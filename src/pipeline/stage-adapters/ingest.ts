import {z} from 'zod';
import {hashRunArtifact, type PipelineArtifact} from '../artifacts';
import {fingerprintValue} from '../fingerprint';
import {
  PipelineContextError,
  requirePreflight,
  requireRunContext,
  type PipelineStage,
} from '../stage';
import {
  createSystemIngestDependencies,
  IngestManifestSchema,
  runIngest,
  type IngestInput,
  type IngestManifest,
} from '../stages/ingest';
import {
  STAGE_ALGORITHM_VERSIONS,
  verifyReportedArtifacts,
} from './shared';

const MVP_INGEST_PROFILE = {
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  frameRate: 30,
  frameRateMode: 'cfr',
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorSpace: 'bt709',
  audioSampleRate: 48_000,
} as const;

const INGEST_MANIFEST_TEMP_PATH = '.asset-manifest.pipeline.tmp';

const IngestAdapterOutputSchema = z.object({
  manifestPath: z.literal('asset-manifest.json'),
  manifest: IngestManifestSchema,
}).strict();

type IngestAdapterOutput = z.infer<typeof IngestAdapterOutputSchema>;

export interface IngestStageAdapterDependencies {
  algorithmVersion?: string;
  profile?: Record<string, unknown>;
  ffprobeExecutable?: string;
  runIngest?: (input: IngestInput) => Promise<IngestAdapterOutput>;
  hashRunArtifact?: typeof hashRunArtifact;
}

const runOwnedRenderPaths = (manifest: IngestManifest): string[] => (
  Object.values(manifest.assets)
    .filter((asset) => asset.renderScope === 'run')
    .map((asset) => asset.renderPath)
    .sort()
);

export const createIngestStage = (
  dependencies: IngestStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.ingest;
  const profile = dependencies.profile ?? MVP_INGEST_PROFILE;
  const ffprobeExecutable = dependencies.ffprobeExecutable
    ?? process.env.FFPROBE_PATH
    ?? '/opt/homebrew/bin/ffprobe';
  const executeIngest = dependencies.runIngest
    ?? (async (input: IngestInput) => await runIngest(
      input,
      createSystemIngestDependencies(),
    ));
  const hashArtifact = dependencies.hashRunArtifact ?? hashRunArtifact;

  const fingerprint = async (context: Parameters<PipelineStage['fingerprint']>[0]) => {
    const ffmpeg = context.preflight?.toolIdentities.ffmpeg;
    if (ffmpeg === undefined || ffmpeg === null) return null;
    return fingerprintValue({
      algorithmVersion,
      sourceCatalog: {
        fingerprint: context.sourceCatalog.fingerprint,
        assets: context.sourceCatalog.assets.map((asset) => ({
          assetId: asset.assetId,
          kind: asset.kind,
          sourcePath: asset.sourcePath,
          sizeBytes: asset.sizeBytes,
          sha256: asset.sha256,
        })),
      },
      ffmpeg,
      profile,
    });
  };

  return {
    id: 'ingest',
    displayName: 'Ingest',
    prerequisites: ['preflight'],
    fingerprint,
    verify: async (context, report) => {
      const parsed = IngestAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      return await verifyReportedArtifacts({
        context,
        report,
        expected: [
          {scope: 'run', path: parsed.data.manifestPath},
          ...runOwnedRenderPaths(parsed.data.manifest).map((path) => ({
            scope: 'run' as const,
            path,
          })),
        ],
      });
    },
    partialArtifacts: (context) => [
      {scope: 'run', path: INGEST_MANIFEST_TEMP_PATH},
      {scope: 'run', path: 'asset-manifest.json'},
      ...context.sourceCatalog.assets
        .filter((asset) => asset.kind === 'video')
        .map((asset) => ({
          scope: 'run' as const,
          path: `assets/${asset.assetId}/render.mp4`,
        })),
    ],
    execute: async (context, signal) => {
      const {runDirectory} = requireRunContext(context);
      const preflight = requirePreflight(context);
      const ffmpeg = preflight.toolIdentities.ffmpeg;
      if (ffmpeg === null) {
        throw new PipelineContextError('Ingest requires a Preflight FFmpeg identity');
      }
      const result = await executeIngest({
        projectDirectory: context.project.projectDirectory,
        runDirectory,
        assets: context.sourceCatalog.assets.map((asset) => ({
          assetId: asset.assetId,
          kind: asset.kind,
          sourcePath: asset.sourcePath,
        })),
        ffmpegExecutable: ffmpeg.realPath,
        ffprobeExecutable,
        manifestTempPath: INGEST_MANIFEST_TEMP_PATH,
        signal,
      });
      const artifacts: PipelineArtifact[] = [
        await hashArtifact(runDirectory, result.manifestPath),
      ];
      for (const relativePath of runOwnedRenderPaths(result.manifest)) {
        artifacts.push(await hashArtifact(runDirectory, relativePath));
      }
      const stageFingerprint = await fingerprint({...context, preflight});
      if (stageFingerprint === null) {
        throw new PipelineContextError('Ingest fingerprint requires Preflight');
      }
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

export const ingestStage = createIngestStage();
