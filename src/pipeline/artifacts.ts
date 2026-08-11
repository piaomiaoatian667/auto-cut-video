import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {
  ensureRunDirectory,
  openExistingOutputFileForRead,
  openExistingRunFileForRead,
  openNewRunFileForWrite,
  unlinkRunFile,
  type AppDirectoryReadFileAuthority,
  type AppDirectoryWriteFileAuthority,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';

export interface PipelineArtifact {
  scope: 'run' | 'output';
  path: string;
  sha256: string;
}

export type PipelineArtifactErrorCode =
  | 'ARTIFACT_SCOPE_INVALID'
  | 'ARTIFACT_HASH_MISMATCH'
  | 'ARTIFACT_INVALID';

export class PipelineArtifactError extends Error {
  constructor(readonly code: PipelineArtifactErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'PipelineArtifactError';
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const requireArtifactScope = (
  artifact: PipelineArtifact,
  expectedScope: PipelineArtifact['scope'],
): void => {
  if (artifact.scope !== expectedScope) {
    throw new PipelineArtifactError(
      'ARTIFACT_SCOPE_INVALID',
      `expected a ${expectedScope} artifact`,
    );
  }
};

interface ArtifactFileIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

const invalidArtifact = (message: string): PipelineArtifactError =>
  new PipelineArtifactError('ARTIFACT_INVALID', message);

const stableFileIdentity = async (
  handle: FileHandle,
): Promise<ArtifactFileIdentity> => {
  const status = await handle.stat({bigint: true});
  if (
    !status.isFile()
    || status.size < 0n
    || status.size > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw invalidArtifact('artifact read target is not a bounded regular file');
  }
  return {
    dev: status.dev,
    ino: status.ino,
    nlink: status.nlink,
    size: status.size,
    mtimeNs: status.mtimeNs,
    ctimeNs: status.ctimeNs,
  };
};

const sameFileIdentity = (
  left: ArtifactFileIdentity,
  right: ArtifactFileIdentity,
): boolean => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.nlink === right.nlink
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs
);

const readStableFile = async (
  handle: FileHandle,
  onChunk: (
    buffer: Buffer,
    bytesRead: number,
    position: number,
  ) => Promise<void> | void,
): Promise<void> => {
  const before = await stableFileIdentity(handle);
  const expectedBytes = Number(before.size);
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (position < expectedBytes) {
    const length = Math.min(buffer.length, expectedBytes - position);
    const {bytesRead} = await handle.read(buffer, 0, length, position);
    if (bytesRead <= 0 || bytesRead > length) {
      throw invalidArtifact('artifact byte count changed while reading');
    }
    await onChunk(buffer, bytesRead, position);
    position += bytesRead;
  }
  const trailing = await handle.read(buffer, 0, 1, position);
  if (trailing.bytesRead !== 0) {
    throw invalidArtifact('artifact byte count changed while reading');
  }
  const after = await stableFileIdentity(handle);
  if (!sameFileIdentity(before, after)) {
    throw invalidArtifact('artifact identity changed while reading');
  }
};

const hashFileHandle = async (handle: FileHandle): Promise<string> => {
  const hash = createHash('sha256');
  await readStableFile(handle, (buffer, bytesRead) => {
    hash.update(buffer.subarray(0, bytesRead));
  });
  return `sha256:${hash.digest('hex')}`;
};

const withAuthorityClose = async <Result>(
  operation: () => Promise<Result>,
  close: () => Promise<void>,
  message: string,
): Promise<Result> => {
  let failed = false;
  let primaryError: unknown;
  try {
    return await operation();
  } catch (error) {
    failed = true;
    primaryError = error;
    throw error;
  } finally {
    try {
      await close();
    } catch (closeError) {
      if (failed) {
        throw new AggregateError(
          [primaryError, closeError],
          message,
          {cause: primaryError},
        );
      }
      throw closeError;
    }
  }
};

const hashScopedFile = async (
  openFile: () => Promise<AppDirectoryReadFileAuthority>,
): Promise<string> => {
  const authority = await openFile();
  return await withAuthorityClose(async () => {
    const sha256 = await hashFileHandle(authority.handle);
    await authority.revalidate();
    return sha256;
  }, async () => await authority.close(), 'artifact read authority close failed');
};

export async function hashRunArtifact(
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<PipelineArtifact> {
  return {
    scope: 'run',
    path: relativePath,
    sha256: await hashScopedFile(async () => await openExistingRunFileForRead(
      runDirectory,
      relativePath,
    )),
  };
}

export async function verifyRunArtifact(
  runDirectory: RunDirectoryScope,
  artifact: PipelineArtifact,
): Promise<boolean> {
  requireArtifactScope(artifact, 'run');
  try {
    return (await hashRunArtifact(runDirectory, artifact.path)).sha256
      === artifact.sha256;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function deleteRunArtifact(
  runDirectory: RunDirectoryScope,
  artifact: PipelineArtifact,
): Promise<void> {
  requireArtifactScope(artifact, 'run');
  await unlinkRunFile(runDirectory, artifact.path);
}

export async function verifyOutputArtifact(
  outputDirectory: OutputDirectoryScope,
  artifact: PipelineArtifact,
): Promise<boolean> {
  requireArtifactScope(artifact, 'output');
  try {
    const sha256 = await hashScopedFile(async () => await openExistingOutputFileForRead(
      outputDirectory,
      artifact.path,
    ));
    return sha256 === artifact.sha256;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return false;
    throw error;
  }
}

const copyFileHandles = async (
  source: FileHandle,
  target: FileHandle,
): Promise<void> => {
  await readStableFile(source, async (buffer, bytesRead, position) => {
    let bytesWritten = 0;
    while (bytesWritten < bytesRead) {
      const result = await target.write(
        buffer,
        bytesWritten,
        bytesRead - bytesWritten,
        position + bytesWritten,
      );
      if (result.bytesWritten === 0) {
        throw new Error('artifact copy made no write progress');
      }
      bytesWritten += result.bytesWritten;
    }
  });
};

const rollbackRunArtifact = async (
  target: AppDirectoryWriteFileAuthority,
  relativePath: string,
  primaryError: unknown,
): Promise<never> => {
  const cleanupErrors: unknown[] = [];
  try {
    await target.unlink();
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    await target.syncParent();
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  try {
    await target.close();
  } catch (cleanupError) {
    cleanupErrors.push(cleanupError);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `artifact rollback failed for ${relativePath}; a partial target may remain and must be removed before retrying`,
      {cause: primaryError},
    );
  }
  throw primaryError;
};

export async function copyRunArtifact(input: {
  sourceRun: RunDirectoryScope;
  targetRun: RunDirectoryScope;
  artifact: PipelineArtifact;
}): Promise<PipelineArtifact> {
  requireArtifactScope(input.artifact, 'run');
  const parent = path.posix.dirname(input.artifact.path);
  if (parent !== '.') await ensureRunDirectory(input.targetRun, parent);

  let target: AppDirectoryWriteFileAuthority | undefined;
  try {
    const source = await openExistingRunFileForRead(
      input.sourceRun,
      input.artifact.path,
    );
    await withAuthorityClose(async () => {
      target = await openNewRunFileForWrite(
        input.targetRun,
        input.artifact.path,
      );
      await copyFileHandles(source.handle, target.handle);
      await target.syncAndSeal();
      await source.revalidate();
    }, async () => await source.close(), 'artifact source authority close failed');
    const targetAuthority = target;
    if (targetAuthority === undefined) {
      throw new TypeError('artifact target authority was not created');
    }
    const copied: PipelineArtifact = {
      scope: 'run',
      path: input.artifact.path,
      sha256: await hashScopedFile(async () => await targetAuthority.openForRead()),
    };
    await targetAuthority.revalidate();
    if (copied.sha256 !== input.artifact.sha256) {
      throw new PipelineArtifactError(
        'ARTIFACT_HASH_MISMATCH',
        'copied Run artifact does not match its source report',
      );
    }
    await targetAuthority.syncParent();
    await targetAuthority.revalidate();
    await targetAuthority.close();
    target = undefined;
    return copied;
  } catch (error) {
    if (target !== undefined) {
      return await rollbackRunArtifact(target, input.artifact.path, error);
    }
    throw error;
  }
}
