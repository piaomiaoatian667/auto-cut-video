import {
  constants,
  lstatSync,
  realpathSync,
  type BigIntStats,
} from 'node:fs';
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
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

interface ScopeState {
  root: string;
  ancestors: DirectoryIdentity[];
}

interface DirectoryAnchor {
  identity: DirectoryIdentity;
  handle: FileHandle;
  volumePath: string;
}

export type AppDirectoryEntryKind =
  | 'missing'
  | 'file'
  | 'directory'
  | 'symlink'
  | 'other';

export interface AppDirectoryReadFileAuthority {
  readonly handle: FileHandle;
  revalidate(): Promise<void>;
  close(): Promise<void>;
}

export interface AppDirectoryWriteFileAuthority {
  readonly handle: FileHandle;
  syncAndSeal(): Promise<void>;
  openForRead(): Promise<AppDirectoryReadFileAuthority>;
  revalidate(): Promise<void>;
  unlink(): Promise<void>;
  close(): Promise<void>;
}

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
  stats: BigIntStats,
): DirectoryIdentity => Object.freeze({
  path: canonicalPath,
  dev: stats.dev,
  ino: stats.ino,
});

const identityMatchesStats = (
  identity: DirectoryIdentity,
  stats: BigIntStats,
): boolean => stats.dev === identity.dev && stats.ino === identity.ino;

interface RegularFileIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

const regularFileIdentity = (stats: BigIntStats): RegularFileIdentity => ({
  dev: stats.dev,
  ino: stats.ino,
  nlink: stats.nlink,
  size: stats.size,
  mtimeNs: stats.mtimeNs,
  ctimeNs: stats.ctimeNs,
});

const regularFileIdentityMatches = (
  stats: BigIntStats,
  identity: RegularFileIdentity,
): boolean => (
  stats.isFile()
  && stats.dev === identity.dev
  && stats.ino === identity.ino
  && stats.nlink === identity.nlink
  && stats.size === identity.size
  && stats.mtimeNs === identity.mtimeNs
  && stats.ctimeNs === identity.ctimeNs
);

const sameRegularFileObject = (
  stats: BigIntStats,
  identity: RegularFileIdentity,
): boolean => (
  stats.isFile()
  && stats.dev === identity.dev
  && stats.ino === identity.ino
  && stats.nlink === identity.nlink
);

const volumePath = (dev: bigint, ino: bigint): string =>
  path.join('/.vol', String(dev), String(ino));

const assertDirectoryIdentityStable = async (
  identity: DirectoryIdentity,
  label: string,
): Promise<void> => {
  try {
    const stats = await lstat(identity.path, {bigint: true});
    if (
      stats.isSymbolicLink()
      || !stats.isDirectory()
      || !identityMatchesStats(identity, stats)
      || await realpath(identity.path) !== identity.path
    ) {
      throw securityError(`app-owned directory changed after validation: ${label}`);
    }
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw securityError(`app-owned directory disappeared: ${label}`, error);
    }
    return mapSymlinkError(error, label);
  }
};

const openDirectoryAnchor = async (
  identity: DirectoryIdentity,
  label: string,
): Promise<DirectoryAnchor> => {
  await assertDirectoryIdentityStable(identity, label);
  const handle = await open(identity.path, constants.O_RDONLY | O_NOFOLLOW_ANY);
  try {
    const stats = await handle.stat({bigint: true});
    if (!stats.isDirectory() || !identityMatchesStats(identity, stats)) {
      throw securityError(`app-owned directory changed while opening: ${label}`);
    }
    const anchoredPath = volumePath(identity.dev, identity.ino);
    const anchoredStats = await lstat(anchoredPath, {bigint: true});
    if (!anchoredStats.isDirectory() || !identityMatchesStats(identity, anchoredStats)) {
      throw securityError(`Darwin directory anchor changed: ${label}`);
    }
    return {identity, handle, volumePath: anchoredPath};
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, label);
  }
};

const closeDirectoryAnchor = async (anchor: DirectoryAnchor): Promise<void> => {
  await anchor.handle.close();
};

const closeDirectoryAnchors = async (
  anchors: readonly DirectoryAnchor[],
): Promise<void> => {
  const errors: unknown[] = [];
  for (const anchor of [...anchors].reverse()) {
    try {
      await closeDirectoryAnchor(anchor);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'failed to close scoped directory authorities');
  }
};

const inspectPlainDirectory = (
  canonicalPath: string,
  label: string,
): DirectoryIdentity => {
  try {
    const stats = lstatSync(canonicalPath, {bigint: true});
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw securityError(`${label} must be a plain directory`);
    }
    const resolved = realpathSync(canonicalPath);
    if (resolved !== canonicalPath) {
      throw securityError(`${label} must not be redirected`);
    }
    return identityFromStats(canonicalPath, stats);
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, label);
  }
};

const inspectPlainChildDirectory = async (
  parent: DirectoryIdentity,
  name: string,
  label: string,
): Promise<DirectoryIdentity> => {
  const anchor = await openDirectoryAnchor(parent, label);
  try {
    const target = path.join(anchor.volumePath, name);
    const stats = await lstat(target, {bigint: true});
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw securityError(`${label} must be a plain directory`);
    }
    const identity = identityFromStats(path.join(parent.path, name), stats);
    await assertDirectoryIdentityStable(parent, label);
    await assertDirectoryIdentityStable(identity, label);
    return identity;
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, label);
  } finally {
    await closeDirectoryAnchor(anchor);
  }
};

const ensurePlainDirectory = async (
  parent: DirectoryIdentity,
  name: string,
  options: {exclusive?: boolean} = {},
): Promise<DirectoryIdentity> => {
  const anchor = await openDirectoryAnchor(parent, name);
  const target = path.join(anchor.volumePath, name);
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
    await assertDirectoryIdentityStable(parent, name);
    const stats = await lstat(target, {bigint: true});
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw securityError(`app-owned directory is not a plain directory: ${name}`);
    }
    const identity = identityFromStats(path.join(parent.path, name), stats);
    await assertDirectoryIdentityStable(identity, name);
    return identity;
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    if (isNodeError(error) && error.code === 'EEXIST') {
      const stats = await lstat(target, {bigint: true}).catch(() => undefined);
      if (stats?.isSymbolicLink() || (stats !== undefined && !stats.isDirectory())) {
        throw securityError(`app-owned directory is not a plain directory: ${target}`);
      }
    }
    return mapSymlinkError(error, name);
  } finally {
    await closeDirectoryAnchor(anchor);
  }
};

