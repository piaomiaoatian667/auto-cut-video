import {describe, expect, it} from 'vitest';
import {
  assertMoovBeforeMdat,
  parseTopLevelMp4Atoms,
  validateSrtWithinDuration,
  validateReleaseProbe,
} from '../../../src/media/release-verify';
import type {MediaProbe} from '../../../src/media/ffprobe';

const atom = (type: string, payloadBytes = 0): Buffer => {
  const buffer = Buffer.alloc(8 + payloadBytes);
  buffer.writeUInt32BE(8 + payloadBytes, 0);
  buffer.write(type, 4, 4, 'ascii');
  return buffer;
};

const extendedAtom = (type: string, payloadBytes = 0): Buffer => {
  const buffer = Buffer.alloc(16 + payloadBytes);
  buffer.writeUInt32BE(1, 0);
  buffer.write(type, 4, 4, 'ascii');
  buffer.writeBigUInt64BE(BigInt(16 + payloadBytes), 8);
  return buffer;
};

const releaseProbe = (overrides: Partial<MediaProbe> = {}): MediaProbe => ({
  durationMs: 1000,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoStreams: [{
    index: 0,
    codec: 'h264',
    pixelFormat: 'yuv420p',
    width: 1920,
    height: 1080,
    attachedPicture: false,
    averageFrameRate: {numerator: 30, denominator: 1, value: 30},
    realFrameRate: {numerator: 30, denominator: 1, value: 30},
    rotation: 0,
    durationMs: 1000,
    sideDataTypes: [],
  }],
  audioStreams: [{
    index: 1,
    codec: 'aac',
    sampleRate: 48000,
    channels: 2,
    durationMs: 1025,
  }],
  ...overrides,
});

describe('parseTopLevelMp4Atoms', () => {
  it('parses 32-bit, extended, and size-zero atoms', () => {
    const sizeZero = Buffer.alloc(12);
    sizeZero.writeUInt32BE(0, 0);
    sizeZero.write('free', 4, 4, 'ascii');
    const atoms = parseTopLevelMp4Atoms(Buffer.concat([
      atom('ftyp', 4),
      extendedAtom('moov', 4),
      sizeZero,
    ]));

    expect(atoms).toEqual([
      {type: 'ftyp', offset: 0, size: 12},
      {type: 'moov', offset: 12, size: 20},
      {type: 'free', offset: 32, size: 12},
    ]);
  });

  it('requires moov before mdat', () => {
    expect(() => assertMoovBeforeMdat(parseTopLevelMp4Atoms(Buffer.concat([
      atom('ftyp'), atom('mdat'), atom('moov'),
    ])))).toThrow(/RELEASE_DECODE_FAILED/);
  });

  it('rejects truncated MP4 atom headers', () => {
    expect(() => parseTopLevelMp4Atoms(Buffer.alloc(7))).toThrow(/RELEASE_DECODE_FAILED/);
  });
});

describe('validateSrtWithinDuration', () => {
  it('accepts parseable SRT cues inside the release duration', () => {
    expect(() => validateSrtWithinDuration(
      '1\n00:00:00,000 --> 00:00:01,000\n介绍\n',
      1000,
    )).not.toThrow();
  });

  it('rejects SRT cues that end after the release duration', () => {
    expect(() => validateSrtWithinDuration(
      '1\n00:00:00,000 --> 00:00:02,000\n介绍\n',
      1000,
    )).toThrow(/RELEASE_DECODE_FAILED/);
  });
});

describe('validateReleaseProbe', () => {
  it('accepts the fixed release media profile', () => {
    expect(() => validateReleaseProbe(releaseProbe())).not.toThrow();
  });

  it('rejects missing audio', () => {
    expect(() => validateReleaseProbe(releaseProbe({audioStreams: []}))).toThrow(/RELEASE_DECODE_FAILED/);
  });

  it('rejects wrong dimensions', () => {
    expect(() => validateReleaseProbe(releaseProbe({videoStreams: [{...releaseProbe().videoStreams[0]!, width: 960}]}))).toThrow(/RELEASE_DECODE_FAILED/);
  });

  it('rejects excessive A\/V duration difference', () => {
    expect(() => validateReleaseProbe(releaseProbe({audioStreams: [{...releaseProbe().audioStreams[0]!, durationMs: 1200}]}))).toThrow(/RELEASE_DURATION_MISMATCH/);
  });
});
