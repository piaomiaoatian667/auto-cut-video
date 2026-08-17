import type {Stats} from 'node:fs';
import {homedir, userInfo} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {DownloaderCapabilityDependencies} from '../../../src/download/toolchain/capabilities';
import {DENO_WRAPPER_SOURCE} from '../../../src/download/toolchain/deno-wrapper';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from '../../../src/download/toolchain/manifest';
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';
import {resolveDownloaderToolchain} from '../../../src/download/toolchain/resolver';
import type {DownloadProcessRunner} from '../../../src/download/yt-dlp';
import type {ProcessResult} from '../../../src/process/run-process';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';
const MISSING_TOOLCHAIN_MESSAGE =
  'The managed downloader is not installed. Run setup-downloader.';
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
const homeDirectory = '/Users/resolver-test';
const paths = resolveDownloaderToolchainPaths(homeDirectory);
const denoExecutable = '/private/tools/deno';
const ffmpegExecutable = '/private/tools/ffmpeg';
const currentUid = 501;

interface ResolverFixture {
  dependencies: DownloaderCapabilityDependencies;
  state: {
    directoryPresent: boolean;
    downloaderHash: string;
    versionOutput: string;
  };
  directoryExists: ReturnType<typeof vi.fn>;
  hashFile: ReturnType<typeof vi.fn>;
  runProcess: ReturnType<typeof vi.fn>;
  resolveExecutable: ReturnType<typeof vi.fn>;
}

