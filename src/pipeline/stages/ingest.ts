import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
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

const IngestAssetSchema = z.object({
  assetId: StableIdSchema,
  kind: z.enum(['video', 'audio', 'image']),
  sourcePath: ProjectRelativePathSchema,
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

const consumeSource = async <T>(
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  failureReason: string,
  consumer: (handle: FileHandle) => Promise<T>,
): Promise<T> => {
  try {
    return await withFreshHandle(
      async () => await dependencies.fileSystem.openExistingProjectFile(
        input.projectDirectory,
        asset.sourcePath,
      ),
      consumer,
    );
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

const hashSource = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
): Promise<string> => await consumeSource(
  input,
  dependencies,
  asset,
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
): Promise<MediaProbe> => await consumeSource(
  input,
  dependencies,
  asset,
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
  const candidates = [
    0,
    Math.min(lastDecodableMs, Math.round(durationMs / 2)),
    Math.min(lastDecodableMs, Math.max(0, durationMs - 100)),
  ];
  return [...new Set(candidates)];
};

const decodeVideoHandle = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  handle: FileHandle,
  offsetMs: number,
): Promise<void> => {
  await dependencies.runProcess(
    input.ffmpegExecutable,
    [
      '-v', 'error',
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
};

const decodeVideoSourceSamples = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
  durationMs: number,
): Promise<void> => {
  for (const offsetMs of videoSampleOffsets(durationMs)) {
    await consumeSource(
      input,
      dependencies,
      asset,
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
): Promise<void> => await consumeSource(
  input,
  dependencies,
  asset,
  'image decode failed',
  async (handle) => {
    await dependencies.runProcess(
      input.ffmpegExecutable,
      [
        '-v', 'error',
        '-i', '/dev/fd/3',
        '-map', '0:v:0',
        '-frames:v', '1',
        '-an',
        '-f', 'null',
        '-',
      ],
      processOptions(input, [handle.fd]),
    );
  },
);

const decodeAudioSource = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
): Promise<void> => await consumeSource(
  input,
  dependencies,
  asset,
  'audio sample decode failed',
  async (handle) => {
    await dependencies.runProcess(
      input.ffmpegExecutable,
      [
        '-v', 'error',
        '-i', '/dev/fd/3',
        '-map', '0:a:0',
        '-t', '0.250',
        '-vn',
        '-f', 'null',
        '-',
      ],
      processOptions(input, [handle.fd]),
    );
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
  durationMs: probe.durationMs,
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
  sourceHash: string,
): Promise<IngestAssetRecord> => {
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
        'video transcode failed',
        async (sourceHandle) => {
          try {
            await transcodeVideo({
              ffmpegExecutable: input.ffmpegExecutable,
              sourceFd: sourceHandle.fd,
              outputFd: outputHandle.fd,
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
  await decodeVideoRunSamples(
    input,
    dependencies,
    asset,
    renderPath,
    outputProbe.durationMs,
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
  const outputStream = outputProbe.videoStreams[0];
  if (outputStream === undefined) validationReasons.push('transcoded output has no video stream');
  if (validationReasons.length > 0 || outputStream === undefined) {
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
  await decodeVideoSourceSamples(input, dependencies, asset, probe.durationMs);
  const decision = decideVideoCompatibility(probe, {decodable: true});
  if (decision.compatibility === 'rejected') rejectDecision(asset, decision);
  if (decision.compatibility === 'transcoded') {
    return await transcodeAsset(input, dependencies, asset, sourceHash);
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
  sourceHash: string,
  probe: MediaProbe,
): Promise<IngestAssetRecord> => {
  if (probe.audioStreams.length === 0) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['audio stream is missing'],
    );
  }
  await decodeAudioSource(input, dependencies, asset);
  return {
    kind: 'audio',
    sourcePath: asset.sourcePath,
    sourceHash,
    renderPath: asset.sourcePath,
    renderScope: 'project',
    durationMs: probe.durationMs,
    compatibility: 'direct',
  };
};

const ingestImage = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  asset: IngestAsset,
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
  await decodeImageSource(input, dependencies, asset);
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
  const initialSourceHash = await hashSource(input, dependencies, asset);
  const probe = await probeSource(input, dependencies, asset);
  const record = asset.kind === 'video'
    ? await ingestVideo(input, dependencies, asset, initialSourceHash, probe)
    : asset.kind === 'audio'
      ? await ingestAudio(input, dependencies, asset, initialSourceHash, probe)
      : await ingestImage(input, dependencies, asset, initialSourceHash, probe);
  const finalSourceHash = await hashSource(input, dependencies, asset);
  if (finalSourceHash !== initialSourceHash) {
    throw new IngestError(
      'ASSET_DECODE_FAILED',
      asset.assetId,
      ['source changed during ingest'],
    );
  }
  return record;
};

const writeManifest = async (
  input: IngestInput,
  dependencies: IngestDependencies,
  manifest: IngestManifest,
): Promise<void> => await withFreshHandle(
  async () => await dependencies.fileSystem.openNewRunFile(
    input.runDirectory,
    'asset-manifest.json',
  ),
  async (handle) => {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  },
);

export async function runIngest(
  input: IngestInput,
  dependencies: IngestDependencies,
): Promise<{manifestPath: 'asset-manifest.json'; manifest: IngestManifest}> {
  if (input.ffmpegExecutable.length === 0 || input.ffprobeExecutable.length === 0) {
    throw new TypeError('ffmpegExecutable and ffprobeExecutable are required');
  }
  const assets = IngestAssetsSchema.parse([...input.assets])
    .sort((left, right) => left.assetId.localeCompare(right.assetId));
  const records: Record<string, IngestAssetRecord> = {};
  for (const asset of assets) {
    records[asset.assetId] = await ingestAsset(input, dependencies, asset);
  }
  const manifest = IngestManifestSchema.parse({version: 1, assets: records});
  await writeManifest(input, dependencies, manifest);
  return {manifestPath: 'asset-manifest.json', manifest};
}
