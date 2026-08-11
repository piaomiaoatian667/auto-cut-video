import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, type BigIntStats} from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  rename,
  rm,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createOutputStore,
  createRunStore,
  ensureOutputDirectory,
  ensureRunDirectory,
  openExistingRunFile,
  openNewOutputFile,
  openNewRunFile,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  copyRunArtifact,
  hashRunArtifact,
  verifyOutputArtifact,
  verifyRunArtifact,
} from '../../../src/pipeline/artifacts';

const tempDirectories: string[] = [];
const execFile = promisify(execFileCallback);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

interface InterceptedReadHandle {
  stat(options: {bigint: true}): Promise<BigIntStats>;
}

type InterceptedRead = (
  this: InterceptedReadHandle,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
) => Promise<{bytesRead: number}>;

type InterceptedStat = (
  this: object,
  options: {bigint: true},
) => Promise<BigIntStats>;

type InterceptedSync = (this: InterceptedReadHandle) => Promise<void>;

afterEach(async () => {
  vi.doUnmock('node:fs/promises');
  vi.resetModules();
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const makeWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'pipeline-artifacts-'));
  tempDirectories.push(workspaceRoot);
  return workspaceRoot;
};

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const writeRunBytes = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  bytes: Buffer,
): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeOutputBytes = async (
  outputDirectory: OutputDirectoryScope,
  relativePath: string,
  bytes: Buffer,
): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureOutputDirectory(outputDirectory, parent);
  const handle = await openNewOutputFile(outputDirectory, relativePath);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

