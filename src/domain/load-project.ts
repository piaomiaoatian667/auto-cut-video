import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {readJson} from '../fs/json-files';
import {resolveExistingProjectPath} from '../fs/project-paths';
import {EditSchema, type Edit} from './edit-schema';
import {ProjectSchema, type Project} from './project-schema';
import {StableIdSchema} from './schema-primitives';
import {ScriptSchema, type Script} from './script-schema';
import {validateAuthoringInputs} from './validate-authoring';

export interface ProjectInputs {
  workspaceRoot: string;
  projectRoot: string;
  project: Project;
  script: Script;
  edit: Edit;
}

export class ProjectIdMismatchError extends Error {
  readonly code = 'PROJECT_ID_MISMATCH';

  constructor(
    readonly requestedProjectId: string,
    readonly declaredProjectId: string,
  ) {
    super(
      `project directory id ${requestedProjectId} does not match `
      + `project.json id ${declaredProjectId}`,
    );
    this.name = 'ProjectIdMismatchError';
  }
}

export async function loadProject(
  workspaceRoot: string,
  projectId: string,
): Promise<ProjectInputs> {
  const validatedProjectId = StableIdSchema.parse(projectId);
  const workspaceRootReal = await realpath(workspaceRoot);
  const projectRoot = await resolveExistingProjectPath(
    workspaceRootReal,
    path.join('projects', validatedProjectId),
  );

  const project = await readJson(
    await resolveExistingProjectPath(projectRoot, 'project.json'),
    ProjectSchema,
  );
  const script = await readJson(
    await resolveExistingProjectPath(projectRoot, 'script.json'),
    ScriptSchema,
  );
  const edit = await readJson(
    await resolveExistingProjectPath(projectRoot, 'edit.json'),
    EditSchema,
  );

  if (project.id !== validatedProjectId) {
    throw new ProjectIdMismatchError(validatedProjectId, project.id);
  }
  validateAuthoringInputs({project, script, edit});

  return {
    workspaceRoot: workspaceRootReal,
    projectRoot,
    project,
    script,
    edit,
  };
}
