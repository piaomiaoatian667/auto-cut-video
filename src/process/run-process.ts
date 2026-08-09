import {spawn, type ChildProcess} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {StringDecoder} from 'node:string_decoder';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from './process-error';

export const PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const PROCESS_KILL_GRACE_MS = 100;
const PROCESS_FINAL_SETTLE_MS = 100;
const OUTPUT_TRUNCATED_MARKER = Buffer.from('\n[output truncated]\n');
const OUTPUT_CONTENT_LIMIT_BYTES = (
  PROCESS_OUTPUT_LIMIT_BYTES - OUTPUT_TRUNCATED_MARKER.byteLength
);
const OUTPUT_DECODE_CHUNK_BYTES = 16 * 1024;
const NOOP = (): void => {};

export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunProcessOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

interface TerminationReason {
  code: Extract<ProcessErrorCode, 'PROCESS_TIMEOUT' | 'PROCESS_ABORTED'>;
  reason: string;
  cause?: unknown;
}

const stringPrefixWithinBytes = (
  value: string,
  maximumBytes: number,
): string => {
  if (maximumBytes <= 0) return '';
  if (Buffer.byteLength(value) <= maximumBytes) return value;

  let lowerBound = 0;
  let upperBound = value.length;
  while (lowerBound < upperBound) {
    const candidate = Math.ceil((lowerBound + upperBound) / 2);
    if (Buffer.byteLength(value.slice(0, candidate)) <= maximumBytes) {
      lowerBound = candidate;
    } else {
      upperBound = candidate - 1;
    }
  }

  const lastCodeUnit = value.charCodeAt(lowerBound - 1);
  const safeLength = (
    lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
      ? lowerBound - 1
      : lowerBound
  );
  return value.slice(0, safeLength);
};

const decodeCapturedOutput = (
  buffer: Buffer,
  inputBytes: number,
  flushIncompleteSequence: boolean,
): {text: string; complete: boolean} => {
  const decoder = new StringDecoder('utf8');
  const decodedChunks: string[] = [];
  let remainingBytes = OUTPUT_CONTENT_LIMIT_BYTES;

  const append = (value: string): boolean => {
    if (value.length === 0) return true;
    const valueBytes = Buffer.byteLength(value);
    if (valueBytes <= remainingBytes) {
      decodedChunks.push(value);
      remainingBytes -= valueBytes;
      return true;
    }

    const prefix = stringPrefixWithinBytes(value, remainingBytes);
    if (prefix.length > 0) decodedChunks.push(prefix);
    remainingBytes -= Buffer.byteLength(prefix);
    return false;
  };

  for (let offset = 0; offset < inputBytes; offset += OUTPUT_DECODE_CHUNK_BYTES) {
    const end = Math.min(offset + OUTPUT_DECODE_CHUNK_BYTES, inputBytes);
    if (!append(decoder.write(buffer.subarray(offset, end)))) {
      return {text: decodedChunks.join(''), complete: false};
    }
  }

  if (flushIncompleteSequence && !append(decoder.end())) {
    return {text: decodedChunks.join(''), complete: false};
  }
  return {text: decodedChunks.join(''), complete: true};
};

class CappedOutput {
  private buffer: Buffer | undefined;
  private capturedBytes = 0;
  private truncated = false;

  append(chunk: Buffer | string): void {
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (source.byteLength === 0) return;

    const remainingBytes = OUTPUT_CONTENT_LIMIT_BYTES - this.capturedBytes;
    if (remainingBytes <= 0) {
      this.truncated = true;
      return;
    }

    this.buffer ??= Buffer.allocUnsafe(OUTPUT_CONTENT_LIMIT_BYTES);
    const copiedBytes = Math.min(source.byteLength, remainingBytes);
    source.copy(this.buffer, this.capturedBytes, 0, copiedBytes);
    this.capturedBytes += copiedBytes;
    if (copiedBytes < source.byteLength) this.truncated = true;
  }

