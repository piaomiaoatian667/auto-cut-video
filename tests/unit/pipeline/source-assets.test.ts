import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink as createSymlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {ProjectInputs} from '../../../src/domain/load-project';
import {
  createProjectDirectoryScope,
  type ProjectDirectoryScope,
} from '../../../src/fs/project-paths';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {
  createSystemSourceCatalogDependencies,
  discoverProjectSourceCatalog,
  type SourceCatalogDependencies,
} from '../../../src/pipeline/source-assets';
import {
  createProjectFixture,
  createScriptFixture,
} from '../../helpers/temp-project';

const projectDirectory = {} as ProjectDirectoryScope;
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) => {
    await rm(directory, {recursive: true, force: true});
  }));
});

const clipBase = {
  startFrame: 0,
  durationInFrames: 30,
  fit: 'contain' as const,
  position: {x: 0, y: 0},
  scale: 1,
  opacity: 1,
  fadeInFrames: 0,
  fadeOutFrames: 0,
  zIndex: 0,
};

const projectInputs: ProjectInputs = {
  workspaceRoot: '/workspace',
  projectDirectory,
  project: createProjectFixture(),
  script: createScriptFixture(),
  edit: {
    version: 1,
    visualClips: [
      {
        ...clipBase,
        id: 'camera-shot',
        kind: 'video',
        assetId: 'camera-a',
        sourceInMs: 0,
        sourceOutMs: 1_000,
      },
      {
        ...clipBase,
        id: 'cover-shot',
        kind: 'image',
        assetId: 'cover',
      },
      {
        ...clipBase,
        id: 'camera-repeat',
        kind: 'video',
        assetId: 'camera-a',
        startFrame: 30,
        sourceInMs: 1_000,
        sourceOutMs: 2_000,
      },
    ],
    overlays: [],
    backgroundMusic: {assetId: 'music-main', startMs: 0},
  },
};

interface FakeFile {
  kind: 'file';
  sizeBytes: number;
  sha256: string;
}

interface FakeSymlink {
  kind: 'symlink';
}

type FakeSourceNode = FakeFile | FakeSymlink;

const file = (sizeBytes: number, sha256: string): FakeFile => ({
  kind: 'file',
  sizeBytes,
  sha256,
});

const symlink = (): FakeSymlink => ({kind: 'symlink'});

const fakeSourceTree = (
  nodes: Readonly<Record<string, FakeSourceNode>>,
): SourceCatalogDependencies => ({
  listSourceFiles: vi.fn(async () => {
    if (Object.values(nodes).some((node) => node.kind === 'symlink')) {
      throw new Error('unsafe source entry');
    }
    return Object.entries(nodes).map(([sourcePath, node]) => {
      if (node.kind !== 'file') throw new Error('unreachable');
      return {sourcePath, sizeBytes: node.sizeBytes};
    });
  }),
  hashProjectFile: vi.fn(async (_scope, sourcePath) => {
    const node = nodes[sourcePath];
    if (node?.kind !== 'file') throw new Error('missing source file');
    return node.sha256;
  }),
});

const createSystemSourceProject = async (): Promise<{
  project: ProjectInputs;
  cameraPath: string;
  originalCameraPath: string;
}> => {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'source-identity-'));
  tempDirectories.push(workspaceRoot);
  const sourceRoot = path.join(workspaceRoot, 'projects', 'demo', 'assets', 'source');
  await mkdir(path.join(sourceRoot, 'nested'), {recursive: true});
  const cameraPath = path.join(sourceRoot, 'camera-a.mp4');
  const originalCameraPath = path.join(sourceRoot, 'camera-original.mp4');
  await Promise.all([
    writeFile(cameraPath, 'camera-old'),
    writeFile(path.join(sourceRoot, 'nested', 'cover.png'), 'cover'),
    writeFile(path.join(sourceRoot, 'music-main.wav'), 'music'),
  ]);
  return {
    project: {
      ...projectInputs,
      workspaceRoot,
      projectDirectory: await createProjectDirectoryScope(workspaceRoot, 'demo'),
    },
    cameraPath,
    originalCameraPath,
  };
};

