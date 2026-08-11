import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import type {ProjectInputs} from '../domain/load-project';
import {NarrationManifestSchema, type NarrationManifest} from '../domain/manifest-schema';
import type {ScriptSegment} from '../domain/script-schema';
import {
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunReadWriteFile,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import {parseFfprobeJson} from '../media/ffprobe';
import {fingerprintValue} from '../pipeline/fingerprint';
import {runProcess, type RunProcessOptions} from '../process/run-process';
import type {TtsProvider} from '../providers/tts';

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';
const FFPROBE_EXECUTABLE = process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe';
const MAX_SEGMENT_DURATION_MS = 7000;

export class NarrationBuildError extends Error {
  constructor(readonly code: 'NARRATION_SEGMENT_TOO_LONG', message: string) {
    super(`${code}: ${message}`);
    this.name = 'NarrationBuildError';
  }
}

export interface NarrationProcessRunner {
  (command: string, args: readonly string[], options?: RunProcessOptions): Promise<{stdout: string}>;
}

export interface BuildNarrationInput extends ProjectInputs {
  runDirectory: RunDirectoryScope;
  provider: TtsProvider;
  signal?: AbortSignal;
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
  runProcess?: NarrationProcessRunner;
  probeDurationMs?: (path: string) => Promise<number>;
  onPartialArtifact?: (relativePath: string) => void;
}

const hexFromFingerprint = (fingerprint: string): string =>
  fingerprint.startsWith('sha256:') ? fingerprint.slice('sha256:'.length) : fingerprint;

export interface NarrationMasterPathInput {
  provider: NarrationManifest['provider'];
  segments: readonly Pick<
    NarrationManifest['segments'][number],
    'id' | 'inputHash' | 'audioHash' | 'startMs' | 'endMs' | 'pauseAfterMs'
  >[];
}

export const narrationMasterPath = ({
  provider,
  segments,
}: NarrationMasterPathInput): string => {
  const manifestFingerprint = fingerprintValue({
    provider,
    segments: segments.map((segment) => ({
      id: segment.id,
      inputHash: segment.inputHash,
      audioHash: segment.audioHash,
      startMs: segment.startMs,
      endMs: segment.endMs,
      pauseAfterMs: segment.pauseAfterMs,
    })),
  });
  return `audio/narration-${hexFromFingerprint(manifestFingerprint).slice(0, 16)}.wav`;
};

const safeSegmentId = (segmentId: string): string => segmentId.replace(/[^a-zA-Z0-9-]/g, '-');

const ensureParentDirectory = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
};

const openIfExists = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<FileHandle | undefined> => {
  try {
    return await openExistingRunFile(runDirectory, relativePath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
};

const runFileExists = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<boolean> => {
  const handle = await openIfExists(runDirectory, relativePath);
  if (handle === undefined) return false;
  await handle.close();
  return true;
};

const hashRunFile = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    const bytes = await handle.readFile();
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  } finally {
    await handle.close();
  }
};

const probeRunAudioDurationMs = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  ffprobeExecutable: string,
  runner: NarrationProcessRunner,
): Promise<number> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    const result = await runner(ffprobeExecutable, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    return parseFfprobeJson(result.stdout).durationMs;
  } finally {
    await handle.close();
  }
};

