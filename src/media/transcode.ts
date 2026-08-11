import type {
  ProcessResult,
  RunProcessOptions,
} from '../process/run-process';

export interface MediaProcessRunner {
  (
    command: string,
    args: readonly string[],
    options: RunProcessOptions,
  ): Promise<ProcessResult>;
}

export const INGEST_MVP_PROFILE = {
  frameRate: 30,
  pixelFormat: 'yuv420p',
  frameRateMode: 'cfr',
  videoEncoder: 'libx264',
  crf: 18,
  encoderPreset: 'medium',
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorSpace: 'bt709',
  colorRange: 'tv',
  container: 'mp4',
} as const;

export interface TranscodeVideoInput {
  ffmpegExecutable: string;
  sourceFd: number;
  outputFd: number;
  sourceStreamIndex: number;
  sourceColor: {
    primaries: string;
    transfer: string;
    space: string;
    range: 'tv' | 'pc';
  };
  runner: MediaProcessRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const colorToken = (value: string, field: string): string => {
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) {
    throw new TypeError(`${field} is not a valid FFmpeg color token`);
  }
  return normalized;
};

const transcodeVideoArgs = (input: TranscodeVideoInput): readonly string[] => {
  if (!Number.isSafeInteger(input.sourceStreamIndex) || input.sourceStreamIndex < 0) {
    throw new TypeError('sourceStreamIndex must be a non-negative safe integer');
  }
  const primaries = colorToken(input.sourceColor.primaries, 'sourceColor.primaries');
  const transfer = colorToken(input.sourceColor.transfer, 'sourceColor.transfer');
  const space = colorToken(input.sourceColor.space, 'sourceColor.space');
  const range = input.sourceColor.range;
  const colorFilter = [
    [
      `colorspace=space=${INGEST_MVP_PROFILE.colorSpace}`,
      `trc=${INGEST_MVP_PROFILE.colorTransfer}`,
      `primaries=${INGEST_MVP_PROFILE.colorPrimaries}`,
      `range=${INGEST_MVP_PROFILE.colorRange}`,
    ].join(':'),
    `ispace=${space}:itrc=${transfer}:iprimaries=${primaries}:irange=${range}:fast=0`,
  ].join(':');
  return [
    '-y',
    '-v', 'error',
    '-i', '/dev/fd/3',
    '-map', `0:${input.sourceStreamIndex}`,
    '-an',
    '-vf', `${colorFilter},fps=${INGEST_MVP_PROFILE.frameRate},format=${INGEST_MVP_PROFILE.pixelFormat}`,
    '-fps_mode', INGEST_MVP_PROFILE.frameRateMode,
    '-c:v', INGEST_MVP_PROFILE.videoEncoder,
    '-crf', String(INGEST_MVP_PROFILE.crf),
    '-preset', INGEST_MVP_PROFILE.encoderPreset,
    '-color_primaries', INGEST_MVP_PROFILE.colorPrimaries,
    '-color_trc', INGEST_MVP_PROFILE.colorTransfer,
    '-colorspace', INGEST_MVP_PROFILE.colorSpace,
    '-color_range', INGEST_MVP_PROFILE.colorRange,
    '-f', INGEST_MVP_PROFILE.container,
    '/dev/fd/4',
  ];
};

export async function transcodeVideo(input: TranscodeVideoInput): Promise<void> {
  await input.runner(
    input.ffmpegExecutable,
    transcodeVideoArgs(input),
    {
      extraStdioFds: [input.sourceFd, input.outputFd],
      ...(input.timeoutMs === undefined ? {} : {timeoutMs: input.timeoutMs}),
      ...(input.signal === undefined ? {} : {signal: input.signal}),
    },
  );
}
