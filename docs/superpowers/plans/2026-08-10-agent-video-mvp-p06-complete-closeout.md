# Agent Video MVP P06 Complete Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the Agent Video MVP with one typed orchestration path, safe source discovery, bounded cross-Run reuse, resumable execution, signal and disk-failure recovery, safe cleanup, the complete CLI, and all end-to-end acceptance evidence.

**Architecture:** The seven existing concrete Stages remain the only owners of media behavior. Thin Stage adapters expose fingerprints, artifact inventories, execution, and verification to one registry, one read-only Execution Plan builder, and one Runner. Reuse is limited to verified scoped copies from the current Run plus segment-level Narration cache seeding; no general workflow engine or artifact store is introduced.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript, Zod, Commander, Vitest, Remotion, FFmpeg/ffprobe, `qt-faststart`, Darwin scoped file descriptors.

---

## Authoritative Inputs

- Product specification: `docs/superpowers/specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- Approved P06 closeout design: `docs/superpowers/specs/2026-08-10-agent-video-mvp-p06-closeout-design.md`
- Project execution index: `docs/superpowers/plans/2026-08-09-agent-video-mvp-project-index.md`
- Existing P06 plan being superseded: `docs/superpowers/plans/2026-08-09-agent-video-mvp-06-workflow-productization.md`

If these documents conflict, preserve the product behavior in the specification, then apply the approved closeout design and this plan's narrower implementation details.

## Baseline

Before Task 1, verify:

```bash
git status --short
pnpm test
pnpm typecheck
git diff --check
```

Expected before P06 implementation: 38 test files pass, 1 test file is skipped, 451 tests pass, 1 test is skipped, TypeScript exits 0, and only approved planning documents are untracked or modified.

## Locked File Structure

### Source and Artifact Inputs

- `src/pipeline/source-assets.ts`: secure recursive inventory of `assets/source`, EDL asset resolution, byte totals, and source hashes.
- `src/pipeline/artifacts.ts`: hash, verify, and copy Run artifacts; verify Output artifacts.
- `src/pipeline/narration-cache.ts`: copy only matching segment cache WAVs into a new Run.
- `src/providers/tts.ts`: exported provider ID, side-effect-free provider fingerprint helper, and provider factory.

### Orchestration Contracts

- `src/pipeline/stage.ts`: Stage contexts, actions, artifacts, normalized results, and Stage interface.
- `src/pipeline/stage-report.ts`: strict persisted report schemas and Run-local report store.
- `src/pipeline/presets.ts`: built-in Presets only.
- `src/pipeline/stage-registry.ts`: ordered registry validation and `MVP_STAGES`.
- `src/pipeline/stage-adapters/`: one thin adapter per concrete Stage.
- `src/pipeline/execution-plan.ts`: side-effect-free plan request validation and action selection.

### Execution and Reliability

- `src/pipeline/runner.ts`: lock, Run selection, materialization, execution, reports, work pointer, and review stop/resume.
- `src/pipeline/runtime-errors.ts`: stable failure normalization and exit categories.
- `src/pipeline/signals.ts`: process signal registration and disposal.
- `src/pipeline/cleanup.ts`: protected references, cleanup inventory, and scoped deletion.
- `src/fs/app-directory-scopes.ts`: add narrowly scoped list/remove APIs; retain authority enforcement.

### CLI and Product Evidence

- `src/cli/commands/pipeline.ts`, `report.ts`, `clean.ts`: command handlers.
- `src/cli/videoctl.ts`: Commander registration only plus dependency assembly.
- `src/cli/output.ts`: shared JSON/text formatting.
- `projects/demo/`, `AGENTS.md`, `README.md`: runnable product fixture and operator guidance.
- `tests/helpers/pipeline-fixtures.ts`: fake Stages, deterministic reports, and pipeline test setup.

## Milestone Mapping

| Design Milestone | Plan Tasks |
| --- | --- |
| M1 Stage contracts and registry | Tasks 1–4 |
| M2 Read-only Execution Plan | Task 5 |
| M3 Runner and resume state machine | Tasks 6–7 |
| M4 Signals, disk failure, cleanup | Tasks 8–9 |
| M5 Complete CLI and reporting | Task 10 |
| M6 Demo, E2E, final acceptance | Tasks 11–12 |

---

### Task 1: Extract Secure Source Discovery and Artifact Primitives

**Files:**
- Create: `src/pipeline/source-assets.ts`
- Create: `src/pipeline/artifacts.ts`
- Modify: `src/fs/app-directory-scopes.ts`
- Modify: `src/cli/videoctl.ts:1-420`
- Test: `tests/unit/pipeline/source-assets.test.ts`
- Test: `tests/unit/pipeline/artifacts.test.ts`
- Modify: `tests/unit/fs/app-directory-scopes.test.ts`
- Modify: `tests/unit/cli/doctor.test.ts`

- [ ] **Step 1: Write failing source discovery tests**

Create fixtures that expose the existing source-meter dependency boundary without invoking FFmpeg. Cover recursive directories, unrelated voice WAVs, duplicate filename stems, missing EDL assets, symlinks, and stable ordering.

```ts
describe('discoverProjectSourceCatalog', () => {
  it('resolves referenced EDL assets by unique filename stem', async () => {
    const catalog = await discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/camera-a.mp4': file(10, 'sha256:camera-a'),
      'assets/source/nested/cover.png': file(20, 'sha256:cover'),
      'assets/source/music-main.wav': file(30, 'sha256:music'),
      'assets/source/voice/intro.wav': file(40, 'sha256:voice'),
    }));

    expect(catalog.assets).toEqual([
      {assetId: 'camera-a', kind: 'video', sourcePath: 'assets/source/camera-a.mp4', sizeBytes: 10, sha256: 'sha256:camera-a'},
      {assetId: 'cover', kind: 'image', sourcePath: 'assets/source/nested/cover.png', sizeBytes: 20, sha256: 'sha256:cover'},
      {assetId: 'music-main', kind: 'audio', sourcePath: 'assets/source/music-main.wav', sizeBytes: 30, sha256: 'sha256:music'},
    ]);
    expect(catalog.totalBytes).toBe(100);
  });

  it('rejects two files with the same referenced stem', async () => {
    await expect(discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/camera-a.mp4': file(10, 'sha256:a'),
      'assets/source/archive/camera-a.mov': file(10, 'sha256:b'),
    }))).rejects.toMatchObject({code: 'PROJECT_SOURCE_AMBIGUOUS'});
  });

  it('fails closed on symlinks and missing referenced assets', async () => {
    await expect(discoverProjectSourceCatalog(projectInputs, fakeSourceTree({
      'assets/source/camera-a.mp4': symlink(),
    }))).rejects.toMatchObject({code: 'PROJECT_SOURCE_INVALID'});
  });
});
```

- [ ] **Step 2: Run the new tests and verify failure**

Run:

```bash
pnpm test tests/unit/pipeline/source-assets.test.ts
```

Expected: FAIL because `src/pipeline/source-assets.ts` does not exist.

- [ ] **Step 3: Move source traversal out of the CLI and implement the catalog**

Export the shared API below. Move the existing scoped-handle traversal from `src/cli/videoctl.ts` instead of creating a lexical-path scanner.

```ts
export type SourceAssetKind = 'video' | 'audio' | 'image';

export interface ProjectSourceAsset {
  assetId: string;
  kind: SourceAssetKind;
  sourcePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface ProjectSourceCatalog {
  assets: readonly ProjectSourceAsset[];
  totalBytes: number;
  fingerprint: string;
}

export type ProjectSourceErrorCode =
  | 'PROJECT_SOURCE_INVALID'
  | 'PROJECT_SOURCE_MISSING'
  | 'PROJECT_SOURCE_AMBIGUOUS'
  | 'PROJECT_SOURCE_KIND_CONFLICT';

export class ProjectSourceError extends Error {
  constructor(readonly code: ProjectSourceErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = 'ProjectSourceError';
  }
}

export interface SourceCatalogDependencies {
  listSourceFiles(
    projectDirectory: ProjectDirectoryScope,
  ): Promise<readonly {sourcePath: string; sizeBytes: number}[]>;
  hashProjectFile(
    projectDirectory: ProjectDirectoryScope,
    sourcePath: string,
  ): Promise<string>;
}

export async function discoverProjectSourceCatalog(
  project: ProjectInputs,
  dependencies: SourceCatalogDependencies = createSystemSourceCatalogDependencies(),
): Promise<ProjectSourceCatalog>;
```

Implementation rules:

1. Build the expected kind map from unique `edit.visualClips[].assetId` values plus `edit.backgroundMusic.assetId`.
2. Reject one asset ID used as two different kinds.
3. Recursively inspect `assets/source` through held directory identities and fresh read handles.
4. Count every regular source file in `totalBytes`, including unrelated File-TTS WAVs.
5. Match referenced assets by basename without its final extension; reject zero or multiple matches.
6. Hash each matched file through a fresh project-scoped handle.
7. Sort by `assetId` and calculate `fingerprintValue({assets})`.
8. Reject symlink, socket, device, or changed-identity entries anywhere below `assets/source`.
9. Reject a total byte count that exceeds `Number.MAX_SAFE_INTEGER`.

Replace the CLI's private `measureProjectSourceBytes()` path with `discoverProjectSourceCatalog(project).totalBytes`. Preserve the current doctor failure code and sanitized output.

- [ ] **Step 4: Write failing artifact primitive tests**

```ts
describe('pipeline artifacts', () => {
  it('copies a Run artifact with fresh handles and verifies the hash', async () => {
    const artifact = await copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: {scope: 'run', path: 'audio/cache/key.wav', sha256: sourceHash},
    });
    expect(artifact).toEqual({scope: 'run', path: 'audio/cache/key.wav', sha256: sourceHash});
    await expect(verifyRunArtifact(targetRun, artifact)).resolves.toBe(true);
  });

  it('refuses an output artifact in the Run copy API', async () => {
    await expect(copyRunArtifact({
      sourceRun,
      targetRun,
      artifact: {scope: 'output', path: 'releases/run/final.mp4', sha256: sourceHash},
    })).rejects.toMatchObject({code: 'ARTIFACT_SCOPE_INVALID'});
  });
});
```

- [ ] **Step 5: Implement artifact hashing, verification, and bounded copy**

```ts
export interface PipelineArtifact {
  scope: 'run' | 'output';
  path: string;
  sha256: string;
}

export async function hashRunArtifact(
  runDirectory: RunDirectoryScope,
  relativePath: string,
): Promise<PipelineArtifact>;

