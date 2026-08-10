import {closeSync, fstatSync} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, onTestFinished, vi} from 'vitest';
import {
  createRunStore,
  ensureRunDirectory,
  openExistingRunFile,
  openNewRunFile,
} from '../../../src/fs/app-directory-scopes';
import {
  createProjectDirectoryScope,
  openExistingProjectFile,
} from '../../../src/fs/project-paths';
import {
  decideVideoCompatibility,
  parseFfprobeJson,
} from '../../../src/media/ffprobe';
import {
  IngestManifestSchema,
  createSystemIngestDependencies,
  runIngest,
  type IngestDependencies,
  type IngestInput,
} from '../../../src/pipeline/stages/ingest';
import {
  runProcess,
  type RunProcessOptions,
} from '../../../src/process/run-process';
import {
  createTestImage,
  createTestMusic,
  createTestMusicWithCover,
  createTestVideo,
  createZeroDurationAac,
} from '../../helpers/media-fixtures';
import {createTempProject} from '../../helpers/temp-project';

const FFMPEG_EXECUTABLE = process.env.FFMPEG_PATH ?? '/opt/homebrew/bin/ffmpeg';
const FFPROBE_EXECUTABLE = process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe';

const makeProject = async (runId = 'ingest-run') => {
  const fixture = await createTempProject({tempPrefix: 'ingest-project-'});
  onTestFinished(fixture.cleanup);
  await mkdir(path.join(fixture.projectRoot, 'assets', 'source'), {recursive: true});
  return {
    ...fixture,
    projectDirectory: await createProjectDirectoryScope(fixture.workspaceRoot, 'demo'),
    runDirectory: await createRunStore(fixture.workspaceRoot).createRun('demo', runId),
  };
};

const inputFor = (
  project: Awaited<ReturnType<typeof makeProject>>,
  assets: IngestInput['assets'],
): IngestInput => ({
  projectDirectory: project.projectDirectory,
  runDirectory: project.runDirectory,
  assets,
  ffmpegExecutable: FFMPEG_EXECUTABLE,
  ffprobeExecutable: FFPROBE_EXECUTABLE,
});

const readHandle = async (handle: FileHandle): Promise<Buffer> => {
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
};

const readRunJson = async (
  runDirectory: Awaited<ReturnType<ReturnType<typeof createRunStore>['createRun']>>,
  relativePath: string,
): Promise<unknown> => JSON.parse((await readHandle(
  await openExistingRunFile(runDirectory, relativePath),
)).toString('utf8'));

const expectMissingManifest = async (
  runDirectory: Awaited<ReturnType<ReturnType<typeof createRunStore>['createRun']>>,
): Promise<void> => {
  await expect(openExistingRunFile(runDirectory, 'asset-manifest.json'))
    .rejects.toMatchObject({code: 'ENOENT'});
};

const probeRunFile = async (
  runDirectory: Awaited<ReturnType<ReturnType<typeof createRunStore>['createRun']>>,
  relativePath: string,
) => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    const result = await runProcess(FFPROBE_EXECUTABLE, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    return parseFfprobeJson(result.stdout);
  } finally {
    await handle.close();
  }
};

const closedHandle = async (handle: FileHandle): Promise<void> => {
  await expect(handle.stat()).rejects.toMatchObject({code: 'EBADF'});
};

type ManifestFaultPhase = 'write' | 'file-sync' | 'rename' | 'directory-sync';

const dependenciesWithManifestFault = (
  system: IngestDependencies,
  phase: ManifestFaultPhase,
  failure: Error,
): IngestDependencies => ({
  ...system,
  manifestFileOps: {
    writeFile: async (handle: FileHandle, contents: string) => {
      if (phase === 'write') throw failure;
      await handle.writeFile(contents, 'utf8');
    },
    syncFile: async (handle: FileHandle) => {
      if (phase === 'file-sync') throw failure;
      await handle.sync();
    },
    rename: async (action: () => Promise<void>) => {
      if (phase === 'rename') throw failure;
      await action();
    },
    syncDirectory: async (action: () => Promise<void>) => {
      if (phase === 'directory-sync') throw failure;
      await action();
    },
  },
} as IngestDependencies);

