import type {
  PreflightCheck,
  PreflightResult,
} from '../pipeline/stages/preflight';
import type {CleanupResult} from '../pipeline/cleanup';
import type {ExecutionPlan} from '../pipeline/execution-plan';
import type {PipelineRunResult} from '../pipeline/runner';
import type {StageId} from '../pipeline/run-store';
import type {StageReport} from '../pipeline/stage-report';
import type {PipelineReport} from './commands/report';

type OutputCheck = Omit<PreflightCheck, 'code'> & {code?: string};

export interface DoctorFailureReport {
  command: 'doctor';
  project: string;
  ok: false;
  checks: Array<Omit<PreflightCheck, 'code'> & {code: string}>;
  toolIdentities: {
    ffmpeg: null;
    ffprobe: null;
    qtFaststart: null;
  };
  fonts: [];
  voice: null;
  versions: null;
  system: null;
  environmentFingerprint: null;
}

export interface DoctorFailure {
  id: string;
  code: string;
  message: string;
}

export interface PipelineFailure {
  projectId: string;
  code: string;
  message: string;
  stageId?: StageId;
}

const PREFLIGHT_FAILURE: DoctorFailure = {
  id: 'doctor',
  code: 'ENV_PREFLIGHT_FAILED',
  message: 'Preflight failed unexpectedly.',
};

const statusLabel = (check: OutputCheck): string => {
  switch (check.severity) {
    case 'error':
      return 'ERROR';
    case 'warning':
      return 'WARN';
    case 'info':
      return 'PASS';
  }
};

export const sanitizeTerminalText = (value: string): string => value
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/\u009b[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/\u001b[@-_]/gu, '')
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

const sanitizeTableCell = sanitizeTerminalText;

const table = (checks: readonly OutputCheck[]): string[] => {
  const rows = checks.map((check) => ({
    status: sanitizeTableCell(statusLabel(check)),
    id: sanitizeTableCell(check.id),
    code: sanitizeTableCell(check.code ?? '-'),
    message: sanitizeTableCell(check.message),
  }));
  const statusWidth = Math.max(
    'STATUS'.length,
    ...rows.map((row) => row.status.length),
  );
  const checkWidth = Math.max(
    'CHECK'.length,
    ...rows.map((row) => row.id.length),
  );
  const codeWidth = Math.max(
    'CODE'.length,
    ...rows.map((row) => row.code.length),
  );
  const row = (
    status: string,
    check: string,
    code: string,
    message: string,
  ): string => [
    status.padEnd(statusWidth),
    check.padEnd(checkWidth),
    code.padEnd(codeWidth),
    message,
  ].join('  ');

  return [
    row('STATUS', 'CHECK', 'CODE', 'MESSAGE'),
    ...rows.map((check) => row(
      check.status,
      check.id,
      check.code,
      check.message,
    )),
  ];
};

const identityValue = (
  value: string | undefined,
): string => value ?? 'unavailable';

const tableIdentityValue = (value: string | undefined): string =>
  sanitizeTableCell(identityValue(value));

export const formatDoctorTable = (
  project: string,
  result: PreflightResult,
): string => [
  `Environment doctor: ${sanitizeTableCell(project)}`,
  ...table(result.checks),
  '',
  `FFmpeg real path: ${tableIdentityValue(
    result.toolIdentities.ffmpeg?.realPath,
  )}`,
  `FFmpeg SHA-256: ${tableIdentityValue(
    result.toolIdentities.ffmpeg?.sha256,
  )}`,
  `FFprobe real path: ${tableIdentityValue(
    result.toolIdentities.ffprobe?.realPath,
  )}`,
  `FFprobe SHA-256: ${tableIdentityValue(
    result.toolIdentities.ffprobe?.sha256,
  )}`,
  `qt-faststart real path: ${tableIdentityValue(
    result.toolIdentities.qtFaststart?.realPath,
  )}`,
  `qt-faststart SHA-256: ${tableIdentityValue(
    result.toolIdentities.qtFaststart?.sha256,
  )}`,
  `Environment fingerprint: ${sanitizeTableCell(result.environmentFingerprint)}`,
  '',
].join('\n');

export const formatDoctorJson = (
  project: string,
  result: PreflightResult,
): string => `${JSON.stringify({
  command: 'doctor',
  project,
  ok: !result.checks.some((check) => check.severity === 'error'),
  ...result,
}, null, 2)}\n`;

export const createDoctorFailureReport = (
  project: string,
  failure: DoctorFailure = PREFLIGHT_FAILURE,
): DoctorFailureReport => ({
  command: 'doctor',
  project,
  ok: false,
  checks: [{
    id: failure.id,
    severity: 'error',
    code: failure.code,
    message: failure.message,
  }],
  toolIdentities: {ffmpeg: null, ffprobe: null, qtFaststart: null},
  fonts: [],
  voice: null,
  versions: null,
  system: null,
  environmentFingerprint: null,
});

