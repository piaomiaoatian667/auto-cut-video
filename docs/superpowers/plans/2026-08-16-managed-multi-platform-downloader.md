# Managed Multi-Platform Downloader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make authorized public single-video downloads operational for YouTube, Bilibili, Douyin, TikTok, and Vimeo on macOS Apple Silicon through a pinned local toolchain, explicit proxy and Chrome Cookie inputs, fixed platform profiles, controlled diagnostics, and receipt v3 auditing.

**Architecture:** Preserve the two-process probe-then-download boundary and descriptor-bound atomic archive publication. Resolve a checked-in managed `yt-dlp_macos` toolchain before video-network access, derive one immutable per-platform invocation profile, and reuse that exact profile for probe and download. Setup is the only command that installs code; download and doctor validate local capabilities, never auto-update, never discover proxy settings, and never persist network, browser, or token secrets.

**Tech Stack:** TypeScript 7, Node.js 22, Commander 15, Zod 4, Vitest 4, native `fetch`, Git, Deno 2, pinned official `yt-dlp_macos 2026.07.04`, pinned BgUtils provider `1.3.1`, FFmpeg, macOS Darwin descriptor-bound subprocess wrappers.

---

## File Map

- Create `config/downloader-toolchain.json`: pinned downloader, plugin, and provider identities.
- Create `src/download/network-options.ts`: closed proxy parser and proxy audit values.
- Create `src/download/platform-profiles.ts`: fixed retry, Cookie, proxy, impersonation, provider, and delay profiles.
- Create `src/download/toolchain/{types,manifest,paths,capabilities,resolver,installer}.ts`: managed toolchain lifecycle.
- Create `src/cli/commands/{setup-downloader,doctor-downloader}.ts`: new CLI commands.
- Create `src/cli/downloader-output.ts`: stable secret-free setup and doctor output.
- Create `tests/fixtures/fake-yt-dlp/yt-dlp.mjs`: reusable no-network fake downloader.
- Modify process, download, archive, receipt, CLI, integration tests, and `README.md` as listed per task.

---

### Task 1: Add Closed Proxy, Cookie, and Error Values

**Files:**
- Create: `src/download/network-options.ts`
- Create: `tests/unit/download/network-options.test.ts`
- Modify: `src/download/browser-cookies.ts:1-51`
- Modify: `src/download/errors.ts:1-29`
- Modify: `tests/unit/download/browser-cookies.test.ts:1-126`

- [ ] **Step 1: Write the failing proxy and five-platform Cookie tests**

Create `tests/unit/download/network-options.test.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {
  parseDownloadProxy,
  proxyAudit,
  validateDownloadProxy,
} from '../../../src/download/network-options';

const expectInvalidProxy = (value: string): void => {
  expect(() => parseDownloadProxy(value)).toThrowError(
    expect.objectContaining({code: 'DOWNLOAD_PROXY_INVALID'}),
  );
};

describe('download proxy options', () => {
  it.each([
    ['http://127.0.0.1:7890', 'http'],
    ['https://proxy.example:8443', 'https'],
    ['socks5://127.0.0.1:1080', 'socks5'],
    ['socks5h://proxy.example:1080', 'socks5h'],
  ] as const)('accepts %s', (source, scheme) => {
    const proxy = parseDownloadProxy(source);
    expect(proxy.url).toBe(new URL(source).href);
    expect(proxy.scheme).toBe(scheme);
    expect(proxyAudit(proxy)).toEqual({proxyUsed: true, proxyScheme: scheme});
  });

  it.each([
    'proxy.example:7890',
    'ftp://proxy.example:21',
    'http://user:password@proxy.example:7890',
    'http://proxy.example:0',
    'http://proxy.example:65536',
    'http://proxy.example/path',
    'http://proxy.example/?query=1',
    'http://proxy.example/#fragment',
    'http:///missing-host',
    'http://proxy.example\n.invalid',
  ])('rejects %s without echoing it', (source) => {
    expectInvalidProxy(source);
    try {
      parseDownloadProxy(source);
    } catch (error) {
      expect(String(error)).not.toContain(source);
    }
  });

  it('represents direct mode without an inherited proxy', () => {
    expect(proxyAudit(undefined)).toEqual({proxyUsed: false});
  });

  it('rejects forged runtime proxy objects', () => {
    expect(() => validateDownloadProxy({
      scheme: 'http',
      url: 'http://secret-proxy.example:7890/',
    })).toThrowError(expect.objectContaining({code: 'DOWNLOAD_PROXY_INVALID'}));
  });
});
```

Replace the Douyin-only success case in `tests/unit/download/browser-cookies.test.ts` with:

```ts
it.each(['youtube', 'bilibili', 'douyin', 'tiktok', 'vimeo'] as const)(
  'allows separately confirmed Chrome access for %s',
  (platform) => {
    expect(validateBrowserCookieRequest('chrome', true, platform)).toBe('chrome');
  },
);
```

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run \
  tests/unit/download/network-options.test.ts \
  tests/unit/download/browser-cookies.test.ts
```

Expected: the proxy module is missing and non-Douyin Cookie cases fail with `DOWNLOAD_COOKIE_HOST_UNSUPPORTED`.

- [ ] **Step 3: Implement the closed proxy parser**

Create `src/download/network-options.ts`:

```ts
import {DownloadError} from './errors';

const proxyBrand: unique symbol = Symbol('download-proxy');
const rawControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const acceptedSchemes = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

export type DownloadProxyScheme = 'http' | 'https' | 'socks5' | 'socks5h';

export interface DownloadProxy {
  readonly [proxyBrand]: true;
  readonly scheme: DownloadProxyScheme;
  readonly url: string;
}

export type DownloadProxyAudit =
  | {readonly proxyUsed: false}
  | {readonly proxyUsed: true; readonly proxyScheme: DownloadProxyScheme};

const invalidProxy = (): DownloadError => new DownloadError(
  'DOWNLOAD_PROXY_INVALID',
  'The proxy URL is invalid.',
);

export const parseDownloadProxy = (source: string): DownloadProxy => {
  if (rawControlCharacters.test(source)) throw invalidProxy();
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw invalidProxy();
  }
  const port = parsed.port === '' ? undefined : Number(parsed.port);
  if (
    !acceptedSchemes.has(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname === '' ||
    (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw invalidProxy();
  }
  const scheme = parsed.protocol.slice(0, -1) as DownloadProxyScheme;
  return Object.freeze({[proxyBrand]: true, scheme, url: parsed.href});
};

export const proxyAudit = (
  proxy: DownloadProxy | undefined,
): DownloadProxyAudit => proxy === undefined
  ? {proxyUsed: false}
  : {proxyUsed: true, proxyScheme: proxy.scheme};

export const validateDownloadProxy = (
  value: unknown,
): DownloadProxy | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw invalidProxy();
  }
  const candidate = value as Record<PropertyKey, unknown>;
  if (
    candidate[proxyBrand] !== true ||
    typeof candidate.url !== 'string' ||
    typeof candidate.scheme !== 'string'
  ) {
    throw invalidProxy();
  }
  const parsed = parseDownloadProxy(candidate.url);
  if (parsed.scheme !== candidate.scheme) throw invalidProxy();
  return parsed;
};
```

Append to `DownloadErrorCode`:

```ts
  | 'DOWNLOAD_TOOLCHAIN_MISSING'
  | 'DOWNLOAD_TOOLCHAIN_INVALID'
  | 'DOWNLOAD_PROXY_INVALID'
  | 'DOWNLOAD_IMPERSONATION_UNAVAILABLE'
  | 'DOWNLOAD_PO_TOKEN_UNAVAILABLE'
  | 'DOWNLOAD_NETWORK_UNREACHABLE'
  | 'DOWNLOAD_RATE_LIMITED'
  | 'DOWNLOAD_PLATFORM_CHALLENGE'
