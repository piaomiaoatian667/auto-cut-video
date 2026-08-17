import {describe, expect, it, vi} from 'vitest';
import {formatDownloadFailure} from '../../../src/cli/download-output';
import {
  type DownloadError,
  type DownloadErrorCode,
  isDownloadError,
} from '../../../src/download/errors';
import {resolvePlatformProfile} from '../../../src/download/platform-profiles';
import type {ResolvedDownloaderToolchain} from '../../../src/download/toolchain/types';
import {
  createYtDlpClient,
  parseYtDlpInfo,
  type DownloadProcessRunner,
  type YtDlpClientOptions,
  YtDlpInfoSchema,
  type YtDlpOperationOptions,
} from '../../../src/download/yt-dlp';
import {ProcessExecutionError} from '../../../src/process/process-error';
import type {ProcessResult} from '../../../src/process/run-process';

const PROBE_FAILED_MESSAGE = 'Video metadata could not be extracted.';
const PROCESS_FAILED_MESSAGE = 'The video could not be downloaded.';
const CLASSIFIED_FAILURES = [
  [
    'HTTP Error 429: Too Many Requests',
    'DOWNLOAD_RATE_LIMITED',
    'The video platform temporarily rate-limited this session.',
  ],
  [
    'Sign in to confirm you are not a bot',
    'DOWNLOAD_RATE_LIMITED',
    'The video platform temporarily rate-limited this session.',
  ],
  [
    'HTTP Error 412: Precondition Failed',
    'DOWNLOAD_PLATFORM_CHALLENGE',
    'The video platform rejected the selected public-session request.',
  ],
  [
    'Connection timed out',
    'DOWNLOAD_NETWORK_UNREACHABLE',
    'The video platform could not be reached with the selected network settings.',
  ],
  [
    'Impersonate target is unavailable',
    'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
    'The required browser compatibility capability is unavailable.',
  ],
  [
    'bgutil script provider unavailable',
    'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
    'The YouTube compatibility provider is unavailable.',
  ],
] as const;

type SupportedYtDlpClientOption = 'toolchain' | 'runProcess';
type UnexpectedYtDlpClientOption = Exclude<
  keyof YtDlpClientOptions,
  SupportedYtDlpClientOption
>;
const hasOnlyFixedClientOptions:
  [UnexpectedYtDlpClientOption] extends [never] ? true : false = true;

type SupportedYtDlpOperationOption = 'profile' | 'signal';
type UnexpectedYtDlpOperationOption = Exclude<
  keyof YtDlpOperationOptions,
  SupportedYtDlpOperationOption
>;
const hasOnlyFixedOperationOptions:
  [UnexpectedYtDlpOperationOption] extends [never] ? true : false = true;

const createToolchain = (
  overrides: Partial<ResolvedDownloaderToolchain> = {},
): ResolvedDownloaderToolchain => ({
  source: 'managed',
  ytDlpExecutable: '/managed/bin/yt-dlp',
  ffmpegExecutable: '/usr/local/bin/ffmpeg',
  denoExecutable: '/usr/local/bin/deno',
  ytDlpVersion: '2026.07.04',
  ffmpegVersion: '8.1.2',
  pluginDirectory: '/managed/plugins',
  pluginArchive: '/managed/plugins/bgutil.zip',
  providerServerDirectory: '/managed/provider/server',
  denoDirectory: '/managed/deno',
  providerCacheDirectory: '/managed/provider-cache',
  chromeImpersonationTarget: 'Chrome-136:Macos-15',
  ffmpegExplicit: false,
  childEnvironment: Object.freeze({
    PATH: '/usr/bin:/bin',
    DENO_NO_PROMPT: '1',
  }),
  audit: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    managedAssetSha256: 'sha256:managed-asset',
  },
  ...overrides,
});

const processResult = (
  overrides: Partial<ProcessResult> = {},
): ProcessResult => ({
  command: '/managed/bin/yt-dlp',
  args: [],
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  durationMs: 1,
  ...overrides,
});

const processFailure = (stderr: string): ProcessExecutionError =>
  new ProcessExecutionError(
    'PROCESS_EXIT_NONZERO',
    'Process exited with status 1',
    processResult({
      exitCode: 1,
      args: ['--secret-argument'],
      stderr,
    }),
  );

const youtubeInfo = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id: 'abc',
    title: 'Example',
    webpage_url: 'https://youtu.be/abc',
    extractor: 'youtube',
    _type: 'video',
    ...overrides,
  });

