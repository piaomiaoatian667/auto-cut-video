import {constants, type Stats} from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {StableIdSchema} from '../domain/schema-primitives';
import {
  createOutputStoreWithAuthority,
  createRunStoreWithAuthority,
  type OutputStore,
  type RunStore,
  type RunStoreOptions,
} from '../pipeline/run-store';

const O_NOFOLLOW_ANY = 0x20000000;

export class AppDirectoryScopeError extends Error {
  readonly code = 'APP_PATH_OUTSIDE_SCOPE';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AppDirectoryScopeError';
  }
}

export class AppDirectoryPlatformError extends Error {
  readonly code = 'ENV_PLATFORM_UNSUPPORTED';

  constructor(readonly platform: NodeJS.Platform) {
    super(`safe app-owned file opening requires Darwin; received ${platform}`);
    this.name = 'AppDirectoryPlatformError';
  }
}

interface DirectoryIdentity {
  path: string;
  dev: number;
  ino: number;
}

interface ScopeState {
  root: string;
  ancestors: DirectoryIdentity[];
}

export type AppDirectoryEntryKind =
  | 'missing'
  | 'file'
  | 'directory'
  | 'symlink'
  | 'other';

const workStates = new WeakMap<WorkDirectoryScope, ScopeState>();
const runStates = new WeakMap<RunDirectoryScope, ScopeState>();
const outputStates = new WeakMap<OutputDirectoryScope, ScopeState>();

let mintWorkDirectoryScope!: () => WorkDirectoryScope;
let mintRunDirectoryScope!: () => RunDirectoryScope;
let mintOutputDirectoryScope!: () => OutputDirectoryScope;

export class WorkDirectoryScope {
  readonly #workDirectoryScopeBrand = undefined;

  private constructor() {
    Object.freeze(this);
  }

  static {
    mintWorkDirectoryScope = () => new WorkDirectoryScope();
  }
}

export class RunDirectoryScope {
  readonly #runDirectoryScopeBrand = undefined;

  private constructor() {
    Object.freeze(this);
  }

  static {
    mintRunDirectoryScope = () => new RunDirectoryScope();
  }
}

export class OutputDirectoryScope {
  readonly #outputDirectoryScopeBrand = undefined;

  private constructor() {
    Object.freeze(this);
  }

  static {
    mintOutputDirectoryScope = () => new OutputDirectoryScope();
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const assertDarwin = (): void => {
  if (process.platform !== 'darwin') {
    throw new AppDirectoryPlatformError(process.platform);
  }
};

const securityError = (
  message: string,
  cause?: unknown,
): AppDirectoryScopeError => new AppDirectoryScopeError(
  message,
  cause === undefined ? undefined : {cause},
);

const mapSymlinkError = (error: unknown, relativePath: string): never => {
  if (
    isNodeError(error)
    && (error.code === 'ELOOP' || error.code === 'ENOTDIR')
  ) {
    throw securityError(`path changed or contains a symlink: ${relativePath}`, error);
  }
  throw error;
};

const isWithin = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
};

const parseRelativePath = (
  relativePath: string,
  allowRoot = false,
): string[] => {
  if (
    typeof relativePath !== 'string'
    || relativePath.includes('\0')
    || relativePath.includes('\\')
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
  ) {
    throw securityError(`invalid app-owned relative path: ${String(relativePath)}`);
  }
  if (allowRoot && (relativePath === '' || relativePath === '.')) return [];
  const segments = relativePath.split('/');
  if (
    segments.length === 0
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw securityError(`invalid app-owned relative path: ${relativePath}`);
  }
  return segments;
};

const identityFromStats = (
  canonicalPath: string,
  stats: Stats,
): DirectoryIdentity => ({
  path: canonicalPath,
  dev: stats.dev,
  ino: stats.ino,
});

const inspectPlainDirectory = async (
  canonicalPath: string,
  label: string,
): Promise<DirectoryIdentity> => {
  try {
    const stats = await lstat(canonicalPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw securityError(`${label} must be a plain directory`);
    }
    const resolved = await realpath(canonicalPath);
    if (resolved !== canonicalPath) {
      throw securityError(`${label} must not be redirected`);
    }
    return identityFromStats(canonicalPath, stats);
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, label);
  }
};

