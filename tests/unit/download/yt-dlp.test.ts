import {describe, expect, it, vi} from 'vitest';
import {
  type DownloadError,
  type DownloadErrorCode,
  isDownloadError,
} from '../../../src/download/errors';
import {
  createYtDlpClient,
  parseYtDlpInfo,
  type DownloadProcessRunner,
  type YtDlpClientOptions,
  YtDlpInfoSchema,
  type YtDlpOperationOptions,
} from '../../../src/download/yt-dlp';
import type {ProcessResult} from '../../../src/process/run-process';

const TOOL_MISSING_MESSAGE = 'Required download tools are unavailable.';
const PROBE_FAILED_MESSAGE = 'Video metadata could not be extracted.';
const PROCESS_FAILED_MESSAGE = 'The video could not be downloaded.';
const forbiddenConnectionArguments = [
  '--geo-bypass',
  '--geo-verification-proxy',
  '--source-address',
  '--xff',
] as const;
const credentialArgument = /^--(?:(?:.*(?:auth|cookie|netrc|password|username).*)|ap-mso|twofactor|client-certificate(?:-key|-password)?)$/iu;
const recodeOrRemuxArgument = /^--(?:recode|remux)(?:-|$)/iu;

type SupportedYtDlpClientOption =
  | 'runProcess'
  | 'ytDlpExecutable'
  | 'ffmpegExecutable';
type UnexpectedYtDlpClientOption = Exclude<
  keyof YtDlpClientOptions,
  SupportedYtDlpClientOption
>;
const hasNoUserControlledPassthrough:
  [UnexpectedYtDlpClientOption] extends [never] ? true : false = true;

