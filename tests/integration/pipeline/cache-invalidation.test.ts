import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {loadProject, type ProjectInputs} from '../../../src/domain/load-project';
import {NarrationManifestSchema} from '../../../src/domain/manifest-schema';
import type {Script} from '../../../src/domain/script-schema';
import {
  ensureRunDirectory,
  openExistingRunFileForRead,
  openNewRunFile,
  openNewRunFileForWrite,
  type RunDirectoryScope,
} from '../../../src/fs/app-directory-scopes';
import {buildNarration} from '../../../src/narration/build-narration';
import type {TtsProvider} from '../../../src/providers/tts';
import {
  hashRunArtifact,
  verifyRunArtifact,
  type PipelineArtifact,
} from '../../../src/pipeline/artifacts';
import {
  buildExecutionPlan,
  type ExecutionPlanContext,
} from '../../../src/pipeline/execution-plan';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {STAGE_PRESETS} from '../../../src/pipeline/presets';
import {
  createOutputStore,
  createRunStore,
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
} from '../../../src/pipeline/stage';
import {
  createNarrationStage,
  type NarrationStageAdapterDependencies,
} from '../../../src/pipeline/stage-adapters/narration';
import {createStageReportStore} from '../../../src/pipeline/stage-report';
import {runNarration} from '../../../src/pipeline/stages/narration';
import {fakePreflightResult} from '../../helpers/pipeline-fixtures';
import {createTempProject} from '../../helpers/temp-project';

const NOW = '2026-08-11T16:00:00.000Z';
const PROVIDER_FINGERPRINT = fingerprintValue({
  provider: 'mock',
  algorithm: 'mock-tts-v2',
});
const SOURCE_HASH = fingerprintValue({source: 'cache-invalidation'});

const oldScript: Script = {
  version: 1,
  language: 'zh-CN',
  segments: [{
    id: 'first',
    text: '第一句',
    normalizedText: '第一句',
    pauseAfterMs: 300,
    requiredTerms: [],
  }, {
    id: 'second',
    text: '第二句',
    normalizedText: '第二句',
    pauseAfterMs: 300,
    requiredTerms: [],
  }],
};

const changedScript: Script = {
  ...oldScript,
  segments: oldScript.segments.map((segment) => (
    segment.id === 'second'
      ? {...segment, text: '改过的第二句', normalizedText: '改过的第二句'}
      : {...segment}
  )),
};

const sourceCatalog: ProjectSourceCatalog = {
  assets: [],
  totalBytes: 0,
  fingerprint: SOURCE_HASH,
};

const preflight = {
  ...fakePreflightResult(),
  toolIdentities: {
    ffmpeg: {realPath: '/tools/ffmpeg', sha256: fingerprintValue({tool: 'ffmpeg'})},
    ffprobe: {realPath: '/tools/ffprobe', sha256: fingerprintValue({tool: 'ffprobe'})},
    qtFaststart: null,
  },
};