describe('discoverProjectSourceCatalog', () => {
  it('resolves referenced EDL assets by unique filename stem', async () => {
    const catalog = await discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/voice/intro.wav': file(40, 'sha256:voice'),
      'assets/source/music-main.wav': file(30, 'sha256:music'),
      'assets/source/nested/cover.png': file(20, 'sha256:cover'),
      'assets/source/camera-a.mp4': file(10, 'sha256:camera-a'),
    }));

    expect(catalog.assets).toEqual([
      {
        assetId: 'camera-a',
        kind: 'video',
        sourcePath: 'assets/source/camera-a.mp4',
        sizeBytes: 10,
        sha256: 'sha256:camera-a',
      },
      {
        assetId: 'cover',
        kind: 'image',
        sourcePath: 'assets/source/nested/cover.png',
        sizeBytes: 20,
        sha256: 'sha256:cover',
      },
      {
        assetId: 'music-main',
        kind: 'audio',
        sourcePath: 'assets/source/music-main.wav',
        sizeBytes: 30,
        sha256: 'sha256:music',
      },
    ]);
    expect(catalog.totalBytes).toBe(100);
    expect(catalog.fingerprint).toBe(fingerprintValue({assets: catalog.assets}));
  });

  it('rejects two files with the same referenced stem', async () => {
    await expect(discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/camera-a.mp4': file(10, 'sha256:a'),
      'assets/source/archive/camera-a.mov': file(10, 'sha256:b'),
      'assets/source/cover.png': file(20, 'sha256:cover'),
      'assets/source/music-main.wav': file(30, 'sha256:music'),
    }))).rejects.toMatchObject({code: 'PROJECT_SOURCE_AMBIGUOUS'});
  });

  it('rejects a missing referenced EDL asset', async () => {
    await expect(discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/camera-a.mp4': file(10, 'sha256:camera-a'),
      'assets/source/cover.png': file(20, 'sha256:cover'),
    }))).rejects.toMatchObject({code: 'PROJECT_SOURCE_MISSING'});
  });

  it('fails closed on symlinks below assets/source', async () => {
    await expect(discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/camera-a.mp4': symlink(),
    }))).rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});
  });

  it('rejects one asset ID used as different source kinds', async () => {
    const conflictingProject: ProjectInputs = {
      ...projectInputs,
      edit: {
        ...projectInputs.edit,
        backgroundMusic: {assetId: 'camera-a', startMs: 0},
      },
    };
    const dependencies = fakeSourceTree({});

    await expect(discoverProjectSourceCatalog(conflictingProject, dependencies))
      .rejects.toMatchObject({code: 'PROJECT_SOURCE_KIND_CONFLICT'});
    expect(dependencies.listSourceFiles).not.toHaveBeenCalled();
  });

  it('rejects a source byte total above Number.MAX_SAFE_INTEGER', async () => {
    await expect(discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/camera-a.mp4': file(
        Number.MAX_SAFE_INTEGER,
        'sha256:camera-a',
      ),
      'assets/source/cover.png': file(1, 'sha256:cover'),
      'assets/source/music-main.wav': file(0, 'sha256:music'),
    }))).rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});
  });

  it.each(['regular file', 'internal symlink'] as const)(
    'rejects an inventoried file replaced by a %s before hashing',
    async (replacement) => {
      const {project, cameraPath, originalCameraPath} =
        await createSystemSourceProject();
      const system = createSystemSourceCatalogDependencies();
      const dependencies: SourceCatalogDependencies = {
        listSourceFiles: async (scope) => {
          const files = await system.listSourceFiles(scope);
          await rename(cameraPath, originalCameraPath);
          if (replacement === 'regular file') {
            await writeFile(cameraPath, 'camera-new');
          } else {
            await createSymlink(path.basename(originalCameraPath), cameraPath);
          }
          return files;
        },
        hashProjectFile: system.hashProjectFile,
      };

      await expect(discoverProjectSourceCatalog(project, dependencies))
        .rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});
    },
  );
});
