import {createHash} from 'node:crypto';
import {mkdir, rename, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ProjectInputs} from '../../../src/domain/load-project';
import {loadProject} from '../../../src/domain/load-project';
import type {Review} from '../../../src/domain/review-schema';
import type {CompiledTimeline} from '../../../src/domain/timeline-schema';
import {formatSrt} from '../../../src/captions/srt';
import {
  AppDirectoryScopeError,
  createOutputStore,
  createRunStore,
  ensureOutputDirectory,
  ensureRunDirectory,
  openNewOutputFile,
  openNewRunFile,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {hashRunArtifact} from '../../../src/pipeline/artifacts';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {selectReviewFrames} from '../../../src/media/contact-sheet';
import type {ReleaseVerificationReport} from '../../../src/media/release-verify';
import {
  narrationMasterPath,
  narrationSegmentInputHash,
} from '../../../src/narration/build-narration';
import {
  createCompileStage,
  createDraftStage,
  createIngestStage,
  createNarrationStage,
  createPreflightStage,
  createReleaseStage,
  createReviewStage,
  narrationReuseCompatibilityFingerprint,
  STAGE_ALGORITHM_VERSIONS,
} from '../../../src/pipeline/stage-adapters';
import {MVP_STAGES} from '../../../src/pipeline/stage-registry';
import type {
  StageExecutionContext,
  StagePlanningContext,
} from '../../../src/pipeline/stage';
import type {PipelineArtifact} from '../../../src/pipeline/artifacts';
import {
  createStageReportStore,
  type StageReport,
} from '../../../src/pipeline/stage-report';
import type {PreflightResult} from '../../../src/pipeline/stages/preflight';
import type {NarrationStageInput} from '../../../src/pipeline/stages/narration';
import {runCompile as runConcreteCompile} from '../../../src/pipeline/stages/compile';
import {evaluateReview} from '../../../src/pipeline/stages/review';
import type {
  DraftReport,
  DraftStageInput,
  DraftStageResult,
} from '../../../src/pipeline/stages/draft';
import {draftReviewEvidenceArtifacts} from '../../../src/pipeline/stages/draft';
import {
  buildReleaseValidationReport,
  formatReleaseChecksums,
  releaseChecksumArtifacts,
  releaseOutputPath,
  releaseSrtFromTimeline,
  releaseStageFingerprint,
  type ReleaseStageInput,
  type ReleaseStageResult,
} from '../../../src/pipeline/stages/release';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import type {TtsProvider} from '../../../src/providers/tts';
import {
  passedStageReport,
} from '../../helpers/pipeline-fixtures';
import {
  createProjectFixture,
  createScriptFixture,
  createTempProject,
  type TempProject,
} from '../../helpers/temp-project';

const hash = (value: unknown): string => fingerprintValue(value);

const contentHash = (value: Buffer | string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const compiledTimeline = (
  inputHashes: Record<string, string> = {'authoring:project': hash('project')},
): CompiledTimeline => ({
  version: 1,
  projectId: 'demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 30,
  inputHashes,
  visualClips: [],
  overlays: [],
  captions: [{
    id: 'caption-intro',
    segmentId: 'intro',
    text: '介绍',
    startFrame: 0,
    endFrame: 30,
  }],
  narration: {
    audioPath: 'audio/narration.wav',
    durationMs: 1000,
    intervals: [{segmentId: 'intro', startMs: 0, endMs: 1000}],
  },
  backgroundMusic: {
    renderPath: 'assets/source/music.wav',
    startMs: 0,
    durationMs: 2000,
  },
});

const fixedReleaseVerification = (sha256: string) => ({
  sha256,
  probe: {
    durationMs: 1000,
    formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoStreams: [{
      index: 0,
      codec: 'h264',
      pixelFormat: 'yuv420p',
      width: 1920,
      height: 1080,
      attachedPicture: false,
      averageFrameRate: {numerator: 30, denominator: 1, value: 30},
      realFrameRate: {numerator: 30, denominator: 1, value: 30},
      rotation: 0,
      durationMs: 1000,
      sideDataTypes: [],
    }],
    audioStreams: [{
      index: 1,
      codec: 'aac',
      sampleRate: 48_000,
      channels: 2,
      durationMs: 1000,
    }],
  },
  atoms: [
    {type: 'ftyp', offset: 0, size: 8},
    {type: 'moov', offset: 8, size: 8},
    {type: 'mdat', offset: 16, size: 8},
  ],
  moovBeforeMdat: true,
}) satisfies ReleaseVerificationReport;

const semanticReleaseVerificationFailures = [
  ['zero streams', (verification: ReleaseVerificationReport) => {
    verification.probe.videoStreams = [];
    verification.probe.audioStreams = [];
  }],
  ['wrong fixed profile', (verification: ReleaseVerificationReport) => {
    verification.probe.videoStreams[0]!.width = 1280;
  }],
  ['empty atoms', (verification: ReleaseVerificationReport) => {
    verification.atoms = [];
  }],
  ['moov after mdat', (verification: ReleaseVerificationReport) => {
    verification.atoms = [
      {type: 'ftyp', offset: 0, size: 8},
      {type: 'mdat', offset: 8, size: 8},
      {type: 'moov', offset: 16, size: 8},
    ];
  }],
] as const;

const draftFrameArtifacts = (
  timeline: CompiledTimeline = compiledTimeline(),
) => selectReviewFrames(timeline).map((frame) => ({
  path: `draft/frames/frame-${String(frame).padStart(6, '0')}.jpg`,
  sha256: hash(`frame-${frame}`),
}));

const draftReport = (overrides: Partial<DraftReport['outputs']> = {}): DraftReport => ({
  version: 1,
  projectId: 'demo',
  outputs: {
    draftVideo: {path: 'draft/draft.mp4', sha256: contentHash('draft-video')},
    contactSheet: {path: 'draft/contact-sheet.jpg', sha256: contentHash('contact-sheet')},
    reviewFrames: [{
      path: 'draft/frames/frame-000000.jpg',
      sha256: contentHash('review-frame'),
    }],
    audio: {
      filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('filter-graph')},
      mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed-audio')},
    },
    audioMixFingerprint: hash('audio-mix'),
    ...overrides,
  },
});

const approvedReview = (overrides: Partial<Review> = {}): Review => ({
  version: 1,
  projectId: 'demo',
  runId: 'source-run',
  status: 'approved',
  reviewer: 'reviewer',
  reviewedAt: '2026-08-11T01:02:03.000Z',
  reason: 'approved',
  evidencePaths: [
    'draft/draft.mp4',
    'draft/contact-sheet.jpg',
    'draft/frames/frame-000000.jpg',
  ],
  ...overrides,
});

const preflightResult = (overrides: Partial<PreflightResult> = {}): PreflightResult => ({
  checks: [],
  toolIdentities: {
    ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg')},
    ffprobe: {realPath: '/tools/ffprobe', sha256: hash('ffprobe')},
    qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart')},
  },
  fonts: [{path: 'assets/fonts/NotoSansSC-Bold.otf', sha256: hash('font')}],
  voice: {
    configured: 'fixture',
    available: true,
    segmentedWavFallback: false,
  },
  versions: {
    node: 'v22.17.0',
    pnpm: '10.14.0',
    macos: '15.0',
    ffmpeg: '7.1',
    ffprobe: '7.1',
  },
  system: {
    platform: 'darwin',
    arch: 'arm64',
    sourceBytes: 123,
    requiredBytes: 2 * 1024 ** 3,
    availableBytes: 4 * 1024 ** 3,
    workDirectory: '.work/demo',
  },
  environmentFingerprint: hash('environment'),
  ...overrides,
});

const preflightStageReport = (result = preflightResult()): StageReport => passedStageReport({
  stageId: 'preflight',
  fingerprint: hash(result.environmentFingerprint),
  artifacts: [],
  outputs: JSON.parse(JSON.stringify(result)),
});

const sourceCatalog = (sourceHash = hash('source')): ProjectSourceCatalog => ({
  assets: [{
    assetId: 'cover',
    kind: 'image',
    sourcePath: 'assets/source/cover.png',
    sizeBytes: 123,
    sha256: sourceHash,
  }],
  totalBytes: 123,
  fingerprint: hash({sourceHash}),
});

const writeRunText = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<void> => {
  const parent = relativePath.split('/').slice(0, -1).join('/');
  if (parent.length > 0) await ensureRunDirectory(runDirectory, parent);
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeOutputText = async <RelativePath extends string>(
  outputDirectory: OutputDirectoryScope,
  relativePath: RelativePath,
  contents: string,
): Promise<{path: RelativePath; sha256: string}> => {
  const parent = relativePath.split('/').slice(0, -1).join('/');
  if (parent.length > 0) await ensureOutputDirectory(outputDirectory, parent);
  const handle = await openNewOutputFile(outputDirectory, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {path: relativePath, sha256: contentHash(contents)};
};

const materializeReleaseResult = async ({
  runId,
  preflight,
  draft,
  timeline,
  review,
  releaseFingerprint,
  outputReview = review,
  mutateVerification,
  publishedAt = '2026-08-11T01:02:03.000Z',
}: {
  runId: string;
  preflight: PreflightResult;
  draft: DraftReport;
  timeline: CompiledTimeline;
  review: Review;
  releaseFingerprint: string;
  outputReview?: Review;
  mutateVerification?: (verification: ReleaseVerificationReport) => void;
  publishedAt?: string;
}): Promise<ReleaseStageResult> => {
  const outputDirectory = await createOutputStore(tempProject.workspaceRoot)
    .createRelease('demo', runId);
  const finalVideo = await writeOutputText(
    outputDirectory,
    releaseOutputPath(runId, 'final.mp4'),
    'final-video',
  );
  const subtitles = await writeOutputText(
    outputDirectory,
    releaseOutputPath(runId, 'subtitles.srt'),
    releaseSrtFromTimeline(timeline),
  );
  const thumbnail = await writeOutputText(
    outputDirectory,
    releaseOutputPath(runId, 'thumbnail.jpg'),
    'thumbnail',
  );
  const releaseReview = await writeOutputText(
    outputDirectory,
    releaseOutputPath(runId, 'review.json'),
    `${JSON.stringify(outputReview, null, 2)}\n`,
  );
  const verification = fixedReleaseVerification(finalVideo.sha256);
  mutateVerification?.(verification);
  const intermediate = {
    path: 'release/final-intermediate.mp4',
    sha256: hash('intermediate'),
  };
  const validationReport = await writeOutputText(
    outputDirectory,
    releaseOutputPath(runId, 'validation-report.json'),
    `${JSON.stringify(buildReleaseValidationReport({
      projectId: 'demo',
      runId,
      releaseFingerprint,
      preflight: {
        toolIdentities: preflight.toolIdentities,
        environmentFingerprint: preflight.environmentFingerprint,
      },
      draftAudio: draft.outputs.audio,
      intermediate,
      finalVideo,
      subtitles,
      thumbnail,
      review: releaseReview,
      verification,
    }), null, 2)}\n`,
  );
  const checksums = await writeOutputText(
    outputDirectory,
    releaseOutputPath(runId, 'checksums.sha256'),
    formatReleaseChecksums(releaseChecksumArtifacts({
      finalVideo,
      subtitles,
      thumbnail,
      review: releaseReview,
      validationReport,
    })),
  );
  return {
    outputs: {
      mutedVideo: {path: 'release/muted-video.mp4', sha256: hash('release-muted')},
      intermediate,
      finalVideo,
      subtitles,
      thumbnail,
      review: releaseReview,
      validationReport,
      checksums,
      releaseFingerprint,
      verification,
    },
    current: {
      runId,
      relativePath: `releases/${runId}`,
      preset: 'release',
      stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
      completedStage: 'release',
      state: 'passed',
      publishedAt,
    },
  };
};

const fakeArtifact = async (
  _runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<PipelineArtifact> => ({
  scope: 'run',
  path: relativePath,
  sha256: hash(relativePath),
});

let tempProject: TempProject;
let project: ProjectInputs;
let sourceRun: RunDirectoryScope;
let targetRun: RunDirectoryScope;

beforeEach(async () => {
  tempProject = await createTempProject();
  project = await loadProject(tempProject.workspaceRoot, 'demo');
  const runStore = createRunStore(tempProject.workspaceRoot);
  sourceRun = await runStore.createRun('demo', 'source-run');
  targetRun = await runStore.createRun('demo', 'target-run');
  for (const runDirectory of [sourceRun, targetRun]) {
    await writeRunText(runDirectory, 'draft/draft.mp4', 'draft-video');
    await writeRunText(runDirectory, 'draft/contact-sheet.jpg', 'contact-sheet');
    await writeRunText(runDirectory, 'draft/frames/frame-000000.jpg', 'review-frame');
  }
});

afterEach(async () => {
  await tempProject.cleanup();
  vi.restoreAllMocks();
});

const planningContext = (
  overrides: Partial<StagePlanningContext> = {},
  reports: ReadonlyMap<StageReport['stageId'], StageReport> = new Map([
    ['preflight', preflightStageReport()],
    ['ingest', passedStageReport({stageId: 'ingest', fingerprint: hash('ingest-report')})],
    ['narration', passedStageReport({stageId: 'narration', fingerprint: hash('narration-report')})],
    ['compile', passedStageReport({stageId: 'compile', fingerprint: hash('compile-report')})],
  ]),
): StagePlanningContext => ({
  project,
  sourceCatalog: sourceCatalog(),
  preflight: preflightResult(),
  sourceRun: {
    runId: 'source-run',
    runDirectory: sourceRun,
    reports,
  },
  ...overrides,
});

const executionContext = (
  overrides: Partial<StageExecutionContext> = {},
): StageExecutionContext => ({
  ...planningContext(),
  preset: 'release',
  runId: 'target-run',
  runDirectory: targetRun,
  now: () => '2026-08-11T01:02:03.000Z',
  ...overrides,
});

const runIdForDirectory = (runDirectory: RunDirectoryScope): string => (
  runDirectory === sourceRun ? 'source-run' : 'target-run'
);

const runFilePath = (runId: string, relativePath: string): string => path.join(
  tempProject.workspaceRoot,
  '.work',
  'demo',
  'runs',
  runId,
  ...relativePath.split('/'),
);

const replaceRunText = async (
  runId: string,
  relativePath: string,
  contents: string,
): Promise<void> => {
  const target = runFilePath(runId, relativePath);
  await mkdir(path.dirname(target), {recursive: true});
  await writeFile(target, contents, 'utf8');
};

const successfulStageReportReader = async (
  runDirectory: RunDirectoryScope,
  stageId: 'ingest' | 'narration' | 'compile',
): Promise<StageReport> => passedStageReport({
  stageId,
  runId: runIdForDirectory(runDirectory),
  fingerprint: hash(`${stageId}-report`),
});

const createBoundCompileStage = (
  dependencies: Parameters<typeof createCompileStage>[0] = {},
) => createCompileStage({readStageReport: successfulStageReportReader, ...dependencies});

const createBoundDraftStage = (
  dependencies: Parameters<typeof createDraftStage>[0] = {},
) => createDraftStage({readStageReport: successfulStageReportReader, ...dependencies});

const releaseStageReportReader = ({
  preflight = () => preflightResult(),
  compileFingerprint = () => hash('compile-report'),
  runId = 'source-run',
}: {
  preflight?: () => PreflightResult;
  compileFingerprint?: () => string;
  runId?: string;
} = {}) => async (
  _runDirectory: RunDirectoryScope,
  stageId: 'preflight' | 'compile',
): Promise<StageReport> => stageId === 'preflight'
  ? {
    ...preflightStageReport(preflight()),
    runId,
    artifacts: [],
  }
  : passedStageReport({
    stageId: 'compile',
    runId,
    fingerprint: compileFingerprint(),
    artifacts: [],
  });

const mutateProject = (
  context: StagePlanningContext,
  mutate: (value: ProjectInputs['project']) => void,
): StagePlanningContext => {
  const nextProject = structuredClone(context.project.project);
  mutate(nextProject);
  return {
    ...context,
    project: {...context.project, project: nextProject},
  };
};

describe('MVP_STAGES', () => {
  it('registers the seven concrete adapters in stable order', () => {
    expect(MVP_STAGES.map((stage) => stage.id)).toEqual([
      'preflight',
      'ingest',
      'narration',
      'compile',
      'draft',
      'review',
      'release',
    ]);
    expect(STAGE_ALGORITHM_VERSIONS).toEqual({
      preflight: 'preflight-stage-v1',
      ingest: 'ingest-stage-v1',
      narration: 'narration-stage-v2',
      compile: 'compile-stage-v1',
      draft: 'draft-stage-v1',
      review: 'review-stage-v1',
      release: 'release-stage-v1',
    });
  });
});

describe('Draft review evidence contract', () => {
  it('returns draft video, contact sheet, and review frames in stable unique order', () => {
    const report = draftReport();

    expect(draftReviewEvidenceArtifacts(report)).toEqual([
      report.outputs.draftVideo,
      report.outputs.contactSheet,
      ...report.outputs.reviewFrames,
    ]);
  });

  it('rejects duplicate Draft review evidence paths', () => {
    const report = draftReport({
      reviewFrames: [{
        path: 'draft/draft.mp4',
        sha256: contentHash('draft-video'),
      }],
    });

    expect(() => draftReviewEvidenceArtifacts(report)).toThrow(
      'Draft review evidence paths must be unique',
    );
  });
});

describe('adapter fingerprints', () => {
  it('returns null for Preflight before an executable probe', async () => {
    const {preflight: _preflight, ...contextWithoutPreflight} = planningContext();
    await expect(createPreflightStage().fingerprint(contextWithoutPreflight))
      .resolves.toBeNull();
  });

  it.each([
    ['environment fingerprint', (context: StagePlanningContext) => ({
      ...context,
      preflight: preflightResult({environmentFingerprint: hash('environment-2')}),
    })],
    ['source catalog fingerprint', (context: StagePlanningContext) => ({
      ...context,
      sourceCatalog: sourceCatalog(hash('source-2')),
    })],
    ['font path', (context: StagePlanningContext) => ({
      ...context,
      preflight: preflightResult({fonts: [{path: 'assets/fonts/other.otf', sha256: hash('font')}]}),
    })],
    ['font hash', (context: StagePlanningContext) => ({
      ...context,
      preflight: preflightResult({fonts: [{path: 'assets/fonts/NotoSansSC-Bold.otf', sha256: hash('font-2')}]}),
    })],
    ['TTS config', (context: StagePlanningContext) => mutateProject(context, (value) => {
      value.tts.rate = 181;
    })],
  ] as const)('changes Preflight for %s', async (_label, mutate) => {
    const stage = createPreflightStage();
    const beforeContext = planningContext();
    expect(await stage.fingerprint(mutate(beforeContext))).not.toBe(
      await stage.fingerprint(beforeContext),
    );
  });

  it('changes Preflight for its algorithm version', async () => {
    const context = planningContext();
    expect(await createPreflightStage({algorithmVersion: 'preflight-stage-v2'}).fingerprint(context))
      .not.toBe(await createPreflightStage().fingerprint(context));
  });

  it('passes the Stage AbortSignal into Preflight execution', async () => {
    const controller = new AbortController();
    const runPreflight = vi.fn(async (
      _input: unknown,
      _options?: {signal?: AbortSignal},
    ) => preflightResult());
    const stage = createPreflightStage({runPreflight});

    await stage.execute(executionContext(), controller.signal);

    expect(runPreflight).toHaveBeenCalledWith(
      expect.objectContaining({workspaceRoot: project.workspaceRoot}),
      {signal: controller.signal},
    );
  });

  it('passes configured FFmpeg overrides into Preflight execution', async () => {
    const runPreflight = vi.fn(async () => preflightResult());
    const dependencies = {
      runPreflight,
      ffmpegExecutable: '/custom/tools/ffmpeg',
      ffprobeExecutable: '/custom/tools/ffprobe',
    } as Parameters<typeof createPreflightStage>[0] & {
      ffmpegExecutable: string;
      ffprobeExecutable: string;
    };
    const stage = createPreflightStage(dependencies);

    await stage.execute(executionContext(), new AbortController().signal);

    expect(runPreflight).toHaveBeenCalledWith(expect.objectContaining({
      ffmpegExecutable: '/custom/tools/ffmpeg',
      ffprobeExecutable: '/custom/tools/ffprobe',
    }), expect.any(Object));
  });

  it.each([
    ['source hash', (context: StagePlanningContext) => ({
      ...context,
      sourceCatalog: sourceCatalog(hash('source-2')),
    })],
    ['FFmpeg identity', (context: StagePlanningContext) => ({
      ...context,
      preflight: preflightResult({
        toolIdentities: {
          ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg-2')},
          ffprobe: {realPath: '/tools/ffprobe', sha256: hash('ffprobe')},
          qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart')},
        },
      }),
    })],
    ['FFprobe identity', (context: StagePlanningContext) => ({
      ...context,
      preflight: preflightResult({
        toolIdentities: {
          ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg')},
          ffprobe: {realPath: '/tools/ffprobe', sha256: hash('ffprobe-2')},
          qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart')},
        },
      }),
    })],
  ] as const)('changes Ingest for %s', async (_label, mutate) => {
    const stage = createIngestStage();
    const beforeContext = planningContext();
    expect(await stage.fingerprint(mutate(beforeContext))).not.toBe(
      await stage.fingerprint(beforeContext),
    );
  });

  it('changes Ingest for its algorithm version', async () => {
    const context = planningContext();
    expect(await createIngestStage({algorithmVersion: 'ingest-stage-v2'}).fingerprint(context))
      .not.toBe(await createIngestStage().fingerprint(context));
  });

  it.each(['ffmpeg', 'ffprobe'] as const)(
    'returns null for Ingest without a persisted %s identity',
    async (tool) => {
      const preflight = preflightResult();
      preflight.toolIdentities[tool] = null;
      await expect(createIngestStage().fingerprint(planningContext({preflight})))
        .resolves.toBeNull();
    },
  );

  it.each([
    ['script', (context: StagePlanningContext) => ({
      ...context,
      project: {...context.project, script: createScriptFixture('changed script')},
    })],
    ['TTS config', (context: StagePlanningContext) => mutateProject(context, (value) => {
      value.tts.voice = 'other';
    })],
    ['FFmpeg identity', (context: StagePlanningContext) => ({
      ...context,
      preflight: preflightResult({
        toolIdentities: {
          ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg-2')},
          ffprobe: {realPath: '/tools/ffprobe', sha256: hash('ffprobe')},
          qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart')},
        },
      }),
    })],
  ] as const)('changes Narration for %s', async (_label, mutate) => {
    const stage = createNarrationStage({
      fingerprintTtsProvider: async () => hash('provider'),
    });
    const beforeContext = planningContext();
    expect(await stage.fingerprint(mutate(beforeContext))).not.toBe(
      await stage.fingerprint(beforeContext),
    );
  });

  it('changes Narration for provider and algorithm fingerprints', async () => {
    const context = planningContext();
    expect(await createNarrationStage({
      fingerprintTtsProvider: async () => hash('provider-2'),
    }).fingerprint(context)).not.toBe(await createNarrationStage({
      fingerprintTtsProvider: async () => hash('provider'),
    }).fingerprint(context));
    expect(await createNarrationStage({
      algorithmVersion: 'narration-stage-v3',
      fingerprintTtsProvider: async () => hash('provider'),
    }).fingerprint(context)).not.toBe(await createNarrationStage({
      fingerprintTtsProvider: async () => hash('provider'),
    }).fingerprint(context));
  });

  it.each([
    ['project authoring hash', 'project.json'],
    ['script authoring hash', 'script.json'],
    ['edit authoring hash', 'edit.json'],
  ] as const)('changes Compile for %s', async (_label, changedPath) => {
    const hashes = new Map([
      ['project.json', hash('project')],
      ['script.json', hash('script')],
      ['edit.json', hash('edit')],
    ]);
    const stage = createBoundCompileStage({
      hashProjectFile: async (_scope, relativePath) => hashes.get(relativePath)!,
    });
    const context = planningContext();
    const before = await stage.fingerprint(context);
    hashes.set(changedPath, hash(`${changedPath}-2`));
    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it.each([
    ['Ingest report fingerprint', 'ingest'],
    ['Narration report fingerprint', 'narration'],
  ] as const)('changes Compile for %s', async (_label, stageId) => {
    const fingerprints = {
      ingest: hash('ingest-report'),
      narration: hash('narration-report'),
    };
    const stage = createCompileStage({
      hashProjectFile: async (_scope, path) => hash(path),
      readStageReport: async (runDirectory, requestedStageId) => passedStageReport({
        stageId: requestedStageId,
        runId: runIdForDirectory(runDirectory),
        fingerprint: fingerprints[requestedStageId],
      }),
    });
    const context = planningContext();
    const before = await stage.fingerprint(context);
    fingerprints[stageId] = hash(`${stageId}-2`);
    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it('changes Compile for registered component IDs and algorithm version', async () => {
    const context = planningContext();
    const dependencies = {hashProjectFile: async (_scope: unknown, path: string) => hash(path)};
    expect(await createBoundCompileStage({...dependencies, componentIds: ['basic-title', 'other']})
      .fingerprint(context)).not.toBe(await createBoundCompileStage(dependencies).fingerprint(context));
    expect(await createBoundCompileStage({...dependencies, algorithmVersion: 'compile-stage-v2'})
      .fingerprint(context)).not.toBe(await createBoundCompileStage(dependencies).fingerprint(context));
  });

  it.each([
    ['sampleRate', (value: ProjectInputs['project']) => { value.audio.sampleRate = 44_100 as 48_000; }],
    ['targetLufs', (value: ProjectInputs['project']) => { value.audio.targetLufs = -15; }],
    ['truePeakDb', (value: ProjectInputs['project']) => { value.audio.truePeakDb = -1; }],
    ['backgroundMusicGainDb', (value: ProjectInputs['project']) => { value.audio.backgroundMusicGainDb = -19; }],
    ['duckDuringNarrationDb', (value: ProjectInputs['project']) => { value.audio.duckDuringNarrationDb = -11; }],
    ['duckAttackMs', (value: ProjectInputs['project']) => { value.audio.duckAttackMs = 121; }],
    ['duckReleaseMs', (value: ProjectInputs['project']) => { value.audio.duckReleaseMs = 251; }],
  ] as const)('changes Draft for project.audio.%s', async (field, mutate) => {
    const stage = createBoundDraftStage();
    const beforeContext = planningContext();
    expect(await stage.fingerprint(mutateProject(beforeContext, mutate))).not.toBe(
      await stage.fingerprint(beforeContext),
    );
  });

  it.each([
    ['draftWidth', (value: ProjectInputs['project']) => { value.render.draftWidth = 1280 as 960; }],
    ['draftHeight', (value: ProjectInputs['project']) => { value.render.draftHeight = 720 as 540; }],
    ['videoCodec', (value: ProjectInputs['project']) => { value.render.videoCodec = 'hevc' as 'h264'; }],
    ['pixelFormat', (value: ProjectInputs['project']) => { value.render.pixelFormat = 'yuv444p' as 'yuv420p'; }],
  ] as const)('changes Draft for render config field %s', async (_field, mutate) => {
    const context = planningContext();
    const baseline = await createBoundDraftStage().fingerprint(context);
    const altered = structuredClone(context.project.project);
    mutate(altered);
    expect(baseline).not.toBe(await createBoundDraftStage().fingerprint({
      ...context,
      project: {...context.project, project: altered},
    }));
  });

  it.each(['ffmpeg', 'ffprobe'] as const)(
    'changes Draft for the persisted %s identity',
    async (tool) => {
      const context = planningContext();
      const changed = preflightResult();
      changed.toolIdentities[tool] = {
        realPath: `/tools/${tool}`,
        sha256: hash(`${tool}-2`),
      };
      expect(await createBoundDraftStage().fingerprint({...context, preflight: changed}))
        .not.toBe(await createBoundDraftStage().fingerprint(context));
    },
  );

  it.each(['ffmpeg', 'ffprobe'] as const)(
    'returns null for Draft without a persisted %s identity',
    async (tool) => {
      const preflight = preflightResult();
      preflight.toolIdentities[tool] = null;
      await expect(createBoundDraftStage().fingerprint(planningContext({preflight})))
        .resolves.toBeNull();
    },
  );

  it('changes Draft for Compile and Stage algorithm versions', async () => {
    let compileFingerprint = hash('compile-report');
    const reader = async (runDirectory: RunDirectoryScope) => passedStageReport({
      stageId: 'compile',
      runId: runIdForDirectory(runDirectory),
      fingerprint: compileFingerprint,
    });
    const context = planningContext();
    const before = await createDraftStage({readStageReport: reader}).fingerprint(context);
    compileFingerprint = hash('compile-2');
    expect(await createDraftStage({readStageReport: reader}).fingerprint(context)).not.toBe(before);
    expect(await createDraftStage({
      readStageReport: reader,
      algorithmVersion: 'draft-stage-v2',
    }).fingerprint(context)).not.toBe(
      await createDraftStage({readStageReport: reader}).fingerprint(context),
    );
  });

  it('changes Review for Draft evidence paths, hashes, and algorithm version', async () => {
    let report = draftReport();
    const stage = createReviewStage({readDraftReport: async () => report});
    const context = planningContext();
    const before = await stage.fingerprint(context);
    report = draftReport({contactSheet: {path: 'draft/other.jpg', sha256: hash('contact-sheet')}});
    expect(await stage.fingerprint(context)).not.toBe(before);
    report = draftReport({contactSheet: {path: 'draft/contact-sheet.jpg', sha256: hash('contact-sheet-2')}});
    expect(await stage.fingerprint(context)).not.toBe(before);
    expect(await createReviewStage({
      readDraftReport: async () => draftReport(),
      algorithmVersion: 'review-stage-v2',
    }).fingerprint(context)).not.toBe(before);
  });

  it.each([
    ['Draft filter-graph hash', () => draftReport({
      audio: {
        filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('filter-graph-2')},
        mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed-audio')},
      },
    })],
    ['Draft review-frame hash', () => draftReport({
      reviewFrames: [{path: 'draft/frames/frame-000000.jpg', sha256: hash('frame-2')}],
    })],
  ] as const)('changes Release for %s', async (_label, changedDraft) => {
    let report = draftReport();
    const stage = createReleaseStage({
      readDraftReport: async () => report,
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
      readStageReport: releaseStageReportReader(),
    });
    const context = planningContext();
    const before = await stage.fingerprint(context);
    report = changedDraft();
    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it('changes Release for Compile hashes, Review identity, Preflight environment, and algorithm', async () => {
    let timeline = compiledTimeline();
    let review = approvedReview();
    let persistedPreflight = preflightResult();
    const dependencies = {
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => timeline,
      readReview: async () => review,
      readStageReport: releaseStageReportReader({
        preflight: () => persistedPreflight,
      }),
    };
    const context = planningContext();
    const stage = createReleaseStage(dependencies);
    const before = await stage.fingerprint(context);
    timeline = compiledTimeline({'authoring:project': hash('project-2')});
    expect(await stage.fingerprint(context)).not.toBe(before);
    timeline = compiledTimeline();
    review = approvedReview({reviewer: 'other'});
    expect(await stage.fingerprint(context)).not.toBe(before);
    review = approvedReview();
    const livePreflightChanged = {
      ...context,
      preflight: preflightResult({environmentFingerprint: hash('live-environment-2')}),
    };
    expect(await stage.fingerprint(livePreflightChanged)).toBe(before);
    persistedPreflight = preflightResult({
      environmentFingerprint: hash('persisted-environment-2'),
    });
    expect(await stage.fingerprint(context)).not.toBe(before);
    expect(await createReleaseStage({...dependencies, algorithmVersion: 'release-stage-v2'})
      .fingerprint(context)).not.toBe(before);
  });

  it('changes Release for the qt-faststart environment fingerprint', async () => {
    let currentPreflight = preflightResult();
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
      readStageReport: releaseStageReportReader({preflight: () => currentPreflight}),
    });
    const context = planningContext();
    const before = await stage.fingerprint(context);
    currentPreflight = preflightResult({
      environmentFingerprint: hash('environment-with-new-qt-faststart'),
      toolIdentities: {
        ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg')},
        ffprobe: {realPath: '/tools/ffprobe', sha256: hash('ffprobe')},
        qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart-2')},
      },
    });
    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it('uses persisted Preflight outputs for Release planning and execution', async () => {
    const sourcePersisted = preflightResult({
      environmentFingerprint: hash('source-persisted-environment'),
      toolIdentities: {
        ffmpeg: {realPath: '/persisted/source/ffmpeg', sha256: hash('source-ffmpeg')},
        ffprobe: {realPath: '/persisted/source/ffprobe', sha256: hash('source-ffprobe')},
        qtFaststart: {realPath: '/persisted/source/qt-faststart', sha256: hash('source-qt')},
      },
    });
    const currentPersisted = preflightResult({
      environmentFingerprint: hash('current-persisted-environment'),
      toolIdentities: {
        ffmpeg: {realPath: '/persisted/current/ffmpeg', sha256: hash('current-ffmpeg')},
        ffprobe: {realPath: '/persisted/current/ffprobe', sha256: hash('current-ffprobe')},
        qtFaststart: {realPath: '/persisted/current/qt-faststart', sha256: hash('current-qt')},
      },
    });
    const live = preflightResult({
      environmentFingerprint: hash('live-environment'),
      toolIdentities: {
        ffmpeg: {realPath: '/live/ffmpeg', sha256: hash('live-ffmpeg')},
        ffprobe: {realPath: '/live/ffprobe', sha256: hash('live-ffprobe')},
        qtFaststart: {realPath: '/live/qt-faststart', sha256: hash('live-qt')},
      },
    });
    const draft = draftReport();
    const timeline = compiledTimeline();
    const compileFingerprint = hash('compile-stage');
    const sourceReview = approvedReview({runId: 'source-run'});
    const targetReview = approvedReview({runId: 'target-run'});
    const sourceFingerprint = releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      compileStageFingerprint: compileFingerprint,
      compiledTimeline: timeline,
      review: sourceReview,
      preflightEnvironmentFingerprint: sourcePersisted.environmentFingerprint,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    });
    const targetFingerprint = releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      compileStageFingerprint: compileFingerprint,
      compiledTimeline: timeline,
      review: targetReview,
      preflightEnvironmentFingerprint: currentPersisted.environmentFingerprint,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    });
    const releaseResult = await materializeReleaseResult({
      runId: 'target-run',
      preflight: currentPersisted,
      draft,
      timeline,
      review: targetReview,
      releaseFingerprint: targetFingerprint,
    });
    const executeRelease = vi.fn(async () => releaseResult);
    const store = createStageReportStore();
    await store.writeStage(targetRun, {
      ...preflightStageReport(currentPersisted),
      runId: 'target-run',
      artifacts: [],
    });
    await store.writeStage(targetRun, passedStageReport({
      stageId: 'compile',
      runId: 'target-run',
      fingerprint: compileFingerprint,
      artifacts: [],
    }));
    const stage = createReleaseStage({
      readDraftReport: async () => draft,
      readCompiledTimeline: async () => timeline,
      readReview: async (runDirectory) => runDirectory === sourceRun
        ? sourceReview
        : targetReview,
      readStageReport: async (runDirectory, stageId) => runDirectory === sourceRun
        ? releaseStageReportReader({
          preflight: () => sourcePersisted,
          compileFingerprint: () => compileFingerprint,
        })(runDirectory, stageId)
        : await store.readStage(runDirectory, stageId),
      runRelease: executeRelease,
    });
    const sourceReports = new Map(planningContext().sourceRun!.reports);
    sourceReports.set('preflight', preflightStageReport(sourcePersisted));
    const planning = planningContext({
      preflight: live,
      sourceRun: {
        runId: 'source-run',
        runDirectory: sourceRun,
        reports: sourceReports,
      },
    });
    expect(await stage.fingerprint(planning)).toBe(sourceFingerprint);

    const result = await stage.execute(
      executionContext({preflight: currentPersisted}),
      new AbortController().signal,
    );
    expect(executeRelease).toHaveBeenCalledWith(expect.objectContaining({
      preflight: {
        toolIdentities: currentPersisted.toolIdentities,
        environmentFingerprint: currentPersisted.environmentFingerprint,
      },
    }), expect.objectContaining({
      publishCurrent: false,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    }));
    expect(result.fingerprint).toBe(targetFingerprint);
  });
});

describe('successful prerequisite reports', () => {
  const invalidReports = (
    stageId: 'ingest' | 'narration' | 'compile',
    runId: string,
  ): Array<[string, StageReport]> => {
    const base = passedStageReport({stageId, runId, fingerprint: hash(`${stageId}-report`)});
    return [
      ['failed', {...base, state: 'failed', error: {code: 'FAILED', message: 'failed'}}],
      ['cancelled', {...base, state: 'cancelled', error: {code: 'CANCELLED', message: 'cancelled'}}],
      ['needs_review', {...base, state: 'needs_review'}],
      ['null fingerprint', {...base, fingerprint: null}],
      ['foreign project', {...base, projectId: 'other-project'}],
      ['foreign run', {...base, runId: 'other-run'}],
      ['wrong stage', {...base, stageId: stageId === 'ingest' ? 'narration' : 'ingest'}],
    ];
  };

  it.each(['ingest', 'narration'] as const)(
    'maps invalid %s prerequisites to null and blocks Compile execution',
    async (invalidStageId) => {
      for (const [label, invalidSourceReport] of invalidReports(
        invalidStageId,
        'source-run',
      )) {
        const runCompile = vi.fn(async () => ({
          timelinePath: 'compiled-timeline.json' as const,
          timeline: compiledTimeline(),
        }));
        const readStageReport = async (
          runDirectory: RunDirectoryScope,
          stageId: 'ingest' | 'narration',
        ): Promise<StageReport> => {
          if (stageId !== invalidStageId) {
            return await successfulStageReportReader(runDirectory, stageId);
          }
          return runDirectory === sourceRun
            ? invalidSourceReport
            : {
              ...invalidSourceReport,
              runId: invalidSourceReport.runId === 'source-run'
                ? 'target-run'
                : invalidSourceReport.runId,
            };
        };
        const stage = createCompileStage({
          hashProjectFile: async (_scope, relativePath) => hash(relativePath),
          readStageReport,
          runCompile,
          hashRunArtifact: fakeArtifact,
        });

        await expect(stage.fingerprint(planningContext()), label).resolves.toBeNull();
        await expect(stage.execute(
          executionContext(),
          new AbortController().signal,
        ), label).rejects.toBeDefined();
        expect(runCompile, label).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['ingest', 'narration'] as const)(
    'maps missing and malformed %s prerequisites to null and blocks Compile execution',
    async (invalidStageId) => {
      for (const [label, failure] of [
        ['missing', null],
        ['malformed', new SyntaxError('malformed prerequisite report')],
      ] as const) {
        const runCompile = vi.fn();
        const stage = createCompileStage({
          hashProjectFile: async (_scope, relativePath) => hash(relativePath),
          readStageReport: async (runDirectory, stageId) => {
            if (stageId !== invalidStageId) {
              return await successfulStageReportReader(runDirectory, stageId);
            }
            if (failure === null) return null;
            throw failure;
          },
          runCompile,
        });

        await expect(stage.fingerprint(planningContext()), label).resolves.toBeNull();
        await expect(stage.execute(
          executionContext(),
          new AbortController().signal,
        ), label).rejects.toBeDefined();
        expect(runCompile, label).not.toHaveBeenCalled();
      }
    },
  );

  it('maps invalid Compile prerequisites to null and blocks Draft execution', async () => {
    for (const [label, invalidSourceReport] of invalidReports('compile', 'source-run')) {
      const runDraft = vi.fn(async () => ({
        reportPath: 'draft/draft-report.json' as const,
        outputs: {
          mutedVideo: {path: 'draft/muted-video.mp4', sha256: hash('muted')},
          draftVideo: {path: 'draft/draft.mp4', sha256: hash('draft')},
          contactSheet: {path: 'draft/contact-sheet.jpg', sha256: hash('contact')},
          reviewFrames: draftFrameArtifacts(),
          audio: {
            filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('graph')},
            mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed')},
          },
          report: {path: 'draft/draft-report.json', sha256: hash('report')},
          audioMixFingerprint: hash('audio-mix'),
        },
      }));
      const stage = createDraftStage({
        readStageReport: async (runDirectory) => runDirectory === sourceRun
          ? invalidSourceReport
          : {
            ...invalidSourceReport,
            runId: invalidSourceReport.runId === 'source-run'
              ? 'target-run'
              : invalidSourceReport.runId,
          },
        readCompiledTimeline: async () => compiledTimeline(),
        runDraft,
      });

      await expect(stage.fingerprint(planningContext()), label).resolves.toBeNull();
      await expect(stage.execute(
        executionContext(),
        new AbortController().signal,
      ), label).rejects.toBeDefined();
      expect(runDraft, label).not.toHaveBeenCalled();
    }
  });

  it('maps missing and malformed Compile prerequisites to null and blocks Draft execution', async () => {
    for (const [label, failure] of [
      ['missing', null],
      ['malformed', new SyntaxError('malformed Compile report')],
    ] as const) {
      const runDraft = vi.fn();
      const stage = createDraftStage({
        readStageReport: async () => {
          if (failure === null) return null;
          throw failure;
        },
        runDraft,
      });

      await expect(stage.fingerprint(planningContext()), label).resolves.toBeNull();
      await expect(stage.execute(
        executionContext(),
        new AbortController().signal,
      ), label).rejects.toBeDefined();
      expect(runDraft, label).not.toHaveBeenCalled();
    }
  });
});

describe('Review Draft project binding', () => {
  it('maps foreign Draft projects to null/false and blocks execution before evaluation', async () => {
    const foreignDraft = {...draftReport(), projectId: 'other-project'};
    const sourceReview = approvedReview();
    const evidence = draftReviewEvidenceArtifacts(foreignDraft);
    const planningStage = createReviewStage({
      readDraftReport: async () => foreignDraft,
      readReview: async () => sourceReview,
    });
    const context = planningContext();

    await expect(planningStage.fingerprint(context)).resolves.toBeNull();
    await expect(planningStage.verify(context, passedStageReport({
      stageId: 'review',
      runId: 'source-run',
      fingerprint: fingerprintValue({
        algorithmVersion: STAGE_ALGORITHM_VERSIONS.review,
        evidence,
      }),
      artifacts: [],
      outputs: {evidence, review: sourceReview},
    }))).resolves.toBe(false);

    const targetReview = approvedReview({runId: 'target-run'});
    const evaluateReview = vi.fn(async () => ({state: 'passed' as const, review: targetReview}));
    const executionStage = createReviewStage({
      readDraftReport: async () => foreignDraft,
      readReview: async () => targetReview,
      evaluateReview,
    });
    await expect(executionStage.execute(
      executionContext(),
      new AbortController().signal,
    )).rejects.toThrow(/PIPELINE_CONTEXT_INVALID/u);
    expect(evaluateReview).not.toHaveBeenCalled();
  });
});

describe('Review approval commit marker', () => {
  const currentDraftReport = async (): Promise<DraftReport> => {
    const draftVideo = await hashRunArtifact(targetRun, 'draft/draft.mp4');
    const contactSheet = await hashRunArtifact(targetRun, 'draft/contact-sheet.jpg');
    const reviewFrame = await hashRunArtifact(targetRun, 'draft/frames/frame-000000.jpg');
    return draftReport({
      draftVideo: {path: draftVideo.path, sha256: draftVideo.sha256},
      contactSheet: {path: contactSheet.path, sha256: contactSheet.sha256},
      reviewFrames: [{path: reviewFrame.path, sha256: reviewFrame.sha256}],
    });
  };

  const canonicalReviewReport = (
    draft: DraftReport,
    review: Review,
  ): StageReport => {
    const evidence = draftReviewEvidenceArtifacts(draft);
    return passedStageReport({
      stageId: 'review',
      runId: 'target-run',
      fingerprint: fingerprintValue({
        algorithmVersion: STAGE_ALGORITHM_VERSIONS.review,
        evidence,
      }),
      artifacts: [],
      outputs: {evidence, review},
    });
  };

  it('ignores orphan approval after Draft hashes change at identical paths', async () => {
    const draft = await currentDraftReport();
    const previousDraft = draftReport({
      ...draft.outputs,
      contactSheet: {
        ...draft.outputs.contactSheet,
        sha256: hash('previous-contact-sheet'),
      },
    });
    const previousEvidence = draftReviewEvidenceArtifacts(previousDraft);
    const currentEvidence = draftReviewEvidenceArtifacts(draft);
    expect(previousEvidence.map((artifact) => artifact.path)).toEqual(
      currentEvidence.map((artifact) => artifact.path),
    );
    expect(fingerprintValue(previousEvidence)).not.toBe(fingerprintValue(currentEvidence));
    const review = approvedReview({
      runId: 'target-run',
      evidencePaths: previousEvidence.map((artifact) => artifact.path),
    });
    const readReview = vi.fn(async () => review);
    const evaluate = vi.fn(evaluateReview);
    const stage = createReviewStage({
      readDraftReport: async () => draft,
      readReview,
      readStageReport: async () => null,
      evaluateReview: evaluate,
    });

    await expect(stage.execute(
      executionContext(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      state: 'needs_review',
      outputs: {review: null},
    });
    expect(readReview).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith(expect.not.objectContaining({review}));
  });

  it('ignores orphan approval when canonical evidence hashes no longer match Draft', async () => {
    const draft = await currentDraftReport();
    const review = approvedReview({runId: 'target-run'});
    const oldDraft = draftReport({
      ...draft.outputs,
      contactSheet: {
        ...draft.outputs.contactSheet,
        sha256: hash('old-contact-sheet'),
      },
    });
    const readReview = vi.fn(async () => review);
    const evaluate = vi.fn(evaluateReview);
    const stage = createReviewStage({
      readDraftReport: async () => draft,
      readReview,
      readStageReport: async () => canonicalReviewReport(oldDraft, review),
      evaluateReview: evaluate,
    });

    await expect(stage.execute(
      executionContext(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      state: 'needs_review',
      outputs: {review: null},
    });
    expect(readReview).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledWith(expect.not.objectContaining({review}));
  });

  it('ignores approval when review.json differs from the canonical Review object', async () => {
    const draft = await currentDraftReport();
    const canonicalReview = approvedReview({runId: 'target-run'});
    const currentReview = approvedReview({
      runId: 'target-run',
      reason: 'different approval',
    });
    const evaluate = vi.fn(evaluateReview);
    const stage = createReviewStage({
      readDraftReport: async () => draft,
      readReview: async () => currentReview,
      readStageReport: async () => canonicalReviewReport(draft, canonicalReview),
      evaluateReview: evaluate,
    });

    await expect(stage.execute(
      executionContext(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      state: 'needs_review',
      outputs: {review: null},
    });
    expect(evaluate).toHaveBeenCalledWith(expect.not.objectContaining({review: currentReview}));
  });

  it('uses approval only when canonical report and review.json match current Draft', async () => {
    const draft = await currentDraftReport();
    const review = approvedReview({runId: 'target-run'});
    const readReview = vi.fn(async () => review);
    const evaluate = vi.fn(evaluateReview);
    const stage = createReviewStage({
      readDraftReport: async () => draft,
      readReview,
      readStageReport: async () => canonicalReviewReport(draft, review),
      evaluateReview: evaluate,
    });

    await expect(stage.execute(
      executionContext(),
      new AbortController().signal,
    )).resolves.toMatchObject({
      state: 'passed',
      outputs: {review},
    });
    expect(readReview).toHaveBeenCalledWith(targetRun);
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({review}));
  });
});

describe('adapter artifact inventories', () => {
  it('returns only artifacts owned or consumed by each adapter', async () => {
    const narrationInputHash = narrationSegmentInputHash(
      project.script.segments[0]!,
      project.project.tts.voice,
      project.project.tts.rate,
      hash('provider'),
    );
    const narrationSegmentPath = `audio/segments/0001-intro-${narrationInputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`;
    const narrationSegments = [{
      id: 'intro',
      inputHash: narrationInputHash,
      audioPath: narrationSegmentPath,
      audioHash: hash('segment'),
      startMs: 0,
      endMs: 1000,
      durationMs: 1000,
      pauseAfterMs: 300,
      sampleRate: 48_000 as const,
      channels: 1 as const,
      providerFingerprint: hash('provider'),
    }];
    const narrationPath = narrationMasterPath({
      provider: 'mock',
      segments: narrationSegments,
    });
    const draftResult: DraftStageResult = {
      reportPath: 'draft/draft-report.json',
      outputs: {
        mutedVideo: {path: 'draft/muted-video.mp4', sha256: hash('muted')},
        draftVideo: {path: 'draft/draft.mp4', sha256: hash('draft')},
        contactSheet: {path: 'draft/contact-sheet.jpg', sha256: hash('contact')},
        reviewFrames: draftFrameArtifacts(),
        audio: {
          filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('graph')},
          mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed')},
        },
        report: {path: 'draft/draft-report.json', sha256: hash('draft-report')},
        audioMixFingerprint: hash('audio-mix'),
      },
    };
    const releaseCompileFingerprint = hash('release-compile');
    const releaseReview = approvedReview({runId: 'target-run'});
    const releaseFingerprint = releaseStageFingerprint({
      draft: draftReport().outputs,
      compileInputHashes: compiledTimeline().inputHashes,
      compileStageFingerprint: releaseCompileFingerprint,
      compiledTimeline: compiledTimeline(),
      review: releaseReview,
      preflightEnvironmentFingerprint: preflightResult().environmentFingerprint,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    });
    const releaseResult = await materializeReleaseResult({
      runId: 'target-run',
      preflight: preflightResult(),
      draft: draftReport(),
      timeline: compiledTimeline(),
      review: releaseReview,
      releaseFingerprint,
    });
    const runReleaseAdapter = vi.fn(async () => releaseResult);
    await writeRunText(
      targetRun,
      'reports/preflight.json',
      `${JSON.stringify({
        ...preflightStageReport(),
        runId: 'target-run',
        outputs: preflightResult(),
      })}\n`,
    );
    const inventoryCatalog: ProjectSourceCatalog = {
      assets: [
        {
          assetId: 'cover',
          kind: 'image',
          sourcePath: 'assets/source/cover.png',
          sizeBytes: 123,
          sha256: hash('cover'),
        },
        {
          assetId: 'clip',
          kind: 'video',
          sourcePath: 'assets/source/clip.mov',
          sizeBytes: 456,
          sha256: hash('clip'),
        },
      ],
      totalBytes: 579,
      fingerprint: hash('inventory-catalog'),
    };
    const context = executionContext({sourceCatalog: inventoryCatalog});

    const stages = [
      createPreflightStage({runPreflight: async () => preflightResult()}),
      createIngestStage({
        runIngest: async () => ({
          manifestPath: 'asset-manifest.json',
          manifest: {
            version: 1,
            assets: {
              cover: {
                kind: 'image',
                sourcePath: 'assets/source/cover.png',
                sourceHash: hash('cover'),
                renderPath: 'assets/source/cover.png',
                renderScope: 'project',
                compatibility: 'direct',
                width: 1920,
                height: 1080,
              },
              clip: {
                kind: 'video',
                sourcePath: 'assets/source/clip.mov',
                sourceHash: hash('clip'),
                renderPath: 'assets/clip/render.mp4',
                renderScope: 'run',
                compatibility: 'transcoded',
                durationMs: 1000,
                width: 1920,
                height: 1080,
                videoCodec: 'h264',
                pixelFormat: 'yuv420p',
                colorSpace: 'bt709',
                hasAudio: false,
                variableFrameRate: false,
              },
            },
          },
        }),
        hashRunArtifact: fakeArtifact,
      }),
      createNarrationStage({
        fingerprintTtsProvider: async () => hash('provider'),
        createTtsProvider: () => ({
          id: 'mock',
          capabilities: async () => ({languages: ['zh-CN'], voices: ['fixture']}),
          fingerprint: async () => hash('provider'),
          synthesize: async () => ({outputPath: 'unused', providerFingerprint: hash('provider')}),
        }),
        runNarration: async () => ({
          narrationPath: 'narration-manifest.json',
          captionsPath: 'captions.json',
          srtPath: 'captions.srt',
          narration: {
            version: 1,
            provider: 'mock',
            segments: narrationSegments,
            master: {
              audioPath: narrationPath,
              audioHash: hash('master'),
              durationMs: 1300,
            },
          },
          captions: {
            version: 1,
            sourceNarrationHash: hash('master'),
            cues: [{
              id: 'caption-intro',
              segmentId: 'intro',
              text: '简短文本',
              startMs: 0,
              endMs: 1000,
            }],
          },
        }),
        hashRunArtifact: fakeArtifact,
      }),
      createCompileStage({
        hashProjectFile: async (_scope, path) => hash(path),
        readStageReport: async (runDirectory, stageId) => passedStageReport({
          stageId,
          runId: runIdForDirectory(runDirectory),
          fingerprint: hash(`${stageId}-report`),
        }),
        runCompile: async () => ({timelinePath: 'compiled-timeline.json', timeline: compiledTimeline()}),
        hashRunArtifact: fakeArtifact,
      }),
      createDraftStage({
        readStageReport: async (runDirectory) => passedStageReport({
          stageId: 'compile',
          runId: runIdForDirectory(runDirectory),
          fingerprint: hash('compile-report'),
        }),
        readCompiledTimeline: async () => compiledTimeline(),
        runDraft: async () => draftResult,
      }),
      createReviewStage({
        readDraftReport: async () => draftReport(),
        readReview: async () => approvedReview({runId: 'target-run'}),
      }),
      createReleaseStage({
        readDraftReport: async () => draftReport(),
        readCompiledTimeline: async () => compiledTimeline(),
        readReview: async () => releaseReview,
        readStageReport: releaseStageReportReader({
          compileFingerprint: () => releaseCompileFingerprint,
          runId: 'target-run',
        }),
        runRelease: runReleaseAdapter,
      }),
    ];

    const expected = new Map<string, string[]>([
      ['preflight', []],
      ['ingest', ['asset-manifest.json', 'assets/clip/render.mp4']],
      ['narration', [
        `audio/cache/${narrationInputHash.slice('sha256:'.length)}.wav`,
        narrationSegmentPath,
        narrationPath,
        'narration-manifest.json',
        'captions.json',
        'captions.srt',
      ]],
      ['compile', ['compiled-timeline.json']],
      ['draft', [
        'draft/muted-video.mp4',
        'draft/draft.mp4',
        'draft/contact-sheet.jpg',
        ...draftFrameArtifacts().map((frame) => frame.path),
        'audio/filter-graph.txt',
        'audio/mixed-normalized.wav',
        'draft/draft-report.json',
      ]],
      ['review', []],
      ['release', [
        'release/muted-video.mp4',
        'release/final-intermediate.mp4',
        'releases/target-run/final.mp4',
        'releases/target-run/subtitles.srt',
        'releases/target-run/thumbnail.jpg',
        'releases/target-run/review.json',
        'releases/target-run/validation-report.json',
        'releases/target-run/checksums.sha256',
      ]],
    ]);

    for (const stage of stages) {
      const result = await stage.execute(context, new AbortController().signal);
      expect(result.artifacts.map((artifact) => artifact.path)).toEqual(expected.get(stage.id));
      expect(result.artifacts.every((artifact) => (
        stage.id === 'release'
          ? artifact.scope === 'run' || artifact.scope === 'output'
          : artifact.scope === 'run'
      ))).toBe(true);
      if (stage.id === 'release') {
        expect(result.outputCurrent).toEqual(releaseResult.current);
      }
    }
    expect(runReleaseAdapter).toHaveBeenCalledWith(
      expect.objectContaining({runId: 'target-run'}),
      expect.objectContaining({publishCurrent: false}),
    );
  });

  it('pre-registers the deterministic Ingest manifest temp path through failure', async () => {
    const ingestFailure = new Error('ingest manifest write failed');
    const ingestRun = vi.fn(async (input) => {
      expect(input.manifestTempPath).toBe('.asset-manifest.pipeline.tmp');
      throw ingestFailure;
    });
    const ingest = createIngestStage({runIngest: ingestRun});
    const context = executionContext();
    expect(ingest.partialArtifacts(context)).toContainEqual({
      scope: 'run',
      path: '.asset-manifest.pipeline.tmp',
    });
    await expect(ingest.execute(context, new AbortController().signal))
      .rejects.toBe(ingestFailure);
    expect(ingest.partialArtifacts(context)).toContainEqual({
      scope: 'run',
      path: '.asset-manifest.pipeline.tmp',
    });
  });

  it('passes persisted FFmpeg and FFprobe paths into Ingest execution', async () => {
    const runIngest = vi.fn(async () => ({
      manifestPath: 'asset-manifest.json' as const,
      manifest: {
        version: 1 as const,
        assets: {
          cover: {
            kind: 'image' as const,
            sourcePath: 'assets/source/cover.png',
            sourceHash: sourceCatalog().assets[0]!.sha256,
            renderPath: 'assets/source/cover.png',
            renderScope: 'project' as const,
            compatibility: 'direct' as const,
            width: 1920,
            height: 1080,
          },
        },
      },
    }));
    const preflight = preflightResult({
      toolIdentities: {
        ffmpeg: {realPath: '/persisted/ffmpeg', sha256: hash('ffmpeg')},
        ffprobe: {realPath: '/persisted/ffprobe', sha256: hash('ffprobe')},
        qtFaststart: {realPath: '/persisted/qt-faststart', sha256: hash('qt-faststart')},
      },
    });
    const stage = createIngestStage({runIngest, hashRunArtifact: fakeArtifact});

    await stage.execute(executionContext({preflight}), new AbortController().signal);

    expect(runIngest).toHaveBeenCalledWith(expect.objectContaining({
      ffmpegExecutable: '/persisted/ffmpeg',
      ffprobeExecutable: '/persisted/ffprobe',
    }));
  });

  it.each(['ffmpeg', 'ffprobe'] as const)(
    'does not execute Ingest without a persisted %s identity',
    async (tool) => {
      const preflight = preflightResult();
      preflight.toolIdentities[tool] = null;
      const runIngest = vi.fn();
      const stage = createIngestStage({runIngest});

      await expect(stage.execute(
        executionContext({preflight}),
        new AbortController().signal,
      )).rejects.toBeDefined();
      expect(runIngest).not.toHaveBeenCalled();
    },
  );

  it('passes persisted FFmpeg and FFprobe paths into Draft execution', async () => {
    const result: DraftStageResult = {
      reportPath: 'draft/draft-report.json',
      outputs: {
        mutedVideo: {path: 'draft/muted-video.mp4', sha256: hash('muted')},
        draftVideo: {path: 'draft/draft.mp4', sha256: hash('draft')},
        contactSheet: {path: 'draft/contact-sheet.jpg', sha256: hash('contact')},
        reviewFrames: draftFrameArtifacts(),
        audio: {
          filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('graph')},
          mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed')},
        },
        report: {path: 'draft/draft-report.json', sha256: hash('report')},
        audioMixFingerprint: hash('audio-mix'),
      },
    };
    const runDraft = vi.fn(async (_input: DraftStageInput) => result);
    const preflight = preflightResult({
      toolIdentities: {
        ffmpeg: {realPath: '/persisted/ffmpeg', sha256: hash('ffmpeg')},
        ffprobe: {realPath: '/persisted/ffprobe', sha256: hash('ffprobe')},
        qtFaststart: {realPath: '/persisted/qt-faststart', sha256: hash('qt-faststart')},
      },
    });
    const stage = createDraftStage({
      readStageReport: async (runDirectory) => passedStageReport({
        stageId: 'compile',
        runId: runIdForDirectory(runDirectory),
        fingerprint: hash('compile-report'),
      }),
      readCompiledTimeline: async () => compiledTimeline(),
      runDraft,
    });

    await stage.execute(executionContext({preflight}), new AbortController().signal);

    expect(runDraft).toHaveBeenCalledWith(expect.objectContaining({
      ffmpegExecutable: '/persisted/ffmpeg',
      ffprobeExecutable: '/persisted/ffprobe',
    }));
  });

  it.each(['ffmpeg', 'ffprobe'] as const)(
    'does not execute Draft without a persisted %s identity',
    async (tool) => {
      const preflight = preflightResult();
      preflight.toolIdentities[tool] = null;
      const runDraft = vi.fn();
      const stage = createDraftStage({
        readStageReport: async (runDirectory) => passedStageReport({
          stageId: 'compile',
          runId: runIdForDirectory(runDirectory),
          fingerprint: hash('compile-report'),
        }),
        runDraft,
      });

      await expect(stage.execute(
        executionContext({preflight}),
        new AbortController().signal,
      )).rejects.toBeDefined();
      expect(runDraft).not.toHaveBeenCalled();
    },
  );

  it('retains predictable and dynamic Narration partials through failure', async () => {
    const context = executionContext();
    const providerFingerprint = hash('partial-provider');
    const narrationFailure = new Error('narration report write failed');
    const narration = createNarrationStage({
      fingerprintTtsProvider: async () => providerFingerprint,
      createTtsProvider: () => ({
        id: 'mock',
        capabilities: async () => ({languages: ['zh-CN'], voices: ['fixture']}),
        fingerprint: async () => hash('untrusted-provider'),
        synthesize: async () => ({
          outputPath: 'unused',
          providerFingerprint: hash('untrusted-provider'),
        }),
      }),
      runNarration: async (input) => {
        input.onPartialArtifact?.('audio/narration-dynamic-master.wav');
        throw narrationFailure;
      },
    });
    await expect(narration.execute(context, new AbortController().signal))
      .rejects.toBe(narrationFailure);
    const narrationInputHash = narrationSegmentInputHash(
      project.script.segments[0]!,
      project.project.tts.voice,
      project.project.tts.rate,
      providerFingerprint,
    );
    expect(narration.partialArtifacts(context)).toEqual(expect.arrayContaining([
      {
        scope: 'run',
        path: `audio/cache/${narrationInputHash.slice('sha256:'.length)}.wav`,
      },
      {
        scope: 'run',
        path: `audio/segments/0001-intro-${narrationInputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`,
      },
      {scope: 'run', path: 'audio/narration-dynamic-master.wav'},
      {scope: 'run', path: 'narration-manifest.json'},
      {scope: 'run', path: 'captions.json'},
      {scope: 'run', path: 'captions.srt'},
    ]));
  });

  it('retains Draft baseline, dynamic, and final partials after success', async () => {
    const context = executionContext();
    const draftFailure = new Error('draft report write failed');
    let failDraft = true;
    const successfulDraft: DraftStageResult = {
      reportPath: 'draft/draft-report.json',
      outputs: {
        mutedVideo: {path: 'draft/muted-video.mp4', sha256: hash('muted')},
        draftVideo: {path: 'draft/draft.mp4', sha256: hash('draft')},
        contactSheet: {path: 'draft/contact-sheet.jpg', sha256: hash('contact')},
        reviewFrames: draftFrameArtifacts(),
        audio: {
          filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('graph')},
          mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed')},
        },
        report: {path: 'draft/draft-report.json', sha256: hash('draft-report')},
        audioMixFingerprint: hash('audio-mix'),
      },
    };
    const draft = createDraftStage({
      readStageReport: async (runDirectory) => passedStageReport({
        stageId: 'compile',
        runId: runIdForDirectory(runDirectory),
        fingerprint: hash('compile-report'),
      }),
      readCompiledTimeline: async () => compiledTimeline(),
      runDraft: async () => {
        if (failDraft) throw draftFailure;
        return successfulDraft;
      },
    });
    await expect(draft.execute(context, new AbortController().signal))
      .rejects.toBe(draftFailure);
    const partialsAfterFailure = draft.partialArtifacts(context);
    expect(partialsAfterFailure).toContainEqual({scope: 'run', path: 'audio/mixed-raw.wav'});
    expect(partialsAfterFailure.some((artifact) => artifact.path.startsWith('draft/frames/')))
      .toBe(true);
    failDraft = false;
    await draft.execute(context, new AbortController().signal);
    expect(draft.partialArtifacts(context)).toEqual(expect.arrayContaining([
      ...partialsAfterFailure,
      {scope: 'run', path: draftFrameArtifacts()[0]!.path},
    ]));
  });
});

describe('adapter verification', () => {
  const compileVerificationFixture = async () => {
    const assetManifest = {
      version: 1 as const,
      assets: {
        cover: {
          kind: 'image' as const,
          sourcePath: 'assets/source/cover.png',
          sourceHash: hash('cover'),
          renderPath: 'assets/source/cover.png',
          renderScope: 'project' as const,
          compatibility: 'direct' as const,
          width: 1920,
          height: 1080,
        },
      },
    };
    const narrationManifest = {
      version: 1 as const,
      provider: 'mock' as const,
      segments: [{
        id: 'intro',
        inputHash: hash('narration-input'),
        audioPath: 'audio/segments/intro.wav',
        audioHash: hash('intro-audio'),
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        pauseAfterMs: 300,
        sampleRate: 48_000 as const,
        channels: 1 as const,
        providerFingerprint: hash('provider'),
      }],
      master: {
        audioPath: 'audio/narration.wav',
        audioHash: hash('narration-master'),
        durationMs: 1000,
      },
    };
    const captionsManifest = {
      version: 1 as const,
      sourceNarrationHash: narrationManifest.master.audioHash,
      cues: [{
        id: 'caption-intro',
        segmentId: 'intro',
        text: project.script.segments[0]!.text,
        startMs: 0,
        endMs: 1000,
      }],
    };
    await Promise.all([
      replaceRunText('source-run', 'asset-manifest.json', `${JSON.stringify(assetManifest)}\n`),
      replaceRunText('source-run', 'narration-manifest.json', `${JSON.stringify(narrationManifest)}\n`),
      replaceRunText('source-run', 'captions.json', `${JSON.stringify(captionsManifest)}\n`),
      rm(runFilePath('source-run', 'compiled-timeline.json'), {force: true}),
    ]);
    const result = await runConcreteCompile({...project, runDirectory: sourceRun});
    const timelineArtifact = await hashRunArtifact(sourceRun, result.timelinePath);
    const stage = createCompileStage({readStageReport: successfulStageReportReader});
    const context = planningContext();
    const fingerprint = await stage.fingerprint(context);
    const report = passedStageReport({
      stageId: 'compile',
      runId: 'source-run',
      fingerprint,
      artifacts: [timelineArtifact],
      outputs: JSON.parse(JSON.stringify(result)),
    });
    return {stage, context, report, result};
  };

  const draftVerificationFixture = async () => {
    const timeline = compiledTimeline();
    const framePaths = selectReviewFrames(timeline).map((frame) =>
      `draft/frames/frame-${String(frame).padStart(6, '0')}.jpg`);
    await Promise.all([
      replaceRunText('source-run', 'compiled-timeline.json', `${JSON.stringify(timeline)}\n`),
      replaceRunText('source-run', 'draft/muted-video.mp4', 'muted-video'),
      replaceRunText('source-run', 'audio/filter-graph.txt', 'filter-graph'),
      replaceRunText('source-run', 'audio/mixed-normalized.wav', 'mixed-audio'),
      ...framePaths.map(async (framePath) => await replaceRunText(
        'source-run',
        framePath,
        framePath,
      )),
    ]);
    const references = new Map(await Promise.all([
      'draft/muted-video.mp4',
      'draft/draft.mp4',
      'draft/contact-sheet.jpg',
      ...framePaths,
      'audio/filter-graph.txt',
      'audio/mixed-normalized.wav',
    ].map(async (relativePath) => {
      const artifact = await hashRunArtifact(sourceRun, relativePath);
      return [relativePath, {path: artifact.path, sha256: artifact.sha256}] as const;
    })));
    const persistedDraft = {
      version: 1 as const,
      projectId: 'demo',
      outputs: {
        mutedVideo: references.get('draft/muted-video.mp4')!,
        draftVideo: references.get('draft/draft.mp4')!,
        contactSheet: references.get('draft/contact-sheet.jpg')!,
        reviewFrames: framePaths.map((framePath) => references.get(framePath)!),
        audio: {
          filterGraph: references.get('audio/filter-graph.txt')!,
          mixedAudio: references.get('audio/mixed-normalized.wav')!,
        },
        audioMixFingerprint: hash('audio-mix'),
      },
    };
    await replaceRunText(
      'source-run',
      'draft/draft-report.json',
      `${JSON.stringify(persistedDraft)}\n`,
    );
    const draftReportArtifact = await hashRunArtifact(sourceRun, 'draft/draft-report.json');
    const outputs = {
      reportPath: 'draft/draft-report.json' as const,
      outputs: {
        ...persistedDraft.outputs,
        report: {
          path: draftReportArtifact.path,
          sha256: draftReportArtifact.sha256,
        },
      },
    };
    const stage = createDraftStage({readStageReport: successfulStageReportReader});
    const context = planningContext();
    const fingerprint = await stage.fingerprint(context);
    const report = passedStageReport({
      stageId: 'draft',
      runId: 'source-run',
      fingerprint,
      artifacts: [
        ...references.values(),
        outputs.outputs.report,
      ].map((artifact) => ({scope: 'run' as const, ...artifact})),
      outputs: JSON.parse(JSON.stringify(outputs)),
    });
    return {stage, context, report, persistedDraft, outputs};
  };

  const narrationVerificationFixture = async () => {
    const providerFingerprint = hash('provider');
    const segmentInputHash = narrationSegmentInputHash(
      project.script.segments[0]!,
      project.project.tts.voice,
      project.project.tts.rate,
      providerFingerprint,
    );
    const segmentPath = `audio/segments/0001-intro-${segmentInputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`;
    const narration = {
      version: 1 as const,
      provider: 'mock' as const,
      segments: [{
        id: 'intro',
        inputHash: segmentInputHash,
        audioPath: segmentPath,
        audioHash: contentHash('segment'),
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        pauseAfterMs: project.script.segments[0]!.pauseAfterMs,
        sampleRate: 48_000 as const,
        channels: 1 as const,
        providerFingerprint,
      }],
      master: {
        audioPath: '',
        audioHash: contentHash('master'),
        durationMs: 1300,
      },
    };
    narration.master.audioPath = narrationMasterPath({
      provider: narration.provider,
      segments: narration.segments,
    });
    const captions = {
      version: 1 as const,
      sourceNarrationHash: narration.master.audioHash,
      cues: [{
        id: 'caption-intro',
        segmentId: 'intro',
        text: project.script.segments[0]!.text,
        startMs: 0,
        endMs: 1000,
      }],
    };
    const reuseCompatibility = {
      tts: project.project.tts,
      providerFingerprint,
      ffmpegIdentity: preflightResult().toolIdentities.ffmpeg!,
      ffprobeIdentity: preflightResult().toolIdentities.ffprobe!,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    };
    const cachePath = `audio/cache/${segmentInputHash.slice('sha256:'.length)}.wav`;
    await Promise.all([
      replaceRunText('source-run', cachePath, 'cache'),
      replaceRunText('source-run', segmentPath, 'segment'),
      replaceRunText('source-run', narration.master.audioPath, 'master'),
      replaceRunText('source-run', 'narration-manifest.json', `${JSON.stringify(narration)}\n`),
      replaceRunText('source-run', 'captions.json', `${JSON.stringify(captions)}\n`),
      replaceRunText('source-run', 'captions.srt', formatSrt(captions)),
    ]);
    const artifacts = await Promise.all([
      cachePath,
      segmentPath,
      narration.master.audioPath,
      'narration-manifest.json',
      'captions.json',
      'captions.srt',
    ].map(async (relativePath) => await hashRunArtifact(sourceRun, relativePath)));
    const stage = createNarrationStage({
      fingerprintTtsProvider: async () => providerFingerprint,
    });
    const context = planningContext();
    const outputs = {
      narrationPath: 'narration-manifest.json' as const,
      captionsPath: 'captions.json' as const,
      srtPath: 'captions.srt' as const,
      narration,
      captions,
      reuseCompatibility,
      reuseCompatibilityFingerprint: narrationReuseCompatibilityFingerprint(
        reuseCompatibility,
      ),
    };
    const report = passedStageReport({
      stageId: 'narration',
      runId: 'source-run',
      fingerprint: await stage.fingerprint(context),
      artifacts,
      outputs: JSON.parse(JSON.stringify(outputs)),
    });
    return {stage, context, report, narration, captions};
  };

  it('binds Compile verification to persisted inputs and current authoring semantics', async () => {
    const {stage, context, report} = await compileVerificationFixture();

    await expect(stage.verify(context, report)).resolves.toBe(true);
    const changedProject = structuredClone(context.project.project);
    changedProject.composition.width = 1280 as 1920;
    await expect(stage.verify({
      ...context,
      project: {...context.project, project: changedProject},
    }, report)).resolves.toBe(false);
  });

  it('rejects foreign or report-mismatched persisted Compile timelines', async () => {
    const foreign = await compileVerificationFixture();
    const foreignTimeline = {...foreign.result.timeline, projectId: 'other-project'};
    await writeFile(
      runFilePath('source-run', 'compiled-timeline.json'),
      `${JSON.stringify(foreignTimeline)}\n`,
    );
    const foreignArtifact = await hashRunArtifact(sourceRun, 'compiled-timeline.json');
    await expect(foreign.stage.verify(foreign.context, {
      ...foreign.report,
      artifacts: [foreignArtifact],
      outputs: JSON.parse(JSON.stringify({
        timelinePath: 'compiled-timeline.json',
        timeline: foreignTimeline,
      })),
    })).resolves.toBe(false);

    const mismatched = await compileVerificationFixture();
    await expect(mismatched.stage.verify(mismatched.context, {
      ...mismatched.report,
      outputs: JSON.parse(JSON.stringify({
        timelinePath: 'compiled-timeline.json',
        timeline: {...mismatched.result.timeline, width: 1280},
      })),
    })).resolves.toBe(false);
  });

  it('maps invalid Compile prerequisites and malformed persisted inputs to false', async () => {
    const fixture = await compileVerificationFixture();
    const invalidPrerequisite = createCompileStage({
      readStageReport: async (runDirectory, stageId) => stageId === 'ingest'
        ? {
          ...await successfulStageReportReader(runDirectory, stageId),
          state: 'failed',
          error: {code: 'FAILED', message: 'failed'},
        }
        : await successfulStageReportReader(runDirectory, stageId),
    });
    await expect(invalidPrerequisite.verify(fixture.context, fixture.report))
      .resolves.toBe(false);

    await writeFile(runFilePath('source-run', 'captions.json'), '{malformed');
    await expect(fixture.stage.verify(fixture.context, fixture.report)).resolves.toBe(false);

    const prerequisiteFixture = await compileVerificationFixture();
    for (const failure of [null, new SyntaxError('malformed prerequisite report')]) {
      const stage = createCompileStage({
        readStageReport: async (runDirectory, stageId) => {
          if (stageId !== 'ingest') {
            return await successfulStageReportReader(runDirectory, stageId);
          }
          if (failure === null) return null;
          throw failure;
        },
      });
      await expect(stage.verify(prerequisiteFixture.context, prerequisiteFixture.report))
        .resolves.toBe(false);
    }
  });

  it('propagates Compile verification I/O and scoped authority failures', async () => {
    const ioFixture = await compileVerificationFixture();
    const ioFailure = Object.assign(new Error('authoring read failed'), {code: 'EIO'});
    const ioStage = createCompileStage({
      readStageReport: successfulStageReportReader,
      hashProjectFile: async () => { throw ioFailure; },
    });
    await expect(ioStage.verify(ioFixture.context, ioFixture.report)).rejects.toBe(ioFailure);

    const authorityFixture = await compileVerificationFixture();
    await rename(
      runFilePath('source-run', ''),
      path.join(tempProject.workspaceRoot, 'moved-source-run'),
    );
    await expect(authorityFixture.stage.verify(
      authorityFixture.context,
      authorityFixture.report,
    )).rejects.toMatchObject({code: 'APP_SCOPE_AUTHORITY_CHANGED'});
  });

  it('requires Ingest report outputs to match persisted asset-manifest.json', async () => {
    const persistedManifest = {
      version: 1 as const,
      assets: {
        cover: {
          kind: 'image' as const,
          sourcePath: 'assets/source/cover.png',
          sourceHash: hash('source'),
          renderPath: 'assets/source/cover.png',
          renderScope: 'project' as const,
          compatibility: 'direct' as const,
          width: 1920,
          height: 1080,
        },
      },
    };
    await writeRunText(
      sourceRun,
      'asset-manifest.json',
      `${JSON.stringify(persistedManifest)}\n`,
    );
    const artifact = await hashRunArtifact(sourceRun, 'asset-manifest.json');
    const reportManifest = structuredClone(persistedManifest);
    reportManifest.assets.cover.width = 1280;
    const report = passedStageReport({
      stageId: 'ingest',
      runId: 'source-run',
      artifacts: [artifact],
      outputs: {manifestPath: 'asset-manifest.json', manifest: reportManifest},
    });

    await expect(createIngestStage().verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('requires Narration report outputs and SRT to match persisted JSON', async () => {
    const manifestMismatch = await narrationVerificationFixture();
    await expect(manifestMismatch.stage.verify(
      manifestMismatch.context,
      manifestMismatch.report,
    )).resolves.toBe(true);
    await writeFile(
      runFilePath('source-run', 'narration-manifest.json'),
      `${JSON.stringify({
        ...manifestMismatch.narration,
        master: {...manifestMismatch.narration.master, durationMs: 1301},
      })}\n`,
    );
    const narrationArtifact = await hashRunArtifact(sourceRun, 'narration-manifest.json');
    await expect(manifestMismatch.stage.verify(manifestMismatch.context, {
      ...manifestMismatch.report,
      artifacts: manifestMismatch.report.artifacts.map((artifact) => (
        artifact.path === narrationArtifact.path ? narrationArtifact : artifact
      )),
    })).resolves.toBe(false);

    const srtMismatch = await narrationVerificationFixture();
    await writeFile(runFilePath('source-run', 'captions.srt'), 'tampered subtitles\n');
    const srtArtifact = await hashRunArtifact(sourceRun, 'captions.srt');
    await expect(srtMismatch.stage.verify(srtMismatch.context, {
      ...srtMismatch.report,
      artifacts: srtMismatch.report.artifacts.map((artifact) => (
        artifact.path === srtArtifact.path ? srtArtifact : artifact
      )),
    })).resolves.toBe(false);
  });

  it('requires Draft outputs to match the persisted current-project report', async () => {
    const mismatch = await draftVerificationFixture();
    await expect(mismatch.stage.verify(mismatch.context, mismatch.report)).resolves.toBe(true);
    await expect(mismatch.stage.verify(mismatch.context, {
      ...mismatch.report,
      outputs: {
        ...mismatch.outputs,
        outputs: {
          ...mismatch.outputs.outputs,
          audioMixFingerprint: hash('different-audio-mix'),
        },
      },
    })).resolves.toBe(false);

    const foreign = await draftVerificationFixture();
    await writeFile(
      runFilePath('source-run', 'draft/draft-report.json'),
      `${JSON.stringify({...foreign.persistedDraft, projectId: 'other-project'})}\n`,
    );
    const reportArtifact = await hashRunArtifact(sourceRun, 'draft/draft-report.json');
    await expect(foreign.stage.verify(foreign.context, {
      ...foreign.report,
      artifacts: foreign.report.artifacts.map((artifact) => (
        artifact.path === reportArtifact.path ? reportArtifact : artifact
      )),
      outputs: {
        ...foreign.outputs,
        outputs: {
          ...foreign.outputs.outputs,
          report: {path: reportArtifact.path, sha256: reportArtifact.sha256},
        },
      },
    })).resolves.toBe(false);
  });

  it('maps invalid Draft prerequisites and malformed persisted reports to false', async () => {
    const invalidPrerequisite = await draftVerificationFixture();
    const stage = createDraftStage({
      readStageReport: async (runDirectory) => ({
        ...await successfulStageReportReader(runDirectory, 'compile'),
        state: 'cancelled',
        error: {code: 'CANCELLED', message: 'cancelled'},
      }),
    });
    await expect(stage.verify(invalidPrerequisite.context, invalidPrerequisite.report))
      .resolves.toBe(false);

    const malformed = await draftVerificationFixture();
    await writeFile(runFilePath('source-run', 'draft/draft-report.json'), '{malformed');
    const reportArtifact = await hashRunArtifact(sourceRun, 'draft/draft-report.json');
    await expect(malformed.stage.verify(malformed.context, {
      ...malformed.report,
      artifacts: malformed.report.artifacts.map((artifact) => (
        artifact.path === reportArtifact.path ? reportArtifact : artifact
      )),
      outputs: {
        ...malformed.outputs,
        outputs: {
          ...malformed.outputs.outputs,
          report: {path: reportArtifact.path, sha256: reportArtifact.sha256},
        },
      },
    })).resolves.toBe(false);

    const prerequisiteFixture = await draftVerificationFixture();
    for (const failure of [null, new SyntaxError('malformed Compile report')]) {
      const stage = createDraftStage({
        readStageReport: async () => {
          if (failure === null) return null;
          throw failure;
        },
      });
      await expect(stage.verify(prerequisiteFixture.context, prerequisiteFixture.report))
        .resolves.toBe(false);
    }
  });

  const releaseVerificationFixture = async (
    mutateVerification?: (verification: ReleaseVerificationReport) => void,
  ) => {
    const draft = draftReport();
    const timeline = compiledTimeline();
    const reviewInput = approvedReview();
    const persistedPreflight = preflightResult();
    const compileFingerprint = hash('compile-report');
    const stageFingerprint = releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      compileStageFingerprint: compileFingerprint,
      compiledTimeline: timeline,
      review: reviewInput,
      preflightEnvironmentFingerprint: persistedPreflight.environmentFingerprint,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    });
    const dependencies = {
      readDraftReport: async () => draft,
      readCompiledTimeline: async () => timeline,
      readReview: async () => reviewInput,
      readStageReport: releaseStageReportReader({
        preflight: () => persistedPreflight,
        compileFingerprint: () => compileFingerprint,
      }),
    };
    await writeRunText(sourceRun, 'release/muted-video.mp4', 'muted-video');
    await writeRunText(sourceRun, 'release/final-intermediate.mp4', 'intermediate');
    const mutedVideo = await hashRunArtifact(sourceRun, 'release/muted-video.mp4');
    const intermediate = await hashRunArtifact(sourceRun, 'release/final-intermediate.mp4');
    const outputDirectory = await createOutputStore(tempProject.workspaceRoot)
      .createRelease('demo', 'source-run');
    const finalVideo = await writeOutputText(
      outputDirectory,
      'releases/source-run/final.mp4',
      'final-video',
    );
    const subtitles = await writeOutputText(
      outputDirectory,
      'releases/source-run/subtitles.srt',
      releaseSrtFromTimeline(timeline),
    );
    const thumbnail = await writeOutputText(
      outputDirectory,
      'releases/source-run/thumbnail.jpg',
      'thumbnail',
    );
    const review = await writeOutputText(
      outputDirectory,
      'releases/source-run/review.json',
      `${JSON.stringify(reviewInput, null, 2)}\n`,
    );
    const verification = fixedReleaseVerification(finalVideo.sha256);
    mutateVerification?.(verification);
    const validationMetadata = buildReleaseValidationReport({
      projectId: 'demo',
      runId: 'source-run',
      releaseFingerprint: stageFingerprint,
      preflight: {
        toolIdentities: persistedPreflight.toolIdentities,
        environmentFingerprint: persistedPreflight.environmentFingerprint,
      },
      draftAudio: draft.outputs.audio,
      intermediate: {path: intermediate.path, sha256: intermediate.sha256},
      finalVideo,
      subtitles,
      thumbnail,
      review,
      verification,
    });
    const validationReport = await writeOutputText(
      outputDirectory,
      'releases/source-run/validation-report.json',
      `${JSON.stringify(validationMetadata, null, 2)}\n`,
    );
    const checksums = await writeOutputText(
      outputDirectory,
      'releases/source-run/checksums.sha256',
      formatReleaseChecksums(releaseChecksumArtifacts({
        finalVideo,
        subtitles,
        thumbnail,
        review,
        validationReport,
      })),
    );
    const outputs = {
      mutedVideo: {path: mutedVideo.path, sha256: mutedVideo.sha256},
      intermediate: {path: intermediate.path, sha256: intermediate.sha256},
      finalVideo,
      subtitles,
      thumbnail,
      review,
      validationReport,
      checksums,
      releaseFingerprint: stageFingerprint,
      verification,
    };
    const report = passedStageReport({
      stageId: 'release',
      runId: 'source-run',
      fingerprint: stageFingerprint,
      outputs,
      artifacts: [
        mutedVideo,
        intermediate,
        {scope: 'output', ...finalVideo},
        {scope: 'output', ...subtitles},
        {scope: 'output', ...thumbnail},
        {scope: 'output', ...review},
        {scope: 'output', ...validationReport},
        {scope: 'output', ...checksums},
      ],
    });
    return {
      report,
      outputs,
      finalVideo,
      dependencies,
      validationMetadata,
      reviewInput,
      timeline,
    };
  };

  it.each([
    ['review.json', 'review', async ({reviewInput}: Awaited<ReturnType<typeof releaseVerificationFixture>>) => (
      `${JSON.stringify({...reviewInput, reviewer: 'tampered-reviewer'}, null, 2)}\n`
    )],
    ['subtitles.srt', 'subtitles', async () => 'tampered subtitles\n'],
    [
      'validation-report.json',
      'validationReport',
      async ({validationMetadata}: Awaited<ReturnType<typeof releaseVerificationFixture>>) => (
        `${JSON.stringify({
          ...validationMetadata,
          verification: {
            ...validationMetadata.verification,
            durationMs: validationMetadata.verification.durationMs + 1,
          },
        }, null, 2)}\n`
      ),
    ],
    ['checksums.sha256', 'checksums', async () => '0'.repeat(64) + '  releases/source-run/final.mp4\n'],
  ] as const)(
    'returns false when Release %s content is semantically inconsistent despite matching its reported hash',
    async (_fileName, outputKey, tamperedContents) => {
      const fixture = await releaseVerificationFixture();
      const reference = fixture.outputs[outputKey];
      const contents = await tamperedContents(fixture);
      await writeFile(
        path.join(tempProject.workspaceRoot, 'output', 'demo', reference.path),
        contents,
        'utf8',
      );
      const changedReference = {...reference, sha256: contentHash(contents)};
      const changedOutputs = {...fixture.outputs, [outputKey]: changedReference};
      const changedReport = {
        ...fixture.report,
        outputs: changedOutputs,
        artifacts: fixture.report.artifacts.map((artifact) => (
          artifact.path === changedReference.path
            ? {...artifact, sha256: changedReference.sha256}
            : artifact
        )),
      };

      await expect(createReleaseStage(fixture.dependencies).verify(
        planningContext(),
        changedReport,
      )).resolves.toBe(false);
    },
  );

  it('returns false for malformed Release verification stream metadata', async () => {
    const fixture = await releaseVerificationFixture();
    const invalidOutputs = JSON.parse(JSON.stringify(fixture.outputs));
    invalidOutputs.verification.probe.videoStreams = [{codec: 'h264'}];

    await expect(createReleaseStage(fixture.dependencies).verify(
      planningContext(),
      {...fixture.report, outputs: invalidOutputs},
    )).resolves.toBe(false);
  });

  it.each(semanticReleaseVerificationFailures)(
    'returns false for semantically invalid persisted Release verification with %s',
    async (_label, mutateVerification) => {
      const fixture = await releaseVerificationFixture(mutateVerification);

      await expect(createReleaseStage(fixture.dependencies).verify(
        planningContext(),
        fixture.report,
      )).resolves.toBe(false);
    },
  );

  it('returns false for missing, changed, and cross-scope Run artifacts', async () => {
    const {stage, context, report} = await compileVerificationFixture();
    const [artifact] = report.artifacts;
    await expect(stage.verify(context, report)).resolves.toBe(true);
    await expect(stage.verify(context, {
      ...report,
      artifacts: [{...artifact!, path: 'missing.json'}],
    })).resolves.toBe(false);
    await expect(stage.verify(context, {
      ...report,
      artifacts: [{...artifact!, sha256: hash('changed')}],
    })).resolves.toBe(false);
    await expect(stage.verify(context, {
      ...report,
      artifacts: [{...artifact!, scope: 'output'}],
    })).resolves.toBe(false);
  });

  it('returns false when a Run artifact becomes a cross-scope symlink', async () => {
    const {stage, context, report} = await compileVerificationFixture();
    const artifactPath = runFilePath('source-run', 'compiled-timeline.json');
    const outsidePath = path.join(tempProject.workspaceRoot, 'outside-timeline.json');
    await writeFile(outsidePath, '{}\n', 'utf8');
    await rm(artifactPath);
    await symlink(outsidePath, artifactPath);

    await expect(stage.verify(context, report)).resolves.toBe(false);
  });

  it('returns false when a Release output artifact becomes a cross-scope symlink', async () => {
    const {report, finalVideo, dependencies} = await releaseVerificationFixture();
    const finalVideoPath = path.join(
      tempProject.workspaceRoot,
      'output',
      'demo',
      finalVideo.path,
    );
    const outsidePath = path.join(tempProject.workspaceRoot, 'outside-final.mp4');
    await writeFile(outsidePath, 'outside-final', 'utf8');
    await rm(finalVideoPath);
    await symlink(outsidePath, finalVideoPath);

    await expect(createReleaseStage(dependencies).verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('returns false when the Release output project root becomes cross-scope', async () => {
    const {report, dependencies} = await releaseVerificationFixture();
    const outputRoot = path.join(tempProject.workspaceRoot, 'output', 'demo');
    const movedOutputRoot = path.join(tempProject.workspaceRoot, 'escaped-output-demo');
    await rename(outputRoot, movedOutputRoot);
    await symlink(movedOutputRoot, outputRoot);

    await expect(createReleaseStage(dependencies).verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('does not swallow unrelated Release output I/O errors', async () => {
    const {report, dependencies} = await releaseVerificationFixture();
    const failure = Object.assign(new Error('injected output I/O failure'), {code: 'EIO'});
    const stage = createReleaseStage({
      ...dependencies,
      openOutputDirectory: async () => { throw failure; },
    });

    await expect(stage.verify(planningContext(), report)).rejects.toBe(failure);
  });

  it('returns false rather than throwing for cross-scope Release artifacts', async () => {
    const output = await createOutputStore(tempProject.workspaceRoot)
      .createRelease('demo', 'source-run');
    await ensureOutputDirectory(output, 'releases/source-run');
    const handle = await openNewOutputFile(output, 'releases/source-run/final.mp4');
    try {
      await handle.writeFile('final');
      await handle.sync();
    } finally {
      await handle.close();
    }
    const finalVideo: PipelineArtifact = {
      scope: 'output',
      path: 'releases/source-run/final.mp4',
      sha256: hash('final'),
    };
    const outputs = {
      mutedVideo: {path: 'release/muted-video.mp4', sha256: hash('muted')},
      intermediate: {path: 'release/final-intermediate.mp4', sha256: hash('intermediate')},
      finalVideo: {path: finalVideo.path, sha256: finalVideo.sha256},
      subtitles: {path: 'releases/source-run/subtitles.srt', sha256: hash('subtitles')},
      thumbnail: {path: 'releases/source-run/thumbnail.jpg', sha256: hash('thumbnail')},
      review: {path: 'releases/source-run/review.json', sha256: hash('review')},
      validationReport: {path: 'releases/source-run/validation-report.json', sha256: hash('validation')},
      checksums: {path: 'releases/source-run/checksums.sha256', sha256: hash('checksums')},
      releaseFingerprint: hash('release'),
      verification: fixedReleaseVerification(finalVideo.sha256),
    };
    const stage = createReleaseStage({
      openOutputDirectory: async () => output,
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
    });
    const report = passedStageReport({
      stageId: 'release',
      outputs,
      artifacts: [{...finalVideo, scope: 'run'}],
    });
    await expect(stage.verify(planningContext(), report)).resolves.toBe(false);
  });

  it('requires an empty Review inventory and verifies current Draft evidence as provenance', async () => {
    const draftVideo = await hashRunArtifact(sourceRun, 'draft/draft.mp4');
    const contactSheet = await hashRunArtifact(sourceRun, 'draft/contact-sheet.jpg');
    const reviewFrame = await hashRunArtifact(sourceRun, 'draft/frames/frame-000000.jpg');
    const draft = draftReport({
      draftVideo: {path: draftVideo.path, sha256: draftVideo.sha256},
      contactSheet: {path: contactSheet.path, sha256: contactSheet.sha256},
      reviewFrames: [{path: reviewFrame.path, sha256: reviewFrame.sha256}],
    });
    const review = approvedReview();
    const stage = createReviewStage({
      readDraftReport: async () => draft,
      readReview: async () => review,
    });
    const context = planningContext();
    const report = passedStageReport({
      stageId: 'review',
      fingerprint: await stage.fingerprint(context),
      artifacts: [],
      outputs: {
        evidence: draftReviewEvidenceArtifacts(draft),
        review,
      },
    });

    await expect(stage.verify(context, report)).resolves.toBe(true);
    await expect(stage.verify(context, {
      ...report,
      artifacts: [contactSheet],
    })).resolves.toBe(false);
    await expect(stage.verify(context, {
      ...report,
      outputs: {
        evidence: [{...draft.outputs.contactSheet, sha256: hash('changed')}],
        review,
      },
    })).resolves.toBe(false);
  });

  it.each([
    ['Draft JSON', 'draft/draft-report.json', '{not-json\n'],
    ['Review schema', 'review.json', '{}\n'],
  ] as const)('returns false for malformed persisted %s', async (_label, relativePath, contents) => {
    const draft = draftReport();
    if (relativePath !== 'draft/draft-report.json') {
      await writeRunText(
        sourceRun,
        'draft/draft-report.json',
        `${JSON.stringify(draft)}\n`,
      );
    }
    await writeRunText(sourceRun, relativePath, contents);
    const review = approvedReview();
    const report = passedStageReport({
      stageId: 'review',
      fingerprint: hash('review'),
      artifacts: [],
      outputs: {
        evidence: draftReviewEvidenceArtifacts(draft),
        review,
      },
    });

    await expect(createReviewStage().verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it.each(['Draft', 'Review'] as const)(
    'propagates persisted %s EIO failures during Review verification',
    async (input) => {
      const failure = Object.assign(new Error(`${input} I/O failed`), {code: 'EIO'});
      const draft = draftReport();
      const review = approvedReview();
      const stage = createReviewStage({
        readDraftReport: async () => {
          if (input === 'Draft') throw failure;
          return draft;
        },
        readReview: async () => {
          if (input === 'Review') throw failure;
          return review;
        },
      });
      const reportFingerprint = input === 'Review'
        ? await createReviewStage({
          readDraftReport: async () => draft,
        }).fingerprint(planningContext())
        : hash('review');
      const report = passedStageReport({
        stageId: 'review',
        fingerprint: reportFingerprint,
        artifacts: [],
        outputs: {
          evidence: draftReviewEvidenceArtifacts(draft),
          review,
        },
      });

      await expect(stage.verify(planningContext(), report)).rejects.toBe(failure);
    },
  );

  it('does not accept Review approval after Draft evidence changes during execution', async () => {
    const draft = draftReport();
    const review = approvedReview({runId: 'target-run'});
    const stage = createReviewStage({
      readDraftReport: async () => draft,
      readReview: async () => review,
    });
    await writeFile(
      path.join(
        tempProject.workspaceRoot,
        '.work',
        'demo',
        'runs',
        'target-run',
        'draft',
        'draft.mp4',
      ),
      'tampered-draft-video',
    );

    await expect(stage.execute(
      executionContext(),
      new AbortController().signal,
    )).rejects.toBeDefined();
  });

  it('propagates scoped authority changes during Review verification', async () => {
    const failure = new AppDirectoryScopeError(
      'APP_SCOPE_AUTHORITY_CHANGED',
      'Run authority changed while reading Draft evidence',
    );
    const draft = draftReport();
    const review = approvedReview();
    const stage = createReviewStage({
      readDraftReport: async () => { throw failure; },
      readReview: async () => review,
    });
    const report = passedStageReport({
      stageId: 'review',
      fingerprint: hash('review'),
      artifacts: [],
      outputs: {
        evidence: draftReviewEvidenceArtifacts(draft),
        review,
      },
    });

    await expect(stage.verify(planningContext(), report)).rejects.toBe(failure);
  });
});

describe('Narration compatibility-gated cache seeding', () => {
  const executeCase = async ({
    sourceProject,
    currentProject,
    sourcePreflight,
    currentPreflight,
    sourceProviderFingerprint,
    currentProviderFingerprint,
    injectedProviderFingerprint = currentProviderFingerprint,
    tamperSourceCache = false,
    tamperCompatibility = false,
    coordinatedManifestArtifactTamper = false,
    sourceReportState = 'passed',
    readPersistedNarrationFiles,
    beforeExecute,
  }: {
    sourceProject: ProjectInputs;
    currentProject: ProjectInputs;
    sourcePreflight: PreflightResult;
    currentPreflight: PreflightResult;
    sourceProviderFingerprint: string;
    currentProviderFingerprint: string;
    injectedProviderFingerprint?: string;
    tamperSourceCache?: boolean;
    tamperCompatibility?: boolean;
    coordinatedManifestArtifactTamper?: boolean;
    sourceReportState?: StageReport['state'];
    readPersistedNarrationFiles?: () => Promise<never>;
    beforeExecute?: () => Promise<void>;
  }) => {
    const withFfprobe = (value: PreflightResult): PreflightResult => {
      const next = structuredClone(value) as PreflightResult & {
        toolIdentities: PreflightResult['toolIdentities'] & {
          ffprobe: {realPath: string; sha256: string};
        };
      };
      next.toolIdentities.ffprobe ??= {
        realPath: '/tools/ffprobe',
        sha256: hash('ffprobe'),
      };
      return next;
    };
    const normalizedSourcePreflight = withFfprobe(sourcePreflight);
    const normalizedCurrentPreflight = withFfprobe(currentPreflight);
    const seedNarrationCache = vi.fn(async () => [] as string[]);
    const runNarration = vi.fn(async (_input: NarrationStageInput) => {
      const segment = currentProject.script.segments[0]!;
      const inputHash = narrationSegmentInputHash(
        segment,
        currentProject.project.tts.voice,
        currentProject.project.tts.rate,
        currentProviderFingerprint,
      );
      const segments = [{
        id: segment.id,
        inputHash,
        audioPath: `audio/segments/0001-${segment.id}-${inputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`,
        audioHash: hash('current-segment'),
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        pauseAfterMs: segment.pauseAfterMs,
        sampleRate: 48_000 as const,
        channels: 1 as const,
        providerFingerprint: currentProviderFingerprint,
      }];
      return {
        narrationPath: 'narration-manifest.json' as const,
        captionsPath: 'captions.json' as const,
        srtPath: 'captions.srt' as const,
        narration: {
          version: 1 as const,
          provider: currentProject.project.tts.provider,
          segments,
          master: {
            audioPath: narrationMasterPath({
              provider: currentProject.project.tts.provider,
              segments,
            }),
            audioHash: hash('master'),
            durationMs: 1000,
          },
        },
        captions: {
          version: 1 as const,
          sourceNarrationHash: hash('master'),
          cues: [{
            id: `caption-${segment.id}`,
            segmentId: segment.id,
            text: segment.text,
            startMs: 0,
            endMs: 1000,
          }],
        },
      };
    });
    let providerFingerprint = sourceProviderFingerprint;
    const canonicalFingerprint = vi.fn(async () => providerFingerprint);
    const injectedFingerprint = vi.fn(async () => injectedProviderFingerprint);
    const stage = createNarrationStage({
      fingerprintTtsProvider: canonicalFingerprint,
      createTtsProvider: () => ({
        id: currentProject.project.tts.provider,
        capabilities: async () => ({languages: ['zh-CN'], voices: ['fixture']}),
        fingerprint: injectedFingerprint,
        synthesize: async () => ({outputPath: 'unused', providerFingerprint: injectedProviderFingerprint}),
      } satisfies TtsProvider),
      seedNarrationCache,
      runNarration,
      hashRunArtifact: fakeArtifact,
      hashProjectAudioFile: async (_projectDirectory, audioPath) => hash(audioPath),
      ...(readPersistedNarrationFiles === undefined
        ? {}
        : {readPersistedNarrationFiles}),
    });
    const sourceCompatibility = narrationReuseCompatibilityFingerprint({
      tts: sourceProject.project.tts,
      providerFingerprint: sourceProviderFingerprint,
      ffmpegIdentity: normalizedSourcePreflight.toolIdentities.ffmpeg,
      ffprobeIdentity: normalizedSourcePreflight.toolIdentities.ffprobe,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    });
    const compatibility = {
      tts: sourceProject.project.tts,
      providerFingerprint: sourceProviderFingerprint,
      ffmpegIdentity: normalizedSourcePreflight.toolIdentities.ffmpeg,
      ffprobeIdentity: normalizedSourcePreflight.toolIdentities.ffprobe,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    };
    if (tamperCompatibility) {
      compatibility.ffmpegIdentity = {
        realPath: '/tampered/ffmpeg',
        sha256: hash('tampered-ffmpeg'),
      };
    }
    const sourceSegment = sourceProject.script.segments[0]!;
    const sourceInputHash = narrationSegmentInputHash(
      sourceSegment,
      sourceProject.project.tts.voice,
      sourceProject.project.tts.rate,
      sourceProviderFingerprint,
    );
    const sourceCachePath = `audio/cache/${sourceInputHash.slice('sha256:'.length)}.wav`;
    const sourceSegmentPath = `audio/segments/0001-${sourceSegment.id}-${sourceInputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`;
    const sourceSegments = [{
      id: sourceSegment.id,
      inputHash: sourceInputHash,
      audioPath: sourceSegmentPath,
      audioHash: contentHash('source-segment'),
      startMs: 0,
      endMs: 1000,
      durationMs: 1000,
      pauseAfterMs: sourceSegment.pauseAfterMs,
      sampleRate: 48_000 as const,
      channels: 1 as const,
      providerFingerprint: sourceProviderFingerprint,
    }];
    const sourceMasterPath = narrationMasterPath({
      provider: sourceProject.project.tts.provider,
      segments: sourceSegments,
    });
    await writeRunText(sourceRun, sourceCachePath, 'source-cache');
    await writeRunText(sourceRun, sourceSegmentPath, 'source-segment');
    await writeRunText(sourceRun, sourceMasterPath, 'source-master');
    const sourceNarration = {
      version: 1 as const,
      provider: sourceProject.project.tts.provider,
      segments: sourceSegments,
      master: {
        audioPath: sourceMasterPath,
        audioHash: contentHash('source-master'),
        durationMs: 1000,
      },
    };
    const sourceCaptions = {
      version: 1 as const,
      sourceNarrationHash: sourceNarration.master.audioHash,
      cues: [],
    };
    await writeRunText(sourceRun, 'narration-manifest.json', `${JSON.stringify(sourceNarration)}\n`);
    await writeRunText(sourceRun, 'captions.json', `${JSON.stringify(sourceCaptions)}\n`);
    await writeRunText(sourceRun, 'captions.srt', formatSrt(sourceCaptions));
    const sourceArtifacts = await Promise.all([
      sourceCachePath,
      sourceSegmentPath,
      sourceMasterPath,
      'narration-manifest.json',
      'captions.json',
      'captions.srt',
    ].map(async (relativePath) => await hashRunArtifact(sourceRun, relativePath)));
    const sourceFingerprint = await stage.fingerprint({
      project: sourceProject,
      sourceCatalog: sourceCatalog(),
      preflight: normalizedSourcePreflight,
    });
    const sourceNarrationReport = passedStageReport({
      stageId: 'narration',
      runId: 'source-run',
      fingerprint: sourceFingerprint,
      artifacts: sourceArtifacts,
      outputs: JSON.parse(JSON.stringify({
        narrationPath: 'narration-manifest.json',
        captionsPath: 'captions.json',
        srtPath: 'captions.srt',
        narration: sourceNarration,
        captions: sourceCaptions,
        reuseCompatibility: compatibility,
        reuseCompatibilityFingerprint: sourceCompatibility,
      })),
    });
    sourceNarrationReport.state = sourceReportState;
    if (coordinatedManifestArtifactTamper) {
      await replaceRunText('source-run', 'narration-manifest.json', `${JSON.stringify({
        ...sourceNarration,
        master: {
          ...sourceNarration.master,
          durationMs: sourceNarration.master.durationMs + 1,
        },
      })}\n`);
      const changedManifestArtifact = await hashRunArtifact(
        sourceRun,
        'narration-manifest.json',
      );
      sourceNarrationReport.artifacts = sourceNarrationReport.artifacts.map((artifact) => (
        artifact.path === changedManifestArtifact.path
          ? changedManifestArtifact
          : artifact
      ));
    }
    if (tamperSourceCache) {
      await writeFile(
        path.join(
          tempProject.workspaceRoot,
          '.work',
          'demo',
          'runs',
          'source-run',
          sourceCachePath,
        ),
        'tampered-cache',
        'utf8',
      );
    }
    providerFingerprint = currentProviderFingerprint;
    canonicalFingerprint.mockClear();
    await beforeExecute?.();
    const context = executionContext({
      project: currentProject,
      preflight: normalizedCurrentPreflight,
      sourceRun: {
        runId: 'source-run',
        runDirectory: sourceRun,
        reports: new Map([['narration', sourceNarrationReport]]),
      },
    });
    await stage.execute(context, new AbortController().signal);
    return {
      seedNarrationCache,
      runNarration,
      injectedFingerprint,
      canonicalFingerprint,
      normalizedCurrentPreflight,
    };
  };

  it('seeds for script-only changes', async () => {
    const providerFingerprint = hash('provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
    });
    expect(result.seedNarrationCache).toHaveBeenCalledOnce();
    expect(result.seedNarrationCache).toHaveBeenCalledWith(expect.objectContaining({
      providerFingerprint,
      sourceRun,
      targetRun,
    }));
  });

  it('does not seed for FFmpeg-only changes', async () => {
    const providerFingerprint = hash('provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: project,
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult({
        toolIdentities: {
          ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg-2')},
          ffprobe: {realPath: '/tools/ffprobe', sha256: hash('ffprobe')},
          qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart')},
        },
      }),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
    });
    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('does not seed for FFprobe-only changes', async () => {
    const providerFingerprint = hash('provider');
    const currentPreflight = preflightResult() as PreflightResult & {
      toolIdentities: PreflightResult['toolIdentities'] & {
        ffprobe: {realPath: string; sha256: string};
      };
    };
    currentPreflight.toolIdentities.ffprobe = {
      realPath: '/tools/ffprobe',
      sha256: hash('ffprobe-2'),
    };
    const result = await executeCase({
      sourceProject: project,
      currentProject: project,
      sourcePreflight: preflightResult(),
      currentPreflight,
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
    });
    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('does not seed for provider-only changes', async () => {
    const result = await executeCase({
      sourceProject: project,
      currentProject: project,
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: hash('provider-1'),
      currentProviderFingerprint: hash('provider-2'),
    });
    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('does not seed for TTS-config-only changes', async () => {
    const currentProjectValue = createProjectFixture('demo');
    currentProjectValue.tts.rate = 181;
    const providerFingerprint = hash('provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: {...project, project: currentProjectValue},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
    });
    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('never seeds the file provider for script-only changes', async () => {
    const fileProjectValue = createProjectFixture('demo');
    fileProjectValue.tts.provider = 'file';
    const sourceScript = createScriptFixture();
    sourceScript.segments[0]!.audioPath = 'assets/source/voice/intro.wav';
    const currentScript = createScriptFixture('changed script');
    currentScript.segments[0]!.audioPath = 'assets/source/voice/intro.wav';
    const fileProject = {...project, project: fileProjectValue, script: sourceScript};
    const providerFingerprint = hash('file-provider');
    const result = await executeCase({
      sourceProject: fileProject,
      currentProject: {...fileProject, script: currentScript},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
    });
    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('uses the canonical provider fingerprint when an injected provider disagrees', async () => {
    const canonicalFingerprint = hash('canonical-provider');
    const injectedFingerprint = hash('injected-provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: canonicalFingerprint,
      currentProviderFingerprint: canonicalFingerprint,
      injectedProviderFingerprint: injectedFingerprint,
    });

    expect(result.injectedFingerprint).not.toHaveBeenCalled();
    expect(result.canonicalFingerprint).toHaveBeenCalledOnce();
    expect(result.seedNarrationCache).toHaveBeenCalledWith(expect.objectContaining({
      providerFingerprint: canonicalFingerprint,
    }));
    const executionInput = result.runNarration.mock.calls[0]?.[0];
    expect(executionInput).toBeDefined();
    await expect(executionInput!.provider.fingerprint()).resolves.toBe(canonicalFingerprint);
  });

  it('does not seed when a source cache artifact is tampered', async () => {
    const providerFingerprint = hash('provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
      tamperSourceCache: true,
    });
    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('does not seed when structured reuse compatibility is tampered', async () => {
    const providerFingerprint = hash('provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
      tamperCompatibility: true,
    });
    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('does not seed from a source Narration report that is not passed or cached', async () => {
    const providerFingerprint = hash('provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
      sourceReportState: 'needs_review',
    });

    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('does not seed when persisted Narration JSON and its artifact hash diverge from report outputs', async () => {
    const providerFingerprint = hash('provider');
    const result = await executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
      coordinatedManifestArtifactTamper: true,
    });

    expect(result.seedNarrationCache).not.toHaveBeenCalled();
  });

  it('propagates EIO while reading persisted Narration seed provenance', async () => {
    const providerFingerprint = hash('provider');
    const failure = Object.assign(new Error('source Narration read failed'), {code: 'EIO'});

    await expect(executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
      readPersistedNarrationFiles: async () => { throw failure; },
    })).rejects.toBe(failure);
  });

  it('propagates source Run authority changes while validating seed provenance', async () => {
    const providerFingerprint = hash('provider');

    await expect(executeCase({
      sourceProject: project,
      currentProject: {...project, script: createScriptFixture('changed script')},
      sourcePreflight: preflightResult(),
      currentPreflight: preflightResult(),
      sourceProviderFingerprint: providerFingerprint,
      currentProviderFingerprint: providerFingerprint,
      beforeExecute: async () => {
        await rename(
          runFilePath('source-run', ''),
          path.join(tempProject.workspaceRoot, 'moved-narration-source-run'),
        );
      },
    })).rejects.toMatchObject({code: 'APP_SCOPE_AUTHORITY_CHANGED'});
  });
});

describe('provenance hardening regressions', () => {
  const releaseResult = (
    runId: string,
    releaseFingerprint = hash('release'),
  ): ReleaseStageResult => ({
    outputs: {
      mutedVideo: {path: 'release/muted-video.mp4', sha256: hash('release-muted')},
      intermediate: {path: 'release/final-intermediate.mp4', sha256: hash('intermediate')},
      finalVideo: {path: releaseOutputPath(runId, 'final.mp4'), sha256: hash('final')},
      subtitles: {path: releaseOutputPath(runId, 'subtitles.srt'), sha256: hash('subtitles')},
      thumbnail: {path: releaseOutputPath(runId, 'thumbnail.jpg'), sha256: hash('thumbnail')},
      review: {path: releaseOutputPath(runId, 'review.json'), sha256: hash('review-output')},
      validationReport: {
        path: releaseOutputPath(runId, 'validation-report.json'),
        sha256: hash('validation'),
      },
      checksums: {path: releaseOutputPath(runId, 'checksums.sha256'), sha256: hash('checksums')},
      releaseFingerprint,
      verification: fixedReleaseVerification(hash('final')),
    },
    current: {
      runId,
      relativePath: `releases/${runId}`,
      preset: 'release',
      stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
      completedStage: 'release',
      state: 'passed',
      publishedAt: '2026-08-11T01:02:03.000Z',
    },
  });

  const writeTargetReleaseReports = async (
    preflight: PreflightResult,
    compileFingerprint = hash('compile-report'),
  ): Promise<void> => {
    const store = createStageReportStore();
    await store.writeStage(targetRun, {
      ...preflightStageReport(preflight),
      runId: 'target-run',
      artifacts: [],
    });
    await store.writeStage(targetRun, passedStageReport({
      stageId: 'compile',
      runId: 'target-run',
      fingerprint: compileFingerprint,
      artifacts: [],
    }));
  };

  const targetReleaseInputs = (
    preflight: PreflightResult,
    compileFingerprint = hash('compile-report'),
  ) => {
    const draft = draftReport();
    const timeline = compiledTimeline();
    const review = approvedReview({runId: 'target-run'});
    const stageFingerprint = releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      compileStageFingerprint: compileFingerprint,
      compiledTimeline: timeline,
      review,
      preflightEnvironmentFingerprint: preflight.environmentFingerprint,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    });
    return {draft, timeline, review, stageFingerprint};
  };

  const materializeTargetReleaseResult = async ({
    preflight,
    draft,
    timeline,
    review,
    stageFingerprint,
    outputReview = review,
    mutateVerification,
  }: ReturnType<typeof targetReleaseInputs> & {
    preflight: PreflightResult;
    outputReview?: Review;
    mutateVerification?: (verification: ReleaseVerificationReport) => void;
  }): Promise<ReleaseStageResult> => await materializeReleaseResult({
    runId: 'target-run',
    preflight,
    draft,
    timeline,
    review,
    releaseFingerprint: stageFingerprint,
    outputReview,
    ...(mutateVerification === undefined ? {} : {mutateVerification}),
  });

  it.each([
    ['FFmpeg real path', (value: Record<string, any>) => {
      value.toolIdentities.ffmpeg.realPath = '/tampered/ffmpeg';
    }],
    ['FFmpeg hash', (value: Record<string, any>) => {
      value.toolIdentities.ffmpeg.sha256 = hash('tampered-ffmpeg');
    }],
    ['font path', (value: Record<string, any>) => {
      value.fonts[0].path = 'assets/fonts/tampered.otf';
    }],
    ['font hash', (value: Record<string, any>) => {
      value.fonts[0].sha256 = hash('tampered-font');
    }],
    ['Node version', (value: Record<string, any>) => {
      value.versions.node = 'v99.0.0';
    }],
    ['FFprobe version', (value: Record<string, any>) => {
      value.versions.ffprobe = '99.0';
    }],
    ['voice availability', (value: Record<string, any>) => {
      value.voice.available = false;
    }],
    ['voice fallback mode', (value: Record<string, any>) => {
      value.voice.segmentedWavFallback = true;
    }],
    ['system platform', (value: Record<string, any>) => {
      value.system.platform = 'linux';
    }],
    ['system architecture', (value: Record<string, any>) => {
      value.system.arch = 'x64';
    }],
    ['system source bytes', (value: Record<string, any>) => {
      value.system.sourceBytes += 1;
    }],
    ['system required bytes', (value: Record<string, any>) => {
      value.system.requiredBytes += 1;
    }],
  ])('rejects a persisted Preflight snapshot with a tampered %s', async (_label, mutate) => {
    const live = preflightResult();
    const context = planningContext({preflight: live});
    const stage = createPreflightStage();
    const fingerprint = await stage.fingerprint(context);
    const outputs = structuredClone(live) as unknown as Record<string, any>;
    mutate(outputs);
    const report = passedStageReport({
      stageId: 'preflight',
      fingerprint,
      artifacts: [],
      outputs,
    });

    await expect(stage.verify(context, report)).resolves.toBe(false);
  });

  it('ignores Preflight runtime noise and human-readable checks during verification', async () => {
    const live = preflightResult();
    const context = planningContext({preflight: live});
    const stage = createPreflightStage();
    const outputs = structuredClone(live);
    outputs.system.availableBytes = 1;
    outputs.system.workDirectory = '/absolute/runtime/work/demo';
    outputs.checks = [{
      id: 'changed-message',
      severity: 'warning',
      code: 'ENV_TOOL_CHANGED',
      message: 'runtime-only message changed',
    }];
    const report = passedStageReport({
      stageId: 'preflight',
      fingerprint: await stage.fingerprint(context),
      artifacts: [],
      outputs: JSON.parse(JSON.stringify(outputs)),
    });

    await expect(stage.verify(context, report)).resolves.toBe(true);
  });

  it('rejects a persisted Preflight snapshot with a tampered ffprobe identity', async () => {
    const live = preflightResult() as PreflightResult & {
      toolIdentities: PreflightResult['toolIdentities'] & {
        ffprobe: {realPath: string; sha256: string};
      };
    };
    live.toolIdentities.ffprobe = {
      realPath: '/tools/ffprobe',
      sha256: hash('ffprobe'),
    };
    const context = planningContext({preflight: live});
    const stage = createPreflightStage();
    const fingerprint = await stage.fingerprint(context);
    const validReport = passedStageReport({
      stageId: 'preflight',
      fingerprint,
      artifacts: [],
      outputs: JSON.parse(JSON.stringify(live)),
    });
    await expect(stage.verify(context, validReport)).resolves.toBe(true);

    const tampered = structuredClone(live);
    tampered.toolIdentities.ffprobe.sha256 = hash('tampered-ffprobe');
    await expect(stage.verify(context, {
      ...validReport,
      outputs: JSON.parse(JSON.stringify(tampered)),
    })).resolves.toBe(false);
  });

  it.each([
    ['wrong project', approvedReview({projectId: 'other-project'})],
    ['wrong run', approvedReview({runId: 'other-run'})],
    ['missing evidence', approvedReview({evidencePaths: ['draft/contact-sheet.jpg']})],
    ['rejected status', approvedReview({status: 'rejected'})],
  ])('does not reuse Review approval with %s', async (_label, review) => {
    const draftVideo = await hashRunArtifact(sourceRun, 'draft/draft.mp4');
    const contactSheet = await hashRunArtifact(sourceRun, 'draft/contact-sheet.jpg');
    const reviewFrame = await hashRunArtifact(sourceRun, 'draft/frames/frame-000000.jpg');
    const draft = draftReport({
      draftVideo: {path: draftVideo.path, sha256: draftVideo.sha256},
      contactSheet: {path: contactSheet.path, sha256: contactSheet.sha256},
      reviewFrames: [{path: reviewFrame.path, sha256: reviewFrame.sha256}],
    });
    const stage = createReviewStage({
      readDraftReport: async () => draft,
      readReview: async () => review,
    });
    const context = planningContext();
    const report = passedStageReport({
      stageId: 'review',
      fingerprint: await stage.fingerprint(context),
      artifacts: [],
      outputs: {
        evidence: draftReviewEvidenceArtifacts(draft),
        review,
      },
    });

    await expect(stage.verify(context, report)).resolves.toBe(false);
  });

  it.each([
    ['wrong project', approvedReview({projectId: 'other-project'})],
    ['wrong run', approvedReview({runId: 'other-run'})],
    ['missing evidence', approvedReview({evidencePaths: ['draft/contact-sheet.jpg']})],
    ['rejected status', approvedReview({status: 'rejected'})],
  ])('returns null for Release planning with %s Review approval', async (_label, review) => {
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => review,
      readStageReport: releaseStageReportReader(),
    });

    await expect(stage.fingerprint(planningContext())).resolves.toBeNull();
  });

  it.each([
    ['missing Draft', Object.assign(new Error('missing Draft'), {code: 'ENOENT'})],
    ['malformed Draft', new SyntaxError('malformed Draft')],
  ])('returns null for Review planning with %s input', async (_label, failure) => {
    const stage = createReviewStage({
      readDraftReport: async () => { throw failure; },
    });
    await expect(stage.fingerprint(planningContext())).resolves.toBeNull();
  });

  it.each([
    ['Draft', 'readDraftReport'],
    ['Review', 'readReview'],
    ['Compile', 'readCompiledTimeline'],
  ] as const)('returns null for malformed persisted Release %s input', async (_label, key) => {
    const failure = new SyntaxError(`malformed ${key}`);
    const dependencies = {
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
      readStageReport: releaseStageReportReader(),
      [key]: async () => { throw failure; },
    };
    const stage = createReleaseStage(dependencies);
    await expect(stage.fingerprint(planningContext())).resolves.toBeNull();
  });

  it('propagates genuine Release planning I/O failures', async () => {
    const failure = Object.assign(new Error('disk I/O failed'), {code: 'EIO'});
    const stage = createReleaseStage({
      readDraftReport: async () => { throw failure; },
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
      readStageReport: releaseStageReportReader(),
    });
    await expect(stage.fingerprint(planningContext())).rejects.toBe(failure);
  });

  it.each([
    ['missing Preflight', 'preflight', null],
    ['missing Compile Stage report', 'compile', null],
    ['malformed Preflight', 'preflight', new SyntaxError('malformed Preflight')],
    ['malformed Compile Stage report', 'compile', new SyntaxError('malformed Compile')],
  ] as const)('returns null for %s', async (_label, failingStage, failure) => {
    const validReader = releaseStageReportReader();
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
      readStageReport: async (runDirectory, stageId) => {
        if (stageId !== failingStage) return await validReader(runDirectory, stageId);
        if (failure === null) return null;
        throw failure;
      },
    });

    await expect(stage.fingerprint(planningContext())).resolves.toBeNull();
  });

  it.each(
    (['preflight', 'compile'] as const).flatMap((stageId) => ([
      [stageId, 'failed', hash(`${stageId}-failed`)],
      [stageId, 'cancelled', hash(`${stageId}-cancelled`)],
      [stageId, 'needs_review', hash(`${stageId}-needs-review`)],
      [stageId, 'passed', null],
    ] as const)),
  )('returns null for a %s prerequisite in state %s with fingerprint %s', async (
    stageId,
    state,
    fingerprint,
  ) => {
    const validReader = releaseStageReportReader();
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
      readStageReport: async (runDirectory, requestedStageId) => {
        const report = await validReader(runDirectory, requestedStageId);
        if (requestedStageId !== stageId) return report;
        return {
          ...report,
          state,
          fingerprint,
          ...(
            state === 'failed' || state === 'cancelled'
              ? {error: {code: 'TEST_FAILURE', message: 'not successful'}}
              : {}
          ),
        };
      },
    });

    await expect(stage.fingerprint(planningContext())).resolves.toBeNull();
  });

  it.each(
    (['preflight', 'compile'] as const).flatMap((stageId) => ([
      [stageId, 'failed', hash(`${stageId}-failed`)],
      [stageId, 'cancelled', hash(`${stageId}-cancelled`)],
      [stageId, 'needs_review', hash(`${stageId}-needs-review`)],
      [stageId, 'passed', null],
    ] as const)),
  )('does not execute Release for a %s prerequisite in state %s with fingerprint %s', async (
    stageId,
    state,
    fingerprint,
  ) => {
    const validReader = releaseStageReportReader({runId: 'target-run'});
    const executeRelease = vi.fn(async () => releaseResult('target-run'));
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview({runId: 'target-run'}),
      readStageReport: async (runDirectory, requestedStageId) => {
        const report = await validReader(runDirectory, requestedStageId);
        if (requestedStageId !== stageId) return report;
        return {
          ...report,
          state,
          fingerprint,
          ...(
            state === 'failed' || state === 'cancelled'
              ? {error: {code: 'TEST_FAILURE', message: 'not successful'}}
              : {}
          ),
        };
      },
      runRelease: executeRelease,
    });

    await expect(stage.execute(
      executionContext(),
      new AbortController().signal,
    )).rejects.toBeDefined();
    expect(executeRelease).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong project', {projectId: 'other-project'}],
    ['wrong run', {runId: 'other-run'}],
    ['wrong stage', {stageId: 'ingest', position: 2}],
  ] as const)('does not execute Release with a %s Preflight report envelope', async (_label, overrides) => {
    const persisted = preflightStageReport(preflightResult());
    await writeRunText(targetRun, 'reports/preflight.json', `${JSON.stringify({
      ...persisted,
      projectId: 'demo',
      runId: 'target-run',
      ...overrides,
    })}\n`);
    await createStageReportStore().writeStage(targetRun, passedStageReport({
      stageId: 'compile',
      runId: 'target-run',
      fingerprint: hash('compile-report'),
      artifacts: [],
    }));
    const executeRelease = vi.fn(async () => releaseResult('target-run'));
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview({runId: 'target-run'}),
      runRelease: executeRelease,
    });

    await expect(stage.execute(executionContext(), new AbortController().signal))
      .rejects.toBeDefined();
    expect(executeRelease).not.toHaveBeenCalled();
  });

  it('does not execute Release when persisted Preflight tools differ from live Preflight', async () => {
    const live = preflightResult();
    const persisted = preflightResult({
      toolIdentities: {
        ffmpeg: {realPath: '/tampered/ffmpeg', sha256: hash('tampered-ffmpeg')},
        ffprobe: live.toolIdentities.ffprobe,
        qtFaststart: live.toolIdentities.qtFaststart,
      },
    });
    await createStageReportStore().writeStage(targetRun, {
      ...preflightStageReport(persisted),
      runId: 'target-run',
      artifacts: [],
    });
    await createStageReportStore().writeStage(targetRun, passedStageReport({
      stageId: 'compile',
      runId: 'target-run',
      fingerprint: hash('compile-report'),
      artifacts: [],
    }));
    const executeRelease = vi.fn(async () => releaseResult('target-run'));
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview({runId: 'target-run'}),
      runRelease: executeRelease,
    });

    await expect(stage.execute(
      executionContext({preflight: live}),
      new AbortController().signal,
    )).rejects.toBeDefined();
    expect(executeRelease).not.toHaveBeenCalled();
  });

  it.each(['ffmpeg', 'ffprobe', 'qtFaststart'] as const)(
    'does not execute Release without a persisted %s identity',
    async (tool) => {
      const persisted = preflightResult();
      persisted.toolIdentities[tool] = null;
      await writeTargetReleaseReports(persisted);
      const inputs = targetReleaseInputs(persisted);
      const executeRelease = vi.fn(async () => releaseResult(
        'target-run',
        inputs.stageFingerprint,
      ));
      const stage = createReleaseStage({
        readDraftReport: async () => inputs.draft,
        readCompiledTimeline: async () => inputs.timeline,
        readReview: async () => inputs.review,
        runRelease: executeRelease,
      });

      await expect(stage.execute(
        executionContext({preflight: persisted}),
        new AbortController().signal,
      )).rejects.toBeDefined();
      expect(executeRelease).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['mismatched verification hash', hash('other-final')],
    ['malformed verification hash', 'not-a-sha256'],
  ])('rejects Release outputs with a %s', async (_label, verificationSha256) => {
    const preflight = preflightResult();
    await writeTargetReleaseReports(preflight);
    const inputs = targetReleaseInputs(preflight);
    const concreteResult = await materializeTargetReleaseResult({...inputs, preflight});
    concreteResult.outputs.verification.sha256 = verificationSha256;
    const stage = createReleaseStage({
      readDraftReport: async () => inputs.draft,
      readCompiledTimeline: async () => inputs.timeline,
      readReview: async () => inputs.review,
      runRelease: async () => concreteResult,
    });

    await expect(stage.execute(
      executionContext({preflight}),
      new AbortController().signal,
    )).rejects.toBeDefined();
  });

  it('rejects semantically inconsistent Release audit metadata after execution', async () => {
    const preflight = preflightResult();
    await writeTargetReleaseReports(preflight);
    const inputs = targetReleaseInputs(preflight);
    const concreteResult = await materializeTargetReleaseResult({
      ...inputs,
      preflight,
      outputReview: {...inputs.review, reviewer: 'tampered-reviewer'},
    });
    const stage = createReleaseStage({
      readDraftReport: async () => inputs.draft,
      readCompiledTimeline: async () => inputs.timeline,
      readReview: async () => inputs.review,
      runRelease: async () => concreteResult,
    });

    await expect(stage.execute(
      executionContext({preflight}),
      new AbortController().signal,
    )).rejects.toThrow('Release returned invalid audit metadata');
  });

  it.each(semanticReleaseVerificationFailures)(
    'rejects semantically invalid Release verification with %s after execution',
    async (_label, mutateVerification) => {
      const preflight = preflightResult();
      await writeTargetReleaseReports(preflight);
      const inputs = targetReleaseInputs(preflight);
      const concreteResult = await materializeTargetReleaseResult({
        ...inputs,
        preflight,
        mutateVerification,
      });
      const stage = createReleaseStage({
        readDraftReport: async () => inputs.draft,
        readCompiledTimeline: async () => inputs.timeline,
        readReview: async () => inputs.review,
        runRelease: async () => concreteResult,
      });

      await expect(stage.execute(
        executionContext({preflight}),
        new AbortController().signal,
      )).rejects.toThrow('Release returned invalid audit metadata');
    },
  );

  it.each([
    ['wrong Run', (current: ReleaseStageResult['current']) => {
      current.runId = 'other-run';
      current.relativePath = 'releases/other-run';
    }],
    ['incomplete Stage list', (current: ReleaseStageResult['current']) => {
      current.stageIds = current.stageIds.filter((stageId) => stageId !== 'release');
    }],
    ['different timestamp', (current: ReleaseStageResult['current']) => {
      current.publishedAt = '2026-08-11T01:02:04.000Z';
    }],
  ] as const)('rejects a Release %s pointer candidate', async (_label, mutate) => {
    const preflight = preflightResult();
    await writeTargetReleaseReports(preflight);
    const inputs = targetReleaseInputs(preflight);
    const concreteResult = await materializeTargetReleaseResult({...inputs, preflight});
    mutate(concreteResult.current);
    const stage = createReleaseStage({
      readDraftReport: async () => inputs.draft,
      readCompiledTimeline: async () => inputs.timeline,
      readReview: async () => inputs.review,
      runRelease: async () => concreteResult,
    });

    await expect(stage.execute(
      executionContext({preflight}),
      new AbortController().signal,
    )).rejects.toBeDefined();
  });

  it('freezes one canonical Release timestamp and derives the pointer candidate', async () => {
    const preflight = preflightResult();
    await writeTargetReleaseReports(preflight);
    const inputs = targetReleaseInputs(preflight);
    const concreteResult = await materializeTargetReleaseResult({...inputs, preflight});
    const now = vi.fn()
      .mockReturnValueOnce('2026-08-11T01:02:03.000Z')
      .mockReturnValue('2026-08-11T01:02:04.000Z');
    const executeRelease = vi.fn(async (input: ReleaseStageInput) => {
      expect(input.now?.()).toBe('2026-08-11T01:02:03.000Z');
      expect(input.now?.()).toBe('2026-08-11T01:02:03.000Z');
      return concreteResult;
    });
    const stage = createReleaseStage({
      readDraftReport: async () => inputs.draft,
      readCompiledTimeline: async () => inputs.timeline,
      readReview: async () => inputs.review,
      runRelease: executeRelease,
    });

    const result = await stage.execute(
      executionContext({preflight, now}),
      new AbortController().signal,
    );

    expect(now).toHaveBeenCalledOnce();
    expect(result.outputCurrent).toEqual(concreteResult.current);
    expect(result.outputCurrent).not.toBe(concreteResult.current);
  });
});

describe('Narration fingerprint and media tool provenance', () => {
  const preflightWithFfprobe = (): PreflightResult => {
    const value = preflightResult() as PreflightResult & {
      toolIdentities: PreflightResult['toolIdentities'] & {
        ffprobe: {realPath: string; sha256: string};
      };
    };
    value.toolIdentities.ffprobe = {
      realPath: '/persisted/ffprobe',
      sha256: hash('persisted-ffprobe'),
    };
    value.toolIdentities.ffmpeg = {
      realPath: '/persisted/ffmpeg',
      sha256: hash('persisted-ffmpeg'),
    };
    return value;
  };

  it('changes the file-provider fingerprint when same-path audio bytes change', async () => {
    const projectValue = structuredClone(project.project);
    projectValue.tts.provider = 'file';
    const script = createScriptFixture('file narration');
    script.segments[0]!.audioPath = 'assets/source/voice/intro.wav';
    await mkdir(path.join(tempProject.projectRoot, 'assets/source/voice'), {recursive: true});
    const audioPath = path.join(tempProject.projectRoot, script.segments[0]!.audioPath!);
    await writeFile(audioPath, 'audio-v1', 'utf8');
    const fileProject = {...project, project: projectValue, script};
    const stage = createNarrationStage({
      fingerprintTtsProvider: async () => hash('file-provider'),
    });
    const context = planningContext({
      project: fileProject,
      preflight: preflightWithFfprobe(),
    });
    const before = await stage.fingerprint(context);

    await writeFile(audioPath, 'audio-v2', 'utf8');

    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it('changes the file-provider fingerprint when the audio path changes', async () => {
    const projectValue = structuredClone(project.project);
    projectValue.tts.provider = 'file';
    const firstScript = createScriptFixture('file narration');
    firstScript.segments[0]!.audioPath = 'assets/source/voice/intro-a.wav';
    const secondScript = structuredClone(firstScript);
    secondScript.segments[0]!.audioPath = 'assets/source/voice/intro-b.wav';
    await mkdir(path.join(tempProject.projectRoot, 'assets/source/voice'), {recursive: true});
    await Promise.all([
      writeFile(path.join(tempProject.projectRoot, firstScript.segments[0]!.audioPath!), 'audio', 'utf8'),
      writeFile(path.join(tempProject.projectRoot, secondScript.segments[0]!.audioPath!), 'audio', 'utf8'),
    ]);
    const stage = createNarrationStage({
      fingerprintTtsProvider: async () => hash('file-provider'),
    });
    const preflight = preflightWithFfprobe();
    const first = await stage.fingerprint(planningContext({
      project: {...project, project: projectValue, script: firstScript},
      preflight,
    }));
    const second = await stage.fingerprint(planningContext({
      project: {...project, project: projectValue, script: secondScript},
      preflight,
    }));

    expect(second).not.toBe(first);
  });

  it('passes persisted FFmpeg and FFprobe paths into Narration execution', async () => {
    const preflight = preflightWithFfprobe();
    const runNarration = vi.fn(async (input: NarrationStageInput) => {
      const providerFingerprint = await input.provider.fingerprint();
      const segment = project.script.segments[0]!;
      const inputHash = narrationSegmentInputHash(
        segment,
        project.project.tts.voice,
        project.project.tts.rate,
        providerFingerprint,
      );
      const segments = [{
        id: segment.id,
        inputHash,
        audioPath: `audio/segments/0001-intro-${inputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`,
        audioHash: hash('segment'),
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        pauseAfterMs: segment.pauseAfterMs,
        sampleRate: 48_000 as const,
        channels: 1 as const,
        providerFingerprint,
      }];
      return {
        narrationPath: 'narration-manifest.json' as const,
        captionsPath: 'captions.json' as const,
        srtPath: 'captions.srt' as const,
        narration: {
          version: 1 as const,
          provider: 'mock' as const,
          segments,
          master: {
            audioPath: narrationMasterPath({provider: 'mock', segments}),
            audioHash: hash('master'),
            durationMs: 1000,
          },
        },
        captions: {
          version: 1 as const,
          sourceNarrationHash: hash('master'),
          cues: [{
            id: `caption-${segment.id}`,
            segmentId: segment.id,
            text: segment.text,
            startMs: 0,
            endMs: 1000,
          }],
        },
      };
    });
    const stage = createNarrationStage({
      fingerprintTtsProvider: async () => hash('provider'),
      createTtsProvider: () => ({
        id: 'mock',
        capabilities: async () => ({languages: ['zh-CN'], voices: ['fixture']}),
        fingerprint: async () => hash('untrusted-provider'),
        synthesize: async () => ({outputPath: 'unused', providerFingerprint: hash('provider')}),
      }),
      runNarration,
      hashRunArtifact: fakeArtifact,
    });

    const context = executionContext({preflight});
    delete context.sourceRun;
    await stage.execute(context, new AbortController().signal);

    expect(runNarration).toHaveBeenCalledWith(expect.objectContaining({
      ffmpegExecutable: '/persisted/ffmpeg',
      ffprobeExecutable: '/persisted/ffprobe',
    }));
  });
});

describe('Release semantic fingerprinting', () => {
  it('changes when compiled timeline caption semantics change', async () => {
    const store = createStageReportStore();
    await store.writeStage(sourceRun, {
      ...preflightStageReport(preflightResult()),
      runId: 'source-run',
      artifacts: [],
    });
    await store.writeStage(sourceRun, passedStageReport({
      stageId: 'compile',
      runId: 'source-run',
      fingerprint: hash('compile-stage'),
      artifacts: [],
      outputs: JSON.parse(JSON.stringify({
        timelinePath: 'compiled-timeline.json',
        timeline: compiledTimeline(),
      })),
    }));
    let timeline = compiledTimeline();
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => timeline,
      readReview: async () => approvedReview(),
    });
    const context = planningContext();
    const before = await stage.fingerprint(context);
    timeline = {
      ...timeline,
      captions: timeline.captions.map((caption) => ({
        ...caption,
        text: `${caption.text} changed`,
      })),
    };

    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it('passes the algorithm version into fixed-profile concrete Release fingerprinting', async () => {
    const preflight = preflightResult();
    const store = createStageReportStore();
    await store.writeStage(targetRun, {
      ...preflightStageReport(preflight),
      runId: 'target-run',
      artifacts: [],
    });
    await store.writeStage(targetRun, passedStageReport({
      stageId: 'compile',
      runId: 'target-run',
      fingerprint: hash('compile-stage'),
      artifacts: [],
      outputs: JSON.parse(JSON.stringify({
        timelinePath: 'compiled-timeline.json',
        timeline: compiledTimeline(),
      })),
    }));
    const algorithmVersion = 'release-stage-v2';
    const timeline = compiledTimeline();
    const draft = draftReport();
    const review = approvedReview({runId: 'target-run'});
    const expectedFingerprint = releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      compileStageFingerprint: hash('compile-stage'),
      compiledTimeline: timeline,
      review,
      preflightEnvironmentFingerprint: preflight.environmentFingerprint,
      algorithmVersion,
    });
    const releaseResultFixture = await materializeReleaseResult({
      runId: 'target-run',
      preflight,
      draft,
      timeline,
      review,
      releaseFingerprint: expectedFingerprint,
    });
    const executeRelease = vi.fn(async () => releaseResultFixture);
    const stage = createReleaseStage({
      algorithmVersion,
      readDraftReport: async () => draft,
      readCompiledTimeline: async () => timeline,
      readReview: async () => review,
      runRelease: executeRelease,
    });

    const result = await stage.execute(
      executionContext({preflight}),
      new AbortController().signal,
    );

    expect(executeRelease).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      publishCurrent: false,
      algorithmVersion,
    }));
    expect(executeRelease).toHaveBeenCalledWith(
      expect.anything(),
      expect.not.objectContaining({profile: expect.anything()}),
    );
    expect(result.fingerprint).toBe(expectedFingerprint);
    expect(result.outputs).toMatchObject({releaseFingerprint: expectedFingerprint});
  });

  it('does not expose an injectable Release profile', () => {
    if (false) {
      // @ts-expect-error Release always uses RELEASE_FIXED_PROFILE
      createReleaseStage({profile: {fps: 60}});
    }
    expect(true).toBe(true);
  });
});

describe('exact stage-owned artifact validators', () => {
  it('rejects an Ingest manifest that omits a current source-catalog asset', async () => {
    const manifest = {version: 1 as const, assets: {}};
    await writeRunText(sourceRun, 'asset-manifest.json', `${JSON.stringify(manifest)}\n`);
    const manifestArtifact = await hashRunArtifact(sourceRun, 'asset-manifest.json');
    const report = passedStageReport({
      stageId: 'ingest',
      artifacts: [manifestArtifact],
      outputs: {manifestPath: 'asset-manifest.json', manifest},
    });

    await expect(createIngestStage().verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('rejects Ingest Run render paths outside concrete asset naming', async () => {
    const manifest = {
      version: 1 as const,
      assets: {
        clip: {
          kind: 'video' as const,
          sourcePath: 'assets/source/clip.mp4',
          sourceHash: hash('source-clip'),
          renderPath: 'assets/unexpected/render.mp4',
          renderScope: 'run' as const,
          compatibility: 'transcoded' as const,
          durationMs: 1000,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          hasAudio: true,
          variableFrameRate: false,
        },
      },
    };
    await writeRunText(sourceRun, 'asset-manifest.json', `${JSON.stringify(manifest)}\n`);
    await writeRunText(sourceRun, 'assets/unexpected/render.mp4', 'render');
    const artifacts = await Promise.all([
      hashRunArtifact(sourceRun, 'asset-manifest.json'),
      hashRunArtifact(sourceRun, 'assets/unexpected/render.mp4'),
    ]);
    const report = passedStageReport({
      stageId: 'ingest',
      artifacts,
      outputs: {manifestPath: 'asset-manifest.json', manifest},
    });

    await expect(createIngestStage().verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('rejects Narration segment and master paths outside concrete naming', async () => {
    const providerFingerprint = hash('provider');
    const inputHash = narrationSegmentInputHash(
      project.script.segments[0]!,
      project.project.tts.voice,
      project.project.tts.rate,
      providerFingerprint,
    );
    const cachePath = `audio/cache/${inputHash.slice('sha256:'.length)}.wav`;
    const segmentPath = 'audio/segments/unexpected.wav';
    const masterPath = 'audio/narration.wav';
    const narration = {
      version: 1 as const,
      provider: 'mock' as const,
      segments: [{
        id: 'intro',
        inputHash,
        audioPath: segmentPath,
        audioHash: contentHash('segment'),
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        pauseAfterMs: 300,
        sampleRate: 48_000 as const,
        channels: 1 as const,
        providerFingerprint,
      }],
      master: {audioPath: masterPath, audioHash: contentHash('master'), durationMs: 1000},
    };
    const captions = {version: 1 as const, sourceNarrationHash: narration.master.audioHash, cues: []};
    const reuseCompatibility = {
      tts: project.project.tts,
      providerFingerprint,
      ffmpegIdentity: preflightResult().toolIdentities.ffmpeg!,
      ffprobeIdentity: preflightResult().toolIdentities.ffprobe!,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    };
    await Promise.all([
      writeRunText(sourceRun, cachePath, 'cache'),
      writeRunText(sourceRun, segmentPath, 'segment'),
      writeRunText(sourceRun, masterPath, 'master'),
      writeRunText(sourceRun, 'narration-manifest.json', `${JSON.stringify(narration)}\n`),
      writeRunText(sourceRun, 'captions.json', `${JSON.stringify(captions)}\n`),
      writeRunText(sourceRun, 'captions.srt', ''),
    ]);
    const artifacts = await Promise.all([
      cachePath,
      segmentPath,
      masterPath,
      'narration-manifest.json',
      'captions.json',
      'captions.srt',
    ].map(async (relativePath) => await hashRunArtifact(sourceRun, relativePath)));
    const report = passedStageReport({
      stageId: 'narration',
      artifacts,
      outputs: JSON.parse(JSON.stringify({
        narrationPath: 'narration-manifest.json',
        captionsPath: 'captions.json',
        srtPath: 'captions.srt',
        narration,
        captions,
        reuseCompatibility,
        reuseCompatibilityFingerprint: narrationReuseCompatibilityFingerprint(
          reuseCompatibility,
        ),
      })),
    });

    await expect(createNarrationStage({
      fingerprintTtsProvider: async () => providerFingerprint,
    }).verify(planningContext(), report)).resolves.toBe(false);
  });

  it('rejects a pattern-valid Narration master path with different provenance', async () => {
    const providerFingerprint = hash('provider');
    const inputHash = narrationSegmentInputHash(
      project.script.segments[0]!,
      project.project.tts.voice,
      project.project.tts.rate,
      providerFingerprint,
    );
    const cachePath = `audio/cache/${inputHash.slice('sha256:'.length)}.wav`;
    const segmentPath = `audio/segments/0001-intro-${inputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`;
    const segments = [{
      id: 'intro',
      inputHash,
      audioPath: segmentPath,
      audioHash: contentHash('segment'),
      startMs: 0,
      endMs: 1000,
      durationMs: 1000,
      pauseAfterMs: 300,
      sampleRate: 48_000 as const,
      channels: 1 as const,
      providerFingerprint,
    }];
    const exactMasterPath = narrationMasterPath({provider: 'mock', segments});
    const masterPath = exactMasterPath === 'audio/narration-0123456789abcdef.wav'
      ? 'audio/narration-fedcba9876543210.wav'
      : 'audio/narration-0123456789abcdef.wav';
    const narration = {
      version: 1 as const,
      provider: 'mock' as const,
      segments,
      master: {audioPath: masterPath, audioHash: contentHash('master'), durationMs: 1300},
    };
    const captions = {
      version: 1 as const,
      sourceNarrationHash: narration.master.audioHash,
      cues: [],
    };
    const reuseCompatibility = {
      tts: project.project.tts,
      providerFingerprint,
      ffmpegIdentity: preflightResult().toolIdentities.ffmpeg!,
      ffprobeIdentity: preflightResult().toolIdentities.ffprobe!,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    };
    await Promise.all([
      writeRunText(sourceRun, cachePath, 'cache'),
      writeRunText(sourceRun, segmentPath, 'segment'),
      writeRunText(sourceRun, masterPath, 'master'),
      writeRunText(sourceRun, 'narration-manifest.json', `${JSON.stringify(narration)}\n`),
      writeRunText(sourceRun, 'captions.json', `${JSON.stringify(captions)}\n`),
      writeRunText(sourceRun, 'captions.srt', ''),
    ]);
    const artifacts = await Promise.all([
      cachePath,
      segmentPath,
      masterPath,
      'narration-manifest.json',
      'captions.json',
      'captions.srt',
    ].map(async (relativePath) => await hashRunArtifact(sourceRun, relativePath)));
    const report = passedStageReport({
      stageId: 'narration',
      artifacts,
      outputs: JSON.parse(JSON.stringify({
        narrationPath: 'narration-manifest.json',
        captionsPath: 'captions.json',
        srtPath: 'captions.srt',
        narration,
        captions,
        reuseCompatibility,
        reuseCompatibilityFingerprint: narrationReuseCompatibilityFingerprint(
          reuseCompatibility,
        ),
      })),
    });

    await expect(createNarrationStage({
      fingerprintTtsProvider: async () => providerFingerprint,
    }).verify(planningContext(), report)).resolves.toBe(false);
  });

  it('rejects Narration cache paths derived from noncanonical input hashes', async () => {
    const providerFingerprint = hash('provider');
    const canonicalInputHash = narrationSegmentInputHash(
      project.script.segments[0]!,
      project.project.tts.voice,
      project.project.tts.rate,
      providerFingerprint,
    );
    const inputHash = canonicalInputHash.slice('sha256:'.length);
    const cachePath = `audio/cache/${inputHash}.wav`;
    const segmentPath = `audio/segments/0001-intro-${inputHash.slice(0, 12)}.wav`;
    const masterPath = 'audio/narration-0123456789abcdef.wav';
    const narration = {
      version: 1 as const,
      provider: 'mock' as const,
      segments: [{
        id: 'intro',
        inputHash,
        audioPath: segmentPath,
        audioHash: contentHash('segment'),
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        pauseAfterMs: 300,
        sampleRate: 48_000 as const,
        channels: 1 as const,
        providerFingerprint,
      }],
      master: {audioPath: masterPath, audioHash: contentHash('master'), durationMs: 1000},
    };
    const captions = {
      version: 1 as const,
      sourceNarrationHash: narration.master.audioHash,
      cues: [],
    };
    const reuseCompatibility = {
      tts: project.project.tts,
      providerFingerprint,
      ffmpegIdentity: preflightResult().toolIdentities.ffmpeg!,
      ffprobeIdentity: preflightResult().toolIdentities.ffprobe!,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    };
    await Promise.all([
      writeRunText(sourceRun, cachePath, 'cache'),
      writeRunText(sourceRun, segmentPath, 'segment'),
      writeRunText(sourceRun, masterPath, 'master'),
      writeRunText(sourceRun, 'narration-manifest.json', `${JSON.stringify(narration)}\n`),
      writeRunText(sourceRun, 'captions.json', `${JSON.stringify(captions)}\n`),
      writeRunText(sourceRun, 'captions.srt', ''),
    ]);
    const artifacts = await Promise.all([
      cachePath,
      segmentPath,
      masterPath,
      'narration-manifest.json',
      'captions.json',
      'captions.srt',
    ].map(async (relativePath) => await hashRunArtifact(sourceRun, relativePath)));
    const report = passedStageReport({
      stageId: 'narration',
      artifacts,
      outputs: JSON.parse(JSON.stringify({
        narrationPath: 'narration-manifest.json',
        captionsPath: 'captions.json',
        srtPath: 'captions.srt',
        narration,
        captions,
        reuseCompatibility,
        reuseCompatibilityFingerprint: narrationReuseCompatibilityFingerprint(
          reuseCompatibility,
        ),
      })),
    });

    await expect(createNarrationStage({
      fingerprintTtsProvider: async () => providerFingerprint,
    }).verify(planningContext(), report)).resolves.toBe(false);
  });

  it('rejects a valid-shaped Narration input hash unrelated to the current script', async () => {
    const providerFingerprint = hash('provider');
    const inputHash = hash('unrelated-script-input');
    const cachePath = `audio/cache/${inputHash.slice('sha256:'.length)}.wav`;
    const segmentPath = `audio/segments/0001-intro-${inputHash.slice('sha256:'.length, 'sha256:'.length + 12)}.wav`;
    const segment = {
      id: 'intro',
      inputHash,
      audioPath: segmentPath,
      audioHash: contentHash('segment'),
      startMs: 0,
      endMs: 1000,
      durationMs: 1000,
      pauseAfterMs: project.script.segments[0]!.pauseAfterMs,
      sampleRate: 48_000 as const,
      channels: 1 as const,
      providerFingerprint,
    };
    const masterPath = narrationMasterPath({provider: 'mock', segments: [segment]});
    const narration = {
      version: 1 as const,
      provider: 'mock' as const,
      segments: [segment],
      master: {
        audioPath: masterPath,
        audioHash: contentHash('master'),
        durationMs: 1300,
      },
    };
    const captions = {
      version: 1 as const,
      sourceNarrationHash: narration.master.audioHash,
      cues: [{
        id: 'caption-intro',
        segmentId: 'intro',
        text: project.script.segments[0]!.text,
        startMs: 0,
        endMs: 1000,
      }],
    };
    const reuseCompatibility = {
      tts: project.project.tts,
      providerFingerprint,
      ffmpegIdentity: preflightResult().toolIdentities.ffmpeg!,
      ffprobeIdentity: preflightResult().toolIdentities.ffprobe!,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    };
    await Promise.all([
      writeRunText(sourceRun, cachePath, 'cache'),
      writeRunText(sourceRun, segmentPath, 'segment'),
      writeRunText(sourceRun, masterPath, 'master'),
      writeRunText(sourceRun, 'narration-manifest.json', `${JSON.stringify(narration)}\n`),
      writeRunText(sourceRun, 'captions.json', `${JSON.stringify(captions)}\n`),
      writeRunText(sourceRun, 'captions.srt', 'captions'),
    ]);
    const artifacts = await Promise.all([
      cachePath,
      segmentPath,
      masterPath,
      'narration-manifest.json',
      'captions.json',
      'captions.srt',
    ].map(async (relativePath) => await hashRunArtifact(sourceRun, relativePath)));
    const stage = createNarrationStage({
      fingerprintTtsProvider: async () => providerFingerprint,
    });
    const context = planningContext();
    const report = passedStageReport({
      stageId: 'narration',
      fingerprint: await stage.fingerprint(context),
      artifacts,
      outputs: JSON.parse(JSON.stringify({
        narrationPath: 'narration-manifest.json',
        captionsPath: 'captions.json',
        srtPath: 'captions.srt',
        narration,
        captions,
        reuseCompatibility,
        reuseCompatibilityFingerprint: narrationReuseCompatibilityFingerprint(
          reuseCompatibility,
        ),
      })),
    });

    await expect(stage.verify(context, report)).resolves.toBe(false);
  });

  it('rejects a Draft review frame that cannot come from the compiled timeline', async () => {
    const paths = [
      'draft/muted-video.mp4',
      'draft/frames/frame-999999.jpg',
      'audio/filter-graph.txt',
      'audio/mixed-normalized.wav',
    ];
    for (const relativePath of paths) await writeRunText(sourceRun, relativePath, relativePath);
    const references = new Map(await Promise.all([
      'draft/muted-video.mp4',
      'draft/draft.mp4',
      'draft/contact-sheet.jpg',
      'draft/frames/frame-999999.jpg',
      'audio/filter-graph.txt',
      'audio/mixed-normalized.wav',
    ].map(async (relativePath) => {
      const artifact = await hashRunArtifact(sourceRun, relativePath);
      return [relativePath, {path: artifact.path, sha256: artifact.sha256}] as const;
    })));
    const persistedOutputs = {
      mutedVideo: references.get('draft/muted-video.mp4')!,
      draftVideo: references.get('draft/draft.mp4')!,
      contactSheet: references.get('draft/contact-sheet.jpg')!,
      reviewFrames: [references.get('draft/frames/frame-999999.jpg')!],
      audio: {
        filterGraph: references.get('audio/filter-graph.txt')!,
        mixedAudio: references.get('audio/mixed-normalized.wav')!,
      },
      audioMixFingerprint: hash('audio-mix'),
    };
    await replaceRunText('source-run', 'draft/draft-report.json', `${JSON.stringify({
      version: 1,
      projectId: 'demo',
      outputs: persistedOutputs,
    })}\n`);
    const reportArtifact = await hashRunArtifact(sourceRun, 'draft/draft-report.json');
    const outputs = {
      ...persistedOutputs,
      report: {path: reportArtifact.path, sha256: reportArtifact.sha256},
    };
    const stage = createBoundDraftStage({
      readCompiledTimeline: async () => compiledTimeline(),
    });
    const report = passedStageReport({
      stageId: 'draft',
      runId: 'source-run',
      fingerprint: await stage.fingerprint(planningContext()),
      artifacts: [
        outputs.mutedVideo,
        outputs.draftVideo,
        outputs.contactSheet,
        ...outputs.reviewFrames,
        outputs.audio.filterGraph,
        outputs.audio.mixedAudio,
        outputs.report,
      ].map((artifact) => ({scope: 'run' as const, ...artifact})),
      outputs: JSON.parse(JSON.stringify({reportPath: 'draft/draft-report.json', outputs})),
    });

    await expect(stage.verify(planningContext(), report)).resolves.toBe(false);
  });

  it('rejects Draft fixed paths and duplicate review frames', async () => {
    const paths = [
      'draft/unexpected-muted.mp4',
      'draft/unexpected-contact.jpg',
      'draft/frames/frame-000001.jpg',
      'audio/unexpected-filter.txt',
      'audio/mixed-normalized.wav',
      'draft/draft-report.json',
    ];
    for (const relativePath of paths) await writeRunText(sourceRun, relativePath, relativePath);
    const references = new Map(await Promise.all(paths.map(async (relativePath) => {
      const artifact = await hashRunArtifact(sourceRun, relativePath);
      return [relativePath, {path: artifact.path, sha256: artifact.sha256}] as const;
    })));
    const existingDraftVideo = await hashRunArtifact(sourceRun, 'draft/draft.mp4');
    const frame = references.get('draft/frames/frame-000001.jpg')!;
    const outputs = {
      mutedVideo: references.get('draft/unexpected-muted.mp4')!,
      draftVideo: {path: existingDraftVideo.path, sha256: existingDraftVideo.sha256},
      contactSheet: references.get('draft/unexpected-contact.jpg')!,
      reviewFrames: [frame, frame],
      audio: {
        filterGraph: references.get('audio/unexpected-filter.txt')!,
        mixedAudio: references.get('audio/mixed-normalized.wav')!,
      },
      report: references.get('draft/draft-report.json')!,
      audioMixFingerprint: hash('audio-mix'),
    };
    const artifacts = [
      outputs.mutedVideo,
      outputs.draftVideo,
      outputs.contactSheet,
      ...outputs.reviewFrames,
      outputs.audio.filterGraph,
      outputs.audio.mixedAudio,
      outputs.report,
    ];
    const report = passedStageReport({
      stageId: 'draft',
      artifacts: artifacts.map((artifact) => ({scope: 'run' as const, ...artifact})),
      outputs: {reportPath: 'draft/draft-report.json', outputs},
    });

    await expect(createDraftStage().verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('rejects Release output paths belonging to another Run', async () => {
    await writeRunText(sourceRun, 'release/muted-video.mp4', 'muted');
    await writeRunText(sourceRun, 'release/final-intermediate.mp4', 'intermediate');
    const mutedVideo = await hashRunArtifact(sourceRun, 'release/muted-video.mp4');
    const intermediate = await hashRunArtifact(sourceRun, 'release/final-intermediate.mp4');
    const output = await createOutputStore(tempProject.workspaceRoot)
      .createRelease('demo', 'source-run');
    const outputReferences = {
      finalVideo: await writeOutputText(output, 'releases/other-run/final.mp4', 'final'),
      subtitles: await writeOutputText(output, 'releases/other-run/subtitles.srt', 'subtitles'),
      thumbnail: await writeOutputText(output, 'releases/other-run/thumbnail.jpg', 'thumbnail'),
      review: await writeOutputText(output, 'releases/other-run/review.json', 'review'),
      validationReport: await writeOutputText(
        output,
        'releases/other-run/validation-report.json',
        'validation',
      ),
      checksums: await writeOutputText(
        output,
        'releases/other-run/checksums.sha256',
        'checksums',
      ),
    };
    const outputs = {
      mutedVideo: {path: mutedVideo.path, sha256: mutedVideo.sha256},
      intermediate: {path: intermediate.path, sha256: intermediate.sha256},
      ...outputReferences,
      releaseFingerprint: hash('release'),
      verification: fixedReleaseVerification(outputReferences.finalVideo.sha256),
    };
    const report = passedStageReport({
      stageId: 'release',
      runId: 'source-run',
      artifacts: [
        mutedVideo,
        intermediate,
        ...Object.values(outputReferences).map((artifact) => ({scope: 'output' as const, ...artifact})),
      ],
      outputs,
    });

    await expect(createReleaseStage({
      openOutputDirectory: async () => output,
    }).verify(planningContext(), report)).resolves.toBe(false);
  });
});
