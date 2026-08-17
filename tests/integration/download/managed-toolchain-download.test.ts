import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  access,
  lstat,
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {runVideoctl} from '../../../src/cli/videoctl';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {downloadVideo} from '../../../src/download/downloader';
import {parseDownloadProxy} from '../../../src/download/network-options';
import {DownloadReceiptSchema} from '../../../src/download/receipt-schema';
import type {DownloadPlatform} from '../../../src/download/platforms';
import {DENO_EXECUTABLE_ENVIRONMENT_KEY} from '../../../src/download/toolchain/deno-wrapper';
import {
  FAKE_YT_DLP_FIXTURE,
  FIXED_DOWNLOAD_TIME,
  NETWORK_COMMAND,
  NODE_NETWORK_API,
  PROBE_SECRET_MARKERS,
  createManagedDownloadFixture,
  installNetworkSocketGuard,
  readDigestRecords,
  type ManagedDownloadFixture,
  type NetworkSocketGuard,
} from './managed-toolchain-fixture';

const execFile = promisify(execFileCallback);
const proxySource = 'http://127.0.0.1:7890';
const proxyUrl = 'http://127.0.0.1:7890/';
const fixtures: ManagedDownloadFixture[] = [];
const socketGuards: NetworkSocketGuard[] = [];

const cases = [
  ['youtube', 'https://www.youtube.com/watch?v=abc', 'abc', false, true],
  ['bilibili', 'https://www.bilibili.com/video/BV1abc', 'BV1abc', true, false],
  ['douyin', 'https://www.douyin.com/video/123', '123', false, false],
  ['tiktok', 'https://www.tiktok.com/@fixture/video/123', '123', true, false],
  ['vimeo', 'https://vimeo.com/123', '123', true, false],
] as const;
const extractors: Record<DownloadPlatform, string> = {
  youtube: 'Youtube',
  bilibili: 'BiliBili',
  douyin: 'Douyin',
  tiktok: 'TikTok',
  vimeo: 'Vimeo',
};

const sharedArguments = (): string[] => [
  '--ignore-config',
  '--proxy',
  proxyUrl,
  '--no-geo-bypass',
  '--no-playlist',
  '--playlist-items',
  '1',
  '--retries',
  '3',
  '--fragment-retries',
  '3',
  '--extractor-retries',
  '3',
  '--retry-sleep',
  'http:exp=1:4',
  '--retry-sleep',
  'fragment:exp=1:4',
  '--retry-sleep',
  'extractor:exp=1:4',
  '--cookies-from-browser',
  'chrome',
];

const platformArguments = (
  platform: DownloadPlatform,
  fixture: ManagedDownloadFixture,
): string[] => {
  if (platform === 'youtube') {
    return [
      '--no-plugin-dirs',
      '--plugin-dirs',
      fixture.paths.pluginDirectory,
      '--no-js-runtimes',
      '--js-runtimes',
      `deno:${fixture.paths.denoWrapperExecutable}`,
      '--no-remote-components',
      '--extractor-args',
      `youtubepot-bgutilscript:server_home=${fixture.paths.providerServerDirectory}`,
      '--sleep-requests',
      '1',
    ];
  }
  return new Set<DownloadPlatform>(['bilibili', 'tiktok', 'vimeo']).has(platform)
    ? ['--impersonate', 'Chrome-136:Macos-15']
    : [];
};

const expectNoSecrets = (value: unknown): void => {
  const source = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  for (const marker of PROBE_SECRET_MARKERS) expect(source).not.toContain(marker);
};

const fileSha256 = (contents: Buffer): string =>
  `sha256:${createHash('sha256').update(contents).digest('hex')}`;

const rawFileSha256 = (contents: Buffer): string =>
  createHash('sha256').update(contents).digest('hex');

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const guard of socketGuards.splice(0)) guard.restore();
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.cleanup();
  }));
});

