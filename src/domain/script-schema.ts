import {z} from 'zod';

const RelativePathSchema = z.string().min(1).refine(
  (value) => !value.startsWith('/') && !value.includes('..'),
);

export const ScriptSegmentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  text: z.string().min(1),
  normalizedText: z.string().min(1),
  pauseAfterMs: z.number().int().min(0).max(5_000),
  requiredTerms: z.array(z.string().min(1)),
  audioPath: RelativePathSchema.optional(),
  notes: z.object({visualHint: z.string().min(1)}).strict().optional(),
}).strict();

export const ScriptSchema = z.object({
  version: z.literal(1),
  language: z.literal('zh-CN'),
  segments: z.array(ScriptSegmentSchema).min(1).superRefine((segments, context) => {
    const ids = new Set<string>();
    for (const segment of segments) {
      if (ids.has(segment.id)) {
        context.addIssue({code: 'custom', message: `duplicate segment id: ${segment.id}`});
      }
      ids.add(segment.id);
    }
  }),
}).strict();

export type Script = z.infer<typeof ScriptSchema>;
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;
