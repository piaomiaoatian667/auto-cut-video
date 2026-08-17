import {createHash, randomBytes} from 'node:crypto';
import {constants, type Dir, type Stats} from 'node:fs';
import {
  lstat,
  open,
  opendir,
  readlink,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import {runProcess as runSystemProcess} from '../../process/run-process';
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
const DARWIN_DIRECTORY_AUTHORITY_FLAGS = 0x20100000;
const DARWIN_FILE_AUTHORITY_FLAGS = 0x20000000;
const SETUP_CACHE_COMPONENTS = [
  'server',
  'node_modules',
  '.deno',
] as const;
const DARWIN_SETUP_CACHE_UNLINK_SCRIPT = [
  'ObjC.import("Foundation");',
  'ObjC.bindFunction("openat", ["int", ["int", "char *", "int"]]);',
  'ObjC.bindFunction("close", ["int", ["int"]]);',
  'ObjC.bindFunction("renameatx_np", ["int", ["int", "char *", "int", "char *", "uint32"]]);',
  'ObjC.bindFunction("unlinkat", ["int", ["int", "char *", "int"]]);',
  `const DIRECTORY_FLAGS = ${DARWIN_DIRECTORY_AUTHORITY_FLAGS};`,
  `const FILE_FLAGS = ${DARWIN_FILE_AUTHORITY_FLAGS};`,
  'const RENAME_EXCL_NOFOLLOW_ANY = 20;',
  'function descriptorStats(nodeExecutable, descriptor) {',
  '  const task = $.NSTask.alloc.init;',
  '  task.launchPath = nodeExecutable;',
  '  task.arguments = [',
  '    "-e",',
  '    "const s=require(\\"node:fs\\").fstatSync(0);" +',
  '      "const kind=s.isDirectory()?\\"d\\":s.isFile()?\\"f\\":\\"o\\";" +',
  '      "process.stdout.write(JSON.stringify({kind,dev:String(s.dev)," +',
  '      "ino:String(s.ino),mode:String(s.mode),uid:String(s.uid)}));",',
  '  ];',
  '  task.standardInput = $.NSFileHandle.alloc',
  '    .initWithFileDescriptorCloseOnDealloc(descriptor, false);',
  '  const outputPipe = $.NSPipe.pipe;',
  '  task.standardOutput = outputPipe;',
  '  task.standardError = $.NSFileHandle.fileHandleWithNullDevice;',
  '  task.launch;',
  '  const outputData = outputPipe.fileHandleForReading.readDataToEndOfFile;',
  '  task.waitUntilExit;',
  '  if (Number(task.terminationStatus) !== 0) return null;',
  '  const output = ObjC.unwrap(',
  '    $.NSString.alloc.initWithDataEncoding(outputData, 4),',
  '  );',
  '  return JSON.parse(output);',
  '}',
  'function matches(nodeExecutable, descriptor, expected) {',
  '  const actual = descriptorStats(nodeExecutable, descriptor);',
  '  return actual !== null && actual.kind === expected.kind &&',
  '    actual.dev === expected.dev && actual.ino === expected.ino &&',
  '    actual.mode === expected.mode && actual.uid === expected.uid;',
  '}',
  'function moveNoReplace(directoryDescriptor, sourceName, targetName) {',
  '  return Number($.renameatx_np(',
  '    directoryDescriptor, sourceName, directoryDescriptor, targetName,',
  '    RENAME_EXCL_NOFOLLOW_ANY,',
  '  )) === 0;',
  '}',
  'function run(argv) {',
  '  const descriptors = [];',
  '  let denoDescriptor = -1;',
  '  let quarantined = false;',
  '  try {',
  '    const nodeExecutable = argv[0];',
  '    const expected = JSON.parse(argv[1]);',
  '    const quarantineName = argv[2];',
  '    if (!/^\\.setup-cache\\.bin\\.quarantine-[0-9a-f]{32}$/.test(',
  '      quarantineName,',
  '    )) return "error";',
  '    const names = ["server", "node_modules", ".deno"];',
  '    if (!matches(nodeExecutable, 3, expected.root) ||',
  '        expected.directories.length !== names.length) return "error";',
  '    let parentDescriptor = 3;',
  '    for (let index = 0; index < names.length; index += 1) {',
  '      const descriptor = Number($.openat(',
  '        parentDescriptor, names[index], DIRECTORY_FLAGS,',
  '      ));',
  '      if (descriptor < 0) return "error";',
  '      descriptors.push(descriptor);',
  '      if (!matches(nodeExecutable, descriptor, expected.directories[index])) {',
  '        return "error";',
  '      }',
  '      parentDescriptor = descriptor;',
  '    }',
  '    denoDescriptor = parentDescriptor;',
  '    const setupCacheDescriptor = Number($.openat(',
  '      parentDescriptor, ".setup-cache.bin", FILE_FLAGS,',
  '    ));',
  '    if (setupCacheDescriptor < 0) return "error";',
  '    descriptors.push(setupCacheDescriptor);',
  '    if (!matches(nodeExecutable, setupCacheDescriptor, expected.file)) {',
  '      return "error";',
  '    }',
  '    const confirmationDescriptor = Number($.openat(',
  '      parentDescriptor, ".setup-cache.bin", FILE_FLAGS,',
  '    ));',
  '    if (confirmationDescriptor < 0) return "error";',
  '    descriptors.push(confirmationDescriptor);',
  '    if (!matches(nodeExecutable, confirmationDescriptor, expected.file)) {',
  '      return "error";',
  '    }',
  '    const quarantineResult = Number($.renameatx_np(',
  '      denoDescriptor, ".setup-cache.bin",',
  '      denoDescriptor, quarantineName, RENAME_EXCL_NOFOLLOW_ANY,',
  '    ));',
  '    if (quarantineResult !== 0) return "error";',
  '    quarantined = true;',
  '    const quarantineDescriptor = Number($.openat(',
  '      denoDescriptor, quarantineName, FILE_FLAGS,',
  '    ));',
  '    if (quarantineDescriptor < 0) {',
  '      if (moveNoReplace(',
  '        denoDescriptor, quarantineName, ".setup-cache.bin",',
  '      )) quarantined = false;',
  '      return "error";',
  '    }',
  '    descriptors.push(quarantineDescriptor);',
  '    if (!matches(nodeExecutable, quarantineDescriptor, expected.file)) {',
  '      if (moveNoReplace(',
  '        denoDescriptor, quarantineName, ".setup-cache.bin",',
  '      )) quarantined = false;',
  '      return "error";',
  '    }',
  '    if (Number($.unlinkat(denoDescriptor, quarantineName, 0)) !== 0) {',
  '      if (moveNoReplace(',
  '        denoDescriptor, quarantineName, ".setup-cache.bin",',
  '      )) quarantined = false;',
  '      return "error";',
  '    }',
  '    quarantined = false;',
  '    return "removed";',
  '  } catch {',
  '    if (quarantined && denoDescriptor >= 0) {',
  '      moveNoReplace(',
  '        denoDescriptor, argv[2], ".setup-cache.bin",',
  '      );',
  '    }',
  '    return "error";',
  '  } finally {',
  '    for (let index = descriptors.length - 1; index >= 0; index -= 1) {',
  '      $.close(descriptors[index]);',
  '    }',
  '  }',
  '}',
].join('\n');

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

interface ProviderEntryIdentity {
  kind: 'd' | 'f';
  dev: string;
  ino: string;
  mode: string;
  uid: string;
}

export interface UnlinkProviderSetupCacheOptions {
  providerDirectoryHandle: FileHandle;
  providerDirectoryIdentity: ProviderEntryIdentity;
  directoryIdentities: readonly ProviderEntryIdentity[];
  setupCacheIdentity: ProviderEntryIdentity;
  signal?: AbortSignal;
}

export interface ProviderIntegrityDependencies {
  lstat(candidate: string): Promise<Stats>;
  open(candidate: string, flags: number): Promise<FileHandle>;
  opendir(candidate: string): Promise<Dir>;
  readlink(candidate: string): Promise<string>;
  unlinkSetupCache(options: UnlinkProviderSetupCacheOptions): Promise<void>;
}

const unlinkSetupCacheAt = async (
  options: UnlinkProviderSetupCacheOptions,
): Promise<void> => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw invalidProvider();
  }
  const quarantineName =
    `.setup-cache.bin.quarantine-${randomBytes(16).toString('hex')}`;
  const result = await runSystemProcess('/usr/bin/osascript', [
    '-l',
    'JavaScript',
    '-e',
    DARWIN_SETUP_CACHE_UNLINK_SCRIPT,
    '--',
    process.execPath,
    JSON.stringify({
      root: options.providerDirectoryIdentity,
      directories: options.directoryIdentities,
      file: options.setupCacheIdentity,
    }),
    quarantineName,
  ], {
    extraStdioFds: [options.providerDirectoryHandle.fd],
    env: Object.freeze({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      FORCE_COLOR: 'false',
    }),
    ...(options.signal === undefined ? {} : {signal: options.signal}),
  });
  if (
    result.exitCode !== 0
    || result.signal !== null
    || result.stdout.trim() !== 'removed'
  ) {
    throw invalidProvider();
  }
};

