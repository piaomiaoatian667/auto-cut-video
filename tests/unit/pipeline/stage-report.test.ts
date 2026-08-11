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

interface DirectorySyncProbe {
  armed: boolean;
  reportFileOpened: boolean;
  syncErrors: unknown[];
  syncPaths: string[];
  postCreateSyncPaths: string[];
}

const importReportModulesWithDirectorySyncProbe = async (
  probe: DirectorySyncProbe,
) => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await Reflect.apply(actual.open, undefined, args);
        if (!probe.armed) return handle;
        const flags = Number(args[1]);
        if ((flags & constants.O_CREAT) !== 0) {
          probe.reportFileOpened = true;
          return handle;
        }
        const status = await handle.stat({bigint: true});
        if (!status.isDirectory()) return handle;
        const openedPath = String(args[0]);
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'sync') {
              return async () => {
                const basename = path.basename(openedPath);
                probe.syncPaths.push(basename);
                if (probe.reportFileOpened) {
                  probe.postCreateSyncPaths.push(basename);
                  const syncError = probe.syncErrors.shift();
                  if (syncError !== undefined) throw syncError;
                }
                await target.sync();
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  });
  return {
    scopes: await import('../../../src/fs/app-directory-scopes'),
    reports: await import('../../../src/pipeline/stage-report'),
  };
};

interface ReadAuthorityFaultProbe {
  armed: boolean;
  closeError: unknown;
  afterRead?: () => Promise<void>;
}

const importReportModulesWithReadAuthorityFault = async (
  probe: ReadAuthorityFaultProbe,
) => {
  vi.resetModules();
  vi.doMock('node:fs/promises', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
    return {
      ...actual,
      open: async (...args: Parameters<typeof actual.open>) => {
        const handle = await Reflect.apply(actual.open, undefined, args);
        if (!probe.armed) return handle;
        const status = await handle.stat({bigint: true});
        if (!status.isFile()) return handle;
        return new Proxy(handle, {
          get(target, property) {
            if (property === 'readFile') {
              return async (...readArgs: Parameters<typeof target.readFile>) => {
                const value = await Reflect.apply(target.readFile, target, readArgs);
                await probe.afterRead?.();
                return value;
              };
            }
            if (property === 'close') {
              return async () => {
                await target.close();
                throw probe.closeError;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    };
  });
  return {
    scopes: await import('../../../src/fs/app-directory-scopes'),
    reports: await import('../../../src/pipeline/stage-report'),
  };
};

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
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'preflight',
      },
    }],
    ['needs-review reports without fingerprints', {
      ...passedStageReport(),
      state: 'needs_review',
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
    ['Stages outside their Preset', {
      ...passedStageReport({stageId: 'narration'}),
      preset: 'assets',
    }],
    ['finish times before start times', {
      ...passedStageReport(),
      finishedAt: '2026-08-11T01:02:02.000Z',
    }],
    ['passed reports with errors', {
      ...passedStageReport(),
      error: {code: 'UNEXPECTED', message: 'unexpected'},
    }],
    ['cached reports with errors', {
      ...passedStageReport(),
      state: 'cached',
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'preflight',
      },
      error: {code: 'UNEXPECTED', message: 'unexpected'},
    }],
    ['needs-review reports with errors', {
      ...passedStageReport(),
      state: 'needs_review',
      error: {code: 'UNEXPECTED', message: 'unexpected'},
    }],
    ['cached reports without provenance', {
      ...passedStageReport(),
      state: 'cached',
    }],
    ['cached reports with mismatched provenance', {
      ...passedStageReport(),
      state: 'cached',
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'ingest',
      },
    }],
    ['passed reports with provenance', {
      ...passedStageReport(),
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'preflight',
      },
    }],
    ['needs-review reports with provenance', {
      ...passedStageReport(),
      state: 'needs_review',
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'preflight',
      },
    }],
    ['failed reports with provenance', {
      ...passedStageReport(),
      state: 'failed',
      fingerprint: null,
      error: {code: 'FAILED', message: 'failed'},
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'preflight',
      },
    }],
    ['cancelled reports with provenance', {
      ...passedStageReport(),
      state: 'cancelled',
      fingerprint: null,
      error: {code: 'CANCELLED', message: 'cancelled'},
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'preflight',
      },
    }],
  ])('rejects %s', (_label, report) => {
    expect(() => StageReportSchema.parse(report)).toThrow();
  });

  it('accepts a cached report with matching provenance', () => {
    const report = passedStageReport({
      stageId: 'ingest',
      state: 'cached',
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'ingest',
      },
    });

    expect(StageReportSchema.parse(report)).toEqual(report);
  });

  it.each([
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a function', () => 'not JSON'],
    ['a Date', new Date('2026-08-11T01:02:03.000Z')],
    ['nested undefined', {nested: undefined}],
    ['nested non-finite numbers', {nested: [1, Number.NEGATIVE_INFINITY]}],
    ['BigInt', 1n],
  ])('rejects %s in report outputs', (_label, outputs) => {
    expect(() => StageReportSchema.parse({
      ...passedStageReport(),
      outputs,
    })).toThrow();
  });

  it.each([
    '/absolute/file.json',
    'https://example.com/file.json',
    'C:/absolute/file.json',
    'nested\\file.json',
    './file.json',
    'nested/./file.json',
    'nested/../file.json',
    'nested//file.json',
    'nested/',
  ])('rejects unsafe artifact path %s', (artifactPath) => {
    expect(() => StageReportSchema.parse({
      ...passedStageReport(),
      artifacts: [{
        scope: 'run',
        path: artifactPath,
        sha256: `sha256:${'e'.repeat(64)}`,
      }],
    })).toThrow();
  });

  it.each([
    ['non-finite check values', {
      id: 'duration',
      severity: 'warning',
      message: 'duration check',
      value: Number.POSITIVE_INFINITY,
    }],
    ['empty affected paths', {
      id: 'tool',
      severity: 'warning',
      message: 'tool check',
      affectedPaths: [''],
    }],
  ])('rejects %s', (_label, check) => {
    expect(() => StageReportSchema.parse({
      ...passedStageReport(),
      checks: [check],
    })).toThrow();
  });

  it('accepts recursive JSON outputs and absolute Check paths', () => {
    const report = passedStageReport({
      outputs: {
        nested: [null, true, 1.25, 'value', {child: false}],
      },
      artifacts: [{
        scope: 'run',
        path: 'nested/file.json',
        sha256: `sha256:${'e'.repeat(64)}`,
      }],
      checks: [{
        id: 'tool-path',
        severity: 'info',
        message: 'resolved executable',
        value: 1.25,
        affectedPaths: ['/opt/homebrew/bin/ffmpeg'],
      }],
    });

    expect(StageReportSchema.parse(report)).toEqual(report);
  });
});

