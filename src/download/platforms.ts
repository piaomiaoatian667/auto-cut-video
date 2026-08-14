import {isIP} from 'node:net';
import {z} from 'zod';
import {DownloadError} from './errors';

export const DownloadPlatformSchema = z.enum([
  'youtube', 'bilibili', 'douyin', 'tiktok', 'vimeo',
]);
export type DownloadPlatform = z.infer<typeof DownloadPlatformSchema>;

const hosts: ReadonlyArray<{
  platform: DownloadPlatform;
  suffixes: readonly string[];
}> = [
  {platform: 'youtube', suffixes: ['youtube.com', 'youtu.be']},
  {platform: 'bilibili', suffixes: ['bilibili.com', 'b23.tv']},
  {platform: 'douyin', suffixes: ['douyin.com']},
  {platform: 'tiktok', suffixes: ['tiktok.com']},
  {platform: 'vimeo', suffixes: ['vimeo.com']},
];

const extractorPrefixes: ReadonlyArray<{
  platform: DownloadPlatform;
  prefixes: readonly string[];
}> = [
  {platform: 'youtube', prefixes: ['youtube']},
  {platform: 'bilibili', prefixes: ['bilibili']},
  {platform: 'douyin', prefixes: ['douyin']},
  {platform: 'tiktok', prefixes: ['tiktok', 'vm.tiktok']},
  {platform: 'vimeo', prefixes: ['vimeo']},
];

const safeDouyinModalId = /^[A-Za-z0-9._-]{1,512}$/u;

const matches = (hostname: string, suffix: string): boolean =>
  hostname === suffix || hostname.endsWith(`.${suffix}`);

const isIpLiteral = (hostname: string): boolean => {
  const candidate = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  return isIP(candidate) !== 0;
};

export interface ValidatedDownloadUrl {
  url: string;
  hostname: string;
  platform: DownloadPlatform;
}

export const parseDownloadUrl = (source: string): ValidatedDownloadUrl => {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw new DownloadError('DOWNLOAD_URL_INVALID', 'The video URL is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new DownloadError(
      'DOWNLOAD_URL_INVALID',
      'The video URL must use HTTPS and must not contain credentials.',
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const hasEmptyLabel = hostname.split('.').some((label) => label === '');
  const platform = hosts.find((candidate) =>
    candidate.suffixes.some((suffix) => matches(hostname, suffix)))?.platform;
  if (hostname === '' || hasEmptyLabel || isIpLiteral(hostname) || platform === undefined) {
    throw new DownloadError('DOWNLOAD_HOST_UNSUPPORTED', 'The video host is not supported.');
  }
  if (platform === 'douyin' && parsed.pathname === '/jingxuan') {
    const queryEntries = [...parsed.searchParams.entries()];
    const modalId = queryEntries[0]?.[1];
    if (
      parsed.href.includes('#')
      || queryEntries.length !== 1
      || queryEntries[0]?.[0] !== 'modal_id'
      || modalId === undefined
      || modalId === '.'
      || modalId === '..'
      || !safeDouyinModalId.test(modalId)
    ) {
      throw new DownloadError('DOWNLOAD_URL_INVALID', 'The video URL is invalid.');
    }
    parsed.pathname = `/video/${modalId}`;
    parsed.search = '';
  }
  parsed.hash = '';
  return {url: parsed.href, hostname, platform};
};

export const platformForExtractor = (
  extractor: string,
): DownloadPlatform | null => {
  const normalized = extractor.toLowerCase();
  return extractorPrefixes.find((candidate) =>
    candidate.prefixes.some((prefix) => normalized.startsWith(prefix)))?.platform ?? null;
};

export const assertExtractorMatches = (
  expected: DownloadPlatform,
  extractor: string,
): void => {
  if (platformForExtractor(extractor) !== expected) {
    throw new DownloadError(
      'DOWNLOAD_EXTRACTOR_MISMATCH',
      'The resolved video platform did not match the requested platform.',
    );
  }
};
