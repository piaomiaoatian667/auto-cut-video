import {describe, expect, it, vi} from 'vitest';
import {createEditFixture, createProjectFixture, createScriptFixture} from '../../helpers/temp-project';
import type {ProjectInputs} from '../../../src/domain/load-project';
import {
  ProjectPathError,
  type ProjectDirectoryScope,
} from '../../../src/fs/project-paths';
import type {PreflightResult} from '../../../src/pipeline/stages/preflight';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {runVideoctl, type VideoctlDependencies} from '../../../src/cli/videoctl';

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

const fixture = (result: PreflightResult = successfulResult()) => {
  let stdout = '';
  let stderr = '';
  const projectInputs = loadedProject();
  const dependencies: VideoctlDependencies = {
    workspaceRoot: '/workspace',
    stdout: {write: (chunk) => { stdout += chunk; }},
    stderr: {write: (chunk) => { stderr += chunk; }},
    loadProject: vi.fn(async () => projectInputs),
    measureSourceBytes: vi.fn(async () => 1024),
    preflight: vi.fn(async () => result),
    download: vi.fn(async () => { throw new Error('unused'); }),
    ffmpegExecutable: '/configured/ffmpeg',
    ffprobeExecutable: '/configured/ffprobe',
  };
  return {
    dependencies,
    projectInputs,
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
      operationFailed: 5,
      cancelled: 130,
    });
  });

  it('loads the project, injects runtime inputs, and prints a stable table', async () => {
    const {dependencies, projectInputs, stdout, stderr} = fixture();

    const exitCode = await runVideoctl(['doctor', 'demo'], dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(dependencies.loadProject).toHaveBeenCalledWith('/workspace', 'demo');
    expect(dependencies.measureSourceBytes).toHaveBeenCalledWith(projectInputs);
    expect(dependencies.preflight).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      projectDirectory: projectInputs.projectDirectory,
      project: projectInputs.project,
      script: projectInputs.script,
      sourceBytes: 1024,
      workDirectory: '/workspace/.work/demo',
      ffmpegExecutable: '/configured/ffmpeg',
      ffprobeExecutable: '/configured/ffprobe',
    });
    expect(stdout()).toBe([
      'Environment doctor: demo',
      'STATUS  CHECK               CODE  MESSAGE',
      'PASS    supported-platform  -     Platform is supported.',
      'PASS    qt-faststart        -     qt-faststart is available.',
      '',
      'FFmpeg real path: /real/ffmpeg',
      'FFmpeg SHA-256: sha256:ffmpeg',
      'qt-faststart real path: /real/qt-faststart',
      'qt-faststart SHA-256: sha256:faststart',
      'Environment fingerprint: sha256:environment',
      '',
    ].join('\n'));
    expect(stderr()).toBe('');
  });

  it('maps scoped source measurement failures to project validation JSON', async () => {
    const {dependencies, stdout, stderr} = fixture();
    dependencies.measureSourceBytes = vi.fn(async () => {
      throw new ProjectPathError(
        'project directory changed after scope creation: assets/source',
      );
    });

    const exitCode = await runVideoctl(
      ['doctor', 'demo', '--json'],
      dependencies,
    );
    const report = JSON.parse(stdout()) as {
      checks: Array<{code?: string}>;
    };

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(dependencies.preflight).not.toHaveBeenCalled();
    expect(report.checks).toContainEqual(expect.objectContaining({
      id: 'source-assets',
      code: 'PROJECT_SOURCE_INVALID',
    }));
    expect(stdout()).not.toContain('assets/source');
    expect(stderr()).toBe('');
  });

  it('prints machine-readable JSON with identities, fingerprint, and checks', async () => {
    const {dependencies, stdout, stderr} = fixture();

    const exitCode = await runVideoctl(
      ['doctor', 'demo', '--json'],
      dependencies,
    );
    const report = JSON.parse(stdout()) as Record<string, unknown>;

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(report).toMatchObject({
      command: 'doctor',
      project: 'demo',
      ok: true,
      toolIdentities: {
        ffmpeg: {realPath: '/real/ffmpeg', sha256: 'sha256:ffmpeg'},
        qtFaststart: {
          realPath: '/real/qt-faststart',
          sha256: 'sha256:faststart',
        },
      },
      environmentFingerprint: 'sha256:environment',
      checks: [
        {id: 'supported-platform', severity: 'info'},
        {id: 'qt-faststart', severity: 'info'},
      ],
    });
    expect(stderr()).toBe('');
  });

  it('returns environmentFailed and shows ENV_TOOL_MISSING in table output', async () => {
    const {dependencies, stdout} = fixture(failedResult());

    const exitCode = await runVideoctl(['doctor', 'demo'], dependencies);

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(stdout()).toContain('ERROR   qt-faststart  ENV_TOOL_MISSING');
    expect(stdout()).toContain('qt-faststart real path: unavailable');
  });

  it('returns environmentFailed for JSON reports with any environment error', async () => {
    const {dependencies, stdout} = fixture(failedResult());

    const exitCode = await runVideoctl(
      ['doctor', '--json', 'demo'],
      dependencies,
    );
    const report = JSON.parse(stdout()) as {
      ok: boolean;
      checks: Array<{code?: string}>;
    };

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      code: 'ENV_TOOL_MISSING',
    }));
  });

  it('keeps warnings at exit zero when no environment error exists', async () => {
    const result = successfulResult();
    result.checks.push({
      id: 'optional-check',
      severity: 'warning',
      message: 'Optional capability is unavailable.',
    });
    const {dependencies} = fixture(result);

    const exitCode = await runVideoctl(['doctor', 'demo'], dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
  });

  it('sanitizes table controls while preserving JSON string semantics', async () => {
    const injectedId = 'font:assets/fonts/evil.otf\nERROR forged';
    const injectedMessage = 'Missing font\u001b[31m\nSTATUS forged\u009b31m';
    const result = successfulResult();
    result.checks = [{
      id: injectedId,
      severity: 'error',
      code: 'ENV_FONT_MISSING',
      message: injectedMessage,
    }];
    result.fonts = [{
      path: 'assets/fonts/evil.otf\nERROR forged\u001b[0m',
      sha256: 'sha256:font',
    }];
    const tableRun = fixture(result);
    const jsonRun = fixture(result);

    const tableExit = await runVideoctl(
      ['doctor', 'demo'],
      tableRun.dependencies,
    );
    const jsonExit = await runVideoctl(
      ['doctor', 'demo', '--json'],
      jsonRun.dependencies,
    );
    const json = JSON.parse(jsonRun.stdout()) as PreflightResult & {
      command: string;
    };

    expect(tableExit).toBe(EXIT_CODES.environmentFailed);
    expect(tableRun.stdout()).not.toMatch(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u,
    );
    expect(tableRun.stdout()).not.toContain('\u001b');
    expect(tableRun.stdout().split('\n').filter((line) => (
      line.includes('ERROR forged') || line.includes('STATUS forged')
    ))).toHaveLength(1);
    expect(jsonExit).toBe(EXIT_CODES.environmentFailed);
    expect(json.checks[0]).toMatchObject({
      id: injectedId,
      message: injectedMessage,
    });
    expect(json.fonts[0]?.path).toBe(result.fonts[0]?.path);
  });

  it('sanitizes unexpected preflight exceptions deterministically', async () => {
    const first = fixture();
    const second = fixture();
    const sensitiveError = Object.assign(
      new Error('token=super-secret path=/private/authority-root'),
      {authority: {canonicalRoot: '/private/authority-root'}},
    );
    first.dependencies.preflight = vi.fn(async () => { throw sensitiveError; });
    second.dependencies.preflight = vi.fn(async () => { throw sensitiveError; });

    const firstExitCode = await runVideoctl(
      ['doctor', 'demo', '--json'],
      first.dependencies,
    );
    const secondExitCode = await runVideoctl(
      ['doctor', 'demo', '--json'],
      second.dependencies,
    );

    expect(firstExitCode).toBe(EXIT_CODES.environmentFailed);
    expect(secondExitCode).toBe(EXIT_CODES.environmentFailed);
    expect(first.stdout()).toBe(second.stdout());
    expect(first.stdout()).not.toContain('super-secret');
    expect(first.stdout()).not.toContain('/private/authority-root');
    expect(JSON.parse(first.stdout())).toMatchObject({
      ok: false,
      checks: [{
        id: 'doctor',
        severity: 'error',
        code: 'ENV_PREFLIGHT_FAILED',
        message: 'Preflight failed unexpectedly.',
      }],
      toolIdentities: {ffmpeg: null, qtFaststart: null},
      environmentFingerprint: null,
    });
  });

  it('reports project loading failures without leaking exception details', async () => {
    const {dependencies, stdout, stderr} = fixture();
    dependencies.loadProject = vi.fn(async () => {
      throw new Error('secret workspace authority /private/projects');
    });

    const exitCode = await runVideoctl(['doctor', 'demo'], dependencies);

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(stdout()).toBe('');
    expect(stderr()).toBe('Unable to load project "demo".\n');
    expect(stderr()).not.toContain('/private/projects');
  });

  it('prints structured JSON when project loading or validation fails', async () => {
    const {dependencies, stdout, stderr} = fixture();
    dependencies.loadProject = vi.fn(async () => {
      throw new Error('secret workspace authority /private/projects');
    });

    const exitCode = await runVideoctl(
      ['doctor', 'demo', '--json'],
      dependencies,
    );
    const report = JSON.parse(stdout()) as {
      command: string;
      project: string;
      ok: boolean;
      checks: Array<{
        id: string;
        severity: string;
        code: string;
        message: string;
      }>;
    };

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(report).toMatchObject({
      command: 'doctor',
      project: 'demo',
      ok: false,
      checks: [{
        id: 'project-load',
        severity: 'error',
        code: 'PROJECT_LOAD_FAILED',
        message: 'Unable to load or validate project.',
      }],
    });
    expect(stdout()).not.toContain('/private/projects');
    expect(stderr()).toBe('');
  });
});
