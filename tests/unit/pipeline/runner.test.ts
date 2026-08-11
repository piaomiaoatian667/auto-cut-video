import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadProject, type ProjectInputs} from '../../../src/domain/load-project';
import {StableIdSchema} from '../../../src/domain/schema-primitives';
import {
  ensureRunDirectory,
  openNewRunFileForWrite,
  type RunDirectoryScope,
  type WorkDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  hashRunArtifact,
  verifyRunArtifact,
  type PipelineArtifact,
} from '../../../src/pipeline/artifacts';
import {
  revalidateExecutionPlan,
  type ExecutionPlan,
  type ExecutionPlanContext,
} from '../../../src/pipeline/execution-plan';
import type {ProjectLockLease} from '../../../src/pipeline/project-lock';
import {
  createOutputStore,
  createRunStore,
  type CurrentPointer,
  type OutputStore,
  type PipelinePreset,
  type RunStore,
  type StageId,
} from '../../../src/pipeline/run-store';
import {
  createRunId,
  runExecutionPlan,
  type RunnerDependencies,
} from '../../../src/pipeline/runner';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import type {
  PipelineStage,
  StageAction,
  StageExecutionContext,
  StageExecutionResult,
  StagePlanningContext,
} from '../../../src/pipeline/stage';
import {
  createStageReportStore,
  StageReportSchema,
  type StageReport,
  type StageReportStore,
} from '../../../src/pipeline/stage-report';
import type {PreflightResult} from '../../../src/pipeline/stages/preflight';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
  createTempProject,
} from '../../helpers/temp-project';
import {fakePreflightResult} from '../../helpers/pipeline-fixtures';

const STAGE_IDS: readonly StageId[] = [
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
  'review',
  'release',
];

const HASH_A = `sha256:${'a'.repeat(64)}`;
const HASH_B = `sha256:${'b'.repeat(64)}`;
const NOW = '2026-08-11T12:00:00.000Z';

const stageFingerprint = (stageId: StageId): string => `${stageId}-fingerprint`;

const sourceCatalog: ProjectSourceCatalog = {
  assets: [],
  totalBytes: 0,
  fingerprint: HASH_A,
};

const memoryProject = (): ProjectInputs => ({
  workspaceRoot: '/workspace',
  projectDirectory: {} as ProjectInputs['projectDirectory'],
  project: createProjectFixture(),
  script: createScriptFixture(),
  edit: createEditFixture(),
});

const currentPointer = (
  runId: string,
  completedStage: StageId,
  overrides: Partial<CurrentPointer> = {},
): CurrentPointer => ({
  runId,
  relativePath: `runs/${runId}`,
  preset: 'release',
  stageIds: [...STAGE_IDS],
  completedStage,
  state: 'passed',
  publishedAt: NOW,
  ...overrides,
});

const makeReport = ({
  runId,
  preset,
  stageId,
  artifacts = [],
  state = 'passed',
  fingerprint = stageFingerprint(stageId),
  outputs = (stageId === 'preflight'
    ? fakePreflightResult()
    : {stageId}) as unknown as StageReport['outputs'],
  position,
  total,
}: {
  runId: string;
  preset: PipelinePreset;
  stageId: StageId;
  artifacts?: PipelineArtifact[];
  state?: StageReport['state'];
  fingerprint?: string | null;
  outputs?: StageReport['outputs'];
  position?: number;
  total?: number;
}): StageReport => StageReportSchema.parse({
  version: 1,
  projectId: 'demo',
  runId,
  preset,
  stageId,
  position: position ?? STAGE_IDS.indexOf(stageId) + 1,
  total: total ?? STAGE_IDS.length,
  state,
  fingerprint,
  startedAt: NOW,
  finishedAt: NOW,
  artifacts,
  outputs,
  checks: [],
});

const reportsThrough = (
  runId: string,
  preset: PipelinePreset,
  completedStage: StageId,
): StageReport[] => {
  const completedIndex = STAGE_IDS.indexOf(completedStage);
  return STAGE_IDS.slice(0, completedIndex + 1).map((stageId) => makeReport({
    runId,
    preset,
    stageId,
  }));
};

const makePlan = ({
  preset = 'release',
  stageIds,
  actions,
  runMode,
  sourceRunId,
  targetRunId,
  requiresRuntimePreflight = false,
}: {
  preset?: PipelinePreset;
  stageIds: readonly StageId[];
  actions: readonly StageAction[];
  runMode: ExecutionPlan['runMode'];
  sourceRunId?: string;
  targetRunId?: string;
  requiresRuntimePreflight?: boolean;
}): ExecutionPlan => ({
  version: 1,
  projectId: 'demo',
  preset,
  stageIds: [...stageIds],
  runMode,
  requiresRuntimePreflight,
  ...(sourceRunId === undefined ? {} : {sourceRunId}),
  ...(targetRunId === undefined ? {} : {targetRunId}),
  items: stageIds.map((stageId, index) => {
    const action = actions[index]!;
    return {
      position: index + 1,
      total: stageIds.length,
      stageId,
      displayName: stageId,
      action,
      fingerprint: stageId === 'preflight' ? null : stageFingerprint(stageId),
      ...(sourceRunId === undefined || (action !== 'cached' && action !== 'resume')
        ? {}
        : {sourceRunId}),
      materialize: action === 'cached' && runMode === 'new',
    };
  }),
});

interface StageOptions {
  preflight?: PreflightResult;
  fingerprints?: Partial<Record<
    StageId,
    (context: StagePlanningContext) => string | null
  >>;
  results?: Partial<Record<StageId, StageExecutionResult>>;
  verify?: Partial<Record<StageId, boolean>>;
  throwStage?: StageId;
}

