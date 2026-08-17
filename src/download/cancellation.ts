import {ProcessExecutionError} from '../process/process-error';

export const DOWNLOAD_CANCELLATION_MESSAGE =
  'The download operation was cancelled.';

export class DownloadCancellationError extends Error {
  constructor() {
    super(DOWNLOAD_CANCELLATION_MESSAGE);
    this.name = 'DownloadCancellationError';
  }
}

export const isDownloadCancellationError = (
  error: unknown,
): error is DownloadCancellationError => error instanceof DownloadCancellationError;

export const downloadCancellationFrom = (
  error: unknown,
): DownloadCancellationError | undefined => {
  if (isDownloadCancellationError(error)) return error;
  if (
    error instanceof ProcessExecutionError
    && error.code === 'PROCESS_ABORTED'
  ) {
    return new DownloadCancellationError();
  }
  return undefined;
};

export const throwIfDownloadCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true) throw new DownloadCancellationError();
};
