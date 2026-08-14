import {EventEmitter} from 'node:events';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  runDownloadCommand,
  type DownloadCommandOptions,
} from '../../../src/cli/commands/download';
import {
  createSystemVideoctlDependencies,
  runWithDownloadSignalHandlers,
  runVideoctl,
  type VideoctlDependencies,
} from '../../../src/cli/videoctl';
import {
  type DownloadDependencies,
  type DownloadInput,
  type DownloadResult,
} from '../../../src/download/downloader';
import {
  DownloadError,
  type DownloadErrorCode,
} from '../../../src/download/errors';

const inputUrl = 'https://www.youtube.com/watch?v=abc';
const jingxuanUrl =
  'https://www.douyin.com/jingxuan?modal_id=7654841525762919726';

const downloadResult = (
  status: DownloadResult['status'] = 'downloaded',
): DownloadResult => ({
  status,
  platform: 'youtube',
  videoId: 'abc',
  directory: 'downloads/youtube/abc',
  mediaPath: 'downloads/youtube/abc/video.mp4',
  receiptPath: 'downloads/youtube/abc/receipt.json',
  receipt: {} as DownloadResult['receipt'],
});

type DownloadImplementation = (
  input: DownloadInput,
) => Promise<DownloadResult>;

const fixture = (
  implementation: DownloadImplementation = async () => downloadResult(),
) => {
  let stdout = '';
  let stderr = '';
  const download = vi.fn(implementation);
  const dependencies: VideoctlDependencies = {
    workspaceRoot: '/workspace',
    stdout: {write: (chunk) => { stdout += chunk; }},
    stderr: {write: (chunk) => { stderr += chunk; }},
    loadProject: vi.fn(async () => { throw new Error('unused'); }),
    measureSourceBytes: vi.fn(async () => { throw new Error('unused'); }),
    preflight: vi.fn(async () => { throw new Error('unused'); }),
    download,
  };
  return {
    dependencies,
    download,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('videoctl download', () => {
  it('downloads one authorized video and prints stable text output', async () => {
    const run = fixture();

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.download).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      url: inputUrl,
      outputRoot: 'downloads',
      rightsConfirmed: true,
      cookieAccessConfirmed: false,
    });
    expect(run.download.mock.calls[0]?.[0])
      .not.toHaveProperty('browserCookieSource');
    expect(run.stdout()).toBe([
      'Download complete: youtube/abc',
      'Media: downloads/youtube/abc/video.mp4',
      'Receipt: downloads/youtube/abc/receipt.json',
      '',
    ].join('\n'));
    expect(run.stdout()).not.toContain(inputUrl);
    expect(run.stderr()).toBe('');
  });

  it('forwards the configured download signal into the operation input', async () => {
    const controller = new AbortController();
    const run = fixture();
    run.dependencies.downloadSignal = controller.signal;

    await expect(runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    )).resolves.toBe(EXIT_CODES.success);

    expect(run.download).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      url: inputUrl,
      outputRoot: 'downloads',
      rightsConfirmed: true,
      cookieAccessConfirmed: false,
      signal: controller.signal,
    });
    expect(run.download.mock.calls[0]?.[0])
      .not.toHaveProperty('browserCookieSource');
  });

  it('forwards explicitly confirmed Chrome cookie access', async () => {
    const run = fixture();

    const exitCode = await runVideoctl([
      'download',
      jingxuanUrl,
      '--rights-confirmed',
      '--browser-cookies',
      'chrome',
      '--cookie-access-confirmed',
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.download).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      url: jingxuanUrl,
      outputRoot: 'downloads',
      rightsConfirmed: true,
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
    });
    expect(run.stderr()).toBe('');
  });

  it('rejects unsupported browser sources without exposing them', async () => {
    const run = fixture();
    const unsupportedSource = 'secret-profile-marker';
    const expected = {
      command: 'download',
      ok: false,
      code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      message:
        'Chrome cookie access requires both browser selection and explicit confirmation.',
    };

    const exitCode = await runVideoctl([
      'download',
      jingxuanUrl,
      '--rights-confirmed',
      '--browser-cookies',
      unsupportedSource,
      '--cookie-access-confirmed',
      '--json',
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.download).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stdout()).not.toContain(unsupportedSource);
    expect(run.stderr()).toBe('');
  });

  it('documents the closed browser cookie options in download help', async () => {
    const run = fixture();

    const exitCode = await runVideoctl(
      ['download', '--help'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    const help = run.stdout().replace(/\s+/g, ' ');
    expect(help).toContain('--browser-cookies <browser>');
    expect(help).toContain(
      'exact lowercase chrome for authorized public Douyin only; requires --cookie-access-confirmed',
    );
    expect(help).toContain('--cookie-access-confirmed');
    expect(help).toContain(
      'required with --browser-cookies; confirms local Chrome cookie access',
    );
    expect(run.stderr()).toBe('');
  });

  it('labels an existing archive without claiming a new download', async () => {
    const run = fixture(async () => downloadResult('already-present'));

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stdout()).toContain('Already downloaded: youtube/abc\n');
    expect(run.stdout()).not.toContain('Download complete');
    expect(run.stderr()).toBe('');
  });

  it('visibly escapes control characters in human success output', async () => {
    const forged = '\nFORGED\u001b[31m';
    const result = downloadResult();
    result.platform = `youtube${forged}` as DownloadResult['platform'];
    result.videoId = `abc${forged}`;
    result.mediaPath = `downloads/youtube/abc/video.mp4${forged}`;
    result.receiptPath = `downloads/youtube/abc/receipt.json${forged}`;
    const run = fixture(async () => result);

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stdout()).toBe([
      'Download complete: youtube\\nFORGED\\u001b[31m/'
        + 'abc\\nFORGED\\u001b[31m',
      'Media: downloads/youtube/abc/video.mp4\\nFORGED\\u001b[31m',
      'Receipt: downloads/youtube/abc/receipt.json\\nFORGED\\u001b[31m',
      '',
    ].join('\n'));
    expect(run.stdout()).not.toContain('\nFORGED');
    expect(run.stdout()).not.toContain('\u001b');
    expect(run.stderr()).toBe('');
  });

  it('prints exactly one JSON document for a successful download', async () => {
    const run = fixture();

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed', '--json'],
      run.dependencies,
    );
    const expected = {
      command: 'download',
      ok: true,
      status: 'downloaded',
      platform: 'youtube',
      videoId: 'abc',
      directory: 'downloads/youtube/abc',
      media: 'downloads/youtube/abc/video.mp4',
      receipt: 'downloads/youtube/abc/receipt.json',
    };

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
  });

  it('forwards a custom output directory and the rights flag', async () => {
    const run = fixture();

    const exitCode = await runVideoctl([
      'download',
      inputUrl,
      '--rights-confirmed',
      '--output',
      'archives',
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.download).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      url: inputUrl,
      outputRoot: 'archives',
      rightsConfirmed: true,
      cookieAccessConfirmed: false,
    });
    expect(run.download.mock.calls[0]?.[0])
      .not.toHaveProperty('browserCookieSource');
  });

  it('maps missing rights confirmation to invalid input', async () => {
    const run = fixture(async (input) => {
      expect(input.rightsConfirmed).toBe(false);
      throw new DownloadError(
        'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
        'Confirm that you are permitted to save this public video.',
      );
    });

    const exitCode = await runVideoctl(['download', inputUrl], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.stderr()).toBe(
      'Download failed [DOWNLOAD_RIGHTS_NOT_CONFIRMED]: '
      + 'Confirm that you are permitted to save this public video.\n',
    );
    expect(run.stdout()).toBe('');
  });

  it.each([
    ['string', 'false'],
    ['number', 1],
    ['object', {confirmed: true}],
    ['null', null],
    ['array', [true]],
  ])('rejects a runtime %s rights value before download', async (
    _caseName,
    rightsConfirmed,
  ) => {
    const run = fixture();
    const expected = {
      command: 'download',
      ok: false,
      code: 'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
      message: 'Confirm that you are permitted to save this public video.',
    };

    const exitCode = await runDownloadCommand(
      inputUrl,
      {
        rightsConfirmed,
        cookieAccessConfirmed: false,
        json: true,
      } as unknown as DownloadCommandOptions,
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.download).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(run.stderr()).toBe('');
  });

  it.each([
    ['string', 'false'],
    ['number', 1],
    ['object', {confirmed: true}],
    ['null', null],
    ['array', [true]],
  ])('rejects a runtime %s cookie confirmation before download', async (
    _caseName,
    cookieAccessConfirmed,
  ) => {
    const run = fixture();
    const expected = {
      command: 'download',
      ok: false,
      code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      message:
        'Chrome cookie access requires both browser selection and explicit confirmation.',
    };

    const exitCode = await runDownloadCommand(
      jingxuanUrl,
      {
        rightsConfirmed: true,
        browserCookies: 'chrome',
        cookieAccessConfirmed,
        json: true,
      } as unknown as DownloadCommandOptions,
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.download).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(run.stderr()).toBe('');
  });

  it.each<{
    code: DownloadErrorCode;
    message: string;
  }>([
    {code: 'DOWNLOAD_URL_INVALID', message: 'The video URL is invalid.'},
    {code: 'DOWNLOAD_HOST_UNSUPPORTED', message: 'The video host is not supported.'},
    {code: 'DOWNLOAD_OUTPUT_INVALID', message: 'The output directory is invalid.'},
    {
      code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      message:
        'Chrome cookie access requires both browser selection and explicit confirmation.',
    },
    {
      code: 'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
      message: 'Browser cookie access is supported only for Douyin downloads.',
    },
    {
      code: 'DOWNLOAD_CONTENT_RESTRICTED',
      message:
        'The requested video is not available as authorized public content.',
    },
  ])('maps $code to invalid input', async ({code, message}) => {
    const run = fixture(async () => { throw new DownloadError(code, message); });

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.stderr()).toBe(`Download failed [${code}]: ${message}\n`);
    expect(run.stdout()).toBe('');
  });

  it('maps download tool failures to the dependency exit code', async () => {
    const error = new DownloadError(
      'DOWNLOAD_TOOL_MISSING',
      'Required download tools are unavailable.',
    );
    const run = fixture(async () => { throw error; });

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(run.stderr()).toBe(
      'Download failed [DOWNLOAD_TOOL_MISSING]: '
      + 'Required download tools are unavailable.\n',
    );
    expect(run.stdout()).toBe('');
  });

  it.each<{
    code: DownloadErrorCode;
    message: string;
  }>([
    {
      code: 'DOWNLOAD_PROBE_FAILED',
      message: 'Video metadata could not be extracted.',
    },
    {
      code: 'DOWNLOAD_PROCESS_FAILED',
      message: 'The video could not be downloaded.',
    },
    {
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: 'The downloaded archive could not be finalized safely.',
    },
    {
      code: 'DOWNLOAD_EXTRACTOR_MISMATCH',
      message: 'The resolved video platform did not match the requested platform.',
    },
  ])('maps $code to operation failure', async ({code, message}) => {
    const run = fixture(async () => { throw new DownloadError(code, message); });

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    expect(run.stderr()).toBe(`Download failed [${code}]: ${message}\n`);
    expect(run.stdout()).toBe('');
  });

  it('maps unexpected errors to a fixed sanitized operation failure', async () => {
    const rawDetails = `spawn failed ${inputUrl} token=secret`;
    const run = fixture(async () => { throw new Error(rawDetails); });

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    expect(run.stderr()).toBe(
      'Download failed [DOWNLOAD_PROCESS_FAILED]: '
      + 'The download operation failed unexpectedly.\n',
    );
    expect(`${run.stdout()}${run.stderr()}`).not.toContain(inputUrl);
    expect(`${run.stdout()}${run.stderr()}`).not.toContain('token=secret');
    expect(`${run.stdout()}${run.stderr()}`).not.toContain(rawDetails);
  });

  it('visibly escapes control characters in human failure output', async () => {
    const message = 'Video metadata failed\nFORGED\u001b[31m';
    const run = fixture(async () => {
      throw new DownloadError('DOWNLOAD_PROBE_FAILED', message);
    });

    const exitCode = await runVideoctl(
      ['download', inputUrl, '--rights-confirmed'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    expect(run.stderr()).toBe(
      'Download failed [DOWNLOAD_PROBE_FAILED]: '
      + 'Video metadata failed\\nFORGED\\u001b[31m\n',
    );
    expect(run.stderr()).not.toContain('\nFORGED');
    expect(run.stderr()).not.toContain('\u001b');
    expect(run.stdout()).toBe('');
  });

  it('prints one sanitized JSON document for probe failure', async () => {
    const sensitiveUrl = `${inputUrl}&token=secret`;
    const rawDetails = `yt-dlp ${sensitiveUrl} exited with stderr details`;
    const run = fixture(async () => {
      throw new DownloadError(
        'DOWNLOAD_PROBE_FAILED',
        'Video metadata could not be extracted.',
        {cause: new Error(rawDetails)},
      );
    });

    const exitCode = await runVideoctl(
      ['download', sensitiveUrl, '--rights-confirmed', '--json'],
      run.dependencies,
    );
    const expected = {
      command: 'download',
      ok: false,
      code: 'DOWNLOAD_PROBE_FAILED',
      message: 'Video metadata could not be extracted.',
    };

    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
    expect(`${run.stdout()}${run.stderr()}`).not.toContain(sensitiveUrl);
    expect(`${run.stdout()}${run.stderr()}`).not.toContain('token=secret');
    expect(`${run.stdout()}${run.stderr()}`).not.toContain(rawDetails);
  });

  it.each<{
    name: string;
    argv: string[];
    forbidden: string[];
  }>([
    {
      name: 'missing URL',
      argv: ['download', '--json'],
      forbidden: [],
    },
    {
      name: 'extra token-bearing argument',
      argv: [
        'download',
        inputUrl,
        'https://example.invalid/extra?token=secret',
        '--json',
      ],
      forbidden: [
        inputUrl,
        'https://example.invalid/extra?token=secret',
        'token=secret',
      ],
    },
    {
      name: 'unknown secret-bearing option',
      argv: [
        'download',
        inputUrl,
        '--json',
        '--api-key=token=secret',
      ],
      forbidden: [inputUrl, '--api-key=token=secret', 'token=secret'],
    },
    {
      name: 'malformed JSON option',
      argv: ['download', inputUrl, '--json=token=secret'],
      forbidden: [inputUrl, '--json=token=secret', 'token=secret'],
    },
  ])('sanitizes JSON parser failure for $name', async ({argv, forbidden}) => {
    const run = fixture();
    const expected = {
      command: 'download',
      ok: false,
      code: 'DOWNLOAD_URL_INVALID',
      message: 'The download command input is invalid.',
    };

    const exitCode = await runVideoctl(argv, run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.download).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
    for (const value of forbidden) {
      expect(`${run.stdout()}${run.stderr()}`).not.toContain(value);
    }
  });

  it.each<{
    name: string;
    argv: string[];
    forbidden: string[];
  }>([
    {
      name: 'missing URL',
      argv: ['download'],
      forbidden: ['missing required argument'],
    },
    {
      name: 'extra token-bearing argument',
      argv: [
        'download',
        inputUrl,
        'https://example.invalid/extra?token=secret',
      ],
      forbidden: [
        inputUrl,
        'https://example.invalid/extra?token=secret',
        'token=secret',
        'too many arguments',
      ],
    },
    {
      name: 'unknown secret-bearing option',
      argv: ['download', inputUrl, '--api-key=option-secret'],
      forbidden: [
        inputUrl,
        '--api-key',
        'option-secret',
        'unknown option',
      ],
    },
  ])('sanitizes human parser failure for $name', async ({argv, forbidden}) => {
    const run = fixture();

    const exitCode = await runVideoctl(argv, run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.download).not.toHaveBeenCalled();
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      'Download failed [DOWNLOAD_URL_INVALID]: '
      + 'The download command input is invalid.\n',
    );
    expect(run.stderr()).not.toContain('error:');
    for (const value of forbidden) {
      expect(`${run.stdout()}${run.stderr()}`).not.toContain(value);
    }
  });

  it('snapshots configured downloader tool paths during system construction', () => {
    vi.stubEnv('YT_DLP_PATH', '/configured/yt-dlp');
    vi.stubEnv('FFMPEG_PATH', '/configured/ffmpeg');
    const downloadDependencies = {} as DownloadDependencies;
    const createDownloadDependencies = vi.fn(() => downloadDependencies);

    const controller = new AbortController();
    const changedController = new AbortController();
    const options = {
      createDownloadDependencies,
      signal: controller.signal,
    };
    const dependencies = createSystemVideoctlDependencies(options);
    options.signal = changedController.signal;
    vi.stubEnv('YT_DLP_PATH', '/changed/yt-dlp');
    vi.stubEnv('FFMPEG_PATH', '/changed/ffmpeg');

    expect(createDownloadDependencies).toHaveBeenCalledOnce();
    expect(createDownloadDependencies).toHaveBeenCalledWith({
      ytDlpExecutable: '/configured/yt-dlp',
      ffmpegExecutable: '/configured/ffmpeg',
    });
    expect(dependencies.ffmpegExecutable).toBe('/configured/ffmpeg');
    expect(dependencies.downloadSignal).toBe(controller.signal);
  });
});

