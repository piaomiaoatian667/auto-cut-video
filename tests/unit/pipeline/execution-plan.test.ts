import {describe, expect, it, vi} from 'vitest';
import type {ProjectInputs} from '../../../src/domain/load-project';
import type {RunDirectoryScope} from '../../../src/fs/app-directory-scopes';
import {
  buildExecutionPlan,
  type ExecutionPlanContext,
  type ExecutionPlanRequest,
} from '../../../src/pipeline/execution-plan';
import {STAGE_PRESETS} from '../../../src/pipeline/presets';
import type {
  CurrentPointer,
  OutputStore,
  PipelinePreset,
  RunStore,
  StageId,
} from '../../../src/pipeline/run-store';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import type {StageReport, StageReportStore} from '../../../src/pipeline/stage-report';
import {fakeStage, passedStageReport} from '../../helpers/pipeline-fixtures';

const STAGE_IDS = [...STAGE_PRESETS.release];

const PREREQUISITES: Record<StageId, readonly StageId[]> = {
  preflight: [],
  ingest: ['preflight'],
  narration: ['preflight'],
  compile: ['ingest', 'narration'],
  draft: ['compile'],
  review: ['draft'],
  release: ['review'],
};

const stageFingerprint = (stageId: StageId, version = 'current'): string =>
  `${stageId}-${version}`;

const pointer = (
  completedStage: StageId,
  overrides: Partial<CurrentPointer> = {},
): CurrentPointer => ({
  runId: 'run-one',
  relativePath: 'runs/run-one',
  preset: 'release',
  stageIds: [...STAGE_PRESETS.release],
  completedStage,
  state: 'passed',
  publishedAt: '2026-08-11T00:00:00.000Z',
  ...overrides,
});

const reportsThrough = (
  completedStage: StageId,
  overrides: Partial<Record<StageId, Partial<StageReport>>> = {},
): Map<StageId, StageReport> => {
  const completedIndex = STAGE_IDS.indexOf(completedStage);
  return new Map(STAGE_IDS.slice(0, completedIndex + 1).map((stageId) => [
    stageId,
    passedStageReport({
      stageId,
      fingerprint: stageFingerprint(stageId),
      ...overrides[stageId],
    }),
  ]));
};

interface PlanScenario {
  current?: CurrentPointer | null;
  outputCurrent?: CurrentPointer | null;
  reports?: ReadonlyMap<StageId, StageReport>;
  fingerprints?: Partial<Record<StageId, string | null>>;
  verified?: Partial<Record<StageId, boolean>>;
}

const createContext = (scenario: PlanScenario = {}): {
  context: ExecutionPlanContext;
  createRunId: ReturnType<typeof vi.fn>;
} => {
  const runDirectory = {} as RunDirectoryScope;
  const reports = scenario.reports ?? new Map<StageId, StageReport>();
  const createRunId = vi.fn(() => 'run-new');
  const runStore = {
    openExistingWork: vi.fn(async () => scenario.current === null ? null : {}),
    readCurrentReadonly: vi.fn(async () => scenario.current ?? null),
    openExistingRun: vi.fn(async () => runDirectory),
  } as unknown as RunStore;
  const outputStore = {
    openExistingProject: vi.fn(async () => (
      scenario.outputCurrent === null ? null : {}
    )),
    readCurrentReadonly: vi.fn(async () => scenario.outputCurrent ?? null),
  } as unknown as OutputStore;
  const reportStore: StageReportStore = {
    readStage: vi.fn(async (_run, stageId) => reports.get(stageId) ?? null),
    writeStage: vi.fn(async () => undefined),
    writeAttempt: vi.fn(async () => 'unused-attempt'),
  };
  const registry = STAGE_IDS.map((stageId) => fakeStage(stageId, {
    displayName: stageId[0]!.toUpperCase() + stageId.slice(1),
    prerequisites: PREREQUISITES[stageId],
    fingerprint: vi.fn(async () => (
      scenario.fingerprints?.[stageId] === undefined
        ? stageFingerprint(stageId)
        : scenario.fingerprints[stageId]!
    )),
    verify: vi.fn(async () => scenario.verified?.[stageId] ?? true),
  }));
  const project = {
    workspaceRoot: '/workspace',
    project: {id: 'demo'},
  } as unknown as ProjectInputs;
  const sourceCatalog: ProjectSourceCatalog = {
    assets: [],
    totalBytes: 0,
    fingerprint: 'source-catalog-current',
  };

  return {
    createRunId,
    context: {
      project,
      sourceCatalog,
      registry,
      runStore,
      outputStore,
      reportStore,
      createRunId,
    },
  };
};

