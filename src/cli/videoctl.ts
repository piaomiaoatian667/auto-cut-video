import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {opendir} from 'node:fs/promises';
import {Command, CommanderError} from 'commander';
import {
  loadProject,
  type ProjectInputs,
} from '../domain/load-project';
import {
  openExistingProjectFile,
  type ProjectDirectoryScope,
} from '../fs/project-paths';
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

export interface SourceMeterStat {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface SourceMeterFileHandle {
  fd: number;
  stat(): Promise<SourceMeterStat>;
  close(): Promise<void>;
}

export interface SourceMeterDirectoryEntry {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface SourceMeterDirectory {
  read(): Promise<SourceMeterDirectoryEntry | null>;
  close(): Promise<void>;
}

export interface SourceMeterDependencies {
  openExistingProjectFile(
    scope: ProjectDirectoryScope,
    relativePath: string,
  ): Promise<SourceMeterFileHandle>;
  openDirectory(fdPath: string): Promise<SourceMeterDirectory>;
}

export class ProjectSourceMeasurementError extends Error {
  readonly code = 'PROJECT_SOURCE_INVALID';

  constructor(options?: ErrorOptions) {
    super('Project source assets could not be measured safely.', options);
    this.name = 'ProjectSourceMeasurementError';
  }
}

const invalidSource = (cause?: unknown): ProjectSourceMeasurementError =>
  new ProjectSourceMeasurementError(cause === undefined ? undefined : {cause});

const sameIdentity = (
  left: Pick<SourceMeterStat, 'dev' | 'ino' | 'nlink'>,
  right: Pick<SourceMeterStat, 'dev' | 'ino' | 'nlink'>,
): boolean => (
  left.dev === right.dev
  && left.ino === right.ino
  && left.nlink === right.nlink
);

const sameOpenedPath = (
  actual: SourceMeterStat,
  expected: SourceMeterStat,
): boolean => (
  sameIdentity(actual, expected)
  && actual.isFile() === expected.isFile()
  && actual.isDirectory() === expected.isDirectory()
  && (!expected.isFile() || actual.size === expected.size)
);

const validateDirectoryEntryName = (name: string): void => {
  if (
    name.length === 0
    || name === '.'
    || name === '..'
    || name.includes('/')
    || name.includes('\0')
  ) {
    throw invalidSource();
  }
};

const childRelativePath = (parent: string, name: string): string =>
  parent === '.' ? name : path.posix.join(parent, name);

type SourceMeterEntryKind = 'file' | 'directory';

const directoryEntryKind = (
  entry: SourceMeterDirectoryEntry,
): SourceMeterEntryKind => {
  if (entry.isSymbolicLink()) throw invalidSource();
  const isFile = entry.isFile();
  const isDirectory = entry.isDirectory();
  if (isFile === isDirectory) throw invalidSource();
  return isFile ? 'file' : 'directory';
};

const statusKind = (status: SourceMeterStat): SourceMeterEntryKind => {
  const isFile = status.isFile();
  const isDirectory = status.isDirectory();
  if (isFile === isDirectory) throw invalidSource();
  return isFile ? 'file' : 'directory';
};

const findDirectoryEntry = async (
  scope: ProjectDirectoryScope,
  parentRelativePath: string,
  expectedParent: SourceMeterStat,
  name: string,
  dependencies: SourceMeterDependencies,
): Promise<SourceMeterDirectoryEntry | undefined> => {
  let parent: SourceMeterFileHandle | undefined;
  let directory: SourceMeterDirectory | undefined;
  try {
    parent = await dependencies.openExistingProjectFile(
      scope,
      parentRelativePath,
    );
    const parentStatus = await parent.stat();
    if (!parentStatus.isDirectory() || !sameOpenedPath(parentStatus, expectedParent)) {
      throw invalidSource();
    }
    directory = await dependencies.openDirectory(`/dev/fd/${parent.fd}`);
    while (true) {
      const entry = await directory.read();
      if (entry === null) return undefined;
      validateDirectoryEntryName(entry.name);
      if (entry.name === name) return entry;
    }
  } finally {
    try {
      if (directory !== undefined) await directory.close();
    } finally {
      if (parent !== undefined) await parent.close();
    }
  }
};

const requireEntryKind = async (
  scope: ProjectDirectoryScope,
  parentRelativePath: string,
  expectedParent: SourceMeterStat,
  name: string,
  dependencies: SourceMeterDependencies,
): Promise<SourceMeterEntryKind> => {
  const entry = await findDirectoryEntry(
    scope,
    parentRelativePath,
    expectedParent,
    name,
    dependencies,
  );
  if (entry === undefined) throw invalidSource();
  return directoryEntryKind(entry);
};

const revalidateOpenedPath = async (
  scope: ProjectDirectoryScope,
  relativePath: string,
  expected: SourceMeterStat,
  dependencies: SourceMeterDependencies,
): Promise<void> => {
  const verification = await dependencies.openExistingProjectFile(
    scope,
    relativePath,
  );
  try {
    const status = await verification.stat();
    if (!sameOpenedPath(status, expected)) throw invalidSource();
  } finally {
    await verification.close();
  }
};

const measureOpenedDirectory = async (
  scope: ProjectDirectoryScope,
  relativePath: string,
  handle: SourceMeterFileHandle,
  initialStatus: SourceMeterStat,
  dependencies: SourceMeterDependencies,
): Promise<bigint> => {
  let directory: SourceMeterDirectory | undefined;
  try {
    if (statusKind(initialStatus) !== 'directory') throw invalidSource();
    directory = await dependencies.openDirectory(`/dev/fd/${handle.fd}`);

    let totalBytes = 0n;
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      validateDirectoryEntryName(entry.name);
      const entryKind = directoryEntryKind(entry);

      const relativeEntry = childRelativePath(relativePath, entry.name);
      if (await requireEntryKind(
        scope,
        relativePath,
        initialStatus,
        entry.name,
        dependencies,
      ) !== entryKind) {
        throw invalidSource();
      }
      const child = await dependencies.openExistingProjectFile(
        scope,
        relativeEntry,
      );
      try {
        const childStatus = await child.stat();
        if (statusKind(childStatus) !== entryKind) throw invalidSource();
        if (await requireEntryKind(
          scope,
          relativePath,
          initialStatus,
          entry.name,
          dependencies,
        ) !== entryKind) {
          throw invalidSource();
        }
        await revalidateOpenedPath(
          scope,
          relativeEntry,
          childStatus,
          dependencies,
        );

        if (entryKind === 'file') {
          if (childStatus.size < 0n) throw invalidSource();
          totalBytes += childStatus.size;
        } else {
          const childBytes = await measureOpenedDirectory(
            scope,
            relativeEntry,
            child,
            childStatus,
            dependencies,
          );
          totalBytes += childBytes;
        }

        if (await requireEntryKind(
          scope,
          relativePath,
          initialStatus,
          entry.name,
          dependencies,
        ) !== entryKind) {
          throw invalidSource();
        }
        await revalidateOpenedPath(
          scope,
          relativeEntry,
          childStatus,
          dependencies,
        );
      } finally {
        await child.close();
      }
    }

    await revalidateOpenedPath(
      scope,
      relativePath,
      initialStatus,
      dependencies,
    );
    return totalBytes;
  } finally {
    if (directory !== undefined) await directory.close();
  }
};

const measureProjectSourceBytesUnsafe = async (
  scope: ProjectDirectoryScope,
  dependencies: SourceMeterDependencies,
): Promise<bigint> => {
  let projectRoot: SourceMeterFileHandle | undefined;
  let assets: SourceMeterFileHandle | undefined;
  let source: SourceMeterFileHandle | undefined;
  try {
    projectRoot = await dependencies.openExistingProjectFile(scope, '.');
    const projectRootStatus = await projectRoot.stat();
    if (statusKind(projectRootStatus) !== 'directory') throw invalidSource();

    if (await requireEntryKind(
      scope,
      '.',
      projectRootStatus,
      'assets',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    assets = await dependencies.openExistingProjectFile(scope, 'assets');
    const assetsStatus = await assets.stat();
    if (statusKind(assetsStatus) !== 'directory') throw invalidSource();
    if (await requireEntryKind(
      scope,
      '.',
      projectRootStatus,
      'assets',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    await revalidateOpenedPath(scope, 'assets', assetsStatus, dependencies);

    if (await requireEntryKind(
      scope,
      'assets',
      assetsStatus,
      'source',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    source = await dependencies.openExistingProjectFile(scope, 'assets/source');
    const sourceStatus = await source.stat();
    if (statusKind(sourceStatus) !== 'directory') throw invalidSource();
    if (await requireEntryKind(
      scope,
      'assets',
      assetsStatus,
      'source',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    await revalidateOpenedPath(
      scope,
      'assets/source',
      sourceStatus,
      dependencies,
    );
    const totalBytes = await measureOpenedDirectory(
      scope,
      'assets/source',
      source,
      sourceStatus,
      dependencies,
    );

    if (await requireEntryKind(
      scope,
      'assets',
      assetsStatus,
      'source',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    await revalidateOpenedPath(
      scope,
      'assets/source',
      sourceStatus,
      dependencies,
    );
    if (await requireEntryKind(
      scope,
      '.',
      projectRootStatus,
      'assets',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    await revalidateOpenedPath(scope, 'assets', assetsStatus, dependencies);
    await revalidateOpenedPath(scope, '.', projectRootStatus, dependencies);
    return totalBytes;
  } finally {
    try {
      if (source !== undefined) await source.close();
    } finally {
      try {
        if (assets !== undefined) await assets.close();
      } finally {
        if (projectRoot !== undefined) await projectRoot.close();
      }
    }
  }
};

export const measureProjectSourceBytes = async (
  scope: ProjectDirectoryScope,
  dependencies: SourceMeterDependencies,
): Promise<number> => {
  try {
    const totalBytes = await measureProjectSourceBytesUnsafe(scope, dependencies);
    if (totalBytes < 0n || totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw invalidSource();
    }
    return Number(totalBytes);
  } catch (error) {
    if (error instanceof ProjectSourceMeasurementError) throw error;
    throw invalidSource(error);
  }
};

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
    sourceBytes = await dependencies.measureSourceBytes(project);
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
  sourceMeter?: SourceMeterDependencies;
}

export interface SystemSourceMeterFileHandle {
  fd: number;
  stat(options: {bigint: true}): Promise<SourceMeterStat>;
  close(): Promise<void>;
}

export interface SystemSourceMeterFileSystem {
  openExistingProjectFile(
    scope: ProjectDirectoryScope,
    relativePath: string,
  ): Promise<SystemSourceMeterFileHandle>;
  openDirectory(fdPath: string): Promise<SourceMeterDirectory>;
}

const SYSTEM_SOURCE_METER_FILE_SYSTEM: SystemSourceMeterFileSystem = {
  openExistingProjectFile: async (scope, relativePath) =>
    await openExistingProjectFile(scope, relativePath),
  openDirectory: async (fdPath) => await opendir(fdPath),
};

export const createSystemSourceMeterDependencies = (
  fileSystem: SystemSourceMeterFileSystem = SYSTEM_SOURCE_METER_FILE_SYSTEM,
): SourceMeterDependencies => ({
  openExistingProjectFile: async (scope, relativePath) => {
    const handle = await fileSystem.openExistingProjectFile(scope, relativePath);
    return {
      fd: handle.fd,
      stat: async () => await handle.stat({bigint: true}),
      close: async () => await handle.close(),
    };
  },
  openDirectory: async (fdPath) => await fileSystem.openDirectory(fdPath),
});

export const createSystemVideoctlDependencies = (
  options: SystemVideoctlOptions = {},
): VideoctlDependencies => {
  const preflightDependencies = createSystemPreflightDependencies();
  const sourceMeter = options.sourceMeter
    ?? createSystemSourceMeterDependencies();
  const ffmpegExecutable = process.env.FFMPEG_PATH;
  const ffprobeExecutable = process.env.FFPROBE_PATH;
  return {
    workspaceRoot: process.cwd(),
    stdout: process.stdout,
    stderr: process.stderr,
    loadProject,
    measureSourceBytes: async (project) => await measureProjectSourceBytes(
      project.projectDirectory,
      sourceMeter,
    ),
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
