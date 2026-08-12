import {pathToFileURL} from 'node:url';
import {Command, CommanderError, Option} from 'commander';
import {loadProject} from '../domain/load-project';
import {
  buildCleanupPlan,
  executeCleanupPlan,
} from '../pipeline/cleanup';
import {
  buildExecutionPlan,
  type ExecutionPlanRequest,
} from '../pipeline/execution-plan';
import {acquireProjectLock} from '../pipeline/project-lock';
import {
  createOutputStore,
  createRunStore,
  type PipelinePreset,
  type StageId,
} from '../pipeline/run-store';
import {
  createRunId,
  runExecutionPlan,
} from '../pipeline/runner';
import {installPipelineSignalHandlers} from '../pipeline/signals';
import {
  createSystemSourceCatalogDependencies,
  discoverProjectSourceCatalog,
  type SourceCatalogDependencies,
} from '../pipeline/source-assets';
import {MVP_STAGES} from '../pipeline/stage-registry';
import {createStageReportStore} from '../pipeline/stage-report';
import {runCleanCommand} from './commands/clean';
import {
  executePipelineCommand,
  runPipelineCommand,
  type PipelineCommandDependencies,
  type PipelineCommandOptions,
} from './commands/pipeline';
import {runReportCommand, type ReportCommandOptions} from './commands/report';
import {runReviewCommand, type ReviewCommandOptions} from './commands/review';
import {EXIT_CODES} from './exit-codes';
import {
  formatDoctorFailure,
  formatDoctorJson,
  formatDoctorTable,
  sanitizeTerminalText,
} from './output';

export interface OutputWriter {
  write(chunk: string): unknown;
}

export interface VideoctlDependencies extends PipelineCommandDependencies {
  buildCleanupPlan?: typeof buildCleanupPlan;
  executeCleanupPlan?: typeof executeCleanupPlan;
}

interface DoctorOptions {
  json?: boolean;
}

const runDoctor = async (
  projectId: string,
  options: DoctorOptions,
  dependencies: VideoctlDependencies,
): Promise<number> => {
  const outcome = await executePipelineCommand(
    projectId,
    {preset: 'release', to: 'preflight'},
    dependencies,
  );
  if (outcome.kind === 'result' && outcome.result.preflight !== undefined) {
    dependencies.stdout.write(options.json === true
      ? formatDoctorJson(projectId, outcome.result.preflight)
      : formatDoctorTable(projectId, outcome.result.preflight));
    return outcome.exitCode;
  }
  if (outcome.kind === 'failure' && outcome.failure.code === 'PROJECT_LOAD_FAILED') {
    if (options.json === true) {
      dependencies.stdout.write(formatDoctorFailure(projectId, true, {
        id: 'project-load',
        code: 'PROJECT_LOAD_FAILED',
        message: 'Unable to load or validate project.',
      }));
    } else {
      dependencies.stderr.write(
        `Unable to load project "${sanitizeTerminalText(projectId)}".\n`,
      );
    }
    return outcome.exitCode;
  }
  if (
    outcome.kind === 'failure'
    && outcome.failure.code === 'PROJECT_SOURCE_INVALID'
  ) {
    dependencies.stdout.write(formatDoctorFailure(
      projectId,
      options.json === true,
      {
        id: 'source-assets',
        code: 'PROJECT_SOURCE_INVALID',
        message: 'Project source assets could not be measured safely.',
      },
    ));
    return outcome.exitCode;
  }
  dependencies.stdout.write(formatDoctorFailure(projectId, options.json === true));
  return outcome.kind === 'failure'
    ? outcome.exitCode
    : EXIT_CODES.environmentFailed;
};

const pipelineOptions = (options: PipelineCommandOptions): PipelineCommandOptions => ({
  ...(options.preset === undefined ? {} : {preset: options.preset}),
  ...(options.plan === undefined ? {} : {plan: options.plan}),
  ...(options.from === undefined ? {} : {from: options.from}),
  ...(options.to === undefined ? {} : {to: options.to}),
  ...(options.resume === undefined ? {} : {resume: options.resume}),
  ...(options.force === undefined ? {} : {force: options.force}),
  ...(options.json === undefined ? {} : {json: options.json}),
});

