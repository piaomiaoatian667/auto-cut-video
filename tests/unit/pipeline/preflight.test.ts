import {createHash} from 'node:crypto';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
} from '../../helpers/temp-project';
import type {ProjectInputs} from '../../../src/domain/load-project';
import {
  ProjectPathError,
  type ProjectDirectoryScope,
} from '../../../src/fs/project-paths';
import {
  runPreflight,
  type PreflightDependencies,
  type PreflightFileStatus,
  type PreflightInput,
  type PreflightProcessResult,
} from '../../../src/pipeline/stages/preflight';
import {
  createSystemSourceMeterDependencies,
  createSystemVideoctlDependencies,
  measureProjectSourceBytes,
  type SourceMeterDependencies,
} from '../../../src/cli/videoctl';

const GIB = 1024 ** 3;
const FFMPEG_SELECTION = '/configured/ffmpeg';
const FFMPEG_LINK = '/opt/homebrew/bin/ffmpeg';
const FFMPEG_REAL = '/opt/homebrew/Cellar/ffmpeg/8.0/bin/ffmpeg';
const QT_FASTSTART_SIBLING = path.join(path.dirname(FFMPEG_REAL), 'qt-faststart');
const QT_FASTSTART_REAL = '/opt/homebrew/Cellar/ffmpeg/8.0/bin/qt-faststart';
const FFPROBE_LINK = '/opt/homebrew/bin/ffprobe';
const FFPROBE_REAL = '/opt/homebrew/Cellar/ffmpeg/8.0/bin/ffprobe';
const WORK_DIRECTORY = '/workspace/.work/demo';

const processResult = (stdout: string): PreflightProcessResult => ({
  command: '',
  args: [],
  exitCode: 0,
  signal: null,
  stdout,
  stderr: '',
  durationMs: 1,
});

const defaultProbeOutput = (
  command: string,
  args: readonly string[],
): string => {
  const key = `${command}\0${args.join('\0')}`;
  const outputs = new Map<string, string>([
    ['node\0--version', 'v22.17.0\n'],
    ['pnpm\0--version', '10.14.0\n'],
    ['/usr/bin/sw_vers\0-productVersion', '15.6\n'],
    [`${FFMPEG_REAL}\0-version`, 'ffmpeg version 8.0 Copyright\n'],
    [`${FFMPEG_REAL}\0-hide_banner\0-encoders`, [
      ' V....D libx264 H.264 / AVC / MPEG-4 AVC',
      ' A....D aac AAC (Advanced Audio Coding)',
    ].join('\n')],
    [`${FFMPEG_REAL}\0-hide_banner\0-filters`, [
      ' ... loudnorm A->A EBU R128 loudness normalization',
      ' ... silencedetect A->A Detect silence',
      ' ... blackdetect V->V Detect black intervals',
    ].join('\n')],
    [`${FFPROBE_REAL}\0-version`, 'ffprobe version 8.0 Copyright\n'],
    ['/usr/bin/say\0-v\0?', [
      'Tingting             zh_CN    # 你好！我是婷婷。',
      'Meijia               zh_TW    # 您好，我叫美佳。',
    ].join('\n')],
  ]);
  const output = outputs.get(key);
  if (output === undefined) throw new Error(`unexpected probe: ${key}`);
  return output;
};

interface FixtureOverrides {
  platform?: NodeJS.Platform;
  arch?: string;
  macosVersion?: string;
  encoders?: string;
  filters?: string;
  voices?: string;
  ffmpegBytes?: string;
  qtFaststartBytes?: string;
  fontBytes?: string;
  fontError?: Error;
  qtFaststartStatus?: PreflightFileStatus | Error;
  availableBytes?: number;
  sourceBytes?: number;
  workDirectoryUsable?: boolean;
  configuredVoice?: string;
  segmentedWav?: boolean;
  processFailure?: {command: string; args: readonly string[]};
}

const executableFile = (): PreflightFileStatus => ({
  kind: 'file',
  mode: 0o100755,
});

