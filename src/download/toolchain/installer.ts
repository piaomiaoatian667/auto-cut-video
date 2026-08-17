import {
  createHash,
  randomUUID as createRandomUUID,
} from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {runProcess as runSystemProcess, type RunProcessOptions} from '../../process/run-process';
import {DownloadError} from '../errors';
import type {DownloadProcessRunner} from '../yt-dlp';
import {
  defaultDownloaderCapabilityDependencies,
  validateDownloaderCapabilities,
  type DownloaderCapabilityDependencies,
} from './capabilities';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from './manifest';
import {
  DENO_EXECUTABLE_ENVIRONMENT_KEY,
  DENO_WRAPPER_FILENAME,
  DENO_WRAPPER_SOURCE,
} from './deno-wrapper';
import {resolveDownloaderToolchainPaths} from './paths';
import type {
  DownloaderToolchainPaths,
  SetupDownloaderResult,
} from './types';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';
const ALLOWED_REDIRECT_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const INSTALL_DIRECTORY_PREFIX = '.install-';
const QUARANTINE_DIRECTORY_PREFIX = '.quarantine-';
const INSTALLER_PATH_FALLBACK = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(path.delimiter);
const CACHE_PATH_COMPONENTS = [
  'Library',
  'Caches',
  'auto-cut-video',
  'downloader',
] as const;

const invalidToolchain = (): DownloadError => new DownloadError(
  'DOWNLOAD_TOOLCHAIN_INVALID',
  INVALID_TOOLCHAIN_MESSAGE,
);

export interface InstallerDependencies {
  fetch: typeof globalThis.fetch;
  runProcess: DownloadProcessRunner;
  capabilities: DownloaderCapabilityDependencies;
  open: typeof import('node:fs/promises').open;
  mkdir: typeof import('node:fs/promises').mkdir;
  mkdtemp: typeof import('node:fs/promises').mkdtemp;
  chmod: typeof import('node:fs/promises').chmod;
  rename: typeof import('node:fs/promises').rename;
  lstat: typeof import('node:fs/promises').lstat;
  readFile: typeof import('node:fs/promises').readFile;
  writeFile: typeof import('node:fs/promises').writeFile;
  rm: typeof import('node:fs/promises').rm;
  randomUUID(): string;
  currentUid(): number;
}

export interface InstallDownloaderToolchainOptions {
  homeDirectory?: string;
  ffmpegOverride?: string;
  signal?: AbortSignal;
}

const defaultInstallerDependencies: InstallerDependencies = {
  fetch: globalThis.fetch,
  runProcess: runSystemProcess,
  capabilities: defaultDownloaderCapabilityDependencies,
  open,
  mkdir,
  mkdtemp,
  chmod,
  rename,
  lstat,
  readFile,
  writeFile,
  rm,
  randomUUID: createRandomUUID,
  currentUid: () =>
    typeof process.getuid === 'function' ? process.getuid() : -1,
};

const processOptionsFor = (
  signal: AbortSignal | undefined,
  environment: Readonly<NodeJS.ProcessEnv>,
): RunProcessOptions => ({
  env: environment,
  ...(signal === undefined ? {} : {signal}),
});

