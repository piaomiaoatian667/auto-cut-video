import {randomUUID} from 'node:crypto';
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
  readlink,
  readdir,
  realpath,
  rename,
  rmdir,
  symlink,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {StableIdSchema} from '../domain/schema-primitives';

const O_NOFOLLOW_ANY = 0x20000000;

export type AppDirectoryScopeErrorCode =
  | 'APP_PATH_OUTSIDE_SCOPE'
  | 'APP_SCOPE_AUTHORITY_CHANGED';

export class AppDirectoryScopeError extends Error {
  constructor(
    readonly code: AppDirectoryScopeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
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

export class AppDirectoryLinkOutcomeError extends AggregateError {
  readonly code = 'APP_DIRECTORY_LINK_OUTCOME_UNKNOWN';

  constructor(
    readonly sourceRelativePath: string,
    readonly targetRelativePath: string,
    primaryError: unknown,
    cleanupErrors: readonly unknown[],
  ) {
    super(
      [primaryError, ...cleanupErrors],
      `App-owned hard link outcome could not be determined for ${targetRelativePath}`,
      {cause: primaryError},
    );
    this.name = 'AppDirectoryLinkOutcomeError';
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
  listedEntries: Map<string, ScopedDirectoryEntryIdentity>;
}

export interface RunDirectoryIdentity {
  readonly projectId: string;
  readonly runId: string;
}

interface RunScopeState extends ScopeState {
  identity: RunDirectoryIdentity;
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

export interface ScopedDirectoryEntry {
  name: string;
  kind: Exclude<AppDirectoryEntryKind, 'missing'>;
}

interface ScopedDirectoryEntryIdentity {
  kind: ScopedDirectoryEntry['kind'];
  dev: bigint;
  ino: bigint;
}

export interface AppDirectoryReadFileAuthority {
  readonly handle: FileHandle;
  revalidate(): Promise<void>;
  close(): Promise<void>;
}

export interface AppDirectoryWriteFileAuthority {
  readonly handle: FileHandle;
  syncAndSeal(): Promise<void>;
  syncParent(): Promise<void>;
  openForRead(): Promise<AppDirectoryReadFileAuthority>;
  revalidate(): Promise<void>;
  unlink(): Promise<void>;
  close(): Promise<void>;
}

export interface AppDirectoryLinkedFileAuthority {
  syncParent(): Promise<void>;
  unlinkSource(): Promise<void>;
  close(): Promise<void>;
}

const workStates = new WeakMap<WorkDirectoryScope, ScopeState>();
const runStates = new WeakMap<RunDirectoryScope, RunScopeState>();
const outputStates = new WeakMap<OutputDirectoryScope, ScopeState>();
const scopedDirectoryEntryIdentities = new WeakMap<
  ScopedDirectoryEntry,
  ScopedDirectoryEntryIdentity
>();

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
  'APP_PATH_OUTSIDE_SCOPE',
  message,
  cause === undefined ? undefined : {cause},
);

const authorityError = (
  message: string,
  cause?: unknown,
): AppDirectoryScopeError => new AppDirectoryScopeError(
  'APP_SCOPE_AUTHORITY_CHANGED',
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
      throw authorityError(`app-owned directory changed after validation: ${label}`);
    }
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw authorityError(`app-owned directory disappeared: ${label}`, error);
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
      throw authorityError(`app-owned directory changed while opening: ${label}`);
    }
    const anchoredPath = volumePath(identity.dev, identity.ino);
    const anchoredStats = await lstat(anchoredPath, {bigint: true});
    if (!anchoredStats.isDirectory() || !identityMatchesStats(identity, anchoredStats)) {
      throw authorityError(`Darwin directory anchor changed: ${label}`);
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

const assertDirectoryAnchorStable = async (
  anchor: DirectoryAnchor,
  label: string,
): Promise<void> => {
  await assertDirectoryIdentityStable(anchor.identity, label);
  const held = await anchor.handle.stat({bigint: true});
  if (!held.isDirectory() || !identityMatchesStats(anchor.identity, held)) {
    throw authorityError(`app-owned directory changed while held open: ${label}`);
  }
  const anchored = await lstat(anchor.volumePath, {bigint: true});
  if (!anchored.isDirectory() || !identityMatchesStats(anchor.identity, anchored)) {
    throw authorityError(`Darwin directory anchor changed: ${label}`);
  }
};

const syncHeldDirectoryAnchor = async (
  anchor: DirectoryAnchor,
  label: string,
): Promise<void> => {
  const errors: unknown[] = [];
  try {
    await assertDirectoryAnchorStable(anchor, label);
  } catch (error) {
    errors.push(error);
  }
  try {
    await anchor.handle.sync();
  } catch (error) {
    errors.push(error);
  }
  try {
    await assertDirectoryAnchorStable(anchor, label);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `failed to sync held directory authority: ${label}`,
      {cause: errors[0]},
    );
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

const inspectOptionalPlainChildDirectory = async (
  parent: DirectoryIdentity,
  name: string,
  label: string,
): Promise<DirectoryIdentity | null> => {
  try {
    return await inspectPlainChildDirectory(parent, name, label);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
};

const ensurePlainDirectory = async (
  parent: DirectoryIdentity,
  name: string,
  options: {exclusive?: boolean} = {},
): Promise<DirectoryIdentity> => {
  const anchor = await openDirectoryAnchor(parent, name);
  const target = path.join(anchor.volumePath, name);
  let created = false;
  let syncAttempted = false;
  let identity: DirectoryIdentity | undefined;
  let primaryError: unknown;
  try {
    if (options.exclusive) {
      await mkdir(target, {mode: 0o700});
      created = true;
    } else {
      try {
        await mkdir(target, {mode: 0o700});
        created = true;
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }
    }
    const stats = await lstat(target, {bigint: true});
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw securityError(`app-owned directory is not a plain directory: ${name}`);
    }
    identity = identityFromStats(path.join(parent.path, name), stats);
    syncAttempted = true;
    await syncHeldDirectoryAnchor(anchor, name);
    await assertDirectoryIdentityStable(identity, name);
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) {
      primaryError = error;
    } else if (isNodeError(error) && error.code === 'EEXIST') {
      const stats = await lstat(target, {bigint: true}).catch(() => undefined);
      if (stats?.isSymbolicLink() || (stats !== undefined && !stats.isDirectory())) {
        primaryError = securityError(
          `app-owned directory is not a plain directory: ${target}`,
        );
      } else {
        primaryError = error;
      }
    } else {
      try {
        mapSymlinkError(error, name);
      } catch (mappedError) {
        primaryError = mappedError;
      }
    }
  }
  const cleanupErrors: unknown[] = [];
  if (created && !syncAttempted) {
    try {
      await syncHeldDirectoryAnchor(anchor, name);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await closeDirectoryAnchor(anchor);
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    const errors = [
      ...(primaryError === undefined ? [] : [primaryError]),
      ...cleanupErrors,
    ];
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(
      errors,
      `failed to ensure app-owned directory: ${name}`,
      {cause: errors[0]},
    );
  }
  if (identity === undefined) {
    throw new TypeError(`directory identity was not established: ${name}`);
  }
  return identity;
};

const createWorkspaceState = (workspaceRoot: string): DirectoryIdentity => {
  assertDarwin();
  const canonicalWorkspace = realpathSync(workspaceRoot);
  return inspectPlainDirectory(canonicalWorkspace, 'workspace root');
};

const stateFor = <Scope extends object, State extends ScopeState>(
  states: WeakMap<Scope, State>,
  scope: Scope,
  name: string,
): State => {
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
        throw authorityError(`app-owned scope changed after creation: ${relativePath}`);
      }
    }
    const workspace = state.ancestors[0]!;
    if (!isWithin(workspace.path, state.root) || state.root === workspace.path) {
      throw authorityError(`app-owned scope escapes workspace: ${relativePath}`);
    }
  } catch (error) {
    if (error instanceof AppDirectoryScopeError) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw authorityError(`app-owned scope disappeared: ${relativePath}`, error);
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
    listedEntries: new Map(),
  });
  return scope;
};

