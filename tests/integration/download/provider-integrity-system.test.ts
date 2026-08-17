import {execFile as execFileCallback} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  rm,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {DOWNLOADER_TOOLCHAIN_MANIFEST} from '../../../src/download/toolchain/manifest';
import {
  normalizeProviderInstallation,
  verifyProviderIntegrity,
} from '../../../src/download/toolchain/provider-integrity';

const execFile = promisify(execFileCallback);
const temporaryRoots: string[] = [];
const systemIt = process.env.RUN_SYSTEM_PROVIDER_INTEGRITY_TESTS === '1'
  ? it
  : it.skip;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, {recursive: true, force: true});
  }));
});

describe('system provider integrity', () => {
  systemIt('verifies a clean pinned checkout after production normalization', async () => {
    expect(process.platform).toBe('darwin');
    expect(process.arch).toBe('arm64');
    const root = await mkdtemp(path.join(tmpdir(), 'provider-integrity-system-'));
    temporaryRoots.push(root);
    const providerDirectory = path.join(root, 'provider');
    const providerCache = path.join(root, 'provider-cache');
    const denoDirectory = path.join(root, 'deno');
    await Promise.all([
      mkdir(providerCache, {recursive: true}),
      mkdir(denoDirectory, {recursive: true}),
    ]);
    const environment = Object.freeze({
      PATH: process.env.PATH,
      HOME: providerCache,
      TMPDIR: providerCache,
      DENO_DIR: denoDirectory,
      XDG_CACHE_HOME: providerCache,
      DENO_NO_PROMPT: '1',
      DENO_NO_UPDATE_CHECK: '1',
      FORCE_COLOR: 'false',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    });
    const run = async (
      command: string,
      args: readonly string[],
      cwd?: string,
    ): Promise<void> => {
      await execFile(command, [...args], {
        env: environment,
        ...(cwd === undefined ? {} : {cwd}),
        maxBuffer: 16 * 1024 * 1024,
      });
    };

    await run('git', ['init', providerDirectory]);
    await run('git', [
      '-C',
      providerDirectory,
      'remote',
      'add',
      'origin',
      DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.repository,
    ]);
    await run('git', [
      '-C',
      providerDirectory,
      'fetch',
      '--depth',
      '1',
      'origin',
      DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit,
    ]);
    await run('git', [
      '-C',
      providerDirectory,
      'checkout',
      '--detach',
      'FETCH_HEAD',
    ]);
    await run('deno', [
      'install',
      '--allow-scripts=npm:canvas',
      '--frozen',
    ], path.join(providerDirectory, 'server'));

    const currentUid = typeof process.getuid === 'function'
      ? process.getuid()
      : -1;
    await normalizeProviderInstallation({providerDirectory, currentUid});
    await expect(verifyProviderIntegrity({
      providerDirectory,
      currentUid,
      identity: DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.integrity,
    })).resolves.toBeUndefined();
  }, 10 * 60 * 1000);
});
