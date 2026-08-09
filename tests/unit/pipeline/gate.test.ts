import {describe, expect, it} from 'vitest';
import {aggregateChecks} from '../../../src/pipeline/gate';
import type {CheckResult} from '../../../src/pipeline/types';

describe('aggregateChecks', () => {
  it('fails on any error', () => {
    const checks: CheckResult[] = [
      {
        id: 'black-frame',
        severity: 'warning',
        message: 'detected',
        requiresReview: true,
      },
      {id: 'decode', severity: 'error', message: 'failed'},
    ];

    expect(aggregateChecks(checks)).toBe('failed');
  });

  it('requires review for configured warnings', () => {
    expect(aggregateChecks([
      {
        id: 'black-frame',
        severity: 'warning',
        message: 'detected',
        requiresReview: true,
      },
    ])).toBe('needs_review');
  });

  it('passes warnings that do not require review', () => {
    expect(aggregateChecks([
      {
        id: 'optional-validator',
        severity: 'warning',
        message: 'not configured',
      },
    ])).toBe('passed');
  });

  it('passes informational and empty checks', () => {
    expect(aggregateChecks([
      {id: 'hash', severity: 'info', message: 'ok'},
    ])).toBe('passed');
    expect(aggregateChecks([])).toBe('passed');
  });
});
