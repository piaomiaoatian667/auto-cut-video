import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CompiledTimelineSchema, type CompiledTimeline} from '../../domain/timeline-schema';
import type {ProjectInputs} from '../../domain/load-project';
import {
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunFile,
  openNewRunReadWriteFile,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {openExistingProjectFile} from '../../fs/project-paths';
import {
  AUDIO_MIX_ALGORITHM_VERSION,
  audioMixFingerprint,
  mixAndNormalizeAudio,
  type AudioArtifactReference,
} from '../../media/audio-mix';
import {generateContactSheet, type ContactSheetArtifact} from '../../media/contact-sheet';
import {parseFfprobeJson} from '../../media/ffprobe';
import {runProcess, type RunProcessOptions} from '../../process/run-process';
import {renderTimelineVideo} from '../../remotion/render';

export interface ArtifactReference {
  path: string;
  sha256: string;
}

export interface DraftStageInput extends ProjectInputs {
  runDirectory: RunDirectoryScope;
  signal?: AbortSignal;
}

export interface DraftStageOutputs {
  mutedVideo: ArtifactReference;
  draftVideo: ArtifactReference;
  contactSheet: ContactSheetArtifact;
  reviewFrames: ContactSheetArtifact[];
  audio: {
    filterGraph: AudioArtifactReference;
    mixedAudio: AudioArtifactReference;
  };
  report: ArtifactReference;
  audioMixFingerprint: string;
}

export interface DraftStageResult {
  reportPath: 'draft/draft-report.json';
  outputs: DraftStageOutputs;
}

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';
const FFPROBE_EXECUTABLE = process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe';

const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const withRunFile = async <Output>(
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

const hashRunFile = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => await withRunFile(
  runDirectory,
  relativePath,
  async (handle) => sha256(await handle.readFile()),
);

const readRunJson = async <Output>(
  runDirectory: RunDirectoryScope,
  relativePath: string,
  parse: (value: unknown) => Output,
): Promise<Output> => await withRunFile(
  runDirectory,
  relativePath,
  async (handle) => parse(JSON.parse(await handle.readFile('utf8'))),
);

const writeRunBuffer = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  bytes: Buffer,
): Promise<ArtifactReference> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {path: relativePath, sha256: sha256(bytes)};
};

const writeRunJson = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  value: unknown,
): Promise<ArtifactReference> => {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {path: relativePath, sha256: sha256(contents)};
};

const readProjectOrRunBytes = async (
  input: DraftStageInput,
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
      return await withRunFile(input.runDirectory, relativePath, async (handle) => await handle.readFile());
    } catch (runError) {
      throw new AggregateError([projectError, runError], `render asset not found: ${relativePath}`);
    }
  }
};

const preparePublicDir = async (
  input: DraftStageInput,
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

const muxDraft = async (
  input: DraftStageInput,
  mutedVideoPath: string,
  mixedAudioPath: string,
  runner: typeof runProcess,
): Promise<ArtifactReference> => {
  await ensureRunDirectory(input.runDirectory, 'draft');
  const videoHandle = await openExistingRunFile(input.runDirectory, mutedVideoPath);
  const audioHandle = await openExistingRunFile(input.runDirectory, mixedAudioPath);
  const outputHandle = await openNewRunReadWriteFile(input.runDirectory, 'draft/draft.mp4');
  try {
    await runner(FFMPEG_EXECUTABLE, [
      '-v', 'error',
      '-y',
      '-i', '/dev/fd/3',
      '-i', '/dev/fd/4',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', '48000',
      '-ac', '2',
      '-shortest',
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
  return {path: 'draft/draft.mp4', sha256: await hashRunFile(input.runDirectory, 'draft/draft.mp4')};
};

const verifyDraft = async (
  runDirectory: RunDirectoryScope,
  draftPath: string,
  runner: typeof runProcess,
): Promise<void> => {
  await withRunFile(runDirectory, draftPath, async (handle) => {
    await runner(FFMPEG_EXECUTABLE, [
      '-v', 'error',
      '-xerror',
      '-i', '/dev/fd/3',
      '-f', 'null',
      '-',
    ], {extraStdioFds: [handle.fd]});
  });
  const metadata = await withRunFile(runDirectory, draftPath, async (handle) => {
    const result = await runner(FFPROBE_EXECUTABLE, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    return parseFfprobeJson(result.stdout);
  });
  if (metadata.videoStreams.length !== 1 || metadata.audioStreams.length !== 1) {
    throw new Error('DRAFT_DECODE_FAILED: draft must contain one video and one audio stream');
  }
}

export const runDraft = async (input: DraftStageInput): Promise<DraftStageResult> => {
  const timeline = await readRunJson(
    input.runDirectory,
    'compiled-timeline.json',
    (value) => CompiledTimelineSchema.parse(value),
  );
  if (timeline.backgroundMusic === undefined) {
    throw new Error('AUDIO_BGM_REQUIRED: draft requires background music metadata');
  }

  const workspace = await mkdtemp(path.join(tmpdir(), 'agent-video-draft-'));
  try {
    const publicDir = path.join(workspace, 'public');
    const mutedOutput = path.join(workspace, 'muted-video.mp4');
    await preparePublicDir(input, timeline, publicDir);
    await renderTimelineVideo({
      timeline,
      publicDir,
      outputLocation: mutedOutput,
      scale: input.project.render.draftWidth / timeline.width,
    });
    const mutedVideo = await writeRunBuffer(
      input.runDirectory,
      'draft/muted-video.mp4',
      await readFile(mutedOutput),
    );

    const compositionDurationMs = Math.round(timeline.durationInFrames * 1000 / timeline.fps);
    const mixInput = {
      compositionDurationMs,
      narrationPath: timeline.narration.audioPath,
      backgroundMusic: timeline.backgroundMusic,
      narrationIntervals: timeline.narration.intervals,
      backgroundMusicGainDb: input.project.audio.backgroundMusicGainDb,
      duckDuringNarrationDb: input.project.audio.duckDuringNarrationDb,
      duckAttackMs: input.project.audio.duckAttackMs,
      duckReleaseMs: input.project.audio.duckReleaseMs,
      targetLufs: input.project.audio.targetLufs,
      truePeakDb: input.project.audio.truePeakDb,
      algorithmVersion: AUDIO_MIX_ALGORITHM_VERSION,
    };
    const audio = await mixAndNormalizeAudio({
      projectDirectory: input.projectDirectory,
      runDirectory: input.runDirectory,
      input: mixInput,
      ...(input.signal === undefined ? {} : {signal: input.signal}),
    });
    const draftVideo = await muxDraft(input, mutedVideo.path, audio.mixedAudio.path, runProcess);
    await verifyDraft(input.runDirectory, draftVideo.path, runProcess);
    const contactSheet = await generateContactSheet({
      runDirectory: input.runDirectory,
      videoPath: draftVideo.path,
      timeline,
      ...(input.signal === undefined ? {} : {signal: input.signal}),
    });

    const outputs = {
      mutedVideo,
      draftVideo,
      contactSheet: contactSheet.contactSheet,
      reviewFrames: contactSheet.frames,
      audio,
      audioMixFingerprint: audioMixFingerprint(mixInput),
    };
    const report = await writeRunJson(input.runDirectory, 'draft/draft-report.json', {
      version: 1,
      projectId: input.project.id,
      outputs,
    });
    return {reportPath: 'draft/draft-report.json', outputs: {...outputs, report}};
  } finally {
    await rm(workspace, {recursive: true, force: true});
  }
};
