import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {
  chmod as chmodFile,
  lstat as lstatFile,
  mkdir as mkdirDirectory,
  mkdtemp as makeTemporaryDirectory,
  open as openFile,
  readFile,
  rename as renameFile,
  rm as removeFile,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {DownloaderCapabilityDependencies} from '../../../src/download/toolchain/capabilities';
import {
  installDownloaderToolchain,
  type InstallerDependencies,
} from '../../../src/download/toolchain/installer';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from '../../../src/download/toolchain/manifest';
import {DENO_EXECUTABLE_ENVIRONMENT_KEY} from '../../../src/download/toolchain/deno-wrapper';
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';
import type {DownloaderToolchainPaths} from '../../../src/download/toolchain/types';
import type {DownloadError} from '../../../src/download/errors';
import type {DownloadProcessRunner} from '../../../src/download/yt-dlp';
import type {ProcessResult} from '../../../src/process/run-process';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';
const INVALID_PROVIDER_MESSAGE =
  'The YouTube compatibility provider is unavailable.';
const currentUid = typeof process.getuid === 'function' ? process.getuid() : 501;
const denoExecutable = '/private/tools/deno';
const ffmpegExecutable = '/private/tools/ffmpeg';
const ytDlpContents = Buffer.from('managed yt-dlp fixture\n');
const pluginContents = Buffer.from('managed POT plugin fixture\n');
const versionOutput = '2026.07.04\n';
const helpOutput = [
  '--js-runtimes RUNTIME[:PATH]',
  '--remote-components COMPONENT',
].join('\n');
const denoOutput = 'deno 2.8.3\nv8 14.2\ntypescript 5.9\n';
const pluginOutput = [
  'yt_dlp_plugins/',
  'yt_dlp_plugins/extractor/',
  'yt_dlp_plugins/extractor/getpot_bgutil.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
  '',
].join('\n');
const targetsOutput = [
  '[info] Available impersonate targets',
  'Client          OS           Source',
  'Chrome-136      Macos-15     curl_cffi',
].join('\n');
const providerInstallArguments = [
  'install',
  '--allow-scripts=npm:canvas',
  '--frozen',
] as const;
const expectedDenoWrapperSource = [
  '#!/bin/sh',
  'set -eu',
  ': "${AUTO_CUT_VIDEO_DENO_EXECUTABLE:?AUTO_CUT_VIDEO_DENO_EXECUTABLE must be set}"',
  'case "$AUTO_CUT_VIDEO_DENO_EXECUTABLE" in',
  '  /*) ;;',
  '  *) exit 126 ;;',
  'esac',
  'if [ "$AUTO_CUT_VIDEO_DENO_EXECUTABLE" = "$0" ]; then',
  '  exit 126',
  'fi',
  ': "${XDG_CACHE_HOME:?XDG_CACHE_HOME must be set}"',
  'export HOME="$XDG_CACHE_HOME"',
  'export TMPDIR="$XDG_CACHE_HOME"',
  'export NPM_CONFIG_REGISTRY="https://registry.npmjs.org/"',
  'export NPM_CONFIG_USERCONFIG="/dev/null"',
  'export NPM_CONFIG_GLOBALCONFIG="/dev/null"',
  'exec "$AUTO_CUT_VIDEO_DENO_EXECUTABLE" "$@"',
  '',
].join('\n');
const denoWrapperExecutableFor = (
  paths: DownloaderToolchainPaths,
): string => path.join(paths.versionDirectory, 'bin/deno-isolated');

type MutableAsset = {url: string; bytes: number; sha256: string};

const originalYtDlpAsset = {...DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp};
const originalPluginAsset = {...DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin};
const temporaryRoots: string[] = [];

const sha256 = (contents: Buffer): string => createHash('sha256')
  .update(contents)
  .digest('hex');

const isNodeErrorWithCode = (
  error: unknown,
  code: string,
): boolean => typeof error === 'object'
  && error !== null
  && 'code' in error
  && error.code === code;

const exists = async (candidate: string): Promise<boolean> => {
  try {
    await lstatFile(candidate);
    return true;
  } catch (error) {
    if (isNodeErrorWithCode(error, 'ENOENT')) return false;
    throw error;
  }
};

const resultFor = (
  command: string,
  args: readonly string[],
  stdout = '',
): ProcessResult => ({
  command,
  args: [...args],
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  durationMs: 1,
});

const statsWithUid = (stats: Stats, uid: number): Stats => new Proxy(stats, {
  get(target, property) {
    if (property === 'uid') return uid;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

interface InstallerFixtureState {
  providerHead: string;
  providerVersionOutput: string;
  failFrozenInstall: boolean;
  replaceLockDuringGitCheck: boolean;
  foreignOwnedPath?: string;
}

interface InstallerFixture {
  homeDirectory: string;
  paths: DownloaderToolchainPaths;
  dependencies: InstallerDependencies;
  state: InstallerFixtureState;
  operations: string[];
  stagingDirectories: string[];
  fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
  runProcess: ReturnType<typeof vi.fn<DownloadProcessRunner>>;
  resolveExecutable: ReturnType<
    typeof vi.fn<DownloaderCapabilityDependencies['resolveExecutable']>
  >;
  verifyProviderIntegrity: ReturnType<
    typeof vi.fn<DownloaderCapabilityDependencies['verifyProviderIntegrity']>
  >;
  open: ReturnType<typeof vi.fn<InstallerDependencies['open']>>;
  mkdtemp: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  rm: ReturnType<typeof vi.fn>;
  randomUUID: ReturnType<typeof vi.fn<() => string>>;
}

const wrapHandle = (
  handle: FileHandle,
  candidate: string,
  operations: string[],
): FileHandle => new Proxy(handle, {
  get(target, property) {
    if (property === 'sync') {
      return async () => {
        operations.push(`sync:${candidate}`);
        await target.sync();
      };
    }
    if (property === 'close') {
      return async () => {
        operations.push(`close:${candidate}`);
        await target.close();
      };
    }
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const createInstallerFixture = async (): Promise<InstallerFixture> => {
  const homeDirectory = await makeTemporaryDirectory(
    path.join(tmpdir(), 'toolchain-installer-'),
  );
  temporaryRoots.push(homeDirectory);
  const paths = resolveDownloaderToolchainPaths(homeDirectory);
  const operations: string[] = [];
  const stagingDirectories: string[] = [];
  const state: InstallerFixtureState = {
    providerHead: DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit,
    providerVersionOutput: '1.3.1\n',
    failFrozenInstall: false,
    replaceLockDuringGitCheck: false,
  };

  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    operations.push(`fetch:${requestUrl}`);
    expect(init?.redirect).toBe('manual');
    if (requestUrl === DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.url) {
      return new Response(ytDlpContents);
    }
    if (requestUrl === DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.url) {
      return new Response(pluginContents);
    }
    throw new Error(`private unexpected fetch ${requestUrl}`);
  });

  const runProcess = vi.fn<DownloadProcessRunner>(
    async (command, args, options) => {
      operations.push(`process:${command}:${args.join(' ')}`);
      if (command === 'git' && args.length === 1 && args[0] === '--version') {
        if (state.replaceLockDuringGitCheck) {
          await removeFile(paths.setupLock);
          await writeFile(paths.setupLock, 'private replacement lock', {mode: 0o600});
        }
        return resultFor(command, args, 'git version 2.50.1\n');
      }
      if (command === denoExecutable && args.length === 1 && args[0] === '--version') {
        return resultFor(command, args, denoOutput);
      }
      if (command === 'git' && args[0] === 'init') {
        const providerDirectory = args[1];
        if (providerDirectory === undefined) {
          throw new Error('private missing provider directory');
        }
        await mkdirDirectory(
          path.join(providerDirectory, '.git'),
          {recursive: true, mode: 0o700},
        );
        await mkdirDirectory(
          path.join(providerDirectory, 'server/src'),
          {recursive: true, mode: 0o700},
        );
        await writeFile(
          path.join(providerDirectory, 'server/src/generate_once.ts'),
          'export {};\n',
          {mode: 0o600},
        );
        return resultFor(command, args);
      }
      if (command === 'git' && args[0] === '-C' && args[2] === 'checkout') {
        const providerDirectory = args[1];
        if (providerDirectory === undefined) {
          throw new Error('private missing checkout directory');
        }
        await writeFile(
          path.join(providerDirectory, '.git/HEAD'),
          `${state.providerHead}\n`,
          {mode: 0o600},
        );
        return resultFor(command, args);
      }
      if (command === 'git') return resultFor(command, args);
      if (command === denoExecutable && args[0] === 'install') {
        if (state.failFrozenInstall) {
          throw new Error(
            `private Deno stderr ${args.join(' ')} ${options?.cwd ?? ''}`,
          );
        }
        if (options?.cwd === undefined) {
          throw new Error('private missing Deno install cwd');
        }
        await mkdirDirectory(
          path.join(options.cwd, 'node_modules'),
          {recursive: true, mode: 0o700},
        );
        await mkdirDirectory(
          path.join(options.cwd, 'node_modules/.deno'),
          {recursive: true, mode: 0o700},
        );
        await writeFile(
          path.join(options.cwd, 'node_modules/.deno/.setup-cache.bin'),
          'unstable Deno setup cache',
          {mode: 0o600},
        );
        return resultFor(command, args);
      }
      if (args.length === 1 && args[0] === '--version') {
        return resultFor(command, args, versionOutput);
      }
      if (args.length === 1 && args[0] === '--help') {
        return resultFor(command, args, helpOutput);
      }
      if (command === '/usr/bin/unzip') {
        return resultFor(command, args, pluginOutput);
      }
      if (
        (command === denoExecutable || path.basename(command) === 'deno-isolated')
        && args[0] === 'run'
      ) {
        return resultFor(command, args, state.providerVersionOutput);
      }
      if (args.length === 1 && args[0] === '--list-impersonate-targets') {
        return resultFor(command, args, targetsOutput);
      }
      if (command === ffmpegExecutable && args.length === 1 && args[0] === '-version') {
        return resultFor(command, args, 'ffmpeg version 8.1.2\n');
      }
      throw new Error(`private unexpected process ${command} ${args.join(' ')}`);
    },
  );

  const open = vi.fn<InstallerDependencies['open']>(
    async (candidate, flags, mode) => {
      const candidatePath = String(candidate);
      operations.push(`open:${candidatePath}:${String(flags)}:${mode ?? ''}`);
      const handle = await openFile(candidate, flags, mode);
      return wrapHandle(handle, candidatePath, operations);
    },
  );
  const lstat = vi.fn(async (candidate: string): Promise<Stats> => {
    const stats = await lstatFile(candidate);
    return String(candidate) === state.foreignOwnedPath
      ? statsWithUid(stats, currentUid + 1)
      : stats;
  });
  const mkdtemp = vi.fn(async (prefix: string) => {
    const directory = await makeTemporaryDirectory(prefix);
    stagingDirectories.push(directory);
    operations.push(`mkdtemp:${directory}`);
    return directory;
  });
  const rename = vi.fn(async (source: string, destination: string) => {
    operations.push(`rename:${source}:${destination}`);
    await renameFile(source, destination);
  });
  const rm = vi.fn(async (
    candidate: string,
    options?: Parameters<typeof removeFile>[1],
  ) => {
    operations.push(`rm:${candidate}`);
    await removeFile(candidate, options);
  });
  const randomUUID = vi.fn(() => '00000000-0000-4000-8000-000000000001');
  const resolveExecutable = vi.fn<
    DownloaderCapabilityDependencies['resolveExecutable']
  >(async (name) => name === 'deno' ? denoExecutable : ffmpegExecutable);
  const verifyProviderIntegrity = vi.fn<
    DownloaderCapabilityDependencies['verifyProviderIntegrity']
  >(async () => {});
  const capabilityDependencies: DownloaderCapabilityDependencies = {
    runProcess,
    directoryExists: async (candidate) => {
      try {
        return (await lstat(candidate)).isDirectory();
      } catch (error) {
        if (isNodeErrorWithCode(error, 'ENOENT')) return false;
        throw error;
      }
    },
    lstat,
    readFile: async (candidate, encoding) => await readFile(candidate, encoding),
    hashFile: async (candidate) => sha256(await readFile(candidate)),
    currentUid: () => currentUid,
    resolveExecutable,
    verifyProviderIntegrity,
  };
  const dependencies: InstallerDependencies = {
    fetch,
    runProcess,
    capabilities: capabilityDependencies,
    open,
    mkdir: mkdirDirectory,
    mkdtemp: mkdtemp as unknown as InstallerDependencies['mkdtemp'],
    chmod: chmodFile,
    rename: rename as InstallerDependencies['rename'],
    lstat: lstat as unknown as InstallerDependencies['lstat'],
    readFile,
    writeFile,
    rm: rm as InstallerDependencies['rm'],
    randomUUID,
    currentUid: () => currentUid,
  };
  return {
    homeDirectory,
    paths,
    dependencies,
    state,
    operations,
    stagingDirectories,
    fetch,
    runProcess,
    resolveExecutable,
    verifyProviderIntegrity,
    open,
    mkdtemp,
    rename,
    rm,
    randomUUID,
  };
};

const seedValidPublishedToolchain = async (
  paths: DownloaderToolchainPaths,
): Promise<void> => {
  await mkdirDirectory(path.dirname(paths.ytDlpExecutable), {
    recursive: true,
    mode: 0o700,
  });
  await mkdirDirectory(paths.pluginDirectory, {recursive: true, mode: 0o700});
  await mkdirDirectory(
    path.join(paths.providerDirectory, '.git'),
    {recursive: true, mode: 0o700},
  );
  await mkdirDirectory(
    path.join(paths.providerServerDirectory, 'src'),
    {recursive: true, mode: 0o700},
  );
  await mkdirDirectory(
    path.join(paths.providerServerDirectory, 'node_modules'),
    {recursive: true, mode: 0o700},
  );
  await writeFile(paths.ytDlpExecutable, ytDlpContents, {mode: 0o700});
  await writeFile(
    denoWrapperExecutableFor(paths),
    expectedDenoWrapperSource,
    {mode: 0o700},
  );
  await writeFile(paths.pluginArchive, pluginContents, {mode: 0o600});
  await writeFile(
    paths.installedManifest,
    `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
    {mode: 0o600},
  );
  await writeFile(
    path.join(paths.providerDirectory, '.git/HEAD'),
    `${DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit}\n`,
    {mode: 0o600},
  );
  await writeFile(
    path.join(paths.providerServerDirectory, 'src/generate_once.ts'),
    'export {};\n',
    {mode: 0o600},
  );
};

const seedInvalidPublishedDirectory = async (
  paths: DownloaderToolchainPaths,
  marker = 'private previous installation',
): Promise<string> => {
  await mkdirDirectory(paths.versionDirectory, {recursive: true, mode: 0o700});
  const markerPath = path.join(paths.versionDirectory, 'previous.txt');
  await writeFile(markerPath, marker, {mode: 0o600});
  return markerPath;
};

const expectInvalidToolchain = async (
  promise: Promise<unknown>,
  privateMarkers: readonly string[] = [],
): Promise<DownloadError> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    name: 'DownloadError',
    code: 'DOWNLOAD_TOOLCHAIN_INVALID',
    message: INVALID_TOOLCHAIN_MESSAGE,
  });
  expect((caught as Error & {cause?: unknown}).cause).toBeUndefined();
  for (const marker of privateMarkers) {
    expect(String(caught)).not.toContain(marker);
  }
  return caught as DownloadError;
};

const expectProviderUnavailable = async (
  promise: Promise<unknown>,
  privateMarkers: readonly string[] = [],
): Promise<DownloadError> => {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    name: 'DownloadError',
    code: 'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
    message: INVALID_PROVIDER_MESSAGE,
  });
  expect((caught as Error & {cause?: unknown}).cause).toBeUndefined();
  for (const marker of privateMarkers) {
    expect(String(caught)).not.toContain(marker);
  }
  return caught as DownloadError;
};

beforeEach(() => {
  Object.assign(
    DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp as unknown as MutableAsset,
    {bytes: ytDlpContents.byteLength, sha256: sha256(ytDlpContents)},
  );
  Object.assign(
    DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin as unknown as MutableAsset,
    {bytes: pluginContents.byteLength, sha256: sha256(pluginContents)},
  );
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
});

afterEach(async () => {
  Object.assign(
    DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp as unknown as MutableAsset,
    originalYtDlpAsset,
  );
  Object.assign(
    DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin as unknown as MutableAsset,
    originalPluginAsset,
  );
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await removeFile(root, {recursive: true, force: true});
    }),
  );
});

describe('installDownloaderToolchain', () => {
  it('installs the pinned toolchain and publishes canonical bytes atomically', async () => {
    const fixture = await createInstallerFixture();
    const uidHomeDirectory = vi.fn(() => '/Users/unused-uid-home');
    const dependencies = {
      ...fixture.dependencies,
      uidHomeDirectory,
    };

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(uidHomeDirectory).not.toHaveBeenCalled();

    expect(await readFile(fixture.paths.installedManifest, 'utf8')).toBe(
      `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
    );
    const denoWrapperExecutable = denoWrapperExecutableFor(fixture.paths);
    expect(await readFile(denoWrapperExecutable, 'utf8')).toBe(
      expectedDenoWrapperSource,
    );
    expect((await lstatFile(fixture.paths.ytDlpExecutable)).mode & 0o777)
      .toBe(0o700);
    expect((await lstatFile(denoWrapperExecutable)).mode & 0o777).toBe(0o700);
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.runProcess.mock.calls.slice(0, 6).map(([command, args]) => [
      command,
      args,
    ])).toEqual([
      ['git', ['--version']],
      [denoExecutable, ['--version']],
      ['git', ['init', expect.stringContaining('/.install-')]],
      [
        'git',
        [
          '-C',
          expect.stringContaining('/.install-'),
          'remote',
          'add',
          'origin',
          DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.repository,
        ],
      ],
      [
        'git',
        [
          '-C',
          expect.stringContaining('/.install-'),
          'fetch',
          '--depth',
          '1',
          'origin',
          DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit,
        ],
      ],
      [
        'git',
        [
          '-C',
          expect.stringContaining('/.install-'),
          'checkout',
          '--detach',
          'FETCH_HEAD',
        ],
      ],
    ]);
    const stagingDirectory = fixture.stagingDirectories[0];
    expect(stagingDirectory).toBeDefined();
    const providerServerDirectory = path.join(
      stagingDirectory as string,
      'provider/server',
    );
    const frozenInstall = fixture.runProcess.mock.calls.find(
      ([command, args, options]) => command === denoExecutable
        && args.length === providerInstallArguments.length
        && args.every((argument, index) =>
          argument === providerInstallArguments[index]
        )
        && options?.cwd === providerServerDirectory,
    );
    expect(frozenInstall?.[1]).toEqual(providerInstallArguments);
    expect(frozenInstall?.[2]).toMatchObject({
      cwd: providerServerDirectory,
      env: expect.objectContaining({
        DENO_NO_PROMPT: '1',
        DENO_NO_UPDATE_CHECK: '1',
      }),
    });
    const publication = fixture.operations.findIndex((operation) =>
      operation.endsWith(`:${fixture.paths.versionDirectory}`)
      && operation.startsWith('rename:')
    );
    expect(publication).toBeGreaterThan(-1);
    for (const requiredPath of [
      'bin/yt-dlp',
      'bin/deno-isolated',
      'plugins/bgutil-ytdlp-pot-provider.zip',
      'manifest.json',
      'provider/.git/HEAD',
      'provider/server/src/generate_once.ts',
    ]) {
      expect(fixture.operations.findIndex((operation) =>
        operation.startsWith('sync:') && operation.includes(requiredPath)
      )).toBeLessThan(publication);
    }
    expect(fixture.operations.findIndex((operation) =>
      operation === `sync:${fixture.paths.cacheRoot}`
    )).toBeGreaterThan(publication);
    expect(await exists(fixture.paths.setupLock)).toBe(false);
    expect(await exists(path.join(
      fixture.paths.providerServerDirectory,
      'node_modules/.deno/.setup-cache.bin',
    ))).toBe(false);
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
  });

  it('snapshots a relative FFmpeg override before the first setup await', async () => {
    const fixture = await createInstallerFixture();
    const setupEntryCwd = '/private/setup-entry-cwd';
    const laterCwd = '/private/setup-later-cwd';
    const ffmpegOverride = 'relative-tools/ffmpeg';
    const expectedFfmpegOverride = path.resolve(setupEntryCwd, ffmpegOverride);
    const laterFfmpegOverride = path.resolve(laterCwd, ffmpegOverride);
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(setupEntryCwd);
    let firstLstat = true;
    const lstat = vi.fn(async (candidate: string): Promise<Stats> => {
      if (firstLstat) {
        firstLstat = false;
        await Promise.resolve();
        cwd.mockReturnValue(laterCwd);
      }
      return await fixture.dependencies.lstat(candidate);
    });
    const capabilityRunProcess = vi.fn<DownloadProcessRunner>(
      async (command, args, options) => {
        if (args.length === 1 && args[0] === '-version') {
          return resultFor(command, args, 'ffmpeg version 8.1.2\n');
        }
        return await fixture.dependencies.capabilities.runProcess(
          command,
          args,
          options,
        );
      },
    );
    const dependencies = {
      ...fixture.dependencies,
      lstat: lstat as unknown as InstallerDependencies['lstat'],
      capabilities: {
        ...fixture.dependencies.capabilities,
        runProcess: capabilityRunProcess,
      },
    };

    try {
      await expect(installDownloaderToolchain({
        homeDirectory: fixture.homeDirectory,
        ffmpegOverride,
      }, dependencies)).resolves.toEqual({
        status: 'installed',
        version: '2026.07.04',
      });

      expect(cwd).toHaveBeenCalledTimes(1);
      expect(cwd.mock.invocationCallOrder[0]).toBeLessThan(
        lstat.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      expect(capabilityRunProcess).toHaveBeenCalledWith(
        expectedFfmpegOverride,
        ['-version'],
        expect.objectContaining({env: expect.any(Object)}),
      );
      expect(capabilityRunProcess).not.toHaveBeenCalledWith(
        laterFfmpegOverride,
        ['-version'],
        expect.anything(),
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('preserves an absolute FFmpeg override without reading cwd', async () => {
    const fixture = await createInstallerFixture();
    const ffmpegOverride = '/private/overrides/linked-bin/../ffmpeg';
    const cwd = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('private cwd failure');
    });
    const capabilityRunProcess = vi.fn<DownloadProcessRunner>(
      async (command, args, options) => {
        if (command === ffmpegOverride && args[0] === '-version') {
          return resultFor(command, args, 'ffmpeg version 8.1.2\n');
        }
        return await fixture.dependencies.capabilities.runProcess(
          command,
          args,
          options,
        );
      },
    );
    const dependencies = {
      ...fixture.dependencies,
      capabilities: {
        ...fixture.dependencies.capabilities,
        runProcess: capabilityRunProcess,
      },
    };

    try {
      await expect(installDownloaderToolchain({
        homeDirectory: fixture.homeDirectory,
        ffmpegOverride,
      }, dependencies)).resolves.toEqual({
        status: 'installed',
        version: '2026.07.04',
      });

      expect(cwd).not.toHaveBeenCalled();
      expect(capabilityRunProcess).toHaveBeenCalledWith(
        ffmpegOverride,
        ['-version'],
        expect.objectContaining({env: expect.any(Object)}),
      );
    } finally {
      cwd.mockRestore();
    }
  });

  it('uses an injected UID home for the default managed install path', async () => {
    const fixture = await createInstallerFixture();
    const poisonedHome = await makeTemporaryDirectory(
      path.join(tmpdir(), 'toolchain-poisoned-home-'),
    );
    temporaryRoots.push(poisonedHome);
    vi.stubEnv('HOME', poisonedHome);
    const uidHomeDirectory = vi.fn(() => fixture.homeDirectory);
    const dependencies = {
      ...fixture.dependencies,
      uidHomeDirectory,
    };

    await expect(installDownloaderToolchain(
      {},
      dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(uidHomeDirectory).toHaveBeenCalledTimes(1);
    expect(await exists(fixture.paths.ytDlpExecutable)).toBe(true);
    expect(await exists(
      resolveDownloaderToolchainPaths(poisonedHome).versionDirectory,
    )).toBe(false);
  });

  it('isolates Deno HOME and npm config while forwarding arguments and exit code', async () => {
    const fixture = await createInstallerFixture();
    await installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    );
    const fakeBinDirectory = path.join(fixture.homeDirectory, 'fake-bin');
    const fakeDenoExecutable = path.join(fakeBinDirectory, 'deno');
    const capturePath = path.join(fixture.homeDirectory, 'fake-deno-capture.txt');
    const maliciousBinDirectory = path.join(fixture.homeDirectory, 'relative-bin');
    const maliciousCapturePath = path.join(
      fixture.homeDirectory,
      'malicious-deno-capture.txt',
    );
    const runtimeCache = path.join(fixture.homeDirectory, 'runtime-cache');
    const poisonedHome = path.join(fixture.homeDirectory, 'poisoned-home');
    await mkdirDirectory(fakeBinDirectory, {recursive: true, mode: 0o700});
    await mkdirDirectory(maliciousBinDirectory, {recursive: true, mode: 0o700});
    await mkdirDirectory(runtimeCache, {recursive: true, mode: 0o700});
    await writeFile(fakeDenoExecutable, [
      '#!/bin/sh',
      'set -eu',
      '{',
      '  printf \'HOME=%s\\n\' "$HOME"',
      '  printf \'TMPDIR=%s\\n\' "$TMPDIR"',
      '  printf \'NPM_CONFIG_REGISTRY=%s\\n\' "$NPM_CONFIG_REGISTRY"',
      '  printf \'NPM_CONFIG_USERCONFIG=%s\\n\' "$NPM_CONFIG_USERCONFIG"',
      '  printf \'NPM_CONFIG_GLOBALCONFIG=%s\\n\' "$NPM_CONFIG_GLOBALCONFIG"',
      '  printf \'ARG=%s\\n\' "$@"',
      '} > "$FAKE_DENO_CAPTURE"',
      'exit 37',
      '',
    ].join('\n'), {mode: 0o700});
    await writeFile(path.join(maliciousBinDirectory, 'deno'), [
      '#!/bin/sh',
      'set -eu',
      'printf \'malicious PATH deno executed\\n\' > "$MALICIOUS_DENO_CAPTURE"',
      'exit 91',
      '',
    ].join('\n'), {mode: 0o700});
    vi.stubEnv('HOME', poisonedHome);
    vi.stubEnv('TMPDIR', path.join(fixture.homeDirectory, 'poisoned-tmp'));
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://private-registry.example.test/');
    vi.stubEnv('NPM_CONFIG_USERCONFIG', '/private/user-npmrc');
    vi.stubEnv('NPM_CONFIG_GLOBALCONFIG', '/private/global-npmrc');
    const parentHome = process.env.HOME;

    const completion = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      const child = spawn(
        denoWrapperExecutableFor(fixture.paths),
        ['argument with spaces', '--flag=$literal'],
        {
          env: {
            ...process.env,
            PATH: ['relative-bin', '/usr/bin', '/bin'].join(path.delimiter),
            XDG_CACHE_HOME: runtimeCache,
            [DENO_EXECUTABLE_ENVIRONMENT_KEY]: fakeDenoExecutable,
            FAKE_DENO_CAPTURE: capturePath,
            MALICIOUS_DENO_CAPTURE: maliciousCapturePath,
          },
          cwd: fixture.homeDirectory,
          stdio: 'ignore',
        },
      );
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({code, signal}));
    });

    expect(completion).toEqual({code: 37, signal: null});
    expect(await readFile(capturePath, 'utf8')).toBe([
      `HOME=${runtimeCache}`,
      `TMPDIR=${runtimeCache}`,
      'NPM_CONFIG_REGISTRY=https://registry.npmjs.org/',
      'NPM_CONFIG_USERCONFIG=/dev/null',
      'NPM_CONFIG_GLOBALCONFIG=/dev/null',
      'ARG=argument with spaces',
      'ARG=--flag=$literal',
      '',
    ].join('\n'));
    expect(await exists(maliciousCapturePath)).toBe(false);
    expect(process.env.HOME).toBe(parentHome);
  });

  it('reuses the initially validated Deno throughout staging validation', async () => {
    const fixture = await createInstallerFixture();
    let denoResolutions = 0;
    fixture.resolveExecutable.mockImplementation(async (name) => {
      if (name === 'ffmpeg') return ffmpegExecutable;
      denoResolutions += 1;
      if (denoResolutions > 1) {
        throw new Error('private second Deno resolution');
      }
      return denoExecutable;
    });

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(fixture.resolveExecutable.mock.calls.filter(([name]) => name === 'deno'))
      .toEqual([['deno']]);
    expect(fixture.runProcess.mock.calls.filter(([command, args]) =>
      command === denoExecutable
      && args.length === 1
      && args[0] === '--version'
    )).toHaveLength(2);
    expect(fixture.runProcess.mock.calls).toContainEqual([
      denoExecutable,
      providerInstallArguments,
      expect.objectContaining({cwd: expect.stringContaining('/provider/server')}),
    ]);
    const providerProbe = fixture.runProcess.mock.calls.find(
      ([command, args]) => path.basename(command) === 'deno-isolated'
        && args[0] === 'run',
    );
    expect(providerProbe?.[2]?.env?.[DENO_EXECUTABLE_ENVIRONMENT_KEY])
      .toBe(denoExecutable);
  });

  it.each(['relative', 'wrapper'] as const)(
    'rejects a %s Deno runtime binding before PATH lookup',
    async (runtimeBinding) => {
      const fixture = await createInstallerFixture();
      await installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      );
      const wrapperExecutable = denoWrapperExecutableFor(fixture.paths);
      const maliciousBinDirectory = path.join(fixture.homeDirectory, 'relative-bin');
      const maliciousCapturePath = path.join(
        fixture.homeDirectory,
        `malicious-${runtimeBinding}-capture.txt`,
      );
      await mkdirDirectory(maliciousBinDirectory, {recursive: true, mode: 0o700});
      await writeFile(path.join(maliciousBinDirectory, 'deno'), [
        '#!/bin/sh',
        'set -eu',
        'printf \'malicious PATH deno executed\\n\' > "$MALICIOUS_DENO_CAPTURE"',
        'exit 0',
        '',
      ].join('\n'), {mode: 0o700});

      const completion = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve, reject) => {
        const child = spawn(wrapperExecutable, ['--version'], {
          cwd: fixture.homeDirectory,
          env: {
            PATH: ['relative-bin', '/usr/bin', '/bin'].join(path.delimiter),
            XDG_CACHE_HOME: fixture.paths.providerCacheDirectory,
            [DENO_EXECUTABLE_ENVIRONMENT_KEY]: runtimeBinding === 'relative'
              ? 'relative-deno'
              : wrapperExecutable,
            MALICIOUS_DENO_CAPTURE: maliciousCapturePath,
          },
          stdio: 'ignore',
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({code, signal}));
      });

      expect(completion.signal).toBeNull();
      expect(completion.code).not.toBe(0);
      expect(await exists(maliciousCapturePath)).toBe(false);
    },
  );

  it('uses a minimal staging-local environment for every installer subprocess', async () => {
    const sourcePath = [
      'relative-bin',
      '/usr/bin',
      './local-bin',
      '/opt/private-tools/bin',
      '',
      '/bin',
    ].join(path.delimiter);
    const poisonedEnvironment: Readonly<Record<string, string>> = {
      PATH: sourcePath,
      HOME: '/private/host-home',
      TMPDIR: '/private/host-tmp',
      OPENAI_API_KEY: 'private-openai-key',
      ANTHROPIC_API_KEY: 'private-anthropic-key',
      AWS_ACCESS_KEY_ID: 'private-aws-access-key',
      AWS_SECRET_ACCESS_KEY: 'private-aws-secret-key',
      AWS_SESSION_TOKEN: 'private-aws-session-token',
      GOOGLE_APPLICATION_CREDENTIALS: '/private/google-credentials.json',
      GOOGLE_CLOUD_PROJECT: 'private-google-project',
      SSH_AUTH_SOCK: '/private/ssh-agent.sock',
      NODE_OPTIONS: '--require=/private/host-hook.cjs',
      NODE_PATH: '/private/host-node-modules',
      NPM_CONFIG_REGISTRY: 'https://private-registry.example.test/',
      npm_config_userconfig: '/private/user-npmrc',
      NpM_CoNfIg_GlObAlCoNfIg: '/private/global-npmrc',
      NPM_TOKEN: 'private-npm-token',
      nPm_AuTh_ToKeN: 'private-npm-auth-token',
      node_auth_token: 'private-node-auth-token',
      DeNo_AuTh_ToKeNs: 'private-deno-auth-tokens',
      HTTP_PROXY: 'http://private-http-proxy.test',
      https_proxy: 'http://private-https-proxy.test',
      ALL_PROXY: 'socks5://private-all-proxy.test',
      no_proxy: 'private-no-proxy.test',
      DENO_DIR: '/private/host-deno',
      XDG_CACHE_HOME: '/private/host-cache',
      DENO_NO_PROMPT: '0',
      DENO_NO_UPDATE_CHECK: '0',
      FORCE_COLOR: 'true',
      GIT_CONFIG_NOSYSTEM: '0',
      GIT_CONFIG_GLOBAL: '/private/host-gitconfig',
      GIT_CONFIG_SYSTEM: '/private/system-gitconfig',
      GIT_TERMINAL_PROMPT: '1',
      GIT_SSH_COMMAND: '/private/host-ssh-command',
      AUTO_CUT_VIDEO_DENO_EXECUTABLE: '/private/poisoned-system-deno',
      auto_cut_video_deno_executable: 'relative-poisoned-deno',
      TOOLCHAIN_SAFE_ENV: 'private-unlisted-value',
    };
    const fixture = await createInstallerFixture();
    for (const [key, value] of Object.entries(poisonedEnvironment)) {
      vi.stubEnv(key, value);
    }
    const controller = new AbortController();

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory, signal: controller.signal},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    const stagingDirectory = fixture.stagingDirectories[0];
    expect(stagingDirectory).toBeDefined();
    const stagingRoot = stagingDirectory as string;
    const providerDirectory = path.join(stagingRoot, 'provider');
    const providerServerDirectory = path.join(providerDirectory, 'server');
    const providerModulesDirectory = path.join(
      providerServerDirectory,
      'node_modules',
    );
    const providerCacheDirectory = path.join(
      stagingRoot,
      'deno/provider-cache',
    );
    const stagingDenoWrapperExecutable = path.join(
      stagingRoot,
      'bin/deno-isolated',
    );
    const expectedPath = [
      '/usr/bin',
      '/opt/private-tools/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(path.delimiter);
    const installerEnvironment = {
      PATH: expectedPath,
      HOME: providerCacheDirectory,
      TMPDIR: providerCacheDirectory,
      DENO_DIR: path.join(stagingRoot, 'deno'),
      XDG_CACHE_HOME: providerCacheDirectory,
      DENO_NO_PROMPT: '1',
      DENO_NO_UPDATE_CHECK: '1',
      FORCE_COLOR: 'false',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_USERCONFIG: '/dev/null',
      NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    };
    const validatedInstallerEnvironment = {
      ...installerEnvironment,
      [DENO_EXECUTABLE_ENVIRONMENT_KEY]: denoExecutable,
    };
    const providerInstallCalls = fixture.runProcess.mock.calls.filter(
      ([command, args, options]) => command === denoExecutable
        && args.length === providerInstallArguments.length
        && args.every((argument, index) =>
          argument === providerInstallArguments[index]
        )
        && options?.cwd === providerServerDirectory,
    );
    expect(providerInstallCalls).toHaveLength(1);
    const providerInstall = providerInstallCalls[0];
    expect(providerInstall?.[0]).toBe(denoExecutable);
    expect(providerInstall?.[1]).toEqual(providerInstallArguments);
    expect(providerInstall?.[2]).toMatchObject({
      cwd: providerServerDirectory,
      signal: controller.signal,
      env: installerEnvironment,
    });

    const expectedGitCalls = [
      ['git', ['--version'], undefined],
      ['git', ['init', providerDirectory], undefined],
      [
        'git',
        [
          '-C',
          providerDirectory,
          'remote',
          'add',
          'origin',
          DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.repository,
        ],
        undefined,
      ],
      [
        'git',
        [
          '-C',
          providerDirectory,
          'fetch',
          '--depth',
          '1',
          'origin',
          DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit,
        ],
        undefined,
      ],
      [
        'git',
        [
          '-C',
          providerDirectory,
          'checkout',
          '--detach',
          'FETCH_HEAD',
        ],
        undefined,
      ],
    ];
    expect(fixture.runProcess.mock.calls.filter(([command]) => command === 'git')
      .map(([command, args, options]) => [command, args, options?.cwd]))
      .toEqual(expectedGitCalls);

    const providerProbeArguments = [
      'run',
      '--allow-env',
      `--allow-ffi=${providerModulesDirectory}`,
      `--allow-read=${providerServerDirectory},${providerModulesDirectory},${providerCacheDirectory}`,
      `--allow-write=${providerCacheDirectory}`,
      path.join(providerServerDirectory, 'src/generate_once.ts'),
      '--version',
    ];
    const providerProbe = fixture.runProcess.mock.calls.find(
      ([command, args, options]) => command === stagingDenoWrapperExecutable
        && args.length === providerProbeArguments.length
        && args.every((argument, index) =>
          argument === providerProbeArguments[index]
        )
        && options?.cwd === providerServerDirectory,
    );
    expect(providerProbe?.[0]).toBe(stagingDenoWrapperExecutable);
    expect(providerProbe?.[1]).toEqual(providerProbeArguments);
    expect(providerProbe?.[2]?.cwd).toBe(providerServerDirectory);
    expect(providerProbe?.[2]?.env).toEqual({
      ...validatedInstallerEnvironment,
    });

    for (const call of fixture.runProcess.mock.calls) {
      const environment = call[2]?.env;
      expect(environment).toBeDefined();
      expect(Object.isFrozen(environment)).toBe(true);
      expect(call[2]?.signal).toBe(controller.signal);
      expect(environment?.PATH).toBe(expectedPath);
      expect(environment?.PATH?.split(path.delimiter).every((entry) =>
        path.isAbsolute(entry)
      )).toBe(true);
      expect([installerEnvironment, validatedInstallerEnvironment])
        .toContainEqual(environment);
      for (const [poisonedKey, poisonedValue] of Object.entries(
        poisonedEnvironment,
      )) {
        const matchingKey = Object.keys(environment ?? {}).find((key) =>
          key.toLowerCase() === poisonedKey.toLowerCase()
        );
        if (matchingKey !== undefined) {
          expect(environment?.[matchingKey]).not.toBe(poisonedValue);
        }
      }
    }
  });

  it('reuses a valid published toolchain without fetches or runtime checks', async () => {
    const fixture = await createInstallerFixture();
    await seedValidPublishedToolchain(fixture.paths);

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'already-present', version: '2026.07.04'});

    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.runProcess).not.toHaveBeenCalled();
    expect(fixture.mkdtemp).not.toHaveBeenCalled();
    expect(fixture.rename).not.toHaveBeenCalled();
    expect(fixture.randomUUID).not.toHaveBeenCalled();
    expect(fixture.verifyProviderIntegrity).toHaveBeenCalledWith({
      providerDirectory: fixture.paths.providerDirectory,
      identity: DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.integrity,
      currentUid,
    });
    expect(await exists(fixture.paths.versionDirectory)).toBe(true);
    expect(await exists(fixture.paths.setupLock)).toBe(false);
  });

  it('quarantines and reinstalls when pinned HEAD has tampered source', async () => {
    const fixture = await createInstallerFixture();
    await seedValidPublishedToolchain(fixture.paths);
    const sourceImport = path.join(
      fixture.paths.providerServerDirectory,
      'src/generate_once.ts',
    );
    await writeFile(sourceImport, 'private tampered provider source\n');
    fixture.verifyProviderIntegrity.mockRejectedValueOnce(
      new Error('private published source root mismatch'),
    );

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(fixture.verifyProviderIntegrity).toHaveBeenCalledTimes(2);
    expect(fixture.verifyProviderIntegrity.mock.calls[0]?.[0])
      .toMatchObject({providerDirectory: fixture.paths.providerDirectory});
    expect(fixture.verifyProviderIntegrity.mock.calls[1]?.[0].providerDirectory)
      .toContain('/.install-');
    expect(await readFile(
      path.join(fixture.paths.providerDirectory, '.git/HEAD'),
      'utf8',
    )).toBe(`${DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit}\n`);
    expect(await readFile(sourceImport, 'utf8')).toBe('export {};\n');
  });

  it('normalizes the Deno setup cache before staging verification', async () => {
    const fixture = await createInstallerFixture();
    let setupCachePresentAtVerification: boolean | undefined;
    fixture.verifyProviderIntegrity.mockImplementation(async ({
      providerDirectory,
    }) => {
      if (!providerDirectory.includes('/.install-')) return;
      setupCachePresentAtVerification = await exists(path.join(
        providerDirectory,
        'server/node_modules/.deno/.setup-cache.bin',
      ));
    });

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(setupCachePresentAtVerification).toBe(false);
  });

  it.each([
    ['wrong version', '1.3.0\n', '1.3.0'],
    ['extra line', '1.3.1\nprivate extra output\n', 'private extra output'],
    ['surrounding whitespace', ' 1.3.1 \n', ' 1.3.1 '],
  ] as const)('restores and cleans up before reporting provider unavailable for %s', async (
    _caseName,
    providerVersionOutput,
    privateOutputMarker,
  ) => {
    const fixture = await createInstallerFixture();
    const markerPath = await seedInvalidPublishedDirectory(fixture.paths);
    fixture.state.providerVersionOutput = providerVersionOutput;
    const quarantineDirectory = path.join(
      fixture.paths.cacheRoot,
      '.quarantine-00000000-0000-4000-8000-000000000001',
    );

    const error = await expectProviderUnavailable(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ), [
      privateOutputMarker,
      fixture.paths.providerServerDirectory,
    ]);
    for (const stagingDirectory of fixture.stagingDirectories) {
      expect(String(error)).not.toContain(stagingDirectory);
    }

    expect(await readFile(markerPath, 'utf8')).toBe('private previous installation');
    expect(await exists(quarantineDirectory)).toBe(false);
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
    expect(await exists(fixture.paths.setupLock)).toBe(false);
    const stagingDirectory = fixture.stagingDirectories[0];
    expect(stagingDirectory).toBeDefined();
    const restoreRename = fixture.operations.indexOf(
      `rename:${quarantineDirectory}:${fixture.paths.versionDirectory}`,
    );
    const stagingRemoval = fixture.operations.indexOf(`rm:${stagingDirectory}`);
    const lockRemoval = fixture.operations.indexOf(`rm:${fixture.paths.setupLock}`);
    expect(restoreRename).toBeGreaterThan(-1);
    expect(stagingRemoval).toBeGreaterThan(restoreRename);
    expect(lockRemoval).toBeGreaterThan(stagingRemoval);
  });

  it.each([
    'missing',
    'tampered',
    'a directory',
    'foreign-owned',
  ] as const)('reinstalls when the published Deno wrapper is %s', async (state) => {
    const fixture = await createInstallerFixture();
    await seedValidPublishedToolchain(fixture.paths);
    const denoWrapperExecutable = denoWrapperExecutableFor(fixture.paths);
    if (state === 'missing') {
      await removeFile(denoWrapperExecutable);
    } else if (state === 'tampered') {
      await writeFile(denoWrapperExecutable, 'private wrapper contents\n');
    } else if (state === 'a directory') {
      await removeFile(denoWrapperExecutable);
      await mkdirDirectory(denoWrapperExecutable, {mode: 0o700});
    } else {
      fixture.state.foreignOwnedPath = denoWrapperExecutable;
    }

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect(await readFile(denoWrapperExecutable, 'utf8')).toBe(
      expectedDenoWrapperSource,
    );
  });

  it.each([
    ['0600', 0o600],
    ['0777', 0o777],
  ] as const)('reinstalls when the published Deno wrapper mode drifts to %s', async (
    _caseName,
    mode,
  ) => {
    const fixture = await createInstallerFixture();
    await seedValidPublishedToolchain(fixture.paths);
    const denoWrapperExecutable = denoWrapperExecutableFor(fixture.paths);
    await chmodFile(denoWrapperExecutable, mode);

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    expect((await lstatFile(denoWrapperExecutable)).mode & 0o777).toBe(0o700);
  });

  it('rejects a redirect to a non-allowlisted host without following it', async () => {
    const fixture = await createInstallerFixture();
    const privateRedirect = 'https://private.example.test/asset';
    fixture.fetch.mockImplementationOnce(async () => new Response(null, {
      status: 302,
      headers: {location: privateRedirect},
    }));

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      [
        privateRedirect,
        DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.url,
      ],
    );

    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(await exists(fixture.paths.versionDirectory)).toBe(false);
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
  });

  it.each([
    [
      'credentials',
      'https://private-user:private-password@release-assets.githubusercontent.com/asset',
    ],
    [
      'a non-default port',
      'https://release-assets.githubusercontent.com:444/asset',
    ],
    [
      'a fragment',
      'https://release-assets.githubusercontent.com/asset#private-fragment',
    ],
    [
      'an empty fragment',
      'https://release-assets.githubusercontent.com/asset#',
    ],
  ])('rejects an allowlisted redirect containing %s before following it', async (
    _caseName,
    privateRedirect,
  ) => {
    const fixture = await createInstallerFixture();
    fixture.fetch.mockImplementationOnce(async () => new Response('redirect', {
      status: 302,
      headers: {location: privateRedirect},
    }));

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      [privateRedirect],
    );

    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });

  it('allows a signed redirect query and cancels its body before the next hop', async () => {
    const fixture = await createInstallerFixture();
    const signedRedirect =
      'https://release-assets.githubusercontent.com/asset?signature=private-query';
    const redirectResponse = new Response('redirect body', {
      status: 302,
      headers: {location: signedRedirect},
    });
    if (redirectResponse.body === null) throw new Error('missing redirect body');
    const cancel = vi.spyOn(redirectResponse.body, 'cancel');
    fixture.fetch
      .mockImplementationOnce(async () => redirectResponse)
      .mockImplementationOnce(async (input) => {
        expect(String(input)).toBe(signedRedirect);
        expect(cancel).toHaveBeenCalledTimes(1);
        return new Response(ytDlpContents);
      });

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['oversized', Buffer.concat([ytDlpContents, Buffer.from('x')])],
    ['short', ytDlpContents.subarray(0, ytDlpContents.byteLength - 1)],
  ])('rejects a %s asset response and cleans staging', async (_caseName, body) => {
    const fixture = await createInstallerFixture();
    fixture.fetch.mockImplementationOnce(async () => new Response(body));

    await expectInvalidToolchain(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ));

    expect(await exists(fixture.paths.versionDirectory)).toBe(false);
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
  });

  it('rejects a same-length SHA mismatch', async () => {
    const fixture = await createInstallerFixture();
    const mismatched = Buffer.from(ytDlpContents);
    mismatched[0] = mismatched[0] === 0 ? 1 : 0;
    fixture.fetch.mockImplementationOnce(async () => new Response(mismatched));

    await expectInvalidToolchain(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ));

    expect(await exists(fixture.paths.versionDirectory)).toBe(false);
  });

  it('sanitizes cancellation and removes the partial staging tree', async () => {
    const fixture = await createInstallerFixture();
    const controller = new AbortController();
    fixture.fetch.mockImplementationOnce(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort(new Error('private cancellation reason'));
      throw new Error(
        `private fetch abort ${DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.url}`,
      );
    });

    let caught: unknown;
    try {
      await installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory, signal: controller.signal},
        fixture.dependencies,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'DownloadCancellationError',
      message: 'The download operation was cancelled.',
    });
    expect(`${String(caught)}${JSON.stringify(caught)}`).not.toContain(
      'private cancellation reason',
    );
    expect(String(caught)).not.toContain(
      DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.url,
    );

    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
    expect(await exists(fixture.paths.setupLock)).toBe(false);
  });

  it('rejects an existing setup lock without removing it', async () => {
    const fixture = await createInstallerFixture();
    await mkdirDirectory(fixture.paths.cacheRoot, {recursive: true, mode: 0o700});
    await writeFile(fixture.paths.setupLock, 'private active setup', {mode: 0o600});

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      [fixture.paths.setupLock, 'private active setup'],
    );

    expect(await readFile(fixture.paths.setupLock, 'utf8')).toBe(
      'private active setup',
    );
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(fixture.mkdtemp).not.toHaveBeenCalled();
  });

  it('rejects an application cache ancestor symlink without touching its target', async () => {
    const fixture = await createInstallerFixture();
    const externalDirectory = await makeTemporaryDirectory(
      path.join(tmpdir(), 'toolchain-cache-symlink-target-'),
    );
    temporaryRoots.push(externalDirectory);
    const cachesDirectory = path.join(fixture.homeDirectory, 'Library/Caches');
    const applicationCache = path.join(cachesDirectory, 'auto-cut-video');
    await mkdirDirectory(cachesDirectory, {recursive: true, mode: 0o700});
    await symlink(externalDirectory, applicationCache);

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      [applicationCache, externalDirectory],
    );

    expect(await exists(path.join(externalDirectory, 'downloader'))).toBe(false);
    expect(fixture.open).not.toHaveBeenCalledWith(
      fixture.paths.setupLock,
      'wx',
      0o600,
    );
    expect(fixture.mkdtemp).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('rejects a group/world-writable application cache before creating the setup lock', async () => {
    const fixture = await createInstallerFixture();
    const applicationCache = path.join(
      fixture.homeDirectory,
      'Library/Caches/auto-cut-video',
    );
    await mkdirDirectory(applicationCache, {recursive: true, mode: 0o700});
    await chmodFile(applicationCache, 0o777);

    await expectInvalidToolchain(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ));

    expect(await exists(fixture.paths.setupLock)).toBe(false);
    expect(fixture.open).not.toHaveBeenCalledWith(
      fixture.paths.setupLock,
      'wx',
      0o600,
    );
    expect(fixture.mkdtemp).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('rejects a symlinked published directory without moving its target', async () => {
    const fixture = await createInstallerFixture();
    const externalDirectory = await makeTemporaryDirectory(
      path.join(tmpdir(), 'toolchain-external-'),
    );
    temporaryRoots.push(externalDirectory);
    const externalMarker = path.join(externalDirectory, 'private-marker.txt');
    await writeFile(externalMarker, 'external data', {mode: 0o600});
    await mkdirDirectory(fixture.paths.cacheRoot, {recursive: true, mode: 0o700});
    await symlink(externalDirectory, fixture.paths.versionDirectory);

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      [externalDirectory, fixture.paths.versionDirectory],
    );

    expect((await lstatFile(fixture.paths.versionDirectory)).isSymbolicLink()).toBe(true);
    expect(await readFile(externalMarker, 'utf8')).toBe('external data');
    expect(fixture.rename).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('rejects a foreign-owned published directory without quarantining it', async () => {
    const fixture = await createInstallerFixture();
    await seedInvalidPublishedDirectory(fixture.paths);
    fixture.state.foreignOwnedPath = fixture.paths.versionDirectory;

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      [fixture.paths.versionDirectory],
    );

    expect(await exists(fixture.paths.versionDirectory)).toBe(true);
    expect(fixture.rename).not.toHaveBeenCalled();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it('quarantines an invalid published directory before creating staging', async () => {
    const fixture = await createInstallerFixture();
    const markerPath = await seedInvalidPublishedDirectory(fixture.paths);
    const quarantineDirectory = path.join(
      fixture.paths.cacheRoot,
      '.quarantine-00000000-0000-4000-8000-000000000001',
    );
    let namespaceSyncedBeforeStaging = false;
    fixture.mkdtemp.mockImplementationOnce(async () => {
      const quarantineRename = fixture.operations.indexOf(
        `rename:${fixture.paths.versionDirectory}:${quarantineDirectory}`,
      );
      const cacheSync = fixture.operations.findIndex((operation, index) =>
        index > quarantineRename && operation === `sync:${fixture.paths.cacheRoot}`
      );
      namespaceSyncedBeforeStaging = quarantineRename >= 0
        && cacheSync > quarantineRename
        && !await exists(fixture.paths.versionDirectory)
        && await exists(quarantineDirectory);
      throw new Error('private staging allocation failure');
    });

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      ['private staging allocation failure', quarantineDirectory],
    );

    expect(await readFile(markerPath, 'utf8')).toBe('private previous installation');
    expect(await exists(quarantineDirectory)).toBe(false);
    expect(namespaceSyncedBeforeStaging).toBe(true);
  });

  it('never removes a generated-looking staging directory outside cacheRoot', async () => {
    const fixture = await createInstallerFixture();
    const externalRoot = await makeTemporaryDirectory(
      path.join(tmpdir(), 'toolchain-external-staging-'),
    );
    temporaryRoots.push(externalRoot);
    const externalStaging = path.join(externalRoot, '.install-private');
    const externalMarker = path.join(externalStaging, 'private-marker.txt');
    await mkdirDirectory(externalStaging, {mode: 0o700});
    await writeFile(externalMarker, 'external staging data', {mode: 0o600});
    fixture.mkdtemp.mockResolvedValueOnce(externalStaging);

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      [externalStaging],
    );

    expect(await readFile(externalMarker, 'utf8')).toBe('external staging data');
    expect(fixture.rm).not.toHaveBeenCalledWith(
      externalStaging,
      expect.anything(),
    );
    expect(await exists(fixture.paths.setupLock)).toBe(false);
  });

  it('rejects a provider HEAD mismatch without exposing Git details', async () => {
    const fixture = await createInstallerFixture();
    fixture.state.providerHead = '0'.repeat(40);

    const error = await expectInvalidToolchain(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ));

    for (const marker of [
      fixture.state.providerHead,
      DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.repository,
      DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit,
      'checkout --detach FETCH_HEAD',
      ...fixture.stagingDirectories,
    ]) {
      expect(String(error)).not.toContain(marker);
    }
    expect(await exists(fixture.paths.versionDirectory)).toBe(false);
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
  });

  it('sanitizes a frozen Deno install failure and cleans staging', async () => {
    const fixture = await createInstallerFixture();
    fixture.state.failFrozenInstall = true;

    const error = await expectInvalidToolchain(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ));

    const frozenInstall = fixture.runProcess.mock.calls.find(([, args]) =>
      args[0] === 'install'
    );
    expect(frozenInstall?.[1]).toEqual([
      'install',
      '--allow-scripts=npm:canvas',
      '--frozen',
    ]);
    for (const marker of [
      'private Deno stderr',
      '--allow-scripts=npm:canvas',
      '--frozen',
      ...fixture.stagingDirectories,
    ]) {
      expect(String(error)).not.toContain(marker);
    }
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
  });

  it('cleans staging after a later asset fetch failure', async () => {
    const fixture = await createInstallerFixture();
    fixture.fetch
      .mockImplementationOnce(async () => new Response(ytDlpContents))
      .mockImplementationOnce(async () => {
        throw new Error(
          `private plugin network ${DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.url}`,
        );
      });

    const error = await expectInvalidToolchain(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ));

    expect(String(error)).not.toContain(
      DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.url,
    );
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
    expect(await exists(fixture.paths.versionDirectory)).toBe(false);
    const stagingDirectory = fixture.stagingDirectories[0];
    expect(stagingDirectory).toBeDefined();
    const stagingRemoval = fixture.operations.indexOf(`rm:${stagingDirectory}`);
    const cacheSync = fixture.operations.findIndex((operation, index) =>
      index > stagingRemoval && operation === `sync:${fixture.paths.cacheRoot}`
    );
    expect(stagingRemoval).toBeGreaterThan(-1);
    expect(cacheSync).toBeGreaterThan(stagingRemoval);
  });

  it('restores quarantine when installation fails before publication', async () => {
    const fixture = await createInstallerFixture();
    const markerPath = await seedInvalidPublishedDirectory(fixture.paths);
    fixture.state.failFrozenInstall = true;
    const quarantineDirectory = path.join(
      fixture.paths.cacheRoot,
      '.quarantine-00000000-0000-4000-8000-000000000001',
    );

    await expectInvalidToolchain(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    ));

    expect(await readFile(markerPath, 'utf8')).toBe('private previous installation');
    expect(await exists(quarantineDirectory)).toBe(false);
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
    expect(fixture.operations.filter((operation) => operation.startsWith('rename:')))
      .toEqual([
        `rename:${fixture.paths.versionDirectory}:${quarantineDirectory}`,
        `rename:${quarantineDirectory}:${fixture.paths.versionDirectory}`,
      ]);
    const quarantineRename = fixture.operations.indexOf(
      `rename:${fixture.paths.versionDirectory}:${quarantineDirectory}`,
    );
    const quarantineSync = fixture.operations.findIndex((operation, index) =>
      index > quarantineRename && operation === `sync:${fixture.paths.cacheRoot}`
    );
    const restoreRename = fixture.operations.indexOf(
      `rename:${quarantineDirectory}:${fixture.paths.versionDirectory}`,
    );
    const restoreSync = fixture.operations.findIndex((operation, index) =>
      index > restoreRename && operation === `sync:${fixture.paths.cacheRoot}`
    );
    const stagingDirectory = fixture.stagingDirectories[0];
    expect(stagingDirectory).toBeDefined();
    const stagingRemoval = fixture.operations.indexOf(`rm:${stagingDirectory}`);
    const removalSync = fixture.operations.findIndex((operation, index) =>
      index > stagingRemoval && operation === `sync:${fixture.paths.cacheRoot}`
    );
    expect(quarantineSync).toBeGreaterThan(quarantineRename);
    expect(quarantineSync).toBeLessThan(restoreRename);
    expect(restoreSync).toBeGreaterThan(restoreRename);
    expect(restoreSync).toBeLessThan(stagingRemoval);
    expect(removalSync).toBeGreaterThan(stagingRemoval);
  });

  it('atomically replaces quarantine and removes it only after cache sync', async () => {
    const fixture = await createInstallerFixture();
    await seedInvalidPublishedDirectory(fixture.paths);
    const quarantineDirectory = path.join(
      fixture.paths.cacheRoot,
      '.quarantine-00000000-0000-4000-8000-000000000001',
    );

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    const renameOperations = fixture.operations.filter((operation) =>
      operation.startsWith('rename:')
    );
    expect(renameOperations[0]).toBe(
      `rename:${fixture.paths.versionDirectory}:${quarantineDirectory}`,
    );
    expect(renameOperations[1]).toMatch(
      new RegExp(`^rename:.+\\.install-.+:${fixture.paths.versionDirectory}$`, 'u'),
    );
    const quarantineRename = fixture.operations.indexOf(renameOperations[0] ?? '');
    const quarantineSync = fixture.operations.findIndex((operation, index) =>
      index > quarantineRename && operation === `sync:${fixture.paths.cacheRoot}`
    );
    const publication = fixture.operations.indexOf(renameOperations[1] ?? '');
    const publicationSync = fixture.operations.findIndex((operation, index) =>
      index > publication && operation === `sync:${fixture.paths.cacheRoot}`
    );
    const quarantineRemoval = fixture.operations.indexOf(`rm:${quarantineDirectory}`);
    const removalSync = fixture.operations.findIndex((operation, index) =>
      index > quarantineRemoval && operation === `sync:${fixture.paths.cacheRoot}`
    );
    expect(quarantineSync).toBeGreaterThan(quarantineRename);
    expect(quarantineSync).toBeLessThan(publication);
    expect(publicationSync).toBeGreaterThan(publication);
    expect(quarantineRemoval).toBeGreaterThan(publicationSync);
    expect(removalSync).toBeGreaterThan(quarantineRemoval);
    expect(await exists(quarantineDirectory)).toBe(false);
    expect(await exists(fixture.paths.versionDirectory)).toBe(true);
  });

  it('rejects a replaced setup lock and leaves the replacement untouched', async () => {
    const fixture = await createInstallerFixture();
    fixture.state.replaceLockDuringGitCheck = true;

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory},
        fixture.dependencies,
      ),
      ['private replacement lock', fixture.paths.setupLock],
    );

    expect(await readFile(fixture.paths.setupLock, 'utf8')).toBe(
      'private replacement lock',
    );
  });
});
