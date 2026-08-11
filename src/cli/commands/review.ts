import {z} from 'zod';
import {ReviewSchema, type Review} from '../../domain/review-schema';
import {
  AppDirectoryScopeError,
  createRunStore,
  openExistingRunFileForRead,
  openNewRunFileForWrite,
  type CurrentPointer,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {
  PipelineArtifactError,
  verifyRunArtifact,
} from '../../pipeline/artifacts';
import {fingerprintValue} from '../../pipeline/fingerprint';
import {STAGE_ALGORITHM_VERSIONS} from '../../pipeline/stage-adapters/shared';
import {
  createStageReportStore,
  StageReportSchema,
  type StageReport,
} from '../../pipeline/stage-report';
import {
  DraftReportSchema,
  draftReviewEvidenceArtifacts,
} from '../../pipeline/stages/draft';
import {recordReviewApproval} from '../../pipeline/stages/review';
import {EXIT_CODES} from '../exit-codes';
import type {OutputWriter} from '../videoctl';

export interface ReviewCommandOptions {
  approve?: boolean;
  reject?: boolean;
  reason?: string;
  reviewer?: string;
}

export interface ReviewCommandDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  now?: () => string;
  verifyRunArtifact?: typeof verifyRunArtifact;
}

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

const writeRunJson = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  value: unknown,
): Promise<void> => {
  const target = await openNewRunFileForWrite(runDirectory, relativePath);
  try {
    await target.handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
};

const isMissingPath = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && error.code === 'ENOENT'
);

