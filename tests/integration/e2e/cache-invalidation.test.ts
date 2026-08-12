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
const MOCK_TTS_COMMAND = 'sine=frequency=440:sample_rate=48000:duration=1';
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
) => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const dependencies = createSystemVideoctlDependencies({
    workspaceRoot,
    environment,
    stdout: stdout.writer,
    stderr: stderr.writer,
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

const mockTtsCallCount = (calls: readonly string[]): number =>
  calls.filter((call) => call.includes(MOCK_TTS_COMMAND)).length;

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
    const runCli = createCli(fixture.workspaceRoot, environment);

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
    expect(mockTtsCallCount(await tools.readCalls('ffmpeg'))).toBe(2);

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

    const ttsCallsBeforeSecondDraft = mockTtsCallCount(await tools.readCalls('ffmpeg'));
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
    expect(await hashFile(firstSegmentNewCache)).toBe(await hashFile(firstSegmentOldCache));
    expect((await stat(firstSegmentNewCache)).ino).not.toBe((await stat(firstSegmentOldCache)).ino);
    await expect(access(cachePath(
      fixture.workspaceRoot,
      secondRunId,
      firstManifest.segments[1]!.inputHash,
    ))).rejects.toMatchObject({code: 'ENOENT'});
    expect(
      mockTtsCallCount(await tools.readCalls('ffmpeg')) - ttsCallsBeforeSecondDraft,
    ).toBe(1);
    for (const stageId of FINGERPRINT_STAGES) {
      expect(secondReports[stageId]!.fingerprint)
        .not.toBe(firstReports[stageId]!.fingerprint);
    }

    const secondDraftReport = await readDraftReport(fixture.workspaceRoot, secondRunId);
    const audioPaths = [
      secondDraftReport.outputs.audio.filterGraph.path,
      secondDraftReport.outputs.audio.mixedAudio.path,
    ];
    const audioHashesBeforeRelease = await Promise.all(audioPaths.map(async (relativePath) =>
      await hashFile(path.join(runRoot(fixture.workspaceRoot, secondRunId), relativePath))));
    const ttsCallsBeforeRelease = mockTtsCallCount(await tools.readCalls('ffmpeg'));

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
    expect(mockTtsCallCount(await tools.readCalls('ffmpeg'))).toBe(ttsCallsBeforeRelease);
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
