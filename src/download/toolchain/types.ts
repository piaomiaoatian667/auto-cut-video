export type DownloaderToolchainSource = 'managed' | 'override';

export interface DownloaderToolchainPaths {
  cacheRoot: string;
  versionDirectory: string;
  installedManifest: string;
  ytDlpExecutable: string;
  denoWrapperExecutable: string;
  pluginDirectory: string;
  pluginArchive: string;
  providerDirectory: string;
  providerServerDirectory: string;
  denoDirectory: string;
  providerCacheDirectory: string;
  setupLock: string;
}

export interface DownloaderToolchainAudit {
  source: DownloaderToolchainSource;
  ytDlpVersion: string;
  managedAssetSha256?: `sha256:${string}`;
  potProvider?: {name: 'bgutil'; version: '1.3.1'; mode: 'script'};
}

export interface ResolvedDownloaderToolchain {
  source: DownloaderToolchainSource;
  ytDlpExecutable: string;
  ffmpegExecutable: string;
  denoExecutable: string;
  ytDlpVersion: string;
  ffmpegVersion: string;
  pluginDirectory: string;
  pluginArchive: string;
  providerServerDirectory: string;
  denoDirectory: string;
  providerCacheDirectory: string;
  chromeImpersonationTarget: string;
  ffmpegExplicit: boolean;
  childEnvironment: Readonly<NodeJS.ProcessEnv>;
  audit: DownloaderToolchainAudit;
}

export interface SetupDownloaderResult {
  status: 'installed' | 'already-present';
  version: '2026.07.04';
}
