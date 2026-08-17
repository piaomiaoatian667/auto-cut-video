import {parseBrowserCookieSource} from '../../download/browser-cookies';
import type {
  DownloadCheckInput,
  DownloadCheckResult,
} from '../../download/downloader';
import {
  DownloadError,
  isDownloadError,
  type DownloadErrorCode,
} from '../../download/errors';
import {parseDownloadProxy} from '../../download/network-options';
import type {ResolvedDownloaderToolchain} from '../../download/toolchain/types';
import {
  formatDoctorDownloaderSuccess,
  formatDownloaderCommandFailure,
} from '../downloader-output';
import {EXIT_CODES} from '../exit-codes';
import type {OutputWriter} from '../videoctl';

export interface DoctorDownloaderCommandOptions {
  checkUrl?: string;
  rightsConfirmed?: boolean;
  proxy?: string;
  browserCookies?: string;
  cookieAccessConfirmed?: boolean;
  json?: boolean;
}

export interface DoctorDownloaderReport {
  source: 'managed' | 'override';
  ytDlpVersion: string;
  integrity: 'verified';
  deno: 'available';
  ejs: 'available';
  potProvider: 'available';
  chromeImpersonation: 'available';
  ffmpeg: 'available';
}

export interface DoctorDownloaderCommandDependencies {
  stdout: OutputWriter;
  stderr: OutputWriter;
  signal?: AbortSignal;
  resolveToolchain(signal?: AbortSignal): Promise<ResolvedDownloaderToolchain>;
  check(
    input: DownloadCheckInput,
    resolveToolchain: () => Promise<ResolvedDownloaderToolchain>,
  ): Promise<DownloadCheckResult>;
}

const INVALID_CHECK_INPUT_MESSAGE =
  'The downloader doctor check input is invalid.';
const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';
const VALIDATION_ERROR_CODES: ReadonlySet<DownloadErrorCode> = new Set([
  'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
  'DOWNLOAD_URL_INVALID',
  'DOWNLOAD_HOST_UNSUPPORTED',
  'DOWNLOAD_PROXY_INVALID',
  'DOWNLOAD_COOKIE_OPTIONS_INVALID',
  'DOWNLOAD_CONTENT_RESTRICTED',
]);
const ENVIRONMENT_ERROR_CODES: ReadonlySet<DownloadErrorCode> = new Set([
  'DOWNLOAD_TOOLCHAIN_MISSING',
  'DOWNLOAD_TOOLCHAIN_INVALID',
  'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
  'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
]);

const doctorReport = (
  toolchain: ResolvedDownloaderToolchain,
): DoctorDownloaderReport => ({
  source: toolchain.source,
  ytDlpVersion: toolchain.ytDlpVersion,
  integrity: 'verified',
  deno: 'available',
  ejs: 'available',
  potProvider: 'available',
  chromeImpersonation: 'available',
  ffmpeg: 'available',
});

const writeDoctorDownloaderFailure = (
  error: unknown,
  json: boolean,
  dependencies: DoctorDownloaderCommandDependencies,
): number => {
  const controlled = isDownloadError(error)
    ? error
    : new DownloadError(
        'DOWNLOAD_TOOLCHAIN_INVALID',
        INVALID_TOOLCHAIN_MESSAGE,
      );
  const output = formatDownloaderCommandFailure(
    'doctor-downloader',
    controlled.code,
    controlled.message,
    json,
  );
  if (json) dependencies.stdout.write(output);
  else dependencies.stderr.write(output);
  if (dependencies.signal?.aborted === true) return EXIT_CODES.cancelled;
  if (VALIDATION_ERROR_CODES.has(controlled.code)) {
    return EXIT_CODES.validationFailed;
  }
  if (ENVIRONMENT_ERROR_CODES.has(controlled.code)) {
    return EXIT_CODES.environmentFailed;
  }
  return EXIT_CODES.operationFailed;
};

export const runDoctorDownloaderCommand = async (
  options: DoctorDownloaderCommandOptions,
  dependencies: DoctorDownloaderCommandDependencies,
): Promise<number> => {
  const json = options.json === true;
  try {
    const hasCheck = options.checkUrl !== undefined;
    const hasNetworkOptions = options.rightsConfirmed !== undefined
      || options.proxy !== undefined
      || options.browserCookies !== undefined
      || options.cookieAccessConfirmed !== undefined;
    if (!hasCheck && hasNetworkOptions) {
      throw new DownloadError(
        'DOWNLOAD_URL_INVALID',
        INVALID_CHECK_INPUT_MESSAGE,
      );
    }
    const proxy = options.proxy === undefined
      ? undefined
      : parseDownloadProxy(options.proxy);
    const browserCookieSource = parseBrowserCookieSource(
      options.browserCookies,
    );
    let resolvedPromise: Promise<ResolvedDownloaderToolchain> | undefined;
    const resolveOnce = (): Promise<ResolvedDownloaderToolchain> => {
      resolvedPromise ??= dependencies.resolveToolchain(dependencies.signal);
      return resolvedPromise;
    };
    const check = options.checkUrl === undefined
      ? undefined
      : await dependencies.check({
          url: options.checkUrl,
          rightsConfirmed: options.rightsConfirmed === true,
          ...(proxy === undefined ? {} : {proxy}),
          ...(browserCookieSource === undefined
            ? {}
            : {browserCookieSource}),
          cookieAccessConfirmed: options.cookieAccessConfirmed === true,
          ...(dependencies.signal === undefined
            ? {}
            : {signal: dependencies.signal}),
        }, resolveOnce);
    const toolchain = await resolveOnce();
    dependencies.stdout.write(formatDoctorDownloaderSuccess(
      doctorReport(toolchain),
      check,
      json,
    ));
    return EXIT_CODES.success;
  } catch (error) {
    return writeDoctorDownloaderFailure(error, json, dependencies);
  }
};
