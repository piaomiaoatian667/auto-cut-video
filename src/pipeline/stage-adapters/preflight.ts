import {z} from 'zod';
import {fingerprintValue} from '../fingerprint';
import type {PipelineStage, StagePlanningContext} from '../stage';
import {
  createSystemPreflightDependencies,
  runPreflight,
  type PreflightInput,
  type PreflightResult,
} from '../stages/preflight';
import {
  STAGE_ALGORITHM_VERSIONS,
  verifyReportedArtifacts,
} from './shared';
import type {CheckResult} from '../types';

const ToolIdentitySchema = z.object({
  realPath: z.string().min(1),
  sha256: z.string().min(1),
}).strict();

const PreflightVersionsSchema = z.object({
  node: z.string().min(1).nullable(),
  pnpm: z.string().min(1).nullable(),
  macos: z.string().min(1).nullable(),
  ffmpeg: z.string().min(1).nullable(),
  ffprobe: z.string().min(1).nullable(),
}).strict();

const PreflightVoiceSchema = z.object({
  configured: z.string().min(1),
  available: z.boolean(),
  segmentedWavFallback: z.boolean(),
}).strict();

const PreflightSystemSchema = z.object({
  platform: z.string().min(1),
  arch: z.string().min(1),
  sourceBytes: z.number().int().nonnegative(),
  requiredBytes: z.number().int().nonnegative(),
  availableBytes: z.number().int().nonnegative().nullable(),
  workDirectory: z.string().min(1),
}).strict();

export const PreflightAdapterOutputSchema = z.object({
  environmentFingerprint: z.string().min(1),
  toolIdentities: z.object({
    ffmpeg: ToolIdentitySchema.nullable(),
    ffprobe: ToolIdentitySchema.nullable(),
    qtFaststart: ToolIdentitySchema.nullable(),
  }).strict(),
  fonts: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().min(1),
  }).strict()),
  voice: PreflightVoiceSchema,
  versions: PreflightVersionsSchema,
  system: PreflightSystemSchema,
}).passthrough();

export type PreflightAdapterOutput = z.infer<typeof PreflightAdapterOutputSchema>;

export interface CanonicalPreflightAdapterOutput {
  environmentFingerprint: string;
  toolIdentities: PreflightAdapterOutput['toolIdentities'];
  fonts: PreflightAdapterOutput['fonts'];
  voice: PreflightAdapterOutput['voice'];
  versions: PreflightAdapterOutput['versions'];
  system: Pick<
    PreflightAdapterOutput['system'],
    'platform' | 'arch' | 'sourceBytes' | 'requiredBytes'
  >;
}

export const normalizePreflightAdapterOutput = (
  value: unknown,
): CanonicalPreflightAdapterOutput => {
  const parsed = PreflightAdapterOutputSchema.parse(value);
  return {
    environmentFingerprint: parsed.environmentFingerprint,
    toolIdentities: parsed.toolIdentities,
    fonts: [...parsed.fonts].sort((left, right) => (
      left.path.localeCompare(right.path) || left.sha256.localeCompare(right.sha256)
    )),
    voice: parsed.voice,
    versions: parsed.versions,
    system: {
      platform: parsed.system.platform,
      arch: parsed.system.arch,
      sourceBytes: parsed.system.sourceBytes,
      requiredBytes: parsed.system.requiredBytes,
    },
  };
};

export const parsePreflightAdapterOutput = (
  value: unknown,
): PreflightAdapterOutput => PreflightAdapterOutputSchema.parse(value);

export interface PreflightStageAdapterDependencies {
  algorithmVersion?: string;
  runPreflight?: (input: PreflightInput) => Promise<PreflightResult>;
}

const preflightFingerprint = (
  context: StagePlanningContext,
  result: PreflightResult,
  algorithmVersion: string,
): string => fingerprintValue({
  algorithmVersion,
  environmentFingerprint: result.environmentFingerprint,
  sourceCatalogFingerprint: context.sourceCatalog.fingerprint,
  fonts: [...result.fonts].sort((left, right) => (
    left.path.localeCompare(right.path) || left.sha256.localeCompare(right.sha256)
  )),
  tts: context.project.project.tts,
});

const normalizeCheck = (check: PreflightResult['checks'][number]): CheckResult => ({
  id: check.id,
  severity: check.severity,
  message: check.message,
  ...(check.requiresReview === undefined
    ? {}
    : {requiresReview: check.requiresReview}),
  ...(check.value === undefined ? {} : {value: check.value}),
  ...(check.expected === undefined ? {} : {expected: check.expected}),
  ...(check.affectedPaths === undefined
    ? {}
    : {affectedPaths: check.affectedPaths}),
  ...(check.suggestedAction === undefined
    ? {}
    : {suggestedAction: check.suggestedAction}),
});

export const createPreflightStage = (
  dependencies: PreflightStageAdapterDependencies = {},
): PipelineStage => {
  const algorithmVersion = dependencies.algorithmVersion
    ?? STAGE_ALGORITHM_VERSIONS.preflight;
  const executePreflight = dependencies.runPreflight
    ?? (async (input: PreflightInput) => await runPreflight(
      input,
      createSystemPreflightDependencies(),
    ));

  return {
    id: 'preflight',
    displayName: 'Preflight',
    prerequisites: [],
    fingerprint: async (context) => context.preflight === undefined
      ? null
      : preflightFingerprint(context, context.preflight, algorithmVersion),
    verify: async (context, report) => {
      if (context.preflight === undefined) return false;
      const parsed = PreflightAdapterOutputSchema.safeParse(report.outputs);
      if (!parsed.success) return false;
      const persisted = normalizePreflightAdapterOutput(parsed.data);
      const live = normalizePreflightAdapterOutput(context.preflight);
      if (fingerprintValue(persisted) !== fingerprintValue(live)) return false;
      if (
        report.fingerprint
        !== preflightFingerprint(context, context.preflight, algorithmVersion)
      ) {
        return false;
      }
      return await verifyReportedArtifacts({context, report, expected: []});
    },
    partialArtifacts: () => [],
    execute: async (context) => {
      const result = await executePreflight({
        workspaceRoot: context.project.workspaceRoot,
        projectDirectory: context.project.projectDirectory,
        project: context.project.project,
        script: context.project.script,
        sourceBytes: context.sourceCatalog.totalBytes,
      });
      return {
        state: 'passed',
        fingerprint: preflightFingerprint(context, result, algorithmVersion),
        outputs: result,
        artifacts: [],
        checks: result.checks.map(normalizeCheck),
      };
    },
  };
};

export const preflightStage = createPreflightStage();
