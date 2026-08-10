import {mkdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import {createRunStore, openExistingRunFile} from '../../../src/fs/app-directory-scopes';
import {FileTtsProvider, MockTtsProvider, type TtsProvider} from '../../../src/providers/tts';
import {ProcessExecutionError} from '../../../src/process/process-error';
import {createTempProject, type TempProject} from '../../helpers/temp-project';
import {createTestMusic} from '../../helpers/media-fixtures';

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const makeScopes = async () => {
  const tempProject = await createTempProject();
  tempProjects.push(tempProject);
  const project = await loadProject(tempProject.workspaceRoot, 'demo');
  const runDirectory = await createRunStore(tempProject.workspaceRoot).createRun('demo', 'run-tts');
  return {...project, runDirectory, projectRoot: tempProject.projectRoot};
};

const outputBytes = async (runDirectory: Awaited<ReturnType<typeof makeScopes>>['runDirectory'], relativePath: string) => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const contract = (name: string, createProvider: (scopes: Awaited<ReturnType<typeof makeScopes>>) => TtsProvider, input: (scopes: Awaited<ReturnType<typeof makeScopes>>) => Promise<{sourceAudioPath?: string}>) => {
  describe(name, () => {
    it('reports deterministic capabilities and fingerprint', async () => {
      const scopes = await makeScopes();
      const provider = createProvider(scopes);

      await expect(provider.capabilities()).resolves.toMatchObject({languages: expect.any(Array), voices: expect.any(Array)});
      await expect(provider.fingerprint()).resolves.toBe(await provider.fingerprint());
    });

    it('writes a non-empty normalized WAV output', async () => {
      const scopes = await makeScopes();
      const provider = createProvider(scopes);
      const result = await provider.synthesize({
        segmentId: 'intro',
        text: '你好',
        voice: 'fixture',
        rate: 180,
        outputPath: 'audio/segments/intro.wav',
        ...(await input(scopes)),
      }, new AbortController().signal);

      expect(result.outputPath).toBe('audio/segments/intro.wav');
      expect(result.providerFingerprint).toBe(await provider.fingerprint());
      expect((await outputBytes(scopes.runDirectory, result.outputPath)).byteLength).toBeGreaterThan(44);
    });

    it('honors cancellation before spawning work', async () => {
      const scopes = await makeScopes();
      const provider = createProvider(scopes);
      const controller = new AbortController();
      controller.abort('contract cancellation');

      await expect(provider.synthesize({
        segmentId: 'intro',
        text: '你好',
        voice: 'fixture',
        rate: 180,
        outputPath: 'audio/segments/cancelled.wav',
        ...(await input(scopes)),
      }, controller.signal)).rejects.toMatchObject({code: 'PROCESS_ABORTED'} satisfies Partial<ProcessExecutionError>);
    });
  });
};

contract(
  'MockTtsProvider',
  (scopes) => new MockTtsProvider({runDirectory: scopes.runDirectory}),
  async () => ({}),
);

contract(
  'FileTtsProvider',
  (scopes) => new FileTtsProvider({
    projectDirectory: scopes.projectDirectory,
    runDirectory: scopes.runDirectory,
  }),
  async (scopes) => {
    const sourcePath = path.join(scopes.projectRoot, 'assets/source/voice.wav');
    await mkdir(path.dirname(sourcePath), {recursive: true});
    await createTestMusic(sourcePath, 1);
    return {sourceAudioPath: 'assets/source/voice.wav'};
  },
);

describe('FileTtsProvider source handling', () => {
  it('requires sourceAudioPath', async () => {
    const scopes = await makeScopes();
    const provider = new FileTtsProvider({
      projectDirectory: scopes.projectDirectory,
      runDirectory: scopes.runDirectory,
    });

    await expect(provider.synthesize({
      segmentId: 'intro',
      text: '你好',
      voice: 'fixture',
      rate: 180,
      outputPath: 'audio/segments/intro.wav',
    }, new AbortController().signal)).rejects.toThrow(/TTS_SOURCE_MISSING/);
  });

  it('does not modify source WAV bytes', async () => {
    const scopes = await makeScopes();
    const sourcePath = path.join(scopes.projectRoot, 'assets/source/voice.wav');
    await mkdir(path.dirname(sourcePath), {recursive: true});
    await createTestMusic(sourcePath, 1);
    const before = await readFile(sourcePath);

    await new FileTtsProvider({
      projectDirectory: scopes.projectDirectory,
      runDirectory: scopes.runDirectory,
    }).synthesize({
      segmentId: 'intro',
      text: '你好',
      voice: 'fixture',
      rate: 180,
      outputPath: 'audio/segments/intro.wav',
      sourceAudioPath: 'assets/source/voice.wav',
    }, new AbortController().signal);

    expect(await readFile(sourcePath)).toEqual(before);
  });
});
