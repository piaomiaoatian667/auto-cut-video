import type {FileHandle} from 'node:fs/promises';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';

const pathMocks = vi.hoisted(() => ({
  openExistingProjectFile: vi.fn(),
}));

vi.mock('../../../src/fs/project-paths', () => ({
  openExistingProjectFile: pathMocks.openExistingProjectFile,
}));

import {JsonFileError, readJson} from '../../../src/fs/json-files';

const schema = z.object({value: z.string()}).strict();
const projectDirectory = {} as ProjectDirectoryScope;

const createHandle = (source: string, closeCause?: unknown) => {
  const close = closeCause === undefined
    ? vi.fn().mockResolvedValue(undefined)
    : vi.fn().mockRejectedValue(closeCause);
  const handle = {
    readFile: vi.fn().mockResolvedValue(source),
    close,
  } as unknown as FileHandle;
  return {handle, close};
};

describe('readJson', () => {
  beforeEach(() => {
    pathMocks.openExistingProjectFile.mockReset();
  });

  it('owns and closes the opened handle after a successful parse', async () => {
    const {handle, close} = createHandle('{"value":"ok"}');
    pathMocks.openExistingProjectFile.mockResolvedValue(handle);

    await expect(
      readJson(projectDirectory, 'project.json', schema),
    ).resolves.toEqual({value: 'ok'});
    expect(pathMocks.openExistingProjectFile).toHaveBeenCalledWith(
      projectDirectory,
      'project.json',
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it('wraps malformed JSON and still closes its handle', async () => {
    const {handle, close} = createHandle('{');
    pathMocks.openExistingProjectFile.mockResolvedValue(handle);

    await expect(
      readJson(projectDirectory, 'script.json', schema),
    ).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'script.json',
      cause: expect.any(SyntaxError),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves malformed JSON as primary when close also fails', async () => {
    const closeCause = Object.assign(new Error('close failed'), {code: 'EIO'});
    const {handle, close} = createHandle('{', closeCause);
    pathMocks.openExistingProjectFile.mockResolvedValue(handle);

    await expect(
      readJson(projectDirectory, 'script.json', schema),
    ).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'script.json',
      cause: expect.any(SyntaxError),
      closeCause,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('wraps Zod failures and still closes its handle', async () => {
    const {handle, close} = createHandle('{"value":42}');
    pathMocks.openExistingProjectFile.mockResolvedValue(handle);

    await expect(
      readJson(projectDirectory, 'edit.json', schema),
    ).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'edit.json',
      cause: expect.objectContaining({name: 'ZodError'}),
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('preserves Zod failure as primary when close also fails', async () => {
    const closeCause = Object.assign(new Error('close failed'), {code: 'EIO'});
    const {handle, close} = createHandle('{"value":42}', closeCause);
    pathMocks.openExistingProjectFile.mockResolvedValue(handle);

    await expect(
      readJson(projectDirectory, 'edit.json', schema),
    ).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'edit.json',
      cause: expect.objectContaining({name: 'ZodError'}),
      closeCause,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('wraps a close-only failure with the JSON file path', async () => {
    const closeCause = Object.assign(new Error('close failed'), {code: 'EIO'});
    const {handle, close} = createHandle('{"value":"ok"}', closeCause);
    pathMocks.openExistingProjectFile.mockResolvedValue(handle);

    await expect(
      readJson(projectDirectory, 'project.json', schema),
    ).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'project.json',
      cause: closeCause,
      closeCause,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('wraps open failures without fabricating a handle to close', async () => {
    const cause = Object.assign(new Error('blocked'), {
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
    pathMocks.openExistingProjectFile.mockRejectedValue(cause);

    await expect(
      readJson(projectDirectory, 'project.json', schema),
    ).rejects.toEqual(expect.objectContaining({
      name: 'JsonFileError',
      filePath: 'project.json',
      cause,
    }));
    expect(pathMocks.openExistingProjectFile).toHaveBeenCalledOnce();
  });

  it('exposes a diagnostic error type', () => {
    const cause = new SyntaxError('bad JSON');
    expect(new JsonFileError('project.json', cause)).toMatchObject({
      name: 'JsonFileError',
      filePath: 'project.json',
      cause,
    });
  });
});
