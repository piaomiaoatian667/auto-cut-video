import {constants} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ProjectInputs} from '../../../src/domain/load-project';
import {
  ensureRunDirectory,
  openNewOutputFile,
  openNewRunFile,
} from '../../../src/fs/app-directory-scopes';
import {
  createOutputStore,
  createRunStore,
  type CurrentPointer,
} from '../../../src/pipeline/run-store';
import {
  buildCleanupPlan,
  cleanupFailedStage,
} from '../../../src/pipeline/cleanup';
import type {ExecutionPlan} from '../../../src/pipeline/execution-plan';
import type {ProjectLockLease} from '../../../src/pipeline/project-lock';
import {runExecutionPlan} from '../../../src/pipeline/runner';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import type {PipelineStage} from '../../../src/pipeline/stage';
import {createStageReportStore} from '../../../src/pipeline/stage-report';
import {fakePreflightResult} from '../../helpers/pipeline-fixtures';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
} from '../../helpers/temp-project';

const tempDirectories: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'pipeline-cleanup-unit-'));
  tempDirectories.push(workspaceRoot);
  return workspaceRoot;
};

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const writeAndClose = async (
  handle: FileHandle,
  contents: string,
): Promise<void> => {
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const pointer = (
  runId: string,
  completedStage: CurrentPointer['completedStage'],
): CurrentPointer => ({
  runId,
  relativePath: completedStage === 'release'
    ? `releases/${runId}`
    : `runs/${runId}`,
  preset: completedStage === 'release' ? 'release' : 'draft',
  stageIds: completedStage === 'release'
    ? ['preflight', 'release']
    : ['preflight', completedStage],
  completedStage,
  state: 'passed',
  publishedAt: '2026-08-12T00:00:00.000Z',
});

describe('pipeline cleanup planning', () => {
  it('protects both current pointers and inventories only stable directories', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    await runStore.createRun('demo', 'run-old');
    await runStore.createRun('demo', 'run-current');
    await runStore.createRun('demo', 'run-failed');
    await runStore.publishCurrent('demo', pointer('run-current', 'draft'));
    const runsRoot = path.join(workspaceRoot, '.work', 'demo', 'runs');
    await mkdir(path.join(runsRoot, 'not_stable'));
    await writeFile(path.join(runsRoot, 'run-file'), 'not a directory');

    const outputStore = createOutputStore(workspaceRoot);
    await outputStore.createRelease('demo', 'release-current');
    await outputStore.createRelease('demo', 'release-unpublished');
    await outputStore.publishCurrent('demo', pointer('release-current', 'release'));
    const releasesRoot = path.join(workspaceRoot, 'output', 'demo', 'releases');
    await mkdir(path.join(releasesRoot, 'not_stable'));
    await writeFile(path.join(releasesRoot, 'release-file'), 'not a directory');

    await expect(buildCleanupPlan({workspaceRoot, projectId: 'demo'})).resolves.toEqual({
      projectId: 'demo',
      protectedRunId: 'run-current',
      protectedReleaseId: 'release-current',
      runDirectories: ['run-failed', 'run-old'],
      releaseDirectories: ['release-unpublished'],
    });
  });
});

describe('failed-stage cleanup', () => {
  it('removes only declared partials while preserving current, source, and siblings', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'run-source');
    const targetRun = await runStore.createRun('demo', 'run-target');
    await ensureRunDirectory(sourceRun, 'draft');
    await ensureRunDirectory(targetRun, 'draft');
    await writeAndClose(
      await openNewRunFile(sourceRun, 'draft/partial.mp4'),
      'source partial',
    );
    await writeAndClose(
      await openNewRunFile(targetRun, 'draft/partial.mp4'),
      'target partial',
    );
    await writeAndClose(
      await openNewRunFile(targetRun, 'draft/sibling.mp4'),
      'target sibling',
    );
    await runStore.publishCurrent('demo', pointer('run-source', 'draft'));

    const outputStore = createOutputStore(workspaceRoot);
    const output = await outputStore.createRelease('demo', 'run-target');
    await outputStore.createRelease('demo', 'run-current');
    await writeAndClose(
      await openNewOutputFile(output, 'releases/run-target/partial.json'),
      'target output partial',
    );
    await writeAndClose(
      await openNewOutputFile(output, 'releases/run-target/sibling.json'),
      'target output sibling',
    );
    await writeAndClose(
      await openNewOutputFile(output, 'releases/run-current/current.json'),
      'current output',
    );
    await outputStore.publishCurrent('demo', pointer('run-current', 'release'));

    await cleanupFailedStage({
      projectId: 'demo',
      runId: 'run-target',
      stageId: 'draft',
      runDirectory: targetRun,
      outputDirectory: output,
      partialArtifacts: [
        {scope: 'run', path: 'draft/partial.mp4'},
        {scope: 'output', path: 'releases/run-target/partial.json'},
      ],
    });

    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-target',
      'draft',
      'partial.mp4',
    ))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'run-target',
      'partial.json',
    ))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-target',
      'draft',
      'sibling.mp4',
    ), 'utf8')).resolves.toBe('target sibling');
    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-source',
      'draft',
      'partial.mp4',
    ), 'utf8')).resolves.toBe('source partial');
    await expect(readFile(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'run-target',
      'sibling.json',
    ), 'utf8')).resolves.toBe('target output sibling');
    await expect(readFile(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'run-current',
      'current.json',
    ), 'utf8')).resolves.toBe('current output');
  });
});

