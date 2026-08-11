import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {formatSrt} from '../../captions/srt';
import type {ProjectInputs} from '../../domain/load-project';
import {ReviewSchema, type Review} from '../../domain/review-schema';
import {CompiledTimelineSchema, type CompiledTimeline} from '../../domain/timeline-schema';
import {
  createOutputStore,
  ensureOutputDirectory,
  ensureRunDirectory,
  openExistingOutputFile,
  openExistingRunFile,
  openNewOutputFile,
  openNewOutputReadWriteFile,
  openNewRunFile,
  openNewRunReadWriteFile,
  type CurrentPointer,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {openExistingProjectFile} from '../../fs/project-paths';
import {parseFfprobeJson} from '../../media/ffprobe';
import {
  validateSrtWithinDuration,
  verifyReleaseOutputFile,
  type ReleaseVerificationReport,
} from '../../media/release-verify';
import {fingerprintValue} from '../fingerprint';
import {
  DraftReportSchema,
  type ArtifactReference,
  type DraftReport,
} from './draft';
import {evaluateReview, ReviewGateError} from './review';
import {
  runProcess as runSystemProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../../process/run-process';
import {
  renderTimelineVideo as renderSystemTimelineVideo,
  type RenderTimelineVideoInput,
} from '../../remotion/render';

export const RELEASE_STAGE_IDS = [
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
  'review',
  'release',
] as const;

export const RELEASE_FIXED_PROFILE = {
  width: 1920,
  height: 1080,
  fps: 30,
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioSampleRate: 48_000,
  audioChannels: 2,
  container: 'mp4',
  thumbnailWidth: 1280,
  thumbnailHeight: 720,
} as const;

export interface ReleaseStageFingerprintInput {
  draft: Pick<
    DraftReport['outputs'],
    'contactSheet' | 'reviewFrames' | 'audio' | 'audioMixFingerprint'
  >;
  compileInputHashes: Record<string, string>;
  compileStageFingerprint?: string | null;
  compiledTimeline?: CompiledTimeline;
  review: Review;
  preflightEnvironmentFingerprint: string;
  profile?: Record<string, unknown>;
  algorithmVersion?: string;
}

export const releaseStageFingerprint = ({
  draft,
  compileInputHashes,
  compileStageFingerprint = null,
  compiledTimeline,
  review,
  preflightEnvironmentFingerprint,
  profile = RELEASE_FIXED_PROFILE,
  algorithmVersion = 'release-stage-v1',
}: ReleaseStageFingerprintInput): string => fingerprintValue({
  algorithmVersion,
  draftArtifacts: {
    contactSheet: draft.contactSheet,
    reviewFrames: draft.reviewFrames,
    audio: draft.audio,
    audioMixFingerprint: draft.audioMixFingerprint ?? null,
  },
  compileInputHashes,
  compileStageFingerprint,
  compiledTimelineFingerprint: compiledTimeline === undefined
    ? null
    : fingerprintValue(compiledTimeline),
  approvedReview: review,
  preflightEnvironmentFingerprint,
  profile,
});

export interface ReleaseToolIdentity {
  realPath: string;
  sha256: string;
}

export interface ReleasePreflightSnapshot {
  toolIdentities: {
    ffmpeg: ReleaseToolIdentity | null;
    ffprobe: ReleaseToolIdentity | null;
    qtFaststart: ReleaseToolIdentity | null;
  };
  environmentFingerprint: string;
}

export type ReleaseStageErrorCode =
  | 'RELEASE_ARTIFACT_CHANGED'
  | 'RELEASE_INTERMEDIATE_EMPTY'
  | 'RELEASE_TOOL_MISSING'
  | 'RELEASE_THUMBNAIL_INVALID';

export class ReleaseStageError extends Error {
  constructor(readonly code: ReleaseStageErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ReleaseStageError';
  }
}

export interface ReleaseStageInput extends ProjectInputs {
  runDirectory: RunDirectoryScope;
  runId: string;
  preflight: ReleasePreflightSnapshot;
  compileStageFingerprint?: string;
  signal?: AbortSignal;
  now?: () => string;
}

type ReleaseRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<ProcessResult>;

export interface ReleaseStageDependencies {
  renderTimelineVideo?: (input: RenderTimelineVideoInput) => Promise<void>;
  runProcess?: ReleaseRunner;
  outputStore?: ReturnType<typeof createOutputStore>;
  publishCurrent?: boolean;
  profile?: Record<string, unknown>;
  algorithmVersion?: string;
}

export interface OutputArtifactReference extends ArtifactReference {
  path: `releases/${string}/${string}`;
}

export interface ReleaseStageOutputs {
  mutedVideo: ArtifactReference;
  intermediate: ArtifactReference;
  finalVideo: OutputArtifactReference;
  subtitles: OutputArtifactReference;
  thumbnail: OutputArtifactReference;
  review: OutputArtifactReference;
  validationReport: OutputArtifactReference;
  checksums: OutputArtifactReference;
  releaseFingerprint: string;
  verification: ReleaseVerificationReport;
}

export interface ReleaseStageResult {
  outputs: ReleaseStageOutputs;
  current: CurrentPointer;
}

const hashBytes = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const withRunRead = async <Output>(
  runDirectory: RunDirectoryScope,
  relativePath: string,
  action: (handle: Awaited<ReturnType<typeof openExistingRunFile>>) => Promise<Output>,
): Promise<Output> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    return await action(handle);
  } finally {
    await handle.close();
  }
};