export async function verifyRunArtifact(
  runDirectory: RunDirectoryScope,
  artifact: PipelineArtifact,
): Promise<boolean>;

export async function verifyOutputArtifact(
  outputDirectory: OutputDirectoryScope,
  artifact: PipelineArtifact,
): Promise<boolean>;

export async function copyRunArtifact(input: {
  sourceRun: RunDirectoryScope;
  targetRun: RunDirectoryScope;
  artifact: PipelineArtifact;
}): Promise<PipelineArtifact>;
```

`copyRunArtifact()` must ensure the target parent directory, open a fresh source handle and an exclusive target handle, copy bytes without resolving a user path, sync the target, close both handles, and compare the resulting SHA-256 with the source report. On mismatch, remove the target file through a Run-scoped unlink helper added in Task 9 and throw `ARTIFACT_HASH_MISMATCH`.

Add the narrow helper in this Task so artifact rollback compiles independently:

```ts
export const unlinkRunFile = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<void> => await unlinkScopedFile(
  stateFor(runStates, scope, 'RunDirectoryScope'),
  relativePath,
);
```

- [ ] **Step 6: Verify source and artifact tests**

Run:

```bash
pnpm test tests/unit/pipeline/source-assets.test.ts tests/unit/pipeline/artifacts.test.ts tests/unit/fs/app-directory-scopes.test.ts tests/unit/cli/doctor.test.ts
pnpm typecheck
```

Expected: PASS and exit code 0.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/pipeline/source-assets.ts src/pipeline/artifacts.ts src/fs/app-directory-scopes.ts src/cli/videoctl.ts tests/unit/pipeline/source-assets.test.ts tests/unit/pipeline/artifacts.test.ts tests/unit/fs/app-directory-scopes.test.ts tests/unit/cli/doctor.test.ts
git commit -m "feat: discover and verify pipeline source artifacts"
```

---

### Task 2: Add Provider Factories and Cross-Run Narration Cache Seeding

**Files:**
- Modify: `src/providers/tts.ts`
- Modify: `src/narration/build-narration.ts`
- Create: `src/pipeline/narration-cache.ts`
- Modify: `src/pipeline/stages/preflight.ts`
- Test: `tests/unit/providers/tts-factory.test.ts`
- Test: `tests/unit/pipeline/narration-cache.test.ts`
- Modify: `tests/unit/pipeline/preflight.test.ts`

- [ ] **Step 1: Write failing provider factory and preflight tests**

```ts
describe('createTtsProvider', () => {
  it.each(['mock', 'file', 'macos-say'] as const)('creates %s', async (provider) => {
    const instance = createTtsProvider({
      provider,
      projectDirectory,
      runDirectory,
      ffmpegExecutable: '/tools/ffmpeg',
    });
    expect(instance.id).toBe(provider);
    await expect(fingerprintTtsProvider(provider, fakeProviderIdentity)).resolves.toMatch(/^sha256:/u);
  });
});

describe('preflight TTS gates', () => {
  it('does not require a macOS voice for the mock provider', async () => {
    const result = await runPreflight(input({provider: 'mock'}), dependenciesWithoutVoice());
    expect(result.checks).not.toContainEqual(expect.objectContaining({code: 'ENV_VOICE_MISSING'}));
  });

  it('requires audioPath on every segment for the file provider', async () => {
    const result = await runPreflight(input({provider: 'file', missingAudioPath: true}), dependenciesWithoutVoice());
    expect(result.checks).toContainEqual(expect.objectContaining({code: 'ENV_VOICE_MISSING'}));
  });
});
```

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm test tests/unit/providers/tts-factory.test.ts tests/unit/pipeline/preflight.test.ts
```

Expected: FAIL because the factory and provider-specific Preflight behavior do not exist.

- [ ] **Step 3: Export the provider identity and factory APIs**

Add the following public contract to `src/providers/tts.ts` and reuse it from provider instances:

```ts
export type TtsProviderId = 'macos-say' | 'file' | 'mock';

export interface TtsProviderIdentityDependencies {
  stat(candidate: string): Promise<{mtimeMs: number; size: number}>;
}

export async function fingerprintTtsProvider(
  provider: TtsProviderId,
  dependencies: TtsProviderIdentityDependencies = {stat},
): Promise<string> {
  if (provider === 'macos-say') {
    const say = await dependencies.stat('/usr/bin/say');
    return fingerprintValue({provider, algorithm: 'macos-say-v1', say});
  }
  return fingerprintValue({provider, algorithm: `${provider}-tts-v1`});
}

export function createTtsProvider(input: {
  provider: TtsProviderId;
  projectDirectory: ProjectDirectoryScope;
  runDirectory: RunDirectoryScope;
  ffmpegExecutable?: string;
  runProcess?: TtsProcessRunner;
}): TtsProvider {
  switch (input.provider) {
    case 'mock':
      return new MockTtsProvider(input);
    case 'file':
      return new FileTtsProvider(input);
    case 'macos-say':
      return new MacOsSayProvider(input);
  }
}
```

Change every provider's `fingerprint()` method to call `fingerprintTtsProvider(this.id)`.

Update Preflight:

- `macos-say`: configured voice must exist.
- `file`: every segment must have `audioPath`; the macOS voice is irrelevant.
- `mock`: voice probing is informational only and never fails the Gate.

- [ ] **Step 4: Export the canonical narration segment key**

Rename the private helper and use it internally:

```ts
export const narrationSegmentInputHash = (
  segment: ScriptSegment,
  voice: string,
  rate: number,
  providerFingerprint: string,
): string => fingerprintValue({
  segmentId: segment.id,
  normalizedText: segment.normalizedText,
  voice,
  rate,
  providerFingerprint,
  sampleRate: 48_000,
  channels: 1,
});
```

- [ ] **Step 5: Write failing cross-Run cache tests**

```ts
it('copies only unchanged segment cache WAVs into the target Run', async () => {
  const copied = await seedNarrationCache({
    sourceRun,
    targetRun,
    script: changedSecondSegment,
    voice: 'fixture',
    rate: 180,
    providerFingerprint,
  });

  expect(copied).toEqual(['audio/cache/first-input-hash.wav']);
  await expect(runFileExists(targetRun, 'audio/cache/first-input-hash.wav')).resolves.toBe(true);
  await expect(runFileExists(targetRun, 'audio/cache/old-second-input-hash.wav')).resolves.toBe(false);
});
```

- [ ] **Step 6: Implement `seedNarrationCache()`**

```ts
export async function seedNarrationCache(input: {
  sourceRun: RunDirectoryScope;
  targetRun: RunDirectoryScope;
  script: Script;
  voice: string;
  rate: number;
  providerFingerprint: string;
}): Promise<string[]>;
```

Read and validate the source `narration-manifest.json`. Calculate the new script's allowed segment input hashes with `narrationSegmentInputHash()`. For every hash present in both sets, copy `audio/cache/<hash-without-sha256-prefix>.wav` through `copyRunArtifact()`. Return sorted copied paths. Missing old cache files are skipped; hash or authority failures fail closed.

Before copying, call `hashRunArtifact()` on the old cache WAV and pass that concrete artifact record to `copyRunArtifact()`; the Narration Manifest does not store cache-file hashes.

- [ ] **Step 7: Verify provider and cache behavior**

Run:

```bash
pnpm test tests/unit/providers/tts-factory.test.ts tests/unit/pipeline/narration-cache.test.ts tests/unit/narration/build-narration.test.ts tests/unit/pipeline/preflight.test.ts
pnpm typecheck
```

Expected: PASS and exit code 0.

- [ ] **Step 8: Commit Task 2**

```bash
git add src/providers/tts.ts src/narration/build-narration.ts src/pipeline/narration-cache.ts src/pipeline/stages/preflight.ts tests/unit/providers/tts-factory.test.ts tests/unit/pipeline/narration-cache.test.ts tests/unit/pipeline/preflight.test.ts
git commit -m "feat: prepare reusable narration providers and caches"
```

---

### Task 3: Define Stage, Report, Preset, and Registry Contracts

**Files:**
- Create: `src/pipeline/stage.ts`
- Create: `src/pipeline/stage-report.ts`
- Create: `src/pipeline/presets.ts`
- Create: `src/pipeline/stage-registry.ts`
- Create: `tests/helpers/pipeline-fixtures.ts`
- Test: `tests/unit/pipeline/stage-report.test.ts`
- Test: `tests/unit/pipeline/stage-registry.test.ts`

- [ ] **Step 1: Write failing report and registry tests**

```ts
it('round-trips a strict passed Stage report', async () => {
  const report = passedStageReport({stageId: 'ingest'});
  await store.writeStage(runDirectory, report);
  await expect(store.readStage(runDirectory, 'ingest')).resolves.toEqual(report);
});

it('rejects duplicate or reordered Stage registrations', () => {
  expect(() => createStageRegistry([
    fakeStage('preflight'),
    fakeStage('preflight'),
  ])).toThrow(/STAGE_REGISTRY_INVALID/u);
});

it('keeps all Presets contiguous in registry order', () => {
  expect(STAGE_PRESETS).toEqual({
    assets: ['preflight', 'ingest'],
    draft: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
    release: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
  });
});
```

- [ ] **Step 2: Run the contract tests and verify failure**

Run:

```bash
pnpm test tests/unit/pipeline/stage-report.test.ts tests/unit/pipeline/stage-registry.test.ts
```

Expected: FAIL because the orchestration contracts do not exist.

- [ ] **Step 3: Implement the common Stage contract**

`src/pipeline/stage.ts` must import `StageId` and `PipelinePreset` from `src/pipeline/run-store.ts`; it must not define duplicate unions.

```ts
export type StageAction = 'run' | 'cached' | 'resume';

export interface StagePlanningContext {
  project: ProjectInputs;
  sourceCatalog: ProjectSourceCatalog;
  preflight?: PreflightResult;
  sourceRun?: {
    runId: string;
    runDirectory: RunDirectoryScope;
    reports: ReadonlyMap<StageId, StageReport>;
  };
}

export interface StageExecutionContext extends StagePlanningContext {
  preset: PipelinePreset;
  runId?: string;
  runDirectory?: RunDirectoryScope;
  now(): string;
}

export interface StageExecutionResult {
  state: 'passed' | 'needs_review';
  fingerprint: string;
  outputs: unknown;
  artifacts: PipelineArtifact[];
  checks: CheckResult[];
  outputCurrent?: CurrentPointer;
}

export interface PipelinePartialArtifact {
  scope: 'run' | 'output';
  path: string;
}

