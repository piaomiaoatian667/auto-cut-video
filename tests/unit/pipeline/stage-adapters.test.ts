import {createHash} from 'node:crypto';
import {rename, rm, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ProjectInputs} from '../../../src/domain/load-project';
import {loadProject} from '../../../src/domain/load-project';
import type {Review} from '../../../src/domain/review-schema';
import type {CompiledTimeline} from '../../../src/domain/timeline-schema';
import {
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
import {narrationSegmentInputHash} from '../../../src/narration/build-narration';
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
import type {StageReport} from '../../../src/pipeline/stage-report';
import type {PreflightResult} from '../../../src/pipeline/stages/preflight';
import type {NarrationStageInput} from '../../../src/pipeline/stages/narration';
import type {DraftReport, DraftStageResult} from '../../../src/pipeline/stages/draft';
import {
  releaseStageFingerprint,
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

const draftReport = (overrides: Partial<DraftReport['outputs']> = {}): DraftReport => ({
  version: 1,
  projectId: 'demo',
  outputs: {
    contactSheet: {path: 'draft/contact-sheet.jpg', sha256: hash('contact-sheet')},
    reviewFrames: [{path: 'draft/frames/frame-000000.jpg', sha256: hash('frame-0')}],
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
  evidencePaths: ['draft/contact-sheet.jpg', 'draft/frames/frame-000000.jpg'],
  ...overrides,
});

const preflightResult = (overrides: Partial<PreflightResult> = {}): PreflightResult => ({
  checks: [],
  toolIdentities: {
    ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg')},
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

const writeOutputText = async (
  outputDirectory: OutputDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<{path: string; sha256: string}> => {
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
      narration: 'narration-stage-v1',
      compile: 'compile-stage-v1',
      draft: 'draft-stage-v1',
      review: 'review-stage-v1',
      release: 'release-stage-v1',
    });
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

  it('changes Ingest for profile and algorithm versions', async () => {
    const context = planningContext();
    expect(await createIngestStage({profile: {fps: 60}}).fingerprint(context))
      .not.toBe(await createIngestStage().fingerprint(context));
    expect(await createIngestStage({algorithmVersion: 'ingest-stage-v2'}).fingerprint(context))
      .not.toBe(await createIngestStage().fingerprint(context));
  });

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
      algorithmVersion: 'narration-stage-v2',
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
    const stage = createCompileStage({
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
    const stage = createCompileStage({hashProjectFile: async (_scope, path) => hash(path)});
    const reports = new Map(planningContext().sourceRun!.reports);
    const context = planningContext({}, reports);
    const before = await stage.fingerprint(context);
    reports.set(stageId, passedStageReport({stageId, fingerprint: hash(`${stageId}-2`)}));
    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it('changes Compile for registered component IDs and algorithm version', async () => {
    const context = planningContext();
    const dependencies = {hashProjectFile: async (_scope: unknown, path: string) => hash(path)};
    expect(await createCompileStage({...dependencies, componentIds: ['basic-title', 'other']})
      .fingerprint(context)).not.toBe(await createCompileStage(dependencies).fingerprint(context));
    expect(await createCompileStage({...dependencies, algorithmVersion: 'compile-stage-v2'})
      .fingerprint(context)).not.toBe(await createCompileStage(dependencies).fingerprint(context));
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
    const stage = createDraftStage();
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
    const baseline = await createDraftStage().fingerprint(context);
    const altered = structuredClone(context.project.project);
    mutate(altered);
    expect(baseline).not.toBe(await createDraftStage().fingerprint({
      ...context,
      project: {...context.project, project: altered},
    }));
  });

  it('changes Draft for Compile, audio-mix, and Stage algorithm versions', async () => {
    const reports = new Map(planningContext().sourceRun!.reports);
    const context = planningContext({}, reports);
    const before = await createDraftStage().fingerprint(context);
    reports.set('compile', passedStageReport({stageId: 'compile', fingerprint: hash('compile-2')}));
    expect(await createDraftStage().fingerprint(context)).not.toBe(before);
    expect(await createDraftStage({audioMixAlgorithmVersion: 'audio-mix-v2'}).fingerprint(context))
      .not.toBe(await createDraftStage().fingerprint(context));
    expect(await createDraftStage({algorithmVersion: 'draft-stage-v2'}).fingerprint(context))
      .not.toBe(await createDraftStage().fingerprint(context));
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
    });
    const context = planningContext();
    const before = await stage.fingerprint(context);
    report = changedDraft();
    expect(await stage.fingerprint(context)).not.toBe(before);
  });

  it('changes Release for Compile hashes, Review identity, Preflight environment, profile, and algorithm', async () => {
    let timeline = compiledTimeline();
    let review = approvedReview();
    const dependencies = {
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => timeline,
      readReview: async () => review,
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
    const reports = new Map(context.sourceRun!.reports);
    reports.set('preflight', preflightStageReport(preflightResult({
      environmentFingerprint: hash('persisted-environment-2'),
    })));
    expect(await stage.fingerprint({
      ...context,
      sourceRun: {...context.sourceRun!, reports},
    })).not.toBe(before);
    expect(await createReleaseStage({...dependencies, profile: {fps: 60}}).fingerprint(context))
      .not.toBe(before);
    expect(await createReleaseStage({...dependencies, algorithmVersion: 'release-stage-v2'})
      .fingerprint(context)).not.toBe(before);
  });

  it('changes Release for the qt-faststart environment fingerprint', async () => {
    const stage = createReleaseStage({
      readDraftReport: async () => draftReport(),
      readCompiledTimeline: async () => compiledTimeline(),
      readReview: async () => approvedReview(),
    });
    const context = planningContext();
    const changed = preflightResult({
      environmentFingerprint: hash('environment-with-new-qt-faststart'),
      toolIdentities: {
        ffmpeg: {realPath: '/tools/ffmpeg', sha256: hash('ffmpeg')},
        qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart-2')},
      },
    });
    const reports = new Map(context.sourceRun!.reports);
    reports.set('preflight', preflightStageReport(changed));
    expect(await stage.fingerprint({
      ...context,
      sourceRun: {...context.sourceRun!, reports},
    })).not.toBe(await stage.fingerprint(context));
  });

  it('uses persisted Preflight outputs for Release planning and execution', async () => {
    const sourcePersisted = preflightResult({
      environmentFingerprint: hash('source-persisted-environment'),
      toolIdentities: {
        ffmpeg: {realPath: '/persisted/source/ffmpeg', sha256: hash('source-ffmpeg')},
        qtFaststart: {realPath: '/persisted/source/qt-faststart', sha256: hash('source-qt')},
      },
    });
    const currentPersisted = preflightResult({
      environmentFingerprint: hash('current-persisted-environment'),
      toolIdentities: {
        ffmpeg: {realPath: '/persisted/current/ffmpeg', sha256: hash('current-ffmpeg')},
        qtFaststart: {realPath: '/persisted/current/qt-faststart', sha256: hash('current-qt')},
      },
    });
    const live = preflightResult({
      environmentFingerprint: hash('live-environment'),
      toolIdentities: {
        ffmpeg: {realPath: '/live/ffmpeg', sha256: hash('live-ffmpeg')},
        qtFaststart: {realPath: '/live/qt-faststart', sha256: hash('live-qt')},
      },
    });
    const draft = draftReport();
    const timeline = compiledTimeline();
    const review = approvedReview({runId: 'target-run'});
    const releaseResult: ReleaseStageResult = {
      outputs: {
        mutedVideo: {path: 'release/muted-video.mp4', sha256: hash('release-muted')},
        intermediate: {path: 'release/final-intermediate.mp4', sha256: hash('intermediate')},
        finalVideo: {path: 'releases/target-run/final.mp4', sha256: hash('final')},
        subtitles: {path: 'releases/target-run/subtitles.srt', sha256: hash('subtitles')},
        thumbnail: {path: 'releases/target-run/thumbnail.jpg', sha256: hash('thumbnail')},
        review: {path: 'releases/target-run/review.json', sha256: hash('review-output')},
        validationReport: {path: 'releases/target-run/validation-report.json', sha256: hash('validation')},
        checksums: {path: 'releases/target-run/checksums.sha256', sha256: hash('checksums')},
        releaseFingerprint: hash('release'),
        verification: {
          sha256: hash('final'),
          probe: {durationMs: 1000, videoStreams: [], audioStreams: []},
          moovBeforeMdat: true,
          atoms: [],
        },
      },
      current: {
        runId: 'target-run',
        relativePath: 'releases/target-run',
        preset: 'release',
        stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
        completedStage: 'release',
        state: 'passed',
        publishedAt: '2026-08-11T01:02:03.000Z',
      },
    };
    const executeRelease = vi.fn(async () => releaseResult);
    const stage = createReleaseStage({
      readDraftReport: async () => draft,
      readCompiledTimeline: async () => timeline,
      readReview: async () => review,
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
    expect(await stage.fingerprint(planning)).toBe(releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      review,
      preflightEnvironmentFingerprint: sourcePersisted.environmentFingerprint,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    }));

    await writeRunText(targetRun, 'reports/preflight.json', `${JSON.stringify({
      ...preflightStageReport(currentPersisted),
      runId: 'target-run',
    })}\n`);
    const result = await stage.execute(executionContext({preflight: live}), new AbortController().signal);
    expect(executeRelease).toHaveBeenCalledWith(expect.objectContaining({
      preflight: {
        toolIdentities: currentPersisted.toolIdentities,
        environmentFingerprint: currentPersisted.environmentFingerprint,
      },
    }), {publishCurrent: false});
    expect(result.fingerprint).toBe(releaseStageFingerprint({
      draft: draft.outputs,
      compileInputHashes: timeline.inputHashes,
      review,
      preflightEnvironmentFingerprint: currentPersisted.environmentFingerprint,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
    }));
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
    const narrationPath = `audio/narration-${hash('manifest').slice(7, 23)}.wav`;
    const draftResult: DraftStageResult = {
      reportPath: 'draft/draft-report.json',
      outputs: {
        mutedVideo: {path: 'draft/muted-video.mp4', sha256: hash('muted')},
        draftVideo: {path: 'draft/draft.mp4', sha256: hash('draft')},
        contactSheet: {path: 'draft/contact-sheet.jpg', sha256: hash('contact')},
        reviewFrames: [{path: 'draft/frames/frame-000000.jpg', sha256: hash('frame')}],
        audio: {
          filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('graph')},
          mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed')},
        },
        report: {path: 'draft/draft-report.json', sha256: hash('draft-report')},
        audioMixFingerprint: hash('audio-mix'),
      },
    };
    const releaseResult: ReleaseStageResult = {
      outputs: {
        mutedVideo: {path: 'release/muted-video.mp4', sha256: hash('release-muted')},
        intermediate: {path: 'release/final-intermediate.mp4', sha256: hash('intermediate')},
        finalVideo: {path: 'releases/target-run/final.mp4', sha256: hash('final')},
        subtitles: {path: 'releases/target-run/subtitles.srt', sha256: hash('subtitles')},
        thumbnail: {path: 'releases/target-run/thumbnail.jpg', sha256: hash('thumbnail')},
        review: {path: 'releases/target-run/review.json', sha256: hash('review-output')},
        validationReport: {path: 'releases/target-run/validation-report.json', sha256: hash('validation')},
        checksums: {path: 'releases/target-run/checksums.sha256', sha256: hash('checksums')},
        releaseFingerprint: hash('release'),
        verification: {
          sha256: hash('final'),
          probe: {durationMs: 1000, videoStreams: [], audioStreams: []},
          moovBeforeMdat: true,
          atoms: [],
        },
      },
      current: {
        runId: 'target-run',
        relativePath: 'releases/target-run',
        preset: 'release',
        stageIds: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
        completedStage: 'release',
        state: 'passed',
        publishedAt: '2026-08-11T01:02:03.000Z',
      },
    };
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
            segments: [{
              id: 'intro',
              inputHash: narrationInputHash,
              audioPath: 'audio/segments/0001-intro.wav',
              audioHash: hash('segment'),
              startMs: 0,
              endMs: 1000,
              durationMs: 1000,
              pauseAfterMs: 300,
              sampleRate: 48_000,
              channels: 1,
              providerFingerprint: hash('provider'),
            }],
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
        readStageReport: async (_runDirectory, stageId) => passedStageReport({
          stageId,
          fingerprint: hash(`${stageId}-report`),
        }),
        runCompile: async () => ({timelinePath: 'compiled-timeline.json', timeline: compiledTimeline()}),
        hashRunArtifact: fakeArtifact,
      }),
      createDraftStage({
        readStageReport: async () => passedStageReport({
          stageId: 'compile',
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
        readReview: async () => approvedReview({runId: 'target-run'}),
        runRelease: runReleaseAdapter,
      }),
    ];

    const expected = new Map<string, string[]>([
      ['preflight', []],
      ['ingest', ['asset-manifest.json', 'assets/clip/render.mp4']],
      ['narration', [
        `audio/cache/${narrationInputHash.slice('sha256:'.length)}.wav`,
        'audio/segments/0001-intro.wav',
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
        'draft/frames/frame-000000.jpg',
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
      const result = await stage.execute(executionContext(), new AbortController().signal);
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
      {publishCurrent: false},
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
        reviewFrames: [{path: 'draft/frames/frame-000007.jpg', sha256: hash('frame-7')}],
        audio: {
          filterGraph: {path: 'audio/filter-graph.txt', sha256: hash('graph')},
          mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: hash('mixed')},
        },
        report: {path: 'draft/draft-report.json', sha256: hash('draft-report')},
        audioMixFingerprint: hash('audio-mix'),
      },
    };
    const draft = createDraftStage({
      readStageReport: async () => passedStageReport({
        stageId: 'compile',
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
      {scope: 'run', path: 'draft/frames/frame-000007.jpg'},
    ]));
  });
});

describe('adapter verification', () => {
  const releaseVerificationFixture = async () => {
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
      'subtitles',
    );
    const thumbnail = await writeOutputText(
      outputDirectory,
      'releases/source-run/thumbnail.jpg',
      'thumbnail',
    );
    const review = await writeOutputText(
      outputDirectory,
      'releases/source-run/review.json',
      'review',
    );
    const validationReport = await writeOutputText(
      outputDirectory,
      'releases/source-run/validation-report.json',
      'validation',
    );
    const checksums = await writeOutputText(
      outputDirectory,
      'releases/source-run/checksums.sha256',
      'checksums',
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
      releaseFingerprint: hash('release'),
      verification: {
        sha256: finalVideo.sha256,
        probe: {durationMs: 1000, videoStreams: [], audioStreams: []},
        moovBeforeMdat: true as const,
        atoms: [],
      },
    };
    const report = passedStageReport({
      stageId: 'release',
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
    return {report, finalVideo};
  };

  it('returns false for missing, changed, and cross-scope Run artifacts', async () => {
    await writeRunText(sourceRun, 'compiled-timeline.json', '{}\n');
    const artifact = await hashRunArtifact(sourceRun, 'compiled-timeline.json');
    const baseReport = passedStageReport({
      stageId: 'compile',
      artifacts: [artifact],
      outputs: JSON.parse(JSON.stringify({
        timelinePath: 'compiled-timeline.json',
        timeline: compiledTimeline(),
      })),
    });
    const stage = createCompileStage({hashProjectFile: async (_scope, path) => hash(path)});
    await expect(stage.verify(planningContext(), baseReport)).resolves.toBe(true);
    await expect(stage.verify(planningContext(), {
      ...baseReport,
      artifacts: [{...artifact, path: 'missing.json'}],
    })).resolves.toBe(false);
    await expect(stage.verify(planningContext(), {
      ...baseReport,
      artifacts: [{...artifact, sha256: hash('changed')}],
    })).resolves.toBe(false);
    await expect(stage.verify(planningContext(), {
      ...baseReport,
      artifacts: [{...artifact, scope: 'output'}],
    })).resolves.toBe(false);
  });

  it('returns false when a Run artifact becomes a cross-scope symlink', async () => {
    await writeRunText(sourceRun, 'compiled-timeline.json', '{}\n');
    const artifact = await hashRunArtifact(sourceRun, 'compiled-timeline.json');
    const report = passedStageReport({
      stageId: 'compile',
      artifacts: [artifact],
      outputs: JSON.parse(JSON.stringify({
        timelinePath: 'compiled-timeline.json',
        timeline: compiledTimeline(),
      })),
    });
    const artifactPath = path.join(
      tempProject.workspaceRoot,
      '.work',
      'demo',
      'runs',
      'source-run',
      'compiled-timeline.json',
    );
    const outsidePath = path.join(tempProject.workspaceRoot, 'outside-timeline.json');
    await writeFile(outsidePath, '{}\n', 'utf8');
    await rm(artifactPath);
    await symlink(outsidePath, artifactPath);

    const stage = createCompileStage({hashProjectFile: async (_scope, path) => hash(path)});
    await expect(stage.verify(planningContext(), report)).resolves.toBe(false);
  });

  it('returns false when a Release output artifact becomes a cross-scope symlink', async () => {
    const {report, finalVideo} = await releaseVerificationFixture();
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

    await expect(createReleaseStage().verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('returns false when the Release output project root becomes cross-scope', async () => {
    const {report} = await releaseVerificationFixture();
    const outputRoot = path.join(tempProject.workspaceRoot, 'output', 'demo');
    const movedOutputRoot = path.join(tempProject.workspaceRoot, 'escaped-output-demo');
    await rename(outputRoot, movedOutputRoot);
    await symlink(movedOutputRoot, outputRoot);

    await expect(createReleaseStage().verify(planningContext(), report))
      .resolves.toBe(false);
  });

  it('does not swallow unrelated Release output I/O errors', async () => {
    const {report} = await releaseVerificationFixture();
    const failure = Object.assign(new Error('injected output I/O failure'), {code: 'EIO'});
    const stage = createReleaseStage({
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
      verification: {
        sha256: finalVideo.sha256,
        probe: {durationMs: 1000, videoStreams: [], audioStreams: []},
        moovBeforeMdat: true,
        atoms: [],
      },
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
    await writeRunText(sourceRun, 'draft/contact-sheet.jpg', 'contact-sheet');
    await writeRunText(sourceRun, 'draft/frames/frame-000000.jpg', 'review-frame');
    const contactSheet = await hashRunArtifact(sourceRun, 'draft/contact-sheet.jpg');
    const reviewFrame = await hashRunArtifact(sourceRun, 'draft/frames/frame-000000.jpg');
    const draft = draftReport({
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
        evidence: [draft.outputs.contactSheet, ...draft.outputs.reviewFrames],
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
  }: {
    sourceProject: ProjectInputs;
    currentProject: ProjectInputs;
    sourcePreflight: PreflightResult;
    currentPreflight: PreflightResult;
    sourceProviderFingerprint: string;
    currentProviderFingerprint: string;
    injectedProviderFingerprint?: string;
  }) => {
    const seedNarrationCache = vi.fn(async () => [] as string[]);
    const runNarration = vi.fn(async (_input: NarrationStageInput) => ({
      narrationPath: 'narration-manifest.json' as const,
      captionsPath: 'captions.json' as const,
      srtPath: 'captions.srt' as const,
      narration: {
        version: 1 as const,
        provider: currentProject.project.tts.provider,
        segments: [],
        master: {audioPath: 'audio/narration.wav', audioHash: hash('master'), durationMs: 1000},
      },
      captions: {version: 1 as const, sourceNarrationHash: hash('master'), cues: []},
    }));
    let providerFingerprint = sourceProviderFingerprint;
    const injectedFingerprint = vi.fn(async () => injectedProviderFingerprint);
    const stage = createNarrationStage({
      fingerprintTtsProvider: async () => providerFingerprint,
      createTtsProvider: () => ({
        id: currentProject.project.tts.provider,
        capabilities: async () => ({languages: ['zh-CN'], voices: ['fixture']}),
        fingerprint: injectedFingerprint,
        synthesize: async () => ({outputPath: 'unused', providerFingerprint: injectedProviderFingerprint}),
      } satisfies TtsProvider),
      seedNarrationCache,
      runNarration,
      hashRunArtifact: fakeArtifact,
    });
    const sourceCompatibility = narrationReuseCompatibilityFingerprint({
      tts: sourceProject.project.tts,
      providerFingerprint: sourceProviderFingerprint,
      ffmpegIdentity: sourcePreflight.toolIdentities.ffmpeg,
      algorithmVersion: STAGE_ALGORITHM_VERSIONS.narration,
    });
    const sourceFingerprint = await stage.fingerprint({
      project: sourceProject,
      sourceCatalog: sourceCatalog(),
      preflight: sourcePreflight,
    });
    const sourceNarrationReport = passedStageReport({
      stageId: 'narration',
      fingerprint: sourceFingerprint,
      outputs: {reuseCompatibilityFingerprint: sourceCompatibility},
    });
    providerFingerprint = currentProviderFingerprint;
    const context = executionContext({
      project: currentProject,
      preflight: currentPreflight,
      sourceRun: {
        runId: 'source-run',
        runDirectory: sourceRun,
        reports: new Map([['narration', sourceNarrationReport]]),
      },
    });
    await stage.execute(context, new AbortController().signal);
    return {seedNarrationCache, runNarration, injectedFingerprint};
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
          qtFaststart: {realPath: '/tools/qt-faststart', sha256: hash('qt-faststart')},
        },
      }),
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
    const fileProject = {...project, project: fileProjectValue};
    const providerFingerprint = hash('file-provider');
    const result = await executeCase({
      sourceProject: fileProject,
      currentProject: {...fileProject, script: createScriptFixture('changed script')},
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
    expect(result.seedNarrationCache).toHaveBeenCalledWith(expect.objectContaining({
      providerFingerprint: canonicalFingerprint,
    }));
    const executionInput = result.runNarration.mock.calls[0]?.[0];
    expect(executionInput).toBeDefined();
    await expect(executionInput!.provider.fingerprint()).resolves.toBe(canonicalFingerprint);
  });
});
