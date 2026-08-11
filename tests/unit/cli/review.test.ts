import {afterEach, describe, expect, it, vi} from 'vitest';
import {rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {
  createRunStore,
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunFile,
} from '../../../src/fs/app-directory-scopes';
import {runVideoctl, type VideoctlDependencies} from '../../../src/cli/videoctl';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {createEditFixture, createProjectFixture, createScriptFixture} from '../../helpers/temp-project';
import type {ProjectInputs} from '../../../src/domain/load-project';

const tempDirectories: string[] = [];

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

const makeFixture = async () => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'videoctl-review-'));
  tempDirectories.push(workspaceRoot);
  const store = createRunStore(workspaceRoot);
  const runId = 'run-review';
  await store.createRun('demo', runId);
  await writeRunJson(workspaceRoot, runId, 'draft/draft-report.json', {
    version: 1,
    outputs: {
      draftVideo: {path: 'draft/draft.mp4', sha256: 'sha256:draft'},
      contactSheet: {path: 'draft/contact-sheet.jpg', sha256: 'sha256:sheet'},
      reviewFrames: [{path: 'draft/frames/frame-000000.jpg', sha256: 'sha256:frame'}],
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
  return {workspaceRoot, runId, dependencies, stdout: () => stdout, stderr: () => stderr};
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
});
