import {execFile} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {constants, type BigIntStats} from 'node:fs';
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {z} from 'zod';
import {
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunFile,
  openNewRunReadWriteFile,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {
  openExistingProjectFile,
  type ProjectDirectoryScope,
} from '../../fs/project-paths';
import {
  ProjectRelativePathSchema,
  StableIdSchema,
} from '../../domain/schema-primitives';
import {
  decideVideoCompatibility,
  isVariableFrameRate,
  parseFfprobeJson,
  type CompatibilityDecision,
  type MediaProbe,
  type VideoStreamProbe,
} from '../../media/ffprobe';
import {
  transcodeVideo,
  type MediaProcessRunner,
} from '../../media/transcode';
import {
  runProcess,
  type RunProcessOptions,
} from '../../process/run-process';

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const RenderScopeSchema = z.enum(['project', 'run']);
const O_NOFOLLOW_ANY = 0x20000000;
const execFileAsync = promisify(execFile);

const ManifestBaseAssetSchema = z.object({
  sourcePath: ProjectRelativePathSchema,
  sourceHash: HashSchema,
  renderPath: ProjectRelativePathSchema,
  renderScope: RenderScopeSchema,
  compatibility: z.enum(['direct', 'transcoded']),
});

const ManifestVideoAssetSchema = ManifestBaseAssetSchema.extend({
  kind: z.literal('video'),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  videoCodec: z.string().min(1),
  pixelFormat: z.string().min(1),
  colorSpace: z.string().min(1),
  hasAudio: z.boolean(),
  variableFrameRate: z.boolean(),
}).strict();

const ManifestAudioAssetSchema = ManifestBaseAssetSchema.extend({
  kind: z.literal('audio'),
  durationMs: z.number().int().positive(),
}).strict();

const ManifestImageAssetSchema = ManifestBaseAssetSchema.extend({
  kind: z.literal('image'),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

export const IngestAssetRecordSchema = z.discriminatedUnion('kind', [
  ManifestVideoAssetSchema,
  ManifestAudioAssetSchema,
  ManifestImageAssetSchema,
]);

export const IngestManifestSchema = z.object({
  version: z.literal(1),
  assets: z.record(StableIdSchema, IngestAssetRecordSchema),
}).strict();

const IngestSourcePathSchema = ProjectRelativePathSchema.superRefine(
  (value, context) => {
    const segments = value.split('/');
    if (
      value.includes('\0')
      || path.posix.isAbsolute(value)
      || path.win32.isAbsolute(value)
      || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be a valid project-relative path',
      });
    }
  },
);

const IngestAssetSchema = z.object({
  assetId: StableIdSchema,
  kind: z.enum(['video', 'audio', 'image']),
  sourcePath: IngestSourcePathSchema,
}).strict();

const IngestAssetsSchema = z.array(IngestAssetSchema).min(1).superRefine(
  (assets, context) => {
    const seen = new Set<string>();
    for (const [index, asset] of assets.entries()) {
      if (seen.has(asset.assetId)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'assetId'],
          message: `duplicate assetId: ${asset.assetId}`,
        });
      }
      seen.add(asset.assetId);
    }
  },
);

export type IngestAssetRecord = z.infer<typeof IngestAssetRecordSchema>;
export type IngestManifest = z.infer<typeof IngestManifestSchema>;
export type IngestAsset = z.infer<typeof IngestAssetSchema>;

export interface IngestInput {
  projectDirectory: ProjectDirectoryScope;
  runDirectory: RunDirectoryScope;
  assets: readonly IngestAsset[];
  ffmpegExecutable: string;
  ffprobeExecutable: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface IngestFileSystem {
  openExistingProjectFile(
    scope: ProjectDirectoryScope,
    relativePath: string,
  ): Promise<FileHandle>;
  ensureRunDirectory(
    scope: RunDirectoryScope,
    relativePath: string,
  ): Promise<void>;
  openExistingRunFile(
    scope: RunDirectoryScope,
    relativePath: string,
  ): Promise<FileHandle>;
  openNewRunFile(
    scope: RunDirectoryScope,
    relativePath: string,
  ): Promise<FileHandle>;
  openNewRunReadWriteFile(
    scope: RunDirectoryScope,
    relativePath: string,
  ): Promise<FileHandle>;
}

export interface IngestDependencies {
  runProcess: MediaProcessRunner;
  fileSystem: IngestFileSystem;
  manifestFileOps: IngestManifestFileOps;
}

export interface IngestManifestFileOps {
  writeFile(handle: FileHandle, contents: string): Promise<void>;
  syncFile(handle: FileHandle): Promise<void>;
  rename(action: () => Promise<void>): Promise<void>;
  syncDirectory(action: () => Promise<void>): Promise<void>;
}

export type IngestErrorCode =
  | 'ASSET_PATH_OUTSIDE_PROJECT'
  | 'ASSET_DECODE_FAILED'
  | 'ASSET_HDR_UNSUPPORTED';

export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    readonly assetId: string,
    readonly reasons: string[],
    options?: ErrorOptions,
  ) {
    super(
      `ingest rejected ${assetId}: ${reasons.join('; ')}`,
      options,
    );
    this.name = 'IngestError';
  }
}

