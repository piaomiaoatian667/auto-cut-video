import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
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
} from 'vitest';
import {
  createOutputStore,
  createRunStore,
  ensureOutputDirectory,
  ensureRunDirectory,
  openExistingOutputFile,
  openExistingRunFile,
  openNewOutputFile,
  openNewRunFile,
} from '../../../src/fs/app-directory-scopes';
import {
  RunStoreError,
  type CurrentPointer,
  type FileOps,
} from '../../../src/pipeline/run-store';
import * as runStoreModule from '../../../src/pipeline/run-store';
// @ts-expect-error authority injection types must not be public
import type {RunStoreAuthority as ForbiddenRunStoreAuthority} from '../../../src/pipeline/run-store';
// @ts-expect-error authority injection types must not be public
import type {OutputStoreAuthority as ForbiddenOutputStoreAuthority} from '../../../src/pipeline/run-store';

function assertNoAuthorityFactoryExports(): void {
  // @ts-expect-error arbitrary Run authority injection must not be exported
  void runStoreModule.createRunStoreWithAuthority;
  // @ts-expect-error arbitrary Output authority injection must not be exported
  void runStoreModule.createOutputStoreWithAuthority;
}
void assertNoAuthorityFactoryExports;
type ForbiddenAuthorityTypes = [
  ForbiddenRunStoreAuthority,
  ForbiddenOutputStoreAuthority,
];
void (undefined as unknown as ForbiddenAuthorityTypes);

const tempDirectories: string[] = [];

const makeWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'run-store-'));
  tempDirectories.push(workspaceRoot);
  return workspaceRoot;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, {recursive: true, force: true})));
});

const pointer = (
  runId: string,
  overrides: Partial<CurrentPointer> = {},
): CurrentPointer => ({
  runId,
  relativePath: `runs/${runId}`,
  preset: 'release',
  stageIds: [
    'preflight',
    'ingest',
    'narration',
    'compile',
    'draft',
    'review',
    'release',
  ],
  completedStage: 'release',
  state: 'passed',
  publishedAt: '2026-08-10T00:00:00.000Z',
  ...overrides,
});

