import {homedir} from 'node:os';
import {DownloadError} from '../errors';
import {
  defaultDownloaderCapabilityDependencies,
  validateDownloaderCapabilities,
  type DownloaderCapabilityDependencies,
} from './capabilities';
import {resolveDownloaderToolchainPaths} from './paths';
import type {ResolvedDownloaderToolchain} from './types';

const invalidToolchain = (): DownloadError => new DownloadError(
  'DOWNLOAD_TOOLCHAIN_INVALID',
  'The managed downloader failed integrity or capability checks.',
);

export interface ResolveDownloaderToolchainOptions {
  ytDlpOverride?: string;
  ffmpegOverride?: string;
  homeDirectory?: string;
  signal?: AbortSignal;
}

export const resolveDownloaderToolchain = async (
  options: ResolveDownloaderToolchainOptions = {},
  dependencies: DownloaderCapabilityDependencies =
    defaultDownloaderCapabilityDependencies,
): Promise<ResolvedDownloaderToolchain> => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw invalidToolchain();
  }
  const paths = resolveDownloaderToolchainPaths(
    options.homeDirectory ?? homedir(),
  );
  let managedDirectoryExists: boolean;
  try {
    managedDirectoryExists = await dependencies.directoryExists(
      paths.versionDirectory,
    );
  } catch {
    throw invalidToolchain();
  }
  if (!managedDirectoryExists) {
    throw new DownloadError(
      'DOWNLOAD_TOOLCHAIN_MISSING',
      'The managed downloader is not installed. Run setup-downloader.',
    );
  }
  return await validateDownloaderCapabilities({
    source: options.ytDlpOverride === undefined ? 'managed' : 'override',
    validationMode: 'published',
    ytDlpExecutable: options.ytDlpOverride ?? paths.ytDlpExecutable,
    paths,
    ...(options.ffmpegOverride === undefined
      ? {}
      : {ffmpegOverride: options.ffmpegOverride}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  }, dependencies);
};
