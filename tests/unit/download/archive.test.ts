import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {renameSync, symlinkSync} from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  cleanupArchive,
  finalizeArchive,
  openStagingDownloadAuthority,
  prepareArchive,
  validateArchiveRoot,
  type DownloadedArchive,
  type FinalizeArchiveInput,
  type StagedArchive,
  type ValidatedArchiveRoot,
} from '../../../src/download/archive';
import {
  DownloadError,
  type DownloadErrorCode,
  isDownloadError,
} from '../../../src/download/errors';
import {
  DownloadReceiptSchema,
  type DownloadReceipt,
} from '../../../src/download/receipt-schema';
import type {DownloadPlatform} from '../../../src/download/platforms';
import {
  PROCESS_OUTPUT_LIMIT_BYTES,
  runProcess,
} from '../../../src/process/run-process';

const OUTPUT_INVALID_MESSAGE = 'The download output path is invalid.';
const ARCHIVE_INVALID_MESSAGE = 'The downloaded archive contents are invalid.';
const DESTINATION_CONFLICT_MESSAGE =
  'The download destination conflicts with an existing archive.';
const FINALIZE_FAILED_MESSAGE = 'The download archive could not be finalized.';
const DOUYIN_VIDEO_ID = '7654841525762919726';
const MANAGED_ASSET_SHA256 = `sha256:${'c'.repeat(64)}` as const;

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

const clearImmutableFlags = async (target: string): Promise<void> => {
  await execFileAsync('/usr/bin/chflags', ['-R', 'nouchg', target])
    .catch(() => {});
};

const makeTreeWritable = async (target: string): Promise<void> => {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return;
    if (!stats.isDirectory()) {
      await chmod(target, 0o600);
      return;
    }
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) {
      await makeTreeWritable(path.join(target, entry));
    }
  } catch {
    return;
  }
};

const makeTreeMutable = async (target: string): Promise<void> => {
  await clearImmutableFlags(target);
  await makeTreeWritable(target);
};

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map(async (directory) => {
    await makeTreeMutable(directory);
    await rm(directory, {recursive: true, force: true});
  }));
});

const createWorkspace = async (): Promise<string> => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'download-archive-test-'));
  temporaryDirectories.push(workspace);
  return workspace;
};

const expectDownloadError = async (
  operation: Promise<unknown>,
  code: DownloadErrorCode,
  message: string,
): Promise<DownloadError> => {
  try {
    await operation;
  } catch (error) {
    expect(isDownloadError(error)).toBe(true);
    if (!isDownloadError(error)) throw error;
    expect(error).toMatchObject({code, message, name: 'DownloadError'});
    expect(error.cause).toBeUndefined();
    return error;
  }
  throw new Error(`Expected ${code}.`);
};

const expectMissing = async (target: string): Promise<void> => {
  await expect(access(target)).rejects.toMatchObject({code: 'ENOENT'});
};

const sortNames = (names: readonly string[]): string[] =>
  [...names].sort((left, right) => left.localeCompare(right));

const archiveHelperOperation = (args: readonly string[]): string | undefined => {
  const separatorIndex = args.indexOf('--');
  return separatorIndex === -1 ? undefined : args[separatorIndex + 1];
};

const sha256 = (contents: Buffer): string =>
  `sha256:${createHash('sha256').update(contents).digest('hex')}`;

const prepareStaging = async (
  workspaceRoot: string,
  outputRoot = 'downloads',
  videoId = 'abc',
  platform: DownloadPlatform = 'youtube',
): Promise<{root: ValidatedArchiveRoot; prepared: StagedArchive}> => {
  const root = await validateArchiveRoot(workspaceRoot, outputRoot);
  const prepared = await prepareArchive(
    root,
    platform,
    videoId,
    canonicalUrlFor(platform, videoId),
  );
  if (prepared.status !== 'staging') throw new Error('Expected staging archive.');
  return {root, prepared};
};

const canonicalUrlFor = (
  platform: DownloadPlatform,
  videoId: string,
): string => platform === 'douyin'
  ? `https://www.douyin.com/video/${videoId}`
  : `https://youtu.be/${videoId}`;

const extractorFor = (platform: DownloadPlatform): string =>
  platform === 'douyin' ? 'Douyin' : 'youtube';

const safeMetadataFor = (prepared: StagedArchive) => ({
  id: prepared.videoId,
  title: 'Example',
  webpage_url: canonicalUrlFor(prepared.platform, prepared.videoId),
  extractor: extractorFor(prepared.platform),
  _type: 'video' as const,
});

interface StagedFilesOptions {
  videoId?: string;
  extractor?: string;
  mediaName?: string;
  thumbnailName?: string;
  subtitleNames?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

const writeStagedFiles = async (
  prepared: StagedArchive,
  options: StagedFilesOptions = {},
): Promise<void> => {
  const videoId = options.videoId ?? prepared.videoId;
  const extractor = options.extractor ?? extractorFor(prepared.platform);
  const mediaName = options.mediaName ?? 'video.webm';

  if (options.thumbnailName !== undefined) {
    await writeFile(
      path.join(prepared.stagingDirectory, options.thumbnailName),
      'thumbnail',
    );
  }
  for (const subtitleName of options.subtitleNames ?? []) {
    await writeFile(
      path.join(prepared.stagingDirectory, subtitleName),
      `subtitle:${subtitleName}`,
    );
  }
  await writeFile(path.join(prepared.stagingDirectory, mediaName), 'media');
  await writeFile(
    path.join(prepared.stagingDirectory, 'video.info.json'),
    JSON.stringify({
      id: videoId,
      title: 'Example',
      webpage_url: canonicalUrlFor(prepared.platform, videoId),
      extractor,
      _type: 'video',
      ...options.metadata,
    }),
  );
};

const finalizeInput = (
  prepared: StagedArchive,
  overrides: Partial<FinalizeArchiveInput> = {},
): FinalizeArchiveInput => ({
  platform: prepared.platform,
  videoId: prepared.videoId,
  title: 'Example',
  canonicalUrl: canonicalUrlFor(prepared.platform, prepared.videoId),
  downloadedAt: new Date('2026-08-12T00:00:00.000Z'),
  tools: {
    ytDlpVersion: '2026.07.04',
    ffmpegVersion: 'ffmpeg version test',
  },
  browserCookies: {used: false},
  network: {proxyUsed: false, browserImpersonation: false},
  toolchain: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    managedAssetSha256: MANAGED_ASSET_SHA256,
  },
  ...overrides,
});

const finalize = (
  prepared: StagedArchive,
  overrides: Partial<FinalizeArchiveInput> = {},
): Promise<DownloadedArchive> =>
  finalizeArchive(prepared, finalizeInput(prepared, overrides));

interface PublishedArchive {
  workspaceRoot: string;
  root: ValidatedArchiveRoot;
  result: DownloadedArchive;
  finalDirectory: string;
}

const publishArchive = async (): Promise<PublishedArchive> => {
  const workspaceRoot = await createWorkspace();
  const {root, prepared} = await prepareStaging(workspaceRoot);
  await writeStagedFiles(prepared, {
    thumbnailName: 'video.webp',
    subtitleNames: ['video.en.vtt'],
  });
  const result = await finalize(prepared);
  return {
    workspaceRoot,
    root,
    result,
    finalDirectory: path.join(root.absolutePath, 'youtube', 'abc'),
  };
};

const commonReceiptFields = (receipt: DownloadReceipt) => ({
  status: receipt.status,
  platform: receipt.platform,
  videoId: receipt.videoId,
  title: receipt.title,
  canonicalUrl: receipt.canonicalUrl,
  downloadedAt: receipt.downloadedAt,
  purpose: receipt.purpose,
  rightsConfirmed: receipt.rightsConfirmed,
  transcoded: receipt.transcoded,
  tools: receipt.tools,
  files: receipt.files,
});

const legacyV1Receipt = (receipt: DownloadReceipt): DownloadReceipt =>
  DownloadReceiptSchema.parse({
    version: 1,
    ...commonReceiptFields(receipt),
  });

const legacyV2Receipt = (receipt: DownloadReceipt): DownloadReceipt => {
  if (receipt.platform !== 'douyin') {
    throw new Error('Expected a Douyin receipt.');
  }
  return DownloadReceiptSchema.parse({
    version: 2,
    ...commonReceiptFields(receipt),
    platform: 'douyin',
    browserCookies: {used: true, source: 'chrome'},
  });
};

const rewritePublishedMetadata = async (
  published: PublishedArchive,
  replacement: string | Readonly<Record<string, unknown>>,
  baseReceipt: DownloadReceipt = published.result.receipt,
): Promise<{metadataSource: string; receiptSource: string}> => {
  await makeTreeMutable(published.finalDirectory);
  const metadataPath = path.join(published.finalDirectory, 'video.info.json');
  const originalMetadata = JSON.parse(await readFile(metadataPath, 'utf8')) as unknown;
  if (typeof originalMetadata !== 'object' || originalMetadata === null) {
    throw new Error('Expected object metadata.');
  }
  const metadataSource = typeof replacement === 'string'
    ? replacement
    : `${JSON.stringify({...originalMetadata, ...replacement}, null, 2)}\n`;
  const metadataContents = Buffer.from(metadataSource);
  await writeFile(metadataPath, metadataContents);

  const forgedReceipt = DownloadReceiptSchema.parse({
    ...baseReceipt,
    files: baseReceipt.files.map((file) =>
      file.path === 'video.info.json'
        ? {
            ...file,
            bytes: metadataContents.byteLength,
            sha256: sha256(metadataContents),
          }
        : file),
  });
  const receiptSource = `${JSON.stringify(forgedReceipt, null, 2)}\n`;
  await writeFile(
    path.join(published.finalDirectory, 'receipt.json'),
    receiptSource,
  );
  return {metadataSource, receiptSource};
};

