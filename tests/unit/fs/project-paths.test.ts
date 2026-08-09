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
  createProjectDirectoryScope,
  openExistingProjectFile,
  openNewProjectFile,
  prepareExistingProjectFile,
  prepareNewProjectFile,
  ProjectPathError,
  type ProjectDirectoryScope,
} from '../../../src/fs/project-paths';

const makeTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(directory, {recursive: true, force: true}));
  return directory;
};

const makeProjectDirectory = async (
  projectId = 'demo',
): Promise<{
  workspaceRoot: string;
  projectRoot: string;
  scope: ProjectDirectoryScope;
}> => {
  const workspaceRoot = await makeTempDirectory('video-workspace-');
  const projectRoot = path.join(workspaceRoot, 'projects', projectId);
  await mkdir(projectRoot, {recursive: true});
  return {
    workspaceRoot,
    projectRoot,
    scope: await createProjectDirectoryScope(workspaceRoot, projectId),
  };
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

    await expect(createProjectDirectoryScope(
      '/path/that/must/not-be-read',
      'demo',
    )).rejects.toMatchObject({
      code: 'ENV_PLATFORM_UNSUPPORTED',
      platform: 'linux',
    });
  });

  it('reads and creates canonical files through owned handles', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    await mkdir(path.join(projectRoot, 'assets'));
    await mkdir(path.join(projectRoot, 'reports'));
    await writeFile(path.join(projectRoot, 'assets', 'clip.txt'), 'fixture');

    const readHandle = await openExistingProjectFile(scope, 'assets/clip.txt');
    await expect(readAndClose(readHandle)).resolves.toBe('fixture');

    const writeHandle = await openNewProjectFile(scope, 'reports/report.json');
    try {
      await writeHandle.writeFile('{"ok":true}');
    } finally {
      await writeHandle.close();
    }
    await expect(
      readFile(path.join(projectRoot, 'reports', 'report.json'), 'utf8'),
    ).resolves.toBe('{"ok":true}');
  });

  it('rejects final and ancestor symlinks that resolve outside the project', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    const outside = await makeTempDirectory('outside-');
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'secret');
    await symlink(secret, path.join(projectRoot, 'final-link.txt'));
    await symlink(outside, path.join(projectRoot, 'ancestor-link'));

    await expect(
      openExistingProjectFile(scope, 'final-link.txt'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
    await expect(
      openExistingProjectFile(scope, 'ancestor-link/secret.txt'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('rejects lexical traversal to a same-prefix sibling project', async () => {
    const workspaceRoot = await makeTempDirectory('video-workspace-');
    const root = path.join(workspaceRoot, 'projects', 'project');
    const sibling = path.join(workspaceRoot, 'projects', 'project-secret');
    await mkdir(root, {recursive: true});
    await mkdir(sibling);
    await writeFile(path.join(sibling, 'secret.txt'), 'secret');
    const scope = await createProjectDirectoryScope(workspaceRoot, 'project');

    await expect(
      openExistingProjectFile(scope, '../project-secret/secret.txt'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('canonicalizes a stable internal symlink before opening', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    await mkdir(path.join(projectRoot, 'assets'));
    await writeFile(path.join(projectRoot, 'assets', 'clip.txt'), 'fixture');
    await symlink('assets', path.join(projectRoot, 'asset-link'));

    const handle = await openExistingProjectFile(scope, 'asset-link/clip.txt');
    await expect(readAndClose(handle)).resolves.toBe('fixture');
  });

  it('maps read-side open-time symlink substitution to ProjectPathError', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    const outside = await makeTempDirectory('outside-');
    await mkdir(path.join(projectRoot, 'assets'));
    await writeFile(path.join(projectRoot, 'assets', 'clip.txt'), 'inside');
    await writeFile(path.join(outside, 'clip.txt'), 'outside');

    const prepared = await prepareExistingProjectFile(scope, 'assets/clip.txt');
    await rename(
      path.join(projectRoot, 'assets'),
      path.join(projectRoot, 'assets-original'),
    );
    await symlink(outside, path.join(projectRoot, 'assets'));

    await expect(prepared.open()).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
      cause: expect.objectContaining({code: 'ELOOP'}),
    });
  });
});

describe('new project file handles', () => {
  it('rejects a static writable target symlink without changing its destination', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    const outside = await makeTempDirectory('outside-');
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'unchanged');
    await symlink(secret, path.join(projectRoot, 'report.json'));

    await expect(openNewProjectFile(scope, 'report.json')).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
    await expect(readFile(secret, 'utf8')).resolves.toBe('unchanged');
  });

  it('rejects a writable parent symlink outside the project', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    const outside = await makeTempDirectory('outside-');
    await symlink(outside, path.join(projectRoot, 'reports'));

    await expect(
      openNewProjectFile(scope, 'reports/report.json'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('blocks canonical-parent substitution at the final open', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    const outside = await makeTempDirectory('outside-');
    await mkdir(path.join(projectRoot, 'reports'));

    const prepared = await prepareNewProjectFile(scope, 'reports/report.json');
    await rename(
      path.join(projectRoot, 'reports'),
      path.join(projectRoot, 'reports-original'),
    );
    await symlink(outside, path.join(projectRoot, 'reports'));

    await expect(prepared.open()).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
      cause: expect.objectContaining({code: 'ELOOP'}),
    });
    await expect(stat(path.join(outside, 'report.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves EEXIST when a regular final target appears after preparation', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    const prepared = await prepareNewProjectFile(scope, 'report.json');
    await writeFile(path.join(projectRoot, 'report.json'), 'competing writer');

    try {
      await prepared.open();
      expect.unreachable('expected exclusive open to reject the competing target');
    } catch (error) {
      expect(error).toMatchObject({code: 'EEXIST'});
      expect(error).not.toBeInstanceOf(ProjectPathError);
    }
    await expect(readFile(path.join(projectRoot, 'report.json'), 'utf8')).resolves.toBe(
      'competing writer',
    );
  });

  it('does not replace an existing regular target', async () => {
    const {projectRoot, scope} = await makeProjectDirectory();
    const target = path.join(projectRoot, 'report.json');
    await writeFile(target, 'first');

    await expect(openNewProjectFile(scope, 'report.json')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await expect(readFile(target, 'utf8')).resolves.toBe('first');
  });
});