const operationOptions = (
  toolchain: ResolvedDownloaderToolchain,
  signal?: AbortSignal,
): YtDlpOperationOptions => ({
  profile: resolvePlatformProfile({platform: 'youtube', toolchain}),
  ...(signal === undefined ? {} : {signal}),
});

const expectDownloadError = async (
  promise: Promise<unknown>,
  code: DownloadErrorCode,
  message: string,
): Promise<DownloadError> => {
  try {
    await promise;
  } catch (error) {
    expect(isDownloadError(error)).toBe(true);
    if (!isDownloadError(error)) throw error;
    expect(error).toMatchObject({code, message, name: 'DownloadError'});
    return error;
  }
  throw new Error(`Expected ${code}.`);
};

describe('yt-dlp client options', () => {
  it('exposes only resolved toolchain and fixed profile options', () => {
    expect(hasOnlyFixedClientOptions).toBe(true);
    expect(hasOnlyFixedOperationOptions).toBe(true);
  });
});

describe('yt-dlp metadata schema', () => {
  it('accepts nullable DRM metadata without coercion', () => {
    expect(YtDlpInfoSchema.parse({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      has_drm: null,
    })).toMatchObject({has_drm: null});
  });

  it('rejects malformed DRM metadata', () => {
    expect(YtDlpInfoSchema.safeParse({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      has_drm: 'true',
    }).success).toBe(false);
  });
});

describe('yt-dlp metadata validation', () => {
  it.each([
    [true, true],
    [false, false],
    [null, false],
    [undefined, false],
  ] as const)('maps has_drm %s to hasDrm %s', (hasDrm, expected) => {
    expect(parseYtDlpInfo({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      _type: 'video',
      ...(hasDrm === undefined ? {} : {has_drm: hasDrm}),
    })).toEqual({
      id: 'abc',
      title: 'Example',
      canonicalUrl: 'https://youtu.be/abc',
      extractor: 'youtube',
      hasDrm: expected,
    });
  });

  it.each([
    ['playlist', {_type: 'playlist'}],
    ['is_live flag', {is_live: true}],
    ['active live status', {live_status: 'is_live'}],
    ['upcoming live status', {live_status: 'is_upcoming'}],
    ['post-live processing status', {live_status: 'post_live'}],
  ])('rejects %s metadata', (_caseName, unsafeMetadata) => {
    expect(() => parseYtDlpInfo({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      ...unsafeMetadata,
    })).toThrow();
  });
});

describe('yt-dlp resolved toolchain', () => {
  it('returns snapshotted resolved versions without ambient tool lookup', async () => {
    const toolchain = createToolchain();
    const runProcess = vi.fn<DownloadProcessRunner>();
    const client = createYtDlpClient({toolchain, runProcess});

    toolchain.ytDlpVersion = 'mutated';
    toolchain.ffmpegVersion = 'mutated';

    await expect(client.checkTools()).resolves.toEqual({
      ytDlpVersion: '2026.07.04',
      ffmpegVersion: '8.1.2',
    });
    expect(runProcess).not.toHaveBeenCalled();
  });
});

