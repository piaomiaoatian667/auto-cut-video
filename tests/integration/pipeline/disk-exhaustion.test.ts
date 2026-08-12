import {lstat, readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {loadProject, type ProjectInputs} from '../../../src/domain/load-project';
import {
  ensureRunDirectory,
  openNewRunFileForWrite,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  hashRunArtifact,
  type PipelineArtifact,
} from '../../../src/pipeline/artifacts';
import type {ExecutionPlan} from '../../../src/pipeline/execution-plan';
import {acquireProjectLock} from '../../../src/pipeline/project-lock';
import {
  createOutputStore,
  createRunStore,
  type CurrentPointer,
  type FileOps,
  type OutputStore,
  type PipelinePreset,
  type RunStore,
  type StageId,
} from '../../../src/pipeline/run-store';
import {
  runExecutionPlan,
  type FailedStageCleanupInput,
  type RunnerDependencies,
} from '../../../src/pipeline/runner';
import type {
  PipelinePartialArtifact,
  PipelineStage,
  StageExecutionResult,
} from '../../../src/pipeline/stage';
import {createStageRegistry} from '../../../src/pipeline/stage-registry';
import {
  createStageReportStore,
  type StageReport,
  type StageReportStore,
} from '../../../src/pipeline/stage-report';
import {releaseCurrentPointer} from '../../../src/pipeline/stages/release';
import {fakePreflightResult} from '../../helpers/pipeline-fixtures';
import {createTempProject, type TempProject} from '../../helpers/temp-project';

const NOW = '2026-08-12T00:00:00.000Z';
const FULL_STAGE_IDS: StageId[] = [
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
  'review',
  'release',
];

type FailureCase =
  | 'canonical-report'
  | 'work-temp-write'
  | 'work-temp-sync'
  | 'cached-copy'
  | 'release-output-write'
  | 'output-temp-write'
  | 'output-temp-sync';

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map((project) => project.cleanup()));
});

const enospc = (message: string): NodeJS.ErrnoException => Object.assign(
  new Error(message),
  {code: 'ENOSPC'},
);

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

