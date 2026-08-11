import type {PreflightResult} from '../../src/pipeline/stages/preflight';
import type {PipelineStage, StageExecutionResult} from '../../src/pipeline/stage';
import type {StageReport} from '../../src/pipeline/stage-report';
import type {RunDirectoryScope} from '../../src/fs/app-directory-scopes';
import {
  createRunStore,
  type StageId,
} from '../../src/pipeline/run-store';
import {createTempProject} from './temp-project';

const STAGE_POSITIONS: Record<StageId, number> = {
  preflight: 1,
  ingest: 2,
  narration: 3,
  compile: 4,
  draft: 5,
  review: 6,
  release: 7,
};

const successfulExecution = (): StageExecutionResult => ({
  state: 'passed',
  fingerprint: `sha256:${'a'.repeat(64)}`,
  outputs: {},
  artifacts: [],
  checks: [],
});

export const passedStageReport = (
  overrides: Partial<StageReport> = {},
): StageReport => {
  const stageId = overrides.stageId ?? 'preflight';
  return {
    version: 1,
    projectId: 'demo',
    runId: 'run-one',
    preset: 'release',
    stageId,
    position: STAGE_POSITIONS[stageId],
    total: 7,
    state: 'passed',
    fingerprint: `sha256:${'b'.repeat(64)}`,
    startedAt: '2026-08-11T01:02:03.000Z',
    finishedAt: '2026-08-11T01:02:04.000Z',
    artifacts: [{
      scope: 'run',
      path: `${stageId}.json`,
      sha256: `sha256:${'c'.repeat(64)}`,
    }],
    outputs: {stageId},
    checks: [{
      id: `${stageId}-complete`,
      severity: 'info',
      message: `${stageId} completed`,
    }],
    ...overrides,
  };
};

export const fakeStage = (
  id: StageId,
  overrides: Partial<Omit<PipelineStage, 'id'>> = {},
): PipelineStage => ({
  id,
  displayName: id,
  prerequisites: [],
  fingerprint: async () => null,
  verify: async () => true,
  partialArtifacts: () => [],
  execute: async () => successfulExecution(),
  ...overrides,
});

export const fakePreflightResult = (): PreflightResult => ({
  checks: [],
  toolIdentities: {
    ffmpeg: null,
    qtFaststart: null,
  },
  fonts: [],
  voice: {
    configured: 'fixture',
    available: true,
    segmentedWavFallback: false,
  },
  versions: {
    node: process.version,
    pnpm: null,
    macos: null,
    ffmpeg: null,
    ffprobe: null,
  },
  system: {
    platform: process.platform,
    arch: process.arch,
    sourceBytes: 0,
    requiredBytes: 0,
    availableBytes: null,
    workDirectory: '.work/demo',
  },
  environmentFingerprint: `sha256:${'d'.repeat(64)}`,
});

export interface PipelineRunFixture {
  workspaceRoot: string;
  runDirectory: RunDirectoryScope;
  cleanup(): Promise<void>;
}

export async function createPipelineRunFixture(): Promise<PipelineRunFixture> {
  const project = await createTempProject();
  try {
    const runDirectory = await createRunStore(project.workspaceRoot)
      .createRun('demo', 'run-one');
    return {
      workspaceRoot: project.workspaceRoot,
      runDirectory,
      cleanup: project.cleanup,
    };
  } catch (error) {
    await project.cleanup();
    throw error;
  }
}
