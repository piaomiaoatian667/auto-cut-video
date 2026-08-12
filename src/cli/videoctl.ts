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
import {PIPELINE_PRESET_IDS} from '../pipeline/presets';
import {
  createMvpStageRegistry,
  MVP_STAGES,
} from '../pipeline/stage-registry';
import {createStageReportStore} from '../pipeline/stage-report';
import {
  createTtsProvider,
  type MockTtsInvocationHook,
} from '../providers/tts';
import {runCleanCommand} from './commands/clean';
import {
  executePipelineCommand,
  runPipelineCommand,
  type PipelineCommandDependencies,
  type PipelineCommandOptions,
} from './commands/pipeline';
import {runReportCommand, type ReportCommandOptions} from './commands/report';
import {
  ReviewApprovalOutcomeError,
  runReviewCommand,
  type ReviewCommandOptions,
} from './commands/review';
import {EXIT_CODES} from './exit-codes';
import {
  formatDoctorFailure,
  formatDoctorJson,
  formatDoctorTable,
  formatPipelineFailure,
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

interface RawPipelineCommandOptions {
  preset?: string;
  plan?: boolean;
  from?: string;
  to?: string;
  resume?: boolean;
  force?: string;
  json?: boolean;
}

const PRESET_IDS: readonly PipelinePreset[] = PIPELINE_PRESET_IDS;
const STAGE_IDS: readonly StageId[] = Object.freeze(
  MVP_STAGES.map((stage) => stage.id),
);

const invalidCliArgument = (): never => {
  throw new CommanderError(
    EXIT_CODES.validationFailed,
    'commander.invalidArgument',
    'Invalid command-line arguments.',
  );
};

const parsePreset = (value: string | undefined): PipelinePreset | undefined => {
  if (value === undefined) return undefined;
  if (!PRESET_IDS.includes(value as PipelinePreset)) return invalidCliArgument();
  return value as PipelinePreset;
};

const parseStage = (value: string | undefined): StageId | undefined => {
  if (value === undefined) return undefined;
  if (!STAGE_IDS.includes(value as StageId)) return invalidCliArgument();
  return value as StageId;
};

const pipelineOptions = (
  options: RawPipelineCommandOptions,
): PipelineCommandOptions => ({
  ...(options.preset === undefined ? {} : {preset: parsePreset(options.preset)!}),
  ...(options.plan === undefined ? {} : {plan: options.plan}),
  ...(options.from === undefined ? {} : {from: parseStage(options.from)!}),
  ...(options.to === undefined ? {} : {to: parseStage(options.to)!}),
  ...(options.resume === undefined ? {} : {resume: options.resume}),
  ...(options.force === undefined ? {} : {force: parseStage(options.force)!}),
  ...(options.json === undefined ? {} : {json: options.json}),
});

interface CommandFailureContext {
  projectId: string;
  json: boolean;
}

const commandFailureContext = (command: Command): CommandFailureContext => {
  const processedProject = command.processedArgs[0];
  const rawProject = command.args.find((argument) => !argument.startsWith('-'));
  const projectId = typeof processedProject === 'string'
    ? processedProject
    : (rawProject ?? 'unknown');
  return {
    projectId,
    json: command.opts<{json?: unknown}>().json === true,
  };
};

const writeCommandFailure = (
  context: CommandFailureContext,
  writers: Pick<VideoctlDependencies, 'stdout' | 'stderr'>,
  code: string,
  message: string,
): void => {
  const formatted = formatPipelineFailure({
    projectId: context.projectId,
    code,
    message,
  }, context.json);
  if (context.json) writers.stdout.write(formatted);
  else writers.stderr.write(formatted);
};

const isReviewApprovalOutcomeUnknown = (error: unknown): boolean => (
  error instanceof ReviewApprovalOutcomeError
  || (
    error instanceof Error
    && 'code' in error
    && error.code === 'REVIEW_APPROVAL_OUTCOME_UNKNOWN'
  )
);

type VideoctlDependenciesLoader = () => (
  VideoctlDependencies | Promise<VideoctlDependencies>
);

const runVideoctlWithLoader = async (
  argv: readonly string[],
  loadDependencies: VideoctlDependenciesLoader,
  writers: Pick<VideoctlDependencies, 'stdout' | 'stderr'>,
): Promise<number> => {
  let exitCode: number = EXIT_CODES.success;
  let dependenciesPromise: Promise<VideoctlDependencies> | undefined;
  const resolveDependencies = (): Promise<VideoctlDependencies> => {
    dependenciesPromise ??= Promise.resolve().then(loadDependencies);
    return dependenciesPromise;
  };
  const command = new Command();
  let activeCommand = command;
  command
    .name('videoctl')
    .exitOverride()
    .hook('preSubcommand', (_root, subcommand) => {
      activeCommand = subcommand;
    })
    .configureOutput({
      writeOut: (value) => { writers.stdout.write(value); },
      writeErr: () => undefined,
    });

  command
    .command('doctor')
    .description('Check the local video pipeline environment')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: DoctorOptions) => {
      const dependencies = await resolveDependencies();
      exitCode = await runDoctor(project, options, dependencies);
    });
  command
    .command('ingest')
    .description('Ingest project source assets')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {json?: boolean}) => {
      const dependencies = await resolveDependencies();
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
    .addOption(new Option('--to <stage>').makeOptionMandatory())
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {to: string; json?: boolean}) => {
      if (options.to !== 'narration') invalidCliArgument();
      const dependencies = await resolveDependencies();
      exitCode = await runPipelineCommand(project, {
        preset: 'draft',
        to: 'narration',
        ...(options.json === undefined ? {} : {json: options.json}),
      }, dependencies);
    });
  command
    .command('compile')
    .description('Compile project media')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {json?: boolean}) => {
      const dependencies = await resolveDependencies();
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
    .addOption(new Option('--preset <preset>'))
    .option('--plan', 'print the execution plan without running')
    .addOption(new Option(
      '--from <stage>',
      'start at a stable Stage ID',
    ))
    .addOption(new Option(
      '--to <stage>',
      'stop at a stable Stage ID',
    ))
    .option('--resume', 'resume the current Run')
    .addOption(new Option(
      '--force <stage>',
      'force a Stage inside the selected range',
    ))
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: RawPipelineCommandOptions) => {
      const parsedOptions = pipelineOptions(options);
      const dependencies = await resolveDependencies();
      exitCode = await runPipelineCommand(
        project,
        parsedOptions,
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
      const dependencies = await resolveDependencies();
      exitCode = await runReviewCommand(project, options, dependencies);
    });
  command
    .command('release')
    .description('Run the complete release pipeline')
    .argument('<project>')
    .option('--json', 'print machine-readable JSON')
    .action(async (project: string, options: {json?: boolean}) => {
      const dependencies = await resolveDependencies();
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
      const dependencies = await resolveDependencies();
      exitCode = await runReportCommand(project, options, dependencies);
    });
  command
    .command('clean')
    .description('Remove non-current pipeline Runs and Releases')
    .argument('<project>')
    .action(async (project: string) => {
      const dependencies = await resolveDependencies();
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
    if (error instanceof CommanderError) {
      writeCommandFailure(
        commandFailureContext(activeCommand),
        writers,
        'CLI_ARGUMENT_INVALID',
        'Invalid command-line arguments.',
      );
      return EXIT_CODES.validationFailed;
    }
    if (isReviewApprovalOutcomeUnknown(error)) {
      writeCommandFailure(
        commandFailureContext(activeCommand),
        writers,
        'REVIEW_APPROVAL_OUTCOME_UNKNOWN',
        'Review approval outcome is unknown; inspect the current report before retrying.',
      );
      return EXIT_CODES.environmentFailed;
    }
    writeCommandFailure(
      commandFailureContext(activeCommand),
      writers,
      'PIPELINE_EXECUTION_FAILED',
      'Pipeline execution failed unexpectedly.',
    );
    return EXIT_CODES.environmentFailed;
  }
};

