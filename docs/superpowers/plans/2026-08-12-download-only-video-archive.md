# Download-Only Video Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `videoctl download` to archive one authorized public video with metadata, subtitles, thumbnail, hashes, and a receipt without entering the editing pipeline.

**Architecture:** Validate a small platform allowlist before network access, share one non-live video metadata validator across probe/finalization/existing-archive checks, and invoke `yt-dlp` with fixed disabling flags. On Darwin, bind writes to a validated staging directory FD through a fixed JXA `fchdir(3)`/`NSTask` wrapper and relative `video.%(ext)s`; archive workers hash and parse full bytes while returning bounded semantic results. Propagate one operation `AbortSignal` through child processes, close authorities before finalization, clean only owned staging, and atomically publish the verified archive.

**Tech Stack:** TypeScript 7, Node.js 22, Commander 15, Zod 4, Vitest 4, external `yt-dlp`, external FFmpeg, Darwin JXA/Objective-C bridge.

**Approved spec:** `docs/superpowers/specs/2026-08-12-download-only-video-archive-design.md`

**Repository rule:** Do not create Git commits unless the user explicitly requests them. Each task stops after verification.

---

## File Map

- `src/download/errors.ts`: stable domain errors.
- `src/download/platforms.ts`: URL allowlist and extractor matching.
- `src/download/receipt-schema.ts`: strict receipt, canonical-platform, and stable filename-role contract.
- `src/download/yt-dlp.ts`: controlled tool checks, shared metadata validation, signal propagation, and FD-bound Darwin download.
- `src/download/archive.ts`: staging authorities, full-byte workers, hashing, metadata binding, duplicate verification, owned cleanup, and finalization.
- `src/download/downloader.ts`: end-to-end use case and system dependencies.
- `src/cli/download-output.ts`: human and JSON rendering.
- `src/cli/commands/download.ts`: exit-code mapping.
- `src/cli/videoctl.ts`: command registration, dependency wiring, and direct-download signal handlers.
- `tests/unit/download/`: domain tests.
- `tests/unit/cli/download.test.ts`: CLI tests.
- `tests/integration/download/system-download.test.ts`: no-network process integration.
- `tests/integration/download/cli-cancellation.test.ts`: direct CLI signal/process-group cleanup integration.
- `.gitignore` and `README.md`: local archive exclusion and operator instructions.

## Task 1: Add Errors and Platform Validation

**Files:**
- Create: `src/download/errors.ts`
- Create: `src/download/platforms.ts`
- Test: `tests/unit/download/platforms.test.ts`

- [ ] **Step 1: Write the failing URL tests**

Create `tests/unit/download/platforms.test.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {
  assertExtractorMatches,
  parseDownloadUrl,
  platformForExtractor,
} from '../../../src/download/platforms';

describe('download platforms', () => {
  it.each([
    ['https://www.youtube.com/watch?v=abc', 'youtube'],
    ['https://youtu.be/abc', 'youtube'],
    ['https://www.bilibili.com/video/BV1abc', 'bilibili'],
    ['https://b23.tv/abc', 'bilibili'],
    ['https://v.douyin.com/abc/', 'douyin'],
    ['https://www.tiktok.com/@author/video/123', 'tiktok'],
    ['https://vimeo.com/123', 'vimeo'],
  ] as const)('accepts %s as %s', (source, platform) => {
    expect(parseDownloadUrl(source)).toMatchObject({platform});
  });

  it.each([
    'http://youtube.com/watch?v=abc',
    'https://user:secret@youtube.com/watch?v=abc',
    'https://youtube.com.example.test/watch?v=abc',
    'https://127.0.0.1/video',
    'https://example.com/video',
    'not-a-url',
  ])('rejects %s', (source) => {
    expect(() => parseDownloadUrl(source)).toThrow();
  });

  it('removes fragments', () => {
    expect(parseDownloadUrl('https://youtu.be/abc?x=1#tracking').url)
      .toBe('https://youtu.be/abc?x=1');
  });

  it.each([
    ['Youtube', 'youtube'],
    ['BiliBili', 'bilibili'],
    ['Douyin', 'douyin'],
    ['TikTok', 'tiktok'],
    ['Vimeo', 'vimeo'],
  ] as const)('maps %s to %s', (extractor, platform) => {
    expect(platformForExtractor(extractor)).toBe(platform);
  });

  it('rejects an extractor mismatch', () => {
    expect(() => assertExtractorMatches('youtube', 'Vimeo')).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused failure**

Run:

```bash
pnpm exec vitest run tests/unit/download/platforms.test.ts
```

Expected: FAIL because `src/download/platforms.ts` is missing.

- [ ] **Step 3: Implement stable errors**

Create `src/download/errors.ts`:

```ts
export type DownloadErrorCode =
  | 'DOWNLOAD_RIGHTS_NOT_CONFIRMED'
  | 'DOWNLOAD_URL_INVALID'
  | 'DOWNLOAD_HOST_UNSUPPORTED'
  | 'DOWNLOAD_OUTPUT_INVALID'
  | 'DOWNLOAD_TOOL_MISSING'
  | 'DOWNLOAD_PROBE_FAILED'
  | 'DOWNLOAD_EXTRACTOR_MISMATCH'
  | 'DOWNLOAD_DESTINATION_CONFLICT'
  | 'DOWNLOAD_PROCESS_FAILED'
  | 'DOWNLOAD_ARCHIVE_INVALID'
  | 'DOWNLOAD_FINALIZE_FAILED';

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DownloadError';
  }
}

