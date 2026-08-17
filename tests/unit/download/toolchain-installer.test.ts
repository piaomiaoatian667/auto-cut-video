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
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';
import type {DownloaderToolchainPaths} from '../../../src/download/toolchain/types';
import type {DownloadError} from '../../../src/download/errors';
import type {DownloadProcessRunner} from '../../../src/download/yt-dlp';
import type {ProcessResult} from '../../../src/process/run-process';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';
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
      if (command === denoExecutable && args[0] === 'run') {
        return resultFor(command, args);
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
    resolveExecutable: async (name) => name === 'deno'
      ? denoExecutable
      : ffmpegExecutable,
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

    await expect(installDownloaderToolchain(
      {homeDirectory: fixture.homeDirectory},
      fixture.dependencies,
    )).resolves.toEqual({status: 'installed', version: '2026.07.04'});

    expect(await readFile(fixture.paths.installedManifest, 'utf8')).toBe(
      `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
    );
    expect((await lstatFile(fixture.paths.ytDlpExecutable)).mode & 0o777)
      .toBe(0o700);
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
    const frozenInstall = fixture.runProcess.mock.calls.find(([, args]) =>
      args[0] === 'install'
    );
    expect(frozenInstall?.[1]).toEqual([
      'install',
      '--allow-scripts=npm:canvas',
      '--frozen',
    ]);
    expect(frozenInstall?.[2]).toMatchObject({
      cwd: expect.stringContaining('/.install-'),
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
    expect(await Promise.all(fixture.stagingDirectories.map(exists)))
      .toEqual(fixture.stagingDirectories.map(() => false));
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
    expect(await exists(fixture.paths.versionDirectory)).toBe(true);
    expect(await exists(fixture.paths.setupLock)).toBe(false);
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

    await expectInvalidToolchain(
      installDownloaderToolchain(
        {homeDirectory: fixture.homeDirectory, signal: controller.signal},
        fixture.dependencies,
      ),
      ['private cancellation reason', DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.url],
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
    fixture.mkdtemp.mockImplementationOnce(async () => {
      expect(await exists(fixture.paths.versionDirectory)).toBe(false);
      expect(await exists(quarantineDirectory)).toBe(true);
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
    const cacheSync = fixture.operations.indexOf(`sync:${fixture.paths.cacheRoot}`);
    const quarantineRemoval = fixture.operations.indexOf(`rm:${quarantineDirectory}`);
    expect(cacheSync).toBeGreaterThan(
      fixture.operations.indexOf(renameOperations[1] ?? ''),
    );
    expect(quarantineRemoval).toBeGreaterThan(cacheSync);
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
