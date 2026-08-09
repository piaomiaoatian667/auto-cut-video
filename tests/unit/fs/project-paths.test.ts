import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, onTestFinished} from 'vitest';
import {
  openExistingProjectFile,
  openNewProjectFile,
  prepareExistingProjectFile,
  prepareNewProjectFile,
  ProjectPathError,
} from '../../../src/fs/project-paths';

const makeTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, {recursive: true, force: true}));
  return directory;
};

const readAndClose = async (handle: FileHandle): Promise<string> => {
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

describe('project file handles', () => {
  it('fails fast outside Darwin', async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) throw new Error('process.platform descriptor is unavailable');
    Object.defineProperty(process, 'platform', {...platformDescriptor, value: 'linux'});
    onTestFinished(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
    });

    await expect(
      openExistingProjectFile('/path/that/must/not/be-read', 'file.json'),
    ).rejects.toMatchObject({
      code: 'ENV_PLATFORM_UNSUPPORTED',
      platform: 'linux',
    });
  });

  it('reads and creates canonical files through owned handles', async () => {
    const root = await makeTempDirectory('video-project-');
    await mkdir(path.join(root, 'assets'));
    await mkdir(path.join(root, 'reports'));
    await writeFile(path.join(root, 'assets', 'clip.txt'), 'fixture');

    const readHandle = await openExistingProjectFile(root, 'assets/clip.txt');
    await expect(readAndClose(readHandle)).resolves.toBe('fixture');

    const writeHandle = await openNewProjectFile(root, 'reports/report.json');
    try {
      await writeHandle.writeFile('{"ok":true}');
    } finally {
      await writeHandle.close();
    }
    await expect(readFile(path.join(root, 'reports', 'report.json'), 'utf8')).resolves.toBe(
      '{"ok":true}',
    );
  });

  it('rejects final and ancestor symlinks that resolve outside containment', async () => {
    const root = await makeTempDirectory('video-project-');
    const outside = await makeTempDirectory('outside-');
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'secret');
    await symlink(secret, path.join(root, 'final-link.txt'));
    await symlink(outside, path.join(root, 'ancestor-link'));

    await expect(
      openExistingProjectFile(root, 'final-link.txt'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
    await expect(
      openExistingProjectFile(root, 'ancestor-link/secret.txt'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('rejects lexical traversal to a same-prefix sibling', async () => {
    const parent = await makeTempDirectory('video-parent-');
    const root = path.join(parent, 'project');
    const sibling = path.join(parent, 'project-secret');
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'secret.txt'), 'secret');

    await expect(
      openExistingProjectFile(root, '../project-secret/secret.txt'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('canonicalizes a stable internal symlink before opening', async () => {
    const root = await makeTempDirectory('video-project-');
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'assets', 'clip.txt'), 'fixture');
    await symlink('assets', path.join(root, 'asset-link'));

    const handle = await openExistingProjectFile(root, 'asset-link/clip.txt');
    await expect(readAndClose(handle)).resolves.toBe('fixture');
  });

  it('maps read-side open-time symlink substitution to ProjectPathError', async () => {
    const root = await makeTempDirectory('video-project-');
    const outside = await makeTempDirectory('outside-');
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'assets', 'clip.txt'), 'inside');
    await writeFile(path.join(outside, 'clip.txt'), 'outside');

    const prepared = await prepareExistingProjectFile(root, 'assets/clip.txt');
    await rename(path.join(root, 'assets'), path.join(root, 'assets-original'));
    await symlink(outside, path.join(root, 'assets'));

    await expect(prepared.open()).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
      cause: expect.objectContaining({code: 'ELOOP'}),
    });
  });
});

describe('new project file handles', () => {
  it('rejects a static writable target symlink without changing its destination', async () => {
    const root = await makeTempDirectory('video-project-');
    const outside = await makeTempDirectory('outside-');
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'unchanged');
    await symlink(secret, path.join(root, 'report.json'));

    await expect(openNewProjectFile(root, 'report.json')).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
    await expect(readFile(secret, 'utf8')).resolves.toBe('unchanged');
  });

  it('rejects a writable parent symlink outside containment', async () => {
    const root = await makeTempDirectory('video-project-');
    const outside = await makeTempDirectory('outside-');
    await symlink(outside, path.join(root, 'reports'));

    await expect(openNewProjectFile(root, 'reports/report.json')).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
  });

  it('blocks canonical-parent substitution at the final open', async () => {
    const root = await makeTempDirectory('video-project-');
    const outside = await makeTempDirectory('outside-');
    await mkdir(path.join(root, 'reports'));

    const prepared = await prepareNewProjectFile(root, 'reports/report.json');
    await rename(path.join(root, 'reports'), path.join(root, 'reports-original'));
    await symlink(outside, path.join(root, 'reports'));

    await expect(prepared.open()).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
      cause: expect.objectContaining({code: 'ELOOP'}),
    });
    await expect(stat(path.join(outside, 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves EEXIST when a regular final target appears after preparation', async () => {
    const root = await makeTempDirectory('video-project-');
    const prepared = await prepareNewProjectFile(root, 'report.json');
    await writeFile(path.join(root, 'report.json'), 'competing writer');

    try {
      await prepared.open();
      expect.unreachable('expected exclusive open to reject the competing target');
    } catch (error) {
      expect(error).toMatchObject({code: 'EEXIST'});
      expect(error).not.toBeInstanceOf(ProjectPathError);
    }
    await expect(readFile(path.join(root, 'report.json'), 'utf8')).resolves.toBe(
      'competing writer',
    );
  });

  it('does not replace an existing regular target', async () => {
    const root = await makeTempDirectory('video-project-');
    const target = path.join(root, 'report.json');
    await writeFile(target, 'first');

    await expect(openNewProjectFile(root, 'report.json')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(readFile(target, 'utf8')).resolves.toBe('first');
  });
});