export async function runVideoctl(
  argv: readonly string[],
  dependencies: VideoctlDependencies,
): Promise<number> {
  let exitCode: number = EXIT_CODES.success;
  const command = new Command();
  command
    .name('videoctl')
    .exitOverride()
    .configureOutput({
      writeOut: (value) => { dependencies.stdout.write(value); },
      writeErr: (value) => { dependencies.stderr.write(value); },
    });

  command
    .command('doctor')
    .description('Check the local video pipeline environment')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: DoctorOptions) => {
      exitCode = await runDoctor(project, options, dependencies);
    });
  command
    .command('ingest')
    .description('Ingest project source assets')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {json?: boolean}) => {
      exitCode = await runPipelineCommand(project, {
        preset: 'assets',
        to: 'ingest',
        ...(options.json === undefined ? {} : {json: options.json}),
      }, dependencies);
    });
  command
    .command('run')
    .description('Run the one-path draft pipeline')
    .argument('<project>')
    .addOption(new Option('--to <stage>').choices(['narration']).makeOptionMandatory())
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {to: 'narration'; json?: boolean}) => {
      exitCode = await runPipelineCommand(project, {
        preset: 'draft',
        to: options.to,
        ...(options.json === undefined ? {} : {json: options.json}),
      }, dependencies);
    });
  command
    .command('compile')
    .description('Compile project media')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {json?: boolean}) => {
      exitCode = await runPipelineCommand(project, {
        preset: 'draft',
        to: 'compile',
        ...(options.json === undefined ? {} : {json: options.json}),
      }, dependencies);
    });
  command
    .command('pipeline')
    .description('Plan or execute a pipeline range')
    .argument('<project>')
    .addOption(new Option('--preset <preset>').choices(['assets', 'draft', 'release']))
    .option('--plan', 'print the execution plan without running')
    .option('--from <stage>', 'start at a stable Stage ID')
    .option('--to <stage>', 'stop at a stable Stage ID')
    .option('--resume', 'resume the current Run')
    .option('--force <stage>', 'force a Stage inside the selected range')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: PipelineCommandOptions) => {
      exitCode = await runPipelineCommand(
        project,
        pipelineOptions(options),
        dependencies,
      );
    });
  command
    .command('review')
    .description('Approve or reject the current draft review')
    .argument('<project>')
    .option('--approve', 'approve the current draft')
    .option('--reject', 'reject the current draft')
    .requiredOption('--reason <text>', 'review reason')
    .action(async (project: string, options: ReviewCommandOptions) => {
      exitCode = await runReviewCommand(project, options, dependencies);
    });
  command
    .command('release')
    .description('Run the complete release pipeline')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {json?: boolean}) => {
      exitCode = await runPipelineCommand(project, {
        preset: 'release',
        ...(options.json === undefined ? {} : {json: options.json}),
      }, dependencies);
    });
  command
    .command('report')
    .description('Read the current pipeline report')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: ReportCommandOptions) => {
      exitCode = await runReportCommand(project, options, dependencies);
    });
  command
    .command('clean')
    .description('Remove non-current pipeline Runs and Releases')
    .argument('<project>')
    .action(async (project: string) => {
      exitCode = await runCleanCommand(project, {
        workspaceRoot: dependencies.workspaceRoot,
        stdout: dependencies.stdout,
        stderr: dependencies.stderr,
        buildCleanupPlan: dependencies.buildCleanupPlan ?? buildCleanupPlan,
        executeCleanupPlan: dependencies.executeCleanupPlan ?? executeCleanupPlan,
      });
    });

  try {
    await command.parseAsync([...argv], {from: 'user'});
    return exitCode;
  } catch (error) {
    if (
      error instanceof CommanderError
      && error.code === 'commander.helpDisplayed'
    ) {
      return EXIT_CODES.success;
    }
    return EXIT_CODES.validationFailed;
  }
}

export interface SystemVideoctlOptions {
  sourceCatalog?: SourceCatalogDependencies;
}

export const createSystemVideoctlDependencies = (
  options: SystemVideoctlOptions = {},
): VideoctlDependencies => {
  const workspaceRoot = process.cwd();
  const sourceCatalogDependencies = options.sourceCatalog
    ?? createSystemSourceCatalogDependencies();
  const runStore = createRunStore(workspaceRoot);
  const outputStore = createOutputStore(workspaceRoot);
  const reportStore = createStageReportStore();
  const buildPlan = async (
    project: Awaited<ReturnType<typeof loadProject>>,
    sourceCatalog: Awaited<ReturnType<typeof discoverProjectSourceCatalog>>,
    request: ExecutionPlanRequest,
  ) => await buildExecutionPlan({
    project,
    sourceCatalog,
    registry: MVP_STAGES,
    runStore,
    outputStore,
    reportStore,
    createRunId,
  }, request);
  return {
    workspaceRoot,
    stdout: process.stdout,
    stderr: process.stderr,
    loadProject,
    discoverProjectSourceCatalog: async (project) => (
      await discoverProjectSourceCatalog(project, sourceCatalogDependencies)
    ),
    buildExecutionPlan: buildPlan,
    runExecutionPlan: async (input) => await runExecutionPlan(input, {
      registry: MVP_STAGES,
      runStore,
      outputStore,
      reportStore,
      acquireProjectLock,
      createRunId,
      now: () => new Date().toISOString(),
    }),
    installPipelineSignalHandlers,
    buildCleanupPlan,
    executeCleanupPlan,
  };
};

const directlyExecuted = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (directlyExecuted) {
  void runVideoctl(
    process.argv.slice(2),
    createSystemVideoctlDependencies(),
  ).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write('videoctl failed unexpectedly.\n');
      process.exitCode = EXIT_CODES.environmentFailed;
    },
  );
}