```

Retain older codes for compatibility, but stop emitting the old Cookie-host code.

- [ ] **Step 4: Allow confirmed Chrome access for every declared platform**

Change `validateBrowserCookieRequest` to:

```ts
export const validateBrowserCookieRequest = (
  source: BrowserCookieSource | undefined,
  cookieAccessConfirmed: boolean,
  platform: DownloadPlatform,
): BrowserCookieSource | undefined => {
  const runtimeSource: unknown = source;
  const runtimeConfirmation: unknown = cookieAccessConfirmed;
  if (
    (runtimeSource !== undefined && runtimeSource !== 'chrome') ||
    typeof runtimeConfirmation !== 'boolean' ||
    !DownloadPlatformSchema.safeParse(platform).success
  ) {
    throw new DownloadError(
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
  }
  if ((source === undefined) === cookieAccessConfirmed) {
    throw new DownloadError(
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
  }
  return source;
};
```

Import `DownloadPlatformSchema`, delete the host-specific message, and remove the host-specific throw.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/download/network-options.test.ts \
  tests/unit/download/browser-cookies.test.ts
pnpm typecheck
git add \
  src/download/errors.ts \
  src/download/network-options.ts \
  src/download/browser-cookies.ts \
  tests/unit/download/network-options.test.ts \
  tests/unit/download/browser-cookies.test.ts
git commit -m "feat: add explicit downloader network options"
```

Expected: focused tests and typecheck pass; rejected values never appear in public errors.

---

### Task 2: Add the Pinned Manifest and Fixed Cache Layout

**Files:**
- Create: `config/downloader-toolchain.json`
- Create: `src/download/toolchain/types.ts`
- Create: `src/download/toolchain/manifest.ts`
- Create: `src/download/toolchain/paths.ts`
- Create: `tests/unit/download/toolchain-manifest.test.ts`
- Create: `tests/unit/download/toolchain-paths.test.ts`

- [ ] **Step 1: Write failing strict manifest and path tests**

Create tests that assert the exact identities:

```ts
expect(DOWNLOADER_TOOLCHAIN_MANIFEST).toMatchObject({
  schemaVersion: 1,
  platform: 'darwin-arm64',
  ytDlp: {
    version: '2026.07.04',
    bytes: 38256544,
    sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
  },
  potPlugin: {
    version: '1.3.1',
    bytes: 8067,
    sha256: 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38',
  },
  potProvider: {
    version: '1.3.1',
    commit: '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0',
  },
});
```

Reject unknown keys, schema `2`, non-Darwin platform, HTTP URLs, non-allowlisted hosts, zero bytes, uppercase/malformed digests, and non-40-character provider commits.

Assert `resolveDownloaderToolchainPaths('/Users/tester')` returns:

```ts
{
  cacheRoot: '/Users/tester/Library/Caches/auto-cut-video/downloader',
  versionDirectory:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64',
  installedManifest:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/manifest.json',
  ytDlpExecutable:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/bin/yt-dlp',
  pluginDirectory:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/plugins',
  pluginArchive:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/plugins/bgutil-ytdlp-pot-provider.zip',
  providerDirectory:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/provider',
  providerServerDirectory:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/provider/server',
  denoDirectory:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/deno',
  providerCacheDirectory:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/2026.07.04-macos-arm64/deno/provider-cache',
  setupLock:
    '/Users/tester/Library/Caches/auto-cut-video/downloader/.setup.lock',
}
```

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run \
  tests/unit/download/toolchain-manifest.test.ts \
  tests/unit/download/toolchain-paths.test.ts
```

Expected: the manifest and path modules are missing.

- [ ] **Step 3: Add the checked-in manifest**

Create `config/downloader-toolchain.json`:

```json
{
  "schemaVersion": 1,
  "platform": "darwin-arm64",
  "ytDlp": {
    "version": "2026.07.04",
    "url": "https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos",
    "bytes": 38256544,
    "sha256": "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b"
  },
  "potPlugin": {
    "version": "1.3.1",
    "url": "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.1/bgutil-ytdlp-pot-provider.zip",
    "bytes": 8067,
    "sha256": "b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38"
  },
  "potProvider": {
    "repository": "https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git",
    "version": "1.3.1",
    "commit": "7608dd51ee813b48cf9a6d68c6e42cb197ce10e0"
  }
}
```

- [ ] **Step 4: Implement strict manifest schemas and types**

In `manifest.ts`, use strict Zod objects, lowercase SHA-256 regex, positive byte counts, HTTPS-only URLs, and this host allowlist:

```ts
const allowedAssetHosts = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
```

Export:

```ts
export const DOWNLOADER_TOOLCHAIN_MANIFEST =
  parseDownloaderToolchainManifest(rawManifest);

export const installedManifestForPinnedToolchain = () => ({
  schemaVersion: 1 as const,
  platform: 'darwin-arm64' as const,
  ytDlp: {
    version: '2026.07.04' as const,
    bytes: 38256544 as const,
    sha256: DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256,
  },
  potPlugin: {
    version: '1.3.1' as const,
    bytes: 8067 as const,
    sha256: DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256,
  },
  potProvider: {
    version: '1.3.1' as const,
    commit: '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0' as const,
  },
});
```

Define in `types.ts`:

```ts
export type DownloaderToolchainSource = 'managed' | 'override';

export interface DownloaderToolchainPaths {
  cacheRoot: string;
  versionDirectory: string;
  installedManifest: string;
  ytDlpExecutable: string;
  pluginDirectory: string;
  pluginArchive: string;
  providerDirectory: string;
  providerServerDirectory: string;
  denoDirectory: string;
  providerCacheDirectory: string;
  setupLock: string;
}

export interface DownloaderToolchainAudit {
  source: DownloaderToolchainSource;
  ytDlpVersion: string;
  managedAssetSha256?: `sha256:${string}`;
  potProvider?: {name: 'bgutil'; version: '1.3.1'; mode: 'script'};
}

export interface ResolvedDownloaderToolchain {
  source: DownloaderToolchainSource;
  ytDlpExecutable: string;
  ffmpegExecutable: string;
  denoExecutable: string;
  ytDlpVersion: string;
  ffmpegVersion: string;
  pluginDirectory: string;
  pluginArchive: string;
  providerServerDirectory: string;
  denoDirectory: string;
  providerCacheDirectory: string;
  chromeImpersonationTarget: string;
  ffmpegExplicit: boolean;
  childEnvironment: Readonly<NodeJS.ProcessEnv>;
  audit: DownloaderToolchainAudit;
}

export interface SetupDownloaderResult {
  status: 'installed' | 'already-present';
  version: '2026.07.04';
}
```

Implement path derivation with `path.resolve`; reject non-absolute or filesystem-root home directories with `DOWNLOAD_TOOLCHAIN_INVALID`.

```ts
export const resolveDownloaderToolchainPaths = (
  homeDirectory: string,
): DownloaderToolchainPaths => {
  if (!path.isAbsolute(homeDirectory) || path.parse(homeDirectory).root === homeDirectory) {
    throw new DownloadError(
      'DOWNLOAD_TOOLCHAIN_INVALID',
      'The managed downloader failed integrity or capability checks.',
    );
  }
  const cacheRoot = path.resolve(
    homeDirectory,
    'Library/Caches/auto-cut-video/downloader',
  );
  const versionDirectory = path.join(cacheRoot, '2026.07.04-macos-arm64');
  return {
    cacheRoot,
    versionDirectory,
    installedManifest: path.join(versionDirectory, 'manifest.json'),
    ytDlpExecutable: path.join(versionDirectory, 'bin/yt-dlp'),
    pluginDirectory: path.join(versionDirectory, 'plugins'),
    pluginArchive: path.join(
      versionDirectory,
      'plugins/bgutil-ytdlp-pot-provider.zip',
    ),
    providerDirectory: path.join(versionDirectory, 'provider'),
    providerServerDirectory: path.join(versionDirectory, 'provider/server'),
    denoDirectory: path.join(versionDirectory, 'deno'),
    providerCacheDirectory: path.join(versionDirectory, 'deno/provider-cache'),
    setupLock: path.join(cacheRoot, '.setup.lock'),
  };
};
```

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/download/toolchain-manifest.test.ts \
  tests/unit/download/toolchain-paths.test.ts
pnpm typecheck
git add \
  config/downloader-toolchain.json \
  src/download/toolchain/types.ts \
  src/download/toolchain/manifest.ts \
  src/download/toolchain/paths.ts \
  tests/unit/download/toolchain-manifest.test.ts \
  tests/unit/download/toolchain-paths.test.ts
git commit -m "feat: define managed downloader toolchain"
```

---

### Task 3: Validate Capabilities and Resolve Managed or Override Tools

**Files:**
- Create: `src/download/toolchain/capabilities.ts`
- Create: `src/download/toolchain/resolver.ts`
- Create: `tests/unit/download/toolchain-capabilities.test.ts`
- Create: `tests/unit/download/toolchain-resolver.test.ts`
- Modify: `src/process/run-process.ts:1-520`
- Modify: `tests/unit/process/run-process.test.ts:1-900`

- [ ] **Step 1: Write failing subprocess and capability tests**

Add a process-runner test that executes a fixture with:

```ts
const result = await runProcess(process.execPath, [fixturePath], {
  cwd: workingDirectory,
  env: {PATH: process.env.PATH, FIXTURE_VALUE: 'closed-value'},
});
expect(JSON.parse(result.stdout)).toEqual({
  cwd: workingDirectory,
  fixtureValue: 'closed-value',
});
```

Capability fixtures must return exact local outputs:

```ts
const versionOutput = '2026.07.04\n';
const helpOutput = [
  '--js-runtimes RUNTIME[:PATH]',
  '--remote-components COMPONENT',
].join('\n');
const denoOutput = 'deno 2.8.3\nv8 14.2\ntypescript 5.9\n';
const ffmpegOutput = 'ffmpeg version 8.1.2\n';
const targetsOutput = [
  '[info] Available impersonate targets',
  'Client          OS           Source',
  'Chrome-136      Macos-15     curl_cffi',
].join('\n');
```

Cover managed hash mismatch, override version older than `2026.07.04`, downloader symlink/foreign ownership, Deno 1, missing EJS help markers, plugin entry mismatch, provider commit mismatch, provider self-check failure, no Chrome-on-macOS target, and missing FFmpeg. Assert controlled codes and no paths/stderr in public errors. Assert resolver precedence is override first, then exact managed cache, with no plain `yt-dlp` lookup.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm vitest run \
  tests/unit/process/run-process.test.ts \
  tests/unit/download/toolchain-capabilities.test.ts \
  tests/unit/download/toolchain-resolver.test.ts
```

Expected: `RunProcessOptions` rejects `cwd` and `env`; toolchain modules are absent.

- [ ] **Step 3: Extend `runProcess` without adding a shell**

Add:

```ts
export interface RunProcessOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly extraStdioFds?: readonly number[];
  readonly cwd?: string;
  readonly env?: Readonly<NodeJS.ProcessEnv>;
}
```

Pass copied values to `spawn`:

```ts
const child = spawn(command, [...args], {
  stdio,
  detached: useProcessGroup,
  ...(options.cwd === undefined ? {} : {cwd: options.cwd}),
  ...(options.env === undefined ? {} : {env: {...options.env}}),
});
```

Preserve bounded output, FD mapping, timeout, abort, process-group termination, and cleanup behavior.

- [ ] **Step 4: Implement local capability parsing and checks**

Use this checked-in preference list:

```ts
const CHROME_MACOS_PREFERENCES = [
  'Chrome-136:Macos-15',
  'Chrome-133:Macos-15',
  'Chrome-131:Macos-14',
  'Chrome-124:Macos-14',
  'Chrome-123:Macos-14',
  'Chrome-120:Macos-14',
  'Chrome-119:Macos-14',
] as const;
```

Compare official date versions with:

```ts
export const compareYtDlpVersions = (left: string, right: string): number => {
  const parse = (value: string): readonly number[] => {
    const match = /^(\d{4})\.(\d{2})\.(\d{2})$/u.exec(value);
    if (match === null) throw invalidToolchain();
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};
```

Parse rows with:

```ts
const match = /^\s*(Chrome-\S+)\s+(Macos-\S+)\s+curl_cffi\s*$/u.exec(line);
```

Require exact plugin entries:

```ts
const EXPECTED_PLUGIN_ENTRIES = [
  'yt_dlp_plugins/',
  'yt_dlp_plugins/extractor/',
  'yt_dlp_plugins/extractor/getpot_bgutil.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
] as const;

export const pluginEntriesMatch = (stdout: string): boolean => {
  const actual = stdout.split(/\r?\n/u).filter((entry) => entry.length > 0);
  return actual.length === EXPECTED_PLUGIN_ENTRIES.length &&
    actual.every((entry, index) => entry === EXPECTED_PLUGIN_ENTRIES[index]);
};
```

Run only local commands:

```ts
const denoPathList = (...values: readonly string[]): string => values
  .map((value) => value.replaceAll(',', ',,'))
  .join(',');

await runner(ytDlpExecutable, ['--version'], processOptions);
await runner(ytDlpExecutable, ['--help'], processOptions);
await runner(denoExecutable, ['--version'], processOptions);
await runner('/usr/bin/unzip', ['-Z1', paths.pluginArchive], processOptions);
const providerHead = await dependencies.readFile(
  path.join(paths.providerDirectory, '.git/HEAD'),
  'utf8',
);
if (providerHead.trim() !== DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit) {
  throw invalidProvider();
}
await runner(denoExecutable, [
  'run',
  '--allow-env',
  `--allow-ffi=${denoPathList(path.join(paths.providerServerDirectory, 'node_modules'))}`,
  `--allow-read=${denoPathList(paths.providerServerDirectory, path.join(paths.providerServerDirectory, 'node_modules'))}`,
  `--allow-write=${denoPathList(paths.providerCacheDirectory)}`,
  path.join(paths.providerServerDirectory, 'src/generate_once.ts'),
  '--version',
], {
  ...processOptions,
  cwd: paths.providerServerDirectory,
  env: providerEnvironment,
});
await runner(ytDlpExecutable, ['--list-impersonate-targets'], processOptions);
await runner(ffmpegExecutable, ['-version'], processOptions);
```

Require the downloader, plugin, and detached provider `.git/HEAD` to be regular non-symlink current-user files. Managed mode requires exact downloader/plugin hashes and installed manifest. Override mode permits a date version `>=2026.07.04`, but still requires plugin, provider, Deno, EJS-help, impersonation, and FFmpeg capabilities. Parse the first Deno line with `/^deno (\d+)\./u` and require major version at least `2`. Set `ffmpegExplicit` to true only when `ffmpegOverride` is present. Managed audit contains the exact `sha256:` downloader digest; override audit omits it. The platform profile adds the optional provider audit only for YouTube.

Add `validationMode: 'published' | 'staging'` to the capability input. Published mode requires the strict installed manifest. Staging mode skips only that manifest read because setup writes it after local capability checks; both modes require exact managed hashes, provider commit/script self-check, Deno, EJS, impersonation, and FFmpeg.

Build `childEnvironment` by copying `process.env`, deleting case-insensitive `http_proxy`, `https_proxy`, `all_proxy`, and `no_proxy`, then setting:

```ts
{
  DENO_DIR: paths.denoDirectory,
  XDG_CACHE_HOME: paths.providerCacheDirectory,
  DENO_NO_PROMPT: '1',
  DENO_NO_UPDATE_CHECK: '1',
  FORCE_COLOR: 'false',
}
```

Implement it as:

```ts
const PROXY_ENVIRONMENT_KEYS = new Set([
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
]);

export const buildDownloaderChildEnvironment = (
  paths: DownloaderToolchainPaths,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<NodeJS.ProcessEnv> => {
  const environment = Object.fromEntries(
    Object.entries(source).filter(([key]) =>
      !PROXY_ENVIRONMENT_KEYS.has(key.toLowerCase())),
  );
  return Object.freeze({
    ...environment,
    DENO_DIR: paths.denoDirectory,
    XDG_CACHE_HOME: paths.providerCacheDirectory,
    DENO_NO_PROMPT: '1',
    DENO_NO_UPDATE_CHECK: '1',
    FORCE_COLOR: 'false',
  });
};
```

Define the injected dependency boundary used by capability and resolver tests:

```ts
export interface DownloaderCapabilityDependencies {
  runProcess: DownloadProcessRunner;
  directoryExists(candidate: string): Promise<boolean>;
  lstat(candidate: string): Promise<Stats>;
  readFile(candidate: string, encoding: 'utf8'): Promise<string>;
  hashFile(candidate: string): Promise<string>;
  currentUid(): number;
  resolveExecutable(name: 'deno' | 'ffmpeg'): Promise<string>;
}
```

Add the exact helper used by every public capability failure:

```ts
const invalidToolchain = (): DownloadError => new DownloadError(
  'DOWNLOAD_TOOLCHAIN_INVALID',
  'The managed downloader failed integrity or capability checks.',
);

const invalidProvider = (): DownloadError => new DownloadError(
  'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
  'The YouTube compatibility provider is unavailable.',
);
```

- [ ] **Step 5: Implement fixed resolution precedence**

Export:

```ts
export interface ResolveDownloaderToolchainOptions {
  ytDlpOverride?: string;
  ffmpegOverride?: string;
  homeDirectory?: string;
  signal?: AbortSignal;
}
```

Resolve as:

```ts
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw invalidToolchain();
}
const paths = resolveDownloaderToolchainPaths(options.homeDirectory ?? homedir());
if (!await dependencies.directoryExists(paths.versionDirectory)) {
  throw new DownloadError(
    'DOWNLOAD_TOOLCHAIN_MISSING',
    'The managed downloader is not installed. Run setup-downloader.',
  );
}
return await validateDownloaderCapabilities({
  source: options.ytDlpOverride === undefined ? 'managed' : 'override',
  ytDlpExecutable: options.ytDlpOverride ?? paths.ytDlpExecutable,
  ffmpegOverride: options.ffmpegOverride,
  paths,
  signal: options.signal,
}, dependencies);
```

Do not call `which yt-dlp` and do not fall back after a missing or invalid managed cache.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/process/run-process.test.ts \
  tests/unit/download/toolchain-capabilities.test.ts \
  tests/unit/download/toolchain-resolver.test.ts
pnpm typecheck
git add \
  src/process/run-process.ts \
  src/download/toolchain/capabilities.ts \
  src/download/toolchain/resolver.ts \
  tests/unit/process/run-process.test.ts \
  tests/unit/download/toolchain-capabilities.test.ts \
  tests/unit/download/toolchain-resolver.test.ts
git commit -m "feat: validate downloader capabilities"
```

---

### Task 4: Install the Managed Toolchain Atomically

**Files:**
- Create: `src/download/toolchain/installer.ts`
- Create: `tests/unit/download/toolchain-installer.test.ts`

- [ ] **Step 1: Write failing installer transaction tests**

Use injected fetch, process, clock, UUID, hash, and filesystem dependencies. Cover:

```ts
expect(await installDownloaderToolchain({homeDirectory}, dependencies)).toEqual({
  status: 'installed',
  version: '2026.07.04',
});
expect(await readFile(paths.installedManifest, 'utf8')).toBe(
  `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
);
expect((await lstat(paths.ytDlpExecutable)).mode & 0o777).toBe(0o700);
```

Add cases for valid idempotent reuse with zero fetches, redirect host rejection, oversized/short response, SHA mismatch, cancellation, setup-lock conflict, symlink/foreign-owned final directory, quarantine replacement, provider `HEAD` mismatch, frozen Deno install failure, staging cleanup, quarantine restoration, and successful atomic replacement. Public failures must exclude URLs, staging names, Git arguments, and stderr.

- [ ] **Step 2: Run installer tests and verify RED**

```bash
pnpm vitest run tests/unit/download/toolchain-installer.test.ts
```

Expected: installer module is missing.

- [ ] **Step 3: Implement bounded pinned HTTPS asset writes**

Use manual redirects with at most five hops and the manifest host allowlist:

```ts
export interface InstallerDependencies {
  fetch: typeof globalThis.fetch;
  runProcess: DownloadProcessRunner;
  capabilities: DownloaderCapabilityDependencies;
  open: typeof import('node:fs/promises').open;
  mkdir: typeof import('node:fs/promises').mkdir;
  mkdtemp: typeof import('node:fs/promises').mkdtemp;
  chmod: typeof import('node:fs/promises').chmod;
  rename: typeof import('node:fs/promises').rename;
  lstat: typeof import('node:fs/promises').lstat;
  readFile: typeof import('node:fs/promises').readFile;
  writeFile: typeof import('node:fs/promises').writeFile;
  rm: typeof import('node:fs/promises').rm;
  randomUUID(): string;
  currentUid(): number;
}
```

```ts
const downloadPinnedAsset = async (
  asset: {url: string; bytes: number; sha256: string},
  destination: string,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  let current = new URL(asset.url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (current.protocol !== 'https:' || !ALLOWED_REDIRECT_HOSTS.has(current.hostname)) {
      throw invalidToolchain();
    }
    response = await dependencies.fetch(current, {redirect: 'manual', signal});
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (location === null) throw invalidToolchain();
    current = new URL(location, current);
    response = undefined;
  }
  if (response === undefined || !response.ok || response.body === null) {
    throw invalidToolchain();
  }
  const handle = await dependencies.open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > asset.bytes) throw invalidToolchain();
      hash.update(buffer);
      await handle.write(buffer);
    }
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw invalidToolchain();
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
};
```

- [ ] **Step 4: Implement the lock, staging, provider, and publication transaction**

Use this exact order:

```ts
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw invalidToolchain();
}
const lock = await acquireSetupLock(paths.setupLock, dependencies);
let stagingDirectory: string | undefined;
let quarantineDirectory: string | undefined;
let published = false;
try {
  if (await publishedToolchainIsValid(paths, dependencies, signal)) {
    return {status: 'already-present', version: '2026.07.04'};
  }
  quarantineDirectory = await quarantineInvalidPublishedDirectory(paths, dependencies);
  stagingDirectory = await dependencies.mkdtemp(path.join(paths.cacheRoot, '.install-'));
  await dependencies.chmod(stagingDirectory, 0o700);
  const stagingPaths = pathsForVersionDirectory(paths, stagingDirectory);
  await createStagingLayout(stagingPaths, dependencies);
  const denoExecutable = await requireGitAndDeno2(dependencies, signal);
  await downloadPinnedAsset(
    DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp,
    stagingPaths.ytDlpExecutable,
    dependencies,
    signal,
  );
  await dependencies.chmod(stagingPaths.ytDlpExecutable, 0o700);
  await downloadPinnedAsset(
    DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin,
    stagingPaths.pluginArchive,
    dependencies,
    signal,
  );
  await checkoutPinnedProvider(stagingPaths, dependencies, signal);
  await installProviderDependencies(
    stagingPaths,
    denoExecutable,
    dependencies,
    signal,
  );
  await validateStagedToolchain(
    stagingPaths,
    options.ffmpegOverride,
    dependencies,
    signal,
  );
  await writeInstalledManifest(stagingPaths, dependencies);
  await syncToolchainTree(stagingPaths, dependencies);
  await dependencies.rename(stagingDirectory, paths.versionDirectory);
  published = true;
  stagingDirectory = undefined;
  await syncDirectory(paths.cacheRoot, dependencies);
  if (quarantineDirectory !== undefined) {
    await removeOwnedDirectory(quarantineDirectory, dependencies);
    quarantineDirectory = undefined;
  }
  return {status: 'installed', version: '2026.07.04'};
} catch {
  if (!published && quarantineDirectory !== undefined) {
    await restoreQuarantine(quarantineDirectory, paths, dependencies);
    quarantineDirectory = undefined;
  }
  throw invalidToolchain();
} finally {
  if (stagingDirectory !== undefined) {
    await removeOwnedDirectory(stagingDirectory, dependencies);
  }
  await lock.release();
}
```

Define the private helpers in the same file:

```ts
type SetupLock = {release(): Promise<void>};
const acquireSetupLock = async (
  lockPath: string,
  dependencies: InstallerDependencies,
): Promise<SetupLock> => {
  const handle = await dependencies.open(lockPath, 'wx', 0o600);
  const identity = await handle.stat();
  if (!identity.isFile() || identity.uid !== dependencies.currentUid()) {
    await handle.close();
    throw invalidToolchain();
  }
  return {
    release: async () => {
      const current = await dependencies.lstat(lockPath);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.uid !== identity.uid ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        await handle.close();
        throw invalidToolchain();
      }
      await handle.close();
      await dependencies.rm(lockPath);
    },
  };
};
const publishedToolchainIsValid = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<boolean> => {
  try {
    if (signal?.aborted === true) throw signal.reason;
    await validatePublishedToolchainIntegrity(paths, dependencies);
    return true;
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    if (error instanceof DownloadError) return false;
    throw invalidToolchain();
  }
};
const pathsForVersionDirectory = (
  base: DownloaderToolchainPaths,
  versionDirectory: string,
): DownloaderToolchainPaths => ({
  ...base,
  versionDirectory,
  installedManifest: path.join(versionDirectory, 'manifest.json'),
  ytDlpExecutable: path.join(versionDirectory, 'bin/yt-dlp'),
  pluginDirectory: path.join(versionDirectory, 'plugins'),
  pluginArchive: path.join(
    versionDirectory,
    'plugins/bgutil-ytdlp-pot-provider.zip',
  ),
  providerDirectory: path.join(versionDirectory, 'provider'),
  providerServerDirectory: path.join(versionDirectory, 'provider/server'),
  denoDirectory: path.join(versionDirectory, 'deno'),
  providerCacheDirectory: path.join(versionDirectory, 'deno/provider-cache'),
});
```

Define the integrity helper:

```ts
const validatePublishedToolchainIntegrity = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const providerHeadPath = path.join(paths.providerDirectory, '.git/HEAD');
  const providerScriptPath = path.join(
    paths.providerServerDirectory,
    'src/generate_once.ts',
  );
  const providerModulesPath = path.join(
    paths.providerServerDirectory,
    'node_modules',
  );
  const [
    root,
    downloader,
    plugin,
    providerHeadStats,
    providerScriptStats,
    providerModulesStats,
    manifestSource,
    providerHead,
  ] =
    await Promise.all([
    dependencies.lstat(paths.versionDirectory),
    dependencies.lstat(paths.ytDlpExecutable),
    dependencies.lstat(paths.pluginArchive),
    dependencies.lstat(providerHeadPath),
    dependencies.lstat(providerScriptPath),
    dependencies.lstat(providerModulesPath),
    dependencies.readFile(paths.installedManifest, 'utf8'),
    dependencies.readFile(providerHeadPath, 'utf8'),
  ]);
  const uid = dependencies.currentUid();
  if (
    root.isSymbolicLink() || !root.isDirectory() || root.uid !== uid ||
    downloader.isSymbolicLink() || !downloader.isFile() || downloader.uid !== uid ||
    plugin.isSymbolicLink() || !plugin.isFile() || plugin.uid !== uid ||
    providerHeadStats.isSymbolicLink() ||
    !providerHeadStats.isFile() ||
    providerHeadStats.uid !== uid ||
    providerScriptStats.isSymbolicLink() ||
    !providerScriptStats.isFile() ||
    providerScriptStats.uid !== uid ||
    providerModulesStats.isSymbolicLink() ||
    !providerModulesStats.isDirectory() ||
    providerModulesStats.uid !== uid
  ) {
    throw invalidToolchain();
  }
  InstalledDownloaderManifestSchema.parse(JSON.parse(manifestSource));
  const [downloaderHash, pluginHash] = await Promise.all([
    dependencies.capabilities.hashFile(paths.ytDlpExecutable),
    dependencies.capabilities.hashFile(paths.pluginArchive),
  ]);
  if (
    downloaderHash !== DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256 ||
    pluginHash !== DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256 ||
    providerHead.trim() !== DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit
  ) {
    throw invalidToolchain();
  }
};
```

This helper does not require Deno, FFmpeg, or a video-network request, so an intact published cache returns `already-present` without downloading or quarantining because an external runtime is temporarily unavailable. Fresh staging still runs full capability checks before publication.

Define installer input and the remaining setup helpers:

```ts
export interface InstallDownloaderToolchainOptions {
  homeDirectory?: string;
  ffmpegOverride?: string;
  signal?: AbortSignal;
}