const SYSTEM_INGEST_FILE_SYSTEM: IngestFileSystem = {
  openExistingProjectFile: async (scope, relativePath) =>
    await openExistingProjectFile(scope, relativePath),
  ensureRunDirectory: async (scope, relativePath) =>
    await ensureRunDirectory(scope, relativePath),
  openExistingRunFile: async (scope, relativePath) =>
    await openExistingRunFile(scope, relativePath),
  openNewRunFile: async (scope, relativePath) =>
    await openNewRunFile(scope, relativePath),
  openNewRunReadWriteFile: async (scope, relativePath) =>
    await openNewRunReadWriteFile(scope, relativePath),
};

export const createSystemIngestDependencies = (): IngestDependencies => ({
  runProcess: async (command, args, options) =>
    await runProcess(command, args, options),
  fileSystem: {...SYSTEM_INGEST_FILE_SYSTEM},
  manifestFileOps: {
    writeFile: async (handle, contents) => {
      await handle.writeFile(contents, 'utf8');
    },
    syncFile: async (handle) => {
      await handle.sync();
    },
    rename: async (action) => {
      await action();
    },
    syncDirectory: async (action) => {
      await action();
    },
  },
});

type HandleOutcome<T> =
  | {ok: true; value: T}
  | {ok: false; error: unknown};

const withFreshHandle = async <T>(
  openHandle: () => Promise<FileHandle>,
  consumer: (handle: FileHandle) => Promise<T>,
): Promise<T> => {
  const handle = await openHandle();
  let outcome: HandleOutcome<T>;
  try {
    outcome = {ok: true, value: await consumer(handle)};
  } catch (error) {
    outcome = {ok: false, error};
  }

  try {
    await handle.close();
  } catch (closeError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, closeError],
        'media file consumer and close both failed',
        {cause: outcome.error},
      );
    }
    throw closeError;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

interface SourceIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface SourceAuthority {
  identity: SourceIdentity;
  hash: string;
}

const sourceIdentity = (stats: BigIntStats): SourceIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  nlink: stats.nlink,
  size: stats.size,
  mtimeNs: stats.mtimeNs,
  ctimeNs: stats.ctimeNs,
});

const sameSourceIdentity = (
  left: SourceIdentity,
  right: SourceIdentity,
): boolean => left.dev === right.dev
  && left.ino === right.ino
  && left.nlink === right.nlink
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs;

const sourceChanged = (asset: IngestAsset, cause?: unknown): IngestError =>
  new IngestError(
    'ASSET_DECODE_FAILED',
    asset.assetId,
    ['source changed during ingest'],
    cause === undefined ? undefined : {cause},
  );

const inspectSourceHandle = async (
  handle: FileHandle,
  asset: IngestAsset,
): Promise<SourceIdentity> => {
  const stats = await handle.stat({bigint: true});
  if (!stats.isFile() || stats.nlink < 1n) throw sourceChanged(asset);
  return sourceIdentity(stats);
};

const assertSourceIdentity = (
  actual: SourceIdentity,
  expected: SourceIdentity,
  asset: IngestAsset,
): void => {
  if (!sameSourceIdentity(actual, expected)) throw sourceChanged(asset);
};

const mapSourceFailure = (
  asset: IngestAsset,
  reason: string,
  error: unknown,
): IngestError => {
  if (error instanceof IngestError) return error;
  if (errorCode(error) === 'ASSET_PATH_OUTSIDE_PROJECT') {
    return new IngestError(
      'ASSET_PATH_OUTSIDE_PROJECT',
      asset.assetId,
      ['asset source path is outside the project'],
      {cause: error},
    );
  }
  return new IngestError(
    'ASSET_DECODE_FAILED',
    asset.assetId,
    [reason],
    {cause: error},
  );
};

