import {NarrationManifestSchema, type NarrationManifest} from '../domain/manifest-schema';
import type {Script} from '../domain/script-schema';
import {
  openExistingRunFileForRead,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import {narrationSegmentInputHash} from '../narration/build-narration';
import {fingerprintTtsProvider} from '../providers/tts';
import {
  copyRunArtifact,
  type PipelineArtifact,
} from './artifacts';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

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
  sourceManifest?: NarrationManifest;
  sourceArtifacts: readonly PipelineArtifact[];
}): Promise<string[]> {
  const sourceManifest = input.sourceManifest
    ?? await readNarrationManifest(input.sourceRun);
  validateCompatibility(sourceManifest, input.providerFingerprint);
  const manifestProviderFingerprint = await fingerprintTtsProvider(
    sourceManifest.provider,
  );
  if (manifestProviderFingerprint !== input.providerFingerprint) {
    throw new Error('manifest provider fingerprint does not match current provider');
  }
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
  const artifactsByPath = new Map(input.sourceArtifacts
    .filter((artifact) => artifact.scope === 'run')
    .map((artifact) => [artifact.path, artifact]));

  for (const cachePath of cachePaths) {
    const artifact = artifactsByPath.get(cachePath);
    if (artifact === undefined) continue;
    requireSha256(artifact.sha256, `source artifact hash for ${cachePath}`);
    const copied = await copyRunArtifact({
      sourceRun: input.sourceRun,
      targetRun: input.targetRun,
      artifact,
    });
    copiedPaths.push(copied.path);
  }

  return copiedPaths.sort();
}
