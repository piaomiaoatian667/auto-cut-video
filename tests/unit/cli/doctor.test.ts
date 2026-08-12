import {describe, expect, it, vi} from 'vitest';
import type {ProjectInputs} from '../../../src/domain/load-project';
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';
import type {ExecutionPlan} from '../../../src/pipeline/execution-plan';
import type {PipelineRunResult} from '../../../src/pipeline/runner';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import type {PreflightResult} from '../../../src/pipeline/stages/preflight';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {runVideoctl, type VideoctlDependencies} from '../../../src/cli/videoctl';
import {
  createEditFixture,
  createProjectFixture,
  createScriptFixture,
} from '../../helpers/temp-project';

const successfulResult = (): PreflightResult => ({
  checks: [
    {
      id: 'supported-platform',
      severity: 'info',
      message: 'Platform is supported.',
      value: 'darwin/arm64',
      expected: 'darwin/arm64',
    },
    {
      id: 'qt-faststart',
      severity: 'info',
      message: 'qt-faststart is available.',
      affectedPaths: ['/real/qt-faststart'],
    },
  ],
  toolIdentities: {
    ffmpeg: {realPath: '/real/ffmpeg', sha256: 'sha256:ffmpeg'},
    ffprobe: {realPath: '/real/ffprobe', sha256: 'sha256:ffprobe'},
    qtFaststart: {realPath: '/real/qt-faststart', sha256: 'sha256:faststart'},
  },
  fonts: [{path: 'assets/fonts/font.otf', sha256: 'sha256:font'}],
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
    sourceBytes: 1024,
    requiredBytes: 2 * 1024 ** 3,
    availableBytes: 20 * 1024 ** 3,
    workDirectory: '/workspace/.work/demo',
  },
  environmentFingerprint: 'sha256:environment',
});

const failedResult = (): PreflightResult => {
  const result = successfulResult();
  result.checks = [{
    id: 'qt-faststart',
    severity: 'error',
    code: 'ENV_TOOL_MISSING',
    message: 'The FFmpeg sibling qt-faststart is missing or unusable.',
    affectedPaths: ['/real/qt-faststart'],
  }];
  result.toolIdentities.qtFaststart = null;
  result.environmentFingerprint = 'sha256:failed-environment';
  return result;
};

const loadedProject = (): ProjectInputs => ({
  workspaceRoot: '/workspace',
  projectDirectory: {} as ProjectDirectoryScope,
  project: createProjectFixture(),
  script: createScriptFixture(),
  edit: createEditFixture(),
});

const sourceCatalog = (): ProjectSourceCatalog => ({
  assets: [{
    assetId: 'source-1',
    kind: 'image',
    sourcePath: 'assets/source/cover.png',
    sizeBytes: 1024,
    sha256: 'sha256:cover',
  }],
  totalBytes: 1024,
  fingerprint: 'sha256:source',
});

const plan = (): ExecutionPlan => ({
  version: 1,
  projectId: 'demo',
  preset: 'release',
  stageIds: ['preflight'],
  runMode: 'new',
  requiresProgressReconciliation: false,
  requiresRuntimePreflight: false,
  targetRunId: 'run-doctor',
  items: [{
    position: 1,
    total: 1,
    stageId: 'preflight',
    displayName: 'Environment Preflight',
    action: 'run',
    fingerprint: null,
    materialize: false,
  }],
});

