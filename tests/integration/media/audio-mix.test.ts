import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import {createRunStore, openExistingRunFile, openNewRunReadWriteFile, type RunDirectoryScope} from '../../../src/fs/app-directory-scopes';
import {mixAndNormalizeAudio, AUDIO_MIX_ALGORITHM_VERSION, type AudioMixInput} from '../../../src/media/audio-mix';
import {parseFfprobeJson} from '../../../src/media/ffprobe';
import {runProcess} from '../../../src/process/run-process';
import {createProjectFixture, createTempProject, type TempProject} from '../../helpers/temp-project';
import {createTestMusic} from '../../helpers/media-fixtures';

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const writeRunTone = async (runDirectory: RunDirectoryScope, relativePath: string, seconds: number) => {
  await import('../../../src/fs/app-directory-scopes').then(async ({ensureRunDirectory}) =>
    await ensureRunDirectory(runDirectory, path.posix.dirname(relativePath)));
  const handle = await openNewRunReadWriteFile(runDirectory, relativePath);
  try {
    await runProcess('/opt/homebrew/bin/ffmpeg', [
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

const probeRunAudio = async (runDirectory: RunDirectoryScope, relativePath: string) => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    const result = await runProcess('/opt/homebrew/bin/ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    return parseFfprobeJson(result.stdout);
  } finally {
    await handle.close();
  }
};

describe('mixAndNormalizeAudio', () => {
  it('executes a serialized filter graph for 100 narration intervals', async () => {
    const project = await createTempProject({project: createProjectFixture('demo')});
    tempProjects.push(project);
    const musicPath = path.join(project.projectRoot, 'assets/source/music.wav');
    await mkdir(path.dirname(musicPath), {recursive: true});
    await createTestMusic(musicPath, 12);
    const loaded = await loadProject(project.workspaceRoot, 'demo');
    const runDirectory = await createRunStore(project.workspaceRoot).createRun('demo', 'run-audio-mix');
    await writeRunTone(runDirectory, 'audio/narration.wav', 10);

    const mix: AudioMixInput = {
      compositionDurationMs: 10_000,
      narrationPath: 'audio/narration.wav',
      backgroundMusic: {renderPath: 'assets/source/music.wav', startMs: 0, durationMs: 12_000},
      narrationIntervals: Array.from({length: 100}, (_, index) => ({
        segmentId: `s${index}`,
        startMs: index * 90,
        endMs: index * 90 + 40,
      })),
      backgroundMusicGainDb: -24,
      duckDuringNarrationDb: -12,
      duckAttackMs: 20,
      duckReleaseMs: 40,
      targetLufs: -16,
      truePeakDb: -1.5,
      algorithmVersion: AUDIO_MIX_ALGORITHM_VERSION,
    };

    const result = await mixAndNormalizeAudio({
      projectDirectory: loaded.projectDirectory,
      runDirectory,
      input: mix,
    });

    expect(result.filterGraph.path).toBe('audio/filter-graph.txt');
    expect(result.filterGraph.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.mixedAudio.path).toBe('audio/mixed-normalized.wav');
    expect(result.mixedAudio.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    const metadata = await probeRunAudio(runDirectory, result.mixedAudio.path);
    expect(metadata.audioStreams).toHaveLength(1);
    expect(metadata.audioStreams[0]).toMatchObject({sampleRate: 48000, channels: 2});
  }, 60_000);
});
