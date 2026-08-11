import {createHash} from 'node:crypto';
import {z} from 'zod';
import {
  CaptionsManifestSchema,
  NarrationManifestSchema,
} from '../../domain/manifest-schema';
import {CompiledTimelineSchema, type CompiledTimeline} from '../../domain/timeline-schema';
import type {ProjectDirectoryScope} from '../../fs/project-paths';
import {openExistingProjectFile} from '../../fs/project-paths';
import {componentRegistry} from '../../remotion/registry';
import {compileTimeline, TimelineCompileError} from '../../timeline/compiler';
import {hashRunArtifact} from '../artifacts';
import {fingerprintValue} from '../fingerprint';
import {
  requirePreflight,
  requireRunContext,
  type PipelineStage,
  type StagePlanningContext,
} from '../stage';
import type {StageReport} from '../stage-report';
import {IngestManifestSchema} from '../stages/ingest';
import {runCompile, type CompileInput} from '../stages/compile';
import {
  STAGE_ALGORITHM_VERSIONS,
  loadSuccessfulBoundStageReport,
  readPlanningInput,
  readRunJson,
  readRunStageReport,
  verifyReportedArtifacts,
} from './shared';

const CompileAdapterOutputSchema = z.object({
  timelinePath: z.literal('compiled-timeline.json'),
  timeline: CompiledTimelineSchema,
}).strict();

type CompileAdapterOutput = z.infer<typeof CompileAdapterOutputSchema>;

const systemHashProjectFile = async (
  projectDirectory: ProjectDirectoryScope,
  relativePath: string,
): Promise<string> => {
  const handle = await openExistingProjectFile(projectDirectory, relativePath);
  try {
    return `sha256:${createHash('sha256').update(await handle.readFile()).digest('hex')}`;
  } finally {
    await handle.close();
  }
};

export interface CompileStageAdapterDependencies {
  algorithmVersion?: string;
  componentIds?: readonly string[];
  hashProjectFile?: typeof systemHashProjectFile;
  readStageReport?: (
    runDirectory: Parameters<typeof readRunStageReport>[0],
    stageId: 'ingest' | 'narration',
  ) => Promise<StageReport | null>;
  runCompile?: (input: CompileInput) => Promise<CompileAdapterOutput>;
  hashRunArtifact?: typeof hashRunArtifact;
}