export interface PipelineStage {
  id: StageId;
  displayName: string;
  prerequisites: readonly StageId[];
  fingerprint(context: StagePlanningContext): Promise<string | null>;
  verify(context: StagePlanningContext, report: StageReport): Promise<boolean>;
  partialArtifacts(context: StageExecutionContext): readonly PipelinePartialArtifact[];
  execute(context: StageExecutionContext, signal: AbortSignal): Promise<StageExecutionResult>;
}
```

Add `requireRunContext()` and `requirePreflight()` helpers that throw `PIPELINE_CONTEXT_INVALID` instead of using non-null assertions.

- [ ] **Step 4: Implement strict Stage reports**

Persist canonical successful reports at `reports/<stage-id>.json`. Persist `needs_review`, `failed`, and `cancelled` attempts at `reports/attempts/<attempt-id>.json` so approval can later write the canonical `reports/review.json` without overwriting an immutable file.

```ts
export interface StageReport {
  version: 1;
  projectId: string;
  runId: string;
  preset: PipelinePreset;
  stageId: StageId;
  position: number;
  total: number;
  state: 'passed' | 'cached' | 'needs_review' | 'failed' | 'cancelled';
  fingerprint: string | null;
  startedAt: string;
  finishedAt: string;
  artifacts: PipelineArtifact[];
  outputs?: unknown;
  checks: CheckResult[];
  provenance?: {sourceRunId: string; sourceStageId: StageId};
  error?: {code: string; message: string};
}
```

`StageReportSchema` must be strict, validate canonical ISO timestamps, enforce `1 <= position <= total`, require a fingerprint for `passed` and `cached`, and require `error` for `failed` and `cancelled`.

Export:

```ts
export interface StageReportStore {
  readStage(run: RunDirectoryScope, stageId: StageId): Promise<StageReport | null>;
  writeStage(run: RunDirectoryScope, report: StageReport): Promise<void>;
  writeAttempt(run: RunDirectoryScope, report: StageReport): Promise<string>;
}

export const createStageReportStore = (): StageReportStore;
```

- [ ] **Step 5: Implement Presets and registry validation**

```ts
export const STAGE_PRESETS = {
  assets: ['preflight', 'ingest'],
  draft: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
  release: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
} as const satisfies Record<PipelinePreset, readonly StageId[]>;

export function createStageRegistry(stages: readonly PipelineStage[]): readonly PipelineStage[];
```

`createStageRegistry()` must freeze a copy, reject duplicates, require the exact stable order, and verify every Preset is a contiguous prefix of the registered order.

- [ ] **Step 6: Verify contracts and types**

Run:

```bash
pnpm test tests/unit/pipeline/stage-report.test.ts tests/unit/pipeline/stage-registry.test.ts
pnpm typecheck
```

Expected: PASS and exit code 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/pipeline/stage.ts src/pipeline/stage-report.ts src/pipeline/presets.ts src/pipeline/stage-registry.ts tests/helpers/pipeline-fixtures.ts tests/unit/pipeline/stage-report.test.ts tests/unit/pipeline/stage-registry.test.ts
git commit -m "feat: define typed pipeline stage contracts"
```

---

### Task 4: Implement the Seven Concrete Stage Adapters

**Files:**
- Create: `src/pipeline/stage-adapters/preflight.ts`
- Create: `src/pipeline/stage-adapters/ingest.ts`
- Create: `src/pipeline/stage-adapters/narration.ts`
- Create: `src/pipeline/stage-adapters/compile.ts`
- Create: `src/pipeline/stage-adapters/draft.ts`
- Create: `src/pipeline/stage-adapters/review.ts`
- Create: `src/pipeline/stage-adapters/release.ts`
- Create: `src/pipeline/stage-adapters/index.ts`
- Modify: `src/pipeline/stage-registry.ts`
- Modify: `src/pipeline/stages/draft.ts`
- Modify: `src/pipeline/stages/release.ts`
- Test: `tests/unit/pipeline/stage-adapters.test.ts`

- [ ] **Step 1: Write failing table-driven fingerprint tests**

Use fake concrete Stage dependencies and assert every frozen input independently changes the adapter fingerprint.

```ts
it.each([
  ['ingest', 'source hash'],
  ['narration', 'provider fingerprint'],
  ['compile', 'edit authoring hash'],
  ['draft', 'targetLufs'],
  ['draft', 'truePeakDb'],
  ['release', 'Draft filter-graph hash'],
  ['release', 'qt-faststart environment fingerprint'],
] as const)('%s fingerprint changes with %s', async (stageId, mutation) => {
  const stage = registryById(MVP_STAGES, stageId);
  const before = await stage.fingerprint(planningContext());
  const after = await stage.fingerprint(planningContextWith(mutation));
  expect(after).not.toBe(before);
});
```

Also verify `preflight.fingerprint()` returns `null` before an executable probe and every adapter reports only artifacts it owns or consumes as provenance.

- [ ] **Step 2: Run the adapter tests and verify failure**

Run:

```bash
pnpm test tests/unit/pipeline/stage-adapters.test.ts
```

Expected: FAIL because the adapters and `MVP_STAGES` do not exist.

- [ ] **Step 3: Export shared Draft and Release report contracts**

Move the private Draft report schema from `src/pipeline/stages/release.ts` into `src/pipeline/stages/draft.ts` and export it without changing its JSON shape:

```ts
export const DraftReportSchema = z.object({
  version: z.literal(1),
  projectId: z.string().min(1),
  outputs: z.object({
    contactSheet: ArtifactReferenceSchema,
    reviewFrames: z.array(ArtifactReferenceSchema).min(1),
    audio: z.object({
      filterGraph: ArtifactReferenceSchema,
      mixedAudio: ArtifactReferenceSchema,
    }).strict(),
    audioMixFingerprint: z.string().min(1),
  }).passthrough(),
}).passthrough();

export type DraftReport = z.infer<typeof DraftReportSchema>;
```

Make Release import this schema. Export a pure `releaseStageFingerprint()` helper from `release.ts` and use it both inside `runRelease()` and the Release adapter. Add `publishCurrent?: boolean` to `ReleaseStageDependencies`, default it to `true` for existing direct Stage callers, and make the P06 adapter pass `false`; the adapter returns the candidate pointer as `StageExecutionResult.outputCurrent`.

- [ ] **Step 4: Implement adapters with explicit fingerprint inputs**

Each adapter exports one `PipelineStage`. Use these algorithm-version constants:

```ts
export const STAGE_ALGORITHM_VERSIONS = {
  preflight: 'preflight-stage-v1',
  ingest: 'ingest-stage-v1',
  narration: 'narration-stage-v1',
  compile: 'compile-stage-v1',
  draft: 'draft-stage-v1',
  review: 'review-stage-v1',
  release: 'release-stage-v1',
} as const;
```

Adapter requirements:

| Stage | Fingerprint inputs | Owned artifact inventory |
| --- | --- | --- |
| Preflight | actual `environmentFingerprint`, source catalog fingerprint, font path/hash, TTS config, algorithm version | no media; persisted result in Stage report |
| Ingest | source catalog assets/hashes, resolved FFmpeg identity, MVP profile, algorithm version | `asset-manifest.json` and every Run-local transcoded `renderPath` |
| Narration | script, TTS config, provider fingerprint, FFmpeg identity, algorithm version | cache WAVs, segment WAVs, master WAV, `narration-manifest.json`, `captions.json`, `captions.srt` |
| Compile | project/script/edit authoring hashes, Ingest report fingerprint, Narration report fingerprint, registered component IDs, algorithm version | `compiled-timeline.json` |
| Draft | Compile fingerprint, complete `project.audio`, render config, `AUDIO_MIX_ALGORITHM_VERSION`, algorithm version | muted video, draft video, contact sheet, review frames, filter graph, normalized audio, Draft report |
| Review | Draft evidence paths and hashes, algorithm version | canonical report only; approval remains `review.json` |
| Release | Draft artifact hashes, Compile input hashes, approved Review identity, Preflight environment fingerprint, fixed profile, algorithm version | Run intermediate plus every output release file |

Use `fingerprintValue()` over plain JSON values only. Do not include raw scope objects, functions, dates, or absolute workspace paths.

- [ ] **Step 5: Implement execution and verification**

Every non-Preflight adapter calls `requireRunContext()` and `requirePreflight()`. The Narration adapter creates the provider with `createTtsProvider()`, seeds matching prior cache WAVs when the Stage fingerprint changed, then calls `runNarration()`. The Review adapter reads `review.json` if present, derives evidence from the Draft report, and calls `evaluateReview()`. The Release adapter passes the persisted Preflight snapshot to `runRelease()`.

Every adapter also returns exact `partialArtifacts()` paths. These are limited to files the concrete Stage may have opened before success; they may not include a whole Run directory, a source path, or another Stage's successful artifact.

`verify()` must parse the adapter's persisted outputs and verify every listed artifact through `verifyRunArtifact()` or `verifyOutputArtifact()`. A missing, changed, or cross-scope artifact returns `false`; it must not throw for ordinary cache misses.

- [ ] **Step 6: Build and export the real registry**

```ts
export const MVP_STAGES = createStageRegistry([
  preflightStage,
  ingestStage,
  narrationStage,
  compileStage,
  draftStage,
  reviewStage,
  releaseStage,
]);
```

- [ ] **Step 7: Verify adapters and all existing Stage tests**

Run:

```bash
pnpm test tests/unit/pipeline/stage-adapters.test.ts tests/unit/pipeline/preflight.test.ts tests/unit/pipeline/narration.test.ts tests/unit/pipeline/compile.test.ts tests/integration/pipeline/ingest.test.ts tests/integration/pipeline/draft.test.ts tests/integration/pipeline/release.test.ts
pnpm typecheck
```

Expected: PASS and no existing Stage output format changes.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/pipeline/stage-adapters src/pipeline/stage-registry.ts src/pipeline/stages/draft.ts src/pipeline/stages/release.ts tests/unit/pipeline/stage-adapters.test.ts
git commit -m "feat: adapt concrete stages to the pipeline registry"
```

---

### Task 5: Build the Side-Effect-Free Execution Plan

**Files:**
- Create: `src/pipeline/execution-plan.ts`
- Modify: `src/fs/app-directory-scopes.ts`
- Modify: `src/pipeline/run-store.ts`
- Modify: `tests/integration/pipeline/run-store.test.ts`
- Test: `tests/unit/pipeline/execution-plan.test.ts`
- Test: `tests/integration/pipeline/plan-side-effects.test.ts`

- [ ] **Step 1: Write failing plan selection tests**

```ts
it('defaults to the release Preset and numbers only selected items', async () => {
  const plan = await buildExecutionPlan(context(), {});
  expect(plan.preset).toBe('release');
  expect(plan.items.map(({position, total, stageId}) => ({position, total, stageId}))).toEqual([
    {position: 1, total: 7, stageId: 'preflight'},
    {position: 2, total: 7, stageId: 'ingest'},
    {position: 3, total: 7, stageId: 'narration'},
    {position: 4, total: 7, stageId: 'compile'},
    {position: 5, total: 7, stageId: 'draft'},
    {position: 6, total: 7, stageId: 'review'},
    {position: 7, total: 7, stageId: 'release'},
  ]);
});

