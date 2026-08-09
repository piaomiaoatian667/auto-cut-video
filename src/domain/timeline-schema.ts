import {z} from 'zod';

const CompiledVisualClipSchema = z.object({
  id: z.string(),
  kind: z.enum(['video', 'image']),
  renderPath: z.string(),
  startFrame: z.number(),
  durationInFrames: z.number(),
  sourceInMs: z.number().optional(),
  fit: z.enum(['cover', 'contain']),
  position: z.object({x: z.number(), y: z.number()}).strict(),
  scale: z.number(),
  opacity: z.number(),
  fadeInFrames: z.number(),
  fadeOutFrames: z.number(),
  zIndex: z.number(),
}).strict();

const CompiledOverlaySchema = z.object({
  id: z.string(),
  component: z.string(),
  startFrame: z.number(),
  durationInFrames: z.number(),
  props: z.record(z.string(), z.unknown()),
  zIndex: z.number(),
}).strict();

const CompiledCaptionSchema = z.object({
  id: z.string(),
  segmentId: z.string(),
  text: z.string(),
  startFrame: z.number(),
  endFrame: z.number(),
}).strict();

const NarrationIntervalSchema = z.object({
  segmentId: z.string(),
  startMs: z.number(),
  endMs: z.number(),
}).strict();

const CompiledNarrationSchema = z.object({
  audioPath: z.string(),
  durationMs: z.number(),
  intervals: z.array(NarrationIntervalSchema),
}).strict();

const CompiledBackgroundMusicSchema = z.object({
  renderPath: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
}).strict();

export const CompiledTimelineSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  width: z.literal(1920),
  height: z.literal(1080),
  fps: z.literal(30),
  durationInFrames: z.number(),
  inputHashes: z.record(z.string(), z.string()),
  visualClips: z.array(CompiledVisualClipSchema),
  overlays: z.array(CompiledOverlaySchema),
  captions: z.array(CompiledCaptionSchema),
  narration: CompiledNarrationSchema,
  backgroundMusic: CompiledBackgroundMusicSchema.optional(),
}).strict();

export type CompiledTimeline = z.infer<typeof CompiledTimelineSchema>;
