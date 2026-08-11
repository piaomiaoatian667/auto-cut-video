import {z} from 'zod';
import {CompiledTimelineSchema, type CompiledTimeline} from '../../domain/timeline-schema';
import type {RunDirectoryScope} from '../../fs/app-directory-scopes';
import {
  AUDIO_MIX_ALGORITHM_VERSION,
} from '../../media/audio-mix';
import {selectReviewFrames} from '../../media/contact-sheet';
import {fingerprintValue} from '../fingerprint';
import {
  PipelineContextError,
  requirePreflight,
  requireRunContext,
  type PipelinePartialArtifact,
  type PipelineStage,
  type StagePlanningContext,
} from '../stage';
import type {StageReport} from '../stage-report';
import {
  ArtifactReferenceSchema,
  runDraft,
  type DraftStageInput,
  type DraftStageResult,
} from '../stages/draft';
import {
  STAGE_ALGORITHM_VERSIONS,
  planningReportFingerprint,
  readPlanningInput,
  readRunJson,
  readRunStageReport,
  runArtifact,
  verifyReportedArtifacts,
} from './shared';

const DraftAdapterOutputSchema = z.object({
  reportPath: z.literal('draft/draft-report.json'),
  outputs: z.object({
    mutedVideo: ArtifactReferenceSchema,
    draftVideo: ArtifactReferenceSchema,
    contactSheet: ArtifactReferenceSchema,
    reviewFrames: z.array(ArtifactReferenceSchema).min(1),
    audio: z.object({
      filterGraph: ArtifactReferenceSchema,
      mixedAudio: ArtifactReferenceSchema,
    }).strict(),
    report: ArtifactReferenceSchema,
    audioMixFingerprint: z.string().min(1),
  }).strict(),
}).strict();

export interface DraftStageAdapterDependencies {
  algorithmVersion?: string;
  readStageReport?: (
    runDirectory: RunDirectoryScope,
    stageId: 'compile',
  ) => Promise<StageReport>;
  readCompiledTimeline?: (runDirectory: RunDirectoryScope) => Promise<CompiledTimeline>;
  runDraft?: (input: DraftStageInput) => Promise<DraftStageResult>;
}

const baselinePartialArtifacts = (): PipelinePartialArtifact[] => [
  {scope: 'run', path: 'draft/muted-video.mp4'},
  {scope: 'run', path: 'audio/filter-graph.txt'},
  {scope: 'run', path: 'audio/mixed-raw.wav'},
  {scope: 'run', path: 'audio/mixed-normalized.wav'},
  {scope: 'run', path: 'draft/draft.mp4'},
  {scope: 'run', path: 'draft/contact-sheet.jpg'},
  {scope: 'run', path: 'draft/draft-report.json'},
];

const uniquePartialArtifacts = (
  artifacts: readonly PipelinePartialArtifact[],
): PipelinePartialArtifact[] => {
  const byPath = new Map<string, PipelinePartialArtifact>();
  for (const artifact of artifacts) {
    byPath.set(`${artifact.scope}:${artifact.path}`, artifact);
  }
  return [...byPath.values()];
};

const draftExpectedArtifacts = (
  outputs: z.infer<typeof DraftAdapterOutputSchema>['outputs'],
  expectedFramePaths: readonly string[],
) => {
  if (
    outputs.mutedVideo.path !== 'draft/muted-video.mp4'
    || outputs.draftVideo.path !== 'draft/draft.mp4'
    || outputs.contactSheet.path !== 'draft/contact-sheet.jpg'
    || outputs.audio.filterGraph.path !== 'audio/filter-graph.txt'
    || outputs.audio.mixedAudio.path !== 'audio/mixed-normalized.wav'
    || outputs.report.path !== 'draft/draft-report.json'
  ) return null;
  const framePaths = outputs.reviewFrames.map((frame) => frame.path);
  if (
    framePaths.length !== expectedFramePaths.length
    || framePaths.some((framePath, index) => framePath !== expectedFramePaths[index])
    || new Set(framePaths).size !== framePaths.length
  ) return null;
  const artifacts = [
    outputs.mutedVideo,
    outputs.draftVideo,
    outputs.contactSheet,
    ...outputs.reviewFrames,
    outputs.audio.filterGraph,
    outputs.audio.mixedAudio,
    outputs.report,
  ];
  if (new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length) {
    return null;
  }
  return artifacts.map((artifact) => ({scope: 'run' as const, ...artifact}));
};

