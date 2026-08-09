import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {
  access,
  readFile,
  realpath,
  stat,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import type {Project} from '../../domain/project-schema';
import type {Script} from '../../domain/script-schema';
import {
  prepareExistingProjectFile,
  type ProjectDirectoryScope,
} from '../../fs/project-paths';
import {
  runProcess as runSystemProcess,
  type ProcessResult,
} from '../../process/run-process';
import {fingerprintValue} from '../fingerprint';
import type {CheckResult} from '../types';

const GIB = 1024 ** 3;
const MINIMUM_REQUIRED_BYTES = 2 * GIB;
const EXECUTABLE_BITS = 0o111;

export type PreflightErrorCode =
  | 'DISK_SPACE_EXHAUSTED'
  | 'ENV_CAPABILITY_MISSING'
  | 'ENV_FONT_MISSING'
  | 'ENV_INPUT_INVALID'
  | 'ENV_PLATFORM_UNSUPPORTED'
  | 'ENV_TOOL_MISSING'
  | 'ENV_VOICE_MISSING'
  | 'ENV_WORK_DIRECTORY_UNAVAILABLE';

export interface PreflightCheck extends CheckResult {
  code?: PreflightErrorCode;
}

export interface ToolIdentity {
  realPath: string;
  sha256: string;
}

export interface FontIdentity {
  path: string;
  sha256: string;
}

export interface PreflightFileStatus {
  kind: 'file' | 'directory' | 'other';
  mode: number;
}

export type PreflightProcessResult = ProcessResult;

export interface DirectoryInspection {
  usable: boolean;
  reason?: string;
  inspectedPath: string;
}

export interface PreflightFileSystem {
  realpath(candidate: string): Promise<string>;
  stat(candidate: string): Promise<PreflightFileStatus>;
  readFile(candidate: string): Promise<Uint8Array>;
  readProjectFile(
    scope: ProjectDirectoryScope,
    relativePath: string,
  ): Promise<{data: Uint8Array; kind: PreflightFileStatus['kind']}>;
  inspectDirectory(candidate: string): Promise<DirectoryInspection>;
  statfsAvailableBytes(candidate: string): Promise<number>;
}

export interface PreflightDependencies {
  runtime: {
    platform: NodeJS.Platform;
    arch: string;
  };
  runProcess(
    command: string,
    args: readonly string[],
  ): Promise<PreflightProcessResult>;
  resolveExecutable(selection: string): Promise<string>;
  fileSystem: PreflightFileSystem;
}

export interface PreflightInput {
  workspaceRoot: string;
  projectDirectory: ProjectDirectoryScope;
  project: Project;
  script: Script;
  sourceBytes: number;
  workDirectory?: string;
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
}

export interface PreflightVersions {
  node: string | null;
  pnpm: string | null;
  macos: string | null;
  ffmpeg: string | null;
  ffprobe: string | null;
}

export interface PreflightVoice {
  configured: string;
  available: boolean;
  segmentedWavFallback: boolean;
}

export interface PreflightSystem {
  platform: NodeJS.Platform;
  arch: string;
  sourceBytes: number;
  requiredBytes: number;
  availableBytes: number | null;
  workDirectory: string;
}

export interface PreflightResult {
  checks: PreflightCheck[];
  toolIdentities: {
    ffmpeg: ToolIdentity | null;
    qtFaststart: ToolIdentity | null;
  };
  fonts: FontIdentity[];
  voice: PreflightVoice;
  versions: PreflightVersions;
  system: PreflightSystem;
  environmentFingerprint: string;
}

interface ProbeOutput {
  stdout: string;
  stderr: string;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const sha256 = (data: Uint8Array): string =>
  `sha256:${createHash('sha256').update(data).digest('hex')}`;

const executable = (status: PreflightFileStatus): boolean =>
  status.kind === 'file' && (status.mode & EXECUTABLE_BITS) !== 0;

const firstLine = (value: string): string =>
  value.trim().split(/\r?\n/u, 1)[0] ?? '';

const parseSimpleVersion = (value: string): string | null => {
  const parsed = firstLine(value).replace(/^v/u, '').trim();
  return parsed.length > 0 ? parsed : null;
};

const parseFfmpegVersion = (
  value: string,
  executableName: 'ffmpeg' | 'ffprobe',
): string | null => {
  const match = new RegExp(`${executableName} version\\s+(\\S+)`, 'u')
    .exec(value);
  return match?.[1] ?? null;
};

const parseNames = (value: string): Set<string> => {
  const names = new Set<string>();
  for (const line of value.split(/\r?\n/u)) {
    const columns = line.trim().split(/\s+/u);
    if (columns.length >= 2) names.add(columns[1]!);
  }
  return names;
};

const hasH264Encoder = (names: ReadonlySet<string>): boolean =>
  [...names].some((name) => name.toLowerCase().includes('h264'));

const hasAacEncoder = (names: ReadonlySet<string>): boolean =>
  [...names].some((name) => name.toLowerCase().includes('aac'));

const hasVoice = (output: string, configuredVoice: string): boolean =>
  output.split(/\r?\n/u).some((line) => (
    line === configuredVoice
    || line.startsWith(`${configuredVoice} `)
    || line.startsWith(`${configuredVoice}\t`)
  ));

const allSegmentsHaveWav = (script: Script): boolean =>
  script.segments.every((segment) => (
    segment.audioPath !== undefined && /\.wav$/iu.test(segment.audioPath)
  ));

const addInfo = (
  checks: PreflightCheck[],
  id: string,
  message: string,
  details: Omit<PreflightCheck, 'id' | 'message' | 'severity'> = {},
): void => {
  checks.push({id, severity: 'info', message, ...details});
};

const addError = (
  checks: PreflightCheck[],
  id: string,
  code: PreflightErrorCode,
  message: string,
  details: Omit<PreflightCheck, 'code' | 'id' | 'message' | 'severity'> = {},
): void => {
  checks.push({id, severity: 'error', code, message, ...details});
};

const probe = async (
  dependencies: PreflightDependencies,
  command: string,
  args: readonly string[],
): Promise<ProbeOutput | null> => {
  try {
    const result = await dependencies.runProcess(command, args);
    if (result.exitCode !== 0 || result.signal !== null) return null;
    return {stdout: result.stdout, stderr: result.stderr};
  } catch {
    return null;
  }
};

const combinedOutput = (output: ProbeOutput | null): string =>
  output === null ? '' : `${output.stdout}\n${output.stderr}`;

const resolveExecutablePath = async (
  selection: string,
  dependencies: PreflightDependencies,
): Promise<string> => {
  const selectedPath = await dependencies.resolveExecutable(selection);
  const realPath = await dependencies.fileSystem.realpath(selectedPath);
  const status = await dependencies.fileSystem.stat(realPath);
  if (!executable(status)) throw new Error('selected executable is unavailable');
  return realPath;
};

const resolveBinaryIdentity = async (
  selection: string,
  dependencies: PreflightDependencies,
): Promise<ToolIdentity> => {
  const realPath = await resolveExecutablePath(selection, dependencies);
  const data = await dependencies.fileSystem.readFile(realPath);
  return {realPath, sha256: sha256(data)};
};

const resolveQtFaststartIdentity = async (
  ffmpegRealPath: string,
  dependencies: PreflightDependencies,
): Promise<{identity: ToolIdentity; siblingPath: string}> => {
  const siblingPath = path.join(path.dirname(ffmpegRealPath), 'qt-faststart');
  const status = await dependencies.fileSystem.stat(siblingPath);
  if (!executable(status)) throw new Error('qt-faststart is unavailable');
  const realPath = await dependencies.fileSystem.realpath(siblingPath);
  const data = await dependencies.fileSystem.readFile(realPath);
  return {
    identity: {realPath, sha256: sha256(data)},
    siblingPath,
  };
};

const capabilityCheck = (
  checks: PreflightCheck[],
  id: string,
  available: boolean,
  capability: string,
): void => {
  if (available) {
    addInfo(checks, id, `${capability} is available.`, {value: true});
  } else {
    addError(
      checks,
      id,
      'ENV_CAPABILITY_MISSING',
      `${capability} is required but unavailable.`,
      {value: false, expected: true},
    );
  }
};

export async function runPreflight(
  input: PreflightInput,
  dependencies: PreflightDependencies,
): Promise<PreflightResult> {
  const checks: PreflightCheck[] = [];
  const {platform, arch} = dependencies.runtime;
  const supportedPlatform = platform === 'darwin' && arch === 'arm64';
  if (supportedPlatform) {
    addInfo(checks, 'supported-platform', 'Platform is supported.', {
      value: `${platform}/${arch}`,
      expected: 'darwin/arm64',
    });
  } else {
    addError(
      checks,
      'supported-platform',
      'ENV_PLATFORM_UNSUPPORTED',
      'Apple Silicon macOS is required.',
      {value: `${platform}/${arch}`, expected: 'darwin/arm64'},
    );
  }

  const validSourceBytes = Number.isFinite(input.sourceBytes)
    && input.sourceBytes >= 0;
  const sourceBytes = validSourceBytes ? input.sourceBytes : 0;
  if (!validSourceBytes) {
    addError(
      checks,
      'source-bytes',
      'ENV_INPUT_INVALID',
      'Source byte estimate must be a non-negative finite number.',
    );
  }
  const requiredBytes = Math.max(sourceBytes * 3, MINIMUM_REQUIRED_BYTES);
  const workDirectory = input.workDirectory
    ?? path.join(input.workspaceRoot, '.work', input.project.id);

  const versions: PreflightVersions = {
    node: null,
    pnpm: null,
    macos: null,
    ffmpeg: null,
    ffprobe: null,
  };

  const nodeOutput = await probe(dependencies, 'node', ['--version']);
  versions.node = nodeOutput === null
    ? null
    : parseSimpleVersion(combinedOutput(nodeOutput));
  if (versions.node === null) {
    addError(checks, 'node', 'ENV_TOOL_MISSING', 'Node.js is unavailable.');
  } else {
    addInfo(checks, 'node', 'Node.js is available.', {value: versions.node});
  }

  const pnpmOutput = await probe(dependencies, 'pnpm', ['--version']);
  versions.pnpm = pnpmOutput === null
    ? null
    : parseSimpleVersion(combinedOutput(pnpmOutput));
  if (versions.pnpm === null) {
    addError(checks, 'pnpm', 'ENV_TOOL_MISSING', 'pnpm is unavailable.');
  } else {
    addInfo(checks, 'pnpm', 'pnpm is available.', {value: versions.pnpm});
  }

  const macosOutput = await probe(
    dependencies,
    '/usr/bin/sw_vers',
    ['-productVersion'],
  );
  versions.macos = macosOutput === null
    ? null
    : parseSimpleVersion(combinedOutput(macosOutput));
  const macosMajor = versions.macos === null
    ? Number.NaN
    : Number.parseInt(versions.macos.split('.')[0] ?? '', 10);
  if (!Number.isFinite(macosMajor) || macosMajor < 15) {
    addError(
      checks,
      'macos-version',
      'ENV_PLATFORM_UNSUPPORTED',
      'macOS 15 or newer is required.',
      {value: versions.macos ?? 'unavailable', expected: '>=15'},
    );
  } else {
    addInfo(checks, 'macos-version', 'macOS version is supported.', {
      value: versions.macos!,
      expected: '>=15',
    });
  }

  const toolIdentities: PreflightResult['toolIdentities'] = {
    ffmpeg: null,
    qtFaststart: null,
  };
  const ffmpegSelection = input.ffmpegExecutable ?? 'ffmpeg';
  try {
    toolIdentities.ffmpeg = await resolveBinaryIdentity(
      ffmpegSelection,
      dependencies,
    );
  } catch {
    addError(
      checks,
      'ffmpeg',
      'ENV_TOOL_MISSING',
      'The selected FFmpeg executable is missing or unusable.',
      {affectedPaths: [ffmpegSelection]},
    );
  }

  if (toolIdentities.ffmpeg !== null) {
    const siblingPath = path.join(
      path.dirname(toolIdentities.ffmpeg.realPath),
      'qt-faststart',
    );
    try {
      const resolved = await resolveQtFaststartIdentity(
        toolIdentities.ffmpeg.realPath,
        dependencies,
      );
      toolIdentities.qtFaststart = resolved.identity;
      addInfo(checks, 'qt-faststart', 'qt-faststart is available.', {
        affectedPaths: [resolved.identity.realPath],
      });
    } catch {
      addError(
        checks,
        'qt-faststart',
        'ENV_TOOL_MISSING',
        'The FFmpeg sibling qt-faststart is missing or unusable.',
        {affectedPaths: [siblingPath]},
      );
    }
  } else {
    addError(
      checks,
      'qt-faststart',
      'ENV_TOOL_MISSING',
      'qt-faststart cannot be resolved without FFmpeg.',
    );
  }

  let ffprobeRealPath: string | null = null;
  try {
    ffprobeRealPath = await resolveExecutablePath(
      input.ffprobeExecutable ?? 'ffprobe',
      dependencies,
    );
  } catch {
    addError(
      checks,
      'ffprobe',
      'ENV_TOOL_MISSING',
      'The selected ffprobe executable is missing or unusable.',
      {affectedPaths: [input.ffprobeExecutable ?? 'ffprobe']},
    );
  }

  let ffmpegVersionOutput: ProbeOutput | null = null;
  if (toolIdentities.ffmpeg !== null) {
    ffmpegVersionOutput = await probe(
      dependencies,
      toolIdentities.ffmpeg.realPath,
      ['-version'],
    );
    versions.ffmpeg = ffmpegVersionOutput === null
      ? null
      : parseFfmpegVersion(combinedOutput(ffmpegVersionOutput), 'ffmpeg');
    if (versions.ffmpeg === null) {
      addError(checks, 'ffmpeg-version', 'ENV_TOOL_MISSING', 'FFmpeg probe failed.');
    } else {
      addInfo(checks, 'ffmpeg-version', 'FFmpeg is available.', {
        value: versions.ffmpeg,
      });
    }
  }

  if (ffprobeRealPath !== null) {
    const ffprobeOutput = await probe(
      dependencies,
      ffprobeRealPath,
      ['-version'],
    );
    versions.ffprobe = ffprobeOutput === null
      ? null
      : parseFfmpegVersion(combinedOutput(ffprobeOutput), 'ffprobe');
    if (versions.ffprobe === null) {
      addError(checks, 'ffprobe-version', 'ENV_TOOL_MISSING', 'ffprobe probe failed.');
    } else {
      addInfo(checks, 'ffprobe-version', 'ffprobe is available.', {
        value: versions.ffprobe,
      });
    }
  }

  let encoderNames = new Set<string>();
  if (toolIdentities.ffmpeg !== null) {
    const encoderOutput = await probe(
      dependencies,
      toolIdentities.ffmpeg.realPath,
      ['-hide_banner', '-encoders'],
    );
    encoderNames = parseNames(combinedOutput(encoderOutput));
  }
  capabilityCheck(
    checks,
    'ffmpeg-encoder-h264',
    hasH264Encoder(encoderNames),
    'An H.264 encoder',
  );
  capabilityCheck(
    checks,
    'ffmpeg-encoder-aac',
    hasAacEncoder(encoderNames),
    'An AAC encoder',
  );

  let filterNames = new Set<string>();
  if (toolIdentities.ffmpeg !== null) {
    const filterOutput = await probe(
      dependencies,
      toolIdentities.ffmpeg.realPath,
      ['-hide_banner', '-filters'],
    );
    filterNames = parseNames(combinedOutput(filterOutput));
  }
  for (const filter of ['loudnorm', 'silencedetect', 'blackdetect'] as const) {
    capabilityCheck(
      checks,
      `ffmpeg-filter-${filter}`,
      filterNames.has(filter),
      `FFmpeg filter ${filter}`,
    );
  }

  const sayOutput = await probe(dependencies, '/usr/bin/say', ['-v', '?']);
  const segmentedWavFallback = allSegmentsHaveWav(input.script);
  const voiceAvailable = sayOutput !== null && hasVoice(
    combinedOutput(sayOutput),
    input.project.tts.voice,
  );
  const voice: PreflightVoice = {
    configured: input.project.tts.voice,
    available: voiceAvailable,
    segmentedWavFallback: !voiceAvailable && segmentedWavFallback,
  };
  if (voiceAvailable) {
    addInfo(checks, 'macos-voice', 'Configured macOS voice is available.', {
      value: input.project.tts.voice,
    });
  } else if (segmentedWavFallback) {
    addInfo(
      checks,
      'macos-voice',
      'Segmented WAV input makes the configured macOS voice optional.',
      {value: input.project.tts.voice},
    );
  } else {
    addError(
      checks,
      'macos-voice',
      'ENV_VOICE_MISSING',
      'Configured macOS voice is unavailable and no segmented WAV fallback exists.',
      {value: input.project.tts.voice},
    );
  }

  const fonts: FontIdentity[] = [];
  const configuredFonts = [...new Set([input.project.captions.font])];
  for (const configuredFont of configuredFonts) {
    const checkId = `font:${configuredFont}`;
    try {
      const fontFile = await dependencies.fileSystem.readProjectFile(
        input.projectDirectory,
        configuredFont,
      );
      if (fontFile.kind !== 'file') throw new Error('font is not a regular file');
      const identity = {path: configuredFont, sha256: sha256(fontFile.data)};
      fonts.push(identity);
      addInfo(checks, checkId, 'Configured font is available.', {
        affectedPaths: [configuredFont],
      });
    } catch {
      addError(
        checks,
        checkId,
        'ENV_FONT_MISSING',
        'Configured font is missing or unusable.',
        {affectedPaths: [configuredFont]},
      );
    }
  }

  try {
    const inspection = await dependencies.fileSystem.inspectDirectory(workDirectory);
    if (inspection.usable) {
      addInfo(checks, 'work-directory', 'Work directory is usable.', {
        affectedPaths: [workDirectory],
      });
    } else {
      addError(
        checks,
        'work-directory',
        'ENV_WORK_DIRECTORY_UNAVAILABLE',
        'Work directory is unavailable or lacks required permissions.',
        {affectedPaths: [workDirectory]},
      );
    }
  } catch {
    addError(
      checks,
      'work-directory',
      'ENV_WORK_DIRECTORY_UNAVAILABLE',
      'Work directory could not be inspected.',
      {affectedPaths: [workDirectory]},
    );
  }

  let availableBytes: number | null = null;
  try {
    const measuredBytes = await dependencies.fileSystem
      .statfsAvailableBytes(workDirectory);
    if (!Number.isFinite(measuredBytes) || measuredBytes < 0) {
      throw new Error('invalid statfs result');
    }
    availableBytes = measuredBytes;
    if (availableBytes < requiredBytes) {
      addError(
        checks,
        'disk-space',
        'DISK_SPACE_EXHAUSTED',
        'Available disk space is below the preflight estimate.',
        {value: availableBytes, expected: requiredBytes},
      );
    } else {
      addInfo(checks, 'disk-space', 'Available disk space is sufficient.', {
        value: availableBytes,
        expected: requiredBytes,
      });
    }
  } catch {
    addError(
      checks,
      'disk-space',
      'ENV_WORK_DIRECTORY_UNAVAILABLE',
      'Available disk space could not be inspected.',
      {expected: requiredBytes},
    );
  }

  const system: PreflightSystem = {
    platform,
    arch,
    sourceBytes,
    requiredBytes,
    availableBytes,
    workDirectory,
  };
  const environmentFingerprint = fingerprintValue({
    schemaVersion: 1,
    system: {
      platform,
      arch,
      macosVersion: versions.macos,
    },
    versions: {
      node: versions.node,
      pnpm: versions.pnpm,
      ffmpeg: versions.ffmpeg,
      ffprobe: versions.ffprobe,
    },
    toolIdentities,
    capabilities: {
      h264Encoder: hasH264Encoder(encoderNames),
      aacEncoder: hasAacEncoder(encoderNames),
      loudnormFilter: filterNames.has('loudnorm'),
      silencedetectFilter: filterNames.has('silencedetect'),
      blackdetectFilter: filterNames.has('blackdetect'),
    },
    fonts,
    voice,
  });

  return {
    checks,
    toolIdentities,
    fonts,
    voice,
    versions,
    system,
    environmentFingerprint,
  };
}

const fileKind = (value: {isFile(): boolean; isDirectory(): boolean}): PreflightFileStatus['kind'] => {
  if (value.isFile()) return 'file';
  if (value.isDirectory()) return 'directory';
  return 'other';
};

const nearestExistingDirectory = async (candidate: string): Promise<string> => {
  let current = candidate;
  while (true) {
    try {
      const status = await stat(current);
      if (!status.isDirectory()) throw new Error('path is not a directory');
      return current;
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
};

const resolveFromPath = async (
  selection: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> => {
  if (
    path.isAbsolute(selection)
    || path.win32.isAbsolute(selection)
    || selection.includes(path.sep)
  ) {
    return selection;
  }

  for (const directory of (environment.PATH ?? '').split(path.delimiter)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, selection);
    try {
      await access(candidate, constants.X_OK);
      const status = await stat(candidate);
      if (status.isFile()) return candidate;
    } catch {
      continue;
    }
  }
  throw new Error('executable is not available');
};

export const createSystemPreflightDependencies = (
  runtime: PreflightDependencies['runtime'] = {
    platform: process.platform,
    arch: process.arch,
  },
  environment: NodeJS.ProcessEnv = process.env,
): PreflightDependencies => ({
  runtime,
  runProcess: runSystemProcess,
  resolveExecutable: async (selection) => resolveFromPath(selection, environment),
  fileSystem: {
    realpath,
    stat: async (candidate) => {
      const status = await stat(candidate);
      return {kind: fileKind(status), mode: status.mode};
    },
    readFile,
    readProjectFile: async (scope, relativePath) => {
      const prepared = await prepareExistingProjectFile(scope, relativePath);
      const handle = await prepared.open();
      try {
        const status = await handle.stat();
        return {
          data: await handle.readFile(),
          kind: fileKind(status),
        };
      } finally {
        await handle.close();
      }
    },
    inspectDirectory: async (candidate) => {
      try {
        const inspectedPath = await nearestExistingDirectory(candidate);
        await access(
          inspectedPath,
          constants.R_OK | constants.W_OK | constants.X_OK,
        );
        return {usable: true, inspectedPath};
      } catch {
        return {usable: false, inspectedPath: candidate};
      }
    },
    statfsAvailableBytes: async (candidate) => {
      const inspectedPath = await nearestExistingDirectory(candidate);
      const value = await statfs(inspectedPath);
      return value.bavail * value.bsize;
    },
  },
});
