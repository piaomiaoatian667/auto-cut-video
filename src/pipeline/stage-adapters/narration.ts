import {z} from 'zod';
import {
  CaptionsManifestSchema,
  NarrationManifestSchema,
} from '../../domain/manifest-schema';
import type {RunDirectoryScope} from '../../fs/app-directory-scopes';
import {narrationSegmentInputHash} from '../../narration/build-narration';
import {
  createTtsProvider,
  fingerprintTtsProvider,
  type TtsProvider,
  type TtsProviderId,
} from '../../providers/tts';
import {hashRunArtifact, type PipelineArtifact} from '../artifacts';
import {fingerprintValue} from '../fingerprint';
import {seedNarrationCache} from '../narration-cache';
import {
  PipelineContextError,
  requirePreflight,
  requireRunContext,
  type PipelinePartialArtifact,
  type PipelineStage,
  type StagePlanningContext,
} from '../stage';
import {runNarration, type NarrationStageInput} from '../stages/narration';
import {
  STAGE_ALGORITHM_VERSIONS,
  runArtifact,
  uniqueArtifacts,
  verifyReportedArtifacts,
} from './shared';

const NarrationAdapterOutputSchema = z.object({
  narrationPath: z.literal('narration-manifest.json'),
  captionsPath: z.literal('captions.json'),
  srtPath: z.literal('captions.srt'),
  narration: NarrationManifestSchema,
  captions: CaptionsManifestSchema,
  reuseCompatibilityFingerprint: z.string().min(1),
}).strict();

type NarrationConcreteOutput = Awaited<ReturnType<typeof runNarration>>;

export interface NarrationReuseCompatibilityInput {
  tts: StagePlanningContext['project']['project']['tts'];
  providerFingerprint: string;
  ffmpegIdentity: StagePlanningContext['preflight'] extends infer Result
    ? Result extends {toolIdentities: {ffmpeg: infer Identity}}
      ? Identity
      : never
    : never;
  algorithmVersion: string;
}

export const narrationReuseCompatibilityFingerprint = (
  input: NarrationReuseCompatibilityInput,
): string => fingerprintValue({
  tts: input.tts,
  providerFingerprint: input.providerFingerprint,
  ffmpegIdentity: input.ffmpegIdentity,
  algorithmVersion: input.algorithmVersion,
});

const narrationFingerprint = ({
  context,
  providerFingerprint,
  algorithmVersion,
}: {
  context: StagePlanningContext;
  providerFingerprint: string;
  algorithmVersion: string;
}): string | null => {
  const ffmpegIdentity = context.preflight?.toolIdentities.ffmpeg;
  if (ffmpegIdentity === undefined || ffmpegIdentity === null) return null;
  const compatibilityFingerprint = narrationReuseCompatibilityFingerprint({
    tts: context.project.project.tts,
    providerFingerprint,
    ffmpegIdentity,
    algorithmVersion,
  });
  return fingerprintValue({
    script: context.project.script,
    reuseCompatibilityFingerprint: compatibilityFingerprint,
  });
};

const cachePath = (inputHash: string): string =>
  `audio/cache/${inputHash.replace(/^sha256:/u, '')}.wav`;

const safeSegmentId = (segmentId: string): string =>
  segmentId.replace(/[^a-zA-Z0-9-]/gu, '-');

const preliminaryPartialArtifacts = (
  context: StagePlanningContext,
  providerFingerprint: string,
  providerId: TtsProviderId,
): PipelinePartialArtifact[] => {
  const paths: PipelinePartialArtifact[] = [];
  for (const [index, segment] of context.project.script.segments.entries()) {
    const inputHash = narrationSegmentInputHash(
      segment,
      context.project.project.tts.voice,
      context.project.project.tts.rate,
      providerFingerprint,
    );
    const wavPath = cachePath(inputHash);
    paths.push({scope: 'run', path: wavPath});
    if (providerId === 'macos-say') {
      paths.push({scope: 'run', path: `${wavPath}.aiff`});
    }
    paths.push({
      scope: 'run',
      path: `audio/segments/${String(index + 1).padStart(4, '0')}-${safeSegmentId(segment.id)}-${inputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`,
    });
  }
  paths.push(
    {scope: 'run', path: 'narration-manifest.json'},
    {scope: 'run', path: 'captions.json'},
    {scope: 'run', path: 'captions.srt'},
  );
  return paths;
};

export interface NarrationStageAdapterDependencies {
  algorithmVersion?: string;
  fingerprintTtsProvider?: typeof fingerprintTtsProvider;
  createTtsProvider?: typeof createTtsProvider;
  seedNarrationCache?: typeof seedNarrationCache;
  runNarration?: (input: NarrationStageInput) => Promise<NarrationConcreteOutput>;
  hashRunArtifact?: typeof hashRunArtifact;
}

