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

const assetSchema = z.object({
  version: z.string().min(1),
  url: allowedAssetUrlSchema,
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
}).strict();

const downloaderToolchainManifestSchema = z.object({
  schemaVersion: z.literal(1),
  platform: z.literal('darwin-arm64'),
  ytDlp: assetSchema,
  potPlugin: assetSchema,
  potProvider: z.object({
    repository: allowedAssetUrlSchema,
    version: z.string().min(1),
    commit: commitSchema,
  }).strict(),
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
  },
});
