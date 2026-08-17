import path from 'node:path';
import {
  downloadCancellationFrom,
  throwIfDownloadCancelled,
} from '../cancellation';
import {DownloadError} from '../errors';
import {
  defaultDownloaderCapabilityDependencies,
  validateDownloaderCapabilities,
  type DownloaderCapabilityDependencies,
} from './capabilities';
import {currentUidHomeDirectory} from './home';
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

export interface ResolveDownloaderToolchainDependencies
  extends DownloaderCapabilityDependencies {
  uidHomeDirectory?(): string;
}

export const resolveDownloaderToolchain = async (
  options: ResolveDownloaderToolchainOptions = {},
  dependencies: ResolveDownloaderToolchainDependencies =
    defaultDownloaderCapabilityDependencies,
): Promise<ResolvedDownloaderToolchain> => {
  const relativeOverridePresent = (
    options.ytDlpOverride !== undefined
    && !path.isAbsolute(options.ytDlpOverride)
  ) || (
    options.ffmpegOverride !== undefined
    && !path.isAbsolute(options.ffmpegOverride)
  );
  const resolverCwd = relativeOverridePresent ? process.cwd() : undefined;
  const resolveOverride = (candidate: string | undefined): string | undefined => {
    if (candidate === undefined || path.isAbsolute(candidate)) return candidate;
    if (resolverCwd === undefined) throw invalidToolchain();
    return path.resolve(resolverCwd, candidate);
  };
  const ytDlpOverride = resolveOverride(options.ytDlpOverride);
  const ffmpegOverride = resolveOverride(options.ffmpegOverride);
  throwIfDownloadCancelled(options.signal);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw invalidToolchain();
  }
  const paths = resolveDownloaderToolchainPaths(
    options.homeDirectory
      ?? (dependencies.uidHomeDirectory ?? currentUidHomeDirectory)(),
  );
  let managedDirectoryExists: boolean;
  try {
    managedDirectoryExists = await dependencies.directoryExists(
      paths.versionDirectory,
    );
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidToolchain();
  }
  if (!managedDirectoryExists) {
    throw new DownloadError(
      'DOWNLOAD_TOOLCHAIN_MISSING',
      'The managed downloader is not installed. Run setup-downloader.',
    );
  }
  return await validateDownloaderCapabilities({
    source: ytDlpOverride === undefined ? 'managed' : 'override',
    validationMode: 'published',
    ytDlpExecutable: ytDlpOverride ?? paths.ytDlpExecutable,
    paths,
    ...(ffmpegOverride === undefined
      ? {}
      : {ffmpegOverride}),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  }, dependencies);
};
