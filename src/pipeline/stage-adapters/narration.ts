import {createHash} from 'node:crypto';
import type {BigIntStats} from 'node:fs';
import {z} from 'zod';
import {
  CaptionsManifestSchema,
  NarrationManifestSchema,
} from '../../domain/manifest-schema';
import {buildCaptions} from '../../captions/build-captions';
import {formatSrt} from '../../captions/srt';
import type {RunDirectoryScope} from '../../fs/app-directory-scopes';
import {
  openExistingProjectFile,
  type ProjectDirectoryScope,
} from '../../fs/project-paths';
import {
  narrationMasterPath,
  narrationSegmentInputHash,
} from '../../narration/build-narration';
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
  isOrdinaryVerificationMiss,
  readPlanningInput,
  readRunJson,
  readRunText,
  runArtifact,
  uniqueArtifacts,
  verifyReportedArtifacts,
} from './shared';

const ToolIdentitySchema = z.object({
  realPath: z.string().min(1),
  sha256: z.string().min(1),
}).strict();

const TtsConfigurationSchema = z.object({
  provider: z.enum(['macos-say', 'file', 'mock']),
  voice: z.string().min(1),
  rate: z.number().int(),
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
  ffprobeIdentity: StagePlanningContext['preflight'] extends infer Result
    ? Result extends {toolIdentities: {ffprobe: infer Identity}}
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
  ffprobeIdentity: input.ffprobeIdentity,
  algorithmVersion: input.algorithmVersion,
});

const NarrationReuseCompatibilitySchema = z.object({
  tts: TtsConfigurationSchema,
  providerFingerprint: z.string().min(1),
  ffmpegIdentity: ToolIdentitySchema,
  ffprobeIdentity: ToolIdentitySchema,
  algorithmVersion: z.string().min(1),
}).strict();

const NarrationAdapterOutputSchema = z.object({
  narrationPath: z.literal('narration-manifest.json'),
  captionsPath: z.literal('captions.json'),
  srtPath: z.literal('captions.srt'),
  narration: NarrationManifestSchema,
  captions: CaptionsManifestSchema,
  reuseCompatibility: NarrationReuseCompatibilitySchema,
  reuseCompatibilityFingerprint: z.string().min(1),
}).strict().superRefine((output, context) => {
  if (
    narrationReuseCompatibilityFingerprint(output.reuseCompatibility)
    !== output.reuseCompatibilityFingerprint
  ) {
    context.addIssue({
      code: 'custom',
      path: ['reuseCompatibilityFingerprint'],
      message: 'must match the structured Narration reuse compatibility inputs',
    });
  }
});

interface PersistedNarrationFiles {
  narration: z.infer<typeof NarrationManifestSchema>;
  captions: z.infer<typeof CaptionsManifestSchema>;
  srt: string;
}

type PersistedNarrationFilesReader = (
  runDirectory: RunDirectoryScope,
  output: z.infer<typeof NarrationAdapterOutputSchema>,
) => Promise<PersistedNarrationFiles>;

const systemReadPersistedNarrationFiles: PersistedNarrationFilesReader = async (
  runDirectory,
  output,
) => {
  const [narration, captions, srt] = await Promise.all([
    readRunJson(
      runDirectory,
      output.narrationPath,
      (value) => NarrationManifestSchema.parse(value),
    ),
    readRunJson(
      runDirectory,
      output.captionsPath,
      (value) => CaptionsManifestSchema.parse(value),
    ),
    readRunText(runDirectory, output.srtPath),
  ]);
  return {narration, captions, srt};
};

const narrationFingerprint = ({
  context,
  providerFingerprint,
  algorithmVersion,
  fileAudioInputs,
}: {
  context: StagePlanningContext;
  providerFingerprint: string;
  algorithmVersion: string;
  fileAudioInputs: readonly {id: string; audioPath: string; sha256: string}[];
}): string | null => {
  const ffmpegIdentity = context.preflight?.toolIdentities.ffmpeg;
  const ffprobeIdentity = context.preflight?.toolIdentities.ffprobe;
  if (
    ffmpegIdentity === undefined
    || ffmpegIdentity === null
    || ffprobeIdentity === undefined
    || ffprobeIdentity === null
  ) return null;
  const compatibilityFingerprint = narrationReuseCompatibilityFingerprint({
    tts: context.project.project.tts,
    providerFingerprint,
    ffmpegIdentity,
    ffprobeIdentity,
    algorithmVersion,
  });
  return fingerprintValue({
    script: context.project.script,
    fileAudioInputs,
    reuseCompatibilityFingerprint: compatibilityFingerprint,
  });
};

