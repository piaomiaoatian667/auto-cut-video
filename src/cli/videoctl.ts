import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {lstat, readdir} from 'node:fs/promises';
import {Command, CommanderError} from 'commander';
import {
  loadProject,
  type ProjectInputs,
} from '../domain/load-project';
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

export interface OutputWriter {
  write(chunk: string): unknown;
}

export interface VideoctlDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  loadProject(workspaceRoot: string, projectId: string): Promise<ProjectInputs>;
  measureSourceBytes(project: ProjectInputs): Promise<number>;
  preflight(input: PreflightInput): Promise<PreflightResult>;
  ffmpegExecutable?: string;
  ffprobeExecutable?: string;
}

interface DoctorOptions {
  json?: boolean;
}

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error;

const measureDirectoryBytes = async (
  directory: string,
  missingIsEmpty: boolean,
): Promise<number> => {
  let directoryStatus;
  try {
    directoryStatus = await lstat(directory);
  } catch (error) {
    if (missingIsEmpty && isNodeError(error) && error.code === 'ENOENT') return 0;
    throw error;
  }
  if (!directoryStatus.isDirectory() || directoryStatus.isSymbolicLink()) {
    throw new Error('source path is not a regular directory');
  }

  const entries = await readdir(directory);
  entries.sort((left, right) => left.localeCompare(right));
  let totalBytes = 0;
  for (const entry of entries) {
    const candidate = path.join(directory, entry);
    const status = await lstat(candidate);
    if (status.isSymbolicLink()) {
      throw new Error('source directory contains a symbolic link');
    }
    if (status.isDirectory()) {
      totalBytes += await measureDirectoryBytes(candidate, false);
    } else if (status.isFile()) {
      totalBytes += status.size;
    } else {
      throw new Error('source directory contains an unsupported file type');
    }
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error('source byte count exceeds the safe integer range');
    }
  }
  return totalBytes;
};

const measureProjectSourceBytes = async (
  project: ProjectInputs,
): Promise<number> => measureDirectoryBytes(path.join(
  project.workspaceRoot,
  'projects',
  project.project.id,
  'assets',
  'source',
), true);

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
    dependencies.stderr.write(`Unable to load project "${projectId}".\n`);
    return EXIT_CODES.validationFailed;
  }

  try {
    const sourceBytes = await dependencies.measureSourceBytes(project);
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

export const createSystemVideoctlDependencies = (): VideoctlDependencies => {
  const preflightDependencies = createSystemPreflightDependencies();
  const ffmpegExecutable = process.env.FFMPEG_PATH;
  const ffprobeExecutable = process.env.FFPROBE_PATH;
  return {
    workspaceRoot: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    loadProject,
    measureSourceBytes: measureProjectSourceBytes,
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