const hashFileHandle = async (handle: FileHandle): Promise<string> => {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
};

const establishSourceAuthority = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
): Promise<SourceAuthority> => {
  try {
    const authority = await withFreshHandle(
      async () => await dependencies.fileSystem.openExistingProjectFile(
        input.projectDirectory,
        asset.sourcePath,
      ),
      async (handle) => {
        const identity = await inspectSourceHandle(handle, asset);
        const hash = await hashFileHandle(handle);
        assertSourceIdentity(await inspectSourceHandle(handle, asset), identity, asset);
        return {
          identity,
          hash,
        };
      },
    );
    await assertProjectSourceIdentity(input, dependencies, asset, authority);
    return authority;
  } catch (error) {
    throw mapSourceFailure(asset, 'asset source could not be hashed', error);
  }
};

const assertProjectSourceIdentity = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
): Promise<void> => {
  try {
    await withFreshHandle(
      async () => await dependencies.fileSystem.openExistingProjectFile(
        input.projectDirectory,
        asset.sourcePath,
      ),
      async (handle) => {
        assertSourceIdentity(
          await inspectSourceHandle(handle, asset),
          authority.identity,
          asset,
        );
      },
    );
  } catch (error) {
    if (error instanceof IngestError) throw error;
    if (errorCode(error) === 'ASSET_PATH_OUTSIDE_PROJECT') {
      throw mapSourceFailure(asset, 'source changed during ingest', error);
    }
    throw sourceChanged(asset, error);
  }
};

const consumeScopedSourceHandle = async <T>(
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  consumer: (handle: FileHandle) => Promise<T>,
): Promise<T> => await withFreshHandle(
  async () => await dependencies.fileSystem.openExistingProjectFile(
    input.projectDirectory,
    asset.sourcePath,
  ),
  async (handle) => {
    assertSourceIdentity(
      await inspectSourceHandle(handle, asset),
      authority.identity,
      asset,
    );
    let outcome: HandleOutcome<T>;
    try {
      outcome = {ok: true, value: await consumer(handle)};
    } catch (error) {
      outcome = {ok: false, error};
    }
    let identityError: unknown;
    try {
      assertSourceIdentity(
        await inspectSourceHandle(handle, asset),
        authority.identity,
        asset,
      );
    } catch (error) {
      identityError = error;
    }
    if (!outcome.ok && identityError !== undefined) {
      if (identityError instanceof IngestError) throw identityError;
      throw new AggregateError(
        [outcome.error, identityError],
        'source consumer and identity verification both failed',
        {cause: outcome.error},
      );
    }
    if (identityError !== undefined) throw identityError;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  },
);

const consumeSource = async <T>(
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  failureReason: string,
  consumer: (handle: FileHandle) => Promise<T>,
): Promise<T> => {
  try {
    let outcome: HandleOutcome<T>;
    try {
      outcome = {
        ok: true,
        value: await consumeScopedSourceHandle(
          input,
          dependencies,
          asset,
          authority,
          consumer,
        ),
      };
    } catch (error) {
      outcome = {ok: false, error};
    }
    let pathError: unknown;
    try {
      await assertProjectSourceIdentity(input, dependencies, asset, authority);
    } catch (error) {
      pathError = error;
    }
    if (!outcome.ok && pathError !== undefined) {
      if (pathError instanceof IngestError) throw pathError;
      throw new AggregateError(
        [outcome.error, pathError],
        'source consumer and project path verification both failed',
        {cause: outcome.error},
      );
    }
    if (pathError !== undefined) throw pathError;
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } catch (error) {
    throw mapSourceFailure(asset, failureReason, error);
  }
};

const consumeRunFile = async <T>(
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  relativePath: string,
  failureReason: string,
  consumer: (handle: FileHandle) => Promise<T>,
): Promise<T> => {
  try {
    return await withFreshHandle(
      async () => await dependencies.fileSystem.openExistingRunFile(
        input.runDirectory,
        relativePath,
      ),
      consumer,
    );
  } catch (error) {
    if (error instanceof IngestError) throw error;
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      [failureReason],
      {cause: error},
    );
  }
};