const buildInstallerChildEnvironment = (
  paths: DownloaderToolchainPaths,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<NodeJS.ProcessEnv> => {
  const absolutePathEntries = (source.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
  return Object.freeze({
    PATH: absolutePathEntries.length === 0
      ? INSTALLER_PATH_FALLBACK
      : absolutePathEntries.join(path.delimiter),
    HOME: paths.providerCacheDirectory,
    TMPDIR: paths.providerCacheDirectory,
    DENO_DIR: paths.denoDirectory,
    XDG_CACHE_HOME: paths.providerCacheDirectory,
    DENO_NO_PROMPT: '1',
    DENO_NO_UPDATE_CHECK: '1',
    FORCE_COLOR: 'false',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
  });
};

const nodeErrorCode = (error: unknown): unknown => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
    ? error.code
    : undefined
);

const isMissingPathError = (error: unknown): boolean =>
  nodeErrorCode(error) === 'ENOENT';

const isAllowedAssetUrl = (candidate: URL): boolean =>
  candidate.protocol === 'https:'
  && ALLOWED_REDIRECT_HOSTS.has(candidate.hostname)
  && candidate.username.length === 0
  && candidate.password.length === 0
  && candidate.port.length === 0
  && !candidate.href.includes('#');

const isOwnedDirectory = (
  stats: Awaited<ReturnType<InstallerDependencies['lstat']>>,
  uid: number,
): boolean => !stats.isSymbolicLink()
  && stats.isDirectory()
  && stats.uid === uid;

const isOwnedRegularFile = (
  stats: Awaited<ReturnType<InstallerDependencies['lstat']>>,
  uid: number,
): boolean => !stats.isSymbolicLink()
  && stats.isFile()
  && stats.uid === uid;

const requireOwnedDirectory = async (
  candidate: string,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const stats = await dependencies.lstat(candidate);
  if (!isOwnedDirectory(stats, dependencies.currentUid())) {
    throw invalidToolchain();
  }
};

const requireGeneratedPath = (
  candidate: string,
  expectedParent: string,
  expectedPrefix?: typeof INSTALL_DIRECTORY_PREFIX
    | typeof QUARANTINE_DIRECTORY_PREFIX,
): void => {
  const basename = path.basename(candidate);
  const prefixes = expectedPrefix === undefined
    ? [INSTALL_DIRECTORY_PREFIX, QUARANTINE_DIRECTORY_PREFIX]
    : [expectedPrefix];
  if (
    !path.isAbsolute(candidate)
    || path.dirname(candidate) !== expectedParent
    || !prefixes.some((prefix) =>
      basename.startsWith(prefix) && basename.length > prefix.length
    )
  ) {
    throw invalidToolchain();
  }
};

type SetupLock = {release(): Promise<void>};

const cachePathChain = (
  canonicalHome: string,
  cacheRoot: string,
): readonly string[] => {
  const expectedCacheRoot = path.join(canonicalHome, ...CACHE_PATH_COMPONENTS);
  if (
    !path.isAbsolute(canonicalHome)
    || cacheRoot !== expectedCacheRoot
    || path.relative(canonicalHome, cacheRoot).startsWith('..')
  ) {
    throw invalidToolchain();
  }
  return [
    canonicalHome,
    ...CACHE_PATH_COMPONENTS.map((_, index) => path.join(
      canonicalHome,
      ...CACHE_PATH_COMPONENTS.slice(0, index + 1),
    )),
  ];
};

const validateCachePathAncestors = async (
  canonicalHome: string,
  cacheRoot: string,
  dependencies: InstallerDependencies,
  allowMissingTail: boolean,
): Promise<void> => {
  const chain = cachePathChain(canonicalHome, cacheRoot);
  const applicationCache = chain.at(-2);
  const uid = dependencies.currentUid();
  for (const [index, candidate] of chain.entries()) {
    let stats: Awaited<ReturnType<InstallerDependencies['lstat']>>;
    try {
      stats = await dependencies.lstat(candidate);
    } catch (error) {
      if (allowMissingTail && index > 0 && isMissingPathError(error)) return;
      throw invalidToolchain();
    }
    if (!isOwnedDirectory(stats, uid)) throw invalidToolchain();
    if (
      (candidate === applicationCache || candidate === cacheRoot)
      && (stats.mode & 0o022) !== 0
    ) {
      throw invalidToolchain();
    }
  }
};

const acquireSetupLock = async (
  canonicalHome: string,
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<SetupLock> => {
  const {cacheRoot, setupLock: lockPath} = paths;
  let handle: FileHandle | undefined;
  try {
    if (path.dirname(lockPath) !== cacheRoot) throw invalidToolchain();
    await validateCachePathAncestors(
      canonicalHome,
      cacheRoot,
      dependencies,
      true,
    );
    await dependencies.mkdir(cacheRoot, {recursive: true, mode: 0o700});
    await validateCachePathAncestors(
      canonicalHome,
      cacheRoot,
      dependencies,
      false,
    );
    handle = await dependencies.open(lockPath, 'wx', 0o600);
    const identity = await handle.stat();
    if (!identity.isFile() || identity.uid !== dependencies.currentUid()) {
      throw invalidToolchain();
    }
    return {
      release: async () => {
        let current:
          | Awaited<ReturnType<InstallerDependencies['lstat']>>
          | undefined;
        try {
          current = await dependencies.lstat(lockPath);
        } catch {
          current = undefined;
        }
        const valid = current !== undefined
          && !current.isSymbolicLink()
          && current.isFile()
          && current.uid === identity.uid
          && current.dev === identity.dev
          && current.ino === identity.ino;
        try {
          await handle?.close();
        } catch {
          throw invalidToolchain();
        }
        if (!valid) throw invalidToolchain();
        try {
          await dependencies.rm(lockPath);
        } catch {
          throw invalidToolchain();
        }
      },
    };
  } catch {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        throw invalidToolchain();
      }
    }
    throw invalidToolchain();
  }
};

