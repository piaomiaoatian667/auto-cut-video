import path from 'node:path';
import {DownloadError} from '../errors';
import type {DownloaderToolchainPaths} from './types';

export const resolveDownloaderToolchainPaths = (
  homeDirectory: string,
): DownloaderToolchainPaths => {
  if (
    !path.isAbsolute(homeDirectory) ||
    path.parse(homeDirectory).root === homeDirectory
  ) {
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
    providerCacheDirectory: path.join(
      versionDirectory,
      'deno/provider-cache',
    ),
    setupLock: path.join(cacheRoot, '.setup.lock'),
  };
};
