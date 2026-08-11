import {createHash} from 'node:crypto';
import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
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
import type {ReleaseVerificationReport} from '../../../src/media/release-verify';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {STAGE_ALGORITHM_VERSIONS} from '../../../src/pipeline/stage-adapters';
import type {PipelineStage} from '../../../src/pipeline/stage';
import type {
  CurrentPointer,
  OutputStore,
  RunStore,
  StageId,
} from '../../../src/pipeline/run-store';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import type {StageReport, StageReportStore} from '../../../src/pipeline/stage-report';
import type {DraftReport} from '../../../src/pipeline/stages/draft';
import type {PreflightResult} from '../../../src/pipeline/stages/preflight';
import {
  buildReleaseValidationReport,
  formatReleaseChecksums,
  releaseChecksumArtifacts,
  releaseOutputPath,
  releaseSrtFromTimeline,
  releaseStageFingerprint,
  type ReleaseStageOutputs,
} from '../../../src/pipeline/stages/release';
import {passedStageReport} from '../../helpers/pipeline-fixtures';
import {createTempProject} from '../../helpers/temp-project';

const STAGE_IDS = [
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
  'review',
  'release',
] as const satisfies readonly StageId[];

const hash = (value: unknown): string => fingerprintValue(value);

const contentHash = (value: string): string =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`;

const writeRunText = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<{path: string; sha256: string}> => {
  const parent = relativePath.split('/').slice(0, -1).join('/');
  if (parent.length > 0) await ensureRunDirectory(runDirectory, parent);
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {path: relativePath, sha256: contentHash(contents)};
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

const compiledTimeline = (): CompiledTimeline => ({
  version: 1,
  projectId: 'demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 30,
  inputHashes: {'authoring:project': hash('project')},
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

const preflightResult = (): PreflightResult => ({
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
});

const releaseVerification = (sha256: string): ReleaseVerificationReport => ({
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
});

interface CompletedReleaseFixture {
  draft: DraftReport;
  preflight: PreflightResult;
  reports: ReadonlyMap<StageId, StageReport>;
  review: Review;
  sourceCatalog: ProjectSourceCatalog;
  timeline: CompiledTimeline;
}

const prepareCompletedRelease = async (
  workspaceRoot: string,
): Promise<CompletedReleaseFixture> => {
  const runId = 'release-run';
  const runStore = createRunStore(workspaceRoot);
  const outputStore = createOutputStore(workspaceRoot);
  const runDirectory = await runStore.createRun('demo', runId);
  const outputDirectory = await outputStore.createRelease('demo', runId);
  const draftVideo = await writeRunText(
    runDirectory,
    'draft/draft.mp4',
    'draft-video',
  );
  const contactSheet = await writeRunText(
    runDirectory,
    'draft/contact-sheet.jpg',
    'contact-sheet',
  );
  const reviewFrame = await writeRunText(
    runDirectory,
    'draft/frames/frame-000000.jpg',
    'review-frame',
  );
  const filterGraph = await writeRunText(
    runDirectory,
    'audio/filter-graph.txt',
    'anull\n',
  );
  const mixedAudio = await writeRunText(
    runDirectory,
    'audio/mixed-normalized.wav',
    'mixed-audio',
  );
  const mutedVideo = await writeRunText(
    runDirectory,
    'release/muted-video.mp4',
    'muted-video',
  );
  const intermediate = await writeRunText(
    runDirectory,
    'release/final-intermediate.mp4',
    'intermediate',
  );
  const draft: DraftReport = {
    version: 1,
    projectId: 'demo',
    outputs: {
      draftVideo,
      contactSheet,
      reviewFrames: [reviewFrame],
      audio: {filterGraph, mixedAudio},
      audioMixFingerprint: hash('audio-mix'),
    },
  };
  const timeline = compiledTimeline();
  const review: Review = {
    version: 1,
    projectId: 'demo',
    runId,
    status: 'approved',
    reviewer: 'reviewer',
    reviewedAt: '2026-08-11T01:02:03.000Z',
    reason: 'approved',
    evidencePaths: [draftVideo.path, contactSheet.path, reviewFrame.path],
  };
  const preflight = preflightResult();
  const compileFingerprint = hash('compile-report');
  const releaseFingerprint = releaseStageFingerprint({
    draft: draft.outputs,
    compileInputHashes: timeline.inputHashes,
    compileStageFingerprint: compileFingerprint,
    compiledTimeline: timeline,
    review,
    preflightEnvironmentFingerprint: preflight.environmentFingerprint,
    algorithmVersion: STAGE_ALGORITHM_VERSIONS.release,
  });
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
  const outputReview = await writeOutputText(
    outputDirectory,
    releaseOutputPath(runId, 'review.json'),
    `${JSON.stringify(review, null, 2)}\n`,
  );
  const verification = releaseVerification(finalVideo.sha256);
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
      review: outputReview,
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
      review: outputReview,
      validationReport,
    })),
  );
  const releaseOutputs: ReleaseStageOutputs = {
    mutedVideo,
    intermediate,
    finalVideo,
    subtitles,
    thumbnail,
    review: outputReview,
    validationReport,
    checksums,
    releaseFingerprint,
    verification,
  };
  const reports = new Map<StageId, StageReport>();
  for (const stageId of STAGE_IDS) {
    reports.set(stageId, passedStageReport({
      stageId,
      runId,
      fingerprint: stageId === 'compile'
        ? compileFingerprint
        : stageId === 'release'
          ? releaseFingerprint
          : hash(`${stageId}-report`),
      artifacts: [],
      outputs: stageId === 'preflight'
        ? JSON.parse(JSON.stringify(preflight))
        : {},
    }));
  }
  reports.set('release', passedStageReport({
    stageId: 'release',
    runId,
    fingerprint: releaseFingerprint,
    artifacts: [
      {scope: 'run', ...mutedVideo},
      {scope: 'run', ...intermediate},
      {scope: 'output', ...finalVideo},
      {scope: 'output', ...subtitles},
      {scope: 'output', ...thumbnail},
      {scope: 'output', ...outputReview},
      {scope: 'output', ...validationReport},
      {scope: 'output', ...checksums},
    ],
    outputs: JSON.parse(JSON.stringify(releaseOutputs)),
  }));
  const publishedAt = '2026-08-11T01:02:04.000Z';
  const current: Omit<CurrentPointer, 'relativePath'> = {
    runId,
    preset: 'release',
    stageIds: [...STAGE_IDS],
    completedStage: 'release',
    state: 'passed',
    publishedAt,
  };
  await runStore.publishCurrent('demo', {
    ...current,
    relativePath: `runs/${runId}`,
  });
  await outputStore.publishCurrent('demo', {
    ...current,
    relativePath: `releases/${runId}`,
  });
  return {
    draft,
    preflight,
    reports,
    review,
    sourceCatalog: {
      assets: [],
      totalBytes: 0,
      fingerprint: hash('source-catalog'),
    },
    timeline,
  };
};

const installForbiddenPlanEffects = () => {
  const forbiddenWrites = vi.fn(async (): Promise<never> => {
    throw new Error('plan mode attempted a filesystem mutation');
  });
  const forbiddenProcesses = vi.fn(async (): Promise<never> => {
    throw new Error('plan mode attempted a subprocess');
  });
  const forbiddenLocks = vi.fn(async (): Promise<never> => {
    throw new Error('plan mode attempted a project lock');
  });

  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      link: forbiddenWrites,
      mkdir: forbiddenWrites,
      rename: forbiddenWrites,
      unlink: forbiddenWrites,
      writeFile: forbiddenWrites,
    };
  });
  vi.doMock('../../../src/process/run-process', async () => {
    const actual = await vi.importActual<
      typeof import('../../../src/process/run-process')
    >('../../../src/process/run-process');
    return {...actual, runProcess: forbiddenProcesses};
  });
  vi.doMock('../../../src/pipeline/project-lock', async () => {
    const actual = await vi.importActual<
      typeof import('../../../src/pipeline/project-lock')
    >('../../../src/pipeline/project-lock');
    return {...actual, acquireProjectLock: forbiddenLocks};
  });

  return {forbiddenLocks, forbiddenProcesses, forbiddenWrites};
};

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('../../../src/process/run-process');
  vi.doUnmock('../../../src/pipeline/project-lock');
  vi.resetModules();
});

describe('Execution Plan side effects', () => {
  it('builds a Release plan without writes, locks, subprocesses, or directories', async () => {
    const fixture = await createTempProject();
    const {forbiddenLocks, forbiddenProcesses, forbiddenWrites}
      = installForbiddenPlanEffects();

    try {
      const [
        {loadProject},
        {buildExecutionPlan},
        {MVP_STAGES},
        {createStageReportStore},
        scopes,
      ] = await Promise.all([
        import('../../../src/domain/load-project'),
        import('../../../src/pipeline/execution-plan'),
        import('../../../src/pipeline/stage-registry'),
        import('../../../src/pipeline/stage-report'),
        import('../../../src/fs/app-directory-scopes'),
      ]);
      const project = await loadProject(fixture.workspaceRoot, 'demo');
      const actualRunStore = scopes.createRunStore(fixture.workspaceRoot);
      const actualOutputStore = scopes.createOutputStore(fixture.workspaceRoot);
      const runStore = new Proxy(actualRunStore, {
        get(target, property, receiver) {
          if (['createWork', 'createRun', 'readCurrent', 'publishCurrent'].includes(
            String(property),
          )) return forbiddenWrites;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as RunStore;
      const outputStore = new Proxy(actualOutputStore, {
        get(target, property, receiver) {
          if (['openProject', 'createRelease', 'readCurrent', 'publishCurrent'].includes(
            String(property),
          )) return forbiddenWrites;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as OutputStore;

      const plan = await buildExecutionPlan({
        project,
        sourceCatalog: {
          assets: [],
          totalBytes: 0,
          fingerprint: `sha256:${'a'.repeat(64)}`,
        },
        registry: MVP_STAGES,
        runStore,
        outputStore,
        reportStore: createStageReportStore(),
        createRunId: () => 'plan-run',
      }, {preset: 'release'});

      expect(plan).toMatchObject({
        runMode: 'new',
        items: expect.arrayContaining([
          expect.objectContaining({stageId: 'preflight', action: 'run'}),
        ]),
      });
      expect(forbiddenWrites).not.toHaveBeenCalled();
      expect(forbiddenProcesses).not.toHaveBeenCalled();
      expect(forbiddenLocks).not.toHaveBeenCalled();
      await expect(lstat(path.join(fixture.workspaceRoot, '.work')))
        .rejects.toMatchObject({code: 'ENOENT'});
      await expect(lstat(path.join(fixture.workspaceRoot, 'output')))
        .rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await fixture.cleanup();
    }
  });

  it('verifies a completed Release without mutating Output state', async () => {
    const fixture = await createTempProject();
    const completed = await prepareCompletedRelease(fixture.workspaceRoot);
    const {forbiddenLocks, forbiddenProcesses, forbiddenWrites}
      = installForbiddenPlanEffects();

    try {
      const [
        {loadProject},
        {buildExecutionPlan},
        {createReleaseStage},
        scopes,
      ] = await Promise.all([
        import('../../../src/domain/load-project'),
        import('../../../src/pipeline/execution-plan'),
        import('../../../src/pipeline/stage-adapters'),
        import('../../../src/fs/app-directory-scopes'),
      ]);
      const project = await loadProject(fixture.workspaceRoot, 'demo');
      const actualRunStore = scopes.createRunStore(fixture.workspaceRoot);
      const actualOutputStore = scopes.createOutputStore(fixture.workspaceRoot);
      const runStore = new Proxy(actualRunStore, {
        get(target, property, receiver) {
          if (['createWork', 'createRun', 'readCurrent', 'publishCurrent'].includes(
            String(property),
          )) return forbiddenWrites;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as RunStore;
      const outputStore = new Proxy(actualOutputStore, {
        get(target, property, receiver) {
          if (['openProject', 'createRelease', 'readCurrent', 'publishCurrent'].includes(
            String(property),
          )) return forbiddenWrites;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as OutputStore;
      const releaseStage = createReleaseStage({
        readDraftReport: async () => completed.draft,
        readCompiledTimeline: async () => completed.timeline,
        readReview: async () => completed.review,
        readStageReport: async (_runDirectory, stageId) => (
          completed.reports.get(stageId) ?? null
        ),
      });
      const releaseVerify = vi.fn(releaseStage.verify.bind(releaseStage));
      const registry: PipelineStage[] = STAGE_IDS.map((stageId) => {
        if (stageId === 'release') return {...releaseStage, verify: releaseVerify};
        return {
          id: stageId,
          displayName: stageId,
          prerequisites: [],
          fingerprint: async () => completed.reports.get(stageId)!.fingerprint,
          verify: async () => true,
          partialArtifacts: () => [],
          execute: async () => {
            throw new Error('plan mode attempted Stage execution');
          },
        };
      });
      const reportStore = {
        readStage: async (
          _runDirectory: RunDirectoryScope,
          stageId: StageId,
        ) => (
          completed.reports.get(stageId) ?? null
        ),
        writeStage: forbiddenWrites,
        writeAttempt: forbiddenWrites,
      } as unknown as StageReportStore;
      const createRunId = vi.fn(() => 'unused-plan-run');

      const plan = await buildExecutionPlan({
        project,
        sourceCatalog: completed.sourceCatalog,
        registry,
        runStore,
        outputStore,
        reportStore,
        createRunId,
      }, {
        preset: 'release',
        from: 'release',
        to: 'release',
      });

      expect(plan).toMatchObject({
        runMode: 'noop',
        sourceRunId: 'release-run',
        targetRunId: 'release-run',
        items: [expect.objectContaining({
          stageId: 'release',
          action: 'cached',
          materialize: false,
        })],
      });
      expect(releaseVerify).toHaveBeenCalledOnce();
      expect(createRunId).not.toHaveBeenCalled();
      expect(forbiddenWrites).not.toHaveBeenCalled();
      expect(forbiddenProcesses).not.toHaveBeenCalled();
      expect(forbiddenLocks).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });
});
