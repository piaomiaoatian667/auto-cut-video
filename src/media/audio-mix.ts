import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunFile,
  openNewRunReadWriteFile,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import {openExistingProjectFile, type ProjectDirectoryScope} from '../fs/project-paths';
import {fingerprintValue} from '../pipeline/fingerprint';
import {runProcess, type RunProcessOptions} from '../process/run-process';
import {
  buildFirstPassLoudnormFilter,
  buildSecondPassLoudnormFilter,
  parseLoudnormStats,
} from './loudness';

export const AUDIO_MIX_ALGORITHM_VERSION = 'audio-mix-v1';

export interface NarrationInterval {
  segmentId: string;
  startMs: number;
  endMs: number;
}

export interface AudioMixInput {
  compositionDurationMs: number;
  narrationPath: string;
  backgroundMusic: {renderPath: string; startMs: number; durationMs: number};
  narrationIntervals: NarrationInterval[];
  backgroundMusicGainDb: number;
  duckDuringNarrationDb: number;
  duckAttackMs: number;
  duckReleaseMs: number;
  targetLufs: number;
  truePeakDb: number;
  algorithmVersion: string;
}

export interface DuckingEnvelope {
  startMs: number;
  duckStartMs: number;
  duckEndMs: number;
  endMs: number;
  gain: number;
}

export interface BuildDuckingEnvelopeInput {
  compositionDurationMs: number;
  intervals: NarrationInterval[];
  attackMs: number;
  releaseMs: number;
  duckDb: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const seconds = (milliseconds: number): string => (milliseconds / 1000).toFixed(3);

const dbToGain = (db: number): number => 10 ** (db / 20);

export const buildDuckingEnvelope = ({
  compositionDurationMs,
  intervals,
  attackMs,
  releaseMs,
  duckDb,
}: BuildDuckingEnvelopeInput): DuckingEnvelope[] => {
  const gain = dbToGain(duckDb);
  const ranges = intervals
    .map((interval) => ({
      startMs: clamp(interval.startMs - attackMs, 0, compositionDurationMs),
      duckStartMs: clamp(interval.startMs, 0, compositionDurationMs),
      duckEndMs: clamp(interval.endMs, 0, compositionDurationMs),
      endMs: clamp(interval.endMs + releaseMs, 0, compositionDurationMs),
      gain,
    }))
    .filter((range) => range.endMs > range.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);

  const merged: DuckingEnvelope[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || range.startMs > previous.endMs) {
      merged.push({...range});
      continue;
    }
    previous.duckEndMs = Math.max(previous.duckEndMs, range.duckEndMs);
    previous.endMs = Math.max(previous.endMs, range.endMs);
  }
  return merged;
};

export const audioMixFingerprint = (input: AudioMixInput): string => fingerprintValue({
  algorithmVersion: input.algorithmVersion,
  compositionDurationMs: input.compositionDurationMs,
  narrationIntervals: input.narrationIntervals,
  backgroundMusic: input.backgroundMusic,
  backgroundMusicGainDb: input.backgroundMusicGainDb,
  duckDuringNarrationDb: input.duckDuringNarrationDb,
  duckAttackMs: input.duckAttackMs,
  duckReleaseMs: input.duckReleaseMs,
  targetLufs: input.targetLufs,
  truePeakDb: input.truePeakDb,
});

const rampDownExpression = (range: DuckingEnvelope): string => {
  if (range.duckStartMs <= range.startMs) return String(range.gain);
  const start = seconds(range.startMs);
  const duckStart = seconds(range.duckStartMs);
  return `1-(1-${range.gain})*(t-${start})/(${duckStart}-${start})`;
};

const rampUpExpression = (range: DuckingEnvelope): string => {
  if (range.endMs <= range.duckEndMs) return '1';
  const duckEnd = seconds(range.duckEndMs);
  const end = seconds(range.endMs);
  return `${range.gain}+(1-${range.gain})*(t-${duckEnd})/(${end}-${duckEnd})`;
};

const envelopeExpression = (range: DuckingEnvelope): string => {
  const start = seconds(range.startMs);
  const duckStart = seconds(range.duckStartMs);
  const duckEnd = seconds(range.duckEndMs);
  const end = seconds(range.endMs);
  return `if(between(t,${start},${duckStart}),${rampDownExpression(range)},if(between(t,${duckStart},${duckEnd}),${range.gain},if(between(t,${duckEnd},${end}),${rampUpExpression(range)},1)))`;
};

const duckingExpression = (envelopes: readonly DuckingEnvelope[]): string => {
  if (envelopes.length === 0) return '1';
  return envelopes.map(envelopeExpression).join('*');
};

export const buildAudioFilterGraph = (input: AudioMixInput): string => {
  const envelopes = buildDuckingEnvelope({
    compositionDurationMs: input.compositionDurationMs,
    intervals: input.narrationIntervals,
    attackMs: input.duckAttackMs,
    releaseMs: input.duckReleaseMs,
    duckDb: input.duckDuringNarrationDb,
  });
  const bgmDelay = Math.max(0, Math.round(input.backgroundMusic.startMs));
  const globalGain = dbToGain(input.backgroundMusicGainDb);
  const expression = `${globalGain}*${duckingExpression(envelopes)}`;
  return [
    `[1:a]adelay=${bgmDelay}|${bgmDelay},volume='${expression}':eval=frame[bgm]`,
    `[0:a][bgm]amix=inputs=2:normalize=0,atrim=0:${seconds(input.compositionDurationMs)},aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[mix]`,
  ].join(';');
};

