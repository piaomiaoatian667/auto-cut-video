import {describe, expect, it} from 'vitest';
import {
  DOWNLOADER_TOOLCHAIN_MANIFEST,
  installedManifestForPinnedToolchain,
  parseDownloaderToolchainManifest,
} from '../../../src/download/toolchain/manifest';

const INVALID_TOOLCHAIN_MESSAGE =
  'The managed downloader failed integrity or capability checks.';

const validManifest = () => ({
  schemaVersion: 1,
  platform: 'darwin-arm64',
  ytDlp: {
    version: '2026.07.04',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos',
    bytes: 38256544,
    sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
  },
  potPlugin: {
    version: '1.3.1',
    url: 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.1/bgutil-ytdlp-pot-provider.zip',
    bytes: 8067,
    sha256: 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38',
  },
  potProvider: {
    repository: 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git',
    version: '1.3.1',
    commit: '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0',
    integrity: {
      source: {
        entries: 30,
        sha256: '1307dade1714cac0f6569377a5930be39b02ec719b0179f77de773c753c6bbf2',
      },
      nodeModules: {
        entries: 9715,
        files: 8906,
        symlinks: 809,
        sha256: 'f2606eacd44bbf1a9c071f52a8bffbfc1298c3b3cd58ffa713efb06ffc15ae36',
      },
    },
  },
});

const withYtDlp = (
  replacement: Partial<ReturnType<typeof validManifest>['ytDlp']>,
) => {
  const manifest = validManifest();
  return {...manifest, ytDlp: {...manifest.ytDlp, ...replacement}};
};

const withPotPlugin = (
  replacement: Partial<ReturnType<typeof validManifest>['potPlugin']>,
) => {
  const manifest = validManifest();
  return {...manifest, potPlugin: {...manifest.potPlugin, ...replacement}};
};

const withPotProvider = (
  replacement: Partial<ReturnType<typeof validManifest>['potProvider']>,
) => {
  const manifest = validManifest();
  return {...manifest, potProvider: {...manifest.potProvider, ...replacement}};
};

