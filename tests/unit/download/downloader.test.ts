import {describe, expect, it, vi} from 'vitest';
import {
  cleanupArchive,
  finalizeArchive,
  prepareArchive,
  validateArchiveRoot,
  type ArchivePreparation,
  type DownloadedArchive,
  type ExistingArchive,
  type StagedArchive,
  type ValidatedArchiveRoot,
} from '../../../src/download/archive';
import {DownloadError} from '../../../src/download/errors';
import {
  createSystemDownloadDependencies,
  downloadVideo,
  type DownloadArchiveDependencies,
  type DownloadDependencies,
  type DownloadInput,
} from '../../../src/download/downloader';
import type {ProcessResult} from '../../../src/process/run-process';
import type {
  DownloadProcessRunner,
  DownloadToolVersions,
  YtDlpClient,
  YtDlpClientOptions,
  YtDlpProbe,
} from '../../../src/download/yt-dlp';

const RIGHTS_MESSAGE =
  'Confirm that you are permitted to save this public video.';
const EXTRACTOR_MISMATCH_MESSAGE =
  'The resolved video platform did not match the requested platform.';
const AUTHORITY_FD = 73;
const NOW = new Date('2026-08-13T08:00:00.000Z');
const TOOLS: DownloadToolVersions = {
  ytDlpVersion: '2026.08.01',
  ffmpegVersion: 'ffmpeg version 8.0',
};
const ROOT: ValidatedArchiveRoot = {
  workspaceRoot: '/workspace',
  absolutePath: '/workspace/downloads',
  relativePath: 'downloads',
};
const STAGED: StagedArchive = {
  status: 'staging',
  root: ROOT,
  platform: 'youtube',
  videoId: 'video-123',
  stagingDirectory: '/workspace/downloads/.staging/download-1',
  finalDirectory: '/workspace/downloads/youtube/video-123',
  relativeDirectory: 'downloads/youtube/video-123',
};
const RECEIPT = {
  version: 1 as const,
  status: 'downloaded' as const,
  platform: 'youtube' as const,
  videoId: 'video-123',
  title: 'Example title',
  canonicalUrl: 'https://www.youtube.com/watch?v=video-123',
  downloadedAt: NOW.toISOString(),
  purpose: 'learning-analysis' as const,
  rightsConfirmed: true as const,
  transcoded: false as const,
  tools: TOOLS,
  files: [
    {
      role: 'metadata' as const,
      path: 'video.info.json',
      bytes: 10,
      sha256: `sha256:${'0'.repeat(64)}`,
    },
    {
      role: 'media' as const,
      path: 'video.webm',
      bytes: 20,
      sha256: `sha256:${'1'.repeat(64)}`,
    },
  ],
};
const EXISTING: ExistingArchive = {
  status: 'already-present',
  platform: 'youtube',
  videoId: 'video-123',
  directory: 'downloads/youtube/video-123',
  mediaPath: 'downloads/youtube/video-123/video.webm',
  receiptPath: 'downloads/youtube/video-123/receipt.json',
  receipt: RECEIPT,
};
const DOWNLOADED: DownloadedArchive = {
  status: 'downloaded',
  platform: 'youtube',
  videoId: 'video-123',
  directory: 'downloads/youtube/video-123',
  mediaPath: 'downloads/youtube/video-123/video.webm',
  receiptPath: 'downloads/youtube/video-123/receipt.json',
  receipt: RECEIPT,
};
const PROBE: YtDlpProbe = {
  id: 'video-123',
  title: 'Example title',
  canonicalUrl: 'https://WWW.YOUTUBE.COM:443/watch?v=video-123#resolved',
  extractor: 'Youtube',
};
const INPUT: DownloadInput = {
  workspaceRoot: '/workspace',
  url: 'https://YOUTU.BE:443/video-123#tracking',
  outputRoot: 'downloads',
  rightsConfirmed: true,
  cookieAccessConfirmed: false,
};

