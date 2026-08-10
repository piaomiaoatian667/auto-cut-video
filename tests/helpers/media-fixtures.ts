import {writeFile} from 'node:fs/promises';
import {runProcess} from '../../src/process/run-process';

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';

export interface TestVideoOptions {
  pixelFormat?: 'yuv420p' | 'yuv422p';
  includeAudio?: boolean;
  audioSeconds?: number;
  colorProfile?: 'bt709' | 'bt470bg' | 'smpte170m';
}

const VIDEO_COLOR_PROFILES = {
  bt709: {
    primaries: 'bt709',
    transfer: 'bt709',
    matrix: 'bt709',
    x264Transfer: 'bt709',
  },
  bt470bg: {
    primaries: 'bt470bg',
    transfer: 'bt470bg',
    matrix: 'bt470bg',
    x264Transfer: 'bt470bg',
  },
  smpte170m: {
    primaries: 'smpte170m',
    transfer: 'smpte170m',
    matrix: 'smpte170m',
    x264Transfer: 'smpte170m',
  },
} as const;

export async function createTestVideo(
  output: string,
  seconds = 2,
  options: TestVideoOptions = {},
): Promise<void> {
  const pixelFormat = options.pixelFormat ?? 'yuv420p';
  const includeAudio = options.includeAudio ?? true;
  const audioSeconds = options.audioSeconds ?? seconds;
  const color = VIDEO_COLOR_PROFILES[options.colorProfile ?? 'bt709'];
  const args = [
    '-v', 'error',
    '-y',
    '-fflags', '+bitexact',
    '-f', 'lavfi',
    '-i', `testsrc2=size=320x180:rate=30:duration=${seconds}`,
    ...(includeAudio
      ? ['-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`]
      : []),
    '-map', '0:v:0',
    ...(includeAudio ? ['-map', '1:a:0'] : []),
    '-vf', [
      `setparams=range=tv:color_primaries=${color.primaries}:color_trc=${color.transfer}:colorspace=${color.matrix}`,
      `format=${pixelFormat}`,
    ].join(','),
    '-c:v', 'libx264',
    '-pix_fmt', pixelFormat,
    '-x264-params', [
      `colorprim=${color.primaries}`,
      `transfer=${color.x264Transfer}`,
      `colormatrix=${color.matrix}`,
      'range=limited',
    ].join(':'),
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
  options: {silent?: boolean} = {},
): Promise<void> {
  await runProcess(FFMPEG_EXECUTABLE, [
    '-v', 'error',
    '-y',
    '-fflags', '+bitexact',
    '-f', 'lavfi',
    '-i', options.silent === true
      ? `anullsrc=channel_layout=mono:sample_rate=48000:duration=${seconds}`
      : `sine=frequency=880:sample_rate=48000:duration=${seconds}`,
    '-map', '0:a:0',
    '-c:a', 'pcm_s16le',
    '-ar', '48000',
    '-ac', '1',
    '-flags:a', '+bitexact',
    '-map_metadata', '-1',
    output,
  ]);
}

export async function createZeroDurationAac(output: string): Promise<void> {
  await writeFile(output, Buffer.from('fff14c40039ffc', 'hex'));
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
