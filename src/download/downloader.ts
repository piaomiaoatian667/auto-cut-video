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

export interface DownloadInput {
  workspaceRoot: string;
  url: string;
  outputRoot: string;
  rightsConfirmed: boolean;
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
  const root = await dependencies.archive.validateRoot(
    input.workspaceRoot,
    input.outputRoot,
  );
  const tools = input.signal === undefined
    ? await dependencies.client.checkTools()
    : await dependencies.client.checkTools(input.signal);
  const probe = input.signal === undefined
    ? await dependencies.client.probe(requested.url)
    : await dependencies.client.probe(requested.url, input.signal);
  assertExtractorMatches(requested.platform, probe.extractor);

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
      if (input.signal === undefined) {
        await dependencies.client.download(requested.url, authority.fd);
      } else {
        await dependencies.client.download(
          requested.url,
          authority.fd,
          input.signal,
        );
      }
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
