# Agent Video MVP P06 Complete Closeout Design

**Status:** Approved

**Date:** 2026-08-10

**Goal:** Complete the remaining Agent Video MVP work in one full-scope delivery, including orchestration, resumability, signal handling, runtime disk failures, safe cleanup, the complete CLI, deterministic demo fixtures, and all end-to-end acceptance evidence.

**Decision:** Keep the P06 product scope intact, but replace the original two oversized implementation tasks with six sequential milestones and explicit verification gates.

---

## 1. Current Baseline

P01 through P05 are implemented on `codex/agent-video-mvp` through commit `d29a93f`. The repository baseline is clean and currently passes:

- 38 test files passed and 1 skipped.
- 451 tests passed and 1 skipped.
- `pnpm typecheck` exits successfully.
- `git diff --check` exits successfully.

The remaining unimplemented scope is P06. None of the planned registry, Execution Plan, Runner, pipeline/report/clean commands, demo project, or E2E files exist yet.

The existing P06 behavior remains authoritative. This design changes decomposition, ownership boundaries, and implementation order; it does not reduce acceptance scope.

## 2. Goals

1. Register all seven existing concrete Stages behind one stable orchestration contract.
2. Discover the source assets referenced by the EDL through the existing scoped-FD security model without introducing an authored asset catalog.
3. Build Presets and read-only Execution Plans from one ordered registry.
4. Execute, cache, resume, force, and review-gate plans through one Runner.
5. Reuse verified prior-Run artifacts through bounded scoped copies rather than a general artifact store.
6. Handle `SIGINT`, `SIGTERM`, subprocess cancellation, `ENOSPC`, and cleanup without corrupting current pointers.
7. Expose all supported commands through one CLI planning path.
8. Prove the complete workflow and all MVP acceptance criteria with deterministic tests and a target-Mac smoke run.
9. Preserve all P01-P05 security, path-authority, media, and publication guarantees.

## 3. Non-Goals

- No general DAG engine.
- No JSON or YAML workflow definitions.
- No condition expression language.
- No remote media, remote fonts, or network resources at render time.
- No alternate orchestration path for convenience CLI commands.
- No rewrite of existing Stage business logic.
- No move or duplication of the frozen `StageId`, `PipelinePreset`, or `CurrentPointer` contracts.
- No relaxation of scoped filesystem authority or the two-step FFmpeg/`qt-faststart` release flow.

## 4. Considered Approaches

### 4.1 Keep the Original Two P06 Tasks

This minimizes planning changes but combines registry contracts, planning, execution, signals, disk failure, cleanup, CLI behavior, fixtures, and E2E verification into two large change sets. Failures would be difficult to isolate, and the Runner would likely accumulate responsibilities before its contracts were proven.

### 4.2 Layered Complete Closeout

This is the selected approach. P06 remains one complete delivery, but implementation proceeds through six milestones. Each milestone has a focused write set and verification gate. Later work may depend on earlier contracts but may not bypass their tests.

### 4.3 Implement One CLI Command at a Time

Vertical command slices would create early demonstrations, but they encourage duplicated planning, locking, reporting, cleanup, and error mapping. That conflicts with the requirement that every convenience command use the same registry, plan builder, and Runner.

## 5. Architecture Principles

### 5.1 One Registry

The ordered Stage registry is the only source of orchestration order. Stable Stage identity remains:

1. `preflight`
2. `ingest`
3. `narration`
4. `compile`
5. `draft`
6. `review`
7. `release`

Sequence numbers are presentation-only values calculated for the selected Execution Plan. They are never persisted as identity.

### 5.2 Preserve Canonical Frozen Types

`StageId`, `PipelinePreset`, `CurrentPointer`, and pointer validation already exist in `src/fs/app-directory-scopes.ts` and are re-exported by `src/pipeline/run-store.ts`. P06 must import these types rather than defining a second union in `src/pipeline/stage.ts`.

This prevents type drift between the orchestration layer and the pointer store.

### 5.3 Thin Stage Adapters

