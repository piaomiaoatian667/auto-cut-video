import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunReadWriteFile,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import {runProcess, type RunProcessOptions} from '../process/run-process';
import type {CompiledTimeline} from '../domain/timeline-schema';

export interface SelectReviewFramesOptions {
  maximumFrames?: number;
  coverageFrames?: number;
}

const clampFrame = (frame: number, durationInFrames: number): number =>
  Math.min(durationInFrames - 1, Math.max(0, Math.trunc(frame)));

const addUnique = (frames: number[], frame: number): void => {
  if (!frames.includes(frame)) frames.push(frame);
};

const boundaryFrames = (timeline: CompiledTimeline): number[] => {
  const frames: number[] = [];
  addUnique(frames, 0);
  addUnique(frames, timeline.durationInFrames - 1);
  for (const clip of timeline.visualClips) {
    addUnique(frames, clampFrame(clip.startFrame, timeline.durationInFrames));
    addUnique(frames, clampFrame(clip.startFrame + clip.durationInFrames - 1, timeline.durationInFrames));
    addUnique(frames, clampFrame(clip.startFrame + clip.durationInFrames, timeline.durationInFrames));
  }
  for (const caption of timeline.captions) {
    addUnique(frames, clampFrame(
      Math.floor((caption.startFrame + caption.endFrame) / 2),
      timeline.durationInFrames,
    ));
  }
  return frames;
};

const coverageFrameList = (
  durationInFrames: number,
  coverageFrames: number,
): number[] => {
  if (coverageFrames <= 1) return [0];
  return Array.from({length: coverageFrames}, (_, index) => clampFrame(
    Math.round(index * (durationInFrames - 1) / (coverageFrames - 1)),
    durationInFrames,
  ));
};

export const selectReviewFrames = (
  timeline: CompiledTimeline,
  options: SelectReviewFramesOptions = {},
): number[] => {
  const maximumFrames = options.maximumFrames ?? 24;
  const coverageFrames = options.coverageFrames ?? 12;
  const boundaries = boundaryFrames(timeline);
  const selected = new Set<number>(boundaries);
  for (const frame of coverageFrameList(timeline.durationInFrames, coverageFrames)) {
    selected.add(frame);
  }

  if (selected.size <= maximumFrames) {
    return [...selected].sort((left, right) => left - right);
  }

  const preserved = boundaries.slice(0, maximumFrames);
  if (preserved.length >= maximumFrames) return preserved;

  for (const frame of [...selected].sort((left, right) => left - right)) {
    if (preserved.includes(frame)) continue;
    preserved.push(frame);
    if (preserved.length >= maximumFrames) break;
  }
  return preserved.sort((left, right) => left - right);
};

export interface ContactSheetArtifact {
  path: string;
  sha256: string;
}

export interface GenerateContactSheetInput {
  runDirectory: RunDirectoryScope;
  videoPath: string;
  timeline: CompiledTimeline;
  ffmpegExecutable?: string;
  runProcess?: (command: string, args: readonly string[], options?: RunProcessOptions) => Promise<unknown>;
  signal?: AbortSignal;
}

export interface ContactSheetResult {
  frames: ContactSheetArtifact[];
  contactSheet: ContactSheetArtifact;
}

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const withHandle = async <Output>(
  handle: FileHandle,
  action: (handle: FileHandle) => Promise<Output>,
): Promise<Output> => {
  try {
    return await action(handle);
  } finally {
    await handle.close();
  }
};

const hashRunFile = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => await withHandle(
  await openExistingRunFile(runDirectory, relativePath),
  async (handle) => sha256(await handle.readFile()),
);

const selectExpression = (frames: readonly number[]): string => frames
  .map((frame) => `eq(n\\,${frame})`)
  .join('+');

const extractFrame = async ({
  runDirectory,
  videoPath,
  outputPath,
  frame,
  ffmpegExecutable,
  runner,
  signal,
}: {
  runDirectory: RunDirectoryScope;
  videoPath: string;
  outputPath: string;
  frame: number;
  ffmpegExecutable: string;
  runner: NonNullable<GenerateContactSheetInput['runProcess']>;
  signal?: AbortSignal;
}): Promise<ContactSheetArtifact> => {
  const videoHandle = await openExistingRunFile(runDirectory, videoPath);
  const outputHandle = await openNewRunReadWriteFile(runDirectory, outputPath);
  try {
    await runner(ffmpegExecutable, [
      '-v', 'error',
      '-y',
      '-i', '/dev/fd/3',
      '-vf', `select=${selectExpression([frame])},scale=320:-1`,
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'mjpeg',
      '/dev/fd/4',
    ], {
      ...(signal === undefined ? {} : {signal}),
      extraStdioFds: [videoHandle.fd, outputHandle.fd],
    });
    await outputHandle.sync();
  } finally {
    await Promise.allSettled([videoHandle.close(), outputHandle.close()]);
  }
  return {path: outputPath, sha256: await hashRunFile(runDirectory, outputPath)};
};

export const generateContactSheet = async ({
  runDirectory,
  videoPath,
  timeline,
  ffmpegExecutable = FFMPEG_EXECUTABLE,
  runProcess: runner = runProcess,
  signal,
}: GenerateContactSheetInput): Promise<ContactSheetResult> => {
  await ensureRunDirectory(runDirectory, 'draft/frames');
  const frames = selectReviewFrames(timeline);
  const frameArtifacts: ContactSheetArtifact[] = [];
  for (const frame of frames) {
    frameArtifacts.push(await extractFrame({
      runDirectory,
      videoPath,
      outputPath: `draft/frames/frame-${String(frame).padStart(6, '0')}.jpg`,
      frame,
      ffmpegExecutable,
      runner,
      ...(signal === undefined ? {} : {signal}),
    }));
  }

  const cols = Math.min(4, Math.max(1, frames.length));
  const rows = Math.ceil(frames.length / cols);
  const videoHandle = await openExistingRunFile(runDirectory, videoPath);
  const outputHandle = await openNewRunReadWriteFile(runDirectory, 'draft/contact-sheet.jpg');
  try {
    await runner(ffmpegExecutable, [
      '-v', 'error',
      '-y',
      '-i', '/dev/fd/3',
      '-vf', `select=${selectExpression(frames)},scale=320:-1,tile=${cols}x${rows}`,
      '-frames:v', '1',
      '-q:v', '3',
      '-f', 'mjpeg',
      '/dev/fd/4',
    ], {
      ...(signal === undefined ? {} : {signal}),
      extraStdioFds: [videoHandle.fd, outputHandle.fd],
    });
    await outputHandle.sync();
  } finally {
    await Promise.allSettled([videoHandle.close(), outputHandle.close()]);
  }

  return {
    frames: frameArtifacts,
    contactSheet: {
      path: 'draft/contact-sheet.jpg',
      sha256: await hashRunFile(runDirectory, 'draft/contact-sheet.jpg'),
    },
  };
};