const pointerScratchFiles = async (root: string): Promise<string[]> => {
  try {
    return (await readdir(root)).filter((entry) => (
      entry === 'current.json.tmp' || entry === 'current.json.rollback'
    ));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

const previousPointers = async (workspaceRoot: string): Promise<{
  work: CurrentPointer;
  output: CurrentPointer;
}> => {
  const runStore = createRunStore(workspaceRoot);
  const outputStore = createOutputStore(workspaceRoot);
  await runStore.createRun('demo', 'run-previous');
  await outputStore.createRelease('demo', 'run-previous');
  const work: CurrentPointer = {
    runId: 'run-previous',
    relativePath: 'runs/run-previous',
    preset: 'release',
    stageIds: [...FULL_STAGE_IDS],
    completedStage: 'release',
    state: 'passed',
    publishedAt: NOW,
  };
  const output: CurrentPointer = {
    ...work,
    relativePath: 'releases/run-previous',
  };
  await runStore.publishCurrent('demo', work);
  await outputStore.publishCurrent('demo', output);
  return {work, output};
};

const planFor = (input: {
  runId: string;
  target: 'ingest' | 'release';
  cached?: boolean;
}): ExecutionPlan => {
  const preset: PipelinePreset = input.target === 'ingest' ? 'assets' : 'release';
  const stageIds: StageId[] = ['preflight', input.target];
  return {
    version: 1,
    projectId: 'demo',
    preset,
    stageIds,
    runMode: 'new',
    requiresProgressReconciliation: false,
    requiresRuntimePreflight: false,
    ...(input.cached ? {sourceRunId: 'run-source'} : {}),
    targetRunId: input.runId,
    items: [
      {
        position: 1,
        total: 2,
        stageId: 'preflight',
        displayName: 'preflight',
        action: 'run',
        fingerprint: null,
        materialize: false,
      },
      {
        position: 2,
        total: 2,
        stageId: input.target,
        displayName: input.target,
        action: input.cached ? 'cached' : 'run',
        fingerprint: `${input.target}-fingerprint`,
        ...(input.cached ? {sourceRunId: 'run-source'} : {}),
        materialize: input.cached === true,
      },
    ],
  };
};

const expectedWorkPointer = (
  runId: string,
  preset: PipelinePreset,
  stageIds: StageId[],
): CurrentPointer => ({
  runId,
  relativePath: `runs/${runId}`,
  preset,
  stageIds,
  completedStage: 'preflight',
  state: 'passed',
  publishedAt: NOW,
});

const preflight = fakePreflightResult();

const passedResult = (stageId: StageId): StageExecutionResult => ({
  state: 'passed',
  fingerprint: `${stageId}-fingerprint`,
  outputs: {stageId},
  artifacts: [],
  checks: [],
});

const passiveStage = (stageId: StageId): PipelineStage => ({
  id: stageId,
  displayName: stageId,
  prerequisites: [],
  fingerprint: async () => `${stageId}-fingerprint`,
  verify: async () => true,
  partialArtifacts: () => [],
  execute: async () => passedResult(stageId),
});

const createRegistry = (input: {
  outputStore: OutputStore;
  releaseWriteFails: boolean;
}): readonly PipelineStage[] => {
  const preflightStage: PipelineStage = {
    id: 'preflight',
    displayName: 'preflight',
    prerequisites: [],
    fingerprint: async () => null,
    verify: async () => true,
    partialArtifacts: () => [],
    execute: async () => ({
      state: 'passed',
      fingerprint: 'preflight-fingerprint',
      outputs: preflight,
      artifacts: [],
      checks: preflight.checks,
    }),
  };
  const ingestPartials: PipelinePartialArtifact[] = [{
    scope: 'run',
    path: 'partials/ingest.tmp',
  }];
  const ingestStage: PipelineStage = {
    id: 'ingest',
    displayName: 'ingest',
    prerequisites: ['preflight'],
    fingerprint: async () => 'ingest-fingerprint',
    verify: async () => true,
    partialArtifacts: () => ingestPartials,
    execute: async () => passedResult('ingest'),
  };
  const releaseStage: PipelineStage = {
    id: 'release',
    displayName: 'release',
    prerequisites: [],
    fingerprint: async () => 'release-fingerprint',
    verify: async () => true,
    partialArtifacts: (context) => context.runId === undefined
      ? [{scope: 'run', path: 'release/intermediate.tmp'}]
      : [
        {scope: 'run', path: 'release/intermediate.tmp'},
        {scope: 'output', path: `releases/${context.runId}/final.mp4`},
      ],
    execute: async (context) => {
      if (context.runId === undefined) throw new TypeError('missing Release runId');
      await input.outputStore.createRelease('demo', context.runId);
      if (input.releaseWriteFails) throw enospc('Release output write failed');
      return {
        ...passedResult('release'),
        outputCurrent: releaseCurrentPointer(context.runId, NOW),
      };
    },
  };
  return createStageRegistry([
    preflightStage,
    ingestStage,
    passiveStage('narration'),
    passiveStage('compile'),
    passiveStage('draft'),
    passiveStage('review'),
    releaseStage,
  ]);
};

const pointerFileOps = (
  phase: 'write' | 'sync',
  targetStage: StageId,
): Partial<FileOps> => {
  let fail = true;
  let failNextSync = false;
  return {
    writeFile: async (handle, data) => {
      const pointer = JSON.parse(data) as CurrentPointer;
      if (pointer.completedStage === targetStage && fail) {
        if (phase === 'write') {
          fail = false;
          throw enospc(`${targetStage} pointer temp write failed`);
        }
        failNextSync = true;
      }
      await handle.writeFile(data);
    },
    syncFile: async (handle) => {
      if (failNextSync && fail) {
        fail = false;
        failNextSync = false;
        throw enospc(`${targetStage} pointer temp sync failed`);
      }
      await handle.sync();
    },
  };
};

const writeSourceArtifact = async (
  runDirectory: RunDirectoryScope,
): Promise<PipelineArtifact> => {
  await ensureRunDirectory(runDirectory, 'cache');
  const target = await openNewRunFileForWrite(runDirectory, 'cache/source.bin');
  try {
    await target.handle.writeFile('cached bytes');
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
  return await hashRunArtifact(runDirectory, 'cache/source.bin');
};

const sourceReport = (input: {
  stageId: 'preflight' | 'ingest';
  artifacts?: PipelineArtifact[];
}): StageReport => ({
  version: 1,
  projectId: 'demo',
  runId: 'run-source',
  preset: 'assets',
  stageId: input.stageId,
  position: input.stageId === 'preflight' ? 1 : 2,
  total: 2,
  state: 'passed',
  fingerprint: `${input.stageId}-fingerprint`,
  startedAt: NOW,
  finishedAt: NOW,
  artifacts: input.artifacts ?? [],
  outputs: input.stageId === 'preflight'
    ? JSON.parse(JSON.stringify(preflight)) as Exclude<StageReport['outputs'], undefined>
    : {},
  checks: [],
});

const seedCachedSource = async (
  runStore: RunStore,
  reportStore: StageReportStore,
): Promise<void> => {
  const sourceRun = await runStore.createRun('demo', 'run-source');
  const artifact = await writeSourceArtifact(sourceRun);
  await reportStore.writeStage(sourceRun, sourceReport({stageId: 'preflight'}));
  await reportStore.writeStage(sourceRun, sourceReport({
    stageId: 'ingest',
    artifacts: [artifact],
  }));
};

interface FailureFixture {
  workspaceRoot: string;
  project: ProjectInputs;
  plan: ExecutionPlan;
  runStore: RunStore;
  outputStore: OutputStore;
  reportStore: StageReportStore;
  previousOutput: CurrentPointer;
  cleanupFailedStage: ReturnType<typeof vi.fn<(input: FailedStageCleanupInput) => Promise<void>>>;
  dependencies: RunnerDependencies;
}

const createFailureFixture = async (failure: FailureCase): Promise<FailureFixture> => {
  const projectFixture = await createTempProject();
  tempProjects.push(projectFixture);
  const project = await loadProject(projectFixture.workspaceRoot, 'demo');
  const previous = await previousPointers(projectFixture.workspaceRoot);
  const runId = `run-${failure}`;
  const target = failure === 'release-output-write'
    || failure === 'output-temp-write'
    || failure === 'output-temp-sync'
    ? 'release'
    : 'ingest';
  const cached = failure === 'cached-copy';

  const runStore = failure === 'work-temp-write'
    ? createRunStore(projectFixture.workspaceRoot, {
      fileOps: pointerFileOps('write', 'ingest'),
    })
    : failure === 'work-temp-sync'
      ? createRunStore(projectFixture.workspaceRoot, {
        fileOps: pointerFileOps('sync', 'ingest'),
      })
      : createRunStore(projectFixture.workspaceRoot);
  const outputStore = failure === 'output-temp-write'
    ? createOutputStore(projectFixture.workspaceRoot, {
      fileOps: pointerFileOps('write', 'release'),
    })
    : failure === 'output-temp-sync'
      ? createOutputStore(projectFixture.workspaceRoot, {
        fileOps: pointerFileOps('sync', 'release'),
      })
      : createOutputStore(projectFixture.workspaceRoot);

  const baseReportStore = createStageReportStore();
  const reportStore: StageReportStore = failure === 'canonical-report'
    ? {
      ...baseReportStore,
      writeStage: async (run, report) => {
        if (report.stageId === 'ingest') {
          throw enospc('canonical report write failed');
        }
        await baseReportStore.writeStage(run, report);
      },
    }
    : baseReportStore;
  if (cached) await seedCachedSource(runStore, baseReportStore);

  const cleanupFailedStage = vi.fn(async (_input: FailedStageCleanupInput) => undefined);
  const plan = planFor({runId, target, cached});
  const dependencies: RunnerDependencies = {
    registry: createRegistry({
      outputStore,
      releaseWriteFails: failure === 'release-output-write',
    }),
    runStore,
    outputStore,
    reportStore,
    acquireProjectLock,
    cleanupFailedStage,
    ...(cached ? {
      copyRunArtifact: async () => {
        throw enospc('cached artifact copy failed');
      },
    } : {}),
    createRunId: () => runId,
    now: () => NOW,
  };
  return {
    workspaceRoot: projectFixture.workspaceRoot,
    project,
    plan,
    runStore,
    outputStore,
    reportStore,
    previousOutput: previous.output,
    cleanupFailedStage,
    dependencies,
  };
};

const runFixture = async (fixture: FailureFixture) => await runExecutionPlan({
  plan: fixture.plan,
  project: fixture.project,
  sourceCatalog: {
    assets: [],
    totalBytes: 0,
    fingerprint: `sha256:${'a'.repeat(64)}`,
  },
  signal: new AbortController().signal,
}, fixture.dependencies);

const readAttempts = async (
  workspaceRoot: string,
  runId: string,
): Promise<Array<{stageId: StageId; state: string; error?: {code: string}}>> => {
  const attemptsRoot = path.join(
    workspaceRoot,
    '.work',
    'demo',
    'runs',
    runId,
    'reports',
    'attempts',
  );
  const names = await readdir(attemptsRoot);
  return await Promise.all(names.map(async (name) => JSON.parse(
    await readFile(path.join(attemptsRoot, name), 'utf8'),
  ) as {stageId: StageId; state: string; error?: {code: string}}));
};

describe('Pipeline runtime disk exhaustion', () => {
  it.each([
    ['canonical-report', 'ingest'],
    ['work-temp-write', 'ingest'],
    ['work-temp-sync', 'ingest'],
    ['cached-copy', 'ingest'],
    ['release-output-write', 'release'],
    ['output-temp-write', 'release'],
    ['output-temp-sync', 'release'],
  ] as const)(
    'recovers safely from ENOSPC at %s',
    async (failure, stageId) => {
      const fixture = await createFailureFixture(failure);
      await expect(runFixture(fixture)).rejects.toMatchObject({
        code: 'DISK_SPACE_EXHAUSTED',
        stageId,
      });

      await expect(fixture.runStore.readCurrentReadonly('demo')).resolves.toEqual(
        expectedWorkPointer(
          fixture.plan.targetRunId!,
          fixture.plan.preset,
          fixture.plan.stageIds,
        ),
      );
      await expect(fixture.outputStore.readCurrentReadonly('demo'))
        .resolves.toEqual(fixture.previousOutput);
      await expect(pointerScratchFiles(path.join(
        fixture.workspaceRoot,
        '.work',
        'demo',
      ))).resolves.toEqual([]);
      await expect(pointerScratchFiles(path.join(
        fixture.workspaceRoot,
        'output',
        'demo',
      ))).resolves.toEqual([]);
      expect(await exists(path.join(
        fixture.workspaceRoot,
        '.work',
        'demo',
        'pipeline.lock',
      ))).toBe(false);

      expect(fixture.cleanupFailedStage).toHaveBeenCalledOnce();
      expect(fixture.cleanupFailedStage).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'demo',
        runId: fixture.plan.targetRunId,
        stageId,
        partialArtifacts: stageId === 'ingest'
          ? [{scope: 'run', path: 'partials/ingest.tmp'}]
          : [
            {scope: 'run', path: 'release/intermediate.tmp'},
            {
              scope: 'output',
              path: `releases/${fixture.plan.targetRunId}/final.mp4`,
            },
          ],
      }));

      await expect(readAttempts(
        fixture.workspaceRoot,
        fixture.plan.targetRunId!,
      )).resolves.toEqual([
        expect.objectContaining({
          stageId,
          state: 'failed',
          error: expect.objectContaining({code: 'DISK_SPACE_EXHAUSTED'}),
        }),
      ]);
    },
  );

  it('retains the original ENOSPC when attempt and cleanup recovery also fail', async () => {
    const fixture = await createFailureFixture('release-output-write');
    const primary = enospc('primary Release output failure');
    const attemptFailure = enospc('attempt write failure');
    const cleanupFailure = enospc('cleanup failure');
    const baseReportStore = fixture.reportStore;
    fixture.dependencies.registry = createRegistry({
      outputStore: fixture.outputStore,
      releaseWriteFails: false,
    }).map((stage) => stage.id === 'release'
      ? {...stage, execute: async () => { throw primary; }}
      : stage);
    fixture.dependencies.reportStore = {
      ...baseReportStore,
      writeAttempt: async () => { throw attemptFailure; },
    };
    fixture.dependencies.cleanupFailedStage = async () => { throw cleanupFailure; };

    let caught: unknown;
    try {
      await runFixture(fixture);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBe(primary);
    expect(caught).toMatchObject({
      code: 'DISK_SPACE_EXHAUSTED',
      stageId: 'release',
    });
    expect((caught as Error).cause).toMatchObject({
      errors: [attemptFailure, cleanupFailure],
    });
    expect(await exists(path.join(
      fixture.workspaceRoot,
      '.work',
      'demo',
      'pipeline.lock',
    ))).toBe(false);
  });

  it('returns Release success with WORK_POINTER_LAGGING after Output commit', async () => {
    const projectFixture = await createTempProject();
    tempProjects.push(projectFixture);
    const project = await loadProject(projectFixture.workspaceRoot, 'demo');
    const previous = await previousPointers(projectFixture.workspaceRoot);
    const runId = 'run-post-commit';
    const runStore = createRunStore(projectFixture.workspaceRoot, {
      fileOps: pointerFileOps('write', 'release'),
    });
    const outputStore = createOutputStore(projectFixture.workspaceRoot);
    const cleanupFailedStage = vi.fn(async (_input: FailedStageCleanupInput) => undefined);
    const plan = planFor({runId, target: 'release'});
    const result = await runExecutionPlan({
      plan,
      project,
      sourceCatalog: {
        assets: [],
        totalBytes: 0,
        fingerprint: `sha256:${'a'.repeat(64)}`,
      },
      signal: new AbortController().signal,
    }, {
      registry: createRegistry({outputStore, releaseWriteFails: false}),
      runStore,
      outputStore,
      reportStore: createStageReportStore(),
      acquireProjectLock,
      cleanupFailedStage,
      createRunId: () => runId,
      now: () => NOW,
    });

    expect(result).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'release',
      warnings: [{code: 'WORK_POINTER_LAGGING'}],
    });
    await expect(runStore.readCurrentReadonly('demo')).resolves.toEqual(
      expectedWorkPointer(runId, plan.preset, plan.stageIds),
    );
    await expect(outputStore.readCurrentReadonly('demo')).resolves.toEqual(
      releaseCurrentPointer(runId, NOW),
    );
    expect(await outputStore.readCurrentReadonly('demo')).not.toEqual(previous.output);
    await expect(pointerScratchFiles(path.join(
      projectFixture.workspaceRoot,
      '.work',
      'demo',
    ))).resolves.toEqual([]);
    await expect(pointerScratchFiles(path.join(
      projectFixture.workspaceRoot,
      'output',
      'demo',
    ))).resolves.toEqual([]);
    expect(await exists(path.join(
      projectFixture.workspaceRoot,
      '.work',
      'demo',
      'pipeline.lock',
    ))).toBe(false);
    expect(cleanupFailedStage).not.toHaveBeenCalled();
  });
});
