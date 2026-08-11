import {createHash} from 'node:crypto';
import {z} from 'zod';
import {CompiledTimelineSchema} from '../../domain/timeline-schema';
import type {ProjectDirectoryScope} from '../../fs/project-paths';
import {openExistingProjectFile} from '../../fs/project-paths';
import {componentRegistry} from '../../remotion/registry';
import {hashRunArtifact} from '../artifacts';
import {fingerprintValue} from '../fingerprint';
import {
  PipelineContextError,
  requirePreflight,
  requireRunContext,
  type PipelineStage,
  type StagePlanningContext,
} from '../stage';
import type {StageReport} from '../stage-report';
import {runCompile, type CompileInput} from '../stages/compile';
import {
  STAGE_ALGORITHM_VERSIONS,
  planningReportFingerprint,
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
  ) => Promise<StageReport>;
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

  const calculateFingerprint = async ({
    context,
    ingestFingerprint,
    narrationFingerprint,
  }: {
    context: StagePlanningContext;
    ingestFingerprint: string | null;
    narrationFingerprint: string | null;
  }): Promise<string | null> => {
    if (ingestFingerprint === null || narrationFingerprint === null) return null;
    const [projectHash, scriptHash, editHash] = await Promise.all([
      hashProjectFile(context.project.projectDirectory, 'project.json'),
      hashProjectFile(context.project.projectDirectory, 'script.json'),
      hashProjectFile(context.project.projectDirectory, 'edit.json'),
    ]);
    return fingerprintValue({
      algorithmVersion,
      authoringHashes: {
        project: projectHash,
        script: scriptHash,
        edit: editHash,
      },
      prerequisiteFingerprints: {
        ingest: ingestFingerprint,
        narration: narrationFingerprint,
      },
      componentIds,
    });
  };

  return {
    id: 'compile',
    displayName: 'Compile',
    prerequisites: ['ingest', 'narration'],
    fingerprint: async (context) => await calculateFingerprint({
      context,
      ingestFingerprint: planningReportFingerprint(context, 'ingest'),
      narrationFingerprint: planningReportFingerprint(context, 'narration'),
    }),
    verify: async (context, report) => {
      const parsed = CompileAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      return await verifyReportedArtifacts({
        context,
        report,
        expected: [{scope: 'run', path: parsed.data.timelinePath}],
      });
    },
    partialArtifacts: () => [{scope: 'run', path: 'compiled-timeline.json'}],
    execute: async (context) => {
      const {runDirectory} = requireRunContext(context);
      requirePreflight(context);
      const [ingestReport, narrationReport] = await Promise.all([
        readStageReport(runDirectory, 'ingest'),
        readStageReport(runDirectory, 'narration'),
      ]);
      const stageFingerprint = await calculateFingerprint({
        context,
        ingestFingerprint: ingestReport.fingerprint,
        narrationFingerprint: narrationReport.fingerprint,
      });
      if (stageFingerprint === null) {
        throw new PipelineContextError('Compile requires passed Ingest and Narration reports');
      }
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
