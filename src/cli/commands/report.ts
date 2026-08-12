import {
  listRunDirectory,
  type CurrentPointer,
  type RunDirectoryScope,
  type ScopedDirectoryEntry,
} from '../../fs/app-directory-scopes';
import {
  createRunStore,
  type RunStore,
  type StageId,
} from '../../pipeline/run-store';
import {MVP_STAGES} from '../../pipeline/stage-registry';
import {
  createStageReportStore,
  StageReportSchema,
  type StageReport,
  type StageReportStore,
} from '../../pipeline/stage-report';
import {readRunJson} from '../../pipeline/stage-adapters/shared';
import {EXIT_CODES} from '../exit-codes';
import {
  formatPipelineFailure,
  formatPipelineReport,
} from '../output';
import type {OutputWriter} from '../videoctl';

export interface PipelineReport {
  projectId: string;
  current: CurrentPointer | null;
  stages: StageReport[];
  attempts: StageReport[];
}

export interface ReportCommandOptions {
  json?: boolean;
}

interface ReportRunStore {
  readCurrentReadonly: RunStore['readCurrentReadonly'];
  openExistingRun: RunStore['openExistingRun'];
}

interface ReportStageStore {
  readStage: StageReportStore['readStage'];
}

interface ReportRegistryStage {
  id: StageId;
}

export interface ReportCommandDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  runStore?: ReportRunStore;
  reportStore?: ReportStageStore;
  registry?: readonly ReportRegistryStage[];
  listRunDirectory?: (
    run: RunDirectoryScope,
    relativePath: string,
  ) => Promise<ScopedDirectoryEntry[]>;
  readAttemptReport?: (
    run: RunDirectoryScope,
    relativePath: string,
  ) => Promise<StageReport>;
}

const isMissingPath = (error: unknown): boolean => (
  error instanceof Error
  && 'code' in error
  && error.code === 'ENOENT'
);

const defaultReadAttemptReport = async (
  run: RunDirectoryScope,
  relativePath: string,
): Promise<StageReport> => await readRunJson(
  run,
  relativePath,
  (value) => StageReportSchema.parse(value),
);

const listAttemptEntries = async (
  run: RunDirectoryScope,
  list: NonNullable<ReportCommandDependencies['listRunDirectory']>,
): Promise<ScopedDirectoryEntry[]> => {
  try {
    return (await list(run, 'reports/attempts'))
      .filter((entry) => entry.kind === 'file' && entry.name.endsWith('.json'))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (isMissingPath(error)) return [];
    throw error;
  }
};

export async function readPipelineReport(
  projectId: string,
  dependencies: ReportCommandDependencies,
): Promise<PipelineReport> {
  const runStore = dependencies.runStore ?? createRunStore(dependencies.workspaceRoot);
  const reportStore = dependencies.reportStore ?? createStageReportStore();
  const registry = dependencies.registry ?? MVP_STAGES;
  const current = await runStore.readCurrentReadonly(projectId);
  if (current === null) {
    return {projectId, current: null, stages: [], attempts: []};
  }

  const run = await runStore.openExistingRun(projectId, current.runId);
  const stages: StageReport[] = [];
  for (const stage of registry) {
    const report = await reportStore.readStage(run, stage.id);
    if (report !== null) {
      if (report.projectId !== projectId || report.runId !== current.runId) {
        throw new TypeError('Canonical report identity does not match current Run');
      }
      stages.push(report);
    }
  }

  const list = dependencies.listRunDirectory ?? listRunDirectory;
  const readAttempt = dependencies.readAttemptReport ?? defaultReadAttemptReport;
  const attemptEntries = await listAttemptEntries(run, list);
  const attempts: StageReport[] = [];
  for (const stage of registry) {
    const stageAttempts: Array<{name: string; report: StageReport}> = [];
    for (const entry of attemptEntries.filter((candidate) => (
      candidate.name.startsWith(`${stage.id}-`)
    ))) {
      const report = await readAttempt(run, `reports/attempts/${entry.name}`);
      if (
        report.projectId !== projectId
        || report.runId !== current.runId
        || report.stageId !== stage.id
      ) {
        throw new TypeError('Attempt report identity does not match current Run');
      }
      stageAttempts.push({name: entry.name, report});
    }
    stageAttempts.sort((left, right) => {
      const startedOrder = left.report.startedAt.localeCompare(right.report.startedAt);
      if (startedOrder !== 0) return startedOrder;
      return left.name.localeCompare(right.name);
    });
    attempts.push(...stageAttempts.map(({report}) => report));
  }

  return {projectId, current, stages, attempts};
}

export async function runReportCommand(
  projectId: string,
  options: ReportCommandOptions,
  dependencies: ReportCommandDependencies,
): Promise<number> {
  try {
    const report = await readPipelineReport(projectId, dependencies);
    dependencies.stdout.write(formatPipelineReport(report, options.json === true));
    return EXIT_CODES.success;
  } catch {
    const output = formatPipelineFailure({
      projectId,
      code: 'PIPELINE_REPORT_FAILED',
      message: 'Unable to read the pipeline report.',
    }, options.json === true);
    if (options.json === true) dependencies.stdout.write(output);
    else dependencies.stderr.write(output);
    return EXIT_CODES.environmentFailed;
  }
}
