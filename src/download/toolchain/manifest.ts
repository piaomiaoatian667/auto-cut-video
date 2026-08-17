import {z} from 'zod';
import rawManifest from '../../../config/downloader-toolchain.json';
import {DownloadError} from '../errors';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';

const allowedAssetHosts = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);

const pinnedToolchainIdentity = {
  schemaVersion: 1,
  platform: 'darwin-arm64',
  ytDlp: {
    version: '2026.07.04',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos',
    bytes: 38256544,
    sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
  },
  potPlugin: {
    version: '1.3.1',
    url: 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.1/bgutil-ytdlp-pot-provider.zip',
    bytes: 8067,
    sha256: 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38',
  },
  potProvider: {
    repository: 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git',
    version: '1.3.1',
    commit: '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0',
    integrity: {
      source: {
        entries: 30,
        sha256: '1307dade1714cac0f6569377a5930be39b02ec719b0179f77de773c753c6bbf2',
      },
      nodeModules: {
        entries: 9715,
        files: 8906,
        symlinks: 809,
        sha256: 'f2606eacd44bbf1a9c071f52a8bffbfc1298c3b3cd58ffa713efb06ffc15ae36',
      },
    },
  },
} as const;

const allowedAssetUrlSchema = z.string().superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({code: 'custom'});
    return;
  }
  if (
    parsed.protocol !== 'https:' ||
    !allowedAssetHosts.has(parsed.hostname)
  ) {
    context.addIssue({code: 'custom'});
  }
});

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const commitSchema = z.string().regex(/^[0-9a-f]{40}$/);

const pinnedUrlSchema = <const Expected extends string>(expected: Expected) =>
  allowedAssetUrlSchema
    .refine((value) => value === expected)
    .transform(() => expected);

const pinnedSha256Schema = <const Expected extends string>(expected: Expected) =>
  sha256Schema
    .refine((value) => value === expected)
    .transform(() => expected);

const pinnedPositiveIntegerSchema = <const Expected extends number>(
  expected: Expected,
) =>
  z.number()
    .int()
    .positive()
    .refine((value) => value === expected)
    .transform(() => expected);

const pinnedCommitSchema = <const Expected extends string>(expected: Expected) =>
  commitSchema
    .refine((value) => value === expected)
    .transform(() => expected);

const ytDlpSchema = z.object({
  version: z.literal(pinnedToolchainIdentity.ytDlp.version),
  url: pinnedUrlSchema(pinnedToolchainIdentity.ytDlp.url),
  bytes: pinnedPositiveIntegerSchema(pinnedToolchainIdentity.ytDlp.bytes),
  sha256: pinnedSha256Schema(pinnedToolchainIdentity.ytDlp.sha256),
}).strict();

const potPluginSchema = z.object({
  version: z.literal(pinnedToolchainIdentity.potPlugin.version),
  url: pinnedUrlSchema(pinnedToolchainIdentity.potPlugin.url),
  bytes: pinnedPositiveIntegerSchema(pinnedToolchainIdentity.potPlugin.bytes),
  sha256: pinnedSha256Schema(pinnedToolchainIdentity.potPlugin.sha256),
}).strict();

const potProviderSchema = z.object({
  repository: pinnedUrlSchema(pinnedToolchainIdentity.potProvider.repository),
  version: z.literal(pinnedToolchainIdentity.potProvider.version),
  commit: pinnedCommitSchema(pinnedToolchainIdentity.potProvider.commit),
  integrity: z.object({
    source: z.object({
      entries: pinnedPositiveIntegerSchema(
        pinnedToolchainIdentity.potProvider.integrity.source.entries,
      ),
      sha256: pinnedSha256Schema(
        pinnedToolchainIdentity.potProvider.integrity.source.sha256,
      ),
    }).strict(),
    nodeModules: z.object({
      entries: pinnedPositiveIntegerSchema(
        pinnedToolchainIdentity.potProvider.integrity.nodeModules.entries,
      ),
      files: pinnedPositiveIntegerSchema(
        pinnedToolchainIdentity.potProvider.integrity.nodeModules.files,
      ),
      symlinks: pinnedPositiveIntegerSchema(
        pinnedToolchainIdentity.potProvider.integrity.nodeModules.symlinks,
      ),
      sha256: pinnedSha256Schema(
        pinnedToolchainIdentity.potProvider.integrity.nodeModules.sha256,
      ),
    }).strict(),
  }).strict(),
}).strict();

const downloaderToolchainManifestSchema = z.object({
  schemaVersion: z.literal(pinnedToolchainIdentity.schemaVersion),
  platform: z.literal(pinnedToolchainIdentity.platform),
  ytDlp: ytDlpSchema,
  potPlugin: potPluginSchema,
  potProvider: potProviderSchema,
}).strict();

export type DownloaderToolchainManifest = z.infer<
  typeof downloaderToolchainManifestSchema
>;

export const parseDownloaderToolchainManifest = (
  value: unknown,
): DownloaderToolchainManifest => {
  const parsed = downloaderToolchainManifestSchema.safeParse(value);
  if (!parsed.success) {
    throw new DownloadError(
      'DOWNLOAD_TOOLCHAIN_INVALID',
      INVALID_TOOLCHAIN_MESSAGE,
    );
  }
  return parsed.data;
};

export const DOWNLOADER_TOOLCHAIN_MANIFEST =
  parseDownloaderToolchainManifest(rawManifest);

export const installedManifestForPinnedToolchain = () => ({
  schemaVersion: 1 as const,
  platform: 'darwin-arm64' as const,
  ytDlp: {
    version: '2026.07.04' as const,
    bytes: 38256544 as const,
    sha256: DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256,
  },
  potPlugin: {
    version: '1.3.1' as const,
    bytes: 8067 as const,
    sha256: DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256,
  },
  potProvider: {
    version: '1.3.1' as const,
    commit: '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0' as const,
    integrity: DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.integrity,
  },
});
