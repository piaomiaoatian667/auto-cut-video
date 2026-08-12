import {access, readFile, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {NarrationManifestSchema} from '../../../src/domain/manifest-schema';
import type {Script} from '../../../src/domain/script-schema';
import {
  createSystemVideoctlDependencies,
  runVideoctl,
  type OutputWriter,
} from '../../../src/cli/videoctl';
import {createRunStore, type StageId} from '../../../src/pipeline/run-store';
import type {PipelineRunResult} from '../../../src/pipeline/runner';
import {createStageReportStore, type StageReport} from '../../../src/pipeline/stage-report';
import {DraftReportSchema} from '../../../src/pipeline/stages/draft';
import {ReleaseValidationReportSchema} from '../../../src/pipeline/stages/release';
import {
  copyDemoProject,
  createRecordedRemotionBrowser,
  createRecordedToolchain,
  findRemotionBrowser,
  hashDemoSources,
  type DemoProjectFixture,
} from '../../helpers/demo-project';

const E2E_TIMEOUT = 180_000;
const FINGERPRINT_STAGES = ['narration', 'compile', 'draft'] as const;
const fixtures: DemoProjectFixture[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

const outputBuffer = (): {writer: OutputWriter; chunks: string[]} => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {write: (chunk) => { chunks.push(chunk); }},
  };
};

const createCli = (
  workspaceRoot: string,
  environment: NodeJS.ProcessEnv,
  onMockTtsInvocation: (input: {
    segmentId: string;
    text: string;
    voice: string;
    rate: number;
  }) => void,
) => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const dependencies = createSystemVideoctlDependencies({
    workspaceRoot,
    environment,
    stdout: stdout.writer,
    stderr: stderr.writer,
    onMockTtsInvocation,
  });
  return async (argv: readonly string[]) => {
    stdout.chunks.length = 0;
    stderr.chunks.length = 0;
    const exitCode = await runVideoctl(argv, dependencies);
    const stdoutText = stdout.chunks.join('');
    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderr.chunks.join(''),
      json: stdoutText.trimStart().startsWith('{')
        ? JSON.parse(stdoutText) as PipelineRunResult
        : undefined,
    };
  };
};

const readReports = async (
  workspaceRoot: string,
  runId: string,
  stageIds: readonly StageId[],
): Promise<Record<string, StageReport>> => {
  const runDirectory = await createRunStore(workspaceRoot).openExistingRun('demo', runId);
  const reportStore = createStageReportStore();
  return Object.fromEntries(await Promise.all(stageIds.map(async (stageId) => {
    const report = await reportStore.readStage(runDirectory, stageId);
    if (report === null) throw new Error(`Missing ${stageId} report for ${runId}`);
    return [stageId, report];
  }))) as Record<string, StageReport>;
};

const runRoot = (workspaceRoot: string, runId: string): string => path.join(
  workspaceRoot,
  '.work',
  'demo',
  'runs',
  runId,
);

const readNarrationManifest = async (
  workspaceRoot: string,
  runId: string,
) => NarrationManifestSchema.parse(JSON.parse(
  await readFile(path.join(runRoot(workspaceRoot, runId), 'narration-manifest.json'), 'utf8'),
));

const cachePath = (workspaceRoot: string, runId: string, inputHash: string): string => path.join(
  runRoot(workspaceRoot, runId),
  'audio',
  'cache',
  `${inputHash.replace(/^sha256:/u, '')}.wav`,
);

const readDraftReport = async (workspaceRoot: string, runId: string) =>
  DraftReportSchema.parse(JSON.parse(
    await readFile(path.join(runRoot(workspaceRoot, runId), 'draft', 'draft-report.json'), 'utf8'),
  ));

const hashFile = async (filePath: string): Promise<string> => {
  const {createHash} = await import('node:crypto');
  return `sha256:${createHash('sha256').update(await readFile(filePath)).digest('hex')}`;
};

