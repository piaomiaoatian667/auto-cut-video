import {z} from 'zod';
import {DownloadPlatformSchema, parseDownloadUrl} from './platforms';

const rawUrlControlCharacters = /[\u0000-\u0020\u007f-\u009f]/u;
const archiveFilenameControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;
const singleExtensionVideoFilename = /^video\.([A-Za-z0-9]+)$/u;
const subtitleFilename =
  /^video\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.([A-Za-z0-9]+)$/u;
const subtitleExtensions = new Set([
  'ass',
  'json3',
  'lrc',
  'srt',
  'srv1',
  'srv2',
  'srv3',
  'ttml',
  'vtt',
]);
const thumbnailExtensions = new Set([
  'avif',
  'jpeg',
  'jpg',
  'png',
  'webp',
]);
const FILE_ROLE_PATH_ISSUE =
  'file role must match the controlled archive filename';
const CANONICAL_PLATFORM_ISSUE =
  'canonicalUrl must use a supported platform matching receipt.platform';

const CanonicalHttpsUrlSchema = z.string().superRefine((value, context) => {
  if (rawUrlControlCharacters.test(value)) {
    context.addIssue({
      code: 'custom',
      message: 'canonicalUrl must not contain raw control characters or spaces',
    });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'canonicalUrl must be a valid canonical HTTPS URL',
    });
    return;
  }

  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.href !== value
  ) {
    context.addIssue({
      code: 'custom',
      message: 'canonicalUrl must be a valid canonical HTTPS URL without credentials',
    });
  }
});

const ArchiveFilenameSchema = z.string().superRefine((path, context) => {
  if (
    path.length === 0 ||
    path === '.' ||
    path === '..' ||
    path === 'receipt.json' ||
    path.includes('/') ||
    path.includes('\\') ||
    archiveFilenameControlCharacters.test(path)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'path must be exactly one safe archive filename',
    });
  }
});

const VideoIdSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+$/u)
  .refine((videoId) => videoId !== '.' && videoId !== '..');

export type DownloadArchiveFileRole =
  | 'media'
  | 'metadata'
  | 'subtitle'
  | 'thumbnail';

export const roleForArchiveFilename = (
  filename: string,
): DownloadArchiveFileRole | null => {
  if (filename === 'video.info.json') return 'metadata';

  const singleExtensionMatch = singleExtensionVideoFilename.exec(filename);
  if (singleExtensionMatch !== null) {
    const extension = singleExtensionMatch[1]?.toLowerCase();
    if (extension === undefined) return null;
    if (thumbnailExtensions.has(extension)) return 'thumbnail';
    if (subtitleExtensions.has(extension)) return null;
    return 'media';
  }

  const subtitleMatch = subtitleFilename.exec(filename);
  const subtitleExtension = subtitleMatch?.[1]?.toLowerCase();
  return subtitleExtension !== undefined && subtitleExtensions.has(subtitleExtension)
    ? 'subtitle'
    : null;
};

export const DownloadArchiveFileSchema = z.object({
  role: z.enum(['media', 'metadata', 'subtitle', 'thumbnail']),
  path: ArchiveFilenameSchema,
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict().superRefine((file, context) => {
  if (roleForArchiveFilename(file.path) !== file.role) {
    context.addIssue({
      code: 'custom',
      message: FILE_ROLE_PATH_ISSUE,
      path: ['path'],
    });
  }
});

export type DownloadArchiveFile = z.infer<typeof DownloadArchiveFileSchema>;

const DownloadReceiptCommonShape = {
  status: z.literal('downloaded'),
  platform: DownloadPlatformSchema,
  videoId: VideoIdSchema,
  title: z.string().min(1),
  canonicalUrl: CanonicalHttpsUrlSchema,
  downloadedAt: z.iso.datetime({offset: true}),
  purpose: z.literal('learning-analysis'),
  rightsConfirmed: z.literal(true),
  transcoded: z.literal(false),
  tools: z.object({
    ytDlpVersion: z.string().min(1),
    ffmpegVersion: z.string().min(1),
  }).strict(),
  files: z.array(DownloadArchiveFileSchema).min(2),
};

const DownloadReceiptV1Schema = z.object({
  version: z.literal(1),
  ...DownloadReceiptCommonShape,
}).strict();

const DownloadReceiptV2Schema = z.object({
  version: z.literal(2),
  ...DownloadReceiptCommonShape,
  platform: z.literal('douyin'),
  browserCookies: z.object({
    used: z.literal(true),
    source: z.literal('chrome'),
  }).strict(),
}).strict();

const BrowserCookiesV3Schema = z.discriminatedUnion('used', [
  z.object({used: z.literal(false)}).strict(),
  z.object({used: z.literal(true), source: z.literal('chrome')}).strict(),
]);

const NetworkAuditSchema = z.object({
  proxyUsed: z.boolean(),
  proxyScheme: z.enum(['http', 'https', 'socks5', 'socks5h']).optional(),
  browserImpersonation: z.boolean(),
  browserFamily: z.literal('chrome').optional(),
}).strict().superRefine((network, context) => {
  if (network.proxyUsed !== (network.proxyScheme !== undefined)) {
    context.addIssue({
      code: 'custom',
      message: 'proxy audit fields disagree',
    });
  }
  if (
    network.browserImpersonation !== (network.browserFamily !== undefined)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'browser impersonation audit fields disagree',
    });
  }
});

