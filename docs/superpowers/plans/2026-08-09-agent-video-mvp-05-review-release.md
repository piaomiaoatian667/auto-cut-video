# Agent Video MVP P05 Review and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate muted visual output and narration/audio output into a reviewable draft, explicit approval Gate, and atomically published verified release package.

**Architecture:** P05 consumes the frozen P03 visual and P04 audio contracts. Draft materializes the write-once filter graph and normalized mixed-audio artifacts while creating review evidence, Review records an explicit decision for the same Run, and Release uses a two-process scoped-FD publication flow: FFmpeg creates a write-once Run-local intermediate MP4 without `+faststart`, then the Preflight-verified `qt-faststart` binary creates the exclusive Output-scope final MP4 before validation and atomic pointer advancement.

**Tech Stack:** TypeScript, FFmpeg/ffprobe, `qt-faststart`, Remotion, Commander, Vitest.

---

## Project Contract

- **Project ID:** P05
- **Specification:** `../specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- **Project Index:** `2026-08-09-agent-video-mvp-project-index.md`
- **Master Tasks:** 13–14
- **Depends On:** P03 and P04 completed and merged.
- **Primary Write Set:** contact-sheet generation, Draft/Review/Release Stages, review CLI command, release verification, and integration tests.
- **Must Not Modify:** Frozen authoring/Manifest formats, TTS/visual business logic, Stage registry, Presets, Execution Plan, or Runner.
- **Exit Artifact:** Decodable review draft, Draft-owned `audio/filter-graph.txt` and `audio/mixed-normalized.wav` references, contact sheet/evidence, strict `review.json`, verified final release directory, checksums, and atomic output pointer.

## Entry Criteria

- P03 and P04 exit verification passes against the same P01/P02 contract versions.
- P02 Preflight has recorded an executable sibling `qt-faststart` real path, binary SHA-256, and environment fingerprint for the resolved FFmpeg toolchain.
- A fixture Run can provide muted final/draft video, narration master, caption data, BGM, and compiled timeline.
- Output publication tests begin with an existing successful pointer to prove rollback behavior.
- Project inputs, work pointers, Run artifacts, and release files/pointers are opened through their owning `ProjectDirectoryScope`, fixed `.work/<projectId>` `WorkDirectoryScope`, `RunDirectoryScope`, and `OutputDirectoryScope` respectively. Scope kinds are never substituted; borrowed FDs are closed by the caller in `finally` after each consumer settles.

---
## Task 13: Build Draft, Contact Sheet, and Explicit Review Gate

**Files:**
- Create: `src/media/contact-sheet.ts`
- Create: `src/pipeline/stages/draft.ts`
- Create: `src/pipeline/stages/review.ts`
- Create: `src/cli/commands/review.ts`
- Test: `tests/unit/media/contact-sheet.test.ts`
- Test: `tests/unit/pipeline/review.test.ts`
- Test: `tests/integration/pipeline/draft.test.ts`

- [ ] **Step 1: Write frame-selection tests**

The selector must include frame 0, final frame, every visual start/end boundary, every caption midpoint, and evenly spaced coverage frames. Deduplicate and sort the result, then cap at 24 frames while preserving boundaries. Draft integration tests must also assert its outputs contain `{path, sha256}` references for both `audio/filter-graph.txt` and `audio/mixed-normalized.wav`.

- [ ] **Step 2: Implement contact sheet generation**

Extract selected frames with FFmpeg and tile them into a labeled JPEG. Each decode/extract/tile input and output opens a fresh `RunDirectoryScope` handle and closes it after the consumer settles. Store individual review frames and `contact-sheet.jpg` under the Run's draft directory.

- [ ] **Step 3: Implement Draft stage**

Render 960×540 muted video, invoke P04 Audio Mix once to create the write-once `audio/filter-graph.txt` and loudness-normalized `audio/mixed-normalized.wav`, record both path/SHA-256 references in Draft Stage outputs, mux that normalized audio into the draft MP4, fully decode it, verify one video and one audio stream, then generate review frames and the draft report. The Draft fingerprint includes `audioMixFingerprint()`; no Audio Mix Stage exists.

- [ ] **Step 4: Write Review Gate tests**

```ts
it('returns needs_review without an approval record', async () => {
  expect(await evaluateReview(runContextWithoutReview())).toMatchObject({state: 'needs_review'});
});