const fixture = (result: PreflightResult = successfulResult()) => {
  let stdout = '';
  let stderr = '';
  const projectInputs = loadedProject();
  const catalog = sourceCatalog();
  const dispose = vi.fn();
  const dependencies = {
    workspaceRoot: '/workspace',
    stdout: {write: (chunk: string) => { stdout += chunk; }},
    stderr: {write: (chunk: string) => { stderr += chunk; }},
    loadProject: vi.fn(async () => projectInputs),
    discoverProjectSourceCatalog: vi.fn(async () => catalog),
    buildExecutionPlan: vi.fn(async () => plan()),
    runExecutionPlan: vi.fn(async (): Promise<PipelineRunResult> => ({
      projectId: 'demo',
      preset: 'release',
      state: result.checks.some((check) => check.severity === 'error')
        ? 'failed'
        : 'passed',
      completedStage: 'preflight',
      reports: [],
      preflight: result,
      warnings: [],
    })),
    installPipelineSignalHandlers: vi.fn(() => ({
      signal: new AbortController().signal,
      dispose,
    })),
  } satisfies VideoctlDependencies;
  return {
    dependencies,
    projectInputs,
    catalog,
    dispose,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

describe('videoctl doctor', () => {
  it('exports the exact shared exit-code contract', () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      needsReview: 2,
      validationFailed: 3,
      environmentFailed: 4,
      cancelled: 130,
      terminated: 143,
    });
  });

  it('uses the shared preflight-only plan and Runner while preserving the table', async () => {
    const {dependencies, projectInputs, catalog, dispose, stdout, stderr} = fixture();

    const exitCode = await runVideoctl(['doctor', 'demo'], dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(dependencies.loadProject).toHaveBeenCalledWith('/workspace', 'demo');
    expect(dependencies.discoverProjectSourceCatalog).toHaveBeenCalledWith(projectInputs);
    expect(dependencies.buildExecutionPlan).toHaveBeenCalledWith(
      projectInputs,
      catalog,
      {preset: 'release', to: 'preflight'},
    );
    expect(dependencies.runExecutionPlan).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    expect(stdout()).toBe([
      'Environment doctor: demo',
      'STATUS  CHECK               CODE  MESSAGE',
      'PASS    supported-platform  -     Platform is supported.',
      'PASS    qt-faststart        -     qt-faststart is available.',
      '',
      'FFmpeg real path: /real/ffmpeg',
      'FFmpeg SHA-256: sha256:ffmpeg',
      'FFprobe real path: /real/ffprobe',
      'FFprobe SHA-256: sha256:ffprobe',
      'qt-faststart real path: /real/qt-faststart',
      'qt-faststart SHA-256: sha256:faststart',
      'Environment fingerprint: sha256:environment',
      '',
    ].join('\n'));
    expect(stderr()).toBe('');
  });

  it('prints the Runner in-memory Preflight output as JSON', async () => {
    const {dependencies, stdout} = fixture();

    const exitCode = await runVideoctl(['doctor', 'demo', '--json'], dependencies);
    const report = JSON.parse(stdout()) as PreflightResult & {
      command: string;
      project: string;
      ok: boolean;
    };

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(report).toMatchObject({
      command: 'doctor',
      project: 'demo',
      ok: true,
      environmentFingerprint: 'sha256:environment',
    });
  });

  it('maps failed Preflight checks to environmentFailed', async () => {
    const table = fixture(failedResult());
    const json = fixture(failedResult());

    await expect(runVideoctl(['doctor', 'demo'], table.dependencies))
      .resolves.toBe(EXIT_CODES.environmentFailed);
    await expect(runVideoctl(['doctor', 'demo', '--json'], json.dependencies))
      .resolves.toBe(EXIT_CODES.environmentFailed);
    expect(table.stdout()).toContain('ENV_TOOL_MISSING');
    expect(JSON.parse(json.stdout()).ok).toBe(false);
  });

  it('sanitizes table controls while preserving JSON string semantics', async () => {
    const injectedId = 'font:evil\nERROR forged';
    const injectedMessage = 'Missing font\u001b[31m\nSTATUS forged\u009b31m';
    const result = failedResult();
    result.checks = [{
      id: injectedId,
      severity: 'error',
      code: 'ENV_FONT_MISSING',
      message: injectedMessage,
    }];
    const table = fixture(result);
    const json = fixture(result);

    await runVideoctl(['doctor', 'demo'], table.dependencies);
    await runVideoctl(['doctor', 'demo', '--json'], json.dependencies);

    expect(table.stdout()).not.toMatch(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u,
    );
    expect(table.stdout()).not.toContain('\u001b');
    expect(JSON.parse(json.stdout()).checks[0]).toMatchObject({
      id: injectedId,
      message: injectedMessage,
    });
  });

  it('reports project loading failures without leaking exception details', async () => {
    const {dependencies, stdout, stderr} = fixture();
    dependencies.loadProject.mockRejectedValueOnce(
      new Error('secret workspace authority /private/projects'),
    );

    const exitCode = await runVideoctl(['doctor', 'demo'], dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(stdout()).toBe('');
    expect(stderr()).toBe('Unable to load project "demo".\n');
  });

  it('sanitizes project identifiers in text loading failures', async () => {
    const {dependencies, stderr} = fixture();
    dependencies.loadProject.mockRejectedValueOnce(new Error('invalid project id'));

    const exitCode = await runVideoctl([
      'doctor',
      'demo\nSTATUS forged\u001b[31m',
    ], dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(stderr()).not.toContain('\u001b');
    expect(stderr().split('\n').filter((line) => line.includes('STATUS forged')))
      .toHaveLength(1);
  });

  it('maps source discovery failures to sanitized validation JSON', async () => {
    const {dependencies, stdout, stderr} = fixture();
    dependencies.discoverProjectSourceCatalog.mockRejectedValueOnce(
      new Error('secret source path /private/source.mov'),
    );

    const exitCode = await runVideoctl(['doctor', 'demo', '--json'], dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(JSON.parse(stdout())).toMatchObject({
      ok: false,
      checks: [{
        id: 'source-assets',
        code: 'PROJECT_SOURCE_INVALID',
      }],
    });
    expect(stdout()).not.toContain('/private/source.mov');
    expect(stderr()).toBe('');
  });

  it('sanitizes unexpected Runner failures deterministically', async () => {
    const first = fixture();
    const second = fixture();
    first.dependencies.runExecutionPlan.mockRejectedValueOnce(
      new Error('token=super-secret path=/private/authority-root'),
    );
    second.dependencies.runExecutionPlan.mockRejectedValueOnce(
      new Error('different private failure'),
    );

    const firstExit = await runVideoctl(
      ['doctor', 'demo', '--json'],
      first.dependencies,
    );
    const secondExit = await runVideoctl(
      ['doctor', 'demo', '--json'],
      second.dependencies,
    );

    expect(firstExit).toBe(EXIT_CODES.environmentFailed);
    expect(secondExit).toBe(EXIT_CODES.environmentFailed);
    expect(first.stdout()).toBe(second.stdout());
    expect(first.stdout()).not.toContain('super-secret');
    expect(JSON.parse(first.stdout())).toMatchObject({
      ok: false,
      checks: [{code: 'ENV_PREFLIGHT_FAILED'}],
    });
  });
});
