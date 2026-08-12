import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {
  lstat,
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createOutputStore,
  createRunStore,
  type CurrentPointer,
  type StageId,
} from '../../../src/pipeline/run-store';
import {
  installPipelineSignalHandlers,
  signalExitCode,
} from '../../../src/pipeline/signals';
import {createTempProject, type TempProject} from '../../helpers/temp-project';

const STAGE_IDS: StageId[] = [
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
  'review',
  'release',
];

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map((project) => project.cleanup()));
});

const previousPointers = async (workspaceRoot: string): Promise<{
  work: CurrentPointer;
  output: CurrentPointer;
}> => {
  const runStore = createRunStore(workspaceRoot);
  const outputStore = createOutputStore(workspaceRoot);
  await runStore.createRun('demo', 'run-previous');
  await outputStore.createRelease('demo', 'run-previous');
  const publishedAt = '2026-08-12T00:00:00.000Z';
  const work: CurrentPointer = {
    runId: 'run-previous',
    relativePath: 'runs/run-previous',
    preset: 'release',
    stageIds: [...STAGE_IDS],
    completedStage: 'release',
    state: 'passed',
    publishedAt,
  };
  const output: CurrentPointer = {
    ...work,
    relativePath: 'releases/run-previous',
  };
  await runStore.publishCurrent('demo', work);
  await outputStore.publishCurrent('demo', output);
  return {work, output};
};

const waitFor = async (
  condition: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!await condition()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition');
    await delay(25);
  }
};

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

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
};

describe('Pipeline signals', () => {
  it('registers one handler per signal, remembers the first, and disposes both', () => {
    const emitter = new EventEmitter();
    const once = vi.spyOn(emitter, 'once');
    const off = vi.spyOn(emitter, 'off');
    const handle = installPipelineSignalHandlers(
      emitter as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
    );

    expect(once).toHaveBeenCalledTimes(2);
    expect(once).toHaveBeenNthCalledWith(1, 'SIGINT', expect.any(Function));
    expect(once).toHaveBeenNthCalledWith(2, 'SIGTERM', expect.any(Function));

    emitter.emit('SIGTERM', 'SIGTERM');
    emitter.emit('SIGINT', 'SIGINT');

    expect(handle.signal.aborted).toBe(true);
    expect(handle.received).toBe('SIGTERM');
    expect(signalExitCode(handle.received)).toBe(143);
    expect(signalExitCode('SIGINT')).toBe(130);
    expect(signalExitCode(undefined)).toBe(130);

    handle.dispose();
    handle.dispose();
    expect(off).toHaveBeenCalledTimes(2);
    expect(off).toHaveBeenNthCalledWith(1, 'SIGINT', expect.any(Function));
    expect(off).toHaveBeenNthCalledWith(2, 'SIGTERM', expect.any(Function));
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'terminates the active child and preserves durable state on %s',
    async (signal, expectedExitCode) => {
      const project = await createTempProject();
      tempProjects.push(project);
      const previous = await previousPointers(project.workspaceRoot);
      const readyPath = path.join(project.workspaceRoot, 'signal-child.pid');
      const cleanupPath = path.join(project.workspaceRoot, 'signal-cleanup.json');
      const fixturePath = path.resolve('tests/fixtures/signal-runner.ts');
      const tsxPath = path.resolve('node_modules/.bin/tsx');
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const fixture = spawn(tsxPath, [
        fixturePath,
        project.workspaceRoot,
        readyPath,
        cleanupPath,
      ], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      fixture.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      fixture.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      const exit = new Promise<{code: number | null; signal: NodeJS.Signals | null}>(
        (resolve, reject) => {
          fixture.once('error', reject);
          fixture.once('exit', (code, exitSignal) => resolve({code, signal: exitSignal}));
        },
      );

      await waitFor(async () => await exists(readyPath));
      const childPid = Number(await readFile(readyPath, 'utf8'));
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(processAlive(childPid)).toBe(true);
      expect(await exists(path.join(
        project.workspaceRoot,
        '.work',
        'demo',
        'pipeline.lock',
      ))).toBe(true);
      const workBeforeSignal = await createRunStore(project.workspaceRoot)
        .readCurrentReadonly('demo');
      expect(workBeforeSignal).toMatchObject({
        runId: 'run-signal',
        completedStage: 'preflight',
        state: 'passed',
      });

      fixture.kill(signal);
      const result = await exit;
      expect(
        result,
        `stdout:\n${Buffer.concat(stdout).toString('utf8')}\nstderr:\n${Buffer.concat(stderr).toString('utf8')}`,
      ).toEqual({code: expectedExitCode, signal: null});

      await waitFor(async () => !processAlive(childPid));
      await expect(createRunStore(project.workspaceRoot).readCurrentReadonly('demo'))
        .resolves.toEqual(workBeforeSignal);
      await expect(createOutputStore(project.workspaceRoot).readCurrentReadonly('demo'))
        .resolves.toEqual(previous.output);
      expect(await exists(path.join(
        project.workspaceRoot,
        '.work',
        'demo',
        'pipeline.lock',
      ))).toBe(false);

      const cleanup = JSON.parse(await readFile(cleanupPath, 'utf8')) as unknown;
      expect(cleanup).toEqual({
        projectId: 'demo',
        runId: 'run-signal',
        stageId: 'ingest',
        hasRunDirectory: true,
        hasOutputDirectory: false,
        partialArtifacts: [{scope: 'run', path: 'partials/ingest.tmp'}],
      });
      expect(await exists(path.join(
        project.workspaceRoot,
        '.work',
        'demo',
        'runs',
        'run-signal',
        'partials',
        'ingest.tmp',
      ))).toBe(false);

      const attemptDirectory = path.join(
        project.workspaceRoot,
        '.work',
        'demo',
        'runs',
        'run-signal',
        'reports',
        'attempts',
      );
      const attempts = await readdir(attemptDirectory);
      expect(attempts).toHaveLength(1);
      const attempt = JSON.parse(await readFile(
        path.join(attemptDirectory, attempts[0]!),
        'utf8',
      )) as {state: string; error?: {code: string}};
      expect(attempt).toMatchObject({
        stageId: 'ingest',
        state: 'cancelled',
        error: {code: 'PIPELINE_CANCELLED'},
      });
    },
    20_000,
  );
});