Existing Stage functions remain independently callable and retain their existing media logic. Each registered Stage uses a thin adapter that:

- reads the Stage-specific inputs from the orchestration context;
- computes a deterministic fingerprint from frozen inputs and prerequisite artifacts;
- invokes the existing Stage function;
- normalizes the result into the common Stage execution result;
- records artifact references without copying or re-owning downstream artifacts.

The adapter layer may translate shapes but must not duplicate ingest, narration, compile, draft, review, or release behavior.

### 5.4 One Plan Builder

Presets, ranges, force selection, cache state, resume state, and convenience commands all become a single `ExecutionPlanRequest`. Only `buildExecutionPlan()` may convert that request into an ordered plan.

### 5.5 One Runner

The Runner consumes an already validated `ExecutionPlan`. It has no Preset-specific or CLI-command-specific branches. It owns execution lifecycle concerns; Stage adapters own Stage behavior.

The plan is advisory until execution-time revalidation. After acquiring the project lock and before reusing any `cached` or `resume` item, the Runner recomputes the Stage fingerprint and revalidates every referenced artifact. A mismatch in a new-Run plan upgrades that Stage and all selected downstream Stages to `run`. A mismatch in a same-Run resume plan returns `PLAN_STALE` before new artifacts are written so the CLI can rebuild the plan once; it never overwrites immutable artifacts in the existing Run.

### 5.6 Shared Failure Lifecycle

Cancellation, disk exhaustion, failed Run cleanup, unpublished Release cleanup, pointer preservation, and lock release use one internal failure lifecycle. The `clean` command reuses the same cleanup inventory and deletion primitives instead of implementing an independent deletion path.

### 5.7 Bounded Cross-Run Materialization

P06 does not add a content-addressed artifact store. When a new Run must reuse a verified completed Stage from the current Run, the Runner copies only the artifact paths listed in that Stage report from the source `RunDirectoryScope` into the new `RunDirectoryScope`, verifies the copied hashes, and writes a new report recording the source `runId` as provenance.

Narration has one additional bounded reuse path: when its Stage fingerprint changes because only some script segments changed, the Narration adapter may seed matching `audio/cache/<segment-input-hash>.wav` files from the previous Run before executing the existing Narration Stage. It must not copy a cache file whose segment input hash is absent from the new script.

## 6. File and Responsibility Map

### 6.1 Pipeline Contracts and Planning

- `src/pipeline/stage.ts`: common Stage adapter contract, execution context, normalized result, report metadata, and action types. Imports canonical `StageId` and `PipelinePreset`.
- `src/pipeline/source-assets.ts`: safe recursive source inventory, EDL asset resolution, source byte totals, and source hashes using fresh scoped handles.
- `src/pipeline/artifacts.ts`: Run/Output artifact hashing, verification, and bounded Run-to-Run copies.
- `src/pipeline/narration-cache.ts`: seed only matching segment-cache WAVs from the previous Run.
- `src/pipeline/stage-registry.ts`: ordered Stage registrations and startup validation.
- `src/pipeline/presets.ts`: the three built-in contiguous Presets.
- `src/pipeline/execution-plan.ts`: plan request validation, range selection, prerequisite validation, fingerprints, cache/resume/force action selection, and presentation numbering.
- `src/pipeline/stage-adapters.ts`: thin adapters around the seven existing Stage functions. If this file exceeds a focused review size during implementation, split it into `src/pipeline/stage-adapters/<stage>.ts` without changing the public contract.

### 6.2 Execution and Reliability

- `src/pipeline/runner.ts`: lock acquisition, Run selection, Stage execution, durable reports, work pointer updates, review stop/resume, and final lock release.
- `src/pipeline/runtime-errors.ts`: normalization of cancellation, signal, process, validation, environment, and `ENOSPC` failures into stable pipeline failures and exit categories.
- `src/pipeline/cleanup.ts`: read-only cleanup inventory plus authority-scoped execution of approved deletions.
- Existing `src/pipeline/project-lock.ts`, `src/pipeline/run-store.ts`, and `src/fs/app-directory-scopes.ts`: remain the authority for locks, opaque directory scopes, atomic pointers, and fault-injectable pointer writes.

