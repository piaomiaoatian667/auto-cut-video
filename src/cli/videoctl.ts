import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {Command, CommanderError} from 'commander';
import {
  loadProject,
  type ProjectInputs,
} from '../domain/load-project';
import {
  createSystemSourceCatalogDependencies,
  discoverProjectSourceCatalog,
  type SourceCatalogDependencies,
} from '../pipeline/source-assets';
import {
  createSystemPreflightDependencies,
  runPreflight,
  type PreflightInput,
  type PreflightResult,
} from '../pipeline/stages/preflight';
import {aggregateChecks} from '../pipeline/gate';
import {EXIT_CODES} from './exit-codes';
import {
  formatDoctorFailure,
  formatDoctorJson,
  formatDoctorTable,
} from './output';
import {runReviewCommand, type ReviewCommandOptions} from './commands/review';

export interface OutputWriter {
  write(chunk: string): unknown;
}

export interface VideoctlDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  loadProject(workspaceRoot: string, projectId: string): Promise<ProjectInputs>;
  sourceCatalog: SourceCatalogDependencies;
  preflight(input: PreflightInput): Promise<PreflightResult>;
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
}

interface DoctorOptions {
  json?: boolean;
}

const doctorInput = (
  project: ProjectInputs,
  sourceBytes: number,
  dependencies: VideoctlDependencies,
): PreflightInput => ({
  workspaceRoot: project.workspaceRoot,
  projectDirectory: project.projectDirectory,
  project: project.project,
  script: project.script,
  sourceBytes,
  workDirectory: path.join(
    project.workspaceRoot,
    '.work',
    project.project.id,
  ),
  ...(dependencies.ffmpegExecutable === undefined
    ? {}
    : {ffmpegExecutable: dependencies.ffmpegExecutable}),
  ...(dependencies.ffprobeExecutable === undefined
    ? {}
    : {ffprobeExecutable: dependencies.ffprobeExecutable}),
});

const runDoctor = async (
  projectId: string,
  options: DoctorOptions,
  dependencies: VideoctlDependencies,
): Promise<number> => {
  let project: ProjectInputs;
  try {
    project = await dependencies.loadProject(
      dependencies.workspaceRoot,
      projectId,
    );
  } catch {
    if (options.json === true) {
      dependencies.stdout.write(formatDoctorFailure(projectId, true, {
        id: 'project-load',
        code: 'PROJECT_LOAD_FAILED',
        message: 'Unable to load or validate project.',
      }));
    } else {
      dependencies.stderr.write(`Unable to load project "${projectId}".\n`);
    }
    return EXIT_CODES.validationFailed;
  }

  let sourceBytes: number;
  try {
    sourceBytes = (
      await discoverProjectSourceCatalog(project, dependencies.sourceCatalog)
    ).totalBytes;
  } catch {
    dependencies.stdout.write(formatDoctorFailure(
      projectId,
      options.json === true,
      {
        id: 'source-assets',
        code: 'PROJECT_SOURCE_INVALID',
        message: 'Project source assets could not be measured safely.',
      },
    ));
    return EXIT_CODES.validationFailed;
  }

  try {
    const result = await dependencies.preflight(doctorInput(
      project,
      sourceBytes,
      dependencies,
    ));
    dependencies.stdout.write(options.json === true
      ? formatDoctorJson(projectId, result)
      : formatDoctorTable(projectId, result));
    return aggregateChecks(result.checks) === 'failed'
      ? EXIT_CODES.environmentFailed
      : EXIT_CODES.success;
  } catch {
    dependencies.stdout.write(formatDoctorFailure(projectId, options.json === true));
    return EXIT_CODES.environmentFailed;
  }
};

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
    .command('review')
    .description('Approve the current draft review for a project')
    .argument('<project>')
    .option('--approve', 'approve the current draft')
    .requiredOption('--reason <text>', 'approval reason')
    .option('--reviewer <name>', 'reviewer identity')
    .action(async (project: string, options: ReviewCommandOptions) => {
      exitCode = await runReviewCommand(project, options, dependencies);
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
  const preflightDependencies = createSystemPreflightDependencies();
  const sourceCatalog = options.sourceCatalog
    ?? createSystemSourceCatalogDependencies();
  const ffmpegExecutable = process.env.FFMPEG_PATH;
  const ffprobeExecutable = process.env.FFPROBE_PATH;
  return {
    workspaceRoot: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    loadProject,
    sourceCatalog,
    preflight: async (input) => runPreflight(input, preflightDependencies),
    ...(ffmpegExecutable === undefined ? {} : {ffmpegExecutable}),
    ...(ffprobeExecutable === undefined ? {} : {ffprobeExecutable}),
  };
};

const directlyExecuted = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (directlyExecuted) {
  void runVideoctl(
    process.argv.slice(2),
    createSystemVideoctlDependencies(),
  ).then(
    (exitCode) => { process.exitCode = exitCode; },
    () => {
      process.stderr.write('videoctl failed unexpectedly.\n');
      process.exitCode = EXIT_CODES.environmentFailed;
    },
  );
}