const createStagingLayout = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  await dependencies.mkdir(path.dirname(paths.ytDlpExecutable), {mode: 0o700});
  await dependencies.mkdir(paths.pluginDirectory, {mode: 0o700});
  await dependencies.mkdir(paths.denoDirectory, {mode: 0o700});
  await dependencies.mkdir(paths.providerCacheDirectory, {mode: 0o700});
};

const requireGitAndDeno2 = async (
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<string> => {
  await dependencies.runProcess('git', ['--version'], {signal});
  const denoExecutable = await dependencies.capabilities.resolveExecutable('deno');
  const result = await dependencies.runProcess(denoExecutable, ['--version'], {signal});
  const match = /^deno (\d+)\./u.exec(result.stdout);
  if (match === null || Number(match[1]) < 2) throw invalidToolchain();
  return denoExecutable;
};

const checkoutPinnedProvider = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  await dependencies.runProcess('git', ['init', paths.providerDirectory], {signal});
  await dependencies.runProcess('git', [
    '-C', paths.providerDirectory,
    'remote', 'add', 'origin',
    DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.repository,
  ], {signal});
  await dependencies.runProcess('git', [
    '-C', paths.providerDirectory,
    'fetch', '--depth', '1', 'origin',
    DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit,
  ], {signal});
  await dependencies.runProcess('git', [
    '-C', paths.providerDirectory,
    'checkout', '--detach', 'FETCH_HEAD',
  ], {signal});
  const head = await dependencies.readFile(
    path.join(paths.providerDirectory, '.git/HEAD'),
    'utf8',
  );
  if (head.trim() !== DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit) {
    throw invalidToolchain();
  }
};
```

Install provider dependencies from `provider/server` with:

```ts
const installProviderDependencies = async (
  stagingPaths: DownloaderToolchainPaths,
  denoExecutable: string,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  await dependencies.runProcess(denoExecutable, [
    'install',
    '--allow-scripts=npm:canvas',
    '--frozen',
  ], {
    cwd: stagingPaths.providerServerDirectory,
    env: buildDownloaderChildEnvironment(stagingPaths),
    signal,
  });
};

