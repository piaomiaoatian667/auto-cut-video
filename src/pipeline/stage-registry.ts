import {STAGE_PRESETS} from './presets';
import {
  compileStage,
  createNarrationStage,
  createPreflightStage,
  draftStage,
  ingestStage,
  releaseStage,
  reviewStage,
  type NarrationStageAdapterDependencies,
  type PreflightStageAdapterDependencies,
} from './stage-adapters';
import type {PipelineStage} from './stage';

export class StageRegistryError extends Error {
  readonly code = 'STAGE_REGISTRY_INVALID';

  constructor(message: string) {
    super(`STAGE_REGISTRY_INVALID: ${message}`);
    this.name = 'StageRegistryError';
  }
}

const invalidRegistry = (message: string): never => {
  throw new StageRegistryError(message);
};

export function createStageRegistry(
  stages: readonly PipelineStage[],
): readonly PipelineStage[] {
  const registry = [...stages];
  const registeredIds = registry.map((stage) => stage.id);
  const seen = new Set<string>();
  for (const stageId of registeredIds) {
    if (seen.has(stageId)) {
      invalidRegistry(`duplicate Stage registration: ${stageId}`);
    }
    seen.add(stageId);
  }

  const expectedOrder = STAGE_PRESETS.release;
  if (
    registeredIds.length !== expectedOrder.length
    || registeredIds.some((stageId, index) => stageId !== expectedOrder[index])
  ) {
    invalidRegistry('Stage registrations must use the exact stable order');
  }

  const stagePositions = new Map(registeredIds.map((stageId, index) => [
    stageId,
    index,
  ]));
  for (const [stageIndex, stage] of registry.entries()) {
    const prerequisites = new Set<string>();
    for (const prerequisite of stage.prerequisites) {
      if (prerequisites.has(prerequisite)) {
        invalidRegistry(`duplicate prerequisite for ${stage.id}: ${prerequisite}`);
      }
      prerequisites.add(prerequisite);
      const prerequisiteIndex = stagePositions.get(prerequisite);
      if (prerequisiteIndex === undefined) {
        invalidRegistry(`unregistered prerequisite for ${stage.id}: ${prerequisite}`);
      } else if (prerequisiteIndex >= stageIndex) {
        invalidRegistry(`prerequisite must precede ${stage.id}: ${prerequisite}`);
      }
    }
  }

  for (const [preset, stageIds] of Object.entries(STAGE_PRESETS)) {
    if (
      stageIds.length > registeredIds.length
      || stageIds.some((stageId, index) => registeredIds[index] !== stageId)
    ) {
      invalidRegistry(`${preset} must be a contiguous registry prefix`);
    }
  }

  return Object.freeze(registry);
}

export interface MvpStageRegistryDependencies extends PreflightStageAdapterDependencies {
  narration?: NarrationStageAdapterDependencies;
}

export const createMvpStageRegistry = (
  dependencies: MvpStageRegistryDependencies = {},
): readonly PipelineStage[] => {
  const {narration, ...preflightDependencies} = dependencies;
  return createStageRegistry([
    createPreflightStage(preflightDependencies),
    ingestStage,
    createNarrationStage(narration),
    compileStage,
    draftStage,
    reviewStage,
    releaseStage,
  ]);
};

export const MVP_STAGES = createMvpStageRegistry();