const fixture = (overrides: FixtureOverrides = {}) => {
  const project = createProjectFixture();
  project.tts.voice = overrides.configuredVoice ?? 'Tingting';
  const script = createScriptFixture();
  if (overrides.segmentedWav) {
    script.segments[0]!.audioPath = 'assets/source/voice/intro.wav';
  }

  const runProcess = vi.fn(async (
    command: string,
    args: readonly string[],
  ): Promise<PreflightProcessResult> => {
    if (
      overrides.processFailure?.command === command
      && overrides.processFailure.args.join('\0') === args.join('\0')
    ) {
      throw new Error('sensitive process failure detail');
    }

    let stdout = defaultProbeOutput(command, args);
    if (command === '/usr/bin/sw_vers') {
      stdout = `${overrides.macosVersion ?? '15.6'}\n`;
    } else if (command === FFMPEG_REAL && args[1] === '-encoders') {
      stdout = overrides.encoders ?? stdout;
    } else if (command === FFMPEG_REAL && args[1] === '-filters') {
      stdout = overrides.filters ?? stdout;
    } else if (command === '/usr/bin/say') {
      stdout = overrides.voices ?? stdout;
    }
    return {...processResult(stdout), command, args: [...args]};
  });

  const resolveExecutable = vi.fn(async (selection: string): Promise<string> => {
    if (selection === FFMPEG_SELECTION || selection === 'ffmpeg') return FFMPEG_LINK;
    if (selection === 'ffprobe') return FFPROBE_LINK;
    throw new Error(`unexpected executable selection: ${selection}`);
  });

  const realpath = vi.fn(async (candidate: string): Promise<string> => {
    if (candidate === FFMPEG_LINK) return FFMPEG_REAL;
    if (candidate === FFPROBE_LINK) return FFPROBE_REAL;
    if (candidate === QT_FASTSTART_SIBLING) return QT_FASTSTART_REAL;
    return candidate;
  });

  const stat = vi.fn(async (candidate: string): Promise<PreflightFileStatus> => {
    if (candidate === QT_FASTSTART_SIBLING) {
      const status = overrides.qtFaststartStatus ?? executableFile();
      if (status instanceof Error) throw status;
      return status;
    }
    if ([FFMPEG_REAL, FFPROBE_REAL].includes(candidate)) return executableFile();
    throw new Error(`unexpected stat: ${candidate}`);
  });

  const readFile = vi.fn(async (candidate: string): Promise<Uint8Array> => {
    if (candidate === FFMPEG_REAL) {
      return Buffer.from(overrides.ffmpegBytes ?? 'ffmpeg-binary');
    }
    if (candidate === QT_FASTSTART_REAL) {
      return Buffer.from(overrides.qtFaststartBytes ?? 'qt-faststart-binary');
    }
    throw new Error(`unexpected readFile: ${candidate}`);
  });

  const readProjectFile = vi.fn(async (
    _scope: ProjectDirectoryScope,
    relativePath: string,
  ): Promise<{data: Uint8Array; kind: PreflightFileStatus['kind']}> => {
    if (overrides.fontError !== undefined) throw overrides.fontError;
    expect(relativePath).toBe(project.captions.font);
    return {
      data: Buffer.from(overrides.fontBytes ?? 'font-binary'),
      kind: 'file',
    };
  });

  const inspectDirectory = vi.fn(async (candidate: string) => (
    overrides.workDirectoryUsable === false
      ? {usable: false, reason: 'not writable', inspectedPath: candidate}
      : {usable: true, inspectedPath: candidate}
  ));

  const statfsAvailableBytes = vi.fn(async () => overrides.availableBytes ?? 20 * GIB);

  const dependencies: PreflightDependencies = {
    runtime: {
      platform: overrides.platform ?? 'darwin',
      arch: overrides.arch ?? 'arm64',
    },
    runProcess,
    resolveExecutable,
    fileSystem: {
      realpath,
      stat,
      readFile,
      readProjectFile,
      inspectDirectory,
      statfsAvailableBytes,
    },
  };

  const input: PreflightInput = {
    workspaceRoot: '/workspace',
    projectDirectory: {} as ProjectDirectoryScope,
    project,
    script,
    sourceBytes: overrides.sourceBytes ?? GIB,
    workDirectory: WORK_DIRECTORY,
    ffmpegExecutable: FFMPEG_SELECTION,
  };

  return {
    dependencies,
    input,
    runProcess,
    resolveExecutable,
    realpath,
    stat,
    readFile,
    readProjectFile,
    inspectDirectory,
    statfsAvailableBytes,
  };
};

