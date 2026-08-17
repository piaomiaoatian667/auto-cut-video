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
  type StagingDownloadAuthority,
  type ValidatedArchiveRoot,
} from '../../../src/download/archive';
import {
  checkVideoDownload,
  createSystemDownloadDependencies,
  downloadVideo,
  waitForDownloadDelay,
  type DownloadArchiveDependencies,
  type DownloadDependencies,
  type DownloadInput,
  type SystemDownloadOptions,
} from '../../../src/download/downloader';
import {DownloadError} from '../../../src/download/errors';
import {parseDownloadProxy} from '../../../src/download/network-options';
import {resolvePlatformProfile} from '../../../src/download/platform-profiles';
import type {DownloadPlatform} from '../../../src/download/platforms';
import type {ResolvedDownloaderToolchain} from '../../../src/download/toolchain/types';
import type {
  DownloadProcessRunner,
  YtDlpClient,
  YtDlpProbe,
} from '../../../src/download/yt-dlp';
import type {ProcessResult} from '../../../src/process/run-process';

const RIGHTS_MESSAGE =
  'Confirm that you are permitted to save this public video.';
const EXTRACTOR_MISMATCH_MESSAGE =
  'The resolved video platform did not match the requested platform.';
const RESTRICTED_MESSAGE =
  'The requested video is not available as authorized public content.';
const AUTHORITY_FD = 73;
const NOW = new Date('2026-08-13T08:00:00.000Z');
const TOOLS = {
  ytDlpVersion: '2026.08.01',
  ffmpegVersion: 'ffmpeg version 8.0',
};
const TOOLCHAIN: ResolvedDownloaderToolchain = {
  source: 'managed',
  ytDlpExecutable: '/managed/bin/yt-dlp',
  ffmpegExecutable: '/usr/local/bin/ffmpeg',
  denoExecutable: '/usr/local/bin/deno',
  ytDlpVersion: TOOLS.ytDlpVersion,
  ffmpegVersion: TOOLS.ffmpegVersion,
  pluginDirectory: '/managed/plugins',
  pluginArchive: '/managed/plugins/bgutil.zip',
  providerServerDirectory: '/managed/provider/server',
  denoDirectory: '/managed/deno',
  providerCacheDirectory: '/managed/provider-cache',
  chromeImpersonationTarget: 'Chrome-136:Macos-15',
  ffmpegExplicit: true,
  childEnvironment: Object.freeze({PATH: '/usr/bin:/bin'}),
  audit: {
    source: 'managed',
    ytDlpVersion: TOOLS.ytDlpVersion,
    managedAssetSha256: 'sha256:managed-asset',
  },
};
const ROOT: ValidatedArchiveRoot = {
  workspaceRoot: '/workspace',
  absolutePath: '/workspace/downloads',
  relativePath: 'downloads',
};

const makeStaged = (
  platform: DownloadPlatform = 'youtube',
  videoId = 'video-123',
): StagedArchive => ({
  status: 'staging',
  root: ROOT,
  platform,
  videoId,
  stagingDirectory: '/workspace/downloads/.staging/download-1',
  finalDirectory: `/workspace/downloads/${platform}/${videoId}`,
  relativeDirectory: `downloads/${platform}/${videoId}`,
});

const STAGED = makeStaged();
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
  extractorKey: 'Youtube',
  hasDrm: false,
};
const SAFE_METADATA = {
  id: 'video-123',
  title: 'Example title',
  webpage_url: 'https://www.youtube.com/watch?v=video-123',
  extractor: 'Youtube',
  extractor_key: 'Youtube',
  _type: 'video' as const,
};
const INPUT: DownloadInput = {
  workspaceRoot: '/workspace',
  url: 'https://YOUTU.BE:443/video-123#tracking',
  outputRoot: 'downloads',
  rightsConfirmed: true,
  cookieAccessConfirmed: false,
};

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
  for (let index = 0; index < 16; index += 1) await Promise.resolve();
};