export async function runVideoctl(
  argv: readonly string[],
  dependencies: VideoctlDependencies,
): Promise<number> {
  return await runVideoctlWithLoader(argv, () => dependencies, dependencies);
}

export interface SystemVideoctlOptions {
  sourceCatalog?: SourceCatalogDependencies;
  workspaceRoot?: string;
  environment?: NodeJS.ProcessEnv;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
  onMockTtsInvocation?: MockTtsInvocationHook;
}

export const createSystemVideoctlDependencies = (
  options: SystemVideoctlOptions = {},
): VideoctlDependencies => {
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const environment = options.environment ?? process.env;
  const onMockTtsInvocation = options.onMockTtsInvocation;
  const sourceCatalogDependencies = options.sourceCatalog
    ?? createSystemSourceCatalogDependencies();
  const registry = createMvpStageRegistry({
    ...(environment.FFMPEG_PATH === undefined
      ? {}
      : {ffmpegExecutable: environment.FFMPEG_PATH}),
    ...(environment.FFPROBE_PATH === undefined
      ? {}
      : {ffprobeExecutable: environment.FFPROBE_PATH}),
    ...(onMockTtsInvocation === undefined
      ? {}
      : {
        narration: {
          createTtsProvider: (input) => createTtsProvider({
            ...input,
            onMockInvocation: onMockTtsInvocation,
          }),
        },
      }),
  });
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
    registry,
    runStore,
    outputStore,
    reportStore,
    createRunId,
  }, request);
  return {
    workspaceRoot,
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
    loadProject,
    discoverProjectSourceCatalog: async (project) => (
      await discoverProjectSourceCatalog(project, sourceCatalogDependencies)
    ),
    buildExecutionPlan: buildPlan,
    runExecutionPlan: async (input) => await runExecutionPlan(input, {
      registry,
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

export interface VideoctlMainOptions {
  createDependencies?: VideoctlDependenciesLoader;
  stdout?: OutputWriter;
  stderr?: OutputWriter;
}

export const runVideoctlMain = async (
  argv: readonly string[],
  options: VideoctlMainOptions = {},
): Promise<number> => {
  const writers = {
    stdout: options.stdout ?? process.stdout,
    stderr: options.stderr ?? process.stderr,
  };
  const loadDependencies = options.createDependencies ?? (() => (
    createSystemVideoctlDependencies({
      stdout: writers.stdout,
      stderr: writers.stderr,
    })
  ));
  return await runVideoctlWithLoader(argv, loadDependencies, writers);
};

const directlyExecuted = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (directlyExecuted) {
  void runVideoctlMain(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    () => {
      process.stderr.write(formatPipelineFailure({
        projectId: 'unknown',
        code: 'PIPELINE_EXECUTION_FAILED',
        message: 'Pipeline execution failed unexpectedly.',
      }, false));
      process.exitCode = EXIT_CODES.environmentFailed;
    },
  );
}
