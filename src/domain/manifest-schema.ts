import {z} from 'zod';
import {ProjectRelativePathSchema, StableIdSchema} from './schema-primitives';

export const AssetCompatibilitySchema = z.enum(['direct', 'transcoded', 'rejected']);

export const AssetRecordSchema = z.object({
  kind: z.enum(['video', 'image', 'audio']),
  sourcePath: ProjectRelativePathSchema,
  sourceHash: z.string(),
  renderPath: ProjectRelativePathSchema,
  durationMs: z.number().positive().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  videoCodec: z.string().optional(),
  pixelFormat: z.string().optional(),
  colorSpace: z.string().optional(),
  hasAudio: z.boolean().optional(),
  variableFrameRate: z.boolean().optional(),
  compatibility: AssetCompatibilitySchema,
}).strict();

export const NarrationSegmentRecordSchema = z.object({
  id: StableIdSchema,
  inputHash: z.string(),
  audioPath: ProjectRelativePathSchema,
  audioHash: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().positive(),
  durationMs: z.number().positive(),
  pauseAfterMs: z.number().nonnegative(),
  sampleRate: z.literal(48_000),
  channels: z.literal(1),
  providerFingerprint: z.string(),
}).strict().superRefine((segment, context) => {
  if (segment.endMs <= segment.startMs) {
    context.addIssue({
      code: 'custom',
      path: ['endMs'],
      message: 'endMs must be greater than startMs',
    });
  }
});

export const AssetManifestSchema = z.object({
  version: z.literal(1),
  assets: z.record(StableIdSchema, AssetRecordSchema),
}).strict();

const NarrationMasterSchema = z.object({
  audioPath: ProjectRelativePathSchema,
  audioHash: z.string(),
  durationMs: z.number().positive(),
}).strict();

export const NarrationManifestSchema = z.object({
  version: z.literal(1),
  provider: z.enum(['macos-say', 'file', 'mock']),
  segments: z.array(NarrationSegmentRecordSchema).superRefine((segments, context) => {
    const ids = new Set<string>();
    for (const [index, segment] of segments.entries()) {
      if (ids.has(segment.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate narration segment id: ${segment.id}`,
        });
      }
      ids.add(segment.id);
    }
  }),
  master: NarrationMasterSchema,
}).strict();

export const CaptionCueSchema = z.object({
  id: StableIdSchema,
  segmentId: StableIdSchema,
  text: z.string(),
  startMs: z.number().nonnegative(),
  endMs: z.number().positive(),
}).strict().superRefine((cue, context) => {
  if (cue.endMs <= cue.startMs) {
    context.addIssue({
      code: 'custom',
      path: ['endMs'],
      message: 'endMs must be greater than startMs',
    });
  }
});

export const CaptionsManifestSchema = z.object({
  version: z.literal(1),
  sourceNarrationHash: z.string(),
  cues: z.array(CaptionCueSchema).superRefine((cues, context) => {
    const ids = new Set<string>();
    for (const [index, cue] of cues.entries()) {
      if (ids.has(cue.id)) {
        context.addIssue({
          code: 'custom',
          path: [index, 'id'],
          message: `duplicate caption cue id: ${cue.id}`,
        });
      }
      ids.add(cue.id);
    }
  }),
}).strict();

export type AssetCompatibility = z.infer<typeof AssetCompatibilitySchema>;
export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type NarrationSegmentRecord = z.infer<typeof NarrationSegmentRecordSchema>;
export type AssetManifest = z.infer<typeof AssetManifestSchema>;
export type NarrationManifest = z.infer<typeof NarrationManifestSchema>;
export type CaptionCue = z.infer<typeof CaptionCueSchema>;
export type CaptionsManifest = z.infer<typeof CaptionsManifestSchema>;
