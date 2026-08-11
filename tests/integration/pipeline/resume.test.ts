import path from 'node:path';
import {readdir, readFile} from 'node:fs/promises';
import {describe, expect, it, vi} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import {
  ensureRunDirectory,
  openExistingRunFileForRead,
  openNewRunFileForWrite,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  hashRunArtifact,
  verifyRunArtifact,
  type PipelineArtifact,
} from '../../../src/pipeline/artifacts';
import {
  buildExecutionPlan,
  type ExecutionPlanContext,
} from '../../../src/pipeline/execution-plan';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {STAGE_PRESETS} from '../../../src/pipeline/presets';
import {
  createOutputStore,
  createRunStore,
  type StageId,
} from '../../../src/pipeline/run-store';
import {
  runExecutionPlan,
  type RunnerDependencies,
} from '../../../src/pipeline/runner';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import {
  requireRunContext,
  type PipelineStage,
} from '../../../src/pipeline/stage';
import {createReviewStage} from '../../../src/pipeline/stage-adapters/review';
import {createStageReportStore} from '../../../src/pipeline/stage-report';
import {
  DraftReportSchema,
  draftReviewEvidenceArtifacts,
} from '../../../src/pipeline/stages/draft';
import {evaluateReview} from '../../../src/pipeline/stages/review';
import {runReviewCommand} from '../../../src/cli/commands/review';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {fakePreflightResult} from '../../helpers/pipeline-fixtures';
import {createTempProject} from '../../helpers/temp-project';

const NOW = '2026-08-11T15:00:00.000Z';
const APPROVED_AT = '2026-08-11T15:05:00.000Z';
const SOURCE_HASH = fingerprintValue({source: 'resume'});

const sourceCatalog: ProjectSourceCatalog = {
  assets: [],
  totalBytes: 0,
  fingerprint: SOURCE_HASH,
};

const stageFingerprint = (stageId: StageId): string => fingerprintValue({stageId});

const writeRunBytes = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  bytes: Buffer | string,
): Promise<PipelineArtifact> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const target = await openNewRunFileForWrite(runDirectory, relativePath);
  try {
    await target.handle.writeFile(bytes);
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
  return await hashRunArtifact(runDirectory, relativePath);
};

const readRunJson = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<unknown> => {
  const authority = await openExistingRunFileForRead(runDirectory, relativePath);
  try {
    const value = JSON.parse(await authority.handle.readFile('utf8')) as unknown;
    await authority.revalidate();
    return value;
  } finally {
    await authority.close();
  }
};