describe('pipeline artifacts', () => {
  it('copies a Run artifact with fresh handles and verifies the hash', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    const sourceRun = await store.createRun('demo', 'source-run');
    const targetRun = await store.createRun('demo', 'target-run');
    const relativePath = 'audio/cache/key.wav';
    const bytes = Buffer.from('fresh source artifact');
    await writeRunBytes(sourceRun, relativePath, bytes);
    const sourceArtifact = await hashRunArtifact(sourceRun, relativePath);

    const artifact = await copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: sourceArtifact,
    });

    expect(artifact).toEqual({
      scope: 'run',
      path: relativePath,
      sha256: sha256(bytes),
    });
    await expect(verifyRunArtifact(targetRun, artifact)).resolves.toBe(true);
    const copied = await openExistingRunFile(targetRun, relativePath);
    try {
      await expect(copied.readFile()).resolves.toEqual(bytes);
    } finally {
      await copied.close();
    }
  });

  it('refuses an output artifact in the Run copy API', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    const sourceRun = await store.createRun('demo', 'source-run');
    const targetRun = await store.createRun('demo', 'target-run');

    await expect(copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: {
        scope: 'output',
        path: 'releases/run/final.mp4',
        sha256: sha256(Buffer.from('release')),
      },
    })).rejects.toMatchObject({code: 'ARTIFACT_SCOPE_INVALID'});
  });

  it('removes a copied Run artifact when its source report hash mismatches', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    const sourceRun = await store.createRun('demo', 'source-run');
    const targetRun = await store.createRun('demo', 'target-run');
    const relativePath = 'cache/segment.wav';
    await writeRunBytes(sourceRun, relativePath, Buffer.from('source bytes'));

    await expect(copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: {
        scope: 'run',
        path: relativePath,
        sha256: sha256(Buffer.from('different bytes')),
      },
    })).rejects.toMatchObject({code: 'ARTIFACT_HASH_MISMATCH'});
    await expect(openExistingRunFile(targetRun, relativePath))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('verifies an Output artifact only in Output scope', async () => {
    const workspaceRoot = await makeWorkspace();
    const outputDirectory = await createOutputStore(workspaceRoot)
      .openProject('demo');
    const relativePath = 'releases/run/final.mp4';
    const bytes = Buffer.from('published release');
    await writeOutputBytes(outputDirectory, relativePath, bytes);
    const artifact = {
      scope: 'output' as const,
      path: relativePath,
      sha256: sha256(bytes),
    };

    await expect(verifyOutputArtifact(outputDirectory, artifact))
      .resolves.toBe(true);
    await expect(verifyRunArtifact({} as RunDirectoryScope, artifact))
      .rejects.toMatchObject({code: 'ARTIFACT_SCOPE_INVALID'});
  });

  it.each(['hash Run', 'verify Output', 'copy Run'] as const)(
    'rejects a FIFO promptly during %s artifact reads',
    async (operation) => {
      const workspaceRoot = await makeWorkspace();
      const runStore = createRunStore(workspaceRoot);
      const sourceRun = await runStore.createRun('demo', 'source-run');
      const targetRun = await runStore.createRun('demo', 'target-run');
      const outputDirectory = await createOutputStore(workspaceRoot)
        .openProject('demo');
      const relativePath = 'blocked.fifo';
      const fifoPath = operation === 'verify Output'
        ? path.join(workspaceRoot, 'output', 'demo', relativePath)
        : path.join(
          workspaceRoot,
          '.work',
          'demo',
          'runs',
          'source-run',
          relativePath,
        );
      await execFile('mkfifo', [fifoPath]);
      const pending = operation === 'hash Run'
        ? hashRunArtifact(sourceRun, relativePath)
        : operation === 'verify Output'
          ? verifyOutputArtifact(outputDirectory, {
            scope: 'output',
            path: relativePath,
            sha256: sha256(Buffer.from('expected')),
          })
          : copyRunArtifact({
            sourceRun,
            targetRun,
            artifact: {
              scope: 'run',
              path: relativePath,
              sha256: sha256(Buffer.from('expected')),
            },
          });
      const outcome = pending.then(
        (value) => ({status: 'resolved', value} as const),
        (error: unknown) => ({status: 'rejected', error} as const),
      );
      const fifoPeer = delay(500).then(async () => {
        try {
          const handle = await openFile(
            fifoPath,
            constants.O_WRONLY | constants.O_NONBLOCK,
          );
          await handle.close();
        } catch (error) {
          if (!isNodeError(error) || error.code !== 'ENXIO') throw error;
        }
      });
      const promptOutcome = await Promise.race([
        outcome,
        delay(200, {status: 'timed-out'} as const),
      ]);
      await fifoPeer;
      await outcome;

      expect(promptOutcome).toMatchObject({status: 'rejected'});
    },
  );

  it.each(['hash Run', 'verify Output', 'copy Run'] as const)(
    'rejects a same-inode rewrite during %s artifact reads',
    async (operation) => {
      const workspaceRoot = await makeWorkspace();
      const runStore = createRunStore(workspaceRoot);
      const sourceRun = await runStore.createRun('demo', 'source-run');
      const targetRun = await runStore.createRun('demo', 'target-run');
      const outputDirectory = await createOutputStore(workspaceRoot)
        .openProject('demo');
      const relativePath = 'media/stable.bin';
      const original = Buffer.alloc(128 * 1024, 0x61);
      const replacement = Buffer.alloc(original.length, 0x62);
      const hybrid = Buffer.concat([
        original.subarray(0, 64 * 1024),
        replacement.subarray(64 * 1024),
      ]);
      if (operation === 'verify Output') {
        await writeOutputBytes(outputDirectory, relativePath, original);
      } else {
        await writeRunBytes(sourceRun, relativePath, original);
      }
      const sourcePath = operation === 'verify Output'
        ? path.join(workspaceRoot, 'output', 'demo', relativePath)
        : path.join(
          workspaceRoot,
          '.work',
          'demo',
          'runs',
          'source-run',
          relativePath,
        );
      const originalStats = await lstat(sourcePath, {bigint: true});
      const probe = operation === 'verify Output'
        ? await openFile(sourcePath, constants.O_RDONLY)
        : await openExistingRunFile(sourceRun, relativePath);
      const prototype = Object.getPrototypeOf(probe) as {read: InterceptedRead};
      const originalRead = prototype.read;
      await probe.close();
      let mutated = false;
      prototype.read = async function (buffer, offset, length, position) {
        const status = await this.stat({bigint: true});
        const result = await originalRead.call(
          this,
          buffer,
          offset,
          length,
          position,
        );
        if (
          !mutated
          && result.bytesRead > 0
          && status.dev === originalStats.dev
          && status.ino === originalStats.ino
        ) {
          mutated = true;
          await writeFile(sourcePath, replacement);
          const changedTime = new Date(Date.now() + 60_000);
          await utimes(sourcePath, changedTime, changedTime);
        }
        return result;
      };

      try {
        const pending = operation === 'hash Run'
          ? hashRunArtifact(sourceRun, relativePath)
          : operation === 'verify Output'
            ? verifyOutputArtifact(outputDirectory, {
              scope: 'output',
              path: relativePath,
              sha256: sha256(hybrid),
            })
            : copyRunArtifact({
              sourceRun,
              targetRun,
              artifact: {
                scope: 'run',
                path: relativePath,
                sha256: sha256(hybrid),
              },
            });

        await expect(pending).rejects.toBeInstanceOf(Error);
      } finally {
        prototype.read = originalRead;
      }
      const changedStats = await lstat(sourcePath, {bigint: true});
      expect(mutated).toBe(true);
      expect(changedStats.ino).toBe(originalStats.ino);
      expect(changedStats.size).toBe(originalStats.size);
    },
  );

  it.each(['hashRunArtifact', 'copyRunArtifact'] as const)(
    'preserves %s operation and authority-close failures',
    async (operation) => {
      const workspaceRoot = await makeWorkspace();
      const relativePath = 'media/close-failure.bin';
      const original = Buffer.alloc(128 * 1024, 0x61);
      const replacement = Buffer.alloc(original.length, 0x62);
      const sourcePath = path.join(
        workspaceRoot,
        '.work',
        'demo',
        'runs',
        'source-run',
        relativePath,
      );
      const closeError = Object.assign(new Error('artifact authority close failed'), {
        code: 'EIO',
      });
      let sourceIdentity: Pick<BigIntStats, 'dev' | 'ino'> | undefined;
      let mutationHandle: FileHandle | undefined;
      let mutated = false;
      let closeFailed = false;
      vi.resetModules();
      vi.doMock('node:fs/promises', async () => {
        const actual = await vi.importActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        );
        return {
          ...actual,
          open: async (...args: Parameters<typeof actual.open>) => {
            const handle = await Reflect.apply(actual.open, undefined, args);
            if (sourceIdentity === undefined) return handle;
            const status = await handle.stat({bigint: true});
            if (
              !status.isFile()
              || status.dev !== sourceIdentity.dev
              || status.ino !== sourceIdentity.ino
            ) {
              return handle;
            }
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'read') {
                  return async (
                    buffer: Uint8Array,
                    offset: number,
                    length: number,
                    position: number,
                  ) => {
                    const result = await target.read(buffer, offset, length, position);
                    if (!mutated && result.bytesRead > 0) {
                      mutated = true;
                      await mutationHandle!.write(replacement, 0, replacement.length, 0);
                      await mutationHandle!.sync();
                      const changedTime = new Date(Date.now() + 60_000);
                      await actual.utimes(sourcePath, changedTime, changedTime);
                    }
                    return result;
                  };
                }
                if (property === 'close') {
                  return async () => {
                    await target.close();
                    if (!closeFailed) {
                      closeFailed = true;
                      throw closeError;
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
      const scopes = await import('../../../src/fs/app-directory-scopes');
      const artifacts = await import('../../../src/pipeline/artifacts');
      const runStore = scopes.createRunStore(workspaceRoot);
      const sourceRun = await runStore.createRun('demo', 'source-run');
      const targetRun = await runStore.createRun('demo', 'target-run');
      await scopes.ensureRunDirectory(sourceRun, 'media');
      const sourceHandle = await scopes.openNewRunFile(sourceRun, relativePath);
      await sourceHandle.writeFile(original);
      await sourceHandle.sync();
      await sourceHandle.close();
      sourceIdentity = await lstat(sourcePath, {bigint: true});
      mutationHandle = await openFile(sourcePath, constants.O_WRONLY);

      let caughtError: unknown;
      try {
        if (operation === 'hashRunArtifact') {
          await artifacts.hashRunArtifact(sourceRun, relativePath);
        } else {
          await artifacts.copyRunArtifact({
            sourceRun,
            targetRun,
            artifact: {
              scope: 'run',
              path: relativePath,
              sha256: sha256(original),
            },
          });
        }
      } catch (error) {
        caughtError = error;
      } finally {
        await mutationHandle.close();
      }

      expect(caughtError).toBeInstanceOf(AggregateError);
      const errors = (caughtError as AggregateError).errors;
      expect(errors).toEqual(expect.arrayContaining([
        expect.objectContaining({code: 'ARTIFACT_INVALID'}),
        closeError,
      ]));
      expect(mutated).toBe(true);
      expect(closeFailed).toBe(true);
      if (operation === 'copyRunArtifact') {
        await expect(scopes.openExistingRunFile(targetRun, relativePath))
          .rejects.toMatchObject({code: 'ENOENT'});
      }
    },
  );

  it('preserves hash mismatch and target write-authority close failure', async () => {
    const workspaceRoot = await makeWorkspace();
    const relativePath = 'media/write-close-failure.bin';
    const bytes = Buffer.from('copied bytes');
    const closeError = Object.assign(new Error('target write authority close failed'), {
      code: 'EIO',
    });
    let armTargetClose = false;
    let targetProxied = false;
    let closeFailed = false;
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
          if (
            !armTargetClose
            || targetProxied
            || (flags & constants.O_CREAT) === 0
          ) {
            return handle;
          }
          targetProxied = true;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'close') {
                return async () => {
                  await target.close();
                  closeFailed = true;
                  throw closeError;
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
    const artifacts = await import('../../../src/pipeline/artifacts');
    const runStore = scopes.createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'source-run');
    const targetRun = await runStore.createRun('demo', 'target-run');
    await scopes.ensureRunDirectory(sourceRun, 'media');
    const sourceHandle = await scopes.openNewRunFile(sourceRun, relativePath);
    await sourceHandle.writeFile(bytes);
    await sourceHandle.sync();
    await sourceHandle.close();
    armTargetClose = true;

    let caughtError: unknown;
    try {
      await artifacts.copyRunArtifact({
        sourceRun,
        targetRun,
        artifact: {
          scope: 'run',
          path: relativePath,
          sha256: sha256(Buffer.from('different bytes')),
        },
      });
    } catch (error) {
      caughtError = error;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    expect((caughtError as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'ARTIFACT_HASH_MISMATCH'}),
      closeError,
    ]));
    expect(targetProxied).toBe(true);
    expect(closeFailed).toBe(true);
    await expect(scopes.openExistingRunFile(targetRun, relativePath))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each([
    'hashRunArtifact',
    'verifyOutputArtifact',
    'copyRunArtifact',
  ] as const)(
    'fails closed when a nested parent is swapped during %s',
    async (operation) => {
      const workspaceRoot = await makeWorkspace();
      const runStore = createRunStore(workspaceRoot);
      const sourceRun = await runStore.createRun('demo', 'source-run');
      const targetRun = await runStore.createRun('demo', 'target-run');
      const outputDirectory = await createOutputStore(workspaceRoot)
        .openProject('demo');
      const relativePath = 'nested/parent/stable.bin';
      const original = Buffer.alloc(128 * 1024, 0x61);
      const replacement = Buffer.alloc(original.length, 0x62);
      if (operation === 'verifyOutputArtifact') {
        await writeOutputBytes(outputDirectory, relativePath, original);
      } else {
        await writeRunBytes(sourceRun, relativePath, original);
      }
      const sourcePath = operation === 'verifyOutputArtifact'
        ? path.join(workspaceRoot, 'output', 'demo', relativePath)
        : path.join(
          workspaceRoot,
          '.work',
          'demo',
          'runs',
          'source-run',
          relativePath,
        );
      const nestedRoot = path.dirname(path.dirname(sourcePath));
      const movedRoot = `${nestedRoot}-original`;
      const originalStats = await lstat(sourcePath, {bigint: true});
      const probe = operation === 'verifyOutputArtifact'
        ? await openFile(sourcePath, constants.O_RDONLY)
        : await openExistingRunFile(sourceRun, relativePath);
      const prototype = Object.getPrototypeOf(probe) as {read: InterceptedRead};
      const originalRead = prototype.read;
      await probe.close();
      let parentSwapped = false;
      prototype.read = async function (buffer, offset, length, position) {
        const status = await this.stat({bigint: true});
        const result = await originalRead.call(
          this,
          buffer,
          offset,
          length,
          position,
        );
        if (
          !parentSwapped
          && result.bytesRead > 0
          && status.dev === originalStats.dev
          && status.ino === originalStats.ino
        ) {
          parentSwapped = true;
          await rename(nestedRoot, movedRoot);
          await mkdir(path.dirname(sourcePath), {recursive: true});
          await writeFile(sourcePath, replacement);
        }
        return result;
      };

      try {
        const pending = operation === 'hashRunArtifact'
          ? hashRunArtifact(sourceRun, relativePath)
          : operation === 'verifyOutputArtifact'
            ? verifyOutputArtifact(outputDirectory, {
              scope: 'output',
              path: relativePath,
              sha256: sha256(original),
            })
            : copyRunArtifact({
              sourceRun,
              targetRun,
              artifact: {
                scope: 'run',
                path: relativePath,
                sha256: sha256(original),
              },
            });
        const prompt = Promise.race([
          pending,
          delay(500).then(() => {
            throw new Error('artifact operation timed out');
          }),
        ]);

        await expect(prompt).rejects.toMatchObject({
          code: 'APP_SCOPE_AUTHORITY_CHANGED',
        });
      } finally {
        prototype.read = originalRead;
      }
      expect(parentSwapped).toBe(true);
      if (operation === 'copyRunArtifact') {
        await expect(openExistingRunFile(targetRun, relativePath))
          .rejects.toMatchObject({code: 'ENOENT'});
      }
    },
  );

  it('fails closed when the source parent is swapped during target sync', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'source-run');
    const targetRun = await runStore.createRun('demo', 'target-run');
    const relativePath = 'nested/parent/stable.bin';
    const original = Buffer.alloc(128 * 1024, 0x61);
    const replacement = Buffer.alloc(original.length, 0x62);
    await writeRunBytes(sourceRun, relativePath, original);
    const sourcePath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'source-run',
      relativePath,
    );
    const targetPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'target-run',
      relativePath,
    );
    const nestedRoot = path.dirname(path.dirname(sourcePath));
    const movedRoot = `${nestedRoot}-original`;
    const probe = await openExistingRunFile(sourceRun, relativePath);
    const prototype = Object.getPrototypeOf(probe) as {sync: InterceptedSync};
    const originalSync = prototype.sync;
    await probe.close();
    let parentSwapped = false;
    prototype.sync = async function () {
      const status = await this.stat({bigint: true});
      const target = await lstat(targetPath, {bigint: true}).catch((error) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (
        !parentSwapped
        && target?.isFile()
        && status.dev === target.dev
        && status.ino === target.ino
      ) {
        parentSwapped = true;
        await rename(nestedRoot, movedRoot);
        await mkdir(path.dirname(sourcePath), {recursive: true});
        await writeFile(sourcePath, replacement);
      }
      await originalSync.call(this);
    };

    try {
      await expect(copyRunArtifact({
        sourceRun,
        targetRun,
        artifact: {
          scope: 'run',
          path: relativePath,
          sha256: sha256(original),
        },
      })).rejects.toMatchObject({code: 'APP_SCOPE_AUTHORITY_CHANGED'});
    } finally {
      prototype.sync = originalSync;
    }
    expect(parentSwapped).toBe(true);
    await expect(openExistingRunFile(targetRun, relativePath))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('removes the exact target when its parent is swapped during sync', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'source-run');
    const targetRun = await runStore.createRun('demo', 'target-run');
    const relativePath = 'nested/parent/stable.bin';
    const bytes = Buffer.alloc(128 * 1024, 0x61);
    await writeRunBytes(sourceRun, relativePath, bytes);
    const targetPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'target-run',
      relativePath,
    );
    const nestedRoot = path.dirname(path.dirname(targetPath));
    const movedRoot = `${nestedRoot}-original`;
    const orphanPath = path.join(movedRoot, 'parent', path.basename(targetPath));
    const probe = await openExistingRunFile(sourceRun, relativePath);
    const prototype = Object.getPrototypeOf(probe) as {sync: InterceptedSync};
    const originalSync = prototype.sync;
    await probe.close();
    let parentSwapped = false;
    prototype.sync = async function () {
      const status = await this.stat({bigint: true});
      const target = await lstat(targetPath, {bigint: true}).catch((error) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (
        !parentSwapped
        && target?.isFile()
        && status.dev === target.dev
        && status.ino === target.ino
      ) {
        parentSwapped = true;
        await rename(nestedRoot, movedRoot);
        await mkdir(path.dirname(targetPath), {recursive: true});
      }
      await originalSync.call(this);
    };

    let caughtError: unknown;
    try {
      await copyRunArtifact({
        sourceRun,
        targetRun,
        artifact: {
          scope: 'run',
          path: relativePath,
          sha256: sha256(bytes),
        },
      });
    } catch (error) {
      caughtError = error;
    } finally {
      prototype.sync = originalSync;
    }

    expect(parentSwapped).toBe(true);
    await expect(lstat(orphanPath)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(lstat(targetPath)).rejects.toMatchObject({code: 'ENOENT'});
    expect(caughtError).toMatchObject({code: 'APP_SCOPE_AUTHORITY_CHANGED'});
  });

  it('reports both a copy failure and rollback failure', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'source-run');
    const targetRun = await runStore.createRun('demo', 'target-run');
    const relativePath = 'cache/rollback.bin';
    const original = Buffer.alloc(128 * 1024, 0x61);
    const replacement = Buffer.alloc(original.length, 0x62);
    await writeRunBytes(sourceRun, relativePath, original);
    const sourcePath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'source-run',
      relativePath,
    );
    const targetPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'target-run',
      relativePath,
    );
    const sourceStats = await lstat(sourcePath, {bigint: true});
    const probe = await openExistingRunFile(sourceRun, relativePath);
    const prototype = Object.getPrototypeOf(probe) as {read: InterceptedRead};
    const originalRead = prototype.read;
    await probe.close();
    let sourceMutated = false;
    let targetReplaced = false;
    prototype.read = async function (buffer, offset, length, position) {
      const status = await this.stat({bigint: true});
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (
        !sourceMutated
        && result.bytesRead > 0
        && status.dev === sourceStats.dev
        && status.ino === sourceStats.ino
      ) {
        sourceMutated = true;
        await writeFile(sourcePath, replacement);
        const changedTime = new Date(Date.now() + 60_000);
        await utimes(sourcePath, changedTime, changedTime);
        await rename(targetPath, `${targetPath}.partial`);
        await link(`${targetPath}.partial`, `${targetPath}.hardlink`);
        await mkdir(targetPath);
        targetReplaced = true;
      }
      return result;
    };

    let caughtError: unknown;
    try {
      await copyRunArtifact({
        sourceRun,
        targetRun,
        artifact: {
          scope: 'run',
          path: relativePath,
          sha256: sha256(original),
        },
      });
    } catch (error) {
      caughtError = error;
    } finally {
      prototype.read = originalRead;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    expect((caughtError as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'ARTIFACT_INVALID'}),
      expect.objectContaining({code: 'APP_SCOPE_AUTHORITY_CHANGED'}),
    ]));
    expect((caughtError as Error).message).toContain(relativePath);
    expect(targetReplaced).toBe(true);
    expect((await lstat(targetPath)).isDirectory()).toBe(true);
  });

  it('reports both a copied-artifact hash failure and rollback failure', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'source-run');
    const targetRun = await runStore.createRun('demo', 'target-run');
    const relativePath = 'cache/hash-rollback.bin';
    const original = Buffer.alloc(128 * 1024, 0x61);
    const replacement = Buffer.alloc(original.length, 0x62);
    await writeRunBytes(sourceRun, relativePath, original);
    const targetPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'target-run',
      relativePath,
    );
    const probe = await openExistingRunFile(sourceRun, relativePath);
    const prototype = Object.getPrototypeOf(probe) as {read: InterceptedRead};
    const originalRead = prototype.read;
    await probe.close();
    let targetMutated = false;
    prototype.read = async function (buffer, offset, length, position) {
      const status = await this.stat({bigint: true});
      const target = await lstat(targetPath, {bigint: true}).catch((error) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (
        !targetMutated
        && result.bytesRead > 0
        && target?.isFile()
        && status.dev === target.dev
        && status.ino === target.ino
      ) {
        targetMutated = true;
        await writeFile(targetPath, replacement);
        const changedTime = new Date(Date.now() + 60_000);
        await utimes(targetPath, changedTime, changedTime);
        await rename(targetPath, `${targetPath}.partial`);
        await link(`${targetPath}.partial`, `${targetPath}.hardlink`);
        await mkdir(targetPath);
      }
      return result;
    };

    let caughtError: unknown;
    try {
      await copyRunArtifact({
        sourceRun,
        targetRun,
        artifact: {
          scope: 'run',
          path: relativePath,
          sha256: sha256(original),
        },
      });
    } catch (error) {
      caughtError = error;
    } finally {
      prototype.read = originalRead;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    expect((caughtError as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'ARTIFACT_INVALID'}),
      expect.objectContaining({code: 'APP_SCOPE_AUTHORITY_CHANGED'}),
    ]));
    expect((caughtError as Error).message).toContain(relativePath);
    expect(targetMutated).toBe(true);
    expect((await lstat(targetPath)).isDirectory()).toBe(true);
  });

  it('preserves hash mismatch when mismatch rollback also fails', async () => {
    const workspaceRoot = await makeWorkspace();
    const runStore = createRunStore(workspaceRoot);
    const sourceRun = await runStore.createRun('demo', 'source-run');
    const targetRun = await runStore.createRun('demo', 'target-run');
    const relativePath = 'cache/mismatch-rollback.bin';
    const bytes = Buffer.alloc(128 * 1024, 0x61);
    await writeRunBytes(sourceRun, relativePath, bytes);
    const targetPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'target-run',
      relativePath,
    );
    const targetParent = path.dirname(targetPath);
    const probe = await openExistingRunFile(sourceRun, relativePath);
    const prototype = Object.getPrototypeOf(probe) as {
      read: InterceptedRead;
      stat: InterceptedStat;
    };
    const originalRead = prototype.read;
    const originalStat = prototype.stat;
    await probe.close();
    let targetRead = false;
    let postReadTargetStats = 0;
    let cleanupBlocked = false;
    prototype.read = async function (buffer, offset, length, position) {
      const status = await this.stat({bigint: true});
      const target = await lstat(targetPath, {bigint: true}).catch((error) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (
        result.bytesRead > 0
        && target?.isFile()
        && status.dev === target.dev
        && status.ino === target.ino
      ) {
        targetRead = true;
      }
      return result;
    };
    prototype.stat = async function (options) {
      const status = await originalStat.call(this, options);
      const target = await lstat(targetPath, {bigint: true}).catch((error) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (
        targetRead
        && target?.isFile()
        && status.dev === target.dev
        && status.ino === target.ino
      ) {
        postReadTargetStats += 1;
        if (postReadTargetStats === 2) {
          await chmod(targetParent, 0o500);
          cleanupBlocked = true;
        }
      }
      return status;
    };

    let caughtError: unknown;
    try {
      await copyRunArtifact({
        sourceRun,
        targetRun,
        artifact: {
          scope: 'run',
          path: relativePath,
          sha256: sha256(Buffer.from('different bytes')),
        },
      });
    } catch (error) {
      caughtError = error;
    } finally {
      prototype.read = originalRead;
      prototype.stat = originalStat;
      if (cleanupBlocked) await chmod(targetParent, 0o700);
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    const errors = (caughtError as AggregateError).errors;
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'ARTIFACT_HASH_MISMATCH'}),
    ]));
    expect(errors.some((error) => (
      isNodeError(error)
      && (error.code === 'EACCES' || error.code === 'EPERM')
    ))).toBe(true);
    expect((caughtError as Error).message).toContain(relativePath);
    expect(cleanupBlocked).toBe(true);
    const remaining = await openExistingRunFile(targetRun, relativePath);
    await remaining.close();
  });
});
