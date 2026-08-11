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
  requiresProgressReconciliation: boolean;
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
  | 'PLAN_RANGE_STALE'
  | 'PLAN_STALE';

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

interface LoadedRun {
  runId: string;
  runDirectory: RunDirectoryScope;
  reports: ReadonlyMap<StageId, StageReport>;
  invalidReports: ReadonlySet<StageId>;
}

interface SourceRun extends LoadedRun {
  pointer: CurrentPointer;
  workPointer: CurrentPointer | null;
  outputPointer: CurrentPointer | null;
}

const isSourceRun = (source: LoadedRun): source is SourceRun => (
  'pointer' in source
  && 'workPointer' in source
  && 'outputPointer' in source
);

interface StageAssessment {
  stage: PipelineStage;
  report: StageReport | null;
  fingerprint: string | null;
  declaredComplete: boolean;
  recoveredTrailing: boolean;
  reportAvailable: boolean;
  matching: boolean;
}

const PRESET_IDS = Object.keys(STAGE_PRESETS) as PipelinePreset[];
const STAGE_IDS = MVP_STAGES.map((stage) => stage.id);
const STAGE_POSITIONS = new Map(STAGE_IDS.map((stageId, index) => [
  stageId,
  index,
]));
const NEW_RUN_REUSE_LIMIT = STAGE_POSITIONS.get('draft')!;

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

const pointerSnapshotCompatible = (
  plan: ExecutionPlan,
  pointer: CurrentPointer,
): boolean => {
  const planPresetStageIds: readonly StageId[] = STAGE_PRESETS[plan.preset];
  const pointerPresetStageIds: readonly StageId[] = STAGE_PRESETS[pointer.preset];
  return pointer.stageIds.length > 0
    && pointer.stageIds.every((stageId) => pointerPresetStageIds.includes(stageId))
    && prefixCompatible(planPresetStageIds, pointerPresetStageIds)
    && (
      prefixCompatible(pointer.stageIds, planPresetStageIds)
      || prefixCompatible(pointer.stageIds, plan.stageIds)
    );
};

const pointerProgress = (pointer: CurrentPointer): number => {
  const completedPosition = STAGE_POSITIONS.get(pointer.completedStage) ?? -1;
  return pointer.state === 'needs_review'
    ? Math.max(-1, completedPosition - 1)
    : completedPosition;
};

