import {NarrationManifestSchema, type NarrationManifest} from '../domain/manifest-schema';
import type {Script} from '../domain/script-schema';
import {
  openExistingRunFileForRead,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import {narrationSegmentInputHash} from '../narration/build-narration';
import {
  copyRunArtifact,
  hashRunArtifact,
  type PipelineArtifact,
} from './artifacts';

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const readNarrationManifest = async (
  sourceRun: RunDirectoryScope,
): Promise<NarrationManifest> => {
  const authority = await openExistingRunFileForRead(
    sourceRun,
    'narration-manifest.json',
  );
  try {
    const manifest = NarrationManifestSchema.parse(JSON.parse(
      await authority.handle.readFile('utf8'),
    ));
    await authority.revalidate();
    return manifest;
  } finally {
    await authority.close();
  }
};

const narrationCachePath = (inputHash: string): string =>
  `audio/cache/${inputHash.slice('sha256:'.length)}.wav`;

export async function seedNarrationCache(input: {
  sourceRun: RunDirectoryScope;
  targetRun: RunDirectoryScope;
  script: Script;
  voice: string;
  rate: number;
  providerFingerprint: string;
}): Promise<string[]> {
  const sourceManifest = await readNarrationManifest(input.sourceRun);
  const allowedHashes = new Set(input.script.segments.map((segment) => (
    narrationSegmentInputHash(
      segment,
      input.voice,
      input.rate,
      input.providerFingerprint,
    )
  )));
  const cachePaths = [...new Set(sourceManifest.segments
    .map((segment) => segment.inputHash)
    .filter((inputHash) => allowedHashes.has(inputHash)))]
    .map(narrationCachePath)
    .sort();
  const copiedPaths: string[] = [];

  for (const cachePath of cachePaths) {
    let artifact: PipelineArtifact;
    try {
      artifact = await hashRunArtifact(input.sourceRun, cachePath);
    } catch (error) {
      if (isMissingFile(error)) continue;
      throw error;
    }
    const copied = await copyRunArtifact({
      sourceRun: input.sourceRun,
      targetRun: input.targetRun,
      artifact,
    });
    copiedPaths.push(copied.path);
  }

  return copiedPaths.sort();
}