const withOutputRead = async <Output>(
  outputDirectory: OutputDirectoryScope,
  relativePath: string,
  action: (handle: Awaited<ReturnType<typeof openExistingOutputFile>>) => Promise<Output>,
): Promise<Output> => {
  const handle = await openExistingOutputFile(outputDirectory, relativePath);
  try {
    return await action(handle);
  } finally {
    await handle.close();
  }
};

const hashRunFile = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => await withRunRead(
  runDirectory,
  relativePath,
  async (handle) => hashBytes(await handle.readFile()),
);

const hashOutputFile = async (
  outputDirectory: OutputDirectoryScope,
  relativePath: string,
): Promise<string> => await withOutputRead(
  outputDirectory,
  relativePath,
  async (handle) => hashBytes(await handle.readFile()),
);

const readRunText = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => await withRunRead(
  runDirectory,
  relativePath,
  async (handle) => await handle.readFile('utf8'),
);

const readRunJson = async <Output>(
  runDirectory: RunDirectoryScope,
  relativePath: string,
  parse: (value: unknown) => Output,
): Promise<Output> => parse(JSON.parse(await readRunText(runDirectory, relativePath)));

const writeRunBuffer = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  bytes: Buffer,
): Promise<ArtifactReference> => {
  await ensureRunDirectory(runDirectory, path.posix.dirname(relativePath));
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {path: relativePath, sha256: hashBytes(bytes)};
};

