import type {ProjectInputs} from '../domain/load-project';
import type {RunDirectoryScope} from '../fs/app-directory-scopes';
import {STAGE_PRESETS} from './presets';
import {
  type CurrentPointer,
  type OutputStore,
  type PipelinePreset,
  type RunStore,
  type StageId,
} from './run-store';
import type {ProjectSourceCatalog} from './source-assets';
import type {PipelineStage, StageAction, StagePlanningContext} from './stage';
import {MVP_STAGES} from './stage-registry';
import {parsePreflightAdapterOutput} from './stage-adapters';
import type {StageReport, StageReportStore} from './stage-report';
import type {PreflightResult} from './stages/preflight';

export interface ExecutionPlanRequest {
  preset?: PipelinePreset;
  from?: StageId;
  to?: StageId;
  resume?: boolean;
  force?: StageId;
}

export interface ExecutionPlanItem {
  position: number;
  total: number;
  stageId: StageId;
  displayName: string;
  action: StageAction;
  fingerprint: string | null;
  sourceRunId?: string;
  materialize: boolean;
}

export interface ExecutionPlan {
  version: 1;
  projectId: string;
  preset: PipelinePreset;
  stageIds: StageId[];
  runMode: 'new' | 'resume' | 'noop';
  requiresRuntimePreflight: boolean;
  sourceRunId?: string;
  targetRunId?: string;
  items: ExecutionPlanItem[];
}

export interface ExecutionPlanContext {
  project: ProjectInputs;
  sourceCatalog: ProjectSourceCatalog;
  registry: readonly PipelineStage[];
  runStore: RunStore;
  outputStore: OutputStore;
  reportStore: StageReportStore;
  createRunId(): string;
}

export type ExecutionPlanErrorCode =
  | 'PLAN_PRESET_INVALID'
  | 'PLAN_STAGE_INVALID'
  | 'PLAN_RANGE_INVALID'
  | 'PLAN_PREREQUISITE_MISSING'
  | 'PLAN_RANGE_STALE';

export class ExecutionPlanError extends Error {
  constructor(
    readonly code: ExecutionPlanErrorCode,
    message: string,
    readonly stageId?: StageId,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'ExecutionPlanError';
  }
}

interface SourceRun {
  pointer: CurrentPointer;
  runDirectory: RunDirectoryScope;
  reports: ReadonlyMap<StageId, StageReport>;
}

interface StageAssessment {
  stage: PipelineStage;
  report: StageReport | null;
  fingerprint: string | null;
  declaredComplete: boolean;
  reportAvailable: boolean;
  matching: boolean;
}

const PRESET_IDS = Object.keys(STAGE_PRESETS) as PipelinePreset[];
const STAGE_IDS = MVP_STAGES.map((stage) => stage.id);
const STAGE_POSITIONS = new Map(STAGE_IDS.map((stageId, index) => [
  stageId,
  index,
]));

const isPreset = (value: unknown): value is PipelinePreset =>
  typeof value === 'string' && PRESET_IDS.includes(value as PipelinePreset);

const isStageId = (value: unknown): value is StageId =>
  typeof value === 'string' && STAGE_POSITIONS.has(value as StageId);

const planError = (
  code: ExecutionPlanErrorCode,
  message: string,
  stageId?: StageId,
): never => {
  throw new ExecutionPlanError(code, message, stageId);
};

const validateStage = (value: unknown, option: string): StageId => {
  if (!isStageId(value)) {
    return planError(
      'PLAN_STAGE_INVALID',
      `${option} references an unknown Stage: ${String(value)}`,
    );
  }
  return value;
};

