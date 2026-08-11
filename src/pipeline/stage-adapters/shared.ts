import {z} from 'zod';
import {
  AppDirectoryScopeError,
  openExistingRunFileForRead,
  type OutputDirectoryScope,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {
  PipelineArtifactError,
  verifyOutputArtifact,
  verifyRunArtifact,
  type PipelineArtifact,
} from '../artifacts';
import type {StagePlanningContext} from '../stage';
import {
  StageReportSchema,
  StageReportValidationError,
  type StageReport,
} from '../stage-report';
import type {StageId} from '../run-store';

export const STAGE_ALGORITHM_VERSIONS = {
  preflight: 'preflight-stage-v1',
  ingest: 'ingest-stage-v1',
  narration: 'narration-stage-v1',
  compile: 'compile-stage-v1',
  draft: 'draft-stage-v1',
  review: 'review-stage-v1',
  release: 'release-stage-v1',
} as const;

export interface ExpectedArtifact {
  scope: PipelineArtifact['scope'];
  path: string;
  sha256?: string;
}

const artifactKey = (
  artifact: Pick<PipelineArtifact, 'scope' | 'path'>,
): string => `${artifact.scope}:${artifact.path}`;

const sortedArtifacts = <Artifact extends Pick<PipelineArtifact, 'scope' | 'path'>>(
  artifacts: readonly Artifact[],
): Artifact[] => [...artifacts].sort((left, right) => (
  artifactKey(left).localeCompare(artifactKey(right))
));

const inventoryMatches = (
  actual: readonly PipelineArtifact[],
  expected: readonly ExpectedArtifact[],
): boolean => {
  if (actual.length !== expected.length) return false;
  const actualSorted = sortedArtifacts(actual);
  const expectedSorted = sortedArtifacts(expected);
  return expectedSorted.every((expectedArtifact, index) => {
    const actualArtifact = actualSorted[index];
    return actualArtifact !== undefined
      && actualArtifact.scope === expectedArtifact.scope
      && actualArtifact.path === expectedArtifact.path
      && (
        expectedArtifact.sha256 === undefined
        || actualArtifact.sha256 === expectedArtifact.sha256
      );
  });
};

export const isOrdinaryVerificationMiss = (error: unknown): boolean => (
  error instanceof z.ZodError
  || error instanceof PipelineArtifactError
  || error instanceof AppDirectoryScopeError
  || (
    error instanceof Error
    && 'code' in error
    && error.code === 'ENOENT'
  )
);

export const isOrdinaryPersistedInputMiss = (error: unknown): boolean => (
  isOrdinaryVerificationMiss(error)
  || error instanceof SyntaxError
  || error instanceof StageReportValidationError
);

export const readPlanningInput = async <Value>(
  operation: () => Promise<Value>,
): Promise<Value | null> => {
  try {
    return await operation();
  } catch (error) {
    if (isOrdinaryPersistedInputMiss(error)) return null;
    throw error;
  }
};

export const verifyReportedArtifacts = async ({
  context,
  report,
  expected,
  outputDirectory,
}: {
  context: StagePlanningContext;
  report: StageReport;
  expected: readonly ExpectedArtifact[];
  outputDirectory?: OutputDirectoryScope;
}): Promise<boolean> => {
  if (!inventoryMatches(report.artifacts, expected)) return false;
  const runDirectory = context.sourceRun?.runDirectory;
  try {
    for (const artifact of report.artifacts) {
      if (artifact.scope === 'run') {
        if (runDirectory === undefined) return false;
        if (!await verifyRunArtifact(runDirectory, artifact)) return false;
      } else {
        if (outputDirectory === undefined) return false;
        if (!await verifyOutputArtifact(outputDirectory, artifact)) return false;
      }
    }
    return true;
  } catch (error) {
    if (isOrdinaryVerificationMiss(error)) return false;
    throw error;
  }
};

export const readRunJson = async <Output>(
  runDirectory: RunDirectoryScope,
  relativePath: string,
  parse: (value: unknown) => Output,
): Promise<Output> => {
  const authority = await openExistingRunFileForRead(runDirectory, relativePath);
  try {
    const result = parse(JSON.parse(await authority.handle.readFile('utf8')));
    await authority.revalidate();
    return result;
  } finally {
    await authority.close();
  }
};

export const readOptionalRunJson = async <Output>(
  runDirectory: RunDirectoryScope,
  relativePath: string,
  parse: (value: unknown) => Output,
): Promise<Output | undefined> => {
  try {
    return await readRunJson(runDirectory, relativePath, parse);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
};

export const readRunStageReport = async (
  runDirectory: RunDirectoryScope,
  stageId: StageId,
): Promise<StageReport> => await readRunJson(
  runDirectory,
  `reports/${stageId}.json`,
  (value) => StageReportSchema.parse(value),
);

export const planningReportFingerprint = (
  context: StagePlanningContext,
  stageId: StageId,
): string | null => context.sourceRun?.reports.get(stageId)?.fingerprint ?? null;

export const runArtifact = (
  reference: {path: string; sha256: string},
): PipelineArtifact => ({scope: 'run', ...reference});

export const outputArtifact = (
  reference: {path: string; sha256: string},
): PipelineArtifact => ({scope: 'output', ...reference});

export const uniqueArtifacts = (
  artifacts: readonly PipelineArtifact[],
): PipelineArtifact[] => {
  const byPath = new Map<string, PipelineArtifact>();
  for (const artifact of artifacts) {
    byPath.set(artifactKey(artifact), artifact);
  }
  return [...byPath.values()];
};
