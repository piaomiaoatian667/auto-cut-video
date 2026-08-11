import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {NarrationManifest} from '../../../src/domain/manifest-schema';
import type {Script} from '../../../src/domain/script-schema';
import {
  createRunStore,
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunFile,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {narrationSegmentInputHash} from '../../../src/narration/build-narration';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {seedNarrationCache} from '../../../src/pipeline/narration-cache';

const tempDirectories: string[] = [];
const voice = 'fixture';
const rate = 180;
const providerFingerprint = fingerprintValue({provider: 'fixture'});

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const makeRuns = async (): Promise<{
  sourceRun: RunDirectoryScope;
  targetRun: RunDirectoryScope;
}> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'narration-cache-'));
  tempDirectories.push(workspaceRoot);
  const store = createRunStore(workspaceRoot);
  return {
    sourceRun: await store.createRun('demo', 'source-run'),
    targetRun: await store.createRun('demo', 'target-run'),
  };
};

const script = (secondText = '第二句'): Script => ({
  version: 1,
  language: 'zh-CN',
  segments: [
    {
      id: 'intro',
      text: '第一句',
      normalizedText: '第一句',
      pauseAfterMs: 250,
      requiredTerms: [],
    },
    {
      id: 'outro',
      text: secondText,
      normalizedText: secondText,
      pauseAfterMs: 0,
      requiredTerms: [],
    },
  ],
});

const inputHash = (value: Script, index: number): string =>
  narrationSegmentInputHash(
    value.segments[index]!,
    voice,
    rate,
    providerFingerprint,
  );

const cachePath = (hash: string): string =>
  `audio/cache/${hash.replace(/^sha256:/u, '')}.wav`;

const manifest = (value: Script): NarrationManifest => ({
  version: 1,
  provider: 'mock',
  segments: value.segments.map((segment, index) => ({
    id: segment.id,
    inputHash: inputHash(value, index),
    audioPath: `audio/segments/${segment.id}.wav`,
    audioHash: fingerprintValue({segment: segment.id}),
    startMs: index * 1000,
    endMs: (index + 1) * 1000,
    durationMs: 1000,
    pauseAfterMs: segment.pauseAfterMs,
    sampleRate: 48_000,
    channels: 1,
    providerFingerprint,
  })),
  master: {
    audioPath: 'audio/narration.wav',
    audioHash: fingerprintValue({master: true}),
    durationMs: 2000,
  },
});

const writeRunBytes = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  bytes: Buffer,
): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeManifest = async (
  runDirectory: RunDirectoryScope,
  value: unknown,
): Promise<void> => {
  await writeRunBytes(
    runDirectory,
    'narration-manifest.json',
    Buffer.from(`${JSON.stringify(value, null, 2)}\n`),
  );
};

const readRunBytes = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<Buffer> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const runFileExists = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<boolean> => {
  try {
    const handle = await openExistingRunFile(runDirectory, relativePath);
    await handle.close();
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
};

describe('seedNarrationCache', () => {
  it('copies only unchanged segment cache WAVs into the target Run', async () => {
    const {sourceRun, targetRun} = await makeRuns();
    const oldScript = script();
    const newScript = script('改过的第二句');
    const firstPath = cachePath(inputHash(oldScript, 0));
    const oldSecondPath = cachePath(inputHash(oldScript, 1));
    const stalePath = 'audio/cache/stale.wav';
    await writeManifest(sourceRun, manifest(oldScript));
    await writeRunBytes(sourceRun, firstPath, Buffer.from('first cache'));
    await writeRunBytes(sourceRun, oldSecondPath, Buffer.from('old second cache'));
    await writeRunBytes(sourceRun, stalePath, Buffer.from('stale cache'));

    const copied = await seedNarrationCache({
      sourceRun,
      targetRun,
      script: newScript,
      voice,
      rate,
      providerFingerprint,
    });

    expect(copied).toEqual([firstPath]);
    await expect(readRunBytes(targetRun, firstPath))
      .resolves.toEqual(Buffer.from('first cache'));
    await expect(runFileExists(targetRun, oldSecondPath)).resolves.toBe(false);
    await expect(runFileExists(targetRun, stalePath)).resolves.toBe(false);
  });

  it('returns copied cache paths in sorted order', async () => {
    const {sourceRun, targetRun} = await makeRuns();
    const unchangedScript = script();
    const sourceManifest = manifest(unchangedScript);
    sourceManifest.segments.reverse();
    const expectedPaths = sourceManifest.segments
      .map((segment) => cachePath(segment.inputHash))
      .sort();
    await writeManifest(sourceRun, sourceManifest);
    for (const cacheFile of expectedPaths) {
      await writeRunBytes(sourceRun, cacheFile, Buffer.from(cacheFile));
    }

    const copied = await seedNarrationCache({
      sourceRun,
      targetRun,
      script: unchangedScript,
      voice,
      rate,
      providerFingerprint,
    });

    expect(copied).toEqual(expectedPaths);
  });

  it('skips unchanged manifest entries whose old cache WAV is missing', async () => {
    const {sourceRun, targetRun} = await makeRuns();
    const unchangedScript = script();
    const firstPath = cachePath(inputHash(unchangedScript, 0));
    const missingPath = cachePath(inputHash(unchangedScript, 1));
    await writeManifest(sourceRun, manifest(unchangedScript));
    await writeRunBytes(sourceRun, firstPath, Buffer.from('first cache'));

    const copied = await seedNarrationCache({
      sourceRun,
      targetRun,
      script: unchangedScript,
      voice,
      rate,
      providerFingerprint,
    });

    expect(copied).toEqual([firstPath]);
    await expect(runFileExists(targetRun, missingPath)).resolves.toBe(false);
  });

  it('rejects an invalid source narration manifest', async () => {
    const {sourceRun, targetRun} = await makeRuns();
    await writeManifest(sourceRun, {version: 1, provider: 'mock'});

    await expect(seedNarrationCache({
      sourceRun,
      targetRun,
      script: script(),
      voice,
      rate,
      providerFingerprint,
    })).rejects.toMatchObject({name: 'ZodError'});
  });

  it('fails closed when an unchanged cache path is not a regular file', async () => {
    const {sourceRun, targetRun} = await makeRuns();
    const unchangedScript = script();
    const firstPath = cachePath(inputHash(unchangedScript, 0));
    await writeManifest(sourceRun, manifest(unchangedScript));
    await ensureRunDirectory(sourceRun, firstPath);

    await expect(seedNarrationCache({
      sourceRun,
      targetRun,
      script: unchangedScript,
      voice,
      rate,
      providerFingerprint,
    })).rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(runFileExists(targetRun, firstPath)).resolves.toBe(false);
  });
});
