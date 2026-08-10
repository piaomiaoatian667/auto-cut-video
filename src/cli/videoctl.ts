import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {constants} from 'node:fs';
import {open, opendir} from 'node:fs/promises';
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
  openAuthority(
    parent: Pick<SourceMeterStat, 'dev' | 'ino'>,
    name: string,
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

const O_NOFOLLOW_ANY = 0x20000000;
const SAFE_SOURCE_FLAGS = constants.O_RDONLY
  | constants.O_NONBLOCK
  | O_NOFOLLOW_ANY;

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

interface SourceMeterAuthority {
  handle: SourceMeterFileHandle;
  status: SourceMeterStat;
  parent?: SourceMeterAuthority;
  name?: string;
}

const closeAuthorityVerification = async (
  handle: SourceMeterFileHandle | undefined,
): Promise<void> => {
  if (handle !== undefined) await handle.close();
};

const revalidateAuthority = async (
  scope: ProjectDirectoryScope,
  authority: SourceMeterAuthority,
  dependencies: SourceMeterDependencies,
): Promise<void> => {
  if (authority.parent === undefined) {
    let verification: SourceMeterFileHandle | undefined;
    try {
      verification = await dependencies.openExistingProjectFile(scope, '.');
      const status = await verification.stat();
      if (
        statusKind(status) !== 'directory'
        || !sameOpenedPath(status, authority.status)
      ) {
        throw invalidSource();
      }
    } finally {
      await closeAuthorityVerification(verification);
    }
    return;
  }

  await revalidateAuthority(scope, authority.parent, dependencies);
  let verification: SourceMeterFileHandle | undefined;
  try {
    verification = await dependencies.openAuthority(
      authority.parent.status,
      authority.name!,
    );
    const status = await verification.stat();
    if (!sameOpenedPath(status, authority.status)) throw invalidSource();
  } finally {
    await closeAuthorityVerification(verification);
  }
};

const findDirectoryEntry = async (
  scope: ProjectDirectoryScope,
  parent: SourceMeterAuthority,
  name: string,
  dependencies: SourceMeterDependencies,
): Promise<SourceMeterDirectoryEntry | undefined> => {
  let directory: SourceMeterDirectory | undefined;
  try {
    await revalidateAuthority(scope, parent, dependencies);
    directory = await dependencies.openDirectory(`/dev/fd/${parent.handle.fd}`);
    while (true) {
      const entry = await directory.read();
      if (entry === null) return undefined;
      validateDirectoryEntryName(entry.name);
      if (entry.name === name) return entry;
    }
  } finally {
    if (directory !== undefined) await directory.close();
  }
};

const requireEntryKind = async (
  scope: ProjectDirectoryScope,
  parent: SourceMeterAuthority,
  name: string,
  dependencies: SourceMeterDependencies,
): Promise<SourceMeterEntryKind> => {
  const entry = await findDirectoryEntry(
    scope,
    parent,
    name,
    dependencies,
  );
  if (entry === undefined) throw invalidSource();
  return directoryEntryKind(entry);
};

const openChildAuthority = async (
  scope: ProjectDirectoryScope,
  parent: SourceMeterAuthority,
  name: string,
  expectedKind: SourceMeterEntryKind,
  dependencies: SourceMeterDependencies,
): Promise<SourceMeterAuthority> => {
  await revalidateAuthority(scope, parent, dependencies);
  const handle = await dependencies.openAuthority(parent.status, name);
  try {
    const status = await handle.stat();
    if (statusKind(status) !== expectedKind) throw invalidSource();
    return {handle, status, parent, name};
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const measureOpenedDirectory = async (
  scope: ProjectDirectoryScope,
  authority: SourceMeterAuthority,
  dependencies: SourceMeterDependencies,
): Promise<bigint> => {
  let directory: SourceMeterDirectory | undefined;
  try {
    if (statusKind(authority.status) !== 'directory') throw invalidSource();
    await revalidateAuthority(scope, authority, dependencies);
    directory = await dependencies.openDirectory(`/dev/fd/${authority.handle.fd}`);

    let totalBytes = 0n;
    while (true) {
      const entry = await directory.read();
      if (entry === null) break;
      validateDirectoryEntryName(entry.name);
      const entryKind = directoryEntryKind(entry);
      await revalidateAuthority(scope, authority, dependencies);
      const child = await openChildAuthority(
        scope,
        authority,
        entry.name,
        entryKind,
        dependencies,
      );
      try {
        if (entryKind === 'file') {
          if (child.status.size < 0n) throw invalidSource();
          await revalidateAuthority(scope, child, dependencies);
          totalBytes += child.status.size;
        } else {
          const childBytes = await measureOpenedDirectory(
            scope,
            child,
            dependencies,
          );
          totalBytes += childBytes;
        }
        await revalidateAuthority(scope, child, dependencies);
      } finally {
        await child.handle.close();
      }
    }

    await revalidateAuthority(scope, authority, dependencies);
    return totalBytes;
  } finally {
    if (directory !== undefined) await directory.close();
  }
};

const measureProjectSourceBytesUnsafe = async (
  scope: ProjectDirectoryScope,
  dependencies: SourceMeterDependencies,
): Promise<bigint> => {
  let projectRootHandle: SourceMeterFileHandle | undefined;
  let projectRoot: SourceMeterAuthority | undefined;
  let assets: SourceMeterAuthority | undefined;
  let source: SourceMeterAuthority | undefined;
  try {
    projectRootHandle = await dependencies.openExistingProjectFile(scope, '.');
    const projectRootStatus = await projectRootHandle.stat();
    if (statusKind(projectRootStatus) !== 'directory') throw invalidSource();
    projectRoot = {handle: projectRootHandle, status: projectRootStatus};
    projectRootHandle = undefined;

    if (await requireEntryKind(
      scope,
      projectRoot,
      'assets',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    assets = await openChildAuthority(
      scope,
      projectRoot,
      'assets',
      'directory',
      dependencies,
    );

    if (await requireEntryKind(
      scope,
      assets,
      'source',
      dependencies,
    ) !== 'directory') {
      throw invalidSource();
    }
    source = await openChildAuthority(
      scope,
      assets,
      'source',
      'directory',
      dependencies,
    );
    const totalBytes = await measureOpenedDirectory(
      scope,
      source,
      dependencies,
    );

    await revalidateAuthority(scope, source, dependencies);
    await revalidateAuthority(scope, assets, dependencies);
    await revalidateAuthority(scope, projectRoot, dependencies);
    return totalBytes;
  } finally {
    try {
      if (source !== undefined) await source.handle.close();
    } finally {
      try {
        if (assets !== undefined) await assets.handle.close();
      } finally {
        if (projectRoot !== undefined) {
          await projectRoot.handle.close();
        } else if (projectRootHandle !== undefined) {
          await projectRootHandle.close();
        }
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
  open(candidate: string, flags: number): Promise<SystemSourceMeterFileHandle>;
  openDirectory(fdPath: string): Promise<SourceMeterDirectory>;
}

const SYSTEM_SOURCE_METER_FILE_SYSTEM: SystemSourceMeterFileSystem = {
  openExistingProjectFile: async (scope, relativePath) =>
    await openExistingProjectFile(scope, relativePath),
  open: async (candidate, flags) => await open(candidate, flags),
  openDirectory: async (fdPath) => await opendir(fdPath),
};

const sourceAuthorityPath = (
  parent: Pick<SourceMeterStat, 'dev' | 'ino'>,
  name: string,
): string => {
  validateDirectoryEntryName(name);
  if (parent.dev < 0n || parent.ino < 0n) throw invalidSource();
  return `/.vol/${parent.dev}/${parent.ino}/${name}`;
};

const systemSourceHandle = (
  handle: SystemSourceMeterFileHandle,
): SourceMeterFileHandle => ({
  fd: handle.fd,
  stat: async () => await handle.stat({bigint: true}),
  close: async () => await handle.close(),
});

export const createSystemSourceMeterDependencies = (
  fileSystem: SystemSourceMeterFileSystem = SYSTEM_SOURCE_METER_FILE_SYSTEM,
): SourceMeterDependencies => ({
  openExistingProjectFile: async (scope, relativePath) => {
    const handle = await fileSystem.openExistingProjectFile(scope, relativePath);
    return systemSourceHandle(handle);
  },
  openAuthority: async (parent, name) => systemSourceHandle(await fileSystem.open(
    sourceAuthorityPath(parent, name),
    SAFE_SOURCE_FLAGS,
  )),
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