interface HarnessOptions {
  events?: string[];
  toolchain?: ResolvedDownloaderToolchain;
  toolchainPromise?: Promise<ResolvedDownloaderToolchain>;
  rootPromise?: Promise<ValidatedArchiveRoot>;
  probe?: YtDlpProbe;
  probePromise?: Promise<YtDlpProbe>;
  preparation?: ArchivePreparation;
  preparationPromise?: Promise<ArchivePreparation>;
  waitImplementation?: DownloadDependencies['wait'];
  waitPromise?: Promise<void>;
  authorityOpenPromise?: Promise<StagingDownloadAuthority>;
  authorityClosePromise?: Promise<void>;
  metadataWritePromise?: Promise<void>;
  downloadPromise?: Promise<void>;
  downloadImplementation?: YtDlpClient['download'];
  finalizePromise?: Promise<DownloadedArchive>;
  cleanupPromise?: Promise<void>;
  waitError?: unknown;
  authorityOpenError?: unknown;
  authorityCloseError?: unknown;
  metadataWriteError?: unknown;
  downloadError?: unknown;
  finalizeError?: unknown;
  cleanupError?: unknown;
}

const makeHarness = (options: HarnessOptions = {}) => {
  const events = options.events ?? [];
  const resolveToolchain = vi.fn<DownloadDependencies['resolveToolchain']>(
    async () => {
      events.push('toolchain');
      if (options.toolchainPromise !== undefined) {
        return await options.toolchainPromise;
      }
      return options.toolchain ?? TOOLCHAIN;
    },
  );
  const validateRoot = vi.fn<DownloadArchiveDependencies['validateRoot']>(
    async () => {
      events.push('output-root');
      if (options.rootPromise !== undefined) return await options.rootPromise;
      return ROOT;
    },
  );
  const probe = vi.fn<YtDlpClient['probe']>(async () => {
    events.push('probe');
    if (options.probePromise !== undefined) return await options.probePromise;
    return options.probe ?? PROBE;
  });
  const prepare = vi.fn<DownloadArchiveDependencies['prepare']>(async () => {
    events.push('prepare');
    if (options.preparationPromise !== undefined) {
      return await options.preparationPromise;
    }
    return options.preparation ?? STAGED;
  });
  const closeAuthority = vi.fn(async () => {
    events.push('authority-close');
    if (options.authorityClosePromise !== undefined) {
      await options.authorityClosePromise;
    }
    if ('authorityCloseError' in options) throw options.authorityCloseError;
  });
  const writeMetadata = vi.fn<StagingDownloadAuthority['writeMetadata']>(
    async () => {
      events.push('metadata');
      if (options.metadataWritePromise !== undefined) {
        await options.metadataWritePromise;
      }
      if ('metadataWriteError' in options) throw options.metadataWriteError;
    },
  );
  const authority: StagingDownloadAuthority = {
    fd: AUTHORITY_FD,
    writeMetadata,
    close: closeAuthority,
  };
  const openStagingDownloadAuthority = vi.fn<
    DownloadArchiveDependencies['openStagingDownloadAuthority']
  >(async () => {
    events.push('authority-open');
    if (options.authorityOpenPromise !== undefined) {
      return await options.authorityOpenPromise;
    }
    if ('authorityOpenError' in options) throw options.authorityOpenError;
    return authority;
  });
  const download = vi.fn<YtDlpClient['download']>(async (...args) => {
    events.push('download');
    if (options.downloadImplementation !== undefined) {
      return await options.downloadImplementation(...args);
    }
    if (options.downloadPromise !== undefined) await options.downloadPromise;
    if ('downloadError' in options) throw options.downloadError;
  });
  const client: YtDlpClient = {
    checkTools: async () => TOOLS,
    probe,
    download,
  };
  const createClient = vi.fn<DownloadDependencies['createClient']>(() => client);
  const wait = vi.fn<DownloadDependencies['wait']>(async (...args) => {
    events.push(`delay:${args[0]}`);
    if (options.waitImplementation !== undefined) {
      return await options.waitImplementation(...args);
    }
    if (options.waitPromise !== undefined) await options.waitPromise;
    if ('waitError' in options) throw options.waitError;
  });
  const finalize = vi.fn<DownloadArchiveDependencies['finalize']>(async () => {
    events.push('finalize');
    if (options.finalizePromise !== undefined) {
      return await options.finalizePromise;
    }
    if ('finalizeError' in options) throw options.finalizeError;
    return DOWNLOADED;
  });
  const cleanup = vi.fn<DownloadArchiveDependencies['cleanup']>(async () => {
    events.push('cleanup');
    if (options.cleanupPromise !== undefined) await options.cleanupPromise;
    if ('cleanupError' in options) throw options.cleanupError;
  });
  const now = vi.fn<DownloadDependencies['now']>(() => NOW);
  const dependencies: DownloadDependencies = {
    resolveToolchain,
    createClient,
    archive: {
      validateRoot,
      prepare,
      openStagingDownloadAuthority,
      finalize,
      cleanup,
    },
    wait,
    now,
  };

  return {
    events,
    dependencies,
    resolveToolchain,
    createClient,
    validateRoot,
    probe,
    prepare,
    authority,
    openStagingDownloadAuthority,
    writeMetadata,
    closeAuthority,
    download,
    wait,
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

const processResult = (stdout = ''): ProcessResult => ({
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

  it('runs the exact checked-session order and reuses one frozen profile', async () => {
    const events: string[] = [];
    const instrumentedToolchain: ResolvedDownloaderToolchain = {
      ...TOOLCHAIN,
      audit: {
        get source() {
          events.push('profile');
          return 'managed' as const;
        },
        ytDlpVersion: TOOLCHAIN.audit.ytDlpVersion,
        managedAssetSha256: 'sha256:managed-asset',
      },
    };
    const instrumentedProbe: YtDlpProbe = {
      ...PROBE,
      get hasDrm() {
        events.push('policy');
        return false;
      },
    };
    const harness = makeHarness({
      events,
      toolchain: instrumentedToolchain,
      probe: instrumentedProbe,
    });
    const orderedInput = {
      workspaceRoot: INPUT.workspaceRoot,
      outputRoot: INPUT.outputRoot,
      cookieAccessConfirmed: false,
      get rightsConfirmed() {
        events.push('rights');
        return true;
      },
      get url() {
        events.push('url');
        return INPUT.url;
      },
      get proxy() {
        events.push('proxy');
        return undefined;
      },
      get browserCookieSource() {
        events.push('cookies');
        return undefined;
      },
    } as unknown as DownloadInput;

    await expect(downloadVideo(orderedInput, harness.dependencies))
      .resolves.toBe(DOWNLOADED);

    expect(events).toEqual([
      'rights',
      'url',
      'proxy',
      'cookies',
      'toolchain',
      'profile',
      'output-root',
      'probe',
      'policy',
      'prepare',
      'delay:5000',
      'authority-open',
      'download',
      'metadata',
      'authority-close',
      'finalize',
    ]);
    expect(harness.resolveToolchain).toHaveBeenCalledWith(undefined);
    expect(harness.createClient).toHaveBeenCalledWith(instrumentedToolchain);
    expect(harness.validateRoot).toHaveBeenCalledWith('/workspace', 'downloads');
    expect(harness.prepare).toHaveBeenCalledWith(
      ROOT,
      'youtube',
      'video-123',
      'https://www.youtube.com/watch?v=video-123',
    );
    expect(harness.wait).toHaveBeenCalledWith(5000, undefined);
    expect(harness.download).toHaveBeenCalledWith(
      'https://youtu.be/video-123',
      AUTHORITY_FD,
      expect.objectContaining({profile: expect.any(Object)}),
    );
    const probeProfile = harness.probe.mock.calls[0]?.[1].profile;
    const downloadProfile = harness.download.mock.calls[0]?.[2].profile;
    expect(downloadProfile).toBe(probeProfile);
    expect(Object.isFrozen(probeProfile)).toBe(true);
    expect(harness.writeMetadata).toHaveBeenCalledWith(SAFE_METADATA);
    expect(harness.finalize).toHaveBeenCalledWith(STAGED, {
      platform: 'youtube',
      videoId: 'video-123',
      title: 'Example title',
      canonicalUrl: 'https://www.youtube.com/watch?v=video-123',
      downloadedAt: NOW,
      tools: TOOLS,
      browserCookies: {used: false},
      network: {
        proxyUsed: false,
        browserImpersonation: false,
      },
      toolchain: {
        source: 'managed',
        ytDlpVersion: TOOLS.ytDlpVersion,
        managedAssetSha256: 'sha256:managed-asset',
        potProvider: {name: 'bgutil', version: '1.3.1', mode: 'script'},
      },
    });
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
    expect(harness.events).toEqual([]);
  });

  it.each(['true', 1, {confirmed: true}, null, [true]])(
    'rejects runtime-invalid rights value %j before dependencies',
    async (rightsConfirmed) => {
      const harness = makeHarness();
      const error = await captureRejection(downloadVideo({
        ...INPUT,
        rightsConfirmed,
      } as unknown as DownloadInput, harness.dependencies));

      expect(error).toMatchObject({
        code: 'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
        message: RIGHTS_MESSAGE,
      });
      expect(harness.events).toEqual([]);
    },
  );

  it('rejects invalid URL, proxy, and Cookie inputs before toolchain resolution', async () => {
    const invalidInputs: DownloadInput[] = [
      {...INPUT, url: 'not-a-url'},
      {
        ...INPUT,
        proxy: {} as unknown as NonNullable<DownloadInput['proxy']>,
      },
      {
        ...INPUT,
        browserCookieSource: 'chrome',
        cookieAccessConfirmed: false,
      },
      {...INPUT, cookieAccessConfirmed: true},
    ];

    for (const input of invalidInputs) {
      const harness = makeHarness();
      await expect(downloadVideo(input, harness.dependencies)).rejects
        .toBeInstanceOf(DownloadError);
      expect(harness.events).toEqual([]);
    }
  });

  it.each([
    {
      platform: 'youtube',
      url: 'https://youtu.be/video-123',
      id: 'video-123',
      canonicalUrl: 'https://www.youtube.com/watch?v=video-123',
      extractor: 'Youtube',
      delay: 5000,
    },
    {
      platform: 'bilibili',
      url: 'https://www.bilibili.com/video/BV1abc',
      id: 'BV1abc',
      canonicalUrl: 'https://www.bilibili.com/video/BV1abc',
      extractor: 'BiliBili',
      delay: 0,
    },
    {
      platform: 'douyin',
      url: 'https://www.douyin.com/video/7654841525762919726',
      id: '7654841525762919726',
      canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
      extractor: 'Douyin',
      delay: 0,
    },
    {
      platform: 'tiktok',
      url: 'https://www.tiktok.com/@creator/video/123',
      id: '123',
      canonicalUrl: 'https://www.tiktok.com/@creator/video/123',
      extractor: 'TikTok',
      delay: 0,
    },
    {
      platform: 'vimeo',
      url: 'https://vimeo.com/987',
      id: '987',
      canonicalUrl: 'https://vimeo.com/987',
      extractor: 'Vimeo',
      delay: 0,
    },
  ] as const)(
    'uses one Chrome Cookie profile for $platform probe and download',
    async ({platform, url, id, canonicalUrl, extractor, delay}) => {
      const staged = makeStaged(platform, id);
      const harness = makeHarness({
        preparation: staged,
        probe: {
          id,
          title: `${platform} fixture`,
          canonicalUrl,
          extractor,
          hasDrm: false,
        },
      });

      await downloadVideo({
        ...INPUT,
        url,
        browserCookieSource: 'chrome',
        cookieAccessConfirmed: true,
      }, harness.dependencies);

      const probeProfile = harness.probe.mock.calls[0]?.[1].profile;
      const downloadProfile = harness.download.mock.calls[0]?.[2].profile;
      expect(probeProfile).toBeDefined();
      if (probeProfile === undefined) throw new Error('Expected probe profile.');
      expect(downloadProfile).toBe(probeProfile);
      expect(probeProfile.browserCookies).toEqual({used: true, source: 'chrome'});
      expect(probeProfile.commonArgs).toContain('--cookies-from-browser');
      expect(harness.wait).toHaveBeenCalledWith(delay, undefined);
      expect(harness.finalize.mock.calls[0]?.[1].browserCookies)
        .toEqual({used: true, source: 'chrome'});
    },
  );

  it.each([
    {availability: 'private', hasDrm: false},
    {availability: 'premium_only', hasDrm: false},
    {availability: 'subscriber_only', hasDrm: false},
    {availability: 'needs_auth', hasDrm: false},
    {availability: 'public', hasDrm: true},
  ])('rejects restricted probe policy %j before archive preparation', async (
    policy,
  ) => {
    const harness = makeHarness({probe: {...PROBE, ...policy}});

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toMatchObject({
      code: 'DOWNLOAD_CONTENT_RESTRICTED',
      message: RESTRICTED_MESSAGE,
    });
    expect(harness.events).toEqual(['toolchain', 'output-root', 'probe']);
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.wait).not.toHaveBeenCalled();
  });

  it('does not retry a failed probe with another profile', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_PROBE_FAILED',
      'Video metadata could not be extracted.',
    );
    const harness = makeHarness({probePromise: Promise.reject(failure)});

    await expect(downloadVideo(INPUT, harness.dependencies)).rejects.toBe(failure);
    expect(harness.probe).toHaveBeenCalledTimes(1);
    expect(harness.probe.mock.calls[0]?.[1].profile.browserCookies)
      .toEqual({used: false});
    expect(harness.download).not.toHaveBeenCalled();
  });

  it('returns an existing archive before delay or staging authority', async () => {
    const harness = makeHarness({preparation: EXISTING});

    await expect(downloadVideo(INPUT, harness.dependencies)).resolves.toBe(EXISTING);
    expect(harness.events).toEqual([
      'toolchain',
      'output-root',
      'probe',
      'prepare',
    ]);
    expect(harness.wait).not.toHaveBeenCalled();
    expect(harness.openStagingDownloadAuthority).not.toHaveBeenCalled();
    expect(harness.cleanup).not.toHaveBeenCalled();
  });

  it('cleans staging when aborting during the YouTube delay without opening authority', async () => {
    const controller = new AbortController();
    const reason = new Error('stop during delay');
    const harness = makeHarness({waitImplementation: waitForDownloadDelay});
    const operation = downloadVideo({
      ...INPUT,
      signal: controller.signal,
    }, harness.dependencies);

    await vi.waitFor(() => expect(harness.wait).toHaveBeenCalledTimes(1));
    controller.abort(reason);

    await expect(operation).rejects.toBe(reason);
    expect(harness.openStagingDownloadAuthority).not.toHaveBeenCalled();
    expect(harness.cleanup).toHaveBeenCalledWith(STAGED);
  });

  it('passes one signal and the same profile through the checked session', async () => {
    const controller = new AbortController();
    const harness = makeHarness();

    await downloadVideo({...INPUT, signal: controller.signal}, harness.dependencies);

    expect(harness.resolveToolchain).toHaveBeenCalledWith(controller.signal);
    expect(harness.wait).toHaveBeenCalledWith(5000, controller.signal);
    const probeOptions = harness.probe.mock.calls[0]?.[1];
    const downloadOptions = harness.download.mock.calls[0]?.[2];
    expect(probeOptions).toBeDefined();
    expect(downloadOptions).toBeDefined();
    if (probeOptions === undefined || downloadOptions === undefined) {
      throw new Error('Expected checked operation options.');
    }
    expect(probeOptions.signal).toBe(controller.signal);
    expect(downloadOptions.signal).toBe(controller.signal);
    expect(downloadOptions.profile).toBe(probeOptions.profile);
  });

  it('awaits toolchain, root, probe, prepare, delay, media, and finalize stages', async () => {
    const toolchainGate = createDeferred<ResolvedDownloaderToolchain>();
    const rootGate = createDeferred<ValidatedArchiveRoot>();
    const probeGate = createDeferred<YtDlpProbe>();
    const preparationGate = createDeferred<ArchivePreparation>();
    const waitGate = createDeferred<void>();
    const downloadGate = createDeferred<void>();
    const metadataGate = createDeferred<void>();
    const finalizeGate = createDeferred<DownloadedArchive>();
    const harness = makeHarness({
      toolchainPromise: toolchainGate.promise,
      rootPromise: rootGate.promise,
      probePromise: probeGate.promise,
      preparationPromise: preparationGate.promise,
      waitPromise: waitGate.promise,
      downloadPromise: downloadGate.promise,
      metadataWritePromise: metadataGate.promise,
      finalizePromise: finalizeGate.promise,
    });
    const operation = downloadVideo(INPUT, harness.dependencies);

    await flushMicrotasks();
    expect(harness.events).toEqual(['toolchain']);
    toolchainGate.resolve(TOOLCHAIN);
    await flushMicrotasks();
    expect(harness.events).toEqual(['toolchain', 'output-root']);
    rootGate.resolve(ROOT);
    await flushMicrotasks();
    expect(harness.events).toEqual(['toolchain', 'output-root', 'probe']);
    probeGate.resolve(PROBE);
    await flushMicrotasks();
    expect(harness.events).toEqual([
      'toolchain', 'output-root', 'probe', 'prepare',
    ]);
    preparationGate.resolve(STAGED);
    await flushMicrotasks();
    expect(harness.events.at(-1)).toBe('delay:5000');
    waitGate.resolve();
    await flushMicrotasks();
    expect(harness.events.slice(-2)).toEqual(['authority-open', 'download']);
    downloadGate.resolve();
    await flushMicrotasks();
    expect(harness.events.at(-1)).toBe('metadata');
    metadataGate.resolve();
    await flushMicrotasks();
    expect(harness.events.slice(-2)).toEqual(['authority-close', 'finalize']);
    finalizeGate.resolve(DOWNLOADED);
    await expect(operation).resolves.toBe(DOWNLOADED);
  });

  it('preserves a download failure over close and cleanup failures', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_PROCESS_FAILED',
      'The video could not be downloaded.',
    );
    const harness = makeHarness({
      downloadError: failure,
      authorityCloseError: new Error('close failed'),
      cleanupError: new Error('cleanup failed'),
    });

    await expect(downloadVideo(INPUT, harness.dependencies)).rejects.toBe(failure);
    expect(harness.closeAuthority).toHaveBeenCalledTimes(1);
    expect(harness.cleanup).toHaveBeenCalledWith(STAGED);
    expect(harness.writeMetadata).not.toHaveBeenCalled();
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it('preserves a metadata failure over close and cleanup failures', async () => {
    const failure = new DownloadError(
      'DOWNLOAD_FINALIZE_FAILED',
      'The download archive could not be finalized.',
    );
    const harness = makeHarness({
      metadataWriteError: failure,
      authorityCloseError: new Error('close failed'),
      cleanupError: new Error('cleanup failed'),
    });

    await expect(downloadVideo(INPUT, harness.dependencies)).rejects.toBe(failure);
    expect(harness.closeAuthority).toHaveBeenCalledTimes(1);
    expect(harness.cleanup).toHaveBeenCalledWith(STAGED);
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it('propagates an authority close failure and cleans before finalization', async () => {
    const failure = new Error('close failed');
    const harness = makeHarness({authorityCloseError: failure});

    await expect(downloadVideo(INPUT, harness.dependencies)).rejects.toBe(failure);
    expect(harness.cleanup).toHaveBeenCalledWith(STAGED);
    expect(harness.finalize).not.toHaveBeenCalled();
  });

  it('preserves finalize and authority-open failures over cleanup failures', async () => {
    const finalizeFailure = new Error('finalize failed');
    const finalizeHarness = makeHarness({
      finalizeError: finalizeFailure,
      cleanupError: new Error('cleanup failed'),
    });
    await expect(downloadVideo(INPUT, finalizeHarness.dependencies))
      .rejects.toBe(finalizeFailure);
    expect(finalizeHarness.cleanup).toHaveBeenCalledWith(STAGED);

    const authorityFailure = new Error('authority failed');
    const authorityHarness = makeHarness({
      authorityOpenError: authorityFailure,
      cleanupError: new Error('cleanup failed'),
    });
    await expect(downloadVideo(INPUT, authorityHarness.dependencies))
      .rejects.toBe(authorityFailure);
    expect(authorityHarness.cleanup).toHaveBeenCalledWith(STAGED);
  });

  it('awaits cleanup before rejecting the original staged failure', async () => {
    const failure = new Error('download failed');
    const cleanupGate = createDeferred<void>();
    const harness = makeHarness({
      downloadError: failure,
      cleanupPromise: cleanupGate.promise,
    });
    const pending = Symbol('pending');
    let outcome: unknown = pending;
    const operation = downloadVideo(INPUT, harness.dependencies);
    void operation.catch((error: unknown) => { outcome = error; });

    await vi.waitFor(() => expect(harness.cleanup).toHaveBeenCalledTimes(1));
    expect(outcome).toBe(pending);
    cleanupGate.resolve();
    await expect(operation).rejects.toBe(failure);
    expect(outcome).toBe(failure);
  });

  it.each([
    {...PROBE, extractor: 'Vimeo'},
    {...PROBE, extractor: 'Vimeo', canonicalUrl: 'not-a-url'},
    {...PROBE, canonicalUrl: 'not-a-url'},
    {...PROBE, canonicalUrl: 'http://www.youtube.com/watch?v=video-123'},
    {...PROBE, canonicalUrl: 'https://example.com/watch?v=video-123'},
    {...PROBE, canonicalUrl: 'https://vimeo.com/987'},
  ])('maps extractor or canonical mismatch to the fixed error before staging', async (
    probe,
  ) => {
    const harness = makeHarness({probe});

    const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

    expect(error).toMatchObject({
      code: 'DOWNLOAD_EXTRACTOR_MISMATCH',
      message: EXTRACTOR_MISMATCH_MESSAGE,
    });
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.wait).not.toHaveBeenCalled();
  });

  it('forwards only safe canonical metadata after probing', async () => {
    const harness = makeHarness({
      probe: {
        ...PROBE,
        cookies: 'cookie-value-marker',
        url: 'signed-url-marker',
        filepath: '/private/profile-marker',
        http_headers: {Authorization: 'header-marker'},
      } as YtDlpProbe,
    });

    await downloadVideo(INPUT, harness.dependencies);

    expect(harness.writeMetadata).toHaveBeenCalledWith(SAFE_METADATA);
    expect(JSON.stringify(harness.writeMetadata.mock.calls[0]?.[0]))
      .not.toMatch(/cookie-value-marker|signed-url-marker|profile-marker|header-marker/u);
  });
});

