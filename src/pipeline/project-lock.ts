import {hostname as nodeHostname} from 'node:os';
import {StableIdSchema} from '../domain/schema-primitives';
import {
  inspectProjectLockFile,
  openExistingProjectLockFile,
  openNewProjectLockFile,
  unlinkProjectLockFile,
  type WorkDirectoryScope,
} from '../fs/app-directory-scopes';
import {ProcessExecutionError} from '../process/process-error';
import {runProcess} from '../process/run-process';

export interface ProjectLockRecord {
  pid: number;
  hostname: string;
  processStart: string;
  createdAt: string;
  runId: string;
}

export type ProjectLockErrorCode =
  | 'PROJECT_LOCKED'
  | 'PROJECT_LOCK_STALE'
  | 'PROJECT_LOCK_INVALID';

export class ProjectLockError extends Error {
  constructor(
    readonly code: ProjectLockErrorCode,
    message: string,
    readonly record?: ProjectLockRecord,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ProjectLockError';
  }
}

export interface ProjectLockRuntime {
  currentPid(): number;
  hostname(): string;
  now(): Date;
  isProcessAlive(pid: number): Promise<boolean>;
  processStart(pid: number): Promise<string | null>;
}

export interface ProjectLockLease {
  readonly record: ProjectLockRecord;
  release(): Promise<void>;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const defaultIsProcessAlive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return false;
    if (isNodeError(error) && error.code === 'EPERM') return true;
    throw error;
  }
};

const defaultProcessStart = async (pid: number): Promise<string | null> => {
  if (process.platform !== 'darwin') {
    throw new ProjectLockError(
      'PROJECT_LOCK_INVALID',
      `process-start markers require Darwin; received ${process.platform}`,
    );
  }
  try {
    const result = await runProcess(
      '/bin/ps',
      ['-o', 'lstart=', '-p', String(pid)],
      {timeoutMs: 2_000},
    );
    const marker = result.stdout.trim().replace(/\s+/g, ' ');
    return marker.length === 0 ? null : marker;
  } catch (error) {
    if (
      error instanceof ProcessExecutionError
      && error.code === 'PROCESS_EXIT_NONZERO'
    ) {
      return null;
    }
    throw error;
  }
};

const defaultRuntime: ProjectLockRuntime = {
  currentPid: () => process.pid,
  hostname: nodeHostname,
  now: () => new Date(),
  isProcessAlive: defaultIsProcessAlive,
  processStart: defaultProcessStart,
};

const exactKeys = [
  'pid',
  'hostname',
  'processStart',
  'createdAt',
  'runId',
] as const;

