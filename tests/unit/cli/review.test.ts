import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {
  createRunStore,
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunFile,
} from '../../../src/fs/app-directory-scopes';
import {runReviewCommand} from '../../../src/cli/commands/review';
import {runVideoctl, type VideoctlDependencies} from '../../../src/cli/videoctl';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {PipelineArtifactError} from '../../../src/pipeline/artifacts';
import {createEditFixture, createProjectFixture, createScriptFixture} from '../../helpers/temp-project';
import type {ProjectInputs} from '../../../src/domain/load-project';

const tempDirectories: string[] = [];

const sha256 = (value: Buffer | string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) =>
    await rm(directory, {recursive: true, force: true})));
});

const writeRunJson = async (workspaceRoot: string, runId: string, relativePath: string, value: unknown) => {
  const run = await createRunStore(workspaceRoot).openExistingRun('demo', runId);
  await ensureRunDirectory(run, path.posix.dirname(relativePath));
  const handle = await openNewRunFile(run, relativePath);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const readRunJson = async (workspaceRoot: string, runId: string, relativePath: string) => {
  const run = await createRunStore(workspaceRoot).openExistingRun('demo', runId);
  const handle = await openExistingRunFile(run, relativePath);
  try {
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
};

const writeRunText = async (
  workspaceRoot: string,
  runId: string,
  relativePath: string,
  contents: string,
): Promise<string> => {
  const run = await createRunStore(workspaceRoot).openExistingRun('demo', runId);
  await ensureRunDirectory(run, path.posix.dirname(relativePath));
  const handle = await openNewRunFile(run, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sha256(contents);
};

const makeFixture = async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'videoctl-review-'));
  tempDirectories.push(workspaceRoot);
  const store = createRunStore(workspaceRoot);
  const runId = 'run-review';
  await store.createRun('demo', runId);
  const draftVideoSha = await writeRunText(
    workspaceRoot,
    runId,
    'draft/draft.mp4',
    'draft-video',
  );
  const contactSheetSha = await writeRunText(
    workspaceRoot,
    runId,
    'draft/contact-sheet.jpg',
    'contact-sheet',
  );
  const reviewFrameSha = await writeRunText(
    workspaceRoot,
    runId,
    'draft/frames/frame-000000.jpg',
    'review-frame',
  );
  await writeRunJson(workspaceRoot, runId, 'draft/draft-report.json', {
    version: 1,
    projectId: 'demo',
    outputs: {
      draftVideo: {path: 'draft/draft.mp4', sha256: draftVideoSha},
      contactSheet: {path: 'draft/contact-sheet.jpg', sha256: contactSheetSha},
      reviewFrames: [{path: 'draft/frames/frame-000000.jpg', sha256: reviewFrameSha}],
      audio: {
        filterGraph: {path: 'audio/filter-graph.txt', sha256: sha256('filter-graph')},
        mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: sha256('mixed-audio')},
      },
    },
  });
  await store.publishCurrent('demo', {
    runId,
    relativePath: `runs/${runId}`,
    preset: 'draft',
    stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review'],
    completedStage: 'review',
    state: 'needs_review',
    publishedAt: '2026-08-10T00:00:00.000Z',
  });

  let stdout = '';
  let stderr = '';
  const projectInputs = {
    workspaceRoot,
    projectDirectory: undefined as never,
    project: createProjectFixture('demo'),
    script: createScriptFixture(),
    edit: createEditFixture(),
  } satisfies ProjectInputs;
  const dependencies: VideoctlDependencies = {
    workspaceRoot,
    stdout: {write: (chunk) => { stdout += chunk; }},
    stderr: {write: (chunk) => { stderr += chunk; }},
    loadProject: vi.fn(async () => projectInputs),
    sourceCatalog: {
      listSourceFiles: vi.fn(async () => []),
      hashProjectFile: vi.fn(async () => 'sha256:not-used'),
    },
    preflight: vi.fn(async () => { throw new Error('unused'); }),
  };
  return {
    workspaceRoot,
    runId,
    dependencies,
    stdout: () => stdout,
    stderr: () => stderr,
    runRoot: path.join(workspaceRoot, '.work', 'demo', 'runs', runId),
  };
};

describe('videoctl review', () => {
  it('approves the current draft run and writes review.json', async () => {
    const fixture = await makeFixture();

    const exitCode = await runVideoctl([
      'review', 'demo', '--approve', '--reason', 'looks good', '--reviewer', 'tester',
    ], fixture.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.stdout()).toBe('Review approved: run-review\n');
    expect(fixture.stderr()).toBe('');
    expect(await readRunJson(fixture.workspaceRoot, fixture.runId, 'review.json')).toMatchObject({
      version: 1,
      projectId: 'demo',
      runId: 'run-review',
      status: 'approved',
      reviewer: 'tester',
      reason: 'looks good',
      evidencePaths: ['draft/draft.mp4', 'draft/contact-sheet.jpg', 'draft/frames/frame-000000.jpg'],
    });
  });

  it.each([
    ['missing', async (fixture: Awaited<ReturnType<typeof makeFixture>>) => {
      await rm(path.join(fixture.runRoot, 'draft/draft.mp4'));
    }],
    ['changed', async (fixture: Awaited<ReturnType<typeof makeFixture>>) => {
      await writeFile(path.join(fixture.runRoot, 'draft/draft.mp4'), 'changed');
    }],
    ['cross-scope symlink', async (fixture: Awaited<ReturnType<typeof makeFixture>>) => {
      const outsidePath = path.join(fixture.workspaceRoot, 'outside-draft.mp4');
      await writeFile(outsidePath, 'draft-video');
      await rm(path.join(fixture.runRoot, 'draft/draft.mp4'));
      await symlink(outsidePath, path.join(fixture.runRoot, 'draft/draft.mp4'));
    }],
  ])('rejects %s Draft review evidence', async (_label, mutateEvidence) => {
    const fixture = await makeFixture();
    await mutateEvidence(fixture);

    const exitCode = await runVideoctl([
      'review', 'demo', '--approve', '--reason', 'looks good', '--reviewer', 'tester',
    ], fixture.dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stdout()).toBe('');
    await expect(createRunStore(fixture.workspaceRoot).readCurrent('demo'))
      .resolves.toMatchObject({state: 'needs_review'});
  });

  it('maps concurrent artifact mutation to validation failure', async () => {
    const fixture = await makeFixture();

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reason: 'looks good', reviewer: 'tester'},
      {
        ...fixture.dependencies,
        verifyRunArtifact: async () => {
          throw new PipelineArtifactError(
            'ARTIFACT_INVALID',
            'artifact identity changed while reading',
          );
        },
      },
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    await expect(createRunStore(fixture.workspaceRoot).readCurrent('demo'))
      .resolves.toMatchObject({state: 'needs_review'});
  });

  it('propagates unrelated artifact verification I/O failures', async () => {
    const fixture = await makeFixture();
    const failure = Object.assign(new Error('artifact read failed'), {code: 'EIO'});

    await expect(runReviewCommand(
      'demo',
      {approve: true, reason: 'looks good', reviewer: 'tester'},
      {
        ...fixture.dependencies,
        verifyRunArtifact: async () => { throw failure; },
      },
    )).rejects.toBe(failure);
  });
});
