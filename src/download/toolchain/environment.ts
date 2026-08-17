import path from 'node:path';

const SYSTEM_EXECUTABLE_DIRECTORIES = [
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

export const buildToolchainExecutablePath = (
  sourcePath: string | undefined,
): string => [...new Set([
  ...(sourcePath ?? '')
    .split(path.delimiter)
    .filter((entry) => path.isAbsolute(entry)),
  ...SYSTEM_EXECUTABLE_DIRECTORIES,
])].join(path.delimiter);
