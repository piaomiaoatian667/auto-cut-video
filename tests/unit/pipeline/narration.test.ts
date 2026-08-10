import {afterEach, describe, expect, it} from 'vitest';
import {loadProject, type ProjectInputs} from '../../../src/domain/load-project';
import {CaptionsManifestSchema, NarrationManifestSchema} from '../../../src/domain/manifest-schema';
import {createRunStore, openExistingRunFile, type RunDirectoryScope} from '../../../src/fs/app-directory-scopes';
import {runNarration} from '../../../src/pipeline/stages/narration';
import {MockTtsProvider} from '../../../src/providers/tts';
import {createTempProject, type TempProject} from '../../helpers/temp-project';

type LoadedProject = ProjectInputs & {runDirectory: RunDirectoryScope};

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const makeProject = async (): Promise<LoadedProject> => {
  const tempProject = await createTempProject();
  tempProjects.push(tempProject);
  const project = await loadProject(tempProject.workspaceRoot, 'demo');
  const runDirectory = await createRunStore(tempProject.workspaceRoot).createRun('demo', 'run-narration-stage');
  return {...project, runDirectory};
};

const readRunText = async (runDirectory: RunDirectoryScope, relativePath: string): Promise<string> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

describe('runNarration', () => {
  it('writes narration and captions artifacts to the run scope', async () => {
    const project = await makeProject();
    const result = await runNarration({
      ...project,
      provider: new MockTtsProvider({runDirectory: project.runDirectory}),
    });

    const narration = NarrationManifestSchema.parse(JSON.parse(
      await readRunText(project.runDirectory, 'narration-manifest.json'),
    ));
    const captions = CaptionsManifestSchema.parse(JSON.parse(
      await readRunText(project.runDirectory, 'captions.json'),
    ));
    const srt = await readRunText(project.runDirectory, 'captions.srt');

    expect(result).toEqual({
      narrationPath: 'narration-manifest.json',
      captionsPath: 'captions.json',
      srtPath: 'captions.srt',
      narration,
      captions,
    });
    expect(captions.cues).toHaveLength(project.script.segments.length);
    expect(srt).toContain('00:00:00,000 --> 00:00:01,000');
  });
});