it('creates a new Run for --resume --force compile when Compile already passed', async () => {
  const plan = await buildExecutionPlan(contextWithPassedRelease(), {
    preset: 'release',
    resume: true,
    force: 'compile',
  });
  expect(plan.runMode).toBe('new');
  expect(plan.items.map((item) => [item.stageId, item.action, item.materialize])).toEqual([
    ['preflight', 'run', false],
    ['ingest', 'cached', true],
    ['narration', 'cached', true],
    ['compile', 'run', false],
    ['draft', 'run', false],
    ['review', 'run', false],
    ['release', 'run', false],
  ]);
});
```

Cover unknown Presets and Stages, reversed ranges, inclusive bounds, missing prerequisites, compatible cross-Preset prefixes, all-cached no-op plans, same-Run resume, completed-force new Runs, and fingerprint mismatch new Runs.

- [ ] **Step 2: Run unit tests and verify failure**

Run:

```bash
pnpm test tests/unit/pipeline/execution-plan.test.ts
```

Expected: FAIL because `buildExecutionPlan()` does not exist.

- [ ] **Step 3: Implement the plan types and builder**

```ts
export interface ExecutionPlanRequest {
  preset?: PipelinePreset;
  from?: StageId;
  to?: StageId;
  resume?: boolean;
  force?: StageId;
}

export interface ExecutionPlanItem {
  position: number;
  total: number;
  stageId: StageId;
  displayName: string;
  action: StageAction;
  fingerprint: string | null;
  sourceRunId?: string;
  materialize: boolean;
}

export interface ExecutionPlan {
  version: 1;
  projectId: string;
  preset: PipelinePreset;
  stageIds: StageId[];
  runMode: 'new' | 'resume' | 'noop';
  requiresRuntimePreflight: boolean;
  sourceRunId?: string;
  targetRunId?: string;
  items: ExecutionPlanItem[];
}

export interface ExecutionPlanContext {
  project: ProjectInputs;
  sourceCatalog: ProjectSourceCatalog;
  registry: readonly PipelineStage[];
  runStore: RunStore;
  outputStore: OutputStore;
  reportStore: StageReportStore;
  createRunId(): string;
}

export async function buildExecutionPlan(
  context: ExecutionPlanContext,
  request: ExecutionPlanRequest,
): Promise<ExecutionPlan>;
```

Add read-only store APIs before using the builder:

```ts
export class RunStore {
  async openExistingWork(projectId: string): Promise<WorkDirectoryScope | null>;
  async readCurrentReadonly(projectId: string): Promise<CurrentPointer | null>;
}

export class OutputStore {
  async openExistingProject(projectId: string): Promise<OutputDirectoryScope | null>;
  async readCurrentReadonly(projectId: string): Promise<CurrentPointer | null>;
}
```

These methods must traverse only already existing plain directories. Missing `.work`, `runs`, `output`, or project directories return `null`; they must not call `mkdir`, `ensurePlainDirectory()`, or pointer cleanup. Keep the existing mutating methods for executable paths.

Selection algorithm:

1. Validate the Preset and inclusive range against `MVP_STAGES`.
2. Read the work and output pointers through the new read-only APIs and open current Run/Output scopes only when they already exist.
3. Calculate read-only fingerprints. A `null` fingerprint means `run`.
4. Before `--from`, require a verified matching report for every omitted prerequisite.
5. A range that omits any prerequisite is bound to the current Run and may only be `resume` or `noop`; it never creates a new Run with hidden prerequisite copies.
6. If an omitted prerequisite or already materialized selected Stage changed, throw `PLAN_RANGE_STALE` and instruct the caller to widen `--from` to the first invalid Stage or remove it.
7. If no prerequisite is omitted and `resume` is false, use the current Run only as an optional cache source and choose `new` unless every selected Stage is already a verified no-op.
8. If `resume` is true and the completed prefix matches, mark the first incomplete Stage `resume` and remain in the current Run.
9. If an already completed Stage fingerprint changed in a full-prefix plan, choose `new`; cache/materialize only earlier still-matching Stages.
10. If `force` targets an already completed Stage in a full-prefix plan, choose `new`, materialize preceding matches, and run the target plus downstream Stages.
11. If `force` targets the first incomplete Stage, remain in `resume` mode.
12. When Preflight is selected, its action is always `run` because its full environment identity requires probing.
13. When `--from` omits Preflight, require a persisted Preflight report and set `requiresRuntimePreflight: true`; the Runner executes the same adapter as an unnumbered prerequisite Gate before writes and compares the actual fingerprint with that report.

Add a test for `--preset release --from compile --to draft`: visible items are only Compile and Draft with positions `1/2` and `2/2`, `requiresRuntimePreflight` is `true`, and `runMode` is `resume` when Compile is incomplete. Add a second test proving a changed Narration prerequisite fails with `PLAN_RANGE_STALE` rather than creating a new Run.

- [ ] **Step 4: Write the side-effect integration test**

Patch process spawning, Run creation, lock acquisition, pointer publication, and filesystem creation to throw if called. Build and format a Release plan.

```ts
expect(await buildExecutionPlan(context, {preset: 'release'})).toMatchObject({
  runMode: 'new',
  items: expect.arrayContaining([expect.objectContaining({stageId: 'preflight', action: 'run'})]),
});
expect(forbiddenWrites).not.toHaveBeenCalled();
expect(forbiddenProcesses).not.toHaveBeenCalled();
```

- [ ] **Step 5: Verify plan behavior**

Run:

```bash
pnpm test tests/unit/pipeline/execution-plan.test.ts tests/integration/pipeline/plan-side-effects.test.ts tests/integration/pipeline/run-store.test.ts
pnpm typecheck
```

Expected: PASS; the integration test observes zero writes, locks, directories, pointers, and subprocesses.

- [ ] **Step 6: Commit Task 5**

```bash
git add src/pipeline/execution-plan.ts src/fs/app-directory-scopes.ts src/pipeline/run-store.ts tests/unit/pipeline/execution-plan.test.ts tests/integration/pipeline/plan-side-effects.test.ts tests/integration/pipeline/run-store.test.ts
git commit -m "feat: build read-only pipeline execution plans"
```

---

### Task 6: Implement the Runner, Materialization, and Durable Progress

**Files:**
- Create: `src/pipeline/runner.ts`
- Modify: `src/pipeline/execution-plan.ts`
- Modify: `src/pipeline/stage-report.ts`
- Test: `tests/unit/pipeline/runner.test.ts`
- Test: `tests/integration/pipeline/preset-reuse.test.ts`

- [ ] **Step 1: Write failing Runner state-machine tests**

Use fake Stages with deterministic fingerprints and artifact bytes.

```ts
it('materializes cached prefix Stages into a new Run before forced execution', async () => {
  const result = await runExecutionPlan(executionInput(plan({
    runMode: 'new',
    sourceRunId: 'run-old',
    items: [
      item('preflight', 'run'),
      item('ingest', 'cached', {materialize: true}),
      item('narration', 'cached', {materialize: true}),
      item('compile', 'run'),
    ],
  })), runtime());

  expect(result.runId).not.toBe('run-old');
  expect(stageCalls()).toEqual(['preflight', 'compile']);
  expect(await report(result.runId, 'ingest')).toMatchObject({
    state: 'cached',
    provenance: {sourceRunId: 'run-old', sourceStageId: 'ingest'},
  });
});

it('publishes needs_review without running Release', async () => {
  const result = await runExecutionPlan(
    executionInput(releasePlan()),
    runtimeWithReview('needs_review'),
  );
  expect(result.state).toBe('needs_review');
  expect(stageCalls()).not.toContain('release');
  expect(await currentPointer()).toMatchObject({
    completedStage: 'review',
    state: 'needs_review',
  });
});

