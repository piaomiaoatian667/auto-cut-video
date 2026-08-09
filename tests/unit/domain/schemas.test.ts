import {describe, expect, it} from 'vitest';
import {ProjectSchema} from '../../../src/domain/project-schema';
import {ScriptSchema} from '../../../src/domain/script-schema';
import {EditSchema} from '../../../src/domain/edit-schema';
import {
  AssetManifestSchema,
  CaptionsManifestSchema,
  NarrationManifestSchema,
} from '../../../src/domain/manifest-schema';
import {CompiledTimelineSchema, type CompiledTimeline} from '../../../src/domain/timeline-schema';
import {ReviewSchema} from '../../../src/domain/review-schema';

const project = {
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

const scriptSegment = {
  id: 'intro',
  text: '介绍',
  normalizedText: '介绍',
  pauseAfterMs: 300,
  requiredTerms: [],
};

const assetRecord = {
  kind: 'video',
  sourcePath: 'assets/source/interview.mp4',
  sourceHash: 'sha256:source',
  renderPath: 'assets/source/interview.mp4',
  durationMs: 52_000,
  width: 1920,
  height: 1080,
  videoCodec: 'h264',
  pixelFormat: 'yuv420p',
  colorSpace: 'bt709',
  hasAudio: true,
  variableFrameRate: false,
  compatibility: 'direct',
} as const;

const narrationSegment = {
  id: 'intro',
  inputHash: 'sha256:input',
  audioPath: 'voice/intro.wav',
  audioHash: 'sha256:audio',
  startMs: 0,
  endMs: 4380,
  durationMs: 4380,
  pauseAfterMs: 400,
  sampleRate: 48000,
  channels: 1,
  providerFingerprint: 'sha256:provider',
} as const;

const captionCue = {
  id: 'caption-intro',
  segmentId: 'intro',
  text: '介绍',
  startMs: 0,
  endMs: 4380,
} as const;

const compiledClipFields = {
  id: 'clip',
  renderPath: 'assets/source/interview.mp4',
  startFrame: 0,
  durationInFrames: 30,
  fit: 'cover',
  position: {x: 0, y: 0},
  scale: 1,
  opacity: 1,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  zIndex: 0,
} as const;

const compiledTimeline = {
  version: 1,
  projectId: 'demo',
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 30,
  inputHashes: {project: 'sha256:project'},
  visualClips: [{...compiledClipFields, kind: 'video', sourceInMs: 0}],
  overlays: [],
  captions: [{id: 'caption-intro', segmentId: 'intro', text: '介绍', startFrame: 0, endFrame: 30}],
  narration: {
    audioPath: 'voice/narration.wav',
    durationMs: 1000,
    intervals: [{segmentId: 'intro', startMs: 0, endMs: 1000}],
  },
  backgroundMusic: {renderPath: 'assets/source/music.wav', startMs: 0, durationMs: 1000},
} as const;

describe('authoring schemas', () => {
  it('accepts the fixed MVP project', () => {
    expect(ProjectSchema.parse(project).id).toBe('demo');
  });

  it('rejects unsupported output dimensions', () => {
    expect(() => ProjectSchema.parse({...project, composition: {...project.composition, width: 1280}})).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => ProjectSchema.parse({...project, remoteUrl: 'https://example.com'})).toThrow();
  });

  it('accepts stable script segments without hard-coding the project display limit', () => {
    expect(ScriptSchema.parse({
      version: 1,
      language: 'zh-CN',
      segments: [{id: 'intro', text: '测'.repeat(29), normalizedText: '测'.repeat(29), pauseAfterMs: 300, requiredTerms: []}],
    }).segments[0]?.id).toBe('intro');
  });

  it('accepts an explicit video edit decision', () => {
    expect(EditSchema.parse({
      version: 1,
      visualClips: [{
        id: 'clip', kind: 'video', assetId: 'camera-a', startFrame: 0,
        durationInFrames: 30, sourceInMs: 0, sourceOutMs: 1000, fit: 'cover',
        position: {x: 0, y: 0}, scale: 1, opacity: 1, fadeInFrames: 0,
        fadeOutFrames: 0, zIndex: 0,
      }],
      overlays: [],
    }).visualClips).toHaveLength(1);
  });

  it('rejects a reversed video trim', () => {
    expect(() => EditSchema.parse({
      version: 1,
      visualClips: [{
        id: 'clip', kind: 'video', assetId: 'camera-a', startFrame: 0,
        durationInFrames: 30, sourceInMs: 1000, sourceOutMs: 1000, fit: 'cover',
        position: {x: 0, y: 0}, scale: 1, opacity: 1, fadeInFrames: 0,
        fadeOutFrames: 0, zIndex: 0,
      }],
      overlays: [],
    })).toThrow(/sourceOutMs must be greater than sourceInMs/);
  });

  it('rejects absolute authoring paths', () => {
    expect(() => ProjectSchema.parse({
      ...project,
      captions: {...project.captions, font: '/tmp/font.otf'},
    })).toThrow();
  });

  it('rejects duplicate stable script segment ids', () => {
    const result = ScriptSchema.safeParse({
      version: 1,
      language: 'zh-CN',
      segments: [scriptSegment, scriptSegment],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: 'duplicate segment id: intro',
        path: ['segments', 1, 'id'],
      }));
    }
  });

  it('rejects duplicate ids across visual clips and overlays', () => {
    const result = EditSchema.safeParse({
      version: 1,
      visualClips: [{
        id: 'opening', kind: 'image', assetId: 'cover', startFrame: 0,
        durationInFrames: 30, fit: 'contain', position: {x: 0, y: 0},
        scale: 1, opacity: 1, fadeInFrames: 0, fadeOutFrames: 0, zIndex: 0,
      }],
      overlays: [{
        id: 'opening', component: 'basic-title', startFrame: 0,
        durationInFrames: 30, props: {}, zIndex: 1,
      }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        message: 'duplicate timeline id: opening',
        path: ['overlays', 0, 'id'],
      }));
    }
  });

  it('uses lexical project-relative paths without rejecting legal double dots in filenames', () => {
    const invalidPaths = [
      '/tmp/font.otf',
      'https://example.com/font.otf',
      'C:/fonts/font.otf',
      'assets\\fonts\\font.otf',
      'assets/../font.otf',
    ];

    for (const font of invalidPaths) {
      expect(() => ProjectSchema.parse({
        ...project,
        captions: {...project.captions, font},
      }), font).toThrow();
    }

    expect(ProjectSchema.parse({
      ...project,
      captions: {...project.captions, font: 'assets/fonts/font..otf'},
    }).captions.font).toBe('assets/fonts/font..otf');
  });

  it('applies project-relative path validation to script audio files', () => {
    expect(() => ScriptSchema.parse({
      version: 1,
      language: 'zh-CN',
      segments: [{...scriptSegment, audioPath: 'file:///tmp/intro.wav'}],
    })).toThrow();
  });

  it('allows fractional millisecond authoring values', () => {
    expect(ProjectSchema.parse({
      ...project,
      audio: {...project.audio, duckAttackMs: 120.5, duckReleaseMs: 250.5},
    }).audio.duckAttackMs).toBe(120.5);
    expect(ScriptSchema.parse({
      version: 1,
      language: 'zh-CN',
      segments: [{...scriptSegment, pauseAfterMs: 300.5}],
    }).segments[0]?.pauseAfterMs).toBe(300.5);
    expect(EditSchema.parse({
      version: 1,
      visualClips: [{
        id: 'clip', kind: 'video', assetId: 'camera-a', startFrame: 0,
        durationInFrames: 30, sourceInMs: 12.5, sourceOutMs: 1012.75, fit: 'cover',
        position: {x: 0, y: 0}, scale: 1, opacity: 1, fadeInFrames: 0,
        fadeOutFrames: 0, zIndex: 0,
      }],
      overlays: [],
      backgroundMusic: {assetId: 'music-main', startMs: 0.5},
    }).backgroundMusic?.startMs).toBe(0.5);
  });

  it('keeps nested authoring objects strict', () => {
    expect(() => ProjectSchema.parse({
      ...project,
      composition: {...project.composition, remoteWidth: 1920},
    })).toThrow();
    expect(() => ScriptSchema.parse({
      version: 1,
      language: 'zh-CN',
      segments: [{...scriptSegment, notes: {visualHint: 'title', remoteHint: true}}],
    })).toThrow();
    expect(() => EditSchema.parse({
      version: 1,
      visualClips: [{
        id: 'opening', kind: 'image', assetId: 'cover', startFrame: 0,
        durationInFrames: 30, fit: 'contain', position: {x: 0, y: 0, anchor: 'center'},
        scale: 1, opacity: 1, fadeInFrames: 0, fadeOutFrames: 0, zIndex: 0,
      }],
      overlays: [],
    })).toThrow();
  });
});

