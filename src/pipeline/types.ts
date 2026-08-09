export type StageState =
  | 'pending'
  | 'running'
  | 'cached'
  | 'skipped'
  | 'passed'
  | 'needs_review'
  | 'failed'
  | 'cancelled';

export type CheckSeverity = 'info' | 'warning' | 'error';

export interface CheckResult {
  id: string;
  severity: CheckSeverity;
  message: string;
  requiresReview?: boolean;
  value?: string | number | boolean;
  expected?: string | number | boolean;
  affectedPaths?: string[];
  suggestedAction?: string;
}
