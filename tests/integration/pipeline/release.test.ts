import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import {ReviewSchema} from '../../../src/domain/review-schema';
import type {CompiledTimeline} from '../../../src/domain/timeline-schema';
import {
  createOutputStore,
  createRunStore,
  ensureRunDirectory,
  openExistingOutputFile,
  openExistingRunFile,
  openNewRunFile,
  openNewRunReadWriteFile,
  type CurrentPointer,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {parseTopLevelMp4Atoms, assertMoovBeforeMdat} from '../../../src/media/release-verify';
import {DraftReportSchema} from '../../../src/pipeline/stages/draft';
import {
  releaseStageFingerprint,
  runRelease,
  type ReleasePreflightSnapshot,
} from '../../../src/pipeline/stages/release';
import {runProcess, type RunProcessOptions, type ProcessResult} from '../../../src/process/run-process';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
  createTempProject,
  type TempProject,
} from '../../helpers/temp-project';

const FFMPEG = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe';
const QT_FASTSTART = process.env.QT_FASTSTART_PATH ?? '/opt/homebrew/bin/qt-faststart';

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const writeRunText = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<string> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  return sha256(contents);
};

const writeRunAudio = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => {
  await ensureRunDirectory(runDirectory, path.posix.dirname(relativePath));
  const handle = await openNewRunReadWriteFile(runDirectory, relativePath);
  try {
    await runProcess(FFMPEG, [
      '-v', 'error',
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
      '-map', '0:a:0',
      '-c:a', 'pcm_s16le',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'wav',
      '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    await handle.sync();
  } finally {
    await handle.close();
  }
  return await hashRunFile(runDirectory, relativePath);
};

const writeRunJpeg = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => {
  await ensureRunDirectory(runDirectory, path.posix.dirname(relativePath));
  const handle = await openNewRunReadWriteFile(runDirectory, relativePath);
  try {
    await runProcess(FFMPEG, [
      '-v', 'error',
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=blue:s=960x540:d=0.1',
      '-frames:v', '1',
      '-f', 'image2',
      '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    await handle.sync();
  } finally {
    await handle.close();
  }
  return await hashRunFile(runDirectory, relativePath);
};

const hashRunFile = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    return sha256(await handle.readFile());
  } finally {
    await handle.close();
  }
};

const readRunFile = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<Buffer> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const readOutputFile = async (workspaceRoot: string, relativePath: string): Promise<Buffer> => {
  const output = await createOutputStore(workspaceRoot).openProject('demo');
  const handle = await openExistingOutputFile(output, relativePath);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const readOutputText = async (workspaceRoot: string, relativePath: string): Promise<string> =>
  (await readOutputFile(workspaceRoot, relativePath)).toString('utf8');

const compiledTimeline = (): CompiledTimeline => ({
  version: 1,
  projectId: 'demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 30,
  inputHashes: {'asset:clip': 'sha256:clip', 'asset:music': 'sha256:music'},
  visualClips: [],
  overlays: [],
  captions: [{id: 'caption-intro', segmentId: 'intro', text: '介绍', startFrame: 0, endFrame: 30}],
  narration: {
    audioPath: 'audio/narration.wav',
    durationMs: 1000,
    intervals: [{segmentId: 'intro', startMs: 0, endMs: 1000}],
  },
  backgroundMusic: {renderPath: 'assets/source/music.wav', startMs: 0, durationMs: 1000},
});

const preflight = (): ReleasePreflightSnapshot => ({
  toolIdentities: {
    ffmpeg: {realPath: FFMPEG, sha256: 'sha256:ffmpeg'},
    ffprobe: {realPath: FFPROBE, sha256: 'sha256:ffprobe'},
    qtFaststart: {realPath: QT_FASTSTART, sha256: 'sha256:qt-faststart'},
  },
  environmentFingerprint: 'sha256:environment',
});

const pointer = (runId: string, publishedAt = '2026-08-10T00:00:00.000Z'): CurrentPointer => ({
  runId,
  relativePath: `releases/${runId}`,
  preset: 'release' as const,
  stageIds: [
    'preflight',
    'ingest',
    'narration',
    'compile',
    'draft',
    'review',
    'release',
  ],
  completedStage: 'release' as const,
  state: 'passed' as const,
  publishedAt,
});

const prepareReleaseRun = async ({
  includeAudioMixFingerprint = true,
}: {
  includeAudioMixFingerprint?: boolean;
} = {}) => {
  const tempProject = await createTempProject({
    project: createProjectFixture('demo'),
    script: createScriptFixture('介绍'),
    edit: createEditFixture(),
  });
  tempProjects.push(tempProject);
  const project = await loadProject(tempProject.workspaceRoot, 'demo');
  const runDirectory = await createRunStore(tempProject.workspaceRoot).createRun('demo', 'run-release');
  await writeRunText(runDirectory, 'compiled-timeline.json', `${JSON.stringify(compiledTimeline(), null, 2)}\n`);
  await writeRunText(runDirectory, 'captions.srt', '1\n00:00:00,000 --> 00:00:01,000\n介绍\n');
  const filterGraphSha = await writeRunText(runDirectory, 'audio/filter-graph.txt', 'anull\n');
  const mixedAudioSha = await writeRunAudio(runDirectory, 'audio/mixed-normalized.wav');
  const contactSheetSha = await writeRunJpeg(runDirectory, 'draft/contact-sheet.jpg');
  const reviewFrameSha = await writeRunJpeg(runDirectory, 'draft/review-frames/frame-000000.jpg');
  await writeRunText(runDirectory, 'draft/draft-report.json', `${JSON.stringify({
    version: 1,
    projectId: 'demo',
    outputs: {
      contactSheet: {path: 'draft/contact-sheet.jpg', sha256: contactSheetSha},
      reviewFrames: [{path: 'draft/review-frames/frame-000000.jpg', sha256: reviewFrameSha}],
      audio: {
        filterGraph: {path: 'audio/filter-graph.txt', sha256: filterGraphSha},
        mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: mixedAudioSha},
      },
      ...(includeAudioMixFingerprint
        ? {audioMixFingerprint: 'sha256:audio-mix'}
        : {}),
    },
  }, null, 2)}\n`);
  await writeRunText(runDirectory, 'review.json', `${JSON.stringify({
    version: 1,
    projectId: 'demo',
    runId: 'run-release',
    status: 'approved',
    reviewer: 'codex',
    reviewedAt: '2026-08-10T00:00:00.000Z',
    reason: '视觉复核通过',
    evidencePaths: ['draft/contact-sheet.jpg', 'draft/review-frames/frame-000000.jpg'],
  }, null, 2)}\n`);
  return {tempProject, project, runDirectory};
};

const renderFinalVideo = async ({outputLocation}: {outputLocation: string}): Promise<void> => {
  await runProcess(FFMPEG, [
    '-v', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', 'color=c=red:s=1920x1080:r=30:d=1',
    '-an',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', '30',
    outputLocation,
  ]);
};

describe('runRelease', () => {
  it('parses the legacy Draft report shape without an audio-mix fingerprint', () => {
    expect(DraftReportSchema.parse({
      version: 1,
      projectId: 'demo',
      outputs: {
        contactSheet: {path: 'draft/contact-sheet.jpg', sha256: sha256('contact')},
        reviewFrames: [{path: 'draft/frame.jpg', sha256: sha256('frame')}],
        audio: {
          filterGraph: {path: 'audio/filter-graph.txt', sha256: sha256('graph')},
          mixedAudio: {path: 'audio/mixed-normalized.wav', sha256: sha256('mixed')},
        },
      },
    }).outputs.audioMixFingerprint).toBeUndefined();
  });

  it('packages a legacy Draft report without rewriting Draft audio artifacts', async () => {
    const {tempProject, project, runDirectory} = await prepareReleaseRun({
      includeAudioMixFingerprint: false,
    });
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    await outputStore.createRelease('demo', 'run-old');
    await outputStore.publishCurrent('demo', pointer('run-old'));
    const oldCurrent = await readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json'));
    const filterGraphBefore = await readRunFile(runDirectory, 'audio/filter-graph.txt');
    const mixedAudioBefore = await readRunFile(runDirectory, 'audio/mixed-normalized.wav');
    const calls: Array<{command: string; args: string[]; fdCount: number}> = [];
    const recordingRunner = async (
      command: string,
      args: readonly string[],
      options: RunProcessOptions = {},
    ): Promise<ProcessResult> => {
      calls.push({command, args: [...args], fdCount: options.extraStdioFds?.length ?? 0});
      return await runProcess(command, args, options);
    };

    const profile = {fps: 60, codec: 'injected-release-profile'};
    const algorithmVersion = 'release-stage-v2';
    const result = await runRelease({
      ...project,
      runDirectory,
      runId: 'run-release',
      preflight: preflight(),
      now: () => '2026-08-10T00:01:00.000Z',
    }, {
      renderTimelineVideo: renderFinalVideo,
      runProcess: recordingRunner,
      outputStore,
      profile,
      algorithmVersion,
    });

    const persistedDraft = DraftReportSchema.parse(JSON.parse(
      (await readRunFile(runDirectory, 'draft/draft-report.json')).toString('utf8'),
    ));
    const persistedReview = ReviewSchema.parse(JSON.parse(
      (await readRunFile(runDirectory, 'review.json')).toString('utf8'),
    ));
    expect(result.outputs.releaseFingerprint).toBe(releaseStageFingerprint({
      draft: persistedDraft.outputs,
      compileInputHashes: compiledTimeline().inputHashes,
      compiledTimeline: compiledTimeline(),
      review: persistedReview,
      preflightEnvironmentFingerprint: preflight().environmentFingerprint,
      profile,
      algorithmVersion,
    }));

    expect(await readRunFile(runDirectory, 'audio/filter-graph.txt')).toEqual(filterGraphBefore);
    expect(await readRunFile(runDirectory, 'audio/mixed-normalized.wav')).toEqual(mixedAudioBefore);
    expect(result.outputs.intermediate.path).toBe('release/final-intermediate.mp4');
    expect(result.outputs.intermediate.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.outputs.finalVideo.path).toBe('releases/run-release/final.mp4');
    expect(result.outputs.finalVideo.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(calls).toEqual(expect.arrayContaining([
      {
        command: FFMPEG,
        args: [
          '-y', '-i', '/dev/fd/3', '-i', '/dev/fd/4',
          '-map', '0:v:0', '-map', '1:a:0',
          '-c:v', 'copy', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
          '-f', 'mp4', '/dev/fd/5',
        ],
        fdCount: 3,
      },
      {command: QT_FASTSTART, args: ['/dev/fd/3', '/dev/fd/4'], fdCount: 2},
    ]));
    expect(calls.some((call) => call.command === FFPROBE)).toBe(true);
    expect(calls.find((call) => call.command === FFMPEG)?.args).not.toContain('+faststart');
    expect(await readOutputFile(tempProject.workspaceRoot, 'releases/run-release/final.mp4')).not.toHaveLength(0);
    expect(assertMoovBeforeMdat(parseTopLevelMp4Atoms(
      await readOutputFile(tempProject.workspaceRoot, 'releases/run-release/final.mp4'),
    ))).toBeUndefined();
    await expect(outputStore.readCurrent('demo'))
      .resolves.toEqual(pointer('run-release', '2026-08-10T00:01:00.000Z'));
    expect(await readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json'))).not.toEqual(oldCurrent);
    await expect(readOutputText(tempProject.workspaceRoot, 'releases/run-release/subtitles.srt')).resolves.toContain('介绍');
    await expect(readOutputFile(tempProject.workspaceRoot, 'releases/run-release/thumbnail.jpg')).resolves.not.toHaveLength(0);
    await expect(readOutputText(tempProject.workspaceRoot, 'releases/run-release/review.json')).resolves.toContain('视觉复核通过');
    await expect(readOutputText(tempProject.workspaceRoot, 'releases/run-release/validation-report.json')).resolves.toContain('moovBeforeMdat');
    await expect(readOutputText(tempProject.workspaceRoot, 'releases/run-release/checksums.sha256')).resolves.toContain('releases/run-release/final.mp4');
  }, 90_000);

  it('preserves the previous output pointer when qt-faststart is missing', async () => {
    const {tempProject, project, runDirectory} = await prepareReleaseRun();
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    await outputStore.createRelease('demo', 'run-old');
    await outputStore.publishCurrent('demo', pointer('run-old'));
    const oldCurrent = await readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json'));
    const missingQt = preflight();
    missingQt.toolIdentities.qtFaststart = null;

    await expect(runRelease({
      ...project,
      runDirectory,
      runId: 'run-release',
      preflight: missingQt,
      now: () => '2026-08-10T00:01:00.000Z',
    }, {renderTimelineVideo: renderFinalVideo, outputStore}))
      .rejects.toMatchObject({code: 'RELEASE_TOOL_MISSING'});

    await expect(readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json'))).resolves.toEqual(oldCurrent);
    await expect(outputStore.readCurrent('demo')).resolves.toEqual(pointer('run-old'));
  }, 90_000);

  it('preserves the previous output pointer when ffprobe is missing', async () => {
    const {tempProject, project, runDirectory} = await prepareReleaseRun();
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    await outputStore.createRelease('demo', 'run-old');
    await outputStore.publishCurrent('demo', pointer('run-old'));
    const oldCurrent = await readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json'));
    const missingFfprobe = preflight();
    missingFfprobe.toolIdentities.ffprobe = null;

    await expect(runRelease({
      ...project,
      runDirectory,
      runId: 'run-release',
      preflight: missingFfprobe,
      now: () => '2026-08-10T00:01:00.000Z',
    }, {renderTimelineVideo: renderFinalVideo, outputStore}))
      .rejects.toMatchObject({code: 'RELEASE_TOOL_MISSING'});

    await expect(readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json')))
      .resolves.toEqual(oldCurrent);
    await expect(outputStore.readCurrent('demo')).resolves.toEqual(pointer('run-old'));
  }, 90_000);

  it('preserves the previous output pointer when qt-faststart fails', async () => {
    const {tempProject, project, runDirectory} = await prepareReleaseRun();
    const outputStore = createOutputStore(tempProject.workspaceRoot);
    await outputStore.createRelease('demo', 'run-old');
    await outputStore.publishCurrent('demo', pointer('run-old'));
    const oldCurrent = await readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json'));
    const failingRunner = async (
      command: string,
      args: readonly string[],
      options: RunProcessOptions = {},
    ): Promise<ProcessResult> => {
      if (command === QT_FASTSTART) throw new Error('injected qt-faststart failure');
      return await runProcess(command, args, options);
    };

    await expect(runRelease({
      ...project,
      runDirectory,
      runId: 'run-release',
      preflight: preflight(),
      now: () => '2026-08-10T00:01:00.000Z',
    }, {
      renderTimelineVideo: renderFinalVideo,
      runProcess: failingRunner,
      outputStore,
    })).rejects.toThrow('injected qt-faststart failure');

    await expect(readFile(path.join(tempProject.workspaceRoot, 'output/demo/current.json'))).resolves.toEqual(oldCurrent);
    await expect(outputStore.readCurrent('demo')).resolves.toEqual(pointer('run-old'));
  }, 90_000);
});
