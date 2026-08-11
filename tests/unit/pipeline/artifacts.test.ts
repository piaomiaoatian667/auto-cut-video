import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createOutputStore,
  createRunStore,
  ensureOutputDirectory,
  ensureRunDirectory,
  openExistingRunFile,
  openNewOutputFile,
  openNewRunFile,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  copyRunArtifact,
  hashRunArtifact,
  verifyOutputArtifact,
  verifyRunArtifact,
} from '../../../src/pipeline/artifacts';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const makeWorkspace = async (): Promise<string> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'pipeline-artifacts-'));
  tempDirectories.push(workspaceRoot);
  return workspaceRoot;
};

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

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

const writeOutputBytes = async (
  outputDirectory: OutputDirectoryScope,
  relativePath: string,
  bytes: Buffer,
): Promise<void> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureOutputDirectory(outputDirectory, parent);
  const handle = await openNewOutputFile(outputDirectory, relativePath);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

describe('pipeline artifacts', () => {
  it('copies a Run artifact with fresh handles and verifies the hash', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    const sourceRun = await store.createRun('demo', 'source-run');
    const targetRun = await store.createRun('demo', 'target-run');
    const relativePath = 'audio/cache/key.wav';
    const bytes = Buffer.from('fresh source artifact');
    await writeRunBytes(sourceRun, relativePath, bytes);
    const sourceArtifact = await hashRunArtifact(sourceRun, relativePath);

    const artifact = await copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: sourceArtifact,
    });

    expect(artifact).toEqual({
      scope: 'run',
      path: relativePath,
      sha256: sha256(bytes),
    });
    await expect(verifyRunArtifact(targetRun, artifact)).resolves.toBe(true);
    const copied = await openExistingRunFile(targetRun, relativePath);
    try {
      await expect(copied.readFile()).resolves.toEqual(bytes);
    } finally {
      await copied.close();
    }
  });

  it('refuses an output artifact in the Run copy API', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    const sourceRun = await store.createRun('demo', 'source-run');
    const targetRun = await store.createRun('demo', 'target-run');

    await expect(copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: {
        scope: 'output',
        path: 'releases/run/final.mp4',
        sha256: sha256(Buffer.from('release')),
      },
    })).rejects.toMatchObject({code: 'ARTIFACT_SCOPE_INVALID'});
  });

  it('removes a copied Run artifact when its source report hash mismatches', async () => {
    const workspaceRoot = await makeWorkspace();
    const store = createRunStore(workspaceRoot);
    const sourceRun = await store.createRun('demo', 'source-run');
    const targetRun = await store.createRun('demo', 'target-run');
    const relativePath = 'cache/segment.wav';
    await writeRunBytes(sourceRun, relativePath, Buffer.from('source bytes'));

    await expect(copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: {
        scope: 'run',
        path: relativePath,
        sha256: sha256(Buffer.from('different bytes')),
      },
    })).rejects.toMatchObject({code: 'ARTIFACT_HASH_MISMATCH'});
    await expect(openExistingRunFile(targetRun, relativePath))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('verifies an Output artifact only in Output scope', async () => {
    const workspaceRoot = await makeWorkspace();
    const outputDirectory = await createOutputStore(workspaceRoot)
      .openProject('demo');
    const relativePath = 'releases/run/final.mp4';
    const bytes = Buffer.from('published release');
    await writeOutputBytes(outputDirectory, relativePath, bytes);
    const artifact = {
      scope: 'output' as const,
      path: relativePath,
      sha256: sha256(bytes),
    };

    await expect(verifyOutputArtifact(outputDirectory, artifact))
      .resolves.toBe(true);
    await expect(verifyRunArtifact({} as RunDirectoryScope, artifact))
      .rejects.toMatchObject({code: 'ARTIFACT_SCOPE_INVALID'});
  });
});
