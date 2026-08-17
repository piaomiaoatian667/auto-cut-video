import type {Stats} from 'node:fs';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {DownloaderCapabilityDependencies} from '../../../src/download/toolchain/capabilities';
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
  for (const marker of privateMarkers) {
    expect(String(caught)).not.toContain(marker);
  }
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDownloaderToolchain', () => {
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
      ytDlpVersion: '2026.07.04',
    });
    expect(fixture.directoryExists).toHaveBeenCalledWith(paths.versionDirectory);
    expect(fixture.runProcess.mock.calls[0]?.[0]).toBe(ytDlpOverride);
    expect(fixture.hashFile).not.toHaveBeenCalledWith(paths.ytDlpExecutable);
    expect(fixture.runProcess.mock.calls.some(([command]) => command === 'yt-dlp'))
      .toBe(false);
    expect(fixture.resolveExecutable.mock.calls).toEqual([['deno'], ['ffmpeg']]);
  });

  it('uses only the exact managed cache path when no override is present', async () => {
    const fixture = createResolverFixture();

    const resolved = await resolveDownloaderToolchain(
      {homeDirectory},
      fixture.dependencies,
    );

    expect(resolved).toMatchObject({
      source: 'managed',
      ytDlpExecutable: paths.ytDlpExecutable,
    });
    expect(fixture.runProcess.mock.calls[0]?.[0]).toBe(paths.ytDlpExecutable);
    expect(fixture.runProcess.mock.calls.some(([command]) => command === 'yt-dlp'))
      .toBe(false);
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