export interface AudioArtifactReference {
  path: string;
  sha256: string;
}

export interface MixAndNormalizeAudioInput {
  projectDirectory: ProjectDirectoryScope;
  runDirectory: RunDirectoryScope;
  input: AudioMixInput;
  ffmpegExecutable?: string;
  runProcess?: (command: string, args: readonly string[], options?: RunProcessOptions) => Promise<{stderr: string}>;
  signal?: AbortSignal;
}

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';

const sha256 = (bytes: Buffer | string): string =>
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

const writeRunText = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<AudioArtifactReference> => {
  await ensureRunDirectory(runDirectory, 'audio');
  await withHandle(await openNewRunFile(runDirectory, relativePath), async (handle) => {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  });
  return {path: relativePath, sha256: sha256(contents)};
};

const hashRunFile = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => await withHandle(
  await openExistingRunFile(runDirectory, relativePath),
  async (handle) => sha256(await handle.readFile()),
);

export const mixAndNormalizeAudio = async ({
  projectDirectory,
  runDirectory,
  input,
  ffmpegExecutable = FFMPEG_EXECUTABLE,
  runProcess: runner = runProcess,
  signal,
}: MixAndNormalizeAudioInput): Promise<{
  filterGraph: AudioArtifactReference;
  mixedAudio: AudioArtifactReference;
}> => {
  if (input.backgroundMusic.durationMs - input.backgroundMusic.startMs < input.compositionDurationMs) {
    throw new Error('AUDIO_BGM_TOO_SHORT: background music is shorter than the composition');
  }
  const filterGraph = await writeRunText(
    runDirectory,
    'audio/filter-graph.txt',
    `${buildAudioFilterGraph(input)}\n`,
  );

  await ensureRunDirectory(runDirectory, 'audio');
  const narrationHandle = await openExistingRunFile(runDirectory, input.narrationPath);
  const bgmHandle = await openExistingProjectFile(projectDirectory, input.backgroundMusic.renderPath);
  const graphHandle = await openExistingRunFile(runDirectory, filterGraph.path);
  const rawMixHandle = await openNewRunReadWriteFile(runDirectory, 'audio/mixed-raw.wav');
  try {
    await runner(ffmpegExecutable, [
      '-v', 'error',
      '-y',
      '-i', '/dev/fd/3',
      '-i', '/dev/fd/4',
      '-filter_complex_script', '/dev/fd/5',
      '-map', '[mix]',
      '-c:a', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'wav',
      '/dev/fd/6',
    ], {
      ...(signal === undefined ? {} : {signal}),
      extraStdioFds: [
        narrationHandle.fd,
        bgmHandle.fd,
        graphHandle.fd,
        rawMixHandle.fd,
      ],
    });
    await rawMixHandle.sync();
  } finally {
    await Promise.allSettled([
      narrationHandle.close(),
      bgmHandle.close(),
      graphHandle.close(),
      rawMixHandle.close(),
    ]);
  }

  const firstPassRawHandle = await openExistingRunFile(runDirectory, 'audio/mixed-raw.wav');
  let firstPassStderr = '';
  try {
    const firstPass = await runner(ffmpegExecutable, [
      '-v', 'info',
      '-y',
      '-i', '/dev/fd/3',
      '-af', buildFirstPassLoudnormFilter({
        targetLufs: input.targetLufs,
        truePeakDb: input.truePeakDb,
      }),
      '-f', 'null',
      '-',
    ], {
      ...(signal === undefined ? {} : {signal}),
      extraStdioFds: [firstPassRawHandle.fd],
    });
    firstPassStderr = firstPass.stderr;
  } finally {
    await firstPassRawHandle.close();
  }

  const stats = parseLoudnormStats(firstPassStderr);
  const secondPassRawHandle = await openExistingRunFile(runDirectory, 'audio/mixed-raw.wav');
  const outputHandle = await openNewRunReadWriteFile(runDirectory, 'audio/mixed-normalized.wav');
  try {
    await runner(ffmpegExecutable, [
      '-v', 'error',
      '-y',
      '-i', '/dev/fd/3',
      '-af', buildSecondPassLoudnormFilter({
        targetLufs: input.targetLufs,
        truePeakDb: input.truePeakDb,
        stats,
      }),
      '-c:a', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'wav',
      '/dev/fd/4',
    ], {
      ...(signal === undefined ? {} : {signal}),
      extraStdioFds: [
        secondPassRawHandle.fd,
        outputHandle.fd,
      ],
    });
    await outputHandle.sync();
  } finally {
    await Promise.allSettled([
      secondPassRawHandle.close(),
      outputHandle.close(),
    ]);
  }

  return {
    filterGraph,
    mixedAudio: {
      path: 'audio/mixed-normalized.wav',
      sha256: await hashRunFile(runDirectory, 'audio/mixed-normalized.wav'),
    },
  };
};