export const formatDoctorFailure = (
  project: string,
  json: boolean,
  failure: DoctorFailure = PREFLIGHT_FAILURE,
): string => {
  const report = createDoctorFailureReport(project, failure);
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `Environment doctor: ${sanitizeTableCell(project)}`,
    ...table(report.checks),
    '',
    'FFmpeg real path: unavailable',
    'FFmpeg SHA-256: unavailable',
    'FFprobe real path: unavailable',
    'FFprobe SHA-256: unavailable',
    'qt-faststart real path: unavailable',
    'qt-faststart SHA-256: unavailable',
    'Environment fingerprint: unavailable',
    '',
  ].join('\n');
};

const jsonOutput = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export const formatExecutionPlan = (
  plan: ExecutionPlan,
  json: boolean,
): string => {
  if (json) return jsonOutput(plan);
  return [
    `Pipeline plan: ${sanitizeTerminalText(plan.projectId)}`,
    `Preset: ${sanitizeTerminalText(plan.preset)}`,
    `Run mode: ${sanitizeTerminalText(plan.runMode)}`,
    ...plan.items.map((item) => [
      `${item.position}/${item.total}`,
      sanitizeTerminalText(item.stageId),
      sanitizeTerminalText(item.displayName),
      sanitizeTerminalText(item.action),
      item.materialize && item.sourceRunId !== undefined
        ? `materialize from ${sanitizeTerminalText(item.sourceRunId)}`
        : undefined,
    ].filter((value) => value !== undefined).join('  ')),
    '',
  ].join('\n');
};

export const formatPipelineResult = (
  result: PipelineRunResult,
  json: boolean,
): string => {
  if (json) return jsonOutput(result);
  const lines = [
    `Pipeline result: ${sanitizeTerminalText(result.projectId)}`,
    `Preset: ${sanitizeTerminalText(result.preset)}`,
    `State: ${sanitizeTerminalText(result.state)}`,
    `Run: ${result.runId === undefined ? 'none' : sanitizeTerminalText(result.runId)}`,
    `Completed Stage: ${result.completedStage === undefined
      ? 'none'
      : sanitizeTerminalText(result.completedStage)}`,
  ];
  if (result.warnings.length > 0) {
    lines.push(
      'Warnings:',
      ...result.warnings.map((warning) => (
        `- ${sanitizeTerminalText(warning.code)}: ${sanitizeTerminalText(warning.message)}`
      )),
    );
  }
  return [...lines, ''].join('\n');
};

export const formatPipelineFailure = (
  failure: PipelineFailure,
  json: boolean,
): string => {
  if (json) return jsonOutput(failure);
  const stage = failure.stageId === undefined
    ? ''
    : ` [${sanitizeTerminalText(failure.stageId)}]`;
  return `Pipeline failure: ${sanitizeTerminalText(failure.code)}${stage}: ${sanitizeTerminalText(failure.message)}\n`;
};

const formatStageReportLine = (report: StageReport): string => [
  `${report.position}/${report.total}`,
  sanitizeTerminalText(report.stageId),
  sanitizeTerminalText(report.state),
  sanitizeTerminalText(report.runId),
].join('  ');

export const formatPipelineReport = (
  report: PipelineReport,
  json: boolean,
): string => {
  if (json) return jsonOutput(report);
  const current = report.current === null
    ? 'none'
    : [
      sanitizeTerminalText(report.current.runId),
      sanitizeTerminalText(report.current.state),
      sanitizeTerminalText(report.current.completedStage),
    ].join('  ');
  return [
    `Pipeline report: ${sanitizeTerminalText(report.projectId)}`,
    `Current: ${current}`,
    'Stages:',
    ...(report.stages.length === 0
      ? ['- none']
      : report.stages.map((stage) => `- ${formatStageReportLine(stage)}`)),
    'Attempts:',
    ...(report.attempts.length === 0
      ? ['- none']
      : report.attempts.map((attempt) => `- ${formatStageReportLine(attempt)}`)),
    '',
  ].join('\n');
};

export const formatCleanupResult = (
  result: CleanupResult,
  json: boolean,
): string => {
  if (json) return jsonOutput(result);
  const removedRuns = [...result.removedRuns].sort((left, right) => (
    left.localeCompare(right)
  ));
  const removedReleases = [...result.removedReleases].sort((left, right) => (
    left.localeCompare(right)
  ));
  return [
    'Removed Runs:',
    ...(removedRuns.length === 0
      ? ['- none']
      : removedRuns.map((runId) => `- ${sanitizeTerminalText(runId)}`)),
    'Removed Releases:',
    ...(removedReleases.length === 0
      ? ['- none']
      : removedReleases.map((releaseId) => `- ${sanitizeTerminalText(releaseId)}`)),
    '',
  ].join('\n');
};
