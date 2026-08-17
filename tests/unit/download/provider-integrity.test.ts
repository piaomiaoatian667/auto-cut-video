import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open as openFile,
  opendir as openDirectory,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {
  normalizeProviderInstallation,
  verifyProviderIntegrity,
  type ProviderIntegrityIdentity,
} from '../../../src/download/toolchain/provider-integrity';

const execFile = promisify(execFileCallback);
const currentUid = typeof process.getuid === 'function' ? process.getuid() : 501;
const temporaryRoots: string[] = [];
const INVALID_PROVIDER_MESSAGE =
  'The YouTube compatibility provider is unavailable.';
const SOURCE_ROOT =
  '97ce970ecc65b28b6a0806d48c1e02c67ef92b73c74d3e4c3345af67da846fda';
const NODE_MODULES_ROOT =
  'f555b411f83a2c157e1556659417b573251ad5b9acc178d7b63028bb40fc1097';

const canonicalIdentity: ProviderIntegrityIdentity = {
  source: {entries: 3, sha256: SOURCE_ROOT},
  nodeModules: {
    entries: 3,
    files: 2,
    symlinks: 1,
    sha256: NODE_MODULES_ROOT,
  },
};

interface ProviderFixture {
  root: string;
  providerDirectory: string;
  nodeModulesDirectory: string;
  binDirectory: string;
  sourceFile: string;
  sourceImport: string;
  moduleFile: string;
  executableModule: string;
  moduleLink: string;
}

const createProviderFixture = async (): Promise<ProviderFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'provider-integrity-'));
  temporaryRoots.push(root);
  const providerDirectory = path.join(root, 'provider');
  const nodeModulesDirectory = path.join(
    providerDirectory,
    'server/node_modules',
  );
  const sourceFile = path.join(providerDirectory, 'README.md');
  const binDirectory = path.join(providerDirectory, 'bin');
  const sourceImport = path.join(
    providerDirectory,
    'server/src/generate_once.ts',
  );
  const moduleDirectory = path.join(
    nodeModulesDirectory,
    '.deno/pkg@1/node_modules/pkg',
  );
  const moduleFile = path.join(moduleDirectory, 'index.js');
  const executableModule = path.join(moduleDirectory, 'native.bin');
  const moduleLink = path.join(nodeModulesDirectory, 'pkg');

  await Promise.all([
    mkdir(path.join(providerDirectory, '.git/objects'), {recursive: true}),
    mkdir(binDirectory, {recursive: true}),
    mkdir(path.dirname(sourceImport), {recursive: true}),
    mkdir(moduleDirectory, {recursive: true}),
  ]);
  await Promise.all([
    writeFile(sourceFile, 'provider fixture\n', {mode: 0o600}),
    writeFile(
      path.join(binDirectory, 'provider'),
      '#!/bin/sh\nexit 0\n',
      {mode: 0o700},
    ),
    writeFile(sourceImport, "export const version = '1.3.1';\n", {
      mode: 0o600,
    }),
    writeFile(
      path.join(providerDirectory, '.git/HEAD'),
      '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0\n',
      {mode: 0o600},
    ),
    writeFile(
      path.join(providerDirectory, '.git/objects/private-object'),
      'excluded git object\n',
      {mode: 0o600},
    ),
    writeFile(moduleFile, 'export const value = 1;\n', {mode: 0o600}),
    writeFile(executableModule, 'native\n', {mode: 0o700}),
  ]);
  await symlink('.deno/pkg@1/node_modules/pkg', moduleLink);

  return {
    root,
    providerDirectory,
    nodeModulesDirectory,
    binDirectory,
    sourceFile,
    sourceImport,
    moduleFile,
    executableModule,
    moduleLink,
  };
};

const verifyFixture = async (
  fixture: ProviderFixture,
  identity: ProviderIntegrityIdentity = canonicalIdentity,
  options: {
    signal?: AbortSignal;
    dependencies?: Parameters<typeof verifyProviderIntegrity>[1];
  } = {},
): Promise<void> => await verifyProviderIntegrity({
  providerDirectory: fixture.providerDirectory,
  identity,
  currentUid,
  ...(options.signal === undefined ? {} : {signal: options.signal}),
}, options.dependencies);