interface HarnessOptions {
  preparation?: ArchivePreparation;
  probe?: YtDlpProbe;
  checkToolsPromise?: Promise<DownloadToolVersions>;
  probePromise?: Promise<YtDlpProbe>;
  preparationPromise?: Promise<ArchivePreparation>;
  authorityOpenPromise?: Promise<{fd: number; close(): Promise<void>}>;
  authorityClosePromise?: Promise<void>;
  downloadPromise?: Promise<void>;
  downloadImplementation?: YtDlpClient['download'];
  finalizePromise?: Promise<DownloadedArchive>;
  cleanupPromise?: Promise<void>;
  authorityOpenError?: unknown;
  authorityCloseError?: unknown;
  downloadError?: unknown;
  finalizeError?: unknown;
  cleanupError?: unknown;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolvePromise!: Deferred<T>['resolve'];
  let rejectPromise!: Deferred<T>['reject'];
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {promise, resolve: resolvePromise, reject: rejectPromise};
};

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};

const makeHarness = (options: HarnessOptions = {}) => {
  const calls: string[] = [];
  const validateRoot = vi.fn<DownloadArchiveDependencies['validateRoot']>(
    async () => {
      calls.push('validateRoot');
      return ROOT;
    },
  );
  const checkTools = vi.fn<YtDlpClient['checkTools']>(async () => {
    calls.push('checkTools');
    if (options.checkToolsPromise !== undefined) {
      return await options.checkToolsPromise;
    }
    return TOOLS;
  });
  const probe = vi.fn<YtDlpClient['probe']>(async () => {
    calls.push('probe');
    if (options.probePromise !== undefined) {
      return await options.probePromise;
    }
    return options.probe ?? PROBE;
  });
  const prepare = vi.fn<DownloadArchiveDependencies['prepare']>(async () => {
    calls.push('prepare');
    if (options.preparationPromise !== undefined) {
      return await options.preparationPromise;
    }
    return options.preparation ?? STAGED;
  });
  const closeAuthority = vi.fn(async () => {
    calls.push('closeAuthority');
    if (options.authorityClosePromise !== undefined) {
      await options.authorityClosePromise;
    }
    if ('authorityCloseError' in options) throw options.authorityCloseError;
  });
  const authority = {fd: AUTHORITY_FD, close: closeAuthority};
  const openStagingDownloadAuthority = vi.fn(async () => {
    calls.push('openAuthority');
    if (options.authorityOpenPromise !== undefined) {
      return await options.authorityOpenPromise;
    }
    if ('authorityOpenError' in options) throw options.authorityOpenError;
    return authority;
  });
  const download = vi.fn<YtDlpClient['download']>(async (...args) => {
    calls.push('download');
    if (options.downloadImplementation !== undefined) {
      return await options.downloadImplementation(...args);
    }
    if (options.downloadPromise !== undefined) {
      await options.downloadPromise;
    }
    if ('downloadError' in options) throw options.downloadError;
  });
  const finalize = vi.fn<DownloadArchiveDependencies['finalize']>(async () => {
    calls.push('finalize');
    if (options.finalizePromise !== undefined) {
      return await options.finalizePromise;
    }
    if ('finalizeError' in options) throw options.finalizeError;
    return DOWNLOADED;
  });
  const cleanup = vi.fn<DownloadArchiveDependencies['cleanup']>(async () => {
    calls.push('cleanup');
    if (options.cleanupPromise !== undefined) {
      await options.cleanupPromise;
    }
    if ('cleanupError' in options) throw options.cleanupError;
  });
  const now = vi.fn<DownloadDependencies['now']>(() => {
    calls.push('now');
    return NOW;
  });
  const dependencies = {
    client: {checkTools, probe, download},
    archive: {
      validateRoot,
      prepare,
      openStagingDownloadAuthority,
      finalize,
      cleanup,
    },
    now,
  } as unknown as DownloadDependencies;

  return {
    calls,
    dependencies,
    validateRoot,
    checkTools,
    probe,
    prepare,
    authority,
    openStagingDownloadAuthority,
    closeAuthority,
    download,
    finalize,
    cleanup,
    now,
  };
};

