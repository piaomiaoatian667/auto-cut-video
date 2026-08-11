import {constants, type BigIntStats} from 'node:fs';
import {
  mkdir,
  lstat,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
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
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';
import {
  AppDirectoryScopeError,
  OutputDirectoryScope,
  RunDirectoryScope,
  WorkDirectoryScope,
  createOutputStore,
  createRunStore,
  createWorkDirectoryScope,
  ensureOutputDirectory,
  ensureRunDirectory,
  openExistingOutputFile,
  openExistingRunFile,
  openNewOutputFile,
  openNewOutputReadWriteFile,
  openNewRunFile,
  openNewRunFileForWrite,
  openNewRunReadWriteFile,
  unlinkRunFile,
} from '../../../src/fs/app-directory-scopes';
import * as appDirectoryScopes from '../../../src/fs/app-directory-scopes';
import {runProcess} from '../../../src/process/run-process';

type FixedProjectLockApi = {
  openExistingProjectLockFile(scope: WorkDirectoryScope): Promise<FileHandle>;
  openNewProjectLockFile(scope: WorkDirectoryScope): Promise<FileHandle>;
};

const fixedProjectLockApi = (): FixedProjectLockApi => {
  const candidate = appDirectoryScopes as unknown as Partial<FixedProjectLockApi>;
  if (
    typeof candidate.openExistingProjectLockFile !== 'function'
    || typeof candidate.openNewProjectLockFile !== 'function'
  ) {
    throw new TypeError('fixed project-lock Work API is unavailable');
  }
  return candidate as FixedProjectLockApi;
};

function assertNoArbitraryWorkExports(): void {
  // @ts-expect-error Work scope must not expose arbitrary relative-path reads
  void appDirectoryScopes.openExistingWorkFile;
  // @ts-expect-error Work scope must not expose arbitrary relative-path writes
  void appDirectoryScopes.openNewWorkFile;
  // @ts-expect-error Work scope must not expose arbitrary relative-path deletion
  void appDirectoryScopes.unlinkWorkFile;
  // @ts-expect-error Work scope must not expose arbitrary relative-path inspection
  void appDirectoryScopes.inspectWorkEntry;
}
void assertNoArbitraryWorkExports;

function assertNominalScopeTypes(
  project: ProjectDirectoryScope,
  work: WorkDirectoryScope,
  run: RunDirectoryScope,
  output: OutputDirectoryScope,
): void {
  // @ts-expect-error private brand prevents object forgery
  const forgedProject: ProjectDirectoryScope = {};
  // @ts-expect-error private brand prevents object forgery
  const forgedWork: WorkDirectoryScope = {};
  // @ts-expect-error private brand prevents object forgery
  const forgedRun: RunDirectoryScope = {};
  // @ts-expect-error private brand prevents object forgery
  const forgedOutput: OutputDirectoryScope = {};

  // @ts-expect-error Project and Work scopes are nominally distinct
  const projectAsWork: WorkDirectoryScope = project;
  // @ts-expect-error Project and Run scopes are nominally distinct
  const projectAsRun: RunDirectoryScope = project;
  // @ts-expect-error Project and Output scopes are nominally distinct
  const projectAsOutput: OutputDirectoryScope = project;
  // @ts-expect-error Work and Project scopes are nominally distinct
  const workAsProject: ProjectDirectoryScope = work;
  // @ts-expect-error Work and Run scopes are nominally distinct
  const workAsRun: RunDirectoryScope = work;
  // @ts-expect-error Work and Output scopes are nominally distinct
  const workAsOutput: OutputDirectoryScope = work;
  // @ts-expect-error Run and Project scopes are nominally distinct
  const runAsProject: ProjectDirectoryScope = run;
  // @ts-expect-error Run and Work scopes are nominally distinct
  const runAsWork: WorkDirectoryScope = run;
  // @ts-expect-error Run and Output scopes are nominally distinct
  const runAsOutput: OutputDirectoryScope = run;
  // @ts-expect-error Output and Project scopes are nominally distinct
  const outputAsProject: ProjectDirectoryScope = output;
  // @ts-expect-error Output and Work scopes are nominally distinct
  const outputAsWork: WorkDirectoryScope = output;
  // @ts-expect-error Output and Run scopes are nominally distinct
  const outputAsRun: RunDirectoryScope = output;

  void [
    forgedProject,
    forgedWork,
    forgedRun,
    forgedOutput,
    projectAsWork,
    projectAsRun,
    projectAsOutput,
    workAsProject,
    workAsRun,
    workAsOutput,
    runAsProject,
    runAsWork,
    runAsOutput,
    outputAsProject,
    outputAsWork,
    outputAsRun,
  ];
}
void assertNominalScopeTypes;

const tempDirectories: string[] = [];

const makeTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  vi.doUnmock('node:fs');
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, {recursive: true, force: true})));
});

