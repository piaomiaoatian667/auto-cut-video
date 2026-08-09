import {z} from 'zod';

const RelativePathSchema = z.string().min(1).refine(
  (value) => !value.startsWith('/') && !value.includes('..'),
  'must be a project-relative path',
);

export const ProjectSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  composition: z.object({
    width: z.literal(1920),
    height: z.literal(1080),
    fps: z.literal(30),
    backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    allowBackgroundGaps: z.boolean(),
  }).strict(),
  tts: z.object({
    provider: z.enum(['macos-say', 'file', 'mock']),
    voice: z.string().min(1),
    rate: z.number().int().min(80).max(400),
  }).strict(),
  captions: z.object({
    font: RelativePathSchema,
    fontSize: z.number().int().min(16).max(120),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    bottomMargin: z.number().int().min(0).max(400),
    maximumChineseCharacters: z.number().int().min(8).max(40),
  }).strict(),
  audio: z.object({
    sampleRate: z.literal(48_000),
    targetLufs: z.number().min(-24).max(-10),
    truePeakDb: z.number().min(-3).max(-0.1),
    backgroundMusicGainDb: z.number().min(-60).max(0),
    duckDuringNarrationDb: z.number().min(-30).max(0),
    duckAttackMs: z.number().int().min(0).max(2_000),
    duckReleaseMs: z.number().int().min(0).max(5_000),
  }).strict(),
  render: z.object({
    draftWidth: z.literal(960),
    draftHeight: z.literal(540),
    videoCodec: z.literal('h264'),
    pixelFormat: z.literal('yuv420p'),
  }).strict(),
}).strict();

export type Project = z.infer<typeof ProjectSchema>;
