import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {StableIdSchema} from '../domain/schema-primitives';
import {
  ensureRunDirectory,
  openExistingRunFileForRead,
  openNewRunFileForWrite,
  type AppDirectoryWriteFileAuthority,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import type {PipelineArtifact} from './artifacts';
import {STAGE_PRESETS} from './presets';
import type {PipelinePreset, StageId} from './run-store';
import type {CheckResult} from './types';

export interface StageReport {
  version: 1;
  projectId: string;
  runId: string;
  preset: PipelinePreset;
  stageId: StageId;
  position: number;
  total: number;
  state: 'passed' | 'cached' | 'needs_review' | 'failed' | 'cancelled';
  fingerprint: string | null;
  startedAt: string;
  finishedAt: string;
  artifacts: PipelineArtifact[];
  outputs?: unknown;
  checks: CheckResult[];
  provenance?: {
    sourceRunId: string;
    sourceStageId: StageId;
  };
  error?: {
    code: string;
    message: string;
  };
}

const PIPELINE_PRESET_IDS = Object.keys(STAGE_PRESETS) as [
  PipelinePreset,
  ...PipelinePreset[],
];

const CanonicalIsoTimestampSchema = z.string().refine((value) => {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}, 'must be a canonical ISO timestamp');

const PipelineArtifactSchema = z.object({
  scope: z.enum(['run', 'output']),
  path: z.string().min(1),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();

const CheckResultSchema = z.object({
  id: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string(),
  requiresReview: z.boolean().optional(),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
  expected: z.union([z.string(), z.number(), z.boolean()]).optional(),
  affectedPaths: z.array(z.string()).optional(),
  suggestedAction: z.string().optional(),
}).strict().transform((check): CheckResult => {
  const normalized: CheckResult = {
    id: check.id,
    severity: check.severity,
    message: check.message,
  };
  if (check.requiresReview !== undefined) {
    normalized.requiresReview = check.requiresReview;
  }
  if (check.value !== undefined) normalized.value = check.value;
  if (check.expected !== undefined) normalized.expected = check.expected;
  if (check.affectedPaths !== undefined) {
    normalized.affectedPaths = check.affectedPaths;
  }
  if (check.suggestedAction !== undefined) {
    normalized.suggestedAction = check.suggestedAction;
  }
  return normalized;
});

const StageReportBaseSchema = z.object({
  version: z.literal(1),
  projectId: StableIdSchema,
  runId: StableIdSchema,
  preset: z.enum(PIPELINE_PRESET_IDS),
  stageId: z.enum(STAGE_PRESETS.release),
  position: z.number().int().positive(),
  total: z.number().int().positive(),
  state: z.enum(['passed', 'cached', 'needs_review', 'failed', 'cancelled']),
  fingerprint: z.string().nullable(),
  startedAt: CanonicalIsoTimestampSchema,
  finishedAt: CanonicalIsoTimestampSchema,
  artifacts: z.array(PipelineArtifactSchema),
  outputs: z.unknown().optional(),
  checks: z.array(CheckResultSchema),
  provenance: z.object({
    sourceRunId: StableIdSchema,
    sourceStageId: z.enum(STAGE_PRESETS.release),
  }).strict().optional(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }).strict().optional(),
}).strict().superRefine((report, context) => {
  if (report.position > report.total) {
    context.addIssue({
      code: 'custom',
      path: ['position'],
      message: 'position must be less than or equal to total',
    });
  }
  if (
    (report.state === 'passed' || report.state === 'cached')
    && report.fingerprint === null
  ) {
    context.addIssue({
      code: 'custom',
      path: ['fingerprint'],
      message: `${report.state} reports require a fingerprint`,
    });
  }
  if (
    (report.state === 'failed' || report.state === 'cancelled')
    && report.error === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['error'],
      message: `${report.state} reports require an error`,
    });
  }
});

