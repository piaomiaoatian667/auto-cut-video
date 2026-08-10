import {CaptionsManifestSchema, type CaptionsManifest, type NarrationManifest} from '../domain/manifest-schema';
import type {Script, ScriptSegment} from '../domain/script-schema';

export type CaptionBuildErrorCode =
  | 'CAPTION_SEGMENT_DUPLICATE'
  | 'CAPTION_SEGMENT_MISSING';

export class CaptionBuildError extends Error {
  constructor(readonly code: CaptionBuildErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'CaptionBuildError';
  }
}

export function millisecondsToFrameRange(startMs: number, endMs: number, fps: number) {
  const startFrame = Math.floor(startMs * fps / 1000);
  const rawEndFrame = Math.ceil(endMs * fps / 1000);
  return {startFrame, endFrame: Math.max(startFrame + 1, rawEndFrame)};
}

export interface BuildCaptionsInput {
  script: Script;
  narration: NarrationManifest;
  sourceNarrationHash: string;
}

const scriptSegmentsById = (segments: readonly ScriptSegment[]): Map<string, ScriptSegment> => {
  const byId = new Map<string, ScriptSegment>();
  for (const segment of segments) {
    if (byId.has(segment.id)) {
      throw new CaptionBuildError(
        'CAPTION_SEGMENT_DUPLICATE',
        `duplicate script segment id: ${segment.id}`,
      );
    }
    byId.set(segment.id, segment);
  }
  return byId;
};

const assertNarrationIdsUnique = (narration: NarrationManifest): void => {
  const seen = new Set<string>();
  for (const segment of narration.segments) {
    if (seen.has(segment.id)) {
      throw new CaptionBuildError(
        'CAPTION_SEGMENT_DUPLICATE',
        `duplicate narration segment id: ${segment.id}`,
      );
    }
    seen.add(segment.id);
  }
};

export const buildCaptions = ({
  script,
  narration,
  sourceNarrationHash,
}: BuildCaptionsInput): CaptionsManifest => {
  const segmentsById = scriptSegmentsById(script.segments);
  assertNarrationIdsUnique(narration);
  const cues = narration.segments.map((segment) => {
    const scriptSegment = segmentsById.get(segment.id);
    if (scriptSegment === undefined) {
      throw new CaptionBuildError(
        'CAPTION_SEGMENT_MISSING',
        `narration segment has no matching script text: ${segment.id}`,
      );
    }
    return {
      id: `caption-${segment.id}`,
      segmentId: segment.id,
      text: scriptSegment.text,
      startMs: segment.startMs,
      endMs: segment.endMs,
    };
  });

  for (const segment of script.segments) {
    if (!narration.segments.some((narrationSegment) => narrationSegment.id === segment.id)) {
      throw new CaptionBuildError(
        'CAPTION_SEGMENT_MISSING',
        `script segment has no matching narration timing: ${segment.id}`,
      );
    }
  }

  return CaptionsManifestSchema.parse({
    version: 1,
    sourceNarrationHash,
    cues,
  });
};
