import {StableIdSchema} from '../domain/schema-primitives';
import {
  assertScopedDirectoryEntryUnchanged,
  createOutputStore,
  createRunStore,
  getRunDirectoryIdentity,
  listOutputDirectory,
  listWorkDirectory,
  removeOutputTree,
  removeWorkTree,
  unlinkRunFile,
  type OutputDirectoryScope,
  type OutputStore,
  type RunDirectoryScope,
  type RunStore,
  type ScopedDirectoryEntry,
  type StageId,
} from './run-store';
import type {PipelinePartialArtifact} from './stage';
import {acquireProjectLock} from './project-lock';

export interface CleanupPlan {
  projectId: string;
  protectedRunId?: string;
  protectedReleaseId?: string;
  runDirectories: string[];
  releaseDirectories: string[];
}

export interface CleanupResult {
  removedRuns: string[];
  removedReleases: string[];
}

export interface CleanupDependencies {
  runStore: RunStore;
  outputStore: OutputStore;
  removeWorkTree: typeof removeWorkTree;
  removeOutputTree: typeof removeOutputTree;
}

export interface FailedStageCleanupInput {
  projectId: string;
  runId?: string;
  stageId: StageId;
  runDirectory?: RunDirectoryScope;
  outputDirectory?: OutputDirectoryScope;
  partialArtifacts: readonly PipelinePartialArtifact[];
}

interface CleanupPlanAuthority {
  dependencies: CleanupDependencies;
  runEntries: Map<string, ScopedDirectoryEntry>;
  releaseEntries: Map<string, ScopedDirectoryEntry>;
}

interface CleanupPlanExecutionState {
  consumedRunIds: Set<string>;
  consumedReleaseIds: Set<string>;
}

const cleanupPlanAuthorities = new WeakMap<CleanupPlan, CleanupPlanAuthority>();
const cleanupPlanExecutionStates = new WeakMap<
  CleanupPlan,
  CleanupPlanExecutionState
>();

const cleanupPlanExecutionState = (
  plan: CleanupPlan,
): CleanupPlanExecutionState => {
  const existing = cleanupPlanExecutionStates.get(plan);
  if (existing !== undefined) return existing;
  const created: CleanupPlanExecutionState = {
    consumedRunIds: new Set(),
    consumedReleaseIds: new Set(),
  };
  cleanupPlanExecutionStates.set(plan, created);
  return created;
};

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const listIfPresent = async <Scope>(
  scope: Scope | null,
  relativePath: string,
  list: (scope: Scope, relativePath: string) => Promise<ScopedDirectoryEntry[]>,
): Promise<ScopedDirectoryEntry[]> => {
  if (scope === null) return [];
  try {
    return await list(scope, relativePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }
};

const cleanupDirectoryInventory = (
  entries: readonly ScopedDirectoryEntry[],
  protectedId: string | undefined,
): {ids: string[]; entries: Map<string, ScopedDirectoryEntry>} => {
  const candidates = entries
    .filter((entry) => entry.kind === 'directory')
    .filter((entry) => (
      StableIdSchema.safeParse(entry.name).success
      && entry.name !== protectedId
    ))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    ids: candidates.map((entry) => entry.name),
    entries: new Map(candidates.map((entry) => [entry.name, entry])),
  };
};

export async function buildCleanupPlan(input: {
  workspaceRoot: string;
  projectId: string;
}): Promise<CleanupPlan> {
  const projectId = StableIdSchema.parse(input.projectId);
  const dependencies: CleanupDependencies = {
    runStore: createRunStore(input.workspaceRoot),
    outputStore: createOutputStore(input.workspaceRoot),
    removeWorkTree,
    removeOutputTree,
  };
  const [work, output, workCurrent, outputCurrent] = await Promise.all([
    dependencies.runStore.openExistingWork(projectId),
    dependencies.outputStore.openExistingProject(projectId),
    dependencies.runStore.readCurrentReadonly(projectId),
    dependencies.outputStore.readCurrentReadonly(projectId),
  ]);
  const [runs, releases] = await Promise.all([
    listIfPresent(work, 'runs', listWorkDirectory),
    listIfPresent(output, 'releases', listOutputDirectory),
  ]);
  const runInventory = cleanupDirectoryInventory(runs, workCurrent?.runId);
  const releaseInventory = cleanupDirectoryInventory(
    releases,
    outputCurrent?.runId,
  );
  const plan: CleanupPlan = {
    projectId,
    ...(workCurrent === null ? {} : {protectedRunId: workCurrent.runId}),
    ...(outputCurrent === null ? {} : {protectedReleaseId: outputCurrent.runId}),
    runDirectories: runInventory.ids,
    releaseDirectories: releaseInventory.ids,
  };
  cleanupPlanAuthorities.set(plan, {
    dependencies,
    runEntries: runInventory.entries,
    releaseEntries: releaseInventory.entries,
  });
  return plan;
}

const requireCleanupDependencies = (
  plan: CleanupPlan,
  dependencies: CleanupDependencies | undefined,
): CleanupDependencies => {
  const resolved = dependencies ?? cleanupPlanAuthorities.get(plan)?.dependencies;
  if (resolved === undefined) {
    throw new TypeError('cleanup dependencies are required for an external CleanupPlan');
  }
  return resolved;
};

const candidateEntry = (
  entries: readonly ScopedDirectoryEntry[],
  candidateId: string,
): ScopedDirectoryEntry | undefined => entries.find(
  (entry) => entry.name === candidateId,
);

