import {constants} from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';
import {
  AppDirectoryScopeError,
  OutputDirectoryScope,
  RunDirectoryScope,
  WorkDirectoryScope,
  createOutputStore,
  createRunStore,
  createWorkDirectoryScope,
  ensureOutputDirectory,
  ensureRunDirectory,
  openExistingOutputFile,
  openExistingRunFile,
  openNewOutputFile,
  openNewOutputReadWriteFile,
  openNewRunFile,
  openNewRunReadWriteFile,
} from '../../../src/fs/app-directory-scopes';
import * as appDirectoryScopes from '../../../src/fs/app-directory-scopes';
import {runProcess} from '../../../src/process/run-process';

type FixedProjectLockApi = {
  openExistingProjectLockFile(scope: WorkDirectoryScope): Promise<FileHandle>;
  openNewProjectLockFile(scope: WorkDirectoryScope): Promise<FileHandle>;
};

const fixedProjectLockApi = (): FixedProjectLockApi => {
  const candidate = appDirectoryScopes as unknown as Partial<FixedProjectLockApi>;
  if (
    typeof candidate.openExistingProjectLockFile !== 'function'
    || typeof candidate.openNewProjectLockFile !== 'function'
  ) {
    throw new TypeError('fixed project-lock Work API is unavailable');
  }
  return candidate as FixedProjectLockApi;
};

function assertNoArbitraryWorkExports(): void {
  // @ts-expect-error Work scope must not expose arbitrary relative-path reads
  void appDirectoryScopes.openExistingWorkFile;
  // @ts-expect-error Work scope must not expose arbitrary relative-path writes
  void appDirectoryScopes.openNewWorkFile;
  // @ts-expect-error Work scope must not expose arbitrary relative-path deletion
  void appDirectoryScopes.unlinkWorkFile;
  // @ts-expect-error Work scope must not expose arbitrary relative-path inspection
  void appDirectoryScopes.inspectWorkEntry;
}
void assertNoArbitraryWorkExports;

function assertNominalScopeTypes(
  project: ProjectDirectoryScope,
  work: WorkDirectoryScope,
  run: RunDirectoryScope,
  output: OutputDirectoryScope,
): void {
  // @ts-expect-error private brand prevents object forgery
  const forgedProject: ProjectDirectoryScope = {};
  // @ts-expect-error private brand prevents object forgery
  const forgedWork: WorkDirectoryScope = {};
  // @ts-expect-error private brand prevents object forgery
  const forgedRun: RunDirectoryScope = {};
  // @ts-expect-error private brand prevents object forgery
  const forgedOutput: OutputDirectoryScope = {};

  // @ts-expect-error Project and Work scopes are nominally distinct
  const projectAsWork: WorkDirectoryScope = project;
  // @ts-expect-error Project and Run scopes are nominally distinct
  const projectAsRun: RunDirectoryScope = project;
  // @ts-expect-error Project and Output scopes are nominally distinct
  const projectAsOutput: OutputDirectoryScope = project;
  // @ts-expect-error Work and Project scopes are nominally distinct
  const workAsProject: ProjectDirectoryScope = work;
  // @ts-expect-error Work and Run scopes are nominally distinct
  const workAsRun: RunDirectoryScope = work;
  // @ts-expect-error Work and Output scopes are nominally distinct
  const workAsOutput: OutputDirectoryScope = work;
  // @ts-expect-error Run and Project scopes are nominally distinct
  const runAsProject: ProjectDirectoryScope = run;
  // @ts-expect-error Run and Work scopes are nominally distinct
  const runAsWork: WorkDirectoryScope = run;
  // @ts-expect-error Run and Output scopes are nominally distinct
  const runAsOutput: OutputDirectoryScope = run;
  // @ts-expect-error Output and Project scopes are nominally distinct
  const outputAsProject: ProjectDirectoryScope = output;
  // @ts-expect-error Output and Work scopes are nominally distinct
  const outputAsWork: WorkDirectoryScope = output;
  // @ts-expect-error Output and Run scopes are nominally distinct
  const outputAsRun: RunDirectoryScope = output;

  void [
    forgedProject,
    forgedWork,
    forgedRun,
    forgedOutput,
    projectAsWork,
    projectAsRun,
    projectAsOutput,
    workAsProject,
    workAsRun,
    workAsOutput,
    runAsProject,
    runAsWork,
    runAsOutput,
    outputAsProject,
    outputAsWork,
    outputAsRun,
  ];
}
void assertNominalScopeTypes;

