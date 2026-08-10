import type {CompiledTimeline} from '../domain/timeline-schema';

export interface SelectReviewFramesOptions {
  maximumFrames?: number;
  coverageFrames?: number;
}

const clampFrame = (frame: number, durationInFrames: number): number =>
  Math.min(durationInFrames - 1, Math.max(0, Math.trunc(frame)));

const addUnique = (frames: number[], frame: number): void => {
  if (!frames.includes(frame)) frames.push(frame);
};

const boundaryFrames = (timeline: CompiledTimeline): number[] => {
  const frames: number[] = [];
  addUnique(frames, 0);
  addUnique(frames, timeline.durationInFrames - 1);
  for (const clip of timeline.visualClips) {
    addUnique(frames, clampFrame(clip.startFrame, timeline.durationInFrames));
    addUnique(frames, clampFrame(clip.startFrame + clip.durationInFrames - 1, timeline.durationInFrames));
    addUnique(frames, clampFrame(clip.startFrame + clip.durationInFrames, timeline.durationInFrames));
  }
  for (const caption of timeline.captions) {
    addUnique(frames, clampFrame(
      Math.floor((caption.startFrame + caption.endFrame) / 2),
      timeline.durationInFrames,
    ));
  }
  return frames;
};

const coverageFrameList = (
  durationInFrames: number,
  coverageFrames: number,
): number[] => {
  if (coverageFrames <= 1) return [0];
  return Array.from({length: coverageFrames}, (_, index) => clampFrame(
    Math.round(index * (durationInFrames - 1) / (coverageFrames - 1)),
    durationInFrames,
  ));
};

export const selectReviewFrames = (
  timeline: CompiledTimeline,
  options: SelectReviewFramesOptions = {},
): number[] => {
  const maximumFrames = options.maximumFrames ?? 24;
  const coverageFrames = options.coverageFrames ?? 12;
  const boundaries = boundaryFrames(timeline);
  const selected = new Set<number>(boundaries);
  for (const frame of coverageFrameList(timeline.durationInFrames, coverageFrames)) {
    selected.add(frame);
  }

  if (selected.size <= maximumFrames) {
    return [...selected].sort((left, right) => left - right);
  }

  const preserved = boundaries.slice(0, maximumFrames);
  if (preserved.length >= maximumFrames) return preserved;

  for (const frame of [...selected].sort((left, right) => left - right)) {
    if (preserved.includes(frame)) continue;
    preserved.push(frame);
    if (preserved.length >= maximumFrames) break;
  }
  return preserved.sort((left, right) => left - right);
};
