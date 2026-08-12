import {createHash} from 'node:crypto';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {readdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {mkdtemp} from 'node:fs/promises';
import {
  createRunStore,
  ensureRunDirectory,
  linkRunFile,
  openExistingRunFile,
  openNewRunFile,
  openNewRunFileForWrite,
  unlinkRunFile,
  type AppDirectoryWriteFileAuthority,
  type RunDirectoryScope,
  type WorkDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {runReviewCommand} from '../../../src/cli/commands/review';
import {runVideoctl, type VideoctlDependencies} from '../../../src/cli/videoctl';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {PipelineArtifactError} from '../../../src/pipeline/artifacts';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {STAGE_PRESETS} from '../../../src/pipeline/presets';
import {
  createStageReportStore,
  StageReportSchema,
} from '../../../src/pipeline/stage-report';
import {STAGE_ALGORITHM_VERSIONS} from '../../../src/pipeline/stage-adapters/shared';
import type {ProjectLockLease} from '../../../src/pipeline/project-lock';
import {
  DraftReportSchema,
  draftReviewEvidenceArtifacts,
} from '../../../src/pipeline/stages/draft';
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
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(run, parent);
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
  const runDirectory = await store.createRun('demo', runId);
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
  const draftReport = DraftReportSchema.parse({
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
  await writeRunJson(workspaceRoot, runId, 'draft/draft-report.json', draftReport);
  const evidence = draftReviewEvidenceArtifacts(draftReport);
  const reviewFingerprint = fingerprintValue({
    algorithmVersion: STAGE_ALGORITHM_VERSIONS.review,
    evidence,
  });
  const reviewAttempt = StageReportSchema.parse({
    version: 1,
    projectId: 'demo',
    runId,
    preset: 'release',
    stageId: 'review',
    position: 6,
    total: 7,
    state: 'needs_review',
    fingerprint: reviewFingerprint,
    startedAt: '2026-08-11T00:00:00.000Z',
    finishedAt: '2026-08-11T00:00:01.000Z',
    artifacts: [],
    outputs: {evidence, review: null},
    checks: [{
      id: 'draft-review-required',
      severity: 'warning',
      message: 'Draft review approval is required before Release.',
      requiresReview: true,
      affectedPaths: evidence.map((artifact) => artifact.path),
    }],
  });
  const reviewAttemptId = await createStageReportStore()
    .writeAttempt(runDirectory, reviewAttempt);
  await store.publishCurrent('demo', {
    runId,
    relativePath: `runs/${runId}`,
    preset: 'release',
    stageIds: [...STAGE_PRESETS.release],
    completedStage: 'review',
    state: 'needs_review',
    publishedAt: '2026-08-11T00:00:01.000Z',
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
    discoverProjectSourceCatalog: vi.fn(async () => { throw new Error('unused'); }),
    buildExecutionPlan: vi.fn(async () => { throw new Error('unused'); }),
    runExecutionPlan: vi.fn(async () => { throw new Error('unused'); }),
    installPipelineSignalHandlers: vi.fn(() => ({
      signal: new AbortController().signal,
      dispose: vi.fn(),
    })),
  };
  return {
    workspaceRoot,
    runId,
    dependencies,
    stdout: () => stdout,
    stderr: () => stderr,
    runRoot: path.join(workspaceRoot, '.work', 'demo', 'runs', runId),
    evidence,
    reviewAttempt,
    reviewAttemptPath: `reports/attempts/${reviewAttemptId}.json`,
    reviewFingerprint,
  };
};

const expectNoCanonicalApproval = async (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
): Promise<void> => {
  await expect(readFile(path.join(fixture.runRoot, 'review.json'), 'utf8'))
    .rejects.toMatchObject({code: 'ENOENT'});
  const runDirectory = await createRunStore(fixture.workspaceRoot)
    .openExistingRun('demo', fixture.runId);
  await expect(createStageReportStore().readStage(runDirectory, 'review'))
    .resolves.toBeNull();
};

const changeDraftVideoEvidence = async (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
) => {
  const draftReport = DraftReportSchema.parse(await readRunJson(
    fixture.workspaceRoot,
    fixture.runId,
    'draft/draft-report.json',
  ));
  const changedBytes = 'changed-draft-video';
  await writeFile(path.join(fixture.runRoot, 'draft/draft.mp4'), changedBytes);
  const changed = DraftReportSchema.parse({
    ...draftReport,
    outputs: {
      ...draftReport.outputs,
      draftVideo: {
        ...draftReport.outputs.draftVideo,
        sha256: sha256(changedBytes),
      },
    },
  });
  await writeFile(
    path.join(fixture.runRoot, 'draft/draft-report.json'),
    `${JSON.stringify(changed, null, 2)}\n`,
    'utf8',
  );
  return changed;
};

describe('videoctl review', () => {
  it('approves the current run, writes a canonical Review report, and preserves the attempt', async () => {
    const fixture = await makeFixture();
    const beforePointer = await createRunStore(fixture.workspaceRoot).readCurrent('demo');

    const exitCode = await runVideoctl([
      'review', 'demo', '--approve', '--reason', 'looks good',
    ], fixture.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.stdout()).toBe('Review approved: run-review\n');
    expect(fixture.stderr()).toBe('');
    expect(await readRunJson(fixture.workspaceRoot, fixture.runId, 'review.json')).toMatchObject({
      version: 1,
      projectId: 'demo',
      runId: 'run-review',
      status: 'approved',
      reviewer: process.env.USER ?? 'unknown',
      reason: 'looks good',
      evidencePaths: ['draft/draft.mp4', 'draft/contact-sheet.jpg', 'draft/frames/frame-000000.jpg'],
    });
    const runDirectory = await createRunStore(fixture.workspaceRoot)
      .openExistingRun('demo', fixture.runId);
    const canonical = await createStageReportStore().readStage(runDirectory, 'review');
    expect(canonical).toMatchObject({
      projectId: 'demo',
      runId: fixture.runId,
      preset: 'release',
      stageId: 'review',
      position: 6,
      total: 7,
      state: 'passed',
      fingerprint: fixture.reviewFingerprint,
      artifacts: [],
      outputs: {
        evidence: fixture.evidence,
        review: {
          projectId: 'demo',
          runId: fixture.runId,
          status: 'approved',
          reviewer: process.env.USER ?? 'unknown',
          reason: 'looks good',
        },
      },
      checks: [{
        id: 'draft-review-approved',
        severity: 'info',
        message: 'Draft review is approved.',
      }],
    });
    expect(await readRunJson(
      fixture.workspaceRoot,
      fixture.runId,
      fixture.reviewAttemptPath,
    )).toEqual(fixture.reviewAttempt);
    const afterPointer = await createRunStore(fixture.workspaceRoot).readCurrent('demo');
    expect(afterPointer).toMatchObject({
      runId: beforePointer!.runId,
      preset: beforePointer!.preset,
      stageIds: beforePointer!.stageIds,
      completedStage: beforePointer!.completedStage,
      state: 'passed',
    });
    await expect(readFile(
      path.join(fixture.workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).rejects.toMatchObject({code: 'ENOENT'});
  });

  it.each(['write', 'fsync'] as const)(
    'rolls back a failed review.json %s and allows a clean retry',
    async (failurePoint) => {
      const fixture = await makeFixture();
      const failure = Object.assign(
        new Error(`${failurePoint} failed`),
        {code: failurePoint === 'write' ? 'ENOSPC' : 'EIO'},
      );
      const openedPaths: string[] = [];
      const openReviewTemp = vi.fn(async (
        run: RunDirectoryScope,
        relativePath: string,
      ): Promise<AppDirectoryWriteFileAuthority> => {
        openedPaths.push(relativePath);
        const authority = await openNewRunFileForWrite(run, relativePath);
        if (failurePoint === 'write') {
          return {
            ...authority,
            handle: {
              writeFile: async () => {
                await authority.handle.writeFile('{"partial"', 'utf8');
                throw failure;
              },
            } as unknown as AppDirectoryWriteFileAuthority['handle'],
          };
        }
        return {
          ...authority,
          syncAndSeal: async () => { throw failure; },
        };
      });
      const dependencies = {
        ...fixture.dependencies,
        reviewFileOps: {
          openNewRunFileForWrite: openReviewTemp,
          createTempId: () => `failed-${failurePoint}`,
        },
      };

      await expect(runReviewCommand(
        'demo',
        {approve: true, reason: 'looks good', reviewer: 'tester'},
        dependencies,
      )).rejects.toBe(failure);

      expect(openedPaths).toEqual([`.review.json.failed-${failurePoint}.tmp`]);
      const runEntries = await readdir(fixture.runRoot);
      expect(runEntries).not.toContain('review.json');
      expect(runEntries.some((entry) => entry.startsWith('.review.json.'))).toBe(false);
      await expect(createRunStore(fixture.workspaceRoot).readCurrentReadonly('demo'))
        .resolves.toMatchObject({state: 'needs_review'});
      await expectNoCanonicalApproval(fixture);

      const retry = await runReviewCommand(
        'demo',
        {approve: true, reason: 'retry accepted', reviewer: 'tester'},
        {...fixture.dependencies, now: () => '2026-08-11T00:20:00.000Z'},
      );
      expect(retry).toBe(EXIT_CODES.success);
      await expect(readRunJson(fixture.workspaceRoot, fixture.runId, 'review.json'))
        .resolves.toMatchObject({reason: 'retry accepted'});
    },
  );

  it('preserves an unknown review.json commit and replaces the orphan on retry', async () => {
    const fixture = await makeFixture();
    const commitSyncFailure = new Error('commit parent sync failed');
    const recoverySyncFailure = new Error('recovery parent sync failed');
    let syncCalls = 0;
    const linkReviewTemp = vi.fn(async (
      run: RunDirectoryScope,
      sourceRelativePath: string,
      targetRelativePath: string,
      sourceAuthority: AppDirectoryWriteFileAuthority,
    ) => {
      const authority = await linkRunFile(
        run,
        sourceRelativePath,
        targetRelativePath,
        sourceAuthority,
      );
      return {
        ...authority,
        syncParent: async () => {
          syncCalls += 1;
          throw syncCalls === 1 ? commitSyncFailure : recoverySyncFailure;
        },
      };
    });
    const dependencies = {
      ...fixture.dependencies,
      now: () => '2026-08-11T00:10:00.000Z',
      reviewFileOps: {
        linkRunFile: linkReviewTemp,
        createTempId: () => 'unknown-outcome',
      },
    };

    await expect(runReviewCommand(
      'demo',
      {approve: true, reason: 'first approval', reviewer: 'first-reviewer'},
      dependencies,
    )).rejects.toMatchObject({
      name: 'ReviewApprovalOutcomeError',
      code: 'REVIEW_APPROVAL_OUTCOME_UNKNOWN',
      cause: commitSyncFailure,
      errors: [commitSyncFailure, recoverySyncFailure],
    });

    await expect(readRunJson(fixture.workspaceRoot, fixture.runId, 'review.json'))
      .resolves.toMatchObject({reason: 'first approval'});
    const runEntries = await readdir(fixture.runRoot);
    expect(runEntries.some((entry) => entry.startsWith('.review.json.'))).toBe(false);
    const runDirectory = await createRunStore(fixture.workspaceRoot)
      .openExistingRun('demo', fixture.runId);
    await expect(createStageReportStore().readStage(runDirectory, 'review'))
      .resolves.toBeNull();
    await expect(createRunStore(fixture.workspaceRoot).readCurrentReadonly('demo'))
      .resolves.toMatchObject({state: 'needs_review'});

    const retry = await runReviewCommand(
      'demo',
      {approve: true, reason: 'fresh retry', reviewer: 'second-reviewer'},
      {...fixture.dependencies, now: () => '2026-08-11T00:20:00.000Z'},
    );

    expect(retry).toBe(EXIT_CODES.success);
    await expect(readRunJson(fixture.workspaceRoot, fixture.runId, 'review.json'))
      .resolves.toMatchObject({
        reviewer: 'second-reviewer',
        reason: 'fresh retry',
        reviewedAt: '2026-08-11T00:20:00.000Z',
      });
  });

  it('replaces an orphaned approval when same-path evidence hashes changed', async () => {
    const fixture = await makeFixture();
    const oldReview = {
      version: 1 as const,
      projectId: 'demo',
      runId: fixture.runId,
      status: 'approved' as const,
      reviewer: 'old-reviewer',
      reviewedAt: '2026-08-11T00:05:00.000Z',
      reason: 'old approval',
      evidencePaths: fixture.evidence.map((artifact) => artifact.path),
    };
    await writeRunJson(fixture.workspaceRoot, fixture.runId, 'review.json', oldReview);
    const changedDraft = await changeDraftVideoEvidence(fixture);
    const unlinkOrphan = vi.fn(unlinkRunFile);
    const syncRunDirectory = vi.fn(async () => undefined);
    const dependencies = {
      ...fixture.dependencies,
      now: () => '2026-08-11T00:20:00.000Z',
      reviewFileOps: {
        unlinkRunFile: unlinkOrphan,
        syncRunDirectory,
      },
    };

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reason: 'new evidence accepted', reviewer: 'new-reviewer'},
      dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(unlinkOrphan).toHaveBeenCalledWith(expect.anything(), 'review.json');
    expect(syncRunDirectory).toHaveBeenCalledTimes(1);
    const review = await readRunJson(fixture.workspaceRoot, fixture.runId, 'review.json');
    expect(review).toMatchObject({
      reviewer: 'new-reviewer',
      reason: 'new evidence accepted',
      reviewedAt: '2026-08-11T00:20:00.000Z',
    });
    expect(review).not.toEqual(oldReview);
    const runDirectory = await createRunStore(fixture.workspaceRoot)
      .openExistingRun('demo', fixture.runId);
    await expect(createStageReportStore().readStage(runDirectory, 'review'))
      .resolves.toMatchObject({
        outputs: {
          evidence: draftReviewEvidenceArtifacts(changedDraft),
          review,
        },
      });
  });

  it('returns success with a warning when approval committed before lock release failed', async () => {
    const fixture = await makeFixture();
    const releaseFailure = new Error('lock close failed');
    const release = vi.fn(async () => { throw releaseFailure; });
    const acquireProjectLock = vi.fn(async (
      _work: WorkDirectoryScope,
      runId: string,
    ): Promise<ProjectLockLease> => ({
      record: {
        pid: 1,
        hostname: 'test',
        processStart: 'test',
        createdAt: '2026-08-11T00:09:00.000Z',
        runId,
      },
      release,
    }));
    const dependencies = {
      ...fixture.dependencies,
      acquireProjectLock,
      now: () => '2026-08-11T00:10:00.000Z',
    };

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reason: 'looks good', reviewer: 'tester'},
      dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.stdout()).toBe('Review approved: run-review\n');
    expect(fixture.stderr()).toBe(
      'Review approved, but the project lock could not be released.\n',
    );
    expect(release).toHaveBeenCalledTimes(1);
    await expect(createRunStore(fixture.workspaceRoot).readCurrentReadonly('demo'))
      .resolves.toMatchObject({state: 'passed', completedStage: 'review'});
    const runDirectory = await createRunStore(fixture.workspaceRoot)
      .openExistingRun('demo', fixture.runId);
    await expect(createStageReportStore().readStage(runDirectory, 'review'))
      .resolves.toMatchObject({state: 'passed'});
  });

  it('does not approve a stale snapshot after the same Run advances before lock acquisition', async () => {
    const fixture = await makeFixture();
    const store = createRunStore(fixture.workspaceRoot);
    const current = await store.readCurrentReadonly('demo');
    const advanced = {
      ...current!,
      completedStage: 'release' as const,
      state: 'passed' as const,
      publishedAt: '2026-08-11T00:10:00.000Z',
    };
    const release = vi.fn(async () => undefined);
    const verifyArtifact = vi.fn(async () => true);
    const acquireProjectLock = vi.fn(async (
      _work: WorkDirectoryScope,
      runId: string,
    ): Promise<ProjectLockLease> => {
      await store.publishCurrent('demo', advanced);
      return {
        record: {
          pid: 1,
          hostname: 'test',
          processStart: 'test',
          createdAt: '2026-08-11T00:09:00.000Z',
          runId,
        },
        release,
      };
    });
    const dependencies = {
      ...fixture.dependencies,
      acquireProjectLock,
      verifyRunArtifact: verifyArtifact,
    };

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reason: 'looks good', reviewer: 'tester'},
      dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stdout()).toBe('');
    expect(fixture.stderr()).toBe('Current run changed before review approval.\n');
    expect(acquireProjectLock).toHaveBeenCalledWith(expect.anything(), fixture.runId);
    expect(release).toHaveBeenCalledTimes(1);
    expect(verifyArtifact).not.toHaveBeenCalled();
    await expect(store.readCurrentReadonly('demo')).resolves.toEqual(advanced);
    await expectNoCanonicalApproval(fixture);
  });

  it('does not approve a stale snapshot after current switches Runs before lock acquisition', async () => {
    const fixture = await makeFixture();
    const store = createRunStore(fixture.workspaceRoot);
    await store.createRun('demo', 'run-next');
    const current = await store.readCurrentReadonly('demo');
    const switched = {
      ...current!,
      runId: 'run-next',
      relativePath: 'runs/run-next',
      completedStage: 'compile' as const,
      state: 'passed' as const,
      publishedAt: '2026-08-11T00:10:00.000Z',
    };
    const release = vi.fn(async () => undefined);
    const verifyArtifact = vi.fn(async () => true);
    const acquireProjectLock = vi.fn(async (
      _work: WorkDirectoryScope,
      runId: string,
    ): Promise<ProjectLockLease> => {
      await store.publishCurrent('demo', switched);
      return {
        record: {
          pid: 1,
          hostname: 'test',
          processStart: 'test',
          createdAt: '2026-08-11T00:09:00.000Z',
          runId,
        },
        release,
      };
    });
    const dependencies = {
      ...fixture.dependencies,
      acquireProjectLock,
      verifyRunArtifact: verifyArtifact,
    };

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reason: 'looks good', reviewer: 'tester'},
      dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stdout()).toBe('');
    expect(fixture.stderr()).toBe('Current run changed before review approval.\n');
    expect(acquireProjectLock).toHaveBeenCalledWith(expect.anything(), fixture.runId);
    expect(release).toHaveBeenCalledTimes(1);
    expect(verifyArtifact).not.toHaveBeenCalled();
    await expect(store.readCurrentReadonly('demo')).resolves.toEqual(switched);
    await expectNoCanonicalApproval(fixture);
  });

  it('preserves approval and lock-release failures together', async () => {
    const fixture = await makeFixture();
    const primaryFailure = Object.assign(new Error('artifact read failed'), {code: 'EIO'});
    const releaseFailure = new Error('lock release failed');
    const release = vi.fn(async () => { throw releaseFailure; });
    const acquireProjectLock = vi.fn(async (
      _work: WorkDirectoryScope,
      runId: string,
    ): Promise<ProjectLockLease> => ({
      record: {
        pid: 1,
        hostname: 'test',
        processStart: 'test',
        createdAt: '2026-08-11T00:09:00.000Z',
        runId,
      },
      release,
    }));
    const dependencies = {
      ...fixture.dependencies,
      acquireProjectLock,
      verifyRunArtifact: async () => { throw primaryFailure; },
    };

    let caught: unknown;
    try {
      await runReviewCommand(
        'demo',
        {approve: true, reason: 'looks good', reviewer: 'tester'},
        dependencies,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([primaryFailure, releaseFailure]);
    expect((caught as Error).cause).toBe(primaryFailure);
    expect(release).toHaveBeenCalledTimes(1);
    await expectNoCanonicalApproval(fixture);
  });

  it('rejects simultaneous approval and rejection', async () => {
    const fixture = await makeFixture();

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reject: true, reason: 'conflicting choice'},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stderr()).toBe('Choose exactly one of --approve or --reject.\n');
  });

  it('records a rejection under the project lock and leaves review pending', async () => {
    const fixture = await makeFixture();

    const exitCode = await runVideoctl([
      'review', 'demo', '--reject', '--reason', 'needs changes',
    ], fixture.dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.stdout()).toBe('Review rejected: run-review\n');
    expect(fixture.stderr()).toBe('');
    expect(await readRunJson(
      fixture.workspaceRoot,
      fixture.runId,
      'review.json',
    )).toMatchObject({
      version: 1,
      projectId: 'demo',
      runId: fixture.runId,
      status: 'rejected',
      reviewer: process.env.USER ?? 'unknown',
      reason: 'needs changes',
      evidencePaths: fixture.evidence.map((artifact) => artifact.path),
    });
    await expect(createRunStore(fixture.workspaceRoot).readCurrentReadonly('demo'))
      .resolves.toMatchObject({state: 'needs_review'});
    const runDirectory = await createRunStore(fixture.workspaceRoot)
      .openExistingRun('demo', fixture.runId);
    await expect(createStageReportStore().readStage(runDirectory, 'review'))
      .resolves.toBeNull();
    await expect(readFile(
      path.join(fixture.workspaceRoot, '.work', 'demo', 'pipeline.lock'),
      'utf8',
    )).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('refuses approval unless the current pointer is needs_review', async () => {
    const fixture = await makeFixture();
    const store = createRunStore(fixture.workspaceRoot);
    const current = await store.readCurrent('demo');
    await store.publishCurrent('demo', {...current!, state: 'passed'});

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reason: 'looks good', reviewer: 'tester'},
      {...fixture.dependencies, now: () => '2026-08-11T01:00:00.000Z'},
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stderr()).toBe('Current run is not awaiting review.\n');
    const runDirectory = await store.openExistingRun('demo', fixture.runId);
    await expect(createStageReportStore().readStage(runDirectory, 'review'))
      .resolves.toBeNull();
  });

  it('recovers a lagging pointer from a matching canonical Review report', async () => {
    const fixture = await makeFixture();
    const review = {
      version: 1 as const,
      projectId: 'demo',
      runId: fixture.runId,
      status: 'approved' as const,
      reviewer: 'tester',
      reviewedAt: '2026-08-11T00:05:00.000Z',
      reason: 'looks good',
      evidencePaths: fixture.evidence.map((artifact) => artifact.path),
    };
    await writeRunJson(fixture.workspaceRoot, fixture.runId, 'review.json', review);
    const canonical = StageReportSchema.parse({
      version: 1,
      projectId: 'demo',
      runId: fixture.runId,
      preset: 'release',
      stageId: 'review',
      position: 6,
      total: 7,
      state: 'passed',
      fingerprint: fixture.reviewFingerprint,
      startedAt: '2026-08-11T00:05:01.000Z',
      finishedAt: '2026-08-11T00:05:02.000Z',
      artifacts: [],
      outputs: {evidence: fixture.evidence, review},
      checks: [{
        id: 'draft-review-approved',
        severity: 'info',
        message: 'Draft review is approved.',
      }],
    });
    const runDirectory = await createRunStore(fixture.workspaceRoot)
      .openExistingRun('demo', fixture.runId);
    const reportStore = createStageReportStore();
    await reportStore.writeStage(runDirectory, canonical);

    const exitCode = await runReviewCommand(
      'demo',
      {approve: true, reason: 'looks good', reviewer: 'tester'},
      {...fixture.dependencies, now: () => '2026-08-11T01:00:00.000Z'},
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    await expect(reportStore.readStage(runDirectory, 'review')).resolves.toEqual(canonical);
    await expect(createRunStore(fixture.workspaceRoot).readCurrent('demo'))
      .resolves.toMatchObject({
        runId: fixture.runId,
        completedStage: 'review',
        state: 'passed',
        publishedAt: review.reviewedAt,
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
      'review', 'demo', '--approve', '--reason', 'looks good',
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
