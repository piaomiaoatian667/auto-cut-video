import {readFile, readdir, stat} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {parseFfprobeJson} from '../../../src/media/ffprobe';
import {runProcess} from '../../../src/process/run-process';
import {createOutputStore, createRunStore, type StageId} from '../../../src/pipeline/run-store';
import {createStageReportStore, type StageReport} from '../../../src/pipeline/stage-report';
import {DraftReportSchema} from '../../../src/pipeline/stages/draft';
import {ReleaseValidationReportSchema} from '../../../src/pipeline/stages/release';
import {
  createSystemVideoctlDependencies,
  runVideoctl,
  type OutputWriter,
} from '../../../src/cli/videoctl';
import type {ExecutionPlan} from '../../../src/pipeline/execution-plan';
import type {PipelineRunResult} from '../../../src/pipeline/runner';
import {
  copyDemoProject,
  createRecordedRemotionBrowser,
  createRecordedToolchain,
  findRemotionBrowser,
  hashDemoSources,
  type DemoProjectFixture,
} from '../../helpers/demo-project';

const E2E_TIMEOUT = 180_000;
const REUSED_ASSET_STAGES = ['preflight', 'ingest'] as const;
const REUSED_DRAFT_STAGES = [
  'preflight',
  'ingest',
  'narration',
  'compile',
  'draft',
] as const;

const fixtures: DemoProjectFixture[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map(async (fixture) => await fixture.cleanup()));
});

interface CliResult<T = unknown> {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: T;
}

const outputBuffer = (): {writer: OutputWriter; chunks: string[]} => {
  const chunks: string[] = [];
  return {
    chunks,
    writer: {write: (chunk) => { chunks.push(chunk); }},
  };
};

const parseJson = <T>(value: string): T => JSON.parse(value) as T;

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
  return async <T = unknown>(argv: readonly string[]): Promise<CliResult<T>> => {
    stdout.chunks.length = 0;
    stderr.chunks.length = 0;
    const exitCode = await runVideoctl(argv, dependencies);
    const stdoutText = stdout.chunks.join('');
    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderr.chunks.join(''),
      json: stdoutText.trimStart().startsWith('{')
        ? parseJson<T>(stdoutText)
        : undefined as T,
    };
  };
};

