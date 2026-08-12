import {randomUUID} from 'node:crypto';
import {StableIdSchema} from '../domain/schema-primitives';
import type {
  OutputDirectoryScope,
  RunDirectoryScope,
} from '../fs/app-directory-scopes';
import {
  copyRunArtifact,
  deleteRunArtifact,
  type PipelineArtifact,
} from './artifacts';
import {
  cleanupFailedStage as sharedCleanupFailedStage,
  type FailedStageCleanupInput,
} from './cleanup';
import {
  ExecutionPlanError,
  revalidateExecutionPlan,
  RetrySafePlanStaleError,
  type ExecutionPlan,
  type ExecutionPlanContext,
  type ExecutionPlanItem,
} from './execution-plan';
import {aggregateChecks} from './gate';
import {STAGE_PRESETS} from './presets';
import {
  acquireProjectLock,
  type ProjectLockLease,
} from './project-lock';
import type {
  CurrentPointer,
  OutputStore,
  PipelinePreset,
  RunStore,
  StageId,
} from './run-store';
import type {ProjectSourceCatalog} from './source-assets';
import {
  PipelineContextError,
  type PipelinePartialArtifact,
  type PipelineStage,
  type StageExecutionContext,
  type StageExecutionResult,
} from './stage';
import {parsePreflightAdapterOutput} from './stage-adapters';
import {
  StageReportOutcomeError,
  StageReportSchema,
  type StageReport,
  type StageReportStore,
} from './stage-report';
import type {PreflightResult} from './stages/preflight';
import {releaseCurrentPointer} from './stages/release';
import type {ProjectInputs} from '../domain/load-project';
import {
  PipelineRuntimeError,
  normalizePipelineError,
} from './runtime-errors';

export type {FailedStageCleanupInput} from './cleanup';

export interface PipelineRunResult {
  projectId: string;
  runId?: string;
  preset: PipelinePreset;
  state: 'passed' | 'needs_review' | 'failed' | 'cancelled';
  completedStage?: StageId;
  reports: StageReport[];
  preflight?: PreflightResult;
  warnings: Array<{code: string; message: string}>;
}

export interface RunExecutionInput {
  plan: ExecutionPlan;
  project: ProjectInputs;
  sourceCatalog: ProjectSourceCatalog;
  signal: AbortSignal;
}

export interface RunnerDependencies {
  registry: readonly PipelineStage[];
  runStore: RunStore;
  outputStore: OutputStore;
  reportStore: StageReportStore;
  acquireProjectLock: typeof acquireProjectLock;
  copyRunArtifact?: typeof copyRunArtifact;
  cleanupFailedStage?: (input: FailedStageCleanupInput) => Promise<void>;
  createRunId(): string;
  now(): string;
}

interface RunnerSourceRun {
  runId: string;
  runDirectory: RunDirectoryScope;
  reports: Map<StageId, StageReport>;
}

interface PreflightExecution {
  preflight: PreflightResult;
  result: StageExecutionResult;
  startedAt: string;
  finishedAt: string;
}

interface PreflightExecutionStart {
  stage: PipelineStage;
  context: StageExecutionContext;
  startedAt: string;
}

type ActiveStageBoundary =
  | 'execute'
  | 'materialize'
  | 'canonical-report'
  | 'attempt-report'
  | 'work-pointer'
  | 'output-pointer';

interface ActiveStageFailure {
  plan: ExecutionPlan;
  item?: ExecutionPlanItem;
  stage: PipelineStage;
  context: StageExecutionContext;
  startedAt: string;
  boundary: ActiveStageBoundary;
  cleanupPartials: boolean;
}

type PointerOwner = 'Work' | 'Output';

export class PipelinePointerOutcomeError extends AggregateError {
  readonly code = 'PIPELINE_POINTER_OUTCOME_UNKNOWN';

  constructor(
    owner: PointerOwner,
    primaryError: unknown,
    readError?: unknown,
  ) {
    super(
      readError === undefined
        ? [primaryError]
        : [primaryError, readError],
      `${owner} pointer publication outcome could not be determined`,
      {cause: primaryError},
    );
    this.name = 'PipelinePointerOutcomeError';
  }
}

const isMissingPath = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isPointerRollbackOutcomeUnknown = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && error.code === 'RUN_POINTER_ROLLBACK_FAILED'
);

const isOrdinaryReportMiss = (error: unknown): boolean => (
  isMissingPath(error)
  || error instanceof SyntaxError
  || (
    error instanceof Error
    && (
      error.name === 'ZodError'
      || error.name === 'StageReportValidationError'
      || ('code' in error && error.code === 'APP_PATH_OUTSIDE_SCOPE')
    )
  )
);

const isStageReportOutcomeError = (
  error: unknown,
): error is StageReportOutcomeError => error instanceof StageReportOutcomeError
  || (
    error instanceof Error
    && 'code' in error
    && error.code === 'PIPELINE_REPORT_OUTCOME_UNKNOWN'
  );

const planStale = (message: string, stageId?: StageId): never => {
  throw new ExecutionPlanError('PLAN_STALE', message, stageId);
};

const retrySafePlanStale = (message: string, stageId?: StageId): never => {
  throw new RetrySafePlanStaleError(message, stageId);
};

const retrySafeRevalidateExecutionPlan = async (
  plan: ExecutionPlan,
  context: ExecutionPlanContext,
  livePreflight?: PreflightResult,
): Promise<ExecutionPlan> => {
  try {
    return await revalidateExecutionPlan(plan, context, livePreflight);
  } catch (error) {
    if (error instanceof ExecutionPlanError && error.code === 'PLAN_STALE') {
      const prefix = 'PLAN_STALE: ';
      const message = error.message.startsWith(prefix)
        ? error.message.slice(prefix.length)
        : 'Pipeline plan is stale.';
      throw new RetrySafePlanStaleError(
        message,
        error.stageId,
        {cause: error},
      );
    }
    throw error;
  }
};

