import type {ProjectInputs} from '../domain/load-project';
import type {RunDirectoryScope} from '../fs/app-directory-scopes';
import type {PipelineArtifact} from './artifacts';
import type {CurrentPointer, PipelinePreset, StageId} from './run-store';
import type {ProjectSourceCatalog} from './source-assets';
import type {StageReport} from './stage-report';
import type {PreflightResult} from './stages/preflight';
import type {CheckResult} from './types';

export type StageAction = 'run' | 'cached' | 'resume';

export interface StagePlanningContext {
  project: ProjectInputs;
  sourceCatalog: ProjectSourceCatalog;
  preflight?: PreflightResult;
  sourceRun?: {
    runId: string;
    runDirectory: RunDirectoryScope;
    reports: ReadonlyMap<StageId, StageReport>;
  };
}

export interface StageExecutionContext extends StagePlanningContext {
  preset: PipelinePreset;
  runId?: string;
  runDirectory?: RunDirectoryScope;
  now(): string;
}

export interface StageExecutionResult {
  state: 'passed' | 'needs_review';
  fingerprint: string;
  outputs: unknown;
  artifacts: PipelineArtifact[];
  checks: CheckResult[];
  outputCurrent?: CurrentPointer;
}

export interface PipelinePartialArtifact {
  scope: 'run' | 'output';
  path: string;
}

export interface PipelineStage {
  id: StageId;
  displayName: string;
  prerequisites: readonly StageId[];
  fingerprint(context: StagePlanningContext): Promise<string | null>;
  verify(context: StagePlanningContext, report: StageReport): Promise<boolean>;
  partialArtifacts(context: StageExecutionContext): readonly PipelinePartialArtifact[];
  execute(
    context: StageExecutionContext,
    signal: AbortSignal,
  ): Promise<StageExecutionResult>;
}

export class PipelineContextError extends Error {
  readonly code = 'PIPELINE_CONTEXT_INVALID';

  constructor(message: string) {
    super(`PIPELINE_CONTEXT_INVALID: ${message}`);
    this.name = 'PipelineContextError';
  }
}

export interface RequiredRunContext {
  runId: string;
  runDirectory: RunDirectoryScope;
}

export const requireRunContext = (
  context: Pick<StageExecutionContext, 'runId' | 'runDirectory'>,
): RequiredRunContext => {
  if (
    context.runId === undefined
    || context.runId === null
    || context.runDirectory === undefined
    || context.runDirectory === null
  ) {
    throw new PipelineContextError('Stage execution requires a Run context');
  }
  return {
    runId: context.runId,
    runDirectory: context.runDirectory,
  };
};

export const requirePreflight = (
  context: Pick<StagePlanningContext, 'preflight'>,
): PreflightResult => {
  if (context.preflight === undefined || context.preflight === null) {
    throw new PipelineContextError('Stage execution requires Preflight results');
  }
  return context.preflight;
};