const expectProviderFailure = async (
  pending: Promise<unknown>,
  privateMarkers: readonly string[] = [],
): Promise<void> => {
  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({
    name: 'DownloadError',
    code: 'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
    message: INVALID_PROVIDER_MESSAGE,
  });
  expect((caught as Error & {cause?: unknown}).cause).toBeUndefined();
  for (const marker of privateMarkers) {
    expect(String(caught)).not.toContain(marker);
  }
};

const sha256 = (value: string): string => createHash('sha256')
  .update(value)
  .digest('hex');

const serializeField = (value: string): string =>
  `${Buffer.byteLength(value)}:${value}`;

const nodeModulesIdentityWithLink = (
  target: string,
): ProviderIntegrityIdentity => {
  const records = [
    ['f', '.deno/pkg@1/node_modules/pkg/index.js', '000', sha256('export const value = 1;\n')],
    ['f', '.deno/pkg@1/node_modules/pkg/native.bin', '100', sha256('native\n')],
    ['l', 'pkg', '111', target],
  ].map((fields) => fields.map(serializeField).join('|'));
  return {
    source: canonicalIdentity.source,
    nodeModules: {
      entries: 3,
      files: 2,
      symlinks: 1,
      sha256: sha256(`${records.join('\n')}\n`),
    },
  };
};

const sourceIdentityWithReadme = (
  contents: string,
): ProviderIntegrityIdentity => {
  const records = [
    ['f', 'README.md', '000', sha256(contents)],
    ['f', 'bin/provider', '100', sha256('#!/bin/sh\nexit 0\n')],
    [
      'f',
      'server/src/generate_once.ts',
      '000',
      sha256("export const version = '1.3.1';\n"),
    ],
  ].map((fields) => fields.map(serializeField).join('|'));
  return {
    source: {
      entries: 3,
      sha256: sha256(`${records.join('\n')}\n`),
    },
    nodeModules: canonicalIdentity.nodeModules,
  };
};

const statsWithUid = (stats: Stats, uid: number): Stats => new Proxy(stats, {
  get(target, property) {
    if (property === 'uid') return uid;
    const value = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, {recursive: true, force: true});
  }));
});

