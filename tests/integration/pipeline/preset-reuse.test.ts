import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import {
  ensureRunDirectory,
  openExistingRunFileForRead,
  openNewRunFileForWrite,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {
  hashRunArtifact,
  verifyRunArtifact,
  type PipelineArtifact,
} from '../../../src/pipeline/artifacts';
import type {ExecutionPlan} from '../../../src/pipeline/execution-plan';
import {STAGE_PRESETS} from '../../../src/pipeline/presets';
import {
  createOutputStore,
  createRunStore,
  type PipelinePreset,
  type StageId,
} from '../../../src/pipeline/run-store';
import {
  runExecutionPlan,
  type RunnerDependencies,
} from '../../../src/pipeline/runner';
import type {ProjectSourceCatalog} from '../../../src/pipeline/source-assets';
import {
  requireRunContext,
  type PipelineStage,
  type StageAction,
} from '../../../src/pipeline/stage';
import {createStageReportStore} from '../../../src/pipeline/stage-report';
import {fakePreflightResult} from '../../helpers/pipeline-fixtures';
import {createTempProject} from '../../helpers/temp-project';

const NOW = '2026-08-11T15:00:00.000Z';
const SOURCE_HASH = `sha256:${'a'.repeat(64)}`;

const fingerprint = (stageId: StageId): string => `${stageId}-fingerprint`;

const catalog: ProjectSourceCatalog = {
  assets: [],
  totalBytes: 0,
  fingerprint: SOURCE_HASH,
};

const plan = ({
  preset,
  stageIds,
  actions,
  runMode,
  sourceRunId,
  targetRunId,
}: {
  preset: PipelinePreset;
  stageIds: readonly StageId[];
  actions: readonly StageAction[];
  runMode: ExecutionPlan['runMode'];
  sourceRunId?: string;
  targetRunId?: string;
}): ExecutionPlan => ({
  version: 1,
  projectId: 'demo',
  preset,
  stageIds: [...stageIds],
  runMode,
  requiresProgressReconciliation: false,
  requiresRuntimePreflight: false,
  ...(sourceRunId === undefined ? {} : {sourceRunId}),
  ...(targetRunId === undefined ? {} : {targetRunId}),
  items: stageIds.map((stageId, index) => {
    const action = actions[index]!;
    return {
      position: index + 1,
      total: stageIds.length,
      stageId,
      displayName: stageId,
      action,
      fingerprint: stageId === 'preflight' ? null : fingerprint(stageId),
      ...(sourceRunId === undefined || (action !== 'cached' && action !== 'resume')
        ? {}
        : {sourceRunId}),
      materialize: action === 'cached' && runMode === 'new',
    };
  }),
});

const writeArtifact = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  contents: string,
): Promise<PipelineArtifact> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const target = await openNewRunFileForWrite(runDirectory, relativePath);
  try {
    await target.handle.writeFile(contents);
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
  return await hashRunArtifact(runDirectory, relativePath);
};

const readArtifact = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<string> => {
  const source = await openExistingRunFileForRead(runDirectory, relativePath);
  try {
    const contents = await source.handle.readFile('utf8');
    await source.revalidate();
    return contents;
  } finally {
    await source.close();
  }
};