const writeAndClose = async (
  handle: Awaited<ReturnType<typeof openNewRunFile>>,
  value: string,
): Promise<void> => {
  try {
    await handle.writeFile(value);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const readAndClose = async (
  handle: Awaited<ReturnType<typeof openExistingRunFile>>,
): Promise<string> => {
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

describe('RunStore', () => {
  it('does not expose arbitrary authority injection or beta-to-alpha mapping', async () => {
    const workspaceRoot = await makeWorkspace();
    const alphaStore = createRunStore(workspaceRoot);
    const alphaWork = await alphaStore.createWork('alpha');
    const alphaRun = await alphaStore.createRun('alpha', 'run-alpha');
    const exportedFactory = (
      runStoreModule as unknown as Record<string, unknown>
    ).createRunStoreWithAuthority;

    if (typeof exportedFactory === 'function') {
      const unsupported = async (): Promise<never> => {
        throw new Error('unused malicious pointer operation');
      };
      const injected = Reflect.apply(exportedFactory, undefined, [{
        createWork: async () => alphaWork,
        createRun: async () => alphaRun,
        openExistingRun: async () => alphaRun,
        workPointer: {
          inspect: unsupported,
          openExisting: unsupported,
          openNew: unsupported,
          unlink: unsupported,
          rename: unsupported,
          link: unsupported,
          syncDirectory: unsupported,
        },
      }]) as {createRun(projectId: string, runId: string): Promise<unknown>};
      const betaAuthority = await injected.createRun('beta', 'run-beta');
      await writeAndClose(
        await openNewRunFile(betaAuthority as never, 'beta-wrote.txt'),
        'mapped-to-alpha',
      );
      await expect(readFile(path.join(
        workspaceRoot,
        '.work',
        'alpha',
        'runs',
        'run-alpha',
        'beta-wrote.txt',
      ), 'utf8')).resolves.toBe('mapped-to-alpha');
    }

    expect(runStoreModule).not.toHaveProperty('createRunStoreWithAuthority');
    expect(runStoreModule).not.toHaveProperty('createOutputStoreWithAuthority');
    expect(Object.keys(runStoreModule)).not.toContain('RunStoreAuthority');
    expect(Object.keys(runStoreModule)).not.toContain('OutputStoreAuthority');
  });

  it('creates immutable runs and safely reopens them through a new store', async () => {
    const workspaceRoot = await makeWorkspace();
    const firstStore = createRunStore(workspaceRoot);
    const run = await firstStore.createRun('demo', 'run-one');
    await ensureRunDirectory(run, 'reports');
    await writeAndClose(
      await openNewRunFile(run, 'reports/preflight.json'),
      '{"passed":true}',
    );

    await expect(firstStore.createRun('demo', 'run-one'))
      .rejects.toMatchObject({code: 'EEXIST'});
    const reopened = await createRunStore(workspaceRoot)
      .openExistingRun('demo', 'run-one');
    await expect(readAndClose(
      await openExistingRunFile(reopened, 'reports/preflight.json'),
    )).resolves.toBe('{"passed":true}');
    await expect(openNewRunFile(reopened, 'reports/preflight.json'))
      .rejects.toMatchObject({code: 'EEXIST'});
    await expect(createRunStore(workspaceRoot).openExistingRun('demo', 'missing'))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('validates projectId and runId before deriving authority', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);

    await expect(store.createRun('../demo', 'run-one')).rejects.toBeInstanceOf(Error);
    await expect(store.createRun('demo', '../run-one')).rejects.toBeInstanceOf(Error);
  });

  it('publishes and reads a Work current pointer atomically', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    await store.createRun('demo', 'run-one');
    const current = pointer('run-one');

    await store.publishCurrent('demo', current);

    await expect(store.readCurrent('demo')).resolves.toEqual(current);
    const currentPath = path.join(workspaceRoot, '.work', 'demo', 'current.json');
    expect((await lstat(currentPath)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(currentPath))).not.toContain('current.json.tmp');
    expect(await readdir(path.dirname(currentPath))).not.toContain('current.json.rollback');
  });

  it('publishes Output current only for a completed release', async () => {
    const workspaceRoot = await makeWorkspace();
    const outputStore = createOutputStore(workspaceRoot);
    const output = await outputStore.createRelease('demo', 'run-one');
    await ensureOutputDirectory(output, 'releases/run-one/reports');
    const report = await openNewOutputFile(
      output,
      'releases/run-one/reports/validation.json',
    );
    try {
      await report.writeFile('{"passed":true}');
    } finally {
      await report.close();
    }
    const current = pointer('run-one', {relativePath: 'releases/run-one'});

    await outputStore.publishCurrent('demo', current);

    await expect(outputStore.readCurrent('demo')).resolves.toEqual(current);
    await expect(readAndClose(
      await openExistingOutputFile(
        await outputStore.openProject('demo'),
        'releases/run-one/reports/validation.json',
      ),
    )).resolves.toContain('passed');
    await expect(outputStore.publishCurrent('demo', pointer('run-one', {
      relativePath: 'releases/run-one',
      completedStage: 'review',
      state: 'needs_review',
    }))).rejects.toBeInstanceOf(RunStoreError);
  });

  it('rejects invalid, unordered, or mismatched pointer metadata', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    await store.createRun('demo', 'run-one');

    await expect(store.publishCurrent('demo', pointer('run-one', {
      relativePath: 'runs/other',
    }))).rejects.toMatchObject({code: 'RUN_POINTER_INVALID'});
    await expect(store.publishCurrent('demo', pointer('run-one', {
      stageIds: ['preflight', 'compile', 'ingest'],
    }))).rejects.toMatchObject({code: 'RUN_POINTER_INVALID'});
    await expect(store.publishCurrent('demo', pointer('run-one', {
      state: 'needs_review',
      completedStage: 'draft',
    }))).rejects.toMatchObject({code: 'RUN_POINTER_INVALID'});
  });

  it.each(['current.json', 'current.json.tmp'])(
    'rejects a Work pointer symlink at %s',
    async (name) => {
      const workspaceRoot = await makeWorkspace();
      const outsideRoot = await makeWorkspace();
      const outsideFile = path.join(outsideRoot, 'outside.json');
      await writeFile(outsideFile, 'outside');
      const store = createRunStore(workspaceRoot);
      await store.createRun('demo', 'run-one');
      await symlink(
        outsideFile,
        path.join(workspaceRoot, '.work', 'demo', name),
      );

      await expect(store.publishCurrent('demo', pointer('run-one')))
        .rejects.toMatchObject({code: 'RUN_POINTER_UNSAFE'});
      await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
    },
  );

  it('rejects an Output pointer symlink', async () => {
    const workspaceRoot = await makeWorkspace();
    const outsideRoot = await makeWorkspace();
    const outsideFile = path.join(outsideRoot, 'outside.json');
    await writeFile(outsideFile, 'outside');
    const store = createOutputStore(workspaceRoot);
    await store.createRelease('demo', 'run-one');
    await symlink(
      outsideFile,
      path.join(workspaceRoot, 'output', 'demo', 'current.json'),
    );

    await expect(store.publishCurrent('demo', pointer('run-one', {
      relativePath: 'releases/run-one',
    }))).rejects.toMatchObject({code: 'RUN_POINTER_UNSAFE'});
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });

  it.each(['work', 'output'] as const)(
    'rejects a %s pointer whose target directory becomes a symlink',
    async (owner) => {
      const workspaceRoot = await makeWorkspace();
      const outsideRoot = await makeWorkspace();
      if (owner === 'work') {
        const store = createRunStore(workspaceRoot);
        await store.createRun('demo', 'run-one');
        const runRoot = path.join(
          workspaceRoot,
          '.work',
          'demo',
          'runs',
          'run-one',
        );
        await rm(runRoot, {recursive: true});
        await symlink(outsideRoot, runRoot);

        await expect(store.publishCurrent('demo', pointer('run-one')))
          .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
      } else {
        const store = createOutputStore(workspaceRoot);
        await store.createRelease('demo', 'run-one');
        const releaseRoot = path.join(
          workspaceRoot,
          'output',
          'demo',
          'releases',
          'run-one',
        );
        await rm(releaseRoot, {recursive: true});
        await symlink(outsideRoot, releaseRoot);

        await expect(store.publishCurrent('demo', pointer('run-one', {
          relativePath: 'releases/run-one',
        }))).rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
      }
    },
  );

  it.each([
    'write',
    'file-sync',
    'rename',
    'rename-after-operation',
    'directory-sync',
    'directory-sync-after-operation',
  ] as const)(
    'preserves old pointer bytes and cleans temps when %s fails',
    async (failurePoint) => {
      const workspaceRoot = await makeWorkspace();
      const normalStore = createRunStore(workspaceRoot);
      await normalStore.createRun('demo', 'run-one');
      await normalStore.publishCurrent('demo', pointer('run-one'));
      await normalStore.createRun('demo', 'run-two');
      const currentPath = path.join(workspaceRoot, '.work', 'demo', 'current.json');
      const oldBytes = await readFile(currentPath);
      const failure = new Error(`injected ${failurePoint} failure`);
      const fileOps: Partial<FileOps> = {
        ...(failurePoint === 'write'
          ? {writeFile: async () => { throw failure; }}
          : {}),
        ...(failurePoint === 'file-sync'
          ? {syncFile: async () => { throw failure; }}
          : {}),
        ...(failurePoint === 'rename'
          ? {rename: async () => { throw failure; }}
          : {}),
        ...(failurePoint === 'rename-after-operation'
          ? {
            rename: async (operation) => {
              await operation();
              throw failure;
            },
          }
          : {}),
        ...(failurePoint === 'directory-sync'
          ? {
            syncDirectory: async (operation, phase) => {
              if (phase === 'publish') throw failure;
              await operation();
            },
          }
          : {}),
        ...(failurePoint === 'directory-sync-after-operation'
          ? {
            syncDirectory: async (operation, phase) => {
              await operation();
              if (phase === 'publish') throw failure;
            },
          }
          : {}),
      };
      const failingStore = createRunStore(workspaceRoot, {fileOps});

      await expect(failingStore.publishCurrent(
        'demo',
        pointer('run-two', {publishedAt: '2026-08-10T00:01:00.000Z'}),
      )).rejects.toThrow(failure);

      await expect(readFile(currentPath)).resolves.toEqual(oldBytes);
      const entries = await readdir(path.dirname(currentPath));
      expect(entries).not.toContain('current.json.tmp');
      expect(entries).not.toContain('current.json.rollback');
      await expect(normalStore.readCurrent('demo')).resolves.toEqual(pointer('run-one'));
    },
  );

  it('preserves an absent pointer when directory sync fails after rename', async () => {
    const workspaceRoot = await makeWorkspace();
    const normalStore = createRunStore(workspaceRoot);
    await normalStore.createRun('demo', 'run-one');
    const failure = new Error('injected directory sync failure');
    const failingStore = createRunStore(workspaceRoot, {
      fileOps: {
        syncDirectory: async (operation, phase) => {
          if (phase === 'publish') throw failure;
          await operation();
        },
      },
    });

    await expect(failingStore.publishCurrent('demo', pointer('run-one')))
      .rejects.toThrow(failure);

    const workRoot = path.join(workspaceRoot, '.work', 'demo');
    await expect(readFile(path.join(workRoot, 'current.json')))
      .rejects.toMatchObject({code: 'ENOENT'});
    expect(await readdir(workRoot)).not.toContain('current.json.tmp');
  });

  it('rejects malformed current JSON on safe reopen', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    await store.createRun('demo', 'run-one');
    await writeFile(
      path.join(workspaceRoot, '.work', 'demo', 'current.json'),
      '{"runId":"run-one"}',
      {mode: 0o600},
    );

    await expect(store.readCurrent('demo')).rejects.toMatchObject({
      code: 'RUN_POINTER_INVALID',
    });
  });
});
