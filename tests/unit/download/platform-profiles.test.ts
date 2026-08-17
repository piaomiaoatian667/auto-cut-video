import {describe, expect, it} from 'vitest';
import {isDownloadError} from '../../../src/download/errors';
import {parseDownloadProxy} from '../../../src/download/network-options';
import {
  resolvePlatformProfile,
  type ResolvedPlatformProfile,
} from '../../../src/download/platform-profiles';
import type {DownloadPlatform} from '../../../src/download/platforms';
import type {ResolvedDownloaderToolchain} from '../../../src/download/toolchain/types';

const IMPERSONATION_UNAVAILABLE_MESSAGE =
  'The required browser compatibility capability is unavailable.';

const createToolchain = (
  overrides: Partial<ResolvedDownloaderToolchain> = {},
): ResolvedDownloaderToolchain => ({
  source: 'managed',
  ytDlpExecutable: '/managed/bin/yt-dlp',
  ffmpegExecutable: '/usr/local/bin/ffmpeg',
  denoExecutable: '/usr/local/bin/deno',
  ytDlpVersion: '2026.07.04',
  ffmpegVersion: '8.1.2',
  pluginDirectory: '/managed/plugins',
  pluginArchive: '/managed/plugins/bgutil.zip',
  providerServerDirectory: '/managed/provider/server',
  denoDirectory: '/managed/deno',
  providerCacheDirectory: '/managed/provider-cache',
  chromeImpersonationTarget: 'Chrome-136:Macos-15',
  ffmpegExplicit: false,
  childEnvironment: Object.freeze({
    PATH: '/usr/bin:/bin',
    DENO_NO_PROMPT: '1',
  }),
  audit: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    managedAssetSha256: 'sha256:managed-asset',
  },
  ...overrides,
});

const expectImpersonationUnavailable = (
  operation: () => unknown,
): void => {
  try {
    operation();
  } catch (error) {
    expect(isDownloadError(error)).toBe(true);
    if (!isDownloadError(error)) throw error;
    expect(error).toMatchObject({
      code: 'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
      message: IMPERSONATION_UNAVAILABLE_MESSAGE,
      name: 'DownloadError',
    });
    expect(error.cause).toBeUndefined();
    return;
  }
  throw new Error('Expected DOWNLOAD_IMPERSONATION_UNAVAILABLE.');
};

const impersonationFlags = (
  profile: ResolvedPlatformProfile,
): readonly string[] => profile.commonArgs.filter((argument) =>
  argument === '--impersonate');

