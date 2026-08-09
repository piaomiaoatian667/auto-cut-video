import type {FileHandle} from 'node:fs/promises';
import {StableIdSchema} from '../domain/schema-primitives';
import type {
  AppDirectoryEntryKind,
  OutputDirectoryScope,
  RunDirectoryScope,
  WorkDirectoryScope,
} from '../fs/app-directory-scopes';

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

export type FileOpsPhase = 'publish';

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

export interface RunStoreAuthority {
  createWork(projectId: string): Promise<WorkDirectoryScope>;
  createRun(projectId: string, runId: string): Promise<RunDirectoryScope>;
  openExistingRun(projectId: string, runId: string): Promise<RunDirectoryScope>;
  workPointer: PointerScopeAuthority<WorkDirectoryScope>;
}

export interface OutputStoreAuthority {
  openProject(projectId: string): Promise<OutputDirectoryScope>;
  createRelease(projectId: string, runId: string): Promise<OutputDirectoryScope>;
  openRelease(projectId: string, runId: string): Promise<OutputDirectoryScope>;
  outputPointer: PointerScopeAuthority<OutputDirectoryScope>;
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

const assertScratchPathAbsent = async <Scope>(
  scope: Scope,
  authority: PointerScopeAuthority<Scope>,
  relativePath: string,
): Promise<void> => {
  const kind = await authority.inspect(scope, relativePath);
  if (kind === 'missing') return;
  if (kind === 'symlink' || kind === 'directory' || kind === 'other') {
    return unsafePointer(relativePath);
  }
  throw new RunStoreError(
    'RUN_POINTER_TEMP_EXISTS',
    `pointer scratch file already exists: ${relativePath}`,
  );
};

const cleanupRegularFile = async <Scope>(
  scope: Scope,
  authority: PointerScopeAuthority<Scope>,
  relativePath: string,
): Promise<void> => {
  const kind = await authority.inspect(scope, relativePath).catch(() => 'missing' as const);
  if (kind === 'file') await authority.unlink(scope, relativePath).catch(() => undefined);
};

const publishPointer = async <Scope>(
  scope: Scope,
  authority: PointerScopeAuthority<Scope>,
  pointer: CurrentPointer,
  fileOps: FileOps,
): Promise<void> => {
  const oldRaw = await readPointerRaw(scope, authority);
  await assertScratchPathAbsent(scope, authority, TEMP_PATH);
  await assertScratchPathAbsent(scope, authority, ROLLBACK_PATH);

  let tempHandle: FileHandle | undefined;
  let tempCreated = false;
  let backupCreated = false;
  let published = false;
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

    if (backupCreated) {
      await authority.unlink(scope, ROLLBACK_PATH);
      backupCreated = false;
    }
  } catch (error) {
    await tempHandle?.close().catch(() => undefined);
    let rollbackError: unknown;
    if (published) {
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
    if (tempCreated) await cleanupRegularFile(scope, authority, TEMP_PATH);
    if (backupCreated) await cleanupRegularFile(scope, authority, ROLLBACK_PATH);
    if (rollbackError !== undefined) {
      throw new RunStoreError(
        'RUN_POINTER_ROLLBACK_FAILED',
        'pointer publication failed and the old pointer could not be restored',
        {cause: new AggregateError([error, rollbackError])},
      );
    }
    throw error;
  }
};

let instantiateRunStore!: (
  authority: RunStoreAuthority,
  options: RunStoreOptions,
) => RunStore;
let instantiateOutputStore!: (
  authority: OutputStoreAuthority,
  options: RunStoreOptions,
) => OutputStore;

export class RunStore {
  readonly #authority: RunStoreAuthority;
  readonly #fileOps: FileOps;

  private constructor(
    authority: RunStoreAuthority,
    options: RunStoreOptions = {},
  ) {
    this.#authority = authority;
    this.#fileOps = mergeFileOps(options);
    Object.freeze(this);
  }

  static {
    instantiateRunStore = (authority, options) => new RunStore(authority, options);
  }

  async createWork(projectId: string): Promise<WorkDirectoryScope> {
    return await this.#authority.createWork(projectId);
  }

  async createRun(projectId: string, runId: string): Promise<RunDirectoryScope> {
    return await this.#authority.createRun(projectId, runId);
  }

  async openExistingRun(
    projectId: string,
    runId: string,
  ): Promise<RunDirectoryScope> {
    return await this.#authority.openExistingRun(projectId, runId);
  }

  async readCurrent(projectId: string): Promise<CurrentPointer | null> {
    const work = await this.#authority.createWork(projectId);
    const raw = await readPointerRaw(work, this.#authority.workPointer);
    return raw === null ? null : parsePointer(raw, 'work');
  }

  async publishCurrent(
    projectId: string,
    value: CurrentPointer,
  ): Promise<void> {
    const pointer = validatePointer(value, 'work');
    await this.#authority.openExistingRun(projectId, pointer.runId);
    const work = await this.#authority.createWork(projectId);
    await publishPointer(work, this.#authority.workPointer, pointer, this.#fileOps);
  }
}

export class OutputStore {
  readonly #authority: OutputStoreAuthority;
  readonly #fileOps: FileOps;

  private constructor(
    authority: OutputStoreAuthority,
    options: RunStoreOptions = {},
  ) {
    this.#authority = authority;
    this.#fileOps = mergeFileOps(options);
    Object.freeze(this);
  }

  static {
    instantiateOutputStore = (authority, options) => new OutputStore(
      authority,
      options,
    );
  }

  async openProject(projectId: string): Promise<OutputDirectoryScope> {
    return await this.#authority.openProject(projectId);
  }

  async createRelease(
    projectId: string,
    runId: string,
  ): Promise<OutputDirectoryScope> {
    return await this.#authority.createRelease(projectId, runId);
  }

  async readCurrent(projectId: string): Promise<CurrentPointer | null> {
    const output = await this.#authority.openProject(projectId);
    const raw = await readPointerRaw(output, this.#authority.outputPointer);
    return raw === null ? null : parsePointer(raw, 'output');
  }

  async publishCurrent(
    projectId: string,
    value: CurrentPointer,
  ): Promise<void> {
    const pointer = validatePointer(value, 'output');
    const output = await this.#authority.openRelease(projectId, pointer.runId);
    await publishPointer(output, this.#authority.outputPointer, pointer, this.#fileOps);
  }
}

export const createRunStoreWithAuthority = (
  authority: RunStoreAuthority,
  options: RunStoreOptions = {},
): RunStore => instantiateRunStore(authority, options);

export const createOutputStoreWithAuthority = (
  authority: OutputStoreAuthority,
  options: RunStoreOptions = {},
): OutputStore => instantiateOutputStore(authority, options);
