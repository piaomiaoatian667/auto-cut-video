import {describe, expect, it} from 'vitest';
import {compileTimeline} from '../../../src/timeline/compiler';
import type {Edit} from '../../../src/domain/edit-schema';
import type {AssetManifest, CaptionsManifest, NarrationManifest} from '../../../src/domain/manifest-schema';
import type {Project} from '../../../src/domain/project-schema';
import type {Script} from '../../../src/domain/script-schema';
import {CompiledTimelineSchema} from '../../../src/domain/timeline-schema';

const project: Project = {
  version: 1,
  id: 'demo',
  composition: {
    width: 1920,
    height: 1080,
    fps: 30,
    backgroundColor: '#000000',
    allowBackgroundGaps: false,
  },
  tts: {provider: 'macos-say', voice: 'Tingting', rate: 180},
  captions: {
    font: 'assets/fonts/NotoSansSC-Bold.otf',
    fontSize: 54,
    color: '#FFFFFF',
    bottomMargin: 90,
    maximumChineseCharacters: 28,
  },
  audio: {
    sampleRate: 48000,
    targetLufs: -16,
    truePeakDb: -1.5,
    backgroundMusicGainDb: -20,
    duckDuringNarrationDb: -12,
    duckAttackMs: 120,
    duckReleaseMs: 250,
  },
  render: {draftWidth: 960, draftHeight: 540, videoCodec: 'h264', pixelFormat: 'yuv420p'},
};

const script: Script = {
  version: 1,
  language: 'zh-CN',
  segments: [{
    id: 'intro',
    text: '介绍',
    normalizedText: '介绍',
    pauseAfterMs: 300,
    requiredTerms: [],
  }],
};

const baseEdit: Edit = {
  version: 1,
  visualClips: [{
    id: 'clip-a',
    kind: 'video',
    assetId: 'interview',
    startFrame: 0,
    durationInFrames: 300,
    sourceInMs: 0,
    sourceOutMs: 10_000,
    fit: 'cover',
    position: {x: 0, y: 0},
    scale: 1,
    opacity: 1,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    zIndex: 0,
  }],
  overlays: [{
    id: 'title',
    component: 'basic-title',
    startFrame: 0,
    durationInFrames: 60,
    props: {text: '本地 AI 视频工作流'},
    zIndex: 10,
  }],
  backgroundMusic: {assetId: 'music-main', startMs: 0},
};

const assetManifest: AssetManifest = {
  version: 1,
  assets: {
    interview: {
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
      sourceHash: 'sha256:interview-source',
      renderPath: 'assets/source/interview.mp4',
      durationMs: 60_000,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      colorSpace: 'bt709',
      hasAudio: true,
      variableFrameRate: false,
      compatibility: 'direct',
    },
    poster: {
      kind: 'image',
      sourcePath: 'assets/source/poster.png',
      sourceHash: 'sha256:poster-source',
      renderPath: 'assets/source/poster.png',
      width: 1920,
      height: 1080,
      compatibility: 'direct',
    },
    'music-main': {
      kind: 'audio',
      sourcePath: 'assets/source/music.wav',
      sourceHash: 'sha256:music-source',
      renderPath: 'assets/source/music.wav',
      durationMs: 20_000,
      compatibility: 'direct',
    },
  },
};

const narrationManifest: NarrationManifest = {
  version: 1,
  provider: 'macos-say',
  segments: [{
    id: 'intro',
    inputHash: 'sha256:narration-input',
    audioPath: 'audio/segments/intro.wav',
    audioHash: 'sha256:intro-audio',
    startMs: 0,
    endMs: 10_000,
    durationMs: 10_000,
    pauseAfterMs: 300,
    sampleRate: 48000,
    channels: 1,
    providerFingerprint: 'sha256:provider',
  }],
  master: {
    audioPath: 'audio/narration.wav',
    audioHash: 'sha256:narration-master',
    durationMs: 10_000,
  },
};

const captionsManifest: CaptionsManifest = {
  version: 1,
  sourceNarrationHash: 'sha256:narration-master',
  cues: [{
    id: 'caption-intro',
    segmentId: 'intro',
    text: '介绍',
    startMs: 0,
    endMs: 10_000,
  }],
};

