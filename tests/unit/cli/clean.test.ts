import {describe, expect, it, vi} from 'vitest';
import type {CleanupPlan, CleanupResult} from '../../../src/pipeline/cleanup';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  runCleanCommand,
  type CleanCommandDependencies,
} from '../../../src/cli/commands/clean';

describe('videoctl clean', () => {
  it('builds and executes the Task 9 cleanup plan once and prints removed IDs', async () => {
    let stdout = '';
    let stderr = '';
    const plan: CleanupPlan = {
      projectId: 'demo',
      protectedRunId: 'run-current',
      protectedReleaseId: 'release-current',
      runDirectories: ['run-old-b', 'run-old-a'],
      releaseDirectories: ['release-old'],
    };
    const result: CleanupResult = {
      removedRuns: ['run-old-a', 'run-old-b'],
      removedReleases: ['release-old'],
    };
    const buildCleanupPlan = vi.fn(async () => plan);
    const executeCleanupPlan = vi.fn(async () => result);
    const dependencies: CleanCommandDependencies = {
      workspaceRoot: '/workspace',
      stdout: {write: (chunk) => { stdout += chunk; }},
      stderr: {write: (chunk) => { stderr += chunk; }},
      buildCleanupPlan,
      executeCleanupPlan,
    };

    const exitCode = await runCleanCommand('demo', dependencies);

    expect(exitCode).toBe(EXIT_CODES.success);
    expect(buildCleanupPlan).toHaveBeenCalledOnce();
    expect(buildCleanupPlan).toHaveBeenCalledWith({
      workspaceRoot: '/workspace',
      projectId: 'demo',
    });
    expect(executeCleanupPlan).toHaveBeenCalledOnce();
    expect(executeCleanupPlan).toHaveBeenCalledWith(plan);
    expect(stdout).toBe([
      'Removed Runs:',
      '- run-old-a',
      '- run-old-b',
      'Removed Releases:',
      '- release-old',
      '',
    ].join('\n'));
    expect(stderr).toBe('');
  });
});
