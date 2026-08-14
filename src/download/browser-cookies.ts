import {DownloadError} from './errors';
import type {DownloadPlatform} from './platforms';

export type BrowserCookieSource = 'chrome';

const COOKIE_OPTIONS_MESSAGE =
  'Chrome cookie access requires both browser selection and explicit confirmation.';
const COOKIE_HOST_MESSAGE =
  'Browser cookie access is supported only for Douyin downloads.';

export const parseBrowserCookieSource = (
  value: string | undefined,
): BrowserCookieSource | undefined => {
  if (value === undefined) return undefined;
  if (value === 'chrome') return value;
  throw new DownloadError(
    'DOWNLOAD_COOKIE_OPTIONS_INVALID',
    COOKIE_OPTIONS_MESSAGE,
  );
};

export const validateBrowserCookieRequest = (
  source: BrowserCookieSource | undefined,
  cookieAccessConfirmed: boolean,
  platform: DownloadPlatform,
): BrowserCookieSource | undefined => {
  const runtimeSource: unknown = source;
  const runtimeConfirmation: unknown = cookieAccessConfirmed;
  if (
    (runtimeSource !== undefined && runtimeSource !== 'chrome') ||
    typeof runtimeConfirmation !== 'boolean'
  ) {
    throw new DownloadError(
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
  }
  if ((source === undefined) === cookieAccessConfirmed) {
    throw new DownloadError(
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
  }
  if (source !== undefined && platform !== 'douyin') {
    throw new DownloadError(
      'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
      COOKIE_HOST_MESSAGE,
    );
  }
  return source;
};
