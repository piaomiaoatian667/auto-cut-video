import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {describe, expect, it, onTestFinished, vi} from 'vitest';
import {ProcessExecutionError} from '../../../src/process/process-error';
import {
  PROCESS_OUTPUT_LIMIT_BYTES,
  runProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../../../src/process/run-process';

type IsEqual<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2)
    ? true
    : false;
type Assert<Condition extends true> = Condition;
type _TimeoutOptionIsReadonly = Assert<IsEqual<
  Pick<RunProcessOptions, 'timeoutMs'>,
  Readonly<Pick<RunProcessOptions, 'timeoutMs'>>
>>;
type _SignalOptionIsReadonly = Assert<IsEqual<
  Pick<RunProcessOptions, 'signal'>,
  Readonly<Pick<RunProcessOptions, 'signal'>>
>>;
type Mutable<T> = {-readonly [Key in keyof T]: T[Key]};

interface TrackedPids {
  parent: number;
  child?: number;
}

type ProcessOutcome =
  | {status: 'resolved'; result: ProcessResult}
  | {status: 'rejected'; error: unknown};

const OUTCOME_TIMEOUT = Symbol('outcome-timeout');
const nativeProcessKill = process.kill.bind(process) as typeof process.kill;

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const observeProcess = (pending: Promise<ProcessResult>): Promise<ProcessOutcome> =>
  pending.then(
    (result) => ({status: 'resolved', result}),
    (error: unknown) => ({status: 'rejected', error}),
  );

const waitForOutcome = async (
  outcome: Promise<ProcessOutcome>,
  timeoutMs: number,
): Promise<ProcessOutcome | typeof OUTCOME_TIMEOUT> =>
  await Promise.race([
    outcome,
    delay(timeoutMs, OUTCOME_TIMEOUT),
  ]);

