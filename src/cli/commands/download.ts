import type {
  DownloadInput,
  DownloadResult,
} from '../../download/downloader';
import {parseBrowserCookieSource} from '../../download/browser-cookies';
import {
  isDownloadError,
  type DownloadErrorCode,
} from '../../download/errors';
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
  'DOWNLOAD_COOKIE_OPTIONS_INVALID',
  'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
]);

const UNEXPECTED_ERROR_CODE: DownloadErrorCode = 'DOWNLOAD_PROCESS_FAILED';
const UNEXPECTED_ERROR_MESSAGE = 'The download operation failed unexpectedly.';

const exitCodeForDownloadError = (code: DownloadErrorCode): number => {
  if (INVALID_INPUT_CODES.has(code)) return EXIT_CODES.validationFailed;
  if (code === 'DOWNLOAD_TOOL_MISSING') return EXIT_CODES.environmentFailed;
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
    const browserCookieSource = parseBrowserCookieSource(
      options.browserCookies,
    );
    const result = await dependencies.download({
      workspaceRoot: dependencies.workspaceRoot,
      url,
      outputRoot: options.output ?? 'downloads',
      rightsConfirmed: Boolean(options.rightsConfirmed),
      ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
      cookieAccessConfirmed: Boolean(options.cookieAccessConfirmed),
      ...(dependencies.downloadSignal === undefined
        ? {}
        : {signal: dependencies.downloadSignal}),
    });
    dependencies.stdout.write(formatDownloadSuccess(result, json));
    return EXIT_CODES.success;
  } catch (error) {
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
