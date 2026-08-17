import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {
  createSystemVideoctlDependencies,
  runVideoctl,
  runWithCommandSignalHandlers,
  type VideoctlDependencies,
} from '../../../src/cli/videoctl';
import {
  createSystemDownloadDependencies,
  waitForDownloadDelay,
  type DownloadDependencies,
} from '../../../src/download/downloader';
import {
  defaultDownloaderCapabilityDependencies,
  type DownloaderCapabilityDependencies,
} from '../../../src/download/toolchain/capabilities';
import {
  DENO_EXECUTABLE_ENVIRONMENT_KEY,
  DENO_WRAPPER_SOURCE,
} from '../../../src/download/toolchain/deno-wrapper';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from '../../../src/download/toolchain/manifest';
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';
import {resolveDownloaderToolchain} from '../../../src/download/toolchain/resolver';
import type {ResolvedDownloaderToolchain} from '../../../src/download/toolchain/types';
import type {DownloadProcessRunner} from '../../../src/download/yt-dlp';
import {ProcessExecutionError} from '../../../src/process/process-error';
import {runProcess as runSystemProcess} from '../../../src/process/run-process';

const execFile = promisify(execFileCallback);
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
export const FAKE_YT_DLP_FIXTURE = path.join(
  PROJECT_ROOT,
  'tests/fixtures/fake-yt-dlp/yt-dlp.mjs',
);
export const MANAGED_FIXTURE_RUNNER = path.join(
  PROJECT_ROOT,
  'tests/integration/download/managed-toolchain-fixture.ts',
);
export const FIXED_DOWNLOAD_TIME = new Date('2026-07-04T12:00:00.000Z');
export const PROBE_SECRET_MARKERS = [
  'cookie-value-marker',
  'signed-url-marker',
  '/private/browser-profile-marker',
  'header-secret-marker',
  'secret-cookie-marker',
  '/Users/fixture/Library/Application Support/Google/Chrome/Default/Cookies',
] as const;
export const NETWORK_COMMAND = /(?:^|\n)\s*(?:\S*\/)?(?:curl|wget|nc|ssh)\b/mu;
export const NODE_NETWORK_API = /(?:['"](?:node:)?(?:http|https|net|tls)['"]|(?:http|https)\s*\.\s*(?:get|request)\s*\(|net\s*\.\s*(?:connect|createConnection)\s*\(|tls\s*\.\s*connect\s*\()/mu;

export type FakeYtDlpScenario =
  | 'rate-limit'
  | 'bot-check'
  | 'bilibili-412'
  | 'timeout'
  | 'missing-impersonation'
  | 'missing-provider'
  | 'keychain-denied'
  | 'unknown';

export interface ManagedFixtureOptions {
  scenario?: FakeYtDlpScenario;
  failurePhase?: 'probe' | 'download';
  longRunning?: boolean;
  relativeOverrides?: boolean;
  beforeDelay?: (
    milliseconds: number,
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

export interface ManagedFixtureSubprocessEnvironmentOptions {
  recordDirectory?: string;
  managedFixtureRoot?: string;
}

export interface RecordedYtDlpOperation {
  phase: 'probe' | 'download';
  args: string[];
  environment: Readonly<NodeJS.ProcessEnv> | undefined;
  environmentWasFrozen: boolean;
  extraStdioFds: readonly number[] | undefined;
}

export interface RecordedFixtureSubprocess {
  command: string;
  args: string[];
  environment: Readonly<NodeJS.ProcessEnv>;
  environmentWasFrozen: boolean;
}

export interface DigestRecord {
  phase: 'probe' | 'download';
  digest: string;
}

export interface ManagedFixtureCommandHarness {
  dependencies: VideoctlDependencies;
  stdout(): string;
  stderr(): string;
}

export interface ManagedDownloadRuntime {
  dependencies: DownloadDependencies;
  resolveToolchain(signal?: AbortSignal): Promise<ResolvedDownloaderToolchain>;
  createHarnessEnvironment(
    options?: ManagedFixtureSubprocessEnvironmentOptions,
  ): Readonly<NodeJS.ProcessEnv>;
  operations: RecordedYtDlpOperation[];
  subprocesses: RecordedFixtureSubprocess[];
  processFailures: ProcessExecutionError[];
  delays: number[];
  actualHashes: Map<string, string>;
  paths: ReturnType<typeof resolveDownloaderToolchainPaths>;
  recordDirectory: string;
  recordPath: string;
  stateDirectory: string;
  toolsDirectory: string;
  temporaryDirectory: string;
}

export interface ManagedDownloadFixture extends ManagedDownloadRuntime {
  root: string;
  homeDirectory: string;
  workspaceRoot: string;
  createCommandHarness(signal?: AbortSignal): ManagedFixtureCommandHarness;
  cleanup(): Promise<void>;
}

interface FixtureLayout {
  root: string;
  homeDirectory: string;
  workspaceRoot: string;
  recordDirectory: string;
  stateDirectory: string;
  toolsDirectory: string;
  temporaryDirectory: string;
  pluginWorkspace: string;
  denoExecutable: string;
  ffmpegExecutable: string;
  gitExecutable: string;
  overrideDirectory: string;
  ytDlpOverrideExecutable: string;
  ffmpegOverrideExecutable: string;
  paths: ReturnType<typeof resolveDownloaderToolchainPaths>;
}

const fixtureLayout = (root: string): FixtureLayout => {
  const homeDirectory = path.join(root, 'home');
  const toolsDirectory = path.join(homeDirectory, 'tools');
  return {
    root,
    homeDirectory,
    workspaceRoot: path.join(root, 'workspace'),
    recordDirectory: path.join(root, 'records'),
    stateDirectory: path.join(root, 'state'),
    toolsDirectory,
    temporaryDirectory: path.join(root, 'tmp'),
    pluginWorkspace: path.join(root, 'plugin-workspace'),
    denoExecutable: path.join(toolsDirectory, 'deno'),
    ffmpegExecutable: path.join(toolsDirectory, 'ffmpeg'),
    gitExecutable: path.join(toolsDirectory, 'git'),
    overrideDirectory: path.join(root, 'overrides'),
    ytDlpOverrideExecutable: path.join(root, 'overrides/yt-dlp'),
    ffmpegOverrideExecutable: path.join(root, 'overrides/ffmpeg'),
    paths: resolveDownloaderToolchainPaths(homeDirectory),
  };
};

const writeExecutable = async (
  candidate: string,
  contents: string,
  mode = 0o755,
): Promise<void> => {
  await writeFile(candidate, contents, {mode});
  await chmod(candidate, mode);
};

const sha256 = async (candidate: string): Promise<string> => createHash('sha256')
  .update(await readFile(candidate))
  .digest('hex');

const createPluginArchive = async (
  archive: string,
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> => {
  const entries = [
    'yt_dlp_plugins/',
    'yt_dlp_plugins/extractor/',
    'yt_dlp_plugins/extractor/getpot_bgutil.py',
    'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
    'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
  ];
  await mkdir(path.join(workspace, 'yt_dlp_plugins/extractor'), {
    recursive: true,
  });
  await Promise.all(entries.slice(2).map(async (entry) => {
    await writeFile(path.join(workspace, entry), '# deterministic fixture\n');
  }));
  await execFile('/usr/bin/zip', ['-q', archive, ...entries], {
    cwd: workspace,
    env: environment,
  });
};

const fixtureHarnessEnvironment = (
  layout: FixtureLayout,
  options: ManagedFixtureOptions,
  environmentOptions: ManagedFixtureSubprocessEnvironmentOptions = {},
): Readonly<NodeJS.ProcessEnv> => Object.freeze({
  HOME: layout.homeDirectory,
  PATH: [
    path.dirname(process.execPath),
    layout.toolsDirectory,
    '/usr/bin',
    '/bin',
  ].join(path.delimiter),
  TMPDIR: layout.temporaryDirectory,
  DENO_DIR: layout.paths.denoDirectory,
  XDG_CACHE_HOME: layout.paths.providerCacheDirectory,
  [DENO_EXECUTABLE_ENVIRONMENT_KEY]: layout.denoExecutable,
  DENO_NO_PROMPT: '1',
  DENO_NO_UPDATE_CHECK: '1',
  FORCE_COLOR: 'false',
  FAKE_YT_DLP_RECORD_DIRECTORY:
    environmentOptions.recordDirectory ?? layout.recordDirectory,
  FAKE_YT_DLP_STATE_DIRECTORY: layout.stateDirectory,
  ...(options.scenario === undefined
    ? {}
    : {FAKE_YT_DLP_SCENARIO: options.scenario}),
  ...(options.failurePhase === undefined
    ? {}
    : {FAKE_YT_DLP_FAILURE_PHASE: options.failurePhase}),
  ...(options.longRunning === true ? {FAKE_YT_DLP_LONG_RUNNING: '1'} : {}),
  ...(environmentOptions.managedFixtureRoot === undefined
    ? {}
    : {MANAGED_DOWNLOAD_FIXTURE_ROOT: environmentOptions.managedFixtureRoot}),
});

const fakeYtDlpWrapperSource = (
  layout: FixtureLayout,
  options: ManagedFixtureOptions,
): string => [
  `#!${process.execPath}`,
  `process.env.FAKE_YT_DLP_RECORD_DIRECTORY ??= ${JSON.stringify(layout.recordDirectory)};`,
  `process.env.FAKE_YT_DLP_STATE_DIRECTORY ??= ${JSON.stringify(layout.stateDirectory)};`,
  'delete process.env.FAKE_YT_DLP_RECORD;',
  options.scenario === undefined
    ? 'delete process.env.FAKE_YT_DLP_SCENARIO;'
    : `process.env.FAKE_YT_DLP_SCENARIO = ${JSON.stringify(options.scenario)};`,
  options.failurePhase === undefined
    ? 'delete process.env.FAKE_YT_DLP_FAILURE_PHASE;'
    : `process.env.FAKE_YT_DLP_FAILURE_PHASE = ${JSON.stringify(options.failurePhase)};`,
  options.longRunning === true
    ? "process.env.FAKE_YT_DLP_LONG_RUNNING = '1';"
    : 'delete process.env.FAKE_YT_DLP_LONG_RUNNING;',
  `await import(${JSON.stringify(pathToFileURL(FAKE_YT_DLP_FIXTURE).href)});`,
  '',
].join('\n');

const initializeManagedCache = async (
  layout: FixtureLayout,
  options: ManagedFixtureOptions,
): Promise<void> => {
  const {paths} = layout;
  await Promise.all([
    mkdir(path.dirname(paths.ytDlpExecutable), {recursive: true}),
    mkdir(paths.pluginDirectory, {recursive: true}),
    mkdir(path.join(paths.providerDirectory, '.git'), {recursive: true}),
    mkdir(path.join(paths.providerServerDirectory, 'src'), {recursive: true}),
    mkdir(path.join(paths.providerServerDirectory, 'node_modules'), {
      recursive: true,
    }),
    mkdir(paths.denoDirectory, {recursive: true}),
    mkdir(paths.providerCacheDirectory, {recursive: true}),
    mkdir(layout.workspaceRoot, {recursive: true}),
    mkdir(layout.recordDirectory, {recursive: true}),
    mkdir(layout.stateDirectory, {recursive: true}),
    mkdir(layout.toolsDirectory, {recursive: true}),
    mkdir(layout.overrideDirectory, {recursive: true}),
    mkdir(layout.temporaryDirectory, {recursive: true}),
    mkdir(layout.pluginWorkspace, {recursive: true}),
  ]);
  const ytDlpWrapperSource = fakeYtDlpWrapperSource(layout, options);
  await Promise.all([
    writeExecutable(paths.ytDlpExecutable, ytDlpWrapperSource),
    writeExecutable(layout.ytDlpOverrideExecutable, ytDlpWrapperSource),
  ]);
  await createPluginArchive(
    paths.pluginArchive,
    layout.pluginWorkspace,
    fixtureHarnessEnvironment(layout, options),
  );
  await Promise.all([
    writeFile(
      paths.installedManifest,
      `${JSON.stringify(installedManifestForPinnedToolchain(), null, 2)}\n`,
    ),
    writeFile(
      path.join(paths.providerDirectory, '.git/HEAD'),
      `${DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.commit}\n`,
    ),
    writeFile(
      path.join(paths.providerServerDirectory, 'src/generate_once.ts'),
      'console.log("deterministic fixture");\n',
    ),
    writeExecutable(
      paths.denoWrapperExecutable,
      DENO_WRAPPER_SOURCE,
      0o700,
    ),
    writeExecutable(layout.denoExecutable, [
      `#!${process.execPath}`,
      'const args = process.argv.slice(2);',
      "if (args.length === 1 && args[0] === '--version') {",
      "  process.stdout.write('deno 2.8.3\\n');",
      '  process.exit(0);',
      '}',
      "if (args[0] === 'run') process.exit(0);",
      'process.exit(2);',
      '',
    ].join('\n')),
    writeExecutable(layout.ffmpegExecutable, [
      `#!${process.execPath}`,
      "process.stdout.write('ffmpeg version 8.1.2\\n');",
      '',
    ].join('\n')),
    writeExecutable(layout.ffmpegOverrideExecutable, [
      `#!${process.execPath}`,
      "process.stdout.write('ffmpeg version 8.1.2\\n');",
      '',
    ].join('\n')),
    writeExecutable(layout.gitExecutable, [
      `#!${process.execPath}`,
      "process.stdout.write('git version 2.50.1\\n');",
      '',
    ].join('\n')),
  ]);
};

const operationForInvocation = (
  command: string,
  args: readonly string[],
): {phase: 'probe' | 'download'; args: string[]} | undefined => {
  if (args.includes('--dump-single-json')) {
    return {phase: 'probe', args: [...args]};
  }
  if (command !== '/usr/bin/osascript') return undefined;
  const separator = args.indexOf('--');
  if (separator === -1 || args[separator + 1] === undefined) return undefined;
  return {phase: 'download', args: args.slice(separator + 2)};
};

export const createManagedDownloadRuntime = (
  root: string,
  options: ManagedFixtureOptions = {},
): ManagedDownloadRuntime => {
  const layout = fixtureLayout(root);
  const operations: RecordedYtDlpOperation[] = [];
  const subprocesses: RecordedFixtureSubprocess[] = [];
  const processFailures: ProcessExecutionError[] = [];
  const delays: number[] = [];
  const actualHashes = new Map<string, string>();
  const createHarnessEnvironment = (
    environmentOptions: ManagedFixtureSubprocessEnvironmentOptions = {},
  ): Readonly<NodeJS.ProcessEnv> => fixtureHarnessEnvironment(
    layout,
    options,
    environmentOptions,
  );
  const processRunner: DownloadProcessRunner = async (
    command,
    args,
    runOptions = {},
  ) => {
    const environmentWasFrozen = runOptions.env !== undefined
      && Object.isFrozen(runOptions.env);
    const environment = {...runOptions.env};
    const operation = operationForInvocation(command, args);
    if (operation !== undefined) {
      operations.push({
        phase: operation.phase,
        args: operation.args,
        environment,
        environmentWasFrozen,
        extraStdioFds: runOptions.extraStdioFds === undefined
          ? undefined
          : [...runOptions.extraStdioFds],
      });
    }
    subprocesses.push({
      command,
      args: [...args],
      environment,
      environmentWasFrozen,
    });
    try {
      return await runSystemProcess(command, args, runOptions);
    } catch (error) {
      if (operation !== undefined && error instanceof ProcessExecutionError) {
        processFailures.push(error);
      }
      throw error;
    }
  };
  const capabilityDependencies: DownloaderCapabilityDependencies = {
    ...defaultDownloaderCapabilityDependencies,
    lstat: async (candidate): Promise<Stats> =>
      await defaultDownloaderCapabilityDependencies.lstat(candidate),
    hashFile: async (candidate) => {
      const digest = await sha256(candidate);
      actualHashes.set(candidate, digest);
      if (candidate === layout.paths.ytDlpExecutable) {
        return DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256;
      }
      if (candidate === layout.paths.pluginArchive) {
        return DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256;
      }
      return digest;
    },
    resolveExecutable: async (name) => name === 'deno'
      ? layout.denoExecutable
      : layout.ffmpegExecutable,
    runProcess: processRunner,
  };
  const resolveToolchain = async (
    signal?: AbortSignal,
  ): Promise<ResolvedDownloaderToolchain> => await resolveDownloaderToolchain({
      homeDirectory: layout.homeDirectory,
      ...(options.relativeOverrides === true
        ? {
            ytDlpOverride: path.relative(
              layout.root,
              layout.ytDlpOverrideExecutable,
            ),
            ffmpegOverride: path.relative(
              layout.root,
              layout.ffmpegOverrideExecutable,
            ),
          }
        : {}),
      ...(signal === undefined ? {} : {signal}),
    }, capabilityDependencies);
  const dependencies = createSystemDownloadDependencies({
    homeDirectory: layout.homeDirectory,
    runProcess: processRunner,
  });
  dependencies.resolveToolchain = resolveToolchain;
  dependencies.wait = async (milliseconds, signal) => {
    delays.push(milliseconds);
    await options.beforeDelay?.(milliseconds, signal);
    await waitForDownloadDelay(0, signal);
  };
  dependencies.now = () => new Date(FIXED_DOWNLOAD_TIME);

  return {
    dependencies,
    resolveToolchain,
    createHarnessEnvironment,
    operations,
    subprocesses,
    processFailures,
    delays,
    actualHashes,
    paths: layout.paths,
    recordDirectory: layout.recordDirectory,
    recordPath: path.join(layout.recordDirectory, 'operations.jsonl'),
    stateDirectory: layout.stateDirectory,
    toolsDirectory: layout.toolsDirectory,
    temporaryDirectory: layout.temporaryDirectory,
  };
};

const clearImmutableFlags = async (
  target: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> => {
  await execFile('/usr/bin/chflags', ['-R', 'nouchg', target], {
    env: environment,
  }).catch(() => {});
};

const makeTreeWritable = async (target: string): Promise<void> => {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return;
    if (!stats.isDirectory()) {
      await chmod(target, 0o600);
      return;
    }
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) {
      await makeTreeWritable(path.join(target, entry));
    }
  } catch {
  }
};

export const createManagedDownloadFixture = async (
  options: ManagedFixtureOptions = {},
): Promise<ManagedDownloadFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'managed-download-test-'));
  const layout = fixtureLayout(root);
  await initializeManagedCache(layout, options);
  const runtime = createManagedDownloadRuntime(root, options);
  const harnessEnvironment = fixtureHarnessEnvironment(layout, options);
  return {
    ...runtime,
    root,
    homeDirectory: layout.homeDirectory,
    workspaceRoot: layout.workspaceRoot,
    createCommandHarness: (signal) => {
      let stdout = '';
      let stderr = '';
      const dependencies = createSystemVideoctlDependencies({
        ...(signal === undefined ? {} : {signal}),
        createDownloadDependencies: () => runtime.dependencies,
      });
      dependencies.workspaceRoot = layout.workspaceRoot;
      dependencies.stdout = {write: (chunk) => { stdout += chunk; }};
      dependencies.stderr = {write: (chunk) => { stderr += chunk; }};
      return {
        dependencies,
        stdout: () => stdout,
        stderr: () => stderr,
      };
    },
    cleanup: async () => {
      await clearImmutableFlags(root, harnessEnvironment);
      await makeTreeWritable(root);
      await rm(root, {recursive: true, force: true});
    },
  };
};

export const readDigestRecords = async (
  recordPath: string,
): Promise<DigestRecord[]> => {
  try {
    return (await readFile(recordPath, 'utf8'))
      .split(/\r?\n/u)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as DigestRecord);
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
};

export interface NetworkSocketGuard {
  calls: string[];
  restore(): void;
}

export const installNetworkSocketGuard = (): NetworkSocketGuard => {
  const calls: string[] = [];
  const restoreMethods: Array<() => void> = [];
  const guardMethod = (target: object, key: string, label: string): void => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
    const original = Reflect.get(target, key);
    if (typeof original !== 'function') throw new Error(`Cannot guard ${label}.`);
    Object.defineProperty(target, key, {
      configurable: ownDescriptor?.configurable ?? true,
      enumerable: ownDescriptor?.enumerable ?? false,
      writable: ownDescriptor?.writable ?? true,
      value: (..._arguments: unknown[]): never => {
        calls.push(label);
        throw new Error(`Unexpected network socket attempt through ${label}.`);
      },
    });
    restoreMethods.push(() => {
      if (ownDescriptor === undefined) Reflect.deleteProperty(target, key);
      else Object.defineProperty(target, key, ownDescriptor);
    });
  };
  guardMethod(net, 'connect', 'node:net.connect');
  guardMethod(net, 'createConnection', 'node:net.createConnection');
  guardMethod(net.Socket.prototype, 'connect', 'node:net.Socket.connect');
  guardMethod(tls, 'connect', 'node:tls.connect');
  return {
    calls,
    restore: () => {
      for (const restore of restoreMethods.reverse()) restore();
    },
  };
};

