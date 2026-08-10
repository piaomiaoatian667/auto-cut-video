import {describe, expect, it} from 'vitest';
import {
  buildCaptions,
  millisecondsToFrameRange,
} from '../../../src/captions/build-captions';
import type {NarrationManifest} from '../../../src/domain/manifest-schema';
import type {Script} from '../../../src/domain/script-schema';

const script: Script = {
  version: 1,
  language: 'zh-CN',
  segments: [
    {id: 'intro', text: '第一句', normalizedText: '第一句', pauseAfterMs: 100, requiredTerms: []},
    {id: 'outro', text: '第二句', normalizedText: '第二句', pauseAfterMs: 0, requiredTerms: []},
  ],
};

const narration: NarrationManifest = {
  version: 1,
  provider: 'mock',
  segments: [
    {
      id: 'intro',
      inputHash: 'sha256:intro-input',
      audioPath: 'audio/segments/0001-intro.wav',
      audioHash: 'sha256:intro-audio',
      startMs: 0,
      endMs: 1000,
      durationMs: 1000,
      pauseAfterMs: 100,
      sampleRate: 48000,
      channels: 1,
      providerFingerprint: 'sha256:provider',
    },
    {
      id: 'outro',
      inputHash: 'sha256:outro-input',
      audioPath: 'audio/segments/0002-outro.wav',
      audioHash: 'sha256:outro-audio',
      startMs: 1100,
      endMs: 2100,
      durationMs: 1000,
      pauseAfterMs: 0,
      sampleRate: 48000,
      channels: 1,
      providerFingerprint: 'sha256:provider',
    },
  ],
  master: {audioPath: 'audio/narration.wav', audioHash: 'sha256:narration', durationMs: 2100},
};

describe('millisecondsToFrameRange', () => {
  it('does not expand exact frame boundaries', () => {
    expect(millisecondsToFrameRange(1000, 2000, 30)).toEqual({startFrame: 30, endFrame: 60});
  });

  it('expands each non-aligned boundary by less than one frame', () => {
    expect(millisecondsToFrameRange(1, 34, 30)).toEqual({startFrame: 0, endFrame: 2});
  });

  it('always produces at least one frame', () => {
    expect(millisecondsToFrameRange(100, 101, 30)).toEqual({startFrame: 3, endFrame: 4});
  });
});

describe('buildCaptions', () => {
  it('joins script text to narration timings by stable segment ID', () => {
    expect(buildCaptions({script, narration, sourceNarrationHash: narration.master.audioHash})).toEqual({
      version: 1,
      sourceNarrationHash: 'sha256:narration',
      cues: [
        {id: 'caption-intro', segmentId: 'intro', text: '第一句', startMs: 0, endMs: 1000},
        {id: 'caption-outro', segmentId: 'outro', text: '第二句', startMs: 1100, endMs: 2100},
      ],
    });
  });

  it('rejects duplicate script segment IDs defensively', () => {
    expect(() => buildCaptions({
      script: {...script, segments: [script.segments[0]!, script.segments[0]!]},
      narration,
      sourceNarrationHash: narration.master.audioHash,
    })).toThrowError(/CAPTION_SEGMENT_DUPLICATE/);
  });

  it('rejects narration without matching script text', () => {
    expect(() => buildCaptions({
      script: {...script, segments: [script.segments[0]!]},
      narration,
      sourceNarrationHash: narration.master.audioHash,
    })).toThrowError(/CAPTION_SEGMENT_MISSING/);
  });
});