const writeOutputText = async (
  outputDirectory: OutputDirectoryScope,
  relativePath: `releases/${string}/${string}`,
  contents: string,
): Promise<OutputArtifactReference> => {
  await ensureOutputDirectory(outputDirectory, path.posix.dirname(relativePath));
  const handle = await openNewOutputFile(outputDirectory, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {path: relativePath, sha256: hashBytes(contents)};
};

const writeOutputJson = async (
  outputDirectory: OutputDirectoryScope,
  relativePath: `releases/${string}/${string}`,
  value: unknown,
): Promise<OutputArtifactReference> => await writeOutputText(
  outputDirectory,
  relativePath,
  `${JSON.stringify(value, null, 2)}\n`,
);

const readProjectOrRunBytes = async (
  input: ReleaseStageInput,
  relativePath: string,
): Promise<Buffer> => {
  try {
    const projectHandle = await openExistingProjectFile(input.projectDirectory, relativePath);
    try {
      return await projectHandle.readFile();
    } finally {
      await projectHandle.close();
    }
  } catch (projectError) {
    try {
      return await withRunRead(input.runDirectory, relativePath, async (handle) => await handle.readFile());
    } catch (runError) {
      throw new AggregateError([projectError, runError], `render asset not found: ${relativePath}`);
    }
  }
};

const preparePublicDir = async (
  input: ReleaseStageInput,
  timeline: CompiledTimeline,
  publicDir: string,
): Promise<void> => {
  const renderPaths = new Set(timeline.visualClips.map((clip) => clip.renderPath));
  for (const renderPath of renderPaths) {
    const target = path.join(publicDir, renderPath);
    await mkdir(path.dirname(target), {recursive: true});
    await writeFile(target, await readProjectOrRunBytes(input, renderPath));
  }
};

const assertReleaseTools = (
  preflight: ReleasePreflightSnapshot,
): {
  ffmpeg: ReleaseToolIdentity;
  ffprobe: ReleaseToolIdentity;
  qtFaststart: ReleaseToolIdentity;
} => {
  const ffmpeg = preflight.toolIdentities.ffmpeg;
  const ffprobe = preflight.toolIdentities.ffprobe;
  const qtFaststart = preflight.toolIdentities.qtFaststart;
  if (ffmpeg === null || ffprobe === null || qtFaststart === null) {
    throw new ReleaseStageError(
      'RELEASE_TOOL_MISSING',
      'release requires preflight-verified ffmpeg, ffprobe, and qt-faststart tools',
    );
  }
  return {ffmpeg, ffprobe, qtFaststart};
};

const assertArtifactUnchanged = async (
  runDirectory: RunDirectoryScope,
  artifact: ArtifactReference,
): Promise<void> => {
  const actual = await hashRunFile(runDirectory, artifact.path);
  if (actual !== artifact.sha256) {
    throw new ReleaseStageError(
      'RELEASE_ARTIFACT_CHANGED',
      `${artifact.path} hash changed: expected ${artifact.sha256}, got ${actual}`,
    );
  }
};

const loadApprovedReview = async (
  input: ReleaseStageInput,
  draftReport: DraftReport,
): Promise<Review> => {
  const review = await readRunJson(input.runDirectory, 'review.json', (value) => ReviewSchema.parse(value));
  const evidencePaths = [
    draftReport.outputs.contactSheet.path,
    ...draftReport.outputs.reviewFrames.map((frame) => frame.path),
  ];
  const gate = await evaluateReview({
    projectId: input.project.id,
    runId: input.runId,
    evidencePaths,
    review,
  });
  if (gate.state !== 'passed' || gate.review === undefined) {
    throw new ReviewGateError('release requires an approved draft review');
  }
  return gate.review;
};

const renderFinalMutedVideo = async (
  input: ReleaseStageInput,
  timeline: CompiledTimeline,
  renderTimelineVideo: (renderInput: RenderTimelineVideoInput) => Promise<void>,
): Promise<ArtifactReference> => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-video-release-'));
  try {
    const publicDir = path.join(workspace, 'public');
    const outputLocation = path.join(workspace, 'muted-video.mp4');
    await preparePublicDir(input, timeline, publicDir);
    await renderTimelineVideo({timeline, publicDir, outputLocation});
    return await writeRunBuffer(
      input.runDirectory,
      'release/muted-video.mp4',
      await readFile(outputLocation),
    );
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
};

const muxIntermediate = async (
  input: ReleaseStageInput,
  mutedVideoPath: string,
  mixedAudioPath: string,
  ffmpegExecutable: string,
  runner: ReleaseRunner,
): Promise<ArtifactReference> => {
  await ensureRunDirectory(input.runDirectory, 'release');
  const videoHandle = await openExistingRunFile(input.runDirectory, mutedVideoPath);
  const audioHandle = await openExistingRunFile(input.runDirectory, mixedAudioPath);
  const outputHandle = await openNewRunReadWriteFile(input.runDirectory, 'release/final-intermediate.mp4');
  try {
    await runner(ffmpegExecutable, [
      '-y',
      '-i', '/dev/fd/3',
      '-i', '/dev/fd/4',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'mp4',
      '/dev/fd/5',
    ], {
      ...(input.signal === undefined ? {} : {signal: input.signal}),
      extraStdioFds: [videoHandle.fd, audioHandle.fd, outputHandle.fd],
    });
    await outputHandle.sync();
  } finally {
    await Promise.allSettled([videoHandle.close(), audioHandle.close(), outputHandle.close()]);
  }
  const bytes = await withRunRead(
    input.runDirectory,
    'release/final-intermediate.mp4',
    async (handle) => await handle.readFile(),
  );
  if (bytes.byteLength === 0) {
    throw new ReleaseStageError('RELEASE_INTERMEDIATE_EMPTY', 'release intermediate MP4 is empty');
  }
  return {path: 'release/final-intermediate.mp4', sha256: hashBytes(bytes)};
};

const faststartFinal = async (
  input: ReleaseStageInput,
  outputDirectory: OutputDirectoryScope,
  qtFaststartExecutable: string,
  runner: ReleaseRunner,
): Promise<OutputArtifactReference> => {
  const finalPath = `releases/${input.runId}/final.mp4` as const;
  const inputHandle = await openExistingRunFile(input.runDirectory, 'release/final-intermediate.mp4');
  const outputHandle = await openNewOutputReadWriteFile(outputDirectory, finalPath);
  try {
    await runner(qtFaststartExecutable, ['/dev/fd/3', '/dev/fd/4'], {
      ...(input.signal === undefined ? {} : {signal: input.signal}),
      extraStdioFds: [inputHandle.fd, outputHandle.fd],
    });
    await outputHandle.sync();
  } finally {
    await Promise.allSettled([inputHandle.close(), outputHandle.close()]);
  }
  const finalSha = await hashOutputFile(outputDirectory, finalPath);
  return {path: finalPath, sha256: finalSha};
};

const generateThumbnail = async (
  input: ReleaseStageInput,
  outputDirectory: OutputDirectoryScope,
  reviewFramePath: string,
  ffmpegExecutable: string,
  ffprobeExecutable: string,
  runner: ReleaseRunner,
): Promise<OutputArtifactReference> => {
  const thumbnailPath = `releases/${input.runId}/thumbnail.jpg` as const;
  const inputHandle = await openExistingRunFile(input.runDirectory, reviewFramePath);
  const outputHandle = await openNewOutputReadWriteFile(outputDirectory, thumbnailPath);
  try {
    await runner(ffmpegExecutable, [
      '-v', 'error',
      '-y',
      '-i', '/dev/fd/3',
      '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2',
      '-frames:v', '1',
      '-f', 'image2',
      '/dev/fd/4',
    ], {
      ...(input.signal === undefined ? {} : {signal: input.signal}),
      extraStdioFds: [inputHandle.fd, outputHandle.fd],
    });
    await outputHandle.sync();
  } finally {
    await Promise.allSettled([inputHandle.close(), outputHandle.close()]);
  }

  const probe = await withOutputRead(outputDirectory, thumbnailPath, async (handle) => {
    const result = await runner(ffprobeExecutable, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/dev/fd/3',
    ], {
      ...(input.signal === undefined ? {} : {signal: input.signal}),
      extraStdioFds: [handle.fd],
    });
    return parseFfprobeJson(result.stdout);
  });
  const thumbnailStream = probe.videoStreams[0];
  if (
    thumbnailStream === undefined
    || thumbnailStream.width !== 1280
    || thumbnailStream.height !== 720
  ) {
    throw new ReleaseStageError('RELEASE_THUMBNAIL_INVALID', 'release thumbnail must be 1280x720');
  }
  return {path: thumbnailPath, sha256: await hashOutputFile(outputDirectory, thumbnailPath)};
};