const errorCheck = (result: Awaited<ReturnType<typeof runPreflight>>, id: string) =>
  result.checks.find((check) => check.id === id && check.severity === 'error');

const sha256 = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

interface SourceNodeBase {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
}

interface SourceDirectoryNode extends SourceNodeBase {
  kind: 'directory';
  entries: Record<string, SourceNode>;
}

interface SourceFileNode extends SourceNodeBase {
  kind: 'file';
  size: bigint;
}

interface SourceSymlinkNode extends SourceNodeBase {
  kind: 'symlink';
}

interface SourceSpecialNode extends SourceNodeBase {
  kind: 'fifo' | 'socket' | 'device' | 'unknown';
}

type SourceNode =
  | SourceDirectoryNode
  | SourceFileNode
  | SourceSymlinkNode
  | SourceSpecialNode;

const sourceDirectory = (
  ino: bigint,
  entries: Record<string, SourceNode>,
): SourceDirectoryNode => ({kind: 'directory', dev: 1n, ino, nlink: 2n, entries});

const sourceFile = (ino: bigint, size: bigint): SourceFileNode => ({
  kind: 'file',
  dev: 1n,
  ino,
  nlink: 1n,
  size,
});

const sourceSymlink = (ino: bigint): SourceSymlinkNode => ({
  kind: 'symlink',
  dev: 1n,
  ino,
  nlink: 1n,
});

const sourceSpecial = (
  kind: SourceSpecialNode['kind'],
  ino: bigint,
): SourceSpecialNode => ({kind, dev: 1n, ino, nlink: 1n});

interface SourceMeterFixtureOptions {
  substituteSourceBeforeOpenPath?: string;
  replaceAfterFirstOpen?: {
    relativePath: string;
    replacement: SourceNode;
  };
  statAsNonRegularPath?: string;
  failStatPath?: string;
  failDirectoryPath?: string;
  failClosePath?: string;
}