const createStages = (
  events: string[],
  stageCalls: StageId[],
  options: StageOptions = {},
): readonly PipelineStage[] => STAGE_IDS.map((stageId) => ({
  id: stageId,
  displayName: stageId,
  prerequisites: [],
  fingerprint: async (context) => {
    events.push(`fingerprint:${stageId}`);
    const configured = options.fingerprints?.[stageId];
    if (configured !== undefined) return configured(context);
    if (stageId === 'preflight' && context.preflight === undefined) return null;
    return stageFingerprint(stageId);
  },
  verify: async (context, report) => {
    events.push(`verify:${stageId}`);
    const configured = options.fingerprints?.[stageId];
    const expected = configured === undefined
      ? stageFingerprint(stageId)
      : configured(context);
    return options.verify?.[stageId]
      ?? (expected !== null && report.fingerprint === expected);
  },
  partialArtifacts: () => [],
  execute: async () => {
    events.push(`execute:${stageId}`);
    stageCalls.push(stageId);
    if (options.throwStage === stageId) throw new Error(`${stageId} failed`);
    const configured = options.results?.[stageId];
    if (configured !== undefined) return configured;
    if (stageId === 'preflight') {
      const preflight = options.preflight ?? fakePreflightResult();
      return {
        state: 'passed',
        fingerprint: stageFingerprint(stageId),
        outputs: preflight,
        artifacts: [],
        checks: preflight.checks,
      };
    }
    return {
      state: 'passed',
      fingerprint: stageFingerprint(stageId),
      outputs: {stageId},
      artifacts: [],
      checks: [],
    };
  },
}));

interface MemoryRuntimeOptions extends StageOptions {
  current?: CurrentPointer | null;
  outputCurrent?: CurrentPointer | null;
  failOutputPublish?: boolean;
  failWorkPublishAt?: StageId;
  failWorkPublishOnceAt?: StageId;
  releaseError?: Error;
}

const createMemoryRuntime = (options: MemoryRuntimeOptions = {}) => {
  const events: string[] = [];
  const stageCalls: StageId[] = [];
  const work = {} as WorkDirectoryScope;
  const runs = new Map<string, RunDirectoryScope>();
  const reports = new Map<string, Map<StageId, StageReport>>();
  const attempts: StageReport[] = [];
  let workCurrent = options.current ?? null;
  let outputCurrent = options.outputCurrent ?? null;
  let workPublishFailed = false;

  const runIdOf = (run: RunDirectoryScope): string => (
    run as unknown as {runId: string}
  ).runId;
  const createScope = (runId: string): RunDirectoryScope => (
    {runId} as unknown as RunDirectoryScope
  );
  const seedRun = (runId: string, seededReports: readonly StageReport[]): void => {
    runs.set(runId, createScope(runId));
    reports.set(runId, new Map(seededReports.map((report) => [
      report.stageId,
      report,
    ])));
  };

  const runStore = {
    createWork: vi.fn(async () => {
      events.push('create-work');
      return work;
    }),
    openExistingWork: vi.fn(async () => work),
    createRun: vi.fn(async (_projectId: string, runId: string) => {
      events.push(`create-run:${runId}`);
      if (runs.has(runId)) throw Object.assign(new Error('exists'), {code: 'EEXIST'});
      const run = createScope(runId);
      runs.set(runId, run);
      reports.set(runId, new Map());
      return run;
    }),
    openExistingRun: vi.fn(async (_projectId: string, runId: string) => {
      events.push(`open-run:${runId}`);
      const run = runs.get(runId);
      if (run === undefined) throw Object.assign(new Error('missing'), {code: 'ENOENT'});
      return run;
    }),
    readCurrent: vi.fn(async () => workCurrent),
    readCurrentReadonly: vi.fn(async () => workCurrent),
    publishCurrent: vi.fn(async (_projectId: string, pointer: CurrentPointer) => {
      events.push(`work:${pointer.completedStage}:${pointer.state}`);
      if (
        options.failWorkPublishAt === pointer.completedStage
        || (
          options.failWorkPublishOnceAt === pointer.completedStage
          && !workPublishFailed
        )
      ) {
        workPublishFailed = true;
        throw new Error('work pointer failed');
      }
      workCurrent = pointer;
    }),
  } as unknown as RunStore;

  const outputStore = {
    readCurrent: vi.fn(async () => outputCurrent),
    readCurrentReadonly: vi.fn(async () => outputCurrent),
    publishCurrent: vi.fn(async (_projectId: string, pointer: CurrentPointer) => {
      events.push(`output:${pointer.completedStage}`);
      if (options.failOutputPublish === true) {
        throw new Error('output pointer failed');
      }
      outputCurrent = pointer;
    }),
  } as unknown as OutputStore;

  const reportStore: StageReportStore = {
    readStage: vi.fn(async (run, stageId) => (
      reports.get(runIdOf(run))?.get(stageId) ?? null
    )),
    writeStage: vi.fn(async (run, report) => {
      const validated = StageReportSchema.parse(report);
      events.push(`report:${validated.stageId}:${validated.state}`);
      const runReports = reports.get(runIdOf(run));
      if (runReports === undefined) throw new Error('unknown run');
      if (runReports.has(validated.stageId)) {
        throw Object.assign(new Error('exists'), {code: 'EEXIST'});
      }
      runReports.set(validated.stageId, validated);
    }),
    writeAttempt: vi.fn(async (_run, report) => {
      const validated = StageReportSchema.parse(report);
      events.push(`attempt:${validated.stageId}:${validated.state}`);
      attempts.push(validated);
      return `${validated.stageId}-attempt`;
    }),
    deleteStage: vi.fn(async (run, stageId) => {
      events.push(`delete-report:${stageId}`);
      reports.get(runIdOf(run))?.delete(stageId);
      events.push(`sync-report-parent:${stageId}`);
    }),
  };

  const release = vi.fn(async () => {
    events.push('release-lock');
    if (options.releaseError !== undefined) throw options.releaseError;
  });
  const lease: ProjectLockLease = {
    record: {
      pid: 1,
      hostname: 'test',
      processStart: 'test',
      createdAt: NOW,
      runId: 'run-lock',
    },
    release,
  };
  const acquireProjectLock = vi.fn(async () => {
    events.push('acquire-lock');
    return lease;
  }) as unknown as RunnerDependencies['acquireProjectLock'];
  const registry = createStages(events, stageCalls, options);
  const dependencies: RunnerDependencies = {
    registry,
    runStore,
    outputStore,
    reportStore,
    acquireProjectLock,
    createRunId: vi.fn(() => 'run-new'),
    now: vi.fn(() => NOW),
  };

  return {
    acquireProjectLock,
    attempts,
    dependencies,
    events,
    outputStore,
    registry,
    release,
    reportStore,
    runStore,
    seedRun,
    stageCalls,
    get workCurrent() {
      return workCurrent;
    },
    get outputCurrent() {
      return outputCurrent;
    },
    report: (runId: string, stageId: StageId) => reports.get(runId)?.get(stageId),
  };
};

