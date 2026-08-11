import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {
  access as accessPath,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  statfs as statfsPath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
} from '../../helpers/temp-project';
import {
  ProjectPathError,
  type ProjectDirectoryScope,
} from '../../../src/fs/project-paths';
import {
  MAX_FONT_BYTES,
  createSystemPreflightFileSystem,
  runPreflight,
  type PreflightDependencies,
  type PreflightExecutableAuthority,
  type PreflightFileIdentity,
  type PreflightInput,
  type PreflightProcessResult,
} from '../../../src/pipeline/stages/preflight';
import {
  createSystemSourceMeterDependencies,
  measureProjectSourceBytes,
  type SourceMeterDependencies,
  type SourceMeterStat,
} from '../../../src/pipeline/source-assets';
import {createRunStore} from '../../../src/pipeline/run-store';

const GIB = 1024 ** 3;
const FFMPEG_SELECTION = '/configured/ffmpeg';
const FFMPEG_LINK = '/opt/homebrew/bin/ffmpeg';
const FFMPEG_REAL = '/opt/homebrew/Cellar/ffmpeg/8.0/bin/ffmpeg';
const FFMPEG_AUTHORITY = '/.vol/1/101';
const QT_FASTSTART_SIBLING = path.join(path.dirname(FFMPEG_REAL), 'qt-faststart');
const QT_FASTSTART_REAL = '/opt/homebrew/Cellar/ffmpeg/8.0/bin/qt-faststart';
const FFPROBE_LINK = '/opt/homebrew/bin/ffprobe';
const FFPROBE_REAL = '/opt/homebrew/Cellar/ffmpeg/8.0/bin/ffprobe';
const FFPROBE_AUTHORITY = '/.vol/1/103';
const WORK_DIRECTORY = '/workspace/.work/demo';
const workInspectionTempDirectories: string[] = [];

const makeWorkInspectionDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  workInspectionTempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  const directories = workInspectionTempDirectories.splice(0);
  await Promise.all(directories.map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const encoderTable = (rows: readonly string[]): string => [
  'Encoders:',
  ' V..... = Video',
  ' A..... = Audio',
  ' ------',
  ...rows,
].join('\n');

const filterTable = (rows: readonly string[]): string => [
  'Filters:',
  '  T.. = Timeline support',
  '  .S. = Slice threading',
  '  ..C = Command support',
  '  ---',
  ...rows,
].join('\n');

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
    [`${FFMPEG_AUTHORITY}\0-version`, 'ffmpeg version 8.0 Copyright\n'],
    [`${FFMPEG_AUTHORITY}\0-hide_banner\0-encoders`, encoderTable([
      ' V....D libx264 libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
      ' A....D aac AAC (Advanced Audio Coding) (codec aac)',
    ])],
    [`${FFMPEG_AUTHORITY}\0-hide_banner\0-filters`, filterTable([
      ' ... loudnorm A->A EBU R128 loudness normalization',
      ' ... silencedetect A->A Detect silence',
      ' ... blackdetect V->V Detect black intervals',
    ])],
    [`${FFPROBE_AUTHORITY}\0-version`, 'ffprobe version 8.0 Copyright\n'],
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
  qtFaststartKind?: PreflightFileIdentity['kind'];
  qtFaststartAccessDenied?: boolean;
  ffmpegAccessDenied?: boolean;
  ffprobeAccessDenied?: boolean;
  replaceFfmpegDuringProbe?: boolean;
  replaceQtFaststartBeforeUse?: boolean;
  availableBytes?: number;
  sourceBytes?: number;
  workDirectoryUsable?: boolean;
  configuredVoice?: string;
  segmentedWav?: boolean;
  processFailure?: {command: string; args: readonly string[]};
}

interface ToolFixtureState {
  bytes: string;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  kind: PreflightFileIdentity['kind'];
  mode: bigint;
  accessible: boolean;
}

const toolIdentity = (state: ToolFixtureState): PreflightFileIdentity => ({
  dev: state.dev,
  ino: state.ino,
  nlink: state.nlink,
  size: BigInt(Buffer.byteLength(state.bytes)),
  mode: state.mode,
  kind: state.kind,
});