const writeChecksums = async (
  outputDirectory: OutputDirectoryScope,
  runId: string,
  artifacts: readonly OutputArtifactReference[],
): Promise<OutputArtifactReference> => {
  const lines = artifacts
    .map((artifact) => `${artifact.sha256.slice('sha256:'.length)}  ${artifact.path}`)
    .sort((left, right) => left.localeCompare(right));
  return await writeOutputText(
    outputDirectory,
    `releases/${runId}/checksums.sha256`,
    `${lines.join('\n')}\n`,
  );
};

export const releaseCurrentPointer = (
  runId: string,
  publishedAt: string,
): CurrentPointer => {
  const timestamp = new Date(publishedAt);
  if (
    Number.isNaN(timestamp.valueOf())
    || timestamp.toISOString() !== publishedAt
  ) {
    throw new TypeError('publishedAt must be a canonical ISO timestamp');
  }
  return {
    runId,
    relativePath: `releases/${runId}`,
    preset: 'release',
    stageIds: [...RELEASE_STAGE_IDS],
    completedStage: 'release',
    state: 'passed',
    publishedAt,
  };
};

const releaseSrtFromTimeline = (timeline: CompiledTimeline): string => formatSrt({
  version: 1,
  sourceNarrationHash: timeline.narration.audioPath,
  cues: timeline.captions.map((caption) => ({
    id: caption.id,
    segmentId: caption.segmentId,
    text: caption.text,
    startMs: Math.round(caption.startFrame * 1000 / timeline.fps),
    endMs: Math.round(caption.endFrame * 1000 / timeline.fps),
  })),
});