const validateStagedToolchain = async (
  stagingPaths: DownloaderToolchainPaths,
  ffmpegOverride: string | undefined,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  await validateDownloaderCapabilities({
    source: 'managed',
    validationMode: 'staging',
    ytDlpExecutable: stagingPaths.ytDlpExecutable,
    ffmpegOverride,
    paths: stagingPaths,
    signal,
  }, dependencies.capabilities);
};

const writeInstalledManifest = async (
  stagingPaths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const handle = await dependencies.open(stagingPaths.installedManifest, 'wx', 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
      'utf8',
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
};
```

`syncToolchainTree` opens and syncs the downloader, plugin ZIP, installed manifest, provider `.git/HEAD`, provider script, and each containing directory before publication. `syncDirectory` opens the directory read-only, calls `sync()`, and closes it. `quarantineInvalidPublishedDirectory`, `removeOwnedDirectory`, and `restoreQuarantine` must require the exact cache parent, current-user ownership, non-symlink directory identity, and a basename beginning with `.install-` or `.quarantine-`; they rename only within `cacheRoot`, recursively remove only validated generated directories, and restore only when the final version path is absent.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run tests/unit/download/toolchain-installer.test.ts
pnpm typecheck
git add \
  src/download/toolchain/installer.ts \
  tests/unit/download/toolchain-installer.test.ts
git commit -m "feat: install managed downloader atomically"
```

---

### Task 5: Add `setup-downloader`

**Files:**
- Create: `src/cli/commands/setup-downloader.ts`
- Create: `src/cli/downloader-output.ts`
- Create: `tests/unit/cli/setup-downloader.test.ts`
- Modify: `src/cli/videoctl.ts:1-727`

- [ ] **Step 1: Write failing setup command tests**

Assert human and JSON success:

```ts
expect(await runVideoctl(['setup-downloader'], dependencies)).toBe(0);
expect(stdout()).toBe('Downloader installed: 2026.07.04\n');

expect(await runVideoctl(['setup-downloader', '--json'], dependencies)).toBe(0);
expect(JSON.parse(stdout())).toEqual({
  command: 'setup-downloader',
  ok: true,
  status: 'already-present',
  version: '2026.07.04',
});
```

Add controlled invalid-toolchain, cancellation signal forwarding, and Commander parse cases. JSON failures use one stdout document; human failures use stderr; no output contains cache paths or child diagnostics.

- [ ] **Step 2: Run setup CLI tests and verify RED**

```bash
pnpm vitest run tests/unit/cli/setup-downloader.test.ts
```

Expected: command and dependency are absent.

- [ ] **Step 3: Implement setup formatting and command behavior**

Add:

```ts
export interface SetupDownloaderCommandOptions {
  json?: boolean;
}

export interface SetupDownloaderCommandDependencies {
  stdout: OutputWriter;
  stderr: OutputWriter;
  signal?: AbortSignal;
  install(signal?: AbortSignal): Promise<SetupDownloaderResult>;
}

export const formatSetupDownloaderSuccess = (
  result: SetupDownloaderResult,
  json: boolean,
): string => json
  ? `${JSON.stringify({
      command: 'setup-downloader',
      ok: true,
      status: result.status,
      version: result.version,
    }, null, 2)}\n`
  : result.status === 'installed'
    ? `Downloader installed: ${result.version}\n`
    : `Downloader already installed: ${result.version}\n`;

export const formatDownloaderCommandFailure = (
  command: 'setup-downloader' | 'doctor-downloader',
  code: DownloadErrorCode,
  message: string,
  json: boolean,
): string => json
  ? `${JSON.stringify({command, ok: false, code, message}, null, 2)}\n`
  : `${command} failed [${code}]: ${message}\n`;
```

Implement:

```ts
export const runSetupDownloaderCommand = async (
  options: SetupDownloaderCommandOptions,
  dependencies: SetupDownloaderCommandDependencies,
): Promise<number> => {
  const json = options.json === true;
  try {
    const result = await dependencies.install(dependencies.signal);
    dependencies.stdout.write(formatSetupDownloaderSuccess(result, json));
    return EXIT_CODES.success;
  } catch (error) {
    const controlled = isDownloadError(error)
      ? error
      : new DownloadError(
          'DOWNLOAD_TOOLCHAIN_INVALID',
          'The managed downloader failed integrity or capability checks.',
        );
    const output = formatDownloaderCommandFailure(
      'setup-downloader',
      controlled.code,
      controlled.message,
      json,
    );
    if (json) dependencies.stdout.write(output);
    else dependencies.stderr.write(output);
    return dependencies.signal?.aborted === true
      ? EXIT_CODES.cancelled
      : EXIT_CODES.environmentFailed;
  }
};
```

- [ ] **Step 4: Register setup and signal-aware dependencies**

Extend `VideoctlDependencies`:

```ts
setupDownloader(signal?: AbortSignal): Promise<SetupDownloaderResult>;
```

Register:

```ts
command
  .command('setup-downloader')
  .description('Install the pinned local downloader toolchain')
  .option('--json', 'print machine-readable JSON')
  .action(async (options: SetupDownloaderCommandOptions) => {
    exitCode = await runSetupDownloaderCommand(options, dependencies);
  });
```

Generalize the existing one-shot SIGINT/SIGTERM controller so setup, doctor, and download receive the same optional signal while retaining listener cleanup.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/cli/setup-downloader.test.ts \
  tests/unit/cli/download.test.ts
pnpm typecheck
git add \
  src/cli/commands/setup-downloader.ts \
  src/cli/downloader-output.ts \
  src/cli/videoctl.ts \
  tests/unit/cli/setup-downloader.test.ts
git commit -m "feat: add downloader setup command"
```

---

### Task 6: Build Fixed Platform Profiles and Classify Failures

**Files:**
- Create: `src/download/platform-profiles.ts`
- Create: `tests/unit/download/platform-profiles.test.ts`
- Modify: `src/download/yt-dlp.ts:1-257`
- Modify: `tests/unit/download/yt-dlp.test.ts:1-689`

- [ ] **Step 1: Write failing profile and classification tests**

Assert YouTube common arguments exactly:

```ts
expect(resolvePlatformProfile({
  platform: 'youtube',
  toolchain,
  proxy: parseDownloadProxy('http://127.0.0.1:7890'),
  browserCookieSource: 'chrome',
}).commonArgs).toEqual([
  '--ignore-config',
  '--proxy', 'http://127.0.0.1:7890/',
  '--no-geo-bypass',
  '--no-playlist',
  '--playlist-items', '1',
  '--retries', '3',
  '--fragment-retries', '3',
  '--extractor-retries', '3',
  '--retry-sleep', 'http:exp=1:4',
  '--retry-sleep', 'fragment:exp=1:4',
  '--retry-sleep', 'extractor:exp=1:4',
  '--cookies-from-browser', 'chrome',
  '--no-plugin-dirs',
  '--plugin-dirs', toolchain.pluginDirectory,
  '--no-js-runtimes',
  '--js-runtimes', `deno:${toolchain.denoExecutable}`,
  '--no-remote-components',
  '--extractor-args',
  `youtubepot-bgutilscript:server_home=${toolchain.providerServerDirectory}`,
  '--sleep-requests', '1',
]);
```

Assert YouTube delay `5000`, provider used, and no impersonation. Assert Bilibili/TikTok/Vimeo have one `--impersonate Chrome-136:Macos-15`; Douyin has no impersonation/provider additions; direct mode contains exactly one `--proxy ''` pair.

Add error cases:

```ts
[
  ['HTTP Error 429: Too Many Requests', 'DOWNLOAD_RATE_LIMITED'],
  ['Sign in to confirm you are not a bot', 'DOWNLOAD_RATE_LIMITED'],
  ['HTTP Error 412: Precondition Failed', 'DOWNLOAD_PLATFORM_CHALLENGE'],
  ['Connection timed out', 'DOWNLOAD_NETWORK_UNREACHABLE'],
  ['Impersonate target is unavailable', 'DOWNLOAD_IMPERSONATION_UNAVAILABLE'],
  ['bgutil script provider unavailable', 'DOWNLOAD_PO_TOKEN_UNAVAILABLE'],
] as const
```

Include source URL, proxy, Chrome path, PO token, visitor data, and signed URL markers in fake stderr; assert none appears in public errors or CLI JSON.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run \
  tests/unit/download/platform-profiles.test.ts \
  tests/unit/download/yt-dlp.test.ts
```

Expected: profile module is missing and current client maps every process failure to generic codes.

- [ ] **Step 3: Implement immutable profiles**

Define:

```ts
export interface PlatformNetworkAudit {
  proxyUsed: boolean;
  proxyScheme?: DownloadProxyScheme;
  browserImpersonation: boolean;
  browserFamily?: 'chrome';
}

export interface ResolvedPlatformProfile {
  platform: DownloadPlatform;
  commonArgs: readonly string[];
  probeToDownloadDelayMs: 0 | 5000;
  networkAudit: PlatformNetworkAudit;
  browserCookies: {used: false} | {used: true; source: 'chrome'};
  potProviderUsed: boolean;
  toolchainAudit: DownloaderToolchainAudit;
}
```

Build `commonArgs` in this order: shared fixed options, one proxy pair, shared retries, optional Cookie pair, then platform additions. Build `toolchainAudit` from the resolved source/version/hash and add `{name: 'bgutil', version: '1.3.1', mode: 'script'}` only when `potProviderUsed` is true. Freeze the profile and copied argument array. Missing impersonation for Bilibili/TikTok/Vimeo throws before network access.

- [ ] **Step 4: Refactor `yt-dlp` around resolved values**

Replace ambient defaults with:

```ts
export interface YtDlpClientOptions {
  toolchain: ResolvedDownloaderToolchain;
  runProcess?: DownloadProcessRunner;
}

export interface YtDlpOperationOptions {
  profile: ResolvedPlatformProfile;
  signal?: AbortSignal;
}
```

Probe uses:

```ts
[
  ...options.profile.commonArgs,
  '--skip-download',
  '--dump-single-json',
  url,
]
```

Download keeps the Darwin FD wrapper and appends archive-only flags after the identical `commonArgs`. Pass `toolchain.childEnvironment` to probe and download. Add `--ffmpeg-location` only when `toolchain.ffmpegExplicit` is true.

Add this property to `YtDlpInfoSchema`:

```ts
has_drm: z.boolean().nullable().optional(),
```

Add this property to `YtDlpProbe`:

```ts
export interface YtDlpProbe {
  hasDrm: boolean;
}
```

`parseYtDlpInfo` sets `hasDrm: info.has_drm === true`; no raw formats, signed URLs, headers, or Cookie fields enter the safe probe object.

- [ ] **Step 5: Classify bounded stderr without retaining it**

Implement a 64 KiB matcher over `ProcessExecutionError.result.stderr`:

```ts
const CLASSIFICATIONS = [
  [/HTTP Error 429|Too Many Requests|confirm you(?:'| a)re not a bot/iu,
    ['DOWNLOAD_RATE_LIMITED',
     'The video platform temporarily rate-limited this session.']],
  [/HTTP Error 412|Precondition Failed/iu,
    ['DOWNLOAD_PLATFORM_CHALLENGE',
     'The video platform rejected the selected public-session request.']],
  [/timed out|failed to connect|network is unreachable|could not resolve/iu,
    ['DOWNLOAD_NETWORK_UNREACHABLE',
     'The video platform could not be reached with the selected network settings.']],
  [/impersonat(?:e|ion).*(?:unavailable|unsupported|missing)/iu,
    ['DOWNLOAD_IMPERSONATION_UNAVAILABLE',
     'The required browser compatibility capability is unavailable.']],
  [/bgutil|po token provider|generate_once\.(?:ts|js)/iu,
    ['DOWNLOAD_PO_TOKEN_UNAVAILABLE',
     'The YouTube compatibility provider is unavailable.']],
] as const;
```

Return a fresh `DownloadError` with no process error cause. Unknown probe/download failures retain existing generic codes.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/download/platform-profiles.test.ts \
  tests/unit/download/yt-dlp.test.ts
pnpm typecheck
git add \
  src/download/platform-profiles.ts \
  src/download/yt-dlp.ts \
  tests/unit/download/platform-profiles.test.ts \
  tests/unit/download/yt-dlp.test.ts
git commit -m "feat: add fixed platform download profiles"
```

---

### Task 7: Rework Download Orchestration and Add the YouTube Delay

**Files:**
- Modify: `src/download/downloader.ts:1-222`
- Modify: `src/download/archive.ts:970-1500`
- Modify: `tests/unit/download/downloader.test.ts:1-1194`
- Modify: `tests/unit/download/archive.test.ts:1-2635`

- [ ] **Step 1: Write failing order, reuse, delay, and archive-binding tests**

Record and assert this event order:

```ts
expect(events).toEqual([
  'rights',
  'url',
  'proxy',
  'cookies',
  'toolchain',
  'profile',
  'output-root',
  'probe',
  'policy',
  'prepare',
  'delay:5000',
  'authority-open',
  'download',
  'metadata',
  'authority-close',
  'finalize',
]);
```

Assert the same frozen profile object reaches probe/download. YouTube waits `5000`; other platforms wait `0`; `already-present` returns before delay; abort during delay opens no staging authority. Existing receipt canonical URL must match the validated probe canonical URL.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run \
  tests/unit/download/downloader.test.ts \
  tests/unit/download/archive.test.ts
```

Expected: downloader lacks resolver/profile/delay flow and archive preparation cannot bind canonical metadata.

- [ ] **Step 3: Add a reusable metadata-only check**

Define:

```ts
export interface DownloadCheckInput {
  url: string;
  rightsConfirmed: boolean;
  proxy?: DownloadProxy;
  browserCookieSource?: BrowserCookieSource;
  cookieAccessConfirmed: boolean;
  signal?: AbortSignal;
}

export interface DownloadCheckResult {
  platform: DownloadPlatform;
  result: 'available';
}

export interface DownloadInput extends DownloadCheckInput {
  workspaceRoot: string;
  outputRoot: string;
}
```

Split the shared flow so download can validate its output root before the video probe while doctor remains archive-free. Use these internal shapes:

```ts
interface ResolvedDownloadSession {
  requested: ValidatedDownloadUrl;
  toolchain: ResolvedDownloaderToolchain;
  profile: ResolvedPlatformProfile;
  client: YtDlpClient;
}

interface InspectedDownloadRequest extends ResolvedDownloadSession {
  canonical: ValidatedDownloadUrl;
  probe: YtDlpProbe;
}
```

Implement the two stages:

```ts
const resolveDownloadSession = async (
  input: DownloadCheckInput,
  dependencies: DownloadDependencies,
): Promise<ResolvedDownloadSession> => {
  if (input.rightsConfirmed !== true) {
    throw new DownloadError(
      'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
      'Confirm that you are permitted to save this public video.',
    );
  }
  const requested = parseDownloadUrl(input.url);
  const proxy = validateDownloadProxy(input.proxy);
  const browserCookieSource = validateBrowserCookieRequest(
    input.browserCookieSource,
    input.cookieAccessConfirmed,
    requested.platform,
  );
  const toolchain = await dependencies.resolveToolchain(input.signal);
  const profile = resolvePlatformProfile({
    platform: requested.platform,
    toolchain,
    proxy,
    browserCookieSource,
  });
  return {
    requested,
    toolchain,
    profile,
    client: dependencies.createClient(toolchain),
  };
};

const inspectResolvedSession = async (
  session: ResolvedDownloadSession,
  signal?: AbortSignal,
): Promise<InspectedDownloadRequest> => {
  const probe = await session.client.probe(session.requested.url, {
    profile: session.profile,
    ...(signal === undefined ? {} : {signal}),
  });
  assertExtractorMatches(session.requested.platform, probe.extractor);
  if (
    probe.hasDrm ||
    (probe.availability !== undefined &&
      probe.availability !== null &&
      RESTRICTED_AVAILABILITY.has(probe.availability))
  ) {
    throw new DownloadError(
      'DOWNLOAD_CONTENT_RESTRICTED',
      'The requested video is not available as authorized public content.',
    );
  }
  const canonical = parseCanonicalForPlatform(
    probe.canonicalUrl,
    session.requested.platform,
  );
  return {...session, canonical, probe};
};

export const checkVideoDownload = async (
  input: DownloadCheckInput,
  dependencies: DownloadDependencies,
): Promise<DownloadCheckResult> => {
  const session = await resolveDownloadSession(input, dependencies);
  const checked = await inspectResolvedSession(session, input.signal);
  return {platform: checked.requested.platform, result: 'available'};
};
```

`parseYtDlpInfo` already rejects collection and active/upcoming/post-live metadata. `parseCanonicalForPlatform` wraps URL/cross-platform failures in the existing controlled extractor-mismatch error. DRM and restricted availability are rejected before archive preparation or media writes.

```ts
const parseCanonicalForPlatform = (
  source: string,
  platform: DownloadPlatform,
): ValidatedDownloadUrl => {
  try {
    const canonical = parseDownloadUrl(source);
    if (canonical.platform !== platform) throw new Error();
    return canonical;
  } catch {
    throw new DownloadError(
      'DOWNLOAD_EXTRACTOR_MISMATCH',
      'The resolved video platform did not match the requested platform.',
    );
  }
};
```

- [ ] **Step 4: Rebuild download dependencies around one checked context**

Use:

```ts
export interface DownloadDependencies {
  resolveToolchain(signal?: AbortSignal): Promise<ResolvedDownloaderToolchain>;
  createClient(toolchain: ResolvedDownloaderToolchain): YtDlpClient;
  archive: DownloadArchiveDependencies;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
  now(): Date;
}

export interface SystemDownloadOptions {
  ytDlpOverride?: string;
  ffmpegOverride?: string;
  homeDirectory?: string;
  runProcess?: DownloadProcessRunner;
}
```

Change archive preparation to:

```ts
prepare(
  root: ValidatedArchiveRoot,
  platform: DownloadPlatform,
  videoId: string,
  canonicalUrl: string,
): Promise<ArchivePreparation>;
```

Existing archives must match platform, video ID, and canonical normalized URL before `already-present`.

`downloadVideo` calls the stages in this order:

```ts
const session = await resolveDownloadSession(input, dependencies);
const root = await dependencies.archive.validateRoot(
  input.workspaceRoot,
  input.outputRoot,
);
const checked = await inspectResolvedSession(session, input.signal);
const prepared = await dependencies.archive.prepare(
  root,
  checked.requested.platform,
  checked.probe.id,
  checked.canonical.url,
);
if (prepared.status === 'already-present') return prepared;
```

After preparation:

```ts
await dependencies.wait(
  checked.profile.probeToDownloadDelayMs,
  input.signal,
);
```

The wait implementation rejects immediately if already aborted, registers one abort listener, clears its timer, removes the listener, and rejects with `signal.reason`.

```ts
export const waitForDownloadDelay = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => await new Promise((resolve, reject) => {
  if (signal?.aborted === true) {
    reject(signal.reason);
    return;
  }
  const timer = setTimeout(settle, milliseconds);
  const abort = (): void => settle(signal?.reason, true);
  function settle(reason?: unknown, aborted = false): void {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (aborted) reject(reason);
    else resolve();
  }
  signal?.addEventListener('abort', abort, {once: true});
});
```

- [ ] **Step 5: Forward v3 audit values**

Finalize with:

```ts
{
  platform: checked.requested.platform,
  videoId: checked.probe.id,
  title: checked.probe.title,
  canonicalUrl: checked.canonical.url,
  downloadedAt: dependencies.now(),
  tools: {
    ytDlpVersion: checked.toolchain.ytDlpVersion,
    ffmpegVersion: checked.toolchain.ffmpegVersion,
  },
  browserCookies: checked.profile.browserCookies,
  network: checked.profile.networkAudit,
  toolchain: checked.profile.toolchainAudit,
}
```

No retry or fallback may change proxy, Cookie mode, provider, target, or platform after probe begins.

- [ ] **Step 6: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/download/downloader.test.ts \
  tests/unit/download/archive.test.ts \
  tests/unit/download/yt-dlp.test.ts
pnpm typecheck
git add \
  src/download/downloader.ts \
  src/download/archive.ts \
  tests/unit/download/downloader.test.ts \
  tests/unit/download/archive.test.ts
git commit -m "feat: enforce checked download sessions"
```

---

### Task 8: Write Receipt v3 and Preserve v1/v2 Archives

**Files:**
- Modify: `src/download/receipt-schema.ts:1-241`
- Modify: `src/download/archive.ts:995-1380`
- Modify: `tests/unit/download/receipt-schema.test.ts:1-480`
- Modify: `tests/unit/download/archive.test.ts:1-2635`

- [ ] **Step 1: Write failing v3 compatibility and privacy tests**

Add a valid v3 fixture:

```ts
const receiptV3 = {
  version: 3,
  status: 'downloaded',
  platform: 'youtube',
  videoId: 'abc',
  title: 'Fixture',
  canonicalUrl: 'https://www.youtube.com/watch?v=abc',
  downloadedAt: '2026-08-16T12:00:00.000Z',
  purpose: 'learning-analysis',
  rightsConfirmed: true,
  transcoded: false,
  tools: {ytDlpVersion: '2026.07.04', ffmpegVersion: 'ffmpeg version 8.1.2'},
  browserCookies: {used: false},
  network: {
    proxyUsed: true,
    proxyScheme: 'socks5h',
    browserImpersonation: false,
  },
  toolchain: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    managedAssetSha256:
      'sha256:498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
    potProvider: {name: 'bgutil', version: '1.3.1', mode: 'script'},
  },
  files: validFiles,
};
```

Reject proxy URL/credentials, browser path/profile, target string, token, visitor data, child args/env, provider path, staging path, unknown keys, inconsistent network booleans, inconsistent Cookie fields, mismatched tool versions, managed source without digest, and override source with digest. Retain valid v1/v2 fixtures.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run \
  tests/unit/download/receipt-schema.test.ts \
  tests/unit/download/archive.test.ts
```

