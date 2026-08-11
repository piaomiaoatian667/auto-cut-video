import type {FileHandle} from 'node:fs/promises';
import {z} from 'zod';
import {
  AppDirectoryScopeError,
  createRunStore,
  openExistingRunFileForRead,
  openNewRunFile,
  type CurrentPointer,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {
  PipelineArtifactError,
  verifyRunArtifact,
} from '../../pipeline/artifacts';
import {
  DraftReportSchema,
  draftReviewEvidenceArtifacts,
} from '../../pipeline/stages/draft';
import {recordReviewApproval} from '../../pipeline/stages/review';
import {EXIT_CODES} from '../exit-codes';
import type {OutputWriter} from '../videoctl';

export interface ReviewCommandOptions {
  approve?: boolean;
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

const withHandle = async <Output>(
  handle: FileHandle,
  action: (handle: FileHandle) => Promise<Output>,
): Promise<Output> => {
  try {
    return await action(handle);
  } finally {
    await handle.close();
  }
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

const writeRunJson = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  value: unknown,
): Promise<void> => await withHandle(
  await openNewRunFile(runDirectory, relativePath),
  async (handle) => {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  },
);

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
  const runDirectory = await store.openExistingRun(projectId, current.runId);
  const verifyArtifact = dependencies.verifyRunArtifact ?? verifyRunArtifact;
  let evidencePaths: string[];
  try {
    const draftReport = DraftReportSchema.parse(
      await readRunJson(runDirectory, 'draft/draft-report.json'),
    );
    if (draftReport.projectId !== projectId) {
      dependencies.stderr.write('Draft report belongs to another project.\n');
      return EXIT_CODES.validationFailed;
    }
    const evidence = draftReviewEvidenceArtifacts(draftReport);
    for (const artifact of evidence) {
      if (!await verifyArtifact(runDirectory, {scope: 'run', ...artifact})) {
        dependencies.stderr.write('Draft review evidence is missing or changed.\n');
        return EXIT_CODES.validationFailed;
      }
    }
    evidencePaths = evidence.map((artifact) => artifact.path);
  } catch (error) {
    if (isReviewValidationMiss(error)) {
      dependencies.stderr.write('Draft review evidence is invalid.\n');
      return EXIT_CODES.validationFailed;
    }
    throw error;
  }
  const reviewedAt = dependencies.now?.() ?? new Date().toISOString();
  const review = recordReviewApproval({
    projectId,
    runId: current.runId,
    reviewer: reviewerName(options),
    reason: options.reason,
    evidencePaths,
    reviewedAt,
  });
  await writeRunJson(runDirectory, 'review.json', review);
  await store.publishCurrent(projectId, passedPointer(current, reviewedAt));
  dependencies.stdout.write(`Review approved: ${current.runId}\n`);
  return EXIT_CODES.success;
};
