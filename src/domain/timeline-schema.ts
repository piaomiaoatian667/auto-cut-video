import {z} from 'zod';
import {ProjectRelativePathSchema, StableIdSchema} from './schema-primitives';

const CompiledVisualClipSchema = z.object({
  id: StableIdSchema,
  kind: z.enum(['video', 'image']),
  renderPath: ProjectRelativePathSchema,
  startFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  sourceInMs: z.number().nonnegative().optional(),
  fit: z.enum(['cover', 'contain']),
  position: z.object({x: z.number(), y: z.number()}).strict(),
  scale: z.number().positive().max(10),
  opacity: z.number().min(0).max(1),
  fadeInFrames: z.number().int().nonnegative(),
  fadeOutFrames: z.number().int().nonnegative(),
  zIndex: z.number().int(),
}).strict();

const CompiledOverlaySchema = z.object({
  id: StableIdSchema,
  component: StableIdSchema,
  startFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  props: z.record(z.string(), z.unknown()),
  zIndex: z.number().int(),
}).strict();

const CompiledCaptionSchema = z.object({
  id: StableIdSchema,
  segmentId: StableIdSchema,
  text: z.string(),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
}).strict().superRefine((caption, context) => {
  if (caption.endFrame <= caption.startFrame) {
    context.addIssue({
      code: 'custom',
      path: ['endFrame'],
      message: 'endFrame must be greater than startFrame',
    });
  }
});

const NarrationIntervalSchema = z.object({
  segmentId: StableIdSchema,
  startMs: z.number().nonnegative(),
  endMs: z.number().positive(),
}).strict().superRefine((interval, context) => {
  if (interval.endMs <= interval.startMs) {
    context.addIssue({
      code: 'custom',
      path: ['endMs'],
      message: 'endMs must be greater than startMs',
    });
  }
});

const CompiledNarrationSchema = z.object({
  audioPath: ProjectRelativePathSchema,
  durationMs: z.number().positive(),
  intervals: z.array(NarrationIntervalSchema),
}).strict();

const CompiledBackgroundMusicSchema = z.object({
  renderPath: ProjectRelativePathSchema,
  startMs: z.number().nonnegative(),
  durationMs: z.number().positive(),
}).strict();

export const CompiledTimelineSchema = z.object({
  version: z.literal(1),
  projectId: StableIdSchema,
  width: z.literal(1920),
  height: z.literal(1080),
  fps: z.literal(30),
  durationInFrames: z.number().int().positive(),
  inputHashes: z.record(z.string(), z.string()),
  visualClips: z.array(CompiledVisualClipSchema),
  overlays: z.array(CompiledOverlaySchema),
  captions: z.array(CompiledCaptionSchema),
  narration: CompiledNarrationSchema,
  backgroundMusic: CompiledBackgroundMusicSchema.optional(),
}).strict().superRefine((timeline, context) => {
  const timelineIds = new Set<string>();
  for (const [index, clip] of timeline.visualClips.entries()) {
    if (timelineIds.has(clip.id)) {
      context.addIssue({
        code: 'custom',
        path: ['visualClips', index, 'id'],
        message: `duplicate timeline id: ${clip.id}`,
      });
    }
    timelineIds.add(clip.id);
  }
  for (const [index, overlay] of timeline.overlays.entries()) {
    if (timelineIds.has(overlay.id)) {
      context.addIssue({
        code: 'custom',
        path: ['overlays', index, 'id'],
        message: `duplicate timeline id: ${overlay.id}`,
      });
    }
    timelineIds.add(overlay.id);
  }

  const captionIds = new Set<string>();
  for (const [index, caption] of timeline.captions.entries()) {
    if (captionIds.has(caption.id)) {
      context.addIssue({
        code: 'custom',
        path: ['captions', index, 'id'],
        message: `duplicate compiled caption id: ${caption.id}`,
      });
    }
    captionIds.add(caption.id);
  }
});

export type CompiledTimeline = z.infer<typeof CompiledTimelineSchema>;
