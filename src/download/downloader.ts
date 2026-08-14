import {
  cleanupArchive,
  finalizeArchive,
  openStagingDownloadAuthority,
  prepareArchive,
  validateArchiveRoot,
  type ArchivePreparation,
  type DownloadedArchive,
  type ExistingArchive,
  type FinalizeArchiveInput,
  type StagingDownloadAuthority,
  type StagedArchive,
  type ValidatedArchiveRoot,
} from './archive';
import {
  validateBrowserCookieRequest,
  type BrowserCookieSource,
} from './browser-cookies';
import {DownloadError} from './errors';
import {
  assertExtractorMatches,
  parseDownloadUrl,
  type DownloadPlatform,
} from './platforms';
import {
  createYtDlpClient,
  type YtDlpClient,
  type YtDlpClientOptions,
} from './yt-dlp';

const EXTRACTOR_MISMATCH_MESSAGE =
  'The resolved video platform did not match the requested platform.';
const RESTRICTED_AVAILABILITY = new Set([
  'private',
  'premium_only',
  'subscriber_only',
  'needs_auth',
]);

export interface DownloadInput {
  workspaceRoot: string;
  url: string;
  outputRoot: string;
  rightsConfirmed: boolean;
  browserCookieSource?: BrowserCookieSource;
  cookieAccessConfirmed: boolean;
  signal?: AbortSignal;
}

export type DownloadResult = DownloadedArchive | ExistingArchive;

export interface DownloadArchiveDependencies {
  validateRoot(
    workspaceRoot: string,
    outputRoot: string,
  ): Promise<ValidatedArchiveRoot>;
  prepare(
    root: ValidatedArchiveRoot,
    platform: DownloadPlatform,
    videoId: string,
  ): Promise<ArchivePreparation>;
  openStagingDownloadAuthority(
    prepared: StagedArchive,
  ): Promise<StagingDownloadAuthority>;
  finalize(
    prepared: StagedArchive,
    input: FinalizeArchiveInput,
  ): Promise<DownloadedArchive>;
  cleanup(prepared: StagedArchive): Promise<void>;
}

export interface DownloadDependencies {
  client: YtDlpClient;
  archive: DownloadArchiveDependencies;
  now(): Date;
}

export const downloadVideo = async (
  input: DownloadInput,
  dependencies: DownloadDependencies,
): Promise<DownloadResult> => {
  if (!input.rightsConfirmed) {
    throw new DownloadError(
      'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
      'Confirm that you are permitted to save this public video.',
    );
  }

  const requested = parseDownloadUrl(input.url);
  const browserCookieSource = validateBrowserCookieRequest(
    input.browserCookieSource,
    input.cookieAccessConfirmed,
    requested.platform,
  );
  const operationOptions =
    browserCookieSource === undefined && input.signal === undefined
      ? undefined
      : Object.freeze({
          ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
          ...(input.signal === undefined ? {} : {signal: input.signal}),
        });
  const root = await dependencies.archive.validateRoot(
    input.workspaceRoot,
    input.outputRoot,
  );
  const tools = input.signal === undefined
    ? await dependencies.client.checkTools()
    : await dependencies.client.checkTools(input.signal);
  const probe = await dependencies.client.probe(requested.url, operationOptions);
  assertExtractorMatches(requested.platform, probe.extractor);
  if (
    probe.availability !== null &&
    probe.availability !== undefined &&
    RESTRICTED_AVAILABILITY.has(probe.availability)
  ) {
    throw new DownloadError(
      'DOWNLOAD_CONTENT_RESTRICTED',
      'The requested video is not available as authorized public content.',
    );
  }

  let canonical: ReturnType<typeof parseDownloadUrl>;
  try {
    canonical = parseDownloadUrl(probe.canonicalUrl);
  } catch {
    throw new DownloadError(
      'DOWNLOAD_EXTRACTOR_MISMATCH',
      EXTRACTOR_MISMATCH_MESSAGE,
    );
  }
  if (canonical.platform !== requested.platform) {
    throw new DownloadError(
      'DOWNLOAD_EXTRACTOR_MISMATCH',
      EXTRACTOR_MISMATCH_MESSAGE,
    );
  }

  const prepared = await dependencies.archive.prepare(
    root,
    requested.platform,
    probe.id,
  );
  if (prepared.status === 'already-present') return prepared;

  try {
    const authority = await dependencies.archive.openStagingDownloadAuthority(
      prepared,
    );
    let downloadFailure: unknown;
    try {
      await dependencies.client.download(
        requested.url,
        authority.fd,
        operationOptions,
      );
    } catch (error) {
      downloadFailure = error;
    }
    try {
      await authority.close();
    } catch (error) {
      if (downloadFailure === undefined) throw error;
    }
    if (downloadFailure !== undefined) throw downloadFailure;

    return await dependencies.archive.finalize(prepared, {
      platform: requested.platform,
      videoId: probe.id,
      title: probe.title,
      canonicalUrl: canonical.url,
      downloadedAt: dependencies.now(),
      tools,
      ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
    });
  } catch (error) {
    try {
      await dependencies.archive.cleanup(prepared);
    } catch {
    }
    throw error;
  }
};

export const createSystemDownloadDependencies = (
  options: YtDlpClientOptions = {},
): DownloadDependencies => {
  const clientOptions: YtDlpClientOptions = {
    ...(options.runProcess === undefined
      ? {}
      : {runProcess: options.runProcess}),
    ...(options.ytDlpExecutable === undefined
      ? {}
      : {ytDlpExecutable: options.ytDlpExecutable}),
    ...(options.ffmpegExecutable === undefined
      ? {}
      : {ffmpegExecutable: options.ffmpegExecutable}),
  };

  return {
    client: createYtDlpClient(clientOptions),
    archive: {
      validateRoot: validateArchiveRoot,
      prepare: prepareArchive,
      openStagingDownloadAuthority,
      finalize: finalizeArchive,
      cleanup: cleanupArchive,
    },
    now: () => new Date(),
  };
};