export const createCompileStage = (
  dependencies: CompileStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.compile;
  const componentIds = [...(
    dependencies.componentIds ?? Object.keys(componentRegistry)
  )].sort();
  const hashProjectFile = dependencies.hashProjectFile ?? systemHashProjectFile;
  const readStageReport = dependencies.readStageReport ?? readRunStageReport;
  const executeCompile = dependencies.runCompile ?? runCompile;
  const hashArtifact = dependencies.hashRunArtifact ?? hashRunArtifact;

  const readAuthoringHashes = async (
    context: StagePlanningContext,
  ): Promise<Record<'authoring:project' | 'authoring:script' | 'authoring:edit', string>> => {
    const [projectHash, scriptHash, editHash] = await Promise.all([
      hashProjectFile(context.project.projectDirectory, 'project.json'),
      hashProjectFile(context.project.projectDirectory, 'script.json'),
      hashProjectFile(context.project.projectDirectory, 'edit.json'),
    ]);
    return {
      'authoring:project': projectHash,
      'authoring:script': scriptHash,
      'authoring:edit': editHash,
    };
  };

  const fingerprintFromInputs = ({
    authoringHashes,
    ingestFingerprint,
    narrationFingerprint,
  }: {
    authoringHashes: Record<'authoring:project' | 'authoring:script' | 'authoring:edit', string>;
    ingestFingerprint: string;
    narrationFingerprint: string;
  }): string => fingerprintValue({
    algorithmVersion,
    authoringHashes: {
      project: authoringHashes['authoring:project'],
      script: authoringHashes['authoring:script'],
      edit: authoringHashes['authoring:edit'],
    },
    prerequisiteFingerprints: {
      ingest: ingestFingerprint,
      narration: narrationFingerprint,
    },
    componentIds,
  });

  const calculateFingerprint = async ({
    context,
    ingestFingerprint,
    narrationFingerprint,
  }: {
    context: StagePlanningContext;
    ingestFingerprint: string;
    narrationFingerprint: string;
  }): Promise<string> => fingerprintFromInputs({
    authoringHashes: await readAuthoringHashes(context),
    ingestFingerprint,
    narrationFingerprint,
  });

  const loadPrerequisites = async (
    context: StagePlanningContext,
    runDirectory: Parameters<typeof readRunStageReport>[0],
    runId: string,
  ) => {
    const [ingestReport, narrationReport] = await Promise.all([
      loadSuccessfulBoundStageReport({
        runDirectory,
        projectId: context.project.project.id,
        runId,
        stageId: 'ingest',
        readStageReport,
      }),
      loadSuccessfulBoundStageReport({
        runDirectory,
        projectId: context.project.project.id,
        runId,
        stageId: 'narration',
        readStageReport,
      }),
    ]);
    return {ingestReport, narrationReport};
  };

  return {
    id: 'compile',
    displayName: 'Compile',
    prerequisites: ['ingest', 'narration'],
    fingerprint: async (context) => {
      if (context.sourceRun === undefined) return null;
      return await readPlanningInput(async () => {
        const {ingestReport, narrationReport} = await loadPrerequisites(
          context,
          context.sourceRun!.runDirectory,
          context.sourceRun!.runId,
        );
        return await calculateFingerprint({
          context,
          ingestFingerprint: ingestReport.fingerprint,
          narrationFingerprint: narrationReport.fingerprint,
        });
      });
    },
    verify: async (context, report) => {
      const parsed = CompileAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success || context.sourceRun === undefined) return false;
      const prerequisites = await readPlanningInput(async () => await loadPrerequisites(
        context,
        context.sourceRun!.runDirectory,
        context.sourceRun!.runId,
      ));
      if (prerequisites === null) return false;
      const persisted = await readPlanningInput(async () => {
        const [assetManifest, narrationManifest, captionsManifest, timeline, authoringHashes] =
          await Promise.all([
            readRunJson(
              context.sourceRun!.runDirectory,
              'asset-manifest.json',
              (value) => IngestManifestSchema.parse(value),
            ),
            readRunJson(
              context.sourceRun!.runDirectory,
              'narration-manifest.json',
              (value) => NarrationManifestSchema.parse(value),
            ),
            readRunJson(
              context.sourceRun!.runDirectory,
              'captions.json',
              (value) => CaptionsManifestSchema.parse(value),
            ),
            readRunJson(
              context.sourceRun!.runDirectory,
              'compiled-timeline.json',
              (value) => CompiledTimelineSchema.parse(value),
            ),
            readAuthoringHashes(context),
          ]);
        return {assetManifest, narrationManifest, captionsManifest, timeline, authoringHashes};
      });
      if (persisted === null) return false;
      let recomputed: CompiledTimeline;
      try {
        recomputed = CompiledTimelineSchema.parse(compileTimeline({
          project: context.project.project,
          script: context.project.script,
          edit: context.project.edit,
          assetManifest: persisted.assetManifest,
          narrationManifest: persisted.narrationManifest,
          captionsManifest: persisted.captionsManifest,
          inputHashes: persisted.authoringHashes,
        }));
      } catch (error) {
        if (error instanceof TimelineCompileError || error instanceof z.ZodError) return false;
        throw error;
      }
      const currentFingerprint = fingerprintFromInputs({
        authoringHashes: persisted.authoringHashes,
        ingestFingerprint: prerequisites.ingestReport.fingerprint,
        narrationFingerprint: prerequisites.narrationReport.fingerprint,
      });
      if (
        report.fingerprint !== currentFingerprint
        || persisted.timeline.projectId !== context.project.project.id
        || parsed.data.timeline.projectId !== context.project.project.id
        || fingerprintValue(persisted.timeline) !== fingerprintValue(recomputed)
        || fingerprintValue(parsed.data.timeline) !== fingerprintValue(recomputed)
      ) return false;
      return await verifyReportedArtifacts({
        context,
        report,
        expected: [{scope: 'run', path: parsed.data.timelinePath}],
      });
    },
    partialArtifacts: () => [{scope: 'run', path: 'compiled-timeline.json'}],
    execute: async (context) => {
      const {runId, runDirectory} = requireRunContext(context);
      requirePreflight(context);
      const {ingestReport, narrationReport} = await loadPrerequisites(
        context,
        runDirectory,
        runId,
      );
      const stageFingerprint = await calculateFingerprint({
        context,
        ingestFingerprint: ingestReport.fingerprint,
        narrationFingerprint: narrationReport.fingerprint,
      });
      const result = await executeCompile({...context.project, runDirectory});
      return {
        state: 'passed',
        fingerprint: stageFingerprint,
        outputs: result,
        artifacts: [await hashArtifact(runDirectory, result.timelinePath)],
        checks: [],
      };
    },
  };
};

export const compileStage = createCompileStage();
