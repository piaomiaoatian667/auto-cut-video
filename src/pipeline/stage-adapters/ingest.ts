import {z} from 'zod';
import {INGEST_MVP_PROFILE} from '../../media/transcode';
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
import type {ProjectSourceCatalog} from '../source-assets';
import {
  STAGE_ALGORITHM_VERSIONS,
  readPlanningInput,
  readRunJson,
  verifyReportedArtifacts,
} from './shared';

const INGEST_MANIFEST_TEMP_PATH = '.asset-manifest.pipeline.tmp';

const IngestAdapterOutputSchema = z.object({
  manifestPath: z.literal('asset-manifest.json'),
  manifest: IngestManifestSchema,
}).strict();

type IngestAdapterOutput = z.infer<typeof IngestAdapterOutputSchema>;

export interface IngestStageAdapterDependencies {
  algorithmVersion?: string;
  runIngest?: (input: IngestInput) => Promise<IngestAdapterOutput>;
  hashRunArtifact?: typeof hashRunArtifact;
}

const runOwnedRenderPaths = (
  manifest: IngestManifest,
  sourceAssets: ProjectSourceCatalog['assets'],
): string[] | null => {
  const manifestAssetIds = Object.keys(manifest.assets);
  if (
    manifestAssetIds.length !== sourceAssets.length
    || new Set(manifestAssetIds).size !== manifestAssetIds.length
  ) return null;
  const paths = new Set<string>();
  for (const sourceAsset of sourceAssets) {
    const asset = manifest.assets[sourceAsset.assetId];
    if (
      asset === undefined
      || asset.kind !== sourceAsset.kind
      || asset.sourcePath !== sourceAsset.sourcePath
      || asset.sourceHash !== sourceAsset.sha256
    ) return null;
    if (asset.renderScope === 'run') {
      const expectedPath = `assets/${sourceAsset.assetId}/render.mp4`;
      if (
        asset.kind !== 'video'
        || asset.compatibility !== 'transcoded'
        || asset.renderPath !== expectedPath
        || paths.has(asset.renderPath)
      ) return null;
      paths.add(asset.renderPath);
    } else if (
      asset.compatibility !== 'direct'
      || asset.renderPath !== sourceAsset.sourcePath
    ) return null;
  }
  return [...paths].sort();
};

export const createIngestStage = (
  dependencies: IngestStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.ingest;
  const executeIngest = dependencies.runIngest
    ?? (async (input: IngestInput) => await runIngest(
      input,
      createSystemIngestDependencies(),
    ));
  const hashArtifact = dependencies.hashRunArtifact ?? hashRunArtifact;

  const fingerprint = async (context: Parameters<PipelineStage['fingerprint']>[0]) => {
    const ffmpeg = context.preflight?.toolIdentities.ffmpeg;
    const ffprobe = context.preflight?.toolIdentities.ffprobe;
    if (
      ffmpeg === undefined
      || ffmpeg === null
      || ffprobe === undefined
      || ffprobe === null
    ) return null;
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
      ffprobe,
      profile: INGEST_MVP_PROFILE,
    });
  };

  return {
    id: 'ingest',
    displayName: 'Ingest',
    prerequisites: ['preflight'],
    fingerprint,
    verify: async (context, report) => {
      const parsed = IngestAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success || context.sourceRun === undefined) return false;
      const persistedManifest = await readPlanningInput(async () => await readRunJson(
        context.sourceRun!.runDirectory,
        parsed.data.manifestPath,
        (value) => IngestManifestSchema.parse(value),
      ));
      if (
        persistedManifest === null
        || fingerprintValue(persistedManifest) !== fingerprintValue(parsed.data.manifest)
      ) return false;
      const renderPaths = runOwnedRenderPaths(
        persistedManifest,
        context.sourceCatalog.assets,
      );
      if (renderPaths === null) return false;
      return await verifyReportedArtifacts({
        context,
        report,
        expected: [
          {scope: 'run', path: parsed.data.manifestPath},
          ...renderPaths.map((path) => ({
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
      const ffprobe = preflight.toolIdentities.ffprobe;
      if (ffmpeg === null || ffprobe === null) {
        throw new PipelineContextError(
          'Ingest requires Preflight FFmpeg and FFprobe identities',
        );
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
        ffprobeExecutable: ffprobe.realPath,
        manifestTempPath: INGEST_MANIFEST_TEMP_PATH,
        signal,
      });
      const renderPaths = runOwnedRenderPaths(
        result.manifest,
        context.sourceCatalog.assets,
      );
      if (renderPaths === null) {
        throw new PipelineContextError('Ingest returned invalid Run-owned render paths');
      }
      const artifacts: PipelineArtifact[] = [
        await hashArtifact(runDirectory, result.manifestPath),
      ];
      for (const relativePath of renderPaths) {
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
