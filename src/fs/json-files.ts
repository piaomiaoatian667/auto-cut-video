import type {FileHandle} from 'node:fs/promises';
import type {ZodType} from 'zod';
import {
  openExistingProjectFile,
  type ProjectDirectoryScope,
} from './project-paths';

export class JsonFileError extends Error {
  constructor(
    readonly filePath: string,
    cause: unknown,
    readonly closeCause?: unknown,
  ) {
    super(`failed to load JSON file: ${filePath}`, {cause});
    this.name = 'JsonFileError';
  }
}

/** Acquires ownership of the opened handle and always closes it before returning. */
export async function readJson<T>(
  projectDirectory: ProjectDirectoryScope,
  filePath: string,
  schema: ZodType<T>,
): Promise<T> {
  let handle: FileHandle | undefined;
  let result!: T;
  let primaryFailed = false;
  let primaryCause: unknown;
  try {
    handle = await openExistingProjectFile(projectDirectory, filePath);
    const source = await handle.readFile('utf8');
    result = schema.parse(JSON.parse(source));
  } catch (cause) {
    primaryFailed = true;
    primaryCause = cause;
  }

  let closeFailed = false;
  let closeCause: unknown;
  try {
    await handle?.close();
  } catch (cause) {
    closeFailed = true;
    closeCause = cause;
  }

  if (primaryFailed) {
    throw new JsonFileError(
      filePath,
      primaryCause,
      closeFailed ? closeCause : undefined,
    );
  }
  if (closeFailed) throw new JsonFileError(filePath, closeCause, closeCause);
  return result;
}