const parseRecord = (raw: string): ProjectLockRecord => {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new ProjectLockError(
      'PROJECT_LOCK_INVALID',
      'project lock is not valid JSON',
      undefined,
      {cause: error},
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProjectLockError('PROJECT_LOCK_INVALID', 'project lock must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('\0') !== [...exactKeys].sort().join('\0')
    || !Number.isSafeInteger(record.pid)
    || (record.pid as number) <= 0
    || typeof record.hostname !== 'string'
    || record.hostname.length === 0
    || typeof record.processStart !== 'string'
    || record.processStart.length === 0
    || typeof record.createdAt !== 'string'
    || typeof record.runId !== 'string'
  ) {
    throw new ProjectLockError('PROJECT_LOCK_INVALID', 'project lock shape is invalid');
  }
  try {
    StableIdSchema.parse(record.runId);
  } catch (error) {
    throw new ProjectLockError(
      'PROJECT_LOCK_INVALID',
      'project lock runId is invalid',
      undefined,
      {cause: error},
    );
  }
  const date = new Date(record.createdAt);
  if (
    Number.isNaN(date.valueOf())
    || date.toISOString() !== record.createdAt
  ) {
    throw new ProjectLockError('PROJECT_LOCK_INVALID', 'project lock createdAt is invalid');
  }
  return {
    pid: record.pid as number,
    hostname: record.hostname,
    processStart: record.processStart,
    createdAt: record.createdAt,
    runId: record.runId,
  };
};

const serializeRecord = (record: ProjectLockRecord): string =>
  `${JSON.stringify(record, null, 2)}\n`;

const readRawLock = async (
  work: WorkDirectoryScope,
): Promise<string | undefined> => {
  const kind = await inspectProjectLockFile(work);
  if (kind === 'missing') return undefined;
  if (kind !== 'file') {
    throw new ProjectLockError(
      'PROJECT_LOCK_INVALID',
      'project lock path is not a regular file',
    );
  }
  const handle = await openExistingProjectLockFile(work);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

const classifyRecord = async (
  record: ProjectLockRecord,
  runtime: ProjectLockRuntime,
): Promise<'live' | 'stale'> => {
  if (record.hostname !== runtime.hostname()) return 'live';
  if (!await runtime.isProcessAlive(record.pid)) return 'stale';
  const currentStart = await runtime.processStart(record.pid);
  if (currentStart === null || currentStart.trim().length === 0) return 'live';
  if (currentStart.trim() !== record.processStart.trim()) return 'stale';
  return 'live';
};

const conflictError = async (
  record: ProjectLockRecord,
  runtime: ProjectLockRuntime,
): Promise<ProjectLockError> => {
  const state = await classifyRecord(record, runtime);
  return state === 'stale'
    ? new ProjectLockError(
      'PROJECT_LOCK_STALE',
      `project lock for ${record.runId} is stale and requires explicit clearing`,
      record,
    )
    : new ProjectLockError(
      'PROJECT_LOCKED',
      `project is locked by run ${record.runId}`,
      record,
    );
};

const recordsEqual = (
  left: ProjectLockRecord,
  right: ProjectLockRecord,
): boolean => exactKeys.every((key) => left[key] === right[key]);

const writeNewLock = async (
  work: WorkDirectoryScope,
  record: ProjectLockRecord,
): Promise<void> => {
  const handle = await openNewProjectLockFile(work);
  let complete = false;
  try {
    await handle.writeFile(serializeRecord(record));
    await handle.sync();
    complete = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!complete) await unlinkProjectLockFile(work).catch(() => undefined);
  }
};

export async function acquireProjectLock(
  work: WorkDirectoryScope,
  runId: string,
  runtime: ProjectLockRuntime = defaultRuntime,
): Promise<ProjectLockLease> {
  const validatedRunId = StableIdSchema.parse(runId);
  const pid = runtime.currentPid();
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new ProjectLockError('PROJECT_LOCK_INVALID', 'current PID is invalid');
  }
  const processStart = await runtime.processStart(pid);
  if (processStart === null || processStart.length === 0) {
    throw new ProjectLockError(
      'PROJECT_LOCK_INVALID',
      `could not determine process-start marker for PID ${pid}`,
    );
  }
  const record: ProjectLockRecord = {
    pid,
    hostname: runtime.hostname(),
    processStart,
    createdAt: runtime.now().toISOString(),
    runId: validatedRunId,
  };

  try {
    await writeNewLock(work, record);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    const raw = await readRawLock(work);
    if (raw === undefined) return await acquireProjectLock(work, runId, runtime);
    const existing = parseRecord(raw);
    throw await conflictError(existing, runtime);
  }

  let released = false;
  return {
    record,
    release: async () => {
      if (released) return;
      const raw = await readRawLock(work).catch(() => undefined);
      if (raw === undefined) {
        released = true;
        return;
      }
      let current: ProjectLockRecord;
      try {
        current = parseRecord(raw);
      } catch {
        return;
      }
      if (!recordsEqual(current, record) || current.runId !== record.runId) return;
      await unlinkProjectLockFile(work);
      released = true;
    },
  };
}

export async function clearStaleLock(
  work: WorkDirectoryScope,
  runtime: ProjectLockRuntime = defaultRuntime,
): Promise<void> {
  const initialRaw = await readRawLock(work);
  if (initialRaw === undefined) return;
  const initial = parseRecord(initialRaw);
  if (await classifyRecord(initial, runtime) !== 'stale') {
    throw new ProjectLockError(
      'PROJECT_LOCKED',
      `project is locked by run ${initial.runId}`,
      initial,
    );
  }

  const currentRaw = await readRawLock(work);
  if (currentRaw === undefined) return;
  const current = parseRecord(currentRaw);
  if (!recordsEqual(initial, current)) {
    throw new ProjectLockError(
      'PROJECT_LOCKED',
      `project lock changed to run ${current.runId} while clearing`,
      current,
    );
  }
  await unlinkProjectLockFile(work);
}
