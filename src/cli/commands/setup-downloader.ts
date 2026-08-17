import {
  DownloadError,
  isDownloadError,
} from '../../download/errors';
import type {SetupDownloaderResult} from '../../download/toolchain/types';
import {
  formatDownloaderCommandFailure,
  formatSetupDownloaderSuccess,
} from '../downloader-output';
import {EXIT_CODES} from '../exit-codes';
import type {OutputWriter} from '../videoctl';

export interface SetupDownloaderCommandOptions {
  json?: boolean;
}

export interface SetupDownloaderCommandDependencies {
  stdout: OutputWriter;
  stderr: OutputWriter;
  signal?: AbortSignal;
  install(signal?: AbortSignal): Promise<SetupDownloaderResult>;
}

export const runSetupDownloaderCommand = async (
  options: SetupDownloaderCommandOptions,
  dependencies: SetupDownloaderCommandDependencies,
): Promise<number> => {
  const json = options.json === true;
  try {
    const result = await dependencies.install(dependencies.signal);
    dependencies.stdout.write(formatSetupDownloaderSuccess(result, json));
    return EXIT_CODES.success;
  } catch (error) {
    const controlled = isDownloadError(error)
      ? error
      : new DownloadError(
          'DOWNLOAD_TOOLCHAIN_INVALID',
          'The managed downloader failed integrity or capability checks.',
        );
    const output = formatDownloaderCommandFailure(
      'setup-downloader',
      controlled.code,
      controlled.message,
      json,
    );
    if (json) dependencies.stdout.write(output);
    else dependencies.stderr.write(output);
    return dependencies.signal?.aborted === true
      ? EXIT_CODES.cancelled
      : EXIT_CODES.environmentFailed;
  }
};