describe('yt-dlp probe', () => {
  it('uses the profile common arguments exactly before fixed probe flags', async () => {
    const toolchain = createToolchain();
    const options = operationOptions(toolchain);
    const url = 'https://youtu.be/requested';
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult({
        stdout: youtubeInfo({webpage_url: 'https://youtu.be/canonical'}),
      }));

    const probe = await createYtDlpClient({toolchain, runProcess})
      .probe(url, options);

    expect(probe).toEqual({
      id: 'abc',
      title: 'Example',
      canonicalUrl: 'https://youtu.be/canonical',
      extractor: 'youtube',
      hasDrm: false,
    });
    expect(runProcess).toHaveBeenCalledWith(
      toolchain.ytDlpExecutable,
      [
        ...options.profile.commonArgs,
        '--skip-download',
        '--dump-single-json',
        url,
      ],
      {env: toolchain.childEnvironment},
    );
  });

  it('passes the resolved child environment and operation signal', async () => {
    const toolchain = createToolchain();
    const controller = new AbortController();
    const options = operationOptions(toolchain, controller.signal);
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult({stdout: youtubeInfo()}));

    await createYtDlpClient({toolchain, runProcess})
      .probe('https://youtu.be/abc', options);

    expect(runProcess.mock.calls[0]?.[2]).toEqual({
      signal: controller.signal,
      env: toolchain.childEnvironment,
    });
  });

  it('returns only safe probe fields and excludes raw signed metadata', async () => {
    const markers = [
      'format-secret-marker',
      'signed-url-secret-marker',
      'cookie-secret-marker',
      'visitor-data-secret-marker',
    ];
    const toolchain = createToolchain();
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult({
        stdout: youtubeInfo({
          has_drm: true,
          formats: [{format_id: markers[0], url: `https://cdn/?sig=${markers[1]}`}],
          http_headers: {Cookie: markers[2]},
          visitor_data: markers[3],
        }),
      }));

    const probe = await createYtDlpClient({toolchain, runProcess}).probe(
      'https://youtu.be/abc',
      operationOptions(toolchain),
    );
    const serialized = JSON.stringify(probe);

    expect(probe).toEqual({
      id: 'abc',
      title: 'Example',
      canonicalUrl: 'https://youtu.be/abc',
      extractor: 'youtube',
      hasDrm: true,
    });
    for (const marker of markers) expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain('formats');
    expect(serialized).not.toContain('http_headers');
    expect(serialized).not.toContain('Cookie');
  });

  it.each(CLASSIFIED_FAILURES)(
    'classifies process stderr %s as %s',
    async (stderr, code, message) => {
      const toolchain = createToolchain();
      const failure = processFailure(stderr);
      const runProcess = vi.fn<DownloadProcessRunner>()
        .mockRejectedValueOnce(failure);

      const error = await expectDownloadError(
        createYtDlpClient({toolchain, runProcess}).probe(
          'https://youtu.be/abc',
          operationOptions(toolchain),
        ),
        code,
        message,
      );

      expect(error).not.toBe(failure);
      expect(error.cause).toBeUndefined();
    },
  );

  it('matches only the bounded stderr tail', async () => {
    const toolchain = createToolchain();
    const stderr = [
      'HTTP Error 429: Too Many Requests',
      'x'.repeat(64 * 1024),
      'Connection timed out',
    ].join('\n');
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(processFailure(stderr));

    await expectDownloadError(
      createYtDlpClient({toolchain, runProcess}).probe(
        'https://youtu.be/abc',
        operationOptions(toolchain),
      ),
      'DOWNLOAD_NETWORK_UNREACHABLE',
      'The video platform could not be reached with the selected network settings.',
    );
  });

  it('keeps unknown process and parse failures generic', async () => {
    const toolchain = createToolchain();
    const unknownProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(processFailure('unknown extractor failure'));
    const invalidJson = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult({stdout: '{not-json'}));

    await expectDownloadError(
      createYtDlpClient({toolchain, runProcess: unknownProcess}).probe(
        'https://youtu.be/abc',
        operationOptions(toolchain),
      ),
      'DOWNLOAD_PROBE_FAILED',
      PROBE_FAILED_MESSAGE,
    );
    await expectDownloadError(
      createYtDlpClient({toolchain, runProcess: invalidJson}).probe(
        'https://youtu.be/abc',
        operationOptions(toolchain),
      ),
      'DOWNLOAD_PROBE_FAILED',
      PROBE_FAILED_MESSAGE,
    );
  });

  it('does not classify matching text from non-process errors', async () => {
    const toolchain = createToolchain();
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(Object.assign(
        new Error('HTTP Error 429: Too Many Requests'),
        {stderr: 'HTTP Error 429: Too Many Requests'},
      ));

    await expectDownloadError(
      createYtDlpClient({toolchain, runProcess}).probe(
        'https://youtu.be/abc',
        operationOptions(toolchain),
      ),
      'DOWNLOAD_PROBE_FAILED',
      PROBE_FAILED_MESSAGE,
    );
  });

  it('never exposes stderr secrets in public errors or CLI JSON', async () => {
    const sourceUrl = 'https://youtu.be/abc?source-url-secret-marker';
    const markers = [
      sourceUrl,
      'http://proxy-user:proxy-password@127.0.0.1:7890',
      '/Users/private/Chrome/Profile 1',
      'po-token-secret-marker',
      'visitor-data-secret-marker',
      'https://signed.example/video?sig=signed-url-secret-marker',
    ];
    const toolchain = createToolchain();
    const failure = processFailure([
      ...markers,
      'HTTP Error 429: Too Many Requests',
    ].join('\n'));
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(failure);

    const error = await expectDownloadError(
      createYtDlpClient({toolchain, runProcess}).probe(
        sourceUrl,
        operationOptions(toolchain),
      ),
      'DOWNLOAD_RATE_LIMITED',
      'The video platform temporarily rate-limited this session.',
    );
    const publicValues = [
      String(error),
      JSON.stringify(error),
      formatDownloadFailure(error.code, error.message, true),
    ];

    expect(error).not.toBe(failure);
    expect(error.cause).toBeUndefined();
    for (const value of publicValues) {
      for (const marker of markers) expect(value).not.toContain(marker);
    }
  });
});