const ToolchainAuditSchema = z.object({
  source: z.enum(['managed', 'override']),
  ytDlpVersion: z.string().min(1),
  managedAssetSha256: z.string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .optional(),
  potProvider: z.object({
    name: z.literal('bgutil'),
    version: z.literal('1.3.1'),
    mode: z.literal('script'),
  }).strict().optional(),
}).strict().superRefine((toolchain, context) => {
  if (
    toolchain.source === 'managed' &&
    toolchain.managedAssetSha256 === undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'managed digest is required',
    });
  }
  if (
    toolchain.source === 'override' &&
    toolchain.managedAssetSha256 !== undefined
  ) {
    context.addIssue({
      code: 'custom',
      message: 'override digest is forbidden',
    });
  }
});

const DownloadReceiptV3Schema = z.object({
  version: z.literal(3),
  ...DownloadReceiptCommonShape,
  browserCookies: BrowserCookiesV3Schema,
  network: NetworkAuditSchema,
  toolchain: ToolchainAuditSchema,
}).strict().superRefine((receipt, context) => {
  if (receipt.toolchain.ytDlpVersion !== receipt.tools.ytDlpVersion) {
    context.addIssue({
      code: 'custom',
      message: 'tools and toolchain yt-dlp versions disagree',
      path: ['toolchain', 'ytDlpVersion'],
    });
  }
});

type DownloadReceiptVariant =
  | z.infer<typeof DownloadReceiptV1Schema>
  | z.infer<typeof DownloadReceiptV2Schema>
  | z.infer<typeof DownloadReceiptV3Schema>;

const validateDownloadReceipt = (
  receipt: DownloadReceiptVariant,
  context: z.core.$RefinementCtx<DownloadReceiptVariant>,
): void => {
  try {
    if (parseDownloadUrl(receipt.canonicalUrl).platform !== receipt.platform) {
      throw new Error();
    }
  } catch {
    context.addIssue({
      code: 'custom',
      message: CANONICAL_PLATFORM_ISSUE,
      path: ['canonicalUrl'],
    });
  }

  const paths = new Set<string>();
  let mediaCount = 0;
  let metadataCount = 0;
  let thumbnailCount = 0;

  receipt.files.forEach((file, index) => {
    if (paths.has(file.path)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate file path: ${file.path}`,
        path: ['files', index, 'path'],
      });
    }
    paths.add(file.path);

    const previous = receipt.files[index - 1];
    if (previous !== undefined && previous.path.localeCompare(file.path) > 0) {
      context.addIssue({
        code: 'custom',
        message: 'files must be sorted by path',
        path: ['files', index, 'path'],
      });
    }

    if (file.role === 'media') mediaCount += 1;
    if (file.role === 'metadata') metadataCount += 1;
    if (file.role === 'thumbnail') thumbnailCount += 1;
  });

  if (mediaCount !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'files must contain exactly one media entry',
      path: ['files'],
    });
  }
  if (metadataCount !== 1) {
    context.addIssue({
      code: 'custom',
      message: 'files must contain exactly one metadata entry',
      path: ['files'],
    });
  }
  if (thumbnailCount > 1) {
    context.addIssue({
      code: 'custom',
      message: 'files must contain at most one thumbnail entry',
      path: ['files'],
    });
  }
};

export const DownloadReceiptSchema = z.discriminatedUnion('version', [
  DownloadReceiptV1Schema,
  DownloadReceiptV2Schema,
  DownloadReceiptV3Schema,
]).superRefine(validateDownloadReceipt);

export type DownloadReceipt = z.infer<typeof DownloadReceiptSchema>;
