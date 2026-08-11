import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {z} from 'zod';
import {ReviewSchema, type Review} from '../../domain/review-schema';
import {
  AppDirectoryLinkOutcomeError,
  AppDirectoryScopeError,
  createRunStore,
  linkRunFile,
  openExistingRunFileForRead,
  openNewRunFileForWrite,
  syncRunDirectory,
  unlinkRunFile,
  type AppDirectoryLinkedFileAuthority,
  type AppDirectoryWriteFileAuthority,
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
import {
  acquireProjectLock,
  type ProjectLockLease,
} from '../../pipeline/project-lock';
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
  acquireProjectLock?: typeof acquireProjectLock;
  reviewFileOps?: Partial<ReviewFileOperations>;
}

interface ReviewFileOperations {
  openNewRunFileForWrite: typeof openNewRunFileForWrite;
  linkRunFile: typeof linkRunFile;
  unlinkRunFile: typeof unlinkRunFile;
  syncRunDirectory: typeof syncRunDirectory;
  createTempId(): string;
}

export class ReviewApprovalOutcomeError extends AggregateError {
  readonly code = 'REVIEW_APPROVAL_OUTCOME_UNKNOWN';

  constructor(
    readonly relativePath: string,
    primaryError: unknown,
    recoveryErrors: readonly unknown[],
  ) {
    super(
      [primaryError, ...recoveryErrors],
      `Review approval publication outcome could not be determined for ${relativePath}`,
      {cause: primaryError},
    );
    this.name = 'ReviewApprovalOutcomeError';
  }
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

const isMissingPath = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && error.code === 'ENOENT'
);

const isLinkOutcomeUnknown = (error: unknown): boolean => (
  error instanceof AppDirectoryLinkOutcomeError
  || (
    error instanceof Error
    && 'code' in error
    && error.code === 'APP_DIRECTORY_LINK_OUTCOME_UNKNOWN'
  )
);

const reviewFileOperations = (
  dependencies: ReviewCommandDependencies,
): ReviewFileOperations => ({
  openNewRunFileForWrite,
  linkRunFile,
  unlinkRunFile,
  syncRunDirectory,
  createTempId: randomUUID,
  ...dependencies.reviewFileOps,
});

const closeReviewBestEffort = async (
  target: {close(): Promise<void>},
): Promise<void> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await target.close();
      return;
    } catch {}
  }
};

const rollbackReviewWrite = async (input: {
  target: AppDirectoryWriteFileAuthority;
  primaryError: unknown;
}): Promise<never> => {
  const cleanupErrors: unknown[] = [];
  try {
    await input.target.unlink();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await input.target.syncParent();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await input.target.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [input.primaryError, ...cleanupErrors],
      'Review approval rollback failed for review.json',
      {cause: input.primaryError},
    );
  }
  throw input.primaryError;
};

const cleanupCommittedReviewTempBestEffort = async (
  target: AppDirectoryWriteFileAuthority,
  linkAuthority: AppDirectoryLinkedFileAuthority,
): Promise<void> => {
  let sourceUnlinked = false;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await linkAuthority.unlinkSource();
      sourceUnlinked = true;
      break;
    } catch {}
  }
  if (sourceUnlinked) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await linkAuthority.syncParent();
        break;
      } catch {}
    }
  }
  await closeReviewBestEffort(linkAuthority);
  await closeReviewBestEffort(target);
};

const recoverLinkedReviewCommit = async (input: {
  target: AppDirectoryWriteFileAuthority;
  linkAuthority: AppDirectoryLinkedFileAuthority;
  primaryError: unknown;
}): Promise<void> => {
  const recoveryErrors: unknown[] = [];
  let sourceUnlinked = false;
  try {
    await input.linkAuthority.unlinkSource();
    sourceUnlinked = true;
  } catch (error) {
    recoveryErrors.push(error);
  }
  try {
    await input.linkAuthority.syncParent();
  } catch (error) {
    recoveryErrors.push(error);
    await closeReviewBestEffort(input.linkAuthority);
    await closeReviewBestEffort(input.target);
    throw new ReviewApprovalOutcomeError(
      'review.json',
      input.primaryError,
      recoveryErrors,
    );
  }
  if (sourceUnlinked) {
    await closeReviewBestEffort(input.linkAuthority);
    await closeReviewBestEffort(input.target);
    return;
  }
  await cleanupCommittedReviewTempBestEffort(input.target, input.linkAuthority);
};

const reviewTempPath = (createTempId: () => string): string =>
  path.posix.join('.', `.review.json.${createTempId()}.tmp`);

