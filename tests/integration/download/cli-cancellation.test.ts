import {spawn, type ChildProcess} from 'node:child_process';
import {
  access,
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  FAKE_YT_DLP_FIXTURE,
  MANAGED_FIXTURE_RUNNER,
  NETWORK_COMMAND,
  createManagedDownloadFixture,
  type ManagedDownloadFixture,
} from './managed-toolchain-fixture';

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TSX_PATH = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
const CANONICAL_URL = 'https://www.youtube.com/watch?v=cancelled';

interface RecordedPids {
  parent: number;
  child: number;
}

const fixtures: ManagedDownloadFixture[] = [];
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

const readWhenReady = async (
  target: string,
  timeoutMs = 10_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
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

afterEach(async () => {
  vi.unstubAllEnvs();
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
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.cleanup();
  }));
});

describe.skipIf(process.platform !== 'darwin' || process.arch !== 'arm64')(
  'videoctl child-process cancellation',
  () => {
    it('waits for managed process-group termination and staging cleanup after SIGINT', async () => {
      expect(await readFile(FAKE_YT_DLP_FIXTURE, 'utf8')).not.toMatch(NETWORK_COMMAND);
      vi.stubEnv('NODE_OPTIONS', '--no-warnings');
      vi.stubEnv('NODE_PATH', '/host/node-path-marker');
      vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'credential-marker');
      vi.stubEnv('HOME', '/host/home-marker');
      vi.stubEnv('PATH', '/host/path-marker');
      vi.stubEnv('HTTP_PROXY', 'http://host-proxy.invalid:8080');
      vi.stubEnv('HTTPS_PROXY', 'https://host-proxy.invalid:8443');
      vi.stubEnv('ALL_PROXY', 'socks5://host-proxy.invalid:1080');
      vi.stubEnv('NO_PROXY', 'host-private.invalid');
      vi.stubEnv('DYLD_FAKE_MARKER', 'dyld-host-marker');
      const fixture = await createManagedDownloadFixture({longRunning: true});
      fixtures.push(fixture);
      const runnerEnvironment = fixture.createSubprocessEnvironment({
        managedFixtureRoot: fixture.root,
      });
      expect(runnerEnvironment).toEqual({
        HOME: fixture.homeDirectory,
        PATH: [
          path.dirname(process.execPath),
          fixture.toolsDirectory,
          '/usr/bin',
          '/bin',
        ].join(path.delimiter),
        TMPDIR: fixture.temporaryDirectory,
        DENO_DIR: fixture.paths.denoDirectory,
        XDG_CACHE_HOME: fixture.paths.providerCacheDirectory,
        DENO_NO_PROMPT: '1',
        DENO_NO_UPDATE_CHECK: '1',
        FORCE_COLOR: 'false',
        FAKE_YT_DLP_RECORD_DIRECTORY: fixture.recordDirectory,
        FAKE_YT_DLP_STATE_DIRECTORY: fixture.stateDirectory,
        FAKE_YT_DLP_LONG_RUNNING: '1',
        MANAGED_DOWNLOAD_FIXTURE_ROOT: fixture.root,
      });

      let stdout = '';
      let stderr = '';
      const child = spawn(TSX_PATH, [
        MANAGED_FIXTURE_RUNNER,
        'download',
        CANONICAL_URL,
        '--rights-confirmed',
      ], {
        cwd: fixture.workspaceRoot,
        env: runnerEnvironment,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      childProcesses.push(child);
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
      child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
      const exit = waitForExit(child);

      await readWhenReady(path.join(fixture.stateDirectory, 'ready'));
      const recordedPids = JSON.parse(await readWhenReady(
        path.join(fixture.stateDirectory, 'pids.json'),
      )) as RecordedPids;
      const childEnvironment = JSON.parse(await readWhenReady(
        path.join(fixture.stateDirectory, 'child-environment.json'),
        1500,
      )) as NodeJS.ProcessEnv;
      expect(childEnvironment).toEqual({
        HOME: fixture.homeDirectory,
        PATH: [
          path.dirname(process.execPath),
          fixture.toolsDirectory,
          '/usr/bin',
          '/bin',
        ].join(path.delimiter),
        TMPDIR: fixture.temporaryDirectory,
        DENO_DIR: fixture.paths.denoDirectory,
        XDG_CACHE_HOME: fixture.paths.providerCacheDirectory,
        DENO_NO_PROMPT: '1',
        DENO_NO_UPDATE_CHECK: '1',
        FORCE_COLOR: 'false',
        FAKE_YT_DLP_RECORD_DIRECTORY: fixture.recordDirectory,
        FAKE_YT_DLP_STATE_DIRECTORY: fixture.stateDirectory,
        FAKE_YT_DLP_LONG_RUNNING: '1',
      });
      descendantPids.push(recordedPids.parent, recordedPids.child);
      const countBeforeSignal = Number(await readWhenReady(
        path.join(fixture.stateDirectory, 'write-count'),
      ));
      expect(countBeforeSignal).toBeGreaterThan(0);
      const stagingRoot = path.join(fixture.workspaceRoot, 'downloads', '.staging');
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
        code: EXIT_CODES.cancelled,
        signal: null,
      });

      expect(stdout).toBe('');
      expect(stderr).toBe(
        'Download failed [DOWNLOAD_PROCESS_FAILED]: '
        + 'The download operation was cancelled.\n',
      );
      expect(await readdir(stagingRoot)).toEqual([]);
      await expect(access(path.join(
        fixture.workspaceRoot,
        'downloads',
        'youtube',
        'cancelled',
      ))).rejects.toMatchObject({code: 'ENOENT'});

      const countAtExit = await readFile(
        path.join(fixture.stateDirectory, 'write-count'),
        'utf8',
      );
      await delay(250);
      expect(await readFile(
        path.join(fixture.stateDirectory, 'write-count'),
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