type ScopedMutation = 'link' | 'rename' | 'unlink';

const importScopesWithMutationProbe = async (
  mutation: ScopedMutation,
  beforeMutation: () => Promise<void>,
): Promise<typeof import('../../../src/fs/app-directory-scopes')> => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      link: mutation === 'link'
        ? async (source: string, target: string) => {
          await beforeMutation();
          await actual.link(source, target);
        }
        : actual.link,
      rename: mutation === 'rename'
        ? async (source: string, target: string) => {
          await beforeMutation();
          await actual.rename(source, target);
        }
        : actual.rename,
      unlink: mutation === 'unlink'
        ? async (target: string) => {
          await beforeMutation();
          await actual.unlink(target);
        }
        : actual.unlink,
    };
  });
  return await import('../../../src/fs/app-directory-scopes');
};

const importScopesWithDelayedRealpath = async (
  gate: Promise<void>,
): Promise<typeof import('../../../src/fs/app-directory-scopes')> => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      realpath: async (...args: Parameters<typeof actual.realpath>) => {
        await gate;
        return await Reflect.apply(actual.realpath, undefined, args);
      },
    };
  });
  return await import('../../../src/fs/app-directory-scopes');
};

interface DirectoryCreationSwapProbe {
  armed: boolean;
  childName: string;
  parentPath: string;
  movedParentPath: string;
  originalParent?: {dev: bigint; ino: bigint};
  replacementParent?: {dev: bigint; ino: bigint};
  originalSyncs: number;
  replacementSyncs: number;
  restoredBySync: boolean;
  swapped: boolean;
}

const importScopesWithDirectoryCreationSwap = async (
  probe: DirectoryCreationSwapProbe,
): Promise<typeof import('../../../src/fs/app-directory-scopes')> => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
        const result = await Reflect.apply(actual.mkdir, undefined, args);
        if (
          probe.armed
          && !probe.swapped
          && path.basename(String(args[0])) === probe.childName
        ) {
          probe.swapped = true;
          await actual.rename(probe.parentPath, probe.movedParentPath);
          await actual.mkdir(probe.parentPath, {mode: 0o700});
          const replacement = await actual.lstat(probe.parentPath, {bigint: true});
          probe.replacementParent = {
            dev: replacement.dev,
            ino: replacement.ino,
          };
        }
        return result;
      },
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await Reflect.apply(actual.open, undefined, args);
        if (!probe.armed) return handle;
        const opened = await handle.stat({bigint: true});
        if (!opened.isDirectory()) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                const stats = await target.stat({bigint: true});
                const isOriginal = probe.originalParent !== undefined
                  && stats.dev === probe.originalParent.dev
                  && stats.ino === probe.originalParent.ino;
                const isReplacement = probe.replacementParent !== undefined
                  && stats.dev === probe.replacementParent.dev
                  && stats.ino === probe.replacementParent.ino;
                if (isOriginal) probe.originalSyncs += 1;
                if (isReplacement) probe.replacementSyncs += 1;
                await target.sync();
                if (isOriginal && probe.swapped && !probe.restoredBySync) {
                  await actual.rm(probe.parentPath, {recursive: true, force: true});
                  await actual.rename(probe.movedParentPath, probe.parentPath);
                  probe.restoredBySync = true;
                }
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  });
  return await import('../../../src/fs/app-directory-scopes');
};

interface FailOnceDirectorySyncProbe {
  armed: boolean;
  error: Error;
  failed: boolean;
  syncAttempts: number;
  target?: {dev: bigint; ino: bigint};
}

const importScopesWithFailOnceDirectorySync = async (
  probe: FailOnceDirectorySyncProbe,
): Promise<typeof import('../../../src/fs/app-directory-scopes')> => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await Reflect.apply(actual.open, undefined, args);
        if (!probe.armed) return handle;
        const opened = await handle.stat({bigint: true});
        if (!opened.isDirectory()) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                const stats = await target.stat({bigint: true});
                const isTarget = probe.target !== undefined
                  && stats.dev === probe.target.dev
                  && stats.ino === probe.target.ino;
                if (isTarget) {
                  probe.syncAttempts += 1;
                  if (!probe.failed) {
                    probe.failed = true;
                    throw probe.error;
                  }
                }
                await target.sync();
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  });
  return await import('../../../src/fs/app-directory-scopes');
};

