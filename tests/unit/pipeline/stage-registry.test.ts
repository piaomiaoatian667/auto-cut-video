import {describe, expect, it} from 'vitest';
import type {StageExecutionContext} from '../../../src/pipeline/stage';
import {
  requirePreflight,
  requireRunContext,
} from '../../../src/pipeline/stage';
import {createStageRegistry} from '../../../src/pipeline/stage-registry';
import {STAGE_PRESETS} from '../../../src/pipeline/presets';
import type {StageId} from '../../../src/pipeline/run-store';
import {
  createPipelineRunFixture,
  fakePreflightResult,
  fakeStage,
} from '../../helpers/pipeline-fixtures';

const orderedStages = () => [
  fakeStage('preflight'),
  fakeStage('ingest'),
  fakeStage('narration'),
  fakeStage('compile'),
  fakeStage('draft'),
  fakeStage('review'),
  fakeStage('release'),
];

const withPrerequisites = (
  stageId: StageId,
  prerequisites: readonly StageId[],
) => orderedStages().map((stage) => stage.id === stageId
  ? fakeStage(stageId, {prerequisites})
  : stage);

describe('STAGE_PRESETS', () => {
  it('keeps all Presets contiguous in registry order', () => {
    expect(STAGE_PRESETS).toEqual({
      assets: ['preflight', 'ingest'],
      draft: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
      release: [
        'preflight',
        'ingest',
        'narration',
        'compile',
        'draft',
        'review',
        'release',
      ],
    });
  });
});

describe('createStageRegistry', () => {
  it('freezes a copied registry in exact stable order', () => {
    const stages = orderedStages();

    const registry = createStageRegistry(stages);

    expect(registry).not.toBe(stages);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(registry.map((stage) => stage.id)).toEqual(STAGE_PRESETS.release);
  });

  it('rejects duplicate Stage registrations', () => {
    expect(() => createStageRegistry([
      fakeStage('preflight'),
      fakeStage('preflight'),
    ])).toThrow(/STAGE_REGISTRY_INVALID/u);
  });

  it('rejects reordered Stage registrations', () => {
    const stages = orderedStages();
    [stages[1], stages[2]] = [stages[2]!, stages[1]!];

    expect(() => createStageRegistry(stages))
      .toThrow(/STAGE_REGISTRY_INVALID/u);
  });

  it('rejects incomplete Stage registrations', () => {
    expect(() => createStageRegistry(orderedStages().slice(0, -1)))
      .toThrow(/STAGE_REGISTRY_INVALID/u);
  });

  it.each([
    ['duplicate prerequisites', withPrerequisites('ingest', [
      'preflight',
      'preflight',
    ])],
    ['unregistered prerequisites', withPrerequisites('ingest', [
      'missing' as StageId,
    ])],
    ['self prerequisites', withPrerequisites('ingest', ['ingest'])],
    ['forward prerequisites', withPrerequisites('ingest', ['narration'])],
  ])('rejects %s', (_label, stages) => {
    expect(() => createStageRegistry(stages))
      .toThrow(/STAGE_REGISTRY_INVALID/u);
  });

  it('accepts unique earlier prerequisites', () => {
    const stages = orderedStages().map((stage, index, allStages) => fakeStage(
      stage.id,
      {prerequisites: allStages.slice(0, index).map((earlier) => earlier.id)},
    ));

    expect(createStageRegistry(stages)).toHaveLength(STAGE_PRESETS.release.length);
  });
});

describe('Stage context requirements', () => {
  it('requires both Run identifiers together', async () => {
    const fixture = await createPipelineRunFixture();
    try {
      const complete = {
        runId: 'run-one',
        runDirectory: fixture.runDirectory,
      } as StageExecutionContext;

      expect(requireRunContext(complete)).toEqual({
        runId: 'run-one',
        runDirectory: fixture.runDirectory,
      });
      expect(() => requireRunContext({} as StageExecutionContext))
        .toThrow(/PIPELINE_CONTEXT_INVALID/u);
      expect(() => requireRunContext({runId: 'run-one'} as StageExecutionContext))
        .toThrow(/PIPELINE_CONTEXT_INVALID/u);
      for (const context of [
        {runId: null, runDirectory: fixture.runDirectory},
        {runId: 'run-one', runDirectory: null},
      ]) {
        let caughtError: unknown;
        try {
          requireRunContext(context as unknown as StageExecutionContext);
        } catch (error) {
          caughtError = error;
        }
        expect(caughtError).toMatchObject({code: 'PIPELINE_CONTEXT_INVALID'});
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('requires a completed Preflight result', () => {
    const preflight = fakePreflightResult();

    expect(requirePreflight({preflight} as StageExecutionContext))
      .toBe(preflight);
    expect(() => requirePreflight({} as StageExecutionContext))
      .toThrow(/PIPELINE_CONTEXT_INVALID/u);
    let caughtError: unknown;
    try {
      requirePreflight({preflight: null} as unknown as StageExecutionContext);
    } catch (error) {
      caughtError = error;
    }
    expect(caughtError).toMatchObject({code: 'PIPELINE_CONTEXT_INVALID'});
  });
});
