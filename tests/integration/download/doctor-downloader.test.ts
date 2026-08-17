import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createSystemVideoctlDependencies,
  runVideoctl,
} from '../../../src/cli/videoctl';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  createSystemDownloadDependencies,
  type DownloadDependencies,
} from '../../../src/download/downloader';
import {
  defaultDownloaderCapabilityDependencies,
  type DownloaderCapabilityDependencies,
} from '../../../src/download/toolchain/capabilities';
import {DENO_WRAPPER_SOURCE} from '../../../src/download/toolchain/deno-wrapper';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
} from '../../../src/download/toolchain/manifest';
import {resolveDownloaderToolchainPaths} from '../../../src/download/toolchain/paths';
import type {VerifyProviderIntegrityOptions} from '../../../src/download/toolchain/provider-integrity';
import {resolveDownloaderToolchain} from '../../../src/download/toolchain/resolver';
import type {ResolvedDownloaderToolchain} from '../../../src/download/toolchain/types';
import {runProcess as runSystemProcess} from '../../../src/process/run-process';
import type {
  DownloadProcessRunner,
} from '../../../src/download/yt-dlp';

const execFile = promisify(execFileCallback);
const PROJECT_ROOT = path.resolve(import.meta.dirname, '../../..');
const FAKE_YT_DLP_FIXTURE = path.join(
  PROJECT_ROOT,
  'tests/fixtures/fake-yt-dlp/yt-dlp.mjs',
);
const CHECK_URL = 'https://www.youtube.com/watch?v=abc';
const temporaryDirectories: string[] = [];

const REPORT = {
  command: 'doctor-downloader',
  ok: true,
  toolchain: {
    source: 'managed',
    ytDlpVersion: '2026.07.04',
    integrity: 'verified',
    deno: 'available',
    ejs: 'available',
    potProvider: 'available',
    chromeImpersonation: 'available',
    ffmpeg: 'available',
  },
} as const;

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
): Promise<void> => {
  const extractorDirectory = path.join(
    workspace,
    'yt_dlp_plugins/extractor',
  );
  await mkdir(extractorDirectory, {recursive: true});
  const entries = [
    'yt_dlp_plugins/',
    'yt_dlp_plugins/extractor/',
    'yt_dlp_plugins/extractor/getpot_bgutil.py',
    'yt_dlp_plugins/extractor/getpot_bgutil_http.py',
    'yt_dlp_plugins/extractor/getpot_bgutil_script.py',
  ];
  await Promise.all(entries.slice(2).map(async (entry) => {
    await writeFile(path.join(workspace, entry), '# fixture\n');
  }));
  await execFile('/usr/bin/zip', ['-q', archive, ...entries], {cwd: workspace});
};

interface ManagedFixture {
  homeDirectory: string;
  recordPath: string;
  systemDenoExecutable: string;
  resolveToolchain(signal?: AbortSignal): Promise<ResolvedDownloaderToolchain>;
  createDownloadDependencies(): DownloadDependencies;
  capabilityCommands: Array<{command: string; args: string[]}>;
  probeEnvironments: Array<Readonly<NodeJS.ProcessEnv> | undefined>;
  probeArgs: string[][];
  actualHashes: Map<string, string>;
  providerIntegrityChecks: VerifyProviderIntegrityOptions[];
  providerIntegrityFailures: Set<'source' | 'node_modules'>;
  paths: ReturnType<typeof resolveDownloaderToolchainPaths>;
}

