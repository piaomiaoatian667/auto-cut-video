import {spawn, type ChildProcess} from 'node:child_process';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it} from 'vitest';
import {EXIT_CODES} from '../../../src/cli/exit-codes';

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const VIDEOCTL_PATH = path.join(PROJECT_ROOT, 'src', 'cli', 'videoctl.ts');
const TSX_PATH = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
const CANONICAL_URL = 'https://www.youtube.com/watch?v=cancelled';
const INFO_DOCUMENT = {
  id: 'cancelled',
  title: 'Cancellation fixture',
  webpage_url: CANONICAL_URL,
  extractor: 'youtube',
  extractor_key: 'Youtube',
  _type: 'video',
};
const LONG_RUNNING_YT_DLP_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'for argument in "$@"; do',
  '  if [ "$argument" = "--version" ]; then',
  '    printf \'%s\\n\' \'2026.08.13-cancel-test\'',
  '    exit 0',
  '  fi',
  '  if [ "$argument" = "--dump-single-json" ]; then',
  `    printf '%s\\n' '${JSON.stringify(INFO_DOCUMENT)}'`,
  '    exit 0',
  '  fi',
  'done',
  'output=',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--output" ]; then',
  '    shift',
  '    [ "$#" -gt 0 ] || exit 64',
  '    output=$1',
  '  fi',
  '  shift',
  'done',
  '[ "$output" = "video.%(ext)s" ] || exit 65',
  'state=${FAKE_STATE_DIR:?}',
  'index=0',
  'while [ "$index" -lt 2000 ]; do',
  '  printf x > "video.$index.tmp"',
  '  index=$((index + 1))',
  'done',
  'trap \'\' TERM',
  '(',
  '  trap \'\' TERM',
  '  count=0',
  '  while :; do',
  '    count=$((count + 1))',
  '    printf \'%s\\n\' "$count" > "$state/write-count.tmp"',
  '    mv "$state/write-count.tmp" "$state/write-count"',
  '    printf x >> video.part',
  '    /bin/sleep 0.02',
  '  done',
  ') &',
  'writer=$!',
  'printf \'{"parent":%s,"child":%s}\\n\' "$$" "$writer" > "$state/pids.json"',
  'touch "$state/ready"',
  'wait "$writer"',
  '',
].join('\n');
const FAKE_FFMPEG_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'if [ "${1-}" = "-version" ]; then',
  '  printf \'%s\\n\' \'ffmpeg version cancellation-test\'',
  '  exit 0',
  'fi',
  'exit 64',
  '',
].join('\n');
const NETWORK_COMMAND = /(?:^|\n)\s*(?:curl|wget|nc|ssh)\b/mu;

interface RecordedPids {
  parent: number;
  child: number;
}

const temporaryDirectories: string[] = [];
const childProcesses: ChildProcess[] = [];
const descendantPids: number[] = [];

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(
      error instanceof Error
      && 'code' in error
      && error.code === 'ESRCH'
    );
  }
};

const readWhenReady = async (target: string): Promise<string> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(target, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${path.basename(target)}.`);
};

const waitForCleanupQuarantine = async (stagingRoot: string): Promise<string> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const cleanupEntry = (await readdir(stagingRoot)).find((entry) =>
        entry.startsWith('.cleanup-'));
      if (cleanupEntry !== undefined) return cleanupEntry;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    await delay(2);
  }
  throw new Error('Timed out waiting for staging cleanup quarantine.');
};

const waitForExit = async (
  child: ChildProcess,
): Promise<{code: number | null; signal: NodeJS.Signals | null}> => await Promise.race([
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({code, signal}));
  }),
  delay(15_000).then(() => {
    throw new Error('Timed out waiting for videoctl to exit.');
  }),
]) as {code: number | null; signal: NodeJS.Signals | null};

const writeExecutable = async (target: string, source: string): Promise<void> => {
  await writeFile(target, source, {mode: 0o700});
  await chmod(target, 0o700);
};

afterEach(async () => {
  for (const child of childProcesses.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  for (const pid of descendantPids.splice(0)) {
    if (!isProcessAlive(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
    }
  }
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'videoctl child-process cancellation',
  () => {
    it('waits for process-group termination and staging cleanup after SIGINT', async () => {
      expect(LONG_RUNNING_YT_DLP_SCRIPT).not.toMatch(NETWORK_COMMAND);
      expect(FAKE_FFMPEG_SCRIPT).not.toMatch(NETWORK_COMMAND);

      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'videoctl-cancel-test-'));
      temporaryDirectories.push(workspaceRoot);
      const toolsDirectory = path.join(workspaceRoot, 'tools');
      const stateDirectory = path.join(workspaceRoot, 'state');
      const ytDlpExecutable = path.join(toolsDirectory, 'yt-dlp');
      const ffmpegExecutable = path.join(toolsDirectory, 'ffmpeg');
      await Promise.all([mkdir(toolsDirectory), mkdir(stateDirectory)]);
      await Promise.all([
        writeExecutable(ytDlpExecutable, LONG_RUNNING_YT_DLP_SCRIPT),
        writeExecutable(ffmpegExecutable, FAKE_FFMPEG_SCRIPT),
      ]);

      let stdout = '';
      let stderr = '';
      const child = spawn(TSX_PATH, [
        VIDEOCTL_PATH,
        'download',
        CANONICAL_URL,
        '--rights-confirmed',
      ], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          YT_DLP_PATH: ytDlpExecutable,
          FFMPEG_PATH: ffmpegExecutable,
          FAKE_STATE_DIR: stateDirectory,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      childProcesses.push(child);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      const exit = waitForExit(child);

      await readWhenReady(path.join(stateDirectory, 'ready'));
      const recordedPids = JSON.parse(await readWhenReady(
        path.join(stateDirectory, 'pids.json'),
      )) as RecordedPids;
      descendantPids.push(recordedPids.parent, recordedPids.child);
      const countBeforeSignal = Number(await readWhenReady(
        path.join(stateDirectory, 'write-count'),
      ));
      expect(countBeforeSignal).toBeGreaterThan(0);
      const stagingRoot = path.join(workspaceRoot, 'downloads', '.staging');
      const stagingEntries = await readdir(stagingRoot);
      expect(stagingEntries).toHaveLength(1);
      await expect(access(path.join(
        stagingRoot,
        stagingEntries[0] ?? '',
        'video.part',
      ))).resolves.toBeUndefined();

      expect(child.kill('SIGINT')).toBe(true);
      await waitForCleanupQuarantine(stagingRoot);
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(child.kill('SIGTERM')).toBe(true);
      await expect(exit).resolves.toEqual({
        code: EXIT_CODES.operationFailed,
        signal: null,
      });

      expect(stdout).toBe('');
      expect(stderr).toBe(
        'Download failed [DOWNLOAD_PROCESS_FAILED]: '
        + 'The video could not be downloaded.\n',
      );
      expect(await readdir(stagingRoot)).toEqual([]);
      await expect(access(path.join(
        workspaceRoot,
        'downloads',
        'youtube',
        'cancelled',
      ))).rejects.toMatchObject({code: 'ENOENT'});

      const countAtExit = await readFile(
        path.join(stateDirectory, 'write-count'),
        'utf8',
      );
      await delay(250);
      expect(await readFile(
        path.join(stateDirectory, 'write-count'),
        'utf8',
      )).toBe(countAtExit);
      await expect.poll(
        () => [
          isProcessAlive(recordedPids.parent),
          isProcessAlive(recordedPids.child),
        ],
        {timeout: 3000, interval: 10},
      ).toEqual([false, false]);
    });
  },
);
