import {constants} from 'node:fs';
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {
  ensureRunDirectory,
  openNewRunFile,
} from '../../../src/fs/app-directory-scopes';
import {
  StageReportSchema,
  createStageReportStore,
} from '../../../src/pipeline/stage-report';
import {
  createPipelineRunFixture,
  passedStageReport,
} from '../../helpers/pipeline-fixtures';

describe('StageReportSchema', () => {
  it.each([
    ['unknown properties', {...passedStageReport(), unexpected: true}],
    ['non-canonical timestamps', {
      ...passedStageReport(),
      startedAt: '2026-08-11T09:02:03+08:00',
    }],
    ['positions below one', {...passedStageReport(), position: 0}],
    ['positions above total', {...passedStageReport(), position: 8, total: 7}],
    ['passed reports without fingerprints', {
      ...passedStageReport(),
      fingerprint: null,
    }],
    ['cached reports without fingerprints', {
      ...passedStageReport(),
      state: 'cached',
      fingerprint: null,
    }],
    ['failed reports without errors', {
      ...passedStageReport(),
      state: 'failed',
      fingerprint: null,
    }],
    ['cancelled reports without errors', {
      ...passedStageReport(),
      state: 'cancelled',
      fingerprint: null,
    }],
  ])('rejects %s', (_label, report) => {
    expect(() => StageReportSchema.parse(report)).toThrow();
  });
});

describe('StageReportStore', () => {
  it('round-trips a strict passed Stage report', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      const store = createStageReportStore();
      const report = passedStageReport({stageId: 'ingest'});

      await store.writeStage(fixture.runDirectory, report);

      await expect(store.readStage(fixture.runDirectory, 'ingest'))
        .resolves.toEqual(report);
    } finally {
      await fixture.cleanup();
    }
  });

  it('returns null only for an ordinary missing canonical report', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      const store = createStageReportStore();

      await expect(store.readStage(fixture.runDirectory, 'ingest'))
        .resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('keeps canonical Stage reports immutable', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      const store = createStageReportStore();
      const report = passedStageReport({stageId: 'ingest'});
      await store.writeStage(fixture.runDirectory, report);

      await expect(store.writeStage(fixture.runDirectory, report))
        .rejects.toMatchObject({code: 'EEXIST'});
    } finally {
      await fixture.cleanup();
    }
  });

  it('removes a canonical report when directory-authority close fails', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'stage-report-close-'));
    const closeError = Object.assign(new Error('directory authority close failed'), {
      code: 'EIO',
    });
    let armed = false;
    let directoryProxied = false;
    let directoryCloseFailed = false;
    let reportFileOpened = false;
    let reportFileClosed = false;
    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
      return {
        ...actual,
        open: async (...args: Parameters<typeof actual.open>) => {
          const handle = await Reflect.apply(actual.open, undefined, args);
          if (!armed) return handle;
          const flags = Number(args[1]);
          if ((flags & constants.O_CREAT) !== 0) {
            reportFileOpened = true;
            return new Proxy(handle, {
              get(target, property) {
                if (property === 'close') {
                  return async () => {
                    await target.close();
                    reportFileClosed = true;
                  };
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            });
          }
          const status = await handle.stat({bigint: true});
          if (!status.isDirectory()) return handle;
          directoryProxied = true;
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'close') {
                return async () => {
                  await target.close();
                  if (reportFileOpened && !directoryCloseFailed) {
                    directoryCloseFailed = true;
                    throw closeError;
                  }
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      };
    });

    try {
      const scopes = await import('../../../src/fs/app-directory-scopes');
      const reports = await import('../../../src/pipeline/stage-report');
      const runDirectory = await scopes.createRunStore(workspaceRoot)
        .createRun('demo', 'run-one');
      const store = reports.createStageReportStore();
      const report = passedStageReport({stageId: 'ingest'});
      armed = true;

      let writeError: unknown;
      try {
        await store.writeStage(runDirectory, report);
      } catch (error) {
        writeError = error;
      }

      expect(writeError).toBe(closeError);
      expect(directoryProxied).toBe(true);
      expect(directoryCloseFailed).toBe(true);
      expect(reportFileClosed).toBe(true);
      await expect(scopes.openExistingRunFile(
        runDirectory,
        'reports/ingest.json',
      )).rejects.toMatchObject({code: 'ENOENT'});

      await expect(store.writeStage(runDirectory, report)).resolves.toBeUndefined();
      await expect(store.readStage(runDirectory, 'ingest')).resolves.toEqual(report);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await rm(workspaceRoot, {recursive: true, force: true});
    }
  });

  it('writes review attempts outside the canonical report path', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      const store = createStageReportStore();
      const report = passedStageReport({
        stageId: 'review',
        state: 'needs_review',
        position: 6,
      });

      const attemptId = await store.writeAttempt(fixture.runDirectory, report);

      const attemptPath = path.join(
        fixture.workspaceRoot,
        '.work',
        'demo',
        'runs',
        'run-one',
        'reports',
        'attempts',
        `${attemptId}.json`,
      );
      await expect(readFile(attemptPath, 'utf8').then(JSON.parse))
        .resolves.toEqual(report);
      await expect(store.readStage(fixture.runDirectory, 'review'))
        .resolves.toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it('rejects reports written through the wrong persistence path', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      const store = createStageReportStore();
      const passed = passedStageReport({stageId: 'review'});
      const needsReview = passedStageReport({
        stageId: 'review',
        state: 'needs_review',
        position: 6,
      });

      await expect(store.writeStage(fixture.runDirectory, needsReview))
        .rejects.toThrow();
      await expect(store.writeAttempt(fixture.runDirectory, passed))
        .rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed for malformed canonical report JSON', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      await ensureRunDirectory(fixture.runDirectory, 'reports');
      const handle = await openNewRunFile(
        fixture.runDirectory,
        'reports/ingest.json',
      );
      try {
        await handle.writeFile('{not-json');
      } finally {
        await handle.close();
      }

      await expect(createStageReportStore().readStage(
        fixture.runDirectory,
        'ingest',
      )).rejects.toBeInstanceOf(Error);
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['an attempt state', passedStageReport({
      stageId: 'ingest',
      state: 'needs_review',
    })],
    ['a mismatched Stage ID', passedStageReport({stageId: 'draft'})],
  ])('fails closed for canonical reports with %s', async (_label, report) => {
    const fixture = await createPipelineRunFixture();
    try {
      await ensureRunDirectory(fixture.runDirectory, 'reports');
      const handle = await openNewRunFile(
        fixture.runDirectory,
        'reports/ingest.json',
      );
      try {
        await handle.writeFile(JSON.stringify(report));
      } finally {
        await handle.close();
      }

      await expect(createStageReportStore().readStage(
        fixture.runDirectory,
        'ingest',
      )).rejects.toThrow(/STAGE_REPORT_INVALID/u);
    } finally {
      await fixture.cleanup();
    }
  });

  it('fails closed for unsafe canonical report paths', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      await ensureRunDirectory(fixture.runDirectory, 'reports');
      const outsidePath = path.join(fixture.workspaceRoot, 'outside.json');
      await writeFile(outsidePath, JSON.stringify(passedStageReport()));
      await symlink(
        outsidePath,
        path.join(
          fixture.workspaceRoot,
          '.work',
          'demo',
          'runs',
          'run-one',
          'reports',
          'ingest.json',
        ),
      );

      await expect(createStageReportStore().readStage(
        fixture.runDirectory,
        'ingest',
      )).rejects.toMatchObject({code: 'APP_PATH_OUTSIDE_SCOPE'});
    } finally {
      await fixture.cleanup();
    }
  });
});
