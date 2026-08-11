import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants, type BigIntStats} from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
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

afterEach(async () => {
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
      expect.objectContaining({code: 'APP_PATH_OUTSIDE_SCOPE'}),
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
      expect.objectContaining({code: 'APP_PATH_OUTSIDE_SCOPE'}),
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
    const probe = await openExistingRunFile(sourceRun, relativePath);
    const prototype = Object.getPrototypeOf(probe) as {stat: InterceptedStat};
    const originalStat = prototype.stat;
    await probe.close();
    let targetStatCalls = 0;
    let targetReplaced = false;
    prototype.stat = async function (options) {
      const status = await originalStat.call(this, options);
      const target = await lstat(targetPath, {bigint: true}).catch((error) => {
        if (isNodeError(error) && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (
        target?.isFile()
        && status.dev === target.dev
        && status.ino === target.ino
      ) {
        targetStatCalls += 1;
        if (targetStatCalls === 3) {
          await rename(targetPath, `${targetPath}.partial`);
          await mkdir(targetPath);
          targetReplaced = true;
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
      prototype.stat = originalStat;
    }

    expect(caughtError).toBeInstanceOf(AggregateError);
    expect((caughtError as AggregateError).errors).toEqual(expect.arrayContaining([
      expect.objectContaining({code: 'ARTIFACT_HASH_MISMATCH'}),
      expect.objectContaining({code: 'APP_PATH_OUTSIDE_SCOPE'}),
    ]));
    expect((caughtError as Error).message).toContain(relativePath);
    expect(targetReplaced).toBe(true);
    expect((await lstat(targetPath)).isDirectory()).toBe(true);
  });
});
