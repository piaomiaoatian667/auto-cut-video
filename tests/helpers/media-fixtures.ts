import {runProcess} from '../../src/process/run-process';

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';

export interface TestVideoOptions {
  pixelFormat?: 'yuv420p' | 'yuv422p';
  includeAudio?: boolean;
}

export async function createTestVideo(
  output: string,
  seconds = 2,
  options: TestVideoOptions = {},
): Promise<void> {
  const pixelFormat = options.pixelFormat ?? 'yuv420p';
  const includeAudio = options.includeAudio ?? true;
  const args = [
    '-v', 'error',
    '-y',
    '-fflags', '+bitexact',
    '-f', 'lavfi',
    '-i', `testsrc2=size=320x180:rate=30:duration=${seconds}`,
    ...(includeAudio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`]
      : []),
    '-map', '0:v:0',
    ...(includeAudio ? ['-map', '1:a:0'] : []),
    '-t', String(seconds),
    '-vf', [
      'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      `format=${pixelFormat}`,
    ].join(','),
    '-c:v', 'libx264',
    '-pix_fmt', pixelFormat,
    '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited',
    '-crf', '18',
    '-preset', 'medium',
    '-threads', '1',
    ...(includeAudio
      ? ['-c:a', 'aac', '-ar', '48000', '-ac', '1', '-flags:a', '+bitexact']
      : []),
    '-map_metadata', '-1',
    '-metadata', 'creation_time=1970-01-01T00:00:00Z',
    '-movflags', '+faststart',
    output,
  ];
  await runProcess(FFMPEG_EXECUTABLE, args);
}

export async function createTestMusic(
  output: string,
  seconds = 2,
): Promise<void> {
  await runProcess(FFMPEG_EXECUTABLE, [
    '-v', 'error',
    '-y',
    '-fflags', '+bitexact',
    '-f', 'lavfi',
    '-i', `sine=frequency=880:sample_rate=48000:duration=${seconds}`,
    '-map', '0:a:0',
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '1',
    '-flags:a', '+bitexact',
    '-map_metadata', '-1',
    output,
  ]);
}

export async function createTestImage(
  output: string,
  color = 'red',
): Promise<void> {
  await runProcess(FFMPEG_EXECUTABLE, [
    '-v', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${color}:s=64x48`,
    '-frames:v', '1',
    '-threads', '1',
    output,
  ]);
}
