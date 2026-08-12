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

const ERROR_GRAPH_MAX_DEPTH = 8;
const ERROR_GRAPH_MAX_NODES = 64;

interface ErrorGraphEntry {
  error: object;
  depth: number;
}

const readCause = (error: object): unknown => {
  try {
    return (error as {cause?: unknown}).cause;
  } catch {
    return undefined;
  }
};

const readAggregateErrors = (error: object): readonly unknown[] => {
  if (!(error instanceof AggregateError) && errorName(error) !== 'AggregateError') {
    return [];
  }
  try {
    const errors = (error as {errors?: unknown}).errors;
    return Array.isArray(errors)
      ? errors.slice(0, ERROR_GRAPH_MAX_NODES)
      : [];
  } catch {
    return [];
  }
};

const inspectErrorGraph = (root: unknown): readonly ErrorGraphEntry[] => {
  const queue: Array<{error: unknown; depth: number}> = [{error: root, depth: 0}];
  const entries: ErrorGraphEntry[] = [];
  const seen = new Set<object>();
  let queueIndex = 0;

  while (
    queueIndex < queue.length
    && entries.length < ERROR_GRAPH_MAX_NODES
  ) {
    const current = queue[queueIndex++]!;
    if (current.error === null || typeof current.error !== 'object') continue;
    if (seen.has(current.error)) continue;
    seen.add(current.error);
    entries.push({error: current.error, depth: current.depth});
    if (current.depth >= ERROR_GRAPH_MAX_DEPTH) continue;

    const nextDepth = current.depth + 1;
    const cause = readCause(current.error);
    if (cause !== undefined) queue.push({error: cause, depth: nextDepth});
    for (const aggregateError of readAggregateErrors(current.error)) {
      queue.push({error: aggregateError, depth: nextDepth});
    }
  }

  return entries;
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
    case 'EIO':
      return 'Pipeline environment I/O failed.';
    case 'ENV_TOOL_MISSING':
      return 'Required pipeline tooling is unavailable.';
    case 'ENOSPC':
    case 'EDQUOT':
    case 'DISK_SPACE_EXHAUSTED':
      return 'Pipeline storage is exhausted.';
    case 'EROFS':
      return 'Pipeline storage is read-only.';
    case 'EMFILE':
    case 'ENFILE':
      return 'Pipeline environment file capacity was exhausted.';
    case 'ENOMEM':
      return 'Pipeline environment memory was exhausted.';
    default:
      return code?.startsWith('ENV_') === true
        ? 'Pipeline environment validation failed.'
        : undefined;
  }
};

interface EnvironmentIssue {
  code: string;
  message: string;
  stageId?: StageId;
}

const findEnvironmentIssue = (
  entries: readonly ErrorGraphEntry[],
): EnvironmentIssue | undefined => {
  const rootStageId = entries[0] === undefined
    ? undefined
    : readStageId(entries[0].error);
  for (const entry of entries) {
    const code = readCode(entry.error);
    const message = environmentMessage(code);
    if (code !== undefined && message !== undefined) {
      const stageId = readStageId(entry.error) ?? rootStageId;
      return {
        code,
        message,
        ...(stageId === undefined ? {} : {stageId}),
      };
    }
  }
  return undefined;
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
  entries: readonly ErrorGraphEntry[] = inspectErrorGraph(error),
): PipelineCommandOutcome => {
  const issue = findEnvironmentIssue(entries);
  return {
    kind: 'failure',
    exitCode: EXIT_CODES.environmentFailed,
    failure: issue === undefined
      ? publicFailure(
        projectId,
        error,
        'PIPELINE_EXECUTION_FAILED',
        'Pipeline execution failed unexpectedly.',
      )
      : {
        projectId,
        code: issue.code,
        message: issue.message,
        ...(issue.stageId === undefined ? {} : {stageId: issue.stageId}),
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
): PipelineCommandOutcome => {
  const entries = inspectErrorGraph(error);
  if (findEnvironmentIssue(entries) !== undefined) {
    return environmentFailure(projectId, error, entries);
  }
  return entries.some(({error: entry}) => isProjectLoadValidationError(entry))
    ? {
      kind: 'failure',
      exitCode: EXIT_CODES.validationFailed,
      failure: {
        projectId,
        code: 'PROJECT_LOAD_FAILED',
        message: 'Unable to load or validate project.',
      },
    }
    : environmentFailure(projectId, error, entries);
};

const sourceCatalogFailure = (
  projectId: string,
  error: unknown,
): PipelineCommandOutcome => {
  const entries = inspectErrorGraph(error);
  if (findEnvironmentIssue(entries) !== undefined) {
    return environmentFailure(projectId, error, entries);
  }
  return entries.some(({error: entry}) => isSourceCatalogValidationError(entry))
    ? {
      kind: 'failure',
      exitCode: EXIT_CODES.validationFailed,
      failure: {
        projectId,
        code: 'PROJECT_SOURCE_INVALID',
        message: 'Project source assets could not be discovered safely.',
      },
    }
    : environmentFailure(projectId, error, entries);
};

const planFailure = (
  projectId: string,
  error: unknown,
): PipelineCommandOutcome => {
  const entries = inspectErrorGraph(error);
  if (findEnvironmentIssue(entries) !== undefined) {
    return environmentFailure(projectId, error, entries);
  }
  const validationError = entries.find(
    ({error: entry}) => isPlanValidationError(entry),
  )?.error;
  return validationError === undefined
    ? environmentFailure(projectId, error, entries)
    : validationFailure(projectId, validationError);
};

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
    return planFailure(projectId, error);
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
            return planFailure(projectId, rebuildError);
          }
          continue;
        }
        return planFailure(projectId, error);
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
