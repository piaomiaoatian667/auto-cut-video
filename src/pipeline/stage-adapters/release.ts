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
  PipelineContextError,
  requirePreflight,
  requireRunContext,
  type PipelineStage,
} from '../stage';
import {
  createStageReportStore,
  StageReportValidationError,
  type StageReport,
} from '../stage-report';
import {fingerprintValue} from '../fingerprint';
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
import {evaluateReview, ReviewGateError} from '../stages/review';
import {
  STAGE_ALGORITHM_VERSIONS,
  isOrdinaryVerificationMiss,
  outputArtifact,
  readPlanningInput,
  readRunJson,
  runArtifact,
  verifyReportedArtifacts,
} from './shared';
import {normalizePreflightAdapterOutput} from './preflight';

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
  readStageReport?: (
    runDirectory: RunDirectoryScope,
    stageId: 'preflight' | 'compile',
  ) => Promise<StageReport | null>;
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
  const parsed = normalizePreflightAdapterOutput(value);
  return {
    toolIdentities: parsed.toolIdentities,
    environmentFingerprint: parsed.environmentFingerprint,
  };
};

const requireBoundStageReport = (
  report: StageReport | null,
  projectId: string,
  runId: string,
  stageId: 'preflight' | 'compile',
): StageReport => {
  if (report === null) {
    throw new StageReportValidationError(`missing ${stageId} Stage report`);
  }
  if (
    report.projectId !== projectId
    || report.runId !== runId
    || report.stageId !== stageId
  ) {
    throw new StageReportValidationError(
      `${stageId} Stage report is not bound to ${projectId}/${runId}`,
    );
  }
  return report;
};