const hashSource = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
): Promise<string> => await consumeSource(
  input,
  dependencies,
  asset,
  authority,
  'asset source could not be hashed',
  hashFileHandle,
);

const processOptions = (
  input: IngestInput,
  descriptors: readonly number[],
): RunProcessOptions => ({
  extraStdioFds: descriptors,
  ...(input.timeoutMs === undefined ? {} : {timeoutMs: input.timeoutMs}),
  ...(input.signal === undefined ? {} : {signal: input.signal}),
});

const probeHandle = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  handle: FileHandle,
): Promise<MediaProbe> => {
  const result = await dependencies.runProcess(
    input.ffprobeExecutable,
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/dev/fd/3',
    ],
    processOptions(input, [handle.fd]),
  );
  return parseFfprobeJson(result.stdout);
};

const probeSource = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
): Promise<MediaProbe> => await consumeSource(
  input,
  dependencies,
  asset,
  authority,
  'media probe failed',
  async (handle) => await probeHandle(input, dependencies, handle),
);

const probeRun = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  relativePath: string,
): Promise<MediaProbe> => await consumeRunFile(
  input,
  dependencies,
  asset,
  relativePath,
  'transcoded output probe failed',
  async (handle) => await probeHandle(input, dependencies, handle),
);

const videoSampleOffsets = (durationMs: number): number[] => {
  const lastDecodableMs = Math.max(0, durationMs - 1);
  const clamp = (value: number): number => Math.min(
    lastDecodableMs,
    Math.max(0, Math.round(value)),
  );
  const candidates = [
    clamp(0),
    clamp(durationMs / 2),
    clamp(durationMs - 100),
  ];
  return [...new Set(candidates)];
};

const decodeVideoHandle = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  handle: FileHandle,
  offsetMs: number,
): Promise<void> => {
  const result = await dependencies.runProcess(
    input.ffmpegExecutable,
    [
      '-v', 'error',
      '-nostats',
      '-progress', 'pipe:1',
      '-ss', (offsetMs / 1000).toFixed(3),
      '-i', '/dev/fd/3',
      '-map', '0:v:0',
      '-frames:v', '1',
      '-an',
      '-f', 'null',
      '-',
    ],
    processOptions(input, [handle.fd]),
  );
  const decodedFrames = [...result.stdout.matchAll(/^frame=(\d+)$/gm)]
    .map((match) => Number(match[1]));
  if (decodedFrames.length === 0 || Math.max(...decodedFrames) < 1) {
    throw new Error('ffmpeg reported zero decoded video frames');
  }
};

const decodeVideoSourceSamples = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  durationMs: number,
): Promise<void> => {
  for (const offsetMs of videoSampleOffsets(durationMs)) {
    await consumeSource(
      input,
      dependencies,
      asset,
      authority,
      'video sample decode failed',
      async (handle) => await decodeVideoHandle(
        input,
        dependencies,
        handle,
        offsetMs,
      ),
    );
  }
};

const decodeVideoRunSamples = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  relativePath: string,
  durationMs: number,
): Promise<void> => {
  for (const offsetMs of videoSampleOffsets(durationMs)) {
    await consumeRunFile(
      input,
      dependencies,
      asset,
      relativePath,
      'transcoded output sample decode failed',
      async (handle) => await decodeVideoHandle(
        input,
        dependencies,
        handle,
        offsetMs,
      ),
    );
  }
};

const decodeImageSource = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
): Promise<void> => await consumeSource(
  input,
  dependencies,
  asset,
  authority,
  'image decode failed',
  async (handle) => {
    const result = await dependencies.runProcess(
      input.ffmpegExecutable,
      [
        '-v', 'error',
        '-nostats',
        '-progress', 'pipe:1',
        '-i', '/dev/fd/3',
        '-map', '0:v:0',
        '-frames:v', '1',
        '-an',
        '-f', 'null',
        '-',
      ],
      processOptions(input, [handle.fd]),
    );
    const decodedFrames = [...result.stdout.matchAll(/^frame=(\d+)$/gm)]
      .map((match) => Number(match[1]));
    if (decodedFrames.length === 0 || Math.max(...decodedFrames) < 1) {
      throw new Error('ffmpeg reported zero decoded image frames');
    }
  },
);