export const createDraftStage = (
  dependencies: DraftStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.draft;
  const readStageReport = dependencies.readStageReport ?? readRunStageReport;
  const readTimeline = dependencies.readCompiledTimeline
    ?? (async (runDirectory: RunDirectoryScope) => await readRunJson(
      runDirectory,
      'compiled-timeline.json',
      (value) => CompiledTimelineSchema.parse(value),
    ));
  const executeDraft = dependencies.runDraft ?? runDraft;
  const partialArtifactsByRun = new WeakMap<
    RunDirectoryScope,
    readonly PipelinePartialArtifact[]
  >();

  const calculateFingerprint = (
    context: StagePlanningContext,
    compileFingerprint: string | null,
  ): string | null => {
    const ffmpegIdentity = context.preflight?.toolIdentities.ffmpeg;
    const ffprobeIdentity = context.preflight?.toolIdentities.ffprobe;
    if (
      compileFingerprint === null
      || ffmpegIdentity === undefined
      || ffmpegIdentity === null
      || ffprobeIdentity === undefined
      || ffprobeIdentity === null
    ) return null;
    return fingerprintValue({
      algorithmVersion,
      compileFingerprint,
      audio: context.project.project.audio,
      render: context.project.project.render,
      audioMixAlgorithmVersion: AUDIO_MIX_ALGORITHM_VERSION,
      ffmpegIdentity,
      ffprobeIdentity,
    });
  };

  return {
    id: 'draft',
    displayName: 'Draft',
    prerequisites: ['compile'],
    fingerprint: async (context) => calculateFingerprint(
      context,
      planningReportFingerprint(context, 'compile'),
    ),
    verify: async (context, report) => {
      const parsed = DraftAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      if (context.sourceRun === undefined) return false;
      const timeline = await readPlanningInput(async () => await readTimeline(
        context.sourceRun!.runDirectory,
      ));
      if (timeline === null || timeline.projectId !== context.project.project.id) {
        return false;
      }
      const outputs = parsed.data.outputs;
      const expected = draftExpectedArtifacts(
        outputs,
        selectReviewFrames(timeline).map((frame) =>
          `draft/frames/frame-${String(frame).padStart(6, '0')}.jpg`),
      );
      if (expected === null) return false;
      return await verifyReportedArtifacts({
        context,
        report,
        expected,
      });
    },
    partialArtifacts: (context) => context.runDirectory === undefined
      ? baselinePartialArtifacts()
      : partialArtifactsByRun.get(context.runDirectory) ?? baselinePartialArtifacts(),
    execute: async (context, signal) => {
      const {runDirectory} = requireRunContext(context);
      const preflight = requirePreflight(context);
      const ffmpegIdentity = preflight.toolIdentities.ffmpeg;
      const ffprobeIdentity = preflight.toolIdentities.ffprobe;
      if (ffmpegIdentity === null || ffprobeIdentity === null) {
        throw new PipelineContextError(
          'Draft requires Preflight FFmpeg and FFprobe identities',
        );
      }
      const compileReport = await readStageReport(runDirectory, 'compile');
      const stageFingerprint = calculateFingerprint(context, compileReport.fingerprint);
      if (stageFingerprint === null) {
        throw new PipelineContextError('Draft requires a passed Compile report');
      }
      const timeline = await readTimeline(runDirectory);
      const expectedFramePaths = selectReviewFrames(timeline).map((frame) =>
        `draft/frames/frame-${String(frame).padStart(6, '0')}.jpg`);
      partialArtifactsByRun.set(runDirectory, [
        ...baselinePartialArtifacts(),
        ...expectedFramePaths.map((framePath) => ({
          scope: 'run' as const,
          path: framePath,
        })),
      ]);
      const result = await executeDraft({
        ...context.project,
        runDirectory,
        ffmpegExecutable: ffmpegIdentity.realPath,
        ffprobeExecutable: ffprobeIdentity.realPath,
        signal,
      });
      const expected = draftExpectedArtifacts(result.outputs, expectedFramePaths);
      if (expected === null) {
        throw new PipelineContextError('Draft returned invalid owned artifact paths');
      }
      const artifacts = expected.map(runArtifact);
      partialArtifactsByRun.set(
        runDirectory,
        uniquePartialArtifacts([
          ...(partialArtifactsByRun.get(runDirectory) ?? baselinePartialArtifacts()),
          ...artifacts.map((artifact) => ({
            scope: artifact.scope,
            path: artifact.path,
          })),
        ]),
      );
      return {
        state: 'passed',
        fingerprint: stageFingerprint,
        outputs: result,
        artifacts,
        checks: [],
      };
    },
  };
};

export const draftStage = createDraftStage();
