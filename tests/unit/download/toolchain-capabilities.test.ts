import type {Stats} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ProcessExecutionError} from '../../../src/process/process-error';
import {
  buildDownloaderChildEnvironment,
  compareYtDlpVersions,
  directoryExists,
  pluginEntriesMatch,
  validateDownloaderCapabilities,
  type DownloaderCapabilityDependencies,
  type ValidateDownloaderCapabilitiesOptions,
} from '../../../src/download/toolchain/capabilities';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from '../../../src/download/toolchain/manifest';
import {DENO_EXECUTABLE_ENVIRONMENT_KEY} from '../../../src/download/toolchain/deno-wrapper';
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';
import type {DownloaderToolchainPaths} from '../../../src/download/toolchain/types';
import {
  DownloadError,
  type DownloadErrorCode,
} from '../../../src/download/errors';
import {DownloadCancellationError} from '../../../src/download/cancellation';
import type {DownloadProcessRunner} from '../../../src/download/yt-dlp';
import type {ProcessResult} from '../../../src/process/run-process';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';
const INVALID_PROVIDER_MESSAGE =
  'The YouTube compatibility provider is unavailable.';
const IMPERSONATION_MESSAGE =
  'The required browser compatibility capability is unavailable.';
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
const pluginEntries = [
  'yt_dlp_plugins/',
  'yt_dlp_plugins/extractor/',
  'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
  'yt_dlp_plugins/extractor/getpot_bgutil.py',
] as const;
const pluginOutput = [
  ...pluginEntries,
  '',
].join('\n');
const expectedDenoWrapperSource = [
  '#!/bin/sh',
  'set -eu',
  ': "${AUTO_CUT_VIDEO_DENO_EXECUTABLE:?AUTO_CUT_VIDEO_DENO_EXECUTABLE must be set}"',
  'case "$AUTO_CUT_VIDEO_DENO_EXECUTABLE" in',
  '  /*) ;;',
  '  *) exit 126 ;;',
  'esac',
  'if [ "$AUTO_CUT_VIDEO_DENO_EXECUTABLE" = "$0" ]; then',
  '  exit 126',
  'fi',
  ': "${XDG_CACHE_HOME:?XDG_CACHE_HOME must be set}"',
  'export HOME="$XDG_CACHE_HOME"',
  'export TMPDIR="$XDG_CACHE_HOME"',
  'export NPM_CONFIG_REGISTRY="https://registry.npmjs.org/"',
  'export NPM_CONFIG_USERCONFIG="/dev/null"',
  'export NPM_CONFIG_GLOBALCONFIG="/dev/null"',
  'exec "$AUTO_CUT_VIDEO_DENO_EXECUTABLE" "$@"',
  '',
].join('\n');
const denoWrapperExecutableFor = (
  toolchainPaths: DownloaderToolchainPaths,
): string => path.join(toolchainPaths.versionDirectory, 'bin/deno-isolated');
const paths = resolveDownloaderToolchainPaths('/Users/tester');
const providerHeadPath = path.join(paths.providerDirectory, '.git/HEAD');
const denoWrapperExecutable = denoWrapperExecutableFor(paths);
const currentUid = 501;
const denoExecutable = '/private/tools/deno';
const ffmpegExecutable = '/private/tools/ffmpeg';

interface CapabilityOutputs {
  version: string;
  help: string;
  deno: string;
  plugin: string;
  provider: string;
  targets: string;
  ffmpeg: string;
}

interface CapabilityFixture {
  dependencies: DownloaderCapabilityDependencies;
  outputs: CapabilityOutputs;
  files: Map<string, string>;
  hashes: Map<string, string>;
  stats: Map<string, Stats>;
  failures: Set<'provider-self-check' | 'impersonation'>;
  missingExecutables: Set<'deno' | 'ffmpeg'>;
  runProcess: ReturnType<typeof vi.fn<DownloadProcessRunner>>;
  lstat: ReturnType<typeof vi.fn<DownloaderCapabilityDependencies['lstat']>>;
  readFile: ReturnType<typeof vi.fn<DownloaderCapabilityDependencies['readFile']>>;
  resolveExecutable: ReturnType<
    typeof vi.fn<DownloaderCapabilityDependencies['resolveExecutable']>
  >;
  verifyProviderIntegrity: ReturnType<
    typeof vi.fn<DownloaderCapabilityDependencies['verifyProviderIntegrity']>
  >;
}

const regularFileStats = (
  uid = currentUid,
  symbolicLink = false,
  mode = 0o700,
): Stats => ({
  uid,
  mode,
  isFile: () => !symbolicLink,
  isSymbolicLink: () => symbolicLink,
}) as Stats;

const nonRegularStats = (): Stats => ({
  uid: currentUid,
  mode: 0o700,
  isFile: () => false,
  isSymbolicLink: () => false,
}) as Stats;

const resultFor = (
  command: string,
  args: readonly string[],
  stdout = '',
): ProcessResult => ({
  command,
  args: [...args],
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  durationMs: 1,
});

