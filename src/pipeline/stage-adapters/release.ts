import {z} from 'zod';
import {ReviewSchema, type Review} from '../../domain/review-schema';
import {
  CompiledTimelineSchema,
  type CompiledTimeline,
} from '../../domain/timeline-schema';
import {
  createOutputStore,
  openExistingOutputFileForRead,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {
  ReleaseVerificationError,
  ReleaseVerificationReportSchema,
  validateReleaseVerificationReport,
} from '../../media/release-verify';
import {
  PipelineContextError,
  requirePreflight,
  requireRunContext,
  type PipelineStage,
} from '../stage';
import {
  createStageReportStore,
  type StageReport,
} from '../stage-report';
import {fingerprintValue} from '../fingerprint';
import {verifyRunArtifact} from '../artifacts';
import {
  ArtifactReferenceSchema,
  DraftReportSchema,
  draftReviewEvidenceArtifacts,
  type DraftReport,
} from '../stages/draft';
import {
  buildReleaseValidationReport,
  formatReleaseChecksums,
  releaseChecksumArtifacts,
  releaseCurrentPointer,
  releaseOutputPath,
  releaseSrtFromTimeline,
  releaseStageFingerprint,
  ReleaseOutputArtifactReferenceSchema,
  ReleaseValidationReportSchema,
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
  loadSuccessfulBoundStageReport,
  outputArtifact,
  readPlanningInput,
  readRunJson,
  runArtifact,
  verifyReportedArtifacts,
} from './shared';
import {normalizePreflightAdapterOutput} from './preflight';

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

const ReleaseAdapterOutputSchema = z.object({
  mutedVideo: ArtifactReferenceSchema,
  intermediate: ArtifactReferenceSchema,
  finalVideo: ReleaseOutputArtifactReferenceSchema,
  subtitles: ReleaseOutputArtifactReferenceSchema,
  thumbnail: ReleaseOutputArtifactReferenceSchema,
  review: ReleaseOutputArtifactReferenceSchema,
  validationReport: ReleaseOutputArtifactReferenceSchema,
  checksums: ReleaseOutputArtifactReferenceSchema,
  releaseFingerprint: HashSchema,
  verification: ReleaseVerificationReportSchema,
}).strict().superRefine((outputs, context) => {
  if (outputs.verification.sha256 !== outputs.finalVideo.sha256) {
    context.addIssue({
      code: 'custom',
      path: ['verification', 'sha256'],
      message: 'must match finalVideo.sha256',
    });
  }
});

export interface ReleaseStageAdapterDependencies {
  algorithmVersion?: string;
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
  ) => Promise<OutputDirectoryScope | null>;
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

const releaseToolsAvailable = (
  preflight: ReleasePreflightSnapshot,
): boolean => (
  preflight.toolIdentities.ffmpeg !== null
  && preflight.toolIdentities.ffprobe !== null
  && preflight.toolIdentities.qtFaststart !== null
);

const requireReleaseTools = (preflight: ReleasePreflightSnapshot): void => {
  if (!releaseToolsAvailable(preflight)) {
    throw new PipelineContextError(
      'Release requires persisted FFmpeg, FFprobe, and qt-faststart identities',
    );
  }
};

const readOutputText = async (
  outputDirectory: OutputDirectoryScope,
  relativePath: string,
): Promise<string> => {
  const authority = await openExistingOutputFileForRead(outputDirectory, relativePath);
  try {
    const contents = await authority.handle.readFile('utf8');
    await authority.revalidate();
    return contents;
  } finally {
    await authority.close();
  }
};

const readOutputJson = async <Output>(
  outputDirectory: OutputDirectoryScope,
  relativePath: string,
  parse: (value: unknown) => Output,
): Promise<Output> => parse(JSON.parse(await readOutputText(outputDirectory, relativePath)));

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
    {scope: 'output' as const, artifact: outputs.finalVideo, path: releaseOutputPath(runId, 'final.mp4')},
    {scope: 'output' as const, artifact: outputs.subtitles, path: releaseOutputPath(runId, 'subtitles.srt')},
    {scope: 'output' as const, artifact: outputs.thumbnail, path: releaseOutputPath(runId, 'thumbnail.jpg')},
    {scope: 'output' as const, artifact: outputs.review, path: releaseOutputPath(runId, 'review.json')},
    {
      scope: 'output' as const,
      artifact: outputs.validationReport,
      path: releaseOutputPath(runId, 'validation-report.json'),
    },
    {scope: 'output' as const, artifact: outputs.checksums, path: releaseOutputPath(runId, 'checksums.sha256')},
  ];
  if (references.some(({artifact, path}) => artifact.path !== path)) return null;
  const paths = new Set(references.map(({scope, artifact}) => `${scope}:${artifact.path}`));
  if (paths.size !== references.length) return null;
  return references.map(({scope, artifact}) => ({scope, ...artifact}));
};