it('rejects approval for another run', async () => {
  await expect(evaluateReview(runContextWithReview({runId: 'old-run'})))
    .rejects.toThrow(/DRAFT_REVIEW_REQUIRED/);
});
```

- [ ] **Step 5: Implement review recording**

`videoctl review <project> --approve --reason <text>` resolves the current pointer through the fixed `.work/<projectId>` `WorkDirectoryScope`, obtains its `runId`, then calls `RunStore.openExistingRun(projectId, runId)`. It receives the opaque `RunDirectoryScope`, verifies every evidence path through that scope, writes strict `review.json`, and never edits programmatic checks. A rejected review records `status: rejected` and blocks Release.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test tests/unit/media/contact-sheet.test.ts tests/unit/pipeline/review.test.ts tests/integration/pipeline/draft.test.ts
pnpm typecheck
git add src/media/contact-sheet.ts src/pipeline/stages/draft.ts src/pipeline/stages/review.ts src/cli/commands/review.ts tests/unit/media/contact-sheet.test.ts tests/unit/pipeline/review.test.ts tests/integration/pipeline/draft.test.ts
git commit -m "feat: add draft review gate"
```

Checkpoint B is complete: a narrated, captioned draft can be explicitly approved.


## Task 14: Implement Release Packaging and Full Verification

**Files:**
- Create: `src/media/release-verify.ts`
- Create: `src/pipeline/stages/release.ts`
- Test: `tests/unit/media/release-verify.test.ts`
- Test: `tests/integration/pipeline/release.test.ts`

- [ ] **Step 1: Write release validation tests**

Generate one valid release and fixtures with missing audio, wrong dimensions, excessive A/V duration difference, and truncated MP4. Assert the exact errors `RELEASE_DECODE_FAILED` or `RELEASE_DURATION_MISMATCH`. Add a regression test that pre-creates the Draft filter graph and normalized mixed audio, runs Release, and proves their bytes/hashes remain unchanged.

Add an exact borrowed-FD integration test for both commands in Step 2. Step A must use distinct fresh Run-scope read handles for video/audio plus a fresh Run-scope exclusive read-write handle for write-once `release/final-intermediate.mp4`; assert that intermediate is non-empty. Step B must reopen the intermediate through a different fresh Run-scope read handle and create `releases/<runId>/final.mp4` through a fresh Output-scope exclusive read-write handle. Assert the intermediate and final use different handles and different scope-relative paths, the final is non-empty and fully decodes, and another fresh Output-scope read handle parses top-level MP4 atoms—including normal 32-bit sizes, extended 64-bit sizes, and size-zero-to-EOF semantics—so the `moov` atom offset is strictly before the `mdat` atom offset.

The same test must prove Draft-owned `audio/filter-graph.txt` and `audio/mixed-normalized.wav` bytes/hashes remain unchanged. Add missing-tool and failing-process cases for `qt-faststart`: neither may publish the output pointer, and a pre-existing output `current.json` must remain byte-for-byte unchanged.

- [ ] **Step 2: Implement final rendering and muxing**

1. Render final muted H.264 video at 1920×1080 into the Run scope.
2. Read and verify the Draft Stage output references for `audio/filter-graph.txt` and `audio/mixed-normalized.wav`. Include both hashes and P02's persisted FFmpeg/`qt-faststart` environment fingerprint in the Release fingerprint/provenance, then reuse the normalized mixed audio without executing the graph or writing either Draft artifact again.
3. **Step A — seekable intermediate mux:** open fresh Run-scope read handles for final video and normalized mixed audio plus a fresh Run-scope **exclusive read-write new-file** handle for write-once `release/final-intermediate.mp4`, then mux with borrowed FDs and no `+faststart` flag:

```text
ffmpeg -y -i /dev/fd/3 -i /dev/fd/4 \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -ar 48000 -ac 2 \
  -f mp4 /dev/fd/5
```