const directlyExecuted = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (directlyExecuted) {
  const root = process.env.MANAGED_DOWNLOAD_FIXTURE_ROOT;
  if (root === undefined) throw new Error('Managed fixture root is required.');
  const runtime = createManagedDownloadRuntime(root, {
    ...(process.env.FAKE_YT_DLP_SCENARIO === undefined
      ? {}
      : {scenario: process.env.FAKE_YT_DLP_SCENARIO as FakeYtDlpScenario}),
    ...(process.env.FAKE_YT_DLP_FAILURE_PHASE === 'probe'
      || process.env.FAKE_YT_DLP_FAILURE_PHASE === 'download'
      ? {failurePhase: process.env.FAKE_YT_DLP_FAILURE_PHASE}
      : {}),
    longRunning: process.env.FAKE_YT_DLP_LONG_RUNNING === '1',
  });
  const argv = process.argv.slice(2);
  const operation = runWithCommandSignalHandlers(process, async (signal) => {
    const dependencies = createSystemVideoctlDependencies({
      signal,
      createDownloadDependencies: () => runtime.dependencies,
    });
    return await runVideoctl(argv, dependencies);
  });
  void operation.then(
    (exitCode) => { process.exitCode = exitCode; },
    () => {
      process.stderr.write('videoctl failed unexpectedly.\n');
      process.exitCode = 4;
    },
  );
}