it('releases the project lock when a Stage throws', async () => {
  await expect(runExecutionPlan(
    executionInput(draftPlan()),
    runtimeWithFailure('compile'),
  )).rejects.toBeDefined();
  expect(lockLease.release).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run Runner tests and verify failure**

Run:

```bash
pnpm test tests/unit/pipeline/runner.test.ts
```

Expected: FAIL because `runExecutionPlan()` does not exist.

- [ ] **Step 3: Implement run identity and result contracts**

```ts
export interface PipelineRunResult {
  projectId: string;
  runId?: string;
  preset: PipelinePreset;
  state: 'passed' | 'needs_review' | 'failed' | 'cancelled';
  completedStage?: StageId;
  reports: StageReport[];
  preflight?: PreflightResult;
  warnings: Array<{code: string; message: string}>;
}

export interface RunExecutionInput {
  plan: ExecutionPlan;
  project: ProjectInputs;
  sourceCatalog: ProjectSourceCatalog;
  signal: AbortSignal;
}

export interface RunnerDependencies {
  registry: readonly PipelineStage[];
  runStore: RunStore;
  outputStore: OutputStore;
  reportStore: StageReportStore;
  acquireProjectLock: typeof acquireProjectLock;
  createRunId(): string;
  now(): string;
}

export const createRunId = (): string => {
  const time = new Date().toISOString().replace(/[-:.TZ]/gu, '').toLowerCase();
  return `run-${time}-${randomUUID().slice(0, 8)}`;
};

export async function runExecutionPlan(
  input: RunExecutionInput,
  dependencies: RunnerDependencies,
): Promise<PipelineRunResult>;
```

Run IDs must pass `StableIdSchema` and tests must inject deterministic IDs.

- [ ] **Step 4: Implement execution-time revalidation**

Add to `src/pipeline/execution-plan.ts`:

```ts
export async function revalidateExecutionPlan(
  plan: ExecutionPlan,
  context: ExecutionPlanContext,
): Promise<ExecutionPlan>;
```

For `new` plans, stale cached items become `run` from the first mismatch downstream. For `resume` plans, any changed completed report throws `ExecutionPlanError('PLAN_STALE', ...)` before writes. Ordinary missing artifacts are treated the same as a fingerprint mismatch.

- [ ] **Step 5: Implement Preflight and Run selection**

Runner order:

1. If the plan contains only Preflight, execute it without creating Work, Run, lock, or pointer state; return the raw result in `PipelineRunResult.preflight` and leave `reports` empty.
2. For `noop`, execute the unnumbered runtime Preflight Gate first when `requiresRuntimePreflight` is true, compare it with the persisted prerequisite report, then return the verified reports without creating Work state or acquiring a write lock.
3. Otherwise determine the lock Run ID (`sourceRunId` for resume, otherwise `targetRunId ?? createRunId()`), create/open the fixed Work scope, and acquire the project lock.
4. Revalidate the plan under the lock.
5. Execute the selected Preflight item or the unnumbered runtime Preflight Gate. An error result stops with no new Run. For `resume` or omitted-Preflight ranges, compare the actual fingerprint with the persisted report; a mismatch throws `PLAN_STALE` before Run writes so the command can rebuild or require the prerequisite range.
6. For `resume`, open the source Run as the target Run.
7. For `new`, create a fresh immutable Run. Write a selected Preflight report, or materialize the verified prerequisite Preflight report after the runtime Gate succeeds.

Use `aggregateChecks(preflight.checks)` to reject an environment failure. Persist the exact Preflight output in `reports/preflight.json` when a Run exists.

- [ ] **Step 6: Implement cached materialization and Stage execution**

For every `cached` item with `materialize: true`:

1. Read the verified source report.
2. Copy each `scope: 'run'` artifact with `copyRunArtifact()`.
3. Reject an Output artifact in a non-Release cached Stage.
4. Write a new canonical report with `state: 'cached'` and provenance.
5. Publish work progress after the report is durable.

For every executable item:

```ts
const startedAt = dependencies.now();
const result = await stage.execute(context, signal);
const finishedAt = dependencies.now();
const report = StageReportSchema.parse({
  version: 1,
  projectId,
  runId,
  preset: plan.preset,
  stageId: stage.id,
  position: item.position,
  total: item.total,
  state: result.state,
  fingerprint: result.fingerprint,
  startedAt,
  finishedAt,
  artifacts: result.artifacts,
  outputs: result.outputs,
  checks: result.checks,
});
```

Write `passed` reports canonically. Write `needs_review` as an attempt, publish the work pointer with state `needs_review`, and stop before Release. Throwing Stages are normalized in Task 8.

- [ ] **Step 7: Publish durable work progress**

After every canonical `passed` or `cached` report:

```ts
await runStore.publishCurrent(projectId, {
  runId,
  relativePath: `runs/${runId}`,
  preset: plan.preset,
  stageIds: plan.stageIds,
  completedStage: report.stageId,
  state: 'passed',
  publishedAt: report.finishedAt,
});
```

For ordinary Stages, publish work progress after the canonical report. Release is special:

1. The adapter prepares and verifies the Release with `publishCurrent: false`.
2. Runner writes canonical `reports/release.json`.
3. Runner publishes `StageExecutionResult.outputCurrent` through `OutputStore` as the Release commit point.
4. If Output publication fails, unlink only `reports/release.json`; leave both previous pointers unchanged and let Task 9 remove the unpublished Release directory.
5. After Output publication succeeds, attempt the work pointer update to `completedStage: release`. If that metadata update fails, return Release success with a `WORK_POINTER_LAGGING` warning because the verified Output publication is already committed.

Runner must not claim Draft artifacts as Release outputs.

- [ ] **Step 8: Add the preset-reuse integration test**

Run fake Assets, Draft, and Release plans against real Run Store scopes. Assert shared Stage artifacts are either kept in the same Run during resume or copied and hash-verified into a new Run. Assert no concrete Stage is invoked for a `cached` item.

- [ ] **Step 9: Verify Runner behavior**

Run:

```bash
pnpm test tests/unit/pipeline/runner.test.ts tests/integration/pipeline/preset-reuse.test.ts
pnpm typecheck
```

Expected: PASS; pointers advance only after durable reports and locks release on every path.

- [ ] **Step 10: Commit Task 6**

```bash
git add src/pipeline/runner.ts src/pipeline/execution-plan.ts src/pipeline/stage-report.ts tests/unit/pipeline/runner.test.ts tests/integration/pipeline/preset-reuse.test.ts
git commit -m "feat: execute and persist resumable pipeline plans"
```

---

### Task 7: Complete Resume, Review, Force, and Segment Reuse

**Files:**
- Modify: `src/pipeline/runner.ts`
- Modify: `src/cli/commands/review.ts`
- Test: `tests/integration/pipeline/resume.test.ts`
- Test: `tests/integration/pipeline/cache-invalidation.test.ts`
- Modify: `tests/unit/cli/review.test.ts`

- [ ] **Step 1: Write failing same-Run review resume tests**

```ts
it('approves and resumes Release in the same Run', async () => {
  const first = await runExecutionPlan(
    executionInput(releasePlan({resume: true})),
    runtime(),
  );
  expect(first).toMatchObject({state: 'needs_review', runId: 'run-review'});

  await runReviewCommand('demo', {
    approve: true,
    reason: 'draft accepted',
  }, reviewDependencies);

  const second = await runExecutionPlan(
    executionInput(releasePlan({resume: true})),
    runtime(),
  );
  expect(second).toMatchObject({state: 'passed', runId: 'run-review'});
  expect(stageCallsForSecondRun()).toEqual(['review', 'release']);
});
```

The test must assert the work pointer uses the same `runId`, the approved `review.json` matches the Draft evidence, and Release is not invoked before approval.

- [ ] **Step 2: Write failing `--resume --force` tests**

Cover both branches required by the approved design:

```ts
it('keeps the same Run when the forced Stage is first incomplete', async () => {
  const plan = await buildExecutionPlan(contextCompletedThroughNarration(), {
    preset: 'release', resume: true, force: 'compile',
  });
  expect(plan.runMode).toBe('resume');
  expect(plan.items.find((item) => item.stageId === 'compile')?.action).toBe('resume');
});

it('creates a new Run when the forced Stage already exists', async () => {
  const plan = await buildExecutionPlan(contextCompletedThroughDraft(), {
    preset: 'release', resume: true, force: 'compile',
  });
  expect(plan.runMode).toBe('new');
  expect(plan.items.find((item) => item.stageId === 'ingest')).toMatchObject({action: 'cached', materialize: true});
});
```

- [ ] **Step 3: Write failing segment invalidation integration tests**

Create `run-old` with two cached narration segments. Change only the second segment and execute a new Draft plan.

```ts
expect(newManifest.segments[0]?.inputHash).toBe(oldManifest.segments[0]?.inputHash);
expect(newManifest.segments[1]?.inputHash).not.toBe(oldManifest.segments[1]?.inputHash);
expect(ttsCalls).toEqual(['second']);
expect(newReports.get('ingest')?.state).toBe('cached');
expect(newReports.get('narration')?.fingerprint).not.toBe(oldReports.get('narration')?.fingerprint);
expect(newReports.get('compile')?.fingerprint).not.toBe(oldReports.get('compile')?.fingerprint);
expect(newReports.get('draft')?.fingerprint).not.toBe(oldReports.get('draft')?.fingerprint);
```

- [ ] **Step 4: Implement approval-aware Review resume**

The Review adapter must always reevaluate `review.json`. A prior `needs_review` attempt is not a cache hit. After approval, write canonical `reports/review.json` with `state: 'passed'`; do not overwrite the earlier attempt.

Update `runReviewCommand()` to:

- reject simultaneous `--approve` and `--reject`;
- return a stable validation failure for `--reject` because rejection behavior is not in MVP;
- preserve `runId`, `stageIds`, and `completedStage` while changing the work pointer from `needs_review` to `passed`;
- refuse approval unless the current pointer state is `needs_review` and Draft evidence exists.

- [ ] **Step 5: Implement partial Narration cache seeding**

When a new Run reuses a previous Run but the Narration Stage fingerprint changed, call `seedNarrationCache()` before `narrationStage.execute()`. The Runner passes the previous Run scope through `StageExecutionContext.sourceRun`. A Stage with an unchanged full fingerprint remains a normal cached materialization and does not execute.

- [ ] **Step 6: Verify resume and invalidation**

Run:

```bash
pnpm test tests/integration/pipeline/resume.test.ts tests/integration/pipeline/cache-invalidation.test.ts tests/unit/cli/review.test.ts
pnpm typecheck
```

Expected: PASS; Review preserves `runId`, force semantics match both branches, and only changed Narration segments synthesize.

- [ ] **Step 7: Commit Task 7**

```bash
git add src/pipeline/runner.ts src/cli/commands/review.ts tests/integration/pipeline/resume.test.ts tests/integration/pipeline/cache-invalidation.test.ts tests/unit/cli/review.test.ts
git commit -m "feat: resume reviewed runs and reuse narration segments"
```

---

### Task 8: Normalize Runtime Failures, Signals, and Disk Exhaustion

**Files:**
- Create: `src/pipeline/runtime-errors.ts`
- Create: `src/pipeline/signals.ts`
- Modify: `src/pipeline/runner.ts`
- Modify: `src/cli/exit-codes.ts`
- Create: `tests/fixtures/signal-runner.ts`
- Test: `tests/unit/pipeline/runtime-errors.test.ts`
- Test: `tests/integration/pipeline/signals.test.ts`
- Test: `tests/integration/pipeline/disk-exhaustion.test.ts`

- [ ] **Step 1: Write failing error normalization tests**

```ts
it.each([
  [{code: 'ENOSPC'}, 'DISK_SPACE_EXHAUSTED'],
  [{code: 'PROCESS_ABORTED'}, 'PIPELINE_CANCELLED'],
  [{code: 'ENV_TOOL_MISSING'}, 'ENV_TOOL_MISSING'],
] as const)('normalizes %o to %s', (error, code) => {
  expect(normalizePipelineError(error)).toMatchObject({code});
});
```

- [ ] **Step 2: Implement the stable runtime failure contract**

```ts
export type PipelineRuntimeErrorCode =
  | 'PIPELINE_CANCELLED'
  | 'DISK_SPACE_EXHAUSTED'
  | 'PLAN_STALE'
  | 'PIPELINE_STAGE_FAILED'
  | 'PIPELINE_CLEANUP_FAILED';

export class PipelineRuntimeError extends Error {
  constructor(
    readonly code: PipelineRuntimeErrorCode | string,
    message: string,
    readonly stageId?: StageId,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'PipelineRuntimeError';
  }
}

export function normalizePipelineError(error: unknown, stageId?: StageId): PipelineRuntimeError;
```

Preserve a trusted existing string `code`. Map Node `ENOSPC` to `DISK_SPACE_EXHAUSTED`, process abort to `PIPELINE_CANCELLED`, and unknown errors to `PIPELINE_STAGE_FAILED`. Never include command stdout, environment variables, or raw user paths in the public message.

- [ ] **Step 3: Implement signal registration**

```ts
export interface PipelineSignalHandle {
  signal: AbortSignal;
  received?: NodeJS.Signals;
  dispose(): void;
}

export function installPipelineSignalHandlers(
  processLike: Pick<NodeJS.Process, 'once' | 'off'> = process,
): PipelineSignalHandle;

export const signalExitCode = (signal: NodeJS.Signals | undefined): number =>
  signal === 'SIGTERM' ? 143 : 130;
```

Register exactly one handler for `SIGINT` and `SIGTERM`, abort one controller, remember only the first signal, and remove both handlers in `dispose()`.

- [ ] **Step 4: Write the real signal integration test**

`tests/fixtures/signal-runner.ts` starts a fake Stage whose child process remains alive until its `AbortSignal` fires. The integration test spawns it with `tsx`, waits for a ready marker, sends the actual signal, and asserts:

```ts
expect(exit.signal).toBeNull();
expect(exit.code).toBe(signal === 'SIGINT' ? 130 : 143);
await expect(projectLockExists(workspace)).resolves.toBe(false);
await expect(readOutputCurrent(workspace)).resolves.toEqual(previousOutputPointer);
```

- [ ] **Step 5: Add failure attempts and `finally` cleanup hooks to Runner**

On a thrown Stage error:

1. Normalize the error.
2. Write a `failed` or `cancelled` attempt if a Run exists.
3. Invoke an injected `cleanupFailedStage` callback with the Stage's declared partial paths.
4. Keep the last work and output pointers unchanged.
5. Release the lock in `finally`.
6. Rethrow the normalized error to the command layer.

If writing the attempt also fails with `ENOSPC`, retain the original `DISK_SPACE_EXHAUSTED` as the primary error.

Add the dependency now with a no-op default so Task 8 compiles independently:

```ts
export interface FailedStageCleanupInput {
  projectId: string;
  runId?: string;
  stageId: StageId;
  runDirectory?: RunDirectoryScope;
  outputDirectory?: OutputDirectoryScope;
  partialArtifacts: readonly PipelinePartialArtifact[];
}

cleanupFailedStage?: (input: FailedStageCleanupInput) => Promise<void>;
```

The signal and disk tests inject a spy and assert it receives only the active Stage's declared partial paths. Task 9 replaces the system default with the authority-scoped implementation.

- [ ] **Step 6: Write the disk-exhaustion matrix**

Inject `ENOSPC` at these boundaries:

- Stage canonical report write;
- work pointer temporary write or sync;
- cached artifact copy;
- fake Release output write;
- output pointer temporary write or sync.

For every case assert:

```ts
await expect(run()).rejects.toMatchObject({code: 'DISK_SPACE_EXHAUSTED'});
expect(await readWorkCurrent()).toEqual(previousWorkPointer);
expect(await readOutputCurrent()).toEqual(previousOutputPointer);
expect(await pointerTemps()).toEqual([]);
expect(await lockExists()).toBe(false);
```

Add one separate post-commit case: inject `ENOSPC` only into the best-effort Work pointer update after Output publication. The command returns success with `WORK_POINTER_LAGGING`, the new Output pointer remains current, and the previous Work pointer remains intact.

- [ ] **Step 7: Extend exit codes**

```ts
export const EXIT_CODES = {
  success: 0,
  needsReview: 2,
  validationFailed: 3,
  environmentFailed: 4,
  cancelled: 130,
  terminated: 143,
} as const;
```

- [ ] **Step 8: Verify failure behavior**

Run:

```bash
pnpm test tests/unit/pipeline/runtime-errors.test.ts tests/integration/pipeline/signals.test.ts tests/integration/pipeline/disk-exhaustion.test.ts
pnpm typecheck
```

Expected: PASS; no signal or disk failure changes a previous successful pointer.

- [ ] **Step 9: Commit Task 8**

```bash
git add src/pipeline/runtime-errors.ts src/pipeline/signals.ts src/pipeline/runner.ts src/cli/exit-codes.ts tests/fixtures/signal-runner.ts tests/unit/pipeline/runtime-errors.test.ts tests/integration/pipeline/signals.test.ts tests/integration/pipeline/disk-exhaustion.test.ts
git commit -m "feat: recover safely from signals and disk exhaustion"
```

---

### Task 9: Add Authority-Scoped Cleanup and the Shared Cleanup Service

**Files:**
- Modify: `src/fs/app-directory-scopes.ts`
- Modify: `src/pipeline/run-store.ts`
- Modify: `src/pipeline/artifacts.ts`
- Create: `src/pipeline/cleanup.ts`
- Modify: `src/pipeline/runner.ts`
- Modify: `tests/unit/fs/app-directory-scopes.test.ts`
- Test: `tests/unit/pipeline/cleanup.test.ts`
- Test: `tests/integration/pipeline/cleanup.test.ts`

- [ ] **Step 1: Write failing scoped list/remove tests**

```ts
it('lists plain children and removes a Run subtree without following symlinks', async () => {
  expect(await listRunDirectory(runDirectory, 'draft')).toEqual([
    {name: 'partial.mp4', kind: 'file'},
  ]);
  await removeRunTree(runDirectory, 'draft');
  await expect(listRunDirectory(runDirectory, '.')).resolves.not.toContainEqual(
    expect.objectContaining({name: 'draft'}),
  );
});

it('fails closed when a child becomes a symlink before deletion', async () => {
  await replaceWithSymlink(target);
  await expect(removeOutputTree(outputDirectory, 'releases/old-run')).rejects.toMatchObject({
    code: 'APP_PATH_OUTSIDE_SCOPE',
  });
});
```

- [ ] **Step 2: Implement narrow scoped tree APIs**

Export:

```ts
export interface ScopedDirectoryEntry {
  name: string;
  kind: Exclude<AppDirectoryEntryKind, 'missing'>;
}

export const listWorkDirectory = async (
  scope: WorkDirectoryScope,
  relativePath: string,
): Promise<ScopedDirectoryEntry[]>;

export const listRunDirectory = async (
  scope: RunDirectoryScope,
  relativePath: string,
): Promise<ScopedDirectoryEntry[]>;

export const listOutputDirectory = async (
  scope: OutputDirectoryScope,
  relativePath: string,
): Promise<ScopedDirectoryEntry[]>;

export const unlinkRunFile = async (scope: RunDirectoryScope, relativePath: string): Promise<void>;
export const removeRunTree = async (scope: RunDirectoryScope, relativePath: string): Promise<void>;
export const removeWorkTree = async (scope: WorkDirectoryScope, relativePath: string): Promise<void>;
export const removeOutputTree = async (scope: OutputDirectoryScope, relativePath: string): Promise<void>;
```

Implementation rules:

- Open and hold each parent directory identity during enumeration and deletion.
- Sort directory entries by name.
- Reject symlink and `other` entries rather than unlinking them.
- Revalidate identity immediately before deleting every file or empty directory.
- Treat `ENOENT` as already removed.
- Never accept `.` as a removal target.

Re-export these APIs from `src/pipeline/run-store.ts` only when the pipeline layer needs them.

- [ ] **Step 3: Write failing cleanup inventory tests**

```ts
it('protects both current pointers and selects only unreferenced directories', async () => {
  const plan = await buildCleanupPlan({workspaceRoot, projectId: 'demo'});
  expect(plan.protectedRunId).toBe('run-current');
  expect(plan.protectedReleaseId).toBe('release-current');
  expect(plan.runDirectories).toEqual(['run-failed', 'run-old']);
  expect(plan.releaseDirectories).toEqual(['release-unpublished']);
});
```

- [ ] **Step 4: Implement cleanup inventory and execution**

```ts
export interface CleanupPlan {
  projectId: string;
  protectedRunId?: string;
  protectedReleaseId?: string;
  runDirectories: string[];
  releaseDirectories: string[];
}

export interface CleanupResult {
  removedRuns: string[];
  removedReleases: string[];
}

export interface CleanupDependencies {
  runStore: RunStore;
  outputStore: OutputStore;
  removeWorkTree: typeof removeWorkTree;
  removeOutputTree: typeof removeOutputTree;
}

export async function buildCleanupPlan(input: {
  workspaceRoot: string;
  projectId: string;
}): Promise<CleanupPlan>;

export async function executeCleanupPlan(
  plan: CleanupPlan,
  dependencies?: CleanupDependencies,
): Promise<CleanupResult>;

export async function cleanupFailedStage(
  input: FailedStageCleanupInput,
): Promise<void>;
```

`buildCleanupPlan()` obtains Work and Output scopes, reads both current pointers, lists only `runs/<stable-id>` and `releases/<stable-id>` directories, and excludes protected IDs. `executeCleanupPlan()` re-reads pointers before each deletion; if a candidate became current, skip it. Delete through `removeWorkTree()` or `removeOutputTree()` only.

Add `cleanupFailedStage()` for Runner-owned known partial paths. It may unlink only paths declared by the active Stage adapter and never delete the current Run directory.

- [ ] **Step 5: Update artifact-copy rollback**

If `copyRunArtifact()` fails after opening the target, close handles and call `unlinkRunFile()` for that exact target. It must not delete the parent directory or any sibling artifact.

- [ ] **Step 6: Add integration coverage for idempotence and races**

Run cleanup twice and expect the second result to contain empty removed arrays. Replace a candidate directory or pointer between inventory and execution and assert the operation fails closed or protects the new current ID.

- [ ] **Step 7: Verify cleanup**

Run:

```bash
pnpm test tests/unit/fs/app-directory-scopes.test.ts tests/unit/pipeline/cleanup.test.ts tests/integration/pipeline/cleanup.test.ts tests/integration/pipeline/disk-exhaustion.test.ts
pnpm typecheck
```

Expected: PASS; source assets, current Run, and current Release are unchanged.

- [ ] **Step 8: Commit Task 9**

```bash
git add src/fs/app-directory-scopes.ts src/pipeline/run-store.ts src/pipeline/artifacts.ts src/pipeline/cleanup.ts src/pipeline/runner.ts tests/unit/fs/app-directory-scopes.test.ts tests/unit/pipeline/cleanup.test.ts tests/integration/pipeline/cleanup.test.ts
git commit -m "feat: clean pipeline artifacts through scoped authority"
```

---

### Task 10: Complete the CLI, Reports, and One-Path Command Mapping

**Files:**
- Create: `src/cli/commands/pipeline.ts`
- Create: `src/cli/commands/report.ts`
- Create: `src/cli/commands/clean.ts`
- Modify: `src/cli/videoctl.ts`
- Modify: `src/cli/output.ts`
- Modify: `src/cli/commands/review.ts`
- Test: `tests/unit/cli/pipeline.test.ts`
- Test: `tests/unit/cli/report.test.ts`
- Test: `tests/unit/cli/clean.test.ts`
- Modify: `tests/unit/cli/doctor.test.ts`
- Modify: `tests/unit/cli/review.test.ts`

- [ ] **Step 1: Write failing command-mapping tests**

```ts
it.each([
  [['doctor', 'demo'], {preset: 'release', to: 'preflight'}],
  [['ingest', 'demo'], {preset: 'assets', to: 'ingest'}],
  [['run', 'demo', '--to', 'narration'], {preset: 'draft', to: 'narration'}],
  [['compile', 'demo'], {preset: 'draft', to: 'compile'}],
  [['release', 'demo'], {preset: 'release'}],
] as const)('maps %o through the shared plan builder', async (argv, request) => {
  await runVideoctl(argv, dependencies);
  expect(dependencies.buildExecutionPlan).toHaveBeenCalledWith(expect.anything(), request);
  expect(dependencies.runExecutionPlan).toHaveBeenCalledTimes(1);
});
```

Also cover all `pipeline` options, JSON output, invalid ranges, `--reject`, report without a current Run, and clean results.

- [ ] **Step 2: Implement the pipeline command handler**

```ts
export interface PipelineCommandOptions {
  preset?: PipelinePreset;
  plan?: boolean;
  from?: StageId;
  to?: StageId;
  resume?: boolean;
  force?: StageId;
  json?: boolean;
}

export interface PipelineCommandDependencies {
  workspaceRoot: string;
  stdout: OutputWriter;
  stderr: OutputWriter;
  loadProject: typeof loadProject;
  discoverProjectSourceCatalog: typeof discoverProjectSourceCatalog;
  buildExecutionPlan(
    project: ProjectInputs,
    sourceCatalog: ProjectSourceCatalog,
    request: ExecutionPlanRequest,
  ): Promise<ExecutionPlan>;
  runExecutionPlan(input: RunExecutionInput): Promise<PipelineRunResult>;
  installPipelineSignalHandlers: typeof installPipelineSignalHandlers;
}

export async function runPipelineCommand(
  projectId: string,
  options: PipelineCommandOptions,
  dependencies: PipelineCommandDependencies,
): Promise<number>;
```

Handler order:

1. Load the project and source catalog.
2. Build the plan.
3. If `--plan`, format it and exit 0.
4. Install signal handlers.
5. Execute the Runner.
6. On one `PLAN_STALE`, rebuild and retry once before any write from the stale attempt.
7. Dispose signal handlers.
8. Map `needs_review` to 2, validation to 3, environment failures to 4, SIGINT to 130, and SIGTERM to 143.

- [ ] **Step 3: Implement report and clean handlers**

`report` uses `readCurrentReadonly()`, opens that Run only when it already exists, reads canonical Stage reports in registry order plus attempt reports, and never writes. `clean` calls `buildCleanupPlan()` and `executeCleanupPlan()` and prints removed IDs.

```ts
export interface PipelineReport {
  projectId: string;
  current: CurrentPointer | null;
  stages: StageReport[];
  attempts: StageReport[];
}
```

- [ ] **Step 4: Register the exact CLI contract**

Register:

```text
videoctl doctor <project> [--json]
videoctl ingest <project> [--json]
videoctl run <project> --to narration [--json]
videoctl compile <project> [--json]
videoctl pipeline <project> [--preset assets|draft|release] [--plan] [--from <stage>] [--to <stage>] [--resume] [--force <stage>] [--json]
videoctl review <project> --approve|--reject --reason <text>
videoctl release <project> [--json]
videoctl report <project> [--json]
videoctl clean <project>
```

Remove the source-meter implementation now moved to `source-assets.ts`. `videoctl.ts` should contain command registration and dependency assembly, not traversal or orchestration algorithms.

- [ ] **Step 5: Add shared output formatting**

Export deterministic formatters:

```ts
export const formatExecutionPlan = (plan: ExecutionPlan, json: boolean): string;
export const formatPipelineResult = (result: PipelineRunResult, json: boolean): string;
export const formatPipelineFailure = (failure: PipelineRuntimeError, json: boolean): string;
export const formatPipelineReport = (report: PipelineReport, json: boolean): string;
export const formatCleanupResult = (result: CleanupResult, json: boolean): string;
```

Sanitize terminal control characters in text mode and preserve JSON string semantics. Plan text must show `1/N`, stable Stage ID, display name, action, and materialization source when present.

- [ ] **Step 6: Preserve doctor-specific output through the shared plan**

The Preflight-only Runner result exposes the in-memory Preflight outputs. `doctor` passes those outputs to the existing doctor formatters, so its current table and JSON contract remain stable while using the shared plan builder and Stage adapter.

- [ ] **Step 7: Verify all CLI tests**

Run:

```bash
pnpm test tests/unit/cli/doctor.test.ts tests/unit/cli/review.test.ts tests/unit/cli/pipeline.test.ts tests/unit/cli/report.test.ts tests/unit/cli/clean.test.ts
pnpm typecheck
```

Expected: PASS; every convenience command calls the same plan builder and Runner.

- [ ] **Step 8: Commit Task 10**

```bash
git add src/cli src/pipeline/source-assets.ts tests/unit/cli
git commit -m "feat: expose the complete video workflow CLI"
```

---

### Task 11: Add the Demo Project and Full End-to-End Acceptance

**Files:**
- Create: `projects/demo/project.json`
- Create: `projects/demo/script.json`
- Create: `projects/demo/edit.json`
- Create: `projects/demo/assets/fonts/NotoSansSC-Bold.otf`
- Create: `projects/demo/assets/fonts/OFL.txt`
- Create: `tests/helpers/demo-project.ts`
- Create: `tests/integration/e2e/demo-pipeline.test.ts`
- Create: `tests/integration/e2e/cache-invalidation.test.ts`

- [ ] **Step 1: Add the authoring-only demo files**

`projects/demo/project.json`:

```json
{
  "version": 1,
  "id": "demo",
  "composition": {
    "width": 1920,
    "height": 1080,
    "fps": 30,
    "backgroundColor": "#101828",
    "allowBackgroundGaps": false
  },
  "tts": {"provider": "mock", "voice": "fixture", "rate": 180},
  "captions": {
    "font": "assets/fonts/NotoSansSC-Bold.otf",
    "fontSize": 54,
    "color": "#FFFFFF",
    "bottomMargin": 90,
    "maximumChineseCharacters": 28
  },
  "audio": {
    "sampleRate": 48000,
    "targetLufs": -16,
    "truePeakDb": -1.5,
    "backgroundMusicGainDb": -20,
    "duckDuringNarrationDb": -12,
    "duckAttackMs": 120,
    "duckReleaseMs": 250
  },
  "render": {
    "draftWidth": 960,
    "draftHeight": 540,
    "videoCodec": "h264",
    "pixelFormat": "yuv420p"
  }
}
```

`projects/demo/script.json`:

```json
{
  "version": 1,
  "language": "zh-CN",
  "segments": [
    {
      "id": "intro",
      "text": "本地流程开始。",
      "normalizedText": "本地流程开始。",
      "pauseAfterMs": 200,
      "requiredTerms": ["本地"],
      "notes": {"visualHint": "展示本地素材"}
    },
    {
      "id": "publish",
      "text": "审核通过后发布。",
      "normalizedText": "审核通过后发布。",
      "pauseAfterMs": 200,
      "requiredTerms": ["审核"],
      "notes": {"visualHint": "展示发布结果"}
    }
  ]
}
```

`projects/demo/edit.json`:

```json
{
  "version": 1,
  "visualClips": [
    {
      "id": "camera-a-clip",
      "kind": "video",
      "assetId": "camera-a",
      "startFrame": 0,
      "durationInFrames": 30,
      "sourceInMs": 0,
      "sourceOutMs": 1000,
      "fit": "cover",
      "position": {"x": 0, "y": 0},
      "scale": 1,
      "opacity": 1,
      "fadeInFrames": 0,
      "fadeOutFrames": 0,
      "zIndex": 0
    },
    {
      "id": "cover-clip",
      "kind": "image",
      "assetId": "cover",
      "startFrame": 30,
      "durationInFrames": 30,
      "fit": "contain",
      "position": {"x": 0, "y": 0},
      "scale": 1,
      "opacity": 1,
      "fadeInFrames": 0,
      "fadeOutFrames": 0,
      "zIndex": 0
    },
    {
      "id": "camera-b-clip",
      "kind": "video",
      "assetId": "camera-b",
      "startFrame": 60,
      "durationInFrames": 30,
      "sourceInMs": 0,
      "sourceOutMs": 1000,
      "fit": "cover",
      "position": {"x": 0, "y": 0},
      "scale": 1,
      "opacity": 1,
      "fadeInFrames": 0,
      "fadeOutFrames": 0,
      "zIndex": 0
    }
  ],
  "overlays": [
    {
      "id": "opening-title",
      "component": "basic-title",
      "startFrame": 5,
      "durationInFrames": 20,
      "props": {"text": "Agent Video MVP"},
      "zIndex": 10
    }
  ],
  "backgroundMusic": {"assetId": "music-main", "startMs": 0}
}
```

- [ ] **Step 2: Add the licensed font**

Run:

```bash
mkdir -p projects/demo/assets/fonts
curl -L --fail \
  'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Bold.otf' \
  -o projects/demo/assets/fonts/NotoSansSC-Bold.otf
curl -L --fail \
  'https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE' \
  -o projects/demo/assets/fonts/OFL.txt
shasum -a 256 projects/demo/assets/fonts/NotoSansSC-Bold.otf projects/demo/assets/fonts/OFL.txt
```

Record the two hashes in the Task 11 commit message body. Do not download any resource during rendering or tests.

- [ ] **Step 3: Implement deterministic demo fixture generation**

`copyDemoProject()` copies the three JSON files and font into a temporary workspace, then creates:

- `assets/source/camera-a.mp4`: one-second CFR H.264 test video;
- `assets/source/camera-b.mp4`: one-second CFR H.264 test video with different color/frequency;
- `assets/source/cover.png`: generated image;
- `assets/source/music-main.wav`: five-second 48 kHz BGM.

Use existing helpers from `tests/helpers/media-fixtures.ts`:

```ts
await Promise.all([
  createTestVideo(path.join(sourceRoot, 'camera-a.mp4'), 1, {includeAudio: true}),
  createTestVideo(path.join(sourceRoot, 'camera-b.mp4'), 1, {includeAudio: false}),
  createTestImage(path.join(sourceRoot, 'cover.png'), 'blue'),
  createTestMusic(path.join(sourceRoot, 'music-main.wav'), 5),
]);
```

Return source hashes captured before the pipeline runs.

- [ ] **Step 4: Write the full review-gated E2E test**

Use the real registry, plan builder, Runner, stores, FFmpeg, Remotion, Mock TTS, and CLI handlers.

```ts
it('plans, drafts, reviews, resumes, and publishes the demo', async () => {
  await expect(runCli(['pipeline', 'demo', '--preset', 'release', '--plan', '--json']))
    .resolves.toMatchObject({exitCode: 0});
  expect(await workArtifacts()).toEqual([]);

  expect((await runCli(['pipeline', 'demo', '--preset', 'assets', '--resume', '--json'])).exitCode).toBe(0);
  expect((await runCli(['pipeline', 'demo', '--preset', 'draft', '--resume', '--json'])).exitCode).toBe(0);
  expect((await runCli(['pipeline', 'demo', '--preset', 'release', '--resume', '--json'])).exitCode).toBe(2);
  expect((await runCli(['review', 'demo', '--approve', '--reason', 'acceptance review'])).exitCode).toBe(0);
  expect((await runCli(['pipeline', 'demo', '--preset', 'release', '--resume', '--json'])).exitCode).toBe(0);
});
```

Assert:

- Assets and Draft reports are reused, not re-executed.
- Review approval and Release share the same `runId`.
- Release references the exact Draft filter graph and normalized-audio hashes.
- `final.mp4` is 1920×1080, 30 fps, H.264, `yuv420p`, AAC, 48 kHz.
- Full decode succeeds and `moov` precedes `mdat`.
- `subtitles.srt`, `thumbnail.jpg`, `review.json`, `validation-report.json`, and `checksums.sha256` exist.
- Source hashes are unchanged.
- FFmpeg Step A and `qt-faststart` Step B retain the P05 scoped-FD contracts.

Set the test timeout to 180 seconds.

- [ ] **Step 5: Write the real cache invalidation E2E test**

Run a Draft, change only the second script segment, then run Draft again without `--resume` so a new Run is created. Assert Ingest is materialized, the first segment cache WAV is copied, only the second segment invokes Mock TTS, and Narration/Compile/Draft fingerprints change. Then run Release with `--resume`, approve, and verify it reuses the second Draft's audio artifacts unchanged.

- [ ] **Step 6: Run E2E tests**

Run:

```bash
pnpm test tests/integration/e2e/demo-pipeline.test.ts tests/integration/e2e/cache-invalidation.test.ts
pnpm typecheck
```

Expected: PASS on the target Apple Silicon Mac with the configured FFmpeg/`qt-faststart` pair and Remotion browser dependencies.

- [ ] **Step 7: Commit Task 11**

```bash
git add projects/demo tests/helpers/demo-project.ts tests/integration/e2e
FONT_SHA=$(shasum -a 256 projects/demo/assets/fonts/NotoSansSC-Bold.otf | awk '{print $1}')
LICENSE_SHA=$(shasum -a 256 projects/demo/assets/fonts/OFL.txt | awk '{print $1}')
git commit -m "test: prove the complete agent video workflow" -m "Noto font SHA-256: $FONT_SHA" -m "OFL SHA-256: $LICENSE_SHA"
```

---

### Task 12: Document, Reindex, and Run Final Acceptance

**Files:**
- Create: `AGENTS.md`
- Modify: `README.md`
- Verify: `docs/superpowers/specs/2026-08-10-agent-video-mvp-p06-closeout-design.md`
- Verify: `docs/superpowers/plans/2026-08-10-agent-video-mvp-p06-complete-closeout.md`
- Modify: `docs/superpowers/plans/2026-08-09-agent-video-mvp-project-index.md`
- Modify: `docs/superpowers/plans/2026-08-09-agent-video-mvp-06-workflow-productization.md`
- Verify: complete repository and target-Mac workflow

- [ ] **Step 1: Add workspace safety rules**

Create `AGENTS.md` with exactly:

```markdown
# Agent Video Workspace Rules

- Never modify files under `projects/*/assets/source`.
- Treat `project.json`, `script.json`, and `edit.json` as editable sources of truth.
- Treat manifests, compiled timelines, run reports, and media outputs as generated files.
- Use integer frames for timeline positions and milliseconds for source trims.
- Never interpolate project data into shell command strings.
- Run the relevant validator after every project edit.
- Render and approve a draft before Release.
- Never bypass schema, path, decode, or release verification failures.
- Keep render-time fonts and media local; do not fetch network resources.
```

- [ ] **Step 2: Replace the minimal README**

Document:

- Apple Silicon macOS 15+, Node 22.17, pnpm 10, FFmpeg, ffprobe, executable sibling `qt-faststart`, and Remotion browser prerequisites;
- installation and font/fixture setup;
- authoring-file roles and source filename-stem convention;
- seven Stage IDs and three Presets;
- `--plan`, `--from`, `--to`, `--resume`, `--force`, including the combined `--resume --force` rules;
- all CLI commands and exit codes;
- review approval flow;
- report and clean behavior;
- work/output current pointer resolution;
- two-step scoped-FD release publication;
- source video audio is muted in MVP;
- common error codes and recovery actions.

Every documented command must match Task 10 exactly.

- [ ] **Step 3: Update plan references**

Change the P06 row in the project index to point to `2026-08-10-agent-video-mvp-p06-complete-closeout.md`. Add this banner immediately below the old P06 title:

```markdown
> **Superseded:** Use [Agent Video MVP P06 Complete Closeout Implementation Plan](2026-08-10-agent-video-mvp-p06-complete-closeout.md). This file is retained only for historical context.
```

- [ ] **Step 4: Run the complete repository verification**

Run:

```bash
pnpm test
pnpm typecheck
git diff --check
```

Expected: zero failed tests, only the intentional system TTS skip when `RUN_SYSTEM_TTS_TESTS` is not enabled, TypeScript exits 0, and no whitespace errors are reported.

- [ ] **Step 5: Run the target-Mac smoke workflow**

Run:

```bash
pnpm video doctor demo --json
pnpm video pipeline demo --preset release --plan --json
pnpm video pipeline demo --preset assets --resume --json
pnpm video pipeline demo --preset draft --resume --json
pnpm video pipeline demo --preset release --resume --json
pnpm video review demo --approve --reason "acceptance review"
pnpm video pipeline demo --preset release --resume --json
pnpm video report demo --json
```

Expected:

- Doctor reports both binary real paths/hashes and the environment fingerprint.
- Plan mode performs no writes or subprocesses.
- Assets and Draft work are reused.
- The first Release stops at Review with exit 2.
- Approval preserves `runId`.
- Resumed Release publishes a fully decodable current output.
- Report lists stable Stage IDs with the correct selected `position/total` values.

- [ ] **Step 6: Verify cleanup against protected pointers**

Create one unreferenced failed Run and one unpublished Release fixture, then run:

```bash
pnpm video clean demo
pnpm video report demo --json
```

Expected: only the fixtures are removed; the current Run and Release remain readable and unchanged.

- [ ] **Step 7: Record the final handoff**

Run:

```bash
git status --short
git log --oneline --decorate --max-count=24
```

Expected: P01-P06 commit groups are present in dependency order, no generated `.work` or `output` artifacts are staged, and README commands match the CLI.

- [ ] **Step 8: Commit Task 12**

```bash
git add AGENTS.md README.md docs/superpowers/specs/2026-08-10-agent-video-mvp-p06-closeout-design.md docs/superpowers/plans/2026-08-10-agent-video-mvp-p06-complete-closeout.md docs/superpowers/plans/2026-08-09-agent-video-mvp-project-index.md docs/superpowers/plans/2026-08-09-agent-video-mvp-06-workflow-productization.md
git commit -m "docs: complete the agent video product handoff"
```

---

## Final Acceptance Checklist

- [ ] Existing P01-P05 tests remain green.
- [ ] Source discovery uses scoped handles, rejects symlinks, and resolves every EDL asset uniquely.
- [ ] Canonical `StageId` and `PipelinePreset` types are not duplicated.
- [ ] Registry IDs are unique and Presets are contiguous.
- [ ] `--plan` performs no writes, locks, directory creation, or subprocesses.
- [ ] Missing prerequisites and invalid ranges fail before execution.
- [ ] Same-Run resume never overwrites immutable artifacts.
- [ ] `--resume --force` follows both documented branches.
- [ ] New-Run cached Stages copy only listed artifacts and verify every hash.
- [ ] Changing one script segment reuses every unchanged segment cache WAV.
- [ ] Draft fingerprint includes `targetLufs`, `truePeakDb`, and every frozen audio-mix input.
- [ ] Release reuses Draft filter-graph and mixed-audio hashes without rewriting them.
- [ ] Review approval preserves `runId` and gates Release.
- [ ] `SIGINT` exits 130; `SIGTERM` exits 143; both release locks and preserve pointers.
- [ ] `ENOSPC` maps to `DISK_SPACE_EXHAUSTED` at every tested durable write boundary.
- [ ] Cleanup is idempotent and never deletes source, current Run, or current Release data.
- [ ] All convenience commands use the same plan builder and Runner.
- [ ] Final output matches the fixed profile, fully decodes, and has `moov` before `mdat`.
- [ ] Required evidence and checksum files exist under the current Release.
- [ ] Source hashes are unchanged before and after the full workflow.
- [ ] README and `AGENTS.md` match implemented behavior.
- [ ] `pnpm test`, `pnpm typecheck`, and `git diff --check` pass.

## Execution Handoff

Execute this plan in an isolated worktree created with `superpowers:using-git-worktrees`. Use one of:

1. **Subagent-Driven (recommended):** invoke `superpowers:subagent-driven-development`, use a fresh worker for each Task, and perform specification plus quality review between Tasks.
2. **Inline Execution:** invoke `superpowers:executing-plans`, execute in small batches, and stop at the verification gate after each Task.