describe('Pipeline resume', () => {
  it('approves and resumes Release in the same Run', async () => {
    const tempProject = await createTempProject({tempPrefix: 'resume-review-'});
    try {
      const project = await loadProject(tempProject.workspaceRoot, 'demo');
      const runStore = createRunStore(tempProject.workspaceRoot);
      const outputStore = createOutputStore(tempProject.workspaceRoot);
      const reportStore = createStageReportStore();
      const executionCalls: StageId[] = [];
      const releasePointerStates: Array<'passed' | 'needs_review'> = [];
      const reviewEvaluations = vi.fn(evaluateReview);
      const concreteReview = createReviewStage({evaluateReview: reviewEvaluations});
      const reviewStage: PipelineStage = {
        ...concreteReview,
        execute: async (...args) => {
          executionCalls.push('review');
          return await concreteReview.execute(...args);
        },
      };
      const genericStage = (stageId: Exclude<StageId, 'review' | 'release'>): PipelineStage => ({
        id: stageId,
        displayName: stageId,
        prerequisites: [],
        fingerprint: async () => stageFingerprint(stageId),
        verify: async (context, report) => {
          if (
            context.sourceRun === undefined
            || report.fingerprint !== stageFingerprint(stageId)
          ) return false;
          for (const artifact of report.artifacts) {
            if (artifact.scope !== 'run') return false;
            if (!await verifyRunArtifact(context.sourceRun.runDirectory, artifact)) {
              return false;
            }
          }
          return true;
        },
        partialArtifacts: () => [],
        execute: async (context) => {
          executionCalls.push(stageId);
          if (stageId === 'preflight') {
            const preflight = fakePreflightResult();
            return {
              state: 'passed',
              fingerprint: stageFingerprint(stageId),
              outputs: preflight,
              artifacts: [],
              checks: preflight.checks,
            };
          }
          if (stageId !== 'draft') {
            return {
              state: 'passed',
              fingerprint: stageFingerprint(stageId),
              outputs: {stageId},
              artifacts: [],
              checks: [],
            };
          }
          const {runDirectory} = requireRunContext(context);
          const draftVideo = await writeRunBytes(
            runDirectory,
            'draft/draft.mp4',
            'draft-video',
          );
          const contactSheet = await writeRunBytes(
            runDirectory,
            'draft/contact-sheet.jpg',
            'contact-sheet',
          );
          const reviewFrame = await writeRunBytes(
            runDirectory,
            'draft/frames/frame-000000.jpg',
            'review-frame',
          );
          const draftReport = DraftReportSchema.parse({
            version: 1,
            projectId: 'demo',
            outputs: {
              draftVideo: {path: draftVideo.path, sha256: draftVideo.sha256},
              contactSheet: {path: contactSheet.path, sha256: contactSheet.sha256},
              reviewFrames: [{path: reviewFrame.path, sha256: reviewFrame.sha256}],
              audio: {
                filterGraph: {
                  path: 'audio/filter-graph.txt',
                  sha256: fingerprintValue({audio: 'filter'}),
                },
                mixedAudio: {
                  path: 'audio/mixed-normalized.wav',
                  sha256: fingerprintValue({audio: 'mixed'}),
                },
              },
            },
          });
          const reportArtifact = await writeRunBytes(
            runDirectory,
            'draft/draft-report.json',
            `${JSON.stringify(draftReport, null, 2)}\n`,
          );
          return {
            state: 'passed',
            fingerprint: stageFingerprint(stageId),
            outputs: {reportPath: reportArtifact.path},
            artifacts: [draftVideo, contactSheet, reviewFrame, reportArtifact],
            checks: [],
          };
        },
      });
      const releaseStage: PipelineStage = {
        id: 'release',
        displayName: 'release',
        prerequisites: ['review'],
        fingerprint: async () => stageFingerprint('release'),
        verify: async () => true,
        partialArtifacts: () => [],
        execute: async (context) => {
          executionCalls.push('release');
          const current = await runStore.readCurrentReadonly('demo');
          if (current === null) throw new Error('missing Work pointer before Release');
          releasePointerStates.push(current.state);
          const {runId} = requireRunContext(context);
          await outputStore.createRelease('demo', runId);
          return {
            state: 'passed',
            fingerprint: stageFingerprint('release'),
            outputs: {runId},
            artifacts: [],
            checks: [],
            outputCurrent: {
              runId,
              relativePath: `releases/${runId}`,
              preset: 'release',
              stageIds: [...STAGE_PRESETS.release],
              completedStage: 'release',
              state: 'passed',
              publishedAt: context.now(),
            },
          };
        },
      };
      const registry: readonly PipelineStage[] = [
        genericStage('preflight'),
        genericStage('ingest'),
        genericStage('narration'),
        genericStage('compile'),
        genericStage('draft'),
        reviewStage,
        releaseStage,
      ];
      const planningContext = (createRunId: () => string): ExecutionPlanContext => ({
        project,
        sourceCatalog,
        registry,
        runStore,
        outputStore,
        reportStore,
        createRunId,
      });
      const releaseLock = vi.fn(async () => undefined);
      const dependencies: RunnerDependencies = {
        registry,
        runStore,
        outputStore,
        reportStore,
        acquireProjectLock: vi.fn(async (_work, runId) => ({
          record: {
            pid: 1,
            hostname: 'test',
            processStart: 'test',
            createdAt: NOW,
            runId,
          },
          release: releaseLock,
        })) as unknown as RunnerDependencies['acquireProjectLock'],
        createRunId: vi.fn(() => 'run-unused'),
        now: vi.fn(() => NOW),
      };
      const signal = new AbortController().signal;
      const firstPlan = await buildExecutionPlan(
        planningContext(() => 'run-review'),
        {preset: 'release', resume: true},
      );

      const first = await runExecutionPlan({
        plan: firstPlan,
        project,
        sourceCatalog,
        signal,
      }, dependencies);

      expect(first).toMatchObject({state: 'needs_review', runId: 'run-review'});
      expect(executionCalls).not.toContain('release');
      const runDirectory = await runStore.openExistingRun('demo', 'run-review');
      await expect(reportStore.readStage(runDirectory, 'review')).resolves.toBeNull();
      const draftReport = DraftReportSchema.parse(
        await readRunJson(runDirectory, 'draft/draft-report.json'),
      );
      const attemptDirectory = path.join(
        tempProject.workspaceRoot,
        '.work',
        'demo',
        'runs',
        'run-review',
        'reports',
        'attempts',
      );
      const attemptNamesBefore = await readdir(attemptDirectory);
      expect(attemptNamesBefore).toHaveLength(1);
      const attemptBytesBefore = await readFile(
        path.join(attemptDirectory, attemptNamesBefore[0]!),
      );

      let reviewStdout = '';
      let reviewStderr = '';
      const approval = await runReviewCommand(
        'demo',
        {approve: true, reason: 'draft accepted', reviewer: 'tester'},
        {
          workspaceRoot: tempProject.workspaceRoot,
          stdout: {write: (chunk) => { reviewStdout += chunk; }},
          stderr: {write: (chunk) => { reviewStderr += chunk; }},
          now: () => APPROVED_AT,
        },
      );

      expect(approval).toBe(EXIT_CODES.success);
      expect(reviewStdout).toBe('Review approved: run-review\n');
      expect(reviewStderr).toBe('');
      const canonicalReview = await reportStore.readStage(runDirectory, 'review');
      expect(canonicalReview).toMatchObject({
        projectId: 'demo',
        runId: 'run-review',
        state: 'passed',
        outputs: {
          evidence: draftReviewEvidenceArtifacts(draftReport),
          review: {
            status: 'approved',
            reason: 'draft accepted',
          },
        },
      });
      const pointerAfterApproval = await runStore.readCurrentReadonly('demo');
      expect(pointerAfterApproval).toMatchObject({
        runId: 'run-review',
        preset: 'release',
        stageIds: [...STAGE_PRESETS.release],
        completedStage: 'review',
        state: 'passed',
      });
      await runStore.publishCurrent('demo', {
        ...pointerAfterApproval!,
        state: 'needs_review',
      });
      const attemptNamesAfter = await readdir(attemptDirectory);
      expect(attemptNamesAfter).toEqual(attemptNamesBefore);
      await expect(readFile(
        path.join(attemptDirectory, attemptNamesAfter[0]!),
      )).resolves.toEqual(attemptBytesBefore);

      executionCalls.length = 0;
      reviewEvaluations.mockClear();
      const secondPlan = await buildExecutionPlan(
        planningContext(() => 'run-replacement'),
        {preset: 'release', resume: true},
      );
      expect(secondPlan).toMatchObject({
        runMode: 'resume',
        sourceRunId: 'run-review',
        targetRunId: 'run-review',
      });
      expect(secondPlan.items.find((item) => item.stageId === 'review'))
        .toMatchObject({action: 'cached', materialize: false});
      expect(secondPlan.items.find((item) => item.stageId === 'release'))
        .toMatchObject({action: 'resume', materialize: false});
      expect(reviewEvaluations).toHaveBeenCalled();

      const second = await runExecutionPlan({
        plan: secondPlan,
        project,
        sourceCatalog,
        signal,
      }, dependencies);

      expect(second).toMatchObject({
        state: 'passed',
        runId: 'run-review',
        completedStage: 'release',
      });
      expect(executionCalls).toEqual(['preflight', 'release']);
      expect(releasePointerStates).toEqual(['passed']);
      expect(await outputStore.readCurrentReadonly('demo')).toMatchObject({
        runId: 'run-review',
        completedStage: 'release',
      });
      expect(releaseLock).toHaveBeenCalledTimes(2);
    } finally {
      await tempProject.cleanup();
    }
  });
});
