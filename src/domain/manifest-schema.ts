import {z} from 'zod';

export const AssetCompatibilitySchema = z.enum(['direct', 'transcoded', 'rejected']);

export const AssetRecordSchema = z.object({
  kind: z.enum(['video', 'image', 'audio']),
  sourcePath: z.string(),
  sourceHash: z.string(),
  renderPath: z.string(),
  durationMs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  videoCodec: z.string().optional(),
  pixelFormat: z.string().optional(),
  colorSpace: z.string().optional(),
  hasAudio: z.boolean().optional(),
  variableFrameRate: z.boolean().optional(),
  compatibility: AssetCompatibilitySchema,
}).strict();

export const NarrationSegmentRecordSchema = z.object({
  id: z.string(),
  inputHash: z.string(),
  audioPath: z.string(),
  audioHash: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  durationMs: z.number(),
  pauseAfterMs: z.number(),
  sampleRate: z.literal(48_000),
  channels: z.literal(1),
  providerFingerprint: z.string(),
}).strict();

export const AssetManifestSchema = z.object({
  version: z.literal(1),
  assets: z.record(z.string(), AssetRecordSchema),
}).strict();

const NarrationMasterSchema = z.object({
  audioPath: z.string(),
  audioHash: z.string(),
  durationMs: z.number(),
}).strict();

export const NarrationManifestSchema = z.object({
  version: z.literal(1),
  provider: z.enum(['macos-say', 'file', 'mock']),
  segments: z.array(NarrationSegmentRecordSchema),
  master: NarrationMasterSchema,
}).strict();

export const CaptionCueSchema = z.object({
  id: z.string(),
  segmentId: z.string(),
  text: z.string(),
  startMs: z.number(),
  endMs: z.number(),
}).strict();

export const CaptionsManifestSchema = z.object({
  version: z.literal(1),
  sourceNarrationHash: z.string(),
  cues: z.array(CaptionCueSchema),
}).strict();

export type AssetCompatibility = z.infer<typeof AssetCompatibilitySchema>;
export type AssetRecord = z.infer<typeof AssetRecordSchema>;
export type NarrationSegmentRecord = z.infer<typeof NarrationSegmentRecordSchema>;
export type AssetManifest = z.infer<typeof AssetManifestSchema>;
export type NarrationManifest = z.infer<typeof NarrationManifestSchema>;
export type CaptionCue = z.infer<typeof CaptionCueSchema>;
export type CaptionsManifest = z.infer<typeof CaptionsManifestSchema>;
