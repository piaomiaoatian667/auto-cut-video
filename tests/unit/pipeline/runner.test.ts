import path from 'node:path';
import {readFile, unlink, writeFile} from 'node:fs/promises';
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
  buildExecutionPlan,
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
  requiresProgressReconciliation = false,
  requiresRuntimePreflight = false,
}: {
  preset?: PipelinePreset;
  stageIds: readonly StageId[];
  actions: readonly StageAction[];
  runMode: ExecutionPlan['runMode'];
  sourceRunId?: string;
  targetRunId?: string;
  requiresProgressReconciliation?: boolean;
  requiresRuntimePreflight?: boolean;
}): ExecutionPlan => ({
  version: 1,
  projectId: 'demo',
  preset,
  stageIds: [...stageIds],
  runMode,
  requiresProgressReconciliation,
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
  failOutputReadAfterPublish?: Error;
  failOutputPublish?: boolean;
  failWorkReadAfterPublish?: Error;
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
  let workPublishRejected = false;
  let outputPublishRejected = false;

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
    readCurrentReadonly: vi.fn(async () => {
      if (workPublishRejected && options.failWorkReadAfterPublish !== undefined) {
        throw options.failWorkReadAfterPublish;
      }
      return workCurrent;
    }),
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
        workPublishRejected = true;
        throw new Error('work pointer failed');
      }
      workCurrent = pointer;
    }),
  } as unknown as RunStore;

  const outputStore = {
    readCurrent: vi.fn(async () => outputCurrent),
    readCurrentReadonly: vi.fn(async () => {
      if (outputPublishRejected && options.failOutputReadAfterPublish !== undefined) {
        throw options.failOutputReadAfterPublish;
      }
      return outputCurrent;
    }),
    publishCurrent: vi.fn(async (_projectId: string, pointer: CurrentPointer) => {
      events.push(`output:${pointer.completedStage}`);
      if (options.failOutputPublish === true) {
        outputPublishRejected = true;
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
  const acquireProjectLock = vi.fn<RunnerDependencies['acquireProjectLock']>(async () => {
    events.push('acquire-lock');
    return lease;
  });
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
    lease,
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

const planningContext = (
  runtime: ReturnType<typeof createMemoryRuntime>,
  project = memoryProject(),
): ExecutionPlanContext => ({
  project,
  sourceCatalog,
  registry: runtime.registry,
  runStore: runtime.dependencies.runStore,
  outputStore: runtime.dependencies.outputStore,
  reportStore: runtime.dependencies.reportStore,
  createRunId: runtime.dependencies.createRunId,
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

interface UnknownReportOutcomeProbe {
  armed: boolean;
  targetReport: string;
  parentSyncErrors: Error[];
  postLinkStatError?: Error;
  postLinkFaultInjected?: boolean;
  postLinkCloseErrors?: Error[];
  commitParentHandleId?: number;
  parentSyncHandleIds: number[];
  linkedSource?: string;
  linkedTarget?: string;
  events: string[];
}

const importPipelineModulesWithUnknownReportOutcomeProbe = async (
  probe: UnknownReportOutcomeProbe,
) => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    let nextDirectoryHandleId = 0;
    return {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await Reflect.apply(actual.open, undefined, args);
        if (!probe.armed) return handle;
        const openedPath = String(args[0]);
        const status = await handle.stat({bigint: true});
        if (status.isFile()) {
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'stat') {
                return async (...statArgs: Parameters<typeof target.stat>) => {
                  if (
                    probe.postLinkStatError !== undefined
                    && probe.postLinkFaultInjected !== true
                    && probe.linkedSource === openedPath
                  ) {
                    probe.postLinkFaultInjected = true;
                    throw probe.postLinkStatError;
                  }
                  return await Reflect.apply(target.stat, target, statArgs);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        }
        if (!status.isDirectory() || path.basename(openedPath) !== 'reports') {
          return handle;
        }
        const directoryHandleId = nextDirectoryHandleId;
        nextDirectoryHandleId += 1;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                probe.events.push('sync-parent:reports');
                if (
                  probe.linkedTarget !== undefined
                  && path.basename(probe.linkedTarget) === probe.targetReport
                ) {
                  probe.commitParentHandleId ??= directoryHandleId;
                  if (probe.commitParentHandleId === directoryHandleId) {
                    probe.parentSyncHandleIds.push(directoryHandleId);
                    const parentSyncError = probe.parentSyncErrors.shift();
                    if (parentSyncError !== undefined) throw parentSyncError;
                  }
                }
                await target.sync();
              };
            }
            if (property === 'close') {
              return async () => {
                probe.events.push('close-parent:reports');
                await target.close();
                if (probe.postLinkFaultInjected === true) {
                  const closeError = probe.postLinkCloseErrors?.shift();
                  if (closeError !== undefined) throw closeError;
                }
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
      link: async (...args: Parameters<typeof actual.link>) => {
        await Reflect.apply(actual.link, undefined, args);
        const sourcePath = String(args[0]);
        const targetPath = String(args[1]);
        if (probe.armed && path.basename(targetPath) === probe.targetReport) {
          probe.linkedSource = sourcePath;
          probe.linkedTarget = targetPath;
          probe.events.push(`link:${probe.targetReport}`);
        }
      },
      unlink: async (...args: Parameters<typeof actual.unlink>) => {
        const targetPath = String(args[0]);
        if (probe.armed && probe.linkedTarget === targetPath) {
          probe.events.push(`unlink-final:${probe.targetReport}`);
        }
        if (probe.armed && probe.linkedSource === targetPath) {
          probe.events.push(`unlink-temp:${probe.targetReport}`);
        }
        await Reflect.apply(actual.unlink, undefined, args);
      },
    };
  });
  const scopes = await import('../../../src/fs/app-directory-scopes');
  const artifacts = await import('../../../src/pipeline/artifacts');
  const reports = await import('../../../src/pipeline/stage-report');
  const executionPlan = await import('../../../src/pipeline/execution-plan');
  const runner = await import('../../../src/pipeline/runner');
  return {artifacts, executionPlan, reports, runner, scopes};
};

type FaultInjectedPipelineModules = Awaited<
  ReturnType<typeof importPipelineModulesWithUnknownReportOutcomeProbe>
>;

const writeFaultInjectedRunArtifact = async (
  modules: FaultInjectedPipelineModules,
  run: RunDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<PipelineArtifact> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await modules.scopes.ensureRunDirectory(run, parent);
  const target = await modules.scopes.openNewRunFileForWrite(run, relativePath);
  try {
    await target.handle.writeFile(contents);
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
  return await modules.artifacts.hashRunArtifact(run, relativePath);
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

  it('rejects an incompatible same-Run Stage snapshot published while waiting for the lock', async () => {
    const sourceRunId = 'run-resume';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest', {
        preset: 'draft',
        stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
      }),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'ingest'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'draft',
      to: 'narration',
      resume: true,
    });
    runtime.acquireProjectLock.mockImplementationOnce(async () => {
      runtime.events.push('acquire-lock');
      runtime.seedRun(
        sourceRunId,
        reportsThrough(sourceRunId, 'draft', 'compile'),
      );
      await runtime.runStore.publishCurrent(
        'demo',
        currentPointer(sourceRunId, 'compile', {
          preset: 'draft',
          stageIds: ['compile'],
        }),
      );
      return runtime.lease;
    });

    await expect(runExecutionPlan(executionInput(plan, project), runtime.dependencies))
      .rejects.toMatchObject({code: 'PLAN_STALE'});

    expect(runtime.stageCalls).toEqual([]);
    expect(runtime.runStore.createRun).not.toHaveBeenCalled();
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
    expect(runtime.runStore.publishCurrent).toHaveBeenCalledOnce();
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('accepts a compatible same-Run sliced Stage snapshot published while waiting for the lock', async () => {
    const sourceRunId = 'run-resume';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest', {
        preset: 'draft',
        stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
      }),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'ingest'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'draft',
      from: 'narration',
      to: 'compile',
      resume: true,
    });
    runtime.acquireProjectLock.mockImplementationOnce(async () => {
      runtime.events.push('acquire-lock');
      runtime.seedRun(
        sourceRunId,
        reportsThrough(sourceRunId, 'draft', 'narration'),
      );
      await runtime.runStore.publishCurrent(
        'demo',
        currentPointer(sourceRunId, 'narration', {
          preset: 'draft',
          stageIds: ['narration', 'compile'],
        }),
      );
      return runtime.lease;
    });

    const result = await runExecutionPlan(executionInput(plan, project), runtime.dependencies);

    expect(result).toMatchObject({
      runId: sourceRunId,
      state: 'passed',
      completedStage: 'compile',
    });
    expect(runtime.stageCalls).toEqual(['preflight', 'compile']);
    expect(runtime.workCurrent).toMatchObject({
      runId: sourceRunId,
      preset: 'draft',
      stageIds: ['narration', 'compile'],
      completedStage: 'compile',
    });
    expect(runtime.release).toHaveBeenCalledOnce();
  });

  it('reconciles valid contiguous reports completed while waiting for the lock', async () => {
    const sourceRunId = 'run-resume';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest'),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'ingest'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'draft',
      to: 'compile',
      resume: true,
    });
    expect(plan.items.slice(-2)).toMatchObject([
      {stageId: 'narration', action: 'resume'},
      {stageId: 'compile', action: 'run'},
    ]);
    runtime.acquireProjectLock.mockImplementationOnce(async () => {
      runtime.events.push('acquire-lock');
      runtime.seedRun(
        sourceRunId,
        reportsThrough(sourceRunId, 'draft', 'compile'),
      );
      await runtime.runStore.publishCurrent(
        'demo',
        currentPointer(sourceRunId, 'compile', {
          preset: 'draft',
          stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
        }),
      );
      return runtime.lease;
    });

    const result = await runExecutionPlan(executionInput(plan, project), runtime.dependencies);

    expect(result).toMatchObject({
      runId: sourceRunId,
      state: 'passed',
      completedStage: 'compile',
    });
    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
    expect(runtime.report(sourceRunId, 'compile')).toMatchObject({state: 'passed'});
  });

  it('repairs Work for a contiguous report written while waiting for the lock', async () => {
    const sourceRunId = 'run-resume';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest'),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'ingest'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'draft',
      to: 'narration',
      resume: true,
    });
    runtime.acquireProjectLock.mockImplementationOnce(async () => {
      runtime.events.push('acquire-lock');
      runtime.seedRun(
        sourceRunId,
        reportsThrough(sourceRunId, 'draft', 'narration'),
      );
      return runtime.lease;
    });

    const result = await runExecutionPlan(executionInput(plan, project), runtime.dependencies);

    expect(result).toMatchObject({
      runId: sourceRunId,
      state: 'passed',
      completedStage: 'narration',
    });
    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.workCurrent).toMatchObject({
      runId: sourceRunId,
      completedStage: 'narration',
    });
    expect(runtime.events).toContain('work:narration:passed');
  });

  it('rejects an invalid report completed while waiting for the lock', async () => {
    const sourceRunId = 'run-resume';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest'),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'ingest'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'draft',
      to: 'narration',
      resume: true,
    });
    runtime.acquireProjectLock.mockImplementationOnce(async () => {
      runtime.events.push('acquire-lock');
      runtime.seedRun(sourceRunId, [
        ...reportsThrough(sourceRunId, 'draft', 'ingest'),
        makeReport({
          runId: sourceRunId,
          preset: 'draft',
          stageId: 'narration',
          fingerprint: 'stale-narration',
        }),
      ]);
      await runtime.runStore.publishCurrent(
        'demo',
        currentPointer(sourceRunId, 'narration', {
          preset: 'draft',
          stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
        }),
      );
      return runtime.lease;
    });

    await expect(runExecutionPlan(executionInput(plan, project), runtime.dependencies))
      .rejects.toMatchObject({code: 'PLAN_STALE', stageId: 'narration'});

    expect(runtime.stageCalls).toEqual([]);
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
  });

  it('rejects a noncontiguous report completed while waiting for the lock', async () => {
    const sourceRunId = 'run-resume';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(sourceRunId, 'ingest'),
    });
    runtime.seedRun(sourceRunId, reportsThrough(sourceRunId, 'draft', 'ingest'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'draft',
      to: 'compile',
      resume: true,
    });
    expect(plan.items.slice(-2)).toMatchObject([
      {stageId: 'narration', action: 'resume'},
      {stageId: 'compile', action: 'run'},
    ]);
    runtime.acquireProjectLock.mockImplementationOnce(async () => {
      runtime.events.push('acquire-lock');
      runtime.seedRun(sourceRunId, [
        ...reportsThrough(sourceRunId, 'draft', 'ingest'),
        makeReport({
          runId: sourceRunId,
          preset: 'draft',
          stageId: 'compile',
        }),
      ]);
      return runtime.lease;
    });

    await expect(runExecutionPlan(executionInput(plan, project), runtime.dependencies))
      .rejects.toMatchObject({code: 'PLAN_STALE', stageId: 'compile'});

    expect(runtime.stageCalls).toEqual([]);
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
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

  it('publishes recovered contiguous same-Run reports before executing downstream', async () => {
    const runId = 'run-resume';
    const runtime = createMemoryRuntime({
      current: currentPointer(runId, 'ingest', {
        preset: 'draft',
        stageIds: ['preflight', 'ingest', 'narration', 'compile'],
      }),
    });
    runtime.seedRun(runId, reportsThrough(runId, 'draft', 'narration'));
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'ingest', 'narration', 'compile'],
      actions: ['run', 'cached', 'cached', 'resume'],
      runMode: 'resume',
      sourceRunId: runId,
      targetRunId: runId,
    });

    const result = await runExecutionPlan(executionInput(plan), runtime.dependencies);

    expect(result).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'compile',
    });
    expect(runtime.stageCalls).toEqual(['preflight', 'compile']);
    expect(runtime.events).toContain('work:narration:passed');
    expect(runtime.events.indexOf('work:narration:passed'))
      .toBeLessThan(runtime.events.indexOf('execute:compile'));
    expect(runtime.reportStore.writeStage).toHaveBeenCalledOnce();
  });

  it('executes sliced ordinary reconciliation without recreating the recovered report', async () => {
    const runId = 'run-resume';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(runId, 'ingest', {
        preset: 'draft',
        stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
      }),
    });
    runtime.seedRun(runId, reportsThrough(runId, 'draft', 'narration'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'draft',
      from: 'narration',
      to: 'narration',
      resume: true,
    });

    expect(plan).toMatchObject({
      runMode: 'resume',
      requiresProgressReconciliation: true,
    });
    const result = await runExecutionPlan(executionInput(plan, project), runtime.dependencies);

    expect(result).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'narration',
    });
    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.reportStore.writeStage).not.toHaveBeenCalled();
    expect(runtime.workCurrent).toMatchObject({
      runId,
      completedStage: 'narration',
    });
    expect(runtime.acquireProjectLock).toHaveBeenCalledOnce();
  });

  it('recovers a durable Release report by publishing Output without re-executing', async () => {
    const runId = 'run-release';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(runId, 'review'),
    });
    runtime.seedRun(runId, reportsThrough(runId, 'release', 'release'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'release',
      from: 'release',
      to: 'release',
      resume: true,
    });

    expect(plan).toMatchObject({
      runMode: 'resume',
      requiresProgressReconciliation: true,
    });

    const result = await runExecutionPlan(executionInput(plan, project), runtime.dependencies);

    expect(result).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'release',
      warnings: [],
    });
    expect(runtime.stageCalls).toEqual(['preflight']);
    expect(runtime.outputCurrent).toEqual(currentPointer(runId, 'release', {
      relativePath: `releases/${runId}`,
    }));
    expect(runtime.workCurrent).toMatchObject({
      runId,
      completedStage: 'release',
      state: 'passed',
    });
    expect(runtime.events.filter((event) => event === 'verify:release').length)
      .toBeGreaterThan(1);
    expect(runtime.acquireProjectLock).toHaveBeenCalledOnce();
  });

  it('returns recovered Release success when Work read-back is unreadable', async () => {
    const runId = 'run-release';
    const project = memoryProject();
    const runtime = createMemoryRuntime({
      current: currentPointer(runId, 'review'),
      failWorkPublishAt: 'release',
      failWorkReadAfterPublish: new Error('recovered Work pointer unreadable'),
    });
    runtime.seedRun(runId, reportsThrough(runId, 'release', 'release'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'release',
      from: 'release',
      to: 'release',
      resume: true,
    });

    const result = await runExecutionPlan(executionInput(plan, project), runtime.dependencies);

    expect(result).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'release',
      warnings: [{code: 'WORK_POINTER_LAGGING'}],
    });
    expect(runtime.outputCurrent).toMatchObject({
      runId,
      completedStage: 'release',
    });
    expect(runtime.report(runId, 'release')).toMatchObject({state: 'passed'});
    expect(runtime.stageCalls).toEqual(['preflight']);
  });

  it('reconciles lagging Work when Output Release is already committed', async () => {
    const runId = 'run-release';
    const project = memoryProject();
    const outputCurrent = currentPointer(runId, 'release', {
      relativePath: `releases/${runId}`,
    });
    const runtime = createMemoryRuntime({
      current: currentPointer(runId, 'review'),
      outputCurrent,
    });
    runtime.seedRun(runId, reportsThrough(runId, 'release', 'release'));
    const plan = await buildExecutionPlan(planningContext(runtime, project), {
      preset: 'release',
      from: 'release',
      to: 'release',
      resume: true,
    });

    expect(plan).toMatchObject({
      runMode: 'resume',
      requiresProgressReconciliation: true,
    });

    const result = await runExecutionPlan(executionInput(plan, project), runtime.dependencies);

    expect(result).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'release',
      warnings: [],
    });
    expect(runtime.outputCurrent).toEqual(outputCurrent);
    expect(runtime.outputStore.publishCurrent).not.toHaveBeenCalled();
    expect(runtime.workCurrent).toMatchObject({
      runId,
      completedStage: 'release',
    });
    expect(runtime.stageCalls).toEqual(['preflight']);
  });

  it.each([
    ['parent-sync', false],
    ['post-link-stat', true],
  ] as const)(
    'preserves ordinary artifacts after a %s report outcome and reconciles on restart',
    async (_mode, failAfterLink) => {
      const tempProject = await createTempProject();
      tempProjects.push(tempProject);
      const project = await loadProject(tempProject.workspaceRoot, 'demo');
      const primaryError = Object.assign(new Error(
        failAfterLink
          ? 'compile report post-link stat failed'
          : 'compile report parent sync failed',
      ), {
        code: 'EIO',
      });
      const retrySyncError = Object.assign(new Error('compile report parent retry failed'), {
        code: 'EIO',
      });
      const closeError = Object.assign(new Error('compile report anchor close failed'), {
        code: 'EIO',
      });
      const probe: UnknownReportOutcomeProbe = {
        armed: false,
        targetReport: 'compile.json',
        parentSyncErrors: failAfterLink ? [] : [primaryError, retrySyncError],
        ...(failAfterLink ? {
          postLinkStatError: primaryError,
          postLinkCloseErrors: [closeError],
        } : {}),
        parentSyncHandleIds: [],
        events: [],
      };
      const modules = await importPipelineModulesWithUnknownReportOutcomeProbe(probe);
      try {
        const runStore = modules.scopes.createRunStore(tempProject.workspaceRoot);
        const outputStore = modules.scopes.createOutputStore(tempProject.workspaceRoot);
        const reportStore = modules.reports.createStageReportStore();
        const runId = 'run-resume';
        const runDirectory = await runStore.createRun('demo', runId);
        for (const stageId of ['preflight', 'ingest', 'narration'] as const) {
          await reportStore.writeStage(runDirectory, makeReport({
            runId,
            preset: 'draft',
            stageId,
          }));
        }
        await runStore.publishCurrent('demo', currentPointer(runId, 'narration', {
          preset: 'draft',
          stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
        }));
        const events: string[] = [];
        const stageCalls: StageId[] = [];
        const artifactPath = 'compiled/unknown-report.json';
        const registry = createStages(events, stageCalls).map((stage) => (
          stage.id !== 'compile'
            ? stage
            : {
              ...stage,
              verify: async (context: StagePlanningContext, report: StageReport) => {
                if (
                  context.sourceRun === undefined
                  || report.fingerprint !== stageFingerprint('compile')
                ) {
                  return false;
                }
                for (const artifact of report.artifacts) {
                  if (
                    artifact.scope !== 'run'
                    || !await modules.artifacts.verifyRunArtifact(
                      context.sourceRun.runDirectory,
                      artifact,
                    )
                  ) {
                    return false;
                  }
                }
                return true;
              },
              execute: async (context: StageExecutionContext, signal: AbortSignal) => {
                const executed = await stage.execute(context, signal);
                if (context.runDirectory === undefined) throw new Error('missing Run');
                const artifact = await writeFaultInjectedRunArtifact(
                  modules,
                  context.runDirectory,
                  artifactPath,
                  'compiled unknown bytes',
                );
                return {...executed, artifacts: [artifact]};
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
          stageIds: ['preflight', 'ingest', 'narration', 'compile'],
          actions: ['run', 'cached', 'cached', 'resume'],
          runMode: 'resume',
          sourceRunId: runId,
          targetRunId: runId,
        });
        probe.armed = true;

        let runError: unknown;
        try {
          await modules.runner.runExecutionPlan(
            executionInput(plan, project),
            dependencies,
          );
        } catch (error) {
          runError = error;
        }

        expect(runError).toMatchObject({
          name: 'StageReportOutcomeError',
          code: 'PIPELINE_REPORT_OUTCOME_UNKNOWN',
        });
        if (failAfterLink) {
          const linkError = (runError as AggregateError).cause;
          expect(linkError).toMatchObject({
            name: 'AppDirectoryLinkOutcomeError',
            code: 'APP_DIRECTORY_LINK_OUTCOME_UNKNOWN',
            cause: primaryError,
          });
          expect((linkError as AggregateError).errors).toEqual([
            primaryError,
            closeError,
          ]);
        } else {
          expect(runError).toMatchObject({
            cause: primaryError,
            errors: [primaryError, retrySyncError],
          });
        }

        await expect(reportStore.readStage(runDirectory, 'compile')).resolves.toMatchObject({
          state: 'passed',
          artifacts: [expect.objectContaining({path: artifactPath})],
        });
        await expect(readFile(path.join(
          tempProject.workspaceRoot,
          '.work/demo/runs/run-resume',
          artifactPath,
        ), 'utf8')).resolves.toBe('compiled unknown bytes');
        await expect(runStore.readCurrentReadonly('demo')).resolves.toMatchObject({
          completedStage: 'narration',
        });
        if (!failAfterLink) {
          expect(probe.parentSyncHandleIds).toEqual([
            probe.commitParentHandleId,
            probe.commitParentHandleId,
          ]);
        }
        expect(probe.events).not.toContain('unlink-final:compile.json');

        probe.armed = false;
        const restartPlan = await modules.executionPlan.buildExecutionPlan({
          project,
          sourceCatalog,
          registry,
          runStore,
          outputStore,
          reportStore,
          createRunId: dependencies.createRunId,
        }, {
          preset: 'draft',
          to: 'compile',
          resume: true,
        });
        expect(restartPlan).toMatchObject({
          runMode: 'resume',
          requiresProgressReconciliation: true,
        });
        expect(restartPlan.items.at(-1)).toMatchObject({
          stageId: 'compile',
          action: 'cached',
        });

        const restarted = await modules.runner.runExecutionPlan(
          executionInput(restartPlan, project),
          dependencies,
        );

        expect(restarted).toMatchObject({
          runId,
          state: 'passed',
          completedStage: 'compile',
        });
        expect(stageCalls.filter((stageId) => stageId === 'compile')).toHaveLength(1);
        await expect(runStore.readCurrentReadonly('demo')).resolves.toMatchObject({
          runId,
          completedStage: 'compile',
        });
        expect(release).toHaveBeenCalledTimes(2);
      } finally {
        vi.doUnmock('node:fs/promises');
        vi.resetModules();
      }
    },
  );

  it('preserves cached artifacts after an unknown canonical report outcome and reconciles on restart', async () => {
    const tempProject = await createTempProject();
    tempProjects.push(tempProject);
    const project = await loadProject(tempProject.workspaceRoot, 'demo');
    const parentSyncError = Object.assign(new Error('cached report parent sync failed'), {
      code: 'EIO',
    });
    const retrySyncError = Object.assign(new Error('cached report parent retry failed'), {
      code: 'EIO',
    });
    const probe: UnknownReportOutcomeProbe = {
      armed: false,
      targetReport: 'ingest.json',
      parentSyncErrors: [parentSyncError, retrySyncError],
      parentSyncHandleIds: [],
      events: [],
    };
    const modules = await importPipelineModulesWithUnknownReportOutcomeProbe(probe);
    try {
      const runStore = modules.scopes.createRunStore(tempProject.workspaceRoot);
      const outputStore = modules.scopes.createOutputStore(tempProject.workspaceRoot);
      const reportStore = modules.reports.createStageReportStore();
      const sourceRunId = 'run-old';
      const targetRunId = 'run-new';
      const sourceRun = await runStore.createRun('demo', sourceRunId);
      const artifactPath = 'assets/cached-unknown.json';
      const sourceArtifact = await writeFaultInjectedRunArtifact(
        modules,
        sourceRun,
        artifactPath,
        'cached unknown bytes',
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
        artifacts: [sourceArtifact],
      }));
      await runStore.publishCurrent('demo', currentPointer(sourceRunId, 'ingest', {
        preset: 'assets',
        stageIds: ['preflight', 'ingest'],
      }));
      const events: string[] = [];
      const stageCalls: StageId[] = [];
      const registry = createStages(events, stageCalls).map((stage) => (
        stage.id !== 'ingest'
          ? stage
          : {
            ...stage,
            verify: async (context: StagePlanningContext, report: StageReport) => {
              if (
                context.sourceRun === undefined
                || report.fingerprint !== stageFingerprint('ingest')
              ) {
                return false;
              }
              for (const artifact of report.artifacts) {
                if (
                  artifact.scope !== 'run'
                  || !await modules.artifacts.verifyRunArtifact(
                    context.sourceRun.runDirectory,
                    artifact,
                  )
                ) {
                  return false;
                }
              }
              return true;
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
            runId: targetRunId,
          },
          release,
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
      probe.armed = true;

      await expect(modules.runner.runExecutionPlan(
        executionInput(plan, project),
        dependencies,
      )).rejects.toMatchObject({
        name: 'StageReportOutcomeError',
        code: 'PIPELINE_REPORT_OUTCOME_UNKNOWN',
        cause: parentSyncError,
        errors: [parentSyncError, retrySyncError],
      });

      const targetRun = await runStore.openExistingRun('demo', targetRunId);
      await expect(reportStore.readStage(targetRun, 'ingest')).resolves.toMatchObject({
        state: 'cached',
        artifacts: [expect.objectContaining({path: artifactPath})],
      });
      await expect(readFile(path.join(
        tempProject.workspaceRoot,
        '.work/demo/runs/run-new',
        artifactPath,
      ), 'utf8')).resolves.toBe('cached unknown bytes');
      await expect(runStore.readCurrentReadonly('demo')).resolves.toMatchObject({
        runId: targetRunId,
        completedStage: 'preflight',
      });
      expect(probe.parentSyncHandleIds).toEqual([
        probe.commitParentHandleId,
        probe.commitParentHandleId,
      ]);
      expect(probe.events).not.toContain('unlink-final:ingest.json');

      probe.armed = false;
      const restartPlan = await modules.executionPlan.buildExecutionPlan({
        project,
        sourceCatalog,
        registry,
        runStore,
        outputStore,
        reportStore,
        createRunId: dependencies.createRunId,
      }, {
        preset: 'assets',
        resume: true,
      });
      expect(restartPlan).toMatchObject({
        runMode: 'resume',
        requiresProgressReconciliation: true,
        sourceRunId: targetRunId,
      });
      expect(restartPlan.items.at(-1)).toMatchObject({
        stageId: 'ingest',
        action: 'cached',
      });

      const restarted = await modules.runner.runExecutionPlan(
        executionInput(restartPlan, project),
        dependencies,
      );

      expect(restarted).toMatchObject({
        runId: targetRunId,
        state: 'passed',
        completedStage: 'ingest',
      });
      expect(stageCalls).toEqual(['preflight', 'preflight']);
      await expect(runStore.readCurrentReadonly('demo')).resolves.toMatchObject({
        runId: targetRunId,
        completedStage: 'ingest',
      });
      expect(release).toHaveBeenCalledTimes(2);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
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

  it('preserves stage state when Work publication outcome cannot be read', async () => {
    const readFailure = new Error('work pointer outcome unreadable');
    const runtime = createMemoryRuntime({
      failWorkPublishAt: 'compile',
      failWorkReadAfterPublish: readFailure,
    });
    const plan = makePlan({
      preset: 'draft',
      stageIds: ['preflight', 'compile'],
      actions: ['run', 'run'],
      runMode: 'new',
      targetRunId: 'run-unknown',
    });

    let caughtError: unknown;
    try {
      await runExecutionPlan(executionInput(plan), runtime.dependencies);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toMatchObject({
      code: 'PIPELINE_POINTER_OUTCOME_UNKNOWN',
      cause: expect.objectContaining({message: 'work pointer failed'}),
    });
    expect(caughtError).toBeInstanceOf(AggregateError);
    expect((caughtError as AggregateError).errors).toEqual([
      expect.objectContaining({message: 'work pointer failed'}),
      readFailure,
    ]);
    expect(runtime.report('run-unknown', 'compile')).toMatchObject({state: 'passed'});
    expect(runtime.events).not.toContain('delete-report:compile');
  });

  it('keeps report and artifacts when real Work publication rejects after commit', async () => {
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
    const workRoot = path.join(tempProject.workspaceRoot, '.work/demo');
    const publicationFailure = new Error('injected ambiguous Work publication');
    const failingRunStore = createRunStore(tempProject.workspaceRoot, {
      fileOps: {
        rename: async (operation) => {
          await operation();
          await unlink(path.join(workRoot, 'current.json.rollback'));
          throw publicationFailure;
        },
      },
    });
    let underlyingError: unknown;
    const runStore = {
      createWork: failingRunStore.createWork.bind(failingRunStore),
      createRun: failingRunStore.createRun.bind(failingRunStore),
      openExistingRun: failingRunStore.openExistingRun.bind(failingRunStore),
      readCurrentReadonly: failingRunStore.readCurrentReadonly.bind(failingRunStore),
      publishCurrent: async (projectId: string, pointer: CurrentPointer) => {
        try {
          await failingRunStore.publishCurrent(projectId, pointer);
        } catch (error) {
          underlyingError = error;
          throw error;
        }
      },
    } as RunStore;
    const events: string[] = [];
    const stageCalls: StageId[] = [];
    const artifactPath = 'compiled/ambiguous.json';
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
              'ambiguous compiled bytes',
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

    const result = await runExecutionPlan(executionInput(plan, project), dependencies);

    expect(underlyingError).toMatchObject({code: 'RUN_POINTER_ROLLBACK_FAILED'});
    expect(result).toMatchObject({
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
    ), 'utf8')).resolves.toBe('ambiguous compiled bytes');
    await expect(normalRunStore.readCurrentReadonly('demo')).resolves.toMatchObject({
      runId,
      completedStage: 'compile',
    });
    expect(release).toHaveBeenCalledOnce();
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

  it('preserves the Release report when Output publication outcome cannot be read', async () => {
    const readFailure = new Error('output pointer outcome unreadable');
    const outputCurrent = currentPointer('run-release', 'release', {
      relativePath: 'releases/run-release',
    });
    const runtime = createMemoryRuntime({
      failOutputPublish: true,
      failOutputReadAfterPublish: readFailure,
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

    let caughtError: unknown;
    try {
      await runExecutionPlan(executionInput(plan), runtime.dependencies);
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toMatchObject({
      code: 'PIPELINE_POINTER_OUTCOME_UNKNOWN',
      cause: expect.objectContaining({message: 'output pointer failed'}),
    });
    expect(caughtError).toBeInstanceOf(AggregateError);
    expect((caughtError as AggregateError).errors).toEqual([
      expect.objectContaining({message: 'output pointer failed'}),
      readFailure,
    ]);
    expect(runtime.report('run-release', 'release')).toMatchObject({state: 'passed'});
    expect(runtime.events).not.toContain('delete-report:release');
  });

  it('keeps Release published when real Output publication rejects after commit', async () => {
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
    const outputRoot = path.join(tempProject.workspaceRoot, 'output/demo');
    const publicationFailure = new Error('injected ambiguous Output publication');
    const failingOutputStore = createOutputStore(tempProject.workspaceRoot, {
      fileOps: {
        rename: async (operation) => {
          await operation();
          await unlink(path.join(outputRoot, 'current.json.rollback'));
          throw publicationFailure;
        },
      },
    });
    let underlyingError: unknown;
    const outputStore = {
      createRelease: failingOutputStore.createRelease.bind(failingOutputStore),
      readCurrentReadonly: failingOutputStore.readCurrentReadonly.bind(failingOutputStore),
      publishCurrent: async (projectId: string, pointer: CurrentPointer) => {
        try {
          await failingOutputStore.publishCurrent(projectId, pointer);
        } catch (error) {
          underlyingError = error;
          throw error;
        }
      },
    } as OutputStore;
    const events: string[] = [];
    const stageCalls: StageId[] = [];
    const releaseArtifactPath = path.join(outputRoot, 'releases/run-release/final.mp4');
    const registry = createStages(events, stageCalls).map((stage) => (
      stage.id !== 'release'
        ? stage
        : {
          ...stage,
          execute: async (context: StageExecutionContext, signal: AbortSignal) => {
            await stage.execute(context, signal);
            if (context.runId === undefined) throw new Error('missing Run');
            await outputStore.createRelease('demo', context.runId);
            await writeFile(releaseArtifactPath, 'published release bytes');
            return {
              state: 'passed' as const,
              fingerprint: stageFingerprint('release'),
              outputs: {release: context.runId},
              artifacts: [{
                scope: 'output' as const,
                path: `releases/${context.runId}/final.mp4`,
                sha256: HASH_B,
              }],
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

    expect(underlyingError).toMatchObject({code: 'RUN_POINTER_ROLLBACK_FAILED'});
    expect(result).toMatchObject({
      runId: 'run-release',
      state: 'passed',
      completedStage: 'release',
    });
    const runDirectory = await runStore.openExistingRun('demo', 'run-release');
    await expect(reportStore.readStage(runDirectory, 'release')).resolves.toMatchObject({
      state: 'passed',
      artifacts: [expect.objectContaining({path: 'releases/run-release/final.mp4'})],
    });
    await expect(readFile(releaseArtifactPath, 'utf8'))
      .resolves.toBe('published release bytes');
    await expect(normalOutputStore.readCurrentReadonly('demo')).resolves.toMatchObject({
      runId: 'run-release',
      completedStage: 'release',
    });
    expect(release).toHaveBeenCalledOnce();
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

  it('returns Release success when Work outcome is unreadable after Output commit', async () => {
    const readFailure = new Error('committed Release Work pointer unreadable');
    const outputCurrent = currentPointer('run-release', 'release', {
      relativePath: 'releases/run-release',
    });
    const runtime = createMemoryRuntime({
      failWorkPublishAt: 'release',
      failWorkReadAfterPublish: readFailure,
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
      warnings: [{code: 'WORK_POINTER_LAGGING'}],
    });
    expect(runtime.outputCurrent).toEqual(outputCurrent);
    expect(runtime.report('run-release', 'release')).toMatchObject({state: 'passed'});
    expect(runtime.events).not.toContain('delete-report:release');
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