const listTree = async (root: string): Promise<string[]> => {
  try {
    return (await readdir(root, {recursive: true})).map(String).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
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

describe('Demo pipeline E2E', () => {
  it('plans, drafts, reviews, resumes, and publishes the demo', async () => {
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

    const planned = await runCli<ExecutionPlan>([
      'pipeline', 'demo', '--preset', 'release', '--plan', '--json',
    ]);
    expect(planned).toMatchObject({exitCode: 0, stderr: ''});
    expect(planned.json).toMatchObject({projectId: 'demo', preset: 'release'});
    expect(await listTree(path.join(fixture.workspaceRoot, '.work'))).toEqual([]);
    expect(await listTree(path.join(fixture.workspaceRoot, 'output'))).toEqual([]);

    const assets = await runCli<PipelineRunResult>([
      'pipeline', 'demo', '--preset', 'assets', '--resume', '--json',
    ]);
    expect(assets).toMatchObject({exitCode: 0, stderr: ''});
    expect(assets.json).toMatchObject({state: 'passed', completedStage: 'ingest'});
    const runId = assets.json.runId;
    expect(runId).toEqual(expect.any(String));
    const assetReports = await readReports(
      fixture.workspaceRoot,
      runId!,
      REUSED_ASSET_STAGES,
    );

    const draft = await runCli<PipelineRunResult>([
      'pipeline', 'demo', '--preset', 'draft', '--resume', '--json',
    ]);
    expect(draft).toMatchObject({exitCode: 0, stderr: ''});
    expect(draft.json).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'draft',
    });
    const draftReports = await readReports(
      fixture.workspaceRoot,
      runId!,
      REUSED_DRAFT_STAGES,
    );

    const reviewGate = await runCli<PipelineRunResult>([
      'pipeline', 'demo', '--preset', 'release', '--resume', '--json',
    ]);
    expect(reviewGate).toMatchObject({exitCode: 2, stderr: ''});
    expect(reviewGate.json).toMatchObject({
      runId,
      state: 'needs_review',
      completedStage: 'review',
    });

    const approval = await runCli([
      'review', 'demo', '--approve', '--reason', 'acceptance review',
    ]);
    expect(approval).toMatchObject({exitCode: 0, stderr: ''});
    const approvedCurrent = await createRunStore(fixture.workspaceRoot)
      .readCurrentReadonly('demo');
    expect(approvedCurrent).toMatchObject({runId, state: 'passed'});

    const released = await runCli<PipelineRunResult>([
      'pipeline', 'demo', '--preset', 'release', '--resume', '--json',
    ]);
    expect(released).toMatchObject({exitCode: 0, stderr: ''});
    expect(released.json).toMatchObject({
      runId,
      state: 'passed',
      completedStage: 'release',
    });
    expect(await readReports(
      fixture.workspaceRoot,
      runId!,
      REUSED_ASSET_STAGES,
    )).toEqual(assetReports);
    expect(await readReports(
      fixture.workspaceRoot,
      runId!,
      REUSED_DRAFT_STAGES,
    )).toEqual(draftReports);

    const finalReports = await readReports(
      fixture.workspaceRoot,
      runId!,
      ['review', 'release'],
    );
    expect(finalReports.review!.runId).toBe(runId);
    expect(finalReports.release!.runId).toBe(runId);

    const runRoot = path.join(fixture.workspaceRoot, '.work', 'demo', 'runs', runId!);
    const releaseRoot = path.join(
      fixture.workspaceRoot,
      'output',
      'demo',
      'releases',
      runId!,
    );
    const draftReport = DraftReportSchema.parse(JSON.parse(
      await readFile(path.join(runRoot, 'draft', 'draft-report.json'), 'utf8'),
    ));
    const validationReport = ReleaseValidationReportSchema.parse(JSON.parse(
      await readFile(path.join(releaseRoot, 'validation-report.json'), 'utf8'),
    ));
    expect(validationReport.inputs.draftAudio).toEqual(draftReport.outputs.audio);

    const finalPath = path.join(releaseRoot, 'final.mp4');
    const probe = parseFfprobeJson((await runProcess(tools.ffprobeExecutable, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      finalPath,
    ])).stdout);
    expect(probe.videoStreams).toHaveLength(1);
    expect(probe.audioStreams).toHaveLength(1);
    expect(probe.videoStreams[0]).toMatchObject({
      codec: 'h264',
      pixelFormat: 'yuv420p',
      width: 1920,
      height: 1080,
    });
    expect(probe.videoStreams[0]!.averageFrameRate.value).toBeCloseTo(30, 3);
    expect(probe.audioStreams[0]).toMatchObject({codec: 'aac', sampleRate: 48_000});
    await expect(runProcess(tools.ffmpegExecutable, [
      '-v', 'error',
      '-xerror',
      '-i', finalPath,
      '-f', 'null',
      '-',
    ])).resolves.toMatchObject({exitCode: 0});
    const finalBytes = await readFile(finalPath);
    expect(finalBytes.indexOf(Buffer.from('moov'))).toBeGreaterThanOrEqual(0);
    expect(finalBytes.indexOf(Buffer.from('mdat'))).toBeGreaterThanOrEqual(0);
    expect(finalBytes.indexOf(Buffer.from('moov')))
      .toBeLessThan(finalBytes.indexOf(Buffer.from('mdat')));

    await Promise.all([
      'subtitles.srt',
      'thumbnail.jpg',
      'review.json',
      'validation-report.json',
      'checksums.sha256',
    ].map(async (fileName) => {
      expect((await stat(path.join(releaseRoot, fileName))).isFile()).toBe(true);
    }));
    expect(await hashDemoSources(fixture.sourceRoot)).toEqual(fixture.sourceHashes);
    expect(await createOutputStore(fixture.workspaceRoot).readCurrentReadonly('demo'))
      .toMatchObject({runId, state: 'passed', completedStage: 'release'});

    const ffmpegCalls = await tools.readCalls('ffmpeg');
    expect(ffmpegCalls).toContain([
      '-y',
      '-i', '/dev/fd/3',
      '-i', '/dev/fd/4',
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'mp4',
      '/dev/fd/5',
    ].join(' '));
    expect(await tools.readCalls('qt-faststart'))
      .toContain('/dev/fd/3 /dev/fd/4');
    expect((await browser.readCalls()).length).toBeGreaterThan(0);
  }, E2E_TIMEOUT);
});
