import {DownloadError} from './errors';

const proxyBrand: unique symbol = Symbol('download-proxy');
const rawControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const absoluteProxyUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]/u;
const acceptedSchemes = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

export type DownloadProxyScheme = 'http' | 'https' | 'socks5' | 'socks5h';

export interface DownloadProxy {
  readonly [proxyBrand]: true;
  readonly scheme: DownloadProxyScheme;
  readonly url: string;
}

export type DownloadProxyAudit =
  | {readonly proxyUsed: false}
  | {readonly proxyUsed: true; readonly proxyScheme: DownloadProxyScheme};

const invalidProxy = (): DownloadError => new DownloadError(
  'DOWNLOAD_PROXY_INVALID',
  'The proxy URL is invalid.',
);

export const parseDownloadProxy = (source: string): DownloadProxy => {
  if (rawControlCharacters.test(source) || !absoluteProxyUrl.test(source)) {
    throw invalidProxy();
  }
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    throw invalidProxy();
  }
  const port = parsed.port === '' ? undefined : Number(parsed.port);
  if (
    !acceptedSchemes.has(parsed.protocol) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hostname === '' ||
    (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/')
  ) {
    throw invalidProxy();
  }
  const scheme = parsed.protocol.slice(0, -1) as DownloadProxyScheme;
  return Object.freeze({[proxyBrand]: true as const, scheme, url: parsed.href});
};

export const proxyAudit = (
  proxy: DownloadProxy | undefined,
): DownloadProxyAudit => proxy === undefined
  ? {proxyUsed: false}
  : {proxyUsed: true, proxyScheme: proxy.scheme};

export const validateDownloadProxy = (
  value: unknown,
): DownloadProxy | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null) {
    throw invalidProxy();
  }
  const candidate = value as Record<PropertyKey, unknown>;
  if (
    candidate[proxyBrand] !== true ||
    typeof candidate.url !== 'string' ||
    typeof candidate.scheme !== 'string'
  ) {
    throw invalidProxy();
  }
  const parsed = parseDownloadProxy(candidate.url);
  if (parsed.scheme !== candidate.scheme) throw invalidProxy();
  return parsed;
};