const decodeAudioSource = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  durationMs: number,
): Promise<void> => await consumeSource(
  input,
  dependencies,
  asset,
  authority,
  'audio sample decode failed',
  async (handle) => {
    const result = await dependencies.runProcess(
      input.ffmpegExecutable,
      [
        '-v', 'error',
        '-nostats',
        '-i', '/dev/fd/3',
        '-map', '0:a:0',
        '-t', (durationMs / 1000).toFixed(3),
        '-frames:a', '1',
        '-vn',
        '-f', 'framehash',
        'pipe:1',
      ],
      processOptions(input, [handle.fd]),
    );
    const hasDecodedFrame = result.stdout.split(/\r?\n/).some((line) => {
      const normalizedLine = line.trim();
      if (normalizedLine.startsWith('#')) return false;
      const fields = normalizedLine.split(',').map((field) => field.trim());
      if (fields.length < 6 || !/^\d+$/.test(fields[0] ?? '')) return false;
      const frameDuration = Number(fields[3]);
      const frameSize = Number(fields[4]);
      return Number.isSafeInteger(frameDuration)
        && frameDuration > 0
        && Number.isSafeInteger(frameSize)
        && frameSize > 0;
    });
    if (!hasDecodedFrame) {
      throw new Error('ffmpeg reported zero decoded audio frames');
    }
  },
);

const rejectDecision = (
  asset: IngestAsset,
  decision: Extract<CompatibilityDecision, {compatibility: 'rejected'}>,
): never => {
  throw new IngestError(
    decision.errorCode,
    asset.assetId,
    decision.reasons,
  );
};

const videoRecord = (
  asset: IngestAsset,
  sourceHash: string,
  stream: VideoStreamProbe,
  probe: MediaProbe,
  compatibility: 'direct' | 'transcoded',
  renderPath: string,
  renderScope: 'project' | 'run',
): IngestAssetRecord => ({
  kind: 'video',
  sourcePath: asset.sourcePath,
  sourceHash,
  renderPath,
  renderScope,
  durationMs: stream.durationMs ?? probe.durationMs,
  width: stream.width,
  height: stream.height,
  videoCodec: stream.codec,
  pixelFormat: stream.pixelFormat,
  colorSpace: stream.colorSpace ?? 'unknown',
  hasAudio: probe.audioStreams.length > 0,
  variableFrameRate: isVariableFrameRate(stream),
  compatibility,
});

const transcodeAsset = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  sourceHash: string,
  sourceStream: VideoStreamProbe,
): Promise<IngestAssetRecord> => {
  const colorPrimaries = sourceStream.colorPrimaries?.toLowerCase();
  const colorTransfer = sourceStream.colorTransfer?.toLowerCase();
  const colorSpace = sourceStream.colorSpace?.toLowerCase();
  const colorRange = sourceStream.colorRange?.toLowerCase();
  if (
    colorPrimaries === undefined
    || colorTransfer === undefined
    || colorSpace === undefined
    || (colorRange !== 'tv' && colorRange !== 'pc')
  ) {
    throw new IngestError(
      'ASSET_HDR_UNSUPPORTED',
      asset.assetId,
      ['color metadata is missing or unsupported'],
    );
  }
  const renderPath = `assets/${asset.assetId}/render.mp4`;
  await dependencies.fileSystem.ensureRunDirectory(
    input.runDirectory,
    `assets/${asset.assetId}`,
  );

  await withFreshHandle(
    async () => await dependencies.fileSystem.openNewRunReadWriteFile(
      input.runDirectory,
      renderPath,
    ),
    async (outputHandle) => {
      await consumeSource(
        input,
        dependencies,
        asset,
        authority,
        'video transcode failed',
        async (sourceHandle) => {
          try {
            await transcodeVideo({
              ffmpegExecutable: input.ffmpegExecutable,
              sourceFd: sourceHandle.fd,
              outputFd: outputHandle.fd,
              sourceColor: {
                primaries: colorPrimaries,
                transfer: colorTransfer,
                space: colorSpace,
                range: colorRange,
              },
              runner: dependencies.runProcess,
              ...(input.timeoutMs === undefined ? {} : {timeoutMs: input.timeoutMs}),
              ...(input.signal === undefined ? {} : {signal: input.signal}),
            });
          } catch (error) {
            throw new IngestError(
              'ASSET_DECODE_FAILED',
              asset.assetId,
              ['video transcode failed'],
              {cause: error},
            );
          }
        },
      );
    },
  );

  const outputProbe = await probeRun(input, dependencies, asset, renderPath);
  const outputStream = outputProbe.videoStreams[0];
  if (outputStream === undefined) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['transcoded output has no video stream'],
    );
  }
  if (outputStream.durationMs === undefined || outputStream.durationMs <= 0) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['transcoded output video duration is missing'],
    );
  }
  await decodeVideoRunSamples(
    input,
    dependencies,
    asset,
    renderPath,
    outputStream.durationMs,
  );
  await consumeRunFile(
    input,
    dependencies,
    asset,
    renderPath,
    'transcoded output hash failed',
    hashFileHandle,
  );

  const outputDecision = decideVideoCompatibility(outputProbe, {decodable: true});
  const validationReasons: string[] = [];
  if (outputProbe.audioStreams.length > 0) {
    validationReasons.push('transcoded output contains audio');
  }
  if (outputDecision.compatibility !== 'direct') {
    validationReasons.push(...outputDecision.reasons);
  }
  if (
    outputStream.averageFrameRate.numerator !== 30
    || outputStream.averageFrameRate.denominator !== 1
    || outputStream.realFrameRate.numerator !== 30
    || outputStream.realFrameRate.denominator !== 1
    || isVariableFrameRate(outputStream)
  ) {
    validationReasons.push('transcoded output frame rate must be 30 fps');
  }
  if (
    outputStream.colorPrimaries?.toLowerCase() !== 'bt709'
    || outputStream.colorTransfer?.toLowerCase() !== 'bt709'
    || outputStream.colorSpace?.toLowerCase() !== 'bt709'
    || outputStream.colorRange?.toLowerCase() !== 'tv'
  ) {
    validationReasons.push('transcoded output must use limited-range BT.709');
  }
  if (validationReasons.length > 0) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      validationReasons,
    );
  }

  return videoRecord(
    asset,
    sourceHash,
    outputStream,
    outputProbe,
    'transcoded',
    renderPath,
    'run',
  );
};

