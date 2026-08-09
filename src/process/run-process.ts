import {spawn, type ChildProcess} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {
  ProcessExecutionError,
  type ProcessErrorCode,
} from './process-error';

export const PROCESS_OUTPUT_LIMIT_BYTES = 1024 * 1024;

const PROCESS_KILL_GRACE_MS = 100;
const OUTPUT_TRUNCATED_MARKER = Buffer.from('\n[output truncated]\n');

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (Buffer.byteLength(value) <= maximumBytes) return value;

  const characters: string[] = [];
  let capturedBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (capturedBytes + characterBytes > maximumBytes) break;
    characters.push(character);
    capturedBytes += characterBytes;
  }
  return characters.join('');
};

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
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface TerminationReason {
  code: Extract<ProcessErrorCode, 'PROCESS_TIMEOUT' | 'PROCESS_ABORTED'>;
  reason: string;
}

class CappedOutput {
  private readonly chunks: Buffer[] = [];
  private capturedBytes = 0;
  private truncated = false;

  append(chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remainingBytes = PROCESS_OUTPUT_LIMIT_BYTES - this.capturedBytes;
    if (remainingBytes <= 0) {
      this.truncated = true;
      return;
    }

    if (buffer.byteLength <= remainingBytes) {
      this.chunks.push(Buffer.from(buffer));
      this.capturedBytes += buffer.byteLength;
      return;
    }

    this.chunks.push(Buffer.from(buffer.subarray(0, remainingBytes)));
    this.capturedBytes += remainingBytes;
    this.truncated = true;
  }

  toString(): string {
    const captured = Buffer.concat(this.chunks, this.capturedBytes);
    const decoded = captured.toString('utf8');
    if (
      !this.truncated
      && Buffer.byteLength(decoded) <= PROCESS_OUTPUT_LIMIT_BYTES
    ) {
      return decoded;
    }

    const contentBytes = Math.max(
      0,
      PROCESS_OUTPUT_LIMIT_BYTES - OUTPUT_TRUNCATED_MARKER.byteLength,
    );
    return `${truncateUtf8(decoded, contentBytes)}`
      + OUTPUT_TRUNCATED_MARKER.toString('utf8');
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

const validateOptions = ({timeoutMs}: RunProcessOptions): void => {
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

  try {
    process.kill(useProcessGroup ? -child.pid : child.pid, signal);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return;
    if (!useProcessGroup) throw error;

    try {
      process.kill(child.pid, signal);
    } catch (fallbackError) {
      if (!isNodeError(fallbackError) || fallbackError.code !== 'ESRCH') {
        throw fallbackError;
      }
    }
  }
};

export async function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<ProcessResult> {
  validateOptions(options);
  const processArgs = [...args];
  const startedAt = performance.now();
  const stdout = new CappedOutput();
  const stderr = new CappedOutput();
  const createResult = (
    exitCode: number,
    signal: NodeJS.Signals | null,
  ): ProcessResult => ({
    command,
    args: processArgs,
    exitCode,
    signal,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  });

  if (options.signal?.aborted) {
    throw new ProcessExecutionError(
      'PROCESS_ABORTED',
      abortReason(options.signal),
      createResult(-1, null),
      options.signal.reason,
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

    const onStdout = (chunk: Buffer | string): void => stdout.append(chunk);
    const onStderr = (chunk: Buffer | string): void => stderr.append(chunk);

    const cleanup = (): void => {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('error', onError);
      child.removeListener('close', onClose);
    };

    const settle = (
      callback: () => void,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    const requestTermination = (nextTermination: TerminationReason): void => {
      if (settled || termination !== undefined) return;
      termination = nextTermination;

      try {
        sendSignal(child, 'SIGTERM', useProcessGroup);
      } catch (error) {
        termination = {
          ...nextTermination,
          reason: `${nextTermination.reason}; SIGTERM failed: ${String(error)}`,
        };
      }

      forceKillTimer = setTimeout(() => {
        if (settled) return;
        try {
          sendSignal(child, 'SIGKILL', useProcessGroup);
        } catch (error) {
          termination = {
            ...nextTermination,
            reason: `${nextTermination.reason}; SIGKILL failed: ${String(error)}`,
          };
        }
      }, PROCESS_KILL_GRACE_MS);
    };

    function onAbort(): void {
      requestTermination({
        code: 'PROCESS_ABORTED',
        reason: abortReason(options.signal!),
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
      signal: NodeJS.Signals | null,
    ): void {
      const result = createResult(exitCode ?? -1, signal);
      if (termination !== undefined) {
        settle(() => reject(new ProcessExecutionError(
          termination!.code,
          termination!.reason,
          result,
        )));
        return;
      }

      if (exitCode !== 0 || signal !== null) {
        const reason = signal === null
          ? `process exited with code ${exitCode ?? -1}`
          : `process was terminated by ${signal}`;
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

    if (options.timeoutMs !== undefined) {
      timeoutTimer = setTimeout(() => {
        requestTermination({
          code: 'PROCESS_TIMEOUT',
          reason: `process exceeded timeout of ${options.timeoutMs}ms`,
        });
      }, options.timeoutMs);
    }

    options.signal?.addEventListener('abort', onAbort, {once: true});
    if (options.signal?.aborted) onAbort();
  });
}