const expectInvalidManifest = (manifest: unknown): Error => {
  try {
    parseDownloaderToolchainManifest(manifest);
  } catch (error) {
    expect(error).toMatchObject({
      code: 'DOWNLOAD_TOOLCHAIN_INVALID',
      message: INVALID_TOOLCHAIN_MESSAGE,
    });
    expect(String(error)).toBe(`DownloadError: ${INVALID_TOOLCHAIN_MESSAGE}`);
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('Expected DOWNLOAD_TOOLCHAIN_INVALID.');
};

describe('managed downloader toolchain manifest', () => {
  it('pins the exact downloader toolchain identity', () => {
    expect(DOWNLOADER_TOOLCHAIN_MANIFEST).toEqual(validManifest());
  });

  it('builds the exact installed manifest identity', () => {
    expect(installedManifestForPinnedToolchain()).toEqual({
      schemaVersion: 1,
      platform: 'darwin-arm64',
      ytDlp: {
        version: '2026.07.04',
        bytes: 38256544,
        sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b',
      },
      potPlugin: {
        version: '1.3.1',
        bytes: 8067,
        sha256: 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38',
      },
      potProvider: {
        version: '1.3.1',
        commit: '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0',
        integrity: {
          source: {
            entries: 30,
            sha256: '1307dade1714cac0f6569377a5930be39b02ec719b0179f77de773c753c6bbf2',
          },
          nodeModules: {
            entries: 9715,
            files: 8906,
            symlinks: 809,
            sha256: 'f2606eacd44bbf1a9c071f52a8bffbfc1298c3b3cd58ffa713efb06ffc15ae36',
          },
        },
      },
    });
  });

  it('parses the pinned manifest shape', () => {
    const manifest = validManifest();
    expect(parseDownloaderToolchainManifest(manifest)).toEqual(manifest);
  });

  it.each([
    [
      'yt-dlp URL path',
      withYtDlp({
        url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/private-marker',
      }),
    ],
    [
      'yt-dlp URL credentials',
      withYtDlp({
        url: 'https://private-marker@github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos',
      }),
    ],
    [
      'yt-dlp URL port',
      withYtDlp({
        url: 'https://github.com:8443/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos',
      }),
    ],
    [
      'yt-dlp URL query',
      withYtDlp({url: `${validManifest().ytDlp.url}?private-marker=1`}),
    ],
    [
      'yt-dlp URL fragment',
      withYtDlp({url: `${validManifest().ytDlp.url}#private-marker`}),
    ],
    [
      'allowlisted redirect URL',
      withYtDlp({
        url: 'https://release-assets.githubusercontent.com/private-marker',
      }),
    ],
    [
      'plugin URL path',
      withPotPlugin({
        url: 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.1/private-marker.zip',
      }),
    ],
  ])('rejects a replacement %s without echoing it', (_caseName, manifest) => {
    const error = expectInvalidManifest(manifest);
    expect(String(error)).not.toContain('private-marker');
  });

  it.each([
    ['yt-dlp version', withYtDlp({version: '2026.07.05'})],
    ['plugin version', withPotPlugin({version: '1.3.2'})],
    ['provider version', withPotProvider({version: '1.3.2'})],
  ])('rejects a replacement %s', (_caseName, manifest) => {
    expectInvalidManifest(manifest);
  });

  it.each([
    ['yt-dlp byte size', withYtDlp({bytes: 38256545})],
    ['plugin byte size', withPotPlugin({bytes: 8068})],
  ])('rejects a replacement %s', (_caseName, manifest) => {
    expectInvalidManifest(manifest);
  });

  it.each([
    ['yt-dlp digest', withYtDlp({sha256: 'a'.repeat(64)})],
    ['plugin digest', withPotPlugin({sha256: 'a'.repeat(64)})],
  ])('rejects a replacement valid lowercase %s', (_caseName, manifest) => {
    expectInvalidManifest(manifest);
  });

  it('rejects a replacement allowlisted provider repository', () => {
    expectInvalidManifest(withPotProvider({
      repository: 'https://github.com/Brainicism/private-marker.git',
    }));
  });

  it('rejects a replacement valid lowercase provider commit', () => {
    expectInvalidManifest(withPotProvider({commit: 'a'.repeat(40)}));
  });

  it.each([
    [
      'source entry count',
      {source: {...validManifest().potProvider.integrity.source, entries: 31}},
    ],
    [
      'source root',
      {source: {...validManifest().potProvider.integrity.source, sha256: 'a'.repeat(64)}},
    ],
    [
      'node_modules entry count',
      {
        nodeModules: {
          ...validManifest().potProvider.integrity.nodeModules,
          entries: 9716,
        },
      },
    ],
    [
      'node_modules file count',
      {
        nodeModules: {
          ...validManifest().potProvider.integrity.nodeModules,
          files: 8905,
        },
      },
    ],
    [
      'node_modules symlink count',
      {
        nodeModules: {
          ...validManifest().potProvider.integrity.nodeModules,
          symlinks: 810,
        },
      },
    ],
    [
      'node_modules root',
      {
        nodeModules: {
          ...validManifest().potProvider.integrity.nodeModules,
          sha256: 'a'.repeat(64),
        },
      },
    ],
  ])('rejects a replacement provider %s', (_caseName, replacement) => {
    const manifest = validManifest();
    expectInvalidManifest(withPotProvider({
      integrity: {
        ...manifest.potProvider.integrity,
        ...replacement,
      },
    }));
  });

  it.each([
    ['top-level key', {...validManifest(), unexpected: true}],
    [
      'asset key',
      {
        ...validManifest(),
        ytDlp: {...validManifest().ytDlp, unexpected: true},
      },
    ],
    [
      'provider key',
      {
        ...validManifest(),
        potProvider: {...validManifest().potProvider, unexpected: true},
      },
    ],
    [
      'provider integrity key',
      {
        ...validManifest(),
        potProvider: {
          ...validManifest().potProvider,
          integrity: {
            ...validManifest().potProvider.integrity,
            unexpected: true,
          },
        },
      },
    ],
  ])('rejects an unexpected %s', (_caseName, manifest) => {
    expectInvalidManifest(manifest);
  });

  it('rejects schema version 2', () => {
    expectInvalidManifest({...validManifest(), schemaVersion: 2});
  });

  it('rejects a non-Darwin platform', () => {
    expectInvalidManifest({...validManifest(), platform: 'linux-x64'});
  });

  it.each([
    [
      'yt-dlp asset',
      {
        ...validManifest(),
        ytDlp: {
          ...validManifest().ytDlp,
          url: 'http://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos',
        },
      },
    ],
    [
      'provider repository',
      {
        ...validManifest(),
        potProvider: {
          ...validManifest().potProvider,
          repository: 'http://github.com/Brainicism/bgutil-ytdlp-pot-provider.git',
        },
      },
    ],
  ])('rejects an HTTP %s URL', (_caseName, manifest) => {
    expectInvalidManifest(manifest);
  });

  it('rejects a malformed URL with the fixed public error', () => {
    const manifest = validManifest();
    const error = expectInvalidManifest({
      ...manifest,
      ytDlp: {...manifest.ytDlp, url: 'private-marker-not-a-url'},
    });
    expect(String(error)).not.toContain('private-marker');
  });

  it.each([
    [
      'plugin asset',
      {
        ...validManifest(),
        potPlugin: {
          ...validManifest().potPlugin,
          url: 'https://downloads.example.test/bgutil-ytdlp-pot-provider.zip',
        },
      },
    ],
    [
      'provider repository',
      {
        ...validManifest(),
        potProvider: {
          ...validManifest().potProvider,
          repository: 'https://private-marker.example.test/provider.git',
        },
      },
    ],
  ])('rejects a non-allowlisted %s host', (_caseName, manifest) => {
    const error = expectInvalidManifest(manifest);
    expect(String(error)).not.toContain('private-marker');
  });

  it.each(['ytDlp', 'potPlugin'] as const)(
    'rejects zero bytes for %s',
    (assetName) => {
      const manifest = validManifest();
      expectInvalidManifest({
        ...manifest,
        [assetName]: {...manifest[assetName], bytes: 0},
      });
    },
  );

  it('rejects an uppercase SHA-256 digest', () => {
    const manifest = validManifest();
    expectInvalidManifest({
      ...manifest,
      ytDlp: {...manifest.ytDlp, sha256: manifest.ytDlp.sha256.toUpperCase()},
    });
  });

  it('rejects a malformed SHA-256 digest', () => {
    const manifest = validManifest();
    expectInvalidManifest({
      ...manifest,
      potPlugin: {...manifest.potPlugin, sha256: 'not-a-sha256'},
    });
  });

  it('rejects a provider commit that is not 40 characters', () => {
    const manifest = validManifest();
    expectInvalidManifest({
      ...manifest,
      potProvider: {...manifest.potProvider, commit: 'a'.repeat(39)},
    });
  });
});