const build = async (
  scenario: PlanScenario,
  request: ExecutionPlanRequest,
) => await buildExecutionPlan(createContext(scenario).context, request);

describe('buildExecutionPlan', () => {
  it('defaults to the release Preset and numbers only selected items', async () => {
    const {context, createRunId} = createContext();

    const plan = await buildExecutionPlan(context, {});

    expect(plan).toMatchObject({
      version: 1,
      projectId: 'demo',
      preset: 'release',
      stageIds: STAGE_PRESETS.release,
      runMode: 'new',
      requiresRuntimePreflight: false,
      targetRunId: 'run-new',
    });
    expect(plan.items.map(({position, total, stageId}) => ({
      position,
      total,
      stageId,
    }))).toEqual([
      {position: 1, total: 7, stageId: 'preflight'},
      {position: 2, total: 7, stageId: 'ingest'},
      {position: 3, total: 7, stageId: 'narration'},
      {position: 4, total: 7, stageId: 'compile'},
      {position: 5, total: 7, stageId: 'draft'},
      {position: 6, total: 7, stageId: 'review'},
      {position: 7, total: 7, stageId: 'release'},
    ]);
    expect(plan.items.every((item) => item.action === 'run')).toBe(true);
    expect(createRunId).toHaveBeenCalledOnce();
  });

  it.each([
    [{preset: 'preview' as PipelinePreset}, 'PLAN_PRESET_INVALID'],
    [{from: 'encode' as StageId}, 'PLAN_STAGE_INVALID'],
    [{force: 'encode' as StageId}, 'PLAN_STAGE_INVALID'],
    [{preset: 'assets' as const, from: 'compile' as StageId}, 'PLAN_RANGE_INVALID'],
    [{from: 'draft' as const, to: 'compile' as const}, 'PLAN_RANGE_INVALID'],
    [{from: 'compile' as const, to: 'draft' as const, force: 'review' as const}, 'PLAN_RANGE_INVALID'],
  ] as const)('rejects invalid selection %o with %s', async (request, code) => {
    await expect(build({}, request)).rejects.toMatchObject({code});
  });

  it('selects inclusive bounds and binds omitted prerequisites to the current Run', async () => {
    const current = pointer('narration');

    const plan = await build({
      current,
      reports: reportsThrough('narration'),
    }, {
      preset: 'release',
      from: 'compile',
      to: 'draft',
    });

    expect(plan).toMatchObject({
      preset: 'release',
      stageIds: ['compile', 'draft'],
      runMode: 'resume',
      requiresRuntimePreflight: true,
      sourceRunId: 'run-one',
      targetRunId: 'run-one',
    });
    expect(plan.items.map((item) => [
      item.position,
      item.total,
      item.stageId,
      item.action,
      item.materialize,
    ])).toEqual([
      [1, 2, 'compile', 'resume', false],
      [2, 2, 'draft', 'run', false],
    ]);
  });

  it('rejects a sliced range without every verified prerequisite', async () => {
    await expect(build({
      current: pointer('ingest'),
      reports: reportsThrough('ingest'),
    }, {
      preset: 'release',
      from: 'compile',
      to: 'draft',
    })).rejects.toMatchObject({
      code: 'PLAN_PREREQUISITE_MISSING',
      stageId: 'narration',
    });
  });

  it('fails a stale omitted prerequisite instead of creating a new Run', async () => {
    const reports = reportsThrough('narration', {
      narration: {fingerprint: stageFingerprint('narration', 'old')},
    });
    const {context, createRunId} = createContext({
      current: pointer('narration'),
      reports,
    });

    await expect(buildExecutionPlan(context, {
      preset: 'release',
      from: 'compile',
      to: 'draft',
    })).rejects.toMatchObject({
      code: 'PLAN_RANGE_STALE',
      stageId: 'narration',
      message: expect.stringMatching(/widen --from to narration|remove --from/u),
    });
    expect(createRunId).not.toHaveBeenCalled();
  });

  it('accepts compatible cross-Preset prefixes for same-Run resume', async () => {
    const plan = await build({
      current: pointer('draft', {
        preset: 'draft',
        stageIds: [...STAGE_PRESETS.draft],
      }),
      reports: reportsThrough('draft'),
    }, {
      preset: 'release',
      resume: true,
    });

    expect(plan.runMode).toBe('resume');
    expect(plan.targetRunId).toBe('run-one');
    expect(plan.items.map((item) => [
      item.stageId,
      item.action,
      item.materialize,
    ])).toEqual([
      ['preflight', 'run', false],
      ['ingest', 'cached', false],
      ['narration', 'cached', false],
      ['compile', 'cached', false],
      ['draft', 'cached', false],
      ['review', 'resume', false],
      ['release', 'run', false],
    ]);
  });

  it('returns a no-op when every selected sliced Stage is verified', async () => {
    const plan = await build({
      current: pointer('draft'),
      reports: reportsThrough('draft'),
    }, {
      preset: 'release',
      from: 'compile',
      to: 'draft',
    });

    expect(plan.runMode).toBe('noop');
    expect(plan.items.map((item) => [
      item.stageId,
      item.action,
      item.materialize,
    ])).toEqual([
      ['compile', 'cached', false],
      ['draft', 'cached', false],
    ]);
  });

  it('resumes the first incomplete Stage in a matching current Run', async () => {
    const plan = await build({
      current: pointer('narration'),
      reports: reportsThrough('narration'),
    }, {
      preset: 'release',
      resume: true,
    });

    expect(plan.runMode).toBe('resume');
    expect(plan.items.map((item) => [item.stageId, item.action])).toEqual([
      ['preflight', 'run'],
      ['ingest', 'cached'],
      ['narration', 'cached'],
      ['compile', 'resume'],
      ['draft', 'run'],
      ['review', 'run'],
      ['release', 'run'],
    ]);
  });

  it('creates a new Run for --resume --force compile when Compile already passed', async () => {
    const plan = await build({
      current: pointer('release'),
      reports: reportsThrough('release'),
    }, {
      preset: 'release',
      resume: true,
      force: 'compile',
    });

    expect(plan.runMode).toBe('new');
    expect(plan.sourceRunId).toBe('run-one');
    expect(plan.targetRunId).toBe('run-new');
    expect(plan.items.map((item) => [
      item.stageId,
      item.action,
      item.materialize,
    ])).toEqual([
      ['preflight', 'run', false],
      ['ingest', 'cached', true],
      ['narration', 'cached', true],
      ['compile', 'run', false],
      ['draft', 'run', false],
      ['review', 'run', false],
      ['release', 'run', false],
    ]);
  });

  it('keeps the current Run when force targets the first incomplete Stage', async () => {
    const plan = await build({
      current: pointer('narration'),
      reports: reportsThrough('narration'),
    }, {
      preset: 'release',
      resume: true,
      force: 'compile',
    });

    expect(plan.runMode).toBe('resume');
    expect(plan.targetRunId).toBe('run-one');
    expect(plan.items.find((item) => item.stageId === 'compile')).toMatchObject({
      action: 'resume',
      materialize: false,
    });
  });

  it('starts a new Run at the first changed completed Stage', async () => {
    const plan = await build({
      current: pointer('release'),
      reports: reportsThrough('release'),
      fingerprints: {narration: stageFingerprint('narration', 'changed')},
    }, {
      preset: 'release',
      resume: true,
    });

    expect(plan.runMode).toBe('new');
    expect(plan.items.map((item) => [
      item.stageId,
      item.action,
      item.materialize,
    ])).toEqual([
      ['preflight', 'run', false],
      ['ingest', 'cached', true],
      ['narration', 'run', false],
      ['compile', 'run', false],
      ['draft', 'run', false],
      ['review', 'run', false],
      ['release', 'run', false],
    ]);
  });

  it('uses a published Output pointer when Work has no current pointer', async () => {
    const outputCurrent = pointer('release', {
      relativePath: 'releases/run-one',
    });

    const plan = await build({
      current: null,
      outputCurrent,
      reports: reportsThrough('release'),
    }, {
      preset: 'release',
      from: 'release',
      to: 'release',
    });

    expect(plan).toMatchObject({
      runMode: 'noop',
      sourceRunId: 'run-one',
      targetRunId: 'run-one',
      requiresRuntimePreflight: true,
    });
    expect(plan.items).toEqual([
      expect.objectContaining({
        stageId: 'release',
        action: 'cached',
        materialize: false,
      }),
    ]);
  });
});
