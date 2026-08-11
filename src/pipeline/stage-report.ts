import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {StableIdSchema} from '../domain/schema-primitives';
import {
  ensureRunDirectory,
  getRunDirectoryIdentity,
  openExistingRunFileForRead,
  openNewRunFileForWrite,
  unlinkRunFile,
  type AppDirectoryReadFileAuthority,
  type AppDirectoryWriteFileAuthority,
  type RunDirectoryScope,
} from '../fs/app-directory-scopes';
import type {PipelineArtifact} from './artifacts';
import {STAGE_PRESETS} from './presets';
import type {PipelinePreset, StageId} from './run-store';
import type {CheckResult} from './types';

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/u;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {[key: string]: JsonValue};

const isPlainJsonObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(JsonValueSchema),
  z.custom<Record<string, unknown>>(
    isPlainJsonObject,
    'must be a plain JSON object',
  ).pipe(z.record(z.string(), JsonValueSchema)),
]));

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
  outputs?: JsonValue;
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
  path: z.string().min(1).superRefine((value, context) => {
    if (
      value.includes('\0')
      || value.startsWith('/')
      || WINDOWS_DRIVE_PATTERN.test(value)
      || URI_SCHEME_PATTERN.test(value)
      || value.includes('\\')
      || value.split('/').some((segment) => (
        segment === '' || segment === '.' || segment === '..'
      ))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be a strict scope-relative file path',
      });
    }
  }),
  sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
}).strict();

const CheckValueSchema = z.union([
  z.string().min(1),
  z.number().finite(),
  z.boolean(),
]);

const CheckResultSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().min(1),
  requiresReview: z.boolean().optional(),
  value: CheckValueSchema.optional(),
  expected: CheckValueSchema.optional(),
  affectedPaths: z.array(z.string().min(1)).optional(),
  suggestedAction: z.string().min(1).optional(),
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
  outputs: JsonValueSchema.optional(),
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
  if (
    Object.prototype.hasOwnProperty.call(report, 'outputs')
    && report.outputs === undefined
  ) {
    context.addIssue({
      code: 'custom',
      path: ['outputs'],
      message: 'outputs must be omitted rather than undefined',
    });
  }
  const presetStages: readonly StageId[] = STAGE_PRESETS[report.preset];
  if (!presetStages.includes(report.stageId)) {
    context.addIssue({
      code: 'custom',
      path: ['stageId'],
      message: `${report.stageId} is not part of the ${report.preset} Preset`,
    });
  }
  if (report.position > report.total) {
    context.addIssue({
      code: 'custom',
      path: ['position'],
      message: 'position must be less than or equal to total',
    });
  }
  if (new Date(report.finishedAt).valueOf() < new Date(report.startedAt).valueOf()) {
    context.addIssue({
      code: 'custom',
      path: ['finishedAt'],
      message: 'finishedAt must not be before startedAt',
    });
  }
  if (
    (
      report.state === 'passed'
      || report.state === 'cached'
      || report.state === 'needs_review'
    )
    && report.fingerprint === null
  ) {
    context.addIssue({
      code: 'custom',
      path: ['fingerprint'],
      message: `${report.state} reports require a fingerprint`,
    });
  }
  if (report.state === 'failed' || report.state === 'cancelled') {
    if (report.error === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['error'],
        message: `${report.state} reports require an error`,
      });
    }
  } else if (report.error !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['error'],
      message: `${report.state} reports must not contain an error`,
    });
  }
  if (report.state === 'cached') {
    if (report.provenance === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['provenance'],
        message: 'cached reports require provenance',
      });
    } else if (report.provenance.sourceStageId !== report.stageId) {
      context.addIssue({
        code: 'custom',
        path: ['provenance', 'sourceStageId'],
        message: 'cached report provenance must match stageId',
      });
    }
  } else if (report.provenance !== undefined) {
    context.addIssue({
      code: 'custom',
      path: ['provenance'],
      message: `${report.state} reports must not contain provenance`,
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
  deleteStage?(run: RunDirectoryScope, stageId: StageId): Promise<void>;
}

export class StageReportValidationError extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = 'StageReportValidationError';
  }
}

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

const invalidReport = (message: string): StageReportValidationError =>
  new StageReportValidationError(`STAGE_REPORT_INVALID: ${message}`);

