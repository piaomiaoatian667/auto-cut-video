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

const PreflightAdapterOutputSchema = z.object({
  environmentFingerprint: z.string().min(1),
  toolIdentities: z.object({
    ffmpeg: ToolIdentitySchema.nullable(),
    qtFaststart: ToolIdentitySchema.nullable(),
  }).strict(),
  fonts: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().min(1),
  }).strict()),
}).passthrough();

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
      if (
        parsed.data.environmentFingerprint
        !== context.preflight.environmentFingerprint
      ) {
        return false;
      }
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
