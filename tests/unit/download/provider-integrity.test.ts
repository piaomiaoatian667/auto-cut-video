import {execFile as execFileCallback} from 'node:child_process';
import {createHash} from 'node:crypto';
import type {Stats} from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
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
    mkdir(path.join(providerDirectory, 'bin'), {recursive: true}),
    mkdir(path.dirname(sourceImport), {recursive: true}),
    mkdir(moduleDirectory, {recursive: true}),
  ]);
  await Promise.all([
    writeFile(sourceFile, 'provider fixture\n', {mode: 0o600}),
    writeFile(
      path.join(providerDirectory, 'bin/provider'),
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

  it('maps filesystem errors to the fixed provider error', async () => {
    const fixture = await createProviderFixture();
    const privateMarker = 'private readdir failure';

    await expectProviderFailure(verifyFixture(fixture, canonicalIdentity, {
      dependencies: {
        readdir: async () => {
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
});