describe('resolvePlatformProfile', () => {
  it('builds the exact fixed YouTube argument sequence', () => {
    const toolchain = createToolchain();
    const proxy = parseDownloadProxy('http://127.0.0.1:7890');

    const profile = resolvePlatformProfile({
      platform: 'youtube',
      toolchain,
      proxy,
      browserCookieSource: 'chrome',
    });

    expect(profile.commonArgs).toEqual([
      '--ignore-config',
      '--proxy',
      'http://127.0.0.1:7890/',
      '--no-geo-bypass',
      '--no-playlist',
      '--playlist-items',
      '1',
      '--retries',
      '3',
      '--fragment-retries',
      '3',
      '--extractor-retries',
      '3',
      '--retry-sleep',
      'http:exp=1:4',
      '--retry-sleep',
      'fragment:exp=1:4',
      '--retry-sleep',
      'extractor:exp=1:4',
      '--cookies-from-browser',
      'chrome',
      '--no-plugin-dirs',
      '--plugin-dirs',
      toolchain.pluginDirectory,
      '--no-js-runtimes',
      '--js-runtimes',
      `deno:${toolchain.denoExecutable}`,
      '--no-remote-components',
      '--extractor-args',
      `youtubepot-bgutilscript:server_home=${toolchain.providerServerDirectory}`,
      '--sleep-requests',
      '1',
    ]);
    expect(profile).toMatchObject({
      platform: 'youtube',
      probeToDownloadDelayMs: 5000,
      networkAudit: {
        proxyUsed: true,
        proxyScheme: 'http',
        browserImpersonation: false,
      },
      browserCookies: {used: true, source: 'chrome'},
      potProviderUsed: true,
      toolchainAudit: {
        source: 'managed',
        ytDlpVersion: '2026.07.04',
        managedAssetSha256: 'sha256:managed-asset',
        potProvider: {name: 'bgutil', version: '1.3.1', mode: 'script'},
      },
    });
    expect(Object.hasOwn(profile.networkAudit, 'browserFamily')).toBe(false);
    expect(profile.commonArgs).not.toContain('--impersonate');
  });

  it('uses exactly one explicit empty proxy pair in direct mode', () => {
    const profile = resolvePlatformProfile({
      platform: 'douyin',
      toolchain: createToolchain(),
    });
    const proxyIndex = profile.commonArgs.indexOf('--proxy');

    expect(profile.commonArgs.filter((argument) => argument === '--proxy'))
      .toHaveLength(1);
    expect(profile.commonArgs.slice(proxyIndex, proxyIndex + 2)).toEqual([
      '--proxy',
      '',
    ]);
    expect(profile.networkAudit).toEqual({
      proxyUsed: false,
      browserImpersonation: false,
    });
    expect(profile.browserCookies).toEqual({used: false});
  });

  it.each(['bilibili', 'tiktok', 'vimeo'] as const)(
    'adds exactly one fixed Chrome impersonation pair for %s',
    (platform) => {
      const toolchain = createToolchain();
      const profile = resolvePlatformProfile({platform, toolchain});
      const impersonationIndex = profile.commonArgs.indexOf('--impersonate');

      expect(impersonationFlags(profile)).toHaveLength(1);
      expect(profile.commonArgs.slice(
        impersonationIndex,
        impersonationIndex + 2,
      )).toEqual(['--impersonate', toolchain.chromeImpersonationTarget]);
      expect(profile.networkAudit).toEqual({
        proxyUsed: false,
        browserImpersonation: true,
        browserFamily: 'chrome',
      });
      expect(profile.probeToDownloadDelayMs).toBe(0);
      expect(profile.potProviderUsed).toBe(false);
      expect(profile.toolchainAudit).not.toHaveProperty('potProvider');
    },
  );

  it('keeps Douyin free of impersonation and provider additions', () => {
    const profile = resolvePlatformProfile({
      platform: 'douyin',
      toolchain: createToolchain(),
      browserCookieSource: 'chrome',
    });

    expect(profile.commonArgs).not.toContain('--impersonate');
    expect(profile.commonArgs).not.toContain('--no-plugin-dirs');
    expect(profile.commonArgs).not.toContain('--plugin-dirs');
    expect(profile.commonArgs).not.toContain('--no-js-runtimes');
    expect(profile.commonArgs).not.toContain('--js-runtimes');
    expect(profile.commonArgs).not.toContain('--extractor-args');
    expect(profile.commonArgs).not.toContain('--sleep-requests');
    expect(profile.probeToDownloadDelayMs).toBe(0);
    expect(profile.potProviderUsed).toBe(false);
    expect(profile.browserCookies).toEqual({used: true, source: 'chrome'});
  });

  it.each([
    ['bilibili', ''],
    ['bilibili', undefined],
    ['tiktok', ''],
    ['tiktok', undefined],
    ['vimeo', ''],
    ['vimeo', undefined],
  ] as const)(
    'rejects a missing impersonation target for %s',
    (platform, target) => {
      const toolchain = createToolchain();
      if (target === undefined) {
        Reflect.deleteProperty(toolchain, 'chromeImpersonationTarget');
      } else {
        toolchain.chromeImpersonationTarget = target;
      }

      expectImpersonationUnavailable(() => resolvePlatformProfile({
        platform,
        toolchain,
      }));
    },
  );

  it('copies and freezes all public profile structures', () => {
    const toolchain = createToolchain();
    const profile = resolvePlatformProfile({
      platform: 'youtube',
      toolchain,
      browserCookieSource: 'chrome',
    });

    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.commonArgs)).toBe(true);
    expect(Object.isFrozen(profile.networkAudit)).toBe(true);
    expect(Object.isFrozen(profile.browserCookies)).toBe(true);
    expect(Object.isFrozen(profile.toolchainAudit)).toBe(true);
    expect(Object.isFrozen(profile.toolchainAudit.potProvider)).toBe(true);
    expect(profile.toolchainAudit).not.toBe(toolchain.audit);

    toolchain.audit.ytDlpVersion = 'mutated';
    toolchain.audit.managedAssetSha256 = 'sha256:mutated';
    toolchain.pluginDirectory = '/mutated/plugins';

    expect(profile.toolchainAudit).toMatchObject({
      ytDlpVersion: '2026.07.04',
      managedAssetSha256: 'sha256:managed-asset',
    });
    expect(profile.commonArgs).toContain('/managed/plugins');
    expect(profile.commonArgs).not.toContain('/mutated/plugins');
    expect(() => (profile.commonArgs as string[]).push('--mutated')).toThrow();
  });

  it.each([
    'youtube',
    'bilibili',
    'douyin',
    'tiktok',
    'vimeo',
  ] as const)('uses shared fixed retries for %s', (platform: DownloadPlatform) => {
    const profile = resolvePlatformProfile({
      platform,
      toolchain: createToolchain(),
    });

    expect(profile.commonArgs.slice(0, 19)).toEqual([
      '--ignore-config',
      '--proxy',
      '',
      '--no-geo-bypass',
      '--no-playlist',
      '--playlist-items',
      '1',
      '--retries',
      '3',
      '--fragment-retries',
      '3',
      '--extractor-retries',
      '3',
      '--retry-sleep',
      'http:exp=1:4',
      '--retry-sleep',
      'fragment:exp=1:4',
      '--retry-sleep',
      'extractor:exp=1:4',
    ]);
  });
});
