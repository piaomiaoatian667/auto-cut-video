import {z} from 'zod';
import {ProjectRelativePathSchema, StableIdSchema} from './schema-primitives';

export const ScriptSegmentSchema = z.object({
  id: StableIdSchema,
  text: z.string().min(1),
  normalizedText: z.string().min(1),
  pauseAfterMs: z.number().min(0).max(5_000),
  requiredTerms: z.array(z.string().min(1)),
  audioPath: ProjectRelativePathSchema.optional(),
  notes: z.object({visualHint: z.string().min(1)}).strict().optional(),
}).strict();

export const ScriptSchema = z.object({
  version: z.literal(1),
  language: z.literal('zh-CN'),
  segments: z.array(ScriptSegmentSchema).min(1).superRefine((segments, context) => {
    const ids = new Set<string>();
    for (const [index, segment] of segments.entries()) {
      if (ids.has(segment.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate segment id: ${segment.id}`,
        });
      }
      ids.add(segment.id);
    }
  }),
}).strict();

export type Script = z.infer<typeof ScriptSchema>;
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;
