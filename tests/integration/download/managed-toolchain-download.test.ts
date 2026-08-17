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
    const fixture = await createManagedDownloadFixture();
    fixtures.push(fixture);
    vi.stubEnv('NODE_OPTIONS', '--no-warnings');
    vi.stubEnv('NODE_PATH', '/host/node-path-marker');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'credential-marker');
    vi.stubEnv('SSH_AUTH_SOCK', '/host/ssh-agent-marker.sock');
    vi.stubEnv('OPENAI_API_KEY', 'openai-credential-marker');
    vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-credential-marker');
    vi.stubEnv('CUSTOM_RUNTIME_MARKER', 'custom-runtime-marker');
    vi.stubEnv('HOME', '/host/home-marker');
    vi.stubEnv('PATH', [
      'relative-path-marker',
      '/host/path-marker',
      '/host/path-marker',
      '/usr/bin',
    ].join(path.delimiter));
    vi.stubEnv('TMPDIR', fixture.temporaryDirectory);
    vi.stubEnv('LANG', 'en_US.UTF-8');
    vi.stubEnv('LC_ALL', 'C');
    vi.stubEnv('LC_CTYPE', 'C.UTF-8');
    vi.stubEnv('LC_MESSAGES', 'en_US.UTF-8');
    vi.stubEnv('LC_MODEL_TOKEN', 'locale-model-private-marker');
    vi.stubEnv('LC_SECRET', 'locale-secret-private-marker');
    vi.stubEnv('USER', 'fixture-user');
    vi.stubEnv('LOGNAME', 'fixture-logname');
    vi.stubEnv('__CF_USER_TEXT_ENCODING', '0x1F5:0x0:0x0');
    vi.stubEnv('SECURITYSESSIONID', 'fixture-security-session');
    vi.stubEnv('HTTP_PROXY', 'http://host-proxy.invalid:8080');
    vi.stubEnv('HTTPS_PROXY', 'https://host-proxy.invalid:8443');
    vi.stubEnv('ALL_PROXY', 'socks5://host-proxy.invalid:1080');
    vi.stubEnv('NO_PROXY', 'host-private.invalid');
    const run = fixture.createCommandHarness();

    const exitCode = await runVideoctl([
      'download',
      'https://www.douyin.com/video/environment',
      '--rights-confirmed',
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stderr()).toBe('');
    const expectedValidationEnvironment = {
      HOME: fixture.homeDirectory,
      PATH: [
        '/host/path-marker',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].join(path.delimiter),
      TMPDIR: fixture.temporaryDirectory,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      LC_CTYPE: 'C.UTF-8',
      LC_MESSAGES: 'en_US.UTF-8',
      USER: 'fixture-user',
      LOGNAME: 'fixture-logname',
      __CF_USER_TEXT_ENCODING: '0x1F5:0x0:0x0',
      SECURITYSESSIONID: 'fixture-security-session',
      DENO_DIR: fixture.paths.denoDirectory,
      XDG_CACHE_HOME: fixture.paths.providerCacheDirectory,
      DENO_NO_PROMPT: '1',
      DENO_NO_UPDATE_CHECK: '1',
      FORCE_COLOR: 'false',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    };
    const expectedChildEnvironment = {
      ...expectedValidationEnvironment,
      [DENO_EXECUTABLE_ENVIRONMENT_KEY]: path.join(
        fixture.toolsDirectory,
        'deno',
      ),
    };
    expect(fixture.subprocesses.length).toBeGreaterThan(fixture.operations.length);
    for (const subprocess of fixture.subprocesses) {
      expect([
        expectedValidationEnvironment,
        expectedChildEnvironment,
      ]).toContainEqual(subprocess.environment);
      expect(Object.isFrozen(subprocess.environment)).toBe(true);
    }
    for (const operation of fixture.operations) {
      expect(operation.environment).toEqual(expectedChildEnvironment);
      expect(Object.isFrozen(operation.environment)).toBe(true);
    }
    expect(expectedChildEnvironment.PATH.split(path.delimiter))
      .toContain('/usr/bin');
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
      'SSH_AUTH_SOCK',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'CUSTOM_RUNTIME_MARKER',
      'LC_MODEL_TOKEN',
      'LC_SECRET',
      'credential-marker',
      'ssh-agent-marker',
      'openai-credential-marker',
      'anthropic-credential-marker',
      'custom-runtime-marker',
      'locale-model-private-marker',
      'locale-secret-private-marker',
      '/host/home-marker',
      'relative-path-marker',
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

  it('uses one absolute override identity for doctor, probe, and staged download', async () => {
    const fixture = await createManagedDownloadFixture({relativeOverrides: true});
    fixtures.push(fixture);
    const originalCwd = process.cwd();
    process.chdir(fixture.root);
    try {
      const capabilityCwd = process.cwd();
      const expectedYtDlpExecutable = path.resolve(
        capabilityCwd,
        'overrides/yt-dlp',
      );
      const expectedFfmpegExecutable = path.resolve(
        capabilityCwd,
        'overrides/ffmpeg',
      );
      const doctor = fixture.createCommandHarness();
      const doctorExitCode = await runVideoctl([
        'doctor-downloader',
        '--check-url',
        'https://vimeo.com/relative-override',
        '--rights-confirmed',
        '--json',
      ], doctor.dependencies);
      expect(doctorExitCode).toBe(EXIT_CODES.success);
      expect(doctor.stderr()).toBe('');

      const download = fixture.createCommandHarness();
      const downloadExitCode = await runVideoctl([
        'download',
        'https://vimeo.com/relative-override',
        '--rights-confirmed',
        '--json',
      ], download.dependencies);
      expect(downloadExitCode).toBe(EXIT_CODES.success);
      expect(download.stderr()).toBe('');

      expect(fixture.operations.map((operation) => operation.phase)).toEqual([
        'probe',
        'probe',
        'download',
      ]);
      const probeCommands = fixture.subprocesses.filter((subprocess) =>
        subprocess.args.includes('--dump-single-json')
      ).map((subprocess) => subprocess.command);
      expect(probeCommands).toEqual([
        expectedYtDlpExecutable,
        expectedYtDlpExecutable,
      ]);
      expect(fixture.subprocesses.filter((subprocess) =>
        subprocess.args.length === 1 && subprocess.args[0] === '--version'
      ).map((subprocess) => subprocess.command)).toContain(
        expectedYtDlpExecutable,
      );
      expect(fixture.subprocesses).toContainEqual(expect.objectContaining({
        command: expectedFfmpegExecutable,
        args: ['-version'],
      }));
      const stagedDownload = fixture.subprocesses.filter((subprocess) =>
        subprocess.command === '/usr/bin/osascript'
      ).at(-1);
      expect(stagedDownload).toBeDefined();
      const separator = stagedDownload?.args.indexOf('--') ?? -1;
      expect(stagedDownload?.args[separator + 1]).toBe(
        expectedYtDlpExecutable,
      );
      const downloadArguments = fixture.operations.at(-1)?.args ?? [];
      const ffmpegLocation = downloadArguments.indexOf('--ffmpeg-location');
      expect(ffmpegLocation).toBeGreaterThanOrEqual(0);
      expect(downloadArguments[ffmpegLocation + 1]).toBe(
        expectedFfmpegExecutable,
      );
      expect(fixture.subprocesses.some((subprocess) =>
        subprocess.command === 'overrides/yt-dlp'
        || subprocess.command === 'overrides/ffmpeg'
      )).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }
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
        expect(environment.FAKE_YT_DLP_RECORD_DIRECTORY).toBeUndefined();
        expect(environment.FAKE_YT_DLP_STATE_DIRECTORY).toBeUndefined();
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
    const directEnvironment = fixture.createHarnessEnvironment({
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
    const mismatchEnvironment = fixture.createHarnessEnvironment({
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