const pointersEqual = (
  left: CurrentPointer | null,
  right: CurrentPointer,
): boolean => left !== null
  && left.runId === right.runId
  && left.relativePath === right.relativePath
  && left.preset === right.preset
  && left.stageIds.length === right.stageIds.length
  && left.stageIds.every((stageId, index) => stageId === right.stageIds[index])
  && left.completedStage === right.completedStage
  && left.state === right.state
  && left.publishedAt === right.publishedAt;

const STAGE_POSITIONS = new Map(
  STAGE_PRESETS.release.map((stageId, index) => [stageId, index]),
);

const preservesCommittedEvidence = (error: unknown): boolean =>
  error instanceof PipelinePointerOutcomeError || isStageReportOutcomeError(error);

const throwIfPipelineCancelled = (
  signal: AbortSignal,
  stageId?: StageId,
): void => {
  if (!signal.aborted) return;
  throw new PipelineRuntimeError(
    'PIPELINE_CANCELLED',
    'Pipeline execution was cancelled.',
    stageId,
    {cause: signal.reason},
  );
};

const normalizeNoRunFailure = (error: unknown): never => {
  if (error instanceof ExecutionPlanError || preservesCommittedEvidence(error)) {
    throw error;
  }
  throw normalizePipelineError(error, 'preflight');
};

const runWithoutPersistedStage = async <Value>(
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await operation();
  } catch (error) {
    return normalizeNoRunFailure(error);
  }
};

const safeBoundaryMessage = (
  error: PipelineRuntimeError,
  active: ActiveStageFailure,
): string => {
  if (
    error.code === 'PIPELINE_STAGE_FAILED'
    && active.boundary === 'output-pointer'
  ) {
    return `${error.code}: Pipeline stage ${active.stage.id} output pointer failed.`;
  }
  return error.message;
};

const normalizeActiveStageFailure = (
  error: unknown,
  active: ActiveStageFailure,
): PipelineRuntimeError => {
  const normalized = normalizePipelineError(error, active.stage.id);
  if (
    error instanceof PipelineRuntimeError
    || !(error instanceof Error)
    || error instanceof AggregateError
  ) {
    return normalized;
  }
  try {
    Object.setPrototypeOf(error, PipelineRuntimeError.prototype);
    Object.defineProperty(error, 'code', {
      configurable: true,
      enumerable: true,
      value: normalized.code,
      writable: true,
    });
    Object.defineProperty(error, 'stageId', {
      configurable: true,
      enumerable: true,
      value: active.stage.id,
      writable: true,
    });
    error.name = 'PipelineRuntimeError';
    error.message = safeBoundaryMessage(normalized, active);
    return error as PipelineRuntimeError;
  } catch {
    return normalized;
  }
};

const failureAttempt = (
  active: ActiveStageFailure,
  error: PipelineRuntimeError,
  finishedAt: string,
): StageReport | undefined => {
  const {item} = active;
  const runId = active.context.runId;
  if (item === undefined || runId === undefined) return undefined;
  return StageReportSchema.parse({
    version: 1,
    projectId: active.plan.projectId,
    runId,
    preset: active.plan.preset,
    stageId: item.stageId,
    position: item.position,
    total: item.total,
    state: error.code === 'PIPELINE_CANCELLED' ? 'cancelled' : 'failed',
    fingerprint: item.fingerprint,
    startedAt: active.startedAt,
    finishedAt,
    artifacts: [],
    checks: [],
    error: {
      code: error.code,
      message: error.message,
    },
  });
};

const attachRecoveryErrors = (
  primary: PipelineRuntimeError,
  recoveryErrors: readonly unknown[],
): void => {
  if (recoveryErrors.length === 0) return;
  const priorCause = primary.cause;
  const recoveryCause = new AggregateError(
    recoveryErrors,
    'Pipeline failure recovery did not complete',
    priorCause === undefined ? undefined : {cause: priorCause},
  );
  try {
    Object.defineProperty(primary, 'cause', {
      configurable: true,
      enumerable: false,
      value: recoveryCause,
      writable: true,
    });
  } catch {
    try {
      Object.defineProperty(primary, 'recoveryErrors', {
        configurable: true,
        enumerable: false,
        value: Object.freeze([...recoveryErrors]),
      });
    } catch {
      return;
    }
  }
};

const recoverActiveStageFailure = async (
  error: unknown,
  active: ActiveStageFailure,
  dependencies: RunnerDependencies,
): Promise<PipelineRuntimeError> => {
  const primary = normalizeActiveStageFailure(error, active);
  const recoveryErrors: unknown[] = [];
  const runDirectory = active.context.runDirectory;
  try {
    const attempt = failureAttempt(active, primary, dependencies.now());
    if (attempt !== undefined && runDirectory !== undefined) {
      await dependencies.reportStore.writeAttempt(runDirectory, attempt);
    }
  } catch (attemptError) {
    recoveryErrors.push(attemptError);
  }

  if (active.cleanupPartials) {
    let partialArtifacts: readonly PipelinePartialArtifact[] = [];
    try {
      partialArtifacts = [...active.stage.partialArtifacts(active.context)];
    } catch (partialError) {
      recoveryErrors.push(partialError);
    }

    let outputDirectory: OutputDirectoryScope | undefined;
    if (partialArtifacts.some((artifact) => artifact.scope === 'output')) {
      try {
        outputDirectory = await dependencies.outputStore.openExistingProject(
          active.plan.projectId,
        ) ?? undefined;
      } catch (outputError) {
        recoveryErrors.push(outputError);
      }
    }

    try {
      await (dependencies.cleanupFailedStage ?? sharedCleanupFailedStage)({
        projectId: active.plan.projectId,
        ...(active.context.runId === undefined ? {} : {runId: active.context.runId}),
        stageId: active.stage.id,
        ...(runDirectory === undefined ? {} : {runDirectory}),
        ...(outputDirectory === undefined ? {} : {outputDirectory}),
        partialArtifacts,
      });
    } catch (cleanupError) {
      recoveryErrors.push(cleanupError);
    }
  }

  attachRecoveryErrors(primary, recoveryErrors);
  return primary;
};