const sourceMeterFixture = (
  sourceNode: SourceNode | undefined,
  options: SourceMeterFixtureOptions = {},
) => {
  const root = sourceDirectory(1n, {
    assets: sourceDirectory(2n, sourceNode === undefined ? {} : {source: sourceNode}),
  });
  const nodes = new Map<string, SourceNode>();
  const indexNode = (relativePath: string, node: SourceNode): void => {
    nodes.set(relativePath, node);
    if (node.kind !== 'directory') return;
    for (const [name, child] of Object.entries(node.entries)) {
      indexNode(
        relativePath === '.' ? name : path.posix.join(relativePath, name),
        child,
      );
    }
  };
  indexNode('.', root);
  const replaceNode = (relativePath: string, replacement: SourceNode): void => {
    const parentPath = path.posix.dirname(relativePath);
    const parent = nodes.get(parentPath);
    if (parent?.kind !== 'directory') throw new Error('invalid replacement parent');
    parent.entries[path.posix.basename(relativePath)] = replacement;
    nodes.set(relativePath, replacement);
  };

  let nextFd = 20;
  const fdPaths = new Map<number, string>();
  const fdNodes = new Map<number, SourceNode>();
  const fdOffsets = new Map<number, number>();
  const fileCloses: Array<ReturnType<typeof vi.fn>> = [];
  const directoryCloses: Array<ReturnType<typeof vi.fn>> = [];
  const statPaths: string[] = [];
  const openCounts = new Map<string, number>();

  const openExistingProjectFile = vi.fn(async (
    _scope: ProjectDirectoryScope,
    relativePath: string,
  ) => {
    if (relativePath === options.substituteSourceBeforeOpenPath) {
      replaceNode('assets/source', sourceSymlink(10_000n));
      throw new ProjectPathError(
        `project directory changed after scope creation: ${relativePath}`,
      );
    }
    const node = nodes.get(relativePath);
    if (node === undefined || node.kind === 'symlink') {
      throw new Error('scoped path is unavailable');
    }
    if (
      node.kind === 'fifo'
      || node.kind === 'socket'
      || node.kind === 'device'
      || node.kind === 'unknown'
    ) {
      return await new Promise<never>(() => {});
    }
    const openCount = openCounts.get(relativePath) ?? 0;
    openCounts.set(relativePath, openCount + 1);
    const fd = nextFd;
    nextFd += 1;
    fdPaths.set(fd, relativePath);
    fdNodes.set(fd, node);
    fdOffsets.set(fd, 0);
    const close = vi.fn(async () => {
      if (relativePath === options.failClosePath) {
        throw new Error('close failed');
      }
    });
    fileCloses.push(close);
    const handle = {
      fd,
      stat: vi.fn(async () => {
        if (relativePath === options.failStatPath) {
          throw new Error('stat failed');
        }
        statPaths.push(relativePath);
        return {
          dev: node.dev,
          ino: node.ino,
          nlink: node.nlink,
          size: node.kind === 'file' ? node.size : 0n,
          isFile: () => (
            relativePath !== options.statAsNonRegularPath
            && node.kind === 'file'
          ),
          isDirectory: () => (
            relativePath !== options.statAsNonRegularPath
            && node.kind === 'directory'
          ),
        };
      }),
      close,
    };
    if (
      openCount === 0
      && options.replaceAfterFirstOpen?.relativePath === relativePath
    ) {
      replaceNode(relativePath, options.replaceAfterFirstOpen.replacement);
    }
    return handle;
  });

  const openDirectory = vi.fn(async (fdPath: string) => {
    const match = /^\/dev\/fd\/(\d+)$/u.exec(fdPath);
    const fd = match === null ? undefined : Number.parseInt(match[1]!, 10);
    const relativePath = fd === undefined ? undefined : fdPaths.get(fd);
    if (relativePath === options.failDirectoryPath) {
      throw new Error('directory enumeration failed');
    }
    const node = fd === undefined ? undefined : fdNodes.get(fd);
    if (node?.kind !== 'directory') throw new Error('invalid directory fd');
    const entries = Object.keys(node.entries).sort().map((name) => ({
      name,
      isFile: () => node.entries[name]!.kind === 'file',
      isDirectory: () => node.entries[name]!.kind === 'directory',
      isSymbolicLink: () => node.entries[name]!.kind === 'symlink',
    }));
    const close = vi.fn(async () => {});
    directoryCloses.push(close);
    return {
      read: vi.fn(async () => {
        if (fd === undefined) throw new Error('invalid directory fd');
        const index = fdOffsets.get(fd) ?? 0;
        fdOffsets.set(fd, index + 1);
        return entries[index] ?? null;
      }),
      close,
    };
  });

  const dependencies: SourceMeterDependencies = {
    openExistingProjectFile,
    openDirectory,
  };
  return {
    dependencies,
    scope: {} as ProjectDirectoryScope,
    openExistingProjectFile,
    statPaths,
    expectAllClosed: () => {
      for (const close of fileCloses) expect(close).toHaveBeenCalledOnce();
      for (const close of directoryCloses) expect(close).toHaveBeenCalledOnce();
    },
  };
};