const releaseExpectedArtifacts = (
  outputs: {
    mutedVideo: {path: string; sha256: string};
    intermediate: {path: string; sha256: string};
    finalVideo: {path: string; sha256: string};
    subtitles: {path: string; sha256: string};
    thumbnail: {path: string; sha256: string};
    review: {path: string; sha256: string};
    validationReport: {path: string; sha256: string};
    checksums: {path: string; sha256: string};
  },
  runId: string,
) => {
  const references = [
    {scope: 'run' as const, artifact: outputs.mutedVideo, path: 'release/muted-video.mp4'},
    {
      scope: 'run' as const,
      artifact: outputs.intermediate,
      path: 'release/final-intermediate.mp4',
    },
    {scope: 'output' as const, artifact: outputs.finalVideo, path: `releases/${runId}/final.mp4`},
    {scope: 'output' as const, artifact: outputs.subtitles, path: `releases/${runId}/subtitles.srt`},
    {scope: 'output' as const, artifact: outputs.thumbnail, path: `releases/${runId}/thumbnail.jpg`},
    {scope: 'output' as const, artifact: outputs.review, path: `releases/${runId}/review.json`},
    {
      scope: 'output' as const,
      artifact: outputs.validationReport,
      path: `releases/${runId}/validation-report.json`,
    },
    {scope: 'output' as const, artifact: outputs.checksums, path: `releases/${runId}/checksums.sha256`},
  ];
  if (references.some(({artifact, path}) => artifact.path !== path)) return null;
  const paths = new Set(references.map(({scope, artifact}) => `${scope}:${artifact.path}`));
  if (paths.size !== references.length) return null;
  return references.map(({scope, artifact}) => ({scope, ...artifact}));
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
  const stageReportStore = createStageReportStore();
  const readStageReport = dependencies.readStageReport
    ?? (async (runDirectory, stageId) => await stageReportStore.readStage(
      runDirectory,
      stageId,
    ));
  const executeRelease = dependencies.runRelease ?? runRelease;
  const openOutputDirectory = dependencies.openOutputDirectory
    ?? (async (workspaceRoot: string, projectId: string) => await createOutputStore(
      workspaceRoot,
    ).openProject(projectId));

  const calculateFingerprint = async (
    runDirectory: RunDirectoryScope,
    runId: string,
    projectId: string,
    preflight: ReleasePreflightSnapshot,
    compileStageFingerprint: string,
  ): Promise<string | null> => {
    const [draft, timeline, review] = await Promise.all([
      readDraftReport(runDirectory),
      readCompiledTimeline(runDirectory),
      readReview(runDirectory),
    ]);
    if (draft.projectId !== projectId || timeline.projectId !== projectId) return null;
    let approvedReview: Review;
    try {
      const gate = await evaluateReview({
        projectId,
        runId,
        evidencePaths: [
          draft.outputs.contactSheet.path,
          ...draft.outputs.reviewFrames.map((frame) => frame.path),
        ],
        review,
      });
      if (gate.state !== 'passed' || gate.review === undefined) return null;
      approvedReview = gate.review;
    } catch (error) {
      if (error instanceof ReviewGateError) return null;
      throw error;
    }
    return releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      compileStageFingerprint,
      compiledTimeline: timeline,
      review: approvedReview,
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
      return await readPlanningInput(async () => {
        const [preflightReportValue, compileReportValue] = await Promise.all([
          readStageReport(context.sourceRun!.runDirectory, 'preflight'),
          readStageReport(context.sourceRun!.runDirectory, 'compile'),
        ]);
        const preflightReport = requireBoundStageReport(
          preflightReportValue,
          context.project.project.id,
          context.sourceRun!.runId,
          'preflight',
        );
        const compileReport = requireBoundStageReport(
          compileReportValue,
          context.project.project.id,
          context.sourceRun!.runId,
          'compile',
        );
        const preflight = parseReleasePreflightSnapshot(preflightReport.outputs);
        return await calculateFingerprint(
          context.sourceRun!.runDirectory,
          context.sourceRun!.runId,
          context.project.project.id,
          preflight,
          compileReport.fingerprint!,
        );
      });
    },
    verify: async (context, report) => {
      const parsed = ReleaseAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      const expected = releaseExpectedArtifacts(parsed.data, report.runId);
      if (expected === null) return false;
      const currentFingerprint = await readPlanningInput(async () => await (
        context.sourceRun === undefined
          ? Promise.resolve(null)
          : createReleaseStage(dependencies).fingerprint(context)
      ));
      if (
        currentFingerprint === null
        || report.fingerprint !== currentFingerprint
        || parsed.data.releaseFingerprint !== currentFingerprint
      ) return false;
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
      return await verifyReportedArtifacts({
        context,
        report,
        expected,
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
      const livePreflight = requirePreflight(context);
      const [preflightReportValue, compileReportValue] = await Promise.all([
        readStageReport(runDirectory, 'preflight'),
        readStageReport(runDirectory, 'compile'),
      ]);
      const preflightReport = requireBoundStageReport(
        preflightReportValue,
        context.project.project.id,
        runId,
        'preflight',
      );
      const compileReport = requireBoundStageReport(
        compileReportValue,
        context.project.project.id,
        runId,
        'compile',
      );
      if (
        fingerprintValue(normalizePreflightAdapterOutput(preflightReport.outputs))
        !== fingerprintValue(normalizePreflightAdapterOutput(livePreflight))
      ) {
        throw new PipelineContextError(
          'Release Preflight report does not match live Preflight results',
        );
      }
      const preflight = parseReleasePreflightSnapshot(preflightReport.outputs);
      const stageFingerprint = await calculateFingerprint(
        runDirectory,
        runId,
        context.project.project.id,
        preflight,
        compileReport.fingerprint!,
      );
      if (stageFingerprint === null) {
        throw new ReviewGateError('Release requires approved Review evidence');
      }
      const result = await executeRelease({
        ...context.project,
        runDirectory,
        runId,
        preflight,
        compileStageFingerprint: compileReport.fingerprint!,
        signal,
        now: context.now,
      }, {
        publishCurrent: false,
        profile,
        algorithmVersion,
      });
      if (result.outputs.releaseFingerprint !== stageFingerprint) {
        throw new PipelineContextError(
          'Release output fingerprint does not match adapter inputs',
        );
      }
      const expected = releaseExpectedArtifacts(result.outputs, runId);
      if (expected === null) {
        throw new PipelineContextError('Release returned invalid artifact paths');
      }
      return {
        state: 'passed',
        fingerprint: stageFingerprint,
        outputs: result.outputs,
        artifacts: expected.map((artifact) => artifact.scope === 'run'
          ? runArtifact(artifact)
          : outputArtifact(artifact)),
        checks: [],
        outputCurrent: result.current,
      };
    },
  };
};

export const releaseStage = createReleaseStage();
