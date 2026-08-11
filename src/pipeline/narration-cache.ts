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

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const requireSha256 = (value: string, label: string): void => {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error(`invalid SHA-256 ${label}`);
  }
};

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

const validateCompatibility = (
  sourceManifest: NarrationManifest,
  providerFingerprint: string,
): void => {
  requireSha256(providerFingerprint, 'provider fingerprint');
  requireSha256(sourceManifest.master.audioHash, 'master audio hash');
  const inputHashes = new Set<string>();

  for (const segment of sourceManifest.segments) {
    requireSha256(segment.inputHash, `input hash for segment ${segment.id}`);
    requireSha256(segment.audioHash, `audio hash for segment ${segment.id}`);
    requireSha256(
      segment.providerFingerprint,
      `provider fingerprint for segment ${segment.id}`,
    );
    if (inputHashes.has(segment.inputHash)) {
      throw new Error(`duplicate narration segment input hash: ${segment.inputHash}`);
    }
    inputHashes.add(segment.inputHash);
  }

  for (const segment of sourceManifest.segments) {
    if (segment.providerFingerprint !== providerFingerprint) {
      throw new Error(`provider fingerprint mismatch for segment ${segment.id}`);
    }
  }
};

export async function seedNarrationCache(input: {
  sourceRun: RunDirectoryScope;
  targetRun: RunDirectoryScope;
  script: Script;
  voice: string;
  rate: number;
  providerFingerprint: string;
}): Promise<string[]> {
  const sourceManifest = await readNarrationManifest(input.sourceRun);
  validateCompatibility(sourceManifest, input.providerFingerprint);
  if (sourceManifest.provider === 'file') return [];

  const expectedHashesById = new Map(input.script.segments.map((segment) => [
    segment.id,
    narrationSegmentInputHash(
      segment,
      input.voice,
      input.rate,
      input.providerFingerprint,
    ),
  ]));
  const cachePaths = [...new Set(sourceManifest.segments
    .filter((segment) => expectedHashesById.get(segment.id) === segment.inputHash)
    .map((segment) => segment.inputHash))]
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
