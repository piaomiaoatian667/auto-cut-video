import type {Stats} from 'node:fs';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  buildDownloaderChildEnvironment,
  compareYtDlpVersions,
  pluginEntriesMatch,
  validateDownloaderCapabilities,
  type DownloaderCapabilityDependencies,
  type ValidateDownloaderCapabilitiesOptions,
} from '../../../src/download/toolchain/capabilities';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from '../../../src/download/toolchain/manifest';
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';
import type {DownloaderToolchainPaths} from '../../../src/download/toolchain/types';
import type {DownloadError, DownloadErrorCode} from '../../../src/download/errors';
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
const pluginOutput = [
  'yt_dlp_plugins/',
  'yt_dlp_plugins/extractor/',
  'yt_dlp_plugins/extractor/getpot_bgutil.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
  '',
].join('\n');
const paths = resolveDownloaderToolchainPaths('/Users/tester');
const providerHeadPath = path.join(paths.providerDirectory, '.git/HEAD');
const currentUid = 501;
const denoExecutable = '/private/tools/deno';
const ffmpegExecutable = '/private/tools/ffmpeg';

interface CapabilityOutputs {
  version: string;
  help: string;
  deno: string;
  plugin: string;
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
  readFile: ReturnType<typeof vi.fn<DownloaderCapabilityDependencies['readFile']>>;
  resolveExecutable: ReturnType<
    typeof vi.fn<DownloaderCapabilityDependencies['resolveExecutable']>
  >;
}

const regularFileStats = (
  uid = currentUid,
  symbolicLink = false,
): Stats => ({
  uid,
  isFile: () => !symbolicLink,
  isSymbolicLink: () => symbolicLink,
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
    targets: targetsOutput,
    ffmpeg: ffmpegOutput,
  };
  const files = new Map<string, string>([
    [
      toolchainPaths.installedManifest,
      `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
    ],
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
        return resultFor(command, args);
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
  const dependencies: DownloaderCapabilityDependencies = {
    runProcess,
    directoryExists: vi.fn(async () => true),
    lstat: vi.fn(async (candidate) => stats.get(candidate) ?? regularFileStats()),
    readFile,
    hashFile: vi.fn(async (candidate) => {
      const digest = hashes.get(candidate);
      if (digest === undefined) throw new Error(`private hash path ${candidate}`);
      return digest;
    }),
    currentUid: () => currentUid,
    resolveExecutable,
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
    readFile,
    resolveExecutable,
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

  it('matches only the exact ordered plugin entries', () => {
    expect(pluginEntriesMatch(pluginOutput)).toBe(true);
    expect(pluginEntriesMatch([
      'yt_dlp_plugins/',
      'yt_dlp_plugins/extractor/getpot_bgutil.py',
      'yt_dlp_plugins/extractor/',
      'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
      'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
    ].join('\n'))).toBe(false);
    expect(pluginEntriesMatch(`${pluginOutput}unexpected.py\n`)).toBe(false);
  });

  it('builds a frozen proxy-free child environment from a snapshot', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HTTP_PROXY: 'http://private-marker',
      https_proxy: 'http://private-marker',
      All_Proxy: 'socks5://private-marker',
      no_PROXY: 'localhost',
      PRESERVED: 'closed-value',
    };

    const environment = buildDownloaderChildEnvironment(paths, source);
    source.PATH = '/mutated';

    expect(environment).toMatchObject({
      PATH: '/usr/bin',
      PRESERVED: 'closed-value',
      DENO_DIR: paths.denoDirectory,
      XDG_CACHE_HOME: paths.providerCacheDirectory,
      DENO_NO_PROMPT: '1',
      DENO_NO_UPDATE_CHECK: '1',
      FORCE_COLOR: 'false',
    });
    expect(Object.keys(environment).filter((key) => key.toLowerCase().includes('proxy')))
      .toEqual([]);
    expect(Object.isFrozen(environment)).toBe(true);
  });
});

describe('validateDownloaderCapabilities', () => {
  it('validates the exact managed toolchain and local command contract', async () => {
    const fixture = createCapabilityFixture();

    const resolved = await validateFixture(fixture);

    expect(resolved).toMatchObject({
      source: 'managed',
      ytDlpExecutable: paths.ytDlpExecutable,
      ffmpegExecutable,
      denoExecutable,
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
    expect(fixture.runProcess.mock.calls.slice(0, 4)).toEqual([
      [paths.ytDlpExecutable, ['--version'], {}],
      [paths.ytDlpExecutable, ['--help'], {}],
      [denoExecutable, ['--version'], {}],
      ['/usr/bin/unzip', ['-Z1', paths.pluginArchive], {}],
    ]);
    const providerCall = fixture.runProcess.mock.calls[4];
    expect(providerCall).toEqual([
      denoExecutable,
      [
        'run',
        '--allow-env',
        `--allow-ffi=${path.join(paths.providerServerDirectory, 'node_modules')}`,
        `--allow-read=${paths.providerServerDirectory},${path.join(paths.providerServerDirectory, 'node_modules')}`,
        `--allow-write=${paths.providerCacheDirectory}`,
        path.join(paths.providerServerDirectory, 'src/generate_once.ts'),
        '--version',
      ],
      {
        cwd: paths.providerServerDirectory,
        env: resolved.childEnvironment,
      },
    ]);
    expect(fixture.runProcess.mock.calls.slice(5)).toEqual([
      [paths.ytDlpExecutable, ['--list-impersonate-targets'], {}],
      [ffmpegExecutable, ['-version'], {}],
    ]);
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

  it('skips only the installed manifest read in staging mode', async () => {
    const fixture = createCapabilityFixture();
    fixture.files.delete(paths.installedManifest);

    await expect(validateFixture(fixture, {validationMode: 'staging'}))
      .resolves.toMatchObject({source: 'managed'});
    expect(fixture.readFile).not.toHaveBeenCalledWith(paths.installedManifest, 'utf8');
    expect(fixture.readFile).toHaveBeenCalledWith(providerHeadPath, 'utf8');
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
