import {describe, expect, it} from 'vitest';
import {
  AUDIO_MIX_ALGORITHM_VERSION,
  audioMixFingerprint,
  buildAudioFilterGraph,
  buildDuckingEnvelope,
  type AudioMixInput,
} from '../../../src/media/audio-mix';

const input = (): AudioMixInput => ({
  compositionDurationMs: 10_000,
  narrationPath: 'audio/narration.wav',
  backgroundMusic: {renderPath: 'assets/source/music.wav', startMs: 0, durationMs: 12_000},
  narrationIntervals: [
    {segmentId: 'a', startMs: 1000, endMs: 2000},
    {segmentId: 'b', startMs: 4500, endMs: 5000},
  ],
  backgroundMusicGainDb: -20,
  duckDuringNarrationDb: -12,
  duckAttackMs: 100,
  duckReleaseMs: 250,
  targetLufs: -16,
  truePeakDb: -1.5,
  algorithmVersion: AUDIO_MIX_ALGORITHM_VERSION,
});

describe('buildDuckingEnvelope', () => {
  it('clamps and merges overlapping attack/release ranges', () => {
    expect(buildDuckingEnvelope({
      compositionDurationMs: 3000,
      intervals: [
        {segmentId: 'a', startMs: 50, endMs: 1000},
        {segmentId: 'b', startMs: 1100, endMs: 4000},
      ],
      attackMs: 100,
      releaseMs: 250,
      duckDb: -12,
    })).toEqual([{startMs: 0, duckStartMs: 50, duckEndMs: 3000, endMs: 3000, gain: expect.closeTo(0.251188643150958, 12)}]);
  });
});

describe('audioMixFingerprint', () => {
  const mutations: Array<[string, (value: AudioMixInput) => AudioMixInput]> = [
    ['narration intervals', (value) => ({...value, narrationIntervals: [{...value.narrationIntervals[0]!, endMs: 2100}, value.narrationIntervals[1]!]} )],
    ['composition duration', (value) => ({...value, compositionDurationMs: 10_001})],
    ['BGM metadata', (value) => ({...value, backgroundMusic: {...value.backgroundMusic, startMs: 1}})],
    ['backgroundMusicGainDb', (value) => ({...value, backgroundMusicGainDb: -21})],
    ['duckDuringNarrationDb', (value) => ({...value, duckDuringNarrationDb: -13})],
    ['duckAttackMs', (value) => ({...value, duckAttackMs: 101})],
    ['duckReleaseMs', (value) => ({...value, duckReleaseMs: 251})],
    ['targetLufs', (value) => ({...value, targetLufs: -17})],
    ['truePeakDb', (value) => ({...value, truePeakDb: -1.6})],
    ['algorithm version', (value) => ({...value, algorithmVersion: 'audio-mix-v2'})],
  ];

  it.each(mutations)('changes when %s changes', (_label, mutate) => {
    const baseline = input();
    expect(audioMixFingerprint(mutate(baseline))).not.toBe(audioMixFingerprint(baseline));
  });
});

describe('buildAudioFilterGraph', () => {
  it('serializes an amix graph with volume ducking and trim to composition duration', () => {
    const graph = buildAudioFilterGraph(input());

    expect(graph).toContain('volume=');
    expect(graph).toContain('amix=inputs=2:normalize=0');
    expect(graph).toContain('atrim=0:10.000');
  });
});