const ingestVideo = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  sourceHash: string,
  probe: MediaProbe,
): Promise<IngestAssetRecord> => {
  const stream = probe.videoStreams[0];
  if (stream === undefined) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['video stream is missing'],
    );
  }
  if (stream.durationMs === undefined || stream.durationMs <= 0) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['primary video duration is missing'],
    );
  }
  await decodeVideoSourceSamples(
    input,
    dependencies,
    asset,
    authority,
    stream.durationMs,
  );
  const decision = decideVideoCompatibility(probe, {decodable: true});
  if (decision.compatibility === 'rejected') rejectDecision(asset, decision);
  if (decision.compatibility === 'transcoded') {
    return await transcodeAsset(
      input,
      dependencies,
      asset,
      authority,
      sourceHash,
      stream,
    );
  }
  return videoRecord(
    asset,
    sourceHash,
    stream,
    probe,
    'direct',
    asset.sourcePath,
    'project',
  );
};

const ingestAudio = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  sourceHash: string,
  probe: MediaProbe,
): Promise<IngestAssetRecord> => {
  const stream = probe.audioStreams[0];
  if (stream === undefined) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['audio stream is missing'],
    );
  }
  if (stream.durationMs === undefined || stream.durationMs <= 0) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['primary audio duration is missing'],
    );
  }
  await decodeAudioSource(input, dependencies, asset, authority, stream.durationMs);
  return {
    kind: 'audio',
    sourcePath: asset.sourcePath,
    sourceHash,
    renderPath: asset.sourcePath,
    renderScope: 'project',
    durationMs: stream.durationMs,
    compatibility: 'direct',
  };
};

const ingestImage = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  authority: SourceAuthority,
  sourceHash: string,
  probe: MediaProbe,
): Promise<IngestAssetRecord> => {
  const stream = probe.videoStreams[0];
  if (stream === undefined) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['image stream is missing'],
    );
  }
  await decodeImageSource(input, dependencies, asset, authority);
  return {
    kind: 'image',
    sourcePath: asset.sourcePath,
    sourceHash,
    renderPath: asset.sourcePath,
    renderScope: 'project',
    width: stream.width,
    height: stream.height,
    compatibility: 'direct',
  };
};

