import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {Edit} from '../../src/domain/edit-schema';
import type {Project} from '../../src/domain/project-schema';
import type {Script} from '../../src/domain/script-schema';

export const createProjectFixture = (
  id = 'demo',
  maximumChineseCharacters = 28,
): Project => ({
  version: 1,
  id,
  composition: {
    width: 1920,
    height: 1080,
    fps: 30,
    backgroundColor: '#000000',
    allowBackgroundGaps: false,
  },
  tts: {
    provider: 'mock',
    voice: 'fixture',
    rate: 180,
  },
  captions: {
    font: 'assets/fonts/NotoSansSC-Bold.otf',
    fontSize: 54,
    color: '#FFFFFF',
    bottomMargin: 90,
    maximumChineseCharacters,
  },
  audio: {
    sampleRate: 48_000,
    targetLufs: -16,
    truePeakDb: -1.5,
    backgroundMusicGainDb: -20,
    duckDuringNarrationDb: -12,
    duckAttackMs: 120,
    duckReleaseMs: 250,
  },
  render: {
    draftWidth: 960,
    draftHeight: 540,
    videoCodec: 'h264',
    pixelFormat: 'yuv420p',
  },
});

export const createScriptFixture = (text = '简短文本'): Script => ({
  version: 1,
  language: 'zh-CN',
  segments: [{
    id: 'intro',
    text,
    normalizedText: text,
    pauseAfterMs: 300,
    requiredTerms: [],
  }],
});

export const createEditFixture = (): Edit => ({
  version: 1,
  visualClips: [{
    id: 'opening',
    kind: 'image',
    assetId: 'cover',
    startFrame: 0,
    durationInFrames: 30,
    fit: 'contain',
    position: {x: 0, y: 0},
    scale: 1,
    opacity: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    zIndex: 0,
  }],
  overlays: [],
});

export interface TempProjectOptions {
  projectId?: string;
  project?: unknown;
  script?: unknown;
  edit?: unknown;
}

export interface TempProject {
  workspaceRoot: string;
  projectRoot: string;
  cleanup: () => Promise<void>;
}

const serialize = (value: unknown): string =>
  typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;

export async function createTempProject(
  options: TempProjectOptions = {},
): Promise<TempProject> {
  const projectId = options.projectId ?? 'demo';
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'agent-video-workspace-'));
  const projectRoot = path.join(workspaceRoot, 'projects', projectId);
  await mkdir(projectRoot, {recursive: true});

  await Promise.all([
    writeFile(
      path.join(projectRoot, 'project.json'),
      serialize(options.project ?? createProjectFixture(projectId)),
    ),
    writeFile(
      path.join(projectRoot, 'script.json'),
      serialize(options.script ?? createScriptFixture()),
    ),
    writeFile(
      path.join(projectRoot, 'edit.json'),
      serialize(options.edit ?? createEditFixture()),
    ),
  ]);

  return {
    workspaceRoot,
    projectRoot,
    cleanup: async () => rm(workspaceRoot, {recursive: true, force: true}),
  };
}