### 6.3 CLI

- `src/cli/commands/pipeline.ts`: translate command options into one `ExecutionPlanRequest`, print plan or run it, and return stable exit codes.
- `src/cli/commands/report.ts`: read and display the current Run and its Stage reports without mutating state.
- `src/cli/commands/clean.ts`: inventory and safely remove only unreferenced artifacts through `src/pipeline/cleanup.ts`.
- `src/cli/videoctl.ts`: register commands and shared dependencies; it must not contain a second orchestration implementation.
- `src/cli/output.ts`: add common text and JSON formatting for plans, reports, and failures.
- `src/cli/exit-codes.ts`: retain current codes and map the complete failure model without changing `SIGINT` code 130.

### 6.4 Product Evidence

- `AGENTS.md`: project workspace safety rules.
- `README.md`: prerequisites, commands, Stage/Preset semantics, review flow, cleanup rules, output resolution, and troubleshooting.
- `projects/demo/`: small authoring JSON plus licensed font files; large source media is generated during tests.
- `tests/unit/pipeline/`: registry, plan, Runner, failure normalization, and cleanup tests.
- `tests/integration/pipeline/`: side-effect-free planning, reuse, resume, real signals, disk exhaustion, and cleanup tests.
- `tests/integration/e2e/`: full workflow and cache invalidation acceptance tests.

## 7. Common Stage Contract

The contract distinguishes planning from execution:

- Planning receives read-only project inputs, previously persisted reports, current pointer data, and read-only environment/provider information.
- Execution additionally receives the opaque scopes required for the selected Stage, a Run identity where applicable, an `AbortSignal`, and injectable runtime dependencies.

Every registered Stage provides:

- stable `id` and `displayName`;
- read-only fingerprint calculation;
- prerequisite Stage IDs;
- execution through the existing concrete Stage implementation;
- normalized outputs, checks, and provenance references.

The common result supports `passed`, `needs_review`, `failed`, and `cancelled`. `cached` and `resume` are plan/Runner actions, not Stage-produced business states.

## 7.1 Source Asset Resolution

P06 does not add another authored JSON catalog. It recursively inventories regular files under `assets/source` through the same held-directory and fresh-handle security model used by source-byte measurement. An EDL `assetId` resolves to the unique source file whose basename without its final extension equals that ID. Missing or duplicate matches, conflicting expected kinds, symlinks, special files, or changed directory identities fail before Ingest.

## 8. Execution Plan Semantics

### 8.1 Presets

- `assets`: `preflight`, `ingest`
- `draft`: `preflight`, `ingest`, `narration`, `compile`, `draft`
- `release`: `preflight`, `ingest`, `narration`, `compile`, `draft`, `review`, `release`

The default Preset is `release`.

### 8.2 Range Selection

`--from` and `--to` are inclusive. Both must reference Stages inside the selected Preset, and the resulting range must preserve registry order. Every omitted prerequisite before `--from` must have a trustworthy matching persisted artifact and fingerprint.

A range that omits prerequisites is bound to the current Run; it may resume or no-op but may not create a new Run with invisible prerequisite copies. If an omitted prerequisite changed, planning fails and instructs the caller to widen `--from` to the first invalid Stage or remove the bound.

When a selected range omits Preflight, plan mode records that runtime Preflight revalidation is required without starting a subprocess. Before executable work, the Runner invokes the Preflight adapter as an unnumbered prerequisite Gate and compares the actual fingerprint with the persisted prerequisite report. The visible plan remains the requested continuous range.

### 8.3 Actions

Each selected item has one action:

- `run`: no trustworthy reusable result exists or force invalidation applies.
- `cached`: a completed Stage result with a matching fingerprint can be reused. When the target is a new Run, the listed Run artifacts are materialized through verified scoped copies before the new passed report is written.
- `resume`: the current resumable Run has a valid completed prefix and execution should continue at the first incomplete Stage using the same `runId`.