const mintExistingWorkScope = async (
  workspace: DirectoryIdentity,
  projectId: string,
): Promise<WorkDirectoryScope> => {
  const validatedProjectId = StableIdSchema.parse(projectId);
  await assertDirectoryIdentityStable(workspace, 'workspace root');
  const workContainer = await inspectPlainChildDirectory(
    workspace,
    '.work',
    'Work directory',
  );
  const workRoot = await inspectPlainChildDirectory(
    workContainer,
    validatedProjectId,
    `Work project ${validatedProjectId}`,
  );
  const scope = mintWorkDirectoryScope();
  workStates.set(scope, {
    root: workRoot.path,
    ancestors: [workspace, workContainer, workRoot],
    listedEntries: new Map(),
  });
  return scope;
};

const openExistingWorkScope = async (
  workspace: DirectoryIdentity,
  projectId: string,
): Promise<WorkDirectoryScope | null> => {
  const validatedProjectId = StableIdSchema.parse(projectId);
  await assertDirectoryIdentityStable(workspace, 'workspace root');
  const workContainer = await inspectOptionalPlainChildDirectory(
    workspace,
    '.work',
    'Work directory',
  );
  if (workContainer === null) return null;
  const workRoot = await inspectOptionalPlainChildDirectory(
    workContainer,
    validatedProjectId,
    `Work project ${validatedProjectId}`,
  );
  if (workRoot === null) return null;
  const scope = mintWorkDirectoryScope();
  workStates.set(scope, {
    root: workRoot.path,
    ancestors: [workspace, workContainer, workRoot],
    listedEntries: new Map(),
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
  const validatedProjectId = StableIdSchema.parse(projectId);
  const validatedRunId = StableIdSchema.parse(runId);
  const work = mode === 'create'
    ? await createWorkScope(workspace, validatedProjectId)
    : await mintExistingWorkScope(workspace, validatedProjectId);
  const workState = stateFor(workStates, work, 'WorkDirectoryScope');
  await assertScopeStable(workState, `runs/${validatedRunId}`);
  const workRoot = workState.ancestors.at(-1)!;
  const runsRoot = mode === 'create'
    ? await ensurePlainDirectory(workRoot, 'runs')
    : await inspectPlainChildDirectory(workRoot, 'runs', 'Work runs directory');
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
    listedEntries: new Map(),
    identity: Object.freeze({
      projectId: validatedProjectId,
      runId: validatedRunId,
    }),
  });
  return scope;
};

export const getRunDirectoryIdentity = (
  scope: RunDirectoryScope,
): RunDirectoryIdentity => stateFor(
  runStates,
  scope,
  'RunDirectoryScope',
).identity;

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
    listedEntries: new Map(),
  });
  return scope;
};

