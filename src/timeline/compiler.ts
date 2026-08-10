import {CompiledTimelineSchema, type CompiledTimeline} from '../domain/timeline-schema';
import type {Edit, VisualClip} from '../domain/edit-schema';
import type {
  AssetManifest,
  AssetRecord,
  CaptionsManifest,
  NarrationManifest,
} from '../domain/manifest-schema';
import type {Project} from '../domain/project-schema';
import type {Script} from '../domain/script-schema';
import {parseOverlayProps} from '../remotion/registry';

export type TimelineCompileErrorCode =
  | 'ASSET_NOT_FOUND'
  | 'EDIT_ASSET_KIND_INVALID'
  | 'EDIT_COMPONENT_PROPS_INVALID'
  | 'EDIT_COMPONENT_UNREGISTERED'
  | 'EDIT_TRIM_OUT_OF_BOUNDS'
  | 'EDIT_TRIM_DURATION_MISMATCH'
  | 'AUDIO_BGM_TOO_SHORT'
  | 'TIMELINE_GAP_UNDECLARED';

export class TimelineCompileError extends Error {
  constructor(readonly code: TimelineCompileErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'TimelineCompileError';
  }
}

export interface CompileTimelineInput {
  project: Project;
  script: Script;
  edit: Edit;
  assetManifest: AssetManifest;
  narrationManifest: NarrationManifest;
  captionsManifest: CaptionsManifest;
  inputHashes?: Record<string, string>;
}

const frameDurationMs = (fps: number): number => 1000 / fps;

const startFrameFromMs = (milliseconds: number, fps: number): number =>
  Math.floor(milliseconds * fps / 1000);

const endFrameFromMs = (milliseconds: number, fps: number): number =>
  Math.ceil(milliseconds * fps / 1000);

const endFrame = (startFrame: number, durationInFrames: number): number =>
  startFrame + durationInFrames;

const resolveAsset = (
  manifest: AssetManifest,
  assetId: string,
): AssetRecord => {
  const asset = manifest.assets[assetId];
  if (asset === undefined) {
    throw new TimelineCompileError(
      'ASSET_NOT_FOUND',
      `asset is not declared in asset-manifest.json: ${assetId}`,
    );
  }
  return asset;
};

const assertAssetKind = (
  assetId: string,
  asset: AssetRecord,
  expectedKind: AssetRecord['kind'],
): void => {
  if (asset.kind !== expectedKind) {
    throw new TimelineCompileError(
      'EDIT_ASSET_KIND_INVALID',
      `asset ${assetId} is ${asset.kind}, expected ${expectedKind}`,
    );
  }
};

const compileVideoClip = (
  clip: Extract<VisualClip, {kind: 'video'}>,
  asset: AssetRecord,
  fps: number,
): CompiledTimeline['visualClips'][number] => {
  assertAssetKind(clip.assetId, asset, 'video');
  if (
    asset.durationMs === undefined
    || clip.sourceInMs < 0
    || clip.sourceInMs >= clip.sourceOutMs
    || clip.sourceOutMs > asset.durationMs
  ) {
    throw new TimelineCompileError(
      'EDIT_TRIM_OUT_OF_BOUNDS',
      `video clip ${clip.id} trim is outside asset ${clip.assetId}`,
    );
  }

  const sourceDurationMs = clip.sourceOutMs - clip.sourceInMs;
  const timelineDurationMs = clip.durationInFrames * frameDurationMs(fps);
  if (Math.abs(sourceDurationMs - timelineDurationMs) > frameDurationMs(fps) + Number.EPSILON) {
    throw new TimelineCompileError(
      'EDIT_TRIM_DURATION_MISMATCH',
      `video clip ${clip.id} source duration does not match timeline duration`,
    );
  }

  return {
    id: clip.id,
    kind: clip.kind,
    renderPath: asset.renderPath,
    startFrame: clip.startFrame,
    durationInFrames: clip.durationInFrames,
    sourceInMs: clip.sourceInMs,
    fit: clip.fit,
    position: clip.position,
    scale: clip.scale,
    opacity: clip.opacity,
    fadeInFrames: clip.fadeInFrames,
    fadeOutFrames: clip.fadeOutFrames,
    zIndex: clip.zIndex,
  };
};

const compileImageClip = (
  clip: Extract<VisualClip, {kind: 'image'}>,
  asset: AssetRecord,
): CompiledTimeline['visualClips'][number] => {
  assertAssetKind(clip.assetId, asset, 'image');
  return {
    id: clip.id,
    kind: clip.kind,
    renderPath: asset.renderPath,
    startFrame: clip.startFrame,
    durationInFrames: clip.durationInFrames,
    fit: clip.fit,
    position: clip.position,
    scale: clip.scale,
    opacity: clip.opacity,
    fadeInFrames: clip.fadeInFrames,
    fadeOutFrames: clip.fadeOutFrames,
    zIndex: clip.zIndex,
  };
};

const compileVisualClip = (
  clip: VisualClip,
  assetManifest: AssetManifest,
  fps: number,
): CompiledTimeline['visualClips'][number] => {
  const asset = resolveAsset(assetManifest, clip.assetId);
  return clip.kind === 'video'
    ? compileVideoClip(clip, asset, fps)
    : compileImageClip(clip, asset);
};

const visualCoverageRanges = (
  clips: readonly CompiledTimeline['visualClips'][number][],
): Array<{startFrame: number; endFrame: number}> => clips
  .map((clip) => ({
    startFrame: clip.startFrame,
    endFrame: endFrame(clip.startFrame, clip.durationInFrames),
  }))
  .sort((left, right) => left.startFrame - right.startFrame || left.endFrame - right.endFrame);