interface ReleasePlan {
  draft: DraftReport;
  timeline: CompiledTimeline;
  review: Review;
  fingerprint: string;
}

const verifyReleaseAuditMetadata = async ({
  outputDirectory,
  projectId,
  runId,
  preflight,
  plan,
  outputs,
}: {
  outputDirectory: OutputDirectoryScope;
  projectId: string;
  runId: string;
  preflight: ReleasePreflightSnapshot;
  plan: ReleasePlan;
  outputs: z.infer<typeof ReleaseAdapterOutputSchema>;
}): Promise<boolean> => {
  const persisted = await readPlanningInput(async () => {
    const [review, subtitles, validationReport, checksums] = await Promise.all([
      readOutputJson(outputDirectory, outputs.review.path, (value) => ReviewSchema.parse(value)),
      readOutputText(outputDirectory, outputs.subtitles.path),
      readOutputJson(
        outputDirectory,
        outputs.validationReport.path,
        (value) => ReleaseValidationReportSchema.parse(value),
      ),
      readOutputText(outputDirectory, outputs.checksums.path),
    ]);
    return {review, subtitles, validationReport, checksums};
  });
  if (persisted === null) return false;
  try {
    validateReleaseVerificationReport(outputs.verification, persisted.subtitles);
  } catch (error) {
    if (error instanceof ReleaseVerificationError) return false;
    throw error;
  }
  const expectedValidationReport = buildReleaseValidationReport({
    projectId,
    runId,
    releaseFingerprint: outputs.releaseFingerprint,
    preflight,
    draftAudio: plan.draft.outputs.audio,
    intermediate: outputs.intermediate,
    finalVideo: outputs.finalVideo,
    subtitles: outputs.subtitles,
    thumbnail: outputs.thumbnail,
    review: outputs.review,
    verification: outputs.verification,
  });
  return fingerprintValue(persisted.review) === fingerprintValue(plan.review)
    && persisted.subtitles === releaseSrtFromTimeline(plan.timeline)
    && fingerprintValue(persisted.validationReport)
      === fingerprintValue(expectedValidationReport)
    && persisted.checksums === formatReleaseChecksums(releaseChecksumArtifacts(outputs));
};