describe('validateArchiveRoot', () => {
  it('creates nested workspace-relative directories one segment at a time', async () => {
    const workspaceRoot = await createWorkspace();
    const canonicalWorkspaceRoot = await realpath(workspaceRoot);

    const root = await validateArchiveRoot(workspaceRoot, 'artifacts/downloads');

    expect(root).toEqual({
      workspaceRoot: canonicalWorkspaceRoot,
      absolutePath: path.join(canonicalWorkspaceRoot, 'artifacts', 'downloads'),
      relativePath: 'artifacts/downloads',
    });
    await expect(lstat(path.join(workspaceRoot, 'artifacts')))
      .resolves.toMatchObject({});
    expect((await lstat(path.join(workspaceRoot, 'artifacts'))).isDirectory())
      .toBe(true);
    expect((await lstat(root.absolutePath)).isDirectory()).toBe(true);
  });

  it.each([
    '',
    '/downloads',
    'C:/downloads',
    'file:downloads',
    'https://example.test/downloads',
    'downloads\\nested',
    'downloads\0nested',
    'downloads//nested',
    'downloads/',
    '.',
    '..',
    'downloads/./nested',
    'downloads/../nested',
  ])('rejects unsafe output root %j', async (outputRoot) => {
    const workspaceRoot = await createWorkspace();

    await expectDownloadError(
      validateArchiveRoot(workspaceRoot, outputRoot),
      'DOWNLOAD_OUTPUT_INVALID',
      OUTPUT_INVALID_MESSAGE,
    );
  });

  it('rejects relative, missing, non-directory, and symlink workspace roots', async () => {
    const workspaceRoot = await createWorkspace();
    const fileRoot = path.join(workspaceRoot, 'file-root');
    const realRoot = path.join(workspaceRoot, 'real-root');
    const linkedRoot = path.join(workspaceRoot, 'linked-root');
    await writeFile(fileRoot, 'not a directory');
    await mkdir(realRoot);
    await symlink(realRoot, linkedRoot);

    for (const candidate of [
      'relative-workspace',
      path.join(workspaceRoot, 'missing-root'),
      fileRoot,
      linkedRoot,
    ]) {
      await expectDownloadError(
        validateArchiveRoot(candidate, 'downloads'),
        'DOWNLOAD_OUTPUT_INVALID',
        OUTPUT_INVALID_MESSAGE,
      );
    }
  });

  it('rejects a symlinked output ancestor without writing through it', async () => {
    const workspaceRoot = await createWorkspace();
    const target = path.join(workspaceRoot, 'target');
    const linked = path.join(workspaceRoot, 'linked');
    await mkdir(target);
    await symlink(target, linked);

    await expectDownloadError(
      validateArchiveRoot(workspaceRoot, 'linked/downloads'),
      'DOWNLOAD_OUTPUT_INVALID',
      OUTPUT_INVALID_MESSAGE,
    );
    await expectMissing(path.join(target, 'downloads'));
  });

  it('sanitizes output validation failures', async () => {
    const workspaceRoot = await createWorkspace();
    const marker = 'sensitive-output-marker';

    const error = await expectDownloadError(
      validateArchiveRoot(workspaceRoot, `${marker}\\downloads`),
      'DOWNLOAD_OUTPUT_INVALID',
      OUTPUT_INVALID_MESSAGE,
    );

    expect(String(error)).not.toContain(marker);
  });
});

describe('prepareArchive', () => {
  it('stages new archives only below .staging/download-*', async () => {
    const workspaceRoot = await createWorkspace();
    const {root, prepared} = await prepareStaging(
      workspaceRoot,
      'artifacts/downloads',
    );

    expect(prepared).toMatchObject({
      status: 'staging',
      root,
      platform: 'youtube',
      videoId: 'abc',
      finalDirectory: path.join(root.absolutePath, 'youtube', 'abc'),
      relativeDirectory: 'artifacts/downloads/youtube/abc',
    });
    expect(path.dirname(prepared.stagingDirectory))
      .toBe(path.join(root.absolutePath, '.staging'));
    expect(path.basename(prepared.stagingDirectory)).toMatch(/^download-/u);
    expect((await lstat(prepared.stagingDirectory)).isDirectory()).toBe(true);
    expect(await readdir(prepared.stagingDirectory)).toEqual([]);
    expect((await lstat(path.join(root.absolutePath, 'youtube'))).isDirectory())
      .toBe(true);
  });

  it('removes a fresh empty staging directory after post-mkdtemp identity failure', async () => {
    const workspaceRoot = await createWorkspace();
    const root = await validateArchiveRoot(workspaceRoot, 'downloads');
    let createdDirectory: string | undefined;
    const postCreationLstatTargets: string[] = [];

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      return {
        ...actual,
        mkdtemp: async (prefix: string) => {
          createdDirectory = await actual.mkdtemp(prefix);
          return createdDirectory;
        },
        lstat: async (...args: Parameters<typeof actual.lstat>) => {
          if (createdDirectory !== undefined) {
            postCreationLstatTargets.push(String(args[0]));
            throw new Error('Injected post-mkdtemp identity failure.');
          }
          return await Reflect.apply(actual.lstat, undefined, args);
        },
      };
    });

    let failure: unknown;
    try {
      const failingArchive = await import('../../../src/download/archive');
      try {
        await failingArchive.prepareArchive(
          root,
          'youtube',
          'abc',
          canonicalUrlFor('youtube', 'abc'),
        );
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    expect(createdDirectory).toBeDefined();
    expect(postCreationLstatTargets).toEqual([createdDirectory]);
    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect(await readdir(path.join(root.absolutePath, '.staging'))).toEqual([]);
  });

  it('does not remove a non-empty replacement after staging identity failure', async () => {
    const workspaceRoot = await createWorkspace();
    const root = await validateArchiveRoot(workspaceRoot, 'downloads');
    let createdDirectory: string | undefined;
    let relocatedOwnedDirectory: string | undefined;
    let replacementSentinel: string | undefined;

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      return {
        ...actual,
        mkdtemp: async (prefix: string) => {
          createdDirectory = await actual.mkdtemp(prefix);
          return createdDirectory;
        },
        lstat: async (...args: Parameters<typeof actual.lstat>) => {
          const target = String(args[0]);
          if (createdDirectory !== undefined && target === createdDirectory) {
            relocatedOwnedDirectory = path.join(
              path.dirname(createdDirectory),
              'download-relocated-owned',
            );
            await actual.rename(createdDirectory, relocatedOwnedDirectory);
            await actual.mkdir(createdDirectory);
            replacementSentinel = path.join(createdDirectory, 'foreign.txt');
            await actual.writeFile(replacementSentinel, 'keep foreign');
            throw new Error('Injected replacement identity failure.');
          }
          return await Reflect.apply(actual.lstat, undefined, args);
        },
      };
    });

    let failure: unknown;
    try {
      const failingArchive = await import('../../../src/download/archive');
      try {
        await failingArchive.prepareArchive(
          root,
          'youtube',
          'abc',
          canonicalUrlFor('youtube', 'abc'),
        );
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect(replacementSentinel).toBeDefined();
    await expect(readFile(replacementSentinel ?? '', 'utf8'))
      .resolves.toBe('keep foreign');
    expect(relocatedOwnedDirectory).toBeDefined();
    await expectMissing(relocatedOwnedDirectory ?? '');
    expect(await readdir(path.join(root.absolutePath, '.staging'))).toEqual([
      path.basename(createdDirectory ?? ''),
    ]);
  });

  it('does not remove an empty replacement after staging identity failure', async () => {
    const workspaceRoot = await createWorkspace();
    const root = await validateArchiveRoot(workspaceRoot, 'downloads');
    let createdDirectory: string | undefined;
    let relocatedOwnedDirectory: string | undefined;

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      return {
        ...actual,
        mkdtemp: async (prefix: string) => {
          createdDirectory = await actual.mkdtemp(prefix);
          return createdDirectory;
        },
        lstat: async (...args: Parameters<typeof actual.lstat>) => {
          const target = String(args[0]);
          if (createdDirectory !== undefined && target === createdDirectory) {
            relocatedOwnedDirectory = path.join(
              path.dirname(createdDirectory),
              'download-relocated-owned',
            );
            await actual.rename(createdDirectory, relocatedOwnedDirectory);
            await actual.mkdir(createdDirectory);
            throw new Error('Injected empty replacement identity failure.');
          }
          return await Reflect.apply(actual.lstat, undefined, args);
        },
      };
    });

    let failure: unknown;
    try {
      const failingArchive = await import('../../../src/download/archive');
      try {
        await failingArchive.prepareArchive(
          root,
          'youtube',
          'abc',
          canonicalUrlFor('youtube', 'abc'),
        );
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect(createdDirectory).toBeDefined();
    expect((await lstat(createdDirectory ?? '')).isDirectory()).toBe(true);
    expect(await readdir(createdDirectory ?? '')).toEqual([]);
    expect(relocatedOwnedDirectory).toBeDefined();
    await expectMissing(relocatedOwnedDirectory ?? '');
    expect(await readdir(path.join(root.absolutePath, '.staging'))).toEqual([
      path.basename(createdDirectory ?? ''),
    ]);
  });

  it.each([
    '',
    '.',
    '..',
    'video/id',
    'video id',
    'a'.repeat(513),
  ])('rejects invalid video identifier %j before creating managed directories', async (videoId) => {
    const workspaceRoot = await createWorkspace();
    const root = await validateArchiveRoot(workspaceRoot, 'downloads');

    await expectDownloadError(
      prepareArchive(
        root,
        'youtube',
        videoId,
        canonicalUrlFor('youtube', videoId),
      ),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
    expect(await readdir(root.absolutePath)).toEqual([]);
  });
});

describe('staging download authority', () => {
  it('keeps descriptor-bound writes on the owned inode after path substitution', async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    const relocatedOwnedDirectory = path.join(
      path.dirname(prepared.stagingDirectory),
      'download-relocated-authority',
    );
    const authority = await openStagingDownloadAuthority(prepared);

    await rename(prepared.stagingDirectory, relocatedOwnedDirectory);
    await symlink(outsideRoot, prepared.stagingDirectory);
    try {
      await authority.writeMetadata(safeMetadataFor(prepared));
      await runProcess('/usr/bin/osascript', [
        '-l',
        'JavaScript',
        '-e',
        [
          'ObjC.import("Foundation");',
          'ObjC.bindFunction("fchdir", ["int", ["int"]]);',
          'function run(argv) {',
          '  if (Number($.fchdir(3)) !== 0) throw new Error();',
          '  const task = $.NSTask.alloc.init;',
          '  task.launchPath = "/usr/bin/env";',
          '  task.arguments = [',
          '    "--", argv[0], "-e",',
          '    "require(\\"node:fs\\").writeFileSync(\\"authority.txt\\", process.argv[1])",',
          '    argv[1],',
          '  ];',
          '  task.standardOutput = $.NSFileHandle.fileHandleWithNullDevice;',
          '  task.standardError = $.NSFileHandle.fileHandleWithStandardError;',
          '  task.launch;',
          '  task.waitUntilExit;',
          '  if (Number(task.terminationStatus) !== 0) throw new Error();',
          '}',
        ].join('\n'),
        '--',
        process.execPath,
        'owned inode',
      ], {extraStdioFds: [authority.fd]});

      expect(await readFile(
        path.join(relocatedOwnedDirectory, 'authority.txt'),
        'utf8',
      )).toBe('owned inode');
      expect(JSON.parse(await readFile(
        path.join(relocatedOwnedDirectory, 'video.info.json'),
        'utf8',
      ))).toEqual(safeMetadataFor(prepared));
      expect((await lstat(
        path.join(relocatedOwnedDirectory, 'video.info.json'),
      )).mode & 0o777).toBe(0o600);
      await expectMissing(path.join(outsideRoot, 'authority.txt'));
      await expectMissing(path.join(outsideRoot, 'video.info.json'));
      expect((await lstat(prepared.stagingDirectory)).isSymbolicLink()).toBe(true);
    } finally {
      await authority.close();
    }

    await unlink(prepared.stagingDirectory);
    await rename(relocatedOwnedDirectory, prepared.stagingDirectory);
    await cleanupArchive(prepared);
    await expectMissing(prepared.stagingDirectory);
    await expectMissing(path.join(outsideRoot, 'authority.txt'));
  });

  it('rejects a pre-existing regular metadata file without overwriting it', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    const metadataPath = path.join(prepared.stagingDirectory, 'video.info.json');
    await writeFile(metadataPath, 'pre-existing regular file');
    const authority = await openStagingDownloadAuthority(prepared);

    try {
      await expectDownloadError(
        authority.writeMetadata(safeMetadataFor(prepared)),
        'DOWNLOAD_FINALIZE_FAILED',
        FINALIZE_FAILED_MESSAGE,
      );
      expect(await readFile(metadataPath, 'utf8')).toBe('pre-existing regular file');
    } finally {
      await authority.close();
      await cleanupArchive(prepared);
    }
  });

  it('rejects a pre-existing metadata symlink without following it', async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    const outsideTarget = path.join(outsideRoot, 'outside-metadata.json');
    const metadataPath = path.join(prepared.stagingDirectory, 'video.info.json');
    await writeFile(outsideTarget, 'outside marker');
    await symlink(outsideTarget, metadataPath);
    const authority = await openStagingDownloadAuthority(prepared);

    try {
      await expectDownloadError(
        authority.writeMetadata(safeMetadataFor(prepared)),
        'DOWNLOAD_FINALIZE_FAILED',
        FINALIZE_FAILED_MESSAGE,
      );
      expect((await lstat(metadataPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(outsideTarget, 'utf8')).toBe('outside marker');
    } finally {
      await authority.close();
      await cleanupArchive(prepared);
    }
  });
});