describe('direct download signal handling', () => {
  it('installs listeners before running and removes them after success', async () => {
    const signalHost = new EventEmitter();
    let operationSignal: AbortSignal | undefined;

    await expect(runWithDownloadSignalHandlers(signalHost, async (signal) => {
      operationSignal = signal;
      expect(signalHost.listenerCount('SIGINT')).toBe(1);
      expect(signalHost.listenerCount('SIGTERM')).toBe(1);
      return 7;
    })).resolves.toBe(7);

    expect(operationSignal?.aborted).toBe(false);
    expect(signalHost.listenerCount('SIGINT')).toBe(0);
    expect(signalHost.listenerCount('SIGTERM')).toBe(0);
  });

  it('removes listeners when the operation fails without a signal', async () => {
    const signalHost = new EventEmitter();
    const failure = new Error('operation failed');

    await expect(runWithDownloadSignalHandlers(signalHost, async () => {
      expect(signalHost.listenerCount('SIGINT')).toBe(1);
      expect(signalHost.listenerCount('SIGTERM')).toBe(1);
      throw failure;
    })).rejects.toBe(failure);

    expect(signalHost.listenerCount('SIGINT')).toBe(0);
    expect(signalHost.listenerCount('SIGTERM')).toBe(0);
  });

  it('keeps handlers installed and aborts only once until the operation settles', async () => {
    const signalHost = new EventEmitter();
    let operationSignal: AbortSignal | undefined;
    let abortEvents = 0;
    let resolveOperation!: (value: number) => void;
    const operation = runWithDownloadSignalHandlers(signalHost, async (signal) => {
      operationSignal = signal;
      signal.addEventListener('abort', () => { abortEvents += 1; });
      return await new Promise<number>((resolve) => {
        resolveOperation = resolve;
      });
    });

    signalHost.emit('SIGINT');
    expect(operationSignal?.aborted).toBe(true);
    expect(operationSignal?.reason).toEqual(
      new Error('The download operation was cancelled.'),
    );
    expect(abortEvents).toBe(1);
    expect(signalHost.listenerCount('SIGINT')).toBe(1);
    expect(signalHost.listenerCount('SIGTERM')).toBe(1);

    signalHost.emit('SIGTERM');
    signalHost.emit('SIGINT');
    expect(abortEvents).toBe(1);
    expect(operationSignal?.reason).toEqual(
      new Error('The download operation was cancelled.'),
    );
    expect(signalHost.listenerCount('SIGINT')).toBe(1);
    expect(signalHost.listenerCount('SIGTERM')).toBe(1);

    resolveOperation(7);
    await expect(operation).resolves.toBe(7);
    expect(signalHost.listenerCount('SIGINT')).toBe(0);
    expect(signalHost.listenerCount('SIGTERM')).toBe(0);
  });
});