describe('Preset reuse', () => {
  it('copies verified new-Run prefixes and keeps same-Run resume artifacts', async () => {
    const tempProject = await createTempProject({tempPrefix: 'preset-reuse-'});
    try {
      const project = await loadProject(tempProject.workspaceRoot, 'demo');
      const runStore = createRunStore(tempProject.workspaceRoot);
      const outputStore = createOutputStore(tempProject.workspaceRoot);
      const reportStore = createStageReportStore();
      const calls: StageId[] = [];
      const artifactPaths: Partial<Record<StageId, string>> = {
        ingest: 'assets/manifest.json',
        narration: 'audio/narration.wav',
        compile: 'timeline/compiled.json',
        draft: 'draft/draft.mp4',
      };
      const registry: readonly PipelineStage[] = STAGE_PRESETS.release.map((stageId) => ({
        id: stageId,
        displayName: stageId,
        prerequisites: [],
        fingerprint: async (context) => (
          stageId === 'preflight' && context.preflight === undefined
            ? null
            : fingerprint(stageId)
        ),
        verify: async (context, report) => {
          if (
            report.projectId !== 'demo'
            || report.stageId !== stageId
            || report.fingerprint !== fingerprint(stageId)
            || context.sourceRun === undefined
          ) return false;
          for (const artifact of report.artifacts) {
            if (artifact.scope !== 'run') return false;
            if (!await verifyRunArtifact(context.sourceRun.runDirectory, artifact)) {
              return false;
            }
          }
          return true;
        },
        partialArtifacts: () => [],
        execute: async (context) => {
          calls.push(stageId);
          if (stageId === 'preflight') {
            const preflight = fakePreflightResult();
            return {
              state: 'passed',
              fingerprint: fingerprint(stageId),
              outputs: preflight,
              artifacts: [],
              checks: preflight.checks,
            };
          }
          const {runId, runDirectory} = requireRunContext(context);
          if (stageId === 'release') {
            await outputStore.createRelease('demo', runId);
            return {
              state: 'passed',
              fingerprint: fingerprint(stageId),
              outputs: {release: runId},
              artifacts: [],
              checks: [],
              outputCurrent: {
                runId,
                relativePath: `releases/${runId}`,
                preset: 'release',
                stageIds: [...STAGE_PRESETS.release],
                completedStage: 'release',
                state: 'passed',
                publishedAt: context.now(),
              },
            };
          }
          if (stageId === 'review') {
            return {
              state: 'passed',
              fingerprint: fingerprint(stageId),
              outputs: {approved: true},
              artifacts: [],
              checks: [],
            };
          }
          const artifactPath = artifactPaths[stageId]!;
          const artifact = await writeArtifact(
            runDirectory,
            artifactPath,
            `${stageId}-bytes`,
          );
          return {
            state: 'passed',
            fingerprint: fingerprint(stageId),
            outputs: {path: artifactPath},
            artifacts: [artifact],
            checks: [],
          };
        },
      }));
      const releaseLock = vi.fn(async () => undefined);
      const dependencies: RunnerDependencies = {
        registry,
        runStore,
        outputStore,
        reportStore,
        acquireProjectLock: vi.fn(async (_work, runId) => ({
          record: {
            pid: 1,
            hostname: 'test',
            processStart: 'test',
            createdAt: NOW,
            runId,
          },
          release: releaseLock,
        })) as unknown as RunnerDependencies['acquireProjectLock'],
        createRunId: vi.fn(() => 'run-unused'),
        now: vi.fn(() => NOW),
      };
      const signal = new AbortController().signal;

      const assetsResult = await runExecutionPlan({
        plan: plan({
          preset: 'assets',
          stageIds: STAGE_PRESETS.assets,
          actions: ['run', 'run'],
          runMode: 'new',
          targetRunId: 'run-assets',
        }),
        project,
        sourceCatalog: catalog,
        signal,
      }, dependencies);
      const assetsRun = await runStore.openExistingRun('demo', 'run-assets');
      const assetsIngest = await reportStore.readStage(assetsRun, 'ingest');

      const draftResult = await runExecutionPlan({
        plan: plan({
          preset: 'draft',
          stageIds: STAGE_PRESETS.draft,
          actions: ['run', 'cached', 'run', 'run', 'run'],
          runMode: 'new',
          sourceRunId: 'run-assets',
          targetRunId: 'run-draft',
        }),
        project,
        sourceCatalog: catalog,
        signal,
      }, dependencies);
      const draftRun = await runStore.openExistingRun('demo', 'run-draft');
      const cachedIngest = await reportStore.readStage(draftRun, 'ingest');
      const draftBeforeRelease = await reportStore.readStage(draftRun, 'draft');

      const releaseResult = await runExecutionPlan({
        plan: plan({
          preset: 'release',
          stageIds: STAGE_PRESETS.release,
          actions: ['run', 'cached', 'cached', 'cached', 'cached', 'resume', 'run'],
          runMode: 'resume',
          sourceRunId: 'run-draft',
          targetRunId: 'run-draft',
        }),
        project,
        sourceCatalog: catalog,
        signal,
      }, dependencies);

      expect(assetsResult).toMatchObject({runId: 'run-assets', state: 'passed'});
      expect(draftResult).toMatchObject({runId: 'run-draft', state: 'passed'});
      expect(releaseResult).toMatchObject({
        runId: 'run-draft',
        state: 'passed',
        completedStage: 'release',
      });
      expect(assetsIngest).not.toBeNull();
      expect(cachedIngest).toMatchObject({
        state: 'cached',
        fingerprint: assetsIngest!.fingerprint,
        artifacts: assetsIngest!.artifacts,
        provenance: {
          sourceRunId: 'run-assets',
          sourceStageId: 'ingest',
        },
      });
      expect(await verifyRunArtifact(draftRun, cachedIngest!.artifacts[0]!)).toBe(true);
      expect(await readArtifact(draftRun, 'assets/manifest.json')).toBe('ingest-bytes');
      expect(await reportStore.readStage(draftRun, 'draft')).toEqual(draftBeforeRelease);
      expect(await verifyRunArtifact(
        draftRun,
        draftBeforeRelease!.artifacts[0]!,
      )).toBe(true);
      expect(calls.filter((stageId) => stageId === 'preflight')).toHaveLength(3);
      expect(calls.filter((stageId) => stageId === 'ingest')).toHaveLength(1);
      expect(calls.filter((stageId) => stageId === 'narration')).toHaveLength(1);
      expect(calls.filter((stageId) => stageId === 'compile')).toHaveLength(1);
      expect(calls.filter((stageId) => stageId === 'draft')).toHaveLength(1);
      expect(calls.filter((stageId) => stageId === 'review')).toHaveLength(1);
      expect(calls.filter((stageId) => stageId === 'release')).toHaveLength(1);
      expect(await outputStore.readCurrentReadonly('demo')).toMatchObject({
        runId: 'run-draft',
        completedStage: 'release',
      });
      expect(await runStore.readCurrentReadonly('demo')).toMatchObject({
        runId: 'run-draft',
        completedStage: 'release',
      });
      expect(releaseLock).toHaveBeenCalledTimes(3);
    } finally {
      await tempProject.cleanup();
    }
  });
});