`--force <stage>` changes that Stage and every selected downstream Stage to `run`. It does not invalidate preceding reusable Stages.

### 8.4 Side-Effect-Free Plan Mode

Plan building may read authoring inputs, existing reports, pointers, artifact metadata, and already persisted fingerprints. It must not:

- create Work or Run directories;
- acquire a write lock;
- write reports or pointers;
- invoke FFmpeg, ffprobe, `qt-faststart`, TTS, or Remotion;
- perform environment or Provider probes that have side effects.

If a required fingerprint cannot be trusted from persisted information, the action is `run`.

## 9. Runner State Machine

### 9.1 Initial Run

1. Load and validate the project through the existing project loader.
2. Build the Execution Plan before acquiring a write lock.
3. If `--plan` is present, print the plan and exit.
4. Acquire the project lock for executable plans.
5. Revalidate planned reusable results against the now-locked state; upgrade stale new-Run items or rebuild one stale same-Run plan as defined above.
6. Run Preflight before creating a new Run.
7. After successful Preflight, create the new immutable Run and persist the Preflight report.
8. Execute remaining selected items in order.

### 9.2 Durable Progress

After every materialized `passed` Stage through Review, publish the work `current.json` with:

- the `runId`;
- the selected Preset;
- a snapshot of selected stable Stage IDs;
- the last completed Stage;
- state `passed`;
- the durable publication timestamp.

When Review returns `needs_review`, write the Review report and publish the same pointer with state `needs_review`. The Runner stops with exit code 2.

Failed and cancelled states are recorded in Run-local reports but are not published as pointer states. The last durable pointer remains authoritative.

Release uses the output `current.json` as its publication commit point. The Runner writes the canonical Release report before publishing the Output pointer. If Output publication fails, it removes the uncommitted Release report and leaves the previous Work and Output pointers unchanged; the unpublished Release directory is eligible for cleanup. After Output publication succeeds, updating the Work pointer to `completedStage: release` is best-effort progress metadata. A failure of that later Work update does not roll back or fail an already verified published Release; `report` must reconcile the Release report with the Output pointer.

### 9.3 Resume

`--resume` may reuse the current `runId` only when:

- the selected Stage sequence is compatible with the persisted snapshot;
- completed Stage fingerprints still match;
- all referenced artifacts exist under the correct opaque scope;
- Review approval, when required, belongs to the same project and `runId`.

The approved Review resumes Release without changing `runId`.

If `--force <stage>` targets a Stage that is already complete in the current Run, execution creates a new Run, materializes every preceding matching Stage, and runs the forced Stage plus all downstream Stages. If the forced Stage is the first incomplete Stage, the current Run may resume normally. Therefore `--resume --force compile` reuses the current Run only when Compile has not yet materialized; otherwise it creates a new Run while reusing verified Preflight/Ingest/Narration evidence and artifacts.

### 9.4 Cross-Preset Reuse

Moving from `draft` to `release` may reuse matching Preflight through Draft artifacts. Release consumes the Draft filter graph and normalized mixed-audio hashes as inputs/provenance. Release must not rewrite them or claim them as Release outputs.

## 10. Signal and Cancellation Semantics

The executable CLI creates one `AbortController` per invocation. `SIGINT` and `SIGTERM` abort that controller.

On abort:

1. Stop scheduling new Stages.
2. Signal the current Stage and its child process group through existing process APIs.
3. Wait for child termination.
4. Persist a cancelled Run-local diagnostic report when the Run exists.
5. Remove only failed Run-local intermediates and unpublished Release artifacts.
6. Preserve both work and output current pointers at their last durable values.
7. Release the project lock in `finally`.

`SIGINT` exits 130. `SIGTERM` exits 143. Both use the normalized cancelled category while preserving identical cleanup, pointer, and lock guarantees.

Integration tests use a real child CLI process and real signals rather than calling signal handlers directly.

## 11. Runtime Disk Exhaustion

The runtime write boundary is injectable. Tests may fail a selected write after a configured byte count or operation number with `ENOSPC`.

