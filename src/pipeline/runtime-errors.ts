import type {StageId} from './run-store';

export type PipelineRuntimeErrorCode =
  | 'PIPELINE_CANCELLED'
  | 'DISK_SPACE_EXHAUSTED'
  | 'PLAN_STALE'
  | 'PIPELINE_STAGE_FAILED'
  | 'PIPELINE_CLEANUP_FAILED';

export class PipelineRuntimeError extends Error {
  constructor(
    readonly code: PipelineRuntimeErrorCode | string,
    message: string,
    readonly stageId?: StageId,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'PipelineRuntimeError';
  }
}

const TRUSTED_CODE = /^[A-Z][A-Z0-9_]*$/u;

const readTrustedCode = (error: unknown): string | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const code = (error as {code?: unknown}).code;
    return typeof code === 'string' && TRUSTED_CODE.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
};

const readErrorName = (error: unknown): string | undefined => {
  if (error === null || typeof error !== 'object') return undefined;
  try {
    const name = (error as {name?: unknown}).name;
    return typeof name === 'string' ? name : undefined;
  } catch {
    return undefined;
  }
};

const readCause = (error: object): {present: boolean; value?: unknown} => {
  try {
    if (!('cause' in error) || error.cause === undefined) return {present: false};
    return {present: true, value: error.cause};
  } catch {
    return {present: false};
  }
};

const readPrimaryCode = (
  error: unknown,
  seen: Set<object> = new Set(),
): string | undefined => {
  if (error === null || typeof error !== 'object' || seen.has(error)) {
    return undefined;
  }
  seen.add(error);
  if (readErrorName(error) === 'AbortError') return 'PROCESS_ABORTED';
  const direct = readTrustedCode(error);
  if (direct !== undefined) return direct;
  const cause = readCause(error);
  if (cause.present) return readPrimaryCode(cause.value, seen);
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      const nestedCode = readPrimaryCode(nested, seen);
      if (nestedCode !== undefined) return nestedCode;
    }
  }
  return undefined;
};

const normalizedCode = (error: unknown): string => {
  const code = readPrimaryCode(error);
  if (code === 'ENOSPC') return 'DISK_SPACE_EXHAUSTED';
  if (code === 'PROCESS_ABORTED' || code === 'ABORT_ERR') {
    return 'PIPELINE_CANCELLED';
  }
  return code ?? 'PIPELINE_STAGE_FAILED';
};

const publicMessage = (code: string, stageId?: StageId): string => {
  if (code === 'PIPELINE_CANCELLED') {
    return 'Pipeline execution was cancelled.';
  }
  if (code === 'DISK_SPACE_EXHAUSTED') {
    return 'Pipeline storage is exhausted.';
  }
  if (code === 'PLAN_STALE') return 'Pipeline plan is stale.';
  if (code === 'PIPELINE_CLEANUP_FAILED') return 'Pipeline cleanup failed.';
  if (code === 'PIPELINE_STAGE_FAILED') {
    return stageId === undefined
      ? 'Pipeline stage failed.'
      : `Pipeline stage ${stageId} failed.`;
  }
  return 'Pipeline operation failed.';
};

export const normalizePipelineError = (
  error: unknown,
  stageId?: StageId,
): PipelineRuntimeError => {
  if (error instanceof PipelineRuntimeError) return error;
  const code = normalizedCode(error);
  return new PipelineRuntimeError(
    code,
    publicMessage(code, stageId),
    stageId,
    {cause: error},
  );
};
