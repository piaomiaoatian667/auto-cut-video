import {afterEach, describe, expect, it} from 'vitest';
import {rm} from 'node:fs/promises';
import {createRunStore, openExistingRunFile, openNewRunFile} from '../../../src/fs/app-directory-scopes';
import {loadProject} from '../../../src/domain/load-project';
import {CompiledTimelineSchema} from '../../../src/domain/timeline-schema';
import {runCompile} from '../../../src/pipeline/stages/compile';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
  createTempProject,
  type TempProject,
} from '../../helpers/temp-project';

const tempProjects: TempProject[] = [];
const sha256 = (suffix: string): string => `sha256:${suffix.padStart(64, '0')}`;

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const makeProject = async () => {
  const project = await createTempProject({
    project: createProjectFixture('demo'),
    script: createScriptFixture('介绍'),
    edit: {
      ...createEditFixture(),
      visualClips: [{
        id: 'opening',
        kind: 'image',
        assetId: 'cover',
        startFrame: 0,
        durationInFrames: 30,
        fit: 'contain',
        position: {x: 0, y: 0},
        scale: 1,
        opacity: 1,
        fadeInFrames: 0,
        fadeOutFrames: 0,
        zIndex: 0,
      }],
      overlays: [{
        id: 'title',
        component: 'basic-title',
        startFrame: 0,
        durationInFrames: 30,
        props: {text: '标题'},
        zIndex: 10,
      }],
    },
  });
  tempProjects.push(project);
  const inputs = await loadProject(project.workspaceRoot, 'demo');
  const runStore = createRunStore(project.workspaceRoot);
  const runDirectory = await runStore.createRun('demo', 'run-compile');
  return {...inputs, runDirectory};
};

const writeRunJson = async (
  runDirectory: Awaited<ReturnType<typeof makeProject>>['runDirectory'],
  relativePath: string,
  value: unknown,
): Promise<void> => {
  const handle = await openNewRunFile(runDirectory, relativePath);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const readRunJson = async (
  runDirectory: Awaited<ReturnType<typeof makeProject>>['runDirectory'],
  relativePath: string,
): Promise<unknown> => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
};

describe('runCompile', () => {
  it('reads manifests from the run and writes compiled-timeline.json', async () => {
    const project = await makeProject();
    await writeRunJson(project.runDirectory, 'asset-manifest.json', {
      version: 1,
      assets: {
        cover: {
          kind: 'image',
          sourcePath: 'assets/source/cover.png',
          sourceHash: sha256('1'),
          renderPath: 'assets/source/cover.png',
          renderScope: 'project',
          width: 1920,
          height: 1080,
          compatibility: 'direct',
        },
      },
    });
    await writeRunJson(project.runDirectory, 'narration-manifest.json', {
      version: 1,
      provider: 'mock',
      segments: [{
        id: 'intro',
        inputHash: 'sha256:narration-input',
        audioPath: 'audio/segments/intro.wav',
        audioHash: 'sha256:intro-audio',
        startMs: 0,
        endMs: 1000,
        durationMs: 1000,
        pauseAfterMs: 300,
        sampleRate: 48000,
        channels: 1,
        providerFingerprint: 'sha256:provider',
      }],
      master: {
        audioPath: 'audio/narration.wav',
        audioHash: 'sha256:narration-master',
        durationMs: 1000,
      },
    });
    await writeRunJson(project.runDirectory, 'captions.json', {
      version: 1,
      sourceNarrationHash: 'sha256:narration-master',
      cues: [{
        id: 'caption-intro',
        segmentId: 'intro',
        text: '介绍',
        startMs: 0,
        endMs: 1000,
      }],
    });

    const result = await runCompile(project);
    const rawCompiled = await readRunJson(project.runDirectory, 'compiled-timeline.json');
    const compiled = CompiledTimelineSchema.parse(rawCompiled);

    expect(result).toEqual({timelinePath: 'compiled-timeline.json', timeline: compiled});
    expect(compiled.visualClips).toEqual([{ 
      id: 'opening',
      kind: 'image',
      renderPath: 'assets/source/cover.png',
      startFrame: 0,
      durationInFrames: 30,
      fit: 'contain',
      position: {x: 0, y: 0},
      scale: 1,
      opacity: 1,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      zIndex: 0,
    }]);
    expect(compiled.inputHashes).toMatchObject({
      'asset:cover': sha256('1'),
      'narration:master': 'sha256:narration-master',
    });
  });
});
