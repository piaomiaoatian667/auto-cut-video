import {z} from 'zod';
import {ReviewSchema, type Review} from '../../domain/review-schema';
import type {RunDirectoryScope} from '../../fs/app-directory-scopes';
import {
  PipelineArtifactError,
  verifyRunArtifact,
} from '../artifacts';
import {fingerprintValue} from '../fingerprint';
import {
  requirePreflight,
  requireRunContext,
  type PipelineStage,
} from '../stage';
import {
  DraftReportSchema,
  type DraftReport,
} from '../stages/draft';
import {
  evaluateReview,
  type ReviewContext,
} from '../stages/review';
import {
  STAGE_ALGORITHM_VERSIONS,
  readOptionalRunJson,
  readRunJson,
  verifyReportedArtifacts,
} from './shared';

const ReviewEvidenceSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().min(1),
}).strict();

const ReviewAdapterOutputSchema = z.object({
  evidence: z.array(ReviewEvidenceSchema).min(1),
  review: ReviewSchema.nullable(),
}).strict();

export interface ReviewStageAdapterDependencies {
  algorithmVersion?: string;
  readDraftReport?: (runDirectory: RunDirectoryScope) => Promise<DraftReport>;
  readReview?: (runDirectory: RunDirectoryScope) => Promise<Review | undefined>;
  evaluateReview?: typeof evaluateReview;
}

const evidenceFromDraft = (report: DraftReport) => [
  report.outputs.contactSheet,
  ...report.outputs.reviewFrames,
];

const isOrdinaryVerificationMiss = (error: unknown): boolean => (
  error instanceof z.ZodError
  || error instanceof PipelineArtifactError
  || (
    error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'APP_PATH_OUTSIDE_SCOPE')
  )
);

export const createReviewStage = (
  dependencies: ReviewStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.review;
  const readDraftReport = dependencies.readDraftReport
    ?? (async (runDirectory: RunDirectoryScope) => await readRunJson(
      runDirectory,
      'draft/draft-report.json',
      (value) => DraftReportSchema.parse(value),
    ));
  const readReview = dependencies.readReview
    ?? (async (runDirectory: RunDirectoryScope) => await readOptionalRunJson(
      runDirectory,
      'review.json',
      (value) => ReviewSchema.parse(value),
    ));
  const evaluate = dependencies.evaluateReview ?? evaluateReview;

  const fingerprintFromDraft = (report: DraftReport): string => fingerprintValue({
    algorithmVersion,
    evidence: evidenceFromDraft(report),
  });

  return {
    id: 'review',
    displayName: 'Review',
    prerequisites: ['draft'],
    fingerprint: async (context) => context.sourceRun === undefined
      ? null
      : fingerprintFromDraft(await readDraftReport(context.sourceRun.runDirectory)),
    verify: async (context, report) => {
      if (report.state !== 'passed' && report.state !== 'cached') return false;
      const parsed = ReviewAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success || parsed.data.review?.status !== 'approved') return false;
      if (context.sourceRun === undefined) return false;
      try {
        const currentDraft = await readDraftReport(context.sourceRun.runDirectory);
        const currentEvidence = evidenceFromDraft(currentDraft);
        if (
          fingerprintValue(currentEvidence)
          !== fingerprintValue(parsed.data.evidence)
          || report.fingerprint !== fingerprintFromDraft(currentDraft)
        ) {
          return false;
        }
        const currentReview = await readReview(context.sourceRun.runDirectory);
        if (
          currentReview === undefined
          || fingerprintValue(currentReview) !== fingerprintValue(parsed.data.review)
        ) {
          return false;
        }
        if (!await verifyReportedArtifacts({context, report, expected: []})) {
          return false;
        }
        for (const artifact of currentEvidence) {
          if (!await verifyRunArtifact(context.sourceRun.runDirectory, {
            scope: 'run',
            ...artifact,
          })) {
            return false;
          }
        }
        return true;
      } catch (error) {
        if (isOrdinaryVerificationMiss(error)) return false;
        throw error;
      }
    },
    partialArtifacts: () => [],
    execute: async (context) => {
      const {runId, runDirectory} = requireRunContext(context);
      requirePreflight(context);
      const draft = await readDraftReport(runDirectory);
      const evidence = evidenceFromDraft(draft);
      const review = await readReview(runDirectory);
      const reviewContext: ReviewContext = {
        projectId: context.project.project.id,
        runId,
        evidencePaths: evidence.map((artifact) => artifact.path),
        ...(review === undefined ? {} : {review}),
      };
      const result = await evaluate(reviewContext);
      return {
        state: result.state,
        fingerprint: fingerprintFromDraft(draft),
        outputs: {
          evidence,
          review: result.review ?? null,
        },
        artifacts: [],
        checks: result.state === 'passed'
          ? [{
            id: 'draft-review-approved',
            severity: 'info',
            message: 'Draft review is approved.',
          }]
          : [{
            id: 'draft-review-required',
            severity: 'warning',
            message: 'Draft review approval is required before Release.',
            requiresReview: true,
            affectedPaths: evidence.map((artifact) => artifact.path),
          }],
      };
    },
  };
};

export const reviewStage = createReviewStage();
