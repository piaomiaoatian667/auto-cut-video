import {describe, expect, it} from 'vitest';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {
  PipelineRuntimeError,
  normalizePipelineError,
} from '../../../src/pipeline/runtime-errors';

describe('Pipeline runtime errors', () => {
  it('exports the exact pipeline exit-code contract', () => {
    expect(EXIT_CODES).toEqual({
      success: 0,
      needsReview: 2,
      validationFailed: 3,
      environmentFailed: 4,
      cancelled: 130,
      terminated: 143,
    });
  });

  it.each([
    [{code: 'ENOSPC'}, 'DISK_SPACE_EXHAUSTED'],
    [{code: 'PROCESS_ABORTED'}, 'PIPELINE_CANCELLED'],
    [{code: 'ENV_TOOL_MISSING'}, 'ENV_TOOL_MISSING'],
  ] as const)('normalizes %o to %s', (error, code) => {
    expect(normalizePipelineError(error)).toMatchObject({code});
  });

  it('normalizes unknown failures to a stable stage failure', () => {
    expect(normalizePipelineError(new Error('unexpected'), 'draft')).toMatchObject({
      name: 'PipelineRuntimeError',
      code: 'PIPELINE_STAGE_FAILED',
      stageId: 'draft',
      message: 'PIPELINE_STAGE_FAILED: Pipeline stage draft failed.',
    });
  });

  it.each([
    [
      new AggregateError(
        [new Error('cleanup failed')],
        'rollback failed',
        {cause: {code: 'ENOSPC'}},
      ),
      'DISK_SPACE_EXHAUSTED',
    ],
    [Object.assign(new Error('aborted'), {name: 'AbortError'}), 'PIPELINE_CANCELLED'],
  ] as const)('preserves the primary mapped failure through wrappers', (error, code) => {
    expect(normalizePipelineError(error)).toMatchObject({code});
  });

  it('does not expose raw paths, environment values, or process output', () => {
    const sensitive = new Error([
      'command failed at /Users/example/private/project.mov',
      'API_TOKEN=super-secret',
      'stdout: customer footage contents',
    ].join('\n'));
    const normalized = normalizePipelineError(sensitive, 'release');

    expect(normalized.message).toBe(
      'PIPELINE_STAGE_FAILED: Pipeline stage release failed.',
    );
    expect(normalized.message).not.toContain('/Users/example');
    expect(normalized.message).not.toContain('super-secret');
    expect(normalized.message).not.toContain('customer footage');
    expect(normalized.cause).toBe(sensitive);
  });

  it('uses sanitized messages for mapped and trusted codes', () => {
    expect(normalizePipelineError({
      code: 'ENOSPC',
      message: 'no space at /private/work',
    }).message).toBe(
      'DISK_SPACE_EXHAUSTED: Pipeline storage is exhausted.',
    );
    expect(normalizePipelineError({
      code: 'PROCESS_ABORTED',
      message: 'aborted while running /usr/local/bin/ffmpeg',
    }).message).toBe(
      'PIPELINE_CANCELLED: Pipeline execution was cancelled.',
    );
    expect(normalizePipelineError({
      code: 'ENV_TOOL_MISSING',
      message: 'missing /private/bin/ffmpeg',
    }).message).toBe(
      'ENV_TOOL_MISSING: Pipeline operation failed.',
    );
  });

  it('rejects untrusted code strings and keeps normalization idempotent', () => {
    const normalized = normalizePipelineError({
      code: 'not-safe:/private/path',
      message: 'secret',
    }, 'ingest');

    expect(normalized.code).toBe('PIPELINE_STAGE_FAILED');
    expect(normalizePipelineError(normalized)).toBe(normalized);
  });

  it('constructs the stable public error shape', () => {
    const cause = new Error('private detail');
    const error = new PipelineRuntimeError(
      'PIPELINE_CLEANUP_FAILED',
      'Pipeline cleanup failed.',
      'compile',
      {cause},
    );

    expect(error).toMatchObject({
      name: 'PipelineRuntimeError',
      code: 'PIPELINE_CLEANUP_FAILED',
      stageId: 'compile',
      message: 'PIPELINE_CLEANUP_FAILED: Pipeline cleanup failed.',
      cause,
    });
  });
});
