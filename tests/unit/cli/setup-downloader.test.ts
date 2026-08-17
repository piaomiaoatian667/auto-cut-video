import {describe, expect, it, vi} from 'vitest';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  runVideoctl,
  type VideoctlDependencies,
} from '../../../src/cli/videoctl';
import {DownloadError} from '../../../src/download/errors';
import type {SetupDownloaderResult} from '../../../src/download/toolchain/types';

type SetupDownloaderImplementation = (
  signal?: AbortSignal,
) => Promise<SetupDownloaderResult>;

interface SetupVideoctlDependencies extends VideoctlDependencies {
  signal?: AbortSignal;
  setupDownloader(signal?: AbortSignal): Promise<SetupDownloaderResult>;
}

const result = (
  status: SetupDownloaderResult['status'] = 'installed',
): SetupDownloaderResult => ({status, version: '2026.07.04'});

const fixture = (
  implementation: SetupDownloaderImplementation = async () => result(),
  signal?: AbortSignal,
) => {
  let stdout = '';
  let stderr = '';
  const setupDownloader = vi.fn(implementation);
  const dependencies: SetupVideoctlDependencies = {
    workspaceRoot: '/workspace',
    stdout: {write: (chunk) => { stdout += chunk; }},
    stderr: {write: (chunk) => { stderr += chunk; }},
    loadProject: vi.fn(async () => { throw new Error('unused'); }),
    measureSourceBytes: vi.fn(async () => { throw new Error('unused'); }),
    preflight: vi.fn(async () => { throw new Error('unused'); }),
    download: vi.fn(async () => { throw new Error('unused'); }),
    setupDownloader,
    ...(signal === undefined ? {} : {signal}),
  };
  return {
    dependencies,
    setupDownloader,
    stdout: () => stdout,
    stderr: () => stderr,
  };
};

const stableFailureMessage =
  'The managed downloader failed integrity or capability checks.';
const parseFailureMessage = 'The setup-downloader command input is invalid.';

describe('videoctl setup-downloader', () => {
  it('installs the pinned downloader and prints stable human output', async () => {
    const run = fixture();

    const exitCode = await runVideoctl(
      ['setup-downloader'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.setupDownloader).toHaveBeenCalledOnce();
    expect(run.setupDownloader).toHaveBeenCalledWith(undefined);
    expect(run.stdout()).toBe('Downloader installed: 2026.07.04\n');
    expect(run.stderr()).toBe('');
  });

  it('prints one exact JSON document when the downloader is already present', async () => {
    const run = fixture(async () => result('already-present'));
    const expected = {
      command: 'setup-downloader',
      ok: true,
      status: 'already-present',
      version: '2026.07.04',
    };

    const exitCode = await runVideoctl(
      ['setup-downloader', '--json'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
  });

  it('prints controlled invalid-toolchain failures only on stderr', async () => {
    const childDiagnostics =
      '/Users/private/Library/Caches/auto-cut-video/downloader stderr token=secret';
    const run = fixture(async () => {
      throw new DownloadError(
        'DOWNLOAD_TOOLCHAIN_INVALID',
        stableFailureMessage,
        {cause: new Error(childDiagnostics)},
      );
    });

    const exitCode = await runVideoctl(
      ['setup-downloader'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      `setup-downloader failed [DOWNLOAD_TOOLCHAIN_INVALID]: ${stableFailureMessage}\n`,
    );
    expect(run.stderr()).not.toContain('/Users/private/Library/Caches');
    expect(run.stderr()).not.toContain('token=secret');
    expect(run.stderr()).not.toContain(childDiagnostics);
  });

  it('prints one controlled JSON failure without raw diagnostics', async () => {
    const rawDiagnostics =
      'child exited 1 at /Users/private/.cache/downloader token=secret';
    const run = fixture(async () => { throw new Error(rawDiagnostics); });
    const expected = {
      command: 'setup-downloader',
      ok: false,
      code: 'DOWNLOAD_TOOLCHAIN_INVALID',
      message: stableFailureMessage,
    };

    const exitCode = await runVideoctl(
      ['setup-downloader', '--json'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.environmentFailed);
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
    expect(run.stdout()).not.toContain('/Users/private/.cache');
    expect(run.stdout()).not.toContain('token=secret');
    expect(run.stdout()).not.toContain(rawDiagnostics);
  });

  it('forwards the shared signal and returns cancelled after abort', async () => {
    const controller = new AbortController();
    const run = fixture(async (signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort(new Error('child diagnostics token=secret'));
      throw new DownloadError(
        'DOWNLOAD_TOOLCHAIN_INVALID',
        stableFailureMessage,
      );
    }, controller.signal);

    const exitCode = await runVideoctl(
      ['setup-downloader'],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.cancelled);
    expect(run.setupDownloader).toHaveBeenCalledWith(controller.signal);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      `setup-downloader failed [DOWNLOAD_TOOLCHAIN_INVALID]: ${stableFailureMessage}\n`,
    );
    expect(run.stderr()).not.toContain('child diagnostics');
    expect(run.stderr()).not.toContain('token=secret');
  });

  it('sanitizes JSON parser failure without invoking the installer', async () => {
    const run = fixture();
    const cacheOption = '--cache=/Users/private/.cache/downloader?token=secret';
    const expected = {
      command: 'setup-downloader',
      ok: false,
      code: 'DOWNLOAD_TOOLCHAIN_INVALID',
      message: parseFailureMessage,
    };

    const exitCode = await runVideoctl(
      ['setup-downloader', '--json', cacheOption],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.setupDownloader).not.toHaveBeenCalled();
    expect(run.stdout()).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(run.stdout())).toEqual(expected);
    expect(run.stderr()).toBe('');
    expect(run.stdout()).not.toContain(cacheOption);
    expect(run.stdout()).not.toContain('/Users/private/.cache');
    expect(run.stdout()).not.toContain('token=secret');
  });

  it('sanitizes excess arguments on the human error channel', async () => {
    const run = fixture();
    const diagnostics = '/Users/private/.cache/downloader/child-stderr';

    const exitCode = await runVideoctl(
      ['setup-downloader', diagnostics],
      run.dependencies,
    );

    expect(exitCode).toBe(EXIT_CODES.validationFailed);
    expect(run.setupDownloader).not.toHaveBeenCalled();
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      `setup-downloader failed [DOWNLOAD_TOOLCHAIN_INVALID]: ${parseFailureMessage}\n`,
    );
    expect(run.stderr()).not.toContain(diagnostics);
    expect(run.stderr()).not.toContain('/Users/private/.cache');
    expect(run.stderr()).not.toContain('too many arguments');
  });
});
