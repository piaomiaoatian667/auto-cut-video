# Agent Video MVP P06 Workflow and Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Productize the independently working Stages through a typed registry, built-in Presets, side-effect-free Execution Plan, resumable Runner, complete CLI, demo project, and end-to-end acceptance suite.

**Architecture:** P06 contains orchestration but no duplicated media business logic. Stable Stage IDs and ordered registration generate Presets and numbered plans; Runner consumes a validated plan, persists per-stage fingerprints and audit metadata, and the demo proves the complete review-gated release workflow.

**Tech Stack:** TypeScript, Commander, Vitest, Node signal/filesystem APIs, all previously integrated media dependencies.

---

## Project Contract

- **Project ID:** P06
- **Specification:** `../specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- **Project Index:** `2026-08-09-agent-video-mvp-project-index.md`
- **Master Tasks:** 15–16
- **Depends On:** P02 and P05 completed and merged, which transitively requires P01, P03, and P04.
- **Primary Write Set:** Stage contract/registry, Presets, Execution Plan, Runner, pipeline/report/clean CLI commands, demo project, README/AGENTS, and full workflow/E2E tests.
- **Must Not Do:** Reimplement Stage business logic, add JSON/YAML Workflow definitions, add a condition DSL, add a general DAG, or change frozen artifact formats without a versioned amendment.
- **Exit Artifact:** Complete local `videoctl` product demonstrating all nineteen MVP acceptance criteria.

## Entry Criteria

- P01–P05 exit verification passes and their commits are present in dependency order.
- Every concrete Stage can be invoked and tested independently before it is registered.
- The target Mac satisfies P02 Preflight and has the licensed demo font available through the Task 16 setup.

---
## Task 15: Wire the Stage Registry, Presets, Execution Plan, Runner, Signals, and CLI

**Files:**
- Create: `src/pipeline/stage.ts`
- Create: `src/pipeline/stage-registry.ts`
- Create: `src/pipeline/presets.ts`
- Create: `src/pipeline/execution-plan.ts`
- Create: `src/pipeline/runner.ts`
- Modify: `src/cli/videoctl.ts`
- Create: `src/cli/commands/pipeline.ts`
- Create: `src/cli/commands/report.ts`
- Create: `src/cli/commands/clean.ts`
- Test: `tests/unit/pipeline/stage-registry.test.ts`
- Test: `tests/unit/pipeline/execution-plan.test.ts`
- Test: `tests/unit/pipeline/runner.test.ts`
- Test: `tests/integration/pipeline/plan-side-effects.test.ts`
- Test: `tests/integration/pipeline/preset-reuse.test.ts`
- Test: `tests/integration/pipeline/resume.test.ts`
- Test: `tests/integration/pipeline/signals.test.ts`
- Test: `tests/integration/pipeline/disk-exhaustion.test.ts`

- [ ] **Step 1: Write Stage registry and Preset tests**

Verify all Stage IDs are unique, every Preset references only registered IDs, every Preset is ordered and contiguous within `MVP_STAGES`, and the three built-in Presets contain exactly:

```ts
expect(STAGE_PRESETS).toEqual({
  assets: ['preflight', 'ingest'],
  draft: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
  release: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
});
```

- [ ] **Step 2: Implement stable Stage contracts, registry, and Presets**

`src/pipeline/stage.ts`:

```ts
export type StageId =
  | 'preflight'
  | 'ingest'
  | 'narration'
  | 'compile'
  | 'draft'
  | 'review'
  | 'release';

export type PipelinePreset = 'assets' | 'draft' | 'release';

export interface PipelineStage {
  id: StageId;
  displayName: string;
  fingerprint(context: PipelineContext): Promise<string>;
  run(context: PipelineContext, signal: AbortSignal): Promise<StageReport>;
}
```

`src/pipeline/stage-registry.ts` exports the ordered `MVP_STAGES` array. `src/pipeline/presets.ts` exports `STAGE_PRESETS` with `as const satisfies Record<PipelinePreset, readonly StageId[]>`. Registration validates IDs once at startup. Sequence numbers are derived only when building a plan and are never persisted as identity.

```ts
export const MVP_STAGES: readonly PipelineStage[] = [
  preflightStage,
  ingestStage,
  narrationStage,
  compileStage,
  draftStage,
  reviewStage,
  releaseStage,
];

