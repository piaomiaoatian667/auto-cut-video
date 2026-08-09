import type {FileHandle} from 'node:fs/promises';
import type {ZodType} from 'zod';
import {
  openExistingProjectFile,
  type ProjectDirectoryScope,
} from './project-paths';

export class JsonFileError extends Error {
  constructor(readonly filePath: string, cause: unknown) {
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
  try {
    handle = await openExistingProjectFile(projectDirectory, filePath);
    const source = await handle.readFile('utf8');
    return schema.parse(JSON.parse(source));
  } catch (cause) {
    throw new JsonFileError(filePath, cause);
  } finally {
    await handle?.close();
  }
}