const reconcileCurrentPointer = (
  work: CurrentPointer | null,
  output: CurrentPointer | null,
): CurrentPointer | null => {
  if (work === null) return output;
  if (output === null) return work;
  if (output.runId === work.runId) {
    const progressOrder = pointerProgress(output) - pointerProgress(work);
    if (progressOrder !== 0) return progressOrder > 0 ? output : work;
    return output.completedStage === 'release' ? output : work;
  }
  const publicationOrder = output.publishedAt.localeCompare(work.publishedAt);
  if (publicationOrder !== 0) return publicationOrder > 0 ? output : work;
  const progressOrder = pointerProgress(output) - pointerProgress(work);
  if (progressOrder !== 0) return progressOrder > 0 ? output : work;
  return output;
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

const loadRun = async (
  context: ExecutionPlanContext,
  projectId: string,
  runId: string,
  reportStageIds: readonly StageId[],
): Promise<LoadedRun | null> => {
  let runDirectory: RunDirectoryScope;
  try {
    runDirectory = await context.runStore.openExistingRun(projectId, runId);
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }

  const reports = new Map<StageId, StageReport>();
  const invalidReports = new Set<StageId>();
  for (const stageId of reportStageIds) {
    let report: StageReport | null;
    try {
      report = await context.reportStore.readStage(runDirectory, stageId);
    } catch (error) {
      if (isOrdinaryPlanningMiss(error)) {
        invalidReports.add(stageId);
        continue;
      }
      throw error;
    }
    if (report !== null) reports.set(stageId, report);
  }
  return {runId, runDirectory, reports, invalidReports};
};

const readSourceRun = async (
  context: ExecutionPlanContext,
  projectId: string,
  reportStageIds: readonly StageId[],
): Promise<SourceRun | null> => {
  const [workCurrent, outputCurrent] = await Promise.all([
    context.runStore.readCurrentReadonly(projectId),
    context.outputStore.readCurrentReadonly(projectId),
  ]);
  const pointer = reconcileCurrentPointer(workCurrent, outputCurrent);
  if (pointer === null) return null;
  const loaded = await loadRun(context, projectId, pointer.runId, reportStageIds);
  return loaded === null
    ? null
    : {
      runId: loaded.runId,
      pointer,
      workPointer: workCurrent,
      outputPointer: outputCurrent,
      runDirectory: loaded.runDirectory,
      reports: loaded.reports,
      invalidReports: loaded.invalidReports,
    };
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
  let reconciledCompletedPosition = completedPosition;
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
    const reportAvailable = source !== null
      && report !== null
      && reportMatchesIdentity(
        report,
        projectId,
        source.pointer.runId,
        stageId,
      );
    const fingerprint = await calculateFingerprint(stage, planningContext);
    const reportMatching = reportAvailable
      && fingerprint !== null
      && report!.fingerprint === fingerprint
      && await verifyReport(stage, planningContext, report!);
    const recoveredTrailing = source !== null
      && stagePosition > completedPosition
      && stagePosition === reconciledCompletedPosition + 1
      && reportMatching;
    if (recoveredTrailing) reconciledCompletedPosition = stagePosition;
    const declaredComplete = source !== null
      && (stagePosition <= completedPosition || recoveredTrailing);
    const matching = declaredComplete && reportMatching;
    assessments.set(stageId, {
      stage,
      report,
      fingerprint,
      declaredComplete,
      recoveredTrailing,
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

const needsProgressReconciliation = (
  source: SourceRun | null,
  assessments: readonly StageAssessment[],
): boolean => {
  if (source === null) return false;
  const workProgress = source.workPointer?.runId === source.pointer.runId
    ? pointerProgress(source.workPointer)
    : -1;
  const workBehind = assessments.some((assessment) => (
    assessment.declaredComplete
    && STAGE_POSITIONS.get(assessment.stage.id)! > workProgress
  ));
  const releaseComplete = assessments.some((assessment) => (
    assessment.stage.id === 'release' && assessment.declaredComplete
  ));
  const outputPublished = source.outputPointer?.runId === source.pointer.runId;
  return workBehind || (releaseComplete && !outputPublished);
};

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

const stalePlan = (message: string, stageId?: StageId): never => planError(
  'PLAN_STALE',
  message,
  stageId,
);

const revalidationSource = async (
  plan: ExecutionPlan,
  context: ExecutionPlanContext,
  reportStageIds: readonly StageId[],
): Promise<LoadedRun | null> => {
  const sourceRunId = plan.sourceRunId;
  if (sourceRunId === undefined) {
    if (plan.runMode === 'resume' || plan.runMode === 'noop') {
      return stalePlan('resume and noop plans require a source Run');
    }
    return null;
  }
  if (plan.runMode === 'new') {
    return await loadRun(context, plan.projectId, sourceRunId, reportStageIds);
  }
  const current = await readSourceRun(
    context,
    plan.projectId,
    reportStageIds,
  );
  if (current === null || current.pointer.runId !== sourceRunId) {
    return stalePlan('the authoritative current Run changed before execution');
  }
  if (!pointerSnapshotCompatible(plan, current.pointer)) {
    return stalePlan('the authoritative current Stage snapshot changed before execution');
  }
  return current;
};

export async function revalidateExecutionPlan(
  plan: ExecutionPlan,
  context: ExecutionPlanContext,
  livePreflight?: PreflightResult,
): Promise<ExecutionPlan> {
  if (plan.projectId !== context.project.project.id) {
    return stalePlan('the Execution Plan belongs to another project');
  }
  const presetStageIds: readonly StageId[] = STAGE_PRESETS[plan.preset];
  const selectedIndexes = plan.stageIds.map((stageId) => presetStageIds.indexOf(stageId));
  if (selectedIndexes.some((index) => index < 0)) {
    return stalePlan('the Execution Plan contains a Stage outside its Preset');
  }
  const firstSelectedIndex = Math.min(...selectedIndexes);
  const lastSelectedIndex = Math.max(...selectedIndexes);
  const reportStageIds = presetStageIds.slice(0, lastSelectedIndex + 1);
  const source = await revalidationSource(plan, context, reportStageIds);
  const registry = new Map(context.registry.map((stage) => [stage.id, stage]));
  const sourcePreflight = persistedPreflight(source?.reports.get('preflight'));
  const planningPreflight = livePreflight ?? sourcePreflight;
  const planningContext: StagePlanningContext = {
    project: context.project,
    sourceCatalog: context.sourceCatalog,
    ...(planningPreflight === undefined ? {} : {preflight: planningPreflight}),
    ...(source === null ? {} : {
      sourceRun: {
        runId: source.runId,
        runDirectory: source.runDirectory,
        reports: source.reports,
      },
    }),
  };
  const selectedItems = new Map(plan.items.map((planItem, index) => [
    planItem.stageId,
    {planItem, index},
  ]));
  const fingerprints = new Map<StageId, string | null>();
  const recoveredSelected = new Set<StageId>();
  const sourcePointer = source !== null && isSourceRun(source)
    ? source.pointer
    : undefined;
  const authoritativeCompletedPosition = sourcePointer === undefined
    ? -1
    : pointerProgress(sourcePointer);
  let reconciledCompletedPosition = authoritativeCompletedPosition;
  let firstMismatch = -1;

  for (const [stageIndex, stageId] of reportStageIds.entries()) {
    const selected = selectedItems.get(stageId);
    const omittedPrerequisite = stageIndex < firstSelectedIndex;
    const stagePosition = STAGE_POSITIONS.get(stageId)!;
    const selectedCanRecover = plan.runMode === 'resume'
      && stageId !== 'preflight'
      && selected !== undefined
      && (
        selected.planItem.action === 'resume'
        || selected.planItem.action === 'run'
      );
    const selectedReportAppeared = selectedCanRecover && (
      source?.reports.has(stageId) === true
      || source?.invalidReports.has(stageId) === true
      || stagePosition <= authoritativeCompletedPosition
    );
    const requiresVerifiedReport = omittedPrerequisite
      || selected?.planItem.action === 'cached'
      || selectedReportAppeared;
    if (!requiresVerifiedReport && selected === undefined) continue;
    const stage = registry.get(stageId);
    if (stage === undefined) {
      return stalePlan(`the Stage registry is missing ${stageId}`, stageId);
    }
    const fingerprint = await calculateFingerprint(stage, planningContext);
    fingerprints.set(stageId, fingerprint);
    if (!requiresVerifiedReport) continue;

    const report = source?.reports.get(stageId);
    const reportAvailable = source !== null
      && report !== undefined
      && reportMatchesIdentity(report, plan.projectId, source.runId, stageId);
    let matching = reportAvailable;
    if (matching && stageId === 'preflight') {
      matching = sourcePreflight !== undefined;
    } else if (matching) {
      matching = fingerprint !== null
        && report!.fingerprint === fingerprint
        && await verifyReport(stage, planningContext, report!);
    }
    if (
      matching
      && selected?.planItem.action === 'cached'
      && plan.runMode === 'new'
    ) {
      if (report!.artifacts.some((artifact) => artifact.scope === 'output')) {
        return stalePlan(
          `cached ${stageId} contains an Output artifact`,
          stageId,
        );
      }
      matching = selected.planItem.materialize
        && stageId !== 'preflight'
        && STAGE_POSITIONS.get(stageId)! <= NEW_RUN_REUSE_LIMIT;
    }
    if (matching) {
      if (
        sourcePointer !== undefined
        && stagePosition > authoritativeCompletedPosition
      ) {
        if (stagePosition !== reconciledCompletedPosition + 1) {
          return stalePlan(
            `newly completed Stage ${stageId} is not contiguous with current progress`,
            stageId,
          );
        }
        reconciledCompletedPosition = stagePosition;
      }
      if (selectedReportAppeared) recoveredSelected.add(stageId);
      continue;
    }

    if (plan.runMode !== 'new' || omittedPrerequisite || selected === undefined) {
      return stalePlan(`planned reusable Stage ${stageId} is no longer valid`, stageId);
    }
    if (firstMismatch < 0 || selected.index < firstMismatch) {
      firstMismatch = selected.index;
    }
  }

  const items = plan.items.map((planItem, index) => {
    const fingerprint = fingerprints.get(planItem.stageId);
    if (recoveredSelected.has(planItem.stageId)) {
      return {
        ...planItem,
        action: 'cached' as const,
        fingerprint: fingerprint ?? planItem.fingerprint,
        ...(source === null ? {} : {sourceRunId: source.runId}),
        materialize: false,
      };
    }
    if (firstMismatch >= 0 && index >= firstMismatch) {
      const {sourceRunId: _sourceRunId, ...base} = planItem;
      return {
        ...base,
        action: 'run' as const,
        fingerprint: planItem.stageId === 'preflight'
          ? null
          : (fingerprint ?? planItem.fingerprint),
        materialize: false,
      };
    }
    return fingerprint === undefined || planItem.stageId === 'preflight'
      ? {...planItem}
      : {...planItem, fingerprint};
  });
  const requiresProgressReconciliation = plan.requiresProgressReconciliation
    || [...recoveredSelected].some((stageId) => (
      STAGE_POSITIONS.get(stageId)! > authoritativeCompletedPosition
    ));
  return {...plan, requiresProgressReconciliation, items};
}

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
  const relevantStageIds = presetStageIds.slice(0, toIndex + 1);
  const source = await readSourceRun(context, projectId, relevantStageIds);
  const assessments = await assessStages(
    context,
    source,
    relevantStageIds,
  );
  const omittedPrerequisites = presetStageIds.slice(0, fromIndex);
  const requiresRuntimePreflight = fromIndex > 0;
  const selectedAssessments = selectedStageIds.map((stageId) => (
    assessments.get(stageId)!
  ));
  const requiresProgressReconciliation = needsProgressReconciliation(
    source,
    selectedAssessments,
  );

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
      && !requiresProgressReconciliation
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
      requiresProgressReconciliation,
      requiresRuntimePreflight,
      sourceRunId,
      targetRunId: sourceRunId,
      items,
    };
  }

  const sourceRunId = source?.pointer.runId;
  const firstMismatchIndex = selectedAssessments.findIndex((assessment) => (
    assessment.declaredComplete && !assessment.matching
  ));
  const firstIncompleteIndex = selectedAssessments.findIndex((assessment) => (
    !assessment.declaredComplete
  ));
  const firstRecoveredIndex = selectedAssessments.findIndex((assessment) => (
    assessment.recoveredTrailing
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
      requiresProgressReconciliation,
      requiresRuntimePreflight,
      ...(sourceRunId === undefined ? {} : {sourceRunId}),
      ...(sourceRunId === undefined ? {} : {targetRunId: sourceRunId}),
      items,
    };
  }

  const boundaries = [
    firstMismatchIndex,
    firstIncompleteIndex,
    firstRecoveredIndex,
    forceIndex,
  ]
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
      && STAGE_POSITIONS.get(assessment.stage.id)! <= NEW_RUN_REUSE_LIMIT
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
    requiresProgressReconciliation: false,
    requiresRuntimePreflight,
    ...(sourceRunId === undefined ? {} : {sourceRunId}),
    targetRunId,
    items,
  };
}
