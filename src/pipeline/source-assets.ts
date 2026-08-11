import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {
  open,
  opendir,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import type {ProjectInputs} from '../domain/load-project';
import {
  openExistingProjectFile,
  type ProjectDirectoryScope,
} from '../fs/project-paths';
import {fingerprintValue} from './fingerprint';

export type SourceAssetKind = 'video' | 'audio' | 'image';

export interface ProjectSourceAsset {
  assetId: string;
  kind: SourceAssetKind;
  sourcePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ProjectSourceCatalog {
  assets: readonly ProjectSourceAsset[];
  totalBytes: number;
  fingerprint: string;
}

export type ProjectSourceErrorCode =
  | 'PROJECT_SOURCE_INVALID'
  | 'PROJECT_SOURCE_MISSING'
  | 'PROJECT_SOURCE_AMBIGUOUS'
  | 'PROJECT_SOURCE_KIND_CONFLICT';

export class ProjectSourceError extends Error {
  constructor(
    readonly code: ProjectSourceErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'ProjectSourceError';
  }
}

export interface SourceCatalogDependencies {
  listSourceFiles(
    projectDirectory: ProjectDirectoryScope,
  ): Promise<readonly {sourcePath: string; sizeBytes: number}[]>;
  hashProjectFile(
    projectDirectory: ProjectDirectoryScope,
    sourcePath: string,
  ): Promise<string>;
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

export class ProjectSourceMeasurementError extends ProjectSourceError {
  constructor(options?: ErrorOptions) {
    super(
      'PROJECT_SOURCE_INVALID',
      'Project source assets could not be measured safely.',
      options,
    );
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

interface SourceFileIdentity {
  dev: bigint;
  ino: bigint;
  nlink: bigint;
  size: bigint;
}

interface MeasuredSourceFile {
  sourcePath: string;
  sizeBytes: bigint;
  identity: SourceFileIdentity;
}

interface MeasuredSourceTree {
  files: MeasuredSourceFile[];
  totalBytes: bigint;
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
  sourcePath: string,
  dependencies: SourceMeterDependencies,
): Promise<MeasuredSourceTree> => {
  let directory: SourceMeterDirectory | undefined;
  try {
    if (statusKind(authority.status) !== 'directory') throw invalidSource();
    await revalidateAuthority(scope, authority, dependencies);
    directory = await dependencies.openDirectory(`/dev/fd/${authority.handle.fd}`);

    const files: MeasuredSourceFile[] = [];
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
        const childSourcePath = path.posix.join(sourcePath, entry.name);
        if (entryKind === 'file') {
          if (child.status.size < 0n) throw invalidSource();
          await revalidateAuthority(scope, child, dependencies);
          files.push({
            sourcePath: childSourcePath,
            sizeBytes: child.status.size,
            identity: {
              dev: child.status.dev,
              ino: child.status.ino,
              nlink: child.status.nlink,
              size: child.status.size,
            },
          });
          totalBytes += child.status.size;
        } else {
          const childTree = await measureOpenedDirectory(
            scope,
            child,
            childSourcePath,
            dependencies,
          );
          files.push(...childTree.files);
          totalBytes += childTree.totalBytes;
        }
        await revalidateAuthority(scope, child, dependencies);
      } finally {
        await child.handle.close();
      }
    }

    await revalidateAuthority(scope, authority, dependencies);
    return {files, totalBytes};
  } finally {
    if (directory !== undefined) await directory.close();
  }
};

const measureProjectSourceTreeUnsafe = async (
  scope: ProjectDirectoryScope,
  dependencies: SourceMeterDependencies,
): Promise<MeasuredSourceTree> => {
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
    const tree = await measureOpenedDirectory(
      scope,
      source,
      'assets/source',
      dependencies,
    );

    await revalidateAuthority(scope, source, dependencies);
    await revalidateAuthority(scope, assets, dependencies);
    await revalidateAuthority(scope, projectRoot, dependencies);
    return tree;
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

interface InventoriedSourceFile {
  sourcePath: string;
  sizeBytes: number;
  identity: SourceFileIdentity;
}

const inventoryProjectSourceFiles = async (
  scope: ProjectDirectoryScope,
  dependencies: SourceMeterDependencies,
): Promise<readonly InventoriedSourceFile[]> => {
  try {
    const tree = await measureProjectSourceTreeUnsafe(scope, dependencies);
    if (
      tree.totalBytes < 0n
      || tree.totalBytes > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw invalidSource();
    }
    return tree.files
      .map(({sourcePath, sizeBytes, identity}) => {
        if (sizeBytes < 0n || sizeBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw invalidSource();
        }
        return {sourcePath, sizeBytes: Number(sizeBytes), identity};
      })
      .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
  } catch (error) {
    if (error instanceof ProjectSourceMeasurementError) throw error;
    throw invalidSource(error);
  }
};

export const measureProjectSourceBytes = async (
  scope: ProjectDirectoryScope,
  dependencies: SourceMeterDependencies,
): Promise<number> => {
  const files = await inventoryProjectSourceFiles(scope, dependencies);
  return files.reduce((total, source) => total + source.sizeBytes, 0);
};

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

const identityMatchesStatus = (
  status: Pick<SourceMeterStat, 'dev' | 'ino' | 'nlink' | 'size'> & {
    isFile(): boolean;
  },
  identity: SourceFileIdentity,
): boolean => (
  status.isFile()
  && status.dev === identity.dev
  && status.ino === identity.ino
  && status.nlink === identity.nlink
  && status.size === identity.size
);

const sourcePathSegments = (sourcePath: string): string[] => {
  const segments = sourcePath.split('/');
  if (
    sourcePath.includes('\0')
    || sourcePath.includes('\\')
    || sourcePath !== path.posix.normalize(sourcePath)
    || segments.length < 3
    || segments[0] !== 'assets'
    || segments[1] !== 'source'
    || segments.some((segment) => (
      segment.length === 0 || segment === '.' || segment === '..'
    ))
  ) {
    throw invalidSource();
  }
  return segments;
};

const closeSourceAuthorities = async (
  authorities: readonly SourceMeterAuthority[],
): Promise<void> => {
  let closeError: unknown;
  for (const authority of [...authorities].reverse()) {
    try {
      await authority.handle.close();
    } catch (error) {
      closeError ??= error;
    }
  }
  if (closeError !== undefined) throw closeError;
};

const openInventoriedSourceAuthority = async (
  scope: ProjectDirectoryScope,
  sourcePath: string,
  dependencies: SourceMeterDependencies,
): Promise<{
  authorities: readonly SourceMeterAuthority[];
  target: SourceMeterAuthority;
}> => {
  const segments = sourcePathSegments(sourcePath);
  const authorities: SourceMeterAuthority[] = [];
  let pendingHandle: SourceMeterFileHandle | undefined;
  try {
    pendingHandle = await dependencies.openExistingProjectFile(scope, '.');
    const rootStatus = await pendingHandle.stat();
    if (statusKind(rootStatus) !== 'directory') throw invalidSource();
    let parent: SourceMeterAuthority = {handle: pendingHandle, status: rootStatus};
    authorities.push(parent);
    pendingHandle = undefined;

    for (const [index, segment] of segments.entries()) {
      const expectedKind: SourceMeterEntryKind = index === segments.length - 1
        ? 'file'
        : 'directory';
      if (await requireEntryKind(
        scope,
        parent,
        segment,
        dependencies,
      ) !== expectedKind) {
        throw invalidSource();
      }
      parent = await openChildAuthority(
        scope,
        parent,
        segment,
        expectedKind,
        dependencies,
      );
      authorities.push(parent);
    }
    return {authorities, target: parent};
  } catch (error) {
    let closeError: unknown;
    if (pendingHandle !== undefined) {
      try {
        await pendingHandle.close();
      } catch (pendingCloseError) {
        closeError = pendingCloseError;
      }
    }
    try {
      await closeSourceAuthorities(authorities);
    } catch (authorityCloseError) {
      closeError ??= authorityCloseError;
    }
    if (closeError !== undefined) throw closeError;
    throw error;
  }
};

const hashFileHandle = async (
  handle: FileHandle,
  expectedIdentity: SourceFileIdentity,
): Promise<string> => {
  const before = await handle.stat({bigint: true});
  if (!identityMatchesStatus(before, expectedIdentity)) throw invalidSource();
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  while (true) {
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  const after = await handle.stat({bigint: true});
  if (!identityMatchesStatus(after, expectedIdentity)) throw invalidSource();
  return `sha256:${hash.digest('hex')}`;
};

const hashInventoriedProjectFile = async (
  projectDirectory: ProjectDirectoryScope,
  sourcePath: string,
  expectedIdentity: SourceFileIdentity,
  sourceMeter: SourceMeterDependencies,
): Promise<string> => {
  const opened = await openInventoriedSourceAuthority(
    projectDirectory,
    sourcePath,
    sourceMeter,
  );
  try {
    if (!identityMatchesStatus(opened.target.status, expectedIdentity)) {
      throw invalidSource();
    }
    await revalidateAuthority(projectDirectory, opened.target, sourceMeter);
    const handle = await openExistingProjectFile(projectDirectory, sourcePath);
    try {
      const sha256 = await hashFileHandle(handle, expectedIdentity);
      await revalidateAuthority(projectDirectory, opened.target, sourceMeter);
      return sha256;
    } finally {
      await handle.close();
    }
  } finally {
    await closeSourceAuthorities(opened.authorities);
  }
};

export const createSystemSourceCatalogDependencies = (
  sourceMeter: SourceMeterDependencies = createSystemSourceMeterDependencies(),
): SourceCatalogDependencies => {
  const inventories = new WeakMap<
    ProjectDirectoryScope,
    ReadonlyMap<string, SourceFileIdentity>
  >();
  return {
    listSourceFiles: async (projectDirectory) => {
      const files = await inventoryProjectSourceFiles(projectDirectory, sourceMeter);
      inventories.set(projectDirectory, new Map(files.map((source) => [
        source.sourcePath,
        source.identity,
      ])));
      return files.map(({sourcePath, sizeBytes}) => ({sourcePath, sizeBytes}));
    },
    hashProjectFile: async (projectDirectory, sourcePath) => {
      const expectedIdentity = inventories.get(projectDirectory)?.get(sourcePath);
      if (expectedIdentity === undefined) throw invalidSource();
      try {
        return await hashInventoriedProjectFile(
          projectDirectory,
          sourcePath,
          expectedIdentity,
          sourceMeter,
        );
      } catch (error) {
        if (error instanceof ProjectSourceMeasurementError) throw error;
        throw invalidSource(error);
      }
    },
  };
};

const projectSourceError = (
  code: ProjectSourceErrorCode,
  message: string,
  cause?: unknown,
): ProjectSourceError => new ProjectSourceError(
  code,
  message,
  cause === undefined ? undefined : {cause},
);

const addExpectedKind = (
  expectedKinds: Map<string, SourceAssetKind>,
  assetId: string,
  kind: SourceAssetKind,
): void => {
  const existing = expectedKinds.get(assetId);
  if (existing !== undefined && existing !== kind) {
    throw projectSourceError(
      'PROJECT_SOURCE_KIND_CONFLICT',
      `asset ${assetId} is referenced as both ${existing} and ${kind}`,
    );
  }
  expectedKinds.set(assetId, kind);
};

const validateSourceFile = (
  source: {sourcePath: string; sizeBytes: number},
): void => {
  if (
    source.sourcePath.includes('\0')
    || source.sourcePath !== path.posix.normalize(source.sourcePath)
    || !source.sourcePath.startsWith('assets/source/')
    || !Number.isSafeInteger(source.sizeBytes)
    || source.sizeBytes < 0
  ) {
    throw projectSourceError(
      'PROJECT_SOURCE_INVALID',
      'Project source assets could not be inspected safely.',
    );
  }
};

const finalExtensionStem = (sourcePath: string): string => {
  const basename = path.posix.basename(sourcePath);
  const extension = path.posix.extname(basename);
  return extension.length === 0
    ? basename
    : basename.slice(0, -extension.length);
};

export async function discoverProjectSourceCatalog(
  project: ProjectInputs,
  dependencies: SourceCatalogDependencies = createSystemSourceCatalogDependencies(),
): Promise<ProjectSourceCatalog> {
  const expectedKinds = new Map<string, SourceAssetKind>();
  for (const clip of project.edit.visualClips) {
    addExpectedKind(expectedKinds, clip.assetId, clip.kind);
  }
  if (project.edit.backgroundMusic !== undefined) {
    addExpectedKind(
      expectedKinds,
      project.edit.backgroundMusic.assetId,
      'audio',
    );
  }

  let sourceFiles: readonly {sourcePath: string; sizeBytes: number}[];
  try {
    sourceFiles = await dependencies.listSourceFiles(project.projectDirectory);
  } catch (error) {
    if (error instanceof ProjectSourceError) throw error;
    throw projectSourceError(
      'PROJECT_SOURCE_INVALID',
      'Project source assets could not be inspected safely.',
      error,
    );
  }

  const filesByStem = new Map<
    string,
    Array<{sourcePath: string; sizeBytes: number}>
  >();
  const sourcePaths = new Set<string>();
  let totalBytes = 0n;
  for (const source of sourceFiles) {
    validateSourceFile(source);
    if (sourcePaths.has(source.sourcePath)) {
      throw projectSourceError(
        'PROJECT_SOURCE_INVALID',
        'Project source assets could not be inspected safely.',
      );
    }
    sourcePaths.add(source.sourcePath);
    totalBytes += BigInt(source.sizeBytes);
    if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw projectSourceError(
        'PROJECT_SOURCE_INVALID',
        'Project source assets exceed the safe byte-count limit.',
      );
    }
    const stem = finalExtensionStem(source.sourcePath);
    const matches = filesByStem.get(stem) ?? [];
    matches.push(source);
    filesByStem.set(stem, matches);
  }

  const assets: ProjectSourceAsset[] = [];
  const expectedAssets = [...expectedKinds.entries()]
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [assetId, kind] of expectedAssets) {
    const matches = filesByStem.get(assetId) ?? [];
    if (matches.length === 0) {
      throw projectSourceError(
        'PROJECT_SOURCE_MISSING',
        `no source file matches asset ${assetId}`,
      );
    }
    if (matches.length > 1) {
      throw projectSourceError(
        'PROJECT_SOURCE_AMBIGUOUS',
        `multiple source files match asset ${assetId}`,
      );
    }
    const source = matches[0]!;
    let sha256: string;
    try {
      sha256 = await dependencies.hashProjectFile(
        project.projectDirectory,
        source.sourcePath,
      );
    } catch (error) {
      if (error instanceof ProjectSourceError) throw error;
      throw projectSourceError(
        'PROJECT_SOURCE_INVALID',
        `source file changed while hashing asset ${assetId}`,
        error,
      );
    }
    assets.push({
      assetId,
      kind,
      sourcePath: source.sourcePath,
      sizeBytes: source.sizeBytes,
      sha256,
    });
  }

  return {
    assets,
    totalBytes: Number(totalBytes),
    fingerprint: fingerprintValue({assets}),
  };
}