const captureRejection = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected operation to reject.');
};

const processResult = (stdout: string): ProcessResult => ({
  command: 'tool',
  args: [],
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  durationMs: 1,
});

describe('downloadVideo', () => {
  it('requires the explicit DownloadInput cookie access contract', () => {
    const inputWithoutCookieAccessState = {
      workspaceRoot: INPUT.workspaceRoot,
      url: INPUT.url,
      outputRoot: INPUT.outputRoot,
      rightsConfirmed: INPUT.rightsConfirmed,
    };
    // @ts-expect-error cookieAccessConfirmed is required.
    const typedInput: DownloadInput = inputWithoutCookieAccessState;

    expect(typedInput).toBe(inputWithoutCookieAccessState);
  });

  it('rejects unconfirmed rights before URL parsing or dependencies', async () => {
    const harness = makeHarness();
    const error = await captureRejection(downloadVideo({
      ...INPUT,
      url: 'not-a-url',
      rightsConfirmed: false,
    }, harness.dependencies));

    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({
      code: 'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
      message: RIGHTS_MESSAGE,
    });
    expect(harness.calls).toEqual([]);
    expect(harness.validateRoot).not.toHaveBeenCalled();
    expect(harness.checkTools).not.toHaveBeenCalled();
    expect(harness.probe).not.toHaveBeenCalled();
  });

  it('rejects a confirmed invalid URL before validating the archive root', async () => {
    const harness = makeHarness();

    const error = await captureRejection(downloadVideo({
      ...INPUT,
      url: 'not-a-url',
    }, harness.dependencies));

    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({code: 'DOWNLOAD_URL_INVALID'});
    expect(harness.calls).toEqual([]);
    expect(harness.validateRoot).not.toHaveBeenCalled();
    expect(harness.checkTools).not.toHaveBeenCalled();
    expect(harness.probe).not.toHaveBeenCalled();
  });

  it.each([
    [{browserCookieSource: 'chrome' as const, cookieAccessConfirmed: false},
      'DOWNLOAD_COOKIE_OPTIONS_INVALID'],
    [{cookieAccessConfirmed: true}, 'DOWNLOAD_COOKIE_OPTIONS_INVALID'],
  ] as const)('rejects mismatched Cookie acknowledgement before archive access', async (
    overrides,
    code,
  ) => {
    const harness = makeHarness();
    const error = await captureRejection(downloadVideo({
      ...INPUT,
      url: 'https://www.douyin.com/video/7654841525762919726',
      ...overrides,
    }, harness.dependencies));

    expect(error).toMatchObject({code});
    expect(harness.calls).toEqual([]);
  });

  it('rejects Chrome Cookie mode for non-Douyin before archive access', async () => {
    const harness = makeHarness();
    const error = await captureRejection(downloadVideo({
      ...INPUT,
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
    }, harness.dependencies));

    expect(error).toMatchObject({code: 'DOWNLOAD_COOKIE_HOST_UNSUPPORTED'});
    expect(harness.calls).toEqual([]);
  });

  it.each([
    {
      name: 'arbitrary source',
      input: {
        browserCookieSource: 'firefox:profile-marker',
        cookieAccessConfirmed: true,
      },
      forbidden: 'firefox:profile-marker',
    },
    {
      name: 'omitted confirmation',
      input: {browserCookieSource: 'chrome'},
    },
    {
      name: 'non-boolean confirmation',
      input: {
        browserCookieSource: 'chrome',
        cookieAccessConfirmed: 'true',
      },
    },
  ])('rejects runtime-invalid Cookie request $name before archive access', async ({
    input,
    forbidden,
  }) => {
    const harness = makeHarness();
    const runtimeInput = {
      workspaceRoot: INPUT.workspaceRoot,
      url: 'https://www.douyin.com/video/7654841525762919726',
      outputRoot: INPUT.outputRoot,
      rightsConfirmed: true,
      ...input,
    } as unknown as DownloadInput;

    const error = await captureRejection(downloadVideo(
      runtimeInput,
      harness.dependencies,
    ));

    expect(error).toBeInstanceOf(DownloadError);
    if (!(error instanceof DownloadError)) throw error;
    expect(error).toMatchObject({
      code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      message:
        'Chrome cookie access requires both browser selection and explicit confirmation.',
    });
    expect(error.cause).toBeUndefined();
    if (forbidden !== undefined) {
      expect(String(error)).not.toContain(forbidden);
    }
    expect(harness.calls).toEqual([]);
  });

  it.each(['private', 'premium_only', 'subscriber_only', 'needs_auth'])(
    'rejects restricted availability %s before staging',
    async (availability) => {
      const harness = makeHarness({
        probe: {
          id: '7654841525762919726',
          title: 'Restricted fixture',
          canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
          extractor: 'Douyin',
          availability,
        },
      });

      const error = await captureRejection(downloadVideo({
        ...INPUT,
        url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
        browserCookieSource: 'chrome',
        cookieAccessConfirmed: true,
      }, harness.dependencies));

      expect(error).toMatchObject({
        code: 'DOWNLOAD_CONTENT_RESTRICTED',
        message:
          'The requested video is not available as authorized public content.',
      });
      expect(harness.calls).toEqual(['validateRoot', 'checkTools', 'probe']);
      expect(harness.prepare).not.toHaveBeenCalled();
    },
  );

  it('does not retry an anonymous probe with browser cookies', async () => {
    const probeFailure = new DownloadError(
      'DOWNLOAD_PROBE_FAILED',
      'Video metadata could not be extracted.',
    );
    const harness = makeHarness({probePromise: Promise.reject(probeFailure)});
    const anonymousInput = {
      ...INPUT,
      url: 'https://youtu.be/video-123',
    };

    const error = await captureRejection(downloadVideo(
      anonymousInput,
      harness.dependencies,
    ));

    expect(error).toBe(probeFailure);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.probe).toHaveBeenCalledWith(anonymousInput.url, undefined);
    expect(harness.download).not.toHaveBeenCalled();
  });

  it('uses one Chrome Cookie mode for probe, download, and receipt finalization', async () => {
    const douyinStaged: StagedArchive = {
      ...STAGED,
      platform: 'douyin',
      videoId: '7654841525762919726',
      finalDirectory: '/workspace/downloads/douyin/7654841525762919726',
      relativeDirectory: 'downloads/douyin/7654841525762919726',
    };
    const harness = makeHarness({
      probe: {
        id: '7654841525762919726',
        title: 'Public Douyin fixture',
        canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
        extractor: 'Douyin',
      },
      preparation: douyinStaged,
    });

    await downloadVideo({
      ...INPUT,
      url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
    }, harness.dependencies);

    expect(harness.probe).toHaveBeenCalledWith(
      'https://www.douyin.com/video/7654841525762919726',
      {browserCookieSource: 'chrome'},
    );
    expect(harness.download).toHaveBeenCalledWith(
      'https://www.douyin.com/video/7654841525762919726',
      AUTHORITY_FD,
      {browserCookieSource: 'chrome'},
    );
    const probeOperationOptions = harness.probe.mock.calls[0]?.[1];
    const downloadOperationOptions = harness.download.mock.calls[0]?.[2];
    expect(downloadOperationOptions).toBe(probeOperationOptions);
    expect(Object.isFrozen(probeOperationOptions)).toBe(true);
    expect(harness.finalize).toHaveBeenCalledWith(douyinStaged, {
      platform: 'douyin',
      videoId: '7654841525762919726',
      title: 'Public Douyin fixture',
      canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
      downloadedAt: NOW,
      tools: TOOLS,
      browserCookieSource: 'chrome',
    });
  });

  it('returns a verified existing archive without download or cleanup', async () => {
    const harness = makeHarness({preparation: EXISTING});

    await expect(downloadVideo(INPUT, harness.dependencies)).resolves.toBe(EXISTING);
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
    ]);
    expect(harness.download).not.toHaveBeenCalled();
    expect(harness.finalize).not.toHaveBeenCalled();
    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(harness.now).not.toHaveBeenCalled();
  });

  it('runs the staged download path in order and finalizes the canonical URL', async () => {
    const harness = makeHarness();

    await expect(downloadVideo(INPUT, harness.dependencies)).resolves.toBe(DOWNLOADED);
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
      'openAuthority',
      'download',
      'closeAuthority',
      'now',
      'finalize',
    ]);
    expect(harness.validateRoot).toHaveBeenCalledWith('/workspace', 'downloads');
    expect(harness.checkTools).toHaveBeenCalledWith();
    expect(harness.probe).toHaveBeenCalledWith(
      'https://youtu.be/video-123',
      undefined,
    );
    expect(harness.prepare).toHaveBeenCalledWith(ROOT, 'youtube', 'video-123');
    expect(harness.download).toHaveBeenCalledWith(
      'https://youtu.be/video-123',
      AUTHORITY_FD,
      undefined,
    );
    expect(harness.openStagingDownloadAuthority).toHaveBeenCalledWith(STAGED);
    expect(harness.closeAuthority).toHaveBeenCalledTimes(1);
    expect(harness.finalize).toHaveBeenCalledWith(STAGED, {
      platform: 'youtube',
      videoId: 'video-123',
      title: 'Example title',
      canonicalUrl: 'https://www.youtube.com/watch?v=video-123',
      downloadedAt: NOW,
      tools: TOOLS,
    });
    expect(harness.cleanup).not.toHaveBeenCalled();
  });

  it('passes one operation signal through checks, probe, and FD-bound download', async () => {
    const controller = new AbortController();
    const harness = makeHarness();

    await expect(downloadVideo({
      ...INPUT,
      signal: controller.signal,
    }, harness.dependencies)).resolves.toBe(DOWNLOADED);

    expect(harness.checkTools).toHaveBeenCalledWith(controller.signal);
    expect(harness.probe).toHaveBeenCalledWith(
      'https://youtu.be/video-123',
      {signal: controller.signal},
    );
    expect(harness.download).toHaveBeenCalledWith(
      'https://youtu.be/video-123',
      AUTHORITY_FD,
      {signal: controller.signal},
    );
    const probeOperationOptions = harness.probe.mock.calls[0]?.[1];
    const downloadOperationOptions = harness.download.mock.calls[0]?.[2];
    expect(downloadOperationOptions).toBe(probeOperationOptions);
    expect(Object.isFrozen(probeOperationOptions)).toBe(true);
  });

  it('awaits each asynchronous stage before starting the next stage', async () => {
    const toolsGate = createDeferred<DownloadToolVersions>();
    const probeGate = createDeferred<YtDlpProbe>();
    const preparationGate = createDeferred<ArchivePreparation>();
    const downloadGate = createDeferred<void>();
    const finalizeGate = createDeferred<DownloadedArchive>();
    const harness = makeHarness({
      checkToolsPromise: toolsGate.promise,
      probePromise: probeGate.promise,
      preparationPromise: preparationGate.promise,
      downloadPromise: downloadGate.promise,
      finalizePromise: finalizeGate.promise,
    });
    const pending = Symbol('pending');
    let outcome: unknown = pending;

    const operation = downloadVideo(INPUT, harness.dependencies);
    void operation.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await flushMicrotasks();
    expect(harness.calls).toEqual(['validateRoot', 'checkTools']);
    expect(harness.probe).not.toHaveBeenCalled();

    toolsGate.resolve(TOOLS);
    await flushMicrotasks();
    expect(harness.calls).toEqual(['validateRoot', 'checkTools', 'probe']);
    expect(harness.prepare).not.toHaveBeenCalled();

    probeGate.resolve(PROBE);
    await flushMicrotasks();
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
    ]);
    expect(harness.download).not.toHaveBeenCalled();

    preparationGate.resolve(STAGED);
    await flushMicrotasks();
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
      'openAuthority',
      'download',
    ]);
    expect(harness.finalize).not.toHaveBeenCalled();

    downloadGate.resolve();
    await flushMicrotasks();
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
      'openAuthority',
      'download',
      'closeAuthority',
      'now',
      'finalize',
    ]);
    expect(outcome).toBe(pending);

    finalizeGate.resolve(DOWNLOADED);
    await expect(operation).resolves.toBe(DOWNLOADED);
    expect(outcome).toBe(DOWNLOADED);
  });

  it('cleans once after download failure and rethrows the original error', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_PROCESS_FAILED',
      'The video could not be downloaded.',
    );
    const harness = makeHarness({
      downloadError: failure,
      cleanupError: new Error('cleanup failed'),
    });

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toBe(failure);
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
      'openAuthority',
      'download',
      'closeAuthority',
      'cleanup',
    ]);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.cleanup).toHaveBeenCalledWith(STAGED);
    expect(harness.closeAuthority).toHaveBeenCalledTimes(1);
    expect(harness.finalize).not.toHaveBeenCalled();
    expect(harness.now).not.toHaveBeenCalled();
  });

  it('waits for asynchronous cleanup before rethrowing a download failure', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_PROCESS_FAILED',
      'The video could not be downloaded.',
    );
    const downloadGate = createDeferred<void>();
    const cleanupGate = createDeferred<void>();
    const harness = makeHarness({
      downloadPromise: downloadGate.promise,
      cleanupPromise: cleanupGate.promise,
    });
    const pending = Symbol('pending');
    let outcome: unknown = pending;

    const operation = downloadVideo(INPUT, harness.dependencies);
    void operation.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await flushMicrotasks();
    expect(harness.download).toHaveBeenCalledTimes(1);

    downloadGate.reject(failure);
    await flushMicrotasks();
    expect(harness.closeAuthority).toHaveBeenCalledTimes(1);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(outcome).toBe(pending);

    cleanupGate.resolve();
    await flushMicrotasks();
    expect(outcome).toBe(failure);
    await expect(operation).rejects.toBe(failure);
  });

  it('waits for authority close and cleanup after cancellation before settling', async () => {
    const controller = new AbortController();
    const closeGate = createDeferred<void>();
    const cleanupGate = createDeferred<void>();
    const cancellationFailure = new DownloadError(
      'DOWNLOAD_PROCESS_FAILED',
      'The video could not be downloaded.',
    );
    const harness = makeHarness({
      authorityClosePromise: closeGate.promise,
      cleanupPromise: cleanupGate.promise,
      downloadImplementation: async (
        _url,
        _fd,
        operationOptions,
      ) => await new Promise(
        (_resolve, reject) => {
          const signal = operationOptions?.signal;
          if (signal === undefined) {
            reject(new Error('missing operation signal'));
            return;
          }
          signal.addEventListener('abort', () => reject(cancellationFailure), {
            once: true,
          });
        },
      ),
    });
    const pending = Symbol('pending');
    let outcome: unknown = pending;

    const operation = downloadVideo({
      ...INPUT,
      signal: controller.signal,
    }, harness.dependencies);
    void operation.then(
      (value) => { outcome = value; },
      (error: unknown) => { outcome = error; },
    );
    await flushMicrotasks();
    expect(harness.download).toHaveBeenCalledTimes(1);

    controller.abort(new Error('sanitized cancellation'));
    await flushMicrotasks();
    expect(harness.closeAuthority).toHaveBeenCalledTimes(1);
    expect(harness.cleanup).not.toHaveBeenCalled();
    expect(outcome).toBe(pending);

    closeGate.resolve();
    await flushMicrotasks();
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(outcome).toBe(pending);

    cleanupGate.resolve();
    await flushMicrotasks();
    expect(outcome).toBe(cancellationFailure);
    await expect(operation).rejects.toBe(cancellationFailure);
  });

  it('cleans once after finalize failure and rethrows the original error', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_FINALIZE_FAILED',
      'The download archive could not be finalized.',
    );
    const harness = makeHarness({
      finalizeError: failure,
      cleanupError: new Error('cleanup failed'),
    });

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toBe(failure);
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
      'openAuthority',
      'download',
      'closeAuthority',
      'now',
      'finalize',
      'cleanup',
    ]);
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(harness.cleanup).toHaveBeenCalledWith(STAGED);
  });

  it('cleans prepared staging when authority acquisition fails', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_FINALIZE_FAILED',
      'The download archive could not be finalized.',
    );
    const harness = makeHarness({authorityOpenError: failure});

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toBe(failure);
    expect(harness.calls).toEqual([
      'validateRoot',
      'checkTools',
      'probe',
      'prepare',
      'openAuthority',
      'cleanup',
    ]);
    expect(harness.download).not.toHaveBeenCalled();
    expect(harness.closeAuthority).not.toHaveBeenCalled();
    expect(harness.cleanup).toHaveBeenCalledWith(STAGED);
  });

  it('waits for failed asynchronous cleanup before rethrowing a finalize failure', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_FINALIZE_FAILED',
      'The download archive could not be finalized.',
    );
    const cleanupFailure = new Error('cleanup failed');
    const finalizeGate = createDeferred<DownloadedArchive>();
    const cleanupGate = createDeferred<void>();
    const harness = makeHarness({
      finalizePromise: finalizeGate.promise,
      cleanupPromise: cleanupGate.promise,
    });
    const pending = Symbol('pending');
    let outcome: unknown = pending;

    const operation = downloadVideo(INPUT, harness.dependencies);
    void operation.then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await flushMicrotasks();
    expect(harness.finalize).toHaveBeenCalledTimes(1);

    finalizeGate.reject(failure);
    await flushMicrotasks();
    expect(harness.cleanup).toHaveBeenCalledTimes(1);
    expect(outcome).toBe(pending);

    cleanupGate.reject(cleanupFailure);
    await flushMicrotasks();
    expect(outcome).toBe(failure);
    await expect(operation).rejects.toBe(failure);
  });

  it('rejects an extractor mismatch before staging', async () => {
    const harness = makeHarness({
      probe: {...PROBE, extractor: 'Vimeo'},
    });

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({
      code: 'DOWNLOAD_EXTRACTOR_MISMATCH',
      message: EXTRACTOR_MISMATCH_MESSAGE,
    });
    expect(harness.calls).toEqual(['validateRoot', 'checkTools', 'probe']);
    expect(harness.prepare).not.toHaveBeenCalled();
  });

  it('rejects an extractor mismatch before parsing the canonical URL', async () => {
    const harness = makeHarness({
      probe: {
        ...PROBE,
        canonicalUrl: 'not-a-url',
        extractor: 'Vimeo',
      },
    });

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({
      code: 'DOWNLOAD_EXTRACTOR_MISMATCH',
      message: EXTRACTOR_MISMATCH_MESSAGE,
    });
    expect(harness.calls).toEqual(['validateRoot', 'checkTools', 'probe']);
    expect(harness.prepare).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', 'not-a-url'],
    ['HTTP', 'http://www.youtube.com/watch?v=video-123'],
    ['unsupported-host', 'https://example.com/watch?v=video-123'],
  ])('maps a matching-extractor %s canonical URL to mismatch before staging', async (
    _caseName,
    canonicalUrl,
  ) => {
    const harness = makeHarness({
      probe: {...PROBE, canonicalUrl},
    });

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({
      code: 'DOWNLOAD_EXTRACTOR_MISMATCH',
      message: EXTRACTOR_MISMATCH_MESSAGE,
    });
    expect(harness.calls).toEqual(['validateRoot', 'checkTools', 'probe']);
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.download).not.toHaveBeenCalled();
    expect(harness.cleanup).not.toHaveBeenCalled();
  });

  it('rejects a canonical platform mismatch before staging', async () => {
    const harness = makeHarness({
      probe: {...PROBE, canonicalUrl: 'https://vimeo.com/987#resolved'},
    });

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toBeInstanceOf(DownloadError);
    expect(error).toMatchObject({
      code: 'DOWNLOAD_EXTRACTOR_MISMATCH',
      message: EXTRACTOR_MISMATCH_MESSAGE,
    });
    expect(harness.calls).toEqual(['validateRoot', 'checkTools', 'probe']);
    expect(harness.prepare).not.toHaveBeenCalled();
  });
});