const openExistingOutputScope = async (
  workspace: DirectoryIdentity,
  projectId: string,
): Promise<OutputDirectoryScope | null> => {
  const validatedProjectId = StableIdSchema.parse(projectId);
  await assertDirectoryIdentityStable(workspace, 'workspace root');
  const outputContainer = await inspectOptionalPlainChildDirectory(
    workspace,
    'output',
    'Output directory',
  );
  if (outputContainer === null) return null;
  const outputRoot = await inspectOptionalPlainChildDirectory(
    outputContainer,
    validatedProjectId,
    `Output project ${validatedProjectId}`,
  );
  if (outputRoot === null) return null;
  const scope = mintOutputDirectoryScope();
  outputStates.set(scope, {
    root: outputRoot.path,
    ancestors: [workspace, outputContainer, outputRoot],
    listedEntries: new Map(),
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
      throw authorityError(`app-owned read target changed while opening: ${relativePath}`);
    }
    const identity = regularFileIdentity(opened);
    const openedHandle = handle;
    const revalidate = async (): Promise<void> => {
      await assertScopedReadPathStable(state, pathAuthority, relativePath);
      const held = await openedHandle.stat({bigint: true});
      if (!regularFileIdentityMatches(held, identity)) {
        throw authorityError(`app-owned read handle changed: ${relativePath}`);
      }
      const current = await inspectAnchoredEntry(anchor, relativePath);
      if (
        current.kind !== 'file'
        || current.stats === undefined
        || !regularFileIdentityMatches(current.stats, identity)
      ) {
        throw authorityError(`app-owned read target changed after opening: ${relativePath}`);
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
      throw authorityError(`app-owned parent changed while held open: ${relativePath}`);
    }
    const anchored = await lstat(directory.volumePath, {bigint: true});
    if (!anchored.isDirectory() || !identityMatchesStats(directory.identity, anchored)) {
      throw authorityError(`Darwin parent anchor changed: ${relativePath}`);
    }
    if (index > 0) {
      const parent = authority.directories[index - 1]!;
      const child = await lstat(
        path.join(parent.volumePath, path.basename(directory.identity.path)),
        {bigint: true},
      );
      if (!child.isDirectory() || !identityMatchesStats(directory.identity, child)) {
        throw authorityError(`app-owned parent chain changed: ${relativePath}`);
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
    throw authorityError(`app-owned parent changed while held open: ${relativePath}`);
  }
  const anchoredStats = await lstat(anchor.parent.volumePath, {bigint: true});
  if (
    !anchoredStats.isDirectory()
    || !identityMatchesStats(anchor.parent.identity, anchoredStats)
  ) {
    throw authorityError(`Darwin parent anchor changed: ${relativePath}`);
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

const openScopedDirectoryAnchor = async (
  state: ScopeState,
  relativePath: string,
): Promise<DirectoryAnchor> => {
  const segments = parseRelativePath(relativePath, true);
  await assertScopeStable(state, relativePath);
  let directory = await openDirectoryAnchor(
    state.ancestors.at(-1)!,
    relativePath,
  );
  try {
    for (const segment of segments) {
      const target = path.join(directory.volumePath, segment);
      const stats = await lstat(target, {bigint: true});
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw securityError(`app-owned list target is not a plain directory: ${relativePath}`);
      }
      const identity = identityFromStats(
        path.join(directory.identity.path, segment),
        stats,
      );
      if (!isWithin(state.root, identity.path)) {
        throw securityError(`directory escapes app-owned scope: ${relativePath}`);
      }
      const child = await openDirectoryAnchor(identity, relativePath);
      await closeDirectoryAnchor(directory);
      directory = child;
    }
    await assertScopeStable(state, relativePath);
    await assertDirectoryAnchorStable(directory, relativePath);
    return directory;
  } catch (error) {
    await closeDirectoryAnchor(directory).catch(() => undefined);
    if (error instanceof AppDirectoryScopeError) throw error;
    return mapSymlinkError(error, relativePath);
  }
};

const listScopedDirectory = async (
  state: ScopeState,
  relativePath: string,
): Promise<ScopedDirectoryEntry[]> => {
  const directory = await openScopedDirectoryAnchor(state, relativePath);
  try {
    await assertDirectoryAnchorStable(directory, relativePath);
    const names = (await readdir(directory.volumePath)).sort();
    const entries: ScopedDirectoryEntry[] = [];
    for (const name of names) {
      await assertDirectoryAnchorStable(directory, relativePath);
      const childRelativePath = relativePath === '.' || relativePath === ''
        ? name
        : `${relativePath}/${name}`;
      const entry = await inspectAnchoredEntry(
        {parent: directory, basename: name},
        childRelativePath,
      );
      if (entry.kind !== 'missing' && entry.stats !== undefined) {
        const identity: ScopedDirectoryEntryIdentity = {
          kind: entry.kind,
          dev: entry.stats.dev,
          ino: entry.stats.ino,
        };
        const scopedEntry = Object.freeze({name, kind: entry.kind});
        scopedDirectoryEntryIdentities.set(scopedEntry, identity);
        state.listedEntries.set(childRelativePath, identity);
        entries.push(scopedEntry);
      }
    }
    await assertScopeStable(state, relativePath);
    await assertDirectoryAnchorStable(directory, relativePath);
    return entries;
  } finally {
    await closeDirectoryAnchor(directory);
  }
};

export const assertScopedDirectoryEntryUnchanged = (
  expected: ScopedDirectoryEntry,
  current: ScopedDirectoryEntry,
  relativePath: string,
): void => {
  const expectedIdentity = scopedDirectoryEntryIdentities.get(expected);
  const currentIdentity = scopedDirectoryEntryIdentities.get(current);
  if (expectedIdentity === undefined || currentIdentity === undefined) {
    throw new TypeError('invalid ScopedDirectoryEntry authority');
  }
  if (current.kind === 'symlink' || current.kind === 'other') {
    throw securityError(`cleanup candidate became unsafe: ${relativePath}`);
  }
  if (
    expected.name !== current.name
    || expectedIdentity.kind !== currentIdentity.kind
    || expectedIdentity.dev !== currentIdentity.dev
    || expectedIdentity.ino !== currentIdentity.ino
  ) {
    throw authorityError(`cleanup candidate changed after inventory: ${relativePath}`);
  }
};

interface AnchoredTreeEntryIdentity {
  kind: 'file' | 'directory';
  dev: bigint;
  ino: bigint;
}

const anchoredTreeEntryIdentity = (
  kind: AnchoredTreeEntryIdentity['kind'],
  stats: BigIntStats,
): AnchoredTreeEntryIdentity => ({kind, dev: stats.dev, ino: stats.ino});

const revalidateAnchoredTreeEntry = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  relativePath: string,
  expected: AnchoredTreeEntryIdentity,
): Promise<BigIntStats | null> => {
  await assertScopedPathAnchorStable(state, anchor, relativePath);
  const current = await inspectAnchoredEntry(anchor, relativePath);
  if (current.kind === 'missing') return null;
  if (current.kind === 'symlink' || current.kind === 'other') {
    throw securityError(`refusing to remove unsafe app entry: ${relativePath}`);
  }
  if (
    current.stats === undefined
    || current.kind !== expected.kind
    || current.stats.dev !== expected.dev
    || current.stats.ino !== expected.ino
  ) {
    throw authorityError(`app-owned tree entry changed before removal: ${relativePath}`);
  }
  return current.stats;
};

const syncRemovedEntryParent = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  relativePath: string,
): Promise<void> => {
  await assertScopeStable(state, relativePath);
  await syncHeldDirectoryAnchor(anchor.parent, relativePath);
};

const anchoredEntryMatchesIdentity = (
  kind: AppDirectoryEntryKind,
  stats: BigIntStats | undefined,
  expected: ScopedDirectoryEntryIdentity,
): boolean => stats !== undefined
  && kind === expected.kind
  && stats.dev === expected.dev
  && stats.ino === expected.ino;

const unusedQuarantineBasename = async (
  anchor: ScopedPathAnchor,
  relativePath: string,
): Promise<string> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const basename = `.cleanup-${randomUUID()}`;
    const entry = await inspectAnchoredEntry(
      {parent: anchor.parent, basename},
      relativePath,
    );
    if (entry.kind === 'missing') return basename;
  }
  throw authorityError(`could not reserve a cleanup quarantine name: ${relativePath}`);
};

