import {spawnSync} from 'node:child_process';
import {lstat, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {loadProject, type ProjectInputs} from '../../../src/domain/load-project';
import {JsonFileError} from '../../../src/fs/json-files';
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';
import {
  ExecutionPlanError,
  type ExecutionPlan,
  type ExecutionPlanRequest,
} from '../../../src/pipeline/execution-plan';
import {acquireProjectLock} from '../../../src/pipeline/project-lock';
import {PipelineRuntimeError} from '../../../src/pipeline/runtime-errors';
import {
  createRunId,
  runExecutionPlan,
  type PipelineRunResult,
  type RunExecutionInput,
} from '../../../src/pipeline/runner';
import {
  createOutputStore,
  createRunStore,
} from '../../../src/pipeline/run-store';
import type {PipelineSignalHandle} from '../../../src/pipeline/signals';
import {
  discoverProjectSourceCatalog,
  type ProjectSourceCatalog,
} from '../../../src/pipeline/source-assets';
import {createStageReportStore} from '../../../src/pipeline/stage-report';
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
  createTempProject,
} from '../../helpers/temp-project';
import {
  fakePreflightResult,
  fakeStage,
} from '../../helpers/pipeline-fixtures';

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

const systemFailure = (
  code: string,
  message: string,
): NodeJS.ErrnoException => Object.assign(new Error(message), {code});

const zodFailure = (): Error => {
  const result = z.literal('expected').safeParse('secret-cause');
  if (result.success) throw new Error('Expected Zod validation to fail.');
  return result.error;
};

const retrySafeStale = (
  message: string,
  stageId = 'ingest' as const,
): ExecutionPlanError & {readonly retrySafe: true} => Object.assign(
  new ExecutionPlanError('PLAN_STALE', message, stageId),
  {retrySafe: true as const},
);

