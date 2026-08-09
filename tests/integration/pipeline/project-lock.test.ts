import {
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  createWorkDirectoryScope,
  openExistingProjectLockFile,
  openNewProjectLockFile,
  unlinkProjectLockFile,
  type WorkDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  ProjectLockError,
  acquireProjectLock,
  clearStaleLock,
  type ProjectLockRecord,
  type ProjectLockRuntime,
} from '../../../src/pipeline/project-lock';

const tempDirectories: string[] = [];

const makeWorkScope = async (): Promise<{
  workspaceRoot: string;
  work: WorkDirectoryScope;
}> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'project-lock-'));
  tempDirectories.push(workspaceRoot);
  return {
    workspaceRoot,
    work: await createWorkDirectoryScope(workspaceRoot, 'demo'),
  };
};

afterEach(async () => {
  vi.doUnmock('../../../src/fs/app-directory-scopes');
  vi.resetModules();
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, {recursive: true, force: true})));
});

const runtime = (
  overrides: Partial<ProjectLockRuntime> = {},
): ProjectLockRuntime => ({
  currentPid: () => 4101,
  hostname: () => 'local-host',
  now: () => new Date('2026-08-10T00:00:00.000Z'),
  isProcessAlive: async () => true,
  processStart: async () => 'Sun Aug 10 08:00:00 2026',
  ...overrides,
});