Expected: v3 is rejected and archive construction still emits v1/v2.

- [ ] **Step 3: Add strict v3 audit schemas**

Add:

```ts
const BrowserCookiesV3Schema = z.discriminatedUnion('used', [
  z.object({used: z.literal(false)}).strict(),
  z.object({used: z.literal(true), source: z.literal('chrome')}).strict(),
]);

const NetworkAuditSchema = z.object({
  proxyUsed: z.boolean(),
  proxyScheme: z.enum(['http', 'https', 'socks5', 'socks5h']).optional(),
  browserImpersonation: z.boolean(),
  browserFamily: z.literal('chrome').optional(),
}).strict().superRefine((network, context) => {
  if (network.proxyUsed !== (network.proxyScheme !== undefined)) {
    context.addIssue({code: 'custom', message: 'proxy audit fields disagree'});
  }
  if (network.browserImpersonation !== (network.browserFamily !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'browser impersonation audit fields disagree',
    });
  }
});

const ToolchainAuditSchema = z.object({
  source: z.enum(['managed', 'override']),
  ytDlpVersion: z.string().min(1),
  managedAssetSha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u).optional(),
  potProvider: z.object({
    name: z.literal('bgutil'),
    version: z.literal('1.3.1'),
    mode: z.literal('script'),
  }).strict().optional(),
}).strict().superRefine((toolchain, context) => {
  if (toolchain.source === 'managed' && toolchain.managedAssetSha256 === undefined) {
    context.addIssue({code: 'custom', message: 'managed digest is required'});
  }
  if (toolchain.source === 'override' && toolchain.managedAssetSha256 !== undefined) {
    context.addIssue({code: 'custom', message: 'override digest is forbidden'});
  }
});
```