const withInode = (stats: BigIntStats, ino: bigint): BigIntStats => {
  Object.defineProperty(stats, 'ino', {
    configurable: true,
    enumerable: true,
    value: ino,
  });
  return stats;
};

const importScopesWithWorkspaceInodes = async (
  canonicalWorkspace: string,
  capturedIno: bigint,
  observedIno: bigint,
): Promise<typeof import('../../../src/fs/app-directory-scopes')> => {
  vi.resetModules();
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
      ...actual,
      lstatSync: (target: string) => {
        const stats = actual.lstatSync(target, {bigint: true});
        return path.resolve(target) === canonicalWorkspace
          ? withInode(stats, capturedIno)
          : stats;
      },
    };
  });
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      lstat: async (target: string) => {
        const stats = await actual.lstat(target, {bigint: true});
        return path.resolve(target) === canonicalWorkspace
          ? withInode(stats, observedIno)
          : stats;
      },
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await Reflect.apply(actual.open, undefined, args);
        const openedPath = path.resolve(String(args[0]));
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'stat') {
              return async () => {
                const stats = await target.stat({bigint: true});
                return openedPath === canonicalWorkspace
                  ? withInode(stats, observedIno)
                  : stats;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  });
  return await import('../../../src/fs/app-directory-scopes');
};

const writeAndClose = async (
  handle: FileHandle,
  value: string,
): Promise<void> => {
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
};