const pathsForVersionDirectory = (
  base: DownloaderToolchainPaths,
  versionDirectory: string,
): DownloaderToolchainPaths => ({
  ...base,
  versionDirectory,
  installedManifest: path.join(versionDirectory, 'manifest.json'),
  ytDlpExecutable: path.join(versionDirectory, 'bin/yt-dlp'),
  denoWrapperExecutable: path.join(
    versionDirectory,
    'bin',
    DENO_WRAPPER_FILENAME,
  ),
  pluginDirectory: path.join(versionDirectory, 'plugins'),
  pluginArchive: path.join(
    versionDirectory,
    'plugins/bgutil-ytdlp-pot-provider.zip',
  ),
  providerDirectory: path.join(versionDirectory, 'provider'),
  providerServerDirectory: path.join(versionDirectory, 'provider/server'),
  denoDirectory: path.join(versionDirectory, 'deno'),
  providerCacheDirectory: path.join(versionDirectory, 'deno/provider-cache'),
});

const validatePublishedToolchainIntegrity = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const providerHeadPath = path.join(paths.providerDirectory, '.git/HEAD');
  const providerScriptPath = path.join(
    paths.providerServerDirectory,
    'src/generate_once.ts',
  );
  const providerModulesPath = path.join(
    paths.providerServerDirectory,
    'node_modules',
  );
  const [
    root,
    downloader,
    denoWrapper,
    plugin,
    providerHeadStats,
    providerScriptStats,
    providerModulesStats,
    manifestSource,
    providerHead,
  ] = await Promise.all([
    dependencies.lstat(paths.versionDirectory),
    dependencies.lstat(paths.ytDlpExecutable),
    dependencies.lstat(paths.denoWrapperExecutable),
    dependencies.lstat(paths.pluginArchive),
    dependencies.lstat(providerHeadPath),
    dependencies.lstat(providerScriptPath),
    dependencies.lstat(providerModulesPath),
    dependencies.readFile(paths.installedManifest, 'utf8'),
    dependencies.readFile(providerHeadPath, 'utf8'),
  ]);
  const uid = dependencies.currentUid();
  if (
    !isOwnedDirectory(root, uid)
    || !isOwnedRegularFile(downloader, uid)
    || !isOwnedRegularFile(denoWrapper, uid)
    || (denoWrapper.mode & 0o777) !== 0o700
    || !isOwnedRegularFile(plugin, uid)
    || !isOwnedRegularFile(providerHeadStats, uid)
    || !isOwnedRegularFile(providerScriptStats, uid)
    || !isOwnedDirectory(providerModulesStats, uid)
  ) {
    throw invalidToolchain();
  }

  const denoWrapperSource = await dependencies.readFile(
    paths.denoWrapperExecutable,
    'utf8',
  );

  let installedManifest: unknown;
  try {
    installedManifest = JSON.parse(manifestSource) as unknown;
  } catch {
    throw invalidToolchain();
  }
  if (!isDeepStrictEqual(
    installedManifest,
    installedManifestForPinnedToolchain(),
  )) {
    throw invalidToolchain();
  }

  const [downloaderHash, pluginHash] = await Promise.all([
    dependencies.capabilities.hashFile(paths.ytDlpExecutable),
    dependencies.capabilities.hashFile(paths.pluginArchive),
  ]);
  if (
    downloaderHash !== DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256
    || pluginHash !== DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256
    || denoWrapperSource !== DENO_WRAPPER_SOURCE
    || providerHead.trim()
      !== DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit
  ) {
    throw invalidToolchain();
  }
};

const publishedToolchainIsValid = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<boolean> => {
  const throwIfAborted = (): void => {
    if (signal?.aborted === true) throw signal.reason;
  };
  try {
    throwIfAborted();
    await validatePublishedToolchainIntegrity(paths, dependencies);
    throwIfAborted();
    return true;
  } catch (error) {
    throwIfAborted();
    if (isMissingPathError(error)) return false;
    if (error instanceof DownloadError) return false;
    throw invalidToolchain();
  }
};

