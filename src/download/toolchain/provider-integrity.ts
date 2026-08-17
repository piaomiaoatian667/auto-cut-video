import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {
  lstat,
  open,
  readdir,
  readlink,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {
  downloadCancellationFrom,
  throwIfDownloadCancelled,
} from '../cancellation';
import {DownloadError} from '../errors';

const INVALID_PROVIDER_MESSAGE =
  'The YouTube compatibility provider is unavailable.';
const FILE_READ_BUFFER_BYTES = 64 * 1024;
const SOURCE_EXCLUDED_DIRECTORIES = new Set([
  '.git',
  'server/node_modules',
]);

export interface ProviderTreeIntegrityIdentity {
  entries: number;
  files?: number;
  symlinks?: number;
  sha256: string;
}

export interface ProviderIntegrityIdentity {
  source: ProviderTreeIntegrityIdentity;
  nodeModules: ProviderTreeIntegrityIdentity;
}

export interface VerifyProviderIntegrityOptions {
  providerDirectory: string;
  identity: ProviderIntegrityIdentity;
  currentUid: number;
  signal?: AbortSignal;
}

export interface NormalizeProviderInstallationOptions {
  providerDirectory: string;
  currentUid: number;
  signal?: AbortSignal;
}

export interface ProviderIntegrityDependencies {
  lstat(candidate: string): Promise<Stats>;
  open(candidate: string, flags: 'r'): Promise<FileHandle>;
  readdir(candidate: string): Promise<string[]>;
  readlink(candidate: string): Promise<string>;
  unlink(candidate: string): Promise<void>;
}

const defaultProviderIntegrityDependencies: ProviderIntegrityDependencies = {
  lstat,
  open: async (candidate, flags) => await open(candidate, flags),
  readdir: async (candidate) => await readdir(candidate),
  readlink: async (candidate) => await readlink(candidate),
  unlink: async (candidate) => await unlink(candidate),
};

type IntegrityRecord = {
  relativePath: string;
  serialized: string;
  kind: 'f' | 'l';
};

type ActualTreeIdentity = {
  entries: number;
  files: number;
  symlinks: number;
  sha256: string;
};

const invalidProvider = (): DownloadError => new DownloadError(
  'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
  INVALID_PROVIDER_MESSAGE,
);

const nodeErrorCode = (error: unknown): unknown => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
    ? error.code
    : undefined
);

const dependenciesWith = (
  overrides: Partial<ProviderIntegrityDependencies> | undefined,
): ProviderIntegrityDependencies => ({
  ...defaultProviderIntegrityDependencies,
  ...overrides,
});

const requireCanonicalRoot = (candidate: string): string => {
  if (
    !path.isAbsolute(candidate)
    || path.resolve(candidate) !== candidate
    || path.parse(candidate).root === candidate
  ) {
    throw invalidProvider();
  }
  return candidate;
};

const requireOwnedDirectory = (
  stats: Stats,
  currentUid: number,
): void => {
  if (
    stats.isSymbolicLink()
    || !stats.isDirectory()
    || stats.uid !== currentUid
  ) {
    throw invalidProvider();
  }
};

const requireOwnedEntry = (
  stats: Stats,
  currentUid: number,
): void => {
  if (stats.uid !== currentUid) throw invalidProvider();
};

const executableMode = (stats: Stats): string =>
  (stats.mode & 0o111).toString(8).padStart(3, '0');

const serializeField = (value: string): string =>
  `${Buffer.byteLength(value)}:${value}`;

const serializeRecord = (
  kind: 'f' | 'l',
  relativePath: string,
  mode: string,
  payload: string,
): string => [kind, relativePath, mode, payload]
  .map(serializeField)
  .join('|');

const throwMappedProviderError = (
  error: unknown,
  signal?: AbortSignal,
): never => {
  throwIfDownloadCancelled(signal);
  const cancellation = downloadCancellationFrom(error);
  if (cancellation !== undefined) throw cancellation;
  if (
    error instanceof DownloadError
    && error.code === 'DOWNLOAD_PO_TOKEN_UNAVAILABLE'
  ) {
    throw error;
  }
  throw invalidProvider();
};

