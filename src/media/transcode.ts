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
  runner: MediaProcessRunner;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const TRANSCODE_VIDEO_ARGS = [
  '-y',
  '-v', 'error',
  '-i', '/dev/fd/3',
  '-map', '0:v:0',
  '-an',
  '-vf', 'fps=30,format=yuv420p',
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
] as const;

export async function transcodeVideo(input: TranscodeVideoInput): Promise<void> {
  await input.runner(
    input.ffmpegExecutable,
    TRANSCODE_VIDEO_ARGS,
    {
      extraStdioFds: [input.sourceFd, input.outputFd],
      ...(input.timeoutMs === undefined ? {} : {timeoutMs: input.timeoutMs}),
      ...(input.signal === undefined ? {} : {signal: input.signal}),
    },
  );
}
