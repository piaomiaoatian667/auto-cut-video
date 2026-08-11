import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {
  access,
  lstat,
  open,
  realpath,
  stat,
  statfs,
} from 'node:fs/promises';
import path from 'node:path';
import type {Project} from '../../domain/project-schema';
import type {Script} from '../../domain/script-schema';
import {StableIdSchema} from '../../domain/schema-primitives';
import {
  openExistingProjectFile,
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
const HASH_CHUNK_BYTES = 64 * 1024;
const O_NOFOLLOW_ANY = 0x20000000;
const SAFE_READ_FLAGS = constants.O_RDONLY
  | constants.O_NONBLOCK
  | O_NOFOLLOW_ANY;

export const MAX_FONT_BYTES = 64 * 1024 * 1024;

export type PreflightErrorCode =
  | 'DISK_SPACE_EXHAUSTED'
  | 'ENV_CAPABILITY_MISSING'
  | 'ENV_FONT_INVALID'
  | 'ENV_FONT_MISSING'
  | 'ENV_INPUT_INVALID'
  | 'ENV_PLATFORM_UNSUPPORTED'
  | 'ENV_TOOL_CHANGED'
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

export interface PreflightFileIdentity {
  kind: 'file' | 'directory' | 'other';
  mode: bigint;
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
}

export interface PreflightExecutableSnapshot {
  identity: PreflightFileIdentity;
  sha256: string;
}

export interface PreflightExecutableAuthority {
  executionPath: string;
  snapshot: PreflightExecutableSnapshot;
  revalidate(): Promise<boolean>;
  close(): Promise<void>;
}

export interface PreflightHashedProjectFile {
  identity: PreflightFileIdentity;
  sha256: string;
}

export type PreflightProcessResult = ProcessResult;

export interface DirectoryInspection {
  usable: boolean;
  reason?: string;
  inspectedPath: string;
}

export interface WorkDirectoryInspection extends DirectoryInspection {
  availableBytes: number | null;
}

export interface PreflightFileSystem {
  realpath(candidate: string): Promise<string>;
  openExecutable(candidate: string): Promise<PreflightExecutableAuthority>;
  hashProjectFile(
    scope: ProjectDirectoryScope,
    relativePath: string,
    maxBytes: number,
  ): Promise<PreflightHashedProjectFile>;
  inspectWorkDirectory(
    workspaceRoot: string,
    projectId: string,
  ): Promise<WorkDirectoryInspection>;
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

interface EncoderRecord {
  name: string;
  description: string;
}

interface ResolvedExecutable {
  realPath: string;
  authority: PreflightExecutableAuthority;
}

interface PreflightBigIntStat {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mode: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink?(): boolean;
}

interface PreflightSystemFileHandle {
  fd: number;
  stat(options: {bigint: true}): Promise<PreflightBigIntStat>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{bytesRead: number}>;
  close(): Promise<void>;
}

interface PreflightStatFs {
  bavail: bigint;
  bsize: bigint;
}

export interface SystemPreflightFileSystem {
  access(candidate: string, mode: number): Promise<void>;
  lstat(candidate: string): Promise<PreflightBigIntStat>;
  open(candidate: string, flags: number): Promise<PreflightSystemFileHandle>;
  openExistingProjectFile(
    scope: ProjectDirectoryScope,
    relativePath: string,
  ): Promise<PreflightSystemFileHandle>;
  realpath(candidate: string): Promise<string>;
  statfs(candidate: string): Promise<PreflightStatFs>;
}

class ProjectFontError extends Error {
  constructor(readonly code: 'ENV_FONT_INVALID' | 'ENV_FONT_MISSING') {
    super('Configured font is unavailable or unsafe.');
    this.name = 'ProjectFontError';
  }
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

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

const parseMacosVersion = (value: string): string | null => {
  const parsed = firstLine(value).trim();
  return /^\d+(?:\.\d+){0,2}$/u.test(parsed) ? parsed : null;
};

const unavailableDescription = (description: string): boolean =>
  /\b(?:disabled|unavailable|decoder[ -]?only)\b/iu.test(description);

const parseEncoderTable = (value: string): EncoderRecord[] => {
  const encoders: EncoderRecord[] = [];
  let inEncoderTable = false;
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === 'Encoders:') {
      inEncoderTable = true;
      continue;
    }
    if (/^[A-Za-z][A-Za-z ]+:$/u.test(trimmed)) {
      inEncoderTable = false;
      continue;
    }
    if (!inEncoderTable) continue;
    const match = /^\s*[VAS][A-Z.]{5}\s+([A-Za-z0-9_]+)(?:\s+(.*))?$/u
      .exec(line);
    if (match === null) continue;
    const name = match[1]!;
    const description = match[2] ?? '';
    if (unavailableDescription(description)) continue;
    encoders.push({name, description});
  }
  return encoders;
};

const hasH264Encoder = (encoders: readonly EncoderRecord[]): boolean =>
  encoders.some(({name, description}) => (
    name === 'libx264'
    || name === 'libx264rgb'
    || /^h264(?:_|$)/u.test(name)
    || /\(codec\s+h264\)/iu.test(description)
  ));

const hasAacEncoder = (encoders: readonly EncoderRecord[]): boolean =>
  encoders.some(({name, description}) => (
    name === 'aac'
    || /^aac_/u.test(name)
    || /_aac$/u.test(name)
    || /\(codec\s+aac\)/iu.test(description)
  ));

const parseFilterTable = (value: string): Set<string> => {
  const names = new Set<string>();
  let inFilterTable = false;
  for (const line of value.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === 'Filters:') {
      inFilterTable = true;
      continue;
    }
    if (/^[A-Za-z][A-Za-z ]+:$/u.test(trimmed)) {
      inFilterTable = false;
      continue;
    }
    if (!inFilterTable) continue;
    const match = /^\s*[TSC.]{2,3}\s+([A-Za-z0-9_]+)(?:\s+(.*))?$/u
      .exec(line);
    if (match === null || unavailableDescription(match[2] ?? '')) continue;
    names.add(match[1]!);
  }
  return names;
};

