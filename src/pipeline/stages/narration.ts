import type {FileHandle} from 'node:fs/promises';
import type {ProjectInputs} from '../../domain/load-project';
import type {CaptionsManifest, NarrationManifest} from '../../domain/manifest-schema';
import {buildCaptions} from '../../captions/build-captions';
import {formatSrt} from '../../captions/srt';
import {
  openNewRunFile,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {buildNarration, type BuildNarrationInput} from '../../narration/build-narration';
import type {TtsProvider} from '../../providers/tts';

export interface NarrationStageInput extends ProjectInputs {
  runDirectory: RunDirectoryScope;
  provider: TtsProvider;
  signal?: AbortSignal;
  onPartialArtifact?: (relativePath: string) => void;
}

export interface NarrationStageFileSystem {
  openNewRunFile(scope: RunDirectoryScope, relativePath: string): Promise<FileHandle>;
}

export interface NarrationStageDependencies {
  fileSystem: NarrationStageFileSystem;
  buildNarration(input: BuildNarrationInput): Promise<NarrationManifest>;
}

export const createSystemNarrationStageDependencies = (): NarrationStageDependencies => ({
  fileSystem: {openNewRunFile},
  buildNarration,
});

const writeRunText = async (
  runDirectory: RunDirectoryScope,
  fileSystem: NarrationStageFileSystem,
  relativePath: string,
  contents: string,
): Promise<void> => {
  const handle = await fileSystem.openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const runNarration = async (
  input: NarrationStageInput,
  dependencies = createSystemNarrationStageDependencies(),
): Promise<{
  narrationPath: 'narration-manifest.json';
  captionsPath: 'captions.json';
  srtPath: 'captions.srt';
  narration: NarrationManifest;
  captions: CaptionsManifest;
}> => {
  const narration = await dependencies.buildNarration(input);
  const captions = buildCaptions({
    script: input.script,
    narration,
    sourceNarrationHash: narration.master.audioHash,
  });
  await writeRunText(
    input.runDirectory,
    dependencies.fileSystem,
    'narration-manifest.json',
    `${JSON.stringify(narration, null, 2)}\n`,
  );
  await writeRunText(
    input.runDirectory,
    dependencies.fileSystem,
    'captions.json',
    `${JSON.stringify(captions, null, 2)}\n`,
  );
  await writeRunText(
    input.runDirectory,
    dependencies.fileSystem,
    'captions.srt',
    formatSrt(captions),
  );
  return {
    narrationPath: 'narration-manifest.json',
    captionsPath: 'captions.json',
    srtPath: 'captions.srt',
    narration,
    captions,
  };
};
