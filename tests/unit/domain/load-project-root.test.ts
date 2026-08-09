import {realpath, rename, symlink} from 'node:fs/promises';
import path from 'node:path';
import {expect, it, onTestFinished, vi} from 'vitest';

const openCalls = vi.hoisted(() => [] as Array<{
  containmentRoot: string;
  relativePath: string;
}>);

vi.mock('../../../src/fs/project-paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fs/project-paths')>();
  return {
    ...actual,
    openExistingProjectFile: async (
      containmentRoot: string,
      relativePath: string,
    ) => {
      openCalls.push({containmentRoot, relativePath});
      return actual.openExistingProjectFile(containmentRoot, relativePath);
    },
  };
});

import {loadProject} from '../../../src/domain/load-project';
import {createTempProject} from '../../helpers/temp-project';

it('keeps workspaceRootReal as the containment root for every authoring file', async () => {
  const temp = await createTempProject();
  onTestFinished(temp.cleanup);
  const storedProject = path.join(temp.workspaceRoot, 'stored-demo');
  await rename(temp.projectRoot, storedProject);
  await symlink('../stored-demo', temp.projectRoot);

  await expect(loadProject(temp.workspaceRoot, 'demo')).resolves.toMatchObject({
    project: {id: 'demo'},
  });

  const workspaceRootReal = await realpath(temp.workspaceRoot);
  expect(openCalls).toEqual([
    {containmentRoot: workspaceRootReal, relativePath: 'projects/demo/project.json'},
    {containmentRoot: workspaceRootReal, relativePath: 'projects/demo/script.json'},
    {containmentRoot: workspaceRootReal, relativePath: 'projects/demo/edit.json'},
  ]);
});