export const STAGE_PRESETS = {
  assets: ['preflight', 'ingest'],
  draft: ['preflight', 'ingest', 'narration', 'compile', 'draft'],
  release: ['preflight', 'ingest', 'narration', 'compile', 'draft', 'review', 'release'],
} as const satisfies Record<PipelinePreset, readonly StageId[]>;
```

- [ ] **Step 3: Build and test the read-only Execution Plan**

```ts
export interface ExecutionPlanItem {
  position: number;
  total: number;
  stageId: StageId;
  displayName: string;
  action: 'run' | 'cached' | 'resume';
}

export interface ExecutionPlan {
  preset: PipelinePreset;
  stageIds: StageId[];
  items: ExecutionPlanItem[];
}
```

`buildExecutionPlan()` must:

1. Default to the `release` Preset when `--preset` is omitted.
2. Validate the Preset against the Stage registry.
3. Apply inclusive `--from` and `--to` bounds and reject reversed or unknown ranges.
4. Require fingerprint-matching artifacts for every omitted prerequisite before `--from`.
5. Calculate each selected Stage fingerprint and action using read-only operations only. If a trustworthy environment or Provider fingerprint is unavailable without probing, mark the Stage as `run`.
6. Apply `--force <stage>` to that Stage and all downstream registered Stages.
7. Number only the selected plan as `1/N`, `2/N`, and so on while retaining stable `StageId` values.

Tests must cover full, prefix, and sliced plans; cached and resume actions; forced invalidation; missing prerequisites; and insertion of a fake Stage without changing Runner code. `--plan` prints this object and exits without creating a Run, acquiring a write lock, writing a pointer, or starting a subprocess.

- [ ] **Step 4: Implement the Execution Plan Runner and resume behavior**

Use fake stages with deterministic fingerprints. Verify an unchanged second run reports `cached`, changing one narration segment invalidates Narration and every downstream Stage, switching from `draft` to `release` reuses matching shared Stage artifacts, and `--force compile` reruns Compile through Release while reusing Preflight, Ingest, and Narration.

The Runner receives an already validated `ExecutionPlan` and has no Preset-specific branches. It acquires the project lock only for an executable plan and reads work `current.json`. With `--resume`, it continues the same `runId` while recorded fingerprints match; otherwise it creates a new Run only after successful Preflight. After every materialized `passed` Stage and when Review enters `needs_review`, update work `current.json` with `preset`, the selected `stageIds` snapshot, `completedStage`, and `state`. Reports include `preset`, stable Stage ID, `position`, and `total`. Stop on `failed` or `needs_review`, write reports after every Stage, and release the lock in `finally`.

- [ ] **Step 5: Implement signal behavior**

Create one `AbortController`, map `SIGINT` and `SIGTERM` to `abort()`, wait for child termination, remove temporary files owned by the current Run, preserve prior pointers, and return exit code 130 for SIGINT. Integration tests send real signals to a child CLI process and assert the lock is released.

- [ ] **Step 6: Implement runtime disk-exhaustion behavior**

Inject a write adapter that throws `ENOSPC` after a configured byte count. Map it to `DISK_SPACE_EXHAUSTED`, fail the current Run, remove temporary pointer files, preserve previous current pointers, and leave diagnostic reports in the failed Run directory.

- [ ] **Step 7: Complete CLI commands through one plan builder**

Support exactly:

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

The convenience commands `doctor`, `ingest`, `run`, `compile`, and `release` translate into the same Stage IDs and call the same Execution Plan builder; they must not contain a second orchestration path. Remove the obsolete `render --preset draft` command in favor of `pipeline --preset draft`. Reject unknown Presets, unknown Stage IDs, invalid ranges, and missing prerequisites with the specification error codes.

`clean` may remove failed and unreferenced work Runs only; it must never remove source assets, the Run referenced by work `current.json`, or the release referenced by output `current.json`.

- [ ] **Step 8: Verify and commit**

```bash
pnpm test tests/unit/pipeline/stage-registry.test.ts tests/unit/pipeline/execution-plan.test.ts tests/unit/pipeline/runner.test.ts
pnpm test tests/integration/pipeline/plan-side-effects.test.ts tests/integration/pipeline/preset-reuse.test.ts tests/integration/pipeline/resume.test.ts tests/integration/pipeline/signals.test.ts tests/integration/pipeline/disk-exhaustion.test.ts
pnpm typecheck
git add src/pipeline/stage.ts src/pipeline/stage-registry.ts src/pipeline/presets.ts src/pipeline/execution-plan.ts src/pipeline/runner.ts src/cli tests/unit/pipeline tests/integration/pipeline
git commit -m "feat: orchestrate typed resumable video workflows"
```


## Task 16: Add the Demo Project, Workspace Rules, and End-to-End Acceptance Test

**Files:**
- Create: `AGENTS.md`
- Modify: `README.md`
- Create: `projects/demo/project.json`
- Create: `projects/demo/script.json`
- Create: `projects/demo/edit.json`
- Create: `projects/demo/assets/fonts/NotoSansSC-Bold.otf`
- Create: `projects/demo/assets/fonts/OFL.txt`
- Create: `tests/integration/e2e/demo-pipeline.test.ts`
- Create: `tests/integration/e2e/cache-invalidation.test.ts`

- [ ] **Step 1: Add workspace safety rules**

`AGENTS.md` must state:

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

- [ ] **Step 2: Add a generated demo fixture setup**

Do not commit large media. Download the official Noto CJK Simplified Chinese Bold OTF and SIL Open Font License into the demo font directory, record their SHA-256 values in the commit description, and keep the font path used by `project.json` stable. The end-to-end test copies demo JSON and the licensed font into a temporary project, then calls media fixture helpers to generate three local clips, one image, one BGM, and deterministic Mock TTS WAVs.

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

- [ ] **Step 3: Write the full acceptance test**

The test first builds a `release` Execution Plan and proves plan mode creates no Run, pointer, lock, or subprocess. It then runs the `assets` Preset, the `draft` Preset, and the `release` Preset in sequence, proving shared Stage reports are reused. The first release attempt stops when Review returns `needs_review`; the test writes an approval for the same `runId`, resumes the `release` Preset, and asserts:

```ts
expect(finalProbe.width).toBe(1920);
expect(finalProbe.height).toBe(1080);
expect(finalProbe.fps).toBe(30);
expect(finalProbe.videoCodec).toBe('h264');
expect(finalProbe.pixelFormat).toBe('yuv420p');
expect(finalProbe.audioCodec).toBe('aac');
expect(finalProbe.audioSampleRate).toBe(48_000);
expect(await fullDecode(finalPath)).toEqual({ok: true});
expect(await sourceHashesAfter()).toEqual(await sourceHashesBefore());
```

It also verifies `subtitles.srt`, `thumbnail.jpg`, `review.json`, `validation-report.json`, and `checksums.sha256` exist under the release referenced by `output/<project>/current.json`. Stage reports must retain stable IDs while displaying the correct `position/total` for each selected Preset.

- [ ] **Step 4: Write cache invalidation acceptance test**

Run the `release` Preset twice, change only the second script segment, and assert the first segment WAV hash is reused, the second changes, and Narration plus all downstream Stages receive new fingerprints. Insert a fake registered Stage in the unit fixture and prove Runner behavior does not require modification.

- [ ] **Step 5: Document exact local usage**

`README.md` must include prerequisites, installation, fixture generation, the seven stable Stage IDs, built-in Presets, Execution Plan numbering, `--plan`/`--from`/`--to`/`--force`, authoring-file roles, commands, review workflow, output pointer resolution, common error codes, and the statement that source video audio is muted in MVP.

- [ ] **Step 6: Run the complete verification suite**

Run:

```bash
pnpm test
pnpm typecheck
pnpm video doctor demo --json
pnpm video pipeline demo --preset release --plan --json
pnpm video pipeline demo --preset assets --resume --json
pnpm video pipeline demo --preset draft --resume --json
pnpm video pipeline demo --preset release --resume --json
pnpm video review demo --approve --reason "acceptance review"
pnpm video pipeline demo --preset release --resume --json
```

Expected:

- All unit and integration tests pass.
- TypeScript exits 0.
- Doctor reports no errors on the target Mac.
- Plan mode reports numbered Stage IDs and performs no writes or subprocess calls.
- `assets`, `draft`, and `release` reuse all matching shared Stage artifacts.
- The first release run stops when Review returns `needs_review` before approval.
- The explicit review command succeeds, and the resumed `release` Preset publishes a new output pointer without changing `runId`.
- The current release fully decodes and matches the fixed media profile.

- [ ] **Step 7: Commit**

```bash
git add AGENTS.md README.md projects/demo tests/integration/e2e
git commit -m "test: add end-to-end agent video workflow"
```

Checkpoint C is complete when all nineteen MVP acceptance criteria in the specification are demonstrated by tests or the target-Mac smoke run.

## Final Verification Checklist

- [ ] `pnpm test` passes with zero failed tests.
- [ ] `pnpm typecheck` exits 0.
- [ ] Every JSON authoring file rejects unknown fields.
- [ ] Script display limits use the project setting and Unicode grapheme counting.
- [ ] Reversed and out-of-bounds Trim tests pass before rendering.
- [ ] Read paths, writable target symlinks, and atomic pointer symlink tests pass.
- [ ] Lock contention, stale lock, SIGINT, and SIGTERM tests pass.
- [ ] Preflight and runtime disk exhaustion remain distinct failures.
- [ ] Exact-frame and non-aligned caption boundary tests pass.
- [ ] Final Ducking release is clamped to Composition duration.
- [ ] A 100-interval audio Filter Graph executes from a Run-local script file.
- [ ] Narration concat succeeds from a project path containing spaces while retaining `-safe 1`.
- [ ] Remotion output contains no audio stream.
- [ ] Final mux copies H.264 video and encodes AAC audio only.
- [ ] Final MP4 passes full FFmpeg decode.
- [ ] Failed publication preserves previous work and release pointers.
- [ ] Changing one script segment reuses all unchanged segment audio.
- [ ] Stage registry IDs are unique and every Preset references a contiguous registered sequence.
- [ ] `--plan` is side-effect free and `--from` rejects missing prerequisite artifacts.
- [ ] Adding a fake ordinary Stage requires no Runner, lock, pointer, or report-protocol changes.
- [ ] Original source hashes remain unchanged.
- [ ] README commands match the implemented CLI.

## Project Exit Verification

- [ ] **Step 1: Run the complete repository verification**

```bash
pnpm test
pnpm typecheck
git diff --check
```

Expected: zero failed tests, TypeScript exits 0, and no whitespace errors are reported.

- [ ] **Step 2: Run the target-Mac workflow smoke sequence**

```bash
pnpm video doctor demo --json
pnpm video pipeline demo --preset release --plan --json
pnpm video pipeline demo --preset assets --resume --json
pnpm video pipeline demo --preset draft --resume --json
pnpm video pipeline demo --preset release --resume --json
pnpm video review demo --approve --reason "acceptance review"
pnpm video pipeline demo --preset release --resume --json
```

Expected: plan mode has no side effects; shared Stage artifacts are reused; the first release run stops at Review; approval preserves the Run ID; the resumed release publishes a fully decodable current output.

- [ ] **Step 3: Record the final cross-project handoff**

```bash
git status --short
git log --oneline --decorate --max-count=20
```

Expected: all six project commit groups are present, no generated `.work` or `output` artifacts are staged, and the README commands match the implemented CLI.
