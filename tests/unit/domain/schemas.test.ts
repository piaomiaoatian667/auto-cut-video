import {describe, expect, it} from 'vitest';
import {ProjectSchema} from '../../../src/domain/project-schema';
import {ScriptSchema} from '../../../src/domain/script-schema';
import {EditSchema} from '../../../src/domain/edit-schema';
import {
  AssetManifestSchema,
  CaptionsManifestSchema,
  NarrationManifestSchema,
} from '../../../src/domain/manifest-schema';
import {CompiledTimelineSchema} from '../../../src/domain/timeline-schema';
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
    const segment = {
      id: 'intro',
      text: '介绍',
      normalizedText: '介绍',
      pauseAfterMs: 300,
      requiredTerms: [],
    };

    expect(() => ScriptSchema.parse({
      version: 1,
      language: 'zh-CN',
      segments: [segment, segment],
    })).toThrow(/duplicate segment id: intro/);
  });

  it('rejects duplicate ids across visual clips and overlays', () => {
    expect(() => EditSchema.parse({
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
    })).toThrow(/duplicate timeline id: opening/);
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
    expect(CompiledTimelineSchema.parse({
      version: 1,
      projectId: 'demo',
      width: 1920,
      height: 1080,
      fps: 30,
      durationInFrames: 30,
      inputHashes: {project: 'sha256:project'},
      visualClips: [{
        id: 'clip',
        kind: 'video',
        renderPath: 'assets/source/interview.mp4',
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
        audioPath: 'voice/narration.wav',
        durationMs: 1000,
        intervals: [{segmentId: 'intro', startMs: 0, endMs: 1000}],
      },
      backgroundMusic: {renderPath: 'assets/source/music.wav', startMs: 0, durationMs: 1000},
    }).projectId).toBe('demo');
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
  });
});