const processResult = (stdout = ''): ProcessResult => ({
  command: 'tool',
  args: [],
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  durationMs: 1,
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

const expectFixedNetworkIsolation = (args: readonly string[]): void => {
  expect(args.slice(0, 4)).toEqual([
    '--ignore-config',
    '--proxy',
    '',
    '--no-geo-bypass',
  ]);
  expect(args.filter((argument) => argument === '--proxy')).toHaveLength(1);
  expect(args[2]).toBe('');
  expect(args.filter((argument) => argument === '--no-geo-bypass')).toHaveLength(1);
  for (const forbiddenArgument of forbiddenConnectionArguments) {
    expect(args).not.toContain(forbiddenArgument);
  }
  expect(args.filter((argument) => credentialArgument.test(argument))).toEqual([]);
  expect(args.filter((argument) => recodeOrRemuxArgument.test(argument))).toEqual([]);
};

describe('yt-dlp client options', () => {
  it('does not expose user-controlled yt-dlp argument passthrough', () => {
    expect(hasNoUserControlledPassthrough).toBe(true);
  });
});

describe('yt-dlp metadata schema', () => {
  it('passes through extra fields without normalizing the source URL', () => {
    const webpageUrl = 'https://EXAMPLE.com:443/watch?v=ABC';

    expect(YtDlpInfoSchema.parse({
      id: 'abc',
      title: 'Example',
      webpage_url: webpageUrl,
      extractor: 'youtube',
      extra: {kept: true},
    })).toMatchObject({
      webpage_url: webpageUrl,
      extra: {kept: true},
    });
  });

  it('rejects an unparseable webpage URL', () => {
    expect(YtDlpInfoSchema.safeParse({
      id: 'abc',
      title: 'Example',
      webpage_url: 'not a URL',
      extractor: 'youtube',
    }).success).toBe(false);
  });

  it('accepts nullable live metadata fields without coercion', () => {
    expect(YtDlpInfoSchema.parse({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      is_live: null,
      live_status: null,
    })).toMatchObject({
      is_live: null,
      live_status: null,
    });
  });

  it.each([
    ['is_live', {is_live: 'true'}],
    ['live_status', {live_status: false}],
  ])('rejects a malformed %s field', (_field, liveMetadata) => {
    expect(YtDlpInfoSchema.safeParse({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      ...liveMetadata,
    }).success).toBe(false);
  });
});

describe('yt-dlp metadata validation', () => {
  it('maps validated video metadata to probe fields', () => {
    expect(parseYtDlpInfo({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      extractor_key: 'Youtube',
      _type: 'video',
      is_live: false,
      live_status: 'was_live',
    })).toEqual({
      id: 'abc',
      title: 'Example',
      canonicalUrl: 'https://youtu.be/abc',
      extractor: 'youtube',
      extractorKey: 'Youtube',
    });
  });

  it('maps optional availability metadata without coercion', () => {
    expect(parseYtDlpInfo({
      id: '7654841525762919726',
      title: 'Public Douyin fixture',
      webpage_url: 'https://www.douyin.com/video/7654841525762919726',
      extractor: 'Douyin',
      _type: 'video',
      availability: 'public',
    })).toMatchObject({availability: 'public'});
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

describe('yt-dlp tool checks', () => {
  it('forwards the same operation signal to checks, probe, and download', async () => {
    const controller = new AbortController();
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult('yt-dlp test\n'))
      .mockResolvedValueOnce(processResult('ffmpeg test\n'))
      .mockResolvedValueOnce(processResult(JSON.stringify({
        id: 'abc',
        title: 'Example',
        webpage_url: 'https://youtu.be/abc',
        extractor: 'youtube',
      })))
      .mockResolvedValueOnce(processResult());
    const client = createYtDlpClient({runProcess});

    await client.checkTools(controller.signal);
    await client.probe('https://youtu.be/abc', {signal: controller.signal});
    await client.download('https://youtu.be/abc', 45, {
      signal: controller.signal,
    });

    expect(runProcess.mock.calls[0]?.[2]).toEqual({signal: controller.signal});
    expect(runProcess.mock.calls[1]?.[2]).toEqual({signal: controller.signal});
    expect(runProcess.mock.calls[2]?.[2]).toEqual({signal: controller.signal});
    expect(runProcess.mock.calls[3]?.[2]).toEqual({
      signal: controller.signal,
      extraStdioFds: [45],
    });
  });

  it('uses default executables and returns first nonempty trimmed lines', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult('\n  2026.07.04  \nignored\n'))
      .mockResolvedValueOnce(processResult('\r\n ffmpeg version 8.0 \r\nbuild details\n'));

    await expect(createYtDlpClient({runProcess}).checkTools()).resolves.toEqual({
      ytDlpVersion: '2026.07.04',
      ffmpegVersion: 'ffmpeg version 8.0',
    });
    expect(runProcess.mock.calls).toEqual([
      ['yt-dlp', ['--version']],
      ['ffmpeg', ['-version']],
    ]);
  });

  it('uses configured executable selections', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult('yt-dlp custom\n'))
      .mockResolvedValueOnce(processResult('ffmpeg custom\n'));

    await createYtDlpClient({
      runProcess,
      ytDlpExecutable: '/tools/custom-yt-dlp',
      ffmpegExecutable: '/tools/custom-ffmpeg',
    }).checkTools();

    expect(runProcess.mock.calls).toEqual([
      ['/tools/custom-yt-dlp', ['--version']],
      ['/tools/custom-ffmpeg', ['-version']],
    ]);
  });

  it.each([
    ['yt-dlp', ['\n \t\n']],
    ['ffmpeg', ['2026.07.04\n', '\r\n  \n']],
  ] as const)('maps empty %s version output to DOWNLOAD_TOOL_MISSING', async (
    _tool,
    outputs,
  ) => {
    const runProcess = vi.fn<DownloadProcessRunner>();
    for (const stdout of outputs) {
      runProcess.mockResolvedValueOnce(processResult(stdout));
    }

    const error = await expectDownloadError(
      createYtDlpClient({runProcess}).checkTools(),
      'DOWNLOAD_TOOL_MISSING',
      TOOL_MISSING_MESSAGE,
    );

    expect(error.cause).toBeUndefined();
  });

  it('sanitizes tool process failures', async () => {
    const secret = 'tool-secret-marker';
    const processFailure = Object.assign(
      new Error(`spawn failed at /private/${secret}`),
      {stderr: secret, stdout: secret},
    );
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(processFailure);

    const error = await expectDownloadError(
      createYtDlpClient({runProcess}).checkTools(),
      'DOWNLOAD_TOOL_MISSING',
      TOOL_MISSING_MESSAGE,
    );

    expect(error).not.toBe(processFailure);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(secret);
  });
});

describe('yt-dlp probe', () => {
  it('uses isolated safety arguments with the URL last and maps video fields', async () => {
    const url = 'https://youtu.be/requested';
    const canonicalUrl = 'https://EXAMPLE.com:443/watch?v=ABC';
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult(JSON.stringify({
        id: 'abc',
        title: 'Example',
        webpage_url: canonicalUrl,
        extractor: 'youtube',
        _type: 'video',
      })));

    const probe = await createYtDlpClient({runProcess}).probe(url);

    expect(probe).toEqual({
      id: 'abc',
      title: 'Example',
      canonicalUrl,
      extractor: 'youtube',
    });
    expect(Object.hasOwn(probe, 'extractorKey')).toBe(false);
    expect(runProcess).toHaveBeenCalledWith('yt-dlp', [
      '--ignore-config',
      '--proxy',
      '',
      '--no-geo-bypass',
      '--no-playlist',
      '--max-downloads',
      '1',
      '--skip-download',
      '--dump-single-json',
      url,
    ]);
    const args = runProcess.mock.calls[0]?.[1];
    expect(args).toBeDefined();
    expectFixedNetworkIsolation(args ?? []);
  });

  it('adds exact Chrome Cookie arguments to a probe', async () => {
    const canonicalDouyinUrl =
      'https://www.douyin.com/video/7654841525762919726';
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult(JSON.stringify({
        id: '7654841525762919726',
        title: 'Public Douyin fixture',
        webpage_url: canonicalDouyinUrl,
        extractor: 'Douyin',
        _type: 'video',
        availability: 'public',
      })));

    await createYtDlpClient({runProcess}).probe(canonicalDouyinUrl, {
      browserCookieSource: 'chrome',
    });

    expect(runProcess).toHaveBeenCalledWith('yt-dlp', [
      '--ignore-config',
      '--proxy',
      '',
      '--no-geo-bypass',
      '--no-playlist',
      '--max-downloads',
      '1',
      '--cookies-from-browser',
      'chrome',
      '--skip-download',
      '--dump-single-json',
      canonicalDouyinUrl,
    ]);
  });

  it('snapshots Chrome Cookie options before caller mutation', async () => {
    const url = 'https://www.douyin.com/video/7654841525762919726';
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult(JSON.stringify({
        id: '7654841525762919726',
        title: 'Public Douyin fixture',
        webpage_url: url,
        extractor: 'Douyin',
        _type: 'video',
      })));
    const client = createYtDlpClient({runProcess});
    const operationOptions: YtDlpOperationOptions = {
      browserCookieSource: 'chrome',
    };

    const promise = client.probe(url, operationOptions);
    delete operationOptions.browserCookieSource;
    await promise;

    expect(runProcess.mock.calls[0]?.[1]).toContain('chrome');
  });

  it('includes extractorKey only when extractor_key is present', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult(JSON.stringify({
        id: 'abc',
        title: 'Example',
        webpage_url: 'https://youtu.be/abc',
        extractor: 'youtube',
        extractor_key: 'Youtube',
      })));

    await expect(createYtDlpClient({runProcess}).probe('https://youtu.be/abc'))
      .resolves.toEqual({
        id: 'abc',
        title: 'Example',
        canonicalUrl: 'https://youtu.be/abc',
        extractor: 'youtube',
        extractorKey: 'Youtube',
      });
  });

  it.each([
    ['is_live flag', {is_live: true}],
    ['active live status', {is_live: false, live_status: 'is_live'}],
    ['upcoming live status', {is_live: false, live_status: 'is_upcoming'}],
    ['post-live processing status', {is_live: false, live_status: 'post_live'}],
  ])('maps %s to DOWNLOAD_PROBE_FAILED', async (_caseName, liveMetadata) => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult(JSON.stringify({
        id: 'abc',
        title: 'Example',
        webpage_url: 'https://youtu.be/abc',
        extractor: 'youtube',
        ...liveMetadata,
      })));

    const error = await expectDownloadError(
      createYtDlpClient({runProcess}).probe('https://youtu.be/abc'),
      'DOWNLOAD_PROBE_FAILED',
      PROBE_FAILED_MESSAGE,
    );

    expect(error.cause).toBeUndefined();
  });

  it('accepts a completed archived replay marked was_live', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult(JSON.stringify({
        id: 'abc',
        title: 'Archived replay',
        webpage_url: 'https://youtu.be/abc',
        extractor: 'youtube',
        is_live: false,
        live_status: 'was_live',
      })));

    await expect(createYtDlpClient({runProcess}).probe('https://youtu.be/abc'))
      .resolves.toEqual({
        id: 'abc',
        title: 'Archived replay',
        canonicalUrl: 'https://youtu.be/abc',
        extractor: 'youtube',
      });
  });

  it.each([
    ['invalid JSON', '{not-json'],
    ['missing required fields', JSON.stringify({
      id: 'abc',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
    })],
    ['invalid canonical URL', JSON.stringify({
      id: 'abc',
      title: 'Example',
      webpage_url: 'not a URL',
      extractor: 'youtube',
    })],
    ['playlist result', JSON.stringify({
      id: 'abc',
      title: 'Example',
      webpage_url: 'https://youtu.be/abc',
      extractor: 'youtube',
      _type: 'playlist',
    })],
  ])('maps %s to DOWNLOAD_PROBE_FAILED', async (_caseName, stdout) => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult(stdout));

    const error = await expectDownloadError(
      createYtDlpClient({runProcess}).probe('https://youtu.be/abc'),
      'DOWNLOAD_PROBE_FAILED',
      PROBE_FAILED_MESSAGE,
    );

    expect(error.cause).toBeUndefined();
  });

  it('sanitizes probe process failures and does not retain the raw URL', async () => {
    const marker = 'probe-secret-marker';
    const url = `https://youtu.be/abc?token=${marker}`;
    const processFailure = Object.assign(
      new Error(`probe failed for ${url}`),
      {command: '/private/yt-dlp', stderr: marker},
    );
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(processFailure);

    const error = await expectDownloadError(
      createYtDlpClient({runProcess}).probe(url),
      'DOWNLOAD_PROBE_FAILED',
      PROBE_FAILED_MESSAGE,
    );

    expect(error).not.toBe(processFailure);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(url);
    expect(String(error)).not.toContain(marker);
  });
});

