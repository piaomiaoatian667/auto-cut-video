import {mkdtemp, mkdir, readFile, realpath, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  openNewProjectFile,
  resolveExistingProjectPath,
} from '../../../src/fs/project-paths';

describe('resolveExistingProjectPath', () => {
  it('accepts a regular file inside the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    await mkdir(path.join(root, 'assets'), {recursive: true});
    await writeFile(path.join(root, 'assets', 'clip.mp4'), 'fixture');

    await expect(resolveExistingProjectPath(root, 'assets/clip.mp4')).resolves.toBe(
      await realpath(path.join(root, 'assets', 'clip.mp4')),
    );
  });

  it('rejects a symlink that resolves outside the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
    await writeFile(path.join(outside, 'secret.mp4'), 'fixture');
    await symlink(path.join(outside, 'secret.mp4'), path.join(root, 'escape.mp4'));

    await expect(resolveExistingProjectPath(root, 'escape.mp4')).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
  });

  it('rejects lexical traversal outside a same-prefix sibling', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'video-parent-'));
    const root = path.join(parent, 'project');
    const sibling = path.join(parent, 'project-secret');
    await mkdir(root);
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'secret.mp4'), 'fixture');

    await expect(
      resolveExistingProjectPath(root, '../project-secret/secret.mp4'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });
});

describe('openNewProjectFile', () => {
  it('does not follow a writable target symlink outside the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'unchanged');
    await symlink(secret, path.join(root, 'report.json'));

    await expect(openNewProjectFile(root, 'report.json')).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
    await expect(readFile(secret, 'utf8')).resolves.toBe('unchanged');
  });

  it('rejects a writable parent symlink outside the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
    await symlink(outside, path.join(root, 'reports'));

    await expect(openNewProjectFile(root, 'reports/report.json')).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
  });

  it('creates a new file without replacing an existing target', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    const target = path.join(root, 'report.json');
    const handle = await openNewProjectFile(root, 'report.json');
    await handle.writeFile('first');
    await handle.close();

    await expect(openNewProjectFile(root, 'report.json')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(readFile(target, 'utf8')).resolves.toBe('first');
  });
});
