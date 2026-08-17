import path from 'node:path';
import {DownloadError} from '../errors';

type OverridePathInputs = Readonly<Record<string, string | undefined>>;

const invalidToolchain = (): DownloadError => new DownloadError(
  'DOWNLOAD_TOOLCHAIN_INVALID',
  'The managed downloader failed integrity or capability checks.',
);

export const snapshotOverridePaths = <Inputs extends OverridePathInputs>(
  inputs: Inputs,
): Inputs => {
  const relativeInputPresent = Object.values(inputs).some((candidate) =>
    candidate !== undefined && !path.isAbsolute(candidate));
  let resolutionCwd: string | undefined;
  if (relativeInputPresent) {
    try {
      resolutionCwd = process.cwd();
    } catch {
      throw invalidToolchain();
    }
  }
  return Object.fromEntries(Object.entries(inputs).map(([key, candidate]) => {
    if (candidate === undefined || path.isAbsolute(candidate)) {
      return [key, candidate];
    }
    if (resolutionCwd === undefined) throw invalidToolchain();
    return [key, path.resolve(resolutionCwd, candidate)];
  })) as Inputs;
};
