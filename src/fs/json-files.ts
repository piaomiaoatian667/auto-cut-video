import {readFile} from 'node:fs/promises';
import type {ZodType} from 'zod';

export async function readJson<T>(filePath: string, schema: ZodType<T>): Promise<T> {
  const source = await readFile(filePath, 'utf8');
  return schema.parse(JSON.parse(source));
}
