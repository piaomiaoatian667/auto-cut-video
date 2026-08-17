import type {BrowserCookieSource} from './browser-cookies';
import {DownloadError} from './errors';
import type {
  DownloadProxy,
  DownloadProxyScheme,
} from './network-options';
import type {DownloadPlatform} from './platforms';
import type {
  DownloaderToolchainAudit,
  ResolvedDownloaderToolchain,
} from './toolchain/types';

const IMPERSONATION_UNAVAILABLE_MESSAGE =
  'The required browser compatibility capability is unavailable.';
const SHARED_FIXED_PREFIX = ['--ignore-config'] as const;
const SHARED_FIXED_SUFFIX = [
  '--no-geo-bypass',
  '--no-playlist',
  '--playlist-items',
  '1',
] as const;
const SHARED_RETRIES = [
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
] as const;
const IMPERSONATED_PLATFORMS: ReadonlySet<DownloadPlatform> = new Set([
  'bilibili',
  'tiktok',
  'vimeo',
]);

export interface PlatformNetworkAudit {
  proxyUsed: boolean;
  proxyScheme?: DownloadProxyScheme;
  browserImpersonation: boolean;
  browserFamily?: 'chrome';
}

export interface ResolvedPlatformProfile {
  platform: DownloadPlatform;
  commonArgs: readonly string[];
  probeToDownloadDelayMs: 0 | 5000;
  networkAudit: PlatformNetworkAudit;
  browserCookies: {used: false} | {used: true; source: 'chrome'};
  potProviderUsed: boolean;
  toolchainAudit: DownloaderToolchainAudit;
}

export interface ResolvePlatformProfileInput {
  platform: DownloadPlatform;
  toolchain: ResolvedDownloaderToolchain;
  proxy?: DownloadProxy;
  browserCookieSource?: BrowserCookieSource;
}

const browserCookieArgs = (
  source: BrowserCookieSource | undefined,
): readonly string[] => source === undefined
  ? []
  : ['--cookies-from-browser', source];

const platformAdditions = (
  platform: DownloadPlatform,
  toolchain: ResolvedDownloaderToolchain,
): readonly string[] => {
  if (platform === 'youtube') {
    return [
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
    ];
  }
  if (!IMPERSONATED_PLATFORMS.has(platform)) return [];

  const target: unknown = toolchain.chromeImpersonationTarget;
  if (typeof target !== 'string' || target.trim() === '') {
    throw new DownloadError(
      'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
      IMPERSONATION_UNAVAILABLE_MESSAGE,
    );
  }
  return ['--impersonate', target];
};

const resolvedToolchainAudit = (
  toolchain: ResolvedDownloaderToolchain,
  potProviderUsed: boolean,
): DownloaderToolchainAudit => {
  const potProvider = potProviderUsed
    ? Object.freeze({
        name: 'bgutil' as const,
        version: '1.3.1' as const,
        mode: 'script' as const,
      })
    : undefined;
  return Object.freeze({
    source: toolchain.audit.source,
    ytDlpVersion: toolchain.audit.ytDlpVersion,
    ...(toolchain.audit.managedAssetSha256 === undefined
      ? {}
      : {managedAssetSha256: toolchain.audit.managedAssetSha256}),
    ...(potProvider === undefined ? {} : {potProvider}),
  });
};

export const resolvePlatformProfile = ({
  platform,
  toolchain,
  proxy,
  browserCookieSource,
}: ResolvePlatformProfileInput): ResolvedPlatformProfile => {
  const additions = platformAdditions(platform, toolchain);
  const browserImpersonation = IMPERSONATED_PLATFORMS.has(platform);
  const potProviderUsed = platform === 'youtube';
  const commonArgs = Object.freeze([
    ...SHARED_FIXED_PREFIX,
    '--proxy',
    proxy?.url ?? '',
    ...SHARED_FIXED_SUFFIX,
    ...SHARED_RETRIES,
    ...browserCookieArgs(browserCookieSource),
    ...additions,
  ]);
  const networkAudit: PlatformNetworkAudit = Object.freeze({
    proxyUsed: proxy !== undefined,
    ...(proxy === undefined ? {} : {proxyScheme: proxy.scheme}),
    browserImpersonation,
    ...(browserImpersonation ? {browserFamily: 'chrome' as const} : {}),
  });
  const browserCookies: ResolvedPlatformProfile['browserCookies'] =
    browserCookieSource === undefined
      ? Object.freeze({used: false as const})
      : Object.freeze({used: true as const, source: browserCookieSource});

  return Object.freeze({
    platform,
    commonArgs,
    probeToDownloadDelayMs: platform === 'youtube' ? 5000 : 0,
    networkAudit,
    browserCookies,
    potProviderUsed,
    toolchainAudit: resolvedToolchainAudit(toolchain, potProviderUsed),
  });
};
