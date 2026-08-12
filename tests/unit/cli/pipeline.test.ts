import {describe, expect, it, vi} from 'vitest';
import type {ProjectInputs} from '../../../src/domain/load-project';
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';
import {
  ExecutionPlanError,
  type ExecutionPlan,
  type ExecutionPlanRequest,
} from '../../../src/pipeline/execution-plan';
import {PipelineRuntimeError} from '../../../src/pipeline/runtime-errors';
import type {
  PipelineRunResult,
  RunExecutionInput,
} from '../../../src/pipeline/runner';
import type {PipelineSignalHandle} from '../../../src/pipeline/signals';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import type {PreflightResult} from '../../../src/pipeline/stages/preflight';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  runPipelineCommand,
  type PipelineCommandDependencies,
} from '../../../src/cli/commands/pipeline';
import {runVideoctl, type VideoctlDependencies} from '../../../src/cli/videoctl';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
} from '../../helpers/temp-project';

const project = (): ProjectInputs => ({
  workspaceRoot: '/workspace',
  projectDirectory: {} as ProjectDirectoryScope,
  project: createProjectFixture('demo'),
  script: createScriptFixture(),
  edit: createEditFixture(),
});

const sourceCatalog = (): ProjectSourceCatalog => ({
  assets: [],
  totalBytes: 0,
  fingerprint: 'sha256:source',
});

const preflight = (): PreflightResult => ({
  checks: [{
    id: 'supported-platform',
    severity: 'info',
    message: 'Platform is supported.',
  }],
  toolIdentities: {
    ffmpeg: {realPath: '/real/ffmpeg', sha256: 'sha256:ffmpeg'},
    ffprobe: {realPath: '/real/ffprobe', sha256: 'sha256:ffprobe'},
    qtFaststart: {realPath: '/real/qt-faststart', sha256: 'sha256:faststart'},
  },
  fonts: [],
  voice: {
    configured: 'Tingting',
    available: true,
    segmentedWavFallback: false,
  },
  versions: {
    node: '22.17.0',
    pnpm: '10.14.0',
    macos: '15.6',
    ffmpeg: '8.0',
    ffprobe: '8.0',
  },
  system: {
    platform: 'darwin',
    arch: 'arm64',
    sourceBytes: 0,
    requiredBytes: 0,
    availableBytes: 1,
    workDirectory: '/workspace/.work/demo',
  },
  environmentFingerprint: 'sha256:environment',
});

const executionPlan = (
  request: Partial<ExecutionPlan> = {},
): ExecutionPlan => ({
  version: 1,
  projectId: 'demo',
  preset: 'draft',
  stageIds: ['preflight', 'ingest'],
  runMode: 'new',
  requiresProgressReconciliation: false,
  requiresRuntimePreflight: false,
  targetRunId: 'run-new',
  items: [
    {
      position: 1,
      total: 2,
      stageId: 'preflight',
      displayName: 'Environment Preflight',
      action: 'run',
      fingerprint: null,
      materialize: false,
    },
    {
      position: 2,
      total: 2,
      stageId: 'ingest',
      displayName: 'Source Ingest',
      action: 'cached',
      fingerprint: 'sha256:ingest',
      sourceRunId: 'run-source',
      materialize: true,
    },
  ],
  ...request,
});

const pipelineResult = (
  request: Partial<PipelineRunResult> = {},
): PipelineRunResult => ({
  projectId: 'demo',
  runId: 'run-new',
  preset: 'draft',
  state: 'passed',
  completedStage: 'ingest',
  reports: [],
  warnings: [],
  ...request,
});

