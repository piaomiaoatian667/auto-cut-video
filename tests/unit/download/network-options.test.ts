import {describe, expect, it} from 'vitest';
import {
  parseDownloadProxy,
  proxyAudit,
  validateDownloadProxy,
} from '../../../src/download/network-options';

const expectInvalidProxy = (value: string): void => {
  expect(() => parseDownloadProxy(value)).toThrowError(
    expect.objectContaining({
      code: 'DOWNLOAD_PROXY_INVALID',
      message: 'The proxy URL is invalid.',
    }),
  );
};

describe('download proxy options', () => {
  it.each([
    ['http://127.0.0.1:7890', 'http'],
    ['https://proxy.example:8443', 'https'],
    ['socks5://127.0.0.1:1080', 'socks5'],
    ['socks5h://proxy.example:1080', 'socks5h'],
  ] as const)('accepts %s', (source, scheme) => {
    const proxy = parseDownloadProxy(source);
    expect(proxy.url).toBe(new URL(source).href);
    expect(proxy.scheme).toBe(scheme);
    expect(proxyAudit(proxy)).toEqual({proxyUsed: true, proxyScheme: scheme});
  });

  it.each([
    'proxy.example:7890',
    'ftp://proxy.example:21',
    'http://user:password@proxy.example:7890',
    'http://proxy.example:0',
    'http://proxy.example:65536',
    'http://proxy.example/path',
    'http://proxy.example/?query=1',
    'http://proxy.example/#fragment',
    'http://proxy.example?',
    'http://proxy.example/?',
    'https://proxy.example#',
    'https://proxy.example/#',
    'socks5://proxy.example?#',
    'socks5h://proxy.example/?#',
    'http:///missing-host',
    'http://proxy.example\n.invalid',
  ])('rejects %s without echoing it', (source) => {
    expectInvalidProxy(source);
    try {
      parseDownloadProxy(source);
    } catch (error) {
      expect(String(error)).not.toContain(source);
    }
  });

  it('represents direct mode without an inherited proxy', () => {
    expect(proxyAudit(undefined)).toEqual({proxyUsed: false});
  });

  it('rejects forged runtime proxy objects', () => {
    expect(() => validateDownloadProxy({
      scheme: 'http',
      url: 'http://secret-proxy.example:7890/',
    })).toThrowError(expect.objectContaining({code: 'DOWNLOAD_PROXY_INVALID'}));
  });

  it('round-trips a parsed proxy through runtime validation', () => {
    const proxy = parseDownloadProxy('https://proxy.example:8443');
    expect(validateDownloadProxy(proxy)).toEqual(proxy);
  });

  it('allows undefined runtime proxy values', () => {
    expect(validateDownloadProxy(undefined)).toBeUndefined();
  });

  it('freezes parsed and validated proxy objects', () => {
    const proxy = parseDownloadProxy('socks5://127.0.0.1:1080');
    const validated = validateDownloadProxy(proxy);
    expect(Object.isFrozen(proxy)).toBe(true);
    expect(Object.isFrozen(validated)).toBe(true);
  });
});