`ENOSPC` is normalized to `DISK_SPACE_EXHAUSTED`. The Runner then:

- marks the current Stage failed in the Run-local diagnostic record when possible;
- removes temporary pointer files;
- removes incomplete Run-local Stage outputs through `RunDirectoryScope`;
- removes incomplete unpublished Release outputs through `OutputDirectoryScope`;
- preserves previous current pointers;
- releases the lock.

The fault matrix covers at least Stage report writes, work pointer publication, Release file writes, and output pointer publication. If diagnostic persistence itself fails because the disk remains full, the original disk-exhaustion error remains primary.

## 12. Cleanup Model

Cleanup is split into two operations:

1. Build a read-only inventory of eligible paths and protected references.
2. Execute that inventory through the appropriate opaque authority.

Protected content includes:

- every project source asset;
- the Run referenced by work `current.json`;
- the Release referenced by output `current.json`;
- any path that cannot be proven to be under the fixed Work or Output prefix;
- any symlink or substituted directory entry rejected by existing scope validation.

Eligible content includes:

- failed Runs not referenced by the work pointer;
- abandoned Run-local temporary/intermediate files;
- unpublished Release directories not referenced by the output pointer;
- stale temporary pointer files after existing rollback rules have been applied.

Cleanup is idempotent. A path disappearing between inventory and deletion is treated as already cleaned; identity or authority changes fail closed.

## 13. CLI Model

The supported commands remain:

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

Convenience commands translate into the same Execution Plan request:

- `doctor`: Preflight plan ending at `preflight`.
- `ingest`: Assets plan ending at `ingest`.
- `run --to narration`: Draft plan ending at `narration`.
- `compile`: Draft plan ending at `compile`.
- `release`: Release Preset.

`review` remains an explicit mutation of the current review-gated Run. `report` is read-only. `clean` uses the shared cleanup model.

The existing MVP implementation supports approval only. The CLI may parse `--reject` for contract compatibility, but rejection must fail with a stable validation message unless a versioned rejection behavior is added to the product specification.

## 14. Milestones and Verification Gates

### M1: Stage Contracts and Registry

Deliver:

- common Stage adapter contract;
- thin adapters for all seven existing Stages;
- unique ordered registry;
- contiguous Presets.

Gate:

- registry and Preset unit tests pass;
- fake ordinary Stage can be registered without changing Runner or pointer protocols;
- all existing tests and type checking remain green.

### M2: Read-Only Execution Plan

Deliver:

- one plan request and builder;
- inclusive ranges;
- prerequisite validation;
- fingerprint-based `run`, `cached`, and `resume` actions;
- force propagation;
- side-effect-free plan output.

Gate:

- full, prefix, sliced, forced, cached, and resumable plans pass;
- missing prerequisite and reversed-range cases fail with stable codes;
- plan mode creates no directories, locks, pointers, or subprocesses.

### M3: Runner and Resume State Machine

Deliver:

- lock and Run lifecycle;
- Stage execution and reporting;
- durable pointer publication;
- review stop and same-Run resume;
- cross-Preset reuse.

Gate:

- unchanged rerun is cached;
- changed narration segment invalidates Narration and downstream Stages;
- changing any frozen Draft audio input invalidates Draft and Release;
- `--force compile` reuses preceding Stages and reruns Compile through Release;
- approval resumes the same `runId`.

### M4: Signals, Disk Failure, and Cleanup

Deliver:

- signal-to-abort wiring;
- process-group shutdown and exit mapping;
- fault-injectable runtime writes;
- `ENOSPC` normalization;
- shared cleanup inventory and executor.

Gate:

- real `SIGINT` and `SIGTERM` tests release locks;
- `SIGINT` exits 130;
- disk fault matrix preserves previous pointers;
- cleanup never removes current or source content;
- cleanup is idempotent and fails closed on authority changes.

### M5: Complete CLI and Reporting

Deliver:

- pipeline and convenience commands through one plan builder;
- report and clean commands;
- shared JSON/text formatting;
- stable argument and failure handling.

