import {describe, expect, it} from 'vitest';
import {
  parseBrowserCookieSource,
  validateBrowserCookieRequest,
  type BrowserCookieSource,
} from '../../../src/download/browser-cookies';
import {isDownloadError} from '../../../src/download/errors';

const COOKIE_OPTIONS_MESSAGE =
  'Chrome cookie access requires both browser selection and explicit confirmation.';

const expectDownloadError = (
  operation: () => unknown,
  code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID',
  message: string,
  forbidden?: string,
): void => {
  try {
    operation();
    throw new Error('Expected operation to throw.');
  } catch (error) {
    expect(isDownloadError(error)).toBe(true);
    if (!isDownloadError(error)) throw error;
    expect(error).toMatchObject({code, message, name: 'DownloadError'});
    expect(error.cause).toBeUndefined();
    if (forbidden !== undefined) {
      expect([
        error.name,
        error.code,
        error.message,
        String(error.cause),
      ].join('\n')).not.toContain(forbidden);
    }
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

  it.each(['youtube', 'bilibili', 'douyin', 'tiktok', 'vimeo'] as const)(
    'allows separately confirmed Chrome access for %s',
    (platform) => {
      expect(validateBrowserCookieRequest('chrome', true, platform)).toBe('chrome');
    },
  );

  it('rejects an arbitrary runtime browser source without retaining it', () => {
    const marker = 'firefox:profile-marker';

    expectDownloadError(
      () => validateBrowserCookieRequest(
        marker as unknown as BrowserCookieSource,
        true,
        'douyin',
      ),
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
      marker,
    );
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
    ['string', 'true'],
    ['number', 1],
  ])('rejects a runtime %s confirmation value', (_name, confirmed) => {
    expectDownloadError(
      () => validateBrowserCookieRequest(
        'chrome',
        confirmed as unknown as boolean,
        'douyin',
      ),
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
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
});