const restoreQuarantinedEntry = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  quarantineBasename: string,
  relativePath: string,
  expected: ScopedDirectoryEntryIdentity,
): Promise<void> => {
  await assertScopedPathAnchorStable(state, anchor, relativePath);
  const quarantineAnchor = {parent: anchor.parent, basename: quarantineBasename};
  const quarantined = await inspectAnchoredEntry(quarantineAnchor, relativePath);
  if (quarantined.kind === 'missing') {
    await syncRemovedEntryParent(state, anchor, relativePath);
    return;
  }
  if (!anchoredEntryMatchesIdentity(quarantined.kind, quarantined.stats, expected)) {
    throw authorityError(`cleanup quarantine changed before restore: ${relativePath}`);
  }
  const identityPath = volumePath(expected.dev, expected.ino);
  const originalPath = path.join(anchor.parent.volumePath, anchor.basename);
  let occupied = false;
  try {
    if (expected.kind === 'file') {
      await link(identityPath, originalPath);
    } else if (expected.kind === 'symlink') {
      await symlink(await readlink(identityPath), originalPath);
    } else {
      throw authorityError(
        `cleanup directory cannot be atomically restored without overwrite: ${relativePath}`,
      );
    }
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') occupied = true;
    else throw error;
  }

  try {
    await unlink(identityPath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
  await assertScopedPathAnchorStable(state, anchor, relativePath);
  const remaining = await inspectAnchoredEntry(quarantineAnchor, relativePath);
  if (remaining.kind !== 'missing') {
    throw authorityError(`cleanup quarantine remained after restore: ${relativePath}`);
  }
  if (!occupied) {
    const restored = await inspectAnchoredEntry(anchor, relativePath);
    if (expected.kind === 'file') {
      if (!anchoredEntryMatchesIdentity(restored.kind, restored.stats, expected)) {
        throw authorityError(`cleanup quarantine restore changed identity: ${relativePath}`);
      }
    } else if (restored.kind !== 'symlink') {
      throw authorityError(`cleanup quarantine restore changed type: ${relativePath}`);
    }
  }
  await syncRemovedEntryParent(state, anchor, relativePath);
};

const inspectIdentityPath = async (
  expected: ScopedDirectoryEntryIdentity,
): Promise<BigIntStats | null> => {
  try {
    const stats = await lstat(volumePath(expected.dev, expected.ino), {bigint: true});
    const kind: AppDirectoryEntryKind = stats.isSymbolicLink()
      ? 'symlink'
      : stats.isFile()
        ? 'file'
        : stats.isDirectory()
          ? 'directory'
          : 'other';
    if (
      kind !== expected.kind
      || stats.dev !== expected.dev
      || stats.ino !== expected.ino
    ) {
      throw authorityError('cleanup identity path changed after validation');
    }
    return stats;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return null;
    throw error;
  }
};

const restoreRemainingFileIdentity = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  quarantineBasename: string,
  relativePath: string,
  expected: ScopedDirectoryEntryIdentity,
): Promise<void> => {
  const quarantineAnchor = {parent: anchor.parent, basename: quarantineBasename};
  const quarantine = await inspectAnchoredEntry(quarantineAnchor, relativePath);
  if (anchoredEntryMatchesIdentity(quarantine.kind, quarantine.stats, expected)) {
    await restoreQuarantinedEntry(
      state,
      anchor,
      quarantineBasename,
      relativePath,
      expected,
    );
    return;
  }
  let occupied = false;
  try {
    await link(
      volumePath(expected.dev, expected.ino),
      path.join(anchor.parent.volumePath, anchor.basename),
    );
  } catch (error) {
    if (isNodeError(error) && error.code === 'EEXIST') occupied = true;
    else throw error;
  }
  await assertScopedPathAnchorStable(state, anchor, relativePath);
  if (!occupied) {
    const restored = await inspectAnchoredEntry(anchor, relativePath);
    if (!anchoredEntryMatchesIdentity(restored.kind, restored.stats, expected)) {
      throw authorityError(`cleanup remaining inode restore changed identity: ${relativePath}`);
    }
  }
  const remainingQuarantine = await inspectAnchoredEntry(
    quarantineAnchor,
    relativePath,
  );
  if (remainingQuarantine.kind !== 'missing') {
    throw authorityError(`cleanup quarantine remained after inode restore: ${relativePath}`);
  }
  await syncRemovedEntryParent(state, anchor, relativePath);
};

const removeAnchoredDirectoryByIdentity = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  relativePath: string,
  expected: AnchoredTreeEntryIdentity,
): Promise<void> => {
  try {
    await rmdir(volumePath(expected.dev, expected.ino));
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
  await assertScopedPathAnchorStable(state, anchor, relativePath);
  if (await inspectIdentityPath(expected) !== null) {
    throw authorityError(`cleanup directory identity remained after removal: ${relativePath}`);
  }
  const replacement = await inspectAnchoredEntry(anchor, relativePath);
  if (replacement.kind !== 'missing') {
    await syncRemovedEntryParent(state, anchor, relativePath);
    throw authorityError(`cleanup target was replaced during removal: ${relativePath}`);
  }
  await syncRemovedEntryParent(state, anchor, relativePath);
};

const restoreQuarantineAfterFailure = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  quarantineBasename: string,
  relativePath: string,
  expected: ScopedDirectoryEntryIdentity,
  primaryError: unknown,
): Promise<never> => {
  try {
    await restoreQuarantinedEntry(
      state,
      anchor,
      quarantineBasename,
      relativePath,
      expected,
    );
  } catch (restoreError) {
    throw new AggregateError(
      [primaryError, restoreError],
      `cleanup quarantine and restore both failed for ${relativePath}`,
      {cause: primaryError},
    );
  }
  throw primaryError;
};

