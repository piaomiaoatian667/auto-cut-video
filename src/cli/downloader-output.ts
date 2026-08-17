import type {DownloadErrorCode} from '../download/errors';
import type {DownloadCheckResult} from '../download/downloader';
import type {SetupDownloaderResult} from '../download/toolchain/types';
import type {DoctorDownloaderReport} from './commands/doctor-downloader';

export const formatSetupDownloaderSuccess = (
  result: SetupDownloaderResult,
  json: boolean,
): string => json
  ? `${JSON.stringify({
      command: 'setup-downloader',
      ok: true,
      status: result.status,
      version: result.version,
    }, null, 2)}\n`
  : result.status === 'installed'
    ? `Downloader installed: ${result.version}\n`
    : `Downloader already installed: ${result.version}\n`;

export const formatDoctorDownloaderSuccess = (
  toolchain: DoctorDownloaderReport,
  check: DownloadCheckResult | undefined,
  json: boolean,
): string => {
  const report = {
    command: 'doctor-downloader' as const,
    ok: true as const,
    toolchain,
    ...(check === undefined ? {} : {check}),
  };
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  return [
    `Downloader: ${toolchain.ytDlpVersion} (${toolchain.source})`,
    'Integrity: verified',
    'Deno/EJS/PO provider/Chrome impersonation/FFmpeg: available',
    ...(check === undefined
      ? []
      : [`Check: ${check.platform} ${check.result}`]),
    '',
  ].join('\n');
};

export const formatDownloaderCommandFailure = (
  command: 'setup-downloader' | 'doctor-downloader',
  code: DownloadErrorCode,
  message: string,
  json: boolean,
): string => json
  ? `${JSON.stringify({command, ok: false, code, message}, null, 2)}\n`
  : `${command} failed [${code}]: ${message}\n`;
