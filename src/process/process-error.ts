import type {ProcessResult} from './run-process';

export type ProcessErrorCode =
  | 'PROCESS_EXIT_NONZERO'
  | 'PROCESS_TIMEOUT'
  | 'PROCESS_ABORTED'
  | 'PROCESS_SPAWN_FAILED';

export class ProcessExecutionError extends Error {
  readonly code: ProcessErrorCode;
  readonly reason: string;
  readonly result: ProcessResult;

  constructor(
    code: ProcessErrorCode,
    reason: string,
    result: ProcessResult,
    cause?: unknown,
  ) {
    super(
      `${reason}: ${result.command}`,
      cause === undefined ? undefined : {cause},
    );
    this.name = 'ProcessExecutionError';
    this.code = code;
    this.reason = reason;
    this.result = result;
  }
}
