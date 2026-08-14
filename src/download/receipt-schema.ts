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

export const DownloadReceiptSchema = z.object({
  version: z.literal(1),
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
}).strict().superRefine((receipt, context) => {
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
});

export type DownloadReceipt = z.infer<typeof DownloadReceiptSchema>;