Add `DownloadReceiptV3Schema` to the discriminated union and require v3 `toolchain.ytDlpVersion === tools.ytDlpVersion`.

- [ ] **Step 4: Make new archive finalization always emit v3**

Change `FinalizeArchiveInput` to require:

```ts
browserCookies: {used: false} | {used: true; source: 'chrome'};
network: PlatformNetworkAudit;
toolchain: DownloaderToolchainAudit;
```

Construct:

```ts
const receipt = DownloadReceiptSchema.parse({
  version: 3,
  ...commonReceipt,
  browserCookies: input.browserCookies,
  network: input.network,
  toolchain: input.toolchain,
});
```

Validate only closed audit shapes; never accept proxy addresses, target strings, tokens, browser paths, or child invocation data.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/download/receipt-schema.test.ts \
  tests/unit/download/archive.test.ts \
  tests/unit/download/downloader.test.ts
pnpm typecheck
git add \
  src/download/receipt-schema.ts \
  src/download/archive.ts \
  tests/unit/download/receipt-schema.test.ts \
  tests/unit/download/archive.test.ts \
  tests/unit/download/downloader.test.ts
git commit -m "feat: write downloader receipt v3"
```

---

### Task 9: Add `doctor-downloader` with Optional Metadata Check

**Files:**
- Create: `src/cli/commands/doctor-downloader.ts`
- Create: `tests/fixtures/fake-yt-dlp/yt-dlp.mjs`
- Create: `tests/unit/cli/doctor-downloader.test.ts`
- Create: `tests/integration/download/doctor-downloader.test.ts`
- Modify: `src/cli/downloader-output.ts`
- Modify: `src/cli/videoctl.ts:35-727`

- [ ] **Step 1: Write failing local and URL-check doctor tests**

Local JSON must equal:

```ts
{
  command: 'doctor-downloader',
  ok: true,
  toolchain: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    integrity: 'verified',
    deno: 'available',
    ejs: 'available',
    potProvider: 'available',
    chromeImpersonation: 'available',
    ffmpeg: 'available',
  },
}
```

Assert local mode resolves only local capabilities, performs zero probes/downloads, reads no Cookies, and ignores ambient proxy variables. URL check output may add only:

```ts
check: {platform: 'vimeo', result: 'available'}
```

Require `--check-url` when rights/proxy/Cookie options are supplied and require rights confirmation with a check URL. Failure JSON contains only command, `ok`, code, and stable message.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm vitest run \
  tests/unit/cli/doctor-downloader.test.ts \
  tests/integration/download/doctor-downloader.test.ts
```

Expected: command is missing.

- [ ] **Step 3: Implement doctor output and command parsing**

Define:

```ts
export interface DoctorDownloaderCommandOptions {
  checkUrl?: string;
  rightsConfirmed?: boolean;
  proxy?: string;
  browserCookies?: string;
  cookieAccessConfirmed?: boolean;
  json?: boolean;
}

export interface DoctorDownloaderReport {
  source: 'managed' | 'override';
  ytDlpVersion: string;
  integrity: 'verified';
  deno: 'available';
  ejs: 'available';
  potProvider: 'available';
  chromeImpersonation: 'available';
  ffmpeg: 'available';
}

export interface DoctorDownloaderCommandDependencies {
  stdout: OutputWriter;
  stderr: OutputWriter;
  signal?: AbortSignal;
  resolveToolchain(signal?: AbortSignal): Promise<ResolvedDownloaderToolchain>;
  check(
    input: DownloadCheckInput,
    resolveToolchain: () => Promise<ResolvedDownloaderToolchain>,
  ): Promise<DownloadCheckResult>;
}
```

`runDoctorDownloaderCommand` parses optional check URL, rights, proxy, Cookie flags, resolves one toolchain, and reuses that resolution for `checkVideoDownload`:

```ts
export const runDoctorDownloaderCommand = async (
  options: DoctorDownloaderCommandOptions,
  dependencies: DoctorDownloaderCommandDependencies,
): Promise<number> => {
  const json = options.json === true;
  try {
    const hasCheck = options.checkUrl !== undefined;
    const hasNetworkOptions = options.rightsConfirmed !== undefined ||
      options.proxy !== undefined ||
      options.browserCookies !== undefined ||
      options.cookieAccessConfirmed !== undefined;
    if (!hasCheck && hasNetworkOptions) {
      throw new DownloadError(
        'DOWNLOAD_URL_INVALID',
        'The downloader doctor check input is invalid.',
      );
    }
    const proxy = options.proxy === undefined
      ? undefined
      : parseDownloadProxy(options.proxy);
    const browserCookieSource = parseBrowserCookieSource(options.browserCookies);
    let resolvedPromise: Promise<ResolvedDownloaderToolchain> | undefined;
    const resolveOnce = (): Promise<ResolvedDownloaderToolchain> => {
      resolvedPromise ??= dependencies.resolveToolchain(dependencies.signal);
      return resolvedPromise;
    };
    const check = options.checkUrl === undefined
      ? undefined
      : await dependencies.check({
          url: options.checkUrl,
          rightsConfirmed: options.rightsConfirmed === true,
          ...(proxy === undefined ? {} : {proxy}),
          ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
          cookieAccessConfirmed: options.cookieAccessConfirmed === true,
          ...(dependencies.signal === undefined ? {} : {signal: dependencies.signal}),
        }, resolveOnce);
    const toolchain = await resolveOnce();
    dependencies.stdout.write(formatDoctorDownloaderSuccess(
      doctorReport(toolchain),
      check,
      json,
    ));
    return EXIT_CODES.success;
  } catch (error) {
    return writeDoctorDownloaderFailure(error, json, dependencies);
  }
};
```

Add the exact report/output helpers:

