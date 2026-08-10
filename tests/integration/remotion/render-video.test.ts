import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import type {CompiledTimeline} from '../../../src/domain/timeline-schema';
import {parseFfprobeJson} from '../../../src/media/ffprobe';
import {runProcess} from '../../../src/process/run-process';
import {renderTimelineVideo} from '../../../src/remotion/render';
import {createTestVideo} from '../../helpers/media-fixtures';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) =>
    await rm(directory, {recursive: true, force: true})));
});

const makeTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), 'remotion-render-'));
  tempDirectories.push(directory);
  return directory;
};

const probe = async (filePath: string) => {
  const result = await runProcess('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ]);
  return parseFfprobeJson(result.stdout);
};

const timeline = (renderPath: string): CompiledTimeline => ({
  version: 1,
  projectId: 'demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 30,
  inputHashes: {'asset:clip': 'sha256:clip'},
  visualClips: [{
    id: 'clip',
    kind: 'video',
    renderPath,
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
  captions: [],
  narration: {
    audioPath: 'audio/narration.wav',
    durationMs: 1000,
    intervals: [],
  },
});

describe('renderTimelineVideo', () => {
  it('renders a muted 1080p H.264 video without an audio stream', async () => {
    const workspace = await makeTempDirectory();
    const publicDir = path.join(workspace, 'public');
    const assetRelativePath = 'assets/source/clip.mp4';
    const assetPath = path.join(publicDir, assetRelativePath);
    const outputLocation = path.join(workspace, 'muted.mp4');
    await mkdir(path.dirname(assetPath), {recursive: true});
    await createTestVideo(assetPath, 1);

    await renderTimelineVideo({
      timeline: timeline(assetRelativePath),
      publicDir,
      outputLocation,
    });

    const metadata = await probe(outputLocation);
    const video = metadata.videoStreams[0];
    expect(metadata.videoStreams).toHaveLength(1);
    expect(metadata.audioStreams).toHaveLength(0);
    expect(video?.width).toBe(1920);
    expect(video?.height).toBe(1080);
    expect(video?.averageFrameRate.value).toBe(30);
  }, 120_000);
});