const isMissingPath = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const isOrdinaryPlanningMiss = (error: unknown): boolean => (
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

const prefixCompatible = (
  left: readonly StageId[],
  right: readonly StageId[],
): boolean => {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const pointerProgress = (pointer: CurrentPointer): number =>
  STAGE_POSITIONS.get(pointer.completedStage) ?? -1;

const reconcileCurrentPointer = (
  work: CurrentPointer | null,
  output: CurrentPointer | null,
): CurrentPointer | null => {
  if (work === null) return output;
  if (output === null || output.runId !== work.runId) return work;
  return pointerProgress(output) > pointerProgress(work) ? output : work;
};

const reportMatchesIdentity = (
  report: StageReport,
  projectId: string,
  runId: string,
  stageId: StageId,
): boolean => report.projectId === projectId
  && report.runId === runId
  && report.stageId === stageId
  && (report.state === 'passed' || report.state === 'cached')
  && report.fingerprint !== null;

const persistedPreflight = (
  report: StageReport | undefined,
): PreflightResult | undefined => {
  if (report === undefined) return undefined;
  try {
    const output = parsePreflightAdapterOutput(report.outputs);
    return {
      checks: report.checks,
      toolIdentities: output.toolIdentities,
      fonts: output.fonts,
      voice: output.voice,
      versions: output.versions,
      system: {
        ...output.system,
        platform: output.system.platform as NodeJS.Platform,
      },
      environmentFingerprint: output.environmentFingerprint,
    };
  } catch {
    return undefined;
  }
};

const readSourceRun = async (
  context: ExecutionPlanContext,
  projectId: string,
): Promise<SourceRun | null> => {
  const [workCurrent, outputCurrent] = await Promise.all([
    context.runStore.readCurrentReadonly(projectId),
    context.outputStore.readCurrentReadonly(projectId),
  ]);
  const pointer = reconcileCurrentPointer(workCurrent, outputCurrent);
  if (pointer === null) return null;

  let runDirectory: RunDirectoryScope;
  try {
    runDirectory = await context.runStore.openExistingRun(
      projectId,
      pointer.runId,
    );
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }

  const reports = new Map<StageId, StageReport>();
  for (const stageId of STAGE_IDS) {
    const report = await context.reportStore.readStage(runDirectory, stageId);
    if (report !== null) reports.set(stageId, report);
  }
  return {pointer, runDirectory, reports};
};

const calculateFingerprint = async (
  stage: PipelineStage,
  context: StagePlanningContext,
): Promise<string | null> => {
  try {
    return await stage.fingerprint(context);
  } catch (error) {
    if (isOrdinaryPlanningMiss(error)) return null;
    throw error;
  }
};

const verifyReport = async (
  stage: PipelineStage,
  context: StagePlanningContext,
  report: StageReport,
): Promise<boolean> => {
  try {
    return await stage.verify(context, report);
  } catch (error) {
    if (isOrdinaryPlanningMiss(error)) return false;
    throw error;
  }
};

const assessStages = async (
  context: ExecutionPlanContext,
  source: SourceRun | null,
  presetStageIds: readonly StageId[],
): Promise<Map<StageId, StageAssessment>> => {
  const registry = new Map(context.registry.map((stage) => [stage.id, stage]));
  const projectId = context.project.project.id;
  const preflight = persistedPreflight(source?.reports.get('preflight'));
  const planningContext: StagePlanningContext = {
    project: context.project,
    sourceCatalog: context.sourceCatalog,
    ...(preflight === undefined ? {} : {preflight}),
    ...(source === null ? {} : {
      sourceRun: {
        runId: source.pointer.runId,
        runDirectory: source.runDirectory,
        reports: source.reports,
      },
    }),
  };
  const completedPosition = source === null
    ? -1
    : pointerProgress(source.pointer);
  const assessments = new Map<StageId, StageAssessment>();

  for (const stageId of presetStageIds) {
    const stage = registry.get(stageId);
    if (stage === undefined) {
      return planError(
        'PLAN_STAGE_INVALID',
        `the Stage registry is missing ${stageId}`,
        stageId,
      );
    }
    const report = source?.reports.get(stageId) ?? null;
    const stagePosition = STAGE_POSITIONS.get(stageId)!;
    const declaredComplete = source !== null && stagePosition <= completedPosition;
    const reportAvailable = source !== null
      && report !== null
      && reportMatchesIdentity(
        report,
        projectId,
        source.pointer.runId,
        stageId,
      );
    const fingerprint = await calculateFingerprint(stage, planningContext);
    const matching = declaredComplete
      && reportAvailable
      && fingerprint !== null
      && report!.fingerprint === fingerprint
      && await verifyReport(stage, planningContext, report!);
    assessments.set(stageId, {
      stage,
      report,
      fingerprint,
      declaredComplete,
      reportAvailable,
      matching,
    });
  }
  return assessments;
};

const staleRange = (stageId: StageId, description: string): never => planError(
  'PLAN_RANGE_STALE',
  `${description}; widen --from to ${stageId} or remove --from`,
  stageId,
);

const item = (
  assessment: StageAssessment,
  position: number,
  total: number,
  action: StageAction,
  runMode: ExecutionPlan['runMode'],
  sourceRunId: string | undefined,
): ExecutionPlanItem => ({
  position,
  total,
  stageId: assessment.stage.id,
  displayName: assessment.stage.displayName,
  action,
  fingerprint: assessment.stage.id === 'preflight'
    ? null
    : assessment.fingerprint,
  ...(sourceRunId === undefined || (action !== 'cached' && action !== 'resume')
    ? {}
    : {sourceRunId}),
  materialize: action === 'cached' && runMode === 'new',
});

export async function buildExecutionPlan(
  context: ExecutionPlanContext,
  request: ExecutionPlanRequest,
): Promise<ExecutionPlan> {
  const requestedPreset = request.preset ?? 'release';
  if (!isPreset(requestedPreset)) {
    return planError(
      'PLAN_PRESET_INVALID',
      `unknown pipeline Preset: ${String(requestedPreset)}`,
    );
  }
  const preset = requestedPreset;
  const presetStageIds: readonly StageId[] = STAGE_PRESETS[preset];
  const from = request.from === undefined
    ? presetStageIds[0]!
    : validateStage(request.from, '--from');
  const to = request.to === undefined
    ? presetStageIds.at(-1)!
    : validateStage(request.to, '--to');
  const fromIndex = presetStageIds.indexOf(from);
  const toIndex = presetStageIds.indexOf(to);
  if (fromIndex < 0) {
    return planError(
      'PLAN_RANGE_INVALID',
      `${from} is not part of the ${preset} Preset`,
      from,
    );
  }
  if (toIndex < 0) {
    return planError(
      'PLAN_RANGE_INVALID',
      `${to} is not part of the ${preset} Preset`,
      to,
    );
  }
  if (fromIndex > toIndex) {
    return planError(
      'PLAN_RANGE_INVALID',
      `Stage range ${from} through ${to} is reversed`,
      from,
    );
  }

  const selectedStageIds = presetStageIds.slice(fromIndex, toIndex + 1);
  const force = request.force === undefined
    ? undefined
    : validateStage(request.force, '--force');
  const forceIndex = force === undefined ? -1 : selectedStageIds.indexOf(force);
  if (force !== undefined && forceIndex < 0) {
    return planError(
      'PLAN_RANGE_INVALID',
      `forced Stage ${force} must be inside the selected range`,
      force,
    );
  }

  const projectId = context.project.project.id;
  const source = await readSourceRun(context, projectId);
  const assessments = await assessStages(
    context,
    source,
    presetStageIds,
  );
  const omittedPrerequisites = presetStageIds.slice(0, fromIndex);
  const requiresRuntimePreflight = fromIndex > 0;

  if (omittedPrerequisites.length > 0) {
    for (const stageId of omittedPrerequisites) {
      const assessment = assessments.get(stageId)!;
      if (!assessment.declaredComplete || !assessment.reportAvailable) {
        return planError(
          'PLAN_PREREQUISITE_MISSING',
          `missing verified prerequisite ${stageId} before ${from}`,
          stageId,
        );
      }
      if (!assessment.matching) {
        return staleRange(stageId, `prerequisite ${stageId} changed`);
      }
    }
    for (const stageId of selectedStageIds) {
      const assessment = assessments.get(stageId)!;
      if (assessment.declaredComplete && !assessment.matching) {
        return staleRange(stageId, `completed Stage ${stageId} changed`);
      }
    }
    if (force !== undefined && assessments.get(force)!.declaredComplete) {
      return staleRange(force, `forced Stage ${force} is already complete`);
    }

    const firstIncompleteIndex = selectedStageIds.findIndex((stageId) => (
      !assessments.get(stageId)!.declaredComplete
    ));
    const runMode: ExecutionPlan['runMode'] = firstIncompleteIndex < 0
      ? 'noop'
      : 'resume';
    const sourceRunId = source?.pointer.runId;
    if (sourceRunId === undefined) {
      return planError(
        'PLAN_PREREQUISITE_MISSING',
        `the selected range requires an existing current Run`,
        omittedPrerequisites[0],
      );
    }
    const total = selectedStageIds.length;
    const items = selectedStageIds.map((stageId, index) => {
      const assessment = assessments.get(stageId)!;
      const action: StageAction = assessment.declaredComplete
        ? 'cached'
        : index === firstIncompleteIndex
          ? 'resume'
          : 'run';
      return item(
        assessment,
        index + 1,
        total,
        action,
        runMode,
        sourceRunId,
      );
    });
    return {
      version: 1,
      projectId,
      preset,
      stageIds: [...selectedStageIds],
      runMode,
      requiresRuntimePreflight,
      sourceRunId,
      targetRunId: sourceRunId,
      items,
    };
  }

  const sourceRunId = source?.pointer.runId;
  const selectedAssessments = selectedStageIds.map((stageId) => (
    assessments.get(stageId)!
  ));
  const firstMismatchIndex = selectedAssessments.findIndex((assessment) => (
    assessment.declaredComplete && !assessment.matching
  ));
  const firstIncompleteIndex = selectedAssessments.findIndex((assessment) => (
    !assessment.declaredComplete
  ));
  const forceCompleted = force === undefined
    ? false
    : assessments.get(force)!.declaredComplete;
  const compatibleResume = source !== null
    && prefixCompatible(source.pointer.stageIds, presetStageIds)
    && firstMismatchIndex < 0
    && !forceCompleted;

  if (request.resume === true && compatibleResume) {
    const runMode: ExecutionPlan['runMode'] = 'resume';
    const total = selectedStageIds.length;
    const items = selectedAssessments.map((assessment, index) => {
      let action: StageAction;
      if (assessment.stage.id === 'preflight') {
        action = 'run';
      } else if (assessment.declaredComplete) {
        action = 'cached';
      } else if (index === firstIncompleteIndex) {
        action = 'resume';
      } else {
        action = 'run';
      }
      return item(
        assessment,
        index + 1,
        total,
        action,
        runMode,
        sourceRunId,
      );
    });
    return {
      version: 1,
      projectId,
      preset,
      stageIds: [...selectedStageIds],
      runMode,
      requiresRuntimePreflight,
      ...(sourceRunId === undefined ? {} : {sourceRunId}),
      ...(sourceRunId === undefined ? {} : {targetRunId: sourceRunId}),
      items,
    };
  }

  const boundaries = [firstMismatchIndex, firstIncompleteIndex, forceIndex]
    .filter((index) => index >= 0);
  const rerunFrom = boundaries.length === 0
    ? selectedStageIds.length
    : Math.min(...boundaries);
  const runMode: ExecutionPlan['runMode'] = 'new';
  const targetRunId = context.createRunId();
  const total = selectedStageIds.length;
  const items = selectedAssessments.map((assessment, index) => {
    const action: StageAction = assessment.stage.id !== 'preflight'
      && index < rerunFrom
      && assessment.matching
      ? 'cached'
      : 'run';
    return item(
      assessment,
      index + 1,
      total,
      action,
      runMode,
      sourceRunId,
    );
  });
  return {
    version: 1,
    projectId,
    preset,
    stageIds: [...selectedStageIds],
    runMode,
    requiresRuntimePreflight,
    ...(sourceRunId === undefined ? {} : {sourceRunId}),
    targetRunId,
    items,
  };
}
