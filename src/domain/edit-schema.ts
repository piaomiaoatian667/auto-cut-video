import {z} from 'zod';

const IdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const AssetIdSchema = IdSchema;
const TimelineBaseSchema = z.object({
  id: IdSchema,
  assetId: AssetIdSchema,
  startFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  fit: z.enum(['cover', 'contain']),
  position: z.object({x: z.number(), y: z.number()}).strict(),
  scale: z.number().positive().max(10),
  opacity: z.number().min(0).max(1),
  fadeInFrames: z.number().int().nonnegative(),
  fadeOutFrames: z.number().int().nonnegative(),
  zIndex: z.number().int(),
}).strict();

export const VisualClipSchema = z.discriminatedUnion('kind', [
  TimelineBaseSchema.extend({
    kind: z.literal('video'),
    sourceInMs: z.number().int().nonnegative(),
    sourceOutMs: z.number().int().positive(),
  }).strict(),
  TimelineBaseSchema.extend({kind: z.literal('image')}).strict(),
]).superRefine((clip, context) => {
  if (clip.kind === 'video' && clip.sourceInMs >= clip.sourceOutMs) {
    context.addIssue({
      code: 'custom',
      path: ['sourceOutMs'],
      message: 'sourceOutMs must be greater than sourceInMs',
    });
  }
});

export const EditSchema = z.object({
  version: z.literal(1),
  visualClips: z.array(VisualClipSchema).min(1),
  overlays: z.array(z.object({
    id: IdSchema,
    component: IdSchema,
    startFrame: z.number().int().nonnegative(),
    durationInFrames: z.number().int().positive(),
    props: z.record(z.string(), z.unknown()),
    zIndex: z.number().int(),
  }).strict()),
  backgroundMusic: z.object({
    assetId: AssetIdSchema,
    startMs: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict().superRefine((edit, context) => {
  const ids = new Set<string>();
  for (const item of [...edit.visualClips, ...edit.overlays]) {
    if (ids.has(item.id)) {
      context.addIssue({code: 'custom', message: `duplicate timeline id: ${item.id}`});
    }
    ids.add(item.id);
  }
});

export type Edit = z.infer<typeof EditSchema>;
export type VisualClip = z.infer<typeof VisualClipSchema>;