describe('checkVideoDownload', () => {
  it('runs the checked metadata flow without touching archive dependencies', async () => {
    const harness = makeHarness();

    await expect(checkVideoDownload(INPUT, harness.dependencies)).resolves.toEqual({
      platform: 'youtube',
      result: 'available',
    });
    expect(harness.events).toEqual(['toolchain', 'probe']);
    expect(harness.validateRoot).not.toHaveBeenCalled();
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.wait).not.toHaveBeenCalled();
  });
});

describe('waitForDownloadDelay', () => {
  it('rejects a pre-aborted signal immediately with its reason', async () => {
    const controller = new AbortController();
    const reason = new Error('already aborted');
    controller.abort(reason);
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');

    await expect(waitForDownloadDelay(5000, controller.signal)).rejects.toBe(reason);
    expect(addEventListener).not.toHaveBeenCalled();
  });

  it('uses one once listener and removes it when a zero delay resolves', async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');

    await expect(waitForDownloadDelay(0, controller.signal)).resolves.toBeUndefined();

    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls[0]?.[0]).toBe('abort');
    expect(addEventListener.mock.calls[0]?.[2]).toEqual({once: true});
    expect(removeEventListener).toHaveBeenCalledWith(
      'abort',
      addEventListener.mock.calls[0]?.[1],
    );
  });
});

