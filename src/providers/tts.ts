import {stat} from 'node:fs/promises';
import path from 'node:path';
import {
  ensureRunDirectory,
  openNewRunReadWriteFile,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import {openExistingProjectFile, type ProjectDirectoryScope} from '../fs/project-paths';
import {fingerprintValue} from '../pipeline/fingerprint';
import {runProcess, type RunProcessOptions} from '../process/run-process';

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';

type TtsProviderId = 'macos-say' | 'file' | 'mock';

export interface TtsInput {
  segmentId: string;
  text: string;
  voice: string;
  rate: number;
  outputPath: string;
  sourceAudioPath?: string;
}

export interface TtsResult {
  outputPath: string;
  providerFingerprint: string;
}

export interface TtsProvider {
  readonly id: TtsProviderId;
  capabilities(): Promise<{languages: string[]; voices: string[]}>;
  fingerprint(): Promise<string>;
  synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsResult>;
}

export class TtsProviderError extends Error {
  constructor(readonly code: 'TTS_SOURCE_MISSING', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'TtsProviderError';
  }
}

export interface TtsProcessRunner {
  (command: string, args: readonly string[], options?: RunProcessOptions): Promise<unknown>;
}

interface RunOutputProviderOptions {
  runDirectory: RunDirectoryScope;
  ffmpegExecutable?: string;
  runProcess?: TtsProcessRunner;
}

interface FileProviderOptions extends RunOutputProviderOptions {
  projectDirectory: ProjectDirectoryScope;
}

const ensureParentDirectory = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
};

const normalizeToOutput = async ({
  runDirectory,
  outputPath,
  ffmpegExecutable,
  runner,
  signal,
  inputFd,
  inputArgs,
}: {
  runDirectory: RunDirectoryScope;
  outputPath: string;
  ffmpegExecutable: string;
  runner: TtsProcessRunner;
  signal: AbortSignal;
  inputFd?: number;
  inputArgs: readonly string[];
}): Promise<void> => {
  await ensureParentDirectory(runDirectory, outputPath);
  const outputHandle = await openNewRunReadWriteFile(runDirectory, outputPath);
  try {
    const extraStdioFds = inputFd === undefined
      ? [outputHandle.fd]
      : [inputFd, outputHandle.fd];
    const outputFdPath = inputFd === undefined ? '/dev/fd/3' : '/dev/fd/4';
    await runner(ffmpegExecutable, [
      '-v', 'error',
      '-y',
      ...inputArgs,
      '-map', '0:a:0',
      '-af', 'aresample=48000,pan=mono|c0=c0',
      '-c:a', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '1',
      '-flags:a', '+bitexact',
      '-map_metadata', '-1',
      '-f', 'wav',
      outputFdPath,
    ], {
      signal,
      extraStdioFds,
    });
    await outputHandle.sync();
  } finally {
    await outputHandle.close();
  }
};

export class MockTtsProvider implements TtsProvider {
  readonly id = 'mock' as const;
  readonly #runDirectory: RunDirectoryScope;
  readonly #ffmpegExecutable: string;
  readonly #runner: TtsProcessRunner;

  constructor(options: RunOutputProviderOptions) {
    this.#runDirectory = options.runDirectory;
    this.#ffmpegExecutable = options.ffmpegExecutable ?? FFMPEG_EXECUTABLE;
    this.#runner = options.runProcess ?? runProcess;
  }

  async capabilities(): Promise<{languages: string[]; voices: string[]}> {
    return {languages: ['zh-CN'], voices: ['fixture']};
  }

  async fingerprint(): Promise<string> {
    return fingerprintValue({provider: this.id, algorithm: 'mock-tts-v1'});
  }

  async synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsResult> {
    await normalizeToOutput({
      runDirectory: this.#runDirectory,
      outputPath: input.outputPath,
      ffmpegExecutable: this.#ffmpegExecutable,
      runner: this.#runner,
      signal,
      inputArgs: [
        '-f', 'lavfi',
        '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      ],
    });
    return {outputPath: input.outputPath, providerFingerprint: await this.fingerprint()};
  }
}

export class FileTtsProvider implements TtsProvider {
  readonly id = 'file' as const;
  readonly #projectDirectory: ProjectDirectoryScope;
  readonly #runDirectory: RunDirectoryScope;
  readonly #ffmpegExecutable: string;
  readonly #runner: TtsProcessRunner;