  toString(): string {
    if (!this.buffer) return '';
    const decoded = decodeCapturedOutput(
      this.buffer,
      this.capturedBytes,
      !this.truncated,
    );
    if (!this.truncated && decoded.complete) return decoded.text;
    return decoded.text + OUTPUT_TRUNCATED_MARKER.toString('utf8');
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const abortReason = (signal: AbortSignal): string => {
  if (signal.reason === undefined) return 'process was aborted';
  if (signal.reason instanceof Error) {
    return `process was aborted: ${signal.reason.message}`;
  }
  return `process was aborted: ${String(signal.reason)}`;
};

const validateTimeout = (timeoutMs: number | undefined): void => {
  if (
    timeoutMs !== undefined
    && (!Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw new RangeError('timeoutMs must be a non-negative finite number');
  }
};

const sendSignal = (
  child: ChildProcess,
  signal: NodeJS.Signals,
  useProcessGroup: boolean,
): void => {
  if (child.pid === undefined) return;
  if (!useProcessGroup) {
    try {
      process.kill(child.pid, signal);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
    }
    return;
  }

  let groupError: unknown;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return;
    groupError = error;
  }

  try {
    process.kill(child.pid, signal);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
  }
  throw groupError;
};

const withSignalFailure = (
  termination: TerminationReason,
  signal: NodeJS.Signals,
  error: unknown,
): TerminationReason => ({
  code: termination.code,
  reason: `${termination.reason}; ${signal} failed: ${String(error)}`,
  cause: error,
});

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs;
  const signal = options.signal;
  validateTimeout(timeoutMs);

  const processArgs = [...args];
  const startedAt = performance.now();
  const stdout = new CappedOutput();
  const stderr = new CappedOutput();
  const createResult = (
    exitCode: number,
    exitSignal: NodeJS.Signals | null,
  ): ProcessResult => ({
    command,
    args: processArgs,
    exitCode,
    signal: exitSignal,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });

  if (signal?.aborted) {
    throw new ProcessExecutionError(
      'PROCESS_ABORTED',
      abortReason(signal),
      createResult(-1, null),
      signal.reason,
    );
  }

  const useProcessGroup = process.platform === 'darwin';
  let child: ChildProcess;
  try {
    child = spawn(command, processArgs, {
      shell: false,
      detached: useProcessGroup,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new ProcessExecutionError(
      'PROCESS_SPAWN_FAILED',
      error instanceof Error ? error.message : 'process spawn failed',
      createResult(-1, null),
      error,
    );
  }

  return await new Promise<ProcessResult>((resolve, reject) => {
    let settled = false;
    let termination: TerminationReason | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let finalSettleTimer: NodeJS.Timeout | undefined;

    const onStdout = (chunk: Buffer | string): void => stdout.append(chunk);
    const onStderr = (chunk: Buffer | string): void => stderr.append(chunk);

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      if (finalSettleTimer !== undefined) clearTimeout(finalSettleTimer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    };

    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const detachAfterFailedTermination = (): void => {
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.stdout?.once('error', NOOP);
      child.stderr?.once('error', NOOP);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.once('error', NOOP);
      child.once('exit', NOOP);
      child.unref();
    };

    const settleTerminatedWithoutClose = (): void => {
      if (settled || termination === undefined) return;
      const finalTermination = termination;
      const result = createResult(-1, null);
      detachAfterFailedTermination();
      settle(() => reject(new ProcessExecutionError(
        finalTermination.code,
        `${finalTermination.reason}; process did not close after SIGKILL`,
        result,
        finalTermination.cause,
      )));
    };

    const requestTermination = (nextTermination: TerminationReason): void => {
      if (settled || termination !== undefined) return;
      termination = nextTermination;

      try {
        sendSignal(child, 'SIGTERM', useProcessGroup);
      } catch (error) {
        termination = withSignalFailure(termination, 'SIGTERM', error);
      }

      forceKillTimer = setTimeout(() => {
        if (settled || termination === undefined) return;
        try {
          sendSignal(child, 'SIGKILL', useProcessGroup);
        } catch (error) {
          termination = withSignalFailure(termination, 'SIGKILL', error);
        }
        finalSettleTimer = setTimeout(
          settleTerminatedWithoutClose,
          PROCESS_FINAL_SETTLE_MS,
        );
      }, PROCESS_KILL_GRACE_MS);
    };

    function onAbort(): void {
      requestTermination({
        code: 'PROCESS_ABORTED',
        reason: abortReason(signal!),
      });
    }

    function onError(error: Error): void {
      settle(() => reject(new ProcessExecutionError(
        'PROCESS_SPAWN_FAILED',
        error.message,
        createResult(-1, null),
        error,
      )));
    }

    function onClose(
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void {
      const result = createResult(exitCode ?? -1, exitSignal);
      if (termination !== undefined) {
        const finalTermination = termination;
        settle(() => reject(new ProcessExecutionError(
          finalTermination.code,
          finalTermination.reason,
          result,
          finalTermination.cause,
        )));
        return;
      }

      if (exitCode !== 0 || exitSignal !== null) {
        const reason = exitSignal === null
          ? `process exited with code ${exitCode ?? -1}`
          : `process was terminated by ${exitSignal}`;
        settle(() => reject(new ProcessExecutionError(
          'PROCESS_EXIT_NONZERO',
          reason,
          result,
        )));
        return;
      }

      settle(() => resolve(result));
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);

    if (timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        requestTermination({
          code: 'PROCESS_TIMEOUT',
          reason: `process exceeded timeout of ${timeoutMs}ms`,
        });
      }, timeoutMs);
    }

    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
  });
}
