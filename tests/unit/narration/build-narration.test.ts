import {afterEach, describe, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {loadProject, type ProjectInputs} from '../../../src/domain/load-project';
import {
  createRunStore,
  openExistingRunFile,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  buildNarration,
  narrationMasterPath,
} from '../../../src/narration/build-narration';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {MockTtsProvider, type TtsInput, type TtsProvider, type TtsResult} from '../../../src/providers/tts';
import {
  createProjectFixture,
  createScriptFixture,
  createTempProject,
  type TempProject,
} from '../../helpers/temp-project';

type LoadedProject = ProjectInputs & {runDirectory: RunDirectoryScope};

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const makeProject = async (texts = ['第一句', '第二句']): Promise<LoadedProject> => {
  const script = createScriptFixture(texts[0]);
  script.segments = texts.map((text, index) => ({
    id: index === 0 ? 'intro' : `segment-${index + 1}`,
    text,
    normalizedText: text,
    pauseAfterMs: index === texts.length - 1 ? 0 : 250,
    requiredTerms: [],
  }));
  const tempProject = await createTempProject({
    project: createProjectFixture('demo'),
    script,
  });
  tempProjects.push(tempProject);
  const loaded = await loadProject(tempProject.workspaceRoot, 'demo');
  const runDirectory = await createRunStore(tempProject.workspaceRoot).createRun('demo', 'run-narration');
  return {...loaded, runDirectory};
};

class RecordingProvider implements TtsProvider {
  readonly id = 'mock' as const;
  readonly calls: TtsInput[] = [];
  readonly #delegate: MockTtsProvider;
  readonly #fingerprint: string;

  constructor(runDirectory: RunDirectoryScope, fingerprintSeed = 'provider-v1') {
    this.#delegate = new MockTtsProvider({runDirectory});
    this.#fingerprint = fingerprintValue({provider: fingerprintSeed});
  }

  async capabilities() {
    return {languages: ['zh-CN'], voices: ['fixture']};
  }

  async fingerprint() {
    return this.#fingerprint;
  }

  async synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsResult> {
    this.calls.push(input);
    return await this.#delegate.synthesize(input, signal);
  }
}

const expectedInputHash = async (project: LoadedProject, segmentId: string): Promise<string> => {
  const provider = new RecordingProvider(project.runDirectory);
  const providerFingerprint = await provider.fingerprint();
  const segment = project.script.segments.find((candidate) => candidate.id === segmentId)!;
  return fingerprintValue({
    segmentId: segment.id,
    normalizedText: segment.normalizedText,
    voice: project.project.tts.voice,
    rate: project.project.tts.rate,
    providerFingerprint,
    sampleRate: 48000,
    channels: 1,
  });
};

describe('buildNarration', () => {
  it('generates a strict manifest in script order with pause-aware timing', async () => {
    const project = await makeProject();
    const provider = new RecordingProvider(project.runDirectory);

    const manifest = await buildNarration({...project, provider});

    expect(manifest.provider).toBe('mock');
    expect(manifest.segments.map((segment) => segment.id)).toEqual(['intro', 'segment-2']);
    expect(manifest.segments[0]).toMatchObject({startMs: 0, endMs: 1000, durationMs: 1000, pauseAfterMs: 250});
    expect(manifest.segments[1]).toMatchObject({startMs: 1250, endMs: 2250, durationMs: 1000, pauseAfterMs: 0});
    expect(manifest.master.audioPath).toBe(narrationMasterPath(manifest));
    expect(manifest.master.durationMs).toBe(2250);
    expect(provider.calls.map((call) => call.segmentId)).toEqual(['intro', 'segment-2']);
  });

  it('derives the exact master path from provider and segment provenance', () => {
    const segments = [{
      id: 'intro',
      inputHash: fingerprintValue('input'),
      audioHash: fingerprintValue('audio'),
      startMs: 0,
      endMs: 1000,
      pauseAfterMs: 250,
    }];

    expect(narrationMasterPath({provider: 'mock', segments})).toBe(
      narrationMasterPath({provider: 'mock', segments: structuredClone(segments)}),
    );
    expect(narrationMasterPath({provider: 'file', segments})).not.toBe(
      narrationMasterPath({provider: 'mock', segments}),
    );
    expect(narrationMasterPath({
      provider: 'mock',
      segments: [{...segments[0]!, audioHash: fingerprintValue('changed-audio')}],
    })).not.toBe(narrationMasterPath({provider: 'mock', segments}));
  });

  it('reuses unchanged cached segment audio on subsequent builds', async () => {
    const project = await makeProject();
    const firstProvider = new RecordingProvider(project.runDirectory);
    await buildNarration({...project, provider: firstProvider});
    const secondProvider = new RecordingProvider(project.runDirectory);

    const manifest = await buildNarration({...project, provider: secondProvider});

    expect(secondProvider.calls).toEqual([]);
    expect(manifest.segments.map((segment) => segment.inputHash)).toEqual([
      await expectedInputHash(project, 'intro'),
      await expectedInputHash(project, 'segment-2'),
    ]);
  });

  it('invalidates only the changed segment cache key', async () => {
    const project = await makeProject();
    await buildNarration({...project, provider: new RecordingProvider(project.runDirectory)});
    project.script.segments[1] = {...project.script.segments[1]!, normalizedText: '改过的第二句', text: '改过的第二句'};
    const provider = new RecordingProvider(project.runDirectory);

    await buildNarration({...project, provider});

    expect(provider.calls.map((call) => call.segmentId)).toEqual(['segment-2']);
  });

  it('rejects a segment longer than 7000ms', async () => {
    const project = await makeProject(['第一句']);
    const provider = new RecordingProvider(project.runDirectory);

    await expect(buildNarration({
      ...project,
      provider,
      probeDurationMs: async () => 7001,
    })).rejects.toThrowError(/NARRATION_SEGMENT_TOO_LONG/);
  });

  it('reports the dynamic master path immediately before opening it', async () => {
    const project = await makeProject(['第一句']);
    const provider = new RecordingProvider(project.runDirectory);
    const partialPaths: string[] = [];
    const failure = new Error('stop before opening master');

    await expect(buildNarration({
      ...project,
      provider,
      onPartialArtifact: (relativePath) => {
        partialPaths.push(relativePath);
        throw failure;
      },
    })).rejects.toBe(failure);

    expect(partialPaths).toEqual([
      expect.stringMatching(/^audio\/narration-[0-9a-f]{16}\.wav$/),
    ]);
    await expect(openExistingRunFile(project.runDirectory, partialPaths[0]!))
      .rejects.toMatchObject({code: 'ENOENT'});
  });
});