```ts
const doctorReport = (
  toolchain: ResolvedDownloaderToolchain,
): DoctorDownloaderReport => ({
  source: toolchain.source,
  ytDlpVersion: toolchain.ytDlpVersion,
  integrity: 'verified',
  deno: 'available',
  ejs: 'available',
  potProvider: 'available',
  chromeImpersonation: 'available',
  ffmpeg: 'available',
});

export const formatDoctorDownloaderSuccess = (
  toolchain: DoctorDownloaderReport,
  check: DownloadCheckResult | undefined,
  json: boolean,
): string => {
  const report = {
    command: 'doctor-downloader' as const,
    ok: true as const,
    toolchain,
    ...(check === undefined ? {} : {check}),
  };
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `Downloader: ${toolchain.ytDlpVersion} (${toolchain.source})`,
    'Integrity: verified',
    'Deno/EJS/PO provider/Chrome impersonation/FFmpeg: available',
    ...(check === undefined
      ? []
      : [`Check: ${check.platform} ${check.result}`]),
    '',
  ].join('\n');
};

const writeDoctorDownloaderFailure = (
  error: unknown,
  json: boolean,
  dependencies: DoctorDownloaderCommandDependencies,
): number => {
  const controlled = isDownloadError(error)
    ? error
    : new DownloadError(
        'DOWNLOAD_TOOLCHAIN_INVALID',
        'The managed downloader failed integrity or capability checks.',
      );
  const output = formatDownloaderCommandFailure(
    'doctor-downloader',
    controlled.code,
    controlled.message,
    json,
  );
  if (json) dependencies.stdout.write(output);
  else dependencies.stderr.write(output);
  if (dependencies.signal?.aborted === true) return EXIT_CODES.cancelled;
  if (new Set<DownloadErrorCode>([
    'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
    'DOWNLOAD_URL_INVALID',
    'DOWNLOAD_HOST_UNSUPPORTED',
    'DOWNLOAD_PROXY_INVALID',
    'DOWNLOAD_COOKIE_OPTIONS_INVALID',
    'DOWNLOAD_CONTENT_RESTRICTED',
  ]).has(controlled.code)) {
    return EXIT_CODES.validationFailed;
  }
  if (
    controlled.code === 'DOWNLOAD_TOOLCHAIN_MISSING' ||
    controlled.code === 'DOWNLOAD_TOOLCHAIN_INVALID' ||
    controlled.code === 'DOWNLOAD_IMPERSONATION_UNAVAILABLE' ||
    controlled.code === 'DOWNLOAD_PO_TOKEN_UNAVAILABLE'
  ) {
    return EXIT_CODES.environmentFailed;
  }
  return EXIT_CODES.operationFailed;
};
```

The system `check` dependency creates normal `DownloadDependencies` with its `resolveToolchain` member replaced by the supplied `resolveOnce`, so rights/URL/session validation runs before the cached capability resolution and probe/download profiles remain identical. Register:

```ts
.command('doctor-downloader')
.option('--check-url <url>', 'run one metadata-only authorized platform check')
.option('--rights-confirmed', 'confirm permission to inspect this public video')
.option('--proxy <url>', 'explicit http, https, socks5, or socks5h proxy')
.option('--browser-cookies <browser>', 'exact lowercase chrome')
.option('--cookie-access-confirmed', 'confirm local Chrome cookie access')
.option('--json', 'print machine-readable JSON')
```

- [ ] **Step 4: Add no-network integration coverage**

Create the first reusable fixture implementation:

```js
#!/usr/bin/env node
import {appendFile, writeFile} from 'node:fs/promises';

const args = process.argv.slice(2);
const record = process.env.FAKE_YT_DLP_RECORD;
if (args.includes('--version')) {
  process.stdout.write('2026.07.04\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write('--js-runtimes RUNTIME[:PATH]\n--remote-components COMPONENT\n');
  process.exit(0);
}
if (args.includes('--list-impersonate-targets')) {
  process.stdout.write('Chrome-136      Macos-15     curl_cffi\n');
  process.exit(0);
}
if (record !== undefined) {
  await appendFile(record, `${args.includes('--dump-single-json') ? 'probe' : 'download'}\n`);
}
if (args.includes('--dump-single-json')) {
  process.stdout.write(`${JSON.stringify({
    id: 'abc',
    title: 'Doctor fixture',
    webpage_url: 'https://www.youtube.com/watch?v=abc',
    extractor: 'youtube',
    extractor_key: 'Youtube',
    _type: 'video',
    has_drm: false,
  })}\n`);
  process.exit(0);
}
await writeFile('video.webm', Buffer.from('fixture'));
```

Build a valid fake managed cache under temporary `HOME`. Run local doctor and assert probe/download counters are zero. Run one `--check-url` and assert one probe, zero downloads, no URL/title/path/diagnostic fields in output.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm vitest run \
  tests/unit/cli/doctor-downloader.test.ts \
  tests/integration/download/doctor-downloader.test.ts \
  tests/unit/cli/download.test.ts
pnpm typecheck
git add \
  src/cli/commands/doctor-downloader.ts \
  src/cli/downloader-output.ts \
  src/cli/videoctl.ts \
  tests/fixtures/fake-yt-dlp/yt-dlp.mjs \
  tests/unit/cli/doctor-downloader.test.ts \
  tests/integration/download/doctor-downloader.test.ts
git commit -m "feat: add downloader doctor command"
```

---

### Task 10: Wire Download CLI and Deterministic Integration Fixtures

**Files:**
- Modify: `tests/fixtures/fake-yt-dlp/yt-dlp.mjs`
- Create: `tests/integration/download/managed-toolchain-download.test.ts`
- Create: `tests/integration/download/platform-error-classification.test.ts`
- Modify: `src/cli/commands/download.ts:1-130`
- Modify: `src/cli/videoctl.ts:1-727`
- Modify: `tests/unit/cli/download.test.ts:1-737`
- Modify: `tests/integration/download/system-download.test.ts:1-619`
- Modify: `tests/integration/download/cli-cancellation.test.ts:1-279`

- [ ] **Step 1: Write failing CLI proxy and resolver tests**

Assert parsed input:

```ts
expect(download).toHaveBeenCalledWith({
  workspaceRoot: '/workspace',
  url: inputUrl,
  outputRoot: 'downloads',
  rightsConfirmed: true,
  proxy: expect.objectContaining({
    scheme: 'http',
    url: 'http://127.0.0.1:7890/',
  }),
  browserCookieSource: 'chrome',
  cookieAccessConfirmed: true,
});
```

Add all five platform URLs to the Chrome table. Reject unsupported proxy schemes, credentials, path/query/fragment, controls, missing host, and invalid ports before download. Map proxy/input errors to validation, toolchain/capability errors to environment, cancellation to `130`, and network/rate/challenge/generic failures to operation failure. Verify `YT_DLP_PATH` and `FFMPEG_PATH` become resolver overrides only.

- [ ] **Step 2: Run CLI tests and verify RED**

```bash
pnpm vitest run tests/unit/cli/download.test.ts
```

Expected: `--proxy` is unrecognized and system dependencies still build an ambient client.

- [ ] **Step 3: Wire closed proxy and managed resolution**

Add `proxy?: string` to `DownloadCommandOptions` and parse once:

```ts
const proxy = options.proxy === undefined
  ? undefined
  : parseDownloadProxy(options.proxy);
```

Register:

```ts
.option(
  '--proxy <url>',
  'explicit http, https, socks5, or socks5h proxy; credentials are unsupported',
)
```

Pass only the closed proxy object into `DownloadInput`. Update Cookie help for all five platforms. Add `DOWNLOAD_PROXY_INVALID` to invalid-input codes. Map new capability codes to `environmentFailed`; network/rate/challenge remain operation failures.

In system dependencies, pass:

```ts
{
  ytDlpOverride: process.env.YT_DLP_PATH,
  ffmpegOverride: process.env.FFMPEG_PATH,
}
```

Do not read proxy environment variables.

- [ ] **Step 4: Create one reusable fake downloader**

`tests/fixtures/fake-yt-dlp/yt-dlp.mjs` must:

- print `2026.07.04` for `--version`;
- print EJS help markers for `--help`;
- print `Chrome-136 Macos-15 curl_cffi` for target listing;
- reject positive geo-bypass, playlist, batch, remux, recode, arbitrary extractor args, duplicate proxy pairs, and mismatched probe/download common arguments;
- record sanitized arguments under `FAKE_YT_DLP_RECORD_DIRECTORY`;
- emit platform-specific safe probe JSON;
- create one media file, subtitle, and thumbnail during download while application code writes metadata;
- emit scenarios `rate-limit`, `bot-check`, `bilibili-412`, `timeout`, `missing-impersonation`, `missing-provider`, and `unknown`;
- support long-running parent/child cancellation;
- contain no real network commands or video-host access.

Recorded fixture output must exclude raw URL, proxy, Cookie, token, and browser/provider paths.

Extend the fixture imports with `createHash` from `node:crypto`, replace Task 9's simple phase-record block, then add this scenario, pair parser, and secret-free profile recording:

```js
const pairs = new Map();
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  if (!key?.startsWith('--')) continue;
  const value = args[index + 1];
  if (value !== undefined && !value.startsWith('--')) {
    const values = pairs.get(key) ?? [];
    values.push(value);
    pairs.set(key, values);
    index += 1;
  }
}
if ((pairs.get('--proxy')?.length ?? 0) !== 1) process.exit(61);
for (const forbidden of [
  '--geo-bypass',
  '--yes-playlist',
  '--batch-file',
  '--remux-video',
  '--recode-video',
]) {
  if (args.includes(forbidden)) process.exit(62);
}
const allowedExtractorArgs = pairs.get('--extractor-args') ?? [];
if (allowedExtractorArgs.some((value) =>
  !value.startsWith('youtubepot-bgutilscript:server_home='))) {
  process.exit(63);
}

const failures = {
  'rate-limit': 'HTTP Error 429: Too Many Requests',
  'bot-check': 'Sign in to confirm you are not a bot',
  'bilibili-412': 'HTTP Error 412: Precondition Failed',
  timeout: 'Connection timed out',
  'missing-impersonation': 'Impersonate target is unavailable',
  'missing-provider': 'bgutil script provider unavailable',
  'keychain-denied': 'Keychain access denied',
  unknown: 'unclassified fixture failure',
};
const failure = failures[process.env.FAKE_YT_DLP_SCENARIO];
if (failure !== undefined) {
  process.stderr.write(`${failure}\n`);
  process.exit(1);
}