  constructor(options: FileProviderOptions) {
    this.#projectDirectory = options.projectDirectory;
    this.#runDirectory = options.runDirectory;
    this.#ffmpegExecutable = options.ffmpegExecutable ?? FFMPEG_EXECUTABLE;
    this.#runner = options.runProcess ?? runProcess;
  }

  async capabilities(): Promise<{languages: string[]; voices: string[]}> {
    return {languages: ['zh-CN'], voices: ['file']};
  }

  async fingerprint(): Promise<string> {
    return fingerprintValue({provider: this.id, algorithm: 'file-tts-v1'});
  }

  async synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsResult> {
    if (input.sourceAudioPath === undefined) {
      throw new TtsProviderError(
        'TTS_SOURCE_MISSING',
        `file TTS segment ${input.segmentId} requires sourceAudioPath`,
      );
    }
    const sourceHandle = await openExistingProjectFile(
      this.#projectDirectory,
      input.sourceAudioPath,
    );
    try {
      await normalizeToOutput({
        runDirectory: this.#runDirectory,
        outputPath: input.outputPath,
        ffmpegExecutable: this.#ffmpegExecutable,
        runner: this.#runner,
        signal,
        inputFd: sourceHandle.fd,
        inputArgs: ['-i', '/dev/fd/3'],
      });
    } finally {
      await sourceHandle.close();
    }
    return {outputPath: input.outputPath, providerFingerprint: await this.fingerprint()};
  }
}

export class MacOsSayProvider implements TtsProvider {
  readonly id = 'macos-say' as const;
  readonly #runDirectory: RunDirectoryScope;
  readonly #ffmpegExecutable: string;
  readonly #runner: TtsProcessRunner;

  constructor(options: RunOutputProviderOptions) {
    this.#runDirectory = options.runDirectory;
    this.#ffmpegExecutable = options.ffmpegExecutable ?? FFMPEG_EXECUTABLE;
    this.#runner = options.runProcess ?? runProcess;
  }

  async capabilities(): Promise<{languages: string[]; voices: string[]}> {
    const result = await runProcess('/usr/bin/say', ['-v', '?']);
    const voices = result.stdout.split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((voice): voice is string => voice !== undefined && voice.length > 0);
    return {languages: ['zh-CN'], voices};
  }

  async fingerprint(): Promise<string> {
    const sayStats = await stat('/usr/bin/say');
    return fingerprintValue({
      provider: this.id,
      algorithm: 'macos-say-v1',
      say: {mtimeMs: sayStats.mtimeMs, size: sayStats.size},
    });
  }

  async synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsResult> {
    const aiffPath = `${input.outputPath}.aiff`;
    await ensureParentDirectory(this.#runDirectory, aiffPath);
    const aiffHandle = await openNewRunReadWriteFile(this.#runDirectory, aiffPath);
    try {
      await this.#runner('/usr/bin/say', [
        '-v', input.voice,
        '-r', String(input.rate),
        '-o', `/dev/fd/3`,
        input.text,
      ], {signal, extraStdioFds: [aiffHandle.fd]});
      await aiffHandle.sync();
    } finally {
      await aiffHandle.close();
    }

    const aiffReadHandle = await import('../fs/app-directory-scopes').then(async ({openExistingRunFile}) =>
      await openExistingRunFile(this.#runDirectory, aiffPath));
    try {
      await normalizeToOutput({
        runDirectory: this.#runDirectory,
        outputPath: input.outputPath,
        ffmpegExecutable: this.#ffmpegExecutable,
        runner: this.#runner,
        signal,
        inputFd: aiffReadHandle.fd,
        inputArgs: ['-i', '/dev/fd/3'],
      });
    } finally {
      await aiffReadHandle.close();
    }
    return {outputPath: input.outputPath, providerFingerprint: await this.fingerprint()};
  }
}