const fixture = (overrides: {
  project?: Partial<Project>;
  edit?: Partial<Edit>;
  sourceInMs?: number;
  sourceOutMs?: number;
  assetDurationMs?: number;
  component?: string;
  allowBackgroundGaps?: boolean;
  gapFrames?: number;
  compositionMs?: number;
  bgmStartMs?: number;
  bgmDurationMs?: number;
} = {}) => {
  const nextProject: Project = {
    ...project,
    ...overrides.project,
    composition: {
      ...project.composition,
      ...overrides.project?.composition,
      allowBackgroundGaps: overrides.allowBackgroundGaps
        ?? overrides.project?.composition?.allowBackgroundGaps
        ?? project.composition.allowBackgroundGaps,
    },
  };
  const compositionFrames = overrides.compositionMs === undefined
    ? baseEdit.visualClips[0]!.durationInFrames
    : Math.round(overrides.compositionMs / (1000 / nextProject.composition.fps));
  const gapFrames = overrides.gapFrames ?? 0;
  const firstClipDuration = Math.max(1, compositionFrames - gapFrames);
  const baseVideoClip = baseEdit.visualClips[0] as Extract<Edit['visualClips'][number], {kind: 'video'}>;
  const firstClipSourceOutMs = Math.round(
    firstClipDuration * 1000 / nextProject.composition.fps,
  );
  const visualClip = {
    ...baseVideoClip,
    durationInFrames: firstClipDuration,
    sourceInMs: overrides.sourceInMs ?? baseVideoClip.sourceInMs,
    sourceOutMs: overrides.sourceOutMs ?? firstClipSourceOutMs,
  };
  const edit: Edit = {
    ...baseEdit,
    ...overrides.edit,
    visualClips: overrides.edit?.visualClips ?? [visualClip],
    overlays: overrides.edit?.overlays ?? [{
      ...baseEdit.overlays[0]!,
      component: overrides.component ?? baseEdit.overlays[0]!.component,
    }],
    backgroundMusic: overrides.edit?.backgroundMusic ?? {
      assetId: 'music-main',
      startMs: overrides.bgmStartMs ?? baseEdit.backgroundMusic!.startMs,
    },
  };
  return {
    project: nextProject,
    script,
    edit,
    assetManifest: {
      ...assetManifest,
      assets: {
        ...assetManifest.assets,
        interview: {
          ...assetManifest.assets.interview!,
          durationMs: overrides.assetDurationMs ?? assetManifest.assets.interview!.durationMs,
        },
        'music-main': {
          ...assetManifest.assets['music-main']!,
          durationMs: overrides.bgmDurationMs ?? assetManifest.assets['music-main']!.durationMs,
        },
      },
    },
    narrationManifest: {
      ...narrationManifest,
      master: {
        ...narrationManifest.master,
        durationMs: overrides.compositionMs ?? narrationManifest.master.durationMs,
      },
      segments: narrationManifest.segments.map((segment) => ({
        ...segment,
        endMs: overrides.compositionMs ?? segment.endMs,
        durationMs: overrides.compositionMs ?? segment.durationMs,
      })),
    },
    captionsManifest: {
      ...captionsManifest,
      cues: captionsManifest.cues.map((cue) => ({
        ...cue,
        endMs: overrides.compositionMs ?? cue.endMs,
      })),
    },
  };
};

describe('compileTimeline', () => {
  it('compiles explicit edit decisions into a strict compiled timeline', () => {
    const compiled = compileTimeline(fixture());

    expect(CompiledTimelineSchema.parse(compiled)).toEqual(compiled);
    expect(compiled).toMatchObject({
      version: 1,
      projectId: 'demo',
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 300,
      inputHashes: {
        'asset:interview': 'sha256:interview-source',
        'asset:music-main': 'sha256:music-source',
        'narration:master': 'sha256:narration-master',
        'caption:sourceNarration': 'sha256:narration-master',
      },
      visualClips: [{
        id: 'clip-a',
        kind: 'video',
        renderPath: 'assets/source/interview.mp4',
        startFrame: 0,
        durationInFrames: 300,
        sourceInMs: 0,
        fit: 'cover',
        position: {x: 0, y: 0},
        scale: 1,
        opacity: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        zIndex: 0,
      }],
      overlays: [{
        id: 'title',
        component: 'basic-title',
        startFrame: 0,
        durationInFrames: 60,
        props: {text: '本地 AI 视频工作流'},
        zIndex: 10,
      }],
      captions: [{
        id: 'caption-intro',
        segmentId: 'intro',
        text: '介绍',
        startFrame: 0,
        endFrame: 300,
      }],
      narration: {
        audioPath: 'audio/narration.wav',
        durationMs: 10_000,
        intervals: [{segmentId: 'intro', startMs: 0, endMs: 10_000}],
      },
      backgroundMusic: {
        renderPath: 'assets/source/music.wav',
        startMs: 0,
        durationMs: 20_000,
      },
    });
  });

  it('rejects a video trim outside the source duration', () => {
    expect(() => compileTimeline(fixture({sourceOutMs: 60_001, assetDurationMs: 60_000})))
      .toThrowError(/EDIT_TRIM_OUT_OF_BOUNDS/);
  });

  it('rejects a reversed video trim defensively', () => {
    expect(() => compileTimeline(fixture({sourceInMs: 5_000, sourceOutMs: 3_000, assetDurationMs: 60_000})))
      .toThrowError(/EDIT_TRIM_OUT_OF_BOUNDS/);
  });

  it('rejects an unregistered overlay component', () => {
    expect(() => compileTimeline(fixture({component: 'arbitrary-code'})))
      .toThrowError(/EDIT_COMPONENT_UNREGISTERED/);
  });

  it('rejects invalid registered overlay props', () => {
    expect(() => compileTimeline(fixture({edit: {
      overlays: [{...baseEdit.overlays[0]!, props: {text: ''}}],
    }}))).toThrowError(/EDIT_COMPONENT_PROPS_INVALID/);
  });

  it('rejects undeclared visual gaps', () => {
    expect(() => compileTimeline(fixture({allowBackgroundGaps: false, gapFrames: 10})))
      .toThrowError(/TIMELINE_GAP_UNDECLARED/);
  });

  it('allows declared visual gaps', () => {
    expect(compileTimeline(fixture({allowBackgroundGaps: true, gapFrames: 10})).durationInFrames)
      .toBe(300);
  });

  it('rejects BGM shorter than the remaining composition', () => {
    expect(() => compileTimeline(fixture({compositionMs: 10_000, bgmStartMs: 1_000, bgmDurationMs: 8_999})))
      .toThrowError(/AUDIO_BGM_TOO_SHORT/);
  });
});
