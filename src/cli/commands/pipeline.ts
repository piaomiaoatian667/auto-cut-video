import type {loadProject, ProjectInputs} from '../../domain/load-project';
import {
  ExecutionPlanError,
  type ExecutionPlan,
  type ExecutionPlanRequest,
} from '../../pipeline/execution-plan';
import {PipelineRuntimeError} from '../../pipeline/runtime-errors';
import type {
  PipelineRunResult,
  RunExecutionInput,
} from '../../pipeline/runner';
import type {PipelinePreset, StageId} from '../../pipeline/run-store';
import {
  installPipelineSignalHandlers,
  signalExitCode,
  type PipelineSignalHandle,
} from '../../pipeline/signals';
import type {
  discoverProjectSourceCatalog,
  ProjectSourceCatalog,
} from '../../pipeline/source-assets';
import {EXIT_CODES} from '../exit-codes';
import {
  formatExecutionPlan,
  formatPipelineFailure,
  formatPipelineResult,
  type PipelineFailure,
} from '../output';
import type {OutputWriter} from '../videoctl';

export interface PipelineCommandOptions {
  preset?: PipelinePreset;
  plan?: boolean;
  from?: StageId;
  to?: StageId;
  resume?: boolean;
  force?: StageId;
  json?: boolean;
}

export interface PipelineCommandDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  loadProject: typeof loadProject;
  discoverProjectSourceCatalog: typeof discoverProjectSourceCatalog;
  buildExecutionPlan(
    project: ProjectInputs,
    sourceCatalog: ProjectSourceCatalog,
    request: ExecutionPlanRequest,
  ): Promise<ExecutionPlan>;
  runExecutionPlan(input: RunExecutionInput): Promise<PipelineRunResult>;
  installPipelineSignalHandlers: typeof installPipelineSignalHandlers;
}

export type PipelineCommandOutcome =
  | {kind: 'plan'; exitCode: number; plan: ExecutionPlan}
  | {kind: 'result'; exitCode: number; result: PipelineRunResult}
  | {kind: 'failure'; exitCode: number; failure: PipelineFailure};

const executionRequest = (
  options: PipelineCommandOptions,
): ExecutionPlanRequest => ({
  ...(options.preset === undefined ? {} : {preset: options.preset}),
  ...(options.from === undefined ? {} : {from: options.from}),
  ...(options.to === undefined ? {} : {to: options.to}),
  ...(options.resume === undefined ? {} : {resume: options.resume}),
  ...(options.force === undefined ? {} : {force: options.force}),
});

const readCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const code = (error as {code?: unknown}).code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

const STAGE_IDS = new Set<StageId>([
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
  'review',
  'release',
]);

const readStageId = (error: unknown): StageId | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const stageId = (error as {stageId?: unknown}).stageId;
    return typeof stageId === 'string' && STAGE_IDS.has(stageId as StageId)
      ? stageId as StageId
      : undefined;
  } catch {
    return undefined;
  }
};

const stripCodePrefix = (code: string, message: string): string => {
  const prefix = `${code}: `;
  return message.startsWith(prefix) ? message.slice(prefix.length) : message;
};

const publicFailure = (
  projectId: string,
  error: unknown,
  fallbackCode: string,
  fallbackMessage: string,
): PipelineFailure => {
  const code = readCode(error) ?? fallbackCode;
  if (
    error instanceof Error
    && (
      error instanceof ExecutionPlanError
      || error instanceof PipelineRuntimeError
      || code.startsWith('PLAN_')
    )
  ) {
    const stageId = error instanceof ExecutionPlanError
      || error instanceof PipelineRuntimeError
      ? error.stageId
      : readStageId(error);
    return {
      projectId,
      code,
      message: stripCodePrefix(code, error.message),
      ...(stageId === undefined ? {} : {stageId}),
    };
  }
  return {projectId, code: fallbackCode, message: fallbackMessage};
};

const errorName = (error: unknown): string | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const name = (error as {name?: unknown}).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
};

const isSchemaValidationError = (error: unknown): boolean => (
  errorName(error) === 'ZodError'
  || error instanceof SyntaxError
);

const isProjectLoadValidationError = (error: unknown): boolean => {
  const code = readCode(error);
  return isSchemaValidationError(error)
    || code === 'PROJECT_ID_MISMATCH'
    || code === 'APP_PATH_OUTSIDE_SCOPE'
    || code === 'ASSET_PATH_OUTSIDE_PROJECT'
    || code === 'SCRIPT_SEGMENT_TEXT_TOO_LONG'
    || code === 'ENOENT';
};

const isSourceCatalogValidationError = (error: unknown): boolean => {
  const code = readCode(error);
  return isSchemaValidationError(error)
    || code?.startsWith('PROJECT_SOURCE_') === true;
};

const isPlanValidationError = (error: unknown): boolean => (
  isSchemaValidationError(error)
  || error instanceof ExecutionPlanError
  || readCode(error)?.startsWith('PLAN_') === true
);

const environmentMessage = (code: string | undefined): string | undefined => {
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return 'Pipeline environment access was denied.';
    case 'ENV_TOOL_MISSING':
      return 'Required pipeline tooling is unavailable.';
    case 'ENOSPC':
    case 'DISK_SPACE_EXHAUSTED':
      return 'Pipeline storage is exhausted.';
    default:
      return code?.startsWith('ENV_') === true
        ? 'Pipeline environment validation failed.'
        : undefined;
  }
};

