import type {PipelinePreset, StageId} from './run-store';

export const STAGE_PRESETS = {
  assets: ['preflight', 'ingest'],
  draft: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
  release: [
    'preflight',
    'ingest',
    'narration',
    'compile',
    'draft',
    'review',
    'release',
  ],
} as const satisfies Record<PipelinePreset, readonly StageId[]>;

export const PIPELINE_PRESET_IDS = Object.freeze(
  Object.keys(STAGE_PRESETS) as PipelinePreset[],
);