const writeImmutableReview = async (
  runDirectory: RunDirectoryScope,
  review: Review,
  operations: ReviewFileOperations,
): Promise<void> => {
  const tempRelativePath = reviewTempPath(operations.createTempId);
  let target: AppDirectoryWriteFileAuthority | undefined;
  let linkAuthority: AppDirectoryLinkedFileAuthority | undefined;
  try {
    target = await operations.openNewRunFileForWrite(
      runDirectory,
      tempRelativePath,
    );
    await target.handle.writeFile(`${JSON.stringify(review, null, 2)}\n`, 'utf8');
    await target.syncAndSeal();
    await target.revalidate();
    linkAuthority = await operations.linkRunFile(
      runDirectory,
      tempRelativePath,
      'review.json',
      target,
    );
  } catch (error) {
    if (isLinkOutcomeUnknown(error)) {
      const recoveryErrors: unknown[] = [];
      if (target !== undefined) {
        try {
          await target.syncParent();
        } catch (syncError) {
          recoveryErrors.push(syncError);
        }
        await closeReviewBestEffort(target);
      }
      throw new ReviewApprovalOutcomeError(
        'review.json',
        error,
        recoveryErrors,
      );
    }
    if (target !== undefined) {
      return await rollbackReviewWrite({target, primaryError: error});
    }
    throw error;
  }
  try {
    await linkAuthority.syncParent();
  } catch (error) {
    await recoverLinkedReviewCommit({
      target,
      linkAuthority,
      primaryError: error,
    });
    return;
  }
  await cleanupCommittedReviewTempBestEffort(target, linkAuthority);
};

const removeOrphanReview = async (
  runDirectory: RunDirectoryScope,
  operations: ReviewFileOperations,
): Promise<void> => {
  try {
    await operations.unlinkRunFile(runDirectory, 'review.json');
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  await operations.syncRunDirectory(runDirectory);
};

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
  const reason = options.reason;

  const store = createRunStore(dependencies.workspaceRoot);
  const current = await store.readCurrentReadonly(projectId);
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
  const work = await store.openExistingWork(projectId);
  if (work === null) {
    dependencies.stderr.write('Current run changed before review approval.\n');
    return EXIT_CODES.validationFailed;
  }
  const fileOperations = reviewFileOperations(dependencies);
  let approvalCommitted = false;

  const approveLocked = async (): Promise<number> => {
    const lockedCurrent = await store.readCurrentReadonly(projectId);
    if (!pointersEqual(lockedCurrent, current)) {
      dependencies.stderr.write('Current run changed before review approval.\n');
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
    const reportStore = createStageReportStore();
    const existingReport = await reportStore.readStage(runDirectory, 'review');
    let review: Review;
    if (existingReport !== null) {
      let existingReview: Review | undefined;
      try {
        existingReview = await readOptionalReview(runDirectory);
      } catch (error) {
        if (isReviewValidationMiss(error)) {
          dependencies.stderr.write('Existing review approval is invalid.\n');
          return EXIT_CODES.validationFailed;
        }
        throw error;
      }
      if (existingReview === undefined) {
        dependencies.stderr.write('Canonical Review report is missing its approval.\n');
        return EXIT_CODES.validationFailed;
      }
      if (!reviewsMatchEvidence(
        existingReview,
        projectId,
        current.runId,
        evidencePaths,
      )) {
        dependencies.stderr.write('Existing review approval does not match current evidence.\n');
        return EXIT_CODES.validationFailed;
      }
      review = existingReview;
      const expectedReport = canonicalReviewReport({
        current,
        projectId,
        review,
        evidence,
      });
      if (!canonicalReportsEquivalent(existingReport, expectedReport)) {
        dependencies.stderr.write('Canonical Review report already exists with different evidence.\n');
        return EXIT_CODES.validationFailed;
      }
    } else {
      await removeOrphanReview(runDirectory, fileOperations);
      review = recordReviewApproval({
        projectId,
        runId: current.runId,
        reviewer: reviewerName(options),
        reason,
        evidencePaths,
        reviewedAt: dependencies.now?.() ?? new Date().toISOString(),
      });
      await writeImmutableReview(runDirectory, review, fileOperations);
      const reviewReport = canonicalReviewReport({
        current,
        projectId,
        review,
        evidence,
      });
      await reportStore.writeStage(runDirectory, reviewReport);
    }
    await store.publishCurrent(projectId, passedPointer(current, review.reviewedAt));
    approvalCommitted = true;
    return EXIT_CODES.success;
  };

  const acquireLock = dependencies.acquireProjectLock ?? acquireProjectLock;
  let lease: ProjectLockLease | undefined;
  let outcome:
    | {ok: true; value: number}
    | {ok: false; error: unknown}
    | undefined;
  try {
    lease = await acquireLock(work, current.runId);
    outcome = {ok: true, value: await approveLocked()};
  } catch (error) {
    outcome = {ok: false, error};
  }

  let releaseError: unknown;
  try {
    await lease?.release();
  } catch (error) {
    releaseError = error;
  }
  if (outcome === undefined) {
    throw new TypeError('Review approval completed without an outcome');
  }
  if (!outcome.ok) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [outcome.error, releaseError],
        'Review approval and project lock release both failed',
        {cause: outcome.error},
      );
    }
    throw outcome.error;
  }
  if (releaseError !== undefined) {
    if (approvalCommitted && outcome.value === EXIT_CODES.success) {
      dependencies.stderr.write(
        'Review approved, but the project lock could not be released.\n',
      );
    } else {
      throw releaseError;
    }
  }
  if (outcome.value === EXIT_CODES.success) {
    dependencies.stdout.write(`Review approved: ${current.runId}\n`);
  }
  return outcome.value;
};