const readWhenReady = async (filePath: string): Promise<string> => {
  await expect.poll(async () => {
    try {
      return await readFile(filePath, 'utf8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return '';
      throw error;
    }
  }, {timeout: 3000, interval: 10}).not.toBe('');
  return await readFile(filePath, 'utf8');
};

const isProcessAlive = (pid: number): boolean => {
  try {
    nativeProcessKill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return false;
    throw error;
  }
};

const killTargetIfAlive = (target: number): void => {
  try {
    nativeProcessKill(target, 'SIGKILL');
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
  }
};

const killTrackedProcesses = (pids: TrackedPids | undefined): void => {
  if (!pids) return;
  if (process.platform === 'darwin') killTargetIfAlive(-pids.parent);
  if (pids.child !== undefined) killTargetIfAlive(pids.child);
  killTargetIfAlive(pids.parent);
};

const cleanupTrackedProcess = async ({
  controller,
  outcome,
  pids,
  tempDirectory,
}: {
  controller: AbortController;
  outcome: Promise<ProcessOutcome> | undefined;
  pids: TrackedPids | undefined;
  tempDirectory: string;
}): Promise<void> => {
  controller.abort('test cleanup');
  if (outcome) await waitForOutcome(outcome, 750);
  killTrackedProcesses(pids);
  if (outcome) await waitForOutcome(outcome, 750);
  await rm(tempDirectory, {recursive: true, force: true});
};

const createPidScript = (ignoreSigterm: boolean): string => [
  'const {writeFileSync} = require("node:fs")',
  ignoreSigterm ? 'process.on("SIGTERM", () => {})' : '',
  'writeFileSync(process.argv[1], String(process.pid))',
  'setInterval(() => {}, 1000)',
].filter(Boolean).join(';');

describe('runProcess', () => {
  it('passes arguments without shell interpolation', async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-process-shell-'));
    onTestFinished(() => rm(tempDirectory, {recursive: true, force: true}));
    const markerPath = path.join(tempDirectory, 'should-not-exist');
    const literalArgument = `$(touch ${markerPath})`;
    const args = [
      '-e',
      'console.log(process.argv[1])',
      literalArgument,
    ];

    const result = await runProcess(process.execPath, args);

    expect(result).toMatchObject({
      command: process.execPath,
      args,
      exitCode: 0,
      signal: null,
      stdout: `${literalArgument}\n`,
      stderr: '',
      durationMs: expect.any(Number),
    });
    await expect(access(markerPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('snapshots arguments before the caller can mutate them', async () => {
    const args = ['-e', 'console.log(process.argv[1])', 'original'];

    const pending = runProcess(process.execPath, args);
    args[2] = 'mutated';

    await expect(pending).resolves.toMatchObject({
      args: ['-e', 'console.log(process.argv[1])', 'original'],
      stdout: 'original\n',
    });
  });

  it('snapshots options and cleans up the original AbortSignal listener', async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-process-options-'));
    const pidFile = path.join(tempDirectory, 'pid');
    const controller = new AbortController();
    const replacementController = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const options: RunProcessOptions = {
      signal: controller.signal,
      timeoutMs: 5000,
    };
    const mutableOptions = options as Mutable<RunProcessOptions>;
    let outcome: Promise<ProcessOutcome> | undefined;
    let pids: TrackedPids | undefined;
    onTestFinished(async () => {
      removeListener.mockRestore();
      replacementController.abort('test cleanup');
      await cleanupTrackedProcess({
        controller,
        outcome,
        pids,
        tempDirectory,
      });
    });

    outcome = observeProcess(runProcess(
      process.execPath,
      ['-e', createPidScript(false), pidFile],
      options,
    ));
    pids = {parent: Number(await readWhenReady(pidFile))};
    mutableOptions.signal = replacementController.signal;
    mutableOptions.timeoutMs = 0;

    controller.abort('original cancellation');

    const result = await waitForOutcome(outcome, 1500);
    expect(result).not.toBe(OUTCOME_TIMEOUT);
    expect(result).toMatchObject({
      status: 'rejected',
      error: {
        code: 'PROCESS_ABORTED',
        reason: expect.stringContaining('original cancellation'),
      },
    });
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects non-zero exits with the captured result', async () => {
    const args = [
      '-e',
      "console.log('before failure'); console.error('diagnostic'); process.exit(7)",
    ];

    const pending = runProcess(process.execPath, args);

    await expect(pending).rejects.toMatchObject({
      name: 'ProcessExecutionError',
      code: 'PROCESS_EXIT_NONZERO',
      reason: expect.any(String),
      result: {
        command: process.execPath,
        args,
        exitCode: 7,
        signal: null,
        stdout: 'before failure\n',
        stderr: 'diagnostic\n',
        durationMs: expect.any(Number),
      },
    });
    await expect(pending).rejects.toBeInstanceOf(ProcessExecutionError);
  });

  it('reports signal exits as non-zero process failures', async () => {
    await expect(runProcess(
      process.execPath,
      ['-e', 'process.kill(process.pid, "SIGTERM")'],
    )).rejects.toMatchObject({
      code: 'PROCESS_EXIT_NONZERO',
      result: expect.objectContaining({
        exitCode: -1,
        signal: 'SIGTERM',
      }),
    });
  });

  it('reports spawn errors without waiting for a close event', async () => {
    const command = path.join(
      tmpdir(),
      `missing-process-${process.pid}-${Date.now()}`,
    );

    await expect(runProcess(command, ['literal argument'])).rejects.toMatchObject({
      name: 'ProcessExecutionError',
      code: 'PROCESS_SPAWN_FAILED',
      reason: expect.any(String),
      result: {
        command,
        args: ['literal argument'],
        exitCode: -1,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: expect.any(Number),
      },
      cause: expect.objectContaining({code: 'ENOENT'}),
    });
  });

  it('rejects a pre-aborted signal without starting the command', async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-process-aborted-'));
    onTestFinished(() => rm(tempDirectory, {recursive: true, force: true}));
    const markerPath = path.join(tempDirectory, 'started');
    const controller = new AbortController();
    controller.abort('cancelled before spawn');

    await expect(runProcess(
      process.execPath,
      ['-e', 'require("node:fs").writeFileSync(process.argv[1], "started")', markerPath],
      {signal: controller.signal},
    )).rejects.toMatchObject({
      code: 'PROCESS_ABORTED',
      reason: expect.stringContaining('cancelled before spawn'),
      result: expect.objectContaining({
        command: process.execPath,
        exitCode: -1,
      }),
    });
    await expect(access(markerPath)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('times out and reports the structured reason', async () => {
    await expect(runProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {timeoutMs: 30},
    )).rejects.toMatchObject({
      code: 'PROCESS_TIMEOUT',
      reason: expect.any(String),
      result: expect.objectContaining({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        durationMs: expect.any(Number),
      }),
    });
  });

  it('keeps abort as the first terminal reason when timeout is also ready', async () => {
    const controller = new AbortController();
    const pending = runProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {signal: controller.signal, timeoutMs: 0},
    );

    controller.abort('abort won');

    await expect(pending).rejects.toMatchObject({
      code: 'PROCESS_ABORTED',
      reason: expect.stringContaining('abort won'),
    });
  });

  it('keeps timeout as the first terminal reason when abort fires during kill', async () => {
    const controller = new AbortController();
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 'SIGTERM') controller.abort('late abort');
      return nativeProcessKill(pid, signal);
    });

    try {
      await expect(runProcess(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {signal: controller.signal, timeoutMs: 0},
      )).rejects.toMatchObject({code: 'PROCESS_TIMEOUT'});
    } finally {
      killSpy.mockRestore();
      controller.abort('test cleanup');
    }
  });

  it('honors AbortSignal', async () => {
    const controller = new AbortController();
    const pending = runProcess(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {signal: controller.signal},
    );
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'PROCESS_ABORTED',
      reason: expect.any(String),
    });

    controller.abort('test cancellation');

    await rejection;
  });

  it.each([
    {trigger: 'abort', expectedCode: 'PROCESS_ABORTED'},
    {trigger: 'timeout', expectedCode: 'PROCESS_TIMEOUT'},
  ] as const)(
    'settles after bounded kill failure for $trigger',
    async ({trigger, expectedCode}) => {
      const tempDirectory = await mkdtemp(path.join(tmpdir(), `run-process-${trigger}-eperm-`));
      const pidFile = path.join(tempDirectory, 'pid');
      const controller = new AbortController();
      let outcome: Promise<ProcessOutcome> | undefined;
      let pids: TrackedPids | undefined;
      const killFailure = Object.assign(new Error('operation not permitted'), {
        code: 'EPERM',
      });
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 'SIGTERM' || signal === 'SIGKILL') throw killFailure;
        return nativeProcessKill(pid, signal);
      });
      onTestFinished(async () => {
        killSpy.mockRestore();
        await cleanupTrackedProcess({
          controller,
          outcome,
          pids,
          tempDirectory,
        });
      });

      outcome = observeProcess(runProcess(
        process.execPath,
        ['-e', createPidScript(true), pidFile],
        {
          signal: controller.signal,
          ...(trigger === 'timeout' ? {timeoutMs: 500} : {}),
        },
      ));
      pids = {parent: Number(await readWhenReady(pidFile))};
      if (trigger === 'abort') controller.abort('bounded abort');

      const result = await waitForOutcome(outcome, 1500);

      expect(result).not.toBe(OUTCOME_TIMEOUT);
      expect(result).toMatchObject({
        status: 'rejected',
        error: {
          code: expectedCode,
          reason: expect.stringContaining('SIGKILL failed'),
          cause: expect.objectContaining({code: 'EPERM'}),
        },
      });
      expect(killSpy.mock.calls).toEqual(expect.arrayContaining([
        [-pids.parent, 'SIGTERM'],
        [pids.parent, 'SIGTERM'],
        [-pids.parent, 'SIGKILL'],
        [pids.parent, 'SIGKILL'],
      ]));
      expect(isProcessAlive(pids.parent)).toBe(true);
    },
  );

  it('caps output at an exact UTF-8 boundary without full-size concatenation', async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-process-output-'));
    onTestFinished(() => rm(tempDirectory, {recursive: true, force: true}));
    const drainedMarker = path.join(tempDirectory, 'drained');
    const outputBytes = PROCESS_OUTPUT_LIMIT_BYTES + 4096;
    const truncationMarker = '\n[output truncated]\n';
    const script = [
      'const fs = require("node:fs")',
      'let remaining = 2',
      'const drained = () => {',
      '  remaining -= 1',
      '  if (remaining === 0) fs.writeFileSync(process.argv[1], "drained")',
      '}',
      `process.stdout.write('€'.repeat(Math.ceil(${outputBytes} / 3)), drained)`,
      `process.stderr.write('e'.repeat(${outputBytes}), drained)`,
    ].join(';');
    const concatSpy = vi.spyOn(Buffer, 'concat');
    let result: ProcessResult;
    let usedFullSizeConcat = false;

    try {
      result = await runProcess(
        process.execPath,
        ['-e', script, drainedMarker],
      );
      usedFullSizeConcat = concatSpy.mock.calls.some(([, totalLength]) => (
        totalLength === PROCESS_OUTPUT_LIMIT_BYTES
      ));
    } finally {
      concatSpy.mockRestore();
    }

    const expectedCharacters = Math.floor(
      (PROCESS_OUTPUT_LIMIT_BYTES - Buffer.byteLength(truncationMarker)) / 3,
    );
    expect(result.stdout).toBe(`${'€'.repeat(expectedCharacters)}${truncationMarker}`);
    expect(result.stdout).not.toContain('\uFFFD');
    expect(result.stderr.endsWith(truncationMarker)).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      PROCESS_OUTPUT_LIMIT_BYTES,
    );
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      PROCESS_OUTPUT_LIMIT_BYTES,
    );
    expect(usedFullSizeConcat).toBe(false);
    await expect(readFile(drainedMarker, 'utf8')).resolves.toBe('drained');
  });

  it('keeps invalid UTF-8 replacement output within the byte cap', async () => {
    const truncationMarker = '\n[output truncated]\n';

    const result = await runProcess(
      process.execPath,
      [
        '-e',
        `process.stdout.write(Buffer.alloc(${PROCESS_OUTPUT_LIMIT_BYTES + 1}, 0x80))`,
      ],
    );

    expect(result.stdout.endsWith(truncationMarker)).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      PROCESS_OUTPUT_LIMIT_BYTES,
    );
  });

  it.skipIf(process.platform !== 'darwin')(
    'kills the entire process group with a SIGKILL fallback',
    async () => {
      const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-process-group-'));
      const pidFile = path.join(tempDirectory, 'pids.json');
      const controller = new AbortController();
      let outcome: Promise<ProcessOutcome> | undefined;
      let processPids: TrackedPids | undefined;
      onTestFinished(async () => {
        await cleanupTrackedProcess({
          controller,
          outcome,
          pids: processPids,
          tempDirectory,
        });
      });
      const childScript = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)';
      const parentScript = [
        'const {spawn} = require("node:child_process")',
        'const {writeFileSync} = require("node:fs")',
        'process.on("SIGTERM", () => {})',
        `const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {stdio: 'ignore'})`,
        'writeFileSync(process.argv[1], JSON.stringify({parent: process.pid, child: child.pid}))',
        'setInterval(() => {}, 1000)',
      ].join(';');
      outcome = observeProcess(runProcess(
        process.execPath,
        ['-e', parentScript, pidFile],
        {signal: controller.signal},
      ));

      processPids = JSON.parse(await readWhenReady(pidFile)) as TrackedPids;
      controller.abort('stop process tree');

      const result = await waitForOutcome(outcome, 1500);
      expect(result).toMatchObject({
        status: 'rejected',
        error: {
          code: 'PROCESS_ABORTED',
          result: expect.objectContaining({signal: 'SIGKILL'}),
        },
      });
      await expect.poll(
        () => [
          isProcessAlive(processPids!.parent),
          isProcessAlive(processPids!.child!),
        ],
        {timeout: 3000, interval: 10},
      ).toEqual([false, false]);
    },
  );
});
