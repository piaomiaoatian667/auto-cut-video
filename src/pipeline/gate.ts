import type {CheckResult, StageState} from './types';

type GateState = Extract<StageState, 'passed' | 'needs_review' | 'failed'>;

export const aggregateChecks = (
  checks: readonly CheckResult[],
): GateState => {
  if (checks.some((check) => check.severity === 'error')) {
    return 'failed';
  }
  if (checks.some((check) => (
    check.severity === 'warning' && check.requiresReview === true
  ))) {
    return 'needs_review';
  }
  return 'passed';
};
