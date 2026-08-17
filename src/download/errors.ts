export type DownloadErrorCode =
  | 'DOWNLOAD_RIGHTS_NOT_CONFIRMED'
  | 'DOWNLOAD_URL_INVALID'
  | 'DOWNLOAD_HOST_UNSUPPORTED'
  | 'DOWNLOAD_OUTPUT_INVALID'
  | 'DOWNLOAD_COOKIE_OPTIONS_INVALID'
  | 'DOWNLOAD_COOKIE_HOST_UNSUPPORTED'
  | 'DOWNLOAD_CONTENT_RESTRICTED'
  | 'DOWNLOAD_TOOL_MISSING'
  | 'DOWNLOAD_PROBE_FAILED'
  | 'DOWNLOAD_EXTRACTOR_MISMATCH'
  | 'DOWNLOAD_DESTINATION_CONFLICT'
  | 'DOWNLOAD_PROCESS_FAILED'
  | 'DOWNLOAD_ARCHIVE_INVALID'
  | 'DOWNLOAD_FINALIZE_FAILED'
  | 'DOWNLOAD_TOOLCHAIN_MISSING'
  | 'DOWNLOAD_TOOLCHAIN_INVALID'
  | 'DOWNLOAD_PROXY_INVALID'
  | 'DOWNLOAD_IMPERSONATION_UNAVAILABLE'
  | 'DOWNLOAD_PO_TOKEN_UNAVAILABLE'
  | 'DOWNLOAD_NETWORK_UNREACHABLE'
  | 'DOWNLOAD_RATE_LIMITED'
  | 'DOWNLOAD_PLATFORM_CHALLENGE';

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DownloadError';
  }
}

export const isDownloadError = (error: unknown): error is DownloadError =>
  error instanceof DownloadError;