const removeAnchoredEntryThroughQuarantine = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  relativePath: string,
  expected: AnchoredTreeEntryIdentity,
): Promise<void> => {
  const validated = await revalidateAnchoredTreeEntry(
    state,
    anchor,
    relativePath,
    expected,
  );
  if (validated === null) return;
  if (expected.kind === 'directory') {
    await removeAnchoredDirectoryByIdentity(state, anchor, relativePath, expected);
    return;
  }
  if (validated.nlink !== 1n) {
    throw authorityError(`cleanup target has unexpected hard links: ${relativePath}`);
  }

  const quarantineBasename = await unusedQuarantineBasename(anchor, relativePath);
  const quarantineAnchor = {parent: anchor.parent, basename: quarantineBasename};
  const sourcePath = path.join(anchor.parent.volumePath, anchor.basename);
  const quarantinePath = path.join(anchor.parent.volumePath, quarantineBasename);
  const expectedEntry: ScopedDirectoryEntryIdentity = expected;
  try {
    await rename(sourcePath, quarantinePath);
  } catch (error) {
    const quarantined = await inspectAnchoredEntry(quarantineAnchor, relativePath);
    if (anchoredEntryMatchesIdentity(
      quarantined.kind,
      quarantined.stats,
      expectedEntry,
    )) {
      return await restoreQuarantineAfterFailure(
        state,
        anchor,
        quarantineBasename,
        relativePath,
        expectedEntry,
        error,
      );
    }
    if (isNodeError(error) && error.code === 'ENOENT') {
      await assertScopedPathAnchorStable(state, anchor, relativePath);
      if ((await inspectAnchoredEntry(anchor, relativePath)).kind === 'missing') {
        await syncRemovedEntryParent(state, anchor, relativePath);
        return;
      }
    }
    throw error;
  }

  await assertScopedPathAnchorStable(state, anchor, relativePath);
  const quarantined = await inspectAnchoredEntry(quarantineAnchor, relativePath);
  if (quarantined.kind === 'missing' || quarantined.stats === undefined) {
    throw authorityError(`cleanup quarantine disappeared after rename: ${relativePath}`);
  }
  const quarantinedIdentity: ScopedDirectoryEntryIdentity = {
    kind: quarantined.kind,
    dev: quarantined.stats.dev,
    ino: quarantined.stats.ino,
  };
  if (
    quarantined.kind === 'symlink'
    || quarantined.kind === 'other'
    || !anchoredEntryMatchesIdentity(
      quarantined.kind,
      quarantined.stats,
      expectedEntry,
    )
  ) {
    return await restoreQuarantineAfterFailure(
      state,
      anchor,
      quarantineBasename,
      relativePath,
      quarantinedIdentity,
      authorityError(`cleanup target changed while entering quarantine: ${relativePath}`),
    );
  }
  if (expected.kind === 'file' && quarantined.stats.nlink !== 1n) {
    return await restoreQuarantineAfterFailure(
      state,
      anchor,
      quarantineBasename,
      relativePath,
      expectedEntry,
      authorityError(`cleanup target has unexpected hard links: ${relativePath}`),
    );
  }

  try {
    await unlink(volumePath(expected.dev, expected.ino));
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      return await restoreQuarantineAfterFailure(
        state,
        anchor,
        quarantineBasename,
        relativePath,
        expectedEntry,
        error,
      );
    }
  }

  await assertScopedPathAnchorStable(state, anchor, relativePath);
  if (await inspectIdentityPath(expectedEntry) !== null) {
    const primaryError = authorityError(
      `cleanup target gained hard links during removal: ${relativePath}`,
    );
    try {
      await restoreRemainingFileIdentity(
        state,
        anchor,
        quarantineBasename,
        relativePath,
        expectedEntry,
      );
    } catch (restoreError) {
      throw new AggregateError(
        [primaryError, restoreError],
        `cleanup remaining inode and restore both failed for ${relativePath}`,
        {cause: primaryError},
      );
    }
    throw primaryError;
  }
  const remaining = await inspectAnchoredEntry(quarantineAnchor, relativePath);
  if (remaining.kind !== 'missing') {
    if (remaining.stats === undefined) {
      throw authorityError(`cleanup quarantine became unreadable: ${relativePath}`);
    }
    const remainingIdentity: ScopedDirectoryEntryIdentity = {
      kind: remaining.kind,
      dev: remaining.stats.dev,
      ino: remaining.stats.ino,
    };
    return await restoreQuarantineAfterFailure(
      state,
      anchor,
      quarantineBasename,
      relativePath,
      remainingIdentity,
      authorityError(`cleanup quarantine changed during removal: ${relativePath}`),
    );
  }
  const replacement = await inspectAnchoredEntry(anchor, relativePath);
  if (replacement.kind !== 'missing') {
    await syncRemovedEntryParent(state, anchor, relativePath);
    throw authorityError(`cleanup target was replaced during removal: ${relativePath}`);
  }
  await syncRemovedEntryParent(state, anchor, relativePath);
};

const removeAnchoredTreeEntry = async (
  state: ScopeState,
  anchor: ScopedPathAnchor,
  relativePath: string,
  expectedIdentity?: ScopedDirectoryEntryIdentity,
): Promise<void> => {
  const initial = await inspectAnchoredEntry(anchor, relativePath);
  if (initial.kind === 'missing') {
    await assertScopedPathAnchorStable(state, anchor, relativePath);
    return;
  }
  if (
    initial.stats === undefined
    || initial.kind === 'symlink'
    || initial.kind === 'other'
  ) {
    throw securityError(`refusing to remove unsafe app entry: ${relativePath}`);
  }
  if (
    expectedIdentity !== undefined
    && (
      initial.kind !== expectedIdentity.kind
      || initial.stats.dev !== expectedIdentity.dev
      || initial.stats.ino !== expectedIdentity.ino
    )
  ) {
    throw authorityError(`app-owned tree entry changed after listing: ${relativePath}`);
  }
  const expected = anchoredTreeEntryIdentity(initial.kind, initial.stats);
  if (initial.kind === 'file') {
    await removeAnchoredEntryThroughQuarantine(
      state,
      anchor,
      relativePath,
      expected,
    );
    return;
  }

  if (await revalidateAnchoredTreeEntry(
    state,
    anchor,
    relativePath,
    expected,
  ) === null) return;
  const directoryIdentity: DirectoryIdentity = {
    path: path.join(anchor.parent.identity.path, anchor.basename),
    dev: expected.dev,
    ino: expected.ino,
  };
  const directory = await openDirectoryAnchor(directoryIdentity, relativePath);
  try {
    await assertDirectoryAnchorStable(directory, relativePath);
    const names = (await readdir(directory.volumePath)).sort();
    for (const name of names) {
      await removeAnchoredTreeEntry(
        state,
        {parent: directory, basename: name},
        `${relativePath}/${name}`,
      );
    }
    await assertDirectoryAnchorStable(directory, relativePath);
    if ((await readdir(directory.volumePath)).length !== 0) {
      throw authorityError(`app-owned directory changed while removing: ${relativePath}`);
    }
    await removeAnchoredEntryThroughQuarantine(
      state,
      anchor,
      relativePath,
      expected,
    );
  } finally {
    await closeDirectoryAnchor(directory);
  }
};