const ensurePlainDirectory = async (
  parent: string,
  name: string,
  options: {exclusive?: boolean} = {},
): Promise<DirectoryIdentity> => {
  const target = path.join(parent, name);
  try {
    if (options.exclusive) {
      await mkdir(target, {mode: 0o700});
    } else {
      try {
        await mkdir(target, {mode: 0o700});
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }
    }
    return await inspectPlainDirectory(target, target);
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    if (isNodeError(error) && error.code === 'EEXIST') {
      const stats = await lstat(target).catch(() => undefined);
      if (stats?.isSymbolicLink() || (stats !== undefined && !stats.isDirectory())) {
        throw securityError(`app-owned directory is not a plain directory: ${target}`);
      }
    }
    return mapSymlinkError(error, target);
  }
};

const createWorkspaceState = async (workspaceRoot: string): Promise<DirectoryIdentity> => {
  assertDarwin();
  const canonicalWorkspace = await realpath(workspaceRoot);
  return await inspectPlainDirectory(canonicalWorkspace, 'workspace root');
};

const stateFor = <T extends object>(
  states: WeakMap<T, ScopeState>,
  scope: T,
  name: string,
): ScopeState => {
  const state = states.get(scope);
  if (!state) throw new TypeError(`invalid ${name}`);
  return state;
};

const assertScopeStable = async (
  state: ScopeState,
  relativePath: string,
): Promise<void> => {
  try {
    for (const identity of state.ancestors) {
      const stats = await lstat(identity.path);
      if (
        stats.isSymbolicLink()
        || !stats.isDirectory()
        || stats.dev !== identity.dev
        || stats.ino !== identity.ino
        || await realpath(identity.path) !== identity.path
      ) {
        throw securityError(`app-owned scope changed after creation: ${relativePath}`);
      }
    }
    const workspace = state.ancestors[0]!;
    if (!isWithin(workspace.path, state.root) || state.root === workspace.path) {
      throw securityError(`app-owned scope escapes workspace: ${relativePath}`);
    }
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw securityError(`app-owned scope disappeared: ${relativePath}`, error);
    }
    return mapSymlinkError(error, relativePath);
  }
};

const createWorkScope = async (
  workspaceRoot: string,
  projectId: string,
): Promise<WorkDirectoryScope> => {
  const validatedProjectId = StableIdSchema.parse(projectId);
  const workspace = await createWorkspaceState(workspaceRoot);
  const workContainer = await ensurePlainDirectory(workspace.path, '.work');
  const workRoot = await ensurePlainDirectory(workContainer.path, validatedProjectId);
  const scope = mintWorkDirectoryScope();
  workStates.set(scope, {
    root: workRoot.path,
    ancestors: [workspace, workContainer, workRoot],
  });
  return scope;
};

export const createWorkDirectoryScope = async (
  workspaceRoot: string,
  projectId: string,
): Promise<WorkDirectoryScope> => await createWorkScope(workspaceRoot, projectId);

const mintRunScope = async (
  workspaceRoot: string,
  projectId: string,
  runId: string,
  mode: 'create' | 'existing',
): Promise<RunDirectoryScope> => {
  const validatedRunId = StableIdSchema.parse(runId);
  const work = await createWorkScope(workspaceRoot, projectId);
  const workState = stateFor(workStates, work, 'WorkDirectoryScope');
  await assertScopeStable(workState, `runs/${validatedRunId}`);
  const runsRoot = await ensurePlainDirectory(workState.root, 'runs');
  const runRoot = mode === 'create'
    ? await ensurePlainDirectory(runsRoot.path, validatedRunId, {exclusive: true})
    : await inspectPlainDirectory(
      path.join(runsRoot.path, validatedRunId),
      `runs/${validatedRunId}`,
    );
  const scope = mintRunDirectoryScope();
  runStates.set(scope, {
    root: runRoot.path,
    ancestors: [...workState.ancestors, runsRoot, runRoot],
  });
  return scope;
};

