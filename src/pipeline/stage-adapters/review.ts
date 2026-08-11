import {z} from 'zod';
import {ReviewSchema, type Review} from '../../domain/review-schema';
import type {RunDirectoryScope} from '../../fs/app-directory-scopes';
import {verifyRunArtifact} from '../artifacts';
import {fingerprintValue} from '../fingerprint';
import {
  PipelineContextError,
  requirePreflight,
  requireRunContext,
  type PipelineStage,
} from '../stage';
import {
  DraftReportSchema,
  draftReviewEvidenceArtifacts,
  type DraftReport,
} from '../stages/draft';
import {
  evaluateReview,
  ReviewGateError,
  type ReviewContext,
} from '../stages/review';
import {
  STAGE_ALGORITHM_VERSIONS,
  isOrdinaryPersistedInputMiss,
  readOptionalRunJson,
  readPlanningInput,
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

const evidenceFromDraft = draftReviewEvidenceArtifacts;

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
    fingerprint: async (context) => {
      if (context.sourceRun === undefined) return null;
      const draft = await readPlanningInput(async () => await readDraftReport(
        context.sourceRun!.runDirectory,
      ));
      return draft === null || draft.projectId !== context.project.project.id
        ? null
        : fingerprintFromDraft(draft);
    },
    verify: async (context, report) => {
      if (report.state !== 'passed' && report.state !== 'cached') return false;
      const parsed = ReviewAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success || parsed.data.review?.status !== 'approved') return false;
      if (context.sourceRun === undefined) return false;
      try {
        const currentDraft = await readDraftReport(context.sourceRun.runDirectory);
        if (currentDraft.projectId !== context.project.project.id) return false;
        const currentEvidence = evidenceFromDraft(currentDraft);
        if (
          fingerprintValue(currentEvidence)
          !== fingerprintValue(parsed.data.evidence)
          || report.fingerprint !== fingerprintFromDraft(currentDraft)
        ) {
          return false;
        }
        const currentReview = await readReview(context.sourceRun.runDirectory);
        if (currentReview === undefined) {
          return false;
        }
        const gate = await evaluate({
          projectId: context.project.project.id,
          runId: context.sourceRun.runId,
          evidencePaths: currentEvidence.map((artifact) => artifact.path),
          review: currentReview,
        });
        if (
          gate.state !== 'passed'
          || gate.review === undefined
          || fingerprintValue(gate.review) !== fingerprintValue(parsed.data.review)
        ) return false;
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
        if (error instanceof ReviewGateError || isOrdinaryPersistedInputMiss(error)) {
          return false;
        }
        throw error;
      }
    },
    partialArtifacts: () => [],
    execute: async (context) => {
      const {runId, runDirectory} = requireRunContext(context);
      requirePreflight(context);
      const draft = await readDraftReport(runDirectory);
      if (draft.projectId !== context.project.project.id) {
        throw new PipelineContextError('Draft report belongs to another project');
      }
      const evidence = evidenceFromDraft(draft);
      for (const artifact of evidence) {
        if (!await verifyRunArtifact(runDirectory, {scope: 'run', ...artifact})) {
          throw new PipelineContextError(
            `Draft review evidence is missing or changed: ${artifact.path}`,
          );
        }
      }
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
