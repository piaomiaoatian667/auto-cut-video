import {describe, expect, it} from 'vitest';
import {
  DownloadError,
  type DownloadErrorCode,
  isDownloadError,
} from '../../../src/download/errors';
import {
  assertExtractorMatches,
  parseDownloadUrl,
  platformForExtractor,
} from '../../../src/download/platforms';

const expectDownloadError = (
  callback: () => unknown,
  code: DownloadErrorCode,
): DownloadError => {
  try {
    callback();
  } catch (error) {
    expect(isDownloadError(error)).toBe(true);
    if (!isDownloadError(error)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected ${code}.`);
};

describe('download errors', () => {
  it('preserves its code, name, and cause', () => {
    const cause = new Error('cause');
    const error = new DownloadError('DOWNLOAD_URL_INVALID', 'Invalid URL.', {cause});

    expect(error).toMatchObject({
      code: 'DOWNLOAD_URL_INVALID',
      message: 'Invalid URL.',
      name: 'DownloadError',
      cause,
    });
    expect(isDownloadError(error)).toBe(true);
    expect(isDownloadError(new Error('other'))).toBe(false);
  });
});

describe('download platforms', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://www.bilibili.com/video/BV1abc', 'bilibili'],
    ['https://b23.tv/abc', 'bilibili'],
    ['https://v.douyin.com/abc/', 'douyin'],
    ['https://www.tiktok.com/@author/video/123', 'tiktok'],
    ['https://vimeo.com/123', 'vimeo'],
  ] as const)('accepts %s as %s', (source, platform) => {
    expect(parseDownloadUrl(source)).toMatchObject({platform});
  });

  it.each([
    ['http://youtube.com/watch?v=abc', 'DOWNLOAD_URL_INVALID'],
    ['https://user:secret@youtube.com/watch?v=abc', 'DOWNLOAD_URL_INVALID'],
    ['https://youtube.com.example.test/watch?v=abc', 'DOWNLOAD_HOST_UNSUPPORTED'],
    ['https://notyoutube.com/watch?v=abc', 'DOWNLOAD_HOST_UNSUPPORTED'],
    ['https://.youtube.com/watch?v=abc', 'DOWNLOAD_HOST_UNSUPPORTED'],
    ['https://foo..youtube.com/watch?v=abc', 'DOWNLOAD_HOST_UNSUPPORTED'],
    ['https://127.0.0.1/video', 'DOWNLOAD_HOST_UNSUPPORTED'],
    ['https://[::1]/video', 'DOWNLOAD_HOST_UNSUPPORTED'],
    ['https://example.com/video', 'DOWNLOAD_HOST_UNSUPPORTED'],
    ['not-a-url', 'DOWNLOAD_URL_INVALID'],
  ] as const)('rejects %s with %s', (source, code) => {
    expectDownloadError(() => parseDownloadUrl(source), code);
  });

  it('does not retain the raw source when URL parsing fails', () => {
    const marker = 'download-secret-marker';
    const error = expectDownloadError(
      () => parseDownloadUrl(`not-a-url?token=${marker}`),
      'DOWNLOAD_URL_INVALID',
    );

    expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain(marker);
  });

  it('normalizes the hostname', () => {
    expect(parseDownloadUrl('https://WWW.YOUTUBE.COM./watch?v=abc')).toMatchObject({
      hostname: 'www.youtube.com',
      platform: 'youtube',
    });
  });

  it('removes fragments while preserving query strings', () => {
    expect(parseDownloadUrl('https://youtu.be/abc?x=1#tracking').url)
      .toBe('https://youtu.be/abc?x=1');
  });

  it('normalizes one strict Douyin Jingxuan modal URL', () => {
    expect(parseDownloadUrl(
      'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
    )).toEqual({
      url: 'https://www.douyin.com/video/7654841525762919726',
      hostname: 'www.douyin.com',
      platform: 'douyin',
    });
  });

  it.each([
    'https://www.douyin.com/jingxuan',
    'https://www.douyin.com/jingxuan?modal_id=',
    'https://www.douyin.com/jingxuan?modal_id=abc&modal_id=def',
    'https://www.douyin.com/jingxuan?modal_id=abc&tracking=1',
    'https://www.douyin.com/jingxuan?modal_id=abc&',
    'https://www.douyin.com/jingxuan?&modal_id=abc',
    'https://www.douyin.com/jingxuan?modal%5Fid=abc',
    'https://www.douyin.com/jingxuan?modal_id=%61bc',
    'https://www.douyin.com/jingxuan?modal_id=video%2Fid',
    'https://www.douyin.com/jingxuan?modal_id=..',
    'https://www.douyin.com/jingxuan?modal_id=abc#tracking',
  ])('rejects malformed or ambiguous Douyin modal URL %s', (source) => {
    expectDownloadError(() => parseDownloadUrl(source), 'DOWNLOAD_URL_INVALID');
  });

  it.each([
    ['Youtube', 'youtube'],
    ['youtube:tab', 'youtube'],
    ['BiliBiliBangumi', 'bilibili'],
    ['DouyinUser', 'douyin'],
    ['TikTokUser', 'tiktok'],
    ['tiktok:user', 'tiktok'],
    ['vm.tiktok', 'tiktok'],
    ['vm.tiktok:redirect', 'tiktok'],
    ['VimeoReview', 'vimeo'],
  ] as const)('maps %s to %s', (extractor, platform) => {
    expect(platformForExtractor(extractor)).toBe(platform);
  });

  it.each([
    'Generic',
    'NotYoutube',
    'GenericBiliBili',
    'BiliLive',
  ])('returns null for unrecognized extractor %s', (extractor) => {
    expect(platformForExtractor(extractor)).toBeNull();
  });

  it('accepts a matching extractor', () => {
    expect(() => assertExtractorMatches('youtube', 'Youtube')).not.toThrow();
  });

  it('rejects an extractor mismatch', () => {
    expectDownloadError(
      () => assertExtractorMatches('youtube', 'Vimeo'),
      'DOWNLOAD_EXTRACTOR_MISMATCH',
    );
  });
});
