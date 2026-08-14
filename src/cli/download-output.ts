import type {DownloadResult} from '../download/downloader';
import type {DownloadErrorCode} from '../download/errors';

const HUMAN_OUTPUT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu;

const escapeHumanOutput = (value: string): string => value.replace(
  HUMAN_OUTPUT_CONTROLS,
  (character) => {
    switch (character) {
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
    }
  },
);

export const formatDownloadSuccess = (
  result: DownloadResult,
  json: boolean,
): string => {
  const report = {
    command: 'download',
    ok: true,
    status: result.status,
    platform: result.platform,
    videoId: result.videoId,
    directory: result.directory,
    media: result.mediaPath,
    receipt: result.receiptPath,
  } as const;
  if (json) return `${JSON.stringify(report, null, 2)}\n`;
  const label = result.status === 'downloaded'
    ? 'Download complete'
    : 'Already downloaded';
  return [
    `${label}: ${escapeHumanOutput(result.platform)}/${escapeHumanOutput(result.videoId)}`,
    `Media: ${escapeHumanOutput(result.mediaPath)}`,
    `Receipt: ${escapeHumanOutput(result.receiptPath)}`,
    '',
  ].join('\n');
};

export const formatDownloadFailure = (
  code: DownloadErrorCode,
  message: string,
  json: boolean,
): string => {
  if (json) {
    return `${JSON.stringify({command: 'download', ok: false, code, message}, null, 2)}\n`;
  }
  return `Download failed [${escapeHumanOutput(code)}]: ${escapeHumanOutput(message)}\n`;
};
