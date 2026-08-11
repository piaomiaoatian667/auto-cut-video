import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import path from 'node:path';
import {
  ensureRunDirectory,
  openExistingOutputFile,
  openExistingRunFile,
  openNewRunFile,
  unlinkRunFile,
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
  | 'ARTIFACT_HASH_MISMATCH';

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

const hashFileHandle = async (handle: FileHandle): Promise<string> => {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${hash.digest('hex')}`;
};

const hashScopedFile = async (
  openFile: () => Promise<FileHandle>,
): Promise<string> => {
  const handle = await openFile();
  try {
    return await hashFileHandle(handle);
  } finally {
    await handle.close();
  }
};

export async function hashRunArtifact(
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<PipelineArtifact> {
  return {
    scope: 'run',
    path: relativePath,
    sha256: await hashScopedFile(async () => await openExistingRunFile(
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

export async function verifyOutputArtifact(
  outputDirectory: OutputDirectoryScope,
  artifact: PipelineArtifact,
): Promise<boolean> {
  requireArtifactScope(artifact, 'output');
  try {
    const sha256 = await hashScopedFile(async () => await openExistingOutputFile(
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
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const {bytesRead} = await source.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
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
    position += bytesRead;
  }
};

export async function copyRunArtifact(input: {
  sourceRun: RunDirectoryScope;
  targetRun: RunDirectoryScope;
  artifact: PipelineArtifact;
}): Promise<PipelineArtifact> {
  requireArtifactScope(input.artifact, 'run');
  const parent = path.posix.dirname(input.artifact.path);
  if (parent !== '.') await ensureRunDirectory(input.targetRun, parent);

  let targetCreated = false;
  try {
    const source = await openExistingRunFile(
      input.sourceRun,
      input.artifact.path,
    );
    try {
      const target = await openNewRunFile(
        input.targetRun,
        input.artifact.path,
      );
      targetCreated = true;
      try {
        await copyFileHandles(source, target);
        await target.sync();
      } finally {
        await target.close();
      }
    } finally {
      await source.close();
    }
  } catch (error) {
    if (targetCreated) {
      await unlinkRunFile(input.targetRun, input.artifact.path)
        .catch(() => undefined);
    }
    throw error;
  }

  let copied: PipelineArtifact;
  try {
    copied = await hashRunArtifact(input.targetRun, input.artifact.path);
  } catch (error) {
    await unlinkRunFile(input.targetRun, input.artifact.path)
      .catch(() => undefined);
    throw error;
  }
  if (copied.sha256 !== input.artifact.sha256) {
    await unlinkRunFile(input.targetRun, input.artifact.path);
    throw new PipelineArtifactError(
      'ARTIFACT_HASH_MISMATCH',
      'copied Run artifact does not match its source report',
    );
  }
  return copied;
}