const createCapabilityFixture = (
  toolchainPaths: DownloaderToolchainPaths = paths,
): CapabilityFixture => {
  const outputs: CapabilityOutputs = {
    version: versionOutput,
    help: helpOutput,
    deno: denoOutput,
    plugin: pluginOutput,
    provider: '1.3.1\n',
    targets: targetsOutput,
    ffmpeg: ffmpegOutput,
  };
  const files = new Map<string, string>([
    [
      toolchainPaths.installedManifest,
      `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
    ],
    [denoWrapperExecutableFor(toolchainPaths), expectedDenoWrapperSource],
    [providerHeadPath, `${DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit}\n`],
  ]);
  if (toolchainPaths !== paths) {
    files.delete(providerHeadPath);
    files.set(
      path.join(toolchainPaths.providerDirectory, '.git/HEAD'),
      `${DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit}\n`,
    );
  }
  const hashes = new Map<string, string>([
    [toolchainPaths.ytDlpExecutable, DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256],
    [toolchainPaths.pluginArchive, DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256],
  ]);
  const stats = new Map<string, Stats>();
  const failures = new Set<'provider-self-check' | 'impersonation'>();
  const missingExecutables = new Set<'deno' | 'ffmpeg'>();
  const runProcess = vi.fn<DownloadProcessRunner>(
    async (command, args) => {
      if (args.length === 1 && args[0] === '--version') {
        if (command === denoExecutable) return resultFor(command, args, outputs.deno);
        return resultFor(command, args, outputs.version);
      }
      if (args.length === 1 && args[0] === '--help') {
        return resultFor(command, args, outputs.help);
      }
      if (command === '/usr/bin/unzip') {
        return resultFor(command, args, outputs.plugin);
      }
      if (args[0] === 'run') {
        if (failures.has('provider-self-check')) {
          throw new Error(
            `provider stderr private-marker ${toolchainPaths.providerServerDirectory}`,
          );
        }
        return resultFor(command, args, outputs.provider);
      }
      if (args.length === 1 && args[0] === '--list-impersonate-targets') {
        if (failures.has('impersonation')) {
          throw new Error(`impersonation stderr ${toolchainPaths.ytDlpExecutable}`);
        }
        return resultFor(command, args, outputs.targets);
      }
      if (args.length === 1 && args[0] === '-version') {
        return resultFor(command, args, outputs.ffmpeg);
      }
      throw new Error(`unexpected private command: ${command} ${args.join(' ')}`);
    },
  );
  const readFile = vi.fn<DownloaderCapabilityDependencies['readFile']>(
    async (candidate) => {
      const value = files.get(candidate);
      if (value === undefined) throw new Error(`private missing file ${candidate}`);
      return value;
    },
  );
  const resolveExecutable = vi.fn<
    DownloaderCapabilityDependencies['resolveExecutable']
  >(async (name) => {
    if (missingExecutables.has(name)) {
      throw new Error(`private PATH marker for ${name}`);
    }
    return name === 'deno' ? denoExecutable : ffmpegExecutable;
  });
  const lstatFile = vi.fn<DownloaderCapabilityDependencies['lstat']>(
    async (candidate) => stats.get(candidate) ?? regularFileStats(),
  );
  const verifyProviderIntegrity = vi.fn<
    DownloaderCapabilityDependencies['verifyProviderIntegrity']
  >(async () => {});
  const dependencies: DownloaderCapabilityDependencies = {
    runProcess,
    directoryExists: vi.fn(async () => true),
    lstat: lstatFile,
    readFile,
    hashFile: vi.fn(async (candidate) => {
      const digest = hashes.get(candidate);
      if (digest === undefined) throw new Error(`private hash path ${candidate}`);
      return digest;
    }),
    currentUid: () => currentUid,
    resolveExecutable,
    verifyProviderIntegrity,
  };
  return {
    dependencies,
    outputs,
    files,
    hashes,
    stats,
    failures,
    missingExecutables,
    runProcess,
    lstat: lstatFile,
    readFile,
    resolveExecutable,
    verifyProviderIntegrity,
  };
};

const validateFixture = (
  fixture: CapabilityFixture,
  options: Partial<ValidateDownloaderCapabilitiesOptions> = {},
) => validateDownloaderCapabilities({
  source: 'managed',
  validationMode: 'published',
  ytDlpExecutable: paths.ytDlpExecutable,
  paths,
  ...options,
}, fixture.dependencies);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const expectControlledError = async (
  pending: Promise<unknown>,
  code: DownloadErrorCode,
  message: string,
  privateMarkers: readonly string[] = [],
): Promise<DownloadError> => {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({name: 'DownloadError', code, message});
  const controlled = caught as DownloadError;
  expect((controlled as Error & {cause?: unknown}).cause).toBeUndefined();
  for (const marker of privateMarkers) {
    expect(String(controlled)).not.toContain(marker);
  }
  return controlled;
};

describe('downloader toolchain capability helpers', () => {
  it('compares strict yt-dlp date versions numerically', () => {
    expect(compareYtDlpVersions('2026.07.04', '2026.07.04')).toBe(0);
    expect(compareYtDlpVersions('2026.07.05', '2026.07.04')).toBeGreaterThan(0);
    expect(compareYtDlpVersions('2025.12.31', '2026.01.01')).toBeLessThan(0);
  });

  it.each(['2026.7.04', 'v2026.07.04', '2026.07.040', 'private-marker'])(
    'rejects invalid yt-dlp version %j with a fixed error',
    (version) => {
      expect(() => compareYtDlpVersions(version, '2026.07.04')).toThrowError(
        expect.objectContaining({
          code: 'DOWNLOAD_TOOLCHAIN_INVALID',
          message: INVALID_TOOLCHAIN_MESSAGE,
        }),
      );
      try {
        compareYtDlpVersions(version, '2026.07.04');
      } catch (error) {
        expect(String(error)).not.toContain('private-marker');
      }
    },
  );

  it('matches the exact plugin entry set regardless of archive order', () => {
    expect(pluginEntriesMatch(pluginOutput)).toBe(true);
    expect(pluginEntriesMatch([...pluginEntries].reverse().join('\n'))).toBe(true);
  });

  it.each([
    ['a duplicate', [...pluginEntries, pluginEntries[2]].join('\n')],
    ['a missing entry', pluginEntries.slice(0, -1).join('\n')],
    ['an extra entry', [...pluginEntries, 'unexpected.py'].join('\n')],
    ['an incorrect path', pluginEntries.map((entry) =>
      entry === 'yt_dlp_plugins/extractor/getpot_bgutil.py'
        ? 'yt_dlp_plugins/getpot_bgutil.py'
        : entry).join('\n')],
  ])('rejects plugin entries with %s', (_case, output) => {
    expect(pluginEntriesMatch(output)).toBe(false);
  });

  it('builds a frozen minimal child environment from an allowlisted snapshot', () => {
    const privateMarker = 'private-environment-marker';
    const source: NodeJS.ProcessEnv = {
      PATH: [
        'relative-bin',
        '/usr/bin',
        '/usr/bin',
        '/bin',
        '../relative-tools',
      ].join(path.delimiter),
      HOME: `/host/${privateMarker}/home`,
      TMPDIR: '/private/runtime-tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      LC_COLLATE: 'C',
      LC_MESSAGES: 'en_US.UTF-8',
      LC_MONETARY: 'C',
      LC_NUMERIC: 'C',
      LC_TIME: 'C',
      LC_MODEL_TOKEN: privateMarker,
      LC_SECRET: privateMarker,
      USER: 'downloader-user',
      LOGNAME: 'downloader-logname',
      __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
      SECURITYSESSIONID: '186a6',
      HTTP_PROXY: 'http://private-marker',
      https_proxy: 'http://private-marker',
      All_Proxy: 'socks5://private-marker',
      no_PROXY: 'localhost',
      AWS_SECRET_ACCESS_KEY: privateMarker,
      GOOGLE_APPLICATION_CREDENTIALS: `/private/${privateMarker}/gcp.json`,
      OPENAI_API_KEY: privateMarker,
      ANTHROPIC_API_KEY: privateMarker,
      SSH_AUTH_SOCK: `/private/${privateMarker}/ssh-agent.sock`,
      NODE_OPTIONS: `--require=/${privateMarker}/inject.cjs`,
      NODE_PATH: `/private/${privateMarker}/node_modules`,
      DYLD_INSERT_LIBRARIES: `/private/${privateMarker}/inject.dylib`,
      DENO_AUTH_TOKENS: privateMarker,
      NPM_TOKEN: privateMarker,
      CUSTOM_RUNTIME_MARKER: privateMarker,
      NPM_CONFIG_REGISTRY: `https://${privateMarker}.example.test/`,
      npm_config_userconfig: `/${privateMarker}/user-npmrc`,
      NpM_CoNfIg_GlObAlCoNfIg: `/${privateMarker}/global-npmrc`,
      npm_config_private_marker: privateMarker,
      [DENO_EXECUTABLE_ENVIRONMENT_KEY]: `/${privateMarker}/poisoned-deno`,
      [DENO_EXECUTABLE_ENVIRONMENT_KEY.toLowerCase()]:
        `relative-${privateMarker}`,
    };

    const environment = buildDownloaderChildEnvironment(
      paths,
      denoExecutable,
      source,
    );
    source.PATH = '/mutated';
    source.LANG = 'mutated';

    expect(environment).toEqual({
      PATH: [
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].join(path.delimiter),
      HOME: '/Users/tester',
      TMPDIR: '/private/runtime-tmp',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'UTF-8',
      LC_COLLATE: 'C',
      LC_MESSAGES: 'en_US.UTF-8',
      LC_MONETARY: 'C',
      LC_NUMERIC: 'C',
      LC_TIME: 'C',
      USER: 'downloader-user',
      LOGNAME: 'downloader-logname',
      __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
      SECURITYSESSIONID: '186a6',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
      [DENO_EXECUTABLE_ENVIRONMENT_KEY]: denoExecutable,
      DENO_DIR: paths.denoDirectory,
      XDG_CACHE_HOME: paths.providerCacheDirectory,
      DENO_NO_PROMPT: '1',
      DENO_NO_UPDATE_CHECK: '1',
      FORCE_COLOR: 'false',
    });
    expect(JSON.stringify(environment)).not.toContain(privateMarker);
    expect(Object.keys(environment).filter((key) =>
      key.toLowerCase() === DENO_EXECUTABLE_ENVIRONMENT_KEY.toLowerCase()
    )).toEqual([DENO_EXECUTABLE_ENVIRONMENT_KEY]);
    expect(Object.isFrozen(environment)).toBe(true);
  });

  it('appends deduplicated system directories after host PATH entries', () => {
    const environment = buildDownloaderChildEnvironment(
      paths,
      denoExecutable,
      {PATH: '/opt/homebrew/bin'},
    );

    expect(environment.PATH).toBe(
      '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    );
  });

  it('uses the safe PATH fallback and omits a relative TMPDIR', () => {
    const environment = buildDownloaderChildEnvironment(
      paths,
      denoExecutable,
      {
        PATH: ['relative-bin', '../tools'].join(path.delimiter),
        TMPDIR: 'relative-tmp',
      },
    );

    expect(environment.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(environment).not.toHaveProperty('TMPDIR');
  });

  it.each(['ENOENT', 'ENOTDIR'] as const)(
    'treats only %s lstat failures as a missing directory',
    async (code) => {
      const candidate = '/private/managed-version';
      const error = Object.assign(new Error(`private ${code} ${candidate}`), {code});
      const lstatFile = vi.fn<(value: string) => Promise<Stats>>(async () => {
        throw error;
      });

      await expect(directoryExists(candidate, lstatFile)).resolves.toBe(false);
      expect(lstatFile).toHaveBeenCalledWith(candidate);
    },
  );

  it.each(['EACCES', 'EIO'] as const)(
    'preserves non-missing %s lstat failures for resolver classification',
    async (code) => {
      const candidate = '/private/managed-version';
      const error = Object.assign(new Error(`private ${code} ${candidate}`), {code});
      const lstatFile = vi.fn<(value: string) => Promise<Stats>>(async () => {
        throw error;
      });

      await expect(directoryExists(candidate, lstatFile)).rejects.toBe(error);
    },
  );
});

describe('validateDownloaderCapabilities', () => {
  it('preserves process cancellation without exposing the abort reason', async () => {
    const fixture = createCapabilityFixture();
    const privateReason = 'private capability abort reason';
    fixture.runProcess.mockRejectedValueOnce(new ProcessExecutionError(
      'PROCESS_ABORTED',
      `process was aborted: ${privateReason}`,
      resultFor(paths.ytDlpExecutable, ['--version'], ''),
      new Error(privateReason),
    ));

    let caught: unknown;
    try {
      await validateFixture(fixture);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'DownloadCancellationError',
      message: 'The download operation was cancelled.',
    });
    expect((caught as Error & {cause?: unknown}).cause).toBeUndefined();
    expect(`${String(caught)}${JSON.stringify(caught)}`).not.toContain(privateReason);
  });

  it('validates the exact managed toolchain and local command contract', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://uppercase-proxy.invalid');
    vi.stubEnv('Https_Proxy', 'https://mixed-proxy.invalid');
    vi.stubEnv('ALL_PROXY', 'socks5://uppercase-proxy.invalid');
    vi.stubEnv('no_PROXY', 'mixed-proxy.invalid');
    const fixture = createCapabilityFixture();

    const resolved = await validateFixture(fixture);

    expect(resolved).toMatchObject({
      source: 'managed',
      ytDlpExecutable: paths.ytDlpExecutable,
      ffmpegExecutable,
      denoExecutable: denoWrapperExecutable,
      ytDlpVersion: '2026.07.04',
      ffmpegVersion: '8.1.2',
      pluginDirectory: paths.pluginDirectory,
      pluginArchive: paths.pluginArchive,
      providerServerDirectory: paths.providerServerDirectory,
      denoDirectory: paths.denoDirectory,
      providerCacheDirectory: paths.providerCacheDirectory,
      chromeImpersonationTarget: 'Chrome-136:Macos-15',
      ffmpegExplicit: false,
      audit: {
        source: 'managed',
        ytDlpVersion: '2026.07.04',
        managedAssetSha256:
          `sha256:${DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256}`,
      },
    });
    expect(Object.isFrozen(resolved.childEnvironment)).toBe(true);
    expect(fixture.resolveExecutable.mock.calls).toEqual([['deno'], ['ffmpeg']]);
    const validationEnvironment = fixture.runProcess.mock.calls[0]?.[2]?.env;
    expect(validationEnvironment).toBeDefined();
    expect(validationEnvironment).not.toBe(resolved.childEnvironment);
    expect(Object.isFrozen(validationEnvironment)).toBe(true);
    expect(validationEnvironment?.[DENO_EXECUTABLE_ENVIRONMENT_KEY])
      .toBeUndefined();
    expect(fixture.runProcess.mock.calls.slice(0, 3)).toEqual([
      [paths.ytDlpExecutable, ['--version'], {env: validationEnvironment}],
      [paths.ytDlpExecutable, ['--help'], {env: validationEnvironment}],
      [denoExecutable, ['--version'], {env: validationEnvironment}],
    ]);
    expect(fixture.runProcess.mock.calls[3]).toEqual(
      [
        '/usr/bin/unzip',
        ['-Z1', paths.pluginArchive],
        {env: resolved.childEnvironment},
      ],
    );
    const providerCall = fixture.runProcess.mock.calls[4];
    expect(providerCall).toEqual([
      denoWrapperExecutable,
      [
        'run',
        '--allow-env',
        `--allow-ffi=${path.join(paths.providerServerDirectory, 'node_modules')}`,
        `--allow-read=${paths.providerServerDirectory},${path.join(paths.providerServerDirectory, 'node_modules')},${paths.providerCacheDirectory}`,
        `--allow-write=${paths.providerCacheDirectory}`,
        path.join(paths.providerServerDirectory, 'src/generate_once.ts'),
        '--version',
      ],
      {
        cwd: paths.providerServerDirectory,
        env: resolved.childEnvironment,
      },
    ]);
    expect(fixture.readFile).toHaveBeenCalledWith(denoWrapperExecutable, 'utf8');
    expect(fixture.verifyProviderIntegrity).toHaveBeenCalledWith({
      providerDirectory: paths.providerDirectory,
      identity: DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.integrity,
      currentUid,
    });
    expect(fixture.runProcess.mock.calls.slice(5)).toEqual([
      [
        paths.ytDlpExecutable,
        ['--list-impersonate-targets'],
        {env: resolved.childEnvironment},
      ],
      [ffmpegExecutable, ['-version'], {env: resolved.childEnvironment}],
    ]);
    for (const [index, [, , processOptions]] of
      fixture.runProcess.mock.calls.entries()) {
      expect(processOptions?.env).toBe(
        index < 3 ? validationEnvironment : resolved.childEnvironment,
      );
      expect(Object.keys(processOptions?.env ?? {}).filter((key) =>
        ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
          .includes(key.toLowerCase())))
        .toEqual([]);
    }
  });

  it('binds the frozen runtime to the validated absolute Deno executable', async () => {
    const privateMarker = 'private-deno-runtime-marker';
    vi.stubEnv('PATH', '/private/original-path');
    vi.stubEnv(
      DENO_EXECUTABLE_ENVIRONMENT_KEY,
      `/private/${privateMarker}/poisoned-deno`,
    );
    vi.stubEnv(
      DENO_EXECUTABLE_ENVIRONMENT_KEY.toLowerCase(),
      `relative-${privateMarker}`,
    );
    const fixture = createCapabilityFixture();

    const resolved = await validateFixture(fixture);
    vi.stubEnv('PATH', '/private/mutated-path');

    expect(resolved.childEnvironment.PATH).toBe(
      '/private/original-path:/usr/bin:/bin:/usr/sbin:/sbin',
    );
    expect(resolved.childEnvironment[DENO_EXECUTABLE_ENVIRONMENT_KEY])
      .toBe(denoExecutable);
    expect(Object.keys(resolved.childEnvironment).filter((key) =>
      key.toLowerCase() === DENO_EXECUTABLE_ENVIRONMENT_KEY.toLowerCase()
    )).toEqual([DENO_EXECUTABLE_ENVIRONMENT_KEY]);
    expect(JSON.stringify(resolved.childEnvironment)).not.toContain(privateMarker);
    expect(Object.isFrozen(resolved.childEnvironment)).toBe(true);
    const providerCall = fixture.runProcess.mock.calls.find(([command, args]) =>
      command === denoWrapperExecutable && args[0] === 'run'
    );
    expect(providerCall?.[2]?.env).toBe(resolved.childEnvironment);
    expect(providerCall?.[2]?.env?.[DENO_EXECUTABLE_ENVIRONMENT_KEY])
      .toBe(denoExecutable);
  });

  it('reuses a prevalidated staging Deno without resolving it again', async () => {
    const fixture = createCapabilityFixture();
    fixture.resolveExecutable.mockImplementation(async (name) => {
      if (name === 'deno') {
        throw new Error('private repeated Deno resolution');
      }
      return ffmpegExecutable;
    });

    const resolved = await validateFixture(fixture, {
      validationMode: 'staging',
      validatedSystemDenoExecutable: denoExecutable,
    });

    expect(fixture.resolveExecutable.mock.calls).toEqual([['ffmpeg']]);
    expect(fixture.runProcess.mock.calls).toContainEqual([
      denoExecutable,
      ['--version'],
      expect.objectContaining({env: expect.any(Object)}),
    ]);
    expect(resolved.childEnvironment[DENO_EXECUTABLE_ENVIRONMENT_KEY])
      .toBe(denoExecutable);
  });

  it.each([
    ['a relative path', 'relative-deno'],
    ['the managed wrapper', denoWrapperExecutable],
  ] as const)('rejects prevalidated staging Deno using %s', async (
    _caseName,
    validatedSystemDenoExecutable,
  ) => {
    const fixture = createCapabilityFixture();

    await expectControlledError(
      validateFixture(fixture, {
        validationMode: 'staging',
        validatedSystemDenoExecutable,
      }),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [validatedSystemDenoExecutable],
    );
    expect(fixture.resolveExecutable).not.toHaveBeenCalledWith('deno');
  });

  it('forwards one signal with the proxy-free environment to every process', async () => {
    vi.stubEnv('http_PROXY', 'http://mixed-proxy.invalid');
    vi.stubEnv('HTTPS_PROXY', 'https://uppercase-proxy.invalid');
    vi.stubEnv('All_Proxy', 'socks5://mixed-proxy.invalid');
    vi.stubEnv('NO_PROXY', 'uppercase-proxy.invalid');
    const fixture = createCapabilityFixture();
    const controller = new AbortController();

    const resolved = await validateFixture(fixture, {signal: controller.signal});

    expect(fixture.runProcess).toHaveBeenCalledTimes(7);
    const validationEnvironment = fixture.runProcess.mock.calls[0]?.[2]?.env;
    expect(validationEnvironment).toBeDefined();
    for (const [index, [, , processOptions]] of
      fixture.runProcess.mock.calls.entries()) {
      expect(processOptions).toMatchObject({
        env: index < 3 ? validationEnvironment : resolved.childEnvironment,
        signal: controller.signal,
      });
      expect(Object.keys(processOptions?.env ?? {}).filter((key) =>
        ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
          .includes(key.toLowerCase())))
        .toEqual([]);
    }
  });

  it('selects the highest checked-in Chrome-on-macOS preference', async () => {
    const fixture = createCapabilityFixture();
    fixture.outputs.targets = [
      'Chrome-119 Macos-14 curl_cffi',
      'Chrome-133 Macos-15 curl_cffi',
      'Chrome-124 Macos-14 curl_cffi',
    ].join('\n');

    await expect(validateFixture(fixture)).resolves.toMatchObject({
      chromeImpersonationTarget: 'Chrome-133:Macos-15',
    });
  });

  it('accepts a newer override without adding a managed downloader digest', async () => {
    const fixture = createCapabilityFixture();
    fixture.outputs.version = '2026.08.01\n';
    const ytDlpOverride = '/private/overrides/yt-dlp';
    const ffmpegOverride = '/private/overrides/ffmpeg';

    const resolved = await validateFixture(fixture, {
      source: 'override',
      ytDlpExecutable: ytDlpOverride,
      ffmpegOverride,
    });

    expect(resolved).toMatchObject({
      source: 'override',
      ytDlpExecutable: ytDlpOverride,
      ffmpegExecutable: ffmpegOverride,
      ytDlpVersion: '2026.08.01',
      ffmpegExplicit: true,
      audit: {source: 'override', ytDlpVersion: '2026.08.01'},
    });
    expect(resolved.audit).not.toHaveProperty('managedAssetSha256');
    expect(fixture.resolveExecutable.mock.calls).toEqual([['deno']]);
  });

  it('canonicalizes both relative overrides from one captured capability cwd', async () => {
    const fixture = createCapabilityFixture();
    const capabilityCwd = '/private/capability-cwd';
    const laterCwd = '/private/later-cwd';
    const ytDlpOverride = 'relative-tools/yt-dlp';
    const ffmpegOverride = 'relative-tools/ffmpeg';
    const absoluteYtDlpOverride = path.resolve(capabilityCwd, ytDlpOverride);
    const absoluteFfmpegOverride = path.resolve(capabilityCwd, ffmpegOverride);
    const cwd = vi.spyOn(process, 'cwd')
      .mockReturnValueOnce(capabilityCwd)
      .mockReturnValue(laterCwd);

    const resolved = await validateFixture(fixture, {
      source: 'override',
      ytDlpExecutable: ytDlpOverride,
      ffmpegOverride,
    });

    expect(cwd).toHaveBeenCalledTimes(1);
    expect(resolved.ytDlpExecutable).toBe(absoluteYtDlpOverride);
    expect(resolved.ffmpegExecutable).toBe(absoluteFfmpegOverride);
    expect(fixture.lstat).toHaveBeenCalledWith(absoluteYtDlpOverride);
    expect(fixture.runProcess.mock.calls.filter(([, args]) =>
      args.length === 1 && ['--version', '--help', '--list-impersonate-targets']
        .includes(args[0] ?? '')
    ).map(([command]) => command)).toEqual([
      absoluteYtDlpOverride,
      absoluteYtDlpOverride,
      denoExecutable,
      absoluteYtDlpOverride,
    ]);
    expect(fixture.runProcess).toHaveBeenCalledWith(
      absoluteFfmpegOverride,
      ['-version'],
      expect.objectContaining({env: expect.any(Object)}),
    );
  });

  it('sanitizes cwd failures while resolving relative capability overrides', async () => {
    const fixture = createCapabilityFixture();
    const privateMarker = 'private deleted cwd /private/removed-capability-cwd';
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error(privateMarker), {code: 'ENOENT'});
    });

    try {
      await expectControlledError(
        validateFixture(fixture, {
          source: 'override',
          ytDlpExecutable: 'relative-tools/yt-dlp',
        }),
        'DOWNLOAD_TOOLCHAIN_INVALID',
        INVALID_TOOLCHAIN_MESSAGE,
        [privateMarker, '/private/removed-capability-cwd'],
      );
      expect(fixture.lstat).not.toHaveBeenCalled();
      expect(fixture.runProcess).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  });

  it('preserves absolute capability inputs without reading cwd', async () => {
    const fixture = createCapabilityFixture();
    const ytDlpExecutable = '/private/overrides/linked-bin/../yt-dlp';
    const ffmpegOverride = '/private/overrides/linked-ffmpeg/../ffmpeg';
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('private cwd failure');
    });

    try {
      const resolved = await validateFixture(fixture, {
        source: 'override',
        ytDlpExecutable,
        ffmpegOverride,
      });

      expect(cwd).not.toHaveBeenCalled();
      expect(resolved.ytDlpExecutable).toBe(ytDlpExecutable);
      expect(resolved.ffmpegExecutable).toBe(ffmpegOverride);
    } finally {
      cwd.mockRestore();
    }
  });

  it('sanitizes a missing canonicalized relative override path', async () => {
    const fixture = createCapabilityFixture();
    const capabilityCwd = '/private/canonical-cwd-marker';
    const ytDlpOverride = 'missing/private-override-marker';
    const absoluteYtDlpOverride = path.resolve(capabilityCwd, ytDlpOverride);
    vi.spyOn(process, 'cwd').mockReturnValue(capabilityCwd);
    fixture.lstat.mockImplementation(async (candidate) => {
      if (candidate === absoluteYtDlpOverride) {
        throw new Error(`private missing path ${candidate}`);
      }
      return regularFileStats();
    });

    await expectControlledError(
      validateFixture(fixture, {
        source: 'override',
        ytDlpExecutable: ytDlpOverride,
      }),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [capabilityCwd, ytDlpOverride, absoluteYtDlpOverride],
    );
    expect(fixture.lstat).toHaveBeenCalledWith(absoluteYtDlpOverride);
  });

  it.each([
    ['symlink', regularFileStats(currentUid, true)],
    ['foreign ownership', regularFileStats(currentUid + 1)],
    ['non-regular file', nonRegularStats()],
  ])('rejects an override downloader that is a %s', async (_caseName, overrideStats) => {
    const fixture = createCapabilityFixture();
    const ytDlpOverride = '/private/overrides/untrusted-yt-dlp';
    fixture.stats.set(ytDlpOverride, overrideStats);

    await expectControlledError(
      validateFixture(fixture, {
        source: 'override',
        ytDlpExecutable: ytDlpOverride,
      }),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [ytDlpOverride],
    );
    expect(fixture.lstat).toHaveBeenCalledWith(ytDlpOverride);
    expect(fixture.lstat).not.toHaveBeenCalledWith(paths.ytDlpExecutable);
  });

  it('skips only the installed manifest read in staging mode', async () => {
    const fixture = createCapabilityFixture();
    fixture.files.delete(paths.installedManifest);

    await expect(validateFixture(fixture, {validationMode: 'staging'}))
      .resolves.toMatchObject({source: 'managed'});
    expect(fixture.readFile).not.toHaveBeenCalledWith(paths.installedManifest, 'utf8');
    expect(fixture.readFile).toHaveBeenCalledWith(providerHeadPath, 'utf8');
    expect(fixture.verifyProviderIntegrity).toHaveBeenCalledWith({
      providerDirectory: paths.providerDirectory,
      identity: DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.integrity,
      currentUid,
    });
  });

  it('rejects a managed downloader hash mismatch without exposing the digest', async () => {
    const fixture = createCapabilityFixture();
    fixture.hashes.set(paths.ytDlpExecutable, 'private-hash-marker');

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['private-hash-marker', paths.ytDlpExecutable],
    );
  });

  it('rejects a managed plugin hash mismatch', async () => {
    const fixture = createCapabilityFixture();
    fixture.hashes.set(paths.pluginArchive, 'private-plugin-hash');

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['private-plugin-hash', paths.pluginArchive],
    );
  });

  it('requires the exact published installed manifest', async () => {
    const fixture = createCapabilityFixture();
    fixture.files.set(paths.installedManifest, JSON.stringify({
      ...installedManifestForPinnedToolchain(),
      privateMarker: paths.installedManifest,
    }));

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['privateMarker', paths.installedManifest],
    );
  });

  it('rejects a missing managed Deno wrapper', async () => {
    const fixture = createCapabilityFixture();
    fixture.files.delete(denoWrapperExecutable);

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [denoWrapperExecutable],
    );
  });

  it('rejects a tampered managed Deno wrapper', async () => {
    const fixture = createCapabilityFixture();
    fixture.files.set(
      denoWrapperExecutable,
      `${expectedDenoWrapperSource}private-wrapper-marker\n`,
    );

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['private-wrapper-marker', denoWrapperExecutable],
    );
  });

  it.each([
    ['a symlink', regularFileStats(currentUid, true)],
    ['foreign ownership', regularFileStats(currentUid + 1)],
    ['a non-regular type', nonRegularStats()],
  ])('rejects a managed Deno wrapper with %s', async (_caseName, wrapperStats) => {
    const fixture = createCapabilityFixture();
    fixture.stats.set(denoWrapperExecutable, wrapperStats);

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [denoWrapperExecutable],
    );
  });

  it.each([
    ['0600', 0o600],
    ['0777', 0o777],
  ] as const)('rejects a managed Deno wrapper with mode %s', async (
    _caseName,
    mode,
  ) => {
    const fixture = createCapabilityFixture();
    fixture.stats.set(
      denoWrapperExecutable,
      regularFileStats(currentUid, false, mode),
    );

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [denoWrapperExecutable],
    );
  });

  it('rejects an override older than the pinned release', async () => {
    const fixture = createCapabilityFixture();
    fixture.outputs.version = '2026.07.03\n';
    const ytDlpOverride = '/private/overrides/old-yt-dlp';

    await expectControlledError(
      validateFixture(fixture, {
        source: 'override',
        ytDlpExecutable: ytDlpOverride,
      }),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [ytDlpOverride],
    );
  });

  it.each([
    ['symlink', regularFileStats(currentUid, true)],
    ['foreign ownership', regularFileStats(currentUid + 1)],
  ])('rejects a downloader with %s', async (_caseName, downloaderStats) => {
    const fixture = createCapabilityFixture();
    fixture.stats.set(paths.ytDlpExecutable, downloaderStats);

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [paths.ytDlpExecutable],
    );
  });

  it('rejects a symlinked plugin archive', async () => {
    const fixture = createCapabilityFixture();
    fixture.stats.set(paths.pluginArchive, regularFileStats(currentUid, true));

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [paths.pluginArchive],
    );
  });

  it('rejects Deno 1 without exposing command output', async () => {
    const fixture = createCapabilityFixture();
    fixture.outputs.deno = 'deno 1.46.3\nprivate-deno-marker\n';

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['private-deno-marker', denoExecutable],
    );
  });

  it.each([
    ['JavaScript runtime marker', '--remote-components COMPONENT'],
    ['remote components marker', '--js-runtimes RUNTIME[:PATH]'],
  ])('rejects help missing the %s', async (_caseName, remainingMarker) => {
    const fixture = createCapabilityFixture();
    fixture.outputs.help = `${remainingMarker}\n/private/help-marker`;

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['/private/help-marker'],
    );
  });

  it('rejects mismatched plugin archive entries', async () => {
    const fixture = createCapabilityFixture();
    fixture.outputs.plugin = `${pluginOutput}private-plugin-entry.py\n`;

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['private-plugin-entry.py', paths.pluginArchive],
    );
  });

  it('maps a provider commit mismatch to the provider error', async () => {
    const fixture = createCapabilityFixture();
    fixture.files.set(providerHeadPath, `private-provider-commit ${paths.providerDirectory}`);

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
      INVALID_PROVIDER_MESSAGE,
      ['private-provider-commit', paths.providerDirectory],
    );
  });

  it.each(['source', 'node_modules'])(
    'maps a %s verifier failure to the fixed provider error',
    async (tree) => {
      const fixture = createCapabilityFixture();
      const privateMarker = `private ${tree} verifier failure`;
      fixture.verifyProviderIntegrity.mockRejectedValueOnce(
        new Error(privateMarker),
      );

      await expectControlledError(
        validateFixture(fixture),
        'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
        INVALID_PROVIDER_MESSAGE,
        [privateMarker, paths.providerDirectory],
      );
      expect(fixture.runProcess).not.toHaveBeenCalled();
    },
  );

  it('preserves cancellation from the provider verifier', async () => {
    const fixture = createCapabilityFixture();
    fixture.verifyProviderIntegrity.mockRejectedValueOnce(
      new DownloadCancellationError(),
    );

    await expect(validateFixture(fixture)).rejects.toMatchObject({
      name: 'DownloadCancellationError',
      message: 'The download operation was cancelled.',
    });
  });

  it('rejects foreign provider HEAD ownership as toolchain integrity failure', async () => {
    const fixture = createCapabilityFixture();
    fixture.stats.set(providerHeadPath, regularFileStats(currentUid + 1));

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [providerHeadPath],
    );
  });

  it('maps provider self-check failure without retaining stderr or paths', async () => {
    const fixture = createCapabilityFixture();
    fixture.failures.add('provider-self-check');

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
      INVALID_PROVIDER_MESSAGE,
      ['provider stderr', 'private-marker', paths.providerServerDirectory],
    );
  });

  it.each([
    ['wrong version', '1.3.0\n'],
    ['extra line', '1.3.1\nextra\n'],
    ['leading whitespace', ' 1.3.1\n'],
    ['trailing whitespace', '1.3.1 \n'],
  ])('rejects provider %s output', async (_caseName, output) => {
    const fixture = createCapabilityFixture();
    fixture.outputs.provider = output;

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
      INVALID_PROVIDER_MESSAGE,
      ['1.3.0', 'extra', paths.providerServerDirectory],
    );
  });

  it('rejects output with no supported Chrome-on-macOS target', async () => {
    const fixture = createCapabilityFixture();
    fixture.outputs.targets = [
      'Chrome-136 Windows-11 curl_cffi',
      'Safari-18 Macos-15 curl_cffi',
      `private-target ${paths.ytDlpExecutable}`,
    ].join('\n');

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
      IMPERSONATION_MESSAGE,
      ['private-target', paths.ytDlpExecutable],
    );
  });

  it('maps impersonation command failure to the fixed capability error', async () => {
    const fixture = createCapabilityFixture();
    fixture.failures.add('impersonation');

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
      IMPERSONATION_MESSAGE,
      ['impersonation stderr', paths.ytDlpExecutable],
    );
  });

  it('rejects missing FFmpeg without exposing PATH details', async () => {
    const fixture = createCapabilityFixture();
    fixture.missingExecutables.add('ffmpeg');

    await expectControlledError(
      validateFixture(fixture),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['private PATH marker', 'ffmpeg'],
    );
  });
});