describe('provider integrity verifier', () => {
  it('accepts a clean canonical source and node_modules fixture', async () => {
    const fixture = await createProviderFixture();

    await expect(verifyFixture(fixture)).resolves.toBeUndefined();
  });

  it.each([
    ['modified source content', async (fixture: ProviderFixture) => {
      await writeFile(fixture.sourceFile, 'tampered source\n');
    }],
    ['added source module', async (fixture: ProviderFixture) => {
      await writeFile(
        path.join(fixture.providerDirectory, 'server/src/extra.ts'),
        'export {};\n',
      );
    }],
    ['removed source import', async (fixture: ProviderFixture) => {
      await rm(fixture.sourceImport);
    }],
    ['modified node_modules content', async (fixture: ProviderFixture) => {
      await writeFile(fixture.moduleFile, 'tampered module\n');
    }],
    ['added node_modules entry', async (fixture: ProviderFixture) => {
      await writeFile(
        path.join(fixture.nodeModulesDirectory, 'unexpected.js'),
        'export {};\n',
      );
    }],
    ['removed node_modules entry', async (fixture: ProviderFixture) => {
      await rm(fixture.moduleFile);
    }],
    ['changed executable bits', async (fixture: ProviderFixture) => {
      await chmod(fixture.executableModule, 0o600);
    }],
  ])('rejects %s', async (_caseName, mutate) => {
    const fixture = await createProviderFixture();
    await mutate(fixture);

    await expectProviderFailure(verifyFixture(fixture));
  });

  it.each([
    ['absolute', '/private/provider-escape'],
    ['escaping', '../../../../provider-escape'],
  ])('rejects a matching-root %s symlink target', async (_caseName, target) => {
    const fixture = await createProviderFixture();
    await unlink(fixture.moduleLink);
    await symlink(target, fixture.moduleLink);

    await expectProviderFailure(
      verifyFixture(fixture, nodeModulesIdentityWithLink(target)),
      [target],
    );
  });

  it('rejects a special filesystem entry', async () => {
    const fixture = await createProviderFixture();
    const fifo = path.join(fixture.nodeModulesDirectory, 'private-fifo');
    await execFile('/usr/bin/mkfifo', [fifo]);

    await expectProviderFailure(verifyFixture(fixture), [fifo]);
  });

  it('rejects a foreign-owned entry', async () => {
    const fixture = await createProviderFixture();

    await expectProviderFailure(verifyFixture(fixture, canonicalIdentity, {
      dependencies: {
        lstat: async (candidate) => {
          const stats = await lstat(candidate);
          return candidate === fixture.sourceFile
            ? statsWithUid(stats, currentUid + 1)
            : stats;
        },
      },
    }));
  });

  it.each(['absolute', 'escaping'] as const)(
    'rejects a source directory replaced by an %s symlink after lstat',
    async (targetKind) => {
      const fixture = await createProviderFixture();
      const outsideBin = path.join(fixture.root, 'outside-bin');
      const outsideProvider = path.join(outsideBin, 'provider');
      await mkdir(outsideBin);
      await writeFile(outsideProvider, '#!/bin/sh\nexit 0\n', {mode: 0o700});
      const outsideStats = await lstat(outsideProvider);
      const target = targetKind === 'absolute'
        ? outsideBin
        : path.relative(path.dirname(fixture.binDirectory), outsideBin);
      let replaced = false;
      let outsideRead = false;

      await expectProviderFailure(verifyFixture(fixture, canonicalIdentity, {
        dependencies: {
          lstat: async (candidate) => {
            const stats = await lstat(candidate);
            if (candidate === fixture.binDirectory && !replaced) {
              replaced = true;
              await rm(fixture.binDirectory, {recursive: true});
              await symlink(target, fixture.binDirectory);
            }
            return stats;
          },
          open: async (candidate, flags) => {
            const handle = await openFile(candidate, flags);
            const openedStats = await handle.stat();
            if (
              openedStats.dev === outsideStats.dev
              && openedStats.ino === outsideStats.ino
            ) {
              outsideRead = true;
            }
            return handle;
          },
        },
      }), [target, outsideProvider]);
      expect(replaced).toBe(true);
      expect(outsideRead).toBe(false);
      await expect(readFile(outsideProvider, 'utf8'))
        .resolves.toBe('#!/bin/sh\nexit 0\n');
    },
  );

  it('rejects a source directory replaced before enumeration', async () => {
    const fixture = await createProviderFixture();
    const outsideBin = path.join(fixture.root, 'outside-bin');
    const outsideProvider = path.join(outsideBin, 'provider');
    const originalBin = path.join(fixture.providerDirectory, 'bin-original');
    await mkdir(outsideBin);
    await writeFile(outsideProvider, '#!/bin/sh\nexit 0\n', {mode: 0o700});
    const outsideStats = await lstat(outsideProvider);
    let replaced = false;
    let outsideRead = false;
    let binDirectoryDescriptor: number | undefined;

    await expectProviderFailure(verifyFixture(fixture, canonicalIdentity, {
      dependencies: {
        opendir: async (candidate) => {
          if (
            binDirectoryDescriptor !== undefined
            && candidate === `/dev/fd/${binDirectoryDescriptor}`
            && !replaced
          ) {
            replaced = true;
            await rename(fixture.binDirectory, originalBin);
            await symlink(outsideBin, fixture.binDirectory);
          }
          return await openDirectory(candidate);
        },
        open: async (candidate, flags) => {
          const handle = await openFile(candidate, flags);
          if (candidate === fixture.binDirectory) {
            binDirectoryDescriptor = handle.fd;
          }
          const openedStats = await handle.stat();
          if (
            openedStats.dev === outsideStats.dev
            && openedStats.ino === outsideStats.ino
          ) {
            outsideRead = true;
          }
          return handle;
        },
      },
    }), [outsideBin, outsideProvider]);
    expect(binDirectoryDescriptor).toBeDefined();
    expect(replaced).toBe(true);
    expect(outsideRead).toBe(false);
  });

  it('does not follow a file replaced by a symlink between lstat and open', async () => {
    const fixture = await createProviderFixture();
    const outsideFile = path.join(fixture.root, 'outside-provider-source');
    const outsideContents = 'outside private source\n';
    await writeFile(outsideFile, outsideContents);
    const outsideStats = await lstat(outsideFile);
    let replaced = false;
    let outsideRead = false;

    await expectProviderFailure(verifyFixture(
      fixture,
      sourceIdentityWithReadme(outsideContents),
      {
        dependencies: {
          lstat: async (candidate) => {
            const stats = await lstat(candidate);
            if (candidate === fixture.sourceFile && !replaced) {
              replaced = true;
              await unlink(candidate);
              await symlink(outsideFile, candidate);
            }
            return stats;
          },
          open: async (candidate, flags) => {
            const handle = await openFile(candidate, flags);
            const openedStats = await handle.stat();
            outsideRead = openedStats.dev === outsideStats.dev
              && openedStats.ino === outsideStats.ino;
            return handle;
          },
        },
      },
    ));
    expect(outsideRead).toBe(false);
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe(outsideContents);
  });

  it('rejects a different inode opened after the path lstat', async () => {
    const fixture = await createProviderFixture();
    const replacement = path.join(fixture.root, 'replacement-provider-source');
    const replacementContents = 'replacement provider source\n';
    await writeFile(replacement, replacementContents);
    let replaced = false;

    await expectProviderFailure(verifyFixture(
      fixture,
      sourceIdentityWithReadme(replacementContents),
      {
        dependencies: {
          lstat: async (candidate) => {
            const stats = await lstat(candidate);
            if (candidate === fixture.sourceFile && !replaced) {
              replaced = true;
              await unlink(candidate);
              await rename(replacement, candidate);
            }
            return stats;
          },
        },
      },
    ));
  });

  it('rejects a path replaced with another inode while reading', async () => {
    const fixture = await createProviderFixture();
    const replacement = path.join(fixture.root, 'replacement-provider-source');
    await writeFile(replacement, 'replacement provider source\n');
    let replaced = false;

    await expectProviderFailure(verifyFixture(fixture, canonicalIdentity, {
      dependencies: {
        open: async (candidate, flags) => {
          const handle = await openFile(candidate, flags);
          if (candidate !== fixture.sourceFile) return handle;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'read') {
                return async (...args: Parameters<typeof target.read>) => {
                  const result = await target.read(...args);
                  if (!replaced) {
                    replaced = true;
                    await unlink(candidate);
                    await rename(replacement, candidate);
                  }
                  return result;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      },
    }));
  });

  it('maps filesystem errors to the fixed provider error', async () => {
    const fixture = await createProviderFixture();
    const privateMarker = 'private opendir failure';

    await expectProviderFailure(verifyFixture(fixture, canonicalIdentity, {
      dependencies: {
        opendir: async () => {
          throw new Error(privateMarker);
        },
      },
    }), [privateMarker, fixture.providerDirectory]);
  });

  it('preserves cancellation with the existing sanitized semantics', async () => {
    const fixture = await createProviderFixture();
    const controller = new AbortController();
    const privateReason = 'private verifier cancellation';

    let caught: unknown;
    try {
      await verifyFixture(fixture, canonicalIdentity, {
        signal: controller.signal,
        dependencies: {
          lstat: async (candidate) => {
            const stats = await lstat(candidate);
            if (candidate === fixture.sourceFile) {
              controller.abort(new Error(privateReason));
            }
            return stats;
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: 'DownloadCancellationError',
      message: 'The download operation was cancelled.',
    });
    expect(`${String(caught)}${JSON.stringify(caught)}`).not.toContain(
      privateReason,
    );
  });
});

describe('provider installation normalization', () => {
  it('allows the descriptor-bound unlink primitive to be injected', async () => {
    const fixture = await createProviderFixture();
    const setupCache = path.join(
      fixture.nodeModulesDirectory,
      '.deno/.setup-cache.bin',
    );
    await writeFile(setupCache, 'unstable-cache-bytes');
    let unlinkCalls = 0;

    await normalizeProviderInstallation({
      providerDirectory: fixture.providerDirectory,
      currentUid,
    }, {
      unlinkSetupCache: async (options) => {
        unlinkCalls += 1;
        expect(options.providerDirectoryHandle.fd).toBeGreaterThan(2);
        expect(options.directoryIdentities).toHaveLength(3);
        await unlink(setupCache);
      },
    });

    expect(unlinkCalls).toBe(1);
    await expect(lstat(setupCache)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('removes only the unstable Deno setup cache before verification', async () => {
    const fixture = await createProviderFixture();
    const setupCache = path.join(
      fixture.nodeModulesDirectory,
      '.deno/.setup-cache.bin',
    );
    await writeFile(setupCache, 'unstable-cache-bytes');

    await normalizeProviderInstallation({
      providerDirectory: fixture.providerDirectory,
      currentUid,
    });

    await expect(lstat(setupCache)).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readFile(fixture.moduleFile, 'utf8'))
      .resolves.toBe('export const value = 1;\n');
    await expect(verifyFixture(fixture)).resolves.toBeUndefined();
  });

  it('does not follow a symlinked setup-cache parent', async () => {
    const fixture = await createProviderFixture();
    const denoDirectory = path.join(fixture.nodeModulesDirectory, '.deno');
    const outsideDirectory = path.join(fixture.root, 'outside-deno');
    const outsideCache = path.join(outsideDirectory, '.setup-cache.bin');
    await rm(denoDirectory, {recursive: true});
    await mkdir(outsideDirectory);
    await writeFile(outsideCache, 'outside cache');
    await symlink(outsideDirectory, denoDirectory);

    await expectProviderFailure(normalizeProviderInstallation({
      providerDirectory: fixture.providerDirectory,
      currentUid,
    }), [outsideDirectory, outsideCache]);
    await expect(readFile(outsideCache, 'utf8')).resolves.toBe('outside cache');
  });

  it('rejects a setup-cache parent replaced after validation', async () => {
    const fixture = await createProviderFixture();
    const denoDirectory = path.join(fixture.nodeModulesDirectory, '.deno');
    const setupCache = path.join(denoDirectory, '.setup-cache.bin');
    const outsideDirectory = path.join(fixture.root, 'outside-deno');
    const outsideCache = path.join(outsideDirectory, '.setup-cache.bin');
    await mkdir(outsideDirectory);
    await writeFile(setupCache, 'inside cache');
    await writeFile(outsideCache, 'outside cache');
    let replaced = false;

    await expectProviderFailure(normalizeProviderInstallation({
      providerDirectory: fixture.providerDirectory,
      currentUid,
    }, {
      lstat: async (candidate) => {
        const stats = await lstat(candidate);
        if (candidate === setupCache && !replaced) {
          replaced = true;
          await rm(denoDirectory, {recursive: true});
          await symlink(outsideDirectory, denoDirectory);
        }
        return stats;
      },
    }), [outsideDirectory, outsideCache]);
    await expect(readFile(outsideCache, 'utf8')).resolves.toBe('outside cache');
  });

  it('rejects a setup-cache file replaced after validation', async () => {
    const fixture = await createProviderFixture();
    const setupCache = path.join(
      fixture.nodeModulesDirectory,
      '.deno/.setup-cache.bin',
    );
    const outsideCache = path.join(fixture.root, 'outside-setup-cache');
    await writeFile(setupCache, 'inside cache');
    await writeFile(outsideCache, 'outside cache');
    let replaced = false;

    await expectProviderFailure(normalizeProviderInstallation({
      providerDirectory: fixture.providerDirectory,
      currentUid,
    }, {
      lstat: async (candidate) => {
        const stats = await lstat(candidate);
        if (candidate === setupCache && !replaced) {
          replaced = true;
          await unlink(setupCache);
          await symlink(outsideCache, setupCache);
        }
        return stats;
      },
    }), [outsideCache]);
    await expect(readFile(outsideCache, 'utf8')).resolves.toBe('outside cache');
  });
});
