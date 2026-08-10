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

export interface TranscodeVideoInput {
  ffmpegExecutable: string;
  sourceFd: number;
  outputFd: number;
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
  const primaries = colorToken(input.sourceColor.primaries, 'sourceColor.primaries');
  const transfer = colorToken(input.sourceColor.transfer, 'sourceColor.transfer');
  const space = colorToken(input.sourceColor.space, 'sourceColor.space');
  const range = input.sourceColor.range;
  const colorFilter = [
    'colorspace=space=bt709:trc=bt709:primaries=bt709:range=tv',
    `ispace=${space}:itrc=${transfer}:iprimaries=${primaries}:irange=${range}:fast=0`,
  ].join(':');
  return [
    '-y',
    '-v', 'error',
    '-i', '/dev/fd/3',
    '-map', '0:v:0',
    '-an',
    '-vf', `${colorFilter},fps=30,format=yuv420p`,
    '-fps_mode', 'cfr',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
    '-f', 'mp4',
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
