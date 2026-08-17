import {createHash} from 'node:crypto';
import {constants, type Stats} from 'node:fs';
import {
  access,
  lstat,
  readFile,
} from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {
  runProcess as runSystemProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../../process/run-process';
import {DownloadError} from '../errors';
import {
  downloadCancellationFrom,
  throwIfDownloadCancelled,
} from '../cancellation';
import type {DownloadProcessRunner} from '../yt-dlp';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from './manifest';
import {
  DENO_EXECUTABLE_ENVIRONMENT_KEY,
  DENO_WRAPPER_SOURCE,
} from './deno-wrapper';
import type {
  DownloaderToolchainPaths,
  DownloaderToolchainSource,
  ResolvedDownloaderToolchain,
} from './types';

const MINIMUM_YT_DLP_VERSION = '2026.07.04';
const HELP_MARKERS = [
  '--js-runtimes RUNTIME[:PATH]',
  '--remote-components COMPONENT',
] as const;
const CHROME_MACOS_PREFERENCES = [
  'Chrome-136:Macos-15',
  'Chrome-133:Macos-15',
  'Chrome-131:Macos-14',
  'Chrome-124:Macos-14',
  'Chrome-123:Macos-14',
  'Chrome-120:Macos-14',
  'Chrome-119:Macos-14',
] as const;
const EXPECTED_PLUGIN_ENTRIES = [
  'yt_dlp_plugins/',
  'yt_dlp_plugins/extractor/',
  'yt_dlp_plugins/extractor/getpot_bgutil.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
  'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
] as const;
const DOWNLOADER_PATH_FALLBACK = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(path.delimiter);
const PASSTHROUGH_ENVIRONMENT_KEYS = new Set([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LC_COLLATE',
  'LC_MESSAGES',
  'LC_MONETARY',
  'LC_NUMERIC',
  'LC_TIME',
  'USER',
  'LOGNAME',
  '__CF_USER_TEXT_ENCODING',
  'SECURITYSESSIONID',
]);

const invalidToolchain = (): DownloadError => new DownloadError(
  'DOWNLOAD_TOOLCHAIN_INVALID',
  'The managed downloader failed integrity or capability checks.',
);

const invalidProvider = (): DownloadError => new DownloadError(
  'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
  'The YouTube compatibility provider is unavailable.',
);

const unavailableImpersonation = (): DownloadError => new DownloadError(
  'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
  'The required browser compatibility capability is unavailable.',
);

export const compareYtDlpVersions = (left: string, right: string): number => {
  const parse = (value: string): readonly number[] => {
    const match = /^(\d{4})\.(\d{2})\.(\d{2})$/u.exec(value);
    if (match === null) throw invalidToolchain();
    return match.slice(1).map(Number);
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const pluginEntriesMatch = (stdout: string): boolean => {
  const actual = stdout.split(/\r?\n/u).filter((entry) => entry.length > 0);
  const actualEntries = new Set(actual);
  return actual.length === EXPECTED_PLUGIN_ENTRIES.length
    && actualEntries.size === EXPECTED_PLUGIN_ENTRIES.length
    && EXPECTED_PLUGIN_ENTRIES.every((entry) => actualEntries.has(entry));
};

const buildDownloaderBaseEnvironment = (
  paths: DownloaderToolchainPaths,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<NodeJS.ProcessEnv> => {
  const pathEntries = [...new Set((source.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry)))];
  const environment: NodeJS.ProcessEnv = {
    PATH: pathEntries.length === 0
      ? DOWNLOADER_PATH_FALLBACK
      : pathEntries.join(path.delimiter),
    HOME: paths.homeDirectory,
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NPM_CONFIG_GLOBALCONFIG: '/dev/null',
    DENO_DIR: paths.denoDirectory,
    XDG_CACHE_HOME: paths.providerCacheDirectory,
    DENO_NO_PROMPT: '1',
    DENO_NO_UPDATE_CHECK: '1',
    FORCE_COLOR: 'false',
  };
  if (source.TMPDIR !== undefined && path.isAbsolute(source.TMPDIR)) {
    environment.TMPDIR = source.TMPDIR;
  }
  for (const [key, value] of Object.entries(source)) {
    if (
      value !== undefined
      && PASSTHROUGH_ENVIRONMENT_KEYS.has(key)
    ) {
      environment[key] = value;
    }
  }
  return Object.freeze(environment);
};

export const buildDownloaderChildEnvironment = (
  paths: DownloaderToolchainPaths,
  systemDenoExecutable: string,
  source: Readonly<NodeJS.ProcessEnv> = process.env,
): Readonly<NodeJS.ProcessEnv> => {
  if (!path.isAbsolute(systemDenoExecutable)) throw invalidToolchain();
  return Object.freeze({
    ...buildDownloaderBaseEnvironment(paths, source),
    [DENO_EXECUTABLE_ENVIRONMENT_KEY]: systemDenoExecutable,
  });
};

export interface DownloaderCapabilityDependencies {
  runProcess: DownloadProcessRunner;
  directoryExists(candidate: string): Promise<boolean>;
  lstat(candidate: string): Promise<Stats>;
  readFile(candidate: string, encoding: 'utf8'): Promise<string>;
  hashFile(candidate: string): Promise<string>;
  currentUid(): number;
  resolveExecutable(name: 'deno' | 'ffmpeg'): Promise<string>;
}

export interface ValidateDownloaderCapabilitiesOptions {
  source: DownloaderToolchainSource;
  validationMode: 'published' | 'staging';
  ytDlpExecutable: string;
  validatedSystemDenoExecutable?: string;
  ffmpegOverride?: string;
  paths: DownloaderToolchainPaths;
  signal?: AbortSignal;
}

const hashFile = async (candidate: string): Promise<string> => {
  const contents = await readFile(candidate);
  return createHash('sha256').update(contents).digest('hex');
};

type LstatFile = (candidate: string) => Promise<Stats>;

export const directoryExists = async (
  candidate: string,
  lstatFile: LstatFile = lstat,
): Promise<boolean> => {
  try {
    return (await lstatFile(candidate)).isDirectory();
  } catch (error) {
    const code = typeof error === 'object'
      && error !== null
      && 'code' in error
      ? error.code
      : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
};

const resolveExecutable = async (
  name: 'deno' | 'ffmpeg',
): Promise<string> => {
  const searchDirectories = (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry));
  for (const directory of searchDirectories) {
    const candidate = path.join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('executable unavailable');
};

export const defaultDownloaderCapabilityDependencies:
  DownloaderCapabilityDependencies = {
  runProcess: runSystemProcess,
  directoryExists,
  lstat,
  readFile: async (candidate, encoding) => await readFile(candidate, encoding),
  hashFile,
  currentUid: () =>
    typeof process.getuid === 'function' ? process.getuid() : -1,
  resolveExecutable,
};

const requireOwnedRegularFile = async (
  candidate: string,
  dependencies: DownloaderCapabilityDependencies,
  failure: () => DownloadError,
): Promise<Stats> => {
  try {
    const stats = await dependencies.lstat(candidate);
    if (
      stats.isSymbolicLink()
      || !stats.isFile()
      || stats.uid !== dependencies.currentUid()
    ) {
      throw failure();
    }
    return stats;
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw failure();
  }
};

const requirePublishedManifest = async (
  paths: DownloaderToolchainPaths,
  dependencies: DownloaderCapabilityDependencies,
): Promise<void> => {
  try {
    const raw = await dependencies.readFile(paths.installedManifest, 'utf8');
    if (!isDeepStrictEqual(
      JSON.parse(raw) as unknown,
      installedManifestForPinnedToolchain(),
    )) {
      throw invalidToolchain();
    }
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidToolchain();
  }
};

const requireManagedDenoWrapper = async (
  paths: DownloaderToolchainPaths,
  dependencies: DownloaderCapabilityDependencies,
): Promise<void> => {
  const stats = await requireOwnedRegularFile(
    paths.denoWrapperExecutable,
    dependencies,
    invalidToolchain,
  );
  if ((stats.mode & 0o777) !== 0o700) throw invalidToolchain();
  try {
    if (
      await dependencies.readFile(paths.denoWrapperExecutable, 'utf8')
      !== DENO_WRAPPER_SOURCE
    ) {
      throw invalidToolchain();
    }
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidToolchain();
  }
};

const requireHash = async (
  candidate: string,
  expected: string,
  dependencies: DownloaderCapabilityDependencies,
): Promise<void> => {
  try {
    if (await dependencies.hashFile(candidate) !== expected) {
      throw invalidToolchain();
    }
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidToolchain();
  }
};

const runChecked = async (
  runner: DownloadProcessRunner,
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<ProcessResult> => {
  try {
    return await runner(command, args, options);
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidToolchain();
  }
};

const runProviderCheck = async (
  runner: DownloadProcessRunner,
  command: string,
  args: readonly string[],
  options: RunProcessOptions,
): Promise<void> => {
  try {
    await runner(command, args, options);
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidProvider();
  }
};

const selectChromeMacosTarget = (stdout: string): string => {
  const targets = new Set<string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const match = /^\s*(Chrome-\S+)\s+(Macos-\S+)\s+curl_cffi\s*$/u.exec(line);
    if (match === null) continue;
    const client = match[1];
    const operatingSystem = match[2];
    if (client !== undefined && operatingSystem !== undefined) {
      targets.add(`${client}:${operatingSystem}`);
    }
  }
  const selected = CHROME_MACOS_PREFERENCES.find((target) => targets.has(target));
  if (selected === undefined) throw unavailableImpersonation();
  return selected;
};

const denoPathList = (...values: readonly string[]): string => values
  .map((value) => value.replaceAll(',', ',,'))
  .join(',');

const parseDenoMajor = (stdout: string): number => {
  const firstLine = stdout.split(/\r?\n/u)[0] ?? '';
  const match = /^deno (\d+)\./u.exec(firstLine);
  if (match?.[1] === undefined) throw invalidToolchain();
  return Number(match[1]);
};

const parseFfmpegVersion = (stdout: string): string => {
  const firstLine = stdout.split(/\r?\n/u)[0] ?? '';
  const match = /^ffmpeg version (\S+)/u.exec(firstLine);
  if (match?.[1] === undefined) throw invalidToolchain();
  return match[1];
};

export const validateDownloaderCapabilities = async (
  options: ValidateDownloaderCapabilitiesOptions,
  dependencies: DownloaderCapabilityDependencies =
    defaultDownloaderCapabilityDependencies,
): Promise<ResolvedDownloaderToolchain> => {
  const relativeInputPresent = !path.isAbsolute(options.ytDlpExecutable)
    || (
      options.ffmpegOverride !== undefined
      && !path.isAbsolute(options.ffmpegOverride)
    );
  const capabilityCwd = relativeInputPresent ? process.cwd() : undefined;
  const canonicalizeExecutable = (candidate: string): string => {
    if (path.isAbsolute(candidate)) return candidate;
    if (capabilityCwd === undefined) throw invalidToolchain();
    return path.resolve(capabilityCwd, candidate);
  };
  const ytDlpExecutable = canonicalizeExecutable(options.ytDlpExecutable);
  const ffmpegOverride = options.ffmpegOverride === undefined
    ? undefined
    : canonicalizeExecutable(options.ffmpegOverride);
  const {
    source,
    validationMode,
    validatedSystemDenoExecutable,
    paths,
    signal,
  } = options;
  throwIfDownloadCancelled(signal);
  const environmentSource = Object.freeze({...process.env});
  const validationEnvironment = buildDownloaderBaseEnvironment(
    paths,
    environmentSource,
  );
  const validationProcessOptions: RunProcessOptions = {
    env: validationEnvironment,
    ...(signal === undefined ? {} : {signal}),
  };
  const providerHead = path.join(paths.providerDirectory, '.git/HEAD');

  await requireOwnedRegularFile(
    ytDlpExecutable,
    dependencies,
    invalidToolchain,
  );
  await requireOwnedRegularFile(
    paths.pluginArchive,
    dependencies,
    invalidToolchain,
  );
  await requireManagedDenoWrapper(paths, dependencies);
  await requireOwnedRegularFile(providerHead, dependencies, invalidToolchain);

  if (validationMode === 'published') {
    await requirePublishedManifest(paths, dependencies);
  }
  if (source === 'managed') {
    await requireHash(
      ytDlpExecutable,
      DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256,
      dependencies,
    );
  }
  await requireHash(
    paths.pluginArchive,
    DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256,
    dependencies,
  );

  let systemDenoExecutable: string;
  let ffmpegExecutable: string;
  try {
    systemDenoExecutable = validatedSystemDenoExecutable
      ?? await dependencies.resolveExecutable('deno');
    ffmpegExecutable = ffmpegOverride
      ?? await dependencies.resolveExecutable('ffmpeg');
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidToolchain();
  }
  if (
    !path.isAbsolute(systemDenoExecutable)
    || systemDenoExecutable === paths.denoWrapperExecutable
  ) {
    throw invalidToolchain();
  }

  const versionResult = await runChecked(
    dependencies.runProcess,
    ytDlpExecutable,
    ['--version'],
    validationProcessOptions,
  );
  const ytDlpVersion = versionResult.stdout.trim();
  const versionComparison = compareYtDlpVersions(
    ytDlpVersion,
    MINIMUM_YT_DLP_VERSION,
  );
  if (
    (source === 'managed' && versionComparison !== 0)
    || (source === 'override' && versionComparison < 0)
  ) {
    throw invalidToolchain();
  }

  const helpResult = await runChecked(
    dependencies.runProcess,
    ytDlpExecutable,
    ['--help'],
    validationProcessOptions,
  );
  if (!HELP_MARKERS.every((marker) => helpResult.stdout.includes(marker))) {
    throw invalidToolchain();
  }

  const denoResult = await runChecked(
    dependencies.runProcess,
    systemDenoExecutable,
    ['--version'],
    validationProcessOptions,
  );
  if (parseDenoMajor(denoResult.stdout) < 2) throw invalidToolchain();
  const childEnvironment = buildDownloaderChildEnvironment(
    paths,
    systemDenoExecutable,
    environmentSource,
  );
  const processOptions: RunProcessOptions = {
    env: childEnvironment,
    ...(signal === undefined ? {} : {signal}),
  };

  const pluginResult = await runChecked(
    dependencies.runProcess,
    '/usr/bin/unzip',
    ['-Z1', paths.pluginArchive],
    processOptions,
  );
  if (!pluginEntriesMatch(pluginResult.stdout)) throw invalidToolchain();

  try {
    const providerHeadContents = await dependencies.readFile(providerHead, 'utf8');
    if (
      providerHeadContents.trim()
      !== DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit
    ) {
      throw invalidProvider();
    }
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw invalidProvider();
  }

  await runProviderCheck(dependencies.runProcess, paths.denoWrapperExecutable, [
    'run',
    '--allow-env',
    `--allow-ffi=${denoPathList(path.join(paths.providerServerDirectory, 'node_modules'))}`,
    `--allow-read=${denoPathList(paths.providerServerDirectory, path.join(paths.providerServerDirectory, 'node_modules'), paths.providerCacheDirectory)}`,
    `--allow-write=${denoPathList(paths.providerCacheDirectory)}`,
    path.join(paths.providerServerDirectory, 'src/generate_once.ts'),
    '--version',
  ], {
    ...processOptions,
    cwd: paths.providerServerDirectory,
  });

  let targetsResult: ProcessResult;
  try {
    targetsResult = await dependencies.runProcess(
      ytDlpExecutable,
      ['--list-impersonate-targets'],
      processOptions,
    );
  } catch (error) {
    const cancellation = downloadCancellationFrom(error);
    if (cancellation !== undefined) throw cancellation;
    throw unavailableImpersonation();
  }
  const chromeImpersonationTarget = selectChromeMacosTarget(targetsResult.stdout);

  const ffmpegResult = await runChecked(
    dependencies.runProcess,
    ffmpegExecutable,
    ['-version'],
    processOptions,
  );
  const ffmpegVersion = parseFfmpegVersion(ffmpegResult.stdout);

  return {
    source,
    ytDlpExecutable,
    ffmpegExecutable,
    denoExecutable: paths.denoWrapperExecutable,
    ytDlpVersion,
    ffmpegVersion,
    pluginDirectory: paths.pluginDirectory,
    pluginArchive: paths.pluginArchive,
    providerServerDirectory: paths.providerServerDirectory,
    denoDirectory: paths.denoDirectory,
    providerCacheDirectory: paths.providerCacheDirectory,
    chromeImpersonationTarget,
    ffmpegExplicit: ffmpegOverride !== undefined,
    childEnvironment,
    audit: source === 'managed'
      ? {
          source,
          ytDlpVersion,
          managedAssetSha256:
            `sha256:${DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256}`,
        }
      : {source, ytDlpVersion},
  };
};
