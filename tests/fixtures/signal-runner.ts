import {writeFile} from 'node:fs/promises';
import {
  ensureRunDirectory,
  openNewRunFileForWrite,
  unlinkRunFile,
} from '../../src/fs/app-directory-scopes';
import {loadProject} from '../../src/domain/load-project';
import type {ExecutionPlan} from '../../src/pipeline/execution-plan';
import {acquireProjectLock} from '../../src/pipeline/project-lock';
import {
  createOutputStore,
  createRunStore,
  type StageId,
} from '../../src/pipeline/run-store';
import {
  runExecutionPlan,
  type FailedStageCleanupInput,
  type RunnerDependencies,
} from '../../src/pipeline/runner';
import {PipelineRuntimeError} from '../../src/pipeline/runtime-errors';
import {
  installPipelineSignalHandlers,
  signalExitCode,
} from '../../src/pipeline/signals';
import type {
  PipelineStage,
  StageExecutionContext,
  StageExecutionResult,
} from '../../src/pipeline/stage';
import {createStageRegistry} from '../../src/pipeline/stage-registry';
import {createStageReportStore} from '../../src/pipeline/stage-report';
import {runProcess} from '../../src/process/run-process';
import {fakePreflightResult} from '../helpers/pipeline-fixtures';

const [workspaceRoot, readyPath, cleanupPath] = process.argv.slice(2);
if (workspaceRoot === undefined || readyPath === undefined || cleanupPath === undefined) {
  throw new TypeError('signal-runner requires workspace, ready, and cleanup paths');
}

const successfulResult = (stageId: StageId): StageExecutionResult => ({
  state: 'passed',
  fingerprint: `${stageId}-fingerprint`,
  outputs: {stageId},
  artifacts: [],
  checks: [],
});

const passiveStage = (stageId: StageId): PipelineStage => ({
  id: stageId,
  displayName: stageId,
  prerequisites: [],
  fingerprint: async () => `${stageId}-fingerprint`,
  verify: async () => true,
  partialArtifacts: () => [],
  execute: async () => successfulResult(stageId),
});

const preflight = fakePreflightResult();
const preflightStage: PipelineStage = {
  id: 'preflight',
  displayName: 'preflight',
  prerequisites: [],
  fingerprint: async () => null,
  verify: async () => true,
  partialArtifacts: () => [],
  execute: async () => ({
    state: 'passed',
    fingerprint: 'preflight-fingerprint',
    outputs: preflight,
    artifacts: [],
    checks: preflight.checks,
  }),
};

const writePartial = async (context: StageExecutionContext): Promise<void> => {
  if (context.runDirectory === undefined) {
    throw new TypeError('signal fixture requires a Run directory');
  }
  await ensureRunDirectory(context.runDirectory, 'partials');
  const target = await openNewRunFileForWrite(
    context.runDirectory,
    'partials/ingest.tmp',
  );
  try {
    await target.handle.writeFile('partial');
    await target.syncAndSeal();
    await target.syncParent();
  } finally {
    await target.close();
  }
};

const ingestStage: PipelineStage = {
  id: 'ingest',
  displayName: 'ingest',
  prerequisites: ['preflight'],
  fingerprint: async () => 'ingest-fingerprint',
  verify: async () => true,
  partialArtifacts: () => [{scope: 'run', path: 'partials/ingest.tmp'}],
  execute: async (context, signal) => {
    await writePartial(context);
    const childScript = [
      "const {writeFileSync} = require('node:fs');",
      `writeFileSync(${JSON.stringify(readyPath)}, String(process.pid));`,
      'setInterval(() => undefined, 1000);',
    ].join('');
    await runProcess(process.execPath, ['-e', childScript], {signal});
    return successfulResult('ingest');
  },
};

const registry = createStageRegistry([
  preflightStage,
  ingestStage,
  passiveStage('narration'),
  passiveStage('compile'),
  passiveStage('draft'),
  passiveStage('review'),
  passiveStage('release'),
]);

const plan: ExecutionPlan = {
  version: 1,
  projectId: 'demo',
  preset: 'assets',
  stageIds: ['preflight', 'ingest'],
  runMode: 'new',
  requiresProgressReconciliation: false,
  requiresRuntimePreflight: false,
  targetRunId: 'run-signal',
  items: [
    {
      position: 1,
      total: 2,
      stageId: 'preflight',
      displayName: 'preflight',
      action: 'run',
      fingerprint: null,
      materialize: false,
    },
    {
      position: 2,
      total: 2,
      stageId: 'ingest',
      displayName: 'ingest',
      action: 'run',
      fingerprint: 'ingest-fingerprint',
      materialize: false,
    },
  ],
};

const cleanupFailedStage = async (
  input: FailedStageCleanupInput,
): Promise<void> => {
  await writeFile(cleanupPath, `${JSON.stringify({
    projectId: input.projectId,
    runId: input.runId,
    stageId: input.stageId,
    hasRunDirectory: input.runDirectory !== undefined,
    hasOutputDirectory: input.outputDirectory !== undefined,
    partialArtifacts: input.partialArtifacts,
  }, null, 2)}\n`);
  if (input.runDirectory === undefined) return;
  for (const artifact of input.partialArtifacts) {
    if (artifact.scope === 'run') {
      await unlinkRunFile(input.runDirectory, artifact.path);
    }
  }
};

const project = await loadProject(workspaceRoot, 'demo');
const runStore = createRunStore(workspaceRoot);
const dependencies: RunnerDependencies = {
  registry,
  runStore,
  outputStore: createOutputStore(workspaceRoot),
  reportStore: createStageReportStore(),
  acquireProjectLock,
  cleanupFailedStage,
  createRunId: () => 'run-signal',
  now: () => new Date().toISOString(),
};
const signalHandle = installPipelineSignalHandlers();

try {
  await runExecutionPlan({
    plan,
    project,
    sourceCatalog: {
      assets: [],
      totalBytes: 0,
      fingerprint: `sha256:${'a'.repeat(64)}`,
    },
    signal: signalHandle.signal,
  }, dependencies);
  process.exitCode = 1;
} catch (error) {
  if (
    error instanceof PipelineRuntimeError
    && error.code === 'PIPELINE_CANCELLED'
    && signalHandle.received !== undefined
  ) {
    process.exitCode = signalExitCode(signalHandle.received);
  } else {
    console.error(error);
    process.exitCode = 1;
  }
} finally {
  signalHandle.dispose();
}
