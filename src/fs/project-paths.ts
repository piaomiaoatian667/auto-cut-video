import {constants} from 'node:fs';
import {lstat, open, realpath, type FileHandle} from 'node:fs/promises';
import path from 'node:path';

export class ProjectPathError extends Error {
  readonly code = 'ASSET_PATH_OUTSIDE_PROJECT';

  constructor(message: string) {
    super(message);
    this.name = 'ProjectPathError';
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const isAbsolutePath = (candidate: string): boolean =>
  path.isAbsolute(candidate) || path.win32.isAbsolute(candidate);

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

const assertRelativePath = (relativePath: string): void => {
  if (isAbsolutePath(relativePath)) {
    throw new ProjectPathError('absolute paths are not allowed');
  }
};

export async function resolveExistingProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  assertRelativePath(relativePath);
  const rootReal = await realpath(projectRoot);
  const targetReal = await realpath(path.resolve(rootReal, relativePath));
  if (!isWithin(rootReal, targetReal)) {
    throw new ProjectPathError(`path escapes project: ${relativePath}`);
  }
  return targetReal;
}

export async function resolveWritableProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<string> {
  assertRelativePath(relativePath);
  const rootReal = await realpath(projectRoot);
  const unresolvedTarget = path.resolve(rootReal, relativePath);
  const parentReal = await realpath(path.dirname(unresolvedTarget));
  if (!isWithin(rootReal, parentReal)) {
    throw new ProjectPathError(`path escapes project: ${relativePath}`);
  }

  const target = path.join(parentReal, path.basename(unresolvedTarget));
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new ProjectPathError(`writable target is a symlink: ${relativePath}`);
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
  return target;
}

export async function openNewProjectFile(
  projectRoot: string,
  relativePath: string,
): Promise<FileHandle> {
  const target = await resolveWritableProjectPath(projectRoot, relativePath);
  const flags = constants.O_WRONLY
    | constants.O_CREAT
    | constants.O_EXCL
    | constants.O_NOFOLLOW;
  return open(target, flags, 0o600);
}
