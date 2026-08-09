import {describe, expect, it} from 'vitest';
import {MVP_PROFILE} from '../../../src/domain/mvp-profile';

describe('MVP_PROFILE', () => {
  it('pins the only supported release profile', () => {
    expect(MVP_PROFILE).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      sampleRate: 48_000,
      pixelFormat: 'yuv420p',
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });
});