const createSyntheticMaster = async ({
  runDirectory,
  outputPath,
  durationMs,
  ffmpegExecutable,
  runner,
  signal,
}: {
  runDirectory: RunDirectoryScope;
  outputPath: string;
  durationMs: number;
  ffmpegExecutable: string;
  runner: NarrationProcessRunner;
  signal?: AbortSignal;
}): Promise<void> => {
  if (await runFileExists(runDirectory, outputPath)) return;
  await ensureParentDirectory(runDirectory, outputPath);
  const outputHandle = await openNewRunReadWriteFile(runDirectory, outputPath);
  try {
    await runner(ffmpegExecutable, [
      '-v', 'error',
      '-y',
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=mono:sample_rate=48000:duration=${(durationMs / 1000).toFixed(3)}`,
      '-map', '0:a:0',
      '-c:a', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '1',
      '-flags:a', '+bitexact',
      '-map_metadata', '-1',
      '-f', 'wav',
      '/dev/fd/3',
    ], {
      ...(signal === undefined ? {} : {signal}),
      extraStdioFds: [outputHandle.fd],
    });
    await outputHandle.sync();
  } finally {
    await outputHandle.close();
  }
};

export const narrationSegmentInputHash = (
  segment: ScriptSegment,
  voice: string,
  rate: number,
  providerFingerprint: string,
): string => fingerprintValue({
  segmentId: segment.id,
  normalizedText: segment.normalizedText,
  voice,
  rate,
  providerFingerprint,
  sampleRate: 48_000,
  channels: 1,
});

export const buildNarration = async (input: BuildNarrationInput): Promise<NarrationManifest> => {
  const providerFingerprint = await input.provider.fingerprint();
  const runner = input.runProcess ?? runProcess;
  const ffmpegExecutable = input.ffmpegExecutable ?? FFMPEG_EXECUTABLE;
  const ffprobeExecutable = input.ffprobeExecutable ?? FFPROBE_EXECUTABLE;
  const segments = [];
  let cursorMs = 0;

  for (const [index, segment] of input.script.segments.entries()) {
    const inputHash = narrationSegmentInputHash(
      segment,
      input.project.tts.voice,
      input.project.tts.rate,
      providerFingerprint,
    );
    const inputHashHex = hexFromFingerprint(inputHash);
    const cachePath = `audio/cache/${inputHashHex}.wav`;
    if (!(await runFileExists(input.runDirectory, cachePath))) {
      await input.provider.synthesize({
        segmentId: segment.id,
        text: segment.normalizedText,
        voice: input.project.tts.voice,
        rate: input.project.tts.rate,
        outputPath: cachePath,
        ...(segment.audioPath === undefined ? {} : {sourceAudioPath: segment.audioPath}),
      }, input.signal ?? new AbortController().signal);
    }

    const durationMs = Math.round(input.probeDurationMs === undefined
      ? await probeRunAudioDurationMs(input.runDirectory, cachePath, ffprobeExecutable, runner)
      : await input.probeDurationMs(cachePath));
    if (durationMs > MAX_SEGMENT_DURATION_MS) {
      throw new NarrationBuildError(
        'NARRATION_SEGMENT_TOO_LONG',
        `segment ${segment.id} is ${durationMs}ms, maximum is ${MAX_SEGMENT_DURATION_MS}ms`,
      );
    }

    const segmentPath = `audio/segments/${String(index + 1).padStart(4, '0')}-${safeSegmentId(segment.id)}-${inputHashHex.slice(0, 12)}.wav`;
    if (!(await runFileExists(input.runDirectory, segmentPath))) {
      await createSyntheticMaster({
        runDirectory: input.runDirectory,
        outputPath: segmentPath,
        durationMs: durationMs + segment.pauseAfterMs,
        ffmpegExecutable,
        runner,
        ...(input.signal === undefined ? {} : {signal: input.signal}),
      });
    }

    segments.push({
      id: segment.id,
      inputHash,
      audioPath: segmentPath,
      audioHash: await hashRunFile(input.runDirectory, segmentPath),
      startMs: cursorMs,
      endMs: cursorMs + durationMs,
      durationMs,
      pauseAfterMs: segment.pauseAfterMs,
      sampleRate: 48000 as const,
      channels: 1 as const,
      providerFingerprint,
    });
    cursorMs += durationMs + segment.pauseAfterMs;
  }

  const masterPath = narrationMasterPath({
    provider: input.provider.id,
    segments,
  });
  input.onPartialArtifact?.(masterPath);
  await createSyntheticMaster({
    runDirectory: input.runDirectory,
    outputPath: masterPath,
    durationMs: cursorMs,
    ffmpegExecutable,
    runner,
    ...(input.signal === undefined ? {} : {signal: input.signal}),
  });

  return NarrationManifestSchema.parse({
    version: 1,
    provider: input.provider.id,
    segments,
    master: {
      audioPath: masterPath,
      audioHash: await hashRunFile(input.runDirectory, masterPath),
      durationMs: cursorMs,
    },
  });
};