Gate:

- every command maps to the intended Stage selection;
- no command contains a second Runner path;
- invalid Presets, Stage IDs, ranges, and prerequisites fail consistently;
- README command examples are executable.

### M6: Demo, E2E, and Final Acceptance

Deliver:

- workspace safety rules;
- authoring-only demo project and licensed font;
- generated local source fixtures and deterministic Mock TTS;
- complete workflow and cache-invalidation E2E tests;
- final documentation and target-Mac smoke instructions.

Gate:

- all repository tests and type checking pass;
- the complete review-gated release workflow succeeds;
- final media matches the fixed profile and fully decodes;
- `moov` precedes `mdat`;
- required release evidence files exist;
- source hashes remain unchanged;
- all nineteen MVP acceptance criteria are demonstrated.

## 15. Test Strategy

### 15.1 Unit Tests

- registry uniqueness and Preset contiguity;
- plan validation and action selection;
- Runner state transitions using fake deterministic Stages;
- error normalization and exit mapping;
- cleanup eligibility and protection rules.

### 15.2 Integration Tests

- plan side effects;
- real Run Store and pointer behavior;
- cache and cross-Preset reuse;
- review stop and resume;
- real CLI signals and lock release;
- injected disk exhaustion at each durable write boundary;
- cleanup against real scoped directories.

### 15.3 End-to-End Tests

The primary E2E sequence is:

1. Build a Release plan and prove no writes or subprocesses.
2. Run the Assets Preset.
3. Run the Draft Preset and reuse matching Assets work.
4. Run the Release Preset and stop at Review.
5. Approve the same `runId`.
6. Resume Release and publish the verified output.
7. Inspect media profile, full decode, atom ordering, checksums, evidence, reports, and source hashes.

The cache E2E sequence changes only one script segment and proves segment-level audio reuse plus correct downstream invalidation.

## 16. Final Verification

Repository verification:

```bash
pnpm test
pnpm typecheck
git diff --check
```

Target-Mac workflow verification:

```bash
pnpm video doctor demo --json
pnpm video pipeline demo --preset release --plan --json
pnpm video pipeline demo --preset assets --resume --json
pnpm video pipeline demo --preset draft --resume --json
pnpm video pipeline demo --preset release --resume --json
pnpm video review demo --approve --reason "acceptance review"
pnpm video pipeline demo --preset release --resume --json
```

The delivery is complete only when both verification groups pass and no generated Work or Output artifact is staged.

## 17. Risks and Mitigations

### Contract Duplication

Risk: defining a new Stage ID union would drift from pointer validation.

Mitigation: import the frozen types from the existing Run Store exports.

### Runner Becoming a Business-Layer God Object

Risk: media decisions leak into orchestration.

Mitigation: adapters translate context; existing Stage functions retain business behavior; Runner handles lifecycle only.

### Plan Mode Accidentally Probing or Writing

Risk: fingerprint calculation invokes tools or creates state.

Mitigation: persisted identities are used when available; uncertain identities force `run`; integration tests deny writes and subprocesses.

### Cancellation Races

Risk: signal cleanup races with a child process or pointer publication.

Mitigation: abort first, await child termination, then clean, preserve durable pointers, and release the lock in `finally`.

### Disk Full During Error Reporting

Risk: the diagnostic write also fails.

Mitigation: preserve the first `ENOSPC` as the primary failure, attempt best-effort diagnostics, and never advance current pointers.

### Cleanup Deleting Valid Data

Risk: stale inventory or path substitution targets protected data.

Mitigation: inventory protected pointers first, execute only through opaque scopes, revalidate authority at deletion time, and fail closed.

## 18. Supersession and Handoff

This design supersedes the task grouping in `docs/superpowers/plans/2026-08-09-agent-video-mvp-06-workflow-productization.md`. The original product behavior and acceptance checklist remain inputs to the replacement implementation plan.

After written design approval, create a replacement implementation plan with one task group per milestone, exact file changes, test-first steps, commands, expected failures, expected passes, and final acceptance execution.