describe('StageReportStore', () => {
  it('exposes immutable identity for a minted Run scope', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      const scopes = await import('../../../src/fs/app-directory-scopes');
      const getRunDirectoryIdentity = (
        scopes as unknown as {
          getRunDirectoryIdentity?: (
            run: typeof fixture.runDirectory,
          ) => {projectId: string; runId: string};
        }
      ).getRunDirectoryIdentity;

      expect(getRunDirectoryIdentity).toBeTypeOf('function');
      const identity = getRunDirectoryIdentity!(fixture.runDirectory);
      expect(identity).toEqual({projectId: 'demo', runId: 'run-one'});
      expect(Object.isFrozen(identity)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

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

  it.each([
    ['canonical', 'projectId', 'other-project'],
    ['canonical', 'runId', 'other-run'],
    ['attempt', 'projectId', 'other-project'],
    ['attempt', 'runId', 'other-run'],
  ] as const)(
    'rejects %s report writes with mismatched %s',
    async (kind, field, value) => {
      const fixture = await createPipelineRunFixture();
      try {
        const store = createStageReportStore();
        const report = kind === 'canonical'
          ? passedStageReport({stageId: 'ingest', [field]: value})
          : passedStageReport({
            stageId: 'review',
            state: 'needs_review',
            position: 6,
            [field]: value,
          });

        const pending = kind === 'canonical'
          ? store.writeStage(fixture.runDirectory, report)
          : store.writeAttempt(fixture.runDirectory, report);
        await expect(pending).rejects.toThrow(/STAGE_REPORT_INVALID/u);
      } finally {
        await fixture.cleanup();
      }
    },
  );

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

  it.each([
    ['canonical', ['run-one', 'reports']],
    ['attempt', ['run-one', 'reports', 'attempts']],
  ] as const)(
    'syncs parent directory entries for %s report creation',
    async (kind, expectedSyncPaths) => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'stage-report-sync-'));
      const probe: DirectorySyncProbe = {
        armed: false,
        reportFileOpened: false,
        syncErrors: [],
        syncPaths: [],
        postCreateSyncPaths: [],
      };
      const {scopes, reports} = await importReportModulesWithDirectorySyncProbe(
        probe,
      );
      try {
        const runDirectory = await scopes.createRunStore(workspaceRoot)
          .createRun('demo', 'run-one');
        const store = reports.createStageReportStore();
        probe.armed = true;

        if (kind === 'canonical') {
          await store.writeStage(
            runDirectory,
            passedStageReport({stageId: 'ingest'}),
          );
        } else {
          await store.writeAttempt(runDirectory, passedStageReport({
            stageId: 'review',
            state: 'needs_review',
            position: 6,
          }));
        }

        expect(probe.syncPaths).toEqual(expectedSyncPaths);
      } finally {
        vi.doUnmock('node:fs/promises');
        vi.resetModules();
        await rm(workspaceRoot, {recursive: true, force: true});
      }
    },
  );

  it.each([
    ['create sync only', false],
    ['create and rollback sync', true],
  ] as const)(
    'preserves %s failures while removing the report',
    async (_label, failRollbackSync) => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'stage-report-sync-'));
      const createSyncError = Object.assign(new Error('report create sync failed'), {
        code: 'EIO',
      });
      const rollbackSyncError = Object.assign(new Error('report unlink sync failed'), {
        code: 'EIO',
      });
      const probe: DirectorySyncProbe = {
        armed: false,
        reportFileOpened: false,
        syncErrors: failRollbackSync
          ? [createSyncError, rollbackSyncError]
          : [createSyncError],
        syncPaths: [],
        postCreateSyncPaths: [],
      };
      const {scopes, reports} = await importReportModulesWithDirectorySyncProbe(
        probe,
      );
      try {
        const runDirectory = await scopes.createRunStore(workspaceRoot)
          .createRun('demo', 'run-one');
        const store = reports.createStageReportStore();
        const report = passedStageReport({stageId: 'ingest'});
        probe.armed = true;

        let writeError: unknown;
        try {
          await store.writeStage(runDirectory, report);
        } catch (error) {
          writeError = error;
        }

        if (failRollbackSync) {
          expect(writeError).toBeInstanceOf(AggregateError);
          expect((writeError as AggregateError).errors).toEqual([
            createSyncError,
            rollbackSyncError,
          ]);
        } else {
          expect(writeError).toBe(createSyncError);
        }
        expect(probe.postCreateSyncPaths.slice(0, 2))
          .toEqual(['reports', 'reports']);
        await expect(scopes.openExistingRunFile(
          runDirectory,
          'reports/ingest.json',
        )).rejects.toMatchObject({code: 'ENOENT'});

        await expect(store.writeStage(runDirectory, report)).resolves.toBeUndefined();
      } finally {
        vi.doUnmock('node:fs/promises');
        vi.resetModules();
        await rm(workspaceRoot, {recursive: true, force: true});
      }
    },
  );

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

  it.each([
    ['needs_review', passedStageReport({
      stageId: 'review',
      state: 'needs_review',
      position: 6,
    })],
    ['failed', passedStageReport({
      stageId: 'review',
      state: 'failed',
      fingerprint: null,
      position: 6,
      error: {code: 'FAILED', message: 'failed'},
    })],
    ['cancelled', passedStageReport({
      stageId: 'review',
      state: 'cancelled',
      fingerprint: null,
      position: 6,
      error: {code: 'CANCELLED', message: 'cancelled'},
    })],
  ])('rejects %s reports on the canonical path', async (_state, report) => {
    const fixture = await createPipelineRunFixture();
    try {
      const store = createStageReportStore();

      await expect(store.writeStage(fixture.runDirectory, report))
        .rejects.toThrow();
    } finally {
      await fixture.cleanup();
    }
  });

  it.each([
    ['passed', passedStageReport({stageId: 'review'})],
    ['cached', passedStageReport({
      stageId: 'review',
      state: 'cached',
      position: 6,
      provenance: {
        sourceRunId: 'source-run',
        sourceStageId: 'review',
      },
    })],
  ])('rejects %s reports on the attempt path', async (_state, report) => {
    const fixture = await createPipelineRunFixture();
    try {
      await expect(createStageReportStore().writeAttempt(
        fixture.runDirectory,
        report,
      ))
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
    ['JSON', '{not-json', (error: unknown) => {
      expect(error).toBeInstanceOf(SyntaxError);
    }],
    ['schema', JSON.stringify({...passedStageReport({stageId: 'ingest'}), extra: true}),
      (error: unknown) => {
        expect(error).toMatchObject({name: 'ZodError'});
      }],
    ['Stage metadata', JSON.stringify(passedStageReport({stageId: 'draft'})),
      (error: unknown) => {
        expect(error).toMatchObject({message: expect.stringMatching(/STAGE_REPORT_INVALID/u)});
      }],
  ] as const)(
    'preserves primary %s and authority-close failures',
    async (_label, raw, assertPrimary) => {
      const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'stage-report-read-'));
      const closeError = Object.assign(new Error('report read close failed'), {
        code: 'EIO',
      });
      const probe: ReadAuthorityFaultProbe = {
        armed: false,
        closeError,
      };
      const {scopes, reports} = await importReportModulesWithReadAuthorityFault(
        probe,
      );
      try {
        const runDirectory = await scopes.createRunStore(workspaceRoot)
          .createRun('demo', 'run-one');
        await scopes.ensureRunDirectory(runDirectory, 'reports');
        const handle = await scopes.openNewRunFile(
          runDirectory,
          'reports/ingest.json',
        );
        await handle.writeFile(raw);
        await handle.close();
        probe.armed = true;

        let caughtError: unknown;
        try {
          await reports.createStageReportStore().readStage(
            runDirectory,
            'ingest',
          );
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(AggregateError);
        const errors = (caughtError as AggregateError).errors;
        expect(errors).toHaveLength(2);
        assertPrimary(errors[0]);
        expect(errors[1]).toBe(closeError);
      } finally {
        vi.doUnmock('node:fs/promises');
        vi.resetModules();
        await rm(workspaceRoot, {recursive: true, force: true});
      }
    },
  );

  it('preserves revalidation and authority-close failures', async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'stage-report-read-'));
    const reportPath = path.join(
      workspaceRoot,
      '.work',
      'demo',
      'runs',
      'run-one',
      'reports',
      'ingest.json',
    );
    const closeError = Object.assign(new Error('report read close failed'), {
      code: 'EIO',
    });
    const probe: ReadAuthorityFaultProbe = {
      armed: false,
      closeError,
      afterRead: async () => await writeFile(reportPath, 'changed'),
    };
    const {scopes, reports} = await importReportModulesWithReadAuthorityFault(
      probe,
    );
    try {
      const runDirectory = await scopes.createRunStore(workspaceRoot)
        .createRun('demo', 'run-one');
      await scopes.ensureRunDirectory(runDirectory, 'reports');
      const handle = await scopes.openNewRunFile(
        runDirectory,
        'reports/ingest.json',
      );
      await handle.writeFile(JSON.stringify(passedStageReport({stageId: 'ingest'})));
      await handle.close();
      probe.armed = true;

      let caughtError: unknown;
      try {
        await reports.createStageReportStore().readStage(
          runDirectory,
          'ingest',
        );
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(AggregateError);
      expect((caughtError as AggregateError).errors).toEqual([
        expect.objectContaining({code: 'APP_PATH_OUTSIDE_SCOPE'}),
        closeError,
      ]);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
      await rm(workspaceRoot, {recursive: true, force: true});
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

  it.each([
    ['projectId', 'other-project'],
    ['runId', 'other-run'],
  ] as const)(
    'fails closed when a canonical report has a mismatched %s',
    async (field, value) => {
      const fixture = await createPipelineRunFixture();
      try {
        await ensureRunDirectory(fixture.runDirectory, 'reports');
        const handle = await openNewRunFile(
          fixture.runDirectory,
          'reports/ingest.json',
        );
        try {
          await handle.writeFile(JSON.stringify(passedStageReport({
            stageId: 'ingest',
            [field]: value,
          })));
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
    },
  );

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