const tempDirectories: string[] = [];

const makeTempDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, {recursive: true, force: true})));
});

const writeAndClose = async (
  handle: FileHandle,
  value: string,
): Promise<void> => {
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
};

const readAndClose = async (handle: FileHandle): Promise<string> => {
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
};

describe('app-owned directory scopes', () => {
  it('mints only fixed Work, Run, and Output prefixes without exposing roots', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-fixed-');
    const work = await createWorkDirectoryScope(workspaceRoot, 'demo');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    const output = await createOutputStore(workspaceRoot).openProject('demo');

    expect(Object.keys(work)).toEqual([]);
    expect(Object.keys(run)).toEqual([]);
    expect(Object.keys(output)).toEqual([]);
    await expect(readFile(path.join(workspaceRoot, '.work', 'demo'), 'utf8'))
      .rejects.toMatchObject({code: 'EISDIR'});
    await expect(readFile(
      path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one'),
      'utf8',
    )).rejects.toMatchObject({code: 'EISDIR'});
    await expect(readFile(path.join(workspaceRoot, 'output', 'demo'), 'utf8'))
      .rejects.toMatchObject({code: 'EISDIR'});
  });

  it.each([
    ['absolute', '/tmp/escape'],
    ['parent traversal', '../escape'],
    ['Windows absolute', 'C:\\escape'],
    ['backslash traversal', '..\\escape'],
    ['NUL byte', 'bad\0name'],
    ['empty', ''],
  ])('rejects %s paths before opening', async (_label, relativePath) => {
    const workspaceRoot = await makeTempDirectory('app-scopes-relative-');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');

    await expect(openNewRunFile(run, relativePath)).rejects.toBeInstanceOf(
      AppDirectoryScopeError,
    );
  });

  it('rejects runtime scope forgery', async () => {
    await expect(fixedProjectLockApi().openNewProjectLockFile(
      {} as WorkDirectoryScope,
    )).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects fixed Work authority that resolves outside the workspace', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-workspace-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    await mkdir(path.join(workspaceRoot, '.work'));
    await symlink(outsideRoot, path.join(workspaceRoot, '.work', 'demo'));

    await expect(createWorkDirectoryScope(workspaceRoot, 'demo'))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
  });

  it('rejects confined Run creation through an escaped runs directory', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-workspace-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    await mkdir(path.join(workspaceRoot, '.work', 'demo'), {recursive: true});
    await symlink(outsideRoot, path.join(workspaceRoot, '.work', 'demo', 'runs'));

    await expect(
      createRunStore(workspaceRoot).createRun('demo', 'run-one'),
    ).rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(readFile(path.join(outsideRoot, 'run-one'), 'utf8'))
      .rejects.toMatchObject({code: 'ENOENT'});
  });

  it('rejects fixed Output authority that resolves outside the workspace', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-workspace-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    await mkdir(path.join(workspaceRoot, 'output'));
    await symlink(outsideRoot, path.join(workspaceRoot, 'output', 'demo'));

    await expect(createOutputStore(workspaceRoot).openProject('demo'))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
  });

  it('rejects a Work project-lock symlink', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-work-');
    const outsideRoot = await makeTempDirectory('app-scopes-outside-');
    const outsideFile = path.join(outsideRoot, 'outside.json');
    await writeFile(outsideFile, 'outside');
    const work = await createWorkDirectoryScope(workspaceRoot, 'demo');
    const workRoot = path.join(workspaceRoot, '.work', 'demo');

    await symlink(outsideFile, path.join(workRoot, 'pipeline.lock'));
    await expect(fixedProjectLockApi().openExistingProjectLockFile(work))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(fixedProjectLockApi().openNewProjectLockFile(work))
      .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    await expect(readFile(outsideFile, 'utf8')).resolves.toBe('outside');
  });

  it('does not expose Work authority over Run artifacts', async () => {
    const workspaceRoot = await makeTempDirectory('app-scopes-work-minimal-');
    const work = await createWorkDirectoryScope(workspaceRoot, 'demo');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    await writeAndClose(await openNewRunFile(run, 'artifact.txt'), 'immutable');

    expect(appDirectoryScopes).not.toHaveProperty('openExistingWorkFile');
    expect(appDirectoryScopes).not.toHaveProperty('openNewWorkFile');
    expect(appDirectoryScopes).not.toHaveProperty('unlinkWorkFile');
    expect(appDirectoryScopes).not.toHaveProperty('inspectWorkEntry');
    expect(appDirectoryScopes).toHaveProperty('openExistingProjectLockFile');
    expect(appDirectoryScopes).toHaveProperty('openNewProjectLockFile');

    await expect(Reflect.apply(
      fixedProjectLockApi().openExistingProjectLockFile,
      undefined,
      [work, 'runs/run-one/artifact.txt'],
    )).rejects.toMatchObject({code: 'ENOENT'});
    await expect(readAndClose(
      await openExistingRunFile(run, 'artifact.txt'),
    )).resolves.toBe('immutable');
  });

  it.each(['run', 'output'] as const)(
    'supports existing, exclusive write-only, and exclusive read-write %s files',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const scope = kind === 'run'
        ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
        : await createOutputStore(workspaceRoot).openProject('demo');
      const ensureDirectory = kind === 'run'
        ? ensureRunDirectory
        : ensureOutputDirectory;
      const openNewFile = kind === 'run'
        ? openNewRunFile
        : openNewOutputFile;
      const openExistingFile = kind === 'run'
        ? openExistingRunFile
        : openExistingOutputFile;
      const openReadWriteFile = kind === 'run'
        ? openNewRunReadWriteFile
        : openNewOutputReadWriteFile;

      await ensureDirectory(scope as never, 'media');
      await writeAndClose(
        await openNewFile(scope as never, 'media/artifact.txt'),
        'immutable',
      );
      await expect(
        openNewFile(scope as never, 'media/artifact.txt'),
      ).rejects.toMatchObject({code: 'EEXIST'});
      await expect(readAndClose(
        await openExistingFile(scope as never, 'media/artifact.txt'),
      )).resolves.toBe('immutable');

      const seekable = await openReadWriteFile(
        scope as never,
        'media/seekable.mp4',
      );
      try {
        expect((await seekable.stat()).mode & 0o777).toBe(0o600);
        await seekable.write(Buffer.from('abcdef'), 0, 6, 0);
        const buffer = Buffer.alloc(3);
        await seekable.read(buffer, 0, 3, 2);
        expect(buffer.toString()).toBe('cde');
      } finally {
        await seekable.close();
      }
      await expect(openReadWriteFile(
        scope as never,
        'media/seekable.mp4',
      )).rejects.toMatchObject({code: 'EEXIST'});
    },
  );

  it.each(['run', 'output'] as const)(
    'rejects %s read, write-only, and read-write symlink escapes',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const outsideRoot = await makeTempDirectory('app-scopes-outside-');
      await writeFile(path.join(outsideRoot, 'secret.txt'), 'secret');
      const scope = kind === 'run'
        ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
        : await createOutputStore(workspaceRoot).openProject('demo');
      const scopeRoot = kind === 'run'
        ? path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one')
        : path.join(workspaceRoot, 'output', 'demo');
      await symlink(outsideRoot, path.join(scopeRoot, 'escape'));

      const openExistingFile = kind === 'run'
        ? openExistingRunFile
        : openExistingOutputFile;
      const openNewFile = kind === 'run'
        ? openNewRunFile
        : openNewOutputFile;
      const openReadWriteFile = kind === 'run'
        ? openNewRunReadWriteFile
        : openNewOutputReadWriteFile;

      await expect(openExistingFile(scope as never, 'escape/secret.txt'))
        .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
      await expect(openNewFile(scope as never, 'escape/new.txt'))
        .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
      await expect(openReadWriteFile(scope as never, 'escape/new.mp4'))
        .rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    },
  );

  it.each(['work', 'run', 'output'] as const)(
    'fails closed after lexical %s root replacement',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const scope = kind === 'work'
        ? await createWorkDirectoryScope(workspaceRoot, 'demo')
        : kind === 'run'
          ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
          : await createOutputStore(workspaceRoot).openProject('demo');
      const scopeRoot = kind === 'work'
        ? path.join(workspaceRoot, '.work', 'demo')
        : kind === 'run'
          ? path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one')
          : path.join(workspaceRoot, 'output', 'demo');
      await rename(scopeRoot, `${scopeRoot}-original`);
      await mkdir(scopeRoot);

      const pending = kind === 'work'
        ? fixedProjectLockApi().openNewProjectLockFile(scope as WorkDirectoryScope)
        : kind === 'run'
          ? openNewRunReadWriteFile(scope as RunDirectoryScope, 'new.mp4')
          : openNewOutputReadWriteFile(scope as OutputDirectoryScope, 'new.mp4');
      await expect(pending).rejects.toMatchObject({
        code: 'APP_PATH_OUTSIDE_SCOPE',
      });
    },
  );

  it.each(['work', 'run', 'output'] as const)(
    'fails closed when the canonical %s root becomes an external symlink',
    async (kind) => {
      const workspaceRoot = await makeTempDirectory(`app-scopes-${kind}-`);
      const outsideRoot = await makeTempDirectory('app-scopes-outside-');
      const scope = kind === 'work'
        ? await createWorkDirectoryScope(workspaceRoot, 'demo')
        : kind === 'run'
          ? await createRunStore(workspaceRoot).createRun('demo', 'run-one')
          : await createOutputStore(workspaceRoot).openProject('demo');
      const scopeRoot = kind === 'work'
        ? path.join(workspaceRoot, '.work', 'demo')
        : kind === 'run'
          ? path.join(workspaceRoot, '.work', 'demo', 'runs', 'run-one')
          : path.join(workspaceRoot, 'output', 'demo');
      await rename(scopeRoot, `${scopeRoot}-original`);
      await symlink(outsideRoot, scopeRoot);

      const pending = kind === 'work'
        ? fixedProjectLockApi().openNewProjectLockFile(scope as WorkDirectoryScope)
        : kind === 'run'
          ? openNewRunFile(scope as RunDirectoryScope, 'new.txt')
          : openNewOutputFile(scope as OutputDirectoryScope, 'new.txt');
      await expect(pending).rejects.toMatchObject({
        code: 'APP_PATH_OUTSIDE_SCOPE',
      });
    },
  );

  it.each([
    ['success', 'success'],
    ['failure', 'failure'],
    ['abort', 'abort'],
    ['timeout', 'timeout'],
  ] as const)('keeps borrowed Run handles caller-owned after %s', async (_label, mode) => {
    const workspaceRoot = await makeTempDirectory('app-scopes-borrowed-');
    const run = await createRunStore(workspaceRoot).createRun('demo', 'run-one');
    await writeAndClose(await openNewRunFile(run, 'input.txt'), 'input');
    const handle = await openExistingRunFile(run, 'input.txt');

    try {
      const controller = new AbortController();
      const script = mode === 'success'
        ? 'require("node:fs").readFileSync(3); process.exit(0)'
        : mode === 'failure'
          ? 'require("node:fs").readFileSync(3); process.exit(2)'
          : 'require("node:fs").readFileSync(3); setInterval(() => {}, 1000)';
      const pending = runProcess(process.execPath, ['-e', script], {
        extraStdioFds: [handle.fd],
        ...(mode === 'abort' ? {signal: controller.signal} : {}),
        ...(mode === 'timeout' ? {timeoutMs: 20} : {}),
      });
      if (mode === 'abort') setTimeout(() => controller.abort('test abort'), 20);

      if (mode === 'success') {
        await expect(pending).resolves.toMatchObject({exitCode: 0});
      } else {
        await expect(pending).rejects.toBeInstanceOf(Error);
      }
      await expect(handle.stat()).resolves.toMatchObject({
        mode: expect.any(Number),
      });
    } finally {
      await handle.close();
    }
  });

  it('uses exclusive no-follow file modes', async () => {
    expect(constants.O_EXCL).toBeGreaterThan(0);
  });
});