describe('createSystemDownloadDependencies', () => {
  it('binds toolchain resolution, client creation, archive adapters, delay, and time', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValue(processResult());
    const options: SystemDownloadOptions = {
      ytDlpOverride: '/tools/yt-dlp',
      ffmpegOverride: '/tools/ffmpeg',
      homeDirectory: '/home/tester',
      runProcess,
    };
    const dependencies = createSystemDownloadDependencies(options);

    expect(dependencies.archive).toEqual({
      validateRoot: validateArchiveRoot,
      prepare: prepareArchive,
      openStagingDownloadAuthority: expect.any(Function),
      finalize: finalizeArchive,
      cleanup: cleanupArchive,
    });
    expect(dependencies.wait).toBe(waitForDownloadDelay);
    const firstNow = dependencies.now();
    const secondNow = dependencies.now();
    expect(firstNow).toBeInstanceOf(Date);
    expect(secondNow).toBeInstanceOf(Date);
    expect(firstNow).not.toBe(secondNow);

    const client = dependencies.createClient(TOOLCHAIN);
    const profile = resolvePlatformProfile({
      platform: 'youtube',
      toolchain: TOOLCHAIN,
    });
    await client.download('https://youtu.be/video-123', AUTHORITY_FD, {profile});
    expect(runProcess).toHaveBeenCalledWith(
      '/usr/bin/osascript',
      expect.arrayContaining([
        TOOLCHAIN.ytDlpExecutable,
        '--ffmpeg-location',
        TOOLCHAIN.ffmpegExecutable,
        'https://youtu.be/video-123',
      ]),
      {
        env: TOOLCHAIN.childEnvironment,
        extraStdioFds: [AUTHORITY_FD],
      },
    );
  });

  it('snapshots the process runner before caller mutation', async () => {
    const originalRunProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValue(processResult());
    const mutatedRunProcess = vi.fn<DownloadProcessRunner>();
    const options: SystemDownloadOptions = {runProcess: originalRunProcess};
    const dependencies = createSystemDownloadDependencies(options);
    options.runProcess = mutatedRunProcess;

    const client = dependencies.createClient(TOOLCHAIN);
    const profile = resolvePlatformProfile({
      platform: 'youtube',
      toolchain: TOOLCHAIN,
      proxy: parseDownloadProxy('http://127.0.0.1:7890'),
    });
    await client.download('https://youtu.be/video-123', AUTHORITY_FD, {profile});

    expect(mutatedRunProcess).not.toHaveBeenCalled();
    expect(originalRunProcess).toHaveBeenCalledTimes(1);
  });
});