const MAX_FILE_PROVIDER_AUDIO_BYTES = 512 * 1024 * 1024;
const FILE_HASH_CHUNK_BYTES = 1024 * 1024;

interface ProjectAudioIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

const projectAudioIdentity = (
  status: BigIntStats,
): ProjectAudioIdentity => ({
  dev: status.dev,
  ino: status.ino,
  nlink: status.nlink,
  size: status.size,
  mtimeNs: status.mtimeNs,
  ctimeNs: status.ctimeNs,
});

const sameProjectAudioIdentity = (
  left: ProjectAudioIdentity,
  right: ProjectAudioIdentity,
): boolean => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.nlink === right.nlink
  && left.size === right.size
  && left.mtimeNs === right.mtimeNs
  && left.ctimeNs === right.ctimeNs
);

const hashProjectAudioFileOnce = async (
  projectDirectory: ProjectDirectoryScope,
  relativePath: string,
): Promise<{identity: ProjectAudioIdentity; sha256: string}> => {
  const handle = await openExistingProjectFile(projectDirectory, relativePath);
  try {
    const beforeStatus = await handle.stat({bigint: true});
    if (
      !beforeStatus.isFile()
      || beforeStatus.size < 0n
      || beforeStatus.size > BigInt(MAX_FILE_PROVIDER_AUDIO_BYTES)
    ) {
      throw new PipelineContextError(`unsafe file-provider audio input: ${relativePath}`);
    }
    const before = projectAudioIdentity(beforeStatus);
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(FILE_HASH_CHUNK_BYTES);
    let position = 0;
    while (position < Number(before.size)) {
      const length = Math.min(buffer.byteLength, Number(before.size) - position);
      const {bytesRead} = await handle.read(buffer, 0, length, position);
      if (bytesRead <= 0 || bytesRead > length) {
        throw new PipelineContextError(`unstable file-provider audio input: ${relativePath}`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const trailing = await handle.read(buffer, 0, 1, position);
    const afterStatus = await handle.stat({bigint: true});
    if (
      trailing.bytesRead !== 0
      || !sameProjectAudioIdentity(before, projectAudioIdentity(afterStatus))
      || BigInt(position) !== before.size
    ) {
      throw new PipelineContextError(`unstable file-provider audio input: ${relativePath}`);
    }
    return {
      identity: before,
      sha256: `sha256:${hash.digest('hex')}`,
    };
  } finally {
    await handle.close();
  }
};

const systemHashProjectAudioFile = async (
  projectDirectory: ProjectDirectoryScope,
  relativePath: string,
): Promise<string> => {
  const first = await hashProjectAudioFileOnce(projectDirectory, relativePath);
  const second = await hashProjectAudioFileOnce(projectDirectory, relativePath);
  if (
    !sameProjectAudioIdentity(first.identity, second.identity)
    || first.sha256 !== second.sha256
  ) {
    throw new PipelineContextError(`unstable file-provider audio input: ${relativePath}`);
  }
  return first.sha256;
};

const cachePath = (inputHash: string): string =>
  `audio/cache/${inputHash.replace(/^sha256:/u, '')}.wav`;

const safeSegmentId = (segmentId: string): string =>
  segmentId.replace(/[^a-zA-Z0-9-]/gu, '-');

const narrationOwnedArtifacts = (
  output: z.infer<typeof NarrationAdapterOutputSchema>,
) => {
  if (
    output.narrationPath !== 'narration-manifest.json'
    || output.captionsPath !== 'captions.json'
    || output.srtPath !== 'captions.srt'
  ) return null;
  const expected: Array<{
    scope: 'run';
    path: string;
    sha256?: string;
  }> = [];
  for (const [index, segment] of output.narration.segments.entries()) {
    const inputHashMatch = /^sha256:([0-9a-f]{64})$/u.exec(segment.inputHash);
    if (inputHashMatch === null) return null;
    const inputHashHex = inputHashMatch[1]!;
    const expectedSegmentPath = `audio/segments/${String(index + 1).padStart(4, '0')}-${safeSegmentId(segment.id)}-${inputHashHex.slice(0, 12)}.wav`;
    if (
      segment.audioPath !== expectedSegmentPath
      || segment.providerFingerprint
        !== output.reuseCompatibility.providerFingerprint
    ) return null;
    expected.push(
      {scope: 'run' as const, path: cachePath(segment.inputHash)},
      {scope: 'run' as const, path: segment.audioPath, sha256: segment.audioHash},
    );
  }
  if (
    output.narration.master.audioPath
    !== narrationMasterPath({
      provider: output.narration.provider,
      segments: output.narration.segments,
    })
  ) return null;
  expected.push(
    {
      scope: 'run' as const,
      path: output.narration.master.audioPath,
      sha256: output.narration.master.audioHash,
    },
    {scope: 'run' as const, path: output.narrationPath},
    {scope: 'run' as const, path: output.captionsPath},
    {scope: 'run' as const, path: output.srtPath},
  );
  if (new Set(expected.map((artifact) => artifact.path)).size !== expected.length) {
    return null;
  }
  return expected;
};

const verifyPersistedNarrationOutput = async ({
  context,
  report,
  output,
  readPersistedNarrationFiles,
}: {
  context: StagePlanningContext;
  report: Parameters<typeof verifyReportedArtifacts>[0]['report'];
  output: z.infer<typeof NarrationAdapterOutputSchema>;
  readPersistedNarrationFiles: PersistedNarrationFilesReader;
}): Promise<boolean> => {
  if (context.sourceRun === undefined) return false;
  const persisted = await readPersistedNarrationFiles(
    context.sourceRun.runDirectory,
    output,
  );
  if (
    fingerprintValue(persisted.narration) !== fingerprintValue(output.narration)
    || fingerprintValue(persisted.captions) !== fingerprintValue(output.captions)
    || persisted.srt !== formatSrt(persisted.captions)
  ) return false;
  const expected = narrationOwnedArtifacts(output);
  return expected !== null
    && await verifyReportedArtifacts({context, report, expected});
};

const narrationMatchesCurrentInputs = ({
  output,
  context,
  providerFingerprint,
  algorithmVersion,
}: {
  output: z.infer<typeof NarrationAdapterOutputSchema>;
  context: StagePlanningContext;
  providerFingerprint: string;
  algorithmVersion: string;
}): boolean => {
  const ffmpegIdentity = context.preflight?.toolIdentities.ffmpeg;
  const ffprobeIdentity = context.preflight?.toolIdentities.ffprobe;
  if (
    ffmpegIdentity === undefined
    || ffmpegIdentity === null
    || ffprobeIdentity === undefined
    || ffprobeIdentity === null
    || output.narration.provider !== context.project.project.tts.provider
  ) return false;
  const expectedCompatibility = {
    tts: context.project.project.tts,
    providerFingerprint,
    ffmpegIdentity,
    ffprobeIdentity,
    algorithmVersion,
  };
  if (
    fingerprintValue(output.reuseCompatibility)
    !== fingerprintValue(expectedCompatibility)
    || output.narration.segments.length !== context.project.script.segments.length
  ) return false;
  for (const [index, segment] of output.narration.segments.entries()) {
    const scriptSegment = context.project.script.segments[index];
    if (
      scriptSegment === undefined
      || segment.id !== scriptSegment.id
      || segment.providerFingerprint !== providerFingerprint
      || segment.inputHash !== narrationSegmentInputHash(
        scriptSegment,
        context.project.project.tts.voice,
        context.project.project.tts.rate,
        providerFingerprint,
      )
    ) return false;
  }
  try {
    return fingerprintValue(output.captions) === fingerprintValue(buildCaptions({
      script: context.project.script,
      narration: output.narration,
      sourceNarrationHash: output.narration.master.audioHash,
    }));
  } catch {
    return false;
  }
};

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

const uniquePartialArtifacts = (
  artifacts: readonly PipelinePartialArtifact[],
): PipelinePartialArtifact[] => {
  const byPath = new Map<string, PipelinePartialArtifact>();
  for (const artifact of artifacts) {
    byPath.set(`${artifact.scope}:${artifact.path}`, artifact);
  }
  return [...byPath.values()];
};

const withCanonicalFingerprint = (
  provider: TtsProvider,
  providerId: TtsProviderId,
  providerFingerprint: string,
): TtsProvider => ({
  id: providerId,
  capabilities: async () => await provider.capabilities(),
  fingerprint: async () => providerFingerprint,
  synthesize: async (input, signal) => await provider.synthesize(input, signal),
});

export interface NarrationStageAdapterDependencies {
  algorithmVersion?: string;
  fingerprintTtsProvider?: typeof fingerprintTtsProvider;
  createTtsProvider?: typeof createTtsProvider;
  seedNarrationCache?: typeof seedNarrationCache;
  runNarration?: (input: NarrationStageInput) => Promise<NarrationConcreteOutput>;
  hashRunArtifact?: typeof hashRunArtifact;
  hashProjectAudioFile?: typeof systemHashProjectAudioFile;
  readPersistedNarrationFiles?: PersistedNarrationFilesReader;
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
  const hashProjectAudioFile = dependencies.hashProjectAudioFile
    ?? systemHashProjectAudioFile;
  const readPersistedNarrationFiles = dependencies.readPersistedNarrationFiles
    ?? systemReadPersistedNarrationFiles;
  const partialArtifactsByRun = new WeakMap<
    RunDirectoryScope,
    readonly PipelinePartialArtifact[]
  >();

  const calculateFingerprint = async (
    context: StagePlanningContext,
    providerFingerprint: string,
  ): Promise<string | null> => {
    const fileAudioInputs = context.project.project.tts.provider === 'file'
      ? await Promise.all(context.project.script.segments.map(async (segment) => {
        if (segment.audioPath === undefined) {
          throw new PipelineContextError(
            `file-provider segment ${segment.id} requires audioPath`,
          );
        }
        return {
          id: segment.id,
          audioPath: segment.audioPath,
          sha256: await hashProjectAudioFile(
            context.project.projectDirectory,
            segment.audioPath,
          ),
        };
      }))
      : [];
    return narrationFingerprint({
      context,
      providerFingerprint,
      algorithmVersion,
      fileAudioInputs,
    });
  };

  const fingerprint = async (context: StagePlanningContext): Promise<string | null> => (
    await calculateFingerprint(
      context,
      await providerIdentity(context.project.project.tts.provider),
    )
  );

  return {
    id: 'narration',
    displayName: 'Narration',
    prerequisites: ['preflight'],
    fingerprint,
    verify: async (context, report) => {
      const parsed = NarrationAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success || context.sourceRun === undefined) return false;
      const persistedIsValid = await readPlanningInput(async () => (
        await verifyPersistedNarrationOutput({
          context,
          report,
          output: parsed.data,
          readPersistedNarrationFiles,
        })
      ));
      if (persistedIsValid !== true) return false;
      const providerFingerprint = await providerIdentity(
        context.project.project.tts.provider,
      );
      if (!narrationMatchesCurrentInputs({
        output: parsed.data,
        context,
        providerFingerprint,
        algorithmVersion,
      })) return false;
      const currentFingerprint = await calculateFingerprint(context, providerFingerprint);
      if (currentFingerprint === null || report.fingerprint !== currentFingerprint) {
        return false;
      }
      return true;
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
      const ffprobeIdentity = preflight.toolIdentities.ffprobe;
      if (ffmpegIdentity === null || ffprobeIdentity === null) {
        throw new PipelineContextError(
          'Narration requires Preflight FFmpeg and FFprobe identities',
        );
      }
      const providerId = context.project.project.tts.provider;
      const providerFingerprint = await providerIdentity(providerId);
      partialArtifactsByRun.set(
        runDirectory,
        preliminaryPartialArtifacts(context, providerFingerprint, providerId),
      );
      const provider = withCanonicalFingerprint(makeProvider({
        provider: context.project.project.tts.provider,
        projectDirectory: context.project.projectDirectory,
        runDirectory,
        ffmpegExecutable: ffmpegIdentity.realPath,
      }), providerId, providerFingerprint);
      const reuseCompatibility = {
        tts: context.project.project.tts,
        providerFingerprint,
        ffmpegIdentity,
        ffprobeIdentity,
        algorithmVersion,
      };
      const compatibilityFingerprint = narrationReuseCompatibilityFingerprint(
        reuseCompatibility,
      );
      const stageFingerprint = await calculateFingerprint(
        {...context, preflight},
        providerFingerprint,
      );
      if (stageFingerprint === null) {
        throw new PipelineContextError('Narration fingerprint requires Preflight');
      }
      const sourceReport = context.sourceRun?.reports.get('narration');
      const sourceOutput = NarrationAdapterOutputSchema.safeParse(sourceReport?.outputs);
      if (
        providerId !== 'file'
        && context.sourceRun !== undefined
        && context.sourceRun.runId !== runId
        && sourceReport?.projectId === context.project.project.id
        && sourceReport.runId === context.sourceRun.runId
        && sourceReport.stageId === 'narration'
        && (sourceReport.state === 'passed' || sourceReport.state === 'cached')
        && sourceReport?.fingerprint !== null
        && sourceReport?.fingerprint !== undefined
        && sourceReport.fingerprint !== stageFingerprint
        && sourceOutput.success
        && sourceOutput.data.reuseCompatibilityFingerprint
          === compatibilityFingerprint
      ) {
        const sourceIsValid = await readPlanningInput(async () => (
          await verifyPersistedNarrationOutput({
            context,
            report: sourceReport,
            output: sourceOutput.data,
            readPersistedNarrationFiles,
          })
        ));
        if (sourceIsValid === true) {
          try {
            await seedCache({
              sourceRun: context.sourceRun.runDirectory,
              targetRun: runDirectory,
              script: context.project.script,
              voice: context.project.project.tts.voice,
              rate: context.project.project.tts.rate,
              providerFingerprint,
              sourceManifest: sourceOutput.data.narration,
              sourceArtifacts: sourceReport.artifacts,
            });
          } catch (error) {
            if (!isOrdinaryVerificationMiss(error)) throw error;
          }
        }
      }

      const result = await executeNarration({
        ...context.project,
        runDirectory,
        provider,
        ffmpegExecutable: ffmpegIdentity.realPath,
        ffprobeExecutable: ffprobeIdentity.realPath,
        signal,
        onPartialArtifact: (relativePath) => {
          partialArtifactsByRun.set(runDirectory, uniquePartialArtifacts([
            ...(partialArtifactsByRun.get(runDirectory) ?? []),
            {scope: 'run', path: relativePath},
          ]));
        },
      });
      partialArtifactsByRun.set(runDirectory, uniquePartialArtifacts([
        ...(partialArtifactsByRun.get(runDirectory) ?? []),
        {scope: 'run', path: result.narration.master.audioPath},
      ]));
      const output = NarrationAdapterOutputSchema.parse({
        ...result,
        reuseCompatibility,
        reuseCompatibilityFingerprint: compatibilityFingerprint,
      });
      if (
        narrationOwnedArtifacts(output) === null
        || !narrationMatchesCurrentInputs({
          output,
          context: {...context, preflight},
          providerFingerprint,
          algorithmVersion,
        })
      ) {
        throw new PipelineContextError('Narration returned invalid owned artifact paths');
      }
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
        uniquePartialArtifacts([
          ...(partialArtifactsByRun.get(runDirectory) ?? []),
          ...ownedArtifacts.map((artifact) => ({
            scope: artifact.scope,
            path: artifact.path,
          })),
        ]),
      );
      return {
        state: 'passed',
        fingerprint: stageFingerprint,
        outputs: output,
        artifacts: ownedArtifacts,
        checks: [],
      };
    },
  };
};

export const narrationStage = createNarrationStage();