describe('runIngest', () => {
  it('publishes a strict manifest for direct video, music, and image assets without changing sources', async () => {
    const project = await makeProject();
    const videoPath = path.join(project.projectRoot, 'assets/source/interview.mp4');
    const musicPath = path.join(project.projectRoot, 'assets/source/music.wav');
    const imagePath = path.join(project.projectRoot, 'assets/source/poster.png');
    await createTestVideo(videoPath);
    await createTestMusic(musicPath);
    await createTestImage(imagePath, 'blue');
    const before = await Promise.all([videoPath, musicPath, imagePath].map(async (filePath) => ({
      bytes: await readFile(filePath),
      stats: await stat(filePath, {bigint: true}),
    })));

    const result = await runIngest(inputFor(project, [
      {assetId: 'music', kind: 'audio', sourcePath: 'assets/source/music.wav'},
      {assetId: 'interview', kind: 'video', sourcePath: 'assets/source/interview.mp4'},
      {assetId: 'poster', kind: 'image', sourcePath: 'assets/source/poster.png'},
    ]), createSystemIngestDependencies());
    const rawManifest = await readRunJson(project.runDirectory, 'asset-manifest.json');
    const manifest = IngestManifestSchema.parse(rawManifest);

    expect(result).toEqual({
      manifestPath: 'asset-manifest.json',
      manifest,
    });
    expect(Object.keys(manifest.assets)).toEqual(['interview', 'music', 'poster']);
    expect(manifest.assets.interview).toMatchObject({
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
      renderPath: 'assets/source/interview.mp4',
      renderScope: 'project',
      durationMs: 2000,
      width: 320,
      height: 180,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      colorSpace: 'bt709',
      hasAudio: true,
      variableFrameRate: false,
      compatibility: 'direct',
    });
    expect(manifest.assets.music).toMatchObject({
      kind: 'audio',
      sourcePath: 'assets/source/music.wav',
      renderPath: 'assets/source/music.wav',
      renderScope: 'project',
      durationMs: 2000,
      compatibility: 'direct',
    });
    expect(manifest.assets.poster).toMatchObject({
      kind: 'image',
      sourcePath: 'assets/source/poster.png',
      renderPath: 'assets/source/poster.png',
      renderScope: 'project',
      width: 64,
      height: 48,
      compatibility: 'direct',
    });
    for (const asset of Object.values(manifest.assets)) {
      expect(asset.sourceHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
    expect(() => IngestManifestSchema.parse({...manifest, unexpected: true})).toThrow();
    expect(() => IngestManifestSchema.parse({
      ...manifest,
      assets: {
        ...manifest.assets,
        interview: {...manifest.assets.interview, unexpected: true},
      },
    })).toThrow();

    const after = await Promise.all([videoPath, musicPath, imagePath].map(async (filePath) => ({
      bytes: await readFile(filePath),
      stats: await stat(filePath, {bigint: true}),
    })));
    for (const [index, snapshot] of after.entries()) {
      expect(snapshot.bytes).toEqual(before[index]!.bytes);
      expect(snapshot.stats.mtimeNs).toBe(before[index]!.stats.mtimeNs);
    }
  });

  it('accepts music with attached artwork and decodes only its audio stream', async () => {
    const project = await makeProject('music-cover');
    const coverPath = path.join(project.projectRoot, 'assets/source/cover.png');
    const musicPath = path.join(project.projectRoot, 'assets/source/music.mp3');
    await createTestImage(coverPath, 'purple');
    await createTestMusicWithCover(musicPath, coverPath, 1);
    const system = createSystemIngestDependencies();
    const mappedStreams: string[] = [];
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        const mapIndex = args.indexOf('-map');
        if (command === FFMPEG_EXECUTABLE && mapIndex >= 0) {
          mappedStreams.push(args[mapIndex + 1]!);
        }
        return await runProcess(command, args, options);
      },
    };

    const {manifest} = await runIngest(inputFor(project, [{
      assetId: 'music',
      kind: 'audio',
      sourcePath: 'assets/source/music.mp3',
    }]), dependencies);

    expect(manifest.assets.music).toMatchObject({
      kind: 'audio',
      durationMs: 1000,
      compatibility: 'direct',
    });
    expect(mappedStreams).toEqual(['0:0']);
  });

  it('rejects attached artwork as the only video stream without sampling it', async () => {
    const project = await makeProject('video-cover');
    const coverPath = path.join(project.projectRoot, 'assets/source/cover.png');
    const musicPath = path.join(project.projectRoot, 'assets/source/music.mp3');
    await createTestImage(coverPath, 'purple');
    await createTestMusicWithCover(musicPath, coverPath, 1);
    const system = createSystemIngestDependencies();
    let sampledVideo = false;
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        if (command === FFMPEG_EXECUTABLE && args.includes('-frames:v')) {
          sampledVideo = true;
        }
        return await runProcess(command, args, options);
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'music-video',
      kind: 'video',
      sourcePath: 'assets/source/music.mp3',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'music-video',
      reasons: ['video stream is missing'],
    });
    expect(sampledVideo).toBe(false);
    await expectMissingManifest(project.runDirectory);
  });

  it('transcodes incompatible SDR video through fresh borrowed handles and validates the result', async () => {
    const project = await makeProject();
    const sourcePath = path.join(project.projectRoot, 'assets/source/interview.mp4');
    await createTestVideo(sourcePath, 2, {pixelFormat: 'yuv422p'});
    const sourceBefore = {
      bytes: await readFile(sourcePath),
      stats: await stat(sourcePath, {bigint: true}),
    };
    const system = createSystemIngestDependencies();
    const projectHandles: FileHandle[] = [];
    const activeProjectFds = new Set<number>();
    const runReadHandles: FileHandle[] = [];
    const runNewHandles: FileHandle[] = [];
    let sourceProcessPhase = true;
    const processCalls: Array<{
      command: string;
      args: string[];
      fds: number[];
    }> = [];
    const dependencies: IngestDependencies = {
      manifestFileOps: system.manifestFileOps,
      runProcess: async (command, args, options) => {
        const fds = [...(options.extraStdioFds ?? [])];
        if (sourceProcessPhase) expect(activeProjectFds.has(fds[0]!)).toBe(true);
        const result = await runProcess(command, args, options);
        if (args.includes('/dev/fd/4')) sourceProcessPhase = false;
        for (const fd of fds) expect(fstatSync(fd).isFile()).toBe(true);
        processCalls.push({command, args: [...args], fds});
        return result;
      },
      fileSystem: {
        ...system.fileSystem,
        openExistingProjectFile: async (scope, relativePath) => {
          const handle = await system.fileSystem.openExistingProjectFile(scope, relativePath);
          vi.spyOn(handle, 'read');
          const descriptor = handle.fd;
          const close = handle.close.bind(handle);
          activeProjectFds.add(descriptor);
          handle.close = async () => {
            try {
              await close();
            } finally {
              activeProjectFds.delete(descriptor);
            }
          };
          projectHandles.push(handle);
          return handle;
        },
        openExistingRunFile: async (scope, relativePath) => {
          const handle = await system.fileSystem.openExistingRunFile(scope, relativePath);
          runReadHandles.push(handle);
          return handle;
        },
        openNewRunReadWriteFile: async (scope, relativePath) => {
          const handle = await system.fileSystem.openNewRunReadWriteFile(scope, relativePath);
          runNewHandles.push(handle);
          return handle;
        },
        openNewRunFile: async (scope, relativePath) => {
          const handle = await system.fileSystem.openNewRunFile(scope, relativePath);
          runNewHandles.push(handle);
          return handle;
        },
      },
    };

    const {manifest} = await runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies);

    expect(manifest.assets.interview).toMatchObject({
      compatibility: 'transcoded',
      renderScope: 'run',
      renderPath: 'assets/interview/render.mp4',
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      colorSpace: 'bt709',
      hasAudio: false,
      variableFrameRate: false,
    });
    const outputProbe = await probeRunFile(
      project.runDirectory,
      'assets/interview/render.mp4',
    );
    expect(outputProbe.audioStreams).toHaveLength(0);
    expect(outputProbe.videoStreams[0]).toMatchObject({
      codec: 'h264',
      pixelFormat: 'yuv420p',
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
    });
    expect(outputProbe.videoStreams[0]?.averageFrameRate).toMatchObject({
      numerator: 30,
      denominator: 1,
    });
    expect(outputProbe.videoStreams[0]?.realFrameRate).toMatchObject({
      numerator: 30,
      denominator: 1,
    });
    expect(decideVideoCompatibility(outputProbe, {decodable: true})).toEqual({
      compatibility: 'direct',
    });

    expect(projectHandles).toHaveLength(14);
    expect(new Set(projectHandles).size).toBe(projectHandles.length);
    expect(projectHandles.filter((handle) =>
      vi.mocked(handle.read).mock.calls.length > 0)).toHaveLength(2);
    expect(activeProjectFds).toEqual(new Set());
    expect(runReadHandles).toHaveLength(8);
    expect(new Set(runReadHandles).size).toBe(runReadHandles.length);
    expect(runNewHandles).toHaveLength(2);
    await Promise.all([
      ...projectHandles.map(closedHandle),
      ...runReadHandles.map(closedHandle),
      ...runNewHandles.map(closedHandle),
    ]);

    const transcodeCall = processCalls.find(({args}) => args.includes('/dev/fd/4'));
    expect(transcodeCall?.fds).toHaveLength(2);
    expect(processCalls.length).toBeGreaterThanOrEqual(9);
    for (const call of processCalls) {
      expect([FFMPEG_EXECUTABLE, FFPROBE_EXECUTABLE]).toContain(call.command);
      expect(call.args).not.toContain(sourcePath);
      expect(call.args.some((argument) => argument.includes(project.workspaceRoot))).toBe(false);
      expect(call.args).toContain('/dev/fd/3');
      expect(call.fds).toHaveLength(call.args.includes('/dev/fd/4') ? 2 : 1);
    }

    expect(await readFile(sourcePath)).toEqual(sourceBefore.bytes);
    expect((await stat(sourcePath, {bigint: true})).mtimeNs).toBe(sourceBefore.stats.mtimeNs);
  });

  it.each([
    'bt470bg',
    'smpte170m',
  ] as const)('converts %s SDR frames to limited-range BT.709', async (colorProfile) => {
    const project = await makeProject(`colorspace-${colorProfile}`);
    await createTestVideo(
      path.join(project.projectRoot, 'assets/source/interview.mp4'),
      1,
      {includeAudio: false, colorProfile},
    );

    const {manifest} = await runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), createSystemIngestDependencies());
    const outputProbe = await probeRunFile(
      project.runDirectory,
      'assets/interview/render.mp4',
    );

    expect(manifest.assets.interview).toMatchObject({
      compatibility: 'transcoded',
      renderScope: 'run',
    });
    expect(outputProbe.videoStreams[0]).toMatchObject({
      codec: 'h264',
      pixelFormat: 'yuv420p',
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
    });
    expect(outputProbe.audioStreams).toHaveLength(0);
  });

  it('samples first, middle, and tail from the primary video duration, not longer audio', async () => {
    const project = await makeProject();
    await createTestVideo(
      path.join(project.projectRoot, 'assets/source/interview.mp4'),
      1,
      {audioSeconds: 3},
    );
    const system = createSystemIngestDependencies();
    const sampledOffsets: number[] = [];
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        const seekIndex = args.indexOf('-ss');
        if (seekIndex >= 0) sampledOffsets.push(Number(args[seekIndex + 1]));
        return await runProcess(command, args, options);
      },
    };

    const {manifest} = await runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies);

    expect(manifest.assets.interview).toMatchObject({durationMs: 1000});
    expect(sampledOffsets).toEqual([0, 0.5, 0.9]);
    expect(sampledOffsets.every((offset) => offset < 1)).toBe(true);
  });

  it('rejects an exit-zero sample decode that reports zero decoded frames', async () => {
    const project = await makeProject();
    await createTestVideo(path.join(project.projectRoot, 'assets/source/interview.mp4'), 1);
    const system = createSystemIngestDependencies();
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        if (command === FFMPEG_EXECUTABLE && args.includes('-frames:v')) {
          return {
            command,
            args: [...args],
            exitCode: 0,
            signal: null,
            stdout: 'frame=0\nprogress=end\n',
            stderr: '',
            durationMs: 1,
          };
        }
        return await runProcess(command, args, options);
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'interview',
      reasons: ['video sample decode failed'],
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('rejects a transcoded output that is CFR but not exactly 30 fps', async () => {
    const project = await makeProject();
    await createTestVideo(
      path.join(project.projectRoot, 'assets/source/interview.mp4'),
      1,
      {pixelFormat: 'yuv422p'},
    );
    const system = createSystemIngestDependencies();
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => await runProcess(
        command,
        args.includes('/dev/fd/4')
          ? args.map((argument) => argument.replace('fps=30', 'fps=24'))
          : args,
        options,
      ),
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'interview',
      reasons: ['transcoded output frame rate must be 30 fps'],
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('rejects a transcoded output without limited-range BT.709 metadata', async () => {
    const project = await makeProject();
    await createTestVideo(
      path.join(project.projectRoot, 'assets/source/interview.mp4'),
      1,
      {pixelFormat: 'yuv422p'},
    );
    const system = createSystemIngestDependencies();
    let probeCount = 0;
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        const result = await runProcess(command, args, options);
        if (command !== FFPROBE_EXECUTABLE) return result;
        probeCount += 1;
        if (probeCount !== 2) return result;
        const output = JSON.parse(result.stdout) as {
          streams: Array<Record<string, unknown>>;
        };
        const video = output.streams.find((stream) => stream.codec_type === 'video');
        if (video !== undefined) video.color_range = 'pc';
        return {...result, stdout: JSON.stringify(output)};
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'interview',
      reasons: ['transcoded output must use limited-range BT.709'],
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('rejects a source symlink escape and never publishes a manifest', async () => {
    const project = await makeProject();
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'ingest-outside-'));
    onTestFinished(() => rm(outsideRoot, {recursive: true, force: true}));
    const outsideFile = path.join(outsideRoot, 'outside.mp4');
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, path.join(project.projectRoot, 'assets/source/interview.mp4'));

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), createSystemIngestDependencies())).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
      assetId: 'interview',
    });
    await expectMissingManifest(project.runDirectory);
  });

  it.each([
    '../outside.mp4',
    '/tmp/outside.mp4',
    'C:\\outside.mp4',
    'assets/source/invalid\0name.mp4',
    'assets//source/interview.mp4',
  ])('maps invalid lexical source path %j to ASSET_PATH_OUTSIDE_PROJECT', async (sourcePath) => {
    const project = await makeProject();

    let caught: unknown;
    try {
      await runIngest(inputFor(project, [{
        assetId: 'interview',
        kind: 'video',
        sourcePath,
      }]), createSystemIngestDependencies());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
      assetId: 'interview',
      cause: expect.any(Error),
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('rejects project-root substitution after scope creation', async () => {
    const project = await makeProject();
    const movedProject = `${project.projectRoot}-original`;
    const outsideRoot = await mkdtemp(path.join(tmpdir(), 'ingest-root-substitution-'));
    onTestFinished(() => rm(outsideRoot, {recursive: true, force: true}));
    await mkdir(path.join(outsideRoot, 'assets/source'), {recursive: true});
    await writeFile(path.join(outsideRoot, 'assets/source/interview.mp4'), 'outside');
    await rename(project.projectRoot, movedProject);
    await symlink(outsideRoot, project.projectRoot);

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), createSystemIngestDependencies())).rejects.toMatchObject({
      code: 'ASSET_PATH_OUTSIDE_PROJECT',
      assetId: 'interview',
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('fails closed when the source hash changes during ingest', async () => {
    const project = await makeProject();
    const sourcePath = path.join(project.projectRoot, 'assets/source/interview.mp4');
    await createTestVideo(sourcePath);
    const system = createSystemIngestDependencies();
    let sourceOpenCount = 0;
    const dependencies: IngestDependencies = {
      ...system,
      fileSystem: {
        ...system.fileSystem,
        openExistingProjectFile: async (scope, relativePath) => {
          sourceOpenCount += 1;
          if (sourceOpenCount === 6) await writeFile(sourcePath, 'replaced during ingest');
          return await system.fileSystem.openExistingProjectFile(scope, relativePath);
        },
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'interview',
      reasons: ['source changed during ingest'],
    });
    expect(sourceOpenCount).toBeGreaterThanOrEqual(6);
    await expectMissingManifest(project.runDirectory);
  });

  it('rejects an ABA path substitution instead of probing a replacement inode', async () => {
    const project = await makeProject();
    const sourcePath = path.join(project.projectRoot, 'assets/source/interview.mp4');
    const replacementPath = path.join(project.projectRoot, 'assets/source/replacement.mp4');
    const parkedPath = path.join(project.projectRoot, 'assets/source/interview-original.mp4');
    await createTestVideo(sourcePath, 2);
    await createTestVideo(replacementPath, 1);
    const system = createSystemIngestDependencies();
    let sourceOpenCount = 0;
    const dependencies: IngestDependencies = {
      ...system,
      fileSystem: {
        ...system.fileSystem,
        openExistingProjectFile: async (scope, relativePath) => {
          sourceOpenCount += 1;
          if (sourceOpenCount !== 3) {
            return await system.fileSystem.openExistingProjectFile(scope, relativePath);
          }
          await rename(sourcePath, parkedPath);
          await rename(replacementPath, sourcePath);
          const replacementHandle = await system.fileSystem.openExistingProjectFile(
            scope,
            relativePath,
          );
          await rename(sourcePath, replacementPath);
          await rename(parkedPath, sourcePath);
          return replacementHandle;
        },
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'interview',
      reasons: ['source changed during ingest'],
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('keeps the scoped probe handle on the original inode during an ABA path swap', async () => {
    const project = await makeProject('probe-aba');
    const sourcePath = path.join(project.projectRoot, 'assets/source/interview.mp4');
    const replacementPath = path.join(project.projectRoot, 'assets/source/replacement.mp4');
    const parkedPath = path.join(project.projectRoot, 'assets/source/interview-original.mp4');
    await createTestVideo(sourcePath, 2, {includeAudio: false});
    await createTestVideo(replacementPath, 1, {includeAudio: false});
    const system = createSystemIngestDependencies();
    let swapped = false;
    let probedDurationMs: number | undefined;
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        if (command !== FFPROBE_EXECUTABLE || swapped) {
          return await runProcess(command, args, options);
        }
        swapped = true;
        await rename(sourcePath, parkedPath);
        await rename(replacementPath, sourcePath);
        try {
          const result = await runProcess(command, args, options);
          probedDurationMs = parseFfprobeJson(result.stdout).durationMs;
          return result;
        } finally {
          await rename(sourcePath, replacementPath);
          await rename(parkedPath, sourcePath);
        }
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'interview',
      reasons: ['source changed during ingest'],
    });

    expect(swapped).toBe(true);
    expect(probedDurationMs).toBe(2000);
    await expectMissingManifest(project.runDirectory);
  });

  it('requires music assets to contain a decodable audio track', async () => {
    const project = await makeProject();
    await createTestVideo(
      path.join(project.projectRoot, 'assets/source/not-music.mp4'),
      1,
      {includeAudio: false},
    );

    await expect(runIngest(inputFor(project, [{
      assetId: 'music',
      kind: 'audio',
      sourcePath: 'assets/source/not-music.mp4',
    }]), createSystemIngestDependencies())).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'music',
      reasons: ['audio stream is missing'],
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('uses the primary audio stream duration and requires a decoded framehash row', async () => {
    const project = await makeProject('audio-duration');
    await createTestVideo(
      path.join(project.projectRoot, 'assets/source/music.mp4'),
      1,
      {audioSeconds: 3},
    );
    const system = createSystemIngestDependencies();
    let audioDecodeArgs: readonly string[] | undefined;
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        if (command === FFMPEG_EXECUTABLE && args.includes('-frames:a')) {
          audioDecodeArgs = [...args];
        }
        return await runProcess(command, args, options);
      },
    };

    const {manifest} = await runIngest(inputFor(project, [{
      assetId: 'music',
      kind: 'audio',
      sourcePath: 'assets/source/music.mp4',
    }]), dependencies);

    expect(manifest.assets.music).toMatchObject({durationMs: 3000});
    expect(audioDecodeArgs?.[audioDecodeArgs.indexOf('-t') + 1]).toBe('3.000');
    expect(audioDecodeArgs).toContain('framehash');
  });

  it('rejects exit-zero audio decode output without a decoded framehash row', async () => {
    const project = await makeProject('audio-no-samples');
    await createTestMusic(path.join(project.projectRoot, 'assets/source/music.wav'), 1);
    const system = createSystemIngestDependencies();
    const dependencies: IngestDependencies = {
      ...system,
      runProcess: async (command, args, options) => {
        if (command === FFMPEG_EXECUTABLE && args.includes('-frames:a')) {
          return {
            command,
            args: [...args],
            exitCode: 0,
            signal: null,
            stdout: [
              '#format: frame checksums',
              '#version: 2',
              '#stream#, dts, pts, duration, size, hash',
              '',
            ].join('\n'),
            stderr: '',
            durationMs: 1,
          };
        }
        return await runProcess(command, args, options);
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'music',
      kind: 'audio',
      sourcePath: 'assets/source/music.wav',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'music',
      reasons: ['audio sample decode failed'],
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('accepts silent audio when it contains decodable samples', async () => {
    const project = await makeProject('silent-audio');
    await createTestMusic(
      path.join(project.projectRoot, 'assets/source/silence.wav'),
      1,
      {silent: true},
    );

    const {manifest} = await runIngest(inputFor(project, [{
      assetId: 'silence',
      kind: 'audio',
      sourcePath: 'assets/source/silence.wav',
    }]), createSystemIngestDependencies());

    expect(manifest.assets.silence).toMatchObject({
      durationMs: 1000,
      compatibility: 'direct',
    });
  });

  it('rejects a zero-duration AAC stream without decodable samples', async () => {
    const project = await makeProject('zero-aac');
    await createZeroDurationAac(
      path.join(project.projectRoot, 'assets/source/empty.aac'),
    );

    await expect(runIngest(inputFor(project, [{
      assetId: 'empty',
      kind: 'audio',
      sourcePath: 'assets/source/empty.aac',
    }]), createSystemIngestDependencies())).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'empty',
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('maps malformed media and sample decode failures to ASSET_DECODE_FAILED', async () => {
    const project = await makeProject();
    await writeFile(
      path.join(project.projectRoot, 'assets/source/corrupt.mp4'),
      'not a media file',
    );

    await expect(runIngest(inputFor(project, [{
      assetId: 'corrupt',
      kind: 'video',
      sourcePath: 'assets/source/corrupt.mp4',
    }]), createSystemIngestDependencies())).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'corrupt',
    });
    await expectMissingManifest(project.runDirectory);
  });

  it('preserves an existing transcode artifact because Run writes are exclusive', async () => {
    const project = await makeProject();
    await createTestVideo(
      path.join(project.projectRoot, 'assets/source/interview.mp4'),
      1,
      {pixelFormat: 'yuv422p'},
    );
    await ensureRunDirectory(project.runDirectory, 'assets/interview');
    const existing = await openNewRunFile(
      project.runDirectory,
      'assets/interview/render.mp4',
    );
    await existing.writeFile('existing artifact');
    await existing.sync();
    await existing.close();

    await expect(runIngest(inputFor(project, [{
      assetId: 'interview',
      kind: 'video',
      sourcePath: 'assets/source/interview.mp4',
    }]), createSystemIngestDependencies())).rejects.toMatchObject({code: 'EEXIST'});
    expect((await readHandle(await openExistingRunFile(
      project.runDirectory,
      'assets/interview/render.mp4',
    ))).toString('utf8')).toBe('existing artifact');
    await expectMissingManifest(project.runDirectory);
  });

  it('does not publish a success manifest when its exclusive write fails', async () => {
    const project = await makeProject();
    await createTestImage(path.join(project.projectRoot, 'assets/source/poster.png'));
    const system = createSystemIngestDependencies();
    const failure = new Error('injected manifest write failure');
    const dependencies: IngestDependencies = {
      ...system,
      fileSystem: {
        ...system.fileSystem,
        openNewRunFile: async () => { throw failure; },
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'poster',
      kind: 'image',
      sourcePath: 'assets/source/poster.png',
    }]), dependencies)).rejects.toBe(failure);
    await expectMissingManifest(project.runDirectory);
  });

  it.each([
    'write',
    'file-sync',
    'rename',
    'directory-sync',
  ] as const)('keeps the final manifest absent after injected %s failure', async (phase) => {
    const project = await makeProject(`manifest-${phase}`);
    await createTestImage(path.join(project.projectRoot, 'assets/source/poster.png'));
    const failure = new Error(`injected manifest ${phase} failure`);
    const system = createSystemIngestDependencies();

    await expect(runIngest(inputFor(project, [{
      assetId: 'poster',
      kind: 'image',
      sourcePath: 'assets/source/poster.png',
    }]), dependenciesWithManifestFault(system, phase, failure))).rejects.toBe(failure);
    await expectMissingManifest(project.runDirectory);
  });

  it('never overwrites an existing final manifest', async () => {
    const project = await makeProject('manifest-existing');
    await createTestImage(path.join(project.projectRoot, 'assets/source/poster.png'));
    const existing = await openNewRunFile(project.runDirectory, 'asset-manifest.json');
    await existing.writeFile('existing manifest');
    await existing.sync();
    await existing.close();

    await expect(runIngest(inputFor(project, [{
      assetId: 'poster',
      kind: 'image',
      sourcePath: 'assets/source/poster.png',
    }]), createSystemIngestDependencies())).rejects.toMatchObject({code: 'EEXIST'});
    expect((await readHandle(await openExistingRunFile(
      project.runDirectory,
      'asset-manifest.json',
    ))).toString('utf8')).toBe('existing manifest');
  });

  it.each(['failure', 'abort', 'timeout'] as const)(
    'closes its fresh source handle after process %s while the runner keeps borrowed ownership',
    async (mode) => {
      const project = await makeProject(`process-${mode}`);
      await writeFile(path.join(project.projectRoot, 'assets/source/input.bin'), 'input');
      const borrowed: number[] = [];
      const system = createSystemIngestDependencies();
      const runner = async (
        _command: string,
        _args: readonly string[],
        options: RunProcessOptions = {},
      ) => {
        const descriptor = options.extraStdioFds?.[0];
        expect(descriptor).toBeTypeOf('number');
        borrowed.push(descriptor!);
        try {
          if (mode === 'failure') {
            return await runProcess(
              process.execPath,
              ['-e', 'process.exit(7)'],
              {extraStdioFds: [descriptor!]},
            );
          }
          if (mode === 'timeout') {
            return await runProcess(
              process.execPath,
              ['-e', 'setInterval(() => {}, 1000)'],
              {extraStdioFds: [descriptor!], timeoutMs: 20},
            );
          }
          const controller = new AbortController();
          const pending = runProcess(
            process.execPath,
            ['-e', 'setInterval(() => {}, 1000)'],
            {extraStdioFds: [descriptor!], signal: controller.signal},
          );
          controller.abort('ingest borrowed fd test');
          return await pending;
        } finally {
          expect(fstatSync(descriptor!).isFile()).toBe(true);
        }
      };

      await expect(runIngest(inputFor(project, [{
        assetId: 'input',
        kind: 'video',
        sourcePath: 'assets/source/input.bin',
      }]), {...system, runProcess: runner})).rejects.toMatchObject({
        code: 'ASSET_DECODE_FAILED',
        assetId: 'input',
      });
      expect(borrowed).toHaveLength(1);
      expect(() => fstatSync(borrowed[0]!)).toThrow(expect.objectContaining({code: 'EBADF'}));
      await expectMissingManifest(project.runDirectory);
    },
  );

  it('inherits the closed-FD spawn failure contract and still closes the caller handle', async () => {
    const project = await makeProject();
    await createTestImage(path.join(project.projectRoot, 'assets/source/poster.png'));
    const system = createSystemIngestDependencies();
    let sourceOpenCount = 0;
    let closedProbeHandle: FileHandle | undefined;
    const dependencies: IngestDependencies = {
      ...system,
      fileSystem: {
        ...system.fileSystem,
        openExistingProjectFile: async (scope, relativePath) => {
          const handle = await openExistingProjectFile(scope, relativePath);
          sourceOpenCount += 1;
          if (sourceOpenCount === 2) {
            closedProbeHandle = handle;
            closeSync(handle.fd);
          }
          return handle;
        },
      },
    };

    await expect(runIngest(inputFor(project, [{
      assetId: 'poster',
      kind: 'image',
      sourcePath: 'assets/source/poster.png',
    }]), dependencies)).rejects.toMatchObject({
      code: 'ASSET_DECODE_FAILED',
      assetId: 'poster',
    });
    expect(closedProbeHandle).toBeDefined();
    await closedHandle(closedProbeHandle!);
    await expectMissingManifest(project.runDirectory);
  });
});