describe('generated schemas', () => {
  it('accepts the exact generated manifest contracts', () => {
    expect(AssetManifestSchema.parse({
      version: 1,
      assets: {
        interview: {
          kind: 'video',
          sourcePath: 'assets/source/interview.mp4',
          sourceHash: 'sha256:source',
          renderPath: 'assets/source/interview.mp4',
          durationMs: 52_000,
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          pixelFormat: 'yuv420p',
          colorSpace: 'bt709',
          hasAudio: true,
          variableFrameRate: false,
          compatibility: 'direct',
        },
      },
    }).assets.interview?.compatibility).toBe('direct');

    expect(NarrationManifestSchema.parse({
      version: 1,
      provider: 'macos-say',
      segments: [{
        id: 'intro',
        inputHash: 'sha256:input',
        audioPath: 'voice/intro.wav',
        audioHash: 'sha256:audio',
        startMs: 0,
        endMs: 4380,
        durationMs: 4380,
        pauseAfterMs: 400,
        sampleRate: 48000,
        channels: 1,
        providerFingerprint: 'sha256:provider',
      }],
      master: {audioPath: 'voice/narration.wav', audioHash: 'sha256:master', durationMs: 4780},
    }).segments[0]?.id).toBe('intro');

    expect(CaptionsManifestSchema.parse({
      version: 1,
      sourceNarrationHash: 'sha256:narration',
      cues: [{id: 'caption-intro', segmentId: 'intro', text: '介绍', startMs: 0, endMs: 4380}],
    }).cues[0]?.segmentId).toBe('intro');
  });

  it('rejects unknown fields in nested generated objects', () => {
    expect(() => AssetManifestSchema.parse({
      version: 1,
      assets: {
        music: {
          kind: 'audio',
          sourcePath: 'assets/source/music.wav',
          sourceHash: 'sha256:source',
          renderPath: 'assets/source/music.wav',
          compatibility: 'direct',
          remoteUrl: 'https://example.com/music.wav',
        },
      },
    })).toThrow();
  });

  it('accepts the exact compiled timeline contract', () => {
    expect(CompiledTimelineSchema.parse(compiledTimeline).projectId).toBe('demo');
  });

  it('keeps compiled clip kind independent from optional sourceInMs in types and runtime', () => {
    const videoWithoutSourceIn: CompiledTimeline['visualClips'][number] = {
      ...compiledClipFields,
      kind: 'video',
    };
    const imageWithSourceIn: CompiledTimeline['visualClips'][number] = {
      ...compiledClipFields,
      id: 'still',
      kind: 'image',
      sourceInMs: 12.5,
    };

    const parsed = CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [videoWithoutSourceIn, imageWithSourceIn],
    });

    expect(parsed.visualClips).toEqual([videoWithoutSourceIn, imageWithSourceIn]);
  });

  it('rejects unsafe paths across generated manifests and timelines', () => {
    expect(() => AssetManifestSchema.parse({
      version: 1,
      assets: {interview: {...assetRecord, sourcePath: 'https://example.com/interview.mp4'}},
    })).toThrow();
    expect(() => AssetManifestSchema.parse({
      version: 1,
      assets: {interview: {...assetRecord, renderPath: 'C:/work/interview.mp4'}},
    })).toThrow();
    expect(() => NarrationManifestSchema.parse({
      version: 1,
      provider: 'mock',
      segments: [{...narrationSegment, audioPath: 'voice\\intro.wav'}],
      master: {audioPath: 'voice/narration.wav', audioHash: 'sha256:master', durationMs: 4780},
    })).toThrow();
    expect(() => NarrationManifestSchema.parse({
      version: 1,
      provider: 'mock',
      segments: [narrationSegment],
      master: {audioPath: 'voice/../narration.wav', audioHash: 'sha256:master', durationMs: 4780},
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], renderPath: '/tmp/interview.mp4'}],
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      narration: {...compiledTimeline.narration, audioPath: 'file:///tmp/narration.wav'},
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      backgroundMusic: {...compiledTimeline.backgroundMusic, renderPath: 'music\\main.wav'},
    })).toThrow();
  });

  it('requires generated stable ids and reference ids', () => {
    expect(() => AssetManifestSchema.parse({
      version: 1,
      assets: {'Interview_Main': assetRecord},
    })).toThrow();
    expect(() => NarrationManifestSchema.parse({
      version: 1,
      provider: 'mock',
      segments: [{...narrationSegment, id: 'Intro_Main'}],
      master: {audioPath: 'voice/narration.wav', audioHash: 'sha256:master', durationMs: 4780},
    })).toThrow();
    expect(() => CaptionsManifestSchema.parse({
      version: 1,
      sourceNarrationHash: 'sha256:narration',
      cues: [{...captionCue, id: 'Caption_Main'}],
    })).toThrow();
    expect(() => CaptionsManifestSchema.parse({
      version: 1,
      sourceNarrationHash: 'sha256:narration',
      cues: [{...captionCue, segmentId: 'Intro_Main'}],
    })).toThrow();

    const invalidTimelines = [
      {...compiledTimeline, projectId: 'Demo_Main'},
      {...compiledTimeline, visualClips: [{...compiledTimeline.visualClips[0], id: 'Clip_Main'}]},
      {...compiledTimeline, overlays: [{id: 'Title_Main', component: 'basic-title', startFrame: 0, durationInFrames: 1, props: {}, zIndex: 1}]},
      {...compiledTimeline, overlays: [{id: 'title', component: 'Basic_Title', startFrame: 0, durationInFrames: 1, props: {}, zIndex: 1}]},
      {...compiledTimeline, captions: [{...compiledTimeline.captions[0], id: 'Caption_Main'}]},
      {...compiledTimeline, captions: [{...compiledTimeline.captions[0], segmentId: 'Intro_Main'}]},
      {...compiledTimeline, narration: {...compiledTimeline.narration, intervals: [{segmentId: 'Intro_Main', startMs: 0, endMs: 1000}]}},
    ];

    for (const timeline of invalidTimelines) {
      expect(() => CompiledTimelineSchema.parse(timeline)).toThrow();
    }
  });

  it('rejects invalid generated frame, dimension, layer, and millisecond values', () => {
    expect(() => AssetManifestSchema.parse({
      version: 1,
      assets: {interview: {...assetRecord, width: 1920.5}},
    })).toThrow();
    expect(() => AssetManifestSchema.parse({
      version: 1,
      assets: {interview: {...assetRecord, durationMs: -1}},
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({...compiledTimeline, durationInFrames: 1.5})).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], startFrame: -1}],
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], zIndex: 0.5}],
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], sourceInMs: -0.5}],
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], scale: 10.5}],
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], opacity: 1.1}],
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], fadeInFrames: 0.5}],
    })).toThrow();

    expect(CompiledTimelineSchema.parse({
      ...compiledTimeline,
      visualClips: [{...compiledTimeline.visualClips[0], sourceInMs: 12.5}],
      narration: {...compiledTimeline.narration, durationMs: 1000.5},
    }).visualClips[0]?.sourceInMs).toBe(12.5);
  });

  it('allows fractional milliseconds without forcing duration equality or unique references', () => {
    expect(NarrationManifestSchema.parse({
      version: 1,
      provider: 'mock',
      segments: [{...narrationSegment, startMs: 0.5, endMs: 1000.75, durationMs: 999.5}],
      master: {audioPath: 'voice/narration.wav', audioHash: 'sha256:master', durationMs: 1000.25},
    }).segments[0]?.durationMs).toBe(999.5);

    expect(CaptionsManifestSchema.parse({
      version: 1,
      sourceNarrationHash: 'sha256:narration',
      cues: [captionCue, {...captionCue, id: 'caption-intro-2'}],
    }).cues).toHaveLength(2);

    expect(CompiledTimelineSchema.parse({
      ...compiledTimeline,
      narration: {
        ...compiledTimeline.narration,
        intervals: [
          {segmentId: 'intro', startMs: 0.5, endMs: 500.25},
          {segmentId: 'intro', startMs: 500.25, endMs: 1000.5},
        ],
      },
    }).narration.intervals).toHaveLength(2);
  });

  it('rejects reversed generated intervals with precise end-field paths', () => {
    const narrationResult = NarrationManifestSchema.safeParse({
      version: 1,
      provider: 'mock',
      segments: [{...narrationSegment, startMs: 100, endMs: 100}],
      master: {audioPath: 'voice/narration.wav', audioHash: 'sha256:master', durationMs: 4780},
    });
    const captionsResult = CaptionsManifestSchema.safeParse({
      version: 1,
      sourceNarrationHash: 'sha256:narration',
      cues: [{...captionCue, startMs: 100, endMs: 100}],
    });
    const timelineCaptionResult = CompiledTimelineSchema.safeParse({
      ...compiledTimeline,
      captions: [{...compiledTimeline.captions[0], startFrame: 10, endFrame: 10}],
    });
    const timelineNarrationResult = CompiledTimelineSchema.safeParse({
      ...compiledTimeline,
      narration: {...compiledTimeline.narration, intervals: [{segmentId: 'intro', startMs: 100, endMs: 100}]},
    });

    expect(narrationResult.success).toBe(false);
    expect(captionsResult.success).toBe(false);
    expect(timelineCaptionResult.success).toBe(false);
    expect(timelineNarrationResult.success).toBe(false);
    if (!narrationResult.success) expect(narrationResult.error.issues[0]?.path).toEqual(['segments', 0, 'endMs']);
    if (!captionsResult.success) expect(captionsResult.error.issues[0]?.path).toEqual(['cues', 0, 'endMs']);
    if (!timelineCaptionResult.success) expect(timelineCaptionResult.error.issues[0]?.path).toEqual(['captions', 0, 'endFrame']);
    if (!timelineNarrationResult.success) expect(timelineNarrationResult.error.issues[0]?.path).toEqual(['narration', 'intervals', 0, 'endMs']);
  });

  it('rejects duplicate generated ids with precise paths', () => {
    const narrationResult = NarrationManifestSchema.safeParse({
      version: 1,
      provider: 'mock',
      segments: [narrationSegment, narrationSegment],
      master: {audioPath: 'voice/narration.wav', audioHash: 'sha256:master', durationMs: 4780},
    });
    const captionsResult = CaptionsManifestSchema.safeParse({
      version: 1,
      sourceNarrationHash: 'sha256:narration',
      cues: [captionCue, captionCue],
    });
    const timelineResult = CompiledTimelineSchema.safeParse({
      ...compiledTimeline,
      overlays: [{id: 'clip', component: 'basic-title', startFrame: 0, durationInFrames: 1, props: {}, zIndex: 1}],
      captions: [compiledTimeline.captions[0], compiledTimeline.captions[0]],
    });

    expect(narrationResult.success).toBe(false);
    expect(captionsResult.success).toBe(false);
    expect(timelineResult.success).toBe(false);
    if (!narrationResult.success) expect(narrationResult.error.issues[0]?.path).toEqual(['segments', 1, 'id']);
    if (!captionsResult.success) expect(captionsResult.error.issues[0]?.path).toEqual(['cues', 1, 'id']);
    if (!timelineResult.success) {
      expect(timelineResult.error.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        ['overlays', 0, 'id'],
        ['captions', 1, 'id'],
      ]));
    }
  });

  it('keeps all generated nested objects strict', () => {
    expect(() => NarrationManifestSchema.parse({
      version: 1,
      provider: 'mock',
      segments: [narrationSegment],
      master: {audioPath: 'voice/narration.wav', audioHash: 'sha256:master', durationMs: 4780, remoteUrl: 'https://example.com'},
    })).toThrow();
    expect(() => CompiledTimelineSchema.parse({
      ...compiledTimeline,
      narration: {
        ...compiledTimeline.narration,
        intervals: [{...compiledTimeline.narration.intervals[0], remoteOffsetMs: 10}],
      },
    })).toThrow();
  });

  it('accepts a strict review record and rejects unknown fields', () => {
    const review = {
      version: 1,
      runId: 'run-1',
      projectId: 'demo',
      status: 'approved',
      reviewer: 'codex',
      reviewedAt: '2026-08-09T12:00:00.000Z',
      reason: 'Visual review completed.',
      evidencePaths: ['review/contact-sheet.png'],
    };

    expect(ReviewSchema.parse(review).status).toBe('approved');
    expect(() => ReviewSchema.parse({...review, approvedByPolicy: true})).toThrow();
    expect(ReviewSchema.parse({...review, evidencePaths: ['/tmp/contact-sheet.png']}).evidencePaths[0]).toBe('/tmp/contact-sheet.png');
  });
});