const quarantineInvalidPublishedDirectory = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<string | undefined> => {
  if (path.dirname(paths.versionDirectory) !== paths.cacheRoot) {
    throw invalidToolchain();
  }
  await requireOwnedDirectory(paths.cacheRoot, dependencies);
  let publishedStats:
    | Awaited<ReturnType<InstallerDependencies['lstat']>>
    | undefined;
  try {
    publishedStats = await dependencies.lstat(paths.versionDirectory);
  } catch (error) {
    if (isMissingPathError(error)) return undefined;
    throw invalidToolchain();
  }
  if (!isOwnedDirectory(publishedStats, dependencies.currentUid())) {
    throw invalidToolchain();
  }

  const quarantineDirectory = path.join(
    paths.cacheRoot,
    `${QUARANTINE_DIRECTORY_PREFIX}${dependencies.randomUUID()}`,
  );
  requireGeneratedPath(
    quarantineDirectory,
    paths.cacheRoot,
    QUARANTINE_DIRECTORY_PREFIX,
  );
  try {
    await dependencies.lstat(quarantineDirectory);
    throw invalidToolchain();
  } catch (error) {
    if (!isMissingPathError(error)) throw invalidToolchain();
  }
  await dependencies.rename(paths.versionDirectory, quarantineDirectory);
  return quarantineDirectory;
};

const removeOwnedDirectory = async (
  candidate: string,
  cacheRoot: string,
  dependencies: InstallerDependencies,
): Promise<void> => {
  requireGeneratedPath(candidate, cacheRoot);
  await requireOwnedDirectory(cacheRoot, dependencies);
  await requireOwnedDirectory(candidate, dependencies);
  await dependencies.rm(candidate, {recursive: true});
  await syncDirectory(cacheRoot, dependencies);
};

const restoreQuarantine = async (
  quarantineDirectory: string,
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  requireGeneratedPath(
    quarantineDirectory,
    paths.cacheRoot,
    QUARANTINE_DIRECTORY_PREFIX,
  );
  if (path.dirname(paths.versionDirectory) !== paths.cacheRoot) {
    throw invalidToolchain();
  }
  await requireOwnedDirectory(paths.cacheRoot, dependencies);
  await requireOwnedDirectory(quarantineDirectory, dependencies);
  try {
    await dependencies.lstat(paths.versionDirectory);
    throw invalidToolchain();
  } catch (error) {
    if (!isMissingPathError(error)) throw invalidToolchain();
  }
  await dependencies.rename(quarantineDirectory, paths.versionDirectory);
};

const createStagingLayout = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  await dependencies.mkdir(path.dirname(paths.ytDlpExecutable), {mode: 0o700});
  await dependencies.mkdir(paths.pluginDirectory, {mode: 0o700});
  await dependencies.mkdir(paths.denoDirectory, {mode: 0o700});
  await dependencies.mkdir(paths.providerCacheDirectory, {mode: 0o700});
};

const requireGitAndDeno2 = async (
  stagingPaths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<string> => {
  const processOptions = processOptionsFor(
    signal,
    buildInstallerChildEnvironment(stagingPaths),
  );
  await dependencies.runProcess('git', ['--version'], processOptions);
  const denoExecutable = await dependencies.capabilities.resolveExecutable('deno');
  const result = await dependencies.runProcess(
    denoExecutable,
    ['--version'],
    processOptions,
  );
  const firstLine = result.stdout.split(/\r?\n/u)[0] ?? '';
  const match = /^deno (\d+)\./u.exec(firstLine);
  if (match?.[1] === undefined || Number(match[1]) < 2) {
    throw invalidToolchain();
  }
  return denoExecutable;
};

const downloadPinnedAsset = async (
  asset: {url: string; bytes: number; sha256: string},
  destination: string,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  let current = new URL(asset.url);
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!isAllowedAssetUrl(current)) throw invalidToolchain();
    response = await dependencies.fetch(current, {
      redirect: 'manual',
      ...(signal === undefined ? {} : {signal}),
    });
    if (!REDIRECT_STATUSES.has(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (location === null) throw invalidToolchain();
    current = new URL(location, current);
    response = undefined;
  }
  if (response === undefined || !response.ok || response.body === null) {
    throw invalidToolchain();
  }

  const handle = await dependencies.open(destination, 'wx', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > asset.bytes) throw invalidToolchain();
      hash.update(buffer);
      await handle.write(buffer);
    }
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) {
      throw invalidToolchain();
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const checkoutPinnedProvider = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  const processOptions = processOptionsFor(
    signal,
    buildInstallerChildEnvironment(paths),
  );
  await dependencies.runProcess(
    'git',
    ['init', paths.providerDirectory],
    processOptions,
  );
  await dependencies.runProcess('git', [
    '-C',
    paths.providerDirectory,
    'remote',
    'add',
    'origin',
    DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.repository,
  ], processOptions);
  await dependencies.runProcess('git', [
    '-C',
    paths.providerDirectory,
    'fetch',
    '--depth',
    '1',
    'origin',
    DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit,
  ], processOptions);
  await dependencies.runProcess('git', [
    '-C',
    paths.providerDirectory,
    'checkout',
    '--detach',
    'FETCH_HEAD',
  ], processOptions);
  const head = await dependencies.readFile(
    path.join(paths.providerDirectory, '.git/HEAD'),
    'utf8',
  );
  if (head.trim() !== DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit) {
    throw invalidToolchain();
  }
};

