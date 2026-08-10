import type {
  PreflightCheck,
  PreflightResult,
} from '../pipeline/stages/preflight';

type OutputCheck = Omit<PreflightCheck, 'code'> & {code?: string};

export interface DoctorFailureReport {
  command: 'doctor';
  project: string;
  ok: false;
  checks: Array<Omit<PreflightCheck, 'code'> & {code: string}>;
  toolIdentities: {
    ffmpeg: null;
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

const sanitizeTableCell = (value: string): string => value
  .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu, '')
  .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  .replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim();

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
  toolIdentities: {ffmpeg: null, qtFaststart: null},
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
    'qt-faststart real path: unavailable',
    'qt-faststart SHA-256: unavailable',
    'Environment fingerprint: unavailable',
    '',
  ].join('\n');
};
