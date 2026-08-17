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
  type StagedArchive,
  type StagingDownloadAuthority,
  type ValidatedArchiveRoot,
} from './archive';
import {
  validateBrowserCookieRequest,
  type BrowserCookieSource,
} from './browser-cookies';
import {
  DownloadCancellationError,
  downloadCancellationFrom,
  throwIfDownloadCancelled,
} from './cancellation';
import {DownloadError} from './errors';
import {
  validateDownloadProxy,
  type DownloadProxy,
} from './network-options';
import {
  resolvePlatformProfile,
  type ResolvedPlatformProfile,
} from './platform-profiles';
import {
  assertExtractorMatches,
  parseDownloadUrl,
  type DownloadPlatform,
  type ValidatedDownloadUrl,
} from './platforms';
import {resolveDownloaderToolchain} from './toolchain/resolver';
import type {ResolvedDownloaderToolchain} from './toolchain/types';
import {
  createYtDlpClient,
  type DownloadProcessRunner,
  type SafeYtDlpMetadata,
  type YtDlpClient,
  type YtDlpProbe,
} from './yt-dlp';

const EXTRACTOR_MISMATCH_MESSAGE =
  'The resolved video platform did not match the requested platform.';
const RESTRICTED_AVAILABILITY = new Set([
  'private',
  'premium_only',
  'subscriber_only',
  'needs_auth',
]);

export interface DownloadCheckInput {
  url: string;
  rightsConfirmed: boolean;
  proxy?: DownloadProxy;
  browserCookieSource?: BrowserCookieSource;
  cookieAccessConfirmed: boolean;
  signal?: AbortSignal;
}

export interface DownloadCheckResult {
  platform: DownloadPlatform;
  result: 'available';
}

export interface DownloadInput extends DownloadCheckInput {
  workspaceRoot: string;
  outputRoot: string;
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
    canonicalUrl: string,
  ): Promise<ArchivePreparation>;
  openStagingDownloadAuthority(
    prepared: StagedArchive,
  ): Promise<StagingDownloadAuthority>;
  finalize(
    prepared: StagedArchive,
    input: FinalizeArchiveInput,
    signal?: AbortSignal,
  ): Promise<DownloadedArchive>;
  cleanup(prepared: StagedArchive): Promise<void>;
}

export interface DownloadDependencies {
  resolveToolchain(signal?: AbortSignal): Promise<ResolvedDownloaderToolchain>;
  createClient(toolchain: ResolvedDownloaderToolchain): YtDlpClient;
  archive: DownloadArchiveDependencies;
  wait(milliseconds: number, signal?: AbortSignal): Promise<void>;
  now(): Date;
}

export interface SystemDownloadOptions {
  ytDlpOverride?: string;
  ffmpegOverride?: string;
  homeDirectory?: string;
  runProcess?: DownloadProcessRunner;
}

interface ResolvedDownloadSession {
  requested: ValidatedDownloadUrl;
  toolchain: ResolvedDownloaderToolchain;
  profile: ResolvedPlatformProfile;
  client: YtDlpClient;
}

interface InspectedDownloadRequest extends ResolvedDownloadSession {
  canonical: ValidatedDownloadUrl;
  probe: YtDlpProbe;
}

const parseCanonicalForPlatform = (
  source: string,
  platform: DownloadPlatform,
): ValidatedDownloadUrl => {
  try {
    const canonical = parseDownloadUrl(source);
    if (canonical.platform !== platform) throw new Error();
    return canonical;
  } catch {
    throw new DownloadError(
      'DOWNLOAD_EXTRACTOR_MISMATCH',
      EXTRACTOR_MISMATCH_MESSAGE,
    );
  }
};

const resolveDownloadSession = async (
  input: DownloadCheckInput,
  dependencies: DownloadDependencies,
): Promise<ResolvedDownloadSession> => {
  if (input.rightsConfirmed !== true) {
    throw new DownloadError(
      'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
      'Confirm that you are permitted to save this public video.',
    );
  }
  const requested = parseDownloadUrl(input.url);
  const proxy = validateDownloadProxy(input.proxy);
  const browserCookieSource = validateBrowserCookieRequest(
    input.browserCookieSource,
    input.cookieAccessConfirmed,
    requested.platform,
  );
  const toolchain = await dependencies.resolveToolchain(input.signal);
  const profile = resolvePlatformProfile({
    platform: requested.platform,
    toolchain,
    ...(proxy === undefined ? {} : {proxy}),
    ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
  });
  return {
    requested,
    toolchain,
    profile,
    client: dependencies.createClient(toolchain),
  };
};

const inspectResolvedSession = async (
  session: ResolvedDownloadSession,
  signal?: AbortSignal,
): Promise<InspectedDownloadRequest> => {
  const probe = await session.client.probe(session.requested.url, {
    profile: session.profile,
    ...(signal === undefined ? {} : {signal}),
  });
  assertExtractorMatches(session.requested.platform, probe.extractor);
  if (
    probe.hasDrm ||
    (probe.availability !== undefined &&
      probe.availability !== null &&
      RESTRICTED_AVAILABILITY.has(probe.availability))
  ) {
    throw new DownloadError(
      'DOWNLOAD_CONTENT_RESTRICTED',
      'The requested video is not available as authorized public content.',
    );
  }
  const canonical = parseCanonicalForPlatform(
    probe.canonicalUrl,
    session.requested.platform,
  );
  return {...session, canonical, probe};
};