export const isDownloadError = (error: unknown): error is DownloadError =>
  error instanceof DownloadError;
```

- [ ] **Step 4: Implement URL and extractor validation**

Create `src/download/platforms.ts`:

```ts
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

const matches = (hostname: string, suffix: string): boolean =>
  hostname === suffix || hostname.endsWith(`.${suffix}`);

export interface ValidatedDownloadUrl {
  url: string;
  hostname: string;
  platform: DownloadPlatform;
}

export const parseDownloadUrl = (source: string): ValidatedDownloadUrl => {
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch (cause) {
    throw new DownloadError('DOWNLOAD_URL_INVALID', 'The video URL is invalid.', {cause});
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    throw new DownloadError(
      'DOWNLOAD_URL_INVALID',
      'The video URL must use HTTPS and must not contain credentials.',
    );
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
  const platform = hosts.find((candidate) =>
    candidate.suffixes.some((suffix) => matches(hostname, suffix)))?.platform;
  if (hostname === '' || isIP(hostname) !== 0 || platform === undefined) {
    throw new DownloadError('DOWNLOAD_HOST_UNSUPPORTED', 'The video host is not supported.');
  }
  parsed.hash = '';
  return {url: parsed.href, hostname, platform};
};

export const platformForExtractor = (
  extractor: string,
): DownloadPlatform | null => {
  const normalized = extractor.toLowerCase();
  if (normalized.includes('youtube')) return 'youtube';
  if (normalized.includes('bilibili')) return 'bilibili';
  if (normalized.includes('douyin')) return 'douyin';
  if (normalized.includes('tiktok')) return 'tiktok';
  if (normalized.includes('vimeo')) return 'vimeo';
  return null;
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
```

- [ ] **Step 5: Verify Task 1**

Run:

```bash
pnpm exec vitest run tests/unit/download/platforms.test.ts
pnpm typecheck
```

Expected: both commands PASS.

## Task 2: Define the Receipt Contract

**Files:**
- Create: `src/download/receipt-schema.ts`
- Test: `tests/unit/download/receipt-schema.test.ts`

- [ ] **Step 1: Write the failing strict-schema tests**

Create `tests/unit/download/receipt-schema.test.ts` with one valid receipt and these invalid variants:

```ts
import {describe, expect, it} from 'vitest';
import {DownloadReceiptSchema} from '../../../src/download/receipt-schema';

const valid = {
  version: 1,
  status: 'downloaded',
  platform: 'youtube',
  videoId: 'abc_123-Z',
  title: 'Example',
  canonicalUrl: 'https://youtu.be/abc_123-Z',
  downloadedAt: '2026-08-12T00:00:00.000Z',
  purpose: 'learning-analysis',
  rightsConfirmed: true,
  transcoded: false,
  tools: {ytDlpVersion: 'test', ffmpegVersion: 'ffmpeg version test'},
  files: [
    {role: 'metadata', path: 'video.info.json', bytes: 4, sha256: `sha256:${'a'.repeat(64)}`},
    {role: 'media', path: 'video.webm', bytes: 5, sha256: `sha256:${'b'.repeat(64)}`},
  ],
} as const;

describe('DownloadReceiptSchema', () => {
  it('accepts a strict sorted receipt', () => {
    expect(DownloadReceiptSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    {...valid, unexpected: true},
    {...valid, rightsConfirmed: false},
    {...valid, transcoded: true},
    {...valid, videoId: '../escape'},
    {...valid, canonicalUrl: 'https://vimeo.com/abc_123-Z'},
    {...valid, files: [
      {...valid.files[0], role: 'media'},
      valid.files[1],
    ]},
    {...valid, files: [...valid.files].reverse()},
    {...valid, files: [valid.files[0], valid.files[0]]},
  ])('rejects invalid data', (candidate) => {
    expect(() => DownloadReceiptSchema.parse(candidate)).toThrow();
  });
});
```

- [ ] **Step 2: Run the focused failure**

Run:

```bash
pnpm exec vitest run tests/unit/download/receipt-schema.test.ts
```

Expected: FAIL because the schema module is missing.

- [ ] **Step 3: Implement strict schemas**

Create `src/download/receipt-schema.ts`:

```ts
import {z} from 'zod';
import {DownloadPlatformSchema, parseDownloadUrl} from './platforms';

const singleExtensionVideoFilename = /^video\.([A-Za-z0-9]+)$/u;
const subtitleFilename =
  /^video\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.([A-Za-z0-9]+)$/u;
const subtitleExtensions = new Set([
  'ass', 'json3', 'lrc', 'srt', 'srv1', 'srv2', 'srv3', 'ttml', 'vtt',
]);
const thumbnailExtensions = new Set(['avif', 'jpeg', 'jpg', 'png', 'webp']);

const FilePathSchema = z.string().min(1).superRefine((value, context) => {
  if (
    value.includes('/') || value.includes('\\') || value.includes('\0')
    || value === '.' || value === '..'
  ) {
    context.addIssue({code: 'custom', message: 'must be one archive filename'});
  }
});

export const roleForArchiveFilename = (filename: string) => {
  if (filename === 'video.info.json') return 'metadata' as const;
  const singleExtension = singleExtensionVideoFilename.exec(filename)?.[1]?.toLowerCase();
  if (singleExtension !== undefined) {
    if (thumbnailExtensions.has(singleExtension)) return 'thumbnail' as const;
    if (subtitleExtensions.has(singleExtension)) return null;
    return 'media' as const;
  }
  const subtitleExtension = subtitleFilename.exec(filename)?.[1]?.toLowerCase();
  return subtitleExtension !== undefined && subtitleExtensions.has(subtitleExtension)
    ? 'subtitle' as const
    : null;
};

export const DownloadArchiveFileSchema = z.object({
  role: z.enum(['media', 'metadata', 'subtitle', 'thumbnail']),
  path: FilePathSchema,
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict().superRefine((file, context) => {
  if (roleForArchiveFilename(file.path) !== file.role) {
    context.addIssue({
      code: 'custom', path: ['path'],
      message: 'file role must match the controlled archive filename',
    });
  }
});

export const DownloadReceiptSchema = z.object({
  version: z.literal(1),
  status: z.literal('downloaded'),
  platform: DownloadPlatformSchema,
  videoId: z.string().min(1).max(512).regex(/^[A-Za-z0-9._-]+$/u),
  title: z.string().min(1),
  canonicalUrl: z.string().url().refine((value) => value.startsWith('https:')),
  downloadedAt: z.iso.datetime({offset: true}),
  purpose: z.literal('learning-analysis'),
  rightsConfirmed: z.literal(true),
  transcoded: z.literal(false),
  tools: z.object({
    ytDlpVersion: z.string().min(1),
    ffmpegVersion: z.string().min(1),
  }).strict(),
  files: z.array(DownloadArchiveFileSchema).min(2),
}).strict().superRefine((value, context) => {
  try {
    if (parseDownloadUrl(value.canonicalUrl).platform !== value.platform) {
      throw new Error();
    }
  } catch {
    context.addIssue({
      code: 'custom', path: ['canonicalUrl'],
      message: 'canonicalUrl must match receipt.platform',
    });
  }
  const paths = value.files.map((file) => file.path);
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (new Set(paths).size !== paths.length) {
    context.addIssue({code: 'custom', path: ['files'], message: 'paths must be unique'});
  }
  if (paths.some((filePath, index) => filePath !== sorted[index])) {
    context.addIssue({code: 'custom', path: ['files'], message: 'files must be sorted'});
  }
  if (value.files.filter((file) => file.role === 'media').length !== 1) {
    context.addIssue({code: 'custom', path: ['files'], message: 'one media file is required'});
  }
  if (value.files.filter((file) => file.role === 'metadata').length !== 1) {
    context.addIssue({code: 'custom', path: ['files'], message: 'one metadata file is required'});
  }
  if (value.files.filter((file) => file.role === 'thumbnail').length > 1) {
    context.addIssue({code: 'custom', path: ['files'], message: 'at most one thumbnail is allowed'});
  }
});

export type DownloadArchiveFile = z.infer<typeof DownloadArchiveFileSchema>;
export type DownloadReceipt = z.infer<typeof DownloadReceiptSchema>;
```

The production schema also rejects raw URL control characters, credentials, non-canonical URL spellings, `receipt.json` as a recorded file, path separators, control characters, `.`/`..`, and unsafe video IDs. These rules bind metadata to exact `video.info.json`, media to one `video.<alphanumeric-extension>`, subtitles and thumbnails to the stable patterns above, and receipt canonical platform to `receipt.platform`.

- [ ] **Step 4: Verify Task 2**

Run:

```bash
pnpm exec vitest run tests/unit/download/receipt-schema.test.ts
pnpm typecheck
```

Expected: both commands PASS.

## Task 3: Add the Controlled `yt-dlp` Adapter

**Files:**
- Create: `src/download/yt-dlp.ts`
- Test: `tests/unit/download/yt-dlp.test.ts`

- [ ] **Step 1: Write failing argument and parsing tests**

Create `tests/unit/download/yt-dlp.test.ts` and assert:

```ts
import {describe, expect, it, vi} from 'vitest';
import type {ProcessResult} from '../../../src/process/run-process';
import {createYtDlpClient} from '../../../src/download/yt-dlp';

const result = (stdout = ''): ProcessResult => ({
  command: 'tool', args: [], exitCode: 0, signal: null,
  stdout, stderr: '', durationMs: 1,
});

describe('yt-dlp client', () => {
  it('checks versions and parses a single video', async () => {
    const runProcess = vi.fn()
      .mockResolvedValueOnce(result('2026.07.04\n'))
      .mockResolvedValueOnce(result('ffmpeg version test\n'))
      .mockResolvedValueOnce(result(JSON.stringify({
        id: 'abc', title: 'Example', webpage_url: 'https://youtu.be/abc',
        extractor: 'youtube', _type: 'video', is_live: false, live_status: 'was_live',
      })));
    const client = createYtDlpClient({runProcess});
    await expect(client.checkTools()).resolves.toEqual({
      ytDlpVersion: '2026.07.04', ffmpegVersion: 'ffmpeg version test',
    });
    await expect(client.probe('https://youtu.be/abc')).resolves.toMatchObject({id: 'abc'});
    expect(runProcess.mock.calls[2]?.[1]).toEqual([
      '--ignore-config', '--proxy', '', '--no-geo-bypass',
      '--no-playlist', '--max-downloads', '1',
      '--skip-download', '--dump-single-json', 'https://youtu.be/abc',
    ]);
  });

  it('uses isolated download flags', async () => {
    const runProcess = vi.fn(async () => result());
    const client = createYtDlpClient({runProcess});
    await client.download('https://youtu.be/abc', 45);
    const [command, args, options] = runProcess.mock.calls[0] ?? [];
    expect(command).toBe('/usr/bin/osascript');
    expect(args?.slice(0, 3)).toEqual(['-l', 'JavaScript', '-e']);
    expect(args?.[3]).toContain('fchdir(3)');
    expect(args?.[3]).toContain('NSTask');
    expect(args?.slice(4, 6)).toEqual(['--', 'yt-dlp']);
    const ytDlpArgs = args?.slice(6) ?? [];
    expect(ytDlpArgs.slice(0, 7)).toEqual([
      '--ignore-config', '--proxy', '', '--no-geo-bypass',
      '--no-playlist', '--max-downloads', '1',
    ]);
    expect(ytDlpArgs).toEqual(expect.arrayContaining([
      '--write-info-json', '--clean-info-json', '--write-thumbnail',
      '--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,en.*',
    ]));
    expect(ytDlpArgs[ytDlpArgs.indexOf('--output') + 1]).toBe('video.%(ext)s');
    expect(ytDlpArgs.at(-1)).toBe('https://youtu.be/abc');
    expect(options).toEqual({extraStdioFds: [45]});
    expect(ytDlpArgs.join(' ')).not.toMatch(
      /cookie|username|password|netrc|recode|remux/iu,
    );
  });
});
```

Add table-driven metadata cases for explicit non-video `_type`, `is_live: true`, and `live_status` values `is_live`, `is_upcoming`, and `post_live`; each must fail through the shared validator and probe mapping. Add a positive `was_live` completed-replay case. Add one signal test proving the same `AbortSignal` reaches both tool checks, probe, and the FD-bound download call.

- [ ] **Step 2: Run the focused failure**

Run:

```bash
pnpm exec vitest run tests/unit/download/yt-dlp.test.ts
```

Expected: FAIL because the adapter is missing.

- [ ] **Step 3: Implement the adapter contract**

Create `src/download/yt-dlp.ts` with these public types:

```ts
import {z} from 'zod';
import {runProcess as runSystemProcess, type ProcessResult, type RunProcessOptions} from '../process/run-process';
import {DownloadError} from './errors';

export type DownloadProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<ProcessResult>;

const ParseableUrlSchema = z.string().superRefine((value, context) => {
  try {
    new URL(value);
  } catch {
    context.addIssue({code: 'custom', message: 'must be a parseable URL'});
  }
});

export const YtDlpInfoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  webpage_url: ParseableUrlSchema,
  extractor: z.string().min(1),
  extractor_key: z.string().min(1).optional(),
  _type: z.string().optional(),
  is_live: z.boolean().nullable().optional(),
  live_status: z.string().nullable().optional(),
}).passthrough();

export interface YtDlpProbe {
  id: string;
  title: string;
  canonicalUrl: string;
  extractor: string;
  extractorKey?: string;
}

export interface DownloadToolVersions {
  ytDlpVersion: string;
  ffmpegVersion: string;
}

export interface YtDlpClient {
  checkTools(signal?: AbortSignal): Promise<DownloadToolVersions>;
  probe(url: string, signal?: AbortSignal): Promise<YtDlpProbe>;
  download(
    url: string,
    stagingDirectoryFd: number,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface YtDlpClientOptions {
  runProcess?: DownloadProcessRunner;
  ytDlpExecutable?: string;
  ffmpegExecutable?: string;
}
```

Export `parseYtDlpInfo(value)` and use it for probe results and later archive metadata checks. It parses `YtDlpInfoSchema`, rejects any explicit `_type` other than `video`, rejects `is_live: true` and active statuses `is_live`, `is_upcoming`, and `post_live`, accepts `was_live`, and returns only ID, title, canonical URL, extractor, and optional extractor key.

Implement `createYtDlpClient(options)` so it:

1. Runs `yt-dlp --version` and `ffmpeg -version` with the optional operation signal; empty output or process failure becomes `DOWNLOAD_TOOL_MISSING`.
2. Probes with exactly:

```ts
[
  '--ignore-config', '--proxy', '', '--no-geo-bypass',
  '--no-playlist', '--max-downloads', '1',
  '--skip-download', '--dump-single-json', url,
]
```

3. Parses probe JSON through shared `parseYtDlpInfo`, rejects active/upcoming/post-live-in-progress and collection metadata, permits completed `was_live` replays, and maps parse/process failures to `DOWNLOAD_PROBE_FAILED`.
4. Downloads through `/usr/bin/osascript -l JavaScript -e <fixed-wrapper> -- yt-dlp ...`. The fixed Darwin JXA wrapper binds `fchdir`, requires `fchdir(3)` to succeed, and uses `NSTask` argument arrays to execute `/usr/bin/env -- <yt-dlp executable> ...` without a shell.
5. Passes the validated staging directory FD through `extraStdioFds: [stagingDirectoryFd]` and uses exactly these fixed `yt-dlp` flags before the URL:

```ts
[
  '--ignore-config', '--proxy', '', '--no-geo-bypass',
  '--no-playlist', '--max-downloads', '1', '--no-progress',
  '--write-info-json', '--clean-info-json', '--write-thumbnail',
  '--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,en.*',
  '--output', 'video.%(ext)s',
]
```

6. Keeps `--proxy` and `''` as separate argv elements so the empty value explicitly disables ambient or user-configured proxy inheritance, and keeps `--no-geo-bypass` to disable `yt-dlp`'s default geographic/X-Forwarded-For bypass behavior. These mandatory disabling flags do not enable circumvention; no user-supplied proxy value or positive geo-bypass/bypass option is accepted.
7. Adds `--ffmpeg-location <configured path>` only when `ffmpegExecutable` was explicitly provided.
8. Passes the same optional signal to probe and download, alongside the borrowed staging FD for download.
9. Maps download process failures to `DOWNLOAD_PROCESS_FAILED` without exposing child stderr.

- [ ] **Step 4: Verify Task 3**

Run:

```bash
pnpm exec vitest run tests/unit/download/yt-dlp.test.ts
pnpm typecheck
```

Expected: both commands PASS.

## Task 4: Build the Atomic Archive Store

**Files:**
- Create: `src/download/archive.ts`
- Test: `tests/unit/download/archive.test.ts`

- [ ] **Step 1: Write failing archive tests**

Create tests that use `mkdtemp` and verify:

```ts
it('publishes one media file plus metadata and subtitles', async () => {
  const root = await validateArchiveRoot(workspaceRoot, 'downloads');
  const prepared = await prepareArchive(root, 'youtube', 'abc');
  if (prepared.status !== 'staging') throw new Error('expected staging');
  await writeFile(path.join(prepared.stagingDirectory, 'video.webm'), 'media');
  await writeFile(path.join(prepared.stagingDirectory, 'video.info.json'), JSON.stringify({
    id: 'abc', title: 'Example', webpage_url: 'https://youtu.be/abc',
    extractor: 'youtube', _type: 'video', is_live: false, live_status: 'was_live',
  }));
  await writeFile(path.join(prepared.stagingDirectory, 'video.en.vtt'), 'WEBVTT');
  const result = await finalizeArchive(prepared, {
    platform: 'youtube', videoId: 'abc', title: 'Example',
    canonicalUrl: 'https://youtu.be/abc',
    downloadedAt: new Date('2026-08-12T00:00:00.000Z'),
    tools: {ytDlpVersion: 'test', ffmpegVersion: 'test'},
  });
  expect(result.status).toBe('downloaded');
});
```

Add independent cases that reject a symlinked output root, reject `.part` files, reject multiple primary media files or thumbnails, enforce exact `video.info.json`/media/subtitle/thumbnail role patterns, and cross-bind metadata ID, extractor/platform, and normalized canonical URL during finalization. Existing-archive cases must rehash every exact recorded file, parse and validate full `video.info.json`, reject forged metadata or canonical mismatches unchanged, and project oversized metadata to bounded semantic worker output. Add preparation-failure cases proving marker-backed non-recursive cleanup preserves empty or non-empty foreign replacements.

- [ ] **Step 2: Run the focused failure**

Run:

```bash
pnpm exec vitest run tests/unit/download/archive.test.ts
```

Expected: FAIL because the archive module is missing.

- [ ] **Step 3: Implement archive types and root validation**

Create `src/download/archive.ts` with these exports:

```ts
export interface ValidatedArchiveRoot {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
}

export interface StagedArchive {
  status: 'staging';
  root: ValidatedArchiveRoot;
  platform: DownloadPlatform;
  videoId: string;
  stagingDirectory: string;
  finalDirectory: string;
  relativeDirectory: string;
}

export interface StagingDownloadAuthority {
  readonly fd: number;
  close(): Promise<void>;
}

export interface ExistingArchive {
  status: 'already-present';
  platform: DownloadPlatform;
  videoId: string;
  directory: string;
  mediaPath: string;
  receiptPath: string;
  receipt: DownloadReceipt;
}

export type ArchivePreparation = StagedArchive | ExistingArchive;

export interface FinalizeArchiveInput {
  platform: DownloadPlatform;
  videoId: string;
  title: string;
  canonicalUrl: string;
  downloadedAt: Date;
  tools: DownloadToolVersions;
}

export interface DownloadedArchive {
  status: 'downloaded';
  platform: DownloadPlatform;
  videoId: string;
  directory: string;
  mediaPath: string;
  receiptPath: string;
  receipt: DownloadReceipt;
}
```

Implement `validateArchiveRoot(workspaceRoot, outputRoot)` with these exact rules:

- reject empty, absolute, Windows-drive, backslash, NUL, `.`, and `..` segments;
- traverse each segment with `lstat`;
- create missing segments one at a time with `mkdir`;
- reject symbolic links and non-directories;
- return the absolute root and normalized forward-slash relative root.

- [ ] **Step 4: Implement staging and duplicate verification**

Implement `prepareArchive(root, platform, videoId)` so it:

- accepts only `/^[A-Za-z0-9._-]+$/u` identifiers;
- creates `<root>/<platform>/` and `<root>/.staging/` through the same safe-directory helper;
- returns a `mkdtemp(<root>/.staging/download-)` staging directory when the final directory does not exist, writes a unique ownership marker immediately, records directory identities, then removes the marker only after ownership capture succeeds;
- if preparation fails after `mkdtemp`, invokes marker-backed helper cleanup that discovers exactly one marker-matching empty `download-*` directory, quarantines it with a no-replace rename, unlinks only the marker, and removes the empty directory non-recursively; a replaced, non-empty, or foreign directory is never deleted;
- when the final directory exists, opens identity-validated directory authorities and runs an existing-archive worker that parses exact `receipt.json`, verifies the exact entry set, hashes every file from its recorded full byte count, and parses the full exact `video.info.json` bytes;
- parses the worker receipt with `DownloadReceiptSchema`, requires requested platform/ID to match, validates projected metadata with `parseYtDlpInfo`, binds metadata ID to receipt ID, extractor to receipt platform, and normalized metadata canonical URL to normalized receipt canonical URL and platform, then returns `already-present`;
- maps invalid existing archives to `DOWNLOAD_DESTINATION_CONFLICT` without modifying them.

Workers must consume complete bytes without returning large metadata over the capped process channel:

```ts
const readBuffer = Buffer.allocUnsafe(64 * 1024);
const stats = fstatSync(descriptor);
const hash = createHash('sha256');
const metadataChunks = name === 'video.info.json' ? [] : null;
let remainingBytes = stats.size;
while (remainingBytes > 0) {
  const bytesRead = readSync(
    descriptor,
    readBuffer,
    0,
    Math.min(readBuffer.length, remainingBytes),
    null,
  );
  if (bytesRead === 0) throw new Error();
  const chunk = Buffer.from(readBuffer.subarray(0, bytesRead));
  hash.update(chunk);
  metadataChunks?.push(chunk);
  remainingBytes -= bytesRead;
}
const file = {
  name,
  bytes: stats.size,
  sha256: `sha256:${hash.digest('hex')}`,
};
if (metadataChunks !== null) {
  const parsed = JSON.parse(Buffer.concat(metadataChunks).toString('utf8'));
  metadata = {
    id: parsed.id,
    title: parsed.title,
    webpage_url: parsed.webpage_url,
    extractor: parsed.extractor,
    extractor_key: parsed.extractor_key,
    _type: parsed._type,
    is_live: parsed.is_live,
    live_status: parsed.live_status,
  };
}
```

The worker hashes and parses the entire metadata file but emits only file facts and the required semantic metadata projection.

- [ ] **Step 5: Implement FD authority, finalization, and cleanup**

Implement `openStagingDownloadAuthority(prepared)` so it revalidates the owned staging identity, opens the directory with no-follow directory flags, returns its FD, and exposes an idempotent async `close()`.

Implement `finalizeArchive(prepared, input)` so it:

- opens fresh root/platform/staging authorities and runs inspection, sealing, and publication helpers through borrowed FDs rather than trusting path-only writes;
- rejects directories, symlinks, `.part`, `.tmp`, and `.ytdl` entries;
- binds metadata to exact `video.info.json`;
- classifies one media file only as `video.<alphanumeric-extension>` after excluding controlled sidecar extensions;
- classifies subtitles only as `video.<segment>[.<segment>...].<ass|json3|lrc|srt|srv1|srv2|srv3|ttml|vtt>` with alphanumeric, `_`, or `-` segments;
- classifies at most one thumbnail as `video.<avif|jpeg|jpg|png|webp>`;
- validates projected `video.info.json` through shared `parseYtDlpInfo`, then binds metadata ID, extractor/platform, and normalized canonical URL to `FinalizeArchiveInput`;
- sorts files by name, records full-byte size and SHA-256, and validates the receipt with `DownloadReceiptSchema`, including canonical URL platform and role/path binding;
- seals `receipt.json` atomically, re-verifies exact file bytes, and atomically publishes staging to `<root>/<platform>/<videoId>` without replacement;
- maps content validation to `DOWNLOAD_ARCHIVE_INVALID` and authority/publication failures to `DOWNLOAD_FINALIZE_FAILED`.

Implement `cleanupArchive(prepared)` through identity-validated authorities and controlled quarantine names. Recursive removal may target only the captured owned staging identity or its publication quarantine; it must not follow a replaced pathname or delete an existing final archive.

- [ ] **Step 6: Verify Task 4**

Run:

```bash
pnpm exec vitest run tests/unit/download/archive.test.ts
pnpm typecheck
```

Expected: both commands PASS.

## Task 5: Orchestrate the Use Case

**Files:**
- Create: `src/download/downloader.ts`
- Test: `tests/unit/download/downloader.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Test these exact sequences with injected spies:

1. `rightsConfirmed: false` throws `DOWNLOAD_RIGHTS_NOT_CONFIRMED` before root validation, tool checks, or probe.
2. A verified `already-present` preparation returns without calling `client.download`.
3. A staged download calls `checkTools → probe → prepare → openStagingDownloadAuthority → download(fd) → close authority → finalize`.
4. One input `AbortSignal` is forwarded to tool checks, probe, and FD-bound download.
5. Download failure or cancellation waits for authority close and asynchronous cleanup before rethrowing the original typed error; finalize or authority-acquisition failures also clean once.
6. A canonical URL or extractor platform mismatch throws `DOWNLOAD_EXTRACTOR_MISMATCH` before staging.

- [ ] **Step 2: Run the focused failure**

Run:

```bash
pnpm exec vitest run tests/unit/download/downloader.test.ts
```

Expected: FAIL because the orchestrator is missing.

- [ ] **Step 3: Implement the orchestrator contract**

Create `src/download/downloader.ts` with:

```ts
export interface DownloadInput {
  workspaceRoot: string;
  url: string;
  outputRoot: string;
  rightsConfirmed: boolean;
  signal?: AbortSignal;
}

export type DownloadResult = DownloadedArchive | ExistingArchive;

export interface DownloadArchiveDependencies {
  validateRoot(workspaceRoot: string, outputRoot: string): Promise<ValidatedArchiveRoot>;
  prepare(root: ValidatedArchiveRoot, platform: DownloadPlatform, videoId: string): Promise<ArchivePreparation>;
  openStagingDownloadAuthority(prepared: StagedArchive): Promise<StagingDownloadAuthority>;
  finalize(prepared: StagedArchive, input: FinalizeArchiveInput): Promise<DownloadedArchive>;
  cleanup(prepared: StagedArchive): Promise<void>;
}

export interface DownloadDependencies {
  client: YtDlpClient;
  archive: DownloadArchiveDependencies;
  now(): Date;
}
```

Implement `downloadVideo(input, dependencies)` in this order:

```ts
if (!input.rightsConfirmed) {
  throw new DownloadError(
    'DOWNLOAD_RIGHTS_NOT_CONFIRMED',
    'Confirm that you are permitted to save this public video.',
  );
}
const requested = parseDownloadUrl(input.url);
const root = await dependencies.archive.validateRoot(input.workspaceRoot, input.outputRoot);
const tools = input.signal === undefined
  ? await dependencies.client.checkTools()
  : await dependencies.client.checkTools(input.signal);
const probe = input.signal === undefined
  ? await dependencies.client.probe(requested.url)
  : await dependencies.client.probe(requested.url, input.signal);
assertExtractorMatches(requested.platform, probe.extractor);
let canonical: ReturnType<typeof parseDownloadUrl>;
try {
  canonical = parseDownloadUrl(probe.canonicalUrl);
} catch {
  throw new DownloadError(
    'DOWNLOAD_EXTRACTOR_MISMATCH',
    'The resolved video platform did not match the requested platform.',
  );
}
if (canonical.platform !== requested.platform) {
  throw new DownloadError(
    'DOWNLOAD_EXTRACTOR_MISMATCH',
    'The resolved video platform did not match the requested platform.',
  );
}
const prepared = await dependencies.archive.prepare(root, requested.platform, probe.id);
if (prepared.status === 'already-present') return prepared;
try {
  const authority = await dependencies.archive.openStagingDownloadAuthority(prepared);
  let downloadFailure: unknown;
  try {
    if (input.signal === undefined) {
      await dependencies.client.download(requested.url, authority.fd);
    } else {
      await dependencies.client.download(requested.url, authority.fd, input.signal);
    }
  } catch (error) {
    downloadFailure = error;
  }
  try {
    await authority.close();
  } catch (error) {
    if (downloadFailure === undefined) throw error;
  }
  if (downloadFailure !== undefined) throw downloadFailure;
  return await dependencies.archive.finalize(prepared, {
    platform: requested.platform,
    videoId: probe.id,
    title: probe.title,
    canonicalUrl: canonical.url,
    downloadedAt: dependencies.now(),
    tools,
  });
} catch (error) {
  await dependencies.archive.cleanup(prepared).catch(() => undefined);
  throw error;
}
```

Export `createSystemDownloadDependencies(options)` that snapshots the controlled client options, creates the `yt-dlp` client, binds root validation, preparation, `openStagingDownloadAuthority`, finalization, and cleanup, and uses `new Date()`.

- [ ] **Step 4: Verify Task 5**

Run:

```bash
pnpm exec vitest run tests/unit/download/downloader.test.ts
pnpm typecheck
```

Expected: both commands PASS.

## Task 6: Add the CLI Command

**Files:**
- Create: `src/cli/download-output.ts`
- Create: `src/cli/commands/download.ts`
- Modify: `src/cli/exit-codes.ts:1`
- Modify: `src/cli/videoctl.ts:33`
- Modify: `src/cli/videoctl.ts:480`
- Modify: `src/cli/videoctl.ts:583`
- Modify: `tests/unit/cli/doctor.test.ts:82`
- Modify: `tests/unit/cli/review.test.ts:79`
- Test: `tests/unit/cli/download.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create tests that inject `VideoctlDependencies.download` and verify:

```ts
const exitCode = await runVideoctl([
  'download', 'https://youtu.be/abc', '--rights-confirmed',
], dependencies);
expect(exitCode).toBe(EXIT_CODES.success);
expect(stdout()).toContain('Download complete: youtube/abc');
```

Add JSON failure coverage where the injected dependency throws `DOWNLOAD_PROBE_FAILED`; assert exit code `5`, exactly one JSON document, and no raw URL or `token=secret` in stdout/stderr. Add a dependency-signal case proving `runDownloadCommand` copies `downloadSignal` to `DownloadInput.signal` without creating a second controller.

- [ ] **Step 2: Run the focused failure**

Run:

```bash
pnpm exec vitest run tests/unit/cli/download.test.ts
```

Expected: FAIL because the command and operation exit code are missing.

- [ ] **Step 3: Add stable output and exit mapping**

Add `operationFailed: 5` to `src/cli/exit-codes.ts` without changing existing values.

Create `src/cli/download-output.ts` with:

```ts
export const formatDownloadSuccess = (result: DownloadResult, json: boolean): string => {
  const report = {
    command: 'download', ok: true, status: result.status,
    platform: result.platform, videoId: result.videoId,
    directory: result.directory, media: result.mediaPath, receipt: result.receiptPath,
  } as const;
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const label = result.status === 'downloaded' ? 'Download complete' : 'Already downloaded';
  return [
    `${label}: ${result.platform}/${result.videoId}`,
    `Media: ${result.mediaPath}`,
    `Receipt: ${result.receiptPath}`,
    '',
  ].join('\n');
};

export const formatDownloadFailure = (
  code: DownloadErrorCode,
  message: string,
  json: boolean,
): string => json
  ? `${JSON.stringify({command: 'download', ok: false, code, message}, null, 2)}\n`
  : `Download failed [${code}]: ${message}\n`;
```

Create `src/cli/commands/download.ts`. Map rights/URL/host/output errors to `3`, tool errors to `4`, all other typed or unexpected operation errors to `5`, never include the input URL in output, and forward optional `dependencies.downloadSignal` as `DownloadInput.signal`.

- [ ] **Step 4: Register and wire `videoctl download`**

Add `download(input: DownloadInput): Promise<DownloadResult>` and optional `downloadSignal?: AbortSignal` to `VideoctlDependencies`, then add this Commander registration:

```ts
command
  .command('download')
  .description('Archive one authorized public video without editing it')
  .argument('<url>')
  .option('--rights-confirmed', 'confirm permission to save this public video')
  .option('--output <directory>', 'workspace-relative archive directory', 'downloads')
  .option('--json', 'print machine-readable JSON')
  .action(async (url: string, options: DownloadCommandOptions) => {
    exitCode = await runDownloadCommand(url, options, dependencies);
  });
```

In `createSystemVideoctlDependencies`, construct system download dependencies with optional `YT_DLP_PATH` and existing `FFMPEG_PATH`, then expose:

```ts
download: async (input) => await downloadVideo(input, downloadDependencies),
```

Accept optional `SystemVideoctlOptions.signal` and expose it as `downloadSignal`. For direct `videoctl download` execution, wrap the entire awaited CLI operation:

```ts
export const runWithDownloadSignalHandlers = async <Result>(
  signalHost: DownloadSignalHost,
  operation: (signal: AbortSignal) => Promise<Result>,
): Promise<Result> => {
  const controller = new AbortController();
  const cancel = (): void => {
    if (controller.signal.aborted) return;
    controller.abort(new Error('The download operation was cancelled.'));
  };
  signalHost.on('SIGINT', cancel);
  signalHost.on('SIGTERM', cancel);
  try {
    return await operation(controller.signal);
  } finally {
    signalHost.removeListener('SIGINT', cancel);
    signalHost.removeListener('SIGTERM', cancel);
  }
};
```

Keep both handlers installed until the operation settles after detached process-group termination, staging-authority close, and staging cleanup. The aborted guard idempotently swallows repeated `SIGINT`/`SIGTERM` during cleanup instead of allowing default signal termination to interrupt it.

Add an unused `download` mock to the existing doctor and review fixtures so their dependency objects remain complete.

- [ ] **Step 5: Verify Task 6**

Run:

```bash
pnpm exec vitest run \
  tests/unit/cli/download.test.ts \
  tests/unit/cli/doctor.test.ts \
  tests/unit/cli/review.test.ts
pnpm typecheck
```

Expected: all commands PASS.

## Task 7: Verify the System Boundary and Document Usage

**Files:**
- Create: `tests/integration/download/system-download.test.ts`
- Create: `tests/integration/download/cli-cancellation.test.ts`
- Modify: `.gitignore:1`
- Modify: `README.md:1`

- [ ] **Step 1: Add a no-network fake-tool integration test**

Create executable temporary shell fixtures in the test:

- fake `yt-dlp --version` prints `2026.07.04-test`;
- fake probe prints one `_type: video`, non-live JSON object with ID `abc`, canonical YouTube URL, and extractor `youtube`;
- fake download requires the argument after `--output` to equal relative `video.%(ext)s` and writes `video.webm`, `video.info.json`, `video.en.vtt`, and `video.webp` into its current directory after the JXA wrapper has called `fchdir(3)`;
- fake FFmpeg prints `ffmpeg version test`.

Call `downloadVideo` through `createSystemDownloadDependencies({ytDlpExecutable, ffmpegExecutable})`. Assert the final result is `downloaded`, `receipt.json` parses, metadata and receipt identities cross-bind, all five files exist under `downloads/youtube/abc/`, staging is empty, and the test never opens a network socket.

Add a Darwin direct-CLI cancellation integration that starts a fake `yt-dlp` parent plus descendant, waits for a staged partial file, sends `SIGINT`, then sends `SIGTERM` while cleanup is still in progress. Assert the CLI exits with operation failure rather than a signal, both descendants are gone, the staging root is empty, no final archive exists, and no writes continue after exit.

- [ ] **Step 2: Run the integration test**

Run:

```bash
pnpm exec vitest run \
  tests/integration/download/system-download.test.ts \
  tests/integration/download/cli-cancellation.test.ts
```

Expected: PASS using only temporary local executables and files; the Darwin cancellation test may be platform-gated where the JXA/FD contract is unavailable.

- [ ] **Step 3: Add operator documentation**

Append `downloads/` to `.gitignore`.

Replace the placeholder `README.md` with requirements and these commands:

```bash
brew install ffmpeg yt-dlp
pnpm install
pnpm video download "<authorized-public-video-url>" --rights-confirmed
pnpm video download "<authorized-public-video-url>" --rights-confirmed --json
```

Document the five initial platform families, archive path `downloads/<platform>/<video-id>/`, saved sidecars, and explicit exclusions: cookies, credentials, user-supplied proxies, playlists/channels/feeds/batches, paid/private content, active/upcoming/post-live-in-progress streams, DRM, positive region/geo-bypass options, transcoding, editing, and publishing. State that completed public `was_live` replays are treated as ordinary videos. Also document that internal probe and download `yt-dlp` calls always pass `--proxy ''` and `--no-geo-bypass` as mandatory disabling controls, not circumvention features.

- [ ] **Step 4: Verify CLI help and the full repository**

Run:

```bash
pnpm video download --help
pnpm typecheck
pnpm test
git diff --check
```

Expected: help lists `<url>`, `--rights-confirmed`, `--output`, and `--json`; all verification commands exit `0`.

- [ ] **Step 5: Optional authorized smoke test**

Only after automated verification, use a small public video owned by the operator or explicitly authorized for local saving:

```bash
pnpm video download "<authorized-public-video-url>" --rights-confirmed --json
```

Expected: status is `downloaded` or `already-present`, files are under `downloads/<platform>/<video-id>/`, and no project assets, run directories, Remotion outputs, or publishing receipts change. Do not add the URL or downloaded files to Git.
