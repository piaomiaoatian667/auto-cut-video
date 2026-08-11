import {chmod, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import type {CompiledTimeline} from '../../../src/domain/timeline-schema';
import {createRunStore, ensureRunDirectory, openExistingRunFile, openNewRunReadWriteFile, openNewRunFile, type RunDirectoryScope} from '../../../src/fs/app-directory-scopes';
import {parseFfprobeJson} from '../../../src/media/ffprobe';
import {runDraft} from '../../../src/pipeline/stages/draft';
import {runProcess} from '../../../src/process/run-process';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
  createTempProject,
  type TempProject,
} from '../../helpers/temp-project';
import {createTestMusic, createTestVideo} from '../../helpers/media-fixtures';

const tempProjects: TempProject[] = [];

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

const createRecordingExecutable = async (
  workspaceRoot: string,
  name: string,
  target: string,
): Promise<{executablePath: string; logPath: string}> => {
  const executablePath = path.join(workspaceRoot, `${name}-wrapper.sh`);
  const logPath = path.join(workspaceRoot, `${name}-calls.log`);
  await writeFile(executablePath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${shellQuote(logPath)}`,
    `exec ${shellQuote(target)} "$@"`,
    '',
  ].join('\n'), 'utf8');
  await chmod(executablePath, 0o755);
  return {executablePath, logPath};
};

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const writeRunJson = async (runDirectory: RunDirectoryScope, relativePath: string, value: unknown) => {
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeRunTone = async (runDirectory: RunDirectoryScope, relativePath: string, seconds: number) => {
  await ensureRunDirectory(runDirectory, path.posix.dirname(relativePath));
  const handle = await openNewRunReadWriteFile(runDirectory, relativePath);
  try {
    await runProcess(process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-map', '0:a:0', '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '1',
      '-f', 'wav', '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const probeRunMedia = async (runDirectory: RunDirectoryScope, relativePath: string) => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    const result = await runProcess(process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    return parseFfprobeJson(result.stdout);
  } finally {
    await handle.close();
  }
};

const compiledTimeline = (): CompiledTimeline => ({
  version: 1,
  projectId: 'demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 30,
  inputHashes: {'asset:clip': 'sha256:clip', 'asset:music': 'sha256:music'},
  visualClips: [{
    id: 'clip',
    kind: 'video',
    renderPath: 'assets/source/clip.mp4',
    startFrame: 0,
    durationInFrames: 30,
    sourceInMs: 0,
    fit: 'cover',
    position: {x: 0, y: 0},
    scale: 1,
    opacity: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    zIndex: 0,
  }],
  overlays: [],
  captions: [{id: 'caption-intro', segmentId: 'intro', text: '介绍', startFrame: 0, endFrame: 30}],
  narration: {
    audioPath: 'audio/narration.wav',
    durationMs: 1000,
    intervals: [{segmentId: 'intro', startMs: 0, endMs: 1000}],
  },
  backgroundMusic: {renderPath: 'assets/source/music.wav', startMs: 0, durationMs: 2000},
});

describe('runDraft', () => {
  it('renders a narrated draft with review evidence and audio artifact references', async () => {
    const tempProject = await createTempProject({
      project: createProjectFixture('demo'),
      script: createScriptFixture('介绍'),
      edit: createEditFixture(),
    });
    tempProjects.push(tempProject);
    await mkdir(path.join(tempProject.projectRoot, 'assets/source'), {recursive: true});
    await createTestVideo(path.join(tempProject.projectRoot, 'assets/source/clip.mp4'), 1);
    await createTestMusic(path.join(tempProject.projectRoot, 'assets/source/music.wav'), 2);
    const project = await loadProject(tempProject.workspaceRoot, 'demo');
    const runDirectory = await createRunStore(tempProject.workspaceRoot).createRun('demo', 'run-draft');
    const ffmpeg = await createRecordingExecutable(
      tempProject.workspaceRoot,
      'ffmpeg',
      process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg',
    );
    const ffprobe = await createRecordingExecutable(
      tempProject.workspaceRoot,
      'ffprobe',
      process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe',
    );
    await writeRunTone(runDirectory, 'audio/narration.wav', 1);
    await writeRunJson(runDirectory, 'compiled-timeline.json', compiledTimeline());

    const result = await runDraft({
      ...project,
      runDirectory,
      ffmpegExecutable: ffmpeg.executablePath,
      ffprobeExecutable: ffprobe.executablePath,
    });

    expect(result.outputs.audio.filterGraph).toMatchObject({
      path: 'audio/filter-graph.txt',
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(result.outputs.audio.mixedAudio).toMatchObject({
      path: 'audio/mixed-normalized.wav',
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(result.outputs.contactSheet.path).toBe('draft/contact-sheet.jpg');
    const metadata = await probeRunMedia(runDirectory, result.outputs.draftVideo.path);
    expect(metadata.videoStreams).toHaveLength(1);
    expect(metadata.audioStreams).toHaveLength(1);
    expect(metadata.videoStreams[0]).toMatchObject({width: 960, height: 540});
    await expect(probeRunMedia(runDirectory, result.outputs.contactSheet.path)).resolves.toMatchObject({videoStreams: expect.any(Array)});
    const ffmpegCalls = await readFile(ffmpeg.logPath, 'utf8');
    expect(ffmpegCalls).toContain('-filter_complex_script');
    expect(ffmpegCalls).toContain('-map 0:v:0');
    expect(ffmpegCalls).toContain('-xerror');
    expect(ffmpegCalls).toContain('select=eq(n\\,');
    expect(ffmpegCalls).toContain('tile=');
    await expect(readFile(ffprobe.logPath, 'utf8')).resolves.toContain('-show_streams');
  }, 90_000);
});