export const runRelease = async (
  input: ReleaseStageInput,
  dependencies: ReleaseStageDependencies = {},
): Promise<ReleaseStageResult> => {
  const tools = assertReleaseTools(input.preflight);
  const runner = dependencies.runProcess ?? runSystemProcess;
  const outputStore = dependencies.outputStore ?? createOutputStore(input.workspaceRoot);
  const timeline = await readRunJson(
    input.runDirectory,
    'compiled-timeline.json',
    (value) => CompiledTimelineSchema.parse(value),
  );
  const draftReport = await readRunJson(
    input.runDirectory,
    'draft/draft-report.json',
    (value) => DraftReportSchema.parse(value),
  );
  if (draftReport.projectId !== input.project.id) {
    throw new ReleaseStageError(
      'RELEASE_ARTIFACT_CHANGED',
      `draft report belongs to ${draftReport.projectId}, expected ${input.project.id}`,
    );
  }
  const audioArtifacts = draftReport.outputs.audio;
  if (
    audioArtifacts.filterGraph.path !== 'audio/filter-graph.txt'
    || audioArtifacts.mixedAudio.path !== 'audio/mixed-normalized.wav'
  ) {
    throw new ReleaseStageError(
      'RELEASE_ARTIFACT_CHANGED',
      'draft report must reference fixed Draft-owned audio artifacts',
    );
  }
  await assertArtifactUnchanged(input.runDirectory, audioArtifacts.filterGraph);
  await assertArtifactUnchanged(input.runDirectory, audioArtifacts.mixedAudio);
  const review = await loadApprovedReview(input, draftReport);
  const mutedVideo = await renderFinalMutedVideo(
    input,
    timeline,
    dependencies.renderTimelineVideo ?? renderSystemTimelineVideo,
  );
  const intermediate = await muxIntermediate(
    input,
    mutedVideo.path,
    audioArtifacts.mixedAudio.path,
    tools.ffmpeg.realPath,
    runner,
  );

  const outputDirectory = await outputStore.createRelease(input.project.id, input.runId);
  const finalVideo = await faststartFinal(
    input,
    outputDirectory,
    tools.qtFaststart.realPath,
    runner,
  );
  const verification = await verifyReleaseOutputFile({
    outputDirectory,
    relativePath: finalVideo.path,
    ffmpegExecutable: tools.ffmpeg.realPath,
    ffprobeExecutable: tools.ffprobe.realPath,
    runProcess: runner,
    ...(input.signal === undefined ? {} : {signal: input.signal}),
  });
  const srt = releaseSrtFromTimeline(timeline);
  validateSrtWithinDuration(srt, verification.probe.durationMs);
  const subtitles = await writeOutputText(
    outputDirectory,
    `releases/${input.runId}/subtitles.srt`,
    srt,
  );
  const thumbnail = await generateThumbnail(
    input,
    outputDirectory,
    draftReport.outputs.reviewFrames[0]!.path,
    tools.ffmpeg.realPath,
    tools.ffprobe.realPath,
    runner,
  );
  const releaseReview = await writeOutputJson(
    outputDirectory,
    `releases/${input.runId}/review.json`,
    review,
  );
  const releaseFingerprint = releaseStageFingerprint({
    draft: draftReport.outputs,
    compileInputHashes: timeline.inputHashes,
    compileStageFingerprint: input.compileStageFingerprint ?? null,
    compiledTimeline: timeline,
    review,
    preflightEnvironmentFingerprint: input.preflight.environmentFingerprint,
    profile: dependencies.profile ?? RELEASE_FIXED_PROFILE,
    algorithmVersion: dependencies.algorithmVersion ?? 'release-stage-v1',
  });
  const validationReport = await writeOutputJson(
    outputDirectory,
    `releases/${input.runId}/validation-report.json`,
    {
      version: 1,
      projectId: input.project.id,
      runId: input.runId,
      releaseFingerprint,
      inputs: {
        preflight: input.preflight,
        draftAudio: audioArtifacts,
        intermediate,
      },
      outputs: {
        finalVideo,
        subtitles,
        thumbnail,
        review: {path: `releases/${input.runId}/review.json`},
      },
      verification: {
        finalSha256: verification.sha256,
        durationMs: verification.probe.durationMs,
        moovBeforeMdat: verification.moovBeforeMdat,
        atomTypes: verification.atoms.map((atom) => atom.type),
      },
    },
  );
  const checksums = await writeChecksums(outputDirectory, input.runId, [
    finalVideo,
    subtitles,
    thumbnail,
    releaseReview,
    validationReport,
  ]);
  const current = releaseCurrentPointer(
    input.runId,
    (input.now ?? (() => new Date().toISOString()))(),
  );
  if (dependencies.publishCurrent ?? true) {
    await outputStore.publishCurrent(input.project.id, current);
  }
  return {
    outputs: {
      mutedVideo,
      intermediate,
      finalVideo,
      subtitles,
      thumbnail,
      review: releaseReview,
      validationReport,
      checksums,
      releaseFingerprint,
      verification,
    },
    current,
  };
};