const executionInput = (plan: ExecutionPlan, project = memoryProject()) => ({
  plan,
  project,
  sourceCatalog,
  signal: new AbortController().signal,
});

const writeRunArtifact = async (
  run: RunDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<PipelineArtifact> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(run, parent);
  const target = await openNewRunFileForWrite(run, relativePath);
  try {
    await target.handle.writeFile(contents);
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
  return await hashRunArtifact(run, relativePath);
};

const tempProjects: Array<{cleanup(): Promise<void>}> = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

describe('Pipeline Runner', () => {
  it('creates StableId-compatible default Run IDs', () => {
    expect(StableIdSchema.parse(createRunId())).toMatch(/^run-[a-z0-9-]+$/u);
  });

  it('runs preflight-only without Work, Run, lock, reports, or pointers', async () => {
    const runtime = createMemoryRuntime();
    const plan = makePlan({
      preset: 'assets',
      stageIds: ['preflight'],
      actions: ['run'],
      runMode: 'new',
      targetRunId: 'run-unused',
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result).toMatchObject({
      projectId: 'demo',
      preset: 'assets',
      state: 'passed',
      preflight: fakePreflightResult(),
      reports: [],
      warnings: [],
    });
    expect(result.runId).toBeUndefined();
    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.runStore.createWork).not.toHaveBeenCalled();
    expect(runtime.runStore.createRun).not.toHaveBeenCalled();
    expect(runtime.acquireProjectLock).not.toHaveBeenCalled();
    expect(runtime.runStore.publishCurrent).not.toHaveBeenCalled();
    expect(runtime.outputStore.publishCurrent).not.toHaveBeenCalled();
  });

  it('runs an unnumbered Preflight Gate for noop without writes or a lock', async () => {
    const sourceRunId = 'run-current';
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'compile', {
        preset: 'draft',
        stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
      }),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'compile'));
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['compile'],
      actions: ['cached'],
      runMode: 'noop',
      sourceRunId,
      targetRunId: sourceRunId,
      requiresRuntimePreflight: true,
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result).toMatchObject({
      runId: sourceRunId,
      state: 'passed',
      completedStage: 'compile',
      preflight: fakePreflightResult(),
      reports: [expect.objectContaining({stageId: 'compile', state: 'passed'})],
    });
    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.runStore.createWork).not.toHaveBeenCalled();
    expect(runtime.acquireProjectLock).not.toHaveBeenCalled();
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
    expect(runtime.reportStore.writeAttempt).not.toHaveBeenCalled();
    expect(runtime.runStore.publishCurrent).not.toHaveBeenCalled();
    expect(runtime.outputStore.publishCurrent).not.toHaveBeenCalled();
  });

  it('revalidates under the lock before writes and upgrades stale new-Run cache downstream', async () => {
    const sourceRunId = 'run-old';
    const runtime = createMemoryRuntime({verify: {ingest: false}});
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'narration'));
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'ingest', 'narration', 'compile'],
      actions: ['run', 'cached', 'cached', 'run'],
      runMode: 'new',
      sourceRunId,
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result.runId).toBe('run-new');
    expect(runtime.stageCalls).toEqual(['preflight', 'ingest', 'narration', 'compile']);
    expect(runtime.report('run-new', 'ingest')).toMatchObject({state: 'passed'});
    expect(runtime.events.indexOf('acquire-lock'))
      .toBeLessThan(runtime.events.indexOf('verify:ingest'));
    expect(runtime.events.indexOf('verify:ingest'))
      .toBeLessThan(runtime.events.indexOf('execute:preflight'));
    expect(runtime.events.indexOf('execute:preflight'))
      .toBeLessThan(runtime.events.indexOf('create-run:run-new'));
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('downgrades cached stages against live Preflight before creating a new Run', async () => {
    const sourceRunId = 'run-old';
    const persistedPreflight = fakePreflightResult();
    const livePreflight = {
      ...persistedPreflight,
      environmentFingerprint: HASH_B,
    };
    const preflightFingerprint = (
      stageId: StageId,
      context: StagePlanningContext,
    ): string => `${stageId}:${context.preflight?.environmentFingerprint ?? 'missing'}`;
    const runtime = createMemoryRuntime({
      preflight: livePreflight,
      fingerprints: {
        ingest: (context) => preflightFingerprint('ingest', context),
        narration: (context) => preflightFingerprint('narration', context),
      },
    });
    runtime.seedRun(sourceRunId, [
      makeReport({
        runId: sourceRunId,
        preset: 'draft',
        stageId: 'preflight',
        outputs: persistedPreflight as unknown as StageReport['outputs'],
      }),
      makeReport({
        runId: sourceRunId,
        preset: 'draft',
        stageId: 'ingest',
        fingerprint: `ingest:${persistedPreflight.environmentFingerprint}`,
      }),
      makeReport({
        runId: sourceRunId,
        preset: 'draft',
        stageId: 'narration',
        fingerprint: `narration:${persistedPreflight.environmentFingerprint}`,
      }),
    ]);
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'ingest', 'narration', 'compile'],
      actions: ['run', 'cached', 'cached', 'run'],
      runMode: 'new',
      sourceRunId,
      targetRunId: 'run-new',
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result.runId).toBe('run-new');
    expect(runtime.stageCalls).toEqual(['preflight', 'ingest', 'narration', 'compile']);
    expect(runtime.report('run-new', 'ingest')).toMatchObject({state: 'passed'});
    expect(runtime.report('run-new', 'narration')).toMatchObject({state: 'passed'});
    const ingestFingerprints = runtime.events
      .map((event, index) => ({event, index}))
      .filter(({event}) => event === 'fingerprint:ingest');
    expect(ingestFingerprints).toHaveLength(2);
    expect(runtime.events.indexOf('execute:preflight'))
      .toBeLessThan(ingestFingerprints.at(-1)!.index);
    expect(ingestFingerprints.at(-1)!.index)
      .toBeLessThan(runtime.events.indexOf('create-run:run-new'));
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('rejects resume when live Preflight invalidates a cached completed Stage', async () => {
    const sourceRunId = 'run-resume';
    const persistedPreflight = fakePreflightResult();
    const livePreflight = {
      ...persistedPreflight,
      environmentFingerprint: HASH_B,
    };
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest'),
      preflight: livePreflight,
      fingerprints: {
        ingest: (context) => `ingest:${context.preflight?.environmentFingerprint}`,
      },
    });
    runtime.seedRun(sourceRunId, [
      makeReport({
        runId: sourceRunId,
        preset: 'release',
        stageId: 'preflight',
        outputs: persistedPreflight as unknown as StageReport['outputs'],
      }),
      makeReport({
        runId: sourceRunId,
        preset: 'release',
        stageId: 'ingest',
        fingerprint: `ingest:${persistedPreflight.environmentFingerprint}`,
      }),
    ]);
    const plan = makePlan({
      stageIds: ['preflight', 'ingest', 'compile'],
      actions: ['run', 'cached', 'resume'],
      runMode: 'resume',
      sourceRunId,
      targetRunId: sourceRunId,
    });

    await expect(runExecutionPlan(executionInput(plan), runtime.dependencies))
      .rejects.toMatchObject({code: 'PLAN_STALE', stageId: 'ingest'});

    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.runStore.createRun).not.toHaveBeenCalled();
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
    expect(runtime.runStore.publishCurrent).not.toHaveBeenCalled();
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('rejects omitted Preflight when its live identity invalidates a prerequisite', async () => {
    const sourceRunId = 'run-old';
    const persistedPreflight = fakePreflightResult();
    const livePreflight = {
      ...persistedPreflight,
      environmentFingerprint: HASH_B,
    };
    const runtime = createMemoryRuntime({
      preflight: livePreflight,
      fingerprints: {
        ingest: (context) => `ingest:${context.preflight?.environmentFingerprint}`,
        narration: (context) => `narration:${context.preflight?.environmentFingerprint}`,
      },
    });
    runtime.seedRun(sourceRunId, [
      makeReport({
        runId: sourceRunId,
        preset: 'draft',
        stageId: 'preflight',
        outputs: persistedPreflight as unknown as StageReport['outputs'],
      }),
      makeReport({
        runId: sourceRunId,
        preset: 'draft',
        stageId: 'ingest',
        fingerprint: `ingest:${persistedPreflight.environmentFingerprint}`,
      }),
      makeReport({
        runId: sourceRunId,
        preset: 'draft',
        stageId: 'narration',
        fingerprint: `narration:${persistedPreflight.environmentFingerprint}`,
      }),
    ]);
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['compile'],
      actions: ['run'],
      runMode: 'new',
      sourceRunId,
      targetRunId: 'run-new',
      requiresRuntimePreflight: true,
    });

    await expect(runExecutionPlan(executionInput(plan), runtime.dependencies))
      .rejects.toMatchObject({code: 'PLAN_STALE', stageId: 'ingest'});

    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.runStore.createRun).not.toHaveBeenCalled();
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
    expect(runtime.runStore.publishCurrent).not.toHaveBeenCalled();
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('throws PLAN_STALE for changed completed resume reports before Run writes', async () => {
    const sourceRunId = 'run-resume';
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest'),
      verify: {ingest: false},
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'release', 'ingest'));
    const plan = makePlan({
      stageIds: ['preflight', 'ingest', 'compile'],
      actions: ['run', 'cached', 'resume'],
      runMode: 'resume',
      sourceRunId,
      targetRunId: sourceRunId,
    });

    await expect(runExecutionPlan(executionInput(plan), runtime.dependencies))
      .rejects.toMatchObject({code: 'PLAN_STALE', stageId: 'ingest'});

    expect(runtime.stageCalls).toEqual([]);
    expect(runtime.runStore.createRun).not.toHaveBeenCalled();
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
    expect(runtime.runStore.publishCurrent).not.toHaveBeenCalled();
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('rejects Output artifacts in a non-Release cached Stage before Run writes', async () => {
    const sourceRunId = 'run-old';
    const runtime = createMemoryRuntime();
    runtime.seedRun(sourceRunId, [
      makeReport({runId: sourceRunId, preset: 'draft', stageId: 'preflight'}),
      makeReport({
        runId: sourceRunId,
        preset: 'draft',
        stageId: 'ingest',
        artifacts: [{
          scope: 'output',
          path: 'releases/run-old/manifest.json',
          sha256: HASH_A,
        }],
      }),
    ]);
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'ingest', 'compile'],
      actions: ['run', 'cached', 'run'],
      runMode: 'new',
      sourceRunId,
      targetRunId: 'run-new',
    });

    await expect(runExecutionPlan(executionInput(plan), runtime.dependencies))
      .rejects.toMatchObject({code: 'PLAN_STALE', stageId: 'ingest'});

    expect(runtime.stageCalls).toEqual([]);
    expect(runtime.runStore.createRun).not.toHaveBeenCalled();
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('opens and advances the same immutable Run when resuming', async () => {
    const sourceRunId = 'run-resume';
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest'),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'release', 'ingest'));
    const plan = makePlan({
      stageIds: ['preflight', 'ingest', 'compile'],
      actions: ['run', 'cached', 'resume'],
      runMode: 'resume',
      sourceRunId,
      targetRunId: sourceRunId,
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result).toMatchObject({
      runId: sourceRunId,
      state: 'passed',
      completedStage: 'compile',
    });
    expect(runtime.stageCalls).toEqual(['preflight', 'compile']);
    expect(runtime.runStore.createRun).not.toHaveBeenCalled();
    expect(runtime.reportStore.writeStage).toHaveBeenCalledOnce();
    expect(runtime.report('run-resume', 'preflight')).toMatchObject({state: 'passed'});
    expect(runtime.report('run-resume', 'compile')).toMatchObject({state: 'passed'});
    expect(runtime.workCurrent).toMatchObject({
      runId: sourceRunId,
      completedStage: 'compile',
      state: 'passed',
    });
  });

  it('rolls back same-Run report and artifacts when Work publication fails', async () => {
    const tempProject = await createTempProject();
    tempProjects.push(tempProject);
    const project = await loadProject(tempProject.workspaceRoot, 'demo');
    const normalRunStore = createRunStore(tempProject.workspaceRoot);
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    const reportStore = createStageReportStore();
    const runId = 'run-resume';
    const runDirectory = await normalRunStore.createRun('demo', runId);
    await reportStore.writeStage(runDirectory, makeReport({
      runId,
      preset: 'draft',
      stageId: 'preflight',
    }));
    await reportStore.writeStage(runDirectory, makeReport({
      runId,
      preset: 'draft',
      stageId: 'ingest',
    }));
    await normalRunStore.publishCurrent('demo', currentPointer(runId, 'ingest', {
      preset: 'draft',
      stageIds: ['preflight', 'ingest', 'compile'],
    }));
    const pointerFailure = new Error('compile pointer failed once');
    let failCompilePointer = true;
    const runStore = createRunStore(tempProject.workspaceRoot, {
      fileOps: {
        writeFile: async (handle, data) => {
          const pointer = JSON.parse(data) as CurrentPointer;
          if (pointer.completedStage === 'compile' && failCompilePointer) {
            failCompilePointer = false;
            throw pointerFailure;
          }
          await handle.writeFile(data);
        },
      },
    });
    const events: string[] = [];
    const stageCalls: StageId[] = [];
    const artifactPath = 'compiled/retry.json';
    const registry = createStages(events, stageCalls).map((stage) => (
      stage.id !== 'compile'
        ? stage
        : {
          ...stage,
          execute: async (context: StageExecutionContext, signal: AbortSignal) => {
            const result = await stage.execute(context, signal);
            if (context.runDirectory === undefined) throw new Error('missing Run');
            const artifact = await writeRunArtifact(
              context.runDirectory,
              artifactPath,
              'compiled bytes',
            );
            return {...result, artifacts: [artifact]};
          },
        }
    ));
    const release = vi.fn(async () => undefined);
    const dependencies: RunnerDependencies = {
      registry,
      runStore,
      outputStore,
      reportStore,
      acquireProjectLock: vi.fn(async () => ({
        record: {
          pid: 1,
          hostname: 'test',
          processStart: 'test',
          createdAt: NOW,
          runId,
        },
        release,
      })) as unknown as RunnerDependencies['acquireProjectLock'],
      createRunId: vi.fn(() => runId),
      now: vi.fn(() => NOW),
    };
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'ingest', 'compile'],
      actions: ['run', 'cached', 'resume'],
      runMode: 'resume',
      sourceRunId: runId,
      targetRunId: runId,
    });

    await expect(runExecutionPlan(executionInput(plan, project), dependencies))
      .rejects.toBe(pointerFailure);

    await expect(reportStore.readStage(runDirectory, 'compile')).resolves.toBeNull();
    await expect(readFile(path.join(
      tempProject.workspaceRoot,
      '.work/demo/runs/run-resume',
      artifactPath,
    ), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    await expect(runStore.readCurrentReadonly('demo')).resolves.toMatchObject({
      completedStage: 'ingest',
    });

    const retry = await runExecutionPlan(executionInput(plan, project), dependencies);

    expect(retry).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'compile',
    });
    await expect(reportStore.readStage(runDirectory, 'compile')).resolves.toMatchObject({
      state: 'passed',
      artifacts: [expect.objectContaining({path: artifactPath})],
    });
    await expect(readFile(path.join(
      tempProject.workspaceRoot,
      '.work/demo/runs/run-resume',
      artifactPath,
    ), 'utf8')).resolves.toBe('compiled bytes');
    expect(stageCalls).toEqual(['preflight', 'compile', 'preflight', 'compile']);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('materializes only listed cached Run artifacts into a new Run', async () => {
    const tempProject = await createTempProject();
    tempProjects.push(tempProject);
    const project = await loadProject(tempProject.workspaceRoot, 'demo');
    const runStore = createRunStore(tempProject.workspaceRoot);
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    const reportStore = createStageReportStore();
    const sourceRunId = 'run-old';
    const targetRunId = 'run-new';
    const sourceRun = await runStore.createRun('demo', sourceRunId);
    const ingestArtifact = await writeRunArtifact(
      sourceRun,
      'assets/manifest.json',
      'ingest-bytes',
    );
    const narrationArtifact = await writeRunArtifact(
      sourceRun,
      'audio/narration.wav',
      'narration-bytes',
    );
    await reportStore.writeStage(sourceRun, makeReport({
      runId: sourceRunId,
      preset: 'draft',
      stageId: 'preflight',
      artifacts: [],
    }));
    await reportStore.writeStage(sourceRun, makeReport({
      runId: sourceRunId,
      preset: 'draft',
      stageId: 'ingest',
      artifacts: [ingestArtifact],
    }));
    await reportStore.writeStage(sourceRun, makeReport({
      runId: sourceRunId,
      preset: 'draft',
      stageId: 'narration',
      artifacts: [narrationArtifact],
    }));

    const events: string[] = [];
    const stageCalls: StageId[] = [];
    const registry = createStages(events, stageCalls).map((stage) => ({
      ...stage,
      verify: async (context: StagePlanningContext, report: StageReport) => {
        if (report.fingerprint !== stageFingerprint(stage.id)) return false;
        if (context.sourceRun === undefined) return false;
        for (const artifact of report.artifacts) {
          if (artifact.scope !== 'run') return false;
          if (!await verifyRunArtifact(context.sourceRun.runDirectory, artifact)) return false;
        }
        return true;
      },
    }));
    const release = vi.fn(async () => undefined);
    const dependencies: RunnerDependencies = {
      registry,
      runStore,
      outputStore,
      reportStore,
      acquireProjectLock: vi.fn(async () => ({
        record: {
          pid: 1,
          hostname: 'test',
          processStart: 'test',
          createdAt: NOW,
          runId: targetRunId,
        },
        release,
      })) as unknown as RunnerDependencies['acquireProjectLock'],
      createRunId: vi.fn(() => targetRunId),
      now: vi.fn(() => NOW),
    };
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'ingest', 'narration', 'compile'],
      actions: ['run', 'cached', 'cached', 'run'],
      runMode: 'new',
      sourceRunId,
      targetRunId,
    });

    const result = await runExecutionPlan(
      executionInput(plan, project),
      dependencies,
    );
    const targetRun = await runStore.openExistingRun('demo', targetRunId);

    expect(result.runId).toBe(targetRunId);
    expect(stageCalls).toEqual(['preflight', 'compile']);
    expect(await reportStore.readStage(targetRun, 'ingest')).toMatchObject({
      state: 'cached',
      provenance: {sourceRunId, sourceStageId: 'ingest'},
      artifacts: [ingestArtifact],
    });
    expect(await reportStore.readStage(targetRun, 'narration')).toMatchObject({
      state: 'cached',
      provenance: {sourceRunId, sourceStageId: 'narration'},
      artifacts: [narrationArtifact],
    });
    expect(await verifyRunArtifact(targetRun, ingestArtifact)).toBe(true);
    expect(await verifyRunArtifact(targetRun, narrationArtifact)).toBe(true);
    expect(await readFile(path.join(
      tempProject.workspaceRoot,
      '.work/demo/runs/run-new/assets/manifest.json',
    ), 'utf8')).toBe('ingest-bytes');
    expect(release).toHaveBeenCalledOnce();
  });

  it('removes earlier cached artifacts when a later copy fails', async () => {
    const tempProject = await createTempProject();
    tempProjects.push(tempProject);
    const project = await loadProject(tempProject.workspaceRoot, 'demo');
    const runStore = createRunStore(tempProject.workspaceRoot);
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    const reportStore = createStageReportStore();
    const sourceRunId = 'run-old';
    const targetRunId = 'run-new';
    const sourceRun = await runStore.createRun('demo', sourceRunId);
    const firstArtifact = await writeRunArtifact(
      sourceRun,
      'assets/first.json',
      'first bytes',
    );
    const secondArtifact = await writeRunArtifact(
      sourceRun,
      'assets/second.json',
      'second bytes',
    );
    await reportStore.writeStage(sourceRun, makeReport({
      runId: sourceRunId,
      preset: 'assets',
      stageId: 'preflight',
    }));
    await reportStore.writeStage(sourceRun, makeReport({
      runId: sourceRunId,
      preset: 'assets',
      stageId: 'ingest',
      artifacts: [firstArtifact, {...secondArtifact, sha256: HASH_B}],
    }));
    const events: string[] = [];
    const stageCalls: StageId[] = [];
    const registry = createStages(events, stageCalls).map((stage) => (
      stage.id === 'ingest'
        ? {...stage, verify: async () => true}
        : stage
    ));
    const dependencies: RunnerDependencies = {
      registry,
      runStore,
      outputStore,
      reportStore,
      acquireProjectLock: vi.fn(async () => ({
        record: {
          pid: 1,
          hostname: 'test',
          processStart: 'test',
          createdAt: NOW,
          runId: targetRunId,
        },
        release: async () => undefined,
      })) as unknown as RunnerDependencies['acquireProjectLock'],
      createRunId: vi.fn(() => targetRunId),
      now: vi.fn(() => NOW),
    };
    const plan = makePlan({
      preset: 'assets',
      stageIds: ['preflight', 'ingest'],
      actions: ['run', 'cached'],
      runMode: 'new',
      sourceRunId,
      targetRunId,
    });

    await expect(runExecutionPlan(executionInput(plan, project), dependencies))
      .rejects.toMatchObject({code: 'ARTIFACT_HASH_MISMATCH'});

    const targetRun = await runStore.openExistingRun('demo', targetRunId);
    await expect(reportStore.readStage(targetRun, 'ingest')).resolves.toBeNull();
    for (const artifact of [firstArtifact, secondArtifact]) {
      await expect(readFile(path.join(
        tempProject.workspaceRoot,
        '.work/demo/runs/run-new',
        artifact.path,
      ), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    }
    await expect(runStore.readCurrentReadonly('demo')).resolves.toMatchObject({
      runId: targetRunId,
      completedStage: 'preflight',
    });
  });

  it('rolls back cached report and artifacts when Work publication fails', async () => {
    const tempProject = await createTempProject();
    tempProjects.push(tempProject);
    const project = await loadProject(tempProject.workspaceRoot, 'demo');
    const normalRunStore = createRunStore(tempProject.workspaceRoot);
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    const reportStore = createStageReportStore();
    const sourceRunId = 'run-old';
    const targetRunId = 'run-new';
    const sourceRun = await normalRunStore.createRun('demo', sourceRunId);
    const artifacts = [
      await writeRunArtifact(sourceRun, 'assets/first.json', 'first bytes'),
      await writeRunArtifact(sourceRun, 'assets/second.json', 'second bytes'),
    ];
    await reportStore.writeStage(sourceRun, makeReport({
      runId: sourceRunId,
      preset: 'assets',
      stageId: 'preflight',
    }));
    await reportStore.writeStage(sourceRun, makeReport({
      runId: sourceRunId,
      preset: 'assets',
      stageId: 'ingest',
      artifacts,
    }));
    const pointerFailure = new Error('cached pointer failed');
    let failIngestPointer = true;
    const runStore = createRunStore(tempProject.workspaceRoot, {
      fileOps: {
        writeFile: async (handle, data) => {
          const pointer = JSON.parse(data) as CurrentPointer;
          if (pointer.completedStage === 'ingest' && failIngestPointer) {
            failIngestPointer = false;
            throw pointerFailure;
          }
          await handle.writeFile(data);
        },
      },
    });
    const events: string[] = [];
    const stageCalls: StageId[] = [];
    const registry = createStages(events, stageCalls).map((stage) => (
      stage.id === 'ingest'
        ? {...stage, verify: async () => true}
        : stage
    ));
    const dependencies: RunnerDependencies = {
      registry,
      runStore,
      outputStore,
      reportStore,
      acquireProjectLock: vi.fn(async () => ({
        record: {
          pid: 1,
          hostname: 'test',
          processStart: 'test',
          createdAt: NOW,
          runId: targetRunId,
        },
        release: async () => undefined,
      })) as unknown as RunnerDependencies['acquireProjectLock'],
      createRunId: vi.fn(() => targetRunId),
      now: vi.fn(() => NOW),
    };
    const plan = makePlan({
      preset: 'assets',
      stageIds: ['preflight', 'ingest'],
      actions: ['run', 'cached'],
      runMode: 'new',
      sourceRunId,
      targetRunId,
    });

    await expect(runExecutionPlan(executionInput(plan, project), dependencies))
      .rejects.toBe(pointerFailure);

    const targetRun = await runStore.openExistingRun('demo', targetRunId);
    await expect(reportStore.readStage(targetRun, 'ingest')).resolves.toBeNull();
    for (const artifact of artifacts) {
      await expect(readFile(path.join(
        tempProject.workspaceRoot,
        '.work/demo/runs/run-new',
        artifact.path,
      ), 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    }
    await expect(runStore.readCurrentReadonly('demo')).resolves.toMatchObject({
      runId: targetRunId,
      completedStage: 'preflight',
    });
  });

  it('does not permit Review or Release cross-Run cache materialization', async () => {
    const sourceRunId = 'run-old';
    const runtime = createMemoryRuntime();
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'release', 'release'));
    const plan = makePlan({
      stageIds: ['draft', 'review', 'release'],
      actions: ['cached', 'cached', 'cached'],
      runMode: 'new',
      sourceRunId,
      targetRunId: 'run-new',
    });
    const context: ExecutionPlanContext = {
      project: memoryProject(),
      sourceCatalog,
      registry: runtime.registry,
      runStore: runtime.dependencies.runStore,
      outputStore: runtime.dependencies.outputStore,
      reportStore: runtime.dependencies.reportStore,
      createRunId: runtime.dependencies.createRunId,
    };

    const revalidated = await revalidateExecutionPlan(plan, context);

    expect(revalidated.items.map((item) => [item.stageId, item.action])).toEqual([
      ['draft', 'cached'],
      ['review', 'run'],
      ['release', 'run'],
    ]);
  });

  it('writes a review attempt and publishes needs_review before stopping Release', async () => {
    const reviewResult: StageExecutionResult = {
      state: 'needs_review',
      fingerprint: stageFingerprint('review'),
      outputs: {review: null},
      artifacts: [],
      checks: [{
        id: 'review-required',
        severity: 'warning',
        message: 'Review required.',
        requiresReview: true,
      }],
    };
    const runtime = createMemoryRuntime({results: {review: reviewResult}});
    const plan = makePlan({
      stageIds: ['preflight', 'review', 'release'],
      actions: ['run', 'run', 'run'],
      runMode: 'new',
      targetRunId: 'run-review',
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result).toMatchObject({
      runId: 'run-review',
      state: 'needs_review',
      completedStage: 'review',
    });
    expect(runtime.stageCalls).toEqual(['preflight', 'review']);
    expect(runtime.attempts).toEqual([
      expect.objectContaining({stageId: 'review', state: 'needs_review'}),
    ]);
    expect(runtime.workCurrent).toMatchObject({
      runId: 'run-review',
      completedStage: 'review',
      state: 'needs_review',
    });
    expect(runtime.events.indexOf('attempt:review:needs_review'))
      .toBeLessThan(runtime.events.indexOf('work:review:needs_review'));
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('rolls back only the Release report when Output publication fails', async () => {
    const previousOutput = currentPointer('run-published', 'release', {
      relativePath: 'releases/run-published',
    });
    const outputCurrent = currentPointer('run-release', 'release', {
      relativePath: 'releases/run-release',
    });
    const runtime = createMemoryRuntime({
      outputCurrent: previousOutput,
      failOutputPublish: true,
      results: {
        release: {
          state: 'passed',
          fingerprint: stageFingerprint('release'),
          outputs: {finalVideo: 'releases/run-release/final.mp4'},
          artifacts: [{
            scope: 'output',
            path: 'releases/run-release/final.mp4',
            sha256: HASH_B,
          }],
          checks: [],
          outputCurrent,
        },
      },
    });
    const plan = makePlan({
      stageIds: ['preflight', 'release'],
      actions: ['run', 'run'],
      runMode: 'new',
      targetRunId: 'run-release',
    });

    await expect(runExecutionPlan(executionInput(plan), runtime.dependencies))
      .rejects.toThrow('output pointer failed');

    expect(runtime.report('run-release', 'release')).toBeUndefined();
    expect(runtime.outputCurrent).toEqual(previousOutput);
    expect(runtime.workCurrent).toMatchObject({completedStage: 'preflight'});
    expect(runtime.events.indexOf('report:release:passed'))
      .toBeLessThan(runtime.events.indexOf('output:release'));
    expect(runtime.events.indexOf('output:release'))
      .toBeLessThan(runtime.events.indexOf('delete-report:release'));
    expect(runtime.events.indexOf('delete-report:release'))
      .toBeLessThan(runtime.events.indexOf('sync-report-parent:release'));
    expect(runtime.events.indexOf('sync-report-parent:release'))
      .toBeLessThan(runtime.events.indexOf('release-lock'));
    expect(runtime.events).not.toContain('work:release:passed');
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('keeps the Release report when Output cleanup fails after pointer commit', async () => {
    const tempProject = await createTempProject();
    tempProjects.push(tempProject);
    const project = await loadProject(tempProject.workspaceRoot, 'demo');
    const runStore = createRunStore(tempProject.workspaceRoot);
    const normalOutputStore = createOutputStore(tempProject.workspaceRoot);
    const reportStore = createStageReportStore();
    await normalOutputStore.createRelease('demo', 'run-old');
    await normalOutputStore.publishCurrent('demo', currentPointer('run-old', 'release', {
      relativePath: 'releases/run-old',
    }));
    const cleanupFailure = new Error('Output cleanup sync failed after commit');
    let failCleanup = true;
    const outputStore = createOutputStore(tempProject.workspaceRoot, {
      fileOps: {
        syncDirectory: async (operation, phase) => {
          await operation();
          if (phase === 'cleanup' && failCleanup) {
            failCleanup = false;
            throw cleanupFailure;
          }
        },
      },
    });
    const events: string[] = [];
    const stageCalls: StageId[] = [];
    const registry = createStages(events, stageCalls).map((stage) => (
      stage.id !== 'release'
        ? stage
        : {
          ...stage,
          execute: async (context: StageExecutionContext, signal: AbortSignal) => {
            await stage.execute(context, signal);
            if (context.runId === undefined) throw new Error('missing Run');
            await outputStore.createRelease('demo', context.runId);
            return {
              state: 'passed' as const,
              fingerprint: stageFingerprint('release'),
              outputs: {release: context.runId},
              artifacts: [],
              checks: [],
              outputCurrent: currentPointer(context.runId, 'release', {
                relativePath: `releases/${context.runId}`,
              }),
            };
          },
        }
    ));
    const release = vi.fn(async () => undefined);
    const dependencies: RunnerDependencies = {
      registry,
      runStore,
      outputStore,
      reportStore,
      acquireProjectLock: vi.fn(async (_work, runId) => ({
        record: {
          pid: 1,
          hostname: 'test',
          processStart: 'test',
          createdAt: NOW,
          runId,
        },
        release,
      })) as unknown as RunnerDependencies['acquireProjectLock'],
      createRunId: vi.fn(() => 'run-release'),
      now: vi.fn(() => NOW),
    };
    const plan = makePlan({
      stageIds: ['preflight', 'release'],
      actions: ['run', 'run'],
      runMode: 'new',
      targetRunId: 'run-release',
    });

    const result = await runExecutionPlan(executionInput(plan, project), dependencies);

    expect(result).toMatchObject({
      runId: 'run-release',
      state: 'passed',
      completedStage: 'release',
    });
    const runDirectory = await runStore.openExistingRun('demo', 'run-release');
    await expect(reportStore.readStage(runDirectory, 'release')).resolves.toMatchObject({
      state: 'passed',
    });
    await expect(normalOutputStore.readCurrentReadonly('demo')).resolves.toMatchObject({
      runId: 'run-release',
      completedStage: 'release',
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps Output authoritative and returns WORK_POINTER_LAGGING after commit', async () => {
    const outputCurrent = currentPointer('run-release', 'release', {
      relativePath: 'releases/run-release',
    });
    const draftArtifact: PipelineArtifact = {
      scope: 'run',
      path: 'audio/filter-graph.txt',
      sha256: HASH_A,
    };
    const releaseArtifacts: PipelineArtifact[] = [{
      scope: 'output',
      path: 'releases/run-release/final.mp4',
      sha256: HASH_B,
    }];
    const runtime = createMemoryRuntime({
      failWorkPublishAt: 'release',
      results: {
        draft: {
          state: 'passed',
          fingerprint: stageFingerprint('draft'),
          outputs: {filterGraph: draftArtifact.path},
          artifacts: [draftArtifact],
          checks: [],
        },
        release: {
          state: 'passed',
          fingerprint: stageFingerprint('release'),
          outputs: {finalVideo: releaseArtifacts[0]!.path},
          artifacts: releaseArtifacts,
          checks: [],
          outputCurrent,
        },
      },
    });
    const plan = makePlan({
      stageIds: ['preflight', 'draft', 'release'],
      actions: ['run', 'run', 'run'],
      runMode: 'new',
      targetRunId: 'run-release',
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result).toMatchObject({
      runId: 'run-release',
      state: 'passed',
      completedStage: 'release',
      warnings: [{code: 'WORK_POINTER_LAGGING'}],
    });
    expect(runtime.outputCurrent).toEqual(outputCurrent);
    expect(runtime.workCurrent).toMatchObject({completedStage: 'draft'});
    expect(runtime.report('run-release', 'release')).toMatchObject({
      artifacts: releaseArtifacts,
    });
    expect(runtime.report('run-release', 'release')?.artifacts)
      .not.toContainEqual(draftArtifact);
    expect(runtime.events.indexOf('report:release:passed'))
      .toBeLessThan(runtime.events.indexOf('output:release'));
    expect(runtime.events.indexOf('output:release'))
      .toBeLessThan(runtime.events.indexOf('work:release:passed'));
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('releases the project lock when a Stage throws', async () => {
    const runtime = createMemoryRuntime({throwStage: 'compile'});
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'compile'],
      actions: ['run', 'run'],
      runMode: 'new',
      targetRunId: 'run-failure',
    });

    await expect(runExecutionPlan(executionInput(plan), runtime.dependencies))
      .rejects.toThrow('compile failed');

    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('preserves a primary Stage failure when lock release also fails', async () => {
    const releaseError = new Error('lock release failed');
    const runtime = createMemoryRuntime({
      throwStage: 'compile',
      releaseError,
    });
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'compile'],
      actions: ['run', 'run'],
      runMode: 'new',
      targetRunId: 'run-failure',
    });

    let caughtError: unknown;
    try {
      await runExecutionPlan(executionInput(plan), runtime.dependencies);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    const errors = (caughtError as AggregateError).errors;
    expect(errors[0]).toEqual(expect.objectContaining({message: 'compile failed'}));
    expect(errors[1]).toBe(releaseError);
    expect((caughtError as Error).cause).toBe(errors[0]);
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('returns committed Release success when lock release fails', async () => {
    const releaseError = new Error('lock release failed');
    const outputCurrent = currentPointer('run-release', 'release', {
      relativePath: 'releases/run-release',
    });
    const runtime = createMemoryRuntime({
      releaseError,
      results: {
        release: {
          state: 'passed',
          fingerprint: stageFingerprint('release'),
          outputs: {release: 'run-release'},
          artifacts: [],
          checks: [],
          outputCurrent,
        },
      },
    });
    const plan = makePlan({
      stageIds: ['preflight', 'release'],
      actions: ['run', 'run'],
      runMode: 'new',
      targetRunId: 'run-release',
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result).toMatchObject({
      runId: 'run-release',
      state: 'passed',
      completedStage: 'release',
      warnings: [{code: 'PROJECT_LOCK_RELEASE_FAILED'}],
    });
    expect(runtime.outputCurrent).toEqual(outputCurrent);
    expect(runtime.report('run-release', 'release')).toMatchObject({state: 'passed'});
    expect(runtime.release).toHaveBeenCalledOnce();
  });
});