const mintOutputScope = async (
  workspaceRoot: string,
  projectId: string,
): Promise<OutputDirectoryScope> => {
  const validatedProjectId = StableIdSchema.parse(projectId);
  const workspace = await createWorkspaceState(workspaceRoot);
  const outputContainer = await ensurePlainDirectory(workspace.path, 'output');
  const outputRoot = await ensurePlainDirectory(outputContainer.path, validatedProjectId);
  const scope = mintOutputDirectoryScope();
  outputStates.set(scope, {
    root: outputRoot.path,
    ancestors: [workspace, outputContainer, outputRoot],
  });
  return scope;
};

const openOutputRelease = async (
  workspaceRoot: string,
  projectId: string,
  runId: string,
): Promise<OutputDirectoryScope> => {
  const validatedRunId = StableIdSchema.parse(runId);
  const scope = await mintOutputScope(workspaceRoot, projectId);
  const state = stateFor(outputStates, scope, 'OutputDirectoryScope');
  await assertScopeStable(state, `releases/${validatedRunId}`);
  const releases = await inspectPlainDirectory(
    path.join(state.root, 'releases'),
    'output releases directory',
  );
  const release = await inspectPlainDirectory(
    path.join(releases.path, validatedRunId),
    `release ${validatedRunId}`,
  );
  if (!isWithin(state.root, release.path)) {
    throw securityError(`release escapes Output scope: ${validatedRunId}`);
  }
  return scope;
};

const ensureScopedDirectory = async (
  state: ScopeState,
  relativePath: string,
  exclusiveFinal = false,
): Promise<void> => {
  const segments = parseRelativePath(relativePath);
  await assertScopeStable(state, relativePath);
  let parent = state.root;
  for (const [index, segment] of segments.entries()) {
    const identity = await ensurePlainDirectory(parent, segment, {
      exclusive: exclusiveFinal && index === segments.length - 1,
    });
    if (!isWithin(state.root, identity.path)) {
      throw securityError(`directory escapes app-owned scope: ${relativePath}`);
    }
    parent = identity.path;
  }
  await assertScopeStable(state, relativePath);
};

export const ensureRunDirectory = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<void> => await ensureScopedDirectory(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
);

export const ensureOutputDirectory = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<void> => await ensureScopedDirectory(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  relativePath,
);

const canonicalExistingTarget = async (
  state: ScopeState,
  relativePath: string,
): Promise<string> => {
  const segments = parseRelativePath(relativePath);
  await assertScopeStable(state, relativePath);
  const unresolved = path.join(state.root, ...segments);
  try {
    const unresolvedStats = await lstat(unresolved);
    if (unresolvedStats.isSymbolicLink()) {
      throw securityError(`app-owned target is a symlink: ${relativePath}`);
    }
    const target = await realpath(unresolved);
    if (!isWithin(state.root, target)) {
      throw securityError(`path escapes app-owned scope: ${relativePath}`);
    }
    await assertScopeStable(state, relativePath);
    return target;
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, relativePath);
  }
};

const canonicalWritableTarget = async (
  state: ScopeState,
  relativePath: string,
): Promise<string> => {
  const segments = parseRelativePath(relativePath);
  await assertScopeStable(state, relativePath);
  const unresolved = path.join(state.root, ...segments);
  try {
    const parent = await realpath(path.dirname(unresolved));
    if (!isWithin(state.root, parent)) {
      throw securityError(`path escapes app-owned scope: ${relativePath}`);
    }
    const target = path.join(parent, path.basename(unresolved));
    try {
      if ((await lstat(target)).isSymbolicLink()) {
        throw securityError(`app-owned target is a symlink: ${relativePath}`);
      }
    } catch (error) {
      if (error instanceof AppDirectoryScopeError) throw error;
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        return mapSymlinkError(error, relativePath);
      }
    }
    await assertScopeStable(state, relativePath);
    return target;
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, relativePath);
  }
};