4. After the first `runProcess()` settles, close all three caller-owned handles in `finally`. Verify the intermediate is non-empty; do not publish it and do not treat it as a release file.
5. **Step B — faststart publication:** reopen `release/final-intermediate.mp4` through a fresh Run-scope read handle, open `releases/<runId>/final.mp4` through a fresh Output-scope exclusive read-write new-file handle, and invoke the exact real path recorded by P02 Preflight with borrowed child FDs 3 and 4:

```text
qt-faststart /dev/fd/3 /dev/fd/4
```

After the second `runProcess()` settles, close both caller-owned handles in `finally`. Do not use `-shortest`; Draft already trims and normalizes the reusable mixed audio to Composition duration, and Release verifies that duration/hash contract before Step A.

On Darwin, directly running FFmpeg with `-movflags +faststart` against one `/dev/fd/N` output is forbidden. FFmpeg's internal faststart rewrite reopens the descriptor path, and the duplicated descriptors share one open-file-description offset; this can silently corrupt the MP4. The two-process flow keeps intermediate input and final output on distinct handles and paths.

- [ ] **Step 3: Implement full release verification**

Open a fresh Output-scope read handle for each final full-decode, probe, top-level-atom parse, and checksum consumer; run the equivalent of `ffmpeg -v error -xerror -i /dev/fd/3 -f null -` and require exit 0. Probe streams and require one H.264 `yuv420p` 1920×1080 30FPS stream and one AAC 48kHz stereo stream. Parse top-level MP4 atoms with bounds checks for 32-bit, extended 64-bit, and size-zero forms; require exactly discoverable `moov` and `mdat` atoms with `moov` before `mdat`. Require A/V duration difference ≤50ms, parseable SRT within video duration, valid loudness metrics, and unchanged source hashes. Each borrowed FD is consumed once and closed by the caller in `finally`.

- [ ] **Step 4: Generate remaining artifacts**

Create a 1280×720 padded thumbnail from an approved non-black review frame. Write deterministic SRT, `review.json`, `validation-report.json`, and SHA-256 lines sorted by relative path.

- [ ] **Step 5: Publish atomically**

Write all release artifacts through `OutputDirectoryScope` under `releases/<runId>`, verify them there, then atomically update scoped `current.json`. A Step A or Step B failure must not publish the output pointer. The Run-local intermediate and any unpublished final file remain unreferenced cleanup candidates: Run cleanup may remove failed-stage intermediate files, and Release cleanup may remove release directories not referenced by output `current.json`; neither cleanup path may delete the current successful Run/release. Inject `qt-faststart` failure plus pointer write, sync, and rename failures and prove the old release pointer remains intact. Release must never overwrite the Draft-owned Run artifacts or any existing release file.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test tests/unit/media/release-verify.test.ts tests/integration/pipeline/release.test.ts
pnpm typecheck
git add src/media/release-verify.ts src/pipeline/stages/release.ts tests/unit/media/release-verify.test.ts tests/integration/pipeline/release.test.ts
git commit -m "feat: package and verify final releases"
```


## Project Exit Verification

- [ ] **Step 1: Run the complete P05 test set**

```bash
pnpm test tests/unit/media/contact-sheet.test.ts tests/unit/pipeline/review.test.ts tests/integration/pipeline/draft.test.ts tests/unit/media/release-verify.test.ts tests/integration/pipeline/release.test.ts
pnpm typecheck
git diff --check
```

Expected: all tests pass, Draft owns both fixed audio artifact references, Release is blocked without approval, Release reuses their exact hashes without overwriting either artifact, FFmpeg creates a non-empty Run-scope intermediate without `+faststart`, `qt-faststart /dev/fd/3 /dev/fd/4` creates a distinct non-empty Output-scope final MP4 that fully decodes with `moov` before `mdat`, and missing/failing `qt-faststart` plus injected pointer failures preserve the previous successful release.

- [ ] **Step 2: Re-run the release artifact contract test verbosely**

```bash
pnpm test tests/integration/pipeline/release.test.ts --reporter=verbose
```

Expected: the integration assertions confirm all six required artifacts exist under the Output scope's `releases/<runId>`, the release is reachable through its scoped `current.json`, and failed publication preserves the previous pointer.

- [ ] **Step 3: Verify the orchestration boundary**

```bash
git status --short
git log --oneline --max-count=2
```

Expected: P06 registry/Runner/CLI orchestration files are not implemented early, and Tasks 13–14 have focused commits.