const pointerProgress = (pointer: CurrentPointer | null): number => pointer === null
  ? -1
  : (STAGE_POSITIONS.get(pointer.completedStage) ?? -1);

const needsRecoveredWorkProgress = (
  current: CurrentPointer | null,
  runId: string,
  report: StageReport,
): boolean => current === null
  || current.runId !== runId
  || (STAGE_POSITIONS.get(report.stageId) ?? -1) > pointerProgress(current)
  || (
    current.completedStage === report.stageId
    && current.state !== 'passed'
  );

const isCanonicalReleasePointer = (
  pointer: CurrentPointer | null,
  runId: string,
): pointer is CurrentPointer => {
  if (pointer === null) return false;
  try {
    return pointersEqual(pointer, releaseCurrentPointer(runId, pointer.publishedAt));
  } catch {
    return false;
  }
};

const publishCurrentConfirmed = async (input: {
  owner: PointerOwner;
  projectId: string;
  pointer: CurrentPointer;
  store: Pick<RunStore, 'publishCurrent' | 'readCurrentReadonly'>
    | Pick<OutputStore, 'publishCurrent' | 'readCurrentReadonly'>;
}): Promise<void> => {
  try {
    await input.store.publishCurrent(input.projectId, input.pointer);
  } catch (primaryError) {
    if (isPointerRollbackOutcomeUnknown(primaryError)) {
      throw new PipelinePointerOutcomeError(input.owner, primaryError);
    }
    let current: CurrentPointer | null;
    try {
      current = await input.store.readCurrentReadonly(input.projectId);
    } catch (readError) {
      throw new PipelinePointerOutcomeError(
        input.owner,
        primaryError,
        readError,
      );
    }
    if (pointersEqual(current, input.pointer)) return;
    throw primaryError;
  }
};

const stageById = (
  registry: readonly PipelineStage[],
  stageId: StageId,
): PipelineStage => {
  const stage = registry.find((candidate) => candidate.id === stageId);
  if (stage === undefined) {
    throw new PipelineContextError(`Stage registry is missing ${stageId}`);
  }
  return stage;
};

const parsePreflightResult = (result: StageExecutionResult): PreflightResult => {
  const parsed = parsePreflightAdapterOutput(result.outputs);
  const rawChecks = result.outputs !== null
    && typeof result.outputs === 'object'
    && !Array.isArray(result.outputs)
    && 'checks' in result.outputs
    && Array.isArray(result.outputs.checks)
    ? result.outputs.checks as PreflightResult['checks']
    : result.checks as PreflightResult['checks'];
  return {
    checks: rawChecks,
    toolIdentities: parsed.toolIdentities,
    fonts: parsed.fonts,
    voice: parsed.voice,
    versions: parsed.versions,
    system: {
      ...parsed.system,
      platform: parsed.system.platform as NodeJS.Platform,
    },
    environmentFingerprint: parsed.environmentFingerprint,
  };
};

const executionContext = (
  input: RunExecutionInput,
  plan: ExecutionPlan,
  dependencies: RunnerDependencies,
  options: {
    sourceRun?: RunnerSourceRun;
    preflight?: PreflightResult;
    runId?: string;
    runDirectory?: RunDirectoryScope;
  } = {},
): StageExecutionContext => ({
  project: input.project,
  sourceCatalog: input.sourceCatalog,
  preset: plan.preset,
  now: dependencies.now,
  ...(options.sourceRun === undefined ? {} : {
    sourceRun: {
      runId: options.sourceRun.runId,
      runDirectory: options.sourceRun.runDirectory,
      reports: options.sourceRun.reports,
    },
  }),
  ...(options.preflight === undefined ? {} : {preflight: options.preflight}),
  ...(options.runId === undefined ? {} : {runId: options.runId}),
  ...(options.runDirectory === undefined ? {} : {runDirectory: options.runDirectory}),
});

const runPreflight = async (
  input: RunExecutionInput,
  plan: ExecutionPlan,
  dependencies: RunnerDependencies,
  sourceRun?: RunnerSourceRun,
  onStart?: (start: PreflightExecutionStart) => void,
): Promise<PreflightExecution> => {
  const stage = stageById(dependencies.registry, 'preflight');
  throwIfPipelineCancelled(input.signal, stage.id);
  const startedAt = dependencies.now();
  const context = executionContext(input, plan, dependencies, {
    ...(sourceRun === undefined ? {} : {sourceRun}),
  });
  onStart?.({stage, context, startedAt});
  const result = await stage.execute(
    context,
    input.signal,
  );
  const finishedAt = dependencies.now();
  throwIfPipelineCancelled(input.signal, stage.id);
  return {
    preflight: parsePreflightResult(result),
    result,
    startedAt,
    finishedAt,
  };
};

const loadSourceRun = async (
  plan: ExecutionPlan,
  dependencies: RunnerDependencies,
): Promise<RunnerSourceRun | undefined> => {
  if (plan.sourceRunId === undefined) return undefined;
  let runDirectory: RunDirectoryScope;
  try {
    runDirectory = await dependencies.runStore.openExistingRun(
      plan.projectId,
      plan.sourceRunId,
    );
  } catch (error) {
    if (plan.runMode === 'new' && isMissingPath(error)) return undefined;
    if (isMissingPath(error)) {
      return retrySafePlanStale('the planned source Run no longer exists');
    }
    throw error;
  }
  const reports = new Map<StageId, StageReport>();
  for (const stageId of STAGE_PRESETS[plan.preset]) {
    let report: StageReport | null;
    try {
      report = await dependencies.reportStore.readStage(runDirectory, stageId);
    } catch (error) {
      if (isOrdinaryReportMiss(error)) continue;
      throw error;
    }
    if (report !== null) reports.set(stageId, report);
  }
  return {runId: plan.sourceRunId, runDirectory, reports};
};

