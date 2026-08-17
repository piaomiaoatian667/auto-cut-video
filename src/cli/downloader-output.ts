import type {DownloadErrorCode} from '../download/errors';
import type {SetupDownloaderResult} from '../download/toolchain/types';

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

export const formatDownloaderCommandFailure = (
  command: 'setup-downloader' | 'doctor-downloader',
  code: DownloadErrorCode,
  message: string,
  json: boolean,
): string => json
  ? `${JSON.stringify({command, ok: false, code, message}, null, 2)}\n`
  : `${command} failed [${code}]: ${message}\n`;