const hashRegularFile = async (
  candidate: string,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<string> => {
  throwIfDownloadCancelled(signal);
  const handle = await dependencies.open(candidate, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES);
  try {
    while (true) {
      throwIfDownloadCancelled(signal);
      const {bytesRead} = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        null,
      );
      throwIfDownloadCancelled(signal);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
};

const targetStaysWithinRoot = (
  root: string,
  linkPath: string,
  target: string,
): boolean => {
  if (path.isAbsolute(target)) return false;
  const resolvedTarget = path.resolve(path.dirname(linkPath), target);
  const relativeTarget = path.relative(root, resolvedTarget);
  return relativeTarget === ''
    || (
      relativeTarget !== '..'
      && !relativeTarget.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relativeTarget)
    );
};

const measureTree = async (
  root: string,
  currentUid: number,
  excludedDirectories: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<ActualTreeIdentity> => {
  throwIfDownloadCancelled(signal);
  requireOwnedDirectory(await dependencies.lstat(root), currentUid);
  const records: IntegrityRecord[] = [];

  const visitDirectory = async (
    directory: string,
    relativeDirectory: string,
  ): Promise<void> => {
    throwIfDownloadCancelled(signal);
    const names = (await dependencies.readdir(directory)).sort();
    for (const name of names) {
      throwIfDownloadCancelled(signal);
      const candidate = path.join(directory, name);
      const relativePath = relativeDirectory.length === 0
        ? name
        : `${relativeDirectory}/${name}`;
      const stats = await dependencies.lstat(candidate);
      throwIfDownloadCancelled(signal);
      requireOwnedEntry(stats, currentUid);

      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        requireOwnedDirectory(stats, currentUid);
        if (!excludedDirectories.has(relativePath)) {
          await visitDirectory(candidate, relativePath);
        }
        continue;
      }
      if (stats.isFile() && !stats.isSymbolicLink()) {
        const payload = await hashRegularFile(candidate, signal, dependencies);
        records.push({
          relativePath,
          kind: 'f',
          serialized: serializeRecord(
            'f',
            relativePath,
            executableMode(stats),
            payload,
          ),
        });
        continue;
      }
      if (stats.isSymbolicLink()) {
        const target = await dependencies.readlink(candidate);
        throwIfDownloadCancelled(signal);
        if (!targetStaysWithinRoot(root, candidate, target)) {
          throw invalidProvider();
        }
        records.push({
          relativePath,
          kind: 'l',
          serialized: serializeRecord(
            'l',
            relativePath,
            executableMode(stats),
            target,
          ),
        });
        continue;
      }
      throw invalidProvider();
    }
  };

  await visitDirectory(root, '');
  records.sort((left, right) => left.relativePath < right.relativePath
    ? -1
    : left.relativePath > right.relativePath
      ? 1
      : 0);
  const rootHash = createHash('sha256');
  let files = 0;
  let symlinks = 0;
  for (const record of records) {
    throwIfDownloadCancelled(signal);
    rootHash.update(record.serialized);
    rootHash.update('\n');
    if (record.kind === 'f') files += 1;
    else symlinks += 1;
  }
  return {
    entries: records.length,
    files,
    symlinks,
    sha256: rootHash.digest('hex'),
  };
};

const treeIdentityMatches = (
  actual: ActualTreeIdentity,
  expected: ProviderTreeIntegrityIdentity,
): boolean => actual.entries === expected.entries
  && actual.sha256 === expected.sha256
  && (expected.files === undefined || actual.files === expected.files)
  && (expected.symlinks === undefined || actual.symlinks === expected.symlinks);

export const verifyProviderIntegrity = async (
  options: VerifyProviderIntegrityOptions,
  dependencyOverrides?: Partial<ProviderIntegrityDependencies>,
): Promise<void> => {
  const dependencies = dependenciesWith(dependencyOverrides);
  try {
    throwIfDownloadCancelled(options.signal);
    if (!Number.isInteger(options.currentUid) || options.currentUid < 0) {
      throw invalidProvider();
    }
    const providerDirectory = requireCanonicalRoot(options.providerDirectory);
    const nodeModulesDirectory = path.join(
      providerDirectory,
      'server/node_modules',
    );
    const source = await measureTree(
      providerDirectory,
      options.currentUid,
      SOURCE_EXCLUDED_DIRECTORIES,
      options.signal,
      dependencies,
    );
    if (!treeIdentityMatches(source, options.identity.source)) {
      throw invalidProvider();
    }
    const nodeModules = await measureTree(
      nodeModulesDirectory,
      options.currentUid,
      new Set(),
      options.signal,
      dependencies,
    );
    if (!treeIdentityMatches(nodeModules, options.identity.nodeModules)) {
      throw invalidProvider();
    }
  } catch (error) {
    throwMappedProviderError(error, options.signal);
  }
};

export const normalizeProviderInstallation = async (
  options: NormalizeProviderInstallationOptions,
  dependencyOverrides?: Partial<ProviderIntegrityDependencies>,
): Promise<void> => {
  const dependencies = dependenciesWith(dependencyOverrides);
  try {
    throwIfDownloadCancelled(options.signal);
    if (!Number.isInteger(options.currentUid) || options.currentUid < 0) {
      throw invalidProvider();
    }
    const providerDirectory = requireCanonicalRoot(options.providerDirectory);
    const directoryChain = [
      providerDirectory,
      path.join(providerDirectory, 'server'),
      path.join(providerDirectory, 'server/node_modules'),
      path.join(providerDirectory, 'server/node_modules/.deno'),
    ];
    for (const [index, candidate] of directoryChain.entries()) {
      throwIfDownloadCancelled(options.signal);
      let stats: Stats;
      try {
        stats = await dependencies.lstat(candidate);
      } catch (error) {
        if (
          index === directoryChain.length - 1
          && nodeErrorCode(error) === 'ENOENT'
        ) {
          return;
        }
        throw error;
      }
      requireOwnedDirectory(stats, options.currentUid);
    }
    const setupCache = path.join(
      providerDirectory,
      'server/node_modules/.deno/.setup-cache.bin',
    );
    let setupCacheStats: Stats;
    try {
      setupCacheStats = await dependencies.lstat(setupCache);
    } catch (error) {
      if (nodeErrorCode(error) === 'ENOENT') return;
      throw error;
    }
    if (
      setupCacheStats.isSymbolicLink()
      || !setupCacheStats.isFile()
      || setupCacheStats.uid !== options.currentUid
    ) {
      throw invalidProvider();
    }
    throwIfDownloadCancelled(options.signal);
    await dependencies.unlink(setupCache);
    throwIfDownloadCancelled(options.signal);
  } catch (error) {
    throwMappedProviderError(error, options.signal);
  }
};