const hasVoice = (output: string, configuredVoice: string): boolean =>
  output.split(/\r?\n/u).some((line) => (
    line === configuredVoice
    || line.startsWith(`${configuredVoice} `)
    || line.startsWith(`${configuredVoice}\t`)
  ));

const allSegmentsHaveAudio = (script: Script): boolean =>
  script.segments.every((segment) => segment.audioPath !== undefined);

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

const safeRevalidate = async (
  authority: PreflightExecutableAuthority,
): Promise<boolean> => {
  try {
    return await authority.revalidate();
  } catch {
    return false;
  }
};

const probeExecutable = async (
  dependencies: PreflightDependencies,
  executable: ResolvedExecutable,
  args: readonly string[],
): Promise<{changed: boolean; output: ProbeOutput | null}> => {
  if (!await safeRevalidate(executable.authority)) {
    return {changed: true, output: null};
  }
  const output = await probe(
    dependencies,
    executable.authority.executionPath,
    args,
  );
  if (!await safeRevalidate(executable.authority)) {
    return {changed: true, output: null};
  }
  return {changed: false, output};
};

const resolveExecutableAuthority = async (
  selection: string,
  dependencies: PreflightDependencies,
): Promise<ResolvedExecutable> => {
  const selectedPath = await dependencies.resolveExecutable(selection);
  const realPath = await dependencies.fileSystem.realpath(selectedPath);
  const authority = await dependencies.fileSystem.openExecutable(realPath);
  return {realPath, authority};
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

const closeAuthorities = async (
  authorities: readonly PreflightExecutableAuthority[],
): Promise<void> => {
  await Promise.allSettled(authorities.map(async (authority) => authority.close()));
};

export async function runPreflight(
  input: PreflightInput,
  dependencies: PreflightDependencies,
): Promise<PreflightResult> {
  const heldAuthorities: PreflightExecutableAuthority[] = [];
  try {
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
    const projectId = StableIdSchema.safeParse(input.project.id);
    const workDirectory = projectId.success
      ? path.join(input.workspaceRoot, '.work', projectId.data)
      : path.join(input.workspaceRoot, '.work');

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
    const macosReported = macosOutput === null
      ? null
      : parseSimpleVersion(combinedOutput(macosOutput));
    versions.macos = macosOutput === null
      ? null
      : parseMacosVersion(combinedOutput(macosOutput));
    const macosMajor = versions.macos === null
      ? Number.NaN
      : Number.parseInt(versions.macos.split('.')[0] ?? '', 10);
    if (!Number.isFinite(macosMajor) || macosMajor < 15) {
      addError(
        checks,
        'macos-version',
        'ENV_PLATFORM_UNSUPPORTED',
        'macOS 15 or newer is required.',
        {value: macosReported ?? 'unavailable', expected: '>=15'},
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
    let ffmpeg: ResolvedExecutable | null = null;
    let ffprobe: ResolvedExecutable | null = null;
    let qtFaststart: ResolvedExecutable | null = null;
    let qtFaststartMissing = false;

    const ffmpegSelection = input.ffmpegExecutable ?? 'ffmpeg';
    try {
      ffmpeg = await resolveExecutableAuthority(ffmpegSelection, dependencies);
      heldAuthorities.push(ffmpeg.authority);
      toolIdentities.ffmpeg = {
        realPath: ffmpeg.realPath,
        sha256: ffmpeg.authority.snapshot.sha256,
      };
    } catch {
      addError(
        checks,
        'ffmpeg',
        'ENV_TOOL_MISSING',
        'The selected FFmpeg executable is missing or unusable.',
        {affectedPaths: [ffmpegSelection]},
      );
    }

    const qtFaststartSibling = ffmpeg === null
      ? null
      : path.join(path.dirname(ffmpeg.realPath), 'qt-faststart');
    if (qtFaststartSibling === null) {
      qtFaststartMissing = true;
      addError(
        checks,
        'qt-faststart',
        'ENV_TOOL_MISSING',
        'qt-faststart cannot be resolved without FFmpeg.',
      );
    } else {
      try {
        const realPath = await dependencies.fileSystem.realpath(qtFaststartSibling);
        const authority = await dependencies.fileSystem.openExecutable(realPath);
        qtFaststart = {realPath, authority};
        heldAuthorities.push(authority);
        toolIdentities.qtFaststart = {
          realPath,
          sha256: authority.snapshot.sha256,
        };
      } catch {
        qtFaststartMissing = true;
        addError(
          checks,
          'qt-faststart',
          'ENV_TOOL_MISSING',
          'The FFmpeg sibling qt-faststart is missing or unusable.',
          {affectedPaths: [qtFaststartSibling]},
        );
      }
    }

    const ffprobeSelection = input.ffprobeExecutable ?? 'ffprobe';
    try {
      ffprobe = await resolveExecutableAuthority(ffprobeSelection, dependencies);
      heldAuthorities.push(ffprobe.authority);
    } catch {
      addError(
        checks,
        'ffprobe',
        'ENV_TOOL_MISSING',
        'The selected ffprobe executable is missing or unusable.',
        {affectedPaths: [ffprobeSelection]},
      );
    }

    let ffmpegChanged = false;
    let ffmpegVersionOutput: ProbeOutput | null = null;
    let encoderOutput: ProbeOutput | null = null;
    let filterOutput: ProbeOutput | null = null;
    if (ffmpeg !== null) {
      const versionProbe = await probeExecutable(
        dependencies,
        ffmpeg,
        ['-version'],
      );
      ffmpegChanged = versionProbe.changed;
      ffmpegVersionOutput = versionProbe.output;
    }

    let ffprobeChanged = false;
    let ffprobeOutput: ProbeOutput | null = null;
    if (ffprobe !== null) {
      const versionProbe = await probeExecutable(
        dependencies,
        ffprobe,
        ['-version'],
      );
      ffprobeChanged = versionProbe.changed;
      ffprobeOutput = versionProbe.output;
    }

    if (ffmpeg !== null && !ffmpegChanged) {
      const encodersProbe = await probeExecutable(
        dependencies,
        ffmpeg,
        ['-hide_banner', '-encoders'],
      );
      ffmpegChanged = encodersProbe.changed;
      encoderOutput = encodersProbe.output;
    }
    if (ffmpeg !== null && !ffmpegChanged) {
      const filtersProbe = await probeExecutable(
        dependencies,
        ffmpeg,
        ['-hide_banner', '-filters'],
      );
      ffmpegChanged = filtersProbe.changed;
      filterOutput = filtersProbe.output;
    }
    if (ffmpeg !== null && !ffmpegChanged) {
      ffmpegChanged = !await safeRevalidate(ffmpeg.authority);
    }

    if (ffmpegChanged) {
      toolIdentities.ffmpeg = null;
      ffmpegVersionOutput = null;
      encoderOutput = null;
      filterOutput = null;
      addError(
        checks,
        'ffmpeg',
        'ENV_TOOL_CHANGED',
        'FFmpeg changed while environment probes were running.',
        {affectedPaths: ffmpeg === null ? [] : [ffmpeg.realPath]},
      );
    } else if (ffmpeg !== null) {
      versions.ffmpeg = ffmpegVersionOutput === null
        ? null
        : parseFfmpegVersion(combinedOutput(ffmpegVersionOutput), 'ffmpeg');
      if (versions.ffmpeg === null) {
        addError(
          checks,
          'ffmpeg-version',
          'ENV_TOOL_MISSING',
          'FFmpeg probe failed.',
        );
      } else {
        addInfo(checks, 'ffmpeg-version', 'FFmpeg is available.', {
          value: versions.ffmpeg,
        });
      }
    }

    if (ffprobeChanged) {
      addError(
        checks,
        'ffprobe',
        'ENV_TOOL_CHANGED',
        'ffprobe changed while environment probes were running.',
        {affectedPaths: ffprobe === null ? [] : [ffprobe.realPath]},
      );
    } else if (ffprobe !== null) {
      versions.ffprobe = ffprobeOutput === null
        ? null
        : parseFfmpegVersion(combinedOutput(ffprobeOutput), 'ffprobe');
      if (versions.ffprobe === null) {
        addError(
          checks,
          'ffprobe-version',
          'ENV_TOOL_MISSING',
          'ffprobe probe failed.',
        );
      } else {
        addInfo(checks, 'ffprobe-version', 'ffprobe is available.', {
          value: versions.ffprobe,
        });
      }
    }

    const encoders = parseEncoderTable(combinedOutput(encoderOutput));
    capabilityCheck(
      checks,
      'ffmpeg-encoder-h264',
      hasH264Encoder(encoders),
      'An H.264 encoder',
    );
    capabilityCheck(
      checks,
      'ffmpeg-encoder-aac',
      hasAacEncoder(encoders),
      'An AAC encoder',
    );

    const filterNames = parseFilterTable(combinedOutput(filterOutput));
    for (const filter of ['loudnorm', 'silencedetect', 'blackdetect'] as const) {
      capabilityCheck(
        checks,
        `ffmpeg-filter-${filter}`,
        filterNames.has(filter),
        `FFmpeg filter ${filter}`,
      );
    }

    const provider = input.project.tts.provider;
    const sayOutput = provider === 'file'
      ? null
      : await probe(dependencies, '/usr/bin/say', ['-v', '?']);
    const segmentedWavFallback = provider === 'file'
      && allSegmentsHaveAudio(input.script);
    const voiceAvailable = sayOutput !== null && hasVoice(
      combinedOutput(sayOutput),
      input.project.tts.voice,
    );
    const voice: PreflightVoice = {
      configured: input.project.tts.voice,
      available: voiceAvailable,
      segmentedWavFallback: !voiceAvailable && segmentedWavFallback,
    };
    switch (provider) {
      case 'macos-say':
        if (voiceAvailable) {
          addInfo(checks, 'macos-voice', 'Configured macOS voice is available.', {
            value: input.project.tts.voice,
          });
        } else {
          addError(
            checks,
            'macos-voice',
            'ENV_VOICE_MISSING',
            'Configured macOS voice is unavailable.',
            {value: input.project.tts.voice},
          );
        }
        break;
      case 'file':
        if (segmentedWavFallback) {
          addInfo(
            checks,
            'macos-voice',
            'File TTS source audio is configured for every segment.',
            {value: input.project.tts.voice},
          );
        } else {
          addError(
            checks,
            'macos-voice',
            'ENV_VOICE_MISSING',
            'File TTS requires audioPath on every segment.',
            {value: input.project.tts.voice},
          );
        }
        break;
      case 'mock':
        addInfo(
          checks,
          'macos-voice',
          voiceAvailable
            ? 'Configured macOS voice is available for mock diagnostics.'
            : 'Configured macOS voice is unavailable, but mock TTS does not require it.',
          {value: input.project.tts.voice},
        );
        break;
    }

    const fonts: FontIdentity[] = [];
    const configuredFonts = [...new Set([input.project.captions.font])];
    for (const configuredFont of configuredFonts) {
      const checkId = `font:${configuredFont}`;
      try {
        const fontFile = await dependencies.fileSystem.hashProjectFile(
          input.projectDirectory,
          configuredFont,
          MAX_FONT_BYTES,
        );
        const identity = {path: configuredFont, sha256: fontFile.sha256};
        fonts.push(identity);
        addInfo(checks, checkId, 'Configured font is available.', {
          affectedPaths: [configuredFont],
        });
      } catch (error) {
        const code = error instanceof ProjectFontError
          ? error.code
          : (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENV_FONT_INVALID'
          )
            ? 'ENV_FONT_INVALID'
            : 'ENV_FONT_MISSING';
        addError(
          checks,
          checkId,
          code,
          code === 'ENV_FONT_INVALID'
            ? 'Configured font is not a safe regular file.'
            : 'Configured font is missing or unusable.',
          {affectedPaths: [configuredFont]},
        );
      }
    }

    let availableBytes: number | null = null;
    let workInspection: WorkDirectoryInspection | null = null;
    if (!projectId.success) {
      addError(
        checks,
        'work-directory',
        'ENV_WORK_DIRECTORY_UNAVAILABLE',
        'Project id cannot establish a fixed work directory authority.',
        {affectedPaths: [workDirectory]},
      );
    } else {
      try {
        workInspection = await dependencies.fileSystem.inspectWorkDirectory(
          input.workspaceRoot,
          projectId.data,
        );
      } catch {
        workInspection = null;
      }
      if (workInspection?.usable === true) {
        addInfo(checks, 'work-directory', 'Work directory is usable.', {
          affectedPaths: [workDirectory],
        });
      } else {
        addError(
          checks,
          'work-directory',
          'ENV_WORK_DIRECTORY_UNAVAILABLE',
          'Work directory authority is unavailable or unsafe.',
          {affectedPaths: [workDirectory]},
        );
      }
    }

    if (
      workInspection?.usable === true
      && workInspection.availableBytes !== null
      && Number.isFinite(workInspection.availableBytes)
      && workInspection.availableBytes >= 0
    ) {
      availableBytes = workInspection.availableBytes;
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
    } else {
      addError(
        checks,
        'disk-space',
        'ENV_WORK_DIRECTORY_UNAVAILABLE',
        'Disk space was not inspected without a valid work directory authority.',
        {expected: requiredBytes},
      );
    }

    if (
      qtFaststart !== null
      && !qtFaststartMissing
      && !await safeRevalidate(qtFaststart.authority)
    ) {
      toolIdentities.qtFaststart = null;
      addError(
        checks,
        'qt-faststart',
        'ENV_TOOL_CHANGED',
        'qt-faststart changed while environment probes were running.',
        {affectedPaths: [qtFaststart.realPath]},
      );
    } else if (qtFaststart !== null && !qtFaststartMissing) {
      addInfo(checks, 'qt-faststart', 'qt-faststart is available.', {
        affectedPaths: [qtFaststart.realPath],
      });
    }

    if (
      ffmpeg !== null
      && toolIdentities.ffmpeg !== null
      && !await safeRevalidate(ffmpeg.authority)
    ) {
      toolIdentities.ffmpeg = null;
      versions.ffmpeg = null;
      addError(
        checks,
        'ffmpeg',
        'ENV_TOOL_CHANGED',
        'FFmpeg changed before its environment identity was finalized.',
        {affectedPaths: [ffmpeg.realPath]},
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
        h264Encoder: toolIdentities.ffmpeg !== null && hasH264Encoder(encoders),
        aacEncoder: toolIdentities.ffmpeg !== null && hasAacEncoder(encoders),
        loudnormFilter: toolIdentities.ffmpeg !== null
          && filterNames.has('loudnorm'),
        silencedetectFilter: toolIdentities.ffmpeg !== null
          && filterNames.has('silencedetect'),
        blackdetectFilter: toolIdentities.ffmpeg !== null
          && filterNames.has('blackdetect'),
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
  } finally {
    await closeAuthorities(heldAuthorities);
  }
}

const fileIdentity = (status: PreflightBigIntStat): PreflightFileIdentity => ({
  kind: status.isFile()
    ? 'file'
    : status.isDirectory()
      ? 'directory'
      : 'other',
  mode: status.mode,
  dev: status.dev,
  ino: status.ino,
  nlink: status.nlink,
  size: status.size,
});

const sameFileIdentity = (
  left: PreflightFileIdentity,
  right: PreflightFileIdentity,
): boolean => (
  left.kind === right.kind
  && left.mode === right.mode
  && left.dev === right.dev
  && left.ino === right.ino
  && left.nlink === right.nlink
  && left.size === right.size
);

const hashHeldRegularFile = async (
  handle: PreflightSystemFileHandle,
  maxBytes?: number,
): Promise<PreflightExecutableSnapshot> => {
  const initial = fileIdentity(await handle.stat({bigint: true}));
  if (initial.kind !== 'file' || initial.size < 0n) {
    throw new ProjectFontError('ENV_FONT_INVALID');
  }
  if (
    initial.size > BigInt(Number.MAX_SAFE_INTEGER)
    || (maxBytes !== undefined && initial.size > BigInt(maxBytes))
  ) {
    throw new ProjectFontError('ENV_FONT_INVALID');
  }

  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const {bytesRead} = await handle.read(
      buffer,
      0,
      buffer.byteLength,
      position,
    );
    if (bytesRead < 0 || bytesRead > buffer.byteLength) {
      throw new ProjectFontError('ENV_FONT_INVALID');
    }
    if (bytesRead === 0) break;
    position += bytesRead;
    if (maxBytes !== undefined && position > maxBytes) {
      throw new ProjectFontError('ENV_FONT_INVALID');
    }
    hash.update(buffer.subarray(0, bytesRead));
  }

  const finalIdentity = fileIdentity(await handle.stat({bigint: true}));
  if (
    !sameFileIdentity(initial, finalIdentity)
    || BigInt(position) !== initial.size
  ) {
    throw new ProjectFontError('ENV_FONT_INVALID');
  }
  return {
    identity: initial,
    sha256: `sha256:${hash.digest('hex')}`,
  };
};

const sameSnapshot = (
  left: PreflightExecutableSnapshot,
  right: PreflightExecutableSnapshot,
): boolean => (
  sameFileIdentity(left.identity, right.identity)
  && left.sha256 === right.sha256
);

const closeHandles = async (
  handles: readonly PreflightSystemFileHandle[],
): Promise<void> => {
  let closeError: unknown;
  for (const handle of [...handles].reverse()) {
    try {
      await handle.close();
    } catch (error) {
      closeError ??= error;
    }
  }
  if (closeError !== undefined) throw closeError;
};

const authorityPath = (
  identity: Pick<PreflightFileIdentity, 'dev' | 'ino'>,
  name?: string,
): string => {
  if (identity.dev < 0n || identity.ino < 0n) {
    throw new ProjectFontError('ENV_FONT_INVALID');
  }
  const base = `/.vol/${identity.dev}/${identity.ino}`;
  return name === undefined ? base : `${base}/${name}`;
};

interface WorkDirectoryIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
}

interface WorkDirectoryAnchor {
  identity: WorkDirectoryIdentity;
  handle: PreflightSystemFileHandle;
  authorityPath: string;
}

interface MissingWorkDirectoryComponent {
  parent: WorkDirectoryAnchor;
  name: string;
}

const workIdentityMatches = (
  identity: WorkDirectoryIdentity,
  status: PreflightBigIntStat,
): boolean => status.dev === identity.dev && status.ino === identity.ino;

const plainWorkDirectory = (status: PreflightBigIntStat): boolean => (
  status.isSymbolicLink?.() !== true && status.isDirectory()
);

const assertWorkIdentityStable = async (
  identity: WorkDirectoryIdentity,
  fileSystem: SystemPreflightFileSystem,
): Promise<void> => {
  const lexicalStatus = await fileSystem.lstat(identity.path);
  if (
    !plainWorkDirectory(lexicalStatus)
    || !workIdentityMatches(identity, lexicalStatus)
    || await fileSystem.realpath(identity.path) !== identity.path
  ) {
    throw new Error('work directory authority changed');
  }
  const anchoredStatus = await fileSystem.lstat(authorityPath(identity));
  if (
    !plainWorkDirectory(anchoredStatus)
    || !workIdentityMatches(identity, anchoredStatus)
  ) {
    throw new Error('work directory anchor changed');
  }
};

const openWorkDirectoryAnchor = async (
  identity: WorkDirectoryIdentity,
  fileSystem: SystemPreflightFileSystem,
): Promise<WorkDirectoryAnchor> => {
  await assertWorkIdentityStable(identity, fileSystem);
  const handle = await fileSystem.open(identity.path, SAFE_READ_FLAGS);
  try {
    const status = await handle.stat({bigint: true});
    if (!plainWorkDirectory(status) || !workIdentityMatches(identity, status)) {
      throw new Error('work directory changed while opening');
    }
    const anchoredPath = authorityPath(identity);
    const anchoredStatus = await fileSystem.lstat(anchoredPath);
    if (
      !plainWorkDirectory(anchoredStatus)
      || !workIdentityMatches(identity, anchoredStatus)
    ) {
      throw new Error('work directory anchor changed while opening');
    }
    return {identity, handle, authorityPath: anchoredPath};
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
};

const assertWorkAnchorsStable = async (
  anchors: readonly WorkDirectoryAnchor[],
  fileSystem: SystemPreflightFileSystem,
): Promise<void> => {
  for (const anchor of anchors) {
    await assertWorkIdentityStable(anchor.identity, fileSystem);
    const status = await anchor.handle.stat({bigint: true});
    if (
      !plainWorkDirectory(status)
      || !workIdentityMatches(anchor.identity, status)
    ) {
      throw new Error('held work directory authority changed');
    }
  }
};

const assertMissingWorkComponent = async (
  missing: MissingWorkDirectoryComponent,
  fileSystem: SystemPreflightFileSystem,
): Promise<void> => {
  try {
    await fileSystem.lstat(`${missing.parent.authorityPath}/${missing.name}`);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('missing work directory component appeared');
};

const assertWorkInspectionStable = async (
  anchors: readonly WorkDirectoryAnchor[],
  missing: MissingWorkDirectoryComponent | undefined,
  fileSystem: SystemPreflightFileSystem,
): Promise<void> => {
  await assertWorkAnchorsStable(anchors, fileSystem);
  if (missing !== undefined) {
    await assertMissingWorkComponent(missing, fileSystem);
  }
  await assertWorkAnchorsStable(anchors, fileSystem);
};

const closeWorkDirectoryAnchors = async (
  anchors: readonly WorkDirectoryAnchor[],
): Promise<boolean> => {
  const results = await Promise.allSettled(
    [...anchors].reverse().map(async (anchor) => anchor.handle.close()),
  );
  return results.every((result) => result.status === 'fulfilled');
};

const withinWorkspace = (workspaceRoot: string, candidate: string): boolean => {
  const relative = path.relative(workspaceRoot, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
};

const inspectSystemWorkDirectory = async (
  workspaceRoot: string,
  projectId: string,
  fileSystem: SystemPreflightFileSystem,
): Promise<WorkDirectoryInspection> => {
  const anchors: WorkDirectoryAnchor[] = [];
  let result: WorkDirectoryInspection = {
    usable: false,
    inspectedPath: workspaceRoot,
    availableBytes: null,
  };
  try {
    const validatedProjectId = StableIdSchema.parse(projectId);
    const canonicalWorkspace = await fileSystem.realpath(workspaceRoot);
    const workspaceStatus = await fileSystem.lstat(canonicalWorkspace);
    if (
      !plainWorkDirectory(workspaceStatus)
      || await fileSystem.realpath(canonicalWorkspace) !== canonicalWorkspace
    ) {
      throw new Error('workspace root is not a plain directory');
    }
    const workspaceIdentity: WorkDirectoryIdentity = {
      path: canonicalWorkspace,
      dev: workspaceStatus.dev,
      ino: workspaceStatus.ino,
    };
    const targetPath = path.join(
      canonicalWorkspace,
      '.work',
      validatedProjectId,
    );
    if (!withinWorkspace(canonicalWorkspace, targetPath)) {
      throw new Error('work directory escapes workspace');
    }

    let nearest = await openWorkDirectoryAnchor(workspaceIdentity, fileSystem);
    let missing: MissingWorkDirectoryComponent | undefined;
    anchors.push(nearest);
    for (const segment of ['.work', validatedProjectId]) {
      await assertWorkAnchorsStable(anchors, fileSystem);
      const childAuthorityPath = `${nearest.authorityPath}/${segment}`;
      let childStatus: PreflightBigIntStat;
      try {
        childStatus = await fileSystem.lstat(childAuthorityPath);
      } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
          missing = {parent: nearest, name: segment};
          break;
        }
        throw error;
      }
      if (!plainWorkDirectory(childStatus)) {
        throw new Error('work directory component is not a plain directory');
      }
      const childIdentity: WorkDirectoryIdentity = {
        path: path.join(nearest.identity.path, segment),
        dev: childStatus.dev,
        ino: childStatus.ino,
      };
      await assertWorkAnchorsStable(anchors, fileSystem);
      nearest = await openWorkDirectoryAnchor(childIdentity, fileSystem);
      anchors.push(nearest);
    }

    await assertWorkInspectionStable(anchors, missing, fileSystem);
    await fileSystem.access(
      nearest.authorityPath,
      constants.R_OK | constants.W_OK | constants.X_OK,
    );
    await assertWorkInspectionStable(anchors, missing, fileSystem);
    await assertWorkInspectionStable(anchors, missing, fileSystem);
    const fileSystemStatus = await fileSystem.statfs(nearest.authorityPath);
    await assertWorkInspectionStable(anchors, missing, fileSystem);
    const available = fileSystemStatus.bavail * fileSystemStatus.bsize;
    if (available < 0n) throw new Error('invalid available disk bytes');
    await assertWorkInspectionStable(anchors, missing, fileSystem);
    result = {
      usable: true,
      inspectedPath: nearest.identity.path,
      availableBytes: available > BigInt(Number.MAX_SAFE_INTEGER)
        ? Number.MAX_SAFE_INTEGER
        : Number(available),
    };
  } catch {
    result = {
      usable: false,
      inspectedPath: workspaceRoot,
      availableBytes: null,
    };
  }
  if (!await closeWorkDirectoryAnchors(anchors)) {
    return {
      usable: false,
      inspectedPath: workspaceRoot,
      availableBytes: null,
    };
  }
  return result;
};

const projectPathParts = (relativePath: string): string[] => {
  if (
    relativePath.length === 0
    || path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
  ) {
    throw new ProjectFontError('ENV_FONT_INVALID');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => (
    part.length === 0
    || part === '.'
    || part === '..'
    || part.includes('\0')
  ))) {
    throw new ProjectFontError('ENV_FONT_INVALID');
  }
  return parts;
};

const openScopedProjectFile = async (
  scope: ProjectDirectoryScope,
  relativePath: string,
  fileSystem: SystemPreflightFileSystem,
): Promise<{
  handles: PreflightSystemFileHandle[];
  file: PreflightSystemFileHandle;
}> => {
  const parts = projectPathParts(relativePath);
  const handles: PreflightSystemFileHandle[] = [];
  try {
    const root = await fileSystem.openExistingProjectFile(scope, '.');
    handles.push(root);
    let parentIdentity = fileIdentity(await root.stat({bigint: true}));
    if (parentIdentity.kind !== 'directory') {
      throw new ProjectFontError('ENV_FONT_INVALID');
    }

    let current = root;
    for (const [index, part] of parts.entries()) {
      const child = await fileSystem.open(
        authorityPath(parentIdentity, part),
        SAFE_READ_FLAGS,
      );
      handles.push(child);
      const childIdentity = fileIdentity(await child.stat({bigint: true}));
      const finalPart = index === parts.length - 1;
      if (
        (!finalPart && childIdentity.kind !== 'directory')
        || (finalPart && childIdentity.kind !== 'file')
      ) {
        throw new ProjectFontError('ENV_FONT_INVALID');
      }
      current = child;
      parentIdentity = childIdentity;
    }
    return {handles, file: current};
  } catch (error) {
    await closeHandles(handles);
    throw error;
  }
};

const mapProjectFontError = (error: unknown): ProjectFontError => {
  if (error instanceof ProjectFontError) return error;
  if (
    isNodeError(error)
    && (error.code === 'ENOENT' || error.code === 'EACCES')
  ) {
    return new ProjectFontError('ENV_FONT_MISSING');
  }
  return new ProjectFontError('ENV_FONT_INVALID');
};

const hashProjectFileOnce = async (
  scope: ProjectDirectoryScope,
  relativePath: string,
  maxBytes: number,
  fileSystem: SystemPreflightFileSystem,
): Promise<PreflightExecutableSnapshot> => {
  const opened = await openScopedProjectFile(scope, relativePath, fileSystem);
  try {
    return await hashHeldRegularFile(opened.file, maxBytes);
  } finally {
    await closeHandles(opened.handles);
  }
};

const SYSTEM_PREFLIGHT_FILE_SYSTEM: SystemPreflightFileSystem = {
  access: async (candidate, mode) => await access(candidate, mode),
  lstat: async (candidate) => await lstat(candidate, {bigint: true}),
  open: async (candidate, flags) => await open(candidate, flags),
  openExistingProjectFile: async (scope, relativePath) =>
    await openExistingProjectFile(scope, relativePath),
  realpath: async (candidate) => await realpath(candidate),
  statfs: async (candidate) => await statfs(candidate, {bigint: true}),
};

export const createSystemPreflightFileSystem = (
  overrides: Partial<SystemPreflightFileSystem> = {},
): Pick<
  PreflightFileSystem,
  'openExecutable' | 'hashProjectFile' | 'inspectWorkDirectory'
> => {
  const fileSystem: SystemPreflightFileSystem = {
    ...SYSTEM_PREFLIGHT_FILE_SYSTEM,
    ...overrides,
  };
  return {
    openExecutable: async (candidate) => {
      await fileSystem.access(candidate, constants.X_OK);
      const held = await fileSystem.open(candidate, SAFE_READ_FLAGS);
      try {
        const snapshot = await hashHeldRegularFile(held);
        const executionPath = authorityPath(snapshot.identity);
        await fileSystem.access(executionPath, constants.X_OK);
        return {
          executionPath,
          snapshot,
          revalidate: async () => {
            let verification: PreflightSystemFileHandle | undefined;
            try {
              await fileSystem.access(candidate, constants.X_OK);
              verification = await fileSystem.open(candidate, SAFE_READ_FLAGS);
              const current = await hashHeldRegularFile(verification);
              await fileSystem.access(
                authorityPath(current.identity),
                constants.X_OK,
              );
              return sameSnapshot(snapshot, current);
            } catch {
              return false;
            } finally {
              if (verification !== undefined) await verification.close();
            }
          },
          close: async () => await held.close(),
        };
      } catch (error) {
        await held.close();
        throw error;
      }
    },
    hashProjectFile: async (scope, relativePath, maxBytes) => {
      try {
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
          throw new ProjectFontError('ENV_FONT_INVALID');
        }
        const initial = await hashProjectFileOnce(
          scope,
          relativePath,
          maxBytes,
          fileSystem,
        );
        const verification = await hashProjectFileOnce(
          scope,
          relativePath,
          maxBytes,
          fileSystem,
        );
        if (!sameSnapshot(initial, verification)) {
          throw new ProjectFontError('ENV_FONT_INVALID');
        }
        return initial;
      } catch (error) {
        throw mapProjectFontError(error);
      }
    },
    inspectWorkDirectory: async (workspaceRoot, projectId) =>
      await inspectSystemWorkDirectory(workspaceRoot, projectId, fileSystem),
  };
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
      const status = await stat(candidate, {bigint: true});
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
): PreflightDependencies => {
  const safeFiles = createSystemPreflightFileSystem();
  return {
    runtime,
    runProcess: runSystemProcess,
    resolveExecutable: async (selection) => resolveFromPath(selection, environment),
    fileSystem: {
      realpath,
      ...safeFiles,
    },
  };
};