describe('managed multi-platform download integration', () => {
  it('isolates every managed subprocess from poisoned host environment', async () => {
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
    vi.stubEnv('NODE_PATH', '/host/node-path-marker');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'credential-marker');
    vi.stubEnv('HOME', '/host/home-marker');
    vi.stubEnv('PATH', '/host/path-marker');
    vi.stubEnv('HTTP_PROXY', 'http://host-proxy.invalid:8080');
    vi.stubEnv('HTTPS_PROXY', 'https://host-proxy.invalid:8443');
    vi.stubEnv('ALL_PROXY', 'socks5://host-proxy.invalid:1080');
    vi.stubEnv('NO_PROXY', 'host-private.invalid');
    const fixture = await createManagedDownloadFixture();
    fixtures.push(fixture);
    const run = fixture.createCommandHarness();

    const exitCode = await runVideoctl([
      'download',
      'https://www.douyin.com/video/environment',
      '--rights-confirmed',
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stderr()).toBe('');
    const expectedEnvironment = {
      HOME: fixture.homeDirectory,
      PATH: [
        path.dirname(process.execPath),
        fixture.toolsDirectory,
        '/usr/bin',
        '/bin',
      ].join(path.delimiter),
      TMPDIR: path.join(fixture.root, 'tmp'),
      DENO_DIR: fixture.paths.denoDirectory,
      XDG_CACHE_HOME: fixture.paths.providerCacheDirectory,
      [DENO_EXECUTABLE_ENVIRONMENT_KEY]: path.join(
        fixture.toolsDirectory,
        'deno',
      ),
      DENO_NO_PROMPT: '1',
      DENO_NO_UPDATE_CHECK: '1',
      FORCE_COLOR: 'false',
      FAKE_YT_DLP_RECORD_DIRECTORY: fixture.recordDirectory,
      FAKE_YT_DLP_STATE_DIRECTORY: fixture.stateDirectory,
    };
    expect(fixture.subprocesses.length).toBeGreaterThan(fixture.operations.length);
    for (const subprocess of fixture.subprocesses) {
      expect(subprocess.environment).toEqual(expectedEnvironment);
    }
    expect(fixture.subprocesses.filter((subprocess) =>
      subprocess.command === path.join(fixture.toolsDirectory, 'deno')
    )).toEqual([
      expect.objectContaining({args: ['--version']}),
    ]);
    const providerChecks = fixture.subprocesses.filter((subprocess) =>
      subprocess.command === fixture.paths.denoWrapperExecutable
    );
    expect(providerChecks).toHaveLength(1);
    expect(providerChecks[0]?.args[0]).toBe('run');
    const serializedEnvironments = JSON.stringify(
      fixture.subprocesses.map((subprocess) => subprocess.environment),
    );
    for (const marker of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'AWS_SECRET_ACCESS_KEY',
      'credential-marker',
      '/host/home-marker',
      '/host/path-marker',
      'host-proxy.invalid',
      'host-private.invalid',
    ]) {
      expect(serializedEnvironments).not.toContain(marker);
    }

    const expectedHashPaths = [
      fixture.paths.pluginArchive,
      fixture.paths.ytDlpExecutable,
    ].sort();
    expect([...fixture.actualHashes.keys()].sort()).toEqual(expectedHashPaths);
    expect(fixture.actualHashes.get(fixture.paths.ytDlpExecutable)).toBe(
      rawFileSha256(await readFile(fixture.paths.ytDlpExecutable)),
    );
    expect(fixture.actualHashes.get(fixture.paths.pluginArchive)).toBe(
      rawFileSha256(await readFile(fixture.paths.pluginArchive)),
    );
  });

  it('keeps the managed toolchain environment below temporary HOME', async () => {
    const fixture = await createManagedDownloadFixture();
    fixtures.push(fixture);
    const managedCandidates = [
      fixture.paths.ytDlpExecutable,
      fixture.paths.denoWrapperExecutable,
      fixture.paths.pluginDirectory,
      fixture.paths.pluginArchive,
      fixture.paths.providerDirectory,
      fixture.paths.providerServerDirectory,
      fixture.paths.denoDirectory,
      fixture.paths.providerCacheDirectory,
      fixture.paths.installedManifest,
      fixture.toolsDirectory,
      path.join(fixture.toolsDirectory, 'deno'),
      path.join(fixture.toolsDirectory, 'ffmpeg'),
    ];

    for (const candidate of managedCandidates) {
      const relative = path.relative(fixture.homeDirectory, candidate);
      expect(relative).not.toBe('');
      expect(path.isAbsolute(relative)).toBe(false);
      expect(relative).not.toBe('..');
      expect(relative.startsWith(`..${path.sep}`)).toBe(false);
    }
  });

  it.each(cases)(
    'archives %s with one strict managed probe/download pair',
    async (platform, url, videoId, browserImpersonation, potProvider) => {
      vi.stubEnv('HTTP_PROXY', 'http://ambient-proxy.invalid:8080');
      vi.stubEnv('HTTPS_PROXY', 'https://ambient-proxy.invalid:8443');
      vi.stubEnv('ALL_PROXY', 'socks5://ambient-proxy.invalid:1080');
      vi.stubEnv('NO_PROXY', 'private.invalid');
      const guard = installNetworkSocketGuard();
      socketGuards.push(guard);
      const fixture = await createManagedDownloadFixture();
      fixtures.push(fixture);
      const run = fixture.createCommandHarness();

      const exitCode = await runVideoctl([
        'download',
        url,
        '--rights-confirmed',
        '--proxy',
        proxySource,
        '--browser-cookies',
        'chrome',
        '--cookie-access-confirmed',
      ], run.dependencies);

      expect(exitCode).toBe(EXIT_CODES.success);
      expect(run.stderr()).toBe('');
      expect(run.stdout()).toContain(`Download complete: ${platform}/${videoId}\n`);
      expectNoSecrets(`${run.stdout()}${run.stderr()}`);
      expect(fixture.operations).toHaveLength(2);
      const [probe, download] = fixture.operations;
      expect(probe?.phase).toBe('probe');
      expect(download?.phase).toBe('download');
      const common = [...sharedArguments(), ...platformArguments(platform, fixture)];
      expect(probe?.args).toEqual([
        ...common,
        '--skip-download',
        '--dump-single-json',
        url,
      ]);
      expect(download?.args).toEqual([
        ...common,
        '--no-progress',
        '--write-thumbnail',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'zh.*,en.*',
        '--output',
        'video.%(ext)s',
        url,
      ]);
      expect(probe?.extraStdioFds).toBeUndefined();
      expect(download?.extraStdioFds).toHaveLength(1);
      for (const operation of fixture.operations) {
        const environment = operation.environment ?? {};
        const keys = Object.keys(environment).map((key) => key.toLowerCase());
        expect(keys).not.toContain('http_proxy');
        expect(keys).not.toContain('https_proxy');
        expect(keys).not.toContain('all_proxy');
        expect(keys).not.toContain('no_proxy');
        expect(environment.FAKE_YT_DLP_RECORD_DIRECTORY)
          .toBe(fixture.recordDirectory);
      }
      expect(fixture.delays).toEqual([platform === 'youtube' ? 5000 : 0]);
      const records = await readDigestRecords(fixture.recordPath);
      expect(records).toHaveLength(2);
      expect(records.map((record) => record.phase)).toEqual(['probe', 'download']);
      expect(records[0]?.digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(records[1]?.digest).toBe(records[0]?.digest);
      expect(Object.keys(records[0] ?? {}).sort()).toEqual(['digest', 'phase']);
      expect(await readdir(fixture.recordDirectory)).toEqual(['operations.jsonl']);

      const finalDirectory = path.join(
        fixture.workspaceRoot,
        'downloads',
        platform,
        videoId,
      );
      const stagingRoot = path.join(fixture.workspaceRoot, 'downloads', '.staging');
      expect((await lstat(finalDirectory)).mode & 0o777).toBe(0o700);
      expect(await readdir(stagingRoot)).toEqual([]);
      expect((await readdir(finalDirectory)).sort()).toEqual([
        'receipt.json',
        'video.en.vtt',
        'video.info.json',
        'video.webm',
        'video.webp',
      ]);
      const receiptSource = await readFile(
        path.join(finalDirectory, 'receipt.json'),
        'utf8',
      );
      const receipt = DownloadReceiptSchema.parse(JSON.parse(receiptSource));
      expect(receipt).toMatchObject({
        version: 3,
        platform,
        videoId,
        downloadedAt: FIXED_DOWNLOAD_TIME.toISOString(),
        browserCookies: {used: true, source: 'chrome'},
        network: {
          proxyUsed: true,
          proxyScheme: 'http',
          browserImpersonation,
        },
        toolchain: {
          source: 'managed',
          ytDlpVersion: '2026.07.04',
        },
        tools: {
          ytDlpVersion: '2026.07.04',
          ffmpegVersion: '8.1.2',
        },
      });
      if (receipt.version !== 3) throw new Error('Expected receipt version 3.');
      if (browserImpersonation) {
        expect(receipt.network.browserFamily).toBe('chrome');
      } else {
        expect(receipt.network).not.toHaveProperty('browserFamily');
      }
      if (potProvider) {
        expect(receipt.toolchain.potProvider).toEqual({
          name: 'bgutil',
          version: '1.3.1',
          mode: 'script',
        });
      } else {
        expect(receipt.toolchain).not.toHaveProperty('potProvider');
      }
      expect((await lstat(path.join(finalDirectory, 'receipt.json'))).mode & 0o777)
        .toBe(0o600);
      for (const file of receipt.files) {
        const filePath = path.join(finalDirectory, file.path);
        const contents = await readFile(filePath);
        expect((await lstat(filePath)).mode & 0o777).toBe(0o400);
        expect(file.bytes).toBe(contents.byteLength);
        expect(file.sha256).toBe(fileSha256(contents));
        expectNoSecrets(contents);
      }
      const metadata = JSON.parse(await readFile(
        path.join(finalDirectory, 'video.info.json'),
        'utf8',
      )) as Record<string, unknown>;
      expect(metadata).toEqual({
        id: videoId,
        title: `${platform} fixture ${videoId}`,
        webpage_url: receipt.canonicalUrl,
        extractor: extractors[receipt.platform],
        extractor_key: extractors[receipt.platform],
        _type: 'video',
      });
      expectNoSecrets(receiptSource);
      expectNoSecrets(receipt);
      expect(guard.calls).toEqual([]);

      const duplicateRun = fixture.createCommandHarness();
      const duplicateExitCode = await runVideoctl([
        'download',
        url,
        '--rights-confirmed',
        '--proxy',
        proxySource,
        '--browser-cookies',
        'chrome',
        '--cookie-access-confirmed',
      ], duplicateRun.dependencies);
      expect(duplicateExitCode).toBe(EXIT_CODES.success);
      expect(duplicateRun.stdout()).toContain(
        `Already downloaded: ${platform}/${videoId}\n`,
      );
      expect(duplicateRun.stderr()).toBe('');
      expect(fixture.operations.map((operation) => operation.phase))
        .toEqual(['probe', 'download', 'probe']);
      expect(await readdir(stagingRoot)).toEqual([]);
    },
  );

  it('normalizes a Douyin modal URL before both phases and metadata binding', async () => {
    const fixture = await createManagedDownloadFixture();
    fixtures.push(fixture);
    const source =
      'https://www.douyin.com/jingxuan?modal_id=7654841525762919726';
    const canonical = 'https://www.douyin.com/video/7654841525762919726';

    const result = await downloadVideo({
      workspaceRoot: fixture.workspaceRoot,
      url: source,
      outputRoot: 'downloads',
      rightsConfirmed: true,
      proxy: parseDownloadProxy(proxySource),
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
    }, fixture.dependencies);

    expect(result.status).toBe('downloaded');
    expect(result.receipt.canonicalUrl).toBe(canonical);
    expect(fixture.operations).toHaveLength(2);
    expect(fixture.operations[0]?.args.at(-1)).toBe(canonical);
    expect(fixture.operations[1]?.args.at(-1)).toBe(canonical);
    const metadata = JSON.parse(await readFile(path.join(
      fixture.workspaceRoot,
      'downloads/douyin/7654841525762919726/video.info.json',
    ), 'utf8')) as {webpage_url: string};
    expect(metadata.webpage_url).toBe(canonical);
  });

  it('cancels during the injected YouTube delay without starting download', async () => {
    const controller = new AbortController();
    const fixture = await createManagedDownloadFixture({
      beforeDelay: () => {
        controller.abort(new Error('private delay cancellation reason'));
      },
    });
    fixtures.push(fixture);
    const run = fixture.createCommandHarness(controller.signal);

    const exitCode = await runVideoctl([
      'download',
      'https://www.youtube.com/watch?v=delay-cancelled',
      '--rights-confirmed',
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.cancelled);
    expect(fixture.delays).toEqual([5000]);
    expect(fixture.operations.map((operation) => operation.phase)).toEqual(['probe']);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      'Download failed [DOWNLOAD_PROCESS_FAILED]: '
      + 'The download operation was cancelled.\n',
    );
    expect(run.stderr()).not.toContain('private delay cancellation reason');
    expect(await readDigestRecords(fixture.recordPath)).toHaveLength(1);
    await expect(access(path.join(
      fixture.workspaceRoot,
      'downloads/youtube/delay-cancelled',
    ))).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readdir(path.join(fixture.workspaceRoot, 'downloads/.staging')))
      .toEqual([]);
  });

  it('rejects forbidden mutations and mismatched probe/download profiles', async () => {
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
    vi.stubEnv('NODE_PATH', '/host/node-path-marker');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'credential-marker');
    vi.stubEnv('HOME', '/host/home-marker');
    vi.stubEnv('PATH', '/host/path-marker');
    vi.stubEnv('HTTP_PROXY', 'http://host-proxy.invalid:8080');
    vi.stubEnv('HTTPS_PROXY', 'https://host-proxy.invalid:8443');
    vi.stubEnv('ALL_PROXY', 'socks5://host-proxy.invalid:1080');
    vi.stubEnv('NO_PROXY', 'host-private.invalid');
    vi.stubEnv('DYLD_FAKE_MARKER', 'dyld-host-marker');
    const fixture = await createManagedDownloadFixture();
    fixtures.push(fixture);
    await downloadVideo({
      workspaceRoot: fixture.workspaceRoot,
      url: 'https://www.youtube.com/watch?v=strict',
      outputRoot: 'downloads',
      rightsConfirmed: true,
      proxy: parseDownloadProxy(proxySource),
      cookieAccessConfirmed: false,
    }, fixture.dependencies);
    const probeArgs = fixture.operations[0]?.args;
    const downloadArgs = fixture.operations[1]?.args;
    if (probeArgs === undefined || downloadArgs === undefined) {
      throw new Error('Expected strict fake invocations.');
    }
    const directRecordDirectory = path.join(fixture.root, 'direct-records');
    const directEnvironment = fixture.createSubprocessEnvironment({
      recordDirectory: directRecordDirectory,
    });
    expect(directEnvironment).toEqual({
      HOME: fixture.homeDirectory,
      PATH: [
        path.dirname(process.execPath),
        fixture.toolsDirectory,
        '/usr/bin',
        '/bin',
      ].join(path.delimiter),
      TMPDIR: fixture.temporaryDirectory,
      DENO_DIR: fixture.paths.denoDirectory,
      XDG_CACHE_HOME: fixture.paths.providerCacheDirectory,
      [DENO_EXECUTABLE_ENVIRONMENT_KEY]: path.join(
        fixture.toolsDirectory,
        'deno',
      ),
      DENO_NO_PROMPT: '1',
      DENO_NO_UPDATE_CHECK: '1',
      FORCE_COLOR: 'false',
      FAKE_YT_DLP_RECORD_DIRECTORY: directRecordDirectory,
      FAKE_YT_DLP_STATE_DIRECTORY: fixture.stateDirectory,
    });
    const direct = async (args: string[]) => await execFile(
      fixture.paths.ytDlpExecutable,
      args,
      {cwd: fixture.workspaceRoot, env: directEnvironment},
    );

    for (const forbidden of [
      '--geo-bypass',
      '--yes-playlist',
      '--batch-file',
      '--remux-video',
      '--recode-video',
    ]) {
      await expect(direct([
        ...probeArgs.slice(0, -1),
        forbidden,
        probeArgs.at(-1) ?? '',
      ])).rejects.toMatchObject({code: 64});
    }
    const proxyIndex = probeArgs.indexOf('--proxy');
    await expect(direct([
      ...probeArgs.slice(0, proxyIndex + 2),
      '--proxy',
      proxyUrl,
      ...probeArgs.slice(proxyIndex + 2),
    ])).rejects.toMatchObject({code: 64});
    const extractorIndex = probeArgs.indexOf('--extractor-args');
    const arbitraryExtractor = [...probeArgs];
    arbitraryExtractor[extractorIndex + 1] = 'youtube:player_client=secret';
    await expect(direct(arbitraryExtractor)).rejects.toMatchObject({code: 64});

    const mismatchDirectory = path.join(fixture.root, 'mismatch-records');
    const mismatchEnvironment = fixture.createSubprocessEnvironment({
      recordDirectory: mismatchDirectory,
    });
    await execFile(fixture.paths.ytDlpExecutable, probeArgs, {
      cwd: fixture.workspaceRoot,
      env: mismatchEnvironment,
    });
    const mismatchedDownload = [...downloadArgs];
    const downloadProxyIndex = mismatchedDownload.indexOf('--proxy');
    mismatchedDownload[downloadProxyIndex + 1] = 'https://127.0.0.1:7890/';
    await expect(execFile(
      fixture.paths.ytDlpExecutable,
      mismatchedDownload,
      {cwd: fixture.workspaceRoot, env: mismatchEnvironment},
    )).rejects.toMatchObject({code: 64});
  });

  it('contains no real network command or fetch implementation', async () => {
    const source = await readFile(FAKE_YT_DLP_FIXTURE, 'utf8');

    expect('curl https://example.invalid/video').toMatch(NETWORK_COMMAND);
    expect('/usr/local/bin/wget https://example.invalid/video')
      .toMatch(NETWORK_COMMAND);
    for (const control of [
      "import http from 'node:http';",
      "const https = require('node:https');",
      "const net = await import('node:net');",
      "import tls from 'node:tls';",
      "http.get('https://example.invalid');",
      "https.request('https://example.invalid');",
      "net.connect({host: 'example.invalid'});",
      "net.createConnection({host: 'example.invalid'});",
      "tls.connect({host: 'example.invalid'});",
    ]) {
      expect(control).toMatch(NODE_NETWORK_API);
    }
    expect(source).not.toMatch(NETWORK_COMMAND);
    expect(source).not.toMatch(NODE_NETWORK_API);
    expect(source).not.toMatch(/\bfetch\s*\(/u);
  });
});
