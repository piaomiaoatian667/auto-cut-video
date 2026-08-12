import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  buildCleanupPlan,
  executeCleanupPlan,
} from '../../../src/pipeline/cleanup';
import {
  createOutputStore,
  createRunStore,
  removeOutputTree,
  removeWorkTree,
  type CurrentPointer,
} from '../../../src/pipeline/run-store';

const tempDirectories: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'pipeline-cleanup-integration-'));
  tempDirectories.push(workspaceRoot);
  return workspaceRoot;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const workPointer = (runId: string): CurrentPointer => ({
  runId,
  relativePath: `runs/${runId}`,
  preset: 'draft',
  stageIds: ['preflight', 'draft'],
  completedStage: 'draft',
  state: 'passed',
  publishedAt: '2026-08-12T00:00:00.000Z',
});

const outputPointer = (runId: string): CurrentPointer => ({
  runId,
  relativePath: `releases/${runId}`,
  preset: 'release',
  stageIds: ['preflight', 'release'],
  completedStage: 'release',
  state: 'passed',
  publishedAt: '2026-08-12T00:00:00.000Z',
});

describe('pipeline cleanup integration', () => {
  it('removes unreferenced Runs and Releases once while preserving current pointers', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    await runStore.createRun('demo', 'run-current');
    await runStore.createRun('demo', 'run-old');
    await writeFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-current',
      'current.txt',
    ), 'current run');
    await writeFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-old',
      'old.txt',
    ), 'old run');
    await runStore.publishCurrent('demo', workPointer('run-current'));

    const outputStore = createOutputStore(workspaceRoot);
    await outputStore.createRelease('demo', 'release-current');
    await outputStore.createRelease('demo', 'release-old');
    await writeFile(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'release-current',
      'current.txt',
    ), 'current release');
    await writeFile(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'release-old',
      'old.txt',
    ), 'old release');
    await outputStore.publishCurrent('demo', outputPointer('release-current'));

    const plan = await buildCleanupPlan({workspaceRoot, projectId: 'demo'});
    await expect(executeCleanupPlan(plan)).resolves.toEqual({
      removedRuns: ['run-old'],
      removedReleases: ['release-old'],
    });
    await expect(executeCleanupPlan(plan)).resolves.toEqual({
      removedRuns: [],
      removedReleases: [],
    });

    await expect(readFile(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-current',
      'current.txt',
    ), 'utf8')).resolves.toBe('current run');
    await expect(readFile(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'release-current',
      'current.txt',
    ), 'utf8')).resolves.toBe('current release');
    await expect(lstat(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-old',
    ))).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'release-old',
    ))).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('re-reads both pointers and skips candidates that became current', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    await runStore.createRun('demo', 'run-first');
    await runStore.createRun('demo', 'run-next');
    await runStore.publishCurrent('demo', workPointer('run-first'));
    const outputStore = createOutputStore(workspaceRoot);
    await outputStore.createRelease('demo', 'release-first');
    await outputStore.createRelease('demo', 'release-next');
    await outputStore.publishCurrent('demo', outputPointer('release-first'));
    const plan = await buildCleanupPlan({workspaceRoot, projectId: 'demo'});

    await runStore.publishCurrent('demo', workPointer('run-next'));
    await outputStore.publishCurrent('demo', outputPointer('release-next'));

    await expect(executeCleanupPlan(plan)).resolves.toEqual({
      removedRuns: [],
      removedReleases: [],
    });
    await expect(lstat(path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-next',
    ))).resolves.toMatchObject({mode: expect.any(Number)});
    await expect(lstat(path.join(
      workspaceRoot,
      'output',
      'demo',
      'releases',
      'release-next',
    ))).resolves.toMatchObject({mode: expect.any(Number)});
  });

  it('fails closed when an inventoried candidate is replaced by a symlink', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await makeWorkspace();
    const outsideSentinel = path.join(outsideRoot, 'sentinel.txt');
    await writeFile(outsideSentinel, 'outside');
    const runStore = createRunStore(workspaceRoot);
    await runStore.createRun('demo', 'run-current');
    await runStore.createRun('demo', 'run-old');
    await runStore.publishCurrent('demo', workPointer('run-current'));
    const plan = await buildCleanupPlan({workspaceRoot, projectId: 'demo'});
    const candidatePath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-old',
    );
    await rm(candidatePath, {recursive: true});
    await symlink(outsideRoot, candidatePath);

    await expect(executeCleanupPlan(plan)).rejects.toMatchObject({
      code: 'APP_PATH_OUTSIDE_SCOPE',
    });
    await expect(readFile(outsideSentinel, 'utf8')).resolves.toBe('outside');
  });

  it('fails closed when an inventoried candidate is replaced by a new directory', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    await runStore.createRun('demo', 'run-current');
    await runStore.createRun('demo', 'run-old');
    await runStore.publishCurrent('demo', workPointer('run-current'));
    const plan = await buildCleanupPlan({workspaceRoot, projectId: 'demo'});
    const candidatePath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-old',
    );
    await rm(candidatePath, {recursive: true});
    await mkdir(candidatePath);
    const replacementSentinel = path.join(candidatePath, 'replacement.txt');
    await writeFile(replacementSentinel, 'replacement');

    await expect(executeCleanupPlan(plan)).rejects.toMatchObject({
      code: 'APP_SCOPE_AUTHORITY_CHANGED',
    });
    await expect(readFile(replacementSentinel, 'utf8')).resolves.toBe('replacement');
  });

  it('fails closed when a candidate is replaced immediately before scoped removal', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    const outputStore = createOutputStore(workspaceRoot);
    await runStore.createRun('demo', 'run-current');
    await runStore.createRun('demo', 'run-old');
    await runStore.publishCurrent('demo', workPointer('run-current'));
    const plan = await buildCleanupPlan({workspaceRoot, projectId: 'demo'});
    const candidatePath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-old',
    );
    const replacementSentinel = path.join(candidatePath, 'replacement.txt');
    let replaced = false;

    await expect(executeCleanupPlan(plan, {
      runStore,
      outputStore,
      removeWorkTree: async (scope, relativePath) => {
        if (!replaced) {
          replaced = true;
          await rm(candidatePath, {recursive: true});
          await mkdir(candidatePath);
          await writeFile(replacementSentinel, 'replacement');
        }
        await removeWorkTree(scope, relativePath);
      },
      removeOutputTree,
    })).rejects.toMatchObject({
      code: 'APP_SCOPE_AUTHORITY_CHANGED',
    });

    expect(replaced).toBe(true);
    await expect(readFile(replacementSentinel, 'utf8')).resolves.toBe('replacement');
  });
});