describe('artifact copy rollback', () => {
  it('closes the target before unlinking only the exact copied path', async () => {
    const workspaceRoot = await makeWorkspace();
    const relativePath = 'cache/copied.bin';
    const events: string[] = [];
    let armed = false;
    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await Reflect.apply(actual.open, undefined, args);
          const openedPath = String(args[0]);
          const flags = Number(args[1]);
          if (
            !armed
            || (flags & constants.O_CREAT) === 0
            || path.basename(openedPath) !== path.basename(relativePath)
          ) return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'close') {
                return async () => {
                  events.push('close-target');
                  await target.close();
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
        unlink: async (...args: Parameters<typeof actual.unlink>) => {
          if (armed) {
            const targetPath = String(args[0]);
            events.push(path.basename(targetPath) === path.basename(relativePath)
              ? 'unlink-target'
              : 'unlink-other');
          }
          await Reflect.apply(actual.unlink, undefined, args);
        },
      };
    });
    const scopes = await import('../../../src/fs/app-directory-scopes');
    const artifacts = await import('../../../src/pipeline/artifacts');
    const runStore = scopes.createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'source-run');
    const targetRun = await runStore.createRun('demo', 'target-run');
    await scopes.ensureRunDirectory(sourceRun, 'cache');
    await scopes.ensureRunDirectory(targetRun, 'cache');
    await writeAndClose(
      await scopes.openNewRunFile(sourceRun, relativePath),
      'source bytes',
    );
    await writeAndClose(
      await scopes.openNewRunFile(targetRun, 'cache/sibling.bin'),
      'sibling bytes',
    );
    const artifact = await artifacts.hashRunArtifact(sourceRun, relativePath);
    armed = true;

    await expect(artifacts.copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: {...artifact, sha256: 'sha256:wrong'},
    })).rejects.toMatchObject({code: 'ARTIFACT_HASH_MISMATCH'});

    expect(events.indexOf('close-target')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('close-target')).toBeLessThan(events.indexOf('unlink-target'));
    expect(events).not.toContain('unlink-other');
    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'target-run',
      relativePath,
    ))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'target-run',
      'cache',
      'sibling.bin',
    ), 'utf8')).resolves.toBe('sibling bytes');
  });
});

describe('Runner failed-stage cleanup', () => {
  it('uses the shared cleanup implementation when no override is injected', async () => {
    const workspaceRoot = await makeWorkspace();
    const runId = 'run-default-cleanup';
    const runStore = createRunStore(workspaceRoot);
    const outputStore = createOutputStore(workspaceRoot);
    const preflight = fakePreflightResult();
    const stages: readonly PipelineStage[] = [
      {
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
      },
      {
        id: 'ingest',
        displayName: 'ingest',
        prerequisites: [],
        fingerprint: async () => 'ingest-fingerprint',
        verify: async () => true,
        partialArtifacts: () => [{scope: 'run', path: 'partial.bin'}],
        execute: async (context) => {
          if (context.runDirectory === undefined) throw new Error('missing Run');
          await writeAndClose(
            await openNewRunFile(context.runDirectory, 'partial.bin'),
            'partial',
          );
          await writeAndClose(
            await openNewRunFile(context.runDirectory, 'sibling.bin'),
            'sibling',
          );
          throw new Error('ingest failed');
        },
      },
    ];
    const plan: ExecutionPlan = {
      version: 1,
      projectId: 'demo',
      preset: 'assets',
      stageIds: ['preflight', 'ingest'],
      runMode: 'new',
      requiresProgressReconciliation: false,
      requiresRuntimePreflight: false,
      targetRunId: runId,
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
          stageId: 'ingest',
          displayName: 'ingest',
          action: 'run',
          fingerprint: 'ingest-fingerprint',
          materialize: false,
        },
      ],
    };
    const project: ProjectInputs = {
      workspaceRoot,
      projectDirectory: {} as ProjectInputs['projectDirectory'],
      project: createProjectFixture(),
      script: createScriptFixture(),
      edit: createEditFixture(),
    };
    const sourceCatalog: ProjectSourceCatalog = {
      assets: [],
      totalBytes: 0,
      fingerprint: `sha256:${'a'.repeat(64)}`,
    };
    const lease: ProjectLockLease = {
      record: {
        pid: process.pid,
        hostname: 'test',
        processStart: 'test',
        createdAt: '2026-08-12T00:00:00.000Z',
        runId,
      },
      release: async () => undefined,
    };

    let caughtError: unknown;
    try {
      await runExecutionPlan({
        plan,
        project,
        sourceCatalog,
        signal: new AbortController().signal,
      }, {
        registry: stages,
        runStore,
        outputStore,
        reportStore: createStageReportStore(),
        acquireProjectLock: async () => lease,
        createRunId: () => runId,
        now: () => '2026-08-12T00:00:00.000Z',
      });
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toMatchObject({
      code: 'PIPELINE_STAGE_FAILED',
      stageId: 'ingest',
    });

    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      runId,
      'partial.bin',
    ))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      runId,
      'sibling.bin',
    ), 'utf8')).resolves.toBe('sibling');
  });
});
