import {describe, expect, it} from 'vitest';
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';

describe('managed downloader toolchain paths', () => {
  it('resolves the fixed cache layout', () => {
    expect(resolveDownloaderToolchainPaths('/Users/tester')).toEqual({
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
    });
  });

  it.each(['Users/tester', '/'])(
    'rejects invalid home directory %j without echoing it',
    (homeDirectory) => {
      expect(() => resolveDownloaderToolchainPaths(homeDirectory)).toThrowError(
        expect.objectContaining({
          code: 'DOWNLOAD_TOOLCHAIN_INVALID',
          message: INVALID_TOOLCHAIN_MESSAGE,
        }),
      );
      try {
        resolveDownloaderToolchainPaths(homeDirectory);
      } catch (error) {
        expect(String(error)).not.toContain(homeDirectory);
      }
    },
  );
});
