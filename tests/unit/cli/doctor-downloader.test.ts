import {describe, expect, it, vi} from 'vitest';
import {
  runDoctorDownloaderCommand,
  type DoctorDownloaderCommandDependencies,
} from '../../../src/cli/commands/doctor-downloader';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  createSystemVideoctlDependencies,
  runVideoctl,
  type VideoctlDependencies,
} from '../../../src/cli/videoctl';
import {
  checkVideoDownload,
  type DownloadCheckInput,
  type DownloadCheckResult,
  type DownloadDependencies,
  type SystemDownloadOptions,
} from '../../../src/download/downloader';
import {
  DownloadError,
  type DownloadErrorCode,
} from '../../../src/download/errors';
import {validateDownloadProxy} from '../../../src/download/network-options';
import type {ResolvedDownloaderToolchain} from '../../../src/download/toolchain/types';

const CHECK_URL = 'https://vimeo.com/123456';
const MANAGED_SHA256 = `sha256:${'a'.repeat(64)}` as const;
const TOOLCHAIN: ResolvedDownloaderToolchain = {
  source: 'managed',
  ytDlpExecutable: '/managed/bin/yt-dlp',
  ffmpegExecutable: '/managed/bin/ffmpeg',
  denoExecutable: '/managed/bin/deno',
  ytDlpVersion: '2026.07.04',
  ffmpegVersion: '8.1.2',
  pluginDirectory: '/managed/plugins',
  pluginArchive: '/managed/plugins/bgutil-ytdlp-pot-provider.zip',
  providerServerDirectory: '/managed/provider/server',
  denoDirectory: '/managed/deno',
  providerCacheDirectory: '/managed/deno/provider-cache',
  chromeImpersonationTarget: 'Chrome-136:Macos-15',
  ffmpegExplicit: false,
  childEnvironment: Object.freeze({PATH: '/usr/bin:/bin'}),
  audit: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    managedAssetSha256: MANAGED_SHA256,
  },
};
const REPORT = {
  command: 'doctor-downloader',
  ok: true,
  toolchain: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    integrity: 'verified',
    deno: 'available',
    ejs: 'available',
    potProvider: 'available',
    chromeImpersonation: 'available',
    ffmpeg: 'available',
  },
} as const;

type DoctorCheckImplementation = (
  input: DownloadCheckInput,
  resolveToolchain: () => Promise<ResolvedDownloaderToolchain>,
) => Promise<DownloadCheckResult>;