const phase = args.includes('--dump-single-json') ? 'probe' : 'download';
const phaseFlags = new Set([
  '--skip-download',
  '--dump-single-json',
  '--no-progress',
  '--write-thumbnail',
  '--write-subs',
  '--write-auto-subs',
]);
const phasePairs = new Set(['--sub-langs', '--output', '--ffmpeg-location']);
const commonArgs = [];
for (let index = 0; index < args.length - 1; index += 1) {
  const argument = args[index];
  if (argument === undefined || phaseFlags.has(argument)) continue;
  if (phasePairs.has(argument)) {
    index += 1;
    continue;
  }
  commonArgs.push(argument);
}
if (record !== undefined) {
  const digest = createHash('sha256')
    .update(JSON.stringify(commonArgs))
    .digest('hex');
  await appendFile(record, `${JSON.stringify({phase, digest})}\n`);
}
```

Compare the probe and download digests in integration tests. This verifies parity without persisting sensitive argument values.

- [ ] **Step 5: Add managed end-to-end and error integration tests**

Build a valid temporary managed cache with fake downloader, plugin ZIP, provider tree, Deno, Git, and FFmpeg fixtures. Run all five platforms and assert:

- exact shared/profile arguments;
- proxy/Cookie parity between probe/download;
- YouTube provider args and injected delay;
- Chrome impersonation only for Bilibili/TikTok/Vimeo;
- Douyin modal normalization;
- descriptor-bound staging and atomic v3 archive;
- hashes, modes, metadata binding, and `already-present`;
- no secret markers in output, errors, receipts, or archive files.

Error integration asserts the stable code table for probe/download and zero application-level retry processes after rate limit, bot check, 412, missing capability, or challenge. Refactor existing system/cancellation tests to reuse the fixture while preserving cleanup and process-group checks.

Add a Chrome session-denial case whose bounded stderr contains `Keychain access denied`. Assert it returns one controlled generic probe failure, launches no anonymous retry, launches no second Cookie retry, prints no browser database path, and leaves no staging content.

Use a table-driven integration test:

```ts
it.each([
  ['youtube', 'https://www.youtube.com/watch?v=abc', false, true],
  ['bilibili', 'https://www.bilibili.com/video/BV1abc', true, false],
  ['douyin', 'https://www.douyin.com/video/123', false, false],
  ['tiktok', 'https://www.tiktok.com/@fixture/video/123', true, false],
  ['vimeo', 'https://vimeo.com/123', true, false],
] as const)(
  'archives %s with the closed profile',
  async (platform, url, impersonated, providerUsed) => {
    const fixture = await createManagedIntegrationFixture({
      workspaceRoot,
      platform,
    });
    const result = await downloadVideo({
      workspaceRoot,
      url,
      outputRoot: 'downloads',
      rightsConfirmed: true,
      cookieAccessConfirmed: false,
    }, fixture.dependencies);
    expect(result.status).toBe('downloaded');
    expect(result.receipt.version).toBe(3);
    if (result.receipt.version !== 3) throw new Error('expected v3');
    expect(result.receipt.network.browserImpersonation).toBe(impersonated);
    expect(result.receipt.toolchain.potProvider !== undefined).toBe(providerUsed);
    expect(await recordedProfileDigests(fixture.recordPath)).toEqual({
      probe: expect.any(String),
      download: expect.any(String),
      equal: true,
    });
  },
);
```

`createManagedIntegrationFixture` is the test-local constructor that writes the strict managed cache under the test `HOME`, creates the fake Deno/FFmpeg/provider files, and returns `{dependencies, recordPath}`; all generated paths stay below the test temporary directory and are removed by `afterEach`.

Define the digest reader in that test file:

```ts
const recordedProfileDigests = async (
  recordPath: string,
): Promise<{probe: string; download: string; equal: boolean}> => {
  const records = (await readFile(recordPath, 'utf8'))
    .trim()
    .split(/\r?\n/u)
    .map((line) => JSON.parse(line) as {phase: 'probe' | 'download'; digest: string});
  const probe = records.find((record) => record.phase === 'probe')?.digest;
  const download = records.find((record) => record.phase === 'download')?.digest;
  if (probe === undefined || download === undefined) throw new Error('missing profile digest');
  return {probe, download, equal: probe === download};
};
```

- [ ] **Step 6: Run deterministic download tests**

```bash
pnpm vitest run \
  tests/unit/download/network-options.test.ts \
  tests/unit/download/browser-cookies.test.ts \
  tests/unit/download/toolchain-manifest.test.ts \
  tests/unit/download/toolchain-paths.test.ts \
  tests/unit/download/toolchain-capabilities.test.ts \
  tests/unit/download/toolchain-resolver.test.ts \
  tests/unit/download/toolchain-installer.test.ts \
  tests/unit/download/platform-profiles.test.ts \
  tests/unit/download/yt-dlp.test.ts \
  tests/unit/download/downloader.test.ts \
  tests/unit/download/receipt-schema.test.ts \
  tests/unit/download/archive.test.ts \
  tests/unit/cli/setup-downloader.test.ts \
  tests/unit/cli/doctor-downloader.test.ts \
  tests/unit/cli/download.test.ts \
  tests/integration/download/doctor-downloader.test.ts \
  tests/integration/download/managed-toolchain-download.test.ts \
  tests/integration/download/platform-error-classification.test.ts \
  tests/integration/download/system-download.test.ts \
  tests/integration/download/cli-cancellation.test.ts
pnpm typecheck
```

Expected: all deterministic downloader tests pass without external network or Chrome access.

- [ ] **Step 7: Commit CLI and integration coverage**

```bash
git add \
  src/cli/commands/download.ts \
  src/cli/videoctl.ts \
  tests/fixtures/fake-yt-dlp/yt-dlp.mjs \
  tests/unit/cli/download.test.ts \
  tests/integration/download/managed-toolchain-download.test.ts \
  tests/integration/download/platform-error-classification.test.ts \
  tests/integration/download/system-download.test.ts \
  tests/integration/download/cli-cancellation.test.ts
git commit -m "test: verify managed multi-platform downloads"
```

---

### Task 11: Document, Verify, and Run Opt-In Live Acceptance

**Files:**
- Modify: `README.md:1-160`
- Verify: all changed source, tests, config, and docs.

- [ ] **Step 1: Update setup, doctor, proxy, Cookie, and privacy documentation**

Replace ambient downloader installation with:

```sh
brew install ffmpeg deno git
pnpm install
pnpm --silent video setup-downloader --json
pnpm --silent video doctor-downloader --json
pnpm --silent video download \
  "https://www.youtube.com/watch?v=qCYCsTbaPy0" \
  --rights-confirmed \
  --json
```

Document explicit proxy and confirmed Chrome use:

```sh
pnpm --silent video download \
  "https://www.douyin.com/jingxuan?modal_id=7654841525762919726" \
  --rights-confirmed \
  --proxy "http://127.0.0.1:7890" \
  --browser-cookies chrome \
  --cookie-access-confirmed \
  --json
```

State macOS Apple Silicon only; ordinary commands never install/update; proxy credentials and environment/system proxy discovery are unsupported; exact confirmed Chrome is allowed for all five platforms; private, paid, subscriber-only, password-protected, live, DRM, and unauthorized content remain excluded; no browser profile, Cookie file/export, PO token input, arbitrary downloader argument, hosted resolver, or transcoding feature exists.

- [ ] **Step 2: Run the deterministic repository gate**

```bash
pnpm typecheck
pnpm test
git diff --check
git status --short --branch
```

Expected: typecheck and full Vitest suite pass, diff check prints nothing, and only intended tracked changes remain.

- [ ] **Step 3: Install and locally diagnose the real pinned toolchain**

```bash
pnpm --silent video setup-downloader --json | tee /tmp/setup-downloader.json
pnpm --silent video doctor-downloader --json | tee /tmp/doctor-downloader.json
pnpm tsx -e '
import {readFile} from "node:fs/promises";
for (const file of ["/tmp/setup-downloader.json", "/tmp/doctor-downloader.json"]) {
  const value = JSON.parse(await readFile(file, "utf8"));
  if (value.ok !== true) throw new Error(`${file} failed`);
}
'
```

Expected: setup reports `installed` or `already-present`; doctor reports the pinned version and all capabilities available.

- [ ] **Step 4: Require explicit authorized live inputs**

```bash
export YOUTUBE_AUTHORIZED_URL='https://www.youtube.com/watch?v=qCYCsTbaPy0'
export DOUYIN_AUTHORIZED_URL='https://www.douyin.com/jingxuan?modal_id=7654841525762919726'
: "${BILIBILI_AUTHORIZED_URL:?export one authorized public Bilibili video URL}"
: "${TIKTOK_AUTHORIZED_URL:?export one authorized public TikTok video URL}"
: "${VIMEO_AUTHORIZED_URL:?export one authorized public Vimeo video URL}"
: "${DOWNLOADER_PROXY_URL:?export an explicit credential-free proxy URL for TikTok and Vimeo}"
```

Do not discover a system proxy, guess browser profiles, or substitute restricted samples.

- [ ] **Step 5: Run metadata-only checks before media writes**

```bash
pnpm --silent video doctor-downloader \
  --check-url "$YOUTUBE_AUTHORIZED_URL" --rights-confirmed --json
pnpm --silent video doctor-downloader \
  --check-url "$BILIBILI_AUTHORIZED_URL" --rights-confirmed --json
pnpm --silent video doctor-downloader \
  --check-url "$DOUYIN_AUTHORIZED_URL" \
  --rights-confirmed \
  --browser-cookies chrome \
  --cookie-access-confirmed --json
pnpm --silent video doctor-downloader \
  --check-url "$TIKTOK_AUTHORIZED_URL" \
  --rights-confirmed --proxy "$DOWNLOADER_PROXY_URL" --json
pnpm --silent video doctor-downloader \
  --check-url "$VIMEO_AUTHORIZED_URL" \
  --rights-confirmed --proxy "$DOWNLOADER_PROXY_URL" --json
```

Expected: one secret-free available result per platform. Controlled capability, network, rate, challenge, Cookie denial, or content restriction stops that platform without fallback.

- [ ] **Step 6: Download and verify five samples**

```bash
pnpm --silent video download "$YOUTUBE_AUTHORIZED_URL" \
  --rights-confirmed --output downloads/live-acceptance --json
pnpm --silent video download "$BILIBILI_AUTHORIZED_URL" \
  --rights-confirmed --output downloads/live-acceptance --json
pnpm --silent video download "$DOUYIN_AUTHORIZED_URL" \
  --rights-confirmed \
  --browser-cookies chrome \
  --cookie-access-confirmed \
  --output downloads/live-acceptance --json
pnpm --silent video download "$TIKTOK_AUTHORIZED_URL" \
  --rights-confirmed --proxy "$DOWNLOADER_PROXY_URL" \
  --output downloads/live-acceptance --json
pnpm --silent video download "$VIMEO_AUTHORIZED_URL" \
  --rights-confirmed --proxy "$DOWNLOADER_PROXY_URL" \
  --output downloads/live-acceptance --json
```

Verify receipts without printing sensitive inputs:

```bash
pnpm tsx -e '
import {readFile} from "node:fs/promises";
import {glob} from "node:fs/promises";
import {DownloadReceiptSchema} from "./src/download/receipt-schema.ts";
let count = 0;
for await (const receiptPath of glob("downloads/live-acceptance/*/*/receipt.json")) {
  const receipt = DownloadReceiptSchema.parse(JSON.parse(
    await readFile(receiptPath, "utf8"),
  ));
  if (receipt.version !== 3) throw new Error("expected receipt v3");
  if (receipt.files.find((file) => file.role === "media") === undefined) {
    throw new Error("missing media");
  }
  count += 1;
}
if (count !== 5) throw new Error(`expected 5 archives, received ${count}`);
'
```

Run FFprobe on each receipt-declared media path and require at least one audio or video stream:

```bash
pnpm tsx -e '
import path from "node:path";
import {execFile} from "node:child_process";
import {readFile} from "node:fs/promises";
import {glob} from "node:fs/promises";
import {promisify} from "node:util";
import {DownloadReceiptSchema} from "./src/download/receipt-schema.ts";
const execFileAsync = promisify(execFile);
for await (const receiptPath of glob("downloads/live-acceptance/*/*/receipt.json")) {
  const receipt = DownloadReceiptSchema.parse(JSON.parse(
    await readFile(receiptPath, "utf8"),
  ));
  const media = receipt.files.find((file) => file.role === "media");
  if (media === undefined) throw new Error("missing media");
  const {stdout} = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "stream=codec_type",
    "-of", "json",
    path.join(path.dirname(receiptPath), media.path),
  ]);
  const streams = JSON.parse(stdout).streams;
  if (!Array.isArray(streams) || !streams.some((stream) =>
    stream.codec_type === "audio" || stream.codec_type === "video")) {
    throw new Error("missing playable stream");
  }
}
'
```

- [ ] **Step 7: Re-run checks and commit docs**

```bash
pnpm typecheck
pnpm test
git diff --check
git status --short --branch
git add README.md
git commit -m "docs: document managed platform downloads"
```

Expected: generated downloads remain ignored and no Cookie, token, proxy, browser, or cache-path material is tracked.

- [ ] **Step 8: Review the branch before integration**

```bash
git log --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
git diff --check origin/main...HEAD
```

Expected: focused implementation, tests, and documentation commits with no diff errors. Invoke `superpowers:requesting-code-review`, resolve findings, rerun the deterministic gate, then invoke `superpowers:finishing-a-development-branch` for integration choices.