const defaultProviderIntegrityDependencies: ProviderIntegrityDependencies = {
  lstat,
  open: async (candidate, flags) => await open(candidate, flags),
  opendir: async (candidate) => await opendir(candidate),
  readlink: async (candidate) => await readlink(candidate),
  unlinkSetupCache: unlinkSetupCacheAt,
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

type DirectoryAuthority = {
  absolutePath: string;
  handle: FileHandle;
  stats: Stats;
};

type CloseAuthoritiesResult =
  | {failed: false}
  | {error: unknown; failed: true};

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

const closeDirectoryAuthorities = async (
  authorities: readonly (DirectoryAuthority | undefined)[],
): Promise<CloseAuthoritiesResult> => {
  let firstError: unknown;
  let failed = false;
  for (const authority of authorities) {
    if (authority === undefined) continue;
    try {
      await authority.handle.close();
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  return failed
    ? {error: firstError, failed: true}
    : {failed: false};
};

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

const entryIdentity = (
  stats: Stats,
  kind: ProviderEntryIdentity['kind'],
): ProviderEntryIdentity => ({
  kind,
  dev: String(stats.dev),
  ino: String(stats.ino),
  mode: String(stats.mode),
  uid: String(stats.uid),
});

const sameOwnedDirectory = (
  expected: Stats,
  actual: Stats,
  currentUid: number,
  requireStableContents = false,
): boolean => (
  !expected.isSymbolicLink()
  && expected.isDirectory()
  && !actual.isSymbolicLink()
  && actual.isDirectory()
  && expected.uid === currentUid
  && actual.uid === currentUid
  && actual.mode === expected.mode
  && actual.dev === expected.dev
  && actual.ino === expected.ino
  && (
    !requireStableContents
    || (
      actual.size === expected.size
      && actual.mtimeMs === expected.mtimeMs
      && actual.ctimeMs === expected.ctimeMs
    )
  )
);

const directoryDescriptorPath = (handle: FileHandle): string =>
  `/dev/fd/${handle.fd}`;

const requireDirectoryAuthorityStable = async (
  authority: DirectoryAuthority,
  currentUid: number,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<void> => {
  throwIfDownloadCancelled(signal);
  const handleStats = await authority.handle.stat();
  const pathStats = await dependencies.lstat(authority.absolutePath);
  throwIfDownloadCancelled(signal);
  if (
    !sameOwnedDirectory(authority.stats, handleStats, currentUid, true)
    || !sameOwnedDirectory(authority.stats, pathStats, currentUid, true)
  ) {
    throw invalidProvider();
  }
};

const openRootDirectoryAuthority = async (
  candidate: string,
  currentUid: number,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<DirectoryAuthority> => {
  throwIfDownloadCancelled(signal);
  const pathStats = await dependencies.lstat(candidate);
  requireOwnedDirectory(pathStats, currentUid);
  const handle = await dependencies.open(
    candidate,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const openedStats = await handle.stat();
    if (!sameOwnedDirectory(pathStats, openedStats, currentUid)) {
      throw invalidProvider();
    }
    return {absolutePath: candidate, handle, stats: openedStats};
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const openChildDirectoryAuthority = async (
  parent: DirectoryAuthority,
  candidate: string,
  pathStats: Stats,
  currentUid: number,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<DirectoryAuthority> => {
  if (path.dirname(candidate) !== parent.absolutePath) throw invalidProvider();
  requireOwnedDirectory(pathStats, currentUid);
  await requireDirectoryAuthorityStable(
    parent,
    currentUid,
    signal,
    dependencies,
  );
  const handle = await dependencies.open(
    candidate,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const openedStats = await handle.stat();
    if (!sameOwnedDirectory(pathStats, openedStats, currentUid)) {
      throw invalidProvider();
    }
    await requireDirectoryAuthorityStable(
      parent,
      currentUid,
      signal,
      dependencies,
    );
    const currentPathStats = await dependencies.lstat(candidate);
    if (!sameOwnedDirectory(openedStats, currentPathStats, currentUid)) {
      throw invalidProvider();
    }
    return {absolutePath: candidate, handle, stats: openedStats};
  } catch (error) {
    await handle.close();
    throw error;
  }
};

const readDirectoryNames = async (
  authority: DirectoryAuthority,
  currentUid: number,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<string[]> => {
  await requireDirectoryAuthorityStable(
    authority,
    currentUid,
    signal,
    dependencies,
  );
  const directory = await dependencies.opendir(
    directoryDescriptorPath(authority.handle),
  );
  const names: string[] = [];
  try {
    while (true) {
      throwIfDownloadCancelled(signal);
      const entry = await directory.read();
      if (entry === null) break;
      names.push(entry.name);
    }
  } finally {
    await directory.close();
  }
  await requireDirectoryAuthorityStable(
    authority,
    currentUid,
    signal,
    dependencies,
  );
  return names.sort();
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
  parent: DirectoryAuthority,
  candidate: string,
  pathStats: Stats,
  currentUid: number,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<string> => {
  await requireDirectoryAuthorityStable(
    parent,
    currentUid,
    signal,
    dependencies,
  );
  const handle = await dependencies.open(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES);
  try {
    const openedStats = await handle.stat();
    if (!sameRegularFile(pathStats, openedStats, currentUid, false)) {
      throw invalidProvider();
    }
    await requireDirectoryAuthorityStable(
      parent,
      currentUid,
      signal,
      dependencies,
    );
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
    const finalHandleStats = await handle.stat();
    await requireDirectoryAuthorityStable(
      parent,
      currentUid,
      signal,
      dependencies,
    );
    const finalPathStats = await dependencies.lstat(candidate);
    await requireDirectoryAuthorityStable(
      parent,
      currentUid,
      signal,
      dependencies,
    );
    if (
      !sameRegularFile(openedStats, finalHandleStats, currentUid, true)
      || !sameRegularFile(openedStats, finalPathStats, currentUid, true)
    ) {
      throw invalidProvider();
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
};

const sameRegularFile = (
  expected: Stats,
  actual: Stats,
  currentUid: number,
  requireStableContents: boolean,
): boolean => (
  !expected.isSymbolicLink()
  && expected.isFile()
  && !actual.isSymbolicLink()
  && actual.isFile()
  && expected.uid === currentUid
  && actual.uid === currentUid
  && actual.mode === expected.mode
  && actual.dev === expected.dev
  && actual.ino === expected.ino
  && (
    !requireStableContents
    || (
      actual.size === expected.size
      && actual.mtimeMs === expected.mtimeMs
      && actual.ctimeMs === expected.ctimeMs
    )
  )
);

const sameSymbolicLink = (
  expected: Stats,
  actual: Stats,
  currentUid: number,
): boolean => (
  expected.isSymbolicLink()
  && actual.isSymbolicLink()
  && expected.uid === currentUid
  && actual.uid === currentUid
  && actual.mode === expected.mode
  && actual.dev === expected.dev
  && actual.ino === expected.ino
  && actual.size === expected.size
  && actual.mtimeMs === expected.mtimeMs
  && actual.ctimeMs === expected.ctimeMs
);

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
  root: DirectoryAuthority,
  logicalRoot: string,
  currentUid: number,
  excludedDirectories: ReadonlySet<string>,
  signal: AbortSignal | undefined,
  dependencies: ProviderIntegrityDependencies,
): Promise<ActualTreeIdentity> => {
  const records: IntegrityRecord[] = [];

  const visitDirectory = async (
    directory: DirectoryAuthority,
    relativeDirectory: string,
  ): Promise<void> => {
    const names = await readDirectoryNames(
      directory,
      currentUid,
      signal,
      dependencies,
    );
    for (const name of names) {
      await requireDirectoryAuthorityStable(
        directory,
        currentUid,
        signal,
        dependencies,
      );
      const candidate = path.join(directory.absolutePath, name);
      const relativePath = relativeDirectory.length === 0
        ? name
        : `${relativeDirectory}/${name}`;
      const stats = await dependencies.lstat(candidate);
      await requireDirectoryAuthorityStable(
        directory,
        currentUid,
        signal,
        dependencies,
      );
      requireOwnedEntry(stats, currentUid);

      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        const child = await openChildDirectoryAuthority(
          directory,
          candidate,
          stats,
          currentUid,
          signal,
          dependencies,
        );
        try {
          if (!excludedDirectories.has(relativePath)) {
            await visitDirectory(child, relativePath);
          }
          await requireDirectoryAuthorityStable(
            child,
            currentUid,
            signal,
            dependencies,
          );
        } finally {
          await child.handle.close();
        }
        continue;
      }
      if (stats.isFile() && !stats.isSymbolicLink()) {
        const payload = await hashRegularFile(
          directory,
          candidate,
          stats,
          currentUid,
          signal,
          dependencies,
        );
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
        await requireDirectoryAuthorityStable(
          directory,
          currentUid,
          signal,
          dependencies,
        );
        const target = await dependencies.readlink(candidate);
        const finalStats = await dependencies.lstat(candidate);
        await requireDirectoryAuthorityStable(
          directory,
          currentUid,
          signal,
          dependencies,
        );
        if (
          !sameSymbolicLink(stats, finalStats, currentUid)
          || !targetStaysWithinRoot(logicalRoot, candidate, target)
        ) {
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
    await requireDirectoryAuthorityStable(
      directory,
      currentUid,
      signal,
      dependencies,
    );
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
    const providerRoot = await openRootDirectoryAuthority(
      providerDirectory,
      options.currentUid,
      options.signal,
      dependencies,
    );
    let serverDirectory: DirectoryAuthority | undefined;
    let nodeModulesRoot: DirectoryAuthority | undefined;
    let verificationError: unknown;
    let verificationFailed = false;
    try {
      const source = await measureTree(
        providerRoot,
        providerDirectory,
        options.currentUid,
        SOURCE_EXCLUDED_DIRECTORIES,
        options.signal,
        dependencies,
      );
      if (!treeIdentityMatches(source, options.identity.source)) {
        throw invalidProvider();
      }
      const serverPath = path.join(providerDirectory, 'server');
      await requireDirectoryAuthorityStable(
        providerRoot,
        options.currentUid,
        options.signal,
        dependencies,
      );
      const serverStats = await dependencies.lstat(serverPath);
      serverDirectory = await openChildDirectoryAuthority(
        providerRoot,
        serverPath,
        serverStats,
        options.currentUid,
        options.signal,
        dependencies,
      );
      const nodeModulesStats = await dependencies.lstat(nodeModulesDirectory);
      nodeModulesRoot = await openChildDirectoryAuthority(
        serverDirectory,
        nodeModulesDirectory,
        nodeModulesStats,
        options.currentUid,
        options.signal,
        dependencies,
      );
      const nodeModules = await measureTree(
        nodeModulesRoot,
        nodeModulesDirectory,
        options.currentUid,
        new Set(),
        options.signal,
        dependencies,
      );
      if (!treeIdentityMatches(nodeModules, options.identity.nodeModules)) {
        throw invalidProvider();
      }
      await requireDirectoryAuthorityStable(
        nodeModulesRoot,
        options.currentUid,
        options.signal,
        dependencies,
      );
      await requireDirectoryAuthorityStable(
        serverDirectory,
        options.currentUid,
        options.signal,
        dependencies,
      );
      await requireDirectoryAuthorityStable(
        providerRoot,
        options.currentUid,
        options.signal,
        dependencies,
      );
    } catch (error) {
      verificationError = error;
      verificationFailed = true;
    } finally {
      const closeResult = await closeDirectoryAuthorities([
        nodeModulesRoot,
        serverDirectory,
        providerRoot,
      ]);
      if (verificationFailed) throw verificationError;
      if (closeResult.failed) throw closeResult.error;
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
    const providerDirectoryStats = await dependencies.lstat(providerDirectory);
    requireOwnedDirectory(providerDirectoryStats, options.currentUid);
    const providerDirectoryHandle = await dependencies.open(
      providerDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const openedProviderDirectoryStats = await providerDirectoryHandle.stat();
      if (!sameOwnedDirectory(
        providerDirectoryStats,
        openedProviderDirectoryStats,
        options.currentUid,
      )) {
        throw invalidProvider();
      }
      const directoryChain = SETUP_CACHE_COMPONENTS.map((_, index) => path.join(
        providerDirectory,
        ...SETUP_CACHE_COMPONENTS.slice(0, index + 1),
      ));
      const directoryIdentities: ProviderEntryIdentity[] = [];
      for (const [index, candidate] of directoryChain.entries()) {
        throwIfDownloadCancelled(options.signal);
        let stats: Stats;
        try {
          stats = await dependencies.lstat(candidate);
        } catch (error) {
          if (
            index === SETUP_CACHE_COMPONENTS.length - 1
            && nodeErrorCode(error) === 'ENOENT'
          ) {
            return;
          }
          throw error;
        }
        requireOwnedDirectory(stats, options.currentUid);
        directoryIdentities.push(entryIdentity(stats, 'd'));
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
      await dependencies.unlinkSetupCache({
        providerDirectoryHandle,
        providerDirectoryIdentity: entryIdentity(
          openedProviderDirectoryStats,
          'd',
        ),
        directoryIdentities,
        setupCacheIdentity: entryIdentity(setupCacheStats, 'f'),
        ...(options.signal === undefined ? {} : {signal: options.signal}),
      });
      throwIfDownloadCancelled(options.signal);
    } finally {
      await providerDirectoryHandle.close();
    }
  } catch (error) {
    throwMappedProviderError(error, options.signal);
  }
};