const openExistingScopedFile = async (
  state: ScopeState,
  relativePath: string,
): Promise<FileHandle> => {
  assertDarwin();
  const target = await canonicalExistingTarget(state, relativePath);
  try {
    return await open(target, constants.O_RDONLY | O_NOFOLLOW_ANY);
  } catch (error) {
    return mapSymlinkError(error, relativePath);
  }
};

const openNewScopedFile = async (
  state: ScopeState,
  relativePath: string,
  access: 'write-only' | 'read-write',
): Promise<FileHandle> => {
  assertDarwin();
  const target = await canonicalWritableTarget(state, relativePath);
  const accessFlag = access === 'write-only' ? constants.O_WRONLY : constants.O_RDWR;
  try {
    return await open(
      target,
      accessFlag | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY,
      0o600,
    );
  } catch (error) {
    return mapSymlinkError(error, relativePath);
  }
};

export const openExistingWorkFile = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openExistingScopedFile(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

export const openNewWorkFile = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openNewScopedFile(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
  'write-only',
);

export const openExistingRunFile = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openExistingScopedFile(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
);

export const openNewRunFile = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openNewScopedFile(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
  'write-only',
);

export const openNewRunReadWriteFile = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openNewScopedFile(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
  'read-write',
);

export const openExistingOutputFile = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openExistingScopedFile(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  relativePath,
);

export const openNewOutputFile = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openNewScopedFile(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  relativePath,
  'write-only',
);

export const openNewOutputReadWriteFile = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openNewScopedFile(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  relativePath,
  'read-write',
);

const inspectScopedEntry = async (
  state: ScopeState,
  relativePath: string,
): Promise<AppDirectoryEntryKind> => {
  const segments = parseRelativePath(relativePath);
  await assertScopeStable(state, relativePath);
  const unresolved = path.join(state.root, ...segments);
  try {
    const parent = await realpath(path.dirname(unresolved));
    if (!isWithin(state.root, parent)) {
      throw securityError(`path escapes app-owned scope: ${relativePath}`);
    }
    const stats = await lstat(path.join(parent, path.basename(unresolved)));
    if (stats.isSymbolicLink()) return 'symlink';
    if (stats.isFile()) return 'file';
    if (stats.isDirectory()) return 'directory';
    return 'other';
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return 'missing';
    return mapSymlinkError(error, relativePath);
  }
};

const unlinkScopedFile = async (
  state: ScopeState,
  relativePath: string,
): Promise<void> => {
  const kind = await inspectScopedEntry(state, relativePath);
  if (kind === 'missing') return;
  if (kind !== 'file') {
    throw securityError(`refusing to unlink non-file app entry: ${relativePath}`);
  }
  const target = await canonicalExistingTarget(state, relativePath);
  await unlink(target);
};

const renameScopedFile = async (
  state: ScopeState,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => {
  if (await inspectScopedEntry(state, sourceRelativePath) !== 'file') {
    throw securityError(`rename source must be a regular file: ${sourceRelativePath}`);
  }
  const targetKind = await inspectScopedEntry(state, targetRelativePath);
  if (targetKind !== 'missing' && targetKind !== 'file') {
    throw securityError(`rename target must be absent or regular: ${targetRelativePath}`);
  }
  const source = await canonicalExistingTarget(state, sourceRelativePath);
  const target = await canonicalWritableTarget(state, targetRelativePath);
  await rename(source, target);
};

const linkScopedFile = async (
  state: ScopeState,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => {
  if (await inspectScopedEntry(state, sourceRelativePath) !== 'file') {
    throw securityError(`link source must be a regular file: ${sourceRelativePath}`);
  }
  if (await inspectScopedEntry(state, targetRelativePath) !== 'missing') {
    throw securityError(`link target must be absent: ${targetRelativePath}`);
  }
  const source = await canonicalExistingTarget(state, sourceRelativePath);
  const target = await canonicalWritableTarget(state, targetRelativePath);
  await link(source, target);
};

const syncScopedDirectory = async (
  state: ScopeState,
  relativePath = '.',
): Promise<void> => {
  const segments = parseRelativePath(relativePath, true);
  await assertScopeStable(state, relativePath);
  const unresolved = path.join(state.root, ...segments);
  const target = await realpath(unresolved);
  if (!isWithin(state.root, target)) {
    throw securityError(`directory escapes app-owned scope: ${relativePath}`);
  }
  const stats = await lstat(target);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw securityError(`directory sync target is not plain: ${relativePath}`);
  }
  const handle = await open(target, constants.O_RDONLY | O_NOFOLLOW_ANY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const inspectWorkEntry = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<AppDirectoryEntryKind> => await inspectScopedEntry(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

const inspectOutputEntry = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<AppDirectoryEntryKind> => await inspectScopedEntry(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  relativePath,
);

export const unlinkWorkFile = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<void> => await unlinkScopedFile(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

const unlinkOutputFile = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<void> => await unlinkScopedFile(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  relativePath,
);

const renameWorkFile = async (
  scope: WorkDirectoryScope,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => await renameScopedFile(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  sourceRelativePath,
  targetRelativePath,
);

const renameOutputFile = async (
  scope: OutputDirectoryScope,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => await renameScopedFile(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  sourceRelativePath,
  targetRelativePath,
);

const linkWorkFile = async (
  scope: WorkDirectoryScope,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => await linkScopedFile(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  sourceRelativePath,
  targetRelativePath,
);

const linkOutputFile = async (
  scope: OutputDirectoryScope,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => await linkScopedFile(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  sourceRelativePath,
  targetRelativePath,
);

const syncWorkDirectory = async (
  scope: WorkDirectoryScope,
  relativePath = '.',
): Promise<void> => await syncScopedDirectory(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

const syncOutputDirectory = async (
  scope: OutputDirectoryScope,
  relativePath = '.',
): Promise<void> => await syncScopedDirectory(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
  relativePath,
);

export const createRunStore = (
  workspaceRoot: string,
  options: RunStoreOptions = {},
): RunStore =>
  createRunStoreWithAuthority({
    createWork: async (projectId) => await createWorkScope(workspaceRoot, projectId),
    createRun: async (projectId, runId) => await mintRunScope(
      workspaceRoot,
      projectId,
      runId,
      'create',
    ),
    openExistingRun: async (projectId, runId) => await mintRunScope(
      workspaceRoot,
      projectId,
      runId,
      'existing',
    ),
    workPointer: {
      inspect: inspectWorkEntry,
      openExisting: openExistingWorkFile,
      openNew: openNewWorkFile,
      unlink: unlinkWorkFile,
      rename: renameWorkFile,
      link: linkWorkFile,
      syncDirectory: syncWorkDirectory,
    },
  }, options);

export const createOutputStore = (
  workspaceRoot: string,
  options: RunStoreOptions = {},
): OutputStore =>
  createOutputStoreWithAuthority({
    openProject: async (projectId) => await mintOutputScope(workspaceRoot, projectId),
    createRelease: async (projectId, runId) => {
      const validatedRunId = StableIdSchema.parse(runId);
      const scope = await mintOutputScope(workspaceRoot, projectId);
      const state = stateFor(outputStates, scope, 'OutputDirectoryScope');
      await ensureScopedDirectory(state, 'releases');
      await ensureScopedDirectory(state, `releases/${validatedRunId}`, true);
      return scope;
    },
    openRelease: async (projectId, runId) => await openOutputRelease(
      workspaceRoot,
      projectId,
      runId,
    ),
    outputPointer: {
      inspect: inspectOutputEntry,
      openExisting: openExistingOutputFile,
      openNew: openNewOutputFile,
      unlink: unlinkOutputFile,
      rename: renameOutputFile,
      link: linkOutputFile,
      syncDirectory: syncOutputDirectory,
    },
  }, options);
