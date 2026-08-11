import {describe, expect, it} from 'vitest';
import {
  evaluateReview,
  recordReviewApproval,
  ReviewGateError,
  type ReviewContext,
} from '../../../src/pipeline/stages/review';

const context = (overrides: Partial<ReviewContext> = {}): ReviewContext => ({
  projectId: 'demo',
  runId: 'run-1',
  evidencePaths: ['draft/draft.mp4', 'draft/contact-sheet.jpg'],
  reviewer: 'tester',
  now: () => '2026-08-10T00:00:00.000Z',
  ...overrides,
});

describe('evaluateReview', () => {
  it('returns needs_review without an approval record', async () => {
    await expect(evaluateReview(context())).resolves.toMatchObject({state: 'needs_review'});
  });

  it('rejects approval for another run', async () => {
    await expect(evaluateReview(context({review: recordReviewApproval({
      projectId: 'demo',
      runId: 'old-run',
      reviewer: 'tester',
      reason: 'ok',
      evidencePaths: ['draft/draft.mp4'],
      reviewedAt: '2026-08-10T00:00:00.000Z',
    })}))).rejects.toThrow(/DRAFT_REVIEW_REQUIRED/);
  });

  it('returns passed for an approval matching the current run and evidence', async () => {
    const review = recordReviewApproval({
      projectId: 'demo',
      runId: 'run-1',
      reviewer: 'tester',
      reason: 'approved',
      evidencePaths: ['draft/draft.mp4', 'draft/contact-sheet.jpg'],
      reviewedAt: '2026-08-10T00:00:00.000Z',
    });

    await expect(evaluateReview(context({review}))).resolves.toEqual({
      state: 'passed',
      review,
    });
  });

  it.each([
    ['reordered', ['draft/contact-sheet.jpg', 'draft/draft.mp4']],
    ['duplicated', ['draft/draft.mp4', 'draft/draft.mp4']],
  ] as const)('rejects %s approval evidence', async (_label, evidencePaths) => {
    const review = recordReviewApproval({
      projectId: 'demo',
      runId: 'run-1',
      reviewer: 'tester',
      reason: 'approved',
      evidencePaths: [...evidencePaths],
      reviewedAt: '2026-08-10T00:00:00.000Z',
    });

    await expect(evaluateReview(context({review}))).rejects.toThrow(
      /review evidence does not exactly match the Draft evidence/u,
    );
  });

  it('keeps rejected reviews in needs_review state', async () => {
    await expect(evaluateReview(context({review: {
      version: 1,
      projectId: 'demo',
      runId: 'run-1',
      status: 'rejected',
      reviewer: 'tester',
      reviewedAt: '2026-08-10T00:00:00.000Z',
      reason: 'needs changes',
      evidencePaths: ['draft/draft.mp4'],
    }}))).resolves.toMatchObject({state: 'needs_review'});
  });
});

describe('recordReviewApproval', () => {
  it('requires a non-empty reason', () => {
    expect(() => recordReviewApproval({
      projectId: 'demo',
      runId: 'run-1',
      reviewer: 'tester',
      reason: '',
      evidencePaths: ['draft/draft.mp4'],
      reviewedAt: '2026-08-10T00:00:00.000Z',
    })).toThrow(ReviewGateError);
  });
});
