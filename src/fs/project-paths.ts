import {constants} from 'node:fs';
import {lstat, open, realpath, type FileHandle} from 'node:fs/promises';
import path from 'node:path';

const O_NOFOLLOW_ANY = 0x20000000;

export class ProjectPathError extends Error {
  readonly code = 'ASSET_PATH_OUTSIDE_PROJECT';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectPathError';
  }
}

export class ProjectPathPlatformError extends Error {
  readonly code = 'ENV_PLATFORM_UNSUPPORTED';

  constructor(readonly platform: NodeJS.Platform) {
    super(`safe project file opening requires Darwin; received ${platform}`);
    this.name = 'ProjectPathPlatformError';
  }
}

export interface PreparedProjectFile {
  open(): Promise<FileHandle>;
}

interface ProjectDirectoryState {
  canonicalProjectRoot: string;
}

const projectDirectoryStates = new WeakMap<
  ProjectDirectoryScope,
  ProjectDirectoryState
>();

export class ProjectDirectoryScope {
  private constructor() {
    Object.freeze(this);
  }

  static async create(
    workspaceRoot: string,
    projectRelativeRoot: string,
  ): Promise<ProjectDirectoryScope> {
    assertDarwin();
    assertRelativePath(projectRelativeRoot);
    if (projectRelativeRoot.length === 0 || projectRelativeRoot === '.') {
      throw new ProjectPathError('project directory must be below the workspace root');
    }

    try {
      const workspaceRootReal = await realpath(workspaceRoot);
      const projectRootReal = await realpath(path.resolve(
        workspaceRootReal,
        projectRelativeRoot,
      ));
      if (
        projectRootReal === workspaceRootReal
        || !isWithin(workspaceRootReal, projectRootReal)
      ) {
        throw new ProjectPathError(
          `project directory escapes workspace: ${projectRelativeRoot}`,
        );
      }

      const scope = new ProjectDirectoryScope();
      projectDirectoryStates.set(scope, {canonicalProjectRoot: projectRootReal});
      return scope;
    } catch (error) {
      if (error instanceof ProjectPathError) throw error;
      return mapSymlinkLoop(error, projectRelativeRoot);
    }
  }
}

export const createProjectDirectoryScope = async (
  workspaceRoot: string,
  projectRelativeRoot: string,
): Promise<ProjectDirectoryScope> =>
  await ProjectDirectoryScope.create(workspaceRoot, projectRelativeRoot);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const assertDarwin = (): void => {
  if (process.platform !== 'darwin') {
    throw new ProjectPathPlatformError(process.platform);
  }
};

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

const canonicalProjectRoot = (scope: ProjectDirectoryScope): string => {
  const state = projectDirectoryStates.get(scope);
  if (!state) throw new TypeError('invalid ProjectDirectoryScope');
  return state.canonicalProjectRoot;
};

const assertCanonicalProjectRootStable = async (
  scope: ProjectDirectoryScope,
  relativePath: string,
): Promise<string> => {
  const savedProjectRoot = canonicalProjectRoot(scope);
  try {
    const currentProjectRoot = await realpath(savedProjectRoot);
    if (currentProjectRoot !== savedProjectRoot) {
      throw new ProjectPathError(
        `project directory changed after scope creation: ${relativePath}`,
      );
    }
    return savedProjectRoot;
  } catch (error) {
    if (error instanceof ProjectPathError) throw error;
    return mapSymlinkLoop(error, relativePath);
  }
};

const mapSymlinkLoop = (error: unknown, relativePath: string): never => {
  if (isNodeError(error) && error.code === 'ELOOP') {
    throw new ProjectPathError(
      `path contains a symlink at open time: ${relativePath}`,
      {cause: error},
    );
  }
  throw error;
};

const canonicalizeExistingTarget = async (
  scope: ProjectDirectoryScope,
  relativePath: string,
): Promise<string> => {
  assertRelativePath(relativePath);
  try {
    const projectRoot = await assertCanonicalProjectRootStable(scope, relativePath);
    const targetReal = await realpath(path.resolve(projectRoot, relativePath));
    if (!isWithin(projectRoot, targetReal)) {
      throw new ProjectPathError(`path escapes project: ${relativePath}`);
    }
    return targetReal;
  } catch (error) {
    if (error instanceof ProjectPathError) throw error;
    return mapSymlinkLoop(error, relativePath);
  }
};

const canonicalizeWritableTarget = async (
  scope: ProjectDirectoryScope,
  relativePath: string,
): Promise<string> => {
  assertRelativePath(relativePath);
  try {
    const projectRoot = await assertCanonicalProjectRootStable(scope, relativePath);
    const unresolvedTarget = path.resolve(projectRoot, relativePath);
    const parentReal = await realpath(path.dirname(unresolvedTarget));
    if (!isWithin(projectRoot, parentReal)) {
      throw new ProjectPathError(`path escapes project: ${relativePath}`);
    }

    const target = path.join(parentReal, path.basename(unresolvedTarget));
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw new ProjectPathError(`writable target is a symlink: ${relativePath}`);
      }
    } catch (error) {
      if (error instanceof ProjectPathError) throw error;
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        return mapSymlinkLoop(error, relativePath);
      }
    }
    return target;
  } catch (error) {
    if (error instanceof ProjectPathError) throw error;
    return mapSymlinkLoop(error, relativePath);
  }
};

class PreparedExistingProjectFile implements PreparedProjectFile {
  readonly #target: string;
  readonly #relativePath: string;

  constructor(target: string, relativePath: string) {
    this.#target = target;
    this.#relativePath = relativePath;
  }

  async open(): Promise<FileHandle> {
    assertDarwin();
    try {
      return await open(this.#target, constants.O_RDONLY | O_NOFOLLOW_ANY);
    } catch (error) {
      return mapSymlinkLoop(error, this.#relativePath);
    }
  }
}

class PreparedNewProjectFile implements PreparedProjectFile {
  readonly #target: string;
  readonly #relativePath: string;

  constructor(target: string, relativePath: string) {
    this.#target = target;
    this.#relativePath = relativePath;
  }

  async open(): Promise<FileHandle> {
    assertDarwin();
    const flags = constants.O_WRONLY
      | constants.O_CREAT
      | constants.O_EXCL
      | O_NOFOLLOW_ANY;
    try {
      return await open(this.#target, flags, 0o600);
    } catch (error) {
      return mapSymlinkLoop(error, this.#relativePath);
    }
  }
}

export async function prepareExistingProjectFile(
  scope: ProjectDirectoryScope,
  relativePath: string,
): Promise<PreparedProjectFile> {
  assertDarwin();
  return new PreparedExistingProjectFile(
    await canonicalizeExistingTarget(scope, relativePath),
    relativePath,
  );
}

export async function openExistingProjectFile(
  scope: ProjectDirectoryScope,
  relativePath: string,
): Promise<FileHandle> {
  return (await prepareExistingProjectFile(scope, relativePath)).open();
}

export async function prepareNewProjectFile(
  scope: ProjectDirectoryScope,
  relativePath: string,
): Promise<PreparedProjectFile> {
  assertDarwin();
  return new PreparedNewProjectFile(
    await canonicalizeWritableTarget(scope, relativePath),
    relativePath,
  );
}

export async function openNewProjectFile(
  scope: ProjectDirectoryScope,
  relativePath: string,
): Promise<FileHandle> {
  return (await prepareNewProjectFile(scope, relativePath)).open();
}