const removeScopedTree = async (
  state: ScopeState,
  relativePath: string,
): Promise<void> => {
  const normalizedPath = parseRelativePath(relativePath).join('/');
  let anchor: ScopedPathAnchor;
  try {
    anchor = await openScopedPathAnchor(state, relativePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      state.listedEntries.delete(normalizedPath);
      return;
    }
    throw error;
  }
  try {
    await removeAnchoredTreeEntry(
      state,
      anchor,
      relativePath,
      state.listedEntries.get(normalizedPath),
    );
    state.listedEntries.delete(normalizedPath);
  } finally {
    await closeDirectoryAnchor(anchor.parent);
  }
};

const unlinkHeldCreatedFile = async (
  identity: RegularFileIdentity,
  handle: FileHandle,
  relativePath: string,
): Promise<void> => {
  let held: BigIntStats;
  let handleOpen = true;
  try {
    held = await handle.stat({bigint: true});
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EBADF') throw error;
    handleOpen = false;
    try {
      held = await lstat(volumePath(identity.dev, identity.ino), {bigint: true});
    } catch (identityError) {
      if (isNodeError(identityError) && identityError.code === 'ENOENT') return;
      throw identityError;
    }
  }
  if (
    !held.isFile()
    || held.dev !== identity.dev
    || held.ino !== identity.ino
  ) {
    throw authorityError(`created app-owned file identity changed before cleanup: ${relativePath}`);
  }
  if (held.nlink === 0n) return;
  if (held.nlink !== 1n) {
    throw authorityError(`created app-owned file has unexpected hard links: ${relativePath}`);
  }
  await unlink(volumePath(held.dev, held.ino));
  if (handleOpen) {
    const removed = await handle.stat({bigint: true});
    if (removed.nlink !== 0n) {
      throw authorityError(`created app-owned file remains linked after cleanup: ${relativePath}`);
    }
    return;
  }
  try {
    await lstat(volumePath(identity.dev, identity.ino), {bigint: true});
    throw authorityError(`created app-owned file remains linked after cleanup: ${relativePath}`);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
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
  let parentSyncAnchor: DirectoryAnchor | undefined;
  let createdIdentity: RegularFileIdentity | undefined;
  let fileCreated = false;
  let transferred = false;
  try {
    await assertScopedReadPathStable(state, pathAuthority, relativePath);
    parentSyncAnchor = await openDirectoryAnchor(
      anchor.parent.identity,
      relativePath,
    );
    handle = await open(
      path.join(anchor.parent.volumePath, anchor.basename),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW_ANY,
      0o600,
    );
    fileCreated = true;
    const created = await handle.stat({bigint: true});
    if (!created.isFile() || created.nlink !== 1n) {
      throw authorityError(`created app-owned target is not a regular file: ${relativePath}`);
    }
    createdIdentity = regularFileIdentity(created);
    const current = await inspectAnchoredEntry(anchor, relativePath);
    if (
      current.kind !== 'file'
      || current.stats === undefined
      || !regularFileIdentityMatches(current.stats, createdIdentity)
    ) {
      throw authorityError(`created app-owned target changed while opening: ${relativePath}`);
    }

    const openedHandle = handle;
    const openedIdentity = createdIdentity;
    const retainedParentSyncAnchor = parentSyncAnchor;
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
        throw authorityError(`created app-owned target changed: ${relativePath}`);
      }
    };
    const syncAndSeal = async (): Promise<void> => {
      await openedHandle.sync();
      const held = await openedHandle.stat({bigint: true});
      if (!sameRegularFileObject(held, openedIdentity)) {
        throw authorityError(`created app-owned target changed while writing: ${relativePath}`);
      }
      const identity = regularFileIdentity(held);
      await assertScopedReadPathStable(state, pathAuthority, relativePath);
      const currentTarget = await inspectAnchoredEntry(anchor, relativePath);
      if (
        currentTarget.kind !== 'file'
        || currentTarget.stats === undefined
        || !regularFileIdentityMatches(currentTarget.stats, identity)
      ) {
        throw authorityError(`created app-owned target changed while syncing: ${relativePath}`);
      }
      sealedIdentity = identity;
    };
    const syncParent = async (): Promise<void> => {
      await syncHeldDirectoryAnchor(retainedParentSyncAnchor, relativePath);
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
          throw authorityError(`created app-owned target changed while reopening: ${relativePath}`);
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
              throw authorityError(`created app-owned read handle changed: ${relativePath}`);
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
    let fileClosed = false;
    let directoriesClosed = false;
    let parentSyncClosed = false;
    let unlinked = false;
    const result: AppDirectoryWriteFileAuthority = {
      handle: openedHandle,
      syncAndSeal,
      syncParent,
      openForRead,
      revalidate,
      unlink: async () => {
        await unlinkHeldCreatedFile(
          openedIdentity,
          openedHandle,
          relativePath,
        );
        unlinked = true;
      },
      close: async () => {
        if (fileClosed && directoriesClosed && parentSyncClosed) return;
        let fileCloseError: unknown;
        let directoryCloseError: unknown;
        let parentSyncCloseError: unknown;
        if (!directoriesClosed) {
          try {
            await closeDirectoryAnchors(pathAuthority.directories);
            directoriesClosed = true;
          } catch (error) {
            directoryCloseError = error;
          }
        }
        if (!parentSyncClosed && (directoriesClosed || unlinked)) {
          try {
            await closeDirectoryAnchor(retainedParentSyncAnchor);
            parentSyncClosed = true;
          } catch (error) {
            parentSyncCloseError = error;
          }
        }
        if (
          !fileClosed
          && ((directoriesClosed && parentSyncClosed) || unlinked)
        ) {
          try {
            await openedHandle.close();
            fileClosed = true;
          } catch (error) {
            fileCloseError = error;
          }
        }
        const closeErrors = [
          directoryCloseError,
          parentSyncCloseError,
          fileCloseError,
        ].filter((error): error is NonNullable<unknown> => error !== undefined);
        if (closeErrors.length > 1) {
          throw new AggregateError(
            closeErrors,
            'failed to close scoped artifact write authority',
            {cause: closeErrors[0]},
          );
        }
        if (closeErrors.length === 1) throw closeErrors[0];
      },
    };
    handle = undefined;
    parentSyncAnchor = undefined;
    createdIdentity = undefined;
    transferred = true;
    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    let cleanupIdentity = createdIdentity;
    if (fileCreated && handle !== undefined && cleanupIdentity === undefined) {
      try {
        const recovered = await handle.stat({bigint: true});
        if (
          !recovered.isFile()
          || (recovered.nlink !== 0n && recovered.nlink !== 1n)
        ) {
          throw authorityError(
            `created app-owned file identity is unsafe for cleanup: ${relativePath}`,
          );
        }
        cleanupIdentity = regularFileIdentity(recovered);
      } catch (identityError) {
        cleanupErrors.push(authorityError(
          `created app-owned file identity could not be recovered for cleanup: ${relativePath}`,
          identityError,
        ));
      }
    }
    if (handle !== undefined && cleanupIdentity !== undefined) {
      try {
        await unlinkHeldCreatedFile(
          cleanupIdentity,
          handle,
          relativePath,
        );
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (
      handle !== undefined
      && cleanupIdentity !== undefined
      && parentSyncAnchor !== undefined
    ) {
      try {
        await syncHeldDirectoryAnchor(parentSyncAnchor, relativePath);
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
        try {
          if (parentSyncAnchor !== undefined) {
            await closeDirectoryAnchor(parentSyncAnchor);
          }
        } finally {
          await closeDirectoryAnchors(pathAuthority.directories);
        }
      }
    }
  }
};

const unlinkScopedFile = async (
  state: ScopeState,
  relativePath: string,
): Promise<void> => {
  let anchor: ScopedPathAnchor;
  try {
    anchor = await openScopedPathAnchor(state, relativePath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  try {
    const initial = await inspectAnchoredEntry(anchor, relativePath);
    const {kind} = initial;
    if (kind === 'missing') {
      await assertScopedPathAnchorStable(state, anchor, relativePath);
      await syncHeldDirectoryAnchor(anchor.parent, relativePath);
      return;
    }
    if (kind !== 'file') {
      throw securityError(`refusing to unlink non-file app entry: ${relativePath}`);
    }
    if (initial.stats === undefined) {
      throw authorityError(`app-owned unlink target identity is unavailable: ${relativePath}`);
    }
    await removeAnchoredEntryThroughQuarantine(
      state,
      anchor,
      relativePath,
      anchoredTreeEntryIdentity('file', initial.stats),
    );
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
    const targetKind = (await inspectAnchoredEntry(target, targetRelativePath)).kind;
    if (targetKind === 'file') {
      throw Object.assign(
        new Error(`app-owned link target already exists: ${targetRelativePath}`),
        {code: 'EEXIST'},
      );
    }
    if (targetKind !== 'missing') {
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

const linkScopedFileAuthority = async (
  state: ScopeState,
  sourceRelativePath: string,
  targetRelativePath: string,
  sourceAuthority: AppDirectoryWriteFileAuthority,
): Promise<AppDirectoryLinkedFileAuthority> => {
  const source = await openScopedPathAnchor(state, sourceRelativePath);
  let target: ScopedPathAnchor | undefined;
  let linked = false;
  let transferred = false;
  let postLinkAnchorsClosed = false;
  try {
    target = await openScopedPathAnchor(state, targetRelativePath);
    if (!identityMatchesStats(source.parent.identity, await target.parent.handle.stat({
      bigint: true,
    }))) {
      throw authorityError('hard-link source and target must share a held parent directory');
    }
    const heldBeforeLink = await sourceAuthority.handle.stat({bigint: true});
    const sourceEntry = await inspectAnchoredEntry(source, sourceRelativePath);
    if (
      sourceEntry.kind !== 'file'
      || sourceEntry.stats === undefined
      || !regularFileIdentityMatches(
        sourceEntry.stats,
        regularFileIdentity(heldBeforeLink),
      )
    ) {
      throw authorityError(`link source authority changed: ${sourceRelativePath}`);
    }
    const targetKind = (await inspectAnchoredEntry(target, targetRelativePath)).kind;
    if (targetKind === 'file') {
      throw Object.assign(
        new Error(`app-owned link target already exists: ${targetRelativePath}`),
        {code: 'EEXIST'},
      );
    }
    if (targetKind !== 'missing') {
      throw securityError(`link target must be absent: ${targetRelativePath}`);
    }
    await assertScopedPathAnchorStable(state, source, sourceRelativePath);
    await assertScopedPathAnchorStable(state, target, targetRelativePath);
    await link(
      path.join(source.parent.volumePath, source.basename),
      path.join(target.parent.volumePath, target.basename),
    );
    linked = true;
    const heldAfterLink = await sourceAuthority.handle.stat({bigint: true});
    let linkedIdentity = regularFileIdentity(heldAfterLink);
    const retainedSource = source;
    const retainedTarget = target;
    const assertLinkedTarget = async (): Promise<void> => {
      const current = await inspectAnchoredEntry(retainedTarget, targetRelativePath);
      if (
        current.kind !== 'file'
        || current.stats === undefined
        || !regularFileIdentityMatches(current.stats, linkedIdentity)
      ) {
        throw authorityError(`linked app-owned target changed: ${targetRelativePath}`);
      }
    };
    await assertLinkedTarget();

    let closed = false;
    let sourceUnlinked = false;
    const refreshLinkedIdentityAfterSourceRemoval = async (): Promise<void> => {
      const held = await sourceAuthority.handle.stat({bigint: true});
      if (!held.isFile() || held.nlink !== 1n) {
        throw authorityError(
          `linked app-owned source removal is incomplete: ${sourceRelativePath}`,
        );
      }
      linkedIdentity = regularFileIdentity(held);
      await assertLinkedTarget();
      sourceUnlinked = true;
    };
    const result: AppDirectoryLinkedFileAuthority = {
      syncParent: async () => {
        if (closed) throw new TypeError('linked file authority is closed');
        await assertLinkedTarget();
        await syncHeldDirectoryAnchor(retainedTarget.parent, targetRelativePath);
        await assertLinkedTarget();
      },
      unlinkSource: async () => {
        if (closed) throw new TypeError('linked file authority is closed');
        if (sourceUnlinked) return;
        const sourceEntry = await inspectAnchoredEntry(
          retainedSource,
          sourceRelativePath,
        );
        if (sourceEntry.kind === 'missing') {
          await refreshLinkedIdentityAfterSourceRemoval();
          return;
        }
        if (
          sourceEntry.kind !== 'file'
          || sourceEntry.stats === undefined
          || !regularFileIdentityMatches(sourceEntry.stats, linkedIdentity)
        ) {
          throw authorityError(`linked app-owned source changed: ${sourceRelativePath}`);
        }
        await assertLinkedTarget();
        await unlink(path.join(
          retainedSource.parent.volumePath,
          retainedSource.basename,
        ));
        if ((await inspectAnchoredEntry(retainedSource, sourceRelativePath)).kind !== 'missing') {
          throw authorityError(
            `linked app-owned source remains after cleanup: ${sourceRelativePath}`,
          );
        }
        await refreshLinkedIdentityAfterSourceRemoval();
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await closeDirectoryAnchors([
          retainedSource.parent,
          retainedTarget.parent,
        ]);
      },
    };
    target = undefined;
    transferred = true;
    return result;
  } catch (error) {
    if (linked) {
      const cleanupErrors: unknown[] = [];
      const anchors = [source.parent, target?.parent].filter(
        (anchor): anchor is DirectoryAnchor => anchor !== undefined,
      );
      for (const anchor of [...anchors].reverse()) {
        try {
          await closeDirectoryAnchor(anchor);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      postLinkAnchorsClosed = true;
      throw new AppDirectoryLinkOutcomeError(
        sourceRelativePath,
        targetRelativePath,
        error,
        cleanupErrors,
      );
    }
    throw error;
  } finally {
    if (!transferred && !postLinkAnchorsClosed) {
      const anchors = [source.parent, target?.parent].filter(
        (anchor): anchor is DirectoryAnchor => anchor !== undefined,
      );
      await closeDirectoryAnchors(anchors).catch(() => undefined);
    }
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
  const identity = identityFromStats(target, stats);
  const handle = await open(target, constants.O_RDONLY | O_NOFOLLOW_ANY);
  let syncError: unknown;
  try {
    await handle.sync();
    const held = await handle.stat({bigint: true});
    if (!held.isDirectory() || !identityMatchesStats(identity, held)) {
      throw authorityError(`directory sync authority changed: ${relativePath}`);
    }
    await assertScopeStable(state, relativePath);
    await assertDirectoryIdentityStable(identity, relativePath);
  } catch (error) {
    syncError = error;
  }
  let closeError: unknown;
  try {
    await handle.close();
  } catch (error) {
    closeError = error;
  }
  if (syncError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [syncError, closeError],
      `failed to sync scoped directory: ${relativePath}`,
      {cause: syncError},
    );
  }
  if (syncError !== undefined) throw syncError;
  if (closeError !== undefined) throw closeError;
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

export const listWorkDirectory = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<ScopedDirectoryEntry[]> => await listScopedDirectory(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

export const listRunDirectory = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<ScopedDirectoryEntry[]> => await listScopedDirectory(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
);

export const listOutputDirectory = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<ScopedDirectoryEntry[]> => await listScopedDirectory(
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

export const removeRunTree = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<void> => await removeScopedTree(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
);

export const removeWorkTree = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<void> => await removeScopedTree(
  stateFor(workStates, scope, 'WorkDirectoryScope'),
  relativePath,
);

export const removeOutputTree = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<void> => await removeScopedTree(
  stateFor(outputStates, scope, 'OutputDirectoryScope'),
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

export const linkRunFile = async (
  scope: RunDirectoryScope,
  sourceRelativePath: string,
  targetRelativePath: string,
  sourceAuthority: AppDirectoryWriteFileAuthority,
): Promise<AppDirectoryLinkedFileAuthority> => await linkScopedFileAuthority(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  sourceRelativePath,
  targetRelativePath,
  sourceAuthority,
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

export const syncRunDirectory = async (
  scope: RunDirectoryScope,
  relativePath = '.',
): Promise<void> => await syncScopedDirectory(
  stateFor(runStates, scope, 'RunDirectoryScope'),
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
      throw authorityError('project lock file handle identity changed');
    }
    if (held.nlink === 0n) return 'missing';
    if (held.nlink !== 1n) {
      throw authorityError('project lock has unexpected hard links');
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
    tempHandle = await authority.openNew(scope, TEMP_PATH);
    tempCreated = true;
    await fileOps.writeFile(tempHandle, serializePointer(pointer));
    await fileOps.syncFile(tempHandle);
    await tempHandle.close();
    tempHandle = undefined;

    await fileOps.rename(
      async () => {
        if (oldRaw !== null) {
          await authority.link(scope, CURRENT_PATH, ROLLBACK_PATH);
          backupCreated = true;
        }
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
    if (committed) return;
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

  async openExistingWork(projectId: string): Promise<WorkDirectoryScope | null> {
    return await openExistingWorkScope(this.#workspace, projectId);
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

  async readCurrentReadonly(projectId: string): Promise<CurrentPointer | null> {
    const work = await openExistingWorkScope(this.#workspace, projectId);
    if (work === null) return null;
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

  async openExistingProject(
    projectId: string,
  ): Promise<OutputDirectoryScope | null> {
    return await openExistingOutputScope(this.#workspace, projectId);
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

  async readCurrentReadonly(projectId: string): Promise<CurrentPointer | null> {
    const output = await openExistingOutputScope(this.#workspace, projectId);
    if (output === null) return null;
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