const createWorkspaceState = (workspaceRoot: string): DirectoryIdentity => {
  assertDarwin();
  const canonicalWorkspace = realpathSync(workspaceRoot);
  return inspectPlainDirectory(canonicalWorkspace, 'workspace root');
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
      const stats = await lstat(identity.path, {bigint: true});
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
  workspace: DirectoryIdentity,
  projectId: string,
): Promise<WorkDirectoryScope> => {
  const validatedProjectId = StableIdSchema.parse(projectId);
  await assertDirectoryIdentityStable(workspace, 'workspace root');
  const workContainer = await ensurePlainDirectory(workspace, '.work');
  const workRoot = await ensurePlainDirectory(workContainer, validatedProjectId);
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
): Promise<WorkDirectoryScope> => await createWorkScope(
  createWorkspaceState(workspaceRoot),
  projectId,
);

const mintRunScope = async (
  workspace: DirectoryIdentity,
  projectId: string,
  runId: string,
  mode: 'create' | 'existing',
): Promise<RunDirectoryScope> => {
  const validatedRunId = StableIdSchema.parse(runId);
  const work = await createWorkScope(workspace, projectId);
  const workState = stateFor(workStates, work, 'WorkDirectoryScope');
  await assertScopeStable(workState, `runs/${validatedRunId}`);
  const workRoot = workState.ancestors.at(-1)!;
  const runsRoot = await ensurePlainDirectory(workRoot, 'runs');
  const runRoot = mode === 'create'
    ? await ensurePlainDirectory(runsRoot, validatedRunId, {exclusive: true})
    : await inspectPlainChildDirectory(
      runsRoot,
      validatedRunId,
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
  workspace: DirectoryIdentity,
  projectId: string,
): Promise<OutputDirectoryScope> => {
  const validatedProjectId = StableIdSchema.parse(projectId);
  await assertDirectoryIdentityStable(workspace, 'workspace root');
  const outputContainer = await ensurePlainDirectory(workspace, 'output');
  const outputRoot = await ensurePlainDirectory(outputContainer, validatedProjectId);
  const scope = mintOutputDirectoryScope();
  outputStates.set(scope, {
    root: outputRoot.path,
    ancestors: [workspace, outputContainer, outputRoot],
  });
  return scope;
};

const openOutputRelease = async (
  workspace: DirectoryIdentity,
  projectId: string,
  runId: string,
): Promise<OutputDirectoryScope> => {
  const validatedRunId = StableIdSchema.parse(runId);
  const scope = await mintOutputScope(workspace, projectId);
  const state = stateFor(outputStates, scope, 'OutputDirectoryScope');
  await assertScopeStable(state, `releases/${validatedRunId}`);
  const outputRoot = state.ancestors.at(-1)!;
  const releases = await inspectPlainChildDirectory(
    outputRoot,
    'releases',
    'output releases directory',
  );
  const release = await inspectPlainChildDirectory(
    releases,
    validatedRunId,
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
  let parent = state.ancestors.at(-1)!;
  for (const [index, segment] of segments.entries()) {
    const identity = await ensurePlainDirectory(parent, segment, {
      exclusive: exclusiveFinal && index === segments.length - 1,
    });
    if (!isWithin(state.root, identity.path)) {
      throw securityError(`directory escapes app-owned scope: ${relativePath}`);
    }
    parent = identity;
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
    const unresolvedStats = await lstat(unresolved, {bigint: true});
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
      if ((await lstat(target, {bigint: true})).isSymbolicLink()) {
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

const openExistingScopedReadFile = async (
  state: ScopeState,
  relativePath: string,
): Promise<AppDirectoryReadFileAuthority> => {
  assertDarwin();
  const pathAuthority = await openScopedReadPathAuthority(state, relativePath);
  const anchor = pathAuthority.finalEntry;
  let handle: FileHandle | undefined;
  let transferred = false;
  try {
    const inspected = await inspectAnchoredEntry(anchor, relativePath);
    if (inspected.kind !== 'file' && inspected.kind !== 'missing') {
      throw securityError(
        `app-owned read target is not a regular file: ${relativePath}`,
      );
    }
    await assertScopedReadPathStable(state, pathAuthority, relativePath);
    handle = await open(
      path.join(anchor.parent.volumePath, anchor.basename),
      constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
    );
    const opened = await handle.stat({bigint: true});
    if (
      inspected.kind !== 'file'
      || inspected.stats === undefined
      || !opened.isFile()
      || opened.dev !== inspected.stats.dev
      || opened.ino !== inspected.stats.ino
      || opened.nlink !== inspected.stats.nlink
      || opened.size !== inspected.stats.size
      || opened.mtimeNs !== inspected.stats.mtimeNs
      || opened.ctimeNs !== inspected.stats.ctimeNs
    ) {
      throw securityError(`app-owned read target changed while opening: ${relativePath}`);
    }
    const identity = regularFileIdentity(opened);
    const openedHandle = handle;
    const revalidate = async (): Promise<void> => {
      await assertScopedReadPathStable(state, pathAuthority, relativePath);
      const held = await openedHandle.stat({bigint: true});
      if (!regularFileIdentityMatches(held, identity)) {
        throw securityError(`app-owned read handle changed: ${relativePath}`);
      }
      const current = await inspectAnchoredEntry(anchor, relativePath);
      if (
        current.kind !== 'file'
        || current.stats === undefined
        || !regularFileIdentityMatches(current.stats, identity)
      ) {
        throw securityError(`app-owned read target changed after opening: ${relativePath}`);
      }
    };
    await revalidate();
    let closed = false;
    const result: AppDirectoryReadFileAuthority = {
      handle: openedHandle,
      revalidate,
      close: async () => {
        if (closed) return;
        closed = true;
        let fileCloseError: unknown;
        try {
          await openedHandle.close();
        } catch (error) {
          fileCloseError = error;
        }
        try {
          await closeDirectoryAnchors(pathAuthority.directories);
        } catch (directoryCloseError) {
          if (fileCloseError !== undefined) {
            throw new AggregateError(
              [fileCloseError, directoryCloseError],
              'failed to close scoped artifact read authority',
            );
          }
          throw directoryCloseError;
        }
        if (fileCloseError !== undefined) throw fileCloseError;
      },
    };
    handle = undefined;
    transferred = true;
    return result;
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, relativePath);
  } finally {
    if (!transferred) {
      try {
        if (handle !== undefined) await handle.close();
      } finally {
        await closeDirectoryAnchors(pathAuthority.directories);
      }
    }
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

const openExistingWorkFile = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<FileHandle> => await openExistingScopedFile(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

const openNewWorkFile = async (
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

export const openExistingRunFileForRead = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<AppDirectoryReadFileAuthority> => await openExistingScopedReadFile(
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

export const openNewRunFileForWrite = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<AppDirectoryWriteFileAuthority> => await openNewScopedWriteFileAuthority(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
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

export const openExistingOutputFileForRead = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<AppDirectoryReadFileAuthority> => await openExistingScopedReadFile(
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
    const stats = await lstat(
      path.join(parent, path.basename(unresolved)),
      {bigint: true},
    );
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

interface ScopedPathAnchor {
  parent: DirectoryAnchor;
  basename: string;
}

interface ScopedReadPathAuthority {
  directories: readonly DirectoryAnchor[];
  finalEntry: ScopedPathAnchor;
}

const openScopedReadPathAuthority = async (
  state: ScopeState,
  relativePath: string,
): Promise<ScopedReadPathAuthority> => {
  const segments = parseRelativePath(relativePath);
  await assertScopeStable(state, relativePath);
  const basename = segments.at(-1)!;
  const parentSegments = segments.slice(0, -1);
  const directories: DirectoryAnchor[] = [];
  try {
    let parent = await openDirectoryAnchor(
      state.ancestors.at(-1)!,
      relativePath,
    );
    directories.push(parent);
    for (const segment of parentSegments) {
      const childPath = path.join(parent.volumePath, segment);
      const childStats = await lstat(childPath, {bigint: true});
      if (childStats.isSymbolicLink() || !childStats.isDirectory()) {
        throw securityError(`app-owned parent is not a plain directory: ${relativePath}`);
      }
      const childIdentity = identityFromStats(
        path.join(parent.identity.path, segment),
        childStats,
      );
      if (!isWithin(state.root, childIdentity.path)) {
        throw securityError(`path escapes app-owned scope: ${relativePath}`);
      }
      await assertDirectoryIdentityStable(childIdentity, relativePath);
      parent = await openDirectoryAnchor(childIdentity, relativePath);
      directories.push(parent);
    }
    await assertScopeStable(state, relativePath);
    return {
      directories,
      finalEntry: {parent, basename},
    };
  } catch (error) {
    await closeDirectoryAnchors(directories).catch(() => undefined);
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, relativePath);
  }
};

const assertScopedReadPathStable = async (
  state: ScopeState,
  authority: ScopedReadPathAuthority,
  relativePath: string,
): Promise<void> => {
  await assertScopeStable(state, relativePath);
  for (const [index, directory] of authority.directories.entries()) {
    await assertDirectoryIdentityStable(directory.identity, relativePath);
    const held = await directory.handle.stat({bigint: true});
    if (!held.isDirectory() || !identityMatchesStats(directory.identity, held)) {
      throw securityError(`app-owned parent changed while held open: ${relativePath}`);
    }
    const anchored = await lstat(directory.volumePath, {bigint: true});
    if (!anchored.isDirectory() || !identityMatchesStats(directory.identity, anchored)) {
      throw securityError(`Darwin parent anchor changed: ${relativePath}`);
    }
    if (index > 0) {
      const parent = authority.directories[index - 1]!;
      const child = await lstat(
        path.join(parent.volumePath, path.basename(directory.identity.path)),
        {bigint: true},
      );
      if (!child.isDirectory() || !identityMatchesStats(directory.identity, child)) {
        throw securityError(`app-owned parent chain changed: ${relativePath}`);
      }
    }
  }
};

const openScopedPathAnchor = async (
  state: ScopeState,
  relativePath: string,
): Promise<ScopedPathAnchor> => {
  const segments = parseRelativePath(relativePath);
  await assertScopeStable(state, relativePath);
  const basename = segments.at(-1)!;
  const parentSegments = segments.slice(0, -1);
  const rootIdentity = state.ancestors.at(-1)!;
  let parent = await openDirectoryAnchor(rootIdentity, relativePath);
  try {
    for (const segment of parentSegments) {
      const childPath = path.join(parent.volumePath, segment);
      const childStats = await lstat(childPath, {bigint: true});
      if (childStats.isSymbolicLink() || !childStats.isDirectory()) {
        throw securityError(`app-owned parent is not a plain directory: ${relativePath}`);
      }
      const childIdentity = identityFromStats(
        path.join(parent.identity.path, segment),
        childStats,
      );
      if (!isWithin(state.root, childIdentity.path)) {
        throw securityError(`path escapes app-owned scope: ${relativePath}`);
      }
      await assertDirectoryIdentityStable(childIdentity, relativePath);
      const child = await openDirectoryAnchor(childIdentity, relativePath);
      await closeDirectoryAnchor(parent);
      parent = child;
    }
    await assertScopeStable(state, relativePath);
    return {parent, basename};
  } catch (error) {
    await closeDirectoryAnchor(parent).catch(() => undefined);
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, relativePath);
  }
};

const assertScopedPathAnchorStable = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  relativePath: string,
): Promise<void> => {
  await assertScopeStable(state, relativePath);
  await assertDirectoryIdentityStable(anchor.parent.identity, relativePath);
  const stats = await anchor.parent.handle.stat({bigint: true});
  if (!stats.isDirectory() || !identityMatchesStats(anchor.parent.identity, stats)) {
    throw securityError(`app-owned parent changed while held open: ${relativePath}`);
  }
  const anchoredStats = await lstat(anchor.parent.volumePath, {bigint: true});
  if (
    !anchoredStats.isDirectory()
    || !identityMatchesStats(anchor.parent.identity, anchoredStats)
  ) {
    throw securityError(`Darwin parent anchor changed: ${relativePath}`);
  }
};

const inspectAnchoredEntry = async (
  anchor: ScopedPathAnchor,
  relativePath: string,
): Promise<{kind: AppDirectoryEntryKind; stats?: BigIntStats}> => {
  try {
    const stats = await lstat(
      path.join(anchor.parent.volumePath, anchor.basename),
      {bigint: true},
    );
    if (stats.isSymbolicLink()) return {kind: 'symlink', stats};
    if (stats.isFile()) return {kind: 'file', stats};
    if (stats.isDirectory()) return {kind: 'directory', stats};
    return {kind: 'other', stats};
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return {kind: 'missing'};
    return mapSymlinkError(error, relativePath);
  }
};

const unlinkAnchoredCreatedFile = async (
  anchor: ScopedPathAnchor,
  identity: RegularFileIdentity,
  handle: FileHandle,
  relativePath: string,
): Promise<void> => {
  const current = await inspectAnchoredEntry(anchor, relativePath);
  if (current.kind === 'missing') {
    const held = await handle.stat({bigint: true});
    if (held.nlink === 0n) return;
    throw securityError(`created app-owned file moved before cleanup: ${relativePath}`);
  }
  if (
    current.kind !== 'file'
    || current.stats === undefined
    || !sameRegularFileObject(current.stats, identity)
  ) {
    throw securityError(`created app-owned file changed before cleanup: ${relativePath}`);
  }
  await unlink(path.join(anchor.parent.volumePath, anchor.basename));
  if ((await inspectAnchoredEntry(anchor, relativePath)).kind !== 'missing') {
    throw securityError(`created app-owned file remained after cleanup: ${relativePath}`);
  }
  const held = await handle.stat({bigint: true});
  if (held.nlink !== 0n) {
    throw securityError(`created app-owned file remains linked after cleanup: ${relativePath}`);
  }
};

const openNewScopedWriteFileAuthority = async (
  state: ScopeState,
  relativePath: string,
): Promise<AppDirectoryWriteFileAuthority> => {
  assertDarwin();
  const pathAuthority = await openScopedReadPathAuthority(state, relativePath);
  const anchor = pathAuthority.finalEntry;
  let handle: FileHandle | undefined;
  let createdIdentity: RegularFileIdentity | undefined;
  let transferred = false;
  try {
    await assertScopedReadPathStable(state, pathAuthority, relativePath);
    handle = await open(
      path.join(anchor.parent.volumePath, anchor.basename),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY,
      0o600,
    );
    const created = await handle.stat({bigint: true});
    if (!created.isFile() || created.nlink !== 1n) {
      throw securityError(`created app-owned target is not a regular file: ${relativePath}`);
    }
    createdIdentity = regularFileIdentity(created);
    const current = await inspectAnchoredEntry(anchor, relativePath);
    if (
      current.kind !== 'file'
      || current.stats === undefined
      || !regularFileIdentityMatches(current.stats, createdIdentity)
    ) {
      throw securityError(`created app-owned target changed while opening: ${relativePath}`);
    }

    const openedHandle = handle;
    const openedIdentity = createdIdentity;
    let sealedIdentity: RegularFileIdentity | undefined;
    const revalidate = async (): Promise<void> => {
      await assertScopedReadPathStable(state, pathAuthority, relativePath);
      const held = await openedHandle.stat({bigint: true});
      const currentTarget = await inspectAnchoredEntry(anchor, relativePath);
      const matches = sealedIdentity === undefined
        ? sameRegularFileObject(held, openedIdentity)
          && currentTarget.stats !== undefined
          && sameRegularFileObject(currentTarget.stats, openedIdentity)
        : regularFileIdentityMatches(held, sealedIdentity)
          && currentTarget.stats !== undefined
          && regularFileIdentityMatches(currentTarget.stats, sealedIdentity);
      if (currentTarget.kind !== 'file' || !matches) {
        throw securityError(`created app-owned target changed: ${relativePath}`);
      }
    };
    const syncAndSeal = async (): Promise<void> => {
      await openedHandle.sync();
      const held = await openedHandle.stat({bigint: true});
      if (!sameRegularFileObject(held, openedIdentity)) {
        throw securityError(`created app-owned target changed while writing: ${relativePath}`);
      }
      const identity = regularFileIdentity(held);
      await assertScopedReadPathStable(state, pathAuthority, relativePath);
      const currentTarget = await inspectAnchoredEntry(anchor, relativePath);
      if (
        currentTarget.kind !== 'file'
        || currentTarget.stats === undefined
        || !regularFileIdentityMatches(currentTarget.stats, identity)
      ) {
        throw securityError(`created app-owned target changed while syncing: ${relativePath}`);
      }
      sealedIdentity = identity;
    };
    const openForRead = async (): Promise<AppDirectoryReadFileAuthority> => {
      const expected = sealedIdentity;
      if (expected === undefined) {
        throw new TypeError('app-owned write authority must be sealed before reading');
      }
      await revalidate();
      let readHandle: FileHandle | undefined;
      try {
        readHandle = await open(
          path.join(anchor.parent.volumePath, anchor.basename),
          constants.O_RDONLY | constants.O_NONBLOCK | O_NOFOLLOW_ANY,
        );
        const opened = await readHandle.stat({bigint: true});
        if (!regularFileIdentityMatches(opened, expected)) {
          throw securityError(`created app-owned target changed while reopening: ${relativePath}`);
        }
        await revalidate();
        const freshHandle = readHandle;
        let closed = false;
        const result: AppDirectoryReadFileAuthority = {
          handle: freshHandle,
          revalidate: async () => {
            await revalidate();
            const held = await freshHandle.stat({bigint: true});
            if (!regularFileIdentityMatches(held, expected)) {
              throw securityError(`created app-owned read handle changed: ${relativePath}`);
            }
          },
          close: async () => {
            if (closed) return;
            closed = true;
            await freshHandle.close();
          },
        };
        readHandle = undefined;
        return result;
      } catch (error) {
        if (readHandle !== undefined) await readHandle.close().catch(() => undefined);
        if (error instanceof AppDirectoryScopeError) throw error;
        return mapSymlinkError(error, relativePath);
      }
    };
    let closed = false;
    const result: AppDirectoryWriteFileAuthority = {
      handle: openedHandle,
      syncAndSeal,
      openForRead,
      revalidate,
      unlink: async () => await unlinkAnchoredCreatedFile(
        anchor,
        openedIdentity,
        openedHandle,
        relativePath,
      ),
      close: async () => {
        if (closed) return;
        closed = true;
        let fileCloseError: unknown;
        try {
          await openedHandle.close();
        } catch (error) {
          fileCloseError = error;
        }
        try {
          await closeDirectoryAnchors(pathAuthority.directories);
        } catch (directoryCloseError) {
          if (fileCloseError !== undefined) {
            throw new AggregateError(
              [fileCloseError, directoryCloseError],
              'failed to close scoped artifact write authority',
            );
          }
          throw directoryCloseError;
        }
        if (fileCloseError !== undefined) throw fileCloseError;
      },
    };
    handle = undefined;
    createdIdentity = undefined;
    transferred = true;
    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (handle !== undefined && createdIdentity !== undefined) {
      try {
        await unlinkAnchoredCreatedFile(
          anchor,
          createdIdentity,
          handle,
          relativePath,
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `failed to create scoped write authority for ${relativePath}`,
        {cause: error},
      );
    }
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, relativePath);
  } finally {
    if (!transferred) {
      try {
        if (handle !== undefined) await handle.close();
      } finally {
        await closeDirectoryAnchors(pathAuthority.directories);
      }
    }
  }
};

const unlinkScopedFile = async (
  state: ScopeState,
  relativePath: string,
): Promise<void> => {
  const anchor = await openScopedPathAnchor(state, relativePath);
  try {
    const {kind} = await inspectAnchoredEntry(anchor, relativePath);
    if (kind === 'missing') return;
    if (kind !== 'file') {
      throw securityError(`refusing to unlink non-file app entry: ${relativePath}`);
    }
    await assertScopedPathAnchorStable(state, anchor, relativePath);
    await unlink(path.join(anchor.parent.volumePath, anchor.basename));
    await assertScopeStable(state, relativePath);
    await assertDirectoryIdentityStable(anchor.parent.identity, relativePath);
  } finally {
    await closeDirectoryAnchor(anchor.parent);
  }
};

const renameScopedFile = async (
  state: ScopeState,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => {
  const source = await openScopedPathAnchor(state, sourceRelativePath);
  let target: ScopedPathAnchor;
  try {
    target = await openScopedPathAnchor(state, targetRelativePath);
  } catch (error) {
    await closeDirectoryAnchor(source.parent).catch(() => undefined);
    throw error;
  }
  try {
    if ((await inspectAnchoredEntry(source, sourceRelativePath)).kind !== 'file') {
      throw securityError(`rename source must be a regular file: ${sourceRelativePath}`);
    }
    const targetKind = (await inspectAnchoredEntry(target, targetRelativePath)).kind;
    if (targetKind !== 'missing' && targetKind !== 'file') {
      throw securityError(`rename target must be absent or regular: ${targetRelativePath}`);
    }
    await assertScopedPathAnchorStable(state, source, sourceRelativePath);
    await assertScopedPathAnchorStable(state, target, targetRelativePath);
    await rename(
      path.join(source.parent.volumePath, source.basename),
      path.join(target.parent.volumePath, target.basename),
    );
    await assertScopeStable(state, sourceRelativePath);
    await assertDirectoryIdentityStable(source.parent.identity, sourceRelativePath);
    await assertDirectoryIdentityStable(target.parent.identity, targetRelativePath);
  } finally {
    await Promise.all([
      closeDirectoryAnchor(source.parent),
      closeDirectoryAnchor(target.parent),
    ]);
  }
};

const linkScopedFile = async (
  state: ScopeState,
  sourceRelativePath: string,
  targetRelativePath: string,
): Promise<void> => {
  const source = await openScopedPathAnchor(state, sourceRelativePath);
  let target: ScopedPathAnchor;
  try {
    target = await openScopedPathAnchor(state, targetRelativePath);
  } catch (error) {
    await closeDirectoryAnchor(source.parent).catch(() => undefined);
    throw error;
  }
  try {
    if ((await inspectAnchoredEntry(source, sourceRelativePath)).kind !== 'file') {
      throw securityError(`link source must be a regular file: ${sourceRelativePath}`);
    }
    if ((await inspectAnchoredEntry(target, targetRelativePath)).kind !== 'missing') {
      throw securityError(`link target must be absent: ${targetRelativePath}`);
    }
    await assertScopedPathAnchorStable(state, source, sourceRelativePath);
    await assertScopedPathAnchorStable(state, target, targetRelativePath);
    await link(
      path.join(source.parent.volumePath, source.basename),
      path.join(target.parent.volumePath, target.basename),
    );
    await assertScopeStable(state, sourceRelativePath);
    await assertDirectoryIdentityStable(source.parent.identity, sourceRelativePath);
    await assertDirectoryIdentityStable(target.parent.identity, targetRelativePath);
  } finally {
    await Promise.all([
      closeDirectoryAnchor(source.parent),
      closeDirectoryAnchor(target.parent),
    ]);
  }
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
  const stats = await lstat(target, {bigint: true});
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

const inspectWorkEntry = async (
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

const unlinkWorkFile = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<void> => await unlinkScopedFile(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

export const unlinkRunFile = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<void> => await unlinkScopedFile(
  stateFor(runStates, scope, 'RunDirectoryScope'),
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

const PROJECT_LOCK_PATH = 'pipeline.lock';

export const inspectProjectLockFile = async (
  scope: WorkDirectoryScope,
): Promise<AppDirectoryEntryKind> => await inspectWorkEntry(
  scope,
  PROJECT_LOCK_PATH,
);

export const openExistingProjectLockFile = async (
  scope: WorkDirectoryScope,
): Promise<FileHandle> => await openExistingWorkFile(scope, PROJECT_LOCK_PATH);

export const openNewProjectLockFile = async (
  scope: WorkDirectoryScope,
): Promise<FileHandle> => await openNewWorkFile(scope, PROJECT_LOCK_PATH);

type ProjectLockUnlinkResult = 'removed' | 'missing' | 'changed';

export const unlinkProjectLockFile = async (
  scope: WorkDirectoryScope,
  expectedHandle: FileHandle,
): Promise<ProjectLockUnlinkResult> => {
  const state = stateFor(workStates, scope, 'WorkDirectoryScope');
  const expected = await expectedHandle.stat({bigint: true});
  if (!expected.isFile()) {
    throw securityError('project lock removal requires a regular-file handle');
  }
  const anchor = await openScopedPathAnchor(state, PROJECT_LOCK_PATH);
  try {
    const current = await inspectAnchoredEntry(anchor, PROJECT_LOCK_PATH);
    if (current.kind === 'missing') return 'missing';
    if (current.kind !== 'file' || current.stats === undefined) {
      throw securityError('project lock path is not a regular file');
    }
    if (current.stats.dev !== expected.dev || current.stats.ino !== expected.ino) {
      return 'changed';
    }
    await assertScopedPathAnchorStable(state, anchor, PROJECT_LOCK_PATH);
    const held = await expectedHandle.stat({bigint: true});
    if (held.dev !== expected.dev || held.ino !== expected.ino) {
      throw securityError('project lock file handle identity changed');
    }
    if (held.nlink === 0n) return 'missing';
    if (held.nlink !== 1n) {
      throw securityError('project lock has unexpected hard links');
    }
    try {
      await unlink(volumePath(expected.dev, expected.ino));
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      const replacement = await inspectAnchoredEntry(anchor, PROJECT_LOCK_PATH);
      return replacement.kind === 'missing' ? 'missing' : 'changed';
    }
    await assertScopeStable(state, PROJECT_LOCK_PATH);
    await assertDirectoryIdentityStable(anchor.parent.identity, PROJECT_LOCK_PATH);
    const replacement = await inspectAnchoredEntry(anchor, PROJECT_LOCK_PATH);
    return replacement.kind === 'missing' ? 'removed' : 'changed';
  } finally {
    await closeDirectoryAnchor(anchor.parent);
  }
};


const CURRENT_PATH = 'current.json';
const TEMP_PATH = 'current.json.tmp';
const ROLLBACK_PATH = 'current.json.rollback';

const STAGE_IDS = [
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
  'review',
  'release',
] as const;
const PRESETS = ['assets', 'draft', 'release'] as const;
const POINTER_STATES = ['passed', 'needs_review'] as const;

export type StageId = typeof STAGE_IDS[number];
export type PipelinePreset = typeof PRESETS[number];
export type CurrentPointerState = typeof POINTER_STATES[number];

export interface CurrentPointer {
  runId: string;
  relativePath: string;
  preset: PipelinePreset;
  stageIds: StageId[];
  completedStage: StageId;
  state: CurrentPointerState;
  publishedAt: string;
}

export type RunStoreErrorCode =
  | 'RUN_POINTER_INVALID'
  | 'RUN_POINTER_UNSAFE'
  | 'RUN_POINTER_TEMP_EXISTS'
  | 'RUN_POINTER_ROLLBACK_FAILED';

export class RunStoreError extends Error {
  constructor(
    readonly code: RunStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RunStoreError';
  }
}

export type FileOpsPhase = 'publish' | 'cleanup';

export interface FileOps {
  writeFile(handle: FileHandle, data: string): Promise<void>;
  syncFile(handle: FileHandle): Promise<void>;
  rename(operation: () => Promise<void>, phase: FileOpsPhase): Promise<void>;
  syncDirectory(
    operation: () => Promise<void>,
    phase: FileOpsPhase,
  ): Promise<void>;
}

export interface RunStoreOptions {
  readonly fileOps?: Partial<FileOps>;
}

interface PointerScopeAuthority<Scope> {
  inspect(scope: Scope, relativePath: string): Promise<AppDirectoryEntryKind>;
  openExisting(scope: Scope, relativePath: string): Promise<FileHandle>;
  openNew(scope: Scope, relativePath: string): Promise<FileHandle>;
  unlink(scope: Scope, relativePath: string): Promise<void>;
  rename(
    scope: Scope,
    sourceRelativePath: string,
    targetRelativePath: string,
  ): Promise<void>;
  link(
    scope: Scope,
    sourceRelativePath: string,
    targetRelativePath: string,
  ): Promise<void>;
  syncDirectory(scope: Scope, relativePath?: string): Promise<void>;
}

const DEFAULT_FILE_OPS: FileOps = {
  writeFile: async (handle, data) => await handle.writeFile(data),
  syncFile: async (handle) => await handle.sync(),
  rename: async (operation) => await operation(),
  syncDirectory: async (operation) => await operation(),
};

const mergeFileOps = (options: RunStoreOptions): FileOps => ({
  ...DEFAULT_FILE_OPS,
  ...options.fileOps,
});

const isExactObject = (
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...expectedKeys].sort().join('\0');

const isOneOf = <Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): value is Value => typeof value === 'string' && allowed.includes(value as Value);

const invalidPointer = (message: string, cause?: unknown): never => {
  throw new RunStoreError(
    'RUN_POINTER_INVALID',
    message,
    cause === undefined ? undefined : {cause},
  );
};

const validatePointer = (
  value: unknown,
  owner: 'work' | 'output',
): CurrentPointer => {
  const keys = [
    'runId',
    'relativePath',
    'preset',
    'stageIds',
    'completedStage',
    'state',
    'publishedAt',
  ] as const;
  if (!isExactObject(value, keys)) {
    return invalidPointer('current pointer shape is invalid');
  }

  let runId: string;
  try {
    runId = StableIdSchema.parse(value.runId);
  } catch (error) {
    return invalidPointer('current pointer runId is invalid', error);
  }
  if (typeof value.relativePath !== 'string') {
    return invalidPointer('current pointer relativePath is invalid');
  }
  const expectedPath = owner === 'work' ? `runs/${runId}` : `releases/${runId}`;
  if (value.relativePath !== expectedPath) {
    return invalidPointer(`current pointer must target ${expectedPath}`);
  }
  if (!isOneOf(value.preset, PRESETS)) {
    return invalidPointer('current pointer preset is invalid');
  }
  if (!Array.isArray(value.stageIds) || value.stageIds.length === 0) {
    return invalidPointer('current pointer stageIds must be a non-empty array');
  }
  const stageIds: StageId[] = [];
  let previousIndex = -1;
  for (const stageId of value.stageIds) {
    if (!isOneOf(stageId, STAGE_IDS)) {
      return invalidPointer('current pointer contains an invalid stageId');
    }
    const stageIndex = STAGE_IDS.indexOf(stageId);
    if (stageIndex <= previousIndex) {
      return invalidPointer('current pointer stageIds must be unique and ordered');
    }
    stageIds.push(stageId);
    previousIndex = stageIndex;
  }
  if (!isOneOf(value.completedStage, STAGE_IDS)) {
    return invalidPointer('current pointer completedStage is invalid');
  }
  if (!stageIds.includes(value.completedStage)) {
    return invalidPointer('current pointer completedStage must be selected');
  }
  if (!isOneOf(value.state, POINTER_STATES)) {
    return invalidPointer('current pointer state is invalid');
  }
  if (value.state === 'needs_review' && value.completedStage !== 'review') {
    return invalidPointer('needs_review pointers must stop at review');
  }
  if (typeof value.publishedAt !== 'string') {
    return invalidPointer('current pointer publishedAt is invalid');
  }
  const publishedAt = new Date(value.publishedAt);
  if (
    Number.isNaN(publishedAt.valueOf())
    || publishedAt.toISOString() !== value.publishedAt
  ) {
    return invalidPointer('current pointer publishedAt must be canonical ISO time');
  }
  if (
    owner === 'output'
    && (
      value.completedStage !== 'release'
      || value.state !== 'passed'
      || !stageIds.includes('release')
    )
  ) {
    return invalidPointer('output current pointer requires a passed release');
  }

  return {
    runId,
    relativePath: value.relativePath,
    preset: value.preset,
    stageIds,
    completedStage: value.completedStage,
    state: value.state,
    publishedAt: value.publishedAt,
  };
};

const parsePointer = (
  raw: string,
  owner: 'work' | 'output',
): CurrentPointer => {
  try {
    return validatePointer(JSON.parse(raw), owner);
  } catch (error) {
    if (error instanceof RunStoreError) throw error;
    return invalidPointer('current pointer is not valid JSON', error);
  }
};

const serializePointer = (pointer: CurrentPointer): string =>
  `${JSON.stringify(pointer, null, 2)}\n`;

const unsafePointer = (relativePath: string): never => {
  throw new RunStoreError(
    'RUN_POINTER_UNSAFE',
    `pointer path must be absent or a regular file: ${relativePath}`,
  );
};

const readPointerRaw = async <Scope>(
  scope: Scope,
  authority: PointerScopeAuthority<Scope>,
): Promise<string | null> => {
  const kind = await authority.inspect(scope, CURRENT_PATH);
  if (kind === 'missing') return null;
  if (kind !== 'file') return unsafePointer(CURRENT_PATH);
  const handle = await authority.openExisting(scope, CURRENT_PATH);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

const cleanupRegularFile = async <Scope>(
  scope: Scope,
  authority: PointerScopeAuthority<Scope>,
  relativePath: string,
  fileOps: FileOps,
): Promise<void> => {
  const kind = await authority.inspect(scope, relativePath);
  if (kind === 'missing') return;
  if (kind !== 'file') return unsafePointer(relativePath);
  await authority.unlink(scope, relativePath);
  await fileOps.syncDirectory(
    async () => await authority.syncDirectory(scope),
    'cleanup',
  );
};

const prepareScratchPath = async <Scope>(
  scope: Scope,
  authority: PointerScopeAuthority<Scope>,
  relativePath: string,
  cleanupRegular: boolean,
  fileOps: FileOps,
): Promise<void> => {
  const kind = await authority.inspect(scope, relativePath);
  if (kind === 'missing') return;
  if (kind === 'file' && cleanupRegular) {
    await cleanupRegularFile(scope, authority, relativePath, fileOps);
    return;
  }
  if (kind !== 'file') return unsafePointer(relativePath);
  throw new RunStoreError(
    'RUN_POINTER_TEMP_EXISTS',
    `pointer scratch file already exists: ${relativePath}`,
  );
};

const publishPointer = async <Scope>(
  scope: Scope,
  authority: PointerScopeAuthority<Scope>,
  pointer: CurrentPointer,
  fileOps: FileOps,
): Promise<void> => {
  const oldRaw = await readPointerRaw(scope, authority);
  await prepareScratchPath(scope, authority, TEMP_PATH, true, fileOps);
  await prepareScratchPath(
    scope,
    authority,
    ROLLBACK_PATH,
    oldRaw !== null,
    fileOps,
  );

  let tempHandle: FileHandle | undefined;
  let tempCreated = false;
  let backupCreated = false;
  let published = false;
  let committed = false;
  try {
    if (oldRaw !== null) {
      await authority.link(scope, CURRENT_PATH, ROLLBACK_PATH);
      backupCreated = true;
    }

    tempHandle = await authority.openNew(scope, TEMP_PATH);
    tempCreated = true;
    await fileOps.writeFile(tempHandle, serializePointer(pointer));
    await fileOps.syncFile(tempHandle);
    await tempHandle.close();
    tempHandle = undefined;

    await fileOps.rename(
      async () => {
        await authority.rename(scope, TEMP_PATH, CURRENT_PATH);
        tempCreated = false;
        published = true;
      },
      'publish',
    );
    tempCreated = false;
    published = true;
    await fileOps.syncDirectory(
      async () => await authority.syncDirectory(scope),
      'publish',
    );
    committed = true;

    if (backupCreated) {
      await authority.unlink(scope, ROLLBACK_PATH);
      backupCreated = false;
      await fileOps.syncDirectory(
        async () => await authority.syncDirectory(scope),
        'cleanup',
      );
    }
  } catch (error) {
    await tempHandle?.close().catch(() => undefined);
    let rollbackError: unknown;
    if (published && !committed) {
      try {
        if (oldRaw === null) {
          await authority.unlink(scope, CURRENT_PATH);
        } else {
          if (!backupCreated) {
            throw new Error('pointer rollback anchor is missing');
          }
          await authority.rename(scope, ROLLBACK_PATH, CURRENT_PATH);
          backupCreated = false;
        }
        await authority.syncDirectory(scope);
      } catch (caught) {
        rollbackError = caught;
      }
    }
    const cleanupErrors: unknown[] = [];
    if (tempCreated) {
      try {
        await cleanupRegularFile(scope, authority, TEMP_PATH, fileOps);
      } catch (caught) {
        cleanupErrors.push(caught);
      }
    }
    if (backupCreated) {
      try {
        await cleanupRegularFile(scope, authority, ROLLBACK_PATH, fileOps);
      } catch (caught) {
        cleanupErrors.push(caught);
      }
    }
    if (rollbackError !== undefined || cleanupErrors.length > 0) {
      throw new RunStoreError(
        'RUN_POINTER_ROLLBACK_FAILED',
        'pointer publication failed and rollback or cleanup did not complete',
        {
          cause: new AggregateError([
            error,
            ...(rollbackError === undefined ? [] : [rollbackError]),
            ...cleanupErrors,
          ]),
        },
      );
    }
    throw error;
  }
};

const WORK_POINTER_AUTHORITY: PointerScopeAuthority<WorkDirectoryScope> = {
  inspect: inspectWorkEntry,
  openExisting: openExistingWorkFile,
  openNew: openNewWorkFile,
  unlink: unlinkWorkFile,
  rename: renameWorkFile,
  link: linkWorkFile,
  syncDirectory: syncWorkDirectory,
};

const OUTPUT_POINTER_AUTHORITY: PointerScopeAuthority<OutputDirectoryScope> = {
  inspect: inspectOutputEntry,
  openExisting: openExistingOutputFile,
  openNew: openNewOutputFile,
  unlink: unlinkOutputFile,
  rename: renameOutputFile,
  link: linkOutputFile,
  syncDirectory: syncOutputDirectory,
};

export class RunStore {
  readonly #workspace: DirectoryIdentity;
  readonly #fileOps: FileOps;

  constructor(workspaceRoot: string, options: RunStoreOptions = {}) {
    this.#workspace = createWorkspaceState(workspaceRoot);
    this.#fileOps = mergeFileOps(options);
    Object.freeze(this);
  }

  async createWork(projectId: string): Promise<WorkDirectoryScope> {
    return await createWorkScope(this.#workspace, projectId);
  }

  async createRun(projectId: string, runId: string): Promise<RunDirectoryScope> {
    return await mintRunScope(this.#workspace, projectId, runId, 'create');
  }

  async openExistingRun(
    projectId: string,
    runId: string,
  ): Promise<RunDirectoryScope> {
    return await mintRunScope(this.#workspace, projectId, runId, 'existing');
  }

  async readCurrent(projectId: string): Promise<CurrentPointer | null> {
    const work = await createWorkScope(this.#workspace, projectId);
    const raw = await readPointerRaw(work, WORK_POINTER_AUTHORITY);
    return raw === null ? null : parsePointer(raw, 'work');
  }

  async publishCurrent(
    projectId: string,
    value: CurrentPointer,
  ): Promise<void> {
    const pointer = validatePointer(value, 'work');
    const workspace = this.#workspace;
    await mintRunScope(workspace, projectId, pointer.runId, 'existing');
    const work = await createWorkScope(workspace, projectId);
    await publishPointer(work, WORK_POINTER_AUTHORITY, pointer, this.#fileOps);
  }
}

export class OutputStore {
  readonly #workspace: DirectoryIdentity;
  readonly #fileOps: FileOps;

  constructor(workspaceRoot: string, options: RunStoreOptions = {}) {
    this.#workspace = createWorkspaceState(workspaceRoot);
    this.#fileOps = mergeFileOps(options);
    Object.freeze(this);
  }

  async openProject(projectId: string): Promise<OutputDirectoryScope> {
    return await mintOutputScope(this.#workspace, projectId);
  }

  async createRelease(
    projectId: string,
    runId: string,
  ): Promise<OutputDirectoryScope> {
    const validatedRunId = StableIdSchema.parse(runId);
    const scope = await mintOutputScope(this.#workspace, projectId);
    const state = stateFor(outputStates, scope, 'OutputDirectoryScope');
    await ensureScopedDirectory(state, 'releases');
    await ensureScopedDirectory(state, `releases/${validatedRunId}`, true);
    return scope;
  }

  async readCurrent(projectId: string): Promise<CurrentPointer | null> {
    const output = await mintOutputScope(this.#workspace, projectId);
    const raw = await readPointerRaw(output, OUTPUT_POINTER_AUTHORITY);
    return raw === null ? null : parsePointer(raw, 'output');
  }

  async publishCurrent(
    projectId: string,
    value: CurrentPointer,
  ): Promise<void> {
    const pointer = validatePointer(value, 'output');
    const output = await openOutputRelease(
      this.#workspace,
      projectId,
      pointer.runId,
    );
    await publishPointer(output, OUTPUT_POINTER_AUTHORITY, pointer, this.#fileOps);
  }
}

export const createRunStore = (
  workspaceRoot: string,
  options: RunStoreOptions = {},
): RunStore => new RunStore(workspaceRoot, options);

export const createOutputStore = (
  workspaceRoot: string,
  options: RunStoreOptions = {},
): OutputStore => new OutputStore(workspaceRoot, options);