export const createReleaseStage = (
  dependencies: ReleaseStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.release;
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
    ).openExistingProject(projectId));

  const calculatePlan = async (
    runDirectory: RunDirectoryScope,
    runId: string,
    projectId: string,
    preflight: ReleasePreflightSnapshot,
    compileStageFingerprint: string,
  ): Promise<ReleasePlan | null> => {
    if (!releaseToolsAvailable(preflight)) return null;
    const [draft, timeline, review] = await Promise.all([
      readDraftReport(runDirectory),
      readCompiledTimeline(runDirectory),
      readReview(runDirectory),
    ]);
    if (draft.projectId !== projectId || timeline.projectId !== projectId) return null;
    const evidence = draftReviewEvidenceArtifacts(draft);
    for (const artifact of evidence) {
      if (!await verifyRunArtifact(runDirectory, {scope: 'run', ...artifact})) {
        return null;
      }
    }
    let approvedReview: Review;
    try {
      const gate = await evaluateReview({
        projectId,
        runId,
        evidencePaths: evidence.map((artifact) => artifact.path),
        review,
      });
      if (gate.state !== 'passed' || gate.review === undefined) return null;
      approvedReview = gate.review;
    } catch (error) {
      if (error instanceof ReviewGateError) return null;
      throw error;
    }
    return {
      draft,
      timeline,
      review: approvedReview,
      fingerprint: releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      compileStageFingerprint,
      compiledTimeline: timeline,
      review: approvedReview,
      preflightEnvironmentFingerprint: preflight.environmentFingerprint,
      algorithmVersion,
      }),
    };
  };

  return {
    id: 'release',
    displayName: 'Release',
    prerequisites: ['review'],
    fingerprint: async (context) => {
      if (context.sourceRun === undefined) return null;
      return await readPlanningInput(async () => {
        const [preflightReport, compileReport] = await Promise.all([
          loadSuccessfulBoundStageReport({
            runDirectory: context.sourceRun!.runDirectory,
            projectId: context.project.project.id,
            runId: context.sourceRun!.runId,
            stageId: 'preflight',
            readStageReport,
          }),
          loadSuccessfulBoundStageReport({
            runDirectory: context.sourceRun!.runDirectory,
            projectId: context.project.project.id,
            runId: context.sourceRun!.runId,
            stageId: 'compile',
            readStageReport,
          }),
        ]);
        const preflight = parseReleasePreflightSnapshot(preflightReport.outputs);
        const plan = await calculatePlan(
          context.sourceRun!.runDirectory,
          context.sourceRun!.runId,
          context.project.project.id,
          preflight,
          compileReport.fingerprint,
        );
        return plan?.fingerprint ?? null;
      });
    },
    verify: async (context, report) => {
      const parsed = ReleaseAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      const expected = releaseExpectedArtifacts(parsed.data, report.runId);
      if (expected === null) return false;
      if (context.sourceRun === undefined) return false;
      const planning = await readPlanningInput(async () => {
        const [preflightReport, compileReport] = await Promise.all([
          loadSuccessfulBoundStageReport({
            runDirectory: context.sourceRun!.runDirectory,
            projectId: context.project.project.id,
            runId: context.sourceRun!.runId,
            stageId: 'preflight',
            readStageReport,
          }),
          loadSuccessfulBoundStageReport({
            runDirectory: context.sourceRun!.runDirectory,
            projectId: context.project.project.id,
            runId: context.sourceRun!.runId,
            stageId: 'compile',
            readStageReport,
          }),
        ]);
        const preflight = parseReleasePreflightSnapshot(preflightReport.outputs);
        const plan = await calculatePlan(
          context.sourceRun!.runDirectory,
          context.sourceRun!.runId,
          context.project.project.id,
          preflight,
          compileReport.fingerprint,
        );
        return plan === null ? null : {preflight, plan};
      });
      if (
        planning === null
        || report.fingerprint !== planning.plan.fingerprint
        || parsed.data.releaseFingerprint !== planning.plan.fingerprint
      ) return false;
      let outputDirectory: OutputDirectoryScope | null;
      try {
        outputDirectory = await openOutputDirectory(
          context.project.workspaceRoot,
          context.project.project.id,
        );
      } catch (error) {
        if (isOrdinaryVerificationMiss(error)) return false;
        throw error;
      }
      if (outputDirectory === null) return false;
      if (!await verifyReleaseAuditMetadata({
        outputDirectory,
        projectId: context.project.project.id,
        runId: context.sourceRun.runId,
        preflight: planning.preflight,
        plan: planning.plan,
        outputs: parsed.data,
      })) return false;
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
        {scope: 'output' as const, path: releaseOutputPath(context.runId, 'final.mp4')},
        {scope: 'output' as const, path: releaseOutputPath(context.runId, 'subtitles.srt')},
        {scope: 'output' as const, path: releaseOutputPath(context.runId, 'thumbnail.jpg')},
        {scope: 'output' as const, path: releaseOutputPath(context.runId, 'review.json')},
        {scope: 'output' as const, path: releaseOutputPath(context.runId, 'validation-report.json')},
        {scope: 'output' as const, path: releaseOutputPath(context.runId, 'checksums.sha256')},
      ];
    },
    execute: async (context, signal) => {
      const {runId, runDirectory} = requireRunContext(context);
      const livePreflight = requirePreflight(context);
      const [preflightReport, compileReport] = await Promise.all([
        loadSuccessfulBoundStageReport({
          runDirectory,
          projectId: context.project.project.id,
          runId,
          stageId: 'preflight',
          readStageReport,
        }),
        loadSuccessfulBoundStageReport({
          runDirectory,
          projectId: context.project.project.id,
          runId,
          stageId: 'compile',
          readStageReport,
        }),
      ]);
      if (
        fingerprintValue(normalizePreflightAdapterOutput(preflightReport.outputs))
        !== fingerprintValue(normalizePreflightAdapterOutput(livePreflight))
      ) {
        throw new PipelineContextError(
          'Release Preflight report does not match live Preflight results',
        );
      }
      const preflight = parseReleasePreflightSnapshot(preflightReport.outputs);
      requireReleaseTools(preflight);
      const plan = await calculatePlan(
        runDirectory,
        runId,
        context.project.project.id,
        preflight,
        compileReport.fingerprint,
      );
      if (plan === null) {
        throw new ReviewGateError('Release requires approved Review evidence');
      }
      const stageFingerprint = plan.fingerprint;
      const publishedAt = context.now();
      const outputCurrent = releaseCurrentPointer(runId, publishedAt);
      const result = await executeRelease({
        ...context.project,
        runDirectory,
        runId,
        preflight,
        compileStageFingerprint: compileReport.fingerprint,
        signal,
        now: () => publishedAt,
      }, {
        publishCurrent: false,
        algorithmVersion,
      });
      if (result.outputs.releaseFingerprint !== stageFingerprint) {
        throw new PipelineContextError(
          'Release output fingerprint does not match adapter inputs',
        );
      }
      const parsedOutputs = ReleaseAdapterOutputSchema.safeParse(result.outputs);
      if (!parsedOutputs.success) {
        throw new PipelineContextError('Release returned internally inconsistent outputs');
      }
      if (fingerprintValue(result.current) !== fingerprintValue(outputCurrent)) {
        throw new PipelineContextError('Release returned an invalid current pointer candidate');
      }
      const expected = releaseExpectedArtifacts(parsedOutputs.data, runId);
      if (expected === null) {
        throw new PipelineContextError('Release returned invalid artifact paths');
      }
      const outputDirectory = await readPlanningInput(async () => await openOutputDirectory(
        context.project.workspaceRoot,
        context.project.project.id,
      ));
      if (
        outputDirectory === null
        || !await verifyReleaseAuditMetadata({
          outputDirectory,
          projectId: context.project.project.id,
          runId,
          preflight,
          plan,
          outputs: parsedOutputs.data,
        })
      ) {
        throw new PipelineContextError('Release returned invalid audit metadata');
      }
      return {
        state: 'passed',
        fingerprint: stageFingerprint,
        outputs: parsedOutputs.data,
        artifacts: expected.map((artifact) => artifact.scope === 'run'
          ? runArtifact(artifact)
          : outputArtifact(artifact)),
        checks: [],
        outputCurrent,
      };
    },
  };
};

export const releaseStage = createReleaseStage();