const runVideoctlOnPlatform = async (
  platform: NodeJS.Platform,
  argv: readonly string[],
) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'videoctl-bootstrap-'));
  try {
    const preload = path.join(directory, 'platform.mjs');
    await writeFile(
      preload,
      `Object.defineProperty(process, 'platform', {value: ${JSON.stringify(platform)}});\n`,
      'utf8',
    );
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', 'src/cli/videoctl.ts', ...argv],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--import=${pathToFileURL(preload).href}`,
          ].filter((value) => value !== undefined && value.length > 0).join(' '),
        },
      },
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
};

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
  it('shows help without initializing Darwin-only system stores', async () => {
    const result = await runVideoctlOnPlatform('linux', ['--help']);

    expect(result.status).toBe(EXIT_CODES.success);
    expect(result.stdout).toContain('Usage: videoctl');
    expect(result.stderr).toBe('');
  });

  it('formats synchronous system bootstrap failures without a raw stack', async () => {
    const result = await runVideoctlOnPlatform('linux', [
      'pipeline', 'demo', '--plan',
    ]);

    expect(result.status).toBe(EXIT_CODES.environmentFailed);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      'Pipeline failure: PIPELINE_EXECUTION_FAILED: Pipeline execution failed unexpectedly.\n',
    );
    expect(result.stderr).not.toContain('AppDirectoryPlatformError');
    expect(result.stderr).not.toContain('src/fs/app-directory-scopes.ts');
  });

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

  it.each([
    ['invalid JSON', () => new SyntaxError('secret-cause invalid JSON')],
    ['invalid schema', () => zodFailure()],
    ['missing authoring file', () => systemFailure(
      'ENOENT',
      'secret-cause missing /private/project/script.json',
    )],
  ] as const)(
    'maps JsonFileError wrapping %s to a sanitized project load failure',
    async (_case, makeCause) => {
      const fixture = makeDependencies();
      fixture.dependencies.loadProject.mockRejectedValueOnce(new JsonFileError(
        '/private/project/project.json',
        makeCause(),
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
      expect(fixture.stdout()).not.toContain('/private/project');
      expect(fixture.stdout()).not.toContain('secret-cause');
    },
  );

  it('maps JsonFileError wrapping EACCES to a sanitized environment failure', async () => {
    const fixture = makeDependencies();
    fixture.dependencies.loadProject.mockRejectedValueOnce(new JsonFileError(
      '/private/project/project.json',
      systemFailure(
        'EACCES',
        'secret-cause permission denied at /private/project/project.json',
      ),
    ));

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
    expect(fixture.stdout()).not.toContain('/private/project');
    expect(fixture.stdout()).not.toContain('secret-cause');
  });

  it('maps source discovery I/O wrappers to a sanitized environment failure', async () => {
    const fixture = makeDependencies();
    const sourceFailure = await discoverProjectSourceCatalog(project(), {
      listSourceFiles: vi.fn(async () => {
        throw systemFailure(
          'EIO',
          'secret-cause read failed at /private/project/assets/source',
        );
      }),
      hashProjectFile: vi.fn(async () => 'sha256:unused'),
    }).then(
      () => { throw new Error('Expected source discovery to fail.'); },
      (error: unknown) => error,
    );
    expect(sourceFailure).toMatchObject({
      code: 'PROJECT_SOURCE_INVALID',
      cause: {code: 'EIO'},
    });
    fixture.dependencies.discoverProjectSourceCatalog
      .mockRejectedValueOnce(sourceFailure);

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      code: 'EIO',
      message: 'Pipeline environment I/O failed.',
    });
    expect(fixture.stdout()).not.toContain('/private/project');
    expect(fixture.stdout()).not.toContain('secret-cause');
  });

  it('keeps genuine source path validation at exit 3', async () => {
    const fixture = makeDependencies();
    const sourceFailure = await discoverProjectSourceCatalog(project(), {
      listSourceFiles: vi.fn(async () => [{
        sourcePath: '../private/secret-source.mp4',
        sizeBytes: 1,
      }]),
      hashProjectFile: vi.fn(async () => 'sha256:unused'),
    }).then(
      () => { throw new Error('Expected source discovery to fail.'); },
      (error: unknown) => error,
    );
    expect(sourceFailure).toMatchObject({code: 'PROJECT_SOURCE_INVALID'});
    fixture.dependencies.discoverProjectSourceCatalog
      .mockRejectedValueOnce(sourceFailure);

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      code: 'PROJECT_SOURCE_INVALID',
      message: 'Project source assets could not be discovered safely.',
    });
    expect(fixture.stdout()).not.toContain('secret-source');
  });

  it('prioritizes AggregateError environment causes over plan validation', async () => {
    const fixture = makeDependencies();
    fixture.dependencies.buildExecutionPlan.mockRejectedValueOnce(new AggregateError([
      new ExecutionPlanError(
        'PLAN_RANGE_INVALID',
        'secret-cause invalid range',
        'draft',
      ),
      systemFailure(
        'ENOSPC',
        'secret-cause disk full at /private/project/.work',
      ),
    ], 'secret aggregate'));

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      code: 'ENOSPC',
      message: 'Pipeline storage is exhausted.',
    });
    expect(fixture.stdout()).not.toContain('/private/project');
    expect(fixture.stdout()).not.toContain('secret-cause');
  });

  it.each(['cycle', 'no cause'] as const)(
    'falls back safely for a JsonFileError with %s',
    async (causeKind) => {
      const fixture = makeDependencies();
      const cyclicCause = new Error('secret-cause cycle') as Error & {
        cause?: unknown;
      };
      cyclicCause.cause = cyclicCause;
      fixture.dependencies.loadProject.mockRejectedValueOnce(new JsonFileError(
        '/private/project/project.json',
        causeKind === 'cycle' ? cyclicCause : undefined,
      ));

      const exitCode = await runPipelineCommand(
        'demo',
        {json: true},
        fixture.dependencies,
      );

      expect(exitCode).toBe(EXIT_CODES.environmentFailed);
      expect(JSON.parse(fixture.stdout())).toEqual({
        projectId: 'demo',
        code: 'PIPELINE_EXECUTION_FAILED',
        message: 'Pipeline execution failed unexpectedly.',
      });
      expect(fixture.stdout()).not.toContain('/private/project');
      expect(fixture.stdout()).not.toContain('secret-cause');
    },
  );

  it('keeps a root PipelineRuntimeError at exit 4 despite schema causes', async () => {
    const fixture = makeDependencies();
    fixture.dependencies.runExecutionPlan.mockRejectedValueOnce(
      new PipelineRuntimeError(
        'PIPELINE_STAGE_FAILED',
        'Pipeline stage ingest failed.',
        'ingest',
        {cause: new SyntaxError('secret-cause malformed stage output')},
      ),
    );

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(JSON.parse(fixture.stdout())).toEqual({
      projectId: 'demo',
      code: 'PIPELINE_STAGE_FAILED',
      message: 'Pipeline stage ingest failed.',
      stageId: 'ingest',
    });
    expect(fixture.stdout()).not.toContain('secret-cause');
  });

  it('rebuilds and retries a cause-wrapped retry-safe PLAN_STALE exactly once', async () => {
    const fixture = makeDependencies();
    const firstPlan = executionPlan({targetRunId: 'run-first'});
    const secondPlan = executionPlan({targetRunId: 'run-second'});
    fixture.dependencies.buildExecutionPlan
      .mockResolvedValueOnce(firstPlan)
      .mockResolvedValueOnce(secondPlan);
    fixture.dependencies.runExecutionPlan
      .mockRejectedValueOnce(new Error('Runner stale wrapper', {
        cause: retrySafeStale('source Run changed before writes'),
      }))
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
    fixture.dependencies.runExecutionPlan.mockImplementation(async () => {
      const stale = retrySafeStale('still stale');
      throw new AggregateError([stale], 'Runner stale aggregate', {cause: stale});
    });

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

  it('does not retry an unmarked PLAN_STALE', async () => {
    const fixture = makeDependencies();
    fixture.dependencies.runExecutionPlan.mockRejectedValueOnce(
      new ExecutionPlanError(
        'PLAN_STALE',
        'stale after persistence began',
        'ingest',
      ),
    );

    const exitCode = await runPipelineCommand(
      'demo',
      {json: true},
      fixture.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.dependencies.buildExecutionPlan).toHaveBeenCalledOnce();
    expect(fixture.dependencies.runExecutionPlan).toHaveBeenCalledOnce();
    expect(JSON.parse(fixture.stdout())).toMatchObject({
      code: 'PLAN_STALE',
      message: 'stale after persistence began',
      stageId: 'ingest',
    });
  });

  it('retries a real Runner pre-write stale only after proving zero persistent writes', async () => {
    const tempProject = await createTempProject();
    try {
      const loaded = await loadProject(tempProject.workspaceRoot, 'demo');
      const runStore = createRunStore(tempProject.workspaceRoot);
      const outputStore = createOutputStore(tempProject.workspaceRoot);
      const reportStore = createStageReportStore();
      const registry = [fakeStage('preflight', {
        execute: async () => ({
          state: 'passed',
          fingerprint: 'sha256:preflight',
          outputs: fakePreflightResult(),
          artifacts: [],
          checks: [],
        }),
      })];
      const runnerDependencies = {
        registry,
        runStore,
        outputStore,
        reportStore,
        acquireProjectLock,
        createRunId,
        now: () => '2026-08-12T00:00:00.000Z',
      };
      const validPlan = executionPlan({
        projectId: 'demo',
        preset: 'release',
        stageIds: ['preflight'],
        targetRunId: 'run-fresh',
        items: [{
          position: 1,
          total: 1,
          stageId: 'preflight',
          displayName: 'Preflight',
          action: 'run',
          fingerprint: null,
          materialize: false,
        }],
      });
      const stalePlan = {...validPlan, projectId: 'other-project'};
      let runAttempts = 0;
      let verifiedNoWrites = false;
      let stdout = '';
      let stderr = '';
      const dependencies = {
        workspaceRoot: tempProject.workspaceRoot,
        stdout: {write: (chunk: string) => { stdout += chunk; }},
        stderr: {write: (chunk: string) => { stderr += chunk; }},
        loadProject: vi.fn(async () => loaded),
        discoverProjectSourceCatalog: vi.fn(async () => sourceCatalog()),
        buildExecutionPlan: vi.fn()
          .mockResolvedValueOnce(stalePlan)
          .mockResolvedValueOnce(validPlan),
        runExecutionPlan: vi.fn(async (input: RunExecutionInput) => {
          runAttempts += 1;
          try {
            return await runExecutionPlan(input, runnerDependencies);
          } catch (error) {
            if (runAttempts === 1) {
              expect(error).toMatchObject({
                code: 'PLAN_STALE',
                retrySafe: true,
              });
              await expect(runStore.readCurrentReadonly('demo')).resolves.toBeNull();
              await expect(outputStore.readCurrentReadonly('demo')).resolves.toBeNull();
              await expect(lstat(path.join(
                tempProject.workspaceRoot,
                '.work',
                'demo',
                'runs',
              ))).rejects.toMatchObject({code: 'ENOENT'});
              await expect(lstat(path.join(
                tempProject.workspaceRoot,
                '.work',
                'demo',
                'pipeline.lock',
              ))).rejects.toMatchObject({code: 'ENOENT'});
              verifiedNoWrites = true;
              throw new AggregateError([error], 'wrapped Runner stale', {cause: error});
            }
            throw error;
          }
        }),
        installPipelineSignalHandlers: vi.fn(() => ({
          signal: new AbortController().signal,
          dispose: vi.fn(),
        })),
      } satisfies PipelineCommandDependencies;

      const exitCode = await runPipelineCommand('demo', {}, dependencies);

      expect(exitCode).toBe(EXIT_CODES.success);
      expect(verifiedNoWrites).toBe(true);
      expect(dependencies.buildExecutionPlan).toHaveBeenCalledTimes(2);
      expect(dependencies.runExecutionPlan).toHaveBeenCalledTimes(2);
      expect(stdout).toContain('State: passed');
      expect(stderr).toBe('');
    } finally {
      await tempProject.cleanup();
    }
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
      '--json',
      'demo',
      '--preset',
      'release\nSTATUS forged\u001b[31m',
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

  it('does not infer JSON output from an unsupported review --json option', async () => {
    const fixture = makeDependencies();

    const exitCode = await runVideoctl([
      'review',
      'demo',
      '--approve',
      '--reason',
      'looks good',
      '--json',
    ], fixture.dependencies as VideoctlDependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(fixture.stdout()).toBe('');
    expect(fixture.stderr()).toBe(
      'Pipeline failure: CLI_ARGUMENT_INVALID: Invalid command-line arguments.\n',
    );
    expect(fixture.dependencies.loadProject).not.toHaveBeenCalled();
  });
});