const createManagedFixture = async (): Promise<ManagedFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'doctor-downloader-'));
  temporaryDirectories.push(root);
  const homeDirectory = path.join(root, 'home');
  const paths = resolveDownloaderToolchainPaths(homeDirectory);
  const toolsDirectory = path.join(root, 'tools');
  const pluginWorkspace = path.join(root, 'plugin-workspace');
  const denoExecutable = path.join(toolsDirectory, 'deno');
  const ffmpegExecutable = path.join(toolsDirectory, 'ffmpeg');
  const recordPath = path.join(root, 'yt-dlp-phases.txt');
  vi.stubEnv('PATH', [toolsDirectory, process.env.PATH ?? ''].join(path.delimiter));

  await Promise.all([
    mkdir(path.dirname(paths.ytDlpExecutable), {recursive: true}),
    mkdir(paths.pluginDirectory, {recursive: true}),
    mkdir(path.join(paths.providerDirectory, '.git'), {recursive: true}),
    mkdir(path.join(paths.providerServerDirectory, 'src'), {recursive: true}),
    mkdir(path.join(paths.providerServerDirectory, 'node_modules'), {recursive: true}),
    mkdir(paths.denoDirectory, {recursive: true}),
    mkdir(paths.providerCacheDirectory, {recursive: true}),
    mkdir(toolsDirectory, {recursive: true}),
    mkdir(pluginWorkspace, {recursive: true}),
  ]);
  await writeExecutable(paths.ytDlpExecutable, [
    `#!${process.execPath}`,
    `process.env.FAKE_YT_DLP_RECORD = ${JSON.stringify(recordPath)};`,
    `await import(${JSON.stringify(pathToFileURL(FAKE_YT_DLP_FIXTURE).href)});`,
    '',
  ].join('\n'));
  await createPluginArchive(paths.pluginArchive, pluginWorkspace);
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
      'console.log("fixture");\n',
    ),
    writeExecutable(
      paths.denoWrapperExecutable,
      DENO_WRAPPER_SOURCE,
      0o700,
    ),
    writeExecutable(denoExecutable, [
      `#!${process.execPath}`,
      "const args = process.argv.slice(2);",
      "if (args.length === 1 && args[0] === '--version') {",
      "  process.stdout.write('deno 2.8.3\\n');",
      '  process.exit(0);',
      '}',
      "if (args[0] === 'run' && args.at(-1) === '--version') {",
      "  process.stdout.write('1.3.1\\n');",
      '  process.exit(0);',
      '}',
      'process.exit(2);',
      '',
    ].join('\n')),
    writeExecutable(ffmpegExecutable, [
      `#!${process.execPath}`,
      "process.stdout.write('ffmpeg version 8.1.2\\n');",
      '',
    ].join('\n')),
  ]);

  const actualHashes = new Map<string, string>();
  const capabilityCommands: Array<{command: string; args: string[]}> = [];
  const providerIntegrityChecks: VerifyProviderIntegrityOptions[] = [];
  const providerIntegrityFailures = new Set<'source' | 'node_modules'>();
  const capabilityDependencies: DownloaderCapabilityDependencies = {
    ...defaultDownloaderCapabilityDependencies,
    runProcess: async (command, args, options) => {
      capabilityCommands.push({command, args: [...args]});
      return await runSystemProcess(command, args, options);
    },
    lstat: async (candidate): Promise<Stats> =>
      await defaultDownloaderCapabilityDependencies.lstat(candidate),
    hashFile: async (candidate) => {
      const digest = await sha256(candidate);
      actualHashes.set(candidate, digest);
      if (candidate === paths.ytDlpExecutable) {
        return DOWNLOADER_TOOLCHAIN_MANIFEST.ytDlp.sha256;
      }
      if (candidate === paths.pluginArchive) {
        return DOWNLOADER_TOOLCHAIN_MANIFEST.potPlugin.sha256;
      }
      return digest;
    },
    resolveExecutable: async (name) =>
      name === 'deno' ? denoExecutable : ffmpegExecutable,
    verifyProviderIntegrity: async (verification) => {
      providerIntegrityChecks.push(verification);
      const failure = providerIntegrityFailures.values().next().value;
      if (failure !== undefined) {
        throw new Error(`private ${failure} provider root mismatch`);
      }
    },
  };
  const resolveToolchain = async (
    signal?: AbortSignal,
  ): Promise<ResolvedDownloaderToolchain> => await resolveDownloaderToolchain({
    homeDirectory,
    ...(signal === undefined ? {} : {signal}),
  }, capabilityDependencies);

  const probeEnvironments: Array<Readonly<NodeJS.ProcessEnv> | undefined> = [];
  const probeArgs: string[][] = [];
  const processRunner: DownloadProcessRunner = async (
    command,
    args,
    options = {},
  ) => {
    if (args.includes('--dump-single-json')) {
      probeArgs.push([...args]);
      probeEnvironments.push(options.env);
    }
    return await runSystemProcess(command, args, options);
  };

  return {
    homeDirectory,
    recordPath,
    systemDenoExecutable: denoExecutable,
    resolveToolchain,
    capabilityCommands,
    createDownloadDependencies: () => {
      const dependencies = createSystemDownloadDependencies({
        homeDirectory,
        runProcess: processRunner,
      });
      dependencies.resolveToolchain = resolveToolchain;
      return dependencies;
    },
    probeEnvironments,
    probeArgs,
    actualHashes,
    providerIntegrityChecks,
    providerIntegrityFailures,
    paths,
  };
};