const installProviderDependencies = async (
  stagingPaths: DownloaderToolchainPaths,
  denoExecutable: string,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  await dependencies.runProcess(denoExecutable, [
    'install',
    '--allow-scripts=npm:canvas',
    '--frozen',
  ], {
    cwd: stagingPaths.providerServerDirectory,
    env: buildInstallerChildEnvironment(stagingPaths),
    ...(signal === undefined ? {} : {signal}),
  });
};

const writeDenoWrapper = async (
  stagingPaths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const handle = await dependencies.open(
    stagingPaths.denoWrapperExecutable,
    'wx',
    0o700,
  );
  try {
    await handle.writeFile(DENO_WRAPPER_SOURCE, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await dependencies.chmod(stagingPaths.denoWrapperExecutable, 0o700);
};

const validateStagedToolchain = async (
  stagingPaths: DownloaderToolchainPaths,
  validatedSystemDenoExecutable: string,
  ffmpegOverride: string | undefined,
  dependencies: InstallerDependencies,
  signal?: AbortSignal,
): Promise<void> => {
  const childEnvironment = buildInstallerChildEnvironment(stagingPaths);
  const capabilityDependencies: DownloaderCapabilityDependencies = {
    ...dependencies.capabilities,
    runProcess: async (command, args, options = {}) => {
      const systemDenoExecutable =
        options.env?.[DENO_EXECUTABLE_ENVIRONMENT_KEY];
      const environment = systemDenoExecutable === undefined
        ? childEnvironment
        : Object.freeze({
            ...childEnvironment,
            [DENO_EXECUTABLE_ENVIRONMENT_KEY]: systemDenoExecutable,
          });
      return await dependencies.capabilities.runProcess(command, args, {
        ...options,
        env: environment,
      });
    },
  };
  await validateDownloaderCapabilities({
    source: 'managed',
    validationMode: 'staging',
    ytDlpExecutable: stagingPaths.ytDlpExecutable,
    validatedSystemDenoExecutable,
    ...(ffmpegOverride === undefined ? {} : {ffmpegOverride}),
    paths: stagingPaths,
    ...(signal === undefined ? {} : {signal}),
  }, capabilityDependencies);
};

const writeInstalledManifest = async (
  stagingPaths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const handle = await dependencies.open(
    stagingPaths.installedManifest,
    'wx',
    0o600,
  );
  try {
    await handle.writeFile(
      `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
      'utf8',
    );
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncFile = async (
  candidate: string,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const handle = await dependencies.open(candidate, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncDirectory = async (
  candidate: string,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const handle = await dependencies.open(candidate, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const syncToolchainTree = async (
  paths: DownloaderToolchainPaths,
  dependencies: InstallerDependencies,
): Promise<void> => {
  const providerHead = path.join(paths.providerDirectory, '.git/HEAD');
  const providerScript = path.join(
    paths.providerServerDirectory,
    'src/generate_once.ts',
  );
  for (const candidate of [
    paths.ytDlpExecutable,
    paths.denoWrapperExecutable,
    paths.pluginArchive,
    paths.installedManifest,
    providerHead,
    providerScript,
  ]) {
    await syncFile(candidate, dependencies);
  }
  for (const candidate of [
    path.dirname(paths.ytDlpExecutable),
    paths.pluginDirectory,
    path.dirname(providerHead),
    path.dirname(providerScript),
    path.join(paths.providerServerDirectory, 'node_modules'),
    paths.providerServerDirectory,
    paths.providerDirectory,
    paths.providerCacheDirectory,
    paths.denoDirectory,
    paths.versionDirectory,
  ]) {
    await syncDirectory(candidate, dependencies);
  }
};

const installDownloaderToolchainTransaction = async (
  options: InstallDownloaderToolchainOptions,
  dependencies: InstallerDependencies,
): Promise<SetupDownloaderResult> => {
  const homeDirectory = options.homeDirectory ?? homedir();
  const canonicalHome = path.resolve(homeDirectory);
  const paths = resolveDownloaderToolchainPaths(homeDirectory);
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw invalidToolchain();
  }
  const lock = await acquireSetupLock(canonicalHome, paths, dependencies);
  let stagingDirectory: string | undefined;
  let quarantineDirectory: string | undefined;
  let published = false;
  try {
    if (await publishedToolchainIsValid(paths, dependencies, options.signal)) {
      return {status: 'already-present', version: '2026.07.04'};
    }
    quarantineDirectory = await quarantineInvalidPublishedDirectory(
      paths,
      dependencies,
    );
    if (quarantineDirectory !== undefined) {
      await syncDirectory(paths.cacheRoot, dependencies);
    }
    stagingDirectory = await dependencies.mkdtemp(
      path.join(paths.cacheRoot, INSTALL_DIRECTORY_PREFIX),
    );
    requireGeneratedPath(
      stagingDirectory,
      paths.cacheRoot,
      INSTALL_DIRECTORY_PREFIX,
    );
    await requireOwnedDirectory(stagingDirectory, dependencies);
    await dependencies.chmod(stagingDirectory, 0o700);
    const stagingPaths = pathsForVersionDirectory(paths, stagingDirectory);
    await createStagingLayout(stagingPaths, dependencies);
    const denoExecutable = await requireGitAndDeno2(
      stagingPaths,
      dependencies,
      options.signal,
    );
    await writeDenoWrapper(stagingPaths, dependencies);
    await downloadPinnedAsset(
      DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp,
      stagingPaths.ytDlpExecutable,
      dependencies,
      options.signal,
    );
    await dependencies.chmod(stagingPaths.ytDlpExecutable, 0o700);
    await downloadPinnedAsset(
      DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin,
      stagingPaths.pluginArchive,
      dependencies,
      options.signal,
    );
    await checkoutPinnedProvider(stagingPaths, dependencies, options.signal);
    await installProviderDependencies(
      stagingPaths,
      denoExecutable,
      dependencies,
      options.signal,
    );
    await validateStagedToolchain(
      stagingPaths,
      denoExecutable,
      options.ffmpegOverride,
      dependencies,
      options.signal,
    );
    await writeInstalledManifest(stagingPaths, dependencies);
    await syncToolchainTree(stagingPaths, dependencies);
    await dependencies.rename(stagingDirectory, paths.versionDirectory);
    published = true;
    stagingDirectory = undefined;
    await syncDirectory(paths.cacheRoot, dependencies);
    if (quarantineDirectory !== undefined) {
      await removeOwnedDirectory(
        quarantineDirectory,
        paths.cacheRoot,
        dependencies,
      );
      quarantineDirectory = undefined;
    }
    return {status: 'installed', version: '2026.07.04'};
  } catch {
    if (!published && quarantineDirectory !== undefined) {
      try {
        await restoreQuarantine(quarantineDirectory, paths, dependencies);
        await syncDirectory(paths.cacheRoot, dependencies);
        quarantineDirectory = undefined;
      } catch {
        throw invalidToolchain();
      }
    }
    throw invalidToolchain();
  } finally {
    let cleanupFailed = false;
    if (stagingDirectory !== undefined) {
      try {
        await removeOwnedDirectory(
          stagingDirectory,
          paths.cacheRoot,
          dependencies,
        );
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      await lock.release();
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) throw invalidToolchain();
  }
};

export const installDownloaderToolchain = async (
  options: InstallDownloaderToolchainOptions = {},
  dependencies: InstallerDependencies = defaultInstallerDependencies,
): Promise<SetupDownloaderResult> => {
  try {
    return await installDownloaderToolchainTransaction(options, dependencies);
  } catch {
    throw invalidToolchain();
  }
};