const readAndClose = async (handle: FileHandle): Promise<string> => {
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

describe('app-owned directory scopes', () => {
  it('mints only fixed Work, Run, and Output prefixes without exposing roots', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-fixed-');
    const work = await createWorkDirectoryScope(workspaceRoot, 'demo');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    const output = await createOutputStore(workspaceRoot).openProject('demo');

    expect(Object.keys(work)).toEqual([]);
    expect(Object.keys(run)).toEqual([]);
    expect(Object.keys(output)).toEqual([]);
    await expect(readFile(path.join(workspaceRoot, '.work', 'demo'), 'utf8'))
      .rejects.toMatchObject({code: 'EISDIR'});
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one'),
      'utf8',
    )).rejects.toMatchObject({code: 'EISDIR'});
    await expect(readFile(path.join(workspaceRoot, 'output', 'demo'), 'utf8'))
      .rejects.toMatchObject({code: 'EISDIR'});
  });

  it.each(['run', 'output'] as const)(
    'captures %s Store workspace authority before returning',
    async (owner) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${owner}-capture-`);
      const outsideRoot = await makeTempDirectory('app-scopes-outside-');
      const displacedWorkspace = `${workspaceRoot}-original`;
      tempDirectories.push(displacedWorkspace);
      let releaseRealpath!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseRealpath = resolve;
      });
      const scopes = await importScopesWithDelayedRealpath(gate);
      let useStore: () => Promise<unknown>;
      if (owner === 'run') {
        const store = scopes.createRunStore(workspaceRoot);
        useStore = async () => await store.createRun('demo', 'run-one');
      } else {
        const store = scopes.createOutputStore(workspaceRoot);
        useStore = async () => await store.openProject('demo');
      }

      await rename(workspaceRoot, displacedWorkspace);
      await symlink(outsideRoot, workspaceRoot);
      releaseRealpath();

      await expect(useStore()).rejects.toMatchObject({
        code: 'APP_SCOPE_AUTHORITY_CHANGED',
      });
      const escapedPath = owner === 'run'
        ? path.join(outsideRoot, '.work', 'demo', 'runs', 'run-one')
        : path.join(outsideRoot, 'output', 'demo');
      await expect(readFile(escapedPath)).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it.each(['run', 'output'] as const)(
    'rejects an invalid %s Store workspace synchronously',
    async (owner) => {
      const workspaceParent = await makeTempDirectory('app-scopes-invalid-');
      const missingWorkspace = path.join(workspaceParent, 'missing');
      let constructionError: unknown;
      let consumeRejectedAuthority: (() => Promise<unknown>) | undefined;
      try {
        if (owner === 'run') {
          const store = createRunStore(missingWorkspace);
          consumeRejectedAuthority = async () => await store.createWork('demo');
        } else {
          const store = createOutputStore(missingWorkspace);
          consumeRejectedAuthority = async () => await store.openProject('demo');
        }
      } catch (error) {
        constructionError = error;
      }
      await consumeRejectedAuthority?.().catch(() => undefined);

      expect(constructionError).toMatchObject({code: 'ENOENT'});
    },
  );

  it('distinguishes adjacent bigint workspace inodes above MAX_SAFE_INTEGER', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-bigint-');
    const canonicalWorkspace = await realpath(workspaceRoot);
    const firstIno = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const secondIno = firstIno + 1n;
    const scopes = await importScopesWithWorkspaceInodes(
      canonicalWorkspace,
      firstIno,
      secondIno,
    );
    const store = scopes.createRunStore(workspaceRoot);

    await expect(store.createWork('demo')).rejects.toMatchObject({
      code: 'APP_SCOPE_AUTHORITY_CHANGED',
    });
  });

  it.each([
    ['absolute', '/tmp/escape'],
    ['parent traversal', '../escape'],
    ['Windows absolute', 'C:\\escape'],
    ['backslash traversal', '..\\escape'],
    ['NUL byte', 'bad\0name'],
    ['empty', ''],
  ])('rejects %s paths before opening', async (_label, relativePath) => {
    const workspaceRoot = await makeTempDirectory('app-scopes-relative-');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');

    await expect(openNewRunFile(run, relativePath)).rejects.toBeInstanceOf(
      AppDirectoryScopeError,
    );
  });

  it('rejects runtime scope forgery', async () => {
    await expect(fixedProjectLockApi().openNewProjectLockFile(
      {} as WorkDirectoryScope,
    )).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects fixed Work authority that resolves outside the workspace', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-workspace-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    await mkdir(path.join(workspaceRoot, '.work'));
    await symlink(outsideRoot, path.join(workspaceRoot, '.work', 'demo'));

    await expect(createWorkDirectoryScope(workspaceRoot, 'demo'))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
  });

  it('rejects confined Run creation through an escaped runs directory', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-workspace-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    await mkdir(path.join(workspaceRoot, '.work', 'demo'), {recursive: true});
    await symlink(outsideRoot, path.join(workspaceRoot, '.work', 'demo', 'runs'));

    await expect(
      createRunStore(workspaceRoot).createRun('demo', 'run-one'),
    ).rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(readFile(path.join(outsideRoot, 'run-one'), 'utf8'))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects fixed Output authority that resolves outside the workspace', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-workspace-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    await mkdir(path.join(workspaceRoot, 'output'));
    await symlink(outsideRoot, path.join(workspaceRoot, 'output', 'demo'));

    await expect(createOutputStore(workspaceRoot).openProject('demo'))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
  });

  it('rejects a Work project-lock symlink', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-work-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    const outsideFile = path.join(outsideRoot, 'outside.json');
    await writeFile(outsideFile, 'outside');
    const work = await createWorkDirectoryScope(workspaceRoot, 'demo');
    const workRoot = path.join(workspaceRoot, '.work', 'demo');

    await symlink(outsideFile, path.join(workRoot, 'pipeline.lock'));
    await expect(fixedProjectLockApi().openExistingProjectLockFile(work))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(fixedProjectLockApi().openNewProjectLockFile(work))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });

  it('does not expose Work authority over Run artifacts', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-work-minimal-');
    const work = await createWorkDirectoryScope(workspaceRoot, 'demo');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    await writeAndClose(await openNewRunFile(run, 'artifact.txt'), 'immutable');

    expect(appDirectoryScopes).not.toHaveProperty('openExistingWorkFile');
    expect(appDirectoryScopes).not.toHaveProperty('openNewWorkFile');
    expect(appDirectoryScopes).not.toHaveProperty('unlinkWorkFile');
    expect(appDirectoryScopes).not.toHaveProperty('inspectWorkEntry');
    expect(appDirectoryScopes).toHaveProperty('openExistingProjectLockFile');
    expect(appDirectoryScopes).toHaveProperty('openNewProjectLockFile');

    await expect(Reflect.apply(
      fixedProjectLockApi().openExistingProjectLockFile,
      undefined,
      [work, 'runs/run-one/artifact.txt'],
    )).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readAndClose(
      await openExistingRunFile(run, 'artifact.txt'),
    )).resolves.toBe('immutable');
  });

  it.each(['run', 'output'] as const)(
    'supports existing, exclusive write-only, and exclusive read-write %s files',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const scope = kind === 'run'
        ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
        : await createOutputStore(workspaceRoot).openProject('demo');
      const ensureDirectory = kind === 'run'
        ? ensureRunDirectory
        : ensureOutputDirectory;
      const openNewFile = kind === 'run'
        ? openNewRunFile
        : openNewOutputFile;
      const openExistingFile = kind === 'run'
        ? openExistingRunFile
        : openExistingOutputFile;
      const openReadWriteFile = kind === 'run'
        ? openNewRunReadWriteFile
        : openNewOutputReadWriteFile;

      await ensureDirectory(scope as never, 'media');
      await writeAndClose(
        await openNewFile(scope as never, 'media/artifact.txt'),
        'immutable',
      );
      await expect(
        openNewFile(scope as never, 'media/artifact.txt'),
      ).rejects.toMatchObject({code: 'EEXIST'});
      await expect(readAndClose(
        await openExistingFile(scope as never, 'media/artifact.txt'),
      )).resolves.toBe('immutable');

      const seekable = await openReadWriteFile(
        scope as never,
        'media/seekable.mp4',
      );
      try {
        expect((await seekable.stat()).mode & 0o777).toBe(0o600);
        await seekable.write(Buffer.from('abcdef'), 0, 6, 0);
        const buffer = Buffer.alloc(3);
        await seekable.read(buffer, 0, 3, 2);
        expect(buffer.toString()).toBe('cde');
      } finally {
        await seekable.close();
      }
      await expect(openReadWriteFile(
        scope as never,
        'media/seekable.mp4',
      )).rejects.toMatchObject({code: 'EEXIST'});
    },
  );

  it.each(['run', 'output'] as const)(
    'rejects %s read, write-only, and read-write symlink escapes',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const outsideRoot = await makeTempDirectory('app-scopes-outside-');
      await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret');
      const scope = kind === 'run'
        ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
        : await createOutputStore(workspaceRoot).openProject('demo');
      const scopeRoot = kind === 'run'
        ? path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one')
        : path.join(workspaceRoot, 'output', 'demo');
      await symlink(outsideRoot, path.join(scopeRoot, 'escape'));

      const openExistingFile = kind === 'run'
        ? openExistingRunFile
        : openExistingOutputFile;
      const openNewFile = kind === 'run'
        ? openNewRunFile
        : openNewOutputFile;
      const openReadWriteFile = kind === 'run'
        ? openNewRunReadWriteFile
        : openNewOutputReadWriteFile;

      await expect(openExistingFile(scope as never, 'escape/secret.txt'))
        .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
      await expect(openNewFile(scope as never, 'escape/new.txt'))
        .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
      await expect(openReadWriteFile(scope as never, 'escape/new.mp4'))
        .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    },
  );

  it('unlinks a regular file through a Run-scoped helper', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-unlink-run-');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    await writeAndClose(await openNewRunFile(run, 'artifact.bin'), 'artifact');

    await unlinkRunFile(run, 'artifact.bin');

    await expect(openExistingRunFile(run, 'artifact.bin'))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('unlinks the exact created inode when its basename is swapped', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-exact-unlink-');
    const relativePath = 'nested/artifact.bin';
    const targetPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-one',
      relativePath,
    );
    const movedPath = `${targetPath}.moved`;
    const replacement = 'replacement';
    let armed = false;
    let swapped = false;
    const scopes = await importScopesWithMutationProbe('unlink', async () => {
      if (!armed || swapped) return;
      swapped = true;
      await rename(targetPath, movedPath);
      await writeFile(targetPath, replacement);
    });
    const run = await scopes.createRunStore(workspaceRoot)
      .createRun('demo', 'run-one');
    await scopes.ensureRunDirectory(run, 'nested');
    const authority = await scopes.openNewRunFileForWrite(run, relativePath);
    await authority.handle.writeFile('created');
    await authority.syncAndSeal();
    armed = true;

    let unlinkError: unknown;
    try {
      await authority.unlink();
    } catch (error) {
      unlinkError = error;
    } finally {
      await authority.close();
    }

    expect(swapped).toBe(true);
    await expect(readFile(targetPath, 'utf8')).resolves.toBe(replacement);
    await expect(readFile(movedPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
    expect(unlinkError).toBeUndefined();
  });

  it('syncs the held parent and rejects a restored lexical replacement', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-parent-sync-');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    await ensureRunDirectory(run, 'reports');
    const reportsPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-one',
      'reports',
    );
    const movedReportsPath = `${reportsPath}-original`;
    const reportPath = path.join(reportsPath, 'ingest.json');
    const authority = await openNewRunFileForWrite(run, 'reports/ingest.json');
    await authority.handle.writeFile('report');
    await authority.syncAndSeal();
    await authority.revalidate();
    const originalIdentity = await lstat(reportsPath, {bigint: true});
    const probe = await open(reportsPath, constants.O_RDONLY);
    const prototype = Object.getPrototypeOf(probe) as {
      sync: (this: FileHandle) => Promise<void>;
    };
    const originalSync = prototype.sync;
    await probe.close();
    await rename(reportsPath, movedReportsPath);
    await mkdir(reportsPath);
    const replacementIdentity = await lstat(reportsPath, {bigint: true});
    let originalSyncs = 0;
    let replacementSyncs = 0;
    let restored = false;
    prototype.sync = async function () {
      const stats = await this.stat({bigint: true});
      const isOriginal = stats.isDirectory()
        && stats.dev === originalIdentity.dev
        && stats.ino === originalIdentity.ino;
      const isReplacement = stats.isDirectory()
        && stats.dev === replacementIdentity.dev
        && stats.ino === replacementIdentity.ino;
      if (isOriginal) originalSyncs += 1;
      if (isReplacement) replacementSyncs += 1;
      await originalSync.call(this);
      if (!restored && (isOriginal || isReplacement)) {
        await rm(reportsPath, {recursive: true, force: true});
        await rename(movedReportsPath, reportsPath);
        restored = true;
      }
    };

    let successSyncError: unknown;
    let rollbackSyncError: unknown;
    try {
      try {
        await authority.syncParent();
      } catch (error) {
        successSyncError = error;
      }
      await authority.unlink();
      try {
        await authority.syncParent();
      } catch (error) {
        rollbackSyncError = error;
      }
    } finally {
      prototype.sync = originalSync;
      if (!restored) {
        await rm(reportsPath, {recursive: true, force: true});
        await rename(movedReportsPath, reportsPath);
      }
      await authority.close();
    }

    expect(successSyncError).toMatchObject({code: 'APP_SCOPE_AUTHORITY_CHANGED'});
    expect(rollbackSyncError).toBeUndefined();
    expect(originalSyncs).toBe(2);
    expect(replacementSyncs).toBe(0);
    await expect(readFile(reportPath, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each([
    ['Run root', 'reports', false],
    ['reports parent', 'attempts', true],
  ] as const)(
    'syncs the held %s when directory creation races with replacement',
    async (_label, childName, createReportsFirst) => {
      const workspaceRoot = await makeTempDirectory('app-scopes-create-sync-');
      const probe: DirectoryCreationSwapProbe = {
        armed: false,
        childName,
        parentPath: '',
        movedParentPath: '',
        originalSyncs: 0,
        replacementSyncs: 0,
        restoredBySync: false,
        swapped: false,
      };
      const scopes = await importScopesWithDirectoryCreationSwap(probe);
      const run = await scopes.createRunStore(workspaceRoot)
        .createRun('demo', 'run-one');
      const runRoot = path.join(
        workspaceRoot,
        '.work',
        'demo',
        'runs',
        'run-one',
      );
      if (createReportsFirst) await scopes.ensureRunDirectory(run, 'reports');
      probe.parentPath = createReportsFirst
        ? path.join(runRoot, 'reports')
        : runRoot;
      probe.movedParentPath = `${probe.parentPath}-original`;
      const original = await lstat(probe.parentPath, {bigint: true});
      probe.originalParent = {dev: original.dev, ino: original.ino};
      probe.armed = true;

      let creationError: unknown;
      try {
        await scopes.ensureRunDirectory(
          run,
          createReportsFirst ? 'reports/attempts' : 'reports',
        );
      } catch (error) {
        creationError = error;
      }
      const restoredBySync = probe.restoredBySync;
      if (!probe.restoredBySync) {
        await rm(probe.parentPath, {recursive: true, force: true});
        await rename(probe.movedParentPath, probe.parentPath);
      }

      expect(creationError).toMatchObject({code: 'APP_SCOPE_AUTHORITY_CHANGED'});
      expect(restoredBySync).toBe(true);
      expect(probe.originalSyncs).toBe(1);
      expect(probe.replacementSyncs).toBe(0);
      const syncCount = probe.originalSyncs;
      await expect(scopes.ensureRunDirectory(
        run,
        createReportsFirst ? 'reports/attempts' : 'reports',
      )).resolves.toBeUndefined();
      expect(probe.originalSyncs).toBe(syncCount + 1);
      expect(probe.replacementSyncs).toBe(0);
    },
  );

  it.each([
    ['reports', 'reports', false],
    ['attempts', 'reports/attempts', true],
  ] as const)(
    'retries held-parent fsync when ensuring existing %s directory',
    async (_label, relativePath, createReportsFirst) => {
      const workspaceRoot = await makeTempDirectory('app-scopes-sync-retry-');
      const syncError = Object.assign(new Error('parent sync failed once'), {
        code: 'EIO',
      });
      const probe: FailOnceDirectorySyncProbe = {
        armed: false,
        error: syncError,
        failed: false,
        syncAttempts: 0,
      };
      const scopes = await importScopesWithFailOnceDirectorySync(probe);
      const run = await scopes.createRunStore(workspaceRoot)
        .createRun('demo', 'run-one');
      const runRoot = path.join(
        workspaceRoot,
        '.work',
        'demo',
        'runs',
        'run-one',
      );
      if (createReportsFirst) await scopes.ensureRunDirectory(run, 'reports');
      const parentPath = createReportsFirst
        ? path.join(runRoot, 'reports')
        : runRoot;
      const parent = await lstat(parentPath, {bigint: true});
      probe.target = {dev: parent.dev, ino: parent.ino};
      probe.armed = true;

      await expect(scopes.ensureRunDirectory(run, relativePath))
        .rejects.toBe(syncError);
      expect(probe.syncAttempts).toBe(1);

      await expect(scopes.ensureRunDirectory(run, relativePath))
        .resolves.toBeUndefined();
      expect(probe.syncAttempts).toBe(2);
    },
  );

  it('retries identity acquisition to clean up after the first created-file stat fails', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-created-stat-');
    const relativePath = 'nested/artifact.bin';
    const targetPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-one',
      relativePath,
    );
    const statError = Object.assign(new Error('created file stat failed'), {code: 'EIO'});
    let firstCreatedHandleSeen = false;
    let createdStatCalls = 0;
    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await Reflect.apply(actual.open, undefined, args);
          const flags = Number(args[1]);
          if (firstCreatedHandleSeen || (flags & constants.O_CREAT) === 0) return handle;
          firstCreatedHandleSeen = true;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'stat') {
                return async (...statArgs: Parameters<FileHandle['stat']>) => {
                  createdStatCalls += 1;
                  if (createdStatCalls === 1) throw statError;
                  return await Reflect.apply(target.stat, target, statArgs);
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
    });
    const scopes = await import('../../../src/fs/app-directory-scopes');
    const run = await scopes.createRunStore(workspaceRoot)
      .createRun('demo', 'run-one');
    await scopes.ensureRunDirectory(run, 'nested');

    await expect(scopes.openNewRunFileForWrite(run, relativePath))
      .rejects.toBe(statError);

    await expect(readFile(targetPath)).rejects.toMatchObject({code: 'ENOENT'});
    expect(createdStatCalls).toBeGreaterThanOrEqual(2);
    const retry = await scopes.openNewRunFileForWrite(run, relativePath);
    await retry.unlink();
    await retry.close();
  });

  it.each(['work', 'run', 'output'] as const)(
    'fails closed after lexical %s root replacement',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const scope = kind === 'work'
        ? await createWorkDirectoryScope(workspaceRoot, 'demo')
        : kind === 'run'
          ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
          : await createOutputStore(workspaceRoot).openProject('demo');
      const scopeRoot = kind === 'work'
        ? path.join(workspaceRoot, '.work', 'demo')
        : kind === 'run'
          ? path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one')
          : path.join(workspaceRoot, 'output', 'demo');
      await rename(scopeRoot, `${scopeRoot}-original`);
      await mkdir(scopeRoot);

      const pending = kind === 'work'
        ? fixedProjectLockApi().openNewProjectLockFile(scope as WorkDirectoryScope)
        : kind === 'run'
          ? openNewRunReadWriteFile(scope as RunDirectoryScope, 'new.mp4')
          : openNewOutputReadWriteFile(scope as OutputDirectoryScope, 'new.mp4');
      await expect(pending).rejects.toMatchObject({
        code: 'APP_SCOPE_AUTHORITY_CHANGED',
      });
    },
  );

  it.each(['link', 'rename', 'unlink'] as const)(
    'anchors the final %s syscall when the Work root is replaced',
    async (mutation) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${mutation}-`);
      const outsideRoot = await makeTempDirectory('app-scopes-outside-');
      const workRoot = path.join(workspaceRoot, '.work', 'demo');
      const displacedWorkRoot = `${workRoot}-original`;
      let armed = false;
      let replaced = false;
      const scopes = await importScopesWithMutationProbe(mutation, async () => {
        if (!armed || replaced) return;
        replaced = true;
        await rename(workRoot, displacedWorkRoot);
        await symlink(outsideRoot, workRoot);
      });
      const store = scopes.createRunStore(workspaceRoot);
      await store.createRun('demo', 'run-one');
      await store.publishCurrent('demo', {
        runId: 'run-one',
        relativePath: 'runs/run-one',
        preset: 'release',
        stageIds: ['preflight', 'release'],
        completedStage: 'release',
        state: 'passed',
        publishedAt: '2026-08-10T00:00:00.000Z',
      });
      await store.createRun('demo', 'run-two');

      const outsideCurrent = path.join(outsideRoot, 'current.json');
      const outsideTemp = path.join(outsideRoot, 'current.json.tmp');
      const outsideRollback = path.join(outsideRoot, 'current.json.rollback');
      await writeFile(outsideCurrent, 'outside-current');
      if (mutation === 'rename') await writeFile(outsideTemp, 'outside-temp');
      if (mutation === 'unlink') await writeFile(outsideRollback, 'outside-rollback');
      armed = true;

      const publication = store.publishCurrent('demo', {
        runId: 'run-two',
        relativePath: 'runs/run-two',
        preset: 'release',
        stageIds: ['preflight', 'release'],
        completedStage: 'release',
        state: 'passed',
        publishedAt: '2026-08-10T00:01:00.000Z',
      });
      if (mutation === 'unlink') {
        await expect(publication).resolves.toBeUndefined();
      } else {
        await expect(publication).rejects.toBeInstanceOf(Error);
      }

      expect(replaced).toBe(true);
      await expect(readFile(outsideCurrent, 'utf8')).resolves.toBe('outside-current');
      if (mutation === 'rename') {
        await expect(readFile(outsideTemp, 'utf8')).resolves.toBe('outside-temp');
      }
      if (mutation === 'link') {
        await expect(readFile(outsideRollback, 'utf8'))
          .rejects.toMatchObject({code: 'ENOENT'});
      } else if (mutation === 'unlink') {
        await expect(readFile(outsideRollback, 'utf8')).resolves.toBe('outside-rollback');
        await expect(readFile(
          path.join(displacedWorkRoot, 'current.json'),
          'utf8',
        ).then(JSON.parse)).resolves.toMatchObject({runId: 'run-two'});
      }
    },
  );

  it.each(['work', 'run', 'output'] as const)(
    'fails closed when the canonical %s root becomes an external symlink',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const outsideRoot = await makeTempDirectory('app-scopes-outside-');
      const scope = kind === 'work'
        ? await createWorkDirectoryScope(workspaceRoot, 'demo')
        : kind === 'run'
          ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
          : await createOutputStore(workspaceRoot).openProject('demo');
      const scopeRoot = kind === 'work'
        ? path.join(workspaceRoot, '.work', 'demo')
        : kind === 'run'
          ? path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one')
          : path.join(workspaceRoot, 'output', 'demo');
      await rename(scopeRoot, `${scopeRoot}-original`);
      await symlink(outsideRoot, scopeRoot);

      const pending = kind === 'work'
        ? fixedProjectLockApi().openNewProjectLockFile(scope as WorkDirectoryScope)
        : kind === 'run'
          ? openNewRunFile(scope as RunDirectoryScope, 'new.txt')
          : openNewOutputFile(scope as OutputDirectoryScope, 'new.txt');
      await expect(pending).rejects.toMatchObject({
        code: 'APP_SCOPE_AUTHORITY_CHANGED',
      });
    },
  );

  it.each([
    ['success', 'success'],
    ['failure', 'failure'],
    ['abort', 'abort'],
    ['timeout', 'timeout'],
  ] as const)('keeps borrowed Run handles caller-owned after %s', async (_label, mode) => {
    const workspaceRoot = await makeTempDirectory('app-scopes-borrowed-');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    await writeAndClose(await openNewRunFile(run, 'input.txt'), 'input');
    const handle = await openExistingRunFile(run, 'input.txt');

    try {
      const controller = new AbortController();
      const script = mode === 'success'
        ? 'require("node:fs").readFileSync(3); process.exit(0)'
        : mode === 'failure'
          ? 'require("node:fs").readFileSync(3); process.exit(2)'
          : 'require("node:fs").readFileSync(3); setInterval(() => {}, 1000)';
      const pending = runProcess(process.execPath, ['-e', script], {
        extraStdioFds: [handle.fd],
        ...(mode === 'abort' ? {signal: controller.signal} : {}),
        ...(mode === 'timeout' ? {timeoutMs: 20} : {}),
      });
      if (mode === 'abort') setTimeout(() => controller.abort('test abort'), 20);

      if (mode === 'success') {
        await expect(pending).resolves.toMatchObject({exitCode: 0});
      } else {
        await expect(pending).rejects.toBeInstanceOf(Error);
      }
      await expect(handle.stat()).resolves.toMatchObject({
        mode: expect.any(Number),
      });
    } finally {
      await handle.close();
    }
  });

  it('uses exclusive no-follow file modes', async () => {
    expect(constants.O_EXCL).toBeGreaterThan(0);
  });
});