describe('Demo cache invalidation E2E', () => {
  it('reuses one narration segment and invalidates only its downstream pipeline', async () => {
    const fixture = await copyDemoProject();
    fixtures.push(fixture);
    const tools = await createRecordedToolchain(fixture.workspaceRoot);
    const browser = await createRecordedRemotionBrowser(
      fixture.workspaceRoot,
      await findRemotionBrowser(),
    );
    vi.stubEnv('REMOTION_BROWSER_EXECUTABLE', browser.executablePath);
    vi.stubEnv('REMOTION_CHROME_MODE', browser.chromeMode);
    vi.stubEnv('REMOTION_OPENGL_RENDERER', 'angle');
    const environment = {
      ...process.env,
      FFMPEG_PATH: tools.ffmpegExecutable,
      FFPROBE_PATH: tools.ffprobeExecutable,
      QT_FASTSTART_PATH: tools.qtFaststartExecutable,
      REMOTION_BROWSER_EXECUTABLE: browser.executablePath,
      REMOTION_CHROME_MODE: browser.chromeMode,
      REMOTION_OPENGL_RENDERER: 'angle',
    };
    const mockTtsInvocations: Array<{
      segmentId: string;
      text: string;
      voice: string;
      rate: number;
    }> = [];
    const runCli = createCli(
      fixture.workspaceRoot,
      environment,
      (input) => { mockTtsInvocations.push({...input}); },
    );

    const firstDraft = await runCli([
      'pipeline', 'demo', '--preset', 'draft', '--json',
    ]);
    expect(firstDraft).toMatchObject({exitCode: 0, stderr: ''});
    expect(firstDraft.json).toMatchObject({state: 'passed', completedStage: 'draft'});
    const firstRunId = firstDraft.json!.runId!;
    const firstReports = await readReports(
      fixture.workspaceRoot,
      firstRunId,
      FINGERPRINT_STAGES,
    );
    const firstManifest = await readNarrationManifest(fixture.workspaceRoot, firstRunId);
    const firstDraftReport = await readDraftReport(fixture.workspaceRoot, firstRunId);
    expect(mockTtsInvocations).toEqual([
      {segmentId: 'intro', text: '本地流程开始。', voice: 'fixture', rate: 180},
      {segmentId: 'publish', text: '审核通过后发布。', voice: 'fixture', rate: 180},
    ]);

    const scriptPath = path.join(fixture.projectRoot, 'script.json');
    const script = JSON.parse(await readFile(scriptPath, 'utf8')) as Script;
    const changedScript: Script = {
      ...script,
      segments: script.segments.map((segment, index) => index === 1
        ? {
          ...segment,
          text: '审核确认后立即发布。',
          normalizedText: '审核确认后立即发布。',
        }
        : segment),
    };
    await writeFile(scriptPath, `${JSON.stringify(changedScript, null, 2)}\n`, 'utf8');

    const ttsInvocationsBeforeSecondDraft = mockTtsInvocations.length;
    const secondDraft = await runCli([
      'pipeline', 'demo', '--preset', 'draft', '--json',
    ]);
    expect(secondDraft).toMatchObject({exitCode: 0, stderr: ''});
    expect(secondDraft.json).toMatchObject({state: 'passed', completedStage: 'draft'});
    const secondRunId = secondDraft.json!.runId!;
    expect(secondRunId).not.toBe(firstRunId);
    const secondReports = await readReports(
      fixture.workspaceRoot,
      secondRunId,
      ['ingest', ...FINGERPRINT_STAGES],
    );
    expect(secondReports.ingest).toMatchObject({
      state: 'cached',
      provenance: {sourceRunId: firstRunId, sourceStageId: 'ingest'},
    });
    const secondManifest = await readNarrationManifest(fixture.workspaceRoot, secondRunId);
    expect(secondManifest.segments[0]!.inputHash).toBe(firstManifest.segments[0]!.inputHash);
    expect(secondManifest.segments[1]!.inputHash).not.toBe(firstManifest.segments[1]!.inputHash);
    expect(secondManifest.segments[0]!.audioHash).toBe(firstManifest.segments[0]!.audioHash);
    expect(secondManifest.segments[1]!.audioHash).not.toBe(firstManifest.segments[1]!.audioHash);
    expect(secondManifest.master.audioHash).not.toBe(firstManifest.master.audioHash);

    const firstSegmentOldCache = cachePath(
      fixture.workspaceRoot,
      firstRunId,
      firstManifest.segments[0]!.inputHash,
    );
    const firstSegmentNewCache = cachePath(
      fixture.workspaceRoot,
      secondRunId,
      secondManifest.segments[0]!.inputHash,
    );
    const firstSegmentOldCacheHash = await hashFile(firstSegmentOldCache);
    const firstSegmentNewCacheHash = await hashFile(firstSegmentNewCache);
    expect(firstSegmentNewCacheHash).toBe(firstSegmentOldCacheHash);
    expect((await stat(firstSegmentNewCache)).ino).not.toBe((await stat(firstSegmentOldCache)).ino);
    const firstSegmentOldArtifact = path.join(
      runRoot(fixture.workspaceRoot, firstRunId),
      firstManifest.segments[0]!.audioPath,
    );
    const firstSegmentNewArtifact = path.join(
      runRoot(fixture.workspaceRoot, secondRunId),
      secondManifest.segments[0]!.audioPath,
    );
    const firstSegmentOldArtifactHash = await hashFile(firstSegmentOldArtifact);
    const firstSegmentNewArtifactHash = await hashFile(firstSegmentNewArtifact);
    expect(firstSegmentNewArtifactHash).toBe(firstSegmentOldArtifactHash);
    expect((await stat(firstSegmentNewArtifact)).ino)
      .not.toBe((await stat(firstSegmentOldArtifact)).ino);
    const secondSegmentOldCache = cachePath(
      fixture.workspaceRoot,
      firstRunId,
      firstManifest.segments[1]!.inputHash,
    );
    const secondSegmentNewCache = cachePath(
      fixture.workspaceRoot,
      secondRunId,
      secondManifest.segments[1]!.inputHash,
    );
    const secondSegmentOldCacheHash = await hashFile(secondSegmentOldCache);
    const secondSegmentNewCacheHash = await hashFile(secondSegmentNewCache);
    expect(secondSegmentNewCacheHash).not.toBe(secondSegmentOldCacheHash);
    await expect(access(cachePath(
      fixture.workspaceRoot,
      secondRunId,
      firstManifest.segments[1]!.inputHash,
    ))).rejects.toMatchObject({code: 'ENOENT'});
    expect(mockTtsInvocations.slice(ttsInvocationsBeforeSecondDraft)).toEqual([
      {segmentId: 'publish', text: '审核确认后立即发布。', voice: 'fixture', rate: 180},
    ]);
    for (const stageId of FINGERPRINT_STAGES) {
      expect(secondReports[stageId]!.fingerprint)
        .not.toBe(firstReports[stageId]!.fingerprint);
    }

    const secondDraftReport = await readDraftReport(fixture.workspaceRoot, secondRunId);
    expect(secondDraftReport.outputs.audio.filterGraph.sha256)
      .toBe(firstDraftReport.outputs.audio.filterGraph.sha256);
    expect(secondDraftReport.outputs.audio.mixedAudio.sha256)
      .not.toBe(firstDraftReport.outputs.audio.mixedAudio.sha256);
    expect(secondDraftReport.outputs.audioMixFingerprint)
      .toBe(firstDraftReport.outputs.audioMixFingerprint);
    const audioPaths = [
      secondDraftReport.outputs.audio.filterGraph.path,
      secondDraftReport.outputs.audio.mixedAudio.path,
    ];
    const audioHashesBeforeRelease = await Promise.all(audioPaths.map(async (relativePath) =>
      await hashFile(path.join(runRoot(fixture.workspaceRoot, secondRunId), relativePath))));
    const ttsInvocationsBeforeRelease = mockTtsInvocations.length;

    const reviewGate = await runCli([
      'pipeline', 'demo', '--preset', 'release', '--resume', '--json',
    ]);
    expect(reviewGate).toMatchObject({
      exitCode: 2,
      stderr: '',
      json: {runId: secondRunId, state: 'needs_review', completedStage: 'review'},
    });
    expect((await runCli([
      'review', 'demo', '--approve', '--reason', 'acceptance review',
    ])).exitCode).toBe(0);
    const released = await runCli([
      'pipeline', 'demo', '--preset', 'release', '--resume', '--json',
    ]);
    expect(released).toMatchObject({
      exitCode: 0,
      stderr: '',
      json: {runId: secondRunId, state: 'passed', completedStage: 'release'},
    });

    expect(await Promise.all(audioPaths.map(async (relativePath) =>
      await hashFile(path.join(runRoot(fixture.workspaceRoot, secondRunId), relativePath)))))
      .toEqual(audioHashesBeforeRelease);
    expect(mockTtsInvocations).toHaveLength(ttsInvocationsBeforeRelease);
    const validationReport = ReleaseValidationReportSchema.parse(JSON.parse(await readFile(path.join(
      fixture.workspaceRoot,
      'output',
      'demo',
      'releases',
      secondRunId,
      'validation-report.json',
    ), 'utf8')));
    expect(validationReport.inputs.draftAudio).toEqual(secondDraftReport.outputs.audio);
    expect(await hashDemoSources(fixture.sourceRoot)).toEqual(fixture.sourceHashes);
    expect((await browser.readCalls()).length).toBeGreaterThan(0);
  }, E2E_TIMEOUT);
});