const commandFixture = (
  checkImplementation: DoctorCheckImplementation = async () => ({
    platform: 'vimeo',
    result: 'available',
  }),
  signal?: AbortSignal,
) => {
  let stdout = '';
  let stderr = '';
  const resolvedPromise = Promise.resolve(TOOLCHAIN);
  const resolveToolchain = vi.fn(() => resolvedPromise);
  const check = vi.fn(checkImplementation);
  const dependencies: DoctorDownloaderCommandDependencies = {
    stdout: {write: (chunk) => { stdout += chunk; }},
    stderr: {write: (chunk) => { stderr += chunk; }},
    resolveToolchain,
    check,
    ...(signal === undefined ? {} : {signal}),
  };
  return {
    dependencies,
    resolveToolchain,
    resolvedPromise,
    check,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

const videoctlFixture = () => {
  const run = commandFixture();
  const download = vi.fn(async () => { throw new Error('unused download'); });
  const setupDownloader = vi.fn(async () => { throw new Error('unused setup'); });
  const dependencies: VideoctlDependencies = {
    workspaceRoot: '/workspace',
    stdout: run.dependencies.stdout,
    stderr: run.dependencies.stderr,
    loadProject: vi.fn(async () => { throw new Error('unused'); }),
    measureSourceBytes: vi.fn(async () => { throw new Error('unused'); }),
    preflight: vi.fn(async () => { throw new Error('unused'); }),
    download,
    setupDownloader,
    resolveDownloaderToolchain: run.resolveToolchain,
    checkDownloader: run.check,
  };
  return {...run, dependencies, download, setupDownloader};
};

const failureDocument = (code: DownloadErrorCode, message: string) => ({
  command: 'doctor-downloader',
  ok: false,
  code,
  message,
});

describe('runDoctorDownloaderCommand', () => {
  it('prints the exact local JSON report without running a metadata check', async () => {
    const run = commandFixture();

    const exitCode = await runDoctorDownloaderCommand(
      {json: true},
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.resolveToolchain).toHaveBeenCalledOnce();
    expect(run.resolveToolchain).toHaveBeenCalledWith(undefined);
    expect(run.check).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(REPORT, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(REPORT);
    expect(run.stderr()).toBe('');
  });

  it('prints the exact concise human report', async () => {
    const run = commandFixture();

    const exitCode = await runDoctorDownloaderCommand({}, run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stdout()).toBe([
      'Downloader: 2026.07.04 (managed)',
      'Integrity: verified',
      'Deno/EJS/PO provider/Chrome impersonation/FFmpeg: available',
      '',
    ].join('\n'));
    expect(run.stderr()).toBe('');
  });

  it('passes branded network inputs and one shared resolver to the check', async () => {
    const controller = new AbortController();
    let firstResolution: Promise<ResolvedDownloaderToolchain> | undefined;
    let secondResolution: Promise<ResolvedDownloaderToolchain> | undefined;
    let receivedInput: DownloadCheckInput | undefined;
    const run = commandFixture(async (input, resolveToolchain) => {
      const first = resolveToolchain();
      const second = resolveToolchain();
      firstResolution = first;
      secondResolution = second;
      receivedInput = input;
      await first;
      return {platform: 'vimeo', result: 'available'};
    }, controller.signal);

    const exitCode = await runDoctorDownloaderCommand({
      checkUrl: CHECK_URL,
      rightsConfirmed: true,
      proxy: 'socks5h://proxy.example:1080',
      browserCookies: 'chrome',
      cookieAccessConfirmed: true,
      json: true,
    }, run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.resolveToolchain).toHaveBeenCalledOnce();
    expect(run.resolveToolchain).toHaveBeenCalledWith(controller.signal);
    expect(firstResolution).toBe(run.resolvedPromise);
    expect(secondResolution).toBe(firstResolution);
    expect(run.check).toHaveBeenCalledOnce();
    expect(receivedInput).toMatchObject({
      url: CHECK_URL,
      rightsConfirmed: true,
      cookieAccessConfirmed: true,
      browserCookieSource: 'chrome',
      signal: controller.signal,
    });
    expect(validateDownloadProxy(receivedInput?.proxy)).toMatchObject({
      scheme: 'socks5h',
      url: 'socks5h://proxy.example:1080',
    });
    expect(run.stdout()).toBe(`${JSON.stringify({
      ...REPORT,
      check: {platform: 'vimeo', result: 'available'},
    }, null, 2)}\n`);
    expect(run.stdout()).not.toContain(CHECK_URL);
    expect(run.stderr()).toBe('');
  });

  it('prints an optional human check line and no URL metadata', async () => {
    const run = commandFixture();

    const exitCode = await runDoctorDownloaderCommand({
      checkUrl: CHECK_URL,
      rightsConfirmed: true,
    }, run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stdout()).toBe([
      'Downloader: 2026.07.04 (managed)',
      'Integrity: verified',
      'Deno/EJS/PO provider/Chrome impersonation/FFmpeg: available',
      'Check: vimeo available',
      '',
    ].join('\n'));
    expect(run.stdout()).not.toContain(CHECK_URL);
  });

  it.each([
    {rightsConfirmed: true},
    {proxy: 'https://proxy.example'},
    {browserCookies: 'chrome'},
    {cookieAccessConfirmed: true},
  ])('rejects network options without --check-url: %j', async (options) => {
    const run = commandFixture();
    const expected = failureDocument(
      'DOWNLOAD_URL_INVALID',
      'The downloader doctor check input is invalid.',
    );

    const exitCode = await runDoctorDownloaderCommand(
      {...options, json: true},
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.resolveToolchain).not.toHaveBeenCalled();
    expect(run.check).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(run.stderr()).toBe('');
  });

  it('maps a URL check without rights confirmation to validation failure', async () => {
    const run = commandFixture(async (input) => {
      expect(input.rightsConfirmed).toBe(false);
      throw new DownloadError(
        'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
        'Confirm that you are permitted to save this public video.',
      );
    });

    const exitCode = await runDoctorDownloaderCommand({
      checkUrl: CHECK_URL,
      json: true,
    }, run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.resolveToolchain).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(failureDocument(
      'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
      'Confirm that you are permitted to save this public video.',
    ), null, 2)}\n`);
  });

  it.each([
    {
      options: {checkUrl: CHECK_URL, rightsConfirmed: true, proxy: 'file:///tmp/proxy'},
      code: 'DOWNLOAD_PROXY_INVALID' as const,
      message: 'The proxy URL is invalid.',
    },
    {
      options: {
        checkUrl: CHECK_URL,
        rightsConfirmed: true,
        browserCookies: 'Chrome',
      },
      code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID' as const,
      message: 'Chrome cookie access requires both browser selection and explicit confirmation.',
    },
  ])('rejects malformed local option parsing before resolving: $code', async ({
    options,
    code,
    message,
  }) => {
    const run = commandFixture();

    const exitCode = await runDoctorDownloaderCommand(
      {...options, json: true},
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.resolveToolchain).not.toHaveBeenCalled();
    expect(run.check).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(
      failureDocument(code, message),
      null,
      2,
    )}\n`);
  });

  it.each<{
    code: DownloadErrorCode;
    exitCode: number;
  }>([
    {code: 'DOWNLOAD_URL_INVALID', exitCode: EXIT_CODES.validationFailed},
    {code: 'DOWNLOAD_HOST_UNSUPPORTED', exitCode: EXIT_CODES.validationFailed},
    {code: 'DOWNLOAD_CONTENT_RESTRICTED', exitCode: EXIT_CODES.validationFailed},
    {code: 'DOWNLOAD_TOOLCHAIN_MISSING', exitCode: EXIT_CODES.environmentFailed},
    {code: 'DOWNLOAD_TOOLCHAIN_INVALID', exitCode: EXIT_CODES.environmentFailed},
    {code: 'DOWNLOAD_IMPERSONATION_UNAVAILABLE', exitCode: EXIT_CODES.environmentFailed},
    {code: 'DOWNLOAD_PO_TOKEN_UNAVAILABLE', exitCode: EXIT_CODES.environmentFailed},
    {code: 'DOWNLOAD_NETWORK_UNREACHABLE', exitCode: EXIT_CODES.operationFailed},
  ])('maps $code to exit $exitCode', async ({code, exitCode: expectedExitCode}) => {
    const run = commandFixture();
    run.resolveToolchain.mockRejectedValueOnce(new DownloadError(code, 'stable message'));

    const exitCode = await runDoctorDownloaderCommand({}, run.dependencies);

    expect(exitCode).toBe(expectedExitCode);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      `doctor-downloader failed [${code}]: stable message\n`,
    );
  });

  it('replaces unknown diagnostics with one stable toolchain failure', async () => {
    const run = commandFixture();
    run.resolveToolchain.mockRejectedValueOnce(
      new Error('/Users/private/cache token=secret'),
    );
    const expected = failureDocument(
      'DOWNLOAD_TOOLCHAIN_INVALID',
      'The managed downloader failed integrity or capability checks.',
    );

    const exitCode = await runDoctorDownloaderCommand(
      {json: true},
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(run.stderr()).toBe('');
    expect(run.stdout()).not.toContain('/Users/private');
    expect(run.stdout()).not.toContain('token=secret');
  });

  it('returns 130 after a shared signal is aborted', async () => {
    const controller = new AbortController();
    const run = commandFixture(async () => {
      controller.abort(new Error('private cancellation diagnostics'));
      throw new DownloadError(
        'DOWNLOAD_PROBE_FAILED',
        'The video metadata check failed.',
      );
    }, controller.signal);

    const exitCode = await runDoctorDownloaderCommand({
      checkUrl: CHECK_URL,
      rightsConfirmed: true,
    }, run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.cancelled);
    expect(run.stderr()).toBe(
      'doctor-downloader failed [DOWNLOAD_PROBE_FAILED]: '
      + 'The video metadata check failed.\n',
    );
    expect(run.stderr()).not.toContain('private cancellation');
  });
});

describe('videoctl doctor-downloader', () => {
  it('registers the command and emits one JSON document without setup or download', async () => {
    const run = videoctlFixture();

    const exitCode = await runVideoctl(
      ['doctor-downloader', '--json'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stdout()).toBe(`${JSON.stringify(REPORT, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(REPORT);
    expect(run.stderr()).toBe('');
    expect(run.setupDownloader).not.toHaveBeenCalled();
    expect(run.download).not.toHaveBeenCalled();
  });

  it('forwards every explicit check option through Commander', async () => {
    const controller = new AbortController();
    const run = videoctlFixture();
    run.dependencies.signal = controller.signal;

    const exitCode = await runVideoctl([
      'doctor-downloader',
      '--check-url',
      CHECK_URL,
      '--rights-confirmed',
      '--proxy',
      'https://proxy.example:8443',
      '--browser-cookies',
      'chrome',
      '--cookie-access-confirmed',
      '--json',
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.check).toHaveBeenCalledOnce();
    expect(run.check.mock.calls[0]?.[0]).toMatchObject({
      url: CHECK_URL,
      rightsConfirmed: true,
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
      signal: controller.signal,
    });
    expect(validateDownloadProxy(run.check.mock.calls[0]?.[0].proxy)).toMatchObject({
      scheme: 'https',
      url: 'https://proxy.example:8443/',
    });
    expect(run.setupDownloader).not.toHaveBeenCalled();
    expect(run.download).not.toHaveBeenCalled();
  });

  it('sanitizes JSON parse failures on stdout only', async () => {
    const run = videoctlFixture();
    const secretOption = '--token=/Users/private?token=secret';
    const expected = failureDocument(
      'DOWNLOAD_URL_INVALID',
      'The downloader doctor check input is invalid.',
    );

    const exitCode = await runVideoctl([
      'doctor-downloader',
      '--json',
      secretOption,
    ], run.dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
    expect(run.stdout()).not.toContain(secretOption);
    expect(run.resolveToolchain).not.toHaveBeenCalled();
    expect(run.setupDownloader).not.toHaveBeenCalled();
    expect(run.download).not.toHaveBeenCalled();
  });

  it('honors the option separator when selecting the human failure channel', async () => {
    const run = videoctlFixture();

    const exitCode = await runVideoctl(
      ['doctor-downloader', '--', '--json'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      'doctor-downloader failed [DOWNLOAD_URL_INVALID]: '
      + 'The downloader doctor check input is invalid.\n',
    );
    expect(run.stderr()).not.toContain('too many arguments');
    expect(run.resolveToolchain).not.toHaveBeenCalled();
  });
});

describe('system doctor-downloader boundary', () => {
  it('reuses the supplied resolver in normal checkVideoDownload dependencies', async () => {
    const probe = vi.fn(async () => ({
      id: 'abc',
      title: 'Doctor fixture',
      canonicalUrl: CHECK_URL,
      extractor: 'vimeo',
      extractorKey: 'Vimeo',
      hasDrm: false,
    }));
    const originalResolveToolchain = vi.fn(async () => {
      throw new Error('the original resolver must be replaced');
    });
    const archiveOperation = vi.fn(async () => {
      throw new Error('archive operation must not run');
    });
    const downloadDependencies: DownloadDependencies = {
      resolveToolchain: originalResolveToolchain,
      createClient: vi.fn(() => ({
        checkTools: vi.fn(async () => ({
          ytDlpVersion: TOOLCHAIN.ytDlpVersion,
          ffmpegVersion: TOOLCHAIN.ffmpegVersion,
        })),
        probe,
        download: vi.fn(async () => {
          throw new Error('download must not run');
        }),
      })),
      archive: {
        validateRoot: archiveOperation,
        prepare: archiveOperation,
        openStagingDownloadAuthority: archiveOperation,
        finalize: archiveOperation,
        cleanup: archiveOperation,
      } as DownloadDependencies['archive'],
      wait: vi.fn(async () => {}),
      now: () => new Date('2026-08-17T00:00:00.000Z'),
    };
    const createDownloadDependencies = vi.fn(
      (_options: SystemDownloadOptions) => downloadDependencies,
    );
    const dependencies = createSystemVideoctlDependencies({
      createDownloadDependencies,
    });
    const resolveOnce = vi.fn(() => Promise.resolve(TOOLCHAIN));

    const result = await dependencies.checkDownloader({
      url: CHECK_URL,
      rightsConfirmed: true,
      cookieAccessConfirmed: false,
    }, resolveOnce);

    expect(result).toEqual({platform: 'vimeo', result: 'available'});
    expect(createDownloadDependencies).toHaveBeenCalledOnce();
    expect(originalResolveToolchain).not.toHaveBeenCalled();
    expect(resolveOnce).toHaveBeenCalledOnce();
    expect(probe).toHaveBeenCalledOnce();
    expect(archiveOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'rights confirmation',
      input: {
        url: 'not a URL',
        rightsConfirmed: false,
        cookieAccessConfirmed: false,
      },
      code: 'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
    },
    {
      name: 'Cookie confirmation pairing',
      input: {
        url: CHECK_URL,
        rightsConfirmed: true,
        browserCookieSource: 'chrome' as const,
        cookieAccessConfirmed: false,
      },
      code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID',
    },
  ])('keeps $name ahead of toolchain resolution', async ({input, code}) => {
    const downloadDependencies = {
      resolveToolchain: vi.fn(async () => TOOLCHAIN),
      createClient: vi.fn(),
      archive: {},
      wait: vi.fn(),
      now: vi.fn(),
    } as unknown as DownloadDependencies;
    const dependencies = createSystemVideoctlDependencies({
      createDownloadDependencies: () => downloadDependencies,
    });
    const resolveOnce = vi.fn(async () => TOOLCHAIN);

    await expect(dependencies.checkDownloader(
      input,
      resolveOnce,
    )).rejects.toMatchObject({code});

    expect(resolveOnce).not.toHaveBeenCalled();
    expect(downloadDependencies.createClient).not.toHaveBeenCalled();
  });
});
