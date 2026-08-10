import {createHash} from 'node:crypto';
import type {MediaProbe} from './ffprobe';
import {parseFfprobeJson} from './ffprobe';
import {
  openExistingOutputFile,
  type OutputDirectoryScope,
} from '../fs/app-directory-scopes';
import {
  runProcess as runSystemProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/run-process';

export type ReleaseVerificationErrorCode =
  | 'RELEASE_DECODE_FAILED'
  | 'RELEASE_DURATION_MISMATCH';

export class ReleaseVerificationError extends Error {
  constructor(readonly code: ReleaseVerificationErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ReleaseVerificationError';
  }
}

export interface Mp4Atom {
  type: string;
  offset: number;
  size: number;
}

export interface ReleaseVerificationReport {
  sha256: string;
  probe: MediaProbe;
  atoms: Mp4Atom[];
  moovBeforeMdat: true;
}

export interface ReleaseOutputVerificationInput {
  outputDirectory: OutputDirectoryScope;
  relativePath: string;
  ffmpegExecutable: string;
  ffprobeExecutable: string;
  runProcess?: ReleaseVerifyRunner;
  signal?: AbortSignal;
}

type ReleaseVerifyRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<ProcessResult>;

const failDecode = (message: string): never => {
  throw new ReleaseVerificationError('RELEASE_DECODE_FAILED', message);
};

const wrapDecodeFailure = (message: string, error: unknown): never => {
  if (error instanceof ReleaseVerificationError) throw error;
  throw new ReleaseVerificationError('RELEASE_DECODE_FAILED', message, {cause: error});
};

export const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export const parseTopLevelMp4Atoms = (bytes: Buffer): Mp4Atom[] => {
  const atoms: Mp4Atom[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) failDecode('truncated MP4 atom header');
    const size32 = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    let headerBytes = 8;
    let size = size32;
    if (size32 === 1) {
      if (bytes.byteLength - offset < 16) failDecode('truncated extended MP4 atom header');
      const size64 = bytes.readBigUInt64BE(offset + 8);
      if (size64 > BigInt(Number.MAX_SAFE_INTEGER)) failDecode('MP4 atom is too large');
      size = Number(size64);
      headerBytes = 16;
    } else if (size32 === 0) {
      size = bytes.byteLength - offset;
    }
    if (size < headerBytes || offset + size > bytes.byteLength) {
      failDecode(`invalid MP4 atom size for ${type}`);
    }
    atoms.push({type, offset, size});
    offset += size;
  }
  return atoms;
};

export const assertMoovBeforeMdat = (atoms: readonly Mp4Atom[]): void => {
  const moov = atoms.find((atom) => atom.type === 'moov');
  const mdat = atoms.find((atom) => atom.type === 'mdat');
  if (moov === undefined) return failDecode('release MP4 must contain a moov atom');
  if (mdat === undefined) return failDecode('release MP4 must contain an mdat atom');
  if (moov.offset >= mdat.offset) {
    failDecode('release MP4 moov atom must appear before mdat');
  }
};

export const validateReleaseProbe = (probe: MediaProbe): void => {
  if (probe.videoStreams.length !== 1 || probe.audioStreams.length !== 1) {
    failDecode('release must contain exactly one video stream and one audio stream');
  }
  const video = probe.videoStreams[0]!;
  const audio = probe.audioStreams[0]!;
  if (
    video.codec !== 'h264'
    || video.pixelFormat !== 'yuv420p'
    || video.width !== 1920
    || video.height !== 1080
    || Math.abs(video.averageFrameRate.value - 30) > 0.001
  ) {
    failDecode('release video stream does not match the fixed MVP profile');
  }
  if (audio.codec !== 'aac' || audio.sampleRate !== 48000 || audio.channels !== 2) {
    failDecode('release audio stream does not match the fixed MVP profile');
  }
  if (
    video.durationMs !== undefined
    && audio.durationMs !== undefined
    && Math.abs(video.durationMs - audio.durationMs) > 50
  ) {
    throw new ReleaseVerificationError(
      'RELEASE_DURATION_MISMATCH',
      'release audio and video durations differ by more than 50ms',
    );
  }
};

const srtTimestampMs = (value: string): number => {
  const match = /^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/u.exec(value);
  if (match === null) return failDecode(`invalid SRT timestamp: ${value}`);
  const rawHours = match[1]!;
  const rawMinutes = match[2]!;
  const rawSeconds = match[3]!;
  const rawMilliseconds = match[4]!;
  const hours = Number(rawHours);
  const minutes = Number(rawMinutes);
  const seconds = Number(rawSeconds);
  const milliseconds = Number(rawMilliseconds);
  if (minutes > 59 || seconds > 59) failDecode(`invalid SRT timestamp: ${value}`);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
};

export const validateSrtWithinDuration = (srt: string, durationMs: number): void => {
  const normalized = srt.replace(/\r\n/gu, '\n').replace(/\r/gu, '\n').trim();
  if (normalized.length === 0) failDecode('release SRT must contain at least one cue');
  const blocks = normalized.split(/\n{2,}/u);
  for (const [index, block] of blocks.entries()) {
    const lines = block.split('\n');
    if (lines.length < 3 || lines[0] !== String(index + 1)) {
      failDecode(`invalid SRT cue at index ${index + 1}`);
    }
    const timingMatch = /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/u.exec(lines[1]!);
    if (timingMatch === null) return failDecode(`invalid SRT cue timing at index ${index + 1}`);
    const startMs = srtTimestampMs(timingMatch[1]!);
    const endMs = srtTimestampMs(timingMatch[2]!);
    if (endMs <= startMs) failDecode(`SRT cue ${index + 1} must have positive duration`);
    if (endMs > durationMs + 50) {
      failDecode(`SRT cue ${index + 1} ends after release video duration`);
    }
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

const runWithOutputFd = async (
  input: ReleaseOutputVerificationInput,
  command: string,
  args: readonly string[],
): Promise<ProcessResult> => await withOutputRead(
  input.outputDirectory,
  input.relativePath,
  async (handle) => await (input.runProcess ?? runSystemProcess)(command, args, {
    ...(input.signal === undefined ? {} : {signal: input.signal}),
    extraStdioFds: [handle.fd],
  }),
);

export const verifyReleaseOutputFile = async (
  input: ReleaseOutputVerificationInput,
): Promise<ReleaseVerificationReport> => {
  try {
    await runWithOutputFd(input, input.ffmpegExecutable, [
      '-v', 'error',
      '-xerror',
      '-i', '/dev/fd/3',
      '-f', 'null',
      '-',
    ]);
  } catch (error) {
    wrapDecodeFailure('release final MP4 did not decode cleanly', error);
  }

  const probe = await withOutputRead<MediaProbe>(input.outputDirectory, input.relativePath, async (handle) => {
    try {
      const result = await (input.runProcess ?? runSystemProcess)(input.ffprobeExecutable, [
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
    } catch (error) {
      return wrapDecodeFailure('release final MP4 ffprobe failed', error);
    }
  });
  validateReleaseProbe(probe);

  const bytes = await withOutputRead(
    input.outputDirectory,
    input.relativePath,
    async (handle) => await handle.readFile(),
  );
  const atoms = parseTopLevelMp4Atoms(bytes);
  assertMoovBeforeMdat(atoms);
  return {sha256: sha256(bytes), probe, atoms, moovBeforeMdat: true};
};