const readPhases = async (recordPath: string): Promise<string[]> => {
  try {
    return (await readFile(recordPath, 'utf8'))
      .split(/\r?\n/u)
      .filter((phase) => phase.length > 0);
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

const commandDependencies = (
  fixture: ManagedFixture,
) => {
  let stdout = '';
  let stderr = '';
  const downloadDependencies = fixture.createDownloadDependencies();
  const dependencies = createSystemVideoctlDependencies({
    createDownloadDependencies: () => downloadDependencies,
  });
  dependencies.stdout = {write: (chunk) => { stdout += chunk; }};
  dependencies.stderr = {write: (chunk) => { stderr += chunk; }};
  return {
    dependencies,
    downloadDependencies,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

describe('doctor-downloader managed integration', () => {
  it('reports only deterministic local capabilities without a probe or download', async () => {
    const fixture = await createManagedFixture();
    vi.stubEnv('HTTP_PROXY', 'http://ambient-proxy.invalid:8080');
    vi.stubEnv('HTTPS_PROXY', 'https://ambient-proxy.invalid:8443');
    vi.stubEnv('ALL_PROXY', 'socks5://ambient-proxy.invalid:1080');
    vi.stubEnv('NO_PROXY', 'private.invalid');
    const run = commandDependencies(fixture);

    const exitCode = await runVideoctl(
      ['doctor-downloader', '--json'],
      run.dependencies,
    );

    expect(exitCode).toBe(0);
    expect(run.stdout()).toBe(`${JSON.stringify(REPORT, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(REPORT);
    expect(run.stderr()).toBe('');
    expect(await readPhases(fixture.recordPath)).toEqual([]);
    expect(fixture.probeArgs).toEqual([]);
    expect(fixture.probeEnvironments).toEqual([]);
    expect(fixture.actualHashes.has(fixture.paths.ytDlpExecutable)).toBe(true);
    expect(fixture.actualHashes.has(fixture.paths.pluginArchive)).toBe(true);
    expect(fixture.capabilityCommands.filter(({command}) =>
      command === fixture.systemDenoExecutable
    )).toEqual([
      expect.objectContaining({args: ['--version']}),
    ]);
    const providerChecks = fixture.capabilityCommands.filter(({command}) =>
      command === fixture.paths.denoWrapperExecutable
    );
    expect(providerChecks).toHaveLength(1);
    expect(providerChecks[0]?.args[0]).toBe('run');
    expect(fixture.providerIntegrityChecks).toEqual([{
      providerDirectory: fixture.paths.providerDirectory,
      identity: DOWNLOADER_TOOLCHAIN_MANIFEST.potProvider.integrity,
      currentUid: typeof process.getuid === 'function' ? process.getuid() : -1,
    }]);
    expect(run.stdout()).not.toContain('Doctor fixture');
    expect(run.stdout()).not.toContain('https://');
    expect(run.stdout()).not.toContain(fixture.homeDirectory);
  });

  it.each(['source', 'node_modules'] as const)(
    'does not report verified integrity when the %s verifier fails',
    async (tree) => {
      const fixture = await createManagedFixture();
      fixture.providerIntegrityFailures.add(tree);
      const run = commandDependencies(fixture);

      const exitCode = await runVideoctl(
        ['doctor-downloader', '--json'],
        run.dependencies,
      );

      expect(exitCode).toBe(EXIT_CODES.environmentFailed);
      expect(JSON.parse(run.stdout())).toEqual({
        command: 'doctor-downloader',
        ok: false,
        code: 'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
        message: 'The YouTube compatibility provider is unavailable.',
      });
      expect(run.stdout()).not.toContain('"integrity": "verified"');
      expect(run.stdout()).not.toContain(`private ${tree}`);
      expect(run.stderr()).toBe('');
      expect(fixture.providerIntegrityChecks).toHaveLength(1);
      expect(fixture.capabilityCommands).toEqual([]);
    },
  );

  it('runs exactly one metadata probe with the same managed toolchain', async () => {
    const fixture = await createManagedFixture();
    vi.stubEnv('HTTP_PROXY', 'http://ambient-proxy.invalid:8080');
    vi.stubEnv('https_proxy', 'https://ambient-proxy.invalid:8443');
    const run = commandDependencies(fixture);
    const expected = {
      ...REPORT,
      check: {platform: 'youtube', result: 'available'},
    } as const;

    const exitCode = await runVideoctl([
      'doctor-downloader',
      '--check-url',
      CHECK_URL,
      '--rights-confirmed',
      '--json',
    ], run.dependencies);

    expect(exitCode).toBe(0);
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
    expect(await readPhases(fixture.recordPath)).toEqual(['probe']);
    expect(fixture.probeArgs).toHaveLength(1);
    expect(fixture.probeArgs[0]).toContain('--dump-single-json');
    expect(fixture.probeArgs[0]).not.toContain('--cookies-from-browser');
    expect(fixture.probeEnvironments).toHaveLength(1);
    const environment = fixture.probeEnvironments[0] ?? {};
    const environmentKeys = Object.keys(environment).map((key) => key.toLowerCase());
    expect(environmentKeys).not.toContain('http_proxy');
    expect(environmentKeys).not.toContain('https_proxy');
    expect(environmentKeys).not.toContain('all_proxy');
    expect(environmentKeys).not.toContain('no_proxy');
    expect(environment.FAKE_YT_DLP_RECORD).toBeUndefined();
    expect(run.stdout()).not.toContain(CHECK_URL);
    expect(run.stdout()).not.toContain('Doctor fixture');
    expect(run.stdout()).not.toContain(fixture.homeDirectory);
    expect(run.stdout()).not.toContain('video.webm');
  });
});