const makeDependencies = () => {
  let stdout = '';
  let stderr = '';
  const handle: PipelineSignalHandle = {
    signal: new AbortController().signal,
    dispose: vi.fn(),
  };
  const dependencies = {
    workspaceRoot: '/workspace',
    stdout: {write: (chunk: string) => { stdout += chunk; }},
    stderr: {write: (chunk: string) => { stderr += chunk; }},
    loadProject: vi.fn(async () => project()),
    discoverProjectSourceCatalog: vi.fn(async () => sourceCatalog()),
    buildExecutionPlan: vi.fn(async () => executionPlan()),
    runExecutionPlan: vi.fn(async (_input: RunExecutionInput) => pipelineResult()),
    installPipelineSignalHandlers: vi.fn(() => handle),
  } satisfies PipelineCommandDependencies;
  return {
    dependencies,
    handle,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

describe('pipeline CLI commands', () => {
  it.each([
    ['doctor', ['doctor', 'demo'], {preset: 'release', to: 'preflight'}],
    ['ingest', ['ingest', 'demo'], {preset: 'assets', to: 'ingest'}],
    ['run', ['run', 'demo', '--to', 'narration'], {preset: 'draft', to: 'narration'}],
    ['compile', ['compile', 'demo'], {preset: 'draft', to: 'compile'}],
    ['release', ['release', 'demo'], {preset: 'release'}],
  ] satisfies Array<[string, string[], ExecutionPlanRequest]>)
    ('maps %s through the shared planner and Runner exactly once', async (
      _name,
      argv,
      request,
    ) => {
      const fixture = makeDependencies();
      if (argv[0] === 'doctor') {
        fixture.dependencies.runExecutionPlan.mockResolvedValueOnce(pipelineResult({
          preset: 'release',
          completedStage: 'preflight',
          preflight: preflight(),
        }));
      }

      const exitCode = await runVideoctl(
        argv,
        fixture.dependencies as VideoctlDependencies,
      );

      expect(exitCode).toBe(EXIT_CODES.success);
      expect(fixture.dependencies.buildExecutionPlan).toHaveBeenCalledOnce();
      expect(fixture.dependencies.buildExecutionPlan).toHaveBeenCalledWith(
        expect.objectContaining({project: expect.objectContaining({id: 'demo'})}),
        expect.objectContaining({fingerprint: 'sha256:source'}),
        request,
      );
      expect(fixture.dependencies.runExecutionPlan).toHaveBeenCalledOnce();
    });

  it('forwards every pipeline option to the plan builder', async () => {
    const fixture = makeDependencies();

    const exitCode = await runVideoctl([
      'pipeline',
      'demo',
      '--preset', 'release',
      '--from', 'ingest',
      '--to', 'draft',
      '--resume',
      '--force', 'narration',
      '--json',
    ], fixture.dependencies as VideoctlDependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.dependencies.buildExecutionPlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        preset: 'release',
        from: 'ingest',
        to: 'draft',
        resume: true,
        force: 'narration',
      },
    );
  });

  it('prints a plan without installing signals or invoking the Runner', async () => {
    const fixture = makeDependencies();
    const plan = executionPlan();
    fixture.dependencies.buildExecutionPlan.mockResolvedValueOnce(plan);

    const exitCode = await runPipelineCommand(
      'demo',
      {preset: 'draft', plan: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.dependencies.installPipelineSignalHandlers).not.toHaveBeenCalled();
    expect(fixture.dependencies.runExecutionPlan).not.toHaveBeenCalled();
    expect(fixture.stdout()).toContain('1/2');
    expect(fixture.stdout()).toContain('preflight');
    expect(fixture.stdout()).toContain('Environment Preflight');
    expect(fixture.stdout()).toContain('run');
    expect(fixture.stdout()).toContain('materialize from run-source');
  });

  it('prints plans as stable JSON without changing JSON string semantics', async () => {
    const fixture = makeDependencies();
    const injected = 'Source\nIngest\u001b[31m';
    const plan = executionPlan({
      items: executionPlan().items.map((item) => (
        item.stageId === 'ingest' ? {...item, displayName: injected} : item
      )),
    });
    fixture.dependencies.buildExecutionPlan.mockResolvedValueOnce(plan);

    const exitCode = await runPipelineCommand(
      'demo',
      {plan: true, json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(JSON.parse(fixture.stdout())).toEqual(plan);
    expect(JSON.parse(fixture.stdout()).items[1].displayName).toBe(injected);
  });

  it('maps invalid ranges to validation failure before signals or Runner', async () => {
    const fixture = makeDependencies();
    fixture.dependencies.buildExecutionPlan.mockRejectedValueOnce(
      new ExecutionPlanError(
        'PLAN_RANGE_INVALID',
        'Stage range draft through ingest is reversed',
        'draft',
      ),
    );

    const exitCode = await runPipelineCommand(
      'demo',
      {from: 'draft', to: 'ingest'},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.dependencies.installPipelineSignalHandlers).not.toHaveBeenCalled();
    expect(fixture.dependencies.runExecutionPlan).not.toHaveBeenCalled();
    expect(fixture.stderr()).toContain('PLAN_RANGE_INVALID');
  });

  it.each([
    ['project load', (fixture: ReturnType<typeof makeDependencies>, failure: Error) => {
      fixture.dependencies.loadProject.mockRejectedValueOnce(failure);
    }],
    ['source catalog', (fixture: ReturnType<typeof makeDependencies>, failure: Error) => {
      fixture.dependencies.discoverProjectSourceCatalog.mockRejectedValueOnce(failure);
    }],
    ['plan build', (fixture: ReturnType<typeof makeDependencies>, failure: Error) => {
      fixture.dependencies.buildExecutionPlan.mockRejectedValueOnce(failure);
    }],
  ] as const)('maps trusted EACCES from %s to a sanitized environment failure', async (
    _phase,
    arrange,
  ) => {
    const fixture = makeDependencies();
    const failure = Object.assign(
      new Error('permission denied at /private/secret-authority token=hidden'),
      {code: 'EACCES'},
    );
    arrange(fixture, failure);

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      code: 'EACCES',
      message: 'Pipeline environment access was denied.',
    });
    expect(fixture.stdout()).not.toContain('/private/secret-authority');
    expect(fixture.stdout()).not.toContain('token=hidden');
    expect(fixture.dependencies.installPipelineSignalHandlers).not.toHaveBeenCalled();
    expect(fixture.dependencies.runExecutionPlan).not.toHaveBeenCalled();
  });

  it('keeps authoring validation failures at exit 3', async () => {
    const fixture = makeDependencies();
    fixture.dependencies.loadProject.mockRejectedValueOnce(Object.assign(
      new Error('segment secret-text is too long'),
      {code: 'SCRIPT_SEGMENT_TEXT_TOO_LONG'},
    ));

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      code: 'PROJECT_LOAD_FAILED',
      message: 'Unable to load or validate project.',
    });
    expect(fixture.stdout()).not.toContain('secret-text');
  });

  it('rebuilds and retries exactly once after a pre-write PLAN_STALE', async () => {
    const fixture = makeDependencies();
    const firstPlan = executionPlan({targetRunId: 'run-first'});
    const secondPlan = executionPlan({targetRunId: 'run-second'});
    fixture.dependencies.buildExecutionPlan
      .mockResolvedValueOnce(firstPlan)
      .mockResolvedValueOnce(secondPlan);
    fixture.dependencies.runExecutionPlan
      .mockRejectedValueOnce(new ExecutionPlanError(
        'PLAN_STALE',
        'source Run changed before writes',
        'ingest',
      ))
      .mockResolvedValueOnce(pipelineResult({runId: 'run-second'}));

    const exitCode = await runPipelineCommand(
      'demo',
      {preset: 'draft'},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(fixture.dependencies.buildExecutionPlan).toHaveBeenCalledTimes(2);
    expect(fixture.dependencies.runExecutionPlan).toHaveBeenCalledTimes(2);
    expect(fixture.dependencies.runExecutionPlan.mock.calls[0]?.[0].plan)
      .toBe(firstPlan);
    expect(fixture.dependencies.runExecutionPlan.mock.calls[1]?.[0].plan)
      .toBe(secondPlan);
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('does not retry a second PLAN_STALE', async () => {
    const fixture = makeDependencies();
    fixture.dependencies.buildExecutionPlan
      .mockResolvedValueOnce(executionPlan({targetRunId: 'run-first'}))
      .mockResolvedValueOnce(executionPlan({targetRunId: 'run-second'}));
    fixture.dependencies.runExecutionPlan.mockRejectedValue(
      Object.assign(new Error('PLAN_STALE: still stale'), {
        code: 'PLAN_STALE',
        stageId: 'ingest',
      }),
    );

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.dependencies.buildExecutionPlan).toHaveBeenCalledTimes(2);
    expect(fixture.dependencies.runExecutionPlan).toHaveBeenCalledTimes(2);
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
    expect(JSON.parse(fixture.stdout())).toMatchObject({
      code: 'PLAN_STALE',
      message: 'still stale',
      stageId: 'ingest',
    });
  });

  it.each([
    ['SIGINT', EXIT_CODES.cancelled],
    ['SIGTERM', EXIT_CODES.terminated],
  ] as const)('disposes signals and maps %s to %s', async (received, expected) => {
    const fixture = makeDependencies();
    Object.defineProperty(fixture.handle, 'received', {
      enumerable: true,
      get: () => received,
    });
    fixture.dependencies.runExecutionPlan.mockRejectedValueOnce(
      new PipelineRuntimeError('PIPELINE_CANCELLED', 'Pipeline execution was cancelled.'),
    );

    const exitCode = await runPipelineCommand('demo', {}, fixture.dependencies);

    expect(exitCode).toBe(expected);
    expect(fixture.handle.dispose).toHaveBeenCalledOnce();
  });

  it('maps needs_review and failed Runner results to stable exit codes', async () => {
    const needsReview = makeDependencies();
    needsReview.dependencies.runExecutionPlan.mockResolvedValueOnce(pipelineResult({
      state: 'needs_review',
      completedStage: 'review',
    }));
    const failed = makeDependencies();
    failed.dependencies.runExecutionPlan.mockResolvedValueOnce(pipelineResult({
      state: 'failed',
    }));

    await expect(runPipelineCommand('demo', {}, needsReview.dependencies))
      .resolves.toBe(EXIT_CODES.needsReview);
    await expect(runPipelineCommand('demo', {}, failed.dependencies))
      .resolves.toBe(EXIT_CODES.environmentFailed);
  });

  it('sanitizes text failures while JSON preserves escaped string values', async () => {
    const text = makeDependencies();
    const json = makeDependencies();
    const message = 'bad range\nSTATUS forged\u001b[31m';
    text.dependencies.buildExecutionPlan.mockRejectedValueOnce(
      new ExecutionPlanError('PLAN_RANGE_INVALID', message, 'draft'),
    );
    json.dependencies.buildExecutionPlan.mockRejectedValueOnce(
      new ExecutionPlanError('PLAN_RANGE_INVALID', message, 'draft'),
    );

    await runPipelineCommand('demo', {}, text.dependencies);
    await runPipelineCommand('demo', {json: true}, json.dependencies);

    expect(text.stderr()).not.toContain('\u001b');
    expect(text.stderr().split('\n').filter((line) => line.includes('STATUS forged')))
      .toHaveLength(1);
    expect(JSON.parse(json.stdout())).toMatchObject({
      code: 'PLAN_RANGE_INVALID',
      message,
      stageId: 'draft',
    });
  });

  it('requires the one-path run command to target narration', async () => {
    const fixture = makeDependencies();

    const exitCode = await runVideoctl(
      ['run', 'demo'],
      fixture.dependencies as VideoctlDependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.dependencies.buildExecutionPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid preset', ['pipeline', 'demo', '--preset', 'release\nSTATUS forged\u001b[31m']],
    ['invalid stage', ['pipeline', 'demo', '--from', 'draft\nSTATUS forged\u001b[31m']],
    ['missing required option', ['run', 'demo']],
    ['unknown option', ['pipeline', 'demo', '--unknown\nSTATUS forged\u001b[31m']],
  ] as const)('formats %s Commander failures without raw output', async (
    _label,
    argv,
  ) => {
    const fixture = makeDependencies();

    const exitCode = await runVideoctl(
      argv,
      fixture.dependencies as VideoctlDependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stdout()).toBe('');
    expect(fixture.stderr()).toBe(
      'Pipeline failure: CLI_ARGUMENT_INVALID: Invalid command-line arguments.\n',
    );
    expect(fixture.stderr()).not.toContain('\u001b');
    expect(fixture.stderr()).not.toContain('STATUS forged');
    expect(fixture.stderr()).not.toContain('error:');
    expect(fixture.dependencies.loadProject).not.toHaveBeenCalled();
    expect(fixture.dependencies.buildExecutionPlan).not.toHaveBeenCalled();
  });

  it('formats injected invalid preset failures as stable JSON', async () => {
    const fixture = makeDependencies();

    const exitCode = await runVideoctl([
      'pipeline',
      'demo',
      '--preset',
      'release\nSTATUS forged\u001b[31m',
      '--json',
    ], fixture.dependencies as VideoctlDependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stderr()).toBe('');
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      code: 'CLI_ARGUMENT_INVALID',
      message: 'Invalid command-line arguments.',
    });
    expect(fixture.stdout()).not.toContain('STATUS forged');
    expect(fixture.stdout()).not.toContain('allowed choices');
    expect(fixture.dependencies.loadProject).not.toHaveBeenCalled();
  });
});
