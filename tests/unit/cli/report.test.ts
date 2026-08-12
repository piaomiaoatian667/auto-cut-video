import {access, mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {CurrentPointer, RunDirectoryScope, StageId} from '../../../src/pipeline/run-store';
import type {StageReport} from '../../../src/pipeline/stage-report';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  runReportCommand,
  type ReportCommandDependencies,
} from '../../../src/cli/commands/report';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const current: CurrentPointer = {
  runId: 'run-current',
  relativePath: 'runs/run-current',
  preset: 'release',
  stageIds: ['preflight', 'ingest', 'narration'],
  completedStage: 'narration',
  state: 'passed',
  publishedAt: '2026-08-12T00:00:00.000Z',
};

const report = (
  stageId: StageId,
  state: StageReport['state'] = 'passed',
  startedAt = '2026-08-12T00:00:00.000Z',
): StageReport => ({
  version: 1,
  projectId: 'demo',
  runId: 'run-current',
  preset: 'release',
  stageId,
  position: 1,
  total: 7,
  state,
  fingerprint: state === 'cancelled' ? null : `sha256:${stageId}`,
  startedAt,
  finishedAt: '2026-08-12T00:00:01.000Z',
  artifacts: [],
  checks: [],
});

const makeDependencies = (pointer: CurrentPointer | null) => {
  let stdout = '';
  let stderr = '';
  const runDirectory = {} as RunDirectoryScope;
  const readCurrentReadonly = vi.fn(async () => pointer);
  const openExistingRun = vi.fn(async () => runDirectory);
  const readStage = vi.fn(async (_run: RunDirectoryScope, stageId: StageId) => (
    stageId === 'preflight' || stageId === 'narration' ? report(stageId) : null
  ));
  const listRunDirectory = vi.fn(async () => [
    {name: 'narration-b.json', kind: 'file' as const},
    {name: 'preflight-z.json', kind: 'file' as const},
    {name: 'narration-a.json', kind: 'file' as const},
  ]);
  const readAttemptReport = vi.fn(async (
    _run: RunDirectoryScope,
    relativePath: string,
  ) => {
    if (relativePath.includes('preflight')) {
      return report('preflight', 'failed', '2026-08-12T00:00:03.000Z');
    }
    return report(
      'narration',
      'cancelled',
      relativePath.includes('-a.')
        ? '2026-08-12T00:00:01.000Z'
        : '2026-08-12T00:00:02.000Z',
    );
  });
  const dependencies: ReportCommandDependencies = {
    workspaceRoot: '/workspace',
    stdout: {write: (chunk) => { stdout += chunk; }},
    stderr: {write: (chunk) => { stderr += chunk; }},
    runStore: {readCurrentReadonly, openExistingRun},
    reportStore: {readStage},
    registry: [{id: 'preflight'}, {id: 'ingest'}, {id: 'narration'}],
    listRunDirectory,
    readAttemptReport,
  };
  return {
    dependencies,
    readCurrentReadonly,
    openExistingRun,
    readStage,
    listRunDirectory,
    readAttemptReport,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

describe('videoctl report', () => {
  it('returns an empty readonly report without opening a Run when current is absent', async () => {
    const fixture = makeDependencies(null);

    const exitCode = await runReportCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      current: null,
      stages: [],
      attempts: [],
    });
    expect(fixture.readCurrentReadonly).toHaveBeenCalledWith('demo');
    expect(fixture.openExistingRun).not.toHaveBeenCalled();
    expect(fixture.readStage).not.toHaveBeenCalled();
    expect(fixture.listRunDirectory).not.toHaveBeenCalled();
  });

  it('reads canonical and attempt reports in registry order', async () => {
    const fixture = makeDependencies(current);

    const exitCode = await runReportCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );
    const output = JSON.parse(fixture.stdout()) as {
      stages: StageReport[];
      attempts: StageReport[];
    };

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.openExistingRun).toHaveBeenCalledWith('demo', 'run-current');
    expect(fixture.readStage.mock.calls.map((call) => call[1])).toEqual([
      'preflight',
      'ingest',
      'narration',
    ]);
    expect(fixture.readAttemptReport.mock.calls.map((call) => call[1])).toEqual([
      'reports/attempts/preflight-z.json',
      'reports/attempts/narration-a.json',
      'reports/attempts/narration-b.json',
    ]);
    expect(output.stages.map((item) => item.stageId)).toEqual([
      'preflight',
      'narration',
    ]);
    expect(output.attempts.map((item) => `${item.stageId}:${item.startedAt}`)).toEqual([
      'preflight:2026-08-12T00:00:03.000Z',
      'narration:2026-08-12T00:00:01.000Z',
      'narration:2026-08-12T00:00:02.000Z',
    ]);
  });

  it('does not create work directories while reporting no current Run', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'videoctl-report-'));
    tempDirectories.push(workspaceRoot);
    let stdout = '';

    const exitCode = await runReportCommand('demo', {json: true}, {
      workspaceRoot,
      stdout: {write: (chunk) => { stdout += chunk; }},
      stderr: {write: () => undefined},
    });

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(stdout)).toMatchObject({current: null});
    await expect(access(path.join(workspaceRoot, '.work')))
      .rejects.toMatchObject({code: 'ENOENT'});
  });
});