const readOptionalReview = async (
  runDirectory: RunDirectoryScope,
): Promise<Review | undefined> => {
  try {
    return ReviewSchema.parse(await readRunJson(runDirectory, 'review.json'));
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
};

const isReviewValidationMiss = (error: unknown): boolean => (
  error instanceof z.ZodError
  || error instanceof SyntaxError
  || error instanceof PipelineArtifactError
  || (
    error instanceof AppDirectoryScopeError
    && error.code === 'APP_PATH_OUTSIDE_SCOPE'
  )
  || (
    error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
  )
);

const reviewerName = (options: ReviewCommandOptions): string =>
  options.reviewer ?? process.env.USER ?? 'unknown';

const pointersEqual = (
  left: CurrentPointer | null,
  right: CurrentPointer,
): boolean => left !== null
  && left.runId === right.runId
  && left.relativePath === right.relativePath
  && left.preset === right.preset
  && left.stageIds.length === right.stageIds.length
  && left.stageIds.every((stageId, index) => stageId === right.stageIds[index])
  && left.completedStage === right.completedStage
  && left.state === right.state
  && left.publishedAt === right.publishedAt;

const reviewsMatchEvidence = (
  review: Review,
  projectId: string,
  runId: string,
  evidencePaths: readonly string[],
): boolean => review.projectId === projectId
  && review.runId === runId
  && review.status === 'approved'
  && review.evidencePaths.length === evidencePaths.length
  && review.evidencePaths.every((path, index) => path === evidencePaths[index]);

const canonicalReviewReport = (input: {
  current: CurrentPointer;
  projectId: string;
  review: Review;
  evidence: ReturnType<typeof draftReviewEvidenceArtifacts>;
}): StageReport => {
  const reviewPosition = input.current.stageIds.indexOf('review');
  if (reviewPosition < 0) {
    throw new TypeError('current pointer does not select Review');
  }
  const startedAt = input.current.publishedAt.localeCompare(input.review.reviewedAt) <= 0
    ? input.current.publishedAt
    : input.review.reviewedAt;
  return StageReportSchema.parse({
    version: 1,
    projectId: input.projectId,
    runId: input.current.runId,
    preset: 'release',
    stageId: 'review',
    position: reviewPosition + 1,
    total: input.current.stageIds.length,
    state: 'passed',
    fingerprint: fingerprintValue({
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.review,
      evidence: input.evidence,
    }),
    startedAt,
    finishedAt: input.review.reviewedAt,
    artifacts: [],
    outputs: {
      evidence: input.evidence,
      review: input.review,
    },
    checks: [{
      id: 'draft-review-approved',
      severity: 'info',
      message: 'Draft review is approved.',
    }],
  });
};

const canonicalReportsEquivalent = (
  left: StageReport,
  right: StageReport,
): boolean => fingerprintValue({
  ...left,
  startedAt: null,
  finishedAt: null,
}) === fingerprintValue({
  ...right,
  startedAt: null,
  finishedAt: null,
});

const passedPointer = (
  current: CurrentPointer,
  publishedAt: string,
): CurrentPointer => ({
  ...current,
  state: 'passed',
  publishedAt,
});

export const runReviewCommand = async (
  projectId: string,
  options: ReviewCommandOptions,
  dependencies: ReviewCommandDependencies,
): Promise<number> => {
  if (options.approve === true && options.reject === true) {
    dependencies.stderr.write('Choose exactly one of --approve or --reject.\n');
    return EXIT_CODES.validationFailed;
  }
  if (options.reject === true) {
    dependencies.stderr.write('Review rejection is not supported in MVP.\n');
    return EXIT_CODES.validationFailed;
  }
  if (options.approve !== true) {
    dependencies.stderr.write('Only --approve is supported for review in MVP.\n');
    return EXIT_CODES.validationFailed;
  }
  if (options.reason === undefined || options.reason.trim().length === 0) {
    dependencies.stderr.write('--reason is required.\n');
    return EXIT_CODES.validationFailed;
  }

  const store = createRunStore(dependencies.workspaceRoot);
  const current = await store.readCurrent(projectId);
  if (current === null) {
    dependencies.stderr.write(`No current run for project ${projectId}.\n`);
    return EXIT_CODES.validationFailed;
  }
  if (
    current.state !== 'needs_review'
    || current.completedStage !== 'review'
    || !current.stageIds.includes('review')
  ) {
    dependencies.stderr.write('Current run is not awaiting review.\n');
    return EXIT_CODES.validationFailed;
  }
  const runDirectory = await store.openExistingRun(projectId, current.runId);
  const verifyArtifact = dependencies.verifyRunArtifact ?? verifyRunArtifact;
  let evidence: ReturnType<typeof draftReviewEvidenceArtifacts>;
  try {
    const draftReport = DraftReportSchema.parse(
      await readRunJson(runDirectory, 'draft/draft-report.json'),
    );
    if (draftReport.projectId !== projectId) {
      dependencies.stderr.write('Draft report belongs to another project.\n');
      return EXIT_CODES.validationFailed;
    }
    evidence = draftReviewEvidenceArtifacts(draftReport);
    for (const artifact of evidence) {
      if (!await verifyArtifact(runDirectory, {scope: 'run', ...artifact})) {
        dependencies.stderr.write('Draft review evidence is missing or changed.\n');
        return EXIT_CODES.validationFailed;
      }
    }
  } catch (error) {
    if (isReviewValidationMiss(error)) {
      dependencies.stderr.write('Draft review evidence is invalid.\n');
      return EXIT_CODES.validationFailed;
    }
    throw error;
  }
  const currentAfterEvidence = await store.readCurrentReadonly(projectId);
  if (!pointersEqual(currentAfterEvidence, current)) {
    dependencies.stderr.write('Current run changed while review evidence was verified.\n');
    return EXIT_CODES.validationFailed;
  }
  const evidencePaths = evidence.map((artifact) => artifact.path);
  let review: Review;
  try {
    const existingReview = await readOptionalReview(runDirectory);
    if (existingReview === undefined) {
      review = recordReviewApproval({
        projectId,
        runId: current.runId,
        reviewer: reviewerName(options),
        reason: options.reason,
        evidencePaths,
        reviewedAt: dependencies.now?.() ?? new Date().toISOString(),
      });
      await writeRunJson(runDirectory, 'review.json', review);
    } else if (reviewsMatchEvidence(
      existingReview,
      projectId,
      current.runId,
      evidencePaths,
    )) {
      review = existingReview;
    } else {
      dependencies.stderr.write('Existing review approval does not match current evidence.\n');
      return EXIT_CODES.validationFailed;
    }
  } catch (error) {
    if (isReviewValidationMiss(error)) {
      dependencies.stderr.write('Existing review approval is invalid.\n');
      return EXIT_CODES.validationFailed;
    }
    throw error;
  }
  const reviewReport = canonicalReviewReport({
    current,
    projectId,
    review,
    evidence,
  });
  const reportStore = createStageReportStore();
  const existingReport = await reportStore.readStage(runDirectory, 'review');
  if (existingReport === null) {
    await reportStore.writeStage(runDirectory, reviewReport);
  } else if (!canonicalReportsEquivalent(existingReport, reviewReport)) {
    dependencies.stderr.write('Canonical Review report already exists with different evidence.\n');
    return EXIT_CODES.validationFailed;
  }
  await store.publishCurrent(projectId, passedPointer(current, review.reviewedAt));
  dependencies.stdout.write(`Review approved: ${current.runId}\n`);
  return EXIT_CODES.success;
};
