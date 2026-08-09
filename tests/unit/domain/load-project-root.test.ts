import {rename, symlink} from 'node:fs/promises';
import path from 'node:path';
import {expect, it, onTestFinished, vi} from 'vitest';
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';

const openCalls = vi.hoisted(() => [] as Array<{
  projectDirectory: ProjectDirectoryScope;
  relativePath: string;
}>);

vi.mock('../../../src/fs/project-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fs/project-paths')>();
  return {
    ...actual,
    openExistingProjectFile: async (
      projectDirectory: ProjectDirectoryScope,
      relativePath: string,
    ) => {
      openCalls.push({projectDirectory, relativePath});
      return await actual.openExistingProjectFile(projectDirectory, relativePath);
    },
  };
});

import {loadProject} from '../../../src/domain/load-project';
import {createTempProject} from '../../helpers/temp-project';

it('uses one opaque project scope and project-relative authoring paths', async () => {
  const temp = await createTempProject();
  onTestFinished(temp.cleanup);
  const storedProject = path.join(temp.workspaceRoot, 'stored-demo');
  await rename(temp.projectRoot, storedProject);
  await symlink('../stored-demo', temp.projectRoot);

  const inputs = await loadProject(temp.workspaceRoot, 'demo');

  expect(inputs).toMatchObject({project: {id: 'demo'}});
  expect(Object.keys(inputs.projectDirectory)).toEqual([]);
  expect(openCalls.map(({relativePath}) => relativePath)).toEqual([
    'project.json',
    'script.json',
    'edit.json',
  ]);
  expect(openCalls.every(({projectDirectory}) => (
    projectDirectory === inputs.projectDirectory
  ))).toBe(true);
});
