import {ReviewSchema, type Review} from '../../domain/review-schema';

export type ReviewGateState = 'passed' | 'needs_review';

export class ReviewGateError extends Error {
  readonly code = 'DRAFT_REVIEW_REQUIRED';

  constructor(message: string, options?: ErrorOptions) {
    super(`DRAFT_REVIEW_REQUIRED: ${message}`, options);
    this.name = 'ReviewGateError';
  }
}

export interface ReviewContext {
  projectId: string;
  runId: string;
  evidencePaths: string[];
  review?: Review;
  reviewer?: string;
  now?: () => string;
}

export interface RecordReviewApprovalInput {
  projectId: string;
  runId: string;
  reviewer: string;
  reason: string;
  evidencePaths: string[];
  reviewedAt?: string;
}

export const recordReviewApproval = ({
  projectId,
  runId,
  reviewer,
  reason,
  evidencePaths,
  reviewedAt = new Date().toISOString(),
}: RecordReviewApprovalInput): Review => {
  if (reason.trim().length === 0) {
    throw new ReviewGateError('review approval reason is required');
  }
  return ReviewSchema.parse({
    version: 1,
    projectId,
    runId,
    status: 'approved',
    reviewer,
    reviewedAt,
    reason,
    evidencePaths,
  });
};

const assertReviewMatchesContext = (context: ReviewContext, review: Review): void => {
  if (review.projectId !== context.projectId || review.runId !== context.runId) {
    throw new ReviewGateError(
      `review belongs to ${review.projectId}/${review.runId}, expected ${context.projectId}/${context.runId}`,
    );
  }
};

const assertApprovedEvidence = (context: ReviewContext, review: Review): void => {
  if (
    review.evidencePaths.length !== context.evidencePaths.length
    || new Set(review.evidencePaths).size !== review.evidencePaths.length
    || new Set(context.evidencePaths).size !== context.evidencePaths.length
    || review.evidencePaths.some((path, index) => path !== context.evidencePaths[index])
  ) {
    throw new ReviewGateError('review evidence does not exactly match the Draft evidence');
  }
};

export const evaluateReview = async (
  context: ReviewContext,
): Promise<{state: ReviewGateState; review?: Review}> => {
  if (context.review === undefined) return {state: 'needs_review'};
  const review = ReviewSchema.parse(context.review);
  assertReviewMatchesContext(context, review);
  if (review.status !== 'approved') return {state: 'needs_review', review};
  assertApprovedEvidence(context, review);
  return {state: 'passed', review};
};