const requireMatchingRunIdentity = (
  run: RunDirectoryScope,
  report: StageReport,
): void => {
  const identity = getRunDirectoryIdentity(run);
  if (
    report.projectId !== identity.projectId
    || report.runId !== identity.runId
  ) {
    throw invalidReport('report projectId and runId must match the Run scope');
  }
};

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
    await target.syncParent();
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

const closeCommittedReportBestEffort = async (
  target: AppDirectoryWriteFileAuthority,
): Promise<void> => {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await target.close();
      return;
    } catch {}
  }
};

const writeImmutableReport = async (
  run: RunDirectoryScope,
  relativePath: string,
  report: StageReport,
): Promise<void> => {
  let target: AppDirectoryWriteFileAuthority | undefined;
  let committed = false;
  try {
    target = await openNewRunFileForWrite(run, relativePath);
    await target.handle.writeFile(serializeReport(report));
    await target.syncAndSeal();
    await target.revalidate();
    await target.syncParent();
    await target.revalidate();
    committed = true;
  } catch (error) {
    if (target !== undefined && !committed) {
      return await rollbackReportWrite(target, relativePath, error);
    }
    throw error;
  }
  if (target !== undefined && committed) {
    await closeCommittedReportBestEffort(target);
  }
};

const withReadAuthorityClose = async <Value>(
  authority: AppDirectoryReadFileAuthority,
  operation: () => Promise<Value>,
): Promise<Value> => {
  const outcome = await operation().then(
    (value) => ({ok: true, value} as const),
    (error: unknown) => ({ok: false, error} as const),
  );
  let closeError: unknown;
  try {
    await authority.close();
  } catch (error) {
    closeError = error;
  }
  if (!outcome.ok && closeError !== undefined) {
    throw new AggregateError(
      [outcome.error, closeError],
      'Stage report read and authority close both failed',
      {cause: outcome.error},
    );
  }
  if (!outcome.ok) throw outcome.error;
  if (closeError !== undefined) throw closeError;
  return outcome.value;
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
  return await withReadAuthorityClose(authority, async () => {
    const report = StageReportSchema.parse(JSON.parse(
      await authority.handle.readFile('utf8'),
    ));
    requireMatchingRunIdentity(run, report);
    if (report.state !== 'passed' && report.state !== 'cached') {
      throw invalidReport('canonical reports must be passed or cached');
    }
    if (report.stageId !== stageId) {
      throw invalidReport(`canonical report Stage ID must be ${stageId}`);
    }
    await authority.revalidate();
    return report;
  });
};

const ensureCanonicalReportDirectory = async (
  run: RunDirectoryScope,
): Promise<void> => {
  await ensureRunDirectory(run, 'reports');
};

const ensureAttemptReportDirectory = async (
  run: RunDirectoryScope,
): Promise<void> => {
  await ensureRunDirectory(run, 'reports/attempts');
};

export const createStageReportStore = (): StageReportStore => ({
  readStage: async (run, stageId) => await readCanonicalReport(run, stageId),
  writeStage: async (run, report) => {
    const validated = StageReportSchema.parse(report);
    requireMatchingRunIdentity(run, validated);
    if (validated.state !== 'passed' && validated.state !== 'cached') {
      throw invalidReport('canonical reports must be passed or cached');
    }
    await ensureCanonicalReportDirectory(run);
    await writeImmutableReport(
      run,
      `reports/${validated.stageId}.json`,
      validated,
    );
  },
  writeAttempt: async (run, report) => {
    const validated = StageReportSchema.parse(report);
    requireMatchingRunIdentity(run, validated);
    if (
      validated.state !== 'needs_review'
      && validated.state !== 'failed'
      && validated.state !== 'cancelled'
    ) {
      throw invalidReport('attempt reports must be review, failed, or cancelled');
    }
    await ensureAttemptReportDirectory(run);
    const attemptId = `${validated.stageId}-${randomUUID()}`;
    await writeImmutableReport(
      run,
      `reports/attempts/${attemptId}.json`,
      validated,
    );
    return attemptId;
  },
  deleteStage: async (run, stageId) => {
    await unlinkRunFile(run, `reports/${stageId}.json`);
  },
});
