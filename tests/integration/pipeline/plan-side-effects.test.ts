import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type {OutputStore, RunStore} from '../../../src/pipeline/run-store';
import {createTempProject} from '../../helpers/temp-project';

afterEach(() => {
  vi.doUnmock('node:fs/promises');
  vi.doUnmock('../../../src/process/run-process');
  vi.doUnmock('../../../src/pipeline/project-lock');
  vi.resetModules();
});

describe('Execution Plan side effects', () => {
  it('builds a Release plan without writes, locks, subprocesses, or directories', async () => {
    const fixture = await createTempProject();
    const forbiddenWrites = vi.fn(async (): Promise<never> => {
      throw new Error('plan mode attempted a filesystem mutation');
    });
    const forbiddenProcesses = vi.fn(async (): Promise<never> => {
      throw new Error('plan mode attempted a subprocess');
    });
    const forbiddenLocks = vi.fn(async (): Promise<never> => {
      throw new Error('plan mode attempted a project lock');
    });

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      return {
        ...actual,
        link: forbiddenWrites,
        mkdir: forbiddenWrites,
        rename: forbiddenWrites,
        unlink: forbiddenWrites,
        writeFile: forbiddenWrites,
      };
    });
    vi.doMock('../../../src/process/run-process', async () => {
      const actual = await vi.importActual<
        typeof import('../../../src/process/run-process')
      >('../../../src/process/run-process');
      return {...actual, runProcess: forbiddenProcesses};
    });
    vi.doMock('../../../src/pipeline/project-lock', async () => {
      const actual = await vi.importActual<
        typeof import('../../../src/pipeline/project-lock')
      >('../../../src/pipeline/project-lock');
      return {...actual, acquireProjectLock: forbiddenLocks};
    });

    try {
      const [
        {loadProject},
        {buildExecutionPlan},
        {MVP_STAGES},
        {createStageReportStore},
        scopes,
      ] = await Promise.all([
        import('../../../src/domain/load-project'),
        import('../../../src/pipeline/execution-plan'),
        import('../../../src/pipeline/stage-registry'),
        import('../../../src/pipeline/stage-report'),
        import('../../../src/fs/app-directory-scopes'),
      ]);
      const project = await loadProject(fixture.workspaceRoot, 'demo');
      const actualRunStore = scopes.createRunStore(fixture.workspaceRoot);
      const actualOutputStore = scopes.createOutputStore(fixture.workspaceRoot);
      const runStore = new Proxy(actualRunStore, {
        get(target, property, receiver) {
          if (['createWork', 'createRun', 'readCurrent', 'publishCurrent'].includes(
            String(property),
          )) return forbiddenWrites;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as RunStore;
      const outputStore = new Proxy(actualOutputStore, {
        get(target, property, receiver) {
          if (['openProject', 'createRelease', 'readCurrent', 'publishCurrent'].includes(
            String(property),
          )) return forbiddenWrites;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as OutputStore;

      const plan = await buildExecutionPlan({
        project,
        sourceCatalog: {
          assets: [],
          totalBytes: 0,
          fingerprint: `sha256:${'a'.repeat(64)}`,
        },
        registry: MVP_STAGES,
        runStore,
        outputStore,
        reportStore: createStageReportStore(),
        createRunId: () => 'plan-run',
      }, {preset: 'release'});

      expect(plan).toMatchObject({
        runMode: 'new',
        items: expect.arrayContaining([
          expect.objectContaining({stageId: 'preflight', action: 'run'}),
        ]),
      });
      expect(forbiddenWrites).not.toHaveBeenCalled();
      expect(forbiddenProcesses).not.toHaveBeenCalled();
      expect(forbiddenLocks).not.toHaveBeenCalled();
      await expect(lstat(path.join(fixture.workspaceRoot, '.work')))
        .rejects.toMatchObject({code: 'ENOENT'});
      await expect(lstat(path.join(fixture.workspaceRoot, 'output')))
        .rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await fixture.cleanup();
    }
  });
});