describe('createSystemDownloadDependencies', () => {
  it('binds the archive adapters and controlled yt-dlp options', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult('yt-dlp custom\n'))
      .mockResolvedValueOnce(processResult('ffmpeg custom\n'));
    const options: YtDlpClientOptions = {
      runProcess,
      ytDlpExecutable: '/tools/yt-dlp',
      ffmpegExecutable: '/tools/ffmpeg',
    };

    const dependencies = createSystemDownloadDependencies(options);

    expect(dependencies.archive).toEqual({
      validateRoot: validateArchiveRoot,
      prepare: prepareArchive,
      openStagingDownloadAuthority: expect.any(Function),
      finalize: finalizeArchive,
      cleanup: cleanupArchive,
    });
    await expect(dependencies.client.checkTools()).resolves.toEqual({
      ytDlpVersion: 'yt-dlp custom',
      ffmpegVersion: 'ffmpeg custom',
    });
    expect(runProcess.mock.calls).toEqual([
      ['/tools/yt-dlp', ['--version']],
      ['/tools/ffmpeg', ['-version']],
    ]);
    const firstNow = dependencies.now();
    const secondNow = dependencies.now();
    expect(firstNow).toBeInstanceOf(Date);
    expect(secondNow).toBeInstanceOf(Date);
    expect(firstNow).not.toBe(secondNow);
  });

  it('snapshots safe client options before caller mutation', async () => {
    const originalRunProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult('yt-dlp original\n'))
      .mockResolvedValueOnce(processResult('ffmpeg original\n'))
      .mockResolvedValueOnce(processResult(''));
    const mutatedRunProcess = vi.fn<DownloadProcessRunner>();
    const options: YtDlpClientOptions = {
      runProcess: originalRunProcess,
      ytDlpExecutable: '/tools/original-yt-dlp',
      ffmpegExecutable: '/tools/original-ffmpeg',
    };
    const dependencies = createSystemDownloadDependencies(options);

    options.runProcess = mutatedRunProcess;
    options.ytDlpExecutable = '/tools/mutated-yt-dlp';
    options.ffmpegExecutable = '/tools/mutated-ffmpeg';

    await dependencies.client.checkTools();
    await dependencies.client.download(
      'https://youtu.be/video-123',
      AUTHORITY_FD,
    );

    expect(mutatedRunProcess).not.toHaveBeenCalled();
    expect(originalRunProcess).toHaveBeenNthCalledWith(
      1,
      '/tools/original-yt-dlp',
      ['--version'],
    );
    expect(originalRunProcess).toHaveBeenNthCalledWith(
      2,
      '/tools/original-ffmpeg',
      ['-version'],
    );
    expect(originalRunProcess).toHaveBeenNthCalledWith(
      3,
      '/usr/bin/osascript',
      expect.arrayContaining([
        '/tools/original-yt-dlp',
        '--ffmpeg-location',
        '/tools/original-ffmpeg',
        'https://youtu.be/video-123',
      ]),
      {extraStdioFds: [AUTHORITY_FD]},
    );
    expect(originalRunProcess.mock.calls[2]?.[1])
      .not.toContain('/tools/mutated-ffmpeg');
  });
});
