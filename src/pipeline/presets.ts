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