const assertVisualCoverage = (
  clips: readonly CompiledTimeline['visualClips'][number][],
  durationInFrames: number,
  allowBackgroundGaps: boolean,
): void => {
  if (allowBackgroundGaps) return;
  const ranges = visualCoverageRanges(clips);
  let coveredUntil = 0;
  for (const range of ranges) {
    if (range.startFrame > coveredUntil) {
      throw new TimelineCompileError(
        'TIMELINE_GAP_UNDECLARED',
        `visual timeline has an undeclared gap before frame ${range.startFrame}`,
      );
    }
    coveredUntil = Math.max(coveredUntil, range.endFrame);
    if (coveredUntil >= durationInFrames) return;
  }
  if (coveredUntil < durationInFrames) {
    throw new TimelineCompileError(
      'TIMELINE_GAP_UNDECLARED',
      `visual timeline ends at frame ${coveredUntil} before composition frame ${durationInFrames}`,
    );
  }
};

const compileOverlays = (
  edit: Edit,
): CompiledTimeline['overlays'] => edit.overlays.map((overlay) => ({
  id: overlay.id,
  component: overlay.component,
  startFrame: overlay.startFrame,
  durationInFrames: overlay.durationInFrames,
  props: parseOverlayProps(overlay.component, overlay.props),
  zIndex: overlay.zIndex,
}));

const compileCaptions = (
  captionsManifest: CaptionsManifest,
  fps: number,
): CompiledTimeline['captions'] => captionsManifest.cues.map((cue) => ({
  id: cue.id,
  segmentId: cue.segmentId,
  text: cue.text,
  startFrame: startFrameFromMs(cue.startMs, fps),
  endFrame: endFrameFromMs(cue.endMs, fps),
}));

const compileNarration = (
  narrationManifest: NarrationManifest,
): CompiledTimeline['narration'] => ({
  audioPath: narrationManifest.master.audioPath,
  durationMs: narrationManifest.master.durationMs,
  intervals: narrationManifest.segments.map((segment) => ({
    segmentId: segment.id,
    startMs: segment.startMs,
    endMs: segment.endMs,
  })),
});

const compileBackgroundMusic = (
  edit: Edit,
  assetManifest: AssetManifest,
  compositionDurationMs: number,
): CompiledTimeline['backgroundMusic'] => {
  if (edit.backgroundMusic === undefined) return undefined;
  const asset = resolveAsset(assetManifest, edit.backgroundMusic.assetId);
  assertAssetKind(edit.backgroundMusic.assetId, asset, 'audio');
  if (
    asset.durationMs === undefined
    || asset.durationMs - edit.backgroundMusic.startMs + Number.EPSILON < compositionDurationMs
  ) {
    throw new TimelineCompileError(
      'AUDIO_BGM_TOO_SHORT',
      `background music ${edit.backgroundMusic.assetId} is shorter than the composition`,
    );
  }
  return {
    renderPath: asset.renderPath,
    startMs: edit.backgroundMusic.startMs,
    durationMs: asset.durationMs,
  };
};

const collectUsedAssetHashes = (
  edit: Edit,
  assetManifest: AssetManifest,
): Record<string, string> => {
  const hashes: Record<string, string> = {};
  const usedAssetIds = new Set<string>(edit.visualClips.map((clip) => clip.assetId));
  if (edit.backgroundMusic !== undefined) usedAssetIds.add(edit.backgroundMusic.assetId);
  for (const assetId of [...usedAssetIds].sort()) {
    hashes[`asset:${assetId}`] = resolveAsset(assetManifest, assetId).sourceHash;
  }
  return hashes;
};

const maxEndFrame = (
  items: readonly {startFrame: number; durationInFrames: number}[],
): number => items.reduce(
  (maximum, item) => Math.max(maximum, endFrame(item.startFrame, item.durationInFrames)),
  0,
);

export const compileTimeline = (input: CompileTimelineInput): CompiledTimeline => {
  const fps = input.project.composition.fps;
  const visualClips = input.edit.visualClips.map((clip) =>
    compileVisualClip(clip, input.assetManifest, fps));
  const overlays = compileOverlays(input.edit);
  const captions = compileCaptions(input.captionsManifest, fps);
  const narration = compileNarration(input.narrationManifest);
  const durationInFrames = Math.max(
    maxEndFrame(visualClips),
    maxEndFrame(overlays),
    captions.reduce((maximum, caption) => Math.max(maximum, caption.endFrame), 0),
    endFrameFromMs(narration.durationMs, fps),
  );
  assertVisualCoverage(
    visualClips,
    durationInFrames,
    input.project.composition.allowBackgroundGaps,
  );
  const compositionDurationMs = durationInFrames * frameDurationMs(fps);
  const backgroundMusic = compileBackgroundMusic(
    input.edit,
    input.assetManifest,
    compositionDurationMs,
  );
  const compiled = {
    version: 1,
    projectId: input.project.id,
    width: input.project.composition.width,
    height: input.project.composition.height,
    fps,
    durationInFrames,
    inputHashes: {
      ...input.inputHashes,
      ...collectUsedAssetHashes(input.edit, input.assetManifest),
      'caption:sourceNarration': input.captionsManifest.sourceNarrationHash,
      'narration:master': input.narrationManifest.master.audioHash,
    },
    visualClips,
    overlays,
    captions,
    narration,
    ...(backgroundMusic === undefined ? {} : {backgroundMusic}),
  };
  return CompiledTimelineSchema.parse(compiled);
};