const regularFileStats = (): Stats => ({
  uid: currentUid,
  mode: 0o700,
  isFile: () => true,
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

const createResolverFixture = (): ResolverFixture => {
  const state = {
    directoryPresent: true,
    downloaderHash: DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256 as string,
    versionOutput,
  };
  const directoryExists = vi.fn(async () => state.directoryPresent);
  const hashFile = vi.fn(async (candidate: string) => {
    if (candidate === paths.ytDlpExecutable) return state.downloaderHash;
    if (candidate === paths.pluginArchive) {
      return DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256;
    }
    throw new Error(`private hash path ${candidate}`);
  });
  const runProcess = vi.fn<DownloadProcessRunner>(async (command, args) => {
    if (args.length === 1 && args[0] === '--version') {
      return resultFor(
        command,
        args,
        command === denoExecutable ? denoOutput : state.versionOutput,
      );
    }
    if (args.length === 1 && args[0] === '--help') {
      return resultFor(command, args, helpOutput);
    }
    if (command === '/usr/bin/unzip') {
      return resultFor(command, args, pluginOutput);
    }
    if (args[0] === 'run') return resultFor(command, args);
    if (args.length === 1 && args[0] === '--list-impersonate-targets') {
      return resultFor(command, args, targetsOutput);
    }
    if (args.length === 1 && args[0] === '-version') {
      return resultFor(command, args, ffmpegOutput);
    }
    throw new Error(`unexpected private command ${command}`);
  });
  const resolveExecutable = vi.fn(async (name: 'deno' | 'ffmpeg') =>
    name === 'deno' ? denoExecutable : ffmpegExecutable);
  const dependencies: DownloaderCapabilityDependencies = {
    runProcess,
    directoryExists,
    lstat: vi.fn(async () => regularFileStats()),
    readFile: vi.fn(async (candidate: string) => {
      if (candidate === paths.installedManifest) {
        return `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`;
      }
      if (candidate === paths.denoWrapperExecutable) {
        return DENO_WRAPPER_SOURCE;
      }
      if (candidate === path.join(paths.providerDirectory, '.git/HEAD')) {
        return `${DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit}\n`;
      }
      throw new Error(`private read path ${candidate}`);
    }),
    hashFile,
    currentUid: () => currentUid,
    resolveExecutable,
  };
  return {
    dependencies,
    state,
    directoryExists,
    hashFile,
    runProcess,
    resolveExecutable,
  };
};

const expectResolverError = async (
  pending: Promise<unknown>,
  code: 'DOWNLOAD_TOOLCHAIN_MISSING' | 'DOWNLOAD_TOOLCHAIN_INVALID',
  message: string,
  privateMarkers: readonly string[] = [],
): Promise<void> => {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({name: 'DownloadError', code, message});
  expect((caught as Error & {cause?: unknown}).cause).toBeUndefined();
  for (const marker of privateMarkers) {
    expect(String(caught)).not.toContain(marker);
  }
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveDownloaderToolchain', () => {
  it('rejects a pre-aborted resolver signal with sanitized cancellation', async () => {
    const fixture = createResolverFixture();
    const controller = new AbortController();
    const privateReason = 'private resolver abort reason';
    controller.abort(new Error(privateReason));

    let caught: unknown;
    try {
      await resolveDownloaderToolchain({
        homeDirectory,
        signal: controller.signal,
      }, fixture.dependencies);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'DownloadCancellationError',
      message: 'The download operation was cancelled.',
    });
    expect(`${String(caught)}${JSON.stringify(caught)}`).not.toContain(privateReason);
    expect(fixture.directoryExists).not.toHaveBeenCalled();
    expect(fixture.runProcess).not.toHaveBeenCalled();
  });

  it('uses the current UID home when HOME poisons os.homedir()', async () => {
    const fixture = createResolverFixture();
    fixture.state.directoryPresent = false;
    const poisonedHome = '/private/poisoned';
    const uidHomeDirectory = userInfo().homedir;
    const uidPaths = resolveDownloaderToolchainPaths(uidHomeDirectory);
    vi.stubEnv('HOME', poisonedHome);

    expect(homedir()).toBe(poisonedHome);
    await expectResolverError(
      resolveDownloaderToolchain({}, fixture.dependencies),
      'DOWNLOAD_TOOLCHAIN_MISSING',
      MISSING_TOOLCHAIN_MESSAGE,
      [poisonedHome],
    );

    expect(fixture.directoryExists).toHaveBeenCalledWith(
      uidPaths.versionDirectory,
    );
  });

  it('uses an injected UID home for default resolver paths', async () => {
    const fixture = createResolverFixture();
    fixture.state.directoryPresent = false;
    const injectedHomeDirectory = '/Users/injected-resolver-home';
    const injectedPaths = resolveDownloaderToolchainPaths(
      injectedHomeDirectory,
    );
    const uidHomeDirectory = vi.fn(() => injectedHomeDirectory);
    const dependencies = {
      ...fixture.dependencies,
      uidHomeDirectory,
    };

    await expectResolverError(
      resolveDownloaderToolchain({}, dependencies),
      'DOWNLOAD_TOOLCHAIN_MISSING',
      MISSING_TOOLCHAIN_MESSAGE,
    );

    expect(uidHomeDirectory).toHaveBeenCalledTimes(1);
    expect(fixture.directoryExists).toHaveBeenCalledWith(
      injectedPaths.versionDirectory,
    );
  });

  it('uses an explicit override before the exact managed downloader', async () => {
    const fixture = createResolverFixture();
    const ytDlpOverride = '/private/overrides/yt-dlp';

    const resolved = await resolveDownloaderToolchain({
      ytDlpOverride,
      homeDirectory,
    }, fixture.dependencies);

    expect(resolved).toMatchObject({
      source: 'override',
      ytDlpExecutable: ytDlpOverride,
      denoExecutable: paths.denoWrapperExecutable,
      ytDlpVersion: '2026.07.04',
    });
    expect(fixture.directoryExists).toHaveBeenCalledWith(paths.versionDirectory);
    expect(fixture.runProcess.mock.calls[0]?.[0]).toBe(ytDlpOverride);
    expect(fixture.hashFile).not.toHaveBeenCalledWith(paths.ytDlpExecutable);
    expect(fixture.runProcess.mock.calls.some(([command]) => command === 'yt-dlp'))
      .toBe(false);
    expect(fixture.resolveExecutable.mock.calls).toEqual([['deno'], ['ffmpeg']]);
  });

  it('preserves absolute override strings without reading cwd', async () => {
    const fixture = createResolverFixture();
    const ytDlpOverride = '/private/overrides/linked-bin/../yt-dlp';
    const ffmpegOverride = '/private/overrides/linked-ffmpeg/../ffmpeg';
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue('/private/unneeded-cwd');

    try {
      const resolved = await resolveDownloaderToolchain({
        ytDlpOverride,
        ffmpegOverride,
        homeDirectory,
      }, fixture.dependencies);

      expect(cwd).not.toHaveBeenCalled();
      expect(resolved).toMatchObject({
        source: 'override',
        ytDlpExecutable: ytDlpOverride,
        ffmpegExecutable: ffmpegOverride,
        ffmpegExplicit: true,
      });
      expect(fixture.runProcess.mock.calls[0]?.[0]).toBe(ytDlpOverride);
      expect(fixture.runProcess).toHaveBeenCalledWith(
        ffmpegOverride,
        ['-version'],
        expect.objectContaining({env: expect.any(Object)}),
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('does not read cwd when no override is present', async () => {
    const fixture = createResolverFixture();
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('private cwd failure');
    });

    try {
      const resolved = await resolveDownloaderToolchain(
        {homeDirectory},
        fixture.dependencies,
      );

      expect(cwd).not.toHaveBeenCalled();
      expect(resolved).toMatchObject({
        source: 'managed',
        ytDlpExecutable: paths.ytDlpExecutable,
      });
    } finally {
      cwd.mockRestore();
    }
  });

  it('sanitizes cwd failures while resolving relative overrides', async () => {
    const fixture = createResolverFixture();
    const privateMarker = 'private deleted cwd /private/removed-workspace';
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error(privateMarker), {code: 'ENOENT'});
    });

    try {
      await expectResolverError(
        resolveDownloaderToolchain({
          ytDlpOverride: 'relative-tools/yt-dlp',
          homeDirectory,
        }, fixture.dependencies),
        'DOWNLOAD_TOOLCHAIN_INVALID',
        INVALID_TOOLCHAIN_MESSAGE,
        [privateMarker, '/private/removed-workspace'],
      );
      expect(fixture.directoryExists).not.toHaveBeenCalled();
      expect(fixture.runProcess).not.toHaveBeenCalled();
    } finally {
      cwd.mockRestore();
    }
  });

  it('snapshots cwd once for mixed absolute and relative overrides', async () => {
    const fixture = createResolverFixture();
    const resolverEntryCwd = '/private/resolver-entry-cwd';
    const laterCwd = '/private/resolver-later-cwd';
    const ytDlpOverride = '/private/overrides/linked-bin/../yt-dlp';
    const ffmpegOverride = 'relative-tools/ffmpeg';
    const absoluteFfmpegOverride = path.resolve(resolverEntryCwd, ffmpegOverride);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(resolverEntryCwd);
    fixture.directoryExists.mockImplementationOnce(async () => {
      await Promise.resolve();
      cwd.mockReturnValue(laterCwd);
      return true;
    });

    try {
      const resolved = await resolveDownloaderToolchain({
        ytDlpOverride,
        ffmpegOverride,
        homeDirectory,
      }, fixture.dependencies);

      expect(cwd).toHaveBeenCalledTimes(1);
      expect(resolved).toMatchObject({
        source: 'override',
        ytDlpExecutable: ytDlpOverride,
        ffmpegExecutable: absoluteFfmpegOverride,
        ffmpegExplicit: true,
      });
      expect(fixture.runProcess.mock.calls[0]?.[0]).toBe(ytDlpOverride);
      expect(fixture.runProcess).toHaveBeenCalledWith(
        absoluteFfmpegOverride,
        ['-version'],
        expect.objectContaining({env: expect.any(Object)}),
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('snapshots relative overrides before the async directory check changes cwd', async () => {
    const fixture = createResolverFixture();
    const resolverEntryCwd = '/private/resolver-entry-cwd';
    const laterCwd = '/private/resolver-later-cwd';
    const ytDlpOverride = 'relative-tools/yt-dlp';
    const ffmpegOverride = 'relative-tools/ffmpeg';
    const absoluteYtDlpOverride = path.resolve(resolverEntryCwd, ytDlpOverride);
    const absoluteFfmpegOverride = path.resolve(resolverEntryCwd, ffmpegOverride);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(resolverEntryCwd);
    fixture.directoryExists.mockImplementationOnce(async () => {
      await Promise.resolve();
      cwd.mockReturnValue(laterCwd);
      return true;
    });

    try {
      const resolved = await resolveDownloaderToolchain({
        ytDlpOverride,
        ffmpegOverride,
        homeDirectory,
      }, fixture.dependencies);

      expect(cwd).toHaveBeenCalledTimes(1);
      expect(resolved).toMatchObject({
        source: 'override',
        ytDlpExecutable: absoluteYtDlpOverride,
        ffmpegExecutable: absoluteFfmpegOverride,
        ffmpegExplicit: true,
      });
      expect(fixture.runProcess.mock.calls[0]?.[0]).toBe(absoluteYtDlpOverride);
      expect(fixture.runProcess).toHaveBeenCalledWith(
        absoluteFfmpegOverride,
        ['-version'],
        expect.objectContaining({env: expect.any(Object)}),
      );
      expect(fixture.resolveExecutable.mock.calls).toEqual([['deno']]);
    } finally {
      cwd.mockRestore();
    }
  });

  it('uses only the exact managed cache path when no override is present', async () => {
    const fixture = createResolverFixture();
    const uidHomeDirectory = vi.fn(() => '/Users/unused-uid-home');
    const dependencies = {
      ...fixture.dependencies,
      uidHomeDirectory,
    };

    const resolved = await resolveDownloaderToolchain(
      {homeDirectory},
      dependencies,
    );

    expect(resolved).toMatchObject({
      source: 'managed',
      ytDlpExecutable: paths.ytDlpExecutable,
      denoExecutable: paths.denoWrapperExecutable,
    });
    expect(fixture.runProcess.mock.calls[0]?.[0]).toBe(paths.ytDlpExecutable);
    expect(fixture.runProcess.mock.calls.some(([command]) => command === 'yt-dlp'))
      .toBe(false);
    expect(uidHomeDirectory).not.toHaveBeenCalled();
  });

  it('requires the managed cache even when an override is explicit', async () => {
    const fixture = createResolverFixture();
    fixture.state.directoryPresent = false;
    const ytDlpOverride = '/private/overrides/yt-dlp';

    await expectResolverError(
      resolveDownloaderToolchain({ytDlpOverride, homeDirectory}, fixture.dependencies),
      'DOWNLOAD_TOOLCHAIN_MISSING',
      MISSING_TOOLCHAIN_MESSAGE,
      [ytDlpOverride, paths.versionDirectory],
    );
    expect(fixture.runProcess).not.toHaveBeenCalled();
    expect(fixture.resolveExecutable).not.toHaveBeenCalled();
  });

  it.each(['EACCES', 'EIO'] as const)(
    'maps a managed directory %s failure to invalid without leaking details',
    async (code) => {
      const fixture = createResolverFixture();
      const privateMarker = `private ${code} ${paths.versionDirectory}`;
      fixture.directoryExists.mockRejectedValueOnce(
        Object.assign(new Error(privateMarker), {code}),
      );

      await expectResolverError(
        resolveDownloaderToolchain({homeDirectory}, fixture.dependencies),
        'DOWNLOAD_TOOLCHAIN_INVALID',
        INVALID_TOOLCHAIN_MESSAGE,
        [privateMarker, paths.versionDirectory],
      );
      expect(fixture.runProcess).not.toHaveBeenCalled();
      expect(fixture.resolveExecutable).not.toHaveBeenCalled();
    },
  );

  it('does not fall back to PATH after an invalid managed downloader', async () => {
    const fixture = createResolverFixture();
    fixture.state.downloaderHash = 'private-managed-hash';

    await expectResolverError(
      resolveDownloaderToolchain({homeDirectory}, fixture.dependencies),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      ['private-managed-hash', paths.ytDlpExecutable],
    );
    expect(fixture.runProcess.mock.calls.some(([command]) => command === 'yt-dlp'))
      .toBe(false);
    expect(fixture.resolveExecutable.mock.calls.some(([name]) => name === 'yt-dlp'))
      .toBe(false);
  });

  it('does not fall back to managed yt-dlp after an invalid override', async () => {
    const fixture = createResolverFixture();
    fixture.state.versionOutput = '2026.07.03\n';
    const ytDlpOverride = '/private/overrides/old-yt-dlp';

    await expectResolverError(
      resolveDownloaderToolchain({ytDlpOverride, homeDirectory}, fixture.dependencies),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [ytDlpOverride],
    );
    const versionCommands = fixture.runProcess.mock.calls
      .filter(([, args]) => args.length === 1 && args[0] === '--version')
      .map(([command]) => command);
    expect(versionCommands).not.toContain(paths.ytDlpExecutable);
    expect(versionCommands).not.toContain('yt-dlp');
  });

  it('rejects unsupported platforms before inspecting paths or tools', async () => {
    const fixture = createResolverFixture();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    await expectResolverError(
      resolveDownloaderToolchain({homeDirectory}, fixture.dependencies),
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
      [homeDirectory],
    );
    expect(fixture.directoryExists).not.toHaveBeenCalled();
    expect(fixture.runProcess).not.toHaveBeenCalled();
  });
});