describe('yt-dlp download', () => {
  it('runs fixed download flags through the descriptor-bound Darwin wrapper', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult());
    const url = 'https://youtu.be/abc';
    const stagingDirectoryFd = 41;

    await expect(createYtDlpClient({runProcess}).download(url, stagingDirectoryFd))
      .resolves.toBeUndefined();

    expect(runProcess).toHaveBeenCalledTimes(1);
    const [command, wrapperArgs, options] = runProcess.mock.calls[0] ?? [];
    expect(command).toBe('/usr/bin/osascript');
    expect(wrapperArgs?.slice(0, 3)).toEqual([
      '-l',
      'JavaScript',
      '-e',
    ]);
    const wrapperScript = wrapperArgs?.[3];
    expect(wrapperScript).toContain('fchdir(3)');
    expect(wrapperScript).toContain('NSTask');
    expect(wrapperScript).toContain('setStartsNewProcessGroup(false)');
    expect(wrapperScript).not.toContain('do shell script');
    expect(wrapperArgs?.[4]).toBe('--');
    expect(wrapperArgs?.[5]).toBe('yt-dlp');
    const ytDlpArgs = wrapperArgs?.slice(6) ?? [];
    expect(ytDlpArgs).toEqual([
      '--ignore-config',
      '--proxy',
      '',
      '--no-geo-bypass',
      '--no-playlist',
      '--max-downloads',
      '1',
      '--no-progress',
      '--write-info-json',
      '--clean-info-json',
      '--write-thumbnail',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'zh.*,en.*',
      '--output',
      'video.%(ext)s',
      url,
    ]);
    expect(options).toEqual({extraStdioFds: [stagingDirectoryFd]});

    expect(ytDlpArgs.at(-1)).toBe(url);
    expect(ytDlpArgs).not.toContain('--ffmpeg-location');
    expectFixedNetworkIsolation(ytDlpArgs);
  });

  it('adds exact Chrome Cookie arguments to the FD-bound download', async () => {
    const canonicalDouyinUrl =
      'https://www.douyin.com/video/7654841525762919726';
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult());

    await createYtDlpClient({runProcess}).download(
      canonicalDouyinUrl,
      45,
      {browserCookieSource: 'chrome'},
    );

    const wrapperArgs = runProcess.mock.calls[0]?.[1] ?? [];
    expect(wrapperArgs.slice(6, 15)).toEqual([
      '--ignore-config',
      '--proxy',
      '',
      '--no-geo-bypass',
      '--no-playlist',
      '--max-downloads',
      '1',
      '--cookies-from-browser',
      'chrome',
    ]);
  });

  it('adds only an explicitly configured ffmpeg location before the URL', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult());
    const url = 'https://youtu.be/abc';

    await createYtDlpClient({
      runProcess,
      ytDlpExecutable: '/tools/custom-yt-dlp',
      ffmpegExecutable: '/tools/custom-ffmpeg',
    }).download(url, 42);

    const [command, wrapperArgs, options] = runProcess.mock.calls[0] ?? [];
    expect(command).toBe('/usr/bin/osascript');
    expect(wrapperArgs?.slice(0, 6)).toEqual([
      '-l',
      'JavaScript',
      '-e',
      expect.stringContaining('fchdir(3)'),
      '--',
      '/tools/custom-yt-dlp',
    ]);
    const ytDlpArgs = wrapperArgs?.slice(6) ?? [];
    expect(ytDlpArgs).toEqual([
      '--ignore-config',
      '--proxy',
      '',
      '--no-geo-bypass',
      '--no-playlist',
      '--max-downloads',
      '1',
      '--no-progress',
      '--write-info-json',
      '--clean-info-json',
      '--write-thumbnail',
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs',
      'zh.*,en.*',
      '--output',
      'video.%(ext)s',
      '--ffmpeg-location',
      '/tools/custom-ffmpeg',
      url,
    ]);
    expect(options).toEqual({extraStdioFds: [42]});
    expectFixedNetworkIsolation(ytDlpArgs);
  });

  it('snapshots the explicit FFmpeg path before caller option mutation', async () => {
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockResolvedValueOnce(processResult());
    const options = {
      runProcess,
      ffmpegExecutable: '/tools/original-ffmpeg',
    };
    const client = createYtDlpClient(options);

    options.ffmpegExecutable = '/tools/mutated-ffmpeg';
    await client.download('https://youtu.be/abc', 43);

    const wrapperArgs = runProcess.mock.calls[0]?.[1] ?? [];
    expect(wrapperArgs).toContain('/tools/original-ffmpeg');
    expect(wrapperArgs).not.toContain('/tools/mutated-ffmpeg');
  });

  it('sanitizes download process failures and does not retain the raw URL', async () => {
    const marker = 'download-secret-marker';
    const url = `https://youtu.be/abc?token=${marker}`;
    const processFailure = Object.assign(
      new Error(`download failed for ${url}`),
      {args: ['--output', '/private/output', url], stderr: marker},
    );
    const runProcess = vi.fn<DownloadProcessRunner>()
      .mockRejectedValueOnce(processFailure);

    const error = await expectDownloadError(
      createYtDlpClient({runProcess}).download(url, 44),
      'DOWNLOAD_PROCESS_FAILED',
      PROCESS_FAILED_MESSAGE,
    );

    expect(error).not.toBe(processFailure);
    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(url);
    expect(String(error)).not.toContain(marker);
  });
});