describe('scoped source measurement', () => {
  it('feeds a measured 1 GiB tree into the 3 GiB Preflight estimate', async () => {
    const meter = sourceMeterFixture(sourceDirectory(3n, {
      video: sourceFile(4n, BigInt(GIB - 512)),
      nested: sourceDirectory(5n, {audio: sourceFile(6n, 512n)}),
    }));
    const projectInputs: ProjectInputs = {
      workspaceRoot: '/workspace',
      projectDirectory: meter.scope,
      project: createProjectFixture(),
      script: createScriptFixture(),
      edit: createEditFixture(),
    };
    const system = createSystemVideoctlDependencies({
      sourceMeter: meter.dependencies,
    });

    const measuredBytes = await system.measureSourceBytes(projectInputs);
    const preflight = fixture({sourceBytes: measuredBytes});
    const result = await runPreflight(preflight.input, preflight.dependencies);

    expect(measuredBytes).toBe(GIB);
    expect(result.system).toMatchObject({
      sourceBytes: GIB,
      requiredBytes: 3 * GIB,
    });
    expect(meter.openExistingProjectFile.mock.calls.every(([, relativePath]) => (
      !path.isAbsolute(relativePath)
    ))).toBe(true);
    meter.expectAllClosed();
  });

  it('rejects an assets/source symlink without opening its target', async () => {
    const meter = sourceMeterFixture(sourceSymlink(3n));

    await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

    expect(meter.openExistingProjectFile).not.toHaveBeenCalledWith(
      meter.scope,
      'assets/source',
    );
    meter.expectAllClosed();
  });

  it('rejects symlink entries and closes every opened FD and directory', async () => {
    const meter = sourceMeterFixture(sourceDirectory(3n, {
      safe: sourceFile(4n, 100n),
      escape: sourceSymlink(5n),
    }));

    await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

    expect(meter.openExistingProjectFile).not.toHaveBeenCalledWith(
      meter.scope,
      'assets/source/escape',
    );
    meter.expectAllClosed();
  });

  it.each(['fifo', 'socket', 'device', 'unknown'] as const)(
    'rejects a %s entry before any potentially blocking open',
    async (kind) => {
      const meter = sourceMeterFixture(sourceDirectory(3n, {
        blocked: sourceSpecial(kind, 4n),
      }));
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('source measurement timed out')), 100);
      });

      await expect(Promise.race([
        measureProjectSourceBytes(meter.scope, meter.dependencies),
        timeout,
      ])).rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

      expect(meter.openExistingProjectFile).not.toHaveBeenCalledWith(
        meter.scope,
        'assets/source/blocked',
      );
      meter.expectAllClosed();
    },
  );

  it('rejects when a file Dirent fresh-opens as a non-regular type', async () => {
    const meter = sourceMeterFixture(
      sourceDirectory(3n, {changed: sourceFile(4n, 100n)}),
      {statAsNonRegularPath: 'assets/source/changed'},
    );

    await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

    meter.expectAllClosed();
  });

  it('requests bigint stats from the real system source-meter adapter', async () => {
    const stat = vi.fn(async (options: {bigint: true}) => {
      expect(options).toEqual({bigint: true});
      return {
        dev: 1n,
        ino: 2n,
        nlink: 1n,
        size: 3n,
        isFile: () => true,
        isDirectory: () => false,
      };
    });
    const close = vi.fn(async () => {});
    const adapter = createSystemSourceMeterDependencies({
      openExistingProjectFile: vi.fn(async () => ({fd: 42, stat, close})),
      openDirectory: vi.fn(async () => { throw new Error('not used'); }),
    });

    const handle = await adapter.openExistingProjectFile(
      {} as ProjectDirectoryScope,
      'assets/source/video.mp4',
    );
    const status = await handle.stat();
    await handle.close();

    expect(status).toMatchObject({dev: 1n, ino: 2n, nlink: 1n, size: 3n});
    expect(stat).toHaveBeenCalledWith({bigint: true});
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects replacement between adjacent inode values above 2^53', async () => {
    const inode = 2n ** 53n;
    const meter = sourceMeterFixture(
      sourceDirectory(3n, {video: sourceFile(inode, 100n)}),
      {
        replaceAfterFirstOpen: {
          relativePath: 'assets/source/video',
          replacement: sourceFile(inode + 1n, 100n),
        },
      },
    );

    await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

    meter.expectAllClosed();
  });

  it('rejects totals that cannot be converted to safe source bytes', async () => {
    const meter = sourceMeterFixture(sourceDirectory(3n, {
      video: sourceFile(4n, BigInt(Number.MAX_SAFE_INTEGER) + 1n),
    }));

    await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

    meter.expectAllClosed();
  });

  it('fails closed when assets/source is replaced by an external symlink', async () => {
    const meter = sourceMeterFixture(
      sourceDirectory(3n, {outside: sourceFile(4n, BigInt(9 * GIB))}),
      {substituteSourceBeforeOpenPath: 'assets/source/outside'},
    );

    await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

    expect(meter.statPaths).not.toContain('assets/source/outside');
    meter.expectAllClosed();
  });

  it('maps missing source and enumeration/stat I/O failures to source errors', async () => {
    const missing = sourceMeterFixture(undefined);
    const enumeration = sourceMeterFixture(
      sourceDirectory(3n, {}),
      {failDirectoryPath: 'assets/source'},
    );
    const statFailure = sourceMeterFixture(
      sourceDirectory(3n, {video: sourceFile(4n, 100n)}),
      {failStatPath: 'assets/source/video'},
    );

    for (const meter of [missing, enumeration, statFailure]) {
      await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
        .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});
      meter.expectAllClosed();
    }
  });

  it('maps FD close failures to a structured source error', async () => {
    const meter = sourceMeterFixture(
      sourceDirectory(3n, {}),
      {failClosePath: '.'},
    );

    await expect(measureProjectSourceBytes(meter.scope, meter.dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});
  });
});