describe('finalizeArchive', () => {
  it('publishes sorted, hashed files and an atomic mode-0600 receipt', async () => {
    const workspaceRoot = await createWorkspace();
    const {root, prepared} = await prepareStaging(
      workspaceRoot,
      'artifacts/downloads',
    );
    await writeStagedFiles(prepared, {
      thumbnailName: 'video.webp',
      subtitleNames: ['video.en.vtt'],
    });

    const result = await finalize(prepared);

    const expectedDirectory = 'artifacts/downloads/youtube/abc';
    const finalDirectory = path.join(root.absolutePath, 'youtube', 'abc');
    const absoluteReceiptPath = path.join(finalDirectory, 'receipt.json');
    expect(result).toMatchObject({
      status: 'downloaded',
      platform: 'youtube',
      videoId: 'abc',
      directory: expectedDirectory,
      mediaPath: `${expectedDirectory}/video.webm`,
      receiptPath: `${expectedDirectory}/receipt.json`,
    });
    expect(result.receipt.version).toBe(3);
    if (result.receipt.version !== 3) {
      throw new Error('Expected a version 3 receipt.');
    }
    expect(result.receipt.browserCookies).toEqual({used: false});
    expect(result.receipt.network).toEqual({
      proxyUsed: false,
      browserImpersonation: false,
    });
    expect(result.receipt.toolchain).toEqual({
      source: 'managed',
      ytDlpVersion: '2026.07.04',
      managedAssetSha256: MANAGED_ASSET_SHA256,
    });
    expect((await lstat(finalDirectory)).isDirectory()).toBe(true);
    await expectMissing(prepared.stagingDirectory);

    const receipt = DownloadReceiptSchema.parse(
      JSON.parse(await readFile(absoluteReceiptPath, 'utf8')),
    );
    expect(result.receipt).toEqual(receipt);
    expect(receipt).toMatchObject({
      version: 3,
      status: 'downloaded',
      platform: 'youtube',
      videoId: 'abc',
      title: 'Example',
      canonicalUrl: 'https://youtu.be/abc',
      downloadedAt: '2026-08-12T00:00:00.000Z',
      purpose: 'learning-analysis',
      rightsConfirmed: true,
      transcoded: false,
      tools: {
        ytDlpVersion: '2026.07.04',
        ffmpegVersion: 'ffmpeg version test',
      },
      browserCookies: {used: false},
      network: {
        proxyUsed: false,
        browserImpersonation: false,
      },
      toolchain: {
        source: 'managed',
        ytDlpVersion: '2026.07.04',
        managedAssetSha256: MANAGED_ASSET_SHA256,
      },
    });
    expect(receipt.files.map((file) => file.path)).toEqual(sortNames([
      'video.webm',
      'video.info.json',
      'video.en.vtt',
      'video.webp',
    ]));
    expect(Object.fromEntries(receipt.files.map((file) => [file.path, file.role])))
      .toEqual({
        'video.en.vtt': 'subtitle',
        'video.info.json': 'metadata',
        'video.webm': 'media',
        'video.webp': 'thumbnail',
      });

    for (const file of receipt.files) {
      const contents = await readFile(path.join(finalDirectory, file.path));
      expect(file.bytes).toBe(contents.byteLength);
      expect(file.sha256).toBe(sha256(contents));
    }
    expect((await lstat(absoluteReceiptPath)).mode & 0o777).toBe(0o600);
    expect(sortNames(await readdir(finalDirectory))).toEqual(sortNames([
      'receipt.json',
      ...receipt.files.map((file) => file.path),
    ]));
    expect((await readdir(finalDirectory)).some((name) =>
      name.includes('receipt-') || name.endsWith('.tmp'))).toBe(false);
  });

  it('records Chrome cookie use in a strict version 3 receipt', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(
      workspaceRoot,
      'downloads',
      DOUYIN_VIDEO_ID,
      'douyin',
    );
    await writeStagedFiles(prepared);

    const result = await finalize(prepared, {
      browserCookies: {used: true, source: 'chrome'},
    });

    expect(result.receipt).toMatchObject({
      version: 3,
      platform: 'douyin',
      videoId: DOUYIN_VIDEO_ID,
      canonicalUrl: `https://www.douyin.com/video/${DOUYIN_VIDEO_ID}`,
      browserCookies: {used: true, source: 'chrome'},
      network: {proxyUsed: false, browserImpersonation: false},
      toolchain: {
        source: 'managed',
        ytDlpVersion: '2026.07.04',
        managedAssetSha256: MANAGED_ASSET_SHA256,
      },
    });
  });

  it.each([
    ['tools and toolchain version mismatch', {
      toolchain: {
        source: 'managed' as const,
        ytDlpVersion: '2026.07.05',
        managedAssetSha256: MANAGED_ASSET_SHA256,
      },
    }],
    ['managed toolchain without digest', {
      toolchain: {
        source: 'managed' as const,
        ytDlpVersion: '2026.07.04',
      },
    }],
    ['override toolchain with managed digest', {
      toolchain: {
        source: 'override' as const,
        ytDlpVersion: '2026.07.04',
        managedAssetSha256: MANAGED_ASSET_SHA256,
      },
    }],
  ])('rejects %s during finalization', async (_caseName, overrides) => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);

    await expectDownloadError(
      finalize(prepared, overrides),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );

    await expectMissing(prepared.finalDirectory);
    expect(sortNames(await readdir(prepared.stagingDirectory))).toEqual(sortNames([
      'video.info.json',
      'video.webm',
    ]));
  });

  it.each([
    '.ass',
    '.json3',
    '.lrc',
    '.srt',
    '.srv1',
    '.srv2',
    '.srv3',
    '.ttml',
    '.vtt',
  ])('classifies %s files as subtitles', async (extension) => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    const subtitleName = `video.en${extension}`;
    await writeStagedFiles(prepared, {subtitleNames: [subtitleName]});

    const result = await finalize(prepared);

    expect(result.receipt.files.find((file) => file.path === subtitleName)?.role)
      .toBe('subtitle');
  });

  it('rejects missing metadata', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeFile(path.join(prepared.stagingDirectory, 'video.webm'), 'media');

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
    await expectMissing(prepared.finalDirectory);
  });

  it('rejects metadata whose identifier does not match', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared, {videoId: 'other'});

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it('rejects metadata whose extractor maps to another platform', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared, {extractor: 'vimeo'});

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it.each([
    ['playlist metadata', {_type: 'playlist'}],
    ['active live metadata', {is_live: true}],
    ['upcoming live metadata', {live_status: 'is_upcoming'}],
    ['post-live processing metadata', {live_status: 'post_live'}],
    ['metadata with an unexpected cookie field', {cookies: 'cookie-value-marker'}],
  ])('rejects %s before publication', async (_caseName, metadata) => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared, {metadata});

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
    await expectMissing(prepared.finalDirectory);
  });

  it('rejects a metadata canonical URL on another platform', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared, {
      metadata: {webpage_url: 'https://vimeo.com/123456789'},
    });

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
    await expectMissing(prepared.finalDirectory);
  });

  it('rejects a normalized metadata canonical URL mismatch', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared, {
      metadata: {webpage_url: 'https://youtu.be/abc?source=metadata#ignored'},
    });

    await expectDownloadError(
      finalize(prepared, {
        canonicalUrl: 'https://youtu.be/abc?source=probe#ignored',
      }),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
    await expectMissing(prepared.finalDirectory);
  });

  it('rejects multiple candidate media files', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);
    await writeFile(path.join(prepared.stagingDirectory, 'video.mp4'), 'second media');

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it('rejects multiple thumbnails', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared, {thumbnailName: 'video.webp'});
    await writeFile(path.join(prepared.stagingDirectory, 'video.jpg'), 'thumbnail two');

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it.each(['.part', '.tmp', '.ytdl'])('rejects staged temporary suffix %s', async (suffix) => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);
    await writeFile(
      path.join(prepared.stagingDirectory, `video.webm${suffix}`),
      'temporary',
    );

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it('rejects an existing receipt in staging', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);
    await writeFile(path.join(prepared.stagingDirectory, 'receipt.json'), '{}');

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it('rejects staged symlinks', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    const target = path.join(workspaceRoot, 'symlink-target');
    await writeStagedFiles(prepared);
    await writeFile(target, 'outside');
    await symlink(target, path.join(prepared.stagingDirectory, 'video.extra'));

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it('rejects staged directories', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);
    await mkdir(path.join(prepared.stagingDirectory, 'video.extra'));

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it('rejects filenames outside the controlled video basename', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);
    await writeFile(path.join(prepared.stagingDirectory, 'audio.en.vtt'), 'subtitle');

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );
  });

  it('does not overwrite a final destination that appears after preparation', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);
    await mkdir(prepared.finalDirectory);
    const sentinelPath = path.join(prepared.finalDirectory, 'sentinel.txt');
    await writeFile(sentinelPath, 'existing archive');

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(await readFile(sentinelPath, 'utf8')).toBe('existing archive');
    expect(await readdir(prepared.finalDirectory)).toEqual(['sentinel.txt']);
    expect((await lstat(prepared.stagingDirectory)).isDirectory()).toBe(true);
  });

  it('does not replace a destination created after the final absence check', async () => {
    const workspaceRoot = await createWorkspace();
    let prepared: StagedArchive | undefined;
    let competingDirectoryStats: Awaited<ReturnType<typeof lstat>> | undefined;
    let injectedDestination = false;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (
            archiveHelperOperation(args[1]) === 'publish' &&
            !injectedDestination &&
            prepared !== undefined
          ) {
            await mkdir(prepared.finalDirectory);
            competingDirectoryStats = await lstat(prepared.finalDirectory);
            injectedDestination = true;
          }
          return actual.runProcess(...args);
        },
      };
    });

    let failure: unknown;
    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);
      try {
        await racedArchive.finalizeArchive(prepared, finalizeInput(prepared));
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(injectedDestination).toBe(true);
    expect(failure).toMatchObject({
      code: 'DOWNLOAD_DESTINATION_CONFLICT',
      message: DESTINATION_CONFLICT_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect(competingDirectoryStats).toBeDefined();
    expect(prepared).toBeDefined();
    const finalStats = await lstat(prepared?.finalDirectory ?? '');
    expect({dev: finalStats.dev, ino: finalStats.ino}).toEqual({
      dev: competingDirectoryStats?.dev,
      ino: competingDirectoryStats?.ino,
    });
    expect(await readdir(prepared?.finalDirectory ?? '')).toEqual([]);
    expect((await lstat(prepared?.stagingDirectory ?? '')).isDirectory()).toBe(true);
  });

  it('does not publish outside the archive root when the platform directory is replaced after validation', async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt');
    await writeFile(outsideSentinel, 'keep outside');
    let prepared: StagedArchive | undefined;
    let parkedPlatformDirectory = '';
    let platformSwapped = false;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (
            archiveHelperOperation(args[1]) === 'publish' &&
            !platformSwapped &&
            prepared !== undefined
          ) {
            const platformDirectory = path.dirname(prepared.finalDirectory);
            parkedPlatformDirectory = `${platformDirectory}-original`;
            await rename(platformDirectory, parkedPlatformDirectory);
            await symlink(outsideRoot, platformDirectory);
            platformSwapped = true;
          }
          return actual.runProcess(...args);
        },
      };
    });

    let failure: unknown;
    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);
      try {
        await racedArchive.finalizeArchive(prepared, finalizeInput(prepared));
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(platformSwapped).toBe(true);
    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    await expectMissing(path.join(outsideRoot, 'abc'));
    expect(await readFile(outsideSentinel, 'utf8')).toBe('keep outside');
    await expectMissing(path.join(parkedPlatformDirectory, 'abc'));
    expect(prepared).toBeDefined();
    expect((await lstat(prepared?.stagingDirectory ?? '')).isDirectory()).toBe(true);
    expect(await realpath(path.dirname(prepared?.finalDirectory ?? '')))
      .toBe(await realpath(outsideRoot));
  });

  it('does not inspect or write through a substituted staging parent', async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeStagedFiles(prepared);
    const stagingRoot = path.dirname(prepared.stagingDirectory);
    const parkedStagingRoot = path.join(
      prepared.root.absolutePath,
      '.staging-original',
    );
    const stagingBasename = path.basename(prepared.stagingDirectory);
    const outsideStagingDirectory = path.join(outsideRoot, stagingBasename);
    await mkdir(outsideStagingDirectory);
    await writeStagedFiles({...prepared, stagingDirectory: outsideStagingDirectory});
    const outsideMediaPath = path.join(outsideStagingDirectory, 'video.webm');
    const outsideInfoPath = path.join(outsideStagingDirectory, 'video.info.json');
    const outsideMedia = await readFile(outsideMediaPath);
    const outsideInfo = await readFile(outsideInfoPath);
    await rename(stagingRoot, parkedStagingRoot);
    await symlink(outsideRoot, stagingRoot);

    await expectDownloadError(
      finalize(prepared),
      'DOWNLOAD_FINALIZE_FAILED',
      FINALIZE_FAILED_MESSAGE,
    );

    await expectMissing(path.join(outsideStagingDirectory, 'receipt.json'));
    expect(await readFile(outsideMediaPath)).toEqual(outsideMedia);
    expect(await readFile(outsideInfoPath)).toEqual(outsideInfo);
    const originalStagingDirectory = path.join(parkedStagingRoot, stagingBasename);
    await expectMissing(path.join(originalStagingDirectory, 'receipt.json'));
    expect(sortNames(await readdir(originalStagingDirectory))).toEqual(sortNames([
      'video.info.json',
      'video.webm',
    ]));
  });

  it('rejects a relocated output ancestor symlink without publishing outside the workspace', async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const {root, prepared} = await prepareStaging(
      workspaceRoot,
      'artifacts/downloads',
    );
    await writeStagedFiles(prepared);
    const outputAncestor = path.join(root.workspaceRoot, 'artifacts');
    const relocatedAncestor = path.join(await realpath(outsideRoot), 'artifacts');
    const stagingBasename = path.basename(prepared.stagingDirectory);
    const relocatedStagingDirectory = path.join(
      relocatedAncestor,
      'downloads',
      '.staging',
      stagingBasename,
    );
    const relocatedFinalDirectory = path.join(
      relocatedAncestor,
      'downloads',
      'youtube',
      prepared.videoId,
    );
    await rename(outputAncestor, relocatedAncestor);
    await symlink(relocatedAncestor, outputAncestor);
    const relocatedMediaPath = path.join(relocatedStagingDirectory, 'video.webm');
    const relocatedInfoPath = path.join(relocatedStagingDirectory, 'video.info.json');
    const relocatedMedia = await readFile(relocatedMediaPath);
    const relocatedInfo = await readFile(relocatedInfoPath);

    let failure: unknown;
    try {
      await finalize(prepared);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    await expectMissing(relocatedFinalDirectory);
    await expectMissing(path.join(relocatedStagingDirectory, 'receipt.json'));
    expect(await readFile(relocatedMediaPath)).toEqual(relocatedMedia);
    expect(await readFile(relocatedInfoPath)).toEqual(relocatedInfo);
    expect(sortNames(await readdir(relocatedStagingDirectory))).toEqual(sortNames([
      'video.info.json',
      'video.webm',
    ]));
  });

  it('prevents media mutation after receipt creation from publishing inconsistent bytes', async () => {
    const workspaceRoot = await createWorkspace();
    let prepared: StagedArchive | undefined;
    let mutationAttempted = false;
    let mutationFailure: unknown;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (
            archiveHelperOperation(args[1]) === 'publish' &&
            !mutationAttempted &&
            prepared !== undefined
          ) {
            await readFile(path.join(prepared.stagingDirectory, 'receipt.json'));
            mutationAttempted = true;
            try {
              await writeFile(
                path.join(prepared.stagingDirectory, 'video.webm'),
                'changed after receipt',
              );
            } catch (error) {
              mutationFailure = error;
            }
          }
          return actual.runProcess(...args);
        },
      };
    });

    let result: DownloadedArchive | undefined;
    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);
      result = await racedArchive.finalizeArchive(
        prepared,
        finalizeInput(prepared),
      );
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(mutationAttempted).toBe(true);
    expect(mutationFailure).toMatchObject({code: expect.stringMatching(/EACCES|EPERM/u)});
    expect(result).toBeDefined();
    expect(prepared).toBeDefined();
    const mediaReceipt = result?.receipt.files.find((file) => file.role === 'media');
    const publishedMedia = await readFile(path.join(
      prepared?.finalDirectory ?? '',
      mediaReceipt?.path ?? '',
    ));
    expect(mediaReceipt?.bytes).toBe(publishedMedia.byteLength);
    expect(mediaReceipt?.sha256).toBe(sha256(publishedMedia));
  });

  it('rejects a staging basename replacement made after native validation', async () => {
    const workspaceRoot = await createWorkspace();
    let prepared: StagedArchive | undefined;
    let parkedStagingDirectory = '';

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) !== 'publish' || prepared === undefined) {
            return actual.runProcess(...args);
          }
          const modifiedArgs = [...args[1]];
          const scriptIndex = modifiedArgs.indexOf('-e') + 1;
          const marker = '    const result = Number($.renameatx_np(';
          parkedStagingDirectory = `${prepared.stagingDirectory}-parked`;
          const replacementSentinel = path.join(
            prepared.stagingDirectory,
            'foreign.txt',
          );
          const swapScript = [
            'const {mkdirSync, renameSync, writeFileSync} = require("node:fs");',
            `renameSync(${JSON.stringify(prepared.stagingDirectory)}, ` +
              `${JSON.stringify(parkedStagingDirectory)});`,
            `mkdirSync(${JSON.stringify(prepared.stagingDirectory)});`,
            `writeFileSync(${JSON.stringify(replacementSentinel)}, "foreign");`,
          ].join('\n');
          const helperScript = modifiedArgs[scriptIndex] ?? '';
          if (!helperScript.includes(marker)) throw new Error('Missing publish marker.');
          modifiedArgs[scriptIndex] = helperScript.replace(
            marker,
            `    taskOutput(${JSON.stringify(process.execPath)}, ` +
              `${JSON.stringify(swapScript)}, []);\n${marker}`,
          );
          return actual.runProcess(args[0], modifiedArgs, args[2]);
        },
      };
    });

    let failure: unknown;
    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);
      try {
        await racedArchive.finalizeArchive(prepared, finalizeInput(prepared));
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect(prepared).toBeDefined();
    await expectMissing(prepared?.finalDirectory ?? '');
    expect(await readFile(
      path.join(prepared?.stagingDirectory ?? '', 'foreign.txt'),
      'utf8',
    )).toBe('foreign');
    expect((await lstat(parkedStagingDirectory)).isDirectory()).toBe(true);
  });

  it('makes the final quarantine rename the last helper filesystem action on success', async () => {
    const workspaceRoot = await createWorkspace();
    let finalRenameIsLast = false;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) !== 'publish') {
            return actual.runProcess(...args);
          }
          const scriptIndex = args[1].indexOf('-e') + 1;
          const helperScript = args[1][scriptIndex] ?? '';
          finalRenameIsLast = helperScript.includes([
            '    const published = Number($.renameatx_np(',
            '      3, argv[3], 4, argv[2], RENAME_EXCL_NOFOLLOW_ANY,',
            '    ));',
            '    if (published === 0) return "published";',
          ].join('\n'));
          return actual.runProcess(...args);
        },
      };
    });

    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      await writeStagedFiles(archivePreparation);
      await racedArchive.finalizeArchive(
        archivePreparation,
        finalizeInput(archivePreparation),
      );
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(finalRenameIsLast).toBe(true);
  });

  it('copies only recorded bytes and rejects a source that extends at EOF', async () => {
    const workspaceRoot = await createWorkspace();
    const counterPath = path.join(workspaceRoot, 'bounded-copy-count.txt');

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) !== 'seal-staging') {
            return actual.runProcess(...args);
          }
          const modifiedArgs = [...args[1]];
          const separatorIndex = modifiedArgs.indexOf('--');
          const workerIndex = separatorIndex + 3;
          const importMarker = [
            '  openSync, readFileSync, readSync, readdirSync, renameSync, unlinkSync,',
            '  writeSync,',
          ].join('\n');
          const importReplacement = [
            '  openSync: nativeOpenSync, readFileSync, readSync: nativeReadSync,',
            '  readdirSync, renameSync, unlinkSync, appendFileSync, writeFileSync,',
            '  writeSync,',
          ].join('\n');
          const injectionMarker = 'const expectedFiles = receipt.files;';
          const injection = [
            injectionMarker,
            'const trackedMediaDescriptors = new Set();',
            'const openSync = (name, ...openArgs) => {',
            '  const descriptor = nativeOpenSync(name, ...openArgs);',
            '  if (name === "video.webm" &&',
            '      (openArgs[0] & (constants.O_WRONLY | constants.O_RDWR)) === 0) {',
            '    trackedMediaDescriptors.add(descriptor);',
            '  }',
            '  return descriptor;',
            '};',
            'let appendedReads = 0;',
            'const readSync = (descriptor, ...readArgs) => {',
            '  const bytesRead = nativeReadSync(descriptor, ...readArgs);',
            '  if (operation === "prepare" && bytesRead === 0 &&',
            '      trackedMediaDescriptors.has(descriptor) && appendedReads < 64) {',
            '    appendFileSync("video.webm", "x");',
            '    appendedReads += 1;',
            `    writeFileSync(${JSON.stringify(counterPath)}, String(appendedReads));`,
            '    return nativeReadSync(descriptor, ...readArgs);',
            '  }',
            '  return bytesRead;',
            '};',
          ].join('\n');
          const workerScript = modifiedArgs[workerIndex] ?? '';
          if (
            !workerScript.includes(importMarker) ||
            !workerScript.includes(injectionMarker)
          ) {
            throw new Error('Missing seal worker marker.');
          }
          modifiedArgs[workerIndex] = workerScript
            .replace(importMarker, importReplacement)
            .replace(injectionMarker, injection);
          return actual.runProcess(args[0], modifiedArgs, args[2]);
        },
      };
    });

    let failure: unknown;
    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      await writeStagedFiles(archivePreparation);
      try {
        await racedArchive.finalizeArchive(
          archivePreparation,
          finalizeInput(archivePreparation),
        );
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(failure).toMatchObject({
      code: 'DOWNLOAD_ARCHIVE_INVALID',
      message: ARCHIVE_INVALID_MESSAGE,
      name: 'DownloadError',
    });
    expect(await readFile(counterPath, 'utf8')).toBe('1');
  });

  it('defers verification when the publish response is lost', async () => {
    const workspaceRoot = await createWorkspace();
    let responseLost = false;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          const result = await actual.runProcess(...args);
          if (archiveHelperOperation(args[1]) === 'publish' && !responseLost) {
            responseLost = true;
            throw new Error('Simulated lost response after publication.');
          }
          return result;
        },
      };
    });

    let prepared: StagedArchive | undefined;
    let failure: unknown;
    let duplicate: Awaited<ReturnType<typeof prepareArchive>> | undefined;
    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);
      try {
        await racedArchive.finalizeArchive(prepared, finalizeInput(prepared));
      } catch (error) {
        failure = error;
      }
      duplicate = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(responseLost).toBe(true);
    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect(duplicate?.status).toBe('already-present');
    if (duplicate?.status !== 'already-present') {
      throw new Error('Expected an existing archive.');
    }
    expect(prepared).toBeDefined();
    await expectMissing(prepared?.stagingDirectory ?? '');
    const media = duplicate.receipt.files.find((file) => file.role === 'media');
    const contents = await readFile(path.join(
      prepared?.finalDirectory ?? '',
      media?.path ?? '',
    ));
    expect(media?.sha256).toBe(sha256(contents));
  });

  it('does not apply worker timeouts to archive operations', async () => {
    const workspaceRoot = await createWorkspace();
    const helperCalls: Array<{
      operation: string | undefined;
      timeoutMs: number | undefined;
    }> = [];

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          helperCalls.push({
            operation: archiveHelperOperation(args[1]),
            timeoutMs: args[2]?.timeoutMs,
          });
          return actual.runProcess(...args);
        },
      };
    });

    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      await writeStagedFiles(archivePreparation);
      await racedArchive.finalizeArchive(
        archivePreparation,
        finalizeInput(archivePreparation),
      );
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(helperCalls).toEqual(expect.arrayContaining([
      {operation: 'inspect-staging', timeoutMs: undefined},
      {operation: 'seal-staging', timeoutMs: undefined},
      {operation: 'publish', timeoutMs: undefined},
    ]));
  });

  it('keeps the final path absent if execution stops before atomic publication', async () => {
    const workspaceRoot = await createWorkspace();
    let prepared: StagedArchive | undefined;
    let nativeHelperCalled = false;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) !== 'publish') {
            return actual.runProcess(...args);
          }
          if (prepared === undefined) throw new Error('Missing staged archive.');
          await expectMissing(prepared.finalDirectory);
          expect((await lstat(prepared.stagingDirectory)).isDirectory()).toBe(true);
          expect(sortNames(await readdir(prepared.stagingDirectory))).toEqual(sortNames([
            'receipt.json',
            'video.info.json',
            'video.webm',
          ]));
          nativeHelperCalled = true;
          throw new Error('Simulated interruption before atomic publication.');
        },
      };
    });

    let failure: unknown;
    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);
      try {
        await racedArchive.finalizeArchive(prepared, finalizeInput(prepared));
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(nativeHelperCalled).toBe(true);
    expect(failure).toMatchObject({
      code: 'DOWNLOAD_FINALIZE_FAILED',
      message: FINALIZE_FAILED_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect(prepared).toBeDefined();
    await expectMissing(prepared?.finalDirectory ?? '');
    expect(sortNames(await readdir(prepared?.stagingDirectory ?? ''))).toEqual(sortNames([
      'receipt.json',
      'video.info.json',
      'video.webm',
    ]));
  });
});