const verifyLivePreflight = async (
  input: RunExecutionInput,
  plan: ExecutionPlan,
  dependencies: RunnerDependencies,
  sourceRun: RunnerSourceRun | undefined,
  execution: PreflightExecution,
): Promise<StageReport> => {
  const persisted = sourceRun?.reports.get('preflight');
  if (
    persisted === undefined
    || persisted.projectId !== plan.projectId
    || persisted.runId !== sourceRun?.runId
    || persisted.fingerprint !== execution.result.fingerprint
  ) {
    return retrySafePlanStale('the live Preflight fingerprint changed', 'preflight');
  }
  const stage = stageById(dependencies.registry, 'preflight');
  let verified = false;
  try {
    verified = await stage.verify(
      executionContext(input, plan, dependencies, {
        sourceRun,
        preflight: execution.preflight,
      }),
      persisted,
    );
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  if (!verified) {
    return retrySafePlanStale(
      'the live Preflight result no longer matches its report',
      'preflight',
    );
  }
  return persisted;
};

const reportFromExecution = (
  plan: ExecutionPlan,
  runId: string,
  item: ExecutionPlanItem,
  result: StageExecutionResult,
  startedAt: string,
  finishedAt: string,
): StageReport => StageReportSchema.parse({
  version: 1,
  projectId: plan.projectId,
  runId,
  preset: plan.preset,
  stageId: item.stageId,
  position: item.position,
  total: item.total,
  state: result.state,
  fingerprint: result.fingerprint,
  startedAt,
  finishedAt,
  artifacts: result.artifacts,
  ...(result.outputs === undefined ? {} : {outputs: result.outputs}),
  checks: result.checks,
});

const cachedReport = (
  plan: ExecutionPlan,
  runId: string,
  item: ExecutionPlanItem,
  source: StageReport,
  artifacts: StageReport['artifacts'],
  startedAt: string,
  finishedAt: string,
): StageReport => StageReportSchema.parse({
  version: 1,
  projectId: plan.projectId,
  runId,
  preset: plan.preset,
  stageId: item.stageId,
  position: item.position,
  total: item.total,
  state: 'cached',
  fingerprint: source.fingerprint,
  startedAt,
  finishedAt,
  artifacts,
  ...(source.outputs === undefined ? {} : {outputs: source.outputs}),
  checks: source.checks,
  provenance: {
    sourceRunId: source.runId,
    sourceStageId: source.stageId,
  },
});

const cachedPrerequisitePreflight = (
  plan: ExecutionPlan,
  runId: string,
  source: StageReport,
  startedAt: string,
  finishedAt: string,
): StageReport => StageReportSchema.parse({
  version: 1,
  projectId: plan.projectId,
  runId,
  preset: plan.preset,
  stageId: 'preflight',
  position: source.position,
  total: source.total,
  state: 'cached',
  fingerprint: source.fingerprint,
  startedAt,
  finishedAt,
  artifacts: [],
  ...(source.outputs === undefined ? {} : {outputs: source.outputs}),
  checks: source.checks,
  provenance: {
    sourceRunId: source.runId,
    sourceStageId: 'preflight',
  },
});

const workPointer = (
  plan: ExecutionPlan,
  runId: string,
  report: StageReport,
  state: CurrentPointer['state'],
): CurrentPointer => ({
  runId,
  relativePath: `runs/${runId}`,
  preset: plan.preset,
  stageIds: [...plan.stageIds],
  completedStage: report.stageId,
  state,
  publishedAt: report.finishedAt,
});

const publishWorkProgress = async (
  plan: ExecutionPlan,
  runId: string,
  report: StageReport,
  state: CurrentPointer['state'],
  dependencies: RunnerDependencies,
): Promise<CurrentPointer> => {
  const pointer = workPointer(plan, runId, report, state);
  await publishCurrentConfirmed({
    owner: 'Work',
    projectId: plan.projectId,
    pointer,
    store: dependencies.runStore,
  });
  return pointer;
};

const publishOutputProgress = async (
  projectId: string,
  pointer: CurrentPointer,
  dependencies: RunnerDependencies,
): Promise<void> => await publishCurrentConfirmed({
  owner: 'Output',
  projectId,
  pointer,
  store: dependencies.outputStore,
});

const requireSourceReport = (
  sourceRun: RunnerSourceRun | undefined,
  stageId: StageId,
): StageReport => {
  const report = sourceRun?.reports.get(stageId);
  if (report === undefined) {
    return planStale(`the source ${stageId} report is missing`, stageId);
  }
  return report;
};

const materializeCachedStage = async (
  plan: ExecutionPlan,
  item: ExecutionPlanItem,
  runId: string,
  runDirectory: RunDirectoryScope,
  sourceRun: RunnerSourceRun | undefined,
  signal: AbortSignal,
  dependencies: RunnerDependencies,
): Promise<StageReport> => {
  if (item.stageId === 'review' || item.stageId === 'release') {
    return planStale(`${item.stageId} cannot be cached across Runs`, item.stageId);
  }
  const source = requireSourceReport(sourceRun, item.stageId);
  for (const artifact of source.artifacts) {
    if (artifact.scope !== 'run') {
      return planStale(
        `cached ${item.stageId} contains an Output artifact`,
        item.stageId,
      );
    }
  }
  const startedAt = dependencies.now();
  const artifacts: PipelineArtifact[] = [];
  let reportWritten = false;
  try {
    const copyArtifact = dependencies.copyRunArtifact ?? copyRunArtifact;
    for (const artifact of source.artifacts) {
      const copied = await copyArtifact({
        sourceRun: sourceRun!.runDirectory,
        targetRun: runDirectory,
        artifact,
      });
      artifacts.push(copied);
      throwIfPipelineCancelled(signal, item.stageId);
    }
    throwIfPipelineCancelled(signal, item.stageId);
    const finishedAt = dependencies.now();
    const report = cachedReport(
      plan,
      runId,
      item,
      source,
      artifacts,
      startedAt,
      finishedAt,
    );
    await dependencies.reportStore.writeStage(runDirectory, report);
    reportWritten = true;
    throwIfPipelineCancelled(signal, item.stageId);
    await publishWorkProgress(plan, runId, report, 'passed', dependencies);
    return report;
  } catch (error) {
    if (
      error instanceof PipelinePointerOutcomeError
      || isStageReportOutcomeError(error)
    ) {
      throw error;
    }
    return await rollbackStageProgress({
      primaryError: error,
      reportStore: dependencies.reportStore,
      runDirectory,
      stageId: item.stageId,
      reportWritten,
      artifacts,
    });
  }
};

const validateReleaseResult = (
  runId: string,
  result: StageExecutionResult,
): CurrentPointer => {
  const pointer = result.outputCurrent;
  if (
    pointer === undefined
    || pointer.runId !== runId
    || pointer.relativePath !== `releases/${runId}`
    || pointer.preset !== 'release'
    || pointer.completedStage !== 'release'
    || pointer.state !== 'passed'
  ) {
    throw new PipelineContextError('Release did not return a valid Output pointer');
  }
  for (const artifact of result.artifacts) {
    if (
      (artifact.scope === 'run' && !artifact.path.startsWith('release/'))
      || (
        artifact.scope === 'output'
        && !artifact.path.startsWith(`releases/${runId}/`)
      )
    ) {
      throw new PipelineContextError('Release claimed a non-Release artifact');
    }
  }
  return pointer;
};

const deleteCanonicalReport = async (
  reportStore: StageReportStore,
  runDirectory: RunDirectoryScope,
  stageId: StageId,
): Promise<void> => await reportStore.deleteStage(runDirectory, stageId);

const rollbackStageProgress = async (input: {
  primaryError: unknown;
  reportStore: StageReportStore;
  runDirectory: RunDirectoryScope;
  stageId: StageId;
  reportWritten: boolean;
  artifacts: readonly PipelineArtifact[];
}): Promise<never> => {
  const cleanupErrors: unknown[] = [];
  if (input.reportWritten) {
    try {
      await deleteCanonicalReport(
        input.reportStore,
        input.runDirectory,
        input.stageId,
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const artifact of [...input.artifacts].reverse()) {
    if (artifact.scope !== 'run') continue;
    try {
      await deleteRunArtifact(input.runDirectory, artifact);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [input.primaryError, ...cleanupErrors],
      `Stage progress rollback failed for ${input.stageId}`,
      {cause: input.primaryError},
    );
  }
  throw input.primaryError;
};

const result = (
  plan: ExecutionPlan,
  values: Omit<PipelineRunResult, 'projectId' | 'preset' | 'warnings'> & {
    warnings?: PipelineRunResult['warnings'];
  },
): PipelineRunResult => ({
  projectId: plan.projectId,
  preset: plan.preset,
  warnings: values.warnings ?? [],
  ...values,
});

const preflightFailed = (
  plan: ExecutionPlan,
  preflight: PreflightResult,
  runId?: string,
): PipelineRunResult => result(plan, {
  ...(runId === undefined ? {} : {runId}),
  state: 'failed',
  reports: [],
  preflight,
});

const noopReports = (
  plan: ExecutionPlan,
  sourceRun: RunnerSourceRun | undefined,
): StageReport[] => plan.items.map((item) => requireSourceReport(sourceRun, item.stageId));

export const createRunId = (): string => {
  const time = new Date().toISOString().replace(/[-:.TZ]/gu, '').toLowerCase();
  return StableIdSchema.parse(`run-${time}-${randomUUID().slice(0, 8)}`);
};

export async function runExecutionPlan(
  input: RunExecutionInput,
  dependencies: RunnerDependencies,
): Promise<PipelineRunResult> {
  const {plan} = input;
  if (plan.projectId !== input.project.project.id) {
    return retrySafePlanStale('the Execution Plan belongs to another project');
  }
  throwIfPipelineCancelled(input.signal, 'preflight');

  if (plan.items.length === 1 && plan.items[0]?.stageId === 'preflight') {
    return await runWithoutPersistedStage(async () => {
      const execution = await runPreflight(input, plan, dependencies);
      throwIfPipelineCancelled(input.signal, 'preflight');
      if (aggregateChecks(execution.preflight.checks) === 'failed') {
        return preflightFailed(plan, execution.preflight);
      }
      return result(plan, {
        state: 'passed',
        completedStage: 'preflight',
        reports: [],
        preflight: execution.preflight,
      });
    });
  }

  if (plan.runMode === 'noop') {
    return await runWithoutPersistedStage(async () => {
      const context: ExecutionPlanContext = {
        project: input.project,
        sourceCatalog: input.sourceCatalog,
        registry: dependencies.registry,
        runStore: dependencies.runStore,
        outputStore: dependencies.outputStore,
        reportStore: dependencies.reportStore,
        createRunId: dependencies.createRunId,
      };
      let revalidated = await retrySafeRevalidateExecutionPlan(plan, context);
      throwIfPipelineCancelled(input.signal, 'preflight');
      const sourceRun = await loadSourceRun(revalidated, dependencies);
      let preflight: PreflightResult | undefined;
      if (revalidated.requiresRuntimePreflight) {
        const execution = await runPreflight(input, revalidated, dependencies, sourceRun);
        preflight = execution.preflight;
        throwIfPipelineCancelled(input.signal, 'preflight');
        if (aggregateChecks(preflight.checks) === 'failed') {
          return preflightFailed(revalidated, preflight, revalidated.sourceRunId);
        }
        await verifyLivePreflight(
          input,
          revalidated,
          dependencies,
          sourceRun,
          execution,
        );
        revalidated = await retrySafeRevalidateExecutionPlan(
          revalidated,
          context,
          execution.preflight,
        );
      }
      throwIfPipelineCancelled(input.signal, 'preflight');
      const reports = noopReports(revalidated, sourceRun);
      return result(revalidated, {
        ...(revalidated.sourceRunId === undefined
          ? {}
          : {runId: revalidated.sourceRunId}),
        state: 'passed',
        ...(reports.at(-1) === undefined
          ? {}
          : {completedStage: reports.at(-1)!.stageId}),
        reports,
        ...(preflight === undefined ? {} : {preflight}),
      });
    });
  }

  const lockRunId = StableIdSchema.parse(
    plan.runMode === 'resume'
      ? plan.sourceRunId
      : (plan.targetRunId ?? dependencies.createRunId()),
  );
  const work = await dependencies.runStore.createWork(plan.projectId);
  let lease: ProjectLockLease | undefined;
  let releaseOutputCommitted = false;
  let activeStageFailure: ActiveStageFailure | undefined;
  let outcome:
    | {ok: true; value: PipelineRunResult}
    | {ok: false; error: unknown}
    | undefined;
  const executeLocked = async (): Promise<PipelineRunResult> => {
    throwIfPipelineCancelled(input.signal, 'preflight');
    const context: ExecutionPlanContext = {
      project: input.project,
      sourceCatalog: input.sourceCatalog,
      registry: dependencies.registry,
      runStore: dependencies.runStore,
      outputStore: dependencies.outputStore,
      reportStore: dependencies.reportStore,
      createRunId: dependencies.createRunId,
    };
    let revalidated = await retrySafeRevalidateExecutionPlan(plan, context);
    const sourceRun = await loadSourceRun(revalidated, dependencies);
    if (
      revalidated.runMode === 'new'
      && revalidated.items.some((item) => item.action === 'cached')
      && sourceRun === undefined
    ) {
      return retrySafePlanStale('the planned cache source no longer exists');
    }
    const preflightItem = revalidated.items.find((item) => item.stageId === 'preflight');
    if (preflightItem === undefined && !revalidated.requiresRuntimePreflight) {
      return retrySafePlanStale(
        'executable plans require selected or prerequisite Preflight',
      );
    }
    const preflightExecution = await runPreflight(
      input,
      revalidated,
      dependencies,
      sourceRun,
      ({stage, context: stageContext, startedAt}) => {
        activeStageFailure = {
          plan: revalidated,
          ...(preflightItem === undefined ? {} : {item: preflightItem}),
          stage,
          context: stageContext,
          startedAt,
          boundary: 'execute',
          cleanupPartials: true,
        };
      },
    );
    throwIfPipelineCancelled(input.signal, 'preflight');
    activeStageFailure = undefined;
    if (aggregateChecks(preflightExecution.preflight.checks) === 'failed') {
      return preflightFailed(
        revalidated,
        preflightExecution.preflight,
        revalidated.runMode === 'resume' ? lockRunId : undefined,
      );
    }
    let persistedPreflight: StageReport | undefined;
    if (revalidated.runMode === 'resume' || preflightItem === undefined) {
      persistedPreflight = await verifyLivePreflight(
        input,
        revalidated,
        dependencies,
        sourceRun,
        preflightExecution,
      );
    }
    revalidated = await retrySafeRevalidateExecutionPlan(
      revalidated,
      context,
      preflightExecution.preflight,
    );
    throwIfPipelineCancelled(input.signal, 'preflight');

    let workCurrent = revalidated.runMode === 'resume'
      ? await dependencies.runStore.readCurrentReadonly(revalidated.projectId)
      : null;
    let outputPointerSnapshot = revalidated.runMode === 'resume'
      ? await dependencies.outputStore.readCurrentReadonly(revalidated.projectId)
      : null;

    const runDirectory = revalidated.runMode === 'resume'
      ? sourceRun?.runDirectory
      : await dependencies.runStore.createRun(revalidated.projectId, lockRunId);
    if (runDirectory === undefined) {
      return retrySafePlanStale('the resumable Run no longer exists');
    }
    const reports: StageReport[] = [];

    if (revalidated.runMode === 'new' && preflightItem !== undefined) {
      const preflightStage = stageById(dependencies.registry, 'preflight');
      const preflightContext = executionContext(input, revalidated, dependencies, {
        ...(sourceRun === undefined ? {} : {sourceRun}),
        preflight: preflightExecution.preflight,
        runId: lockRunId,
        runDirectory,
      });
      activeStageFailure = {
        plan: revalidated,
        item: preflightItem,
        stage: preflightStage,
        context: preflightContext,
        startedAt: preflightExecution.startedAt,
        boundary: 'canonical-report',
        cleanupPartials: true,
      };
      throwIfPipelineCancelled(input.signal, preflightStage.id);
      const preflightReport = reportFromExecution(
        revalidated,
        lockRunId,
        preflightItem,
        preflightExecution.result,
        preflightExecution.startedAt,
        preflightExecution.finishedAt,
      );
      let preflightReportWritten = false;
      try {
        await dependencies.reportStore.writeStage(runDirectory, preflightReport);
        preflightReportWritten = true;
        throwIfPipelineCancelled(input.signal, preflightStage.id);
        activeStageFailure.boundary = 'work-pointer';
        workCurrent = await publishWorkProgress(
          revalidated,
          lockRunId,
          preflightReport,
          'passed',
          dependencies,
        );
      } catch (error) {
        if (
          error instanceof PipelinePointerOutcomeError
          || isStageReportOutcomeError(error)
        ) {
          throw error;
        }
        return await rollbackStageProgress({
          primaryError: error,
          reportStore: dependencies.reportStore,
          runDirectory,
          stageId: preflightStage.id,
          reportWritten: preflightReportWritten,
          artifacts: [],
        });
      }
      reports.push(preflightReport);
      activeStageFailure = undefined;
    } else if (revalidated.runMode === 'new') {
      const sourcePreflight = persistedPreflight
        ?? requireSourceReport(sourceRun, 'preflight');
      const prerequisiteReport = cachedPrerequisitePreflight(
        revalidated,
        lockRunId,
        sourcePreflight,
        preflightExecution.startedAt,
        preflightExecution.finishedAt,
      );
      const preflightStage = stageById(dependencies.registry, 'preflight');
      const prerequisiteItem: ExecutionPlanItem = {
        position: prerequisiteReport.position,
        total: prerequisiteReport.total,
        stageId: 'preflight',
        displayName: preflightStage.displayName,
        action: 'cached',
        fingerprint: prerequisiteReport.fingerprint,
        ...(sourceRun === undefined ? {} : {sourceRunId: sourceRun.runId}),
        materialize: false,
      };
      activeStageFailure = {
        plan: revalidated,
        item: prerequisiteItem,
        stage: preflightStage,
        context: executionContext(input, revalidated, dependencies, {
          ...(sourceRun === undefined ? {} : {sourceRun}),
          preflight: preflightExecution.preflight,
          runId: lockRunId,
          runDirectory,
        }),
        startedAt: preflightExecution.startedAt,
        boundary: 'canonical-report',
        cleanupPartials: true,
      };
      let prerequisiteReportWritten = false;
      try {
        throwIfPipelineCancelled(input.signal, preflightStage.id);
        await dependencies.reportStore.writeStage(runDirectory, prerequisiteReport);
        prerequisiteReportWritten = true;
        throwIfPipelineCancelled(input.signal, preflightStage.id);
      } catch (error) {
        if (
          error instanceof PipelinePointerOutcomeError
          || isStageReportOutcomeError(error)
        ) {
          throw error;
        }
        return await rollbackStageProgress({
          primaryError: error,
          reportStore: dependencies.reportStore,
          runDirectory,
          stageId: preflightStage.id,
          reportWritten: prerequisiteReportWritten,
          artifacts: [],
        });
      }
      activeStageFailure = undefined;
    } else if (preflightItem !== undefined) {
      reports.push(persistedPreflight ?? requireSourceReport(sourceRun, 'preflight'));
    }

    for (const item of revalidated.items) {
      if (item.stageId === 'preflight') continue;
      const scheduledStage = stageById(dependencies.registry, item.stageId);
      const scheduledContext = executionContext(input, revalidated, dependencies, {
        ...(sourceRun === undefined ? {} : {sourceRun}),
        preflight: preflightExecution.preflight,
        runId: lockRunId,
        runDirectory,
      });
      const scheduledAt = dependencies.now();
      activeStageFailure = {
        plan: revalidated,
        item,
        stage: scheduledStage,
        context: scheduledContext,
        startedAt: scheduledAt,
        boundary: item.action === 'cached' ? 'materialize' : 'execute',
        cleanupPartials: true,
      };
      throwIfPipelineCancelled(input.signal, item.stageId);
      if (item.action === 'cached') {
        if (revalidated.runMode === 'new') {
          const cached = await materializeCachedStage(
            revalidated,
            item,
            lockRunId,
            runDirectory,
            sourceRun,
            input.signal,
            dependencies,
          );
          reports.push(cached);
          activeStageFailure = undefined;
        } else {
          activeStageFailure = undefined;
          const cached = requireSourceReport(sourceRun, item.stageId);
          if (item.stageId === 'release') {
            if (cached.state !== 'passed') {
              return planStale('the recovered Release report is not passed', 'release');
            }
            const releaseStage = scheduledStage;
            let verified = false;
            try {
              verified = await releaseStage.verify(
                executionContext(input, revalidated, dependencies, {
                  ...(sourceRun === undefined ? {} : {sourceRun}),
                  preflight: preflightExecution.preflight,
                  runId: lockRunId,
                  runDirectory,
                }),
                cached,
              );
            } catch (error) {
              if (!isOrdinaryReportMiss(error)) {
                throw normalizePipelineError(error, 'release');
              }
            }
            activeStageFailure = {
              plan: revalidated,
              item,
              stage: releaseStage,
              context: scheduledContext,
              startedAt: scheduledAt,
              boundary: 'output-pointer',
              cleanupPartials: false,
            };
            throwIfPipelineCancelled(input.signal, item.stageId);
            if (!verified) {
              activeStageFailure = undefined;
              return planStale(
                'the recovered Release report or audit artifacts are no longer valid',
                'release',
              );
            }

            if (!isCanonicalReleasePointer(outputPointerSnapshot, lockRunId)) {
              const recoveredOutput = releaseCurrentPointer(
                lockRunId,
                cached.finishedAt,
              );
              throwIfPipelineCancelled(input.signal, item.stageId);
              await publishOutputProgress(
                revalidated.projectId,
                recoveredOutput,
                dependencies,
              );
              outputPointerSnapshot = recoveredOutput;
            }
            activeStageFailure = undefined;
            releaseOutputCommitted = true;
            reports.push(cached);
            const warnings: PipelineRunResult['warnings'] = [];
            if (needsRecoveredWorkProgress(workCurrent, lockRunId, cached)) {
              try {
                activeStageFailure = {
                  plan: revalidated,
                  item,
                  stage: releaseStage,
                  context: scheduledContext,
                  startedAt: scheduledAt,
                  boundary: 'work-pointer',
                  cleanupPartials: false,
                };
                throwIfPipelineCancelled(input.signal, item.stageId);
                workCurrent = await publishWorkProgress(
                  revalidated,
                  lockRunId,
                  cached,
                  'passed',
                  dependencies,
                );
              } catch {
                warnings.push({
                  code: 'WORK_POINTER_LAGGING',
                  message: 'Output Release is published, but Work progress metadata is lagging.',
                });
              } finally {
                activeStageFailure = undefined;
              }
            }
            return result(revalidated, {
              runId: lockRunId,
              state: 'passed',
              completedStage: 'release',
              reports,
              preflight: preflightExecution.preflight,
              warnings,
            });
          }
          if (needsRecoveredWorkProgress(workCurrent, lockRunId, cached)) {
            activeStageFailure = {
              plan: revalidated,
              item,
              stage: scheduledStage,
              context: executionContext(input, revalidated, dependencies, {
                ...(sourceRun === undefined ? {} : {sourceRun}),
                preflight: preflightExecution.preflight,
                runId: lockRunId,
                runDirectory,
              }),
              startedAt: dependencies.now(),
              boundary: 'work-pointer',
              cleanupPartials: false,
            };
            workCurrent = await publishWorkProgress(
              revalidated,
              lockRunId,
              cached,
              'passed',
              dependencies,
            );
            activeStageFailure = undefined;
          }
          reports.push(cached);
        }
        continue;
      }

      const stageResult = await scheduledStage.execute(
        scheduledContext,
        input.signal,
      );
      throwIfPipelineCancelled(input.signal, item.stageId);
      const finishedAt = dependencies.now();
      const report = reportFromExecution(
        revalidated,
        lockRunId,
        item,
        stageResult,
        scheduledAt,
        finishedAt,
      );

      if (stageResult.state === 'needs_review') {
        activeStageFailure.boundary = 'attempt-report';
        await dependencies.reportStore.writeAttempt(runDirectory, report);
        throwIfPipelineCancelled(input.signal, item.stageId);
        activeStageFailure.boundary = 'work-pointer';
        workCurrent = await publishWorkProgress(
          revalidated,
          lockRunId,
          report,
          'needs_review',
          dependencies,
        );
        reports.push(report);
        activeStageFailure = undefined;
        return result(revalidated, {
          runId: lockRunId,
          state: 'needs_review',
          completedStage: report.stageId,
          reports,
          preflight: preflightExecution.preflight,
        });
      }

      if (item.stageId !== 'release') {
        let reportWritten = false;
        try {
          if (stageResult.outputCurrent !== undefined) {
            throw new PipelineContextError(
              `${item.stageId} returned an unexpected Output pointer`,
            );
          }
          activeStageFailure.boundary = 'canonical-report';
          await dependencies.reportStore.writeStage(runDirectory, report);
          reportWritten = true;
          throwIfPipelineCancelled(input.signal, item.stageId);
          activeStageFailure.boundary = 'work-pointer';
          workCurrent = await publishWorkProgress(
            revalidated,
            lockRunId,
            report,
            'passed',
            dependencies,
          );
        } catch (error) {
          if (
            error instanceof PipelinePointerOutcomeError
            || isStageReportOutcomeError(error)
          ) {
            throw error;
          }
          return await rollbackStageProgress({
            primaryError: error,
            reportStore: dependencies.reportStore,
            runDirectory,
            stageId: item.stageId,
            reportWritten,
            artifacts: stageResult.artifacts,
          });
        }
        reports.push(report);
        if (sourceRun?.runId === lockRunId) {
          sourceRun.reports.set(report.stageId, report);
        }
        activeStageFailure = undefined;
        continue;
      }

      const outputCurrent = validateReleaseResult(lockRunId, stageResult);
      activeStageFailure.boundary = 'canonical-report';
      await dependencies.reportStore.writeStage(runDirectory, report);
      try {
        throwIfPipelineCancelled(input.signal, item.stageId);
        activeStageFailure.boundary = 'output-pointer';
        await publishOutputProgress(revalidated.projectId, outputCurrent, dependencies);
        releaseOutputCommitted = true;
      } catch (error) {
        if (error instanceof PipelinePointerOutcomeError) throw error;
        if (
          error instanceof PipelineRuntimeError
          && error.code === 'PIPELINE_CANCELLED'
        ) {
          return await rollbackStageProgress({
            primaryError: error,
            reportStore: dependencies.reportStore,
            runDirectory,
            stageId: item.stageId,
            reportWritten: true,
            artifacts: stageResult.artifacts,
          });
        }
        try {
          await deleteCanonicalReport(
            dependencies.reportStore,
            runDirectory,
            'release',
          );
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Output publication and Release report rollback both failed',
            {cause: error},
          );
        }
        throw error;
      }
      reports.push(report);
      const warnings: PipelineRunResult['warnings'] = [];
      try {
        activeStageFailure.boundary = 'work-pointer';
        throwIfPipelineCancelled(input.signal, item.stageId);
        workCurrent = await publishWorkProgress(
          revalidated,
          lockRunId,
          report,
          'passed',
          dependencies,
        );
      } catch {
        warnings.push({
          code: 'WORK_POINTER_LAGGING',
          message: 'Output Release is published, but Work progress metadata is lagging.',
        });
      }
      activeStageFailure = undefined;
      return result(revalidated, {
        runId: lockRunId,
        state: 'passed',
        completedStage: 'release',
        reports,
        preflight: preflightExecution.preflight,
        warnings,
      });
    }

    activeStageFailure = undefined;
    return result(revalidated, {
      runId: lockRunId,
      state: 'passed',
      ...(reports.at(-1) === undefined
        ? {}
        : {completedStage: reports.at(-1)!.stageId}),
      reports,
      preflight: preflightExecution.preflight,
    });
  };
  let releaseError: unknown;
  try {
    try {
      lease = await dependencies.acquireProjectLock(work, lockRunId);
      outcome = {ok: true, value: await executeLocked()};
    } catch (error) {
      outcome = {
        ok: false,
        error: activeStageFailure === undefined || preservesCommittedEvidence(error)
          ? error
          : await recoverActiveStageFailure(
            error,
            activeStageFailure,
            dependencies,
          ),
      };
    }
  } finally {
    try {
      await lease?.release();
    } catch (error) {
      releaseError = error;
    }
  }
  if (outcome === undefined) {
    throw new TypeError('Pipeline Runner completed without an outcome');
  }
  if (!outcome.ok) {
    if (releaseError !== undefined) {
      const aggregatePrimary = outcome.error instanceof PipelineRuntimeError
        && outcome.error.code === 'PIPELINE_STAGE_FAILED'
        && outcome.error.stageId !== undefined
        ? Object.assign(
          new Error(`${outcome.error.stageId} failed`, {cause: outcome.error}),
          {
            code: outcome.error.code,
            stageId: outcome.error.stageId,
          },
        )
        : outcome.error;
      throw new AggregateError(
        [aggregatePrimary, releaseError],
        'Pipeline execution and project lock release both failed',
        {cause: aggregatePrimary},
      );
    }
    throw outcome.error;
  }
  if (releaseError !== undefined) {
    if (releaseOutputCommitted) {
      return {
        ...outcome.value,
        warnings: [
          ...outcome.value.warnings,
          {
            code: 'PROJECT_LOCK_RELEASE_FAILED',
            message: 'Output Release is published, but the project lock could not be released.',
          },
        ],
      };
    }
    throw releaseError;
  }
  return outcome.value;
}