describe('runPreflight', () => {
  it.each([
    {platform: 'linux' as const, arch: 'arm64'},
    {platform: 'darwin' as const, arch: 'x64'},
  ])('rejects unsupported runtime $platform/$arch', async ({platform, arch}) => {
    const {input, dependencies} = fixture({platform, arch});

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'supported-platform')).toMatchObject({
      code: 'ENV_PLATFORM_UNSUPPORTED',
    });
  });

  it('rejects macOS versions before 15', async () => {
    const {input, dependencies} = fixture({macosVersion: '14.7.6'});

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'macos-version')).toMatchObject({
      code: 'ENV_PLATFORM_UNSUPPORTED',
      value: '14.7.6',
      expected: '>=15',
    });
  });

  it.each([
    {
      id: 'ffmpeg-encoder-h264',
      encoders: ' A....D aac AAC (Advanced Audio Coding)',
    },
    {
      id: 'ffmpeg-encoder-aac',
      encoders: ' V....D h264_videotoolbox VideoToolbox H.264 Encoder',
    },
  ])('reports a missing encoder for $id', async ({id, encoders}) => {
    const {input, dependencies} = fixture({encoders});

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, id)).toMatchObject({code: 'ENV_CAPABILITY_MISSING'});
  });

  it('accepts alternate H.264 and AAC encoder implementations', async () => {
    const {input, dependencies} = fixture({
      encoders: [
        ' V....D libopenh264 OpenH264 H.264 encoder',
        ' A....D aac_at AudioToolbox AAC encoder',
      ].join('\n'),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'ffmpeg-encoder-h264')).toBeUndefined();
    expect(errorCheck(result, 'ffmpeg-encoder-aac')).toBeUndefined();
  });

  it.each(['loudnorm', 'silencedetect', 'blackdetect'] as const)(
    'reports a missing %s filter',
    async (missingFilter) => {
      const filters = ['loudnorm', 'silencedetect', 'blackdetect']
        .filter((filter) => filter !== missingFilter)
        .map((filter) => ` ... ${filter} input->output`)
        .join('\n');
      const {input, dependencies} = fixture({filters});

      const result = await runPreflight(input, dependencies);

      expect(errorCheck(result, `ffmpeg-filter-${missingFilter}`)).toMatchObject({
        code: 'ENV_CAPABILITY_MISSING',
      });
    },
  );

  it('resolves FFmpeg once, canonicalizes it, and reuses its real path', async () => {
    const {input, dependencies, resolveExecutable, realpath, runProcess} = fixture();

    const result = await runPreflight(input, dependencies);

    expect(resolveExecutable.mock.calls.filter(([selection]) => (
      selection === FFMPEG_SELECTION
    ))).toHaveLength(1);
    expect(realpath.mock.calls.filter(([candidate]) => (
      candidate === FFMPEG_LINK
    ))).toHaveLength(1);
    expect(runProcess.mock.calls.filter(([command]) => command === FFMPEG_REAL))
      .toEqual([
        [FFMPEG_REAL, ['-version']],
        [FFMPEG_REAL, ['-hide_banner', '-encoders']],
        [FFMPEG_REAL, ['-hide_banner', '-filters']],
      ]);
    expect(runProcess.mock.calls.some(([command]) => command === 'ffmpeg')).toBe(false);
    expect(result.toolIdentities.ffmpeg?.realPath).toBe(FFMPEG_REAL);
    expect(result.versions.ffmpeg).toBe('8.0');
  });

  it('resolves ffprobe before probing instead of treating PATH text as identity', async () => {
    const {input, dependencies, resolveExecutable, realpath, runProcess} = fixture();

    const result = await runPreflight(input, dependencies);

    expect(resolveExecutable).toHaveBeenCalledWith('ffprobe');
    expect(realpath).toHaveBeenCalledWith(FFPROBE_LINK);
    expect(runProcess).toHaveBeenCalledWith(FFPROBE_REAL, ['-version']);
    expect(result.versions.ffprobe).toBe('8.0');
  });

  it('derives qt-faststart only from the canonical FFmpeg directory', async () => {
    const {input, dependencies, stat, realpath} = fixture();

    const result = await runPreflight(input, dependencies);

    expect(stat).toHaveBeenCalledWith(QT_FASTSTART_SIBLING);
    expect(realpath).toHaveBeenCalledWith(QT_FASTSTART_SIBLING);
    expect(result.toolIdentities.qtFaststart?.realPath).toBe(QT_FASTSTART_REAL);
  });

  it.each([
    ['missing', Object.assign(new Error('missing'), {code: 'ENOENT'})],
    ['non-regular', {kind: 'directory', mode: 0o40755} satisfies PreflightFileStatus],
    ['non-executable', {kind: 'file', mode: 0o100644} satisfies PreflightFileStatus],
  ])('maps a %s qt-faststart sibling to ENV_TOOL_MISSING', async (_, status) => {
    const {input, dependencies} = fixture({qtFaststartStatus: status});

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'qt-faststart')).toMatchObject({
      code: 'ENV_TOOL_MISSING',
      affectedPaths: [QT_FASTSTART_SIBLING],
    });
    expect(result.toolIdentities.qtFaststart).toBeNull();
  });

  it('exposes both binary hashes and changes the fingerprint with either hash', async () => {
    const baselineFixture = fixture();
    const ffmpegChangedFixture = fixture({ffmpegBytes: 'changed-ffmpeg'});
    const faststartChangedFixture = fixture({qtFaststartBytes: 'changed-faststart'});

    const baseline = await runPreflight(
      baselineFixture.input,
      baselineFixture.dependencies,
    );
    const ffmpegChanged = await runPreflight(
      ffmpegChangedFixture.input,
      ffmpegChangedFixture.dependencies,
    );
    const faststartChanged = await runPreflight(
      faststartChangedFixture.input,
      faststartChangedFixture.dependencies,
    );

    expect(baseline.toolIdentities).toEqual({
      ffmpeg: {realPath: FFMPEG_REAL, sha256: sha256('ffmpeg-binary')},
      qtFaststart: {
        realPath: QT_FASTSTART_REAL,
        sha256: sha256('qt-faststart-binary'),
      },
    });
    expect(ffmpegChanged.environmentFingerprint)
      .not.toBe(baseline.environmentFingerprint);
    expect(faststartChanged.environmentFingerprint)
      .not.toBe(baseline.environmentFingerprint);
  });

  it('hashes every configured font', async () => {
    const {input, dependencies, readProjectFile} = fixture({fontBytes: 'font-v2'});

    const result = await runPreflight(input, dependencies);

    expect(readProjectFile).toHaveBeenCalledOnce();
    expect(result.fonts).toEqual([{
      path: input.project.captions.font,
      sha256: sha256('font-v2'),
    }]);
    expect(errorCheck(result, `font:${input.project.captions.font}`)).toBeUndefined();
  });

  it('reports a configured font that cannot be read', async () => {
    const {input, dependencies} = fixture({
      fontError: Object.assign(new Error('font missing'), {code: 'ENOENT'}),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, `font:${input.project.captions.font}`)).toMatchObject({
      code: 'ENV_FONT_MISSING',
      affectedPaths: [input.project.captions.font],
    });
  });

  it('accepts an installed configured macOS voice', async () => {
    const {input, dependencies} = fixture({configuredVoice: 'Tingting'});

    const result = await runPreflight(input, dependencies);

    expect(result.voice).toEqual({
      configured: 'Tingting',
      available: true,
      segmentedWavFallback: false,
    });
    expect(errorCheck(result, 'macos-voice')).toBeUndefined();
  });

  it('rejects a missing voice without segmented WAV input', async () => {
    const {input, dependencies} = fixture({configuredVoice: 'Missing Voice'});

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'macos-voice')).toMatchObject({
      code: 'ENV_VOICE_MISSING',
    });
  });

  it('allows a missing voice when every segment supplies WAV input', async () => {
    const {input, dependencies} = fixture({
      configuredVoice: 'Missing Voice',
      segmentedWav: true,
    });

    const result = await runPreflight(input, dependencies);

    expect(result.voice).toEqual({
      configured: 'Missing Voice',
      available: false,
      segmentedWavFallback: true,
    });
    expect(errorCheck(result, 'macos-voice')).toBeUndefined();
  });

  it.each([
    {sourceBytes: 100, expectedRequiredBytes: 2 * GIB},
    {sourceBytes: GIB, expectedRequiredBytes: 3 * GIB},
  ])(
    'estimates disk as max(sourceBytes * 3, 2 GiB)',
    async ({sourceBytes, expectedRequiredBytes}) => {
      const {input, dependencies, statfsAvailableBytes} = fixture({sourceBytes});

      const result = await runPreflight(input, dependencies);

      expect(statfsAvailableBytes).toHaveBeenCalledWith(WORK_DIRECTORY);
      expect(result.system).toMatchObject({
        sourceBytes,
        requiredBytes: expectedRequiredBytes,
      });
    },
  );

  it('reports insufficient disk before a caller may create a run', async () => {
    const createRun = vi.fn();
    const {input, dependencies} = fixture({
      sourceBytes: GIB,
      availableBytes: 3 * GIB - 1,
    });

    const result = await runPreflight(input, dependencies);
    if (!result.checks.some((check) => check.severity === 'error')) createRun();

    expect(errorCheck(result, 'disk-space')).toMatchObject({
      code: 'DISK_SPACE_EXHAUSTED',
      value: 3 * GIB - 1,
      expected: 3 * GIB,
    });
    expect(createRun).not.toHaveBeenCalled();
  });

  it('checks work directory usability without writing to it', async () => {
    const {input, dependencies, inspectDirectory} = fixture({
      workDirectoryUsable: false,
    });

    const result = await runPreflight(input, dependencies);

    expect(inspectDirectory).toHaveBeenCalledWith(WORK_DIRECTORY);
    expect(errorCheck(result, 'work-directory')).toMatchObject({
      code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
      affectedPaths: [WORK_DIRECTORY],
    });
  });

  it('runs the complete required probe list with injected processes', async () => {
    const {input, dependencies, runProcess} = fixture();

    await runPreflight(input, dependencies);

    expect(runProcess.mock.calls).toEqual([
      ['node', ['--version']],
      ['pnpm', ['--version']],
      ['/usr/bin/sw_vers', ['-productVersion']],
      [FFMPEG_REAL, ['-version']],
      [FFPROBE_REAL, ['-version']],
      [FFMPEG_REAL, ['-hide_banner', '-encoders']],
      [FFMPEG_REAL, ['-hide_banner', '-filters']],
      ['/usr/bin/say', ['-v', '?']],
    ]);
  });

  it('maps probe exceptions to deterministic structured errors', async () => {
    const {input, dependencies} = fixture({
      processFailure: {command: 'pnpm', args: ['--version']},
    });

    const result = await runPreflight(input, dependencies);
    const check = errorCheck(result, 'pnpm');

    expect(check).toMatchObject({code: 'ENV_TOOL_MISSING'});
    expect(JSON.stringify(result)).not.toContain('sensitive process failure detail');
  });
});
