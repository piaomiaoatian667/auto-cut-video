import type {
  DownloadInput,
  DownloadResult,
} from '../../download/downloader';
import {parseBrowserCookieSource} from '../../download/browser-cookies';
import {
  DOWNLOAD_CANCELLATION_MESSAGE,
  isDownloadCancellationError,
} from '../../download/cancellation';
import {
  DownloadError,
  isDownloadError,
  type DownloadErrorCode,
} from '../../download/errors';
import {parseDownloadProxy} from '../../download/network-options';
import {
  formatDownloadFailure,
  formatDownloadSuccess,
} from '../download-output';
import {EXIT_CODES} from '../exit-codes';
import type {OutputWriter} from '../videoctl';

export interface DownloadCommandOptions {
  rightsConfirmed?: boolean;
  output?: string;
  json?: boolean;
  proxy?: string;
  browserCookies?: string;
  cookieAccessConfirmed?: boolean;
}

export interface DownloadCommandDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  downloadSignal?: AbortSignal;
  download(input: DownloadInput): Promise<DownloadResult>;
}

const INVALID_INPUT_CODES = new Set<DownloadErrorCode>([
  'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
  'DOWNLOAD_URL_INVALID',
  'DOWNLOAD_HOST_UNSUPPORTED',
  'DOWNLOAD_OUTPUT_INVALID',
  'DOWNLOAD_PROXY_INVALID',
  'DOWNLOAD_COOKIE_OPTIONS_INVALID',
  'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
  'DOWNLOAD_CONTENT_RESTRICTED',
]);

const ENVIRONMENT_ERROR_CODES = new Set<DownloadErrorCode>([
  'DOWNLOAD_TOOL_MISSING',
  'DOWNLOAD_TOOLCHAIN_MISSING',
  'DOWNLOAD_TOOLCHAIN_INVALID',
  'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
  'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
]);

const UNEXPECTED_ERROR_CODE: DownloadErrorCode = 'DOWNLOAD_PROCESS_FAILED';
const UNEXPECTED_ERROR_MESSAGE = 'The download operation failed unexpectedly.';
const RIGHTS_NOT_CONFIRMED_MESSAGE =
  'Confirm that you are permitted to save this public video.';
const COOKIE_OPTIONS_MESSAGE =
  'Chrome cookie access requires both browser selection and explicit confirmation.';

const parseOptionalBooleanFlag = (
  value: unknown,
  code: Extract<
    DownloadErrorCode,
    'DOWNLOAD_RIGHTS_NOT_CONFIRMED' | 'DOWNLOAD_COOKIE_OPTIONS_INVALID'
  >,
  message: string,
): boolean => {
  if (value === undefined) return false;
  if (typeof value === 'boolean') return value;
  throw new DownloadError(code, message);
};

const exitCodeForDownloadError = (code: DownloadErrorCode): number => {
  if (INVALID_INPUT_CODES.has(code)) return EXIT_CODES.validationFailed;
  if (ENVIRONMENT_ERROR_CODES.has(code)) return EXIT_CODES.environmentFailed;
  return EXIT_CODES.operationFailed;
};

const writeFailure = (
  code: DownloadErrorCode,
  message: string,
  json: boolean,
  dependencies: DownloadCommandDependencies,
): void => {
  const output = formatDownloadFailure(code, message, json);
  if (json) {
    dependencies.stdout.write(output);
  } else {
    dependencies.stderr.write(output);
  }
};

export const runDownloadCommand = async (
  url: string,
  options: DownloadCommandOptions,
  dependencies: DownloadCommandDependencies,
): Promise<number> => {
  const json = options.json === true;
  try {
    const rightsConfirmed = parseOptionalBooleanFlag(
      options.rightsConfirmed,
      'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
      RIGHTS_NOT_CONFIRMED_MESSAGE,
    );
    const cookieAccessConfirmed = parseOptionalBooleanFlag(
      options.cookieAccessConfirmed,
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
    const proxy = options.proxy === undefined
      ? undefined
      : parseDownloadProxy(options.proxy);
    const browserCookieSource = parseBrowserCookieSource(
      options.browserCookies,
    );
    const result = await dependencies.download({
      workspaceRoot: dependencies.workspaceRoot,
      url,
      outputRoot: options.output ?? 'downloads',
      rightsConfirmed,
      ...(proxy === undefined ? {} : {proxy}),
      ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
      cookieAccessConfirmed,
      ...(dependencies.downloadSignal === undefined
        ? {}
        : {signal: dependencies.downloadSignal}),
    });
    dependencies.stdout.write(formatDownloadSuccess(result, json));
    return EXIT_CODES.success;
  } catch (error) {
    if (isDownloadCancellationError(error)) {
      writeFailure(
        UNEXPECTED_ERROR_CODE,
        DOWNLOAD_CANCELLATION_MESSAGE,
        json,
        dependencies,
      );
      return EXIT_CODES.cancelled;
    }
    if (isDownloadError(error)) {
      writeFailure(error.code, error.message, json, dependencies);
      return exitCodeForDownloadError(error.code);
    }
    writeFailure(
      UNEXPECTED_ERROR_CODE,
      UNEXPECTED_ERROR_MESSAGE,
      json,
      dependencies,
    );
    return EXIT_CODES.operationFailed;
  }
};