const ingestAsset = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
): Promise<IngestAssetRecord> => {
  const authority = await establishSourceAuthority(input, dependencies, asset);
  const probe = await probeSource(input, dependencies, asset, authority);
  const record = asset.kind === 'video'
    ? await ingestVideo(input, dependencies, asset, authority, authority.hash, probe)
    : asset.kind === 'audio'
      ? await ingestAudio(input, dependencies, asset, authority, authority.hash, probe)
      : await ingestImage(input, dependencies, asset, authority, authority.hash, probe);
  const finalSourceHash = await hashSource(input, dependencies, asset, authority);
  if (finalSourceHash !== authority.hash) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['source changed during ingest'],
    );
  }
  return record;
};

interface InodeIdentity {
  dev: bigint;
  ino: bigint;
}

interface RunPublication {
  readonly published: boolean;
  rename(): Promise<void>;
  syncDirectory(): Promise<void>;
  rollback(): Promise<void>;
  close(): Promise<void>;
}

const inodeIdentity = (stats: BigIntStats): InodeIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
});

const sameInode = (left: InodeIdentity, right: InodeIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const descriptorFilePath = async (descriptor: number): Promise<string> => {
  const {stdout} = await execFileAsync(
    '/usr/sbin/lsof',
    ['-a', '-p', String(process.pid), '-d', String(descriptor), '-F0pn'],
    {encoding: 'utf8', maxBuffer: 64 * 1024},
  );
  const fields = String(stdout)
    .split('\0')
    .map((field) => field.replace(/^\n+/, ''));
  const nameField = fields.find((field) => field.startsWith('n/'));
  if (nameField === undefined) {
    throw new Error(`could not resolve path for open descriptor ${descriptor}`);
  }
  return nameField.slice(1);
};

const assertScopedRunInode = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  relativePath: string,
  expected: InodeIdentity,
): Promise<void> => await withFreshHandle(
  async () => await dependencies.fileSystem.openExistingRunFile(
    input.runDirectory,
    relativePath,
  ),
  async (handle) => {
    const stats = await handle.stat({bigint: true});
    if (!stats.isFile() || !sameInode(inodeIdentity(stats), expected)) {
      throw new Error(`Run file identity changed: ${relativePath}`);
    }
  },
);

const prepareRunPublication = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  tempPath: string,
  finalPath: string,
  tempHandle: FileHandle,
): Promise<RunPublication> => {
  if (path.posix.dirname(tempPath) !== path.posix.dirname(finalPath)) {
    throw new Error('atomic Run publication requires one parent directory');
  }
  const tempStats = await tempHandle.stat({bigint: true});
  if (!tempStats.isFile() || tempStats.nlink !== 1n) {
    throw new Error('manifest temporary file identity is invalid');
  }
  const tempIdentity = inodeIdentity(tempStats);
  await assertScopedRunInode(input, dependencies, tempPath, tempIdentity);

  const descriptorPath = await descriptorFilePath(tempHandle.fd);
  if (path.basename(descriptorPath) !== path.posix.basename(tempPath)) {
    throw new Error('manifest temporary file path changed after scoped open');
  }
  const descriptorStats = await lstat(descriptorPath, {bigint: true});
  if (!descriptorStats.isFile() || !sameInode(inodeIdentity(descriptorStats), tempIdentity)) {
    throw new Error('manifest temporary descriptor no longer names the scoped file');
  }

  const parentPath = path.dirname(descriptorPath);
  const parentStats = await lstat(parentPath, {bigint: true});
  if (
    parentStats.isSymbolicLink()
    || !parentStats.isDirectory()
    || await realpath(parentPath) !== parentPath
  ) {
    throw new Error('manifest parent directory is not a stable plain directory');
  }
  const parentIdentity = inodeIdentity(parentStats);
  const parentHandle = await open(
    parentPath,
    constants.O_RDONLY | O_NOFOLLOW_ANY,
  );
  try {
    const heldParentStats = await parentHandle.stat({bigint: true});
    if (
      !heldParentStats.isDirectory()
      || !sameInode(inodeIdentity(heldParentStats), parentIdentity)
    ) {
      throw new Error('manifest parent directory changed while anchoring');
    }
    const parentVolumePath = path.join(
      '/.vol',
      String(parentIdentity.dev),
      String(parentIdentity.ino),
    );
    const anchoredParentStats = await lstat(parentVolumePath, {bigint: true});
    if (
      !anchoredParentStats.isDirectory()
      || !sameInode(inodeIdentity(anchoredParentStats), parentIdentity)
    ) {
      throw new Error('manifest parent inode authority is unavailable');
    }
    const anchoredTempPath = path.join(parentVolumePath, path.basename(descriptorPath));
    const anchoredFinalPath = path.join(parentVolumePath, path.posix.basename(finalPath));
    let published = false;

    const rollback = async (): Promise<void> => {
      if (!published) return;
      const current = await lstat(anchoredFinalPath, {bigint: true});
      if (!current.isFile() || !sameInode(inodeIdentity(current), tempIdentity)) {
        throw new Error('refusing to rollback a replaced manifest file');
      }
      await unlink(anchoredFinalPath);
      published = false;
      await parentHandle.sync();
    };

    return {
      get published() {
        return published;
      },
      rename: async () => {
        await assertScopedRunInode(input, dependencies, tempPath, tempIdentity);
        await link(anchoredTempPath, anchoredFinalPath);
        published = true;
        try {
          await unlink(anchoredTempPath);
          await assertScopedRunInode(input, dependencies, finalPath, tempIdentity);
        } catch (error) {
          await rollback().catch((rollbackError) => {
            throw new AggregateError(
              [error, rollbackError],
              'manifest publication and rollback both failed',
              {cause: error},
            );
          });
          throw error;
        }
      },
      syncDirectory: async () => {
        await parentHandle.sync();
      },
      rollback,
      close: async () => {
        await parentHandle.close();
      },
    };
  } catch (error) {
    await parentHandle.close().catch(() => undefined);
    throw error;
  }
};