describe('prepareArchive duplicate verification', () => {
  it('returns already-present only after validating and rehashing the archive', async () => {
    const published = await publishArchive();

    const duplicate = await prepareArchive(
      published.root,
      'youtube',
      'abc',
      'https://YOUTU.BE:443/abc#probe',
    );

    expect(duplicate).toEqual({
      status: 'already-present',
      platform: 'youtube',
      videoId: 'abc',
      directory: 'downloads/youtube/abc',
      mediaPath: 'downloads/youtube/abc/video.webm',
      receiptPath: 'downloads/youtube/abc/receipt.json',
      receipt: published.result.receipt,
    });
    expect(await readdir(path.join(published.root.absolutePath, '.staging')))
      .toEqual([]);
  });

  it('rejects a sensitive unknown receipt key at the public archive boundary', async () => {
    const published = await publishArchive();
    await makeTreeMutable(published.finalDirectory);
    const receiptPath = path.join(published.finalDirectory, 'receipt.json');
    const sensitiveKey =
      'https://proxy.example/receipt?token=sensitive-key-name-marker';
    const forgedReceipt = {
      ...published.result.receipt,
      [sensitiveKey]: true,
    };
    await writeFile(receiptPath, `${JSON.stringify(forgedReceipt, null, 2)}\n`);

    const error = await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_ARCHIVE_INVALID',
      ARCHIVE_INVALID_MESSAGE,
    );

    expect(error.message).not.toContain(sensitiveKey);
    expect(String(error)).not.toContain(sensitiveKey);
    expect(error.cause).toBeUndefined();
  });

  it('rejects an existing archive whose receipt canonical URL differs from the probe', async () => {
    const published = await publishArchive();
    const receiptSource = await readFile(
      path.join(published.finalDirectory, 'receipt.json'),
      'utf8',
    );

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        'https://www.youtube.com/watch?v=different-video',
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(await readFile(
      path.join(published.finalDirectory, 'receipt.json'),
      'utf8',
    )).toBe(receiptSource);
    expect(await readdir(path.join(published.root.absolutePath, '.staging')))
      .toEqual([]);
  });

  it('returns a sealed version 3 receipt unchanged', async () => {
    const workspaceRoot = await createWorkspace();
    const {root, prepared} = await prepareStaging(
      workspaceRoot,
      'downloads',
      DOUYIN_VIDEO_ID,
      'douyin',
    );
    await writeStagedFiles(prepared);
    const result = await finalize(prepared, {
      browserCookies: {used: true, source: 'chrome'},
    });

    const duplicate = await prepareArchive(
      root,
      'douyin',
      DOUYIN_VIDEO_ID,
      canonicalUrlFor('douyin', DOUYIN_VIDEO_ID),
    );

    expect(result.receipt).toMatchObject({
      version: 3,
      platform: 'douyin',
      videoId: DOUYIN_VIDEO_ID,
      browserCookies: {used: true, source: 'chrome'},
    });
    expect(duplicate.status).toBe('already-present');
    if (duplicate.status !== 'already-present') {
      throw new Error('Expected an existing archive.');
    }
    expect(duplicate.receipt).toEqual(result.receipt);
  });

  it('reuses a sealed legacy version 1 archive with extra metadata unchanged', async () => {
    const published = await publishArchive();
    const description = 'x'.repeat(PROCESS_OUTPUT_LIMIT_BYTES + 128 * 1024);
    const legacy = await rewritePublishedMetadata(published, {
      description,
      format: 'legacy-format',
      cookies: 'cookie-value-marker',
      url: 'signed-url-marker',
      filepath: '/private/profile-marker',
      http_headers: {Authorization: 'header-marker'},
    }, legacyV1Receipt(published.result.receipt));
    const expectedReceipt = DownloadReceiptSchema.parse(
      JSON.parse(legacy.receiptSource),
    );
    expect(expectedReceipt.version).toBe(1);

    expect(Buffer.byteLength(legacy.metadataSource))
      .toBeGreaterThan(PROCESS_OUTPUT_LIMIT_BYTES);
    const duplicate = await prepareArchive(
      published.root,
      'youtube',
      'abc',
      canonicalUrlFor('youtube', 'abc'),
    );

    expect(duplicate).toMatchObject({
      status: 'already-present',
      platform: 'youtube',
      videoId: 'abc',
      receipt: expectedReceipt,
    });
    expect(JSON.stringify(duplicate)).not.toMatch(
      /cookie-value-marker|signed-url-marker|profile-marker|header-marker/u,
    );
    expect(await readFile(
      path.join(published.finalDirectory, 'video.info.json'),
      'utf8',
    )).toBe(legacy.metadataSource);
    expect(await readFile(
      path.join(published.finalDirectory, 'receipt.json'),
      'utf8',
    )).toBe(legacy.receiptSource);
  });

  it('reuses a sealed legacy version 2 archive with extra metadata unchanged', async () => {
    const workspaceRoot = await createWorkspace();
    const {root, prepared} = await prepareStaging(
      workspaceRoot,
      'downloads',
      DOUYIN_VIDEO_ID,
      'douyin',
    );
    await writeStagedFiles(prepared);
    const result = await finalize(prepared, {
      browserCookies: {used: true, source: 'chrome'},
    });
    const published: PublishedArchive = {
      workspaceRoot,
      root,
      result,
      finalDirectory: path.join(root.absolutePath, 'douyin', DOUYIN_VIDEO_ID),
    };
    const legacy = await rewritePublishedMetadata(published, {
      availability: 'public',
      description: 'legacy Douyin description',
      cookies: 'cookie-value-marker',
      url: 'signed-url-marker',
      filepath: '/private/profile-marker',
      http_headers: {Authorization: 'header-marker'},
    }, legacyV2Receipt(result.receipt));
    const expectedReceipt = DownloadReceiptSchema.parse(
      JSON.parse(legacy.receiptSource),
    );
    expect(expectedReceipt.version).toBe(2);

    const duplicate = await prepareArchive(
      root,
      'douyin',
      DOUYIN_VIDEO_ID,
      canonicalUrlFor('douyin', DOUYIN_VIDEO_ID),
    );

    expect(duplicate).toMatchObject({
      status: 'already-present',
      platform: 'douyin',
      videoId: DOUYIN_VIDEO_ID,
      receipt: expectedReceipt,
    });
    expect(JSON.stringify(duplicate)).not.toMatch(
      /cookie-value-marker|signed-url-marker|profile-marker|header-marker/u,
    );
    expect(await readFile(
      path.join(published.finalDirectory, 'video.info.json'),
      'utf8',
    )).toBe(legacy.metadataSource);
    expect(await readFile(
      path.join(published.finalDirectory, 'receipt.json'),
      'utf8',
    )).toBe(legacy.receiptSource);
  });

  it('accepts a valid archive with ordinary safe modes and no immutable flags', async () => {
    const published = await publishArchive();
    await clearImmutableFlags(published.finalDirectory);
    await chmod(published.finalDirectory, 0o755);
    for (const entry of await readdir(published.finalDirectory)) {
      await chmod(path.join(published.finalDirectory, entry), 0o644);
    }

    const duplicate = await prepareArchive(
      published.root,
      'youtube',
      'abc',
      canonicalUrlFor('youtube', 'abc'),
    );

    expect(duplicate).toEqual({
      status: 'already-present',
      platform: 'youtube',
      videoId: 'abc',
      directory: 'downloads/youtube/abc',
      mediaPath: 'downloads/youtube/abc/video.webm',
      receiptPath: 'downloads/youtube/abc/receipt.json',
      receipt: published.result.receipt,
    });
  });

  it('rejects a fully rehashed archive with forged stable filenames unchanged', async () => {
    const published = await publishArchive();
    await makeTreeMutable(published.finalDirectory);
    const originalMediaPath = path.join(published.finalDirectory, 'video.webm');
    const forgedMediaPath = path.join(published.finalDirectory, 'media.bin');
    await rename(originalMediaPath, forgedMediaPath);
    const mediaContents = await readFile(forgedMediaPath);
    const forgedReceipt = {
      ...published.result.receipt,
      files: published.result.receipt.files
        .map((file) => file.role === 'media'
          ? {
              ...file,
              path: 'media.bin',
              bytes: mediaContents.byteLength,
              sha256: sha256(mediaContents),
            }
          : file)
        .sort((left, right) => left.path.localeCompare(right.path)),
    };
    const receiptPath = path.join(published.finalDirectory, 'receipt.json');
    const forgedReceiptSource = `${JSON.stringify(forgedReceipt, null, 2)}\n`;
    await writeFile(receiptPath, forgedReceiptSource);
    const entriesBefore = sortNames(await readdir(published.finalDirectory));

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(sortNames(await readdir(published.finalDirectory))).toEqual(entriesBefore);
    expect(await readFile(receiptPath, 'utf8')).toBe(forgedReceiptSource);
    expect(await readFile(forgedMediaPath, 'utf8')).toBe('media');
    await expectMissing(originalMediaPath);
  });

  it('rejects a rehashed archive with a canonical platform mismatch unchanged', async () => {
    const published = await publishArchive();
    await makeTreeMutable(published.finalDirectory);
    const receiptPath = path.join(published.finalDirectory, 'receipt.json');
    const forgedReceipt = {
      ...published.result.receipt,
      canonicalUrl: 'https://vimeo.com/123456789',
    };
    const forgedReceiptSource = `${JSON.stringify(forgedReceipt, null, 2)}\n`;
    await writeFile(receiptPath, forgedReceiptSource);
    const entriesBefore = sortNames(await readdir(published.finalDirectory));

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(sortNames(await readdir(published.finalDirectory))).toEqual(entriesBefore);
    expect(await readFile(receiptPath, 'utf8')).toBe(forgedReceiptSource);
  });

  it.each([
    ['non-JSON', '{not-json'],
    ['playlist', {_type: 'playlist'}],
    ['live', {is_live: true}],
    ['identifier mismatch', {id: 'other'}],
    ['extractor mismatch', {extractor: 'vimeo'}],
    ['canonical mismatch', {webpage_url: 'https://youtu.be/different'}],
  ])('rejects fully rehashed forged existing metadata: %s', async (
    _caseName,
    replacement,
  ) => {
    const published = await publishArchive();
    const {metadataSource, receiptSource} = await rewritePublishedMetadata(
      published,
      replacement,
    );
    const entriesBefore = sortNames(await readdir(published.finalDirectory));

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(sortNames(await readdir(published.finalDirectory))).toEqual(entriesBefore);
    expect(await readFile(
      path.join(published.finalDirectory, 'video.info.json'),
      'utf8',
    )).toBe(metadataSource);
    expect(await readFile(
      path.join(published.finalDirectory, 'receipt.json'),
      'utf8',
    )).toBe(receiptSource);
  });

  it('fails closed when the final directory path is swapped during verification', async () => {
    const published = await publishArchive();
    const outsideRoot = await createWorkspace();
    const relocatedFinalDirectory = path.join(outsideRoot, 'relocated-final');
    let swapped = false;

    const swapFinalDirectory = (): void => {
      if (swapped) return;
      renameSync(published.finalDirectory, relocatedFinalDirectory);
      symlinkSync(relocatedFinalDirectory, published.finalDirectory);
      swapped = true;
    };

    vi.resetModules();
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
          swapFinalDirectory();
          return actual.createReadStream(...args);
        },
      };
    });
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) === 'inspect-existing') {
            swapFinalDirectory();
          }
          return actual.runProcess(...args);
        },
      };
    });

    let failure: unknown;
    try {
      const racedArchive = await import('../../../src/download/archive');
      try {
        await racedArchive.prepareArchive(
          published.root,
          'youtube',
          'abc',
          canonicalUrlFor('youtube', 'abc'),
        );
      } catch (error) {
        failure = error;
      }
    } finally {
      vi.doUnmock('node:fs');
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(swapped).toBe(true);
    expect(failure).toMatchObject({
      code: 'DOWNLOAD_DESTINATION_CONFLICT',
      message: DESTINATION_CONFLICT_MESSAGE,
      name: 'DownloadError',
    });
    expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
    expect((await lstat(published.finalDirectory)).isSymbolicLink()).toBe(true);
    expect(await realpath(published.finalDirectory))
      .toBe(await realpath(relocatedFinalDirectory));
  });

  it('rejects a same-size modified file without repairing it', async () => {
    const published = await publishArchive();
    await makeTreeMutable(published.finalDirectory);
    const mediaPath = path.join(published.finalDirectory, 'video.webm');
    await writeFile(mediaPath, 'MEDIA');
    const entriesBefore = sortNames(await readdir(published.finalDirectory));

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(await readFile(mediaPath, 'utf8')).toBe('MEDIA');
    expect(sortNames(await readdir(published.finalDirectory))).toEqual(entriesBefore);
  });

  it('rejects a missing recorded file without recreating it', async () => {
    const published = await publishArchive();
    await makeTreeMutable(published.finalDirectory);
    const subtitlePath = path.join(published.finalDirectory, 'video.en.vtt');
    await unlink(subtitlePath);
    const entriesBefore = sortNames(await readdir(published.finalDirectory));

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    await expectMissing(subtitlePath);
    expect(sortNames(await readdir(published.finalDirectory))).toEqual(entriesBefore);
  });

  it('rejects an extra entry without deleting it', async () => {
    const published = await publishArchive();
    await makeTreeMutable(published.finalDirectory);
    const extraPath = path.join(published.finalDirectory, 'extra.txt');
    await writeFile(extraPath, 'extra');

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(await readFile(extraPath, 'utf8')).toBe('extra');
  });

  it('rejects a symlinked recorded file without replacing it', async () => {
    const published = await publishArchive();
    await makeTreeMutable(published.finalDirectory);
    const mediaPath = path.join(published.finalDirectory, 'video.webm');
    const target = path.join(published.workspaceRoot, 'replacement-media');
    await writeFile(target, 'media');
    await unlink(mediaPath);
    await symlink(target, mediaPath);

    await expectDownloadError(
      prepareArchive(
        published.root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect((await lstat(mediaPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(mediaPath)).toBe(target);
  });

  it('rejects a symlinked final directory without changing its target', async () => {
    const workspaceRoot = await createWorkspace();
    const root = await validateArchiveRoot(workspaceRoot, 'downloads');
    await mkdir(path.join(root.absolutePath, 'youtube'));
    const target = path.join(workspaceRoot, 'existing-target');
    const sentinel = path.join(target, 'sentinel.txt');
    await mkdir(target);
    await writeFile(sentinel, 'keep');
    await symlink(target, path.join(root.absolutePath, 'youtube', 'abc'));

    await expectDownloadError(
      prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      ),
      'DOWNLOAD_DESTINATION_CONFLICT',
      DESTINATION_CONFLICT_MESSAGE,
    );

    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });
});

describe('cleanupArchive', () => {
  it('removes an owned unique staging directory', async () => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    await writeFile(path.join(prepared.stagingDirectory, 'video.webm'), 'media');

    await cleanupArchive(prepared);

    await expectMissing(prepared.stagingDirectory);
    expect((await lstat(path.join(prepared.root.absolutePath, '.staging'))).isDirectory())
      .toBe(true);
  });

  it.each([
    ['outside staging', (root: ValidatedArchiveRoot) =>
      path.join(root.absolutePath, 'download-outside')],
    ['missing download prefix', (root: ValidatedArchiveRoot) =>
      path.join(root.absolutePath, '.staging', 'not-owned')],
  ] as const)('rejects %s cleanup targets without removing them', async (_caseName, targetFor) => {
    const workspaceRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    const target = targetFor(prepared.root);
    await mkdir(target, {recursive: true});
    const sentinel = path.join(target, 'sentinel.txt');
    await writeFile(sentinel, 'keep');
    const forged: StagedArchive = {...prepared, stagingDirectory: target};

    await expectDownloadError(
      cleanupArchive(forged),
      'DOWNLOAD_FINALIZE_FAILED',
      FINALIZE_FAILED_MESSAGE,
    );

    expect(await readFile(sentinel, 'utf8')).toBe('keep');
  });

  it('rejects cleanup when .staging is replaced by an outside symlink', async () => {
    const workspaceRoot = await createWorkspace();
    const outsideRoot = await createWorkspace();
    const {prepared} = await prepareStaging(workspaceRoot);
    const stagingRoot = path.join(prepared.root.absolutePath, '.staging');
    const parkedStagingRoot = path.join(
      prepared.root.absolutePath,
      '.staging-original',
    );
    const stagingBasename = path.basename(prepared.stagingDirectory);
    const outsideStagingDirectory = path.join(outsideRoot, stagingBasename);
    const outsideSentinel = path.join(outsideStagingDirectory, 'sentinel.txt');
    await rename(stagingRoot, parkedStagingRoot);
    await mkdir(outsideStagingDirectory);
    await writeFile(outsideSentinel, 'keep outside');
    await symlink(outsideRoot, stagingRoot);

    await expectDownloadError(
      cleanupArchive(prepared),
      'DOWNLOAD_FINALIZE_FAILED',
      FINALIZE_FAILED_MESSAGE,
    );

    expect(await readFile(outsideSentinel, 'utf8')).toBe('keep outside');
    expect((await lstat(stagingRoot)).isSymbolicLink()).toBe(true);
    expect((await lstat(path.join(parkedStagingRoot, stagingBasename))).isDirectory())
      .toBe(true);
  });

  it('removes a sealed staging directory after publication fails', async () => {
    const workspaceRoot = await createWorkspace();
    let prepared: StagedArchive | undefined;
    let finalizeFailure: unknown;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) === 'publish') {
            throw new Error('Simulated publication failure.');
          }
          return actual.runProcess(...args);
        },
      };
    });

    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);
      try {
        await racedArchive.finalizeArchive(prepared, finalizeInput(prepared));
      } catch (error) {
        finalizeFailure = error;
      }
      expect(finalizeFailure).toMatchObject({
        code: 'DOWNLOAD_FINALIZE_FAILED',
        message: FINALIZE_FAILED_MESSAGE,
        name: 'DownloadError',
      });
      expect((finalizeFailure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
      expect((await lstat(prepared.stagingDirectory)).mode & 0o777).toBe(0o500);
      expect((await lstat(path.join(prepared.stagingDirectory, 'video.webm'))).mode & 0o777)
        .toBe(0o400);

      await racedArchive.cleanupArchive(prepared);
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(prepared).toBeDefined();
    await expectMissing(prepared?.stagingDirectory ?? '');
  });

  it('cleans the journaled quarantine after publication fails post-move', async () => {
    const workspaceRoot = await createWorkspace();
    let prepared: StagedArchive | undefined;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) !== 'publish') {
            return actual.runProcess(...args);
          }
          const modifiedArgs = [...args[1]];
          const scriptIndex = modifiedArgs.indexOf('-e') + 1;
          const marker = '    if (result !== 0) return "source-conflict";';
          const replacementScript = [
            'const {mkdirSync, writeFileSync} = require("node:fs");',
            'const path = require("node:path");',
            'const sourceName = process.argv.at(-1);',
            'mkdirSync(sourceName);',
            'writeFileSync(path.join(sourceName, "foreign.txt"), "foreign");',
          ].join('\n');
          const helperScript = modifiedArgs[scriptIndex] ?? '';
          if (!helperScript.includes(marker)) throw new Error('Missing quarantine marker.');
          modifiedArgs[scriptIndex] = helperScript.replace(
            marker,
            `${marker}\n` +
              `    taskOutput(${JSON.stringify(process.execPath)}, ` +
              `${JSON.stringify(replacementScript)}, [argv[1]]);\n` +
              '    throw new Error("Simulated failure after quarantine move.");',
          );
          return actual.runProcess(args[0], modifiedArgs, args[2]);
        },
      };
    });

    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      prepared = archivePreparation;
      await writeStagedFiles(prepared);

      let finalizeFailure: unknown;
      try {
        await racedArchive.finalizeArchive(prepared, finalizeInput(prepared));
      } catch (error) {
        finalizeFailure = error;
      }
      expect(finalizeFailure).toMatchObject({
        code: 'DOWNLOAD_FINALIZE_FAILED',
        message: FINALIZE_FAILED_MESSAGE,
        name: 'DownloadError',
      });
      expect((finalizeFailure as {cause?: unknown} | undefined)?.cause).toBeUndefined();

      const stagingRoot = path.dirname(prepared.stagingDirectory);
      const entriesBeforeCleanup = await readdir(stagingRoot);
      expect(entriesBeforeCleanup).toContain(path.basename(prepared.stagingDirectory));
      expect(entriesBeforeCleanup.some((entry) => entry.startsWith('.publish-')))
        .toBe(true);

      await racedArchive.cleanupArchive(prepared);

      expect(await readdir(stagingRoot)).toEqual([
        path.basename(prepared.stagingDirectory),
      ]);
      expect(await readFile(
        path.join(prepared.stagingDirectory, 'foreign.txt'),
        'utf8',
      )).toBe('foreign');
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }
  });

  it('does not apply the short native timeout to recursive cleanup', async () => {
    const workspaceRoot = await createWorkspace();
    let cleanupTimeout: number | undefined = 30_000;

    vi.resetModules();
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
        '../../../src/process/run-process',
      );
      return {
        ...actual,
        runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
          if (archiveHelperOperation(args[1]) === 'cleanup') {
            cleanupTimeout = args[2]?.timeoutMs;
          }
          return actual.runProcess(...args);
        },
      };
    });

    try {
      const racedArchive = await import('../../../src/download/archive');
      const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
      const archivePreparation = await racedArchive.prepareArchive(
        root,
        'youtube',
        'abc',
        canonicalUrlFor('youtube', 'abc'),
      );
      if (archivePreparation.status !== 'staging') {
        throw new Error('Expected staging archive.');
      }
      await writeFile(
        path.join(archivePreparation.stagingDirectory, 'partial.tmp'),
        'partial',
      );
      await racedArchive.cleanupArchive(archivePreparation);
    } finally {
      vi.doUnmock('../../../src/process/run-process');
      vi.resetModules();
    }

    expect(cleanupTimeout).toBeUndefined();
  });

  it.each(['archive root', 'staging root'] as const)(
    'fails closed when the %s is replaced after ownership validation',
    async (replacementTarget) => {
      const workspaceRoot = await createWorkspace();
      let prepared: StagedArchive | undefined;
      let replacementSentinel = '';
      let originalStagingDirectory = '';
      let swapped = false;

      const swapOwnedAncestor = async (): Promise<void> => {
        if (swapped || prepared === undefined) return;
        const stagingBasename = path.basename(prepared.stagingDirectory);
        if (replacementTarget === 'archive root') {
          const parkedRoot = `${prepared.root.absolutePath}-original`;
          await rename(prepared.root.absolutePath, parkedRoot);
          originalStagingDirectory = path.join(
            parkedRoot,
            '.staging',
            stagingBasename,
          );
          const replacementDirectory = path.join(
            prepared.root.absolutePath,
            '.staging',
            stagingBasename,
          );
          await mkdir(replacementDirectory, {recursive: true});
          replacementSentinel = path.join(replacementDirectory, 'sentinel.txt');
        } else {
          const stagingRoot = path.join(prepared.root.absolutePath, '.staging');
          const parkedStagingRoot = path.join(
            prepared.root.absolutePath,
            '.staging-original',
          );
          await rename(stagingRoot, parkedStagingRoot);
          originalStagingDirectory = path.join(parkedStagingRoot, stagingBasename);
          const replacementDirectory = path.join(stagingRoot, stagingBasename);
          await mkdir(replacementDirectory, {recursive: true});
          replacementSentinel = path.join(replacementDirectory, 'sentinel.txt');
        }
        await writeFile(replacementSentinel, 'keep replacement');
        swapped = true;
      };

      vi.resetModules();
      vi.doMock('../../../src/process/run-process', async () => {
        const actual = await vi.importActual<typeof import('../../../src/process/run-process')>(
          '../../../src/process/run-process',
        );
        return {
          ...actual,
          runProcess: async (...args: Parameters<typeof actual.runProcess>) => {
            if (archiveHelperOperation(args[1]) === 'cleanup') {
              await swapOwnedAncestor();
            }
            return actual.runProcess(...args);
          },
        };
      });

      let failure: unknown;
      try {
        const racedArchive = await import('../../../src/download/archive');
        const root = await racedArchive.validateArchiveRoot(workspaceRoot, 'downloads');
        const archivePreparation = await racedArchive.prepareArchive(
          root,
          'youtube',
          'abc',
          canonicalUrlFor('youtube', 'abc'),
        );
        if (archivePreparation.status !== 'staging') {
          throw new Error('Expected staging archive.');
        }
        prepared = archivePreparation;
        await writeFile(path.join(prepared.stagingDirectory, 'partial.tmp'), 'partial');
        try {
          await racedArchive.cleanupArchive(prepared);
        } catch (error) {
          failure = error;
        }
      } finally {
        vi.doUnmock('../../../src/process/run-process');
        vi.resetModules();
      }

      expect(swapped).toBe(true);
      expect(failure).toMatchObject({
        code: 'DOWNLOAD_FINALIZE_FAILED',
        message: FINALIZE_FAILED_MESSAGE,
        name: 'DownloadError',
      });
      expect((failure as {cause?: unknown} | undefined)?.cause).toBeUndefined();
      expect(await readFile(replacementSentinel, 'utf8')).toBe('keep replacement');
      expect((await lstat(originalStagingDirectory)).isDirectory()).toBe(true);
      expect(await readFile(path.join(originalStagingDirectory, 'partial.tmp'), 'utf8'))
        .toBe('partial');
    },
  );
});
