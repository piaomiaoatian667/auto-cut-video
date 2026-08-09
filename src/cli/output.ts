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

const table = (checks: readonly OutputCheck[]): string[] => {
  const statusWidth = Math.max(
    'STATUS'.length,
    ...checks.map((check) => statusLabel(check).length),
  );
  const checkWidth = Math.max(
    'CHECK'.length,
    ...checks.map((check) => check.id.length),
  );
  const codeWidth = Math.max(
    'CODE'.length,
    ...checks.map((check) => (check.code ?? '-').length),
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
    ...checks.map((check) => row(
      statusLabel(check),
      check.id,
      check.code ?? '-',
      check.message,
    )),
  ];
};

const identityValue = (
  value: string | undefined,
): string => value ?? 'unavailable';

export const formatDoctorTable = (
  project: string,
  result: PreflightResult,
): string => [
  `Environment doctor: ${project}`,
  ...table(result.checks),
  '',
  `FFmpeg real path: ${identityValue(result.toolIdentities.ffmpeg?.realPath)}`,
  `FFmpeg SHA-256: ${identityValue(result.toolIdentities.ffmpeg?.sha256)}`,
  `qt-faststart real path: ${identityValue(
    result.toolIdentities.qtFaststart?.realPath,
  )}`,
  `qt-faststart SHA-256: ${identityValue(
    result.toolIdentities.qtFaststart?.sha256,
  )}`,
  `Environment fingerprint: ${result.environmentFingerprint}`,
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
    `Environment doctor: ${project}`,
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