const writeRunBytes = async (
  runDirectory: RunDirectoryScope,
  relativePath: string,
  bytes: Buffer | string,
): Promise<PipelineArtifact> => {
  const parent = path.posix.dirname(relativePath);
  if (parent !== '.') await ensureRunDirectory(runDirectory, parent);
  const target = await openNewRunFileForWrite(runDirectory, relativePath);
  try {
    await target.handle.writeFile(bytes);
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
  return await hashRunArtifact(runDirectory, relativePath);
};

const readManifest = async (
  runDirectory: RunDirectoryScope,
) => {
  const authority = await openExistingRunFileForRead(
    runDirectory,
    'narration-manifest.json',
  );
  try {
    const manifest = NarrationManifestSchema.parse(JSON.parse(
      await authority.handle.readFile('utf8'),
    ));
    await authority.revalidate();
    return manifest;
  } finally {
    await authority.close();
  }
};

describe('Pipeline cache invalidation', () => {
  it('reuses only unchanged Narration segments and invalidates downstream fingerprints', async () => {
    const tempProject = await createTempProject({
      tempPrefix: 'cache-invalidation-',
      script: oldScript,
    });
    try {
      const initialProject = await loadProject(tempProject.workspaceRoot, 'demo');
      const runStore = createRunStore(tempProject.workspaceRoot);
      const outputStore = createOutputStore(tempProject.workspaceRoot);
      const reportStore = createStageReportStore();
      const stageExecutions: StageId[] = [];
      const ttsCalls: string[] = [];
      const createProvider: NonNullable<
        NarrationStageAdapterDependencies['createTtsProvider']
      > = ({runDirectory}): TtsProvider => ({
        id: 'mock',
        capabilities: async () => ({languages: ['zh-CN'], voices: ['fixture']}),
        fingerprint: async () => PROVIDER_FINGERPRINT,
        synthesize: async (input) => {
          ttsCalls.push(input.segmentId);
          await writeRunBytes(
            runDirectory,
            input.outputPath,
            `tts:${input.segmentId}:${input.text}`,
          );
          return {
            outputPath: input.outputPath,
            providerFingerprint: PROVIDER_FINGERPRINT,
          };
        },
      });
      const narration = createNarrationStage({
        fingerprintTtsProvider: async () => PROVIDER_FINGERPRINT,
        createTtsProvider: createProvider,
        runNarration: async (input) => await runNarration(input, {
          fileSystem: {openNewRunFile},
          buildNarration: async (buildInput) => await buildNarration({
            ...buildInput,
            probeDurationMs: async () => 1_000,
            runProcess: async (_command, args, options) => {
              const outputFd = options?.extraStdioFds?.at(-1);
              if (outputFd === undefined) throw new Error('missing synthetic audio output fd');
              writeFileSync(outputFd, Buffer.from(`audio:${args.join('|')}`));
              return {stdout: ''};
            },
          }),
        }),
      });
      const narrationStage: PipelineStage = {
        ...narration,
        execute: async (...args) => {
          stageExecutions.push('narration');
          return await narration.execute(...args);
        },
      };
      const preflightStage: PipelineStage = {
        id: 'preflight',
        displayName: 'preflight',
        prerequisites: [],
        fingerprint: async () => fingerprintValue({stage: 'preflight'}),
        verify: async (_context, report) => (
          report.fingerprint === fingerprintValue({stage: 'preflight'})
        ),
        partialArtifacts: () => [],
        execute: async () => {
          stageExecutions.push('preflight');
          return {
            state: 'passed',
            fingerprint: fingerprintValue({stage: 'preflight'}),
            outputs: preflight,
            artifacts: [],
            checks: preflight.checks,
          };
        },
      };
      const ingestFingerprint = fingerprintValue({stage: 'ingest'});
      const ingestStage: PipelineStage = {
        id: 'ingest',
        displayName: 'ingest',
        prerequisites: ['preflight'],
        fingerprint: async () => ingestFingerprint,
        verify: async (context, report) => {
          if (
            context.sourceRun === undefined
            || report.fingerprint !== ingestFingerprint
          ) return false;
          return await Promise.all(report.artifacts.map(async (artifact) => (
            artifact.scope === 'run'
            && await verifyRunArtifact(context.sourceRun!.runDirectory, artifact)
          ))).then((results) => results.every(Boolean));
        },
        partialArtifacts: () => [],
        execute: async (context) => {
          stageExecutions.push('ingest');
          const {runDirectory} = requireRunContext(context);
          const artifact = await writeRunBytes(
            runDirectory,
            'assets/manifest.json',
            'ingest-manifest',
          );
          return {
            state: 'passed',
            fingerprint: ingestFingerprint,
            outputs: {path: artifact.path},
            artifacts: [artifact],
            checks: [],
          };
        },
      };
      const dependentStage = (
        stageId: 'compile' | 'draft',
        upstreamStageId: 'narration' | 'compile',
      ): PipelineStage => {
        const calculateFingerprint = async (
          context: Parameters<PipelineStage['fingerprint']>[0],
        ): Promise<string | null> => {
          const upstream = context.sourceRun?.reports.get(upstreamStageId);
          return upstream?.fingerprint === null || upstream?.fingerprint === undefined
            ? null
            : fingerprintValue({stageId, upstream: upstream.fingerprint});
        };
        return {
          id: stageId,
          displayName: stageId,
          prerequisites: [upstreamStageId],
          fingerprint: calculateFingerprint,
          verify: async (context, report) => (
            report.fingerprint === await calculateFingerprint(context)
          ),
          partialArtifacts: () => [],
          execute: async (context) => {
            stageExecutions.push(stageId);
            const {runDirectory} = requireRunContext(context);
            const upstream = await reportStore.readStage(runDirectory, upstreamStageId);
            if (upstream?.fingerprint === null || upstream?.fingerprint === undefined) {
              throw new Error(`missing ${upstreamStageId} fingerprint`);
            }
            return {
              state: 'passed',
              fingerprint: fingerprintValue({
                stageId,
                upstream: upstream.fingerprint,
              }),
              outputs: {upstreamFingerprint: upstream.fingerprint},
              artifacts: [],
              checks: [],
            };
          },
        };
      };
      const registry: readonly PipelineStage[] = [
        preflightStage,
        ingestStage,
        narrationStage,
        dependentStage('compile', 'narration'),
        dependentStage('draft', 'compile'),
      ];
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
          release: vi.fn(async () => undefined),
        })) as unknown as RunnerDependencies['acquireProjectLock'],
        createRunId: vi.fn(() => 'run-unused'),
        now: vi.fn(() => NOW),
      };
      const planningContext = (
        project: ProjectInputs,
        runId: string,
      ): ExecutionPlanContext => ({
        project,
        sourceCatalog,
        registry,
        runStore,
        outputStore,
        reportStore,
        createRunId: () => runId,
      });
      const signal = new AbortController().signal;
      const oldPlan = await buildExecutionPlan(
        planningContext(initialProject, 'run-old'),
        {preset: 'draft'},
      );
      await runExecutionPlan({
        plan: oldPlan,
        project: initialProject,
        sourceCatalog,
        signal,
      }, dependencies);
      const oldRun = await runStore.openExistingRun('demo', 'run-old');
      const oldManifest = await readManifest(oldRun);
      const oldReports = new Map(await Promise.all(
        STAGE_PRESETS.draft.map(async (stageId) => [
          stageId,
          await reportStore.readStage(oldRun, stageId),
        ] as const),
      ));
      expect(ttsCalls).toEqual(['first', 'second']);

      const currentProject: ProjectInputs = {
        ...initialProject,
        script: changedScript,
      };
      ttsCalls.length = 0;
      stageExecutions.length = 0;
      const changedPlan = await buildExecutionPlan(
        planningContext(currentProject, 'run-new'),
        {preset: 'draft'},
      );
      expect(changedPlan).toMatchObject({
        runMode: 'new',
        sourceRunId: 'run-old',
        targetRunId: 'run-new',
      });
      expect(changedPlan.items.map((item) => [
        item.stageId,
        item.action,
        item.materialize,
      ])).toEqual([
        ['preflight', 'run', false],
        ['ingest', 'cached', true],
        ['narration', 'run', false],
        ['compile', 'run', false],
        ['draft', 'run', false],
      ]);

      await runExecutionPlan({
        plan: changedPlan,
        project: currentProject,
        sourceCatalog,
        signal,
      }, dependencies);

      const newRun = await runStore.openExistingRun('demo', 'run-new');
      const newManifest = await readManifest(newRun);
      const newReports = new Map(await Promise.all(
        STAGE_PRESETS.draft.map(async (stageId) => [
          stageId,
          await reportStore.readStage(newRun, stageId),
        ] as const),
      ));
      expect(newManifest.segments[0]?.inputHash)
        .toBe(oldManifest.segments[0]?.inputHash);
      expect(newManifest.segments[1]?.inputHash)
        .not.toBe(oldManifest.segments[1]?.inputHash);
      expect(ttsCalls).toEqual(['second']);
      expect(stageExecutions).toEqual(['preflight', 'narration', 'compile', 'draft']);
      expect(newReports.get('ingest')?.state).toBe('cached');
      expect(newReports.get('narration')?.fingerprint)
        .not.toBe(oldReports.get('narration')?.fingerprint);
      expect(newReports.get('compile')?.fingerprint)
        .not.toBe(oldReports.get('compile')?.fingerprint);
      expect(newReports.get('draft')?.fingerprint)
        .not.toBe(oldReports.get('draft')?.fingerprint);

      ttsCalls.length = 0;
      stageExecutions.length = 0;
      const unchangedPlan = await buildExecutionPlan(
        planningContext(currentProject, 'run-unchanged'),
        {preset: 'draft'},
      );
      expect(unchangedPlan.items.find((item) => item.stageId === 'narration'))
        .toMatchObject({action: 'cached', materialize: true});

      await runExecutionPlan({
        plan: unchangedPlan,
        project: currentProject,
        sourceCatalog,
        signal,
      }, dependencies);

      const unchangedRun = await runStore.openExistingRun('demo', 'run-unchanged');
      expect(await reportStore.readStage(unchangedRun, 'narration'))
        .toMatchObject({state: 'cached'});
      expect(ttsCalls).toEqual([]);
      expect(stageExecutions).toEqual(['preflight']);
    } finally {
      await tempProject.cleanup();
    }
  });
});