const validationFailure = (
  projectId: string,
  error: unknown,
): PipelineCommandOutcome => ({
  kind: 'failure',
  exitCode: EXIT_CODES.validationFailed,
  failure: publicFailure(
    projectId,
    error,
    'PIPELINE_VALIDATION_FAILED',
    'Pipeline inputs or execution plan are invalid.',
  ),
});

const environmentFailure = (
  projectId: string,
  error: unknown,
): PipelineCommandOutcome => {
  const code = readCode(error);
  const message = environmentMessage(code);
  return {
    kind: 'failure',
    exitCode: EXIT_CODES.environmentFailed,
    failure: message === undefined
      ? publicFailure(
        projectId,
        error,
        'PIPELINE_EXECUTION_FAILED',
        'Pipeline execution failed unexpectedly.',
      )
      : {
        projectId,
        code: code!,
        message,
        ...(readStageId(error) === undefined ? {} : {stageId: readStageId(error)!}),
      },
  };
};

const signalFailure = (
  projectId: string,
  handle: PipelineSignalHandle,
): PipelineCommandOutcome => ({
  kind: 'failure',
  exitCode: signalExitCode(handle.received),
  failure: {
    projectId,
    code: 'PIPELINE_CANCELLED',
    message: 'Pipeline execution was cancelled.',
  },
});

const projectLoadFailure = (
  projectId: string,
  error: unknown,
): PipelineCommandOutcome => isProjectLoadValidationError(error)
  ? {
    kind: 'failure',
    exitCode: EXIT_CODES.validationFailed,
    failure: {
      projectId,
      code: 'PROJECT_LOAD_FAILED',
      message: 'Unable to load or validate project.',
    },
  }
  : environmentFailure(projectId, error);

const sourceCatalogFailure = (
  projectId: string,
  error: unknown,
): PipelineCommandOutcome => isSourceCatalogValidationError(error)
  ? {
    kind: 'failure',
    exitCode: EXIT_CODES.validationFailed,
    failure: {
      projectId,
      code: 'PROJECT_SOURCE_INVALID',
      message: 'Project source assets could not be discovered safely.',
    },
  }
  : environmentFailure(projectId, error);

const resultExitCode = (result: PipelineRunResult): number => {
  switch (result.state) {
    case 'passed':
      return EXIT_CODES.success;
    case 'needs_review':
      return EXIT_CODES.needsReview;
    case 'failed':
      return EXIT_CODES.environmentFailed;
    case 'cancelled':
      return EXIT_CODES.cancelled;
  }
};

export async function executePipelineCommand(
  projectId: string,
  options: PipelineCommandOptions,
  dependencies: PipelineCommandDependencies,
): Promise<PipelineCommandOutcome> {
  let project: ProjectInputs;
  try {
    project = await dependencies.loadProject(
      dependencies.workspaceRoot,
      projectId,
    );
  } catch (error) {
    return projectLoadFailure(projectId, error);
  }

  let sourceCatalog: ProjectSourceCatalog;
  try {
    sourceCatalog = await dependencies.discoverProjectSourceCatalog(project);
  } catch (error) {
    return sourceCatalogFailure(projectId, error);
  }

  const request = executionRequest(options);
  let plan: ExecutionPlan;
  try {
    plan = await dependencies.buildExecutionPlan(project, sourceCatalog, request);
  } catch (error) {
    return isPlanValidationError(error)
      ? validationFailure(projectId, error)
      : environmentFailure(projectId, error);
  }

  if (options.plan === true) {
    return {kind: 'plan', exitCode: EXIT_CODES.success, plan};
  }

  let handle: PipelineSignalHandle;
  try {
    handle = dependencies.installPipelineSignalHandlers();
  } catch (error) {
    return environmentFailure(projectId, error);
  }

  try {
    let activePlan = plan;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await dependencies.runExecutionPlan({
          plan: activePlan,
          project,
          sourceCatalog,
          signal: handle.signal,
        });
        const exitCode = result.state === 'cancelled' && handle.received !== undefined
          ? signalExitCode(handle.received)
          : resultExitCode(result);
        return {kind: 'result', exitCode, result};
      } catch (error) {
        if (handle.received !== undefined) return signalFailure(projectId, handle);
        if (readCode(error) === 'PLAN_STALE' && attempt === 0) {
          try {
            activePlan = await dependencies.buildExecutionPlan(
              project,
              sourceCatalog,
              request,
            );
          } catch (rebuildError) {
            return isPlanValidationError(rebuildError)
              ? validationFailure(projectId, rebuildError)
              : environmentFailure(projectId, rebuildError);
          }
          continue;
        }
        return isPlanValidationError(error)
          ? validationFailure(projectId, error)
          : environmentFailure(projectId, error);
      }
    }
    return validationFailure(
      projectId,
      new ExecutionPlanError('PLAN_STALE', 'Pipeline plan remained stale.'),
    );
  } finally {
    handle.dispose();
  }
}

export async function runPipelineCommand(
  projectId: string,
  options: PipelineCommandOptions,
  dependencies: PipelineCommandDependencies,
): Promise<number> {
  const outcome = await executePipelineCommand(projectId, options, dependencies);
  if (outcome.kind === 'plan') {
    dependencies.stdout.write(formatExecutionPlan(
      outcome.plan,
      options.json === true,
    ));
  } else if (outcome.kind === 'result') {
    dependencies.stdout.write(formatPipelineResult(
      outcome.result,
      options.json === true,
    ));
  } else {
    const output = formatPipelineFailure(outcome.failure, options.json === true);
    if (options.json === true) dependencies.stdout.write(output);
    else dependencies.stderr.write(output);
  }
  return outcome.exitCode;
}