export const checkVideoDownload = async (
  input: DownloadCheckInput,
  dependencies: DownloadDependencies,
): Promise<DownloadCheckResult> => {
  const session = await resolveDownloadSession(input, dependencies);
  const checked = await inspectResolvedSession(session, input.signal);
  return {platform: checked.requested.platform, result: 'available'};
};

export const downloadVideo = async (
  input: DownloadInput,
  dependencies: DownloadDependencies,
): Promise<DownloadResult> => {
  const session = await resolveDownloadSession(input, dependencies);
  const root = await dependencies.archive.validateRoot(
    input.workspaceRoot,
    input.outputRoot,
  );
  const checked = await inspectResolvedSession(session, input.signal);
  const safeMetadata: SafeYtDlpMetadata = {
    id: checked.probe.id,
    title: checked.probe.title,
    webpage_url: checked.canonical.url,
    extractor: checked.probe.extractor,
    ...(checked.probe.extractorKey === undefined
      ? {}
      : {extractor_key: checked.probe.extractorKey}),
    _type: 'video',
  };
  const prepared = await dependencies.archive.prepare(
    root,
    checked.requested.platform,
    checked.probe.id,
    checked.canonical.url,
  );
  if (prepared.status === 'already-present') return prepared;

  try {
    await dependencies.wait(
      checked.profile.probeToDownloadDelayMs,
      input.signal,
    );
    const authority = await dependencies.archive.openStagingDownloadAuthority(
      prepared,
    );
    let authorityOperationFailure: unknown;
    try {
      await checked.client.download(
        checked.requested.url,
        authority.fd,
        {
          profile: checked.profile,
          ...(input.signal === undefined ? {} : {signal: input.signal}),
        },
      );
      throwIfDownloadCancelled(input.signal);
      await authority.writeMetadata(safeMetadata, input.signal);
      throwIfDownloadCancelled(input.signal);
    } catch (error) {
      authorityOperationFailure = downloadCancellationFrom(error) ?? error;
    }
    try {
      await authority.close();
    } catch (error) {
      if (authorityOperationFailure === undefined) {
        const cancellation = downloadCancellationFrom(error);
        if (cancellation !== undefined) throw cancellation;
        throwIfDownloadCancelled(input.signal);
        throw error;
      }
    }
    if (authorityOperationFailure !== undefined) throw authorityOperationFailure;
    throwIfDownloadCancelled(input.signal);

    const finalizeInput: FinalizeArchiveInput = {
      platform: checked.requested.platform,
      videoId: checked.probe.id,
      title: checked.probe.title,
      canonicalUrl: checked.canonical.url,
      downloadedAt: dependencies.now(),
      tools: {
        ytDlpVersion: checked.toolchain.ytDlpVersion,
        ffmpegVersion: checked.toolchain.ffmpegVersion,
      },
      browserCookies: checked.profile.browserCookies,
      network: checked.profile.networkAudit,
      toolchain: checked.profile.toolchainAudit,
    };
    throwIfDownloadCancelled(input.signal);
    return await dependencies.archive.finalize(
      prepared,
      finalizeInput,
      input.signal,
    );
  } catch (error) {
    const failure = downloadCancellationFrom(error) ?? error;
    try {
      await dependencies.archive.cleanup(prepared);
    } catch {
    }
    throw failure;
  }
};

export const waitForDownloadDelay = async (
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> => await new Promise((resolve, reject) => {
  if (signal?.aborted === true) {
    reject(new DownloadCancellationError());
    return;
  }
  const timer = setTimeout(settle, milliseconds);
  const abort = (): void => settle(new DownloadCancellationError(), true);
  function settle(reason?: unknown, aborted = false): void {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (aborted) reject(reason);
    else resolve();
  }
  signal?.addEventListener('abort', abort, {once: true});
});

export const createSystemDownloadDependencies = (
  options: SystemDownloadOptions = {},
): DownloadDependencies => {
  const resolverOptions = {
    ...(options.ytDlpOverride === undefined
      ? {}
      : {ytDlpOverride: options.ytDlpOverride}),
    ...(options.ffmpegOverride === undefined
      ? {}
      : {ffmpegOverride: options.ffmpegOverride}),
    ...(options.homeDirectory === undefined
      ? {}
      : {homeDirectory: options.homeDirectory}),
  };
  const runProcess = options.runProcess;

  return {
    resolveToolchain: async (signal) => await resolveDownloaderToolchain({
      ...resolverOptions,
      ...(signal === undefined ? {} : {signal}),
    }),
    createClient: (toolchain) => createYtDlpClient({
      toolchain,
      ...(runProcess === undefined ? {} : {runProcess}),
    }),
    archive: {
      validateRoot: validateArchiveRoot,
      prepare: prepareArchive,
      openStagingDownloadAuthority,
      finalize: finalizeArchive,
      cleanup: cleanupArchive,
    },
    wait: waitForDownloadDelay,
    now: () => new Date(),
  };
};
