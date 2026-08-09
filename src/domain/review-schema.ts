import {z} from 'zod';

export const ReviewSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  status: z.enum(['approved', 'rejected']),
  reviewer: z.string().min(1),
  reviewedAt: z.string().datetime(),
  reason: z.string().min(1),
  evidencePaths: z.array(z.string().min(1)).min(1),
}).strict();

export type Review = z.infer<typeof ReviewSchema>;
