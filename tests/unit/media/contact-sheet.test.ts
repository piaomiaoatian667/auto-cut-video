import {describe, expect, it} from 'vitest';
import {selectReviewFrames} from '../../../src/media/contact-sheet';
import type {CompiledTimeline} from '../../../src/domain/timeline-schema';

const timeline = (overrides: Partial<CompiledTimeline> = {}): CompiledTimeline => ({
  version: 1,
  projectId: 'demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 300,
  inputHashes: {},
  visualClips: [
    {
      id: 'a', kind: 'video', renderPath: 'a.mp4', startFrame: 0, durationInFrames: 90,
      sourceInMs: 0, fit: 'cover', position: {x: 0, y: 0}, scale: 1, opacity: 1,
      fadeInFrames: 0, fadeOutFrames: 0, zIndex: 0,
    },
    {
      id: 'b', kind: 'image', renderPath: 'b.png', startFrame: 90, durationInFrames: 210,
      fit: 'contain', position: {x: 0, y: 0}, scale: 1, opacity: 1,
      fadeInFrames: 0, fadeOutFrames: 0, zIndex: 0,
    },
  ],
  overlays: [],
  captions: [{id: 'caption-a', segmentId: 'a', text: '字幕', startFrame: 30, endFrame: 60}],
  narration: {audioPath: 'audio/narration.wav', durationMs: 10_000, intervals: []},
  ...overrides,
});

describe('selectReviewFrames', () => {
  it('includes start, final frame, visual boundaries, caption midpoint, and coverage frames', () => {
    const frames = selectReviewFrames(timeline(), {maximumFrames: 24, coverageFrames: 6});

    expect(frames).toEqual([...frames].sort((left, right) => left - right));
    expect(frames).toContain(0);
    expect(frames).toContain(299);
    expect(frames).toContain(89);
    expect(frames).toContain(90);
    expect(frames).toContain(45);
    expect(frames.length).toBeLessThanOrEqual(24);
  });

  it('caps at maximumFrames while preserving boundaries', () => {
    const dense = timeline({
      durationInFrames: 1_000,
      visualClips: Array.from({length: 20}, (_, index) => ({
        id: `clip-${index}`,
        kind: 'image' as const,
        renderPath: `image-${index}.png`,
        startFrame: index * 50,
        durationInFrames: 50,
        fit: 'cover' as const,
        position: {x: 0, y: 0},
        scale: 1,
        opacity: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        zIndex: 0,
      })),
      captions: [],
    });

    const frames = selectReviewFrames(dense, {maximumFrames: 8, coverageFrames: 20});

    expect(frames).toHaveLength(8);
    expect(frames).toContain(0);
    expect(frames).toContain(999);
    expect(frames).toContain(49);
    expect(frames).toContain(50);
  });
});
