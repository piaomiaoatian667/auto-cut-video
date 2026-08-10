import type {FileHandle} from 'node:fs/promises';
import {
  createRunStore,
  openExistingRunFile,
  openNewRunFile,
  type CurrentPointer,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
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
): Promise<unknown> => await withHandle(
  await openExistingRunFile(runDirectory, relativePath),
  async (handle) => JSON.parse(await handle.readFile('utf8')) as unknown,
);

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

const isArtifact = (value: unknown): value is {path: string} => value !== null
  && typeof value === 'object'
  && 'path' in value
  && typeof value.path === 'string';

const evidenceFromDraftReport = (report: unknown): string[] => {
  const output = report !== null && typeof report === 'object' && 'outputs' in report
    ? (report as {outputs?: unknown}).outputs
    : undefined;
  if (output === null || typeof output !== 'object' || output === undefined) return [];
  const record = output as Record<string, unknown>;
  const evidence: string[] = [];
  if (isArtifact(record.draftVideo)) evidence.push(record.draftVideo.path);
  if (isArtifact(record.contactSheet)) evidence.push(record.contactSheet.path);
  if (Array.isArray(record.reviewFrames)) {
    for (const frame of record.reviewFrames) {
      if (isArtifact(frame)) evidence.push(frame.path);
    }
  }
  return [...new Set(evidence)];
};

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
  const evidencePaths = evidenceFromDraftReport(
    await readRunJson(runDirectory, 'draft/draft-report.json'),
  );
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