const executeCleanupPlanLocked = async (
  plan: CleanupPlan,
  resolved: CleanupDependencies,
  authority: CleanupPlanAuthority | undefined,
  executionState: CleanupPlanExecutionState,
): Promise<CleanupResult> => {
  const projectId = StableIdSchema.parse(plan.projectId);
  const removedRuns: string[] = [];
  const removedReleases: string[] = [];

  for (const rawRunId of plan.runDirectories) {
    const runId = StableIdSchema.parse(rawRunId);
    if (runId === plan.protectedRunId) continue;
    if (executionState.consumedRunIds.has(runId)) continue;
    const work = await resolved.runStore.openExistingWork(projectId);
    const currentEntry = candidateEntry(
      await listIfPresent(work, 'runs', listWorkDirectory),
      runId,
    );
    if (currentEntry === undefined) {
      executionState.consumedRunIds.add(runId);
      continue;
    }
    const current = await resolved.runStore.readCurrentReadonly(projectId);
    if (current?.runId === runId) continue;
    if (work === null) continue;
    const inventoried = authority?.runEntries.get(runId);
    if (inventoried !== undefined) {
      assertScopedDirectoryEntryUnchanged(
        inventoried,
        currentEntry,
        `runs/${runId}`,
      );
    }
    await resolved.removeWorkTree(work, `runs/${runId}`);
    executionState.consumedRunIds.add(runId);
    removedRuns.push(runId);
  }

  for (const rawReleaseId of plan.releaseDirectories) {
    const releaseId = StableIdSchema.parse(rawReleaseId);
    if (releaseId === plan.protectedReleaseId) continue;
    if (executionState.consumedReleaseIds.has(releaseId)) continue;
    const output = await resolved.outputStore.openExistingProject(projectId);
    const currentEntry = candidateEntry(
      await listIfPresent(output, 'releases', listOutputDirectory),
      releaseId,
    );
    if (currentEntry === undefined) {
      executionState.consumedReleaseIds.add(releaseId);
      continue;
    }
    const current = await resolved.outputStore.readCurrentReadonly(projectId);
    if (current?.runId === releaseId) continue;
    if (output === null) continue;
    const inventoried = authority?.releaseEntries.get(releaseId);
    if (inventoried !== undefined) {
      assertScopedDirectoryEntryUnchanged(
        inventoried,
        currentEntry,
        `releases/${releaseId}`,
      );
    }
    await resolved.removeOutputTree(output, `releases/${releaseId}`);
    executionState.consumedReleaseIds.add(releaseId);
    removedReleases.push(releaseId);
  }

  return {removedRuns, removedReleases};
};

export async function executeCleanupPlan(
  plan: CleanupPlan,
  dependencies?: CleanupDependencies,
): Promise<CleanupResult> {
  const resolved = requireCleanupDependencies(plan, dependencies);
  const projectId = StableIdSchema.parse(plan.projectId);
  const work = await resolved.runStore.createWork(projectId);
  const lease = await acquireProjectLock(work, 'cleanup');
  let outcome:
    | {ok: true; value: CleanupResult}
    | {ok: false; error: unknown};
  try {
    outcome = {
      ok: true,
      value: await executeCleanupPlanLocked(
        plan,
        resolved,
        cleanupPlanAuthorities.get(plan),
        cleanupPlanExecutionState(plan),
      ),
    };
  } catch (error) {
    outcome = {ok: false, error};
  }

  let releaseError: unknown;
  try {
    await lease.release();
  } catch (error) {
    releaseError = error;
  }
  if (!outcome.ok) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [outcome.error, releaseError],
        'Cleanup execution and project lock release both failed',
        {cause: outcome.error},
      );
    }
    throw outcome.error;
  }
  if (releaseError !== undefined) throw releaseError;
  return outcome.value;
}

const throwCleanupErrors = (
  errors: readonly unknown[],
  stageId: StageId,
): void => {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `failed to clean declared partial artifacts for ${stageId}`,
      {cause: errors[0]},
    );
  }
};

export async function cleanupFailedStage(
  input: FailedStageCleanupInput,
): Promise<void> {
  const projectId = StableIdSchema.parse(input.projectId);
  const runIdentity = input.runDirectory === undefined
    ? undefined
    : getRunDirectoryIdentity(input.runDirectory);
  if (
    runIdentity !== undefined
    && (
      runIdentity.projectId !== projectId
      || (input.runId !== undefined && runIdentity.runId !== input.runId)
    )
  ) {
    throw new TypeError('failed-stage cleanup Run scope does not match its active Run');
  }
  const activeRunId = input.runId ?? runIdentity?.runId;
  const seen = new Set<string>();
  const errors: unknown[] = [];
  for (const artifact of input.partialArtifacts) {
    const key = `${artifact.scope}\0${artifact.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    try {
      if (artifact.scope === 'run') {
        if (input.runDirectory !== undefined) {
          await unlinkRunFile(input.runDirectory, artifact.path);
        }
        continue;
      }
      if (input.outputDirectory === undefined || activeRunId === undefined) continue;
      const outputPrefix = `releases/${StableIdSchema.parse(activeRunId)}/`;
      if (!artifact.path.startsWith(outputPrefix)) {
        throw new TypeError('failed-stage cleanup Output path is outside the active Release');
      }
      await removeOutputTree(input.outputDirectory, artifact.path);
    } catch (error) {
      errors.push(error);
    }
  }
  throwCleanupErrors(errors, input.stageId);
}
