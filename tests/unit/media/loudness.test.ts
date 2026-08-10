import {describe, expect, it} from 'vitest';
import {buildSecondPassLoudnormFilter, parseLoudnormStats} from '../../../src/media/loudness';

describe('parseLoudnormStats', () => {
  it('extracts finite loudnorm JSON values from stderr', () => {
    expect(parseLoudnormStats(`noise\n{\n  "input_i" : "-18.10",\n  "input_tp" : "-2.30",\n  "input_lra" : "1.20",\n  "input_thresh" : "-28.00",\n  "target_offset" : "0.40"\n}\n`)).toEqual({
      inputI: -18.1,
      inputTp: -2.3,
      inputLra: 1.2,
      inputThresh: -28,
      targetOffset: 0.4,
    });
  });

  it('rejects missing or non-finite measurements', () => {
    expect(() => parseLoudnormStats('{"input_i":"inf"}')).toThrow(/LOUDNORM_MEASUREMENT_INVALID/);
  });
});

describe('buildSecondPassLoudnormFilter', () => {
  it('serializes measured values for a deterministic second pass', () => {
    expect(buildSecondPassLoudnormFilter({
      targetLufs: -16,
      truePeakDb: -1.5,
      stats: {inputI: -18.1, inputTp: -2.3, inputLra: 1.2, inputThresh: -28, targetOffset: 0.4},
    })).toContain('measured_I=-18.1');
  });
});
