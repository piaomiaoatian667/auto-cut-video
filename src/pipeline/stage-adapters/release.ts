import {z} from 'zod';
import {ReviewSchema, type Review} from '../../domain/review-schema';
import {
  CompiledTimelineSchema,
  type CompiledTimeline,
} from '../../domain/timeline-schema';
import {
  createOutputStore,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {
  requirePreflight,
  requireRunContext,
  type PipelineStage,
} from '../stage';
import type {StageReport} from '../stage-report';
import {
  ArtifactReferenceSchema,
  DraftReportSchema,
  type DraftReport,
} from '../stages/draft';
import {
  RELEASE_FIXED_PROFILE,
  releaseStageFingerprint,
  runRelease,
  type ReleasePreflightSnapshot,
  type ReleaseStageDependencies,
  type ReleaseStageInput,
  type ReleaseStageResult,
} from '../stages/release';
import {ReviewGateError} from '../stages/review';
import {
  STAGE_ALGORITHM_VERSIONS,
  isOrdinaryVerificationMiss,
  outputArtifact,
  readRunJson,
  readRunStageReport,
  runArtifact,
  verifyReportedArtifacts,
} from './shared';
import {parsePreflightAdapterOutput} from './preflight';

const OutputArtifactReferenceSchema = ArtifactReferenceSchema.extend({
  path: z.string().regex(/^releases\/[^/]+\/[^/]+$/u),
}).strict();

const ReleaseAdapterOutputSchema = z.object({
  mutedVideo: ArtifactReferenceSchema,
  intermediate: ArtifactReferenceSchema,
  finalVideo: OutputArtifactReferenceSchema,
  subtitles: OutputArtifactReferenceSchema,
  thumbnail: OutputArtifactReferenceSchema,
  review: OutputArtifactReferenceSchema,
  validationReport: OutputArtifactReferenceSchema,
  checksums: OutputArtifactReferenceSchema,
  releaseFingerprint: z.string().min(1),
  verification: z.object({
    sha256: z.string().min(1),
    probe: z.object({
      durationMs: z.number().nonnegative(),
      videoStreams: z.array(z.unknown()),
      audioStreams: z.array(z.unknown()),
    }).passthrough(),
    atoms: z.array(z.unknown()),
    moovBeforeMdat: z.literal(true),
  }).passthrough(),
}).strict();

export interface ReleaseStageAdapterDependencies {
  algorithmVersion?: string;
  profile?: Record<string, unknown>;
  readDraftReport?: (runDirectory: RunDirectoryScope) => Promise<DraftReport>;
  readCompiledTimeline?: (runDirectory: RunDirectoryScope) => Promise<CompiledTimeline>;
  readReview?: (runDirectory: RunDirectoryScope) => Promise<Review>;
  readPreflightReport?: (runDirectory: RunDirectoryScope) => Promise<StageReport>;
  runRelease?: (
    input: ReleaseStageInput,
    dependencies?: ReleaseStageDependencies,
  ) => Promise<ReleaseStageResult>;
  openOutputDirectory?: (
    workspaceRoot: string,
    projectId: string,
  ) => Promise<OutputDirectoryScope>;
}

const parseReleasePreflightSnapshot = (
  value: unknown,
): ReleasePreflightSnapshot => {
  const parsed = parsePreflightAdapterOutput(value);
  return {
    toolIdentities: parsed.toolIdentities,
    environmentFingerprint: parsed.environmentFingerprint,
  };
};

export const createReleaseStage = (
  dependencies: ReleaseStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.release;
  const profile = dependencies.profile ?? RELEASE_FIXED_PROFILE;
  const readDraftReport = dependencies.readDraftReport
    ?? (async (runDirectory: RunDirectoryScope) => await readRunJson(
      runDirectory,
      'draft/draft-report.json',
      (value) => DraftReportSchema.parse(value),
    ));
  const readCompiledTimeline = dependencies.readCompiledTimeline
    ?? (async (runDirectory: RunDirectoryScope) => await readRunJson(
      runDirectory,
      'compiled-timeline.json',
      (value) => CompiledTimelineSchema.parse(value),
    ));
  const readReview = dependencies.readReview
    ?? (async (runDirectory: RunDirectoryScope) => await readRunJson(
      runDirectory,
      'review.json',
      (value) => ReviewSchema.parse(value),
    ));
  const readPreflightReport = dependencies.readPreflightReport
    ?? (async (runDirectory: RunDirectoryScope) => await readRunStageReport(
      runDirectory,
      'preflight',
    ));
  const executeRelease = dependencies.runRelease ?? runRelease;
  const openOutputDirectory = dependencies.openOutputDirectory
    ?? (async (workspaceRoot: string, projectId: string) => await createOutputStore(
      workspaceRoot,
    ).openProject(projectId));

  const calculateFingerprint = async (
    runDirectory: RunDirectoryScope,
    preflight: ReleasePreflightSnapshot,
  ): Promise<string | null> => {
    const [draft, timeline, review] = await Promise.all([
      readDraftReport(runDirectory),
      readCompiledTimeline(runDirectory),
      readReview(runDirectory),
    ]);
    if (review.status !== 'approved') return null;
    return releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      review,
      preflightEnvironmentFingerprint: preflight.environmentFingerprint,
      profile,
      algorithmVersion,
    });
  };

  return {
    id: 'release',
    displayName: 'Release',
    prerequisites: ['review'],
    fingerprint: async (context) => {
      if (context.sourceRun === undefined) return null;
      const preflightReport = context.sourceRun.reports.get('preflight');
      if (preflightReport?.outputs === undefined) return null;
      let preflight: ReleasePreflightSnapshot;
      try {
        preflight = parseReleasePreflightSnapshot(preflightReport.outputs);
      } catch (error) {
        if (error instanceof z.ZodError) return null;
        throw error;
      }
      return await calculateFingerprint(context.sourceRun.runDirectory, preflight);
    },
    verify: async (context, report) => {
      const parsed = ReleaseAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      let outputDirectory: OutputDirectoryScope;
      try {
        outputDirectory = await openOutputDirectory(
          context.project.workspaceRoot,
          context.project.project.id,
        );
      } catch (error) {
        if (isOrdinaryVerificationMiss(error)) return false;
        throw error;
      }
      const outputs = parsed.data;
      return await verifyReportedArtifacts({
        context,
        report,
        expected: [
          {scope: 'run', ...outputs.mutedVideo},
          {scope: 'run', ...outputs.intermediate},
          {scope: 'output', ...outputs.finalVideo},
          {scope: 'output', ...outputs.subtitles},
          {scope: 'output', ...outputs.thumbnail},
          {scope: 'output', ...outputs.review},
          {scope: 'output', ...outputs.validationReport},
          {scope: 'output', ...outputs.checksums},
        ],
        outputDirectory,
      });
    },
    partialArtifacts: (context) => {
      const artifacts = [
        {scope: 'run' as const, path: 'release/muted-video.mp4'},
        {scope: 'run' as const, path: 'release/final-intermediate.mp4'},
      ];
      if (context.runId === undefined) return artifacts;
      return [
        ...artifacts,
        {scope: 'output' as const, path: `releases/${context.runId}/final.mp4`},
        {scope: 'output' as const, path: `releases/${context.runId}/subtitles.srt`},
        {scope: 'output' as const, path: `releases/${context.runId}/thumbnail.jpg`},
        {scope: 'output' as const, path: `releases/${context.runId}/review.json`},
        {scope: 'output' as const, path: `releases/${context.runId}/validation-report.json`},
        {scope: 'output' as const, path: `releases/${context.runId}/checksums.sha256`},
      ];
    },
    execute: async (context, signal) => {
      const {runId, runDirectory} = requireRunContext(context);
      requirePreflight(context);
      const preflightReport = await readPreflightReport(runDirectory);
      const preflight = parseReleasePreflightSnapshot(preflightReport.outputs);
      const stageFingerprint = await calculateFingerprint(runDirectory, preflight);
      if (stageFingerprint === null) {
        throw new ReviewGateError('Release requires approved Review evidence');
      }
      const result = await executeRelease({
        ...context.project,
        runDirectory,
        runId,
        preflight,
        signal,
        now: context.now,
      }, {publishCurrent: false});
      return {
        state: 'passed',
        fingerprint: stageFingerprint,
        outputs: result.outputs,
        artifacts: [
          runArtifact(result.outputs.mutedVideo),
          runArtifact(result.outputs.intermediate),
          outputArtifact(result.outputs.finalVideo),
          outputArtifact(result.outputs.subtitles),
          outputArtifact(result.outputs.thumbnail),
          outputArtifact(result.outputs.review),
          outputArtifact(result.outputs.validationReport),
          outputArtifact(result.outputs.checksums),
        ],
        checks: [],
        outputCurrent: result.current,
      };
    },
  };
};

export const releaseStage = createReleaseStage();
