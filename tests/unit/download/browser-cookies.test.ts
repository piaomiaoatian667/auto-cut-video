import {describe, expect, it} from 'vitest';
import {
  parseBrowserCookieSource,
  validateBrowserCookieRequest,
} from '../../../src/download/browser-cookies';
import {isDownloadError} from '../../../src/download/errors';

const COOKIE_OPTIONS_MESSAGE =
  'Chrome cookie access requires both browser selection and explicit confirmation.';
const COOKIE_HOST_MESSAGE =
  'Browser cookie access is supported only for Douyin downloads.';

const expectDownloadError = (
  operation: () => unknown,
  code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID' | 'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
  message: string,
): void => {
  try {
    operation();
    throw new Error('Expected operation to throw.');
  } catch (error) {
    expect(isDownloadError(error)).toBe(true);
    if (!isDownloadError(error)) throw error;
    expect(error).toMatchObject({code, message, name: 'DownloadError'});
    expect(error.cause).toBeUndefined();
  }
};

describe('browser cookie source parsing', () => {
  it('leaves an omitted browser source undefined', () => {
    expect(parseBrowserCookieSource(undefined)).toBeUndefined();
  });

  it('accepts exact lowercase chrome', () => {
    expect(parseBrowserCookieSource('chrome')).toBe('chrome');
  });

  it.each([
    'Chrome',
    'chromium',
    'firefox',
    '--config-location',
  ])('rejects unsupported source %s without retaining it', (source) => {
    expectDownloadError(
      () => parseBrowserCookieSource(source),
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
  });
});

describe('browser cookie request validation', () => {
  it('allows anonymous Douyin downloads', () => {
    expect(validateBrowserCookieRequest(undefined, false, 'douyin'))
      .toBeUndefined();
  });

  it('allows explicitly confirmed Chrome access for Douyin', () => {
    expect(validateBrowserCookieRequest('chrome', true, 'douyin'))
      .toBe('chrome');
  });

  it.each([
    ['chrome', false],
    [undefined, true],
  ] as const)(
    'rejects mismatched source and confirmation values',
    (source, confirmed) => {
      expectDownloadError(
        () => validateBrowserCookieRequest(source, confirmed, 'douyin'),
        'DOWNLOAD_COOKIE_OPTIONS_INVALID',
        COOKIE_OPTIONS_MESSAGE,
      );
    },
  );

  it('rejects browser cookie access for YouTube', () => {
    expectDownloadError(
      () => validateBrowserCookieRequest('chrome', true, 'youtube'),
      'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
      COOKIE_HOST_MESSAGE,
    );
  });
});