const fixture = (overrides: FixtureOverrides = {}) => {
  const project = createProjectFixture();
  project.tts.voice = overrides.configuredVoice ?? 'Tingting';
  const script = createScriptFixture();
  if (overrides.segmentedWav) {
    script.segments[0]!.audioPath = 'assets/source/voice/intro.wav';
  }

  const toolStates = new Map<string, ToolFixtureState>([
    [FFMPEG_REAL, {
      bytes: overrides.ffmpegBytes ?? 'ffmpeg-binary',
      dev: 1n,
      ino: 101n,
      nlink: 1n,
      kind: 'file',
      mode: 0o100755n,
      accessible: overrides.ffmpegAccessDenied !== true,
    }],
    [QT_FASTSTART_REAL, {
      bytes: overrides.qtFaststartBytes ?? 'qt-faststart-binary',
      dev: 1n,
      ino: 102n,
      nlink: 1n,
      kind: overrides.qtFaststartKind ?? 'file',
      mode: 0o100755n,
      accessible: overrides.qtFaststartAccessDenied !== true,
    }],
    [FFPROBE_REAL, {
      bytes: 'ffprobe-binary',
      dev: 1n,
      ino: 103n,
      nlink: 1n,
      kind: 'file',
      mode: 0o100755n,
      accessible: overrides.ffprobeAccessDenied !== true,
    }],
  ]);
  let ffmpegReplaced = false;
  let qtFaststartReplaced = false;

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

    if (
      overrides.replaceFfmpegDuringProbe === true
      && !ffmpegReplaced
      && command === FFMPEG_AUTHORITY
    ) {
      ffmpegReplaced = true;
      const current = toolStates.get(FFMPEG_REAL)!;
      toolStates.set(FFMPEG_REAL, {
        ...current,
        bytes: 'replacement-ffmpeg-binary',
        ino: current.ino + 1n,
      });
    }

    let stdout = defaultProbeOutput(command, args);
    if (command === '/usr/bin/sw_vers') {
      stdout = `${overrides.macosVersion ?? '15.6'}\n`;
    } else if (command === FFMPEG_AUTHORITY && args[1] === '-encoders') {
      stdout = overrides.encoders ?? stdout;
    } else if (command === FFMPEG_AUTHORITY && args[1] === '-filters') {
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

  const heldAuthorities: PreflightExecutableAuthority[] = [];
  const openExecutable = vi.fn(async (
    candidate: string,
  ): Promise<PreflightExecutableAuthority> => {
    const state = toolStates.get(candidate);
    if (state === undefined || state.kind !== 'file' || !state.accessible) {
      throw new Error('executable unavailable');
    }
    const initial = {...state};
    const close = vi.fn(async () => {});
    const authority: PreflightExecutableAuthority = {
      executionPath: `/.vol/${initial.dev}/${initial.ino}`,
      snapshot: {
        identity: toolIdentity(initial),
        sha256: sha256(initial.bytes),
      },
      revalidate: vi.fn(async () => {
        if (
          candidate === QT_FASTSTART_REAL
          && overrides.replaceQtFaststartBeforeUse === true
          && !qtFaststartReplaced
        ) {
          qtFaststartReplaced = true;
          const current = toolStates.get(candidate)!;
          toolStates.set(candidate, {
            ...current,
            bytes: 'replacement-qt-faststart-binary',
            ino: current.ino + 1n,
          });
        }
        const current = toolStates.get(candidate);
        return current !== undefined
          && current.accessible
          && current.kind === 'file'
          && current.bytes === initial.bytes
          && current.dev === initial.dev
          && current.ino === initial.ino
          && current.nlink === initial.nlink;
      }),
      close,
    };
    heldAuthorities.push(authority);
    return authority;
  });

  const hashProjectFile = vi.fn(async (
    _scope: ProjectDirectoryScope,
    relativePath: string,
    maxBytes: number,
  ) => {
    if (overrides.fontError !== undefined) throw overrides.fontError;
    expect(relativePath).toBe(project.captions.font);
    expect(maxBytes).toBe(MAX_FONT_BYTES);
    return {
      identity: {
        kind: 'file' as const,
        mode: 0o100644n,
        dev: 1n,
        ino: 200n,
        nlink: 1n,
        size: BigInt(Buffer.byteLength(overrides.fontBytes ?? 'font-binary')),
      },
      sha256: sha256(overrides.fontBytes ?? 'font-binary'),
    };
  });

  const inspectWorkDirectory = vi.fn(async (
    workspaceRoot: string,
    projectId: string,
  ) => (
    overrides.workDirectoryUsable === false
      ? {
          usable: false,
          reason: 'not writable',
          inspectedPath: workspaceRoot,
          availableBytes: null,
        }
      : {
          usable: true,
          inspectedPath: path.join(workspaceRoot, '.work', projectId),
          availableBytes: overrides.availableBytes ?? 20 * GIB,
        }
  ));

  const dependencies: PreflightDependencies = {
    runtime: {
      platform: overrides.platform ?? 'darwin',
      arch: overrides.arch ?? 'arm64',
    },
    runProcess,
    resolveExecutable,
    fileSystem: {
      realpath,
      openExecutable,
      hashProjectFile,
      inspectWorkDirectory,
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
    openExecutable,
    hashProjectFile,
    heldAuthorities,
    toolStates,
    inspectWorkDirectory,
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
  mtimeNs: bigint;
  ctimeNs: bigint;
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
): SourceDirectoryNode => ({
  kind: 'directory',
  dev: 1n,
  ino,
  nlink: 2n,
  mtimeNs: ino * 10n,
  ctimeNs: ino * 10n + 1n,
  entries,
});

const sourceFile = (ino: bigint, size: bigint): SourceFileNode => ({
  kind: 'file',
  dev: 1n,
  ino,
  nlink: 1n,
  mtimeNs: ino * 10n,
  ctimeNs: ino * 10n + 1n,
  size,
});

const sourceSymlink = (ino: bigint): SourceSymlinkNode => ({
  kind: 'symlink',
  dev: 1n,
  ino,
  nlink: 1n,
  mtimeNs: ino * 10n,
  ctimeNs: ino * 10n + 1n,
});

const sourceSpecial = (
  kind: SourceSpecialNode['kind'],
  ino: bigint,
): SourceSpecialNode => ({
  kind,
  dev: 1n,
  ino,
  nlink: 1n,
  mtimeNs: ino * 10n,
  ctimeNs: ino * 10n + 1n,
});

const sourceChildPath = (parent: string, name: string): string =>
  parent === '.' ? name : path.posix.join(parent, name);

interface SourceMeterFixtureOptions {
  substituteSourceBeforeOpenPath?: string;
  replaceWithFifoBeforeOpenPath?: string;
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
  let scopeSubstituted = false;

  const pathForIdentity = (
    identity: Pick<SourceMeterStat, 'dev' | 'ino'>,
  ): string | undefined => [...nodes.entries()].find(([, node]) => (
    node.kind === 'directory'
    && node.dev === identity.dev
    && node.ino === identity.ino
  ))?.[0];

  const makeHandle = (relativePath: string, node: SourceNode) => {
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
    return {
      fd,
      read: vi.fn(async () => ({bytesRead: 0})),
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
          mtimeNs: node.mtimeNs,
          ctimeNs: node.ctimeNs,
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
  };

  const openExistingProjectFile = vi.fn(async (
    _scope: ProjectDirectoryScope,
    relativePath: string,
  ) => {
    expect(relativePath).toBe('.');
    if (scopeSubstituted) {
      throw new ProjectPathError(
        `project directory changed after scope creation: ${relativePath}`,
      );
    }
    const node = nodes.get(relativePath);
    if (node === undefined || node.kind !== 'directory') throw new Error('missing root');
    return makeHandle(relativePath, node);
  });

  const openAuthority = vi.fn(async (
    parent: Pick<SourceMeterStat, 'dev' | 'ino'>,
    name: string,
  ) => {
    const parentPath = pathForIdentity(parent);
    if (parentPath === undefined) throw new Error('unknown parent authority');
    const relativePath = sourceChildPath(parentPath, name);
    const node = nodes.get(relativePath);
    if (node === undefined || node.kind === 'symlink') {
      throw new Error('authority path is unavailable');
    }
    const openCount = openCounts.get(relativePath) ?? 0;
    openCounts.set(relativePath, openCount + 1);
    const handle = makeHandle(relativePath, node);
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
    const entries = Object.keys(node.entries).sort().map((name) => {
      const entryNode = node.entries[name]!;
      return {
        name,
        isFile: () => entryNode.kind === 'file',
        isDirectory: () => entryNode.kind === 'directory',
        isSymbolicLink: () => entryNode.kind === 'symlink',
      };
    });
    const close = vi.fn(async () => {});
    directoryCloses.push(close);
    return {
      read: vi.fn(async () => {
        if (fd === undefined) throw new Error('invalid directory fd');
        const index = fdOffsets.get(fd) ?? 0;
        fdOffsets.set(fd, index + 1);
        const entry = entries[index] ?? null;
        if (entry !== null) {
          const entryPath = sourceChildPath(relativePath!, entry.name);
          if (entryPath === options.substituteSourceBeforeOpenPath) {
            scopeSubstituted = true;
          }
          if (entryPath === options.replaceWithFifoBeforeOpenPath) {
            replaceNode(entryPath, sourceSpecial('fifo', 20_000n));
          }
        }
        return entry;
      }),
      close,
    };
  });

  const dependencies: SourceMeterDependencies = {
    openExistingProjectFile,
    openAuthority,
    openDirectory,
  };
  return {
    dependencies,
    scope: {} as ProjectDirectoryScope,
    openExistingProjectFile,
    openAuthority,
    statPaths,
    expectAllClosed: () => {
      for (const close of fileCloses) expect(close).toHaveBeenCalledOnce();
      for (const close of directoryCloses) expect(close).toHaveBeenCalledOnce();
    },
  };
};

interface SystemFileNode {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  mode: bigint;
  kind: 'file' | 'directory' | 'other';
  bytes: Uint8Array;
  reportedSize?: bigint;
}

interface SystemFileFixtureOptions {
  fontKind?: SystemFileNode['kind'];
  replaceFontWithFifo?: boolean;
  fontBytes?: Uint8Array;
  fontSize?: bigint;
  readChunkSize?: number;
  denyExecutableAccess?: boolean;
}

const systemFileAccessFixture = (
  options: SystemFileFixtureOptions = {},
) => {
  const root: SystemFileNode = {
    dev: 1n,
    ino: 10n,
    nlink: 2n,
    mode: 0o40755n,
    kind: 'directory',
    bytes: new Uint8Array(),
  };
  const assets: SystemFileNode = {
    ...root,
    ino: 11n,
  };
  const fonts: SystemFileNode = {
    ...root,
    ino: 12n,
  };
  const font: SystemFileNode = {
    dev: 1n,
    ino: 13n,
    nlink: 1n,
    mode: 0o100644n,
    kind: options.fontKind ?? 'file',
    bytes: options.fontBytes ?? Buffer.from('streamed-font-data'),
    ...(options.fontSize === undefined ? {} : {reportedSize: options.fontSize}),
  };
  const fifo: SystemFileNode = {
    ...font,
    ino: 14n,
    mode: 0o10644n,
    kind: 'other',
    bytes: new Uint8Array(),
    reportedSize: 0n,
  };
  const executable: SystemFileNode = {
    dev: 2n,
    ino: 20n,
    nlink: 1n,
    mode: 0o100401n,
    kind: 'file',
    bytes: Buffer.from('tool-binary'),
  };
  const authorityNodes = new Map<string, SystemFileNode>([
    ['/.vol/1/10/assets', assets],
    ['/.vol/1/11/fonts', fonts],
  ]);
  let fontOpenCount = 0;
  const closes: Array<ReturnType<typeof vi.fn>> = [];
  const reads: Array<ReturnType<typeof vi.fn>> = [];

  const makeHandle = (node: SystemFileNode) => {
    const close = vi.fn(async () => {});
    const read = vi.fn(async (
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      const available = Math.max(0, node.bytes.byteLength - position);
      const bytesRead = Math.min(
        available,
        length,
        options.readChunkSize ?? length,
      );
      buffer.set(node.bytes.subarray(position, position + bytesRead), offset);
      return {bytesRead};
    });
    closes.push(close);
    reads.push(read);
    return {
      fd: Number(node.ino),
      stat: vi.fn(async (statOptions: {bigint: true}) => {
        expect(statOptions).toEqual({bigint: true});
        return {
          dev: node.dev,
          ino: node.ino,
          nlink: node.nlink,
          size: node.reportedSize ?? BigInt(node.bytes.byteLength),
          mode: node.mode,
          isFile: () => node.kind === 'file',
          isDirectory: () => node.kind === 'directory',
        };
      }),
      read,
      close,
    };
  };

  const open = vi.fn(async (candidate: string, flags: number) => {
    expect(flags & constants.O_NONBLOCK).not.toBe(0);
    if (candidate === '/tool') return makeHandle(executable);
    if (candidate === '/.vol/1/12/font.otf') {
      fontOpenCount += 1;
      return makeHandle(
        options.replaceFontWithFifo === true && fontOpenCount > 1
          ? fifo
          : font,
      );
    }
    const node = authorityNodes.get(candidate);
    if (node === undefined) throw new Error(`unexpected authority open: ${candidate}`);
    return makeHandle(node);
  });
  const openExistingProjectFile = vi.fn(async (
    _scope: ProjectDirectoryScope,
    relativePath: string,
  ) => {
    expect(relativePath).toBe('.');
    return makeHandle(root);
  });
  const access = vi.fn(async (_candidate: string, mode: number) => {
    expect(mode).toBe(constants.X_OK);
    if (options.denyExecutableAccess === true) {
      throw Object.assign(new Error('not executable for effective user'), {
        code: 'EACCES',
      });
    }
  });
  const fileSystem = createSystemPreflightFileSystem({
    access,
    open,
    openExistingProjectFile,
  });

  return {
    access,
    closes,
    fileSystem,
    open,
    reads,
    expectAllClosed: () => {
      for (const close of closes) expect(close).toHaveBeenCalledOnce();
    },
  };
};

describe('system preflight file access', () => {
  it('streams a scoped font hash and closes every authority FD', async () => {
    const bytes = Buffer.alloc(180_000, 0x5a);
    const system = systemFileAccessFixture({
      fontBytes: bytes,
      readChunkSize: 4096,
    });

    const result = await system.fileSystem.hashProjectFile(
      {} as ProjectDirectoryScope,
      'assets/fonts/font.otf',
      MAX_FONT_BYTES,
    );

    expect(result.sha256).toBe(sha256(bytes.toString('binary')));
    expect(system.reads.reduce((count, read) => count + read.mock.calls.length, 0))
      .toBeGreaterThan(2);
    system.expectAllClosed();
  });

  it.each([
    ['static FIFO', {fontKind: 'other' as const}],
    ['replacement FIFO', {replaceFontWithFifo: true}],
    ['oversized font', {fontSize: 64n * 1024n * 1024n + 1n}],
  ])('rejects a %s without leaking FDs', async (_, options) => {
    const system = systemFileAccessFixture(options);

    await expect(system.fileSystem.hashProjectFile(
      {} as ProjectDirectoryScope,
      'assets/fonts/font.otf',
      MAX_FONT_BYTES,
    )).rejects.toBeInstanceOf(Error);

    system.expectAllClosed();
  });

  it('rejects mode 0401 when access(X_OK) denies the effective user', async () => {
    const system = systemFileAccessFixture({denyExecutableAccess: true});

    await expect(system.fileSystem.openExecutable('/tool'))
      .rejects.toBeInstanceOf(Error);

    expect(system.access).toHaveBeenCalledWith('/tool', constants.X_OK);
    system.expectAllClosed();
  });

  it('checks execute access against the held executable inode authority', async () => {
    const system = systemFileAccessFixture();

    const authority = await system.fileSystem.openExecutable('/tool');
    await authority.close();

    expect(system.access).toHaveBeenCalledWith('/tool', constants.X_OK);
    expect(system.access).toHaveBeenCalledWith('/.vol/2/20', constants.X_OK);
    system.expectAllClosed();
  });
});

describe('system work directory inspection', () => {
  it('rejects an external .work symlink without creating a Run', async () => {
    const workspaceRoot = await makeWorkInspectionDirectory('preflight-workspace-');
    const outsideRoot = await makeWorkInspectionDirectory('preflight-outside-');
    await symlink(outsideRoot, path.join(workspaceRoot, '.work'));
    const fileSystem = createSystemPreflightFileSystem();

    const inspection = await fileSystem.inspectWorkDirectory(
      workspaceRoot,
      'demo',
    );
    const preflight = fixture();
    preflight.input.workspaceRoot = workspaceRoot;
    preflight.input.workDirectory = path.join(workspaceRoot, '.work', 'demo');
    preflight.dependencies.fileSystem.inspectWorkDirectory =
      fileSystem.inspectWorkDirectory;
    const result = await runPreflight(preflight.input, preflight.dependencies);

    expect(inspection).toMatchObject({usable: false, availableBytes: null});
    expect(errorCheck(result, 'work-directory')).toMatchObject({
      code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
    });
    expect(errorCheck(result, 'disk-space')).toMatchObject({
      code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
    });
    expect(result.checks).not.toContainEqual(expect.objectContaining({
      id: 'disk-space',
      severity: 'info',
    }));
    await expect(createRunStore(workspaceRoot).createRun('demo', 'run-one'))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(lstat(path.join(outsideRoot, 'demo')))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects an external project work symlink', async () => {
    const workspaceRoot = await makeWorkInspectionDirectory('preflight-workspace-');
    const outsideRoot = await makeWorkInspectionDirectory('preflight-outside-');
    await mkdir(path.join(workspaceRoot, '.work'));
    await symlink(outsideRoot, path.join(workspaceRoot, '.work', 'demo'));
    const fileSystem = createSystemPreflightFileSystem();

    const inspection = await fileSystem.inspectWorkDirectory(
      workspaceRoot,
      'demo',
    );

    expect(inspection).toMatchObject({usable: false, availableBytes: null});
    await expect(createRunStore(workspaceRoot).createRun('demo', 'run-one'))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(lstat(path.join(outsideRoot, 'runs')))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('uses the safe workspace ancestor when .work is missing without creating it', async () => {
    const workspaceRoot = await makeWorkInspectionDirectory('preflight-workspace-');
    const canonicalWorkspace = await realpath(workspaceRoot);
    const fileSystem = createSystemPreflightFileSystem();

    const inspection = await fileSystem.inspectWorkDirectory(
      workspaceRoot,
      'demo',
    );

    expect(inspection).toMatchObject({
      usable: true,
      inspectedPath: canonicalWorkspace,
      availableBytes: expect.any(Number),
    });
    await expect(lstat(path.join(workspaceRoot, '.work')))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each([
    ['permission', 'symlink'],
    ['permission', 'directory'],
    ['statfs-before', 'symlink'],
    ['statfs-before', 'directory'],
    ['statfs-after', 'symlink'],
    ['statfs-after', 'directory'],
  ] as const)(
    'fails closed when missing .work appears during %s as a %s',
    async (mutationStage, appearance) => {
      const workspaceRoot = await makeWorkInspectionDirectory('preflight-workspace-');
      const outsideRoot = await makeWorkInspectionDirectory('preflight-outside-');
      const workPath = path.join(workspaceRoot, '.work');
      let mutated = false;
      const introduceWorkComponent = async (): Promise<void> => {
        if (mutated) return;
        mutated = true;
        if (appearance === 'symlink') {
          await symlink(outsideRoot, workPath);
        } else {
          await mkdir(workPath);
        }
      };
      const fileSystem = createSystemPreflightFileSystem({
        access: async (candidate, mode) => {
          if (mutationStage === 'permission') {
            await introduceWorkComponent();
          }
          await accessPath(candidate, mode);
        },
        statfs: async (candidate) => {
          if (mutationStage === 'statfs-before') {
            await introduceWorkComponent();
          }
          const status = await statfsPath(candidate, {bigint: true});
          if (mutationStage === 'statfs-after') {
            await introduceWorkComponent();
          }
          return status;
        },
      });
      const preflight = fixture();
      preflight.input.workspaceRoot = workspaceRoot;
      preflight.input.workDirectory = path.join(workPath, 'demo');
      preflight.dependencies.fileSystem.inspectWorkDirectory =
        fileSystem.inspectWorkDirectory;

      const result = await runPreflight(preflight.input, preflight.dependencies);

      expect(mutated).toBe(true);
      expect(errorCheck(result, 'work-directory')).toMatchObject({
        code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
      });
      expect(errorCheck(result, 'disk-space')).toMatchObject({
        code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
      });
      expect(result.checks).not.toContainEqual(expect.objectContaining({
        id: 'disk-space',
        severity: 'info',
      }));
      const runProjectPath = appearance === 'symlink'
        ? path.join(outsideRoot, 'demo')
        : path.join(workPath, 'demo');
      await expect(lstat(runProjectPath)).rejects.toMatchObject({code: 'ENOENT'});
    },
  );

  it('accepts an existing plain project work directory', async () => {
    const workspaceRoot = await makeWorkInspectionDirectory('preflight-workspace-');
    const workDirectory = path.join(workspaceRoot, '.work', 'demo');
    await mkdir(workDirectory, {recursive: true});
    const canonicalWorkDirectory = await realpath(workDirectory);
    const permissionTargets: string[] = [];
    const statfsTargets: string[] = [];
    const fileSystem = createSystemPreflightFileSystem({
      access: async (candidate, mode) => {
        permissionTargets.push(candidate);
        await accessPath(candidate, mode);
      },
      statfs: async (candidate) => {
        statfsTargets.push(candidate);
        return await statfsPath(candidate, {bigint: true});
      },
    });

    const inspection = await fileSystem.inspectWorkDirectory(
      workspaceRoot,
      'demo',
    );

    expect(inspection).toMatchObject({
      usable: true,
      inspectedPath: canonicalWorkDirectory,
      availableBytes: expect.any(Number),
    });
    expect(permissionTargets).toEqual([statfsTargets[0]]);
    expect(permissionTargets[0]).toMatch(/^\/\.vol\/\d+\/\d+$/u);
  });

  it('rejects a non-directory fixed work component', async () => {
    const workspaceRoot = await makeWorkInspectionDirectory('preflight-workspace-');
    await writeFile(path.join(workspaceRoot, '.work'), 'not a directory');
    const fileSystem = createSystemPreflightFileSystem();

    const inspection = await fileSystem.inspectWorkDirectory(
      workspaceRoot,
      'demo',
    );

    expect(inspection).toMatchObject({usable: false, availableBytes: null});
  });

  it('fails closed when the workspace root is substituted during inspection', async () => {
    const workspaceRoot = await makeWorkInspectionDirectory('preflight-workspace-');
    const outsideRoot = await makeWorkInspectionDirectory('preflight-outside-');
    const displacedWorkspace = `${workspaceRoot}-original`;
    workInspectionTempDirectories.push(displacedWorkspace);
    await mkdir(path.join(workspaceRoot, '.work', 'demo'), {recursive: true});
    let substituted = false;
    const fileSystem = createSystemPreflightFileSystem({
      access: async (candidate, mode) => {
        if (!substituted && candidate.startsWith('/.vol/')) {
          substituted = true;
          await rename(workspaceRoot, displacedWorkspace);
          await symlink(outsideRoot, workspaceRoot);
        }
        await accessPath(candidate, mode);
      },
    });

    const inspection = await fileSystem.inspectWorkDirectory(
      workspaceRoot,
      'demo',
    );

    expect(substituted).toBe(true);
    expect(inspection).toMatchObject({usable: false, availableBytes: null});
    await expect(lstat(path.join(outsideRoot, '.work')))
      .rejects.toMatchObject({code: 'ENOENT'});
  });
});

describe('scoped source measurement', () => {
  it('feeds a measured 1 GiB tree into the 3 GiB Preflight estimate', async () => {
    const meter = sourceMeterFixture(sourceDirectory(3n, {
      video: sourceFile(4n, BigInt(GIB - 512)),
      nested: sourceDirectory(5n, {audio: sourceFile(6n, 512n)}),
    }));

    const measuredBytes = await measureProjectSourceBytes(
      meter.scope,
      meter.dependencies,
    );
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

  it('does not block when a file Dirent is replaced by a FIFO before open', async () => {
    const meter = sourceMeterFixture(
      sourceDirectory(3n, {changed: sourceFile(4n, 100n)}),
      {replaceWithFifoBeforeOpenPath: 'assets/source/changed'},
    );
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('source measurement timed out')), 100);
    });

    await expect(Promise.race([
      measureProjectSourceBytes(meter.scope, meter.dependencies),
      timeout,
    ])).rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});

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
        mtimeNs: 4n,
        ctimeNs: 5n,
        isFile: () => true,
        isDirectory: () => false,
      };
    });
    const close = vi.fn(async () => {});
    const read = vi.fn(async () => ({bytesRead: 0}));
    const open = vi.fn(async (candidate: string, flags: number) => {
      expect(candidate).toBe('/.vol/1/9/video.mp4');
      expect(flags & constants.O_NONBLOCK).not.toBe(0);
      return {fd: 42, stat, read, close};
    });
    const adapter = createSystemSourceMeterDependencies({
      openExistingProjectFile: vi.fn(async () => ({fd: 42, stat, read, close})),
      open,
      openDirectory: vi.fn(async () => { throw new Error('not used'); }),
    });

    const handle = await adapter.openAuthority({dev: 1n, ino: 9n}, 'video.mp4');
    const status = await handle.stat();
    await handle.close();

    expect(status).toMatchObject({dev: 1n, ino: 2n, nlink: 1n, size: 3n});
    expect(stat).toHaveBeenCalledWith({bigint: true});
    expect(open).toHaveBeenCalledOnce();
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
    const rootStatFailure = sourceMeterFixture(
      sourceDirectory(3n, {}),
      {failStatPath: '.'},
    );
    const enumeration = sourceMeterFixture(
      sourceDirectory(3n, {}),
      {failDirectoryPath: 'assets/source'},
    );
    const statFailure = sourceMeterFixture(
      sourceDirectory(3n, {video: sourceFile(4n, 100n)}),
      {failStatPath: 'assets/source/video'},
    );

    for (const meter of [missing, rootStatFailure, enumeration, statFailure]) {
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

  it('rejects malformed macOS versions before parsing the major', async () => {
    const {input, dependencies} = fixture({macosVersion: '15beta'});

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'macos-version')).toMatchObject({
      code: 'ENV_PLATFORM_UNSUPPORTED',
      value: '15beta',
    });
  });

  it.each([
    {
      id: 'ffmpeg-encoder-h264',
      encoders: encoderTable([
        ' A....D aac AAC (Advanced Audio Coding) (codec aac)',
      ]),
    },
    {
      id: 'ffmpeg-encoder-aac',
      encoders: encoderTable([
        ' V....D h264_videotoolbox VideoToolbox H.264 Encoder (codec h264)',
      ]),
    },
  ])('reports a missing encoder for $id', async ({id, encoders}) => {
    const {input, dependencies} = fixture({encoders});

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, id)).toMatchObject({code: 'ENV_CAPABILITY_MISSING'});
  });

  it('accepts alternate H.264 and AAC encoder implementations', async () => {
    const {input, dependencies} = fixture({
      encoders: encoderTable([
        ' V....D libopenh264 OpenH264 H.264 encoder (codec h264)',
        ' A....D aac_at AudioToolbox AAC encoder (codec aac)',
      ]),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'ffmpeg-encoder-h264')).toBeUndefined();
    expect(errorCheck(result, 'ffmpeg-encoder-aac')).toBeUndefined();
  });

  it('accepts the standard libx264 encoder row', async () => {
    const {input, dependencies} = fixture({
      encoders: encoderTable([
        ' V....D libx264 libx264 H.264 / AVC / MPEG-4 AVC (codec h264)',
        ' A....D aac AAC (Advanced Audio Coding) (codec aac)',
      ]),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'ffmpeg-encoder-h264')).toBeUndefined();
    expect(errorCheck(result, 'ffmpeg-encoder-aac')).toBeUndefined();
  });

  it('ignores warnings, decoder tables, and disabled encoder text', async () => {
    const {input, dependencies} = fixture({
      encoders: [
        'warning: h264 disabled and aac unavailable',
        'Decoders:',
        ' V....D h264 H.264 decoder only',
        ' A....D aac AAC decoder only',
        encoderTable([
          ' V....D vp9 VP9 encoder',
          ' A....D mp3 MP3 encoder',
          ' V....D h264_disabled disabled encoder',
        ]),
      ].join('\n'),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'ffmpeg-encoder-h264')).toMatchObject({
      code: 'ENV_CAPABILITY_MISSING',
    });
    expect(errorCheck(result, 'ffmpeg-encoder-aac')).toMatchObject({
      code: 'ENV_CAPABILITY_MISSING',
    });
  });

  it.each(['loudnorm', 'silencedetect', 'blackdetect'] as const)(
    'reports a missing %s filter',
    async (missingFilter) => {
      const filters = ['loudnorm', 'silencedetect', 'blackdetect']
        .filter((filter) => filter !== missingFilter)
        .map((filter) => ` ... ${filter} input->output`);
      const {input, dependencies} = fixture({filters: filterTable(filters)});

      const result = await runPreflight(input, dependencies);

      expect(errorCheck(result, `ffmpeg-filter-${missingFilter}`)).toMatchObject({
        code: 'ENV_CAPABILITY_MISSING',
      });
    },
  );

  it('ignores warning and substring filter names', async () => {
    const {input, dependencies} = fixture({
      filters: [
        'warning: loudnorm unavailable',
        filterTable([
          ' ... loudnorm_unavailable A->A not the required filter',
          ' ... silencedetect A->A Detect silence',
          ' ... blackdetect V->V Detect black intervals',
        ]),
      ].join('\n'),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'ffmpeg-filter-loudnorm')).toMatchObject({
      code: 'ENV_CAPABILITY_MISSING',
    });
  });

  it('accepts current FFmpeg filter rows with two flag columns', async () => {
    const {input, dependencies} = fixture({
      filters: [
        'Filters:',
        '  T. loudnorm A->A EBU R128 loudness normalization',
        '  .. silencedetect A->A Detect silence',
        '  .. blackdetect V->V Detect black intervals',
      ].join('\n'),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'ffmpeg-filter-loudnorm')).toBeUndefined();
    expect(errorCheck(result, 'ffmpeg-filter-silencedetect')).toBeUndefined();
    expect(errorCheck(result, 'ffmpeg-filter-blackdetect')).toBeUndefined();
  });

  it('resolves FFmpeg once, canonicalizes it, and reuses its real path', async () => {
    const {input, dependencies, resolveExecutable, realpath, runProcess} = fixture();

    const result = await runPreflight(input, dependencies);

    expect(resolveExecutable.mock.calls.filter(([selection]) => (
      selection === FFMPEG_SELECTION
    ))).toHaveLength(1);
    expect(realpath.mock.calls.filter(([candidate]) => (
      candidate === FFMPEG_LINK
    ))).toHaveLength(1);
    expect(runProcess.mock.calls.filter(([command]) => command === FFMPEG_AUTHORITY))
      .toEqual([
        [FFMPEG_AUTHORITY, ['-version']],
        [FFMPEG_AUTHORITY, ['-hide_banner', '-encoders']],
        [FFMPEG_AUTHORITY, ['-hide_banner', '-filters']],
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
    expect(runProcess).toHaveBeenCalledWith(FFPROBE_AUTHORITY, ['-version']);
    expect(result.versions.ffprobe).toBe('8.0');
  });

  it('derives qt-faststart only from the canonical FFmpeg directory', async () => {
    const {input, dependencies, openExecutable, realpath} = fixture();

    const result = await runPreflight(input, dependencies);

    expect(realpath).toHaveBeenCalledWith(QT_FASTSTART_SIBLING);
    expect(openExecutable).toHaveBeenCalledWith(QT_FASTSTART_REAL);
    expect(result.toolIdentities.qtFaststart?.realPath).toBe(QT_FASTSTART_REAL);
  });

  it.each([
    ['missing', {qtFaststartAccessDenied: true}],
    ['non-regular', {qtFaststartKind: 'directory' as const}],
    ['non-executable', {qtFaststartAccessDenied: true}],
  ])('maps a %s qt-faststart sibling to ENV_TOOL_MISSING', async (_, overrides) => {
    const {input, dependencies} = fixture(overrides);

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, 'qt-faststart')).toMatchObject({
      code: 'ENV_TOOL_MISSING',
      affectedPaths: [QT_FASTSTART_SIBLING],
    });
    expect(result.toolIdentities.qtFaststart).toBeNull();
  });

  it('fails closed when FFmpeg is atomically replaced during a probe', async () => {
    const {input, dependencies} = fixture({replaceFfmpegDuringProbe: true});

    const result = await runPreflight(input, dependencies);

    expect(result.checks).toContainEqual(expect.objectContaining({
      code: 'ENV_TOOL_CHANGED',
    }));
    expect(result.toolIdentities.ffmpeg).toBeNull();
    expect(result.versions.ffmpeg).toBeNull();
    expect(result.environmentFingerprint).not.toContain('replacement-ffmpeg-binary');
  });

  it('fails closed when qt-faststart changes before fingerprint use', async () => {
    const {input, dependencies} = fixture({replaceQtFaststartBeforeUse: true});

    const result = await runPreflight(input, dependencies);

    expect(result.checks).toContainEqual(expect.objectContaining({
      id: 'qt-faststart',
      code: 'ENV_TOOL_CHANGED',
    }));
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
    const {input, dependencies, hashProjectFile} = fixture({fontBytes: 'font-v2'});

    const result = await runPreflight(input, dependencies);

    expect(hashProjectFile).toHaveBeenCalledOnce();
    expect(result.fonts).toEqual([{
      path: input.project.captions.font,
      sha256: sha256('font-v2'),
    }]);
    expect(errorCheck(result, `font:${input.project.captions.font}`)).toBeUndefined();
  });

  it('maps invalid or oversized configured fonts to ENV_FONT_INVALID', async () => {
    const {input, dependencies} = fixture({
      fontError: Object.assign(new Error('font is unsafe'), {
        code: 'ENV_FONT_INVALID',
      }),
    });

    const result = await runPreflight(input, dependencies);

    expect(errorCheck(result, `font:${input.project.captions.font}`)).toMatchObject({
      code: 'ENV_FONT_INVALID',
    });
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
      const {input, dependencies, inspectWorkDirectory} = fixture({sourceBytes});

      const result = await runPreflight(input, dependencies);

      expect(inspectWorkDirectory).toHaveBeenCalledWith('/workspace', 'demo');
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
    const {input, dependencies, inspectWorkDirectory} = fixture({
      workDirectoryUsable: false,
    });
    input.workDirectory = '/external/override';

    const result = await runPreflight(input, dependencies);

    expect(inspectWorkDirectory).toHaveBeenCalledWith('/workspace', 'demo');
    expect(result.system.workDirectory).toBe(WORK_DIRECTORY);
    expect(errorCheck(result, 'work-directory')).toMatchObject({
      code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
      affectedPaths: [WORK_DIRECTORY],
    });
    expect(errorCheck(result, 'disk-space')).toMatchObject({
      code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
    });
    expect(result.checks).not.toContainEqual(expect.objectContaining({
      id: 'disk-space',
      severity: 'info',
    }));
  });

  it('rejects an unvalidated project id before deriving work authority', async () => {
    const {input, dependencies, inspectWorkDirectory} = fixture();
    input.project.id = '../escape';

    const result = await runPreflight(input, dependencies);

    expect(inspectWorkDirectory).not.toHaveBeenCalled();
    expect(errorCheck(result, 'work-directory')).toMatchObject({
      code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
    });
    expect(errorCheck(result, 'disk-space')).toMatchObject({
      code: 'ENV_WORK_DIRECTORY_UNAVAILABLE',
    });
  });

  it('runs the complete required probe list with injected processes', async () => {
    const {input, dependencies, heldAuthorities, runProcess} = fixture();

    await runPreflight(input, dependencies);

    expect(runProcess.mock.calls).toEqual([
      ['node', ['--version']],
      ['pnpm', ['--version']],
      ['/usr/bin/sw_vers', ['-productVersion']],
      [FFMPEG_AUTHORITY, ['-version']],
      [FFPROBE_AUTHORITY, ['-version']],
      [FFMPEG_AUTHORITY, ['-hide_banner', '-encoders']],
      [FFMPEG_AUTHORITY, ['-hide_banner', '-filters']],
      ['/usr/bin/say', ['-v', '?']],
    ]);
    for (const authority of heldAuthorities) {
      expect(authority.close).toHaveBeenCalledOnce();
    }
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
