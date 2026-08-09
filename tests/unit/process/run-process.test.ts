import {access, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, onTestFinished} from 'vitest';
import {ProcessExecutionError} from '../../../src/process/process-error';
import {
  PROCESS_OUTPUT_LIMIT_BYTES,
  runProcess,
} from '../../../src/process/run-process';

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ESRCH') return false;
    throw error;
  }
};

const killIfAlive = (pid: number): void => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ESRCH') throw error;
  }
};

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
      reason: expect.any(String),
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

  it('caps output while continuing to drain both streams', async () => {
    const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-process-output-'));
    onTestFinished(() => rm(tempDirectory, {recursive: true, force: true}));
    const drainedMarker = path.join(tempDirectory, 'drained');
    const outputBytes = PROCESS_OUTPUT_LIMIT_BYTES + 4096;
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

    const result = await runProcess(
      process.execPath,
      ['-e', script, drainedMarker],
    );

    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(
      PROCESS_OUTPUT_LIMIT_BYTES,
    );
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      PROCESS_OUTPUT_LIMIT_BYTES,
    );
    await expect(readFile(drainedMarker, 'utf8')).resolves.toBe('drained');
  });

  it.skipIf(process.platform !== 'darwin')(
    'kills the entire process group with a SIGKILL fallback',
    async () => {
      const tempDirectory = await mkdtemp(path.join(tmpdir(), 'run-process-group-'));
      const pidFile = path.join(tempDirectory, 'pids.json');
      let processPids: {parent: number; child: number} | undefined;
      onTestFinished(async () => {
        if (processPids) {
          killIfAlive(processPids.child);
          killIfAlive(processPids.parent);
        }
        await rm(tempDirectory, {recursive: true, force: true});
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
      const controller = new AbortController();
      const pending = runProcess(
        process.execPath,
        ['-e', parentScript, pidFile],
        {signal: controller.signal},
      );

      await expect.poll(async () => {
        try {
          return await readFile(pidFile, 'utf8');
        } catch (error) {
          if (isNodeError(error) && error.code === 'ENOENT') return '';
          throw error;
        }
      }, {timeout: 3000, interval: 10}).not.toBe('');
      processPids = JSON.parse(await readFile(pidFile, 'utf8')) as {
        parent: number;
        child: number;
      };
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'PROCESS_ABORTED',
        result: expect.objectContaining({signal: 'SIGKILL'}),
      });

      controller.abort('stop process tree');

      await rejection;
      await expect.poll(
        () => [
          isProcessAlive(processPids!.parent),
          isProcessAlive(processPids!.child),
        ],
        {timeout: 3000, interval: 10},
      ).toEqual([false, false]);
    },
  );
});
