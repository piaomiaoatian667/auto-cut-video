import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
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
  ProjectDirectoryScope,
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

describe('ProjectDirectoryScope', () => {
  it('is nominal under strict TypeScript', () => {
    const acceptScope = (_scope: ProjectDirectoryScope): void => undefined;

    // @ts-expect-error empty objects must not forge ProjectDirectoryScope authority
    acceptScope({});
  });

  it('does not expose an arbitrary-root static factory', () => {
    expect(Object.hasOwn(ProjectDirectoryScope, 'create')).toBe(false);

    if (false) {
      // @ts-expect-error ProjectDirectoryScope has no public static authority factory
      void ProjectDirectoryScope.create('/workspace', 'projects/demo');
    }
  });

  it('rejects runtime-forged scope instances', async () => {
    const forged = Object.create(
      ProjectDirectoryScope.prototype,
    ) as ProjectDirectoryScope;

    expect(forged).toBeInstanceOf(ProjectDirectoryScope);
    await expect(
      openExistingProjectFile(forged, 'project.json'),
    ).rejects.toThrow(TypeError);
  });

  it('rejects arbitrary app-owned roots passed as project IDs', async () => {
    const workspaceRoot = await makeTempDirectory('project-scope-workspace-');
    await mkdir(path.join(workspaceRoot, '.work', 'demo'), {recursive: true});
    await mkdir(path.join(workspaceRoot, 'output', 'demo'), {recursive: true});

    for (const projectId of ['.work/demo', 'output/demo']) {
      await expect(
        createProjectDirectoryScope(workspaceRoot, projectId),
        projectId,
      ).rejects.toMatchObject({name: 'ZodError'});
    }
  });

  it('is opaque and accepts project-relative file operations only', async () => {
    const workspaceRoot = await makeTempDirectory('project-scope-workspace-');
    const projectRoot = path.join(workspaceRoot, 'projects', 'demo');
    await mkdir(projectRoot, {recursive: true});
    await writeFile(path.join(projectRoot, 'project.json'), 'inside');

    const scope = await createProjectDirectoryScope(workspaceRoot, 'demo');

    expect(Object.keys(scope)).toEqual([]);
    expect(JSON.stringify(scope)).toBe('{}');
    expect((scope as unknown as {projectRoot?: string}).projectRoot).toBeUndefined();
    await expect(
      readAndClose(await openExistingProjectFile(scope, 'project.json')),
    ).resolves.toBe('inside');
    await expect(
      openExistingProjectFile(scope, path.join(workspaceRoot, 'project.json')),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('rejects read and write symlinks into a workspace sibling', async () => {
    const workspaceRoot = await makeTempDirectory('project-scope-workspace-');
    const projectRoot = path.join(workspaceRoot, 'projects', 'demo');
    const sharedRoot = path.join(workspaceRoot, 'shared');
    await mkdir(projectRoot, {recursive: true});
    await mkdir(sharedRoot);
    await writeFile(path.join(sharedRoot, 'secret.txt'), 'secret');
    await symlink('../../shared', path.join(projectRoot, 'shared-link'));
    const scope = await createProjectDirectoryScope(workspaceRoot, 'demo');

    await expect(
      openExistingProjectFile(scope, 'shared-link/secret.txt'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
    await expect(
      openNewProjectFile(scope, 'shared-link/injected.json'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
    await expect(readFile(path.join(sharedRoot, 'secret.txt'), 'utf8')).resolves.toBe('secret');
  });

  it('does not expand when the lexical project link changes after scope creation', async () => {
    const workspaceRoot = await makeTempDirectory('project-scope-workspace-');
    const projectsRoot = path.join(workspaceRoot, 'projects');
    const storedProject = path.join(projectsRoot, 'stored-demo');
    const replacementProject = path.join(projectsRoot, 'replacement-demo');
    const lexicalProject = path.join(projectsRoot, 'demo');
    await mkdir(projectsRoot);
    await mkdir(storedProject);
    await mkdir(replacementProject);
    await writeFile(path.join(storedProject, 'project.json'), 'stored');
    await writeFile(path.join(replacementProject, 'project.json'), 'replacement');
    await symlink('stored-demo', lexicalProject);

    const scope = await createProjectDirectoryScope(workspaceRoot, 'demo');
    await unlink(lexicalProject);
    await symlink('replacement-demo', lexicalProject);

    await expect(
      readAndClose(await openExistingProjectFile(scope, 'project.json')),
    ).resolves.toBe('stored');
  });

  it('fails closed when the saved canonical project root becomes an external symlink', async () => {
    const workspaceRoot = await makeTempDirectory('project-scope-workspace-');
    const outsideRoot = await makeTempDirectory('project-scope-outside-');
    const projectRoot = path.join(workspaceRoot, 'projects', 'demo');
    const movedProject = path.join(workspaceRoot, 'projects', 'demo-original');
    await mkdir(projectRoot, {recursive: true});
    await writeFile(path.join(projectRoot, 'project.json'), 'inside');
    await writeFile(path.join(outsideRoot, 'project.json'), 'outside');
    const scope = await createProjectDirectoryScope(workspaceRoot, 'demo');

    await rename(projectRoot, movedProject);
    await symlink(outsideRoot, projectRoot);

    await expect(
      openExistingProjectFile(scope, 'project.json'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
    await expect(
      openNewProjectFile(scope, 'injected.json'),
    ).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('rejects an initial project root that resolves outside the workspace', async () => {
    const workspaceRoot = await makeTempDirectory('project-scope-workspace-');
    const outsideRoot = await makeTempDirectory('project-scope-outside-');
    await mkdir(path.join(workspaceRoot, 'projects'));
    await symlink(outsideRoot, path.join(workspaceRoot, 'projects', 'escape'));

    await expect(createProjectDirectoryScope(
      workspaceRoot,
      'escape',
    )).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('keeps stable internal symlinks inside the project boundary usable', async () => {
    const workspaceRoot = await makeTempDirectory('project-scope-workspace-');
    const projectRoot = path.join(workspaceRoot, 'projects', 'demo');
    await mkdir(path.join(projectRoot, 'assets'), {recursive: true});
    await writeFile(path.join(projectRoot, 'assets', 'clip.txt'), 'fixture');
    await symlink('assets', path.join(projectRoot, 'asset-link'));
    const scope = await createProjectDirectoryScope(workspaceRoot, 'demo');

    await expect(
      readAndClose(await openExistingProjectFile(scope, 'asset-link/clip.txt')),
    ).resolves.toBe('fixture');
  });
});