export const createNarrationStage = (
  dependencies: NarrationStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.narration;
  const providerIdentity = dependencies.fingerprintTtsProvider
    ?? fingerprintTtsProvider;
  const makeProvider = dependencies.createTtsProvider ?? createTtsProvider;
  const seedCache = dependencies.seedNarrationCache ?? seedNarrationCache;
  const executeNarration = dependencies.runNarration ?? runNarration;
  const hashArtifact = dependencies.hashRunArtifact ?? hashRunArtifact;
  const partialArtifactsByRun = new WeakMap<
    RunDirectoryScope,
    readonly PipelinePartialArtifact[]
  >();

  const fingerprint = async (context: StagePlanningContext): Promise<string | null> => (
    narrationFingerprint({
      context,
      providerFingerprint: await providerIdentity(
        context.project.project.tts.provider,
      ),
      algorithmVersion,
    })
  );

  return {
    id: 'narration',
    displayName: 'Narration',
    prerequisites: ['preflight'],
    fingerprint,
    verify: async (context, report) => {
      const parsed = NarrationAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      const expected = [
        ...parsed.data.narration.segments.map((segment) => ({
          scope: 'run' as const,
          path: cachePath(segment.inputHash),
        })),
        ...parsed.data.narration.segments.map((segment) => ({
          scope: 'run' as const,
          path: segment.audioPath,
          sha256: segment.audioHash,
        })),
        {
          scope: 'run' as const,
          path: parsed.data.narration.master.audioPath,
          sha256: parsed.data.narration.master.audioHash,
        },
        {scope: 'run' as const, path: parsed.data.narrationPath},
        {scope: 'run' as const, path: parsed.data.captionsPath},
        {scope: 'run' as const, path: parsed.data.srtPath},
      ];
      return await verifyReportedArtifacts({context, report, expected});
    },
    partialArtifacts: (context) => {
      if (context.runDirectory === undefined) {
        return [
          {scope: 'run', path: 'narration-manifest.json'},
          {scope: 'run', path: 'captions.json'},
          {scope: 'run', path: 'captions.srt'},
        ];
      }
      return partialArtifactsByRun.get(context.runDirectory) ?? [
        {scope: 'run', path: 'narration-manifest.json'},
        {scope: 'run', path: 'captions.json'},
        {scope: 'run', path: 'captions.srt'},
      ];
    },
    execute: async (context, signal) => {
      const {runId, runDirectory} = requireRunContext(context);
      const preflight = requirePreflight(context);
      const ffmpegIdentity = preflight.toolIdentities.ffmpeg;
      if (ffmpegIdentity === null) {
        throw new PipelineContextError('Narration requires a Preflight FFmpeg identity');
      }
      const provider = makeProvider({
        provider: context.project.project.tts.provider,
        projectDirectory: context.project.projectDirectory,
        runDirectory,
        ffmpegExecutable: ffmpegIdentity.realPath,
      });
      const providerFingerprint = await provider.fingerprint();
      const compatibilityFingerprint = narrationReuseCompatibilityFingerprint({
        tts: context.project.project.tts,
        providerFingerprint,
        ffmpegIdentity,
        algorithmVersion,
      });
      const stageFingerprint = narrationFingerprint({
        context: {...context, preflight},
        providerFingerprint,
        algorithmVersion,
      });
      if (stageFingerprint === null) {
        throw new PipelineContextError('Narration fingerprint requires Preflight');
      }
      partialArtifactsByRun.set(
        runDirectory,
        preliminaryPartialArtifacts(context, providerFingerprint, provider.id),
      );

      const sourceReport = context.sourceRun?.reports.get('narration');
      const sourceCompatibility = z.object({
        reuseCompatibilityFingerprint: z.string().min(1),
      }).passthrough().safeParse(sourceReport?.outputs);
      if (
        provider.id !== 'file'
        && context.sourceRun !== undefined
        && context.sourceRun.runId !== runId
        && sourceReport?.fingerprint !== null
        && sourceReport?.fingerprint !== undefined
        && sourceReport.fingerprint !== stageFingerprint
        && sourceCompatibility.success
        && sourceCompatibility.data.reuseCompatibilityFingerprint
          === compatibilityFingerprint
      ) {
        await seedCache({
          sourceRun: context.sourceRun.runDirectory,
          targetRun: runDirectory,
          script: context.project.script,
          voice: context.project.project.tts.voice,
          rate: context.project.project.tts.rate,
          providerFingerprint,
        });
      }

      const result = await executeNarration({
        ...context.project,
        runDirectory,
        provider,
        signal,
      });
      partialArtifactsByRun.set(runDirectory, [
        ...preliminaryPartialArtifacts(context, providerFingerprint, provider.id),
        {scope: 'run', path: result.narration.master.audioPath},
      ]);
      const artifacts: PipelineArtifact[] = [];
      for (const segment of result.narration.segments) {
        artifacts.push(await hashArtifact(runDirectory, cachePath(segment.inputHash)));
      }
      artifacts.push(
        ...result.narration.segments.map((segment) => runArtifact({
          path: segment.audioPath,
          sha256: segment.audioHash,
        })),
        runArtifact({
          path: result.narration.master.audioPath,
          sha256: result.narration.master.audioHash,
        }),
        await hashArtifact(runDirectory, result.narrationPath),
        await hashArtifact(runDirectory, result.captionsPath),
        await hashArtifact(runDirectory, result.srtPath),
      );
      const ownedArtifacts = uniqueArtifacts(artifacts);
      partialArtifactsByRun.set(
        runDirectory,
        ownedArtifacts.map((artifact) => ({scope: artifact.scope, path: artifact.path})),
      );
      return {
        state: 'passed',
        fingerprint: stageFingerprint,
        outputs: {...result, reuseCompatibilityFingerprint: compatibilityFingerprint},
        artifacts: ownedArtifacts,
        checks: [],
      };
    },
  };
};

export const narrationStage = createNarrationStage();
