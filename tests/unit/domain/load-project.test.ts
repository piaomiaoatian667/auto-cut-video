import {realpath, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it, onTestFinished} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import {ProjectDirectoryScope} from '../../../src/fs/project-paths';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
  createTempProject,
} from '../../helpers/temp-project';

describe('loadProject', () => {
  it('loads and validates all authoring files', async () => {
    const temp = await createTempProject();
    onTestFinished(temp.cleanup);

    const inputs = await loadProject(temp.workspaceRoot, 'demo');

    expect(inputs).toMatchObject({
      workspaceRoot: await realpath(temp.workspaceRoot),
      projectDirectory: expect.any(ProjectDirectoryScope),
      project: {id: 'demo'},
      script: {segments: [{id: 'intro'}]},
      edit: {visualClips: [{id: 'opening'}]},
    });
    expect('projectRoot' in inputs).toBe(false);
  });

  it('fails when an authoring file contains malformed JSON', async () => {
    const temp = await createTempProject();
    onTestFinished(temp.cleanup);
    await writeFile(path.join(temp.projectRoot, 'script.json'), '{');

    await expect(loadProject(temp.workspaceRoot, 'demo')).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'script.json',
      cause: expect.any(SyntaxError),
    });
  });

  it('rejects unknown fields through the strict schemas', async () => {
    const project = {
      ...createProjectFixture(),
      remoteProjectId: 'not-allowed',
    };
    const temp = await createTempProject({project});
    onTestFinished(temp.cleanup);

    await expect(loadProject(temp.workspaceRoot, 'demo')).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'project.json',
      cause: expect.objectContaining({
        name: 'ZodError',
        issues: expect.arrayContaining([
          expect.objectContaining({code: 'unrecognized_keys'}),
        ]),
      }),
    });
  });

  it('rejects project IDs containing slash or double-dot sequences', async () => {
    const temp = await createTempProject();
    onTestFinished(temp.cleanup);

    for (const projectId of ['demo/escape', '..', 'demo..escape']) {
      await expect(loadProject(temp.workspaceRoot, projectId), projectId).rejects.toMatchObject({
        name: 'ZodError',
      });
    }
  });

  it('rejects a project directory symlink outside the workspace', async () => {
    const workspace = await createTempProject();
    const outside = await createTempProject({projectId: 'escape'});
    onTestFinished(workspace.cleanup);
    onTestFinished(outside.cleanup);
    await symlink(
      outside.projectRoot,
      path.join(workspace.workspaceRoot, 'projects', 'escape'),
    );

    await expect(loadProject(workspace.workspaceRoot, 'escape')).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
    });
  });

  it('rejects a project.json id that does not match its directory id', async () => {
    const temp = await createTempProject({
      project: createProjectFixture('other-project'),
      script: '{',
      edit: '{',
    });
    onTestFinished(temp.cleanup);

    await expect(loadProject(temp.workspaceRoot, 'demo')).rejects.toMatchObject({
      code: 'PROJECT_ID_MISMATCH',
      requestedProjectId: 'demo',
      declaredProjectId: 'other-project',
    });
  });

  it('runs cross-file validation only after all three schemas parse', async () => {
    const editWithUnknownField = {
      ...createEditFixture(),
      remoteTimeline: true,
    };
    const temp = await createTempProject({
      project: createProjectFixture('demo', 8),
      script: createScriptFixture('123456789'),
      edit: editWithUnknownField,
    });
    onTestFinished(temp.cleanup);

    await expect(loadProject(temp.workspaceRoot, 'demo')).rejects.toMatchObject({
      name: 'JsonFileError',
      filePath: 'edit.json',
      cause: expect.objectContaining({
        name: 'ZodError',
        issues: expect.arrayContaining([
          expect.objectContaining({code: 'unrecognized_keys'}),
        ]),
      }),
    });

    await writeFile(
      path.join(temp.projectRoot, 'edit.json'),
      `${JSON.stringify(createEditFixture(), null, 2)}\n`,
    );
    await expect(loadProject(temp.workspaceRoot, 'demo')).rejects.toMatchObject({
      code: 'SCRIPT_SEGMENT_TEXT_TOO_LONG',
    });
  });
});