describe('yt-dlp download', () => {
  it('uses identical profile arguments before archive-only flags', async () => {
    const toolchain = createToolchain();
    const options = operationOptions(toolchain);
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult({stdout: youtubeInfo()}))
      .mockResolvedValueOnce(processResult());
    const client = createYtDlpClient({toolchain, runProcess});
    const url = 'https://youtu.be/abc';

    await client.probe(url, options);
    await client.download(url, 41, options);

    const probeArgs = runProcess.mock.calls[0]?.[1] ?? [];
    const [command, wrapperArgs, processOptions] = runProcess.mock.calls[1] ?? [];
    const downloadArgs = wrapperArgs?.slice(6) ?? [];

    expect(command).toBe('/usr/bin/osascript');
    expect(wrapperArgs?.slice(0, 6)).toEqual([
      '-l',
      'JavaScript',
      '-e',
      expect.stringContaining('fchdir(3)'),
      '--',
      toolchain.ytDlpExecutable,
    ]);
    expect(probeArgs.slice(0, options.profile.commonArgs.length))
      .toEqual(options.profile.commonArgs);
    expect(downloadArgs.slice(0, options.profile.commonArgs.length))
      .toEqual(options.profile.commonArgs);
    expect(downloadArgs).toEqual([
      ...options.profile.commonArgs,
      '--no-progress',
      '--write-thumbnail',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'zh.*,en.*',
      '--output',
      'video.%(ext)s',
      url,
    ]);
    expect(downloadArgs).not.toContain('--ffmpeg-location');
    expect(downloadArgs).not.toContain('--write-info-json');
    expect(downloadArgs).not.toContain('--clean-info-json');
    expect(processOptions).toEqual({
      env: toolchain.childEnvironment,
      extraStdioFds: [41],
    });
  });

  it('adds only an explicitly resolved FFmpeg location', async () => {
    const toolchain = createToolchain({
      ffmpegExecutable: '/private/custom-ffmpeg',
      ffmpegExplicit: true,
    });
    const options = operationOptions(toolchain);
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult());

    await createYtDlpClient({toolchain, runProcess}).download(
      'https://youtu.be/abc',
      42,
      options,
    );

    const wrapperArgs = runProcess.mock.calls[0]?.[1] ?? [];
    expect(wrapperArgs.slice(6)).toEqual([
      ...options.profile.commonArgs,
      '--no-progress',
      '--write-thumbnail',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'zh.*,en.*',
      '--output',
      'video.%(ext)s',
      '--ffmpeg-location',
      toolchain.ffmpegExecutable,
      'https://youtu.be/abc',
    ]);
  });

  it('passes the resolved environment, signal, and staging descriptor', async () => {
    const toolchain = createToolchain();
    const controller = new AbortController();
    const options = operationOptions(toolchain, controller.signal);
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult());

    await createYtDlpClient({toolchain, runProcess}).download(
      'https://youtu.be/abc',
      45,
      options,
    );

    expect(runProcess.mock.calls[0]?.[2]).toEqual({
      signal: controller.signal,
      env: toolchain.childEnvironment,
      extraStdioFds: [45],
    });
  });

  it('classifies download process failures without retaining the cause', async () => {
    const toolchain = createToolchain();
    const failure = processFailure('bgutil script provider unavailable');
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(failure);

    const error = await expectDownloadError(
      createYtDlpClient({toolchain, runProcess}).download(
        'https://youtu.be/abc',
        44,
        operationOptions(toolchain),
      ),
      'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
      'The YouTube compatibility provider is unavailable.',
    );

    expect(error).not.toBe(failure);
    expect(error.cause).toBeUndefined();
  });

  it('keeps unknown download failures generic', async () => {
    const toolchain = createToolchain();
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(processFailure('unknown download failure'));

    await expectDownloadError(
      createYtDlpClient({toolchain, runProcess}).download(
        'https://youtu.be/abc',
        44,
        operationOptions(toolchain),
      ),
      'DOWNLOAD_PROCESS_FAILED',
      PROCESS_FAILED_MESSAGE,
    );
  });
});