export const StageReportSchema: z.ZodType<StageReport> =
  StageReportBaseSchema.transform((report): StageReport => {
    const normalized: StageReport = {
      version: report.version,
      projectId: report.projectId,
      runId: report.runId,
      preset: report.preset,
      stageId: report.stageId,
      position: report.position,
      total: report.total,
      state: report.state,
      fingerprint: report.fingerprint,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      artifacts: report.artifacts,
      checks: report.checks,
    };
    if (report.outputs !== undefined) normalized.outputs = report.outputs;
    if (report.provenance !== undefined) {
      normalized.provenance = report.provenance;
    }
    if (report.error !== undefined) normalized.error = report.error;
    return normalized;
  });

export interface StageReportStore {
  readStage(
    run: RunDirectoryScope,
    stageId: StageId,
  ): Promise<StageReport | null>;
  writeStage(run: RunDirectoryScope, report: StageReport): Promise<void>;
  writeAttempt(run: RunDirectoryScope, report: StageReport): Promise<string>;
}

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const invalidReport = (message: string): TypeError =>
  new TypeError(`STAGE_REPORT_INVALID: ${message}`);

const serializeReport = (report: StageReport): string =>
  `${JSON.stringify(report, null, 2)}\n`;

const rollbackReportWrite = async (
  target: AppDirectoryWriteFileAuthority,
  relativePath: string,
  primaryError: unknown,
): Promise<never> => {
  const cleanupErrors: unknown[] = [];
  try {
    await target.unlink();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await target.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      `Stage report rollback failed for ${relativePath}`,
      {cause: primaryError},
    );
  }
  throw primaryError;
};

const writeImmutableReport = async (
  run: RunDirectoryScope,
  relativePath: string,
  report: StageReport,
): Promise<void> => {
  let target: AppDirectoryWriteFileAuthority | undefined;
  try {
    target = await openNewRunFileForWrite(run, relativePath);
    await target.handle.writeFile(serializeReport(report));
    await target.syncAndSeal();
    await target.revalidate();
    await target.close();
    target = undefined;
  } catch (error) {
    if (target !== undefined) {
      return await rollbackReportWrite(target, relativePath, error);
    }
    throw error;
  }
};

const readCanonicalReport = async (
  run: RunDirectoryScope,
  stageId: StageId,
): Promise<StageReport | null> => {
  let authority;
  try {
    authority = await openExistingRunFileForRead(
      run,
      `reports/${stageId}.json`,
    );
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
  try {
    const report = StageReportSchema.parse(JSON.parse(
      await authority.handle.readFile('utf8'),
    ));
    if (report.state !== 'passed' && report.state !== 'cached') {
      throw invalidReport('canonical reports must be passed or cached');
    }
    if (report.stageId !== stageId) {
      throw invalidReport(`canonical report Stage ID must be ${stageId}`);
    }
    await authority.revalidate();
    return report;
  } finally {
    await authority.close();
  }
};

export const createStageReportStore = (): StageReportStore => ({
  readStage: async (run, stageId) => await readCanonicalReport(run, stageId),
  writeStage: async (run, report) => {
    const validated = StageReportSchema.parse(report);
    if (validated.state !== 'passed' && validated.state !== 'cached') {
      throw invalidReport('canonical reports must be passed or cached');
    }
    await ensureRunDirectory(run, 'reports');
    await writeImmutableReport(
      run,
      `reports/${validated.stageId}.json`,
      validated,
    );
  },
  writeAttempt: async (run, report) => {
    const validated = StageReportSchema.parse(report);
    if (validated.state === 'passed' || validated.state === 'cached') {
      throw invalidReport('attempt reports must not be passed or cached');
    }
    await ensureRunDirectory(run, 'reports/attempts');
    const attemptId = `${validated.stageId}-${randomUUID()}`;
    await writeImmutableReport(
      run,
      `reports/attempts/${attemptId}.json`,
      validated,
    );
    return attemptId;
  },
});
