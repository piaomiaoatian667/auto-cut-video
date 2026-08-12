import {
  buildCleanupPlan,
  executeCleanupPlan,
} from '../../pipeline/cleanup';
import {EXIT_CODES} from '../exit-codes';
import {
  formatCleanupResult,
  formatPipelineFailure,
} from '../output';
import type {OutputWriter} from '../videoctl';

export interface CleanCommandDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  buildCleanupPlan: typeof buildCleanupPlan;
  executeCleanupPlan: typeof executeCleanupPlan;
}

export async function runCleanCommand(
  projectId: string,
  dependencies: CleanCommandDependencies,
): Promise<number> {
  try {
    const plan = await dependencies.buildCleanupPlan({
      workspaceRoot: dependencies.workspaceRoot,
      projectId,
    });
    const result = await dependencies.executeCleanupPlan(plan);
    dependencies.stdout.write(formatCleanupResult(result, false));
    return EXIT_CODES.success;
  } catch {
    dependencies.stderr.write(formatPipelineFailure({
      projectId,
      code: 'PIPELINE_CLEANUP_FAILED',
      message: 'Pipeline cleanup failed.',
    }, false));
    return EXIT_CODES.environmentFailed;
  }
}