const writeManifest = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  manifest: IngestManifest,
): Promise<void> => {
  const finalPath = 'asset-manifest.json';
  const tempPath = `.asset-manifest.${process.pid}.${randomUUID()}.tmp`;
  await withFreshHandle(
    async () => await dependencies.fileSystem.openNewRunFile(
      input.runDirectory,
      tempPath,
    ),
    async (handle) => {
      let publication: RunPublication | undefined;
      try {
        await dependencies.manifestFileOps.writeFile(
          handle,
          `${JSON.stringify(manifest, null, 2)}\n`,
        );
        await dependencies.manifestFileOps.syncFile(handle);
        publication = await prepareRunPublication(
          input,
          dependencies,
          tempPath,
          finalPath,
          handle,
        );
        await dependencies.manifestFileOps.rename(
          async () => await publication!.rename(),
        );
        await dependencies.manifestFileOps.syncDirectory(
          async () => await publication!.syncDirectory(),
        );
      } catch (error) {
        if (publication?.published) {
          try {
            await publication.rollback();
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'manifest publication failed and final rollback failed',
              {cause: error},
            );
          }
        }
        throw error;
      } finally {
        await publication?.close();
      }
    },
  );
};

const parseIngestAssets = (assets: readonly IngestAsset[]): IngestAsset[] => {
  try {
    return IngestAssetsSchema.parse([...assets]);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const sourcePathIssue = error.issues.find((issue) =>
        typeof issue.path[0] === 'number' && issue.path[1] === 'sourcePath');
      if (sourcePathIssue !== undefined) {
        const index = sourcePathIssue.path[0] as number;
        const rawAsset = assets[index] as unknown;
        const assetId = rawAsset !== null
          && typeof rawAsset === 'object'
          && 'assetId' in rawAsset
          && typeof rawAsset.assetId === 'string'
          ? rawAsset.assetId
          : 'unknown';
        throw new IngestError(
          'ASSET_PATH_OUTSIDE_PROJECT',
          assetId,
          ['asset source path is outside the project'],
          {cause: error},
        );
      }
    }
    throw error;
  }
};

export async function runIngest(
  input: IngestInput,
  dependencies: IngestDependencies,
): Promise<{manifestPath: 'asset-manifest.json'; manifest: IngestManifest}> {
  if (input.ffmpegExecutable.length === 0 || input.ffprobeExecutable.length === 0) {
    throw new TypeError('ffmpegExecutable and ffprobeExecutable are required');
  }
  const assets = parseIngestAssets(input.assets)
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const records: Record<string, IngestAssetRecord> = {};
  for (const asset of assets) {
    records[asset.assetId] = await ingestAsset(input, dependencies, asset);
  }
  const manifest = IngestManifestSchema.parse({version: 1, assets: records});
  await writeManifest(input, dependencies, manifest);
  return {manifestPath: 'asset-manifest.json', manifest};
}