const writeLock = async (
  work: WorkDirectoryScope,
  record: ProjectLockRecord,
): Promise<void> => {
  const handle = await openNewProjectLockFile(work);
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const removeLock = async (work: WorkDirectoryScope): Promise<void> => {
  const handle = await openExistingProjectLockFile(work);
  try {
    await unlinkProjectLockFile(work, handle);
  } finally {
    await handle.close();
  }
};

const lockRecord = (
  overrides: Partial<ProjectLockRecord> = {},
): ProjectLockRecord => ({
  pid: 4101,
  hostname: 'local-host',
  processStart: 'Sun Aug 10 08:00:00 2026',
  createdAt: '2026-08-10T00:00:00.000Z',
  runId: 'run-one',
  ...overrides,
});

const importLockModulesWithReplacementAtRemove = async (
  replacement: ProjectLockRecord,
): Promise<{
  locks: typeof import('../../../src/pipeline/project-lock');
  scopes: typeof import('../../../src/fs/app-directory-scopes');
  replacementCount: () => number;
}> => {
  let replacementCount = 0;
  vi.resetModules();
  vi.doMock('../../../src/fs/app-directory-scopes', async () => {
    const actual = await vi.importActual<
      typeof import('../../../src/fs/app-directory-scopes')
    >('../../../src/fs/app-directory-scopes');
    return {
      ...actual,
      unlinkProjectLockFile: async (...args: unknown[]) => {
        if (replacementCount === 0) {
          replacementCount += 1;
          const work = args[0] as WorkDirectoryScope;
          const oldHandle = await actual.openExistingProjectLockFile(work);
          try {
            await Reflect.apply(
              actual.unlinkProjectLockFile,
              undefined,
              [work, oldHandle],
            );
          } finally {
            await oldHandle.close();
          }
          const replacementHandle = await actual.openNewProjectLockFile(work);
          try {
            await replacementHandle.writeFile(
              `${JSON.stringify(replacement, null, 2)}\n`,
            );
            await replacementHandle.sync();
          } finally {
            await replacementHandle.close();
          }
        }
        return await Reflect.apply(
          actual.unlinkProjectLockFile,
          undefined,
          args,
        );
      },
    };
  });
  const scopes = await import('../../../src/fs/app-directory-scopes');
  const locks = await import('../../../src/pipeline/project-lock');
  return {locks, scopes, replacementCount: () => replacementCount};
};

describe('project lock', () => {
  it('rejects a second owner with PROJECT_LOCKED', async () => {
    const {work} = await makeWorkScope();
    const first = await acquireProjectLock(work, 'run-one', runtime());

    await expect(acquireProjectLock(work, 'run-two', runtime()))
      .rejects.toMatchObject({
        code: 'PROJECT_LOCKED',
        record: expect.objectContaining({runId: 'run-one'}),
      });

    await first.release();
  });

  it('reports a dead local PID as stale without deleting it', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    await writeLock(work, lockRecord({pid: 999_999}));
    const staleRuntime = runtime({isProcessAlive: async () => false});

    await expect(acquireProjectLock(work, 'run-two', staleRuntime))
      .rejects.toMatchObject({code: 'PROJECT_LOCK_STALE'});
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).resolves.toContain('run-one');

    await clearStaleLock(work, staleRuntime);
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('detects PID reuse from a different process-start marker', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    await writeLock(work, lockRecord({processStart: 'old marker'}));
    const reusedRuntime = runtime({
      isProcessAlive: async () => true,
      processStart: async () => 'new marker',
    });

    await expect(acquireProjectLock(work, 'run-two', reusedRuntime))
      .rejects.toMatchObject({code: 'PROJECT_LOCK_STALE'});
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).resolves.toContain('old marker');
  });

  it.each([null, '   '] as const)(
    'fails closed when a live PID process-start marker is unavailable: %s',
    async (unavailableMarker) => {
      const {workspaceRoot, work} = await makeWorkScope();
      await writeLock(work, lockRecord());
      const lockPath = path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock');
      const before = await readFile(lockPath);
      const unavailableRuntime = runtime({
        currentPid: () => 5100,
        isProcessAlive: async () => true,
        processStart: async (pid) => (
          pid === 5100 ? 'caller process marker' : unavailableMarker
        ),
      });

      let acquireError: unknown;
      try {
        await acquireProjectLock(work, 'run-two', unavailableRuntime);
      } catch (error) {
        acquireError = error;
      }
      let clearError: unknown;
      try {
        await clearStaleLock(work, unavailableRuntime);
      } catch (error) {
        clearError = error;
      }

      expect(acquireError).toMatchObject({code: 'PROJECT_LOCKED'});
      expect(clearError).toMatchObject({code: 'PROJECT_LOCKED'});
      await expect(readFile(lockPath)).resolves.toEqual(before);
    },
  );

  it('fails closed for a lock owned on another host', async () => {
    const {work} = await makeWorkScope();
    await writeLock(work, lockRecord({hostname: 'remote-host'}));

    await expect(acquireProjectLock(work, 'run-two', runtime()))
      .rejects.toMatchObject({code: 'PROJECT_LOCKED'});
    await expect(clearStaleLock(work, runtime()))
      .rejects.toMatchObject({code: 'PROJECT_LOCKED'});
  });

  it('does not release a replacement lock owned by another runId', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    const lease = await acquireProjectLock(work, 'run-one', runtime());
    await removeLock(work);
    await writeLock(work, lockRecord({runId: 'run-two'}));

    await lease.release();

    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).resolves.toContain('run-two');
  });

  it('keeps release ownership private from lease.record mutation', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    const lease = await acquireProjectLock(work, 'run-one', runtime());
    expect(Object.isFrozen(lease.record)).toBe(true);
    const mutableRecord = lease.record as {
      pid: number;
      runId: string;
    };
    expect(Reflect.set(mutableRecord, 'pid', 999_999)).toBe(false);
    expect(Reflect.set(mutableRecord, 'runId', 'run-two')).toBe(false);

    await lease.release();

    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('propagates release scope errors and remains retryable', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'project-lock-outside-'));
    tempDirectories.push(outsideRoot);
    const workRoot = path.join(workspaceRoot, '.work', 'demo');
    const displacedWorkRoot = `${workRoot}-original`;
    const lease = await acquireProjectLock(work, 'run-one', runtime());
    await rename(workRoot, displacedWorkRoot);
    await symlink(outsideRoot, workRoot);

    await expect(lease.release()).rejects.toMatchObject({
      code: 'APP_PATH_OUTSIDE_SCOPE',
    });

    await rm(workRoot);
    await rename(displacedWorkRoot, workRoot);
    await lease.release();
    await expect(readFile(path.join(workRoot, 'pipeline.lock')))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('propagates an invalid lock record and remains retryable', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    const lease = await acquireProjectLock(work, 'run-one', runtime());
    const lockPath = path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock');
    await writeFile(lockPath, '{invalid json');

    await expect(lease.release()).rejects.toMatchObject({
      code: 'PROJECT_LOCK_INVALID',
    });
    await expect(readFile(lockPath, 'utf8')).resolves.toBe('{invalid json');

    await writeFile(lockPath, `${JSON.stringify(lease.record, null, 2)}\n`);
    await lease.release();
    await expect(readFile(lockPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects a different valid record on the owner inode and remains retryable', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    const lease = await acquireProjectLock(work, 'run-one', runtime());
    const lockPath = path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock');
    const replacement = lockRecord({
      pid: 4202,
      processStart: 'Sun Aug 10 08:01:00 2026',
      runId: 'run-two',
    });
    await writeFile(lockPath, `${JSON.stringify(replacement, null, 2)}\n`);

    await expect(lease.release()).rejects.toMatchObject({
      code: 'PROJECT_LOCK_INVALID',
      record: expect.objectContaining({runId: 'run-two'}),
    });
    await expect(readFile(lockPath, 'utf8')).resolves.toContain('run-two');

    await writeFile(lockPath, `${JSON.stringify(lease.record, null, 2)}\n`);
    await lease.release();
    await expect(readFile(lockPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('does not delete a new owner installed at the release remove boundary', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'project-lock-race-'));
    tempDirectories.push(workspaceRoot);
    const replacement = lockRecord({pid: 4202, runId: 'run-two'});
    const {locks, scopes, replacementCount} =
      await importLockModulesWithReplacementAtRemove(replacement);
    const work = await scopes.createWorkDirectoryScope(workspaceRoot, 'demo');
    const lease = await locks.acquireProjectLock(work, 'run-one', runtime());

    await lease.release();

    expect(replacementCount()).toBe(1);
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).resolves.toContain('run-two');
  });

  it('does not delete a new owner installed at the stale-clear remove boundary', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'project-lock-race-'));
    tempDirectories.push(workspaceRoot);
    const replacement = lockRecord({pid: 4202, runId: 'run-two'});
    const {locks, scopes, replacementCount} =
      await importLockModulesWithReplacementAtRemove(replacement);
    const work = await scopes.createWorkDirectoryScope(workspaceRoot, 'demo');
    const staleHandle = await scopes.openNewProjectLockFile(work);
    try {
      await staleHandle.writeFile(`${JSON.stringify(
        lockRecord({pid: 999_999}),
        null,
        2,
      )}\n`);
      await staleHandle.sync();
    } finally {
      await staleHandle.close();
    }

    await expect(locks.clearStaleLock(
      work,
      runtime({isProcessAlive: async () => false}),
    )).rejects.toMatchObject({code: 'PROJECT_LOCKED'});

    expect(replacementCount()).toBe(1);
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).resolves.toContain('run-two');
  });

  it('keeps a changed stale lock when clear races with replacement', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    await writeLock(work, lockRecord({pid: 999_999}));
    let probes = 0;
    const racingRuntime = runtime({
      isProcessAlive: async () => {
        probes += 1;
        if (probes === 1) {
          await removeLock(work);
          await writeLock(work, lockRecord({runId: 'run-two'}));
          return false;
        }
        return true;
      },
    });

    await expect(clearStaleLock(work, racingRuntime)).rejects.toBeInstanceOf(
      ProjectLockError,
    );
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).resolves.toContain('run-two');
  });

  it('records the real Darwin process-start marker and mode 0600', async () => {
    const {workspaceRoot, work} = await makeWorkScope();
    const lease = await acquireProjectLock(work, 'run-real');
    const lockPath = path.join(workspaceRoot, '.work', 'demo', 'pipeline.lock');
    const raw = await readFile(lockPath, 'utf8');
    const record = JSON.parse(raw) as ProjectLockRecord;

    expect(record).toMatchObject({
      pid: process.pid,
      runId: 'run-real',
      processStart: expect.stringMatching(/\S/),
    });
    const handle = await import('node:fs/promises').then(({open}) => open(lockPath, 'r'));
    try {
      expect((await handle.stat()).mode & 0o777).toBe(0o600);
    } finally {
      await handle.close();
    }
    await lease.release();
  });
});
