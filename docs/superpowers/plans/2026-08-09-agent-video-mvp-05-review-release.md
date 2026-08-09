# Agent Video MVP P05 Review and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate muted visual output and narration/audio output into a reviewable draft, explicit approval Gate, and atomically published verified release package.

**Architecture:** P05 consumes the frozen P03 visual and P04 audio contracts. Draft creates evidence without publishing, Review records an explicit decision for the same Run, and Release renders/mixes the final profile, performs full decode and metadata checks, then atomically advances the output pointer.

**Tech Stack:** TypeScript, FFmpeg/ffprobe, Remotion, Commander, Vitest.

---

## Project Contract

- **Project ID:** P05
- **Specification:** `../specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- **Project Index:** `2026-08-09-agent-video-mvp-project-index.md`
- **Master Tasks:** 13–14
- **Depends On:** P03 and P04 completed and merged.
- **Primary Write Set:** contact-sheet generation, Draft/Review/Release Stages, review CLI command, release verification, and integration tests.
- **Must Not Modify:** Frozen authoring/Manifest formats, TTS/visual business logic, Stage registry, Presets, Execution Plan, or Runner.
- **Exit Artifact:** Decodable review draft, contact sheet/evidence, strict `review.json`, verified final release directory, checksums, and atomic output pointer.

## Entry Criteria

- P03 and P04 exit verification passes against the same P01/P02 contract versions.
- A fixture Run can provide muted final/draft video, narration master, caption data, BGM, and compiled timeline.
- Output publication tests begin with an existing successful pointer to prove rollback behavior.

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

The selector must include frame 0, final frame, every visual start/end boundary, every caption midpoint, and evenly spaced coverage frames. Deduplicate and sort the result, then cap at 24 frames while preserving boundaries.

- [ ] **Step 2: Implement contact sheet generation**

Extract selected frames with FFmpeg and tile them into a labeled JPEG. Store individual review frames and `contact-sheet.jpg` under the run's draft directory.

- [ ] **Step 3: Implement Draft stage**

Render 960×540 muted video, mix non-normalized guide audio using the same envelope, mux draft MP4, fully decode it, verify one video and one audio stream, then generate review frames and the draft report.

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

`videoctl review <project> --approve --reason <text>` loads the current Run whose Review Stage is `needs_review`, verifies every evidence path is inside that Run, writes strict `review.json`, and never edits programmatic checks. A rejected review records `status: rejected` and blocks Release.

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

Generate one valid release and fixtures with missing audio, wrong dimensions, excessive A/V duration difference, and truncated MP4. Assert the exact errors `RELEASE_DECODE_FAILED` or `RELEASE_DURATION_MISMATCH`.

- [ ] **Step 2: Implement final rendering and muxing**

1. Render final muted H.264 video at 1920×1080.
2. Mix and loudness-normalize narration plus BGM.
3. Mux with:

```text
ffmpeg -y -i final-video.mp4 -i master.wav \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -ar 48000 -ac 2 \
  -movflags +faststart final.mp4
```

Do not use `-shortest`; validate and explicitly trim audio to Composition duration before muxing.

- [ ] **Step 3: Implement full release verification**

Run `ffmpeg -v error -xerror -i final.mp4 -f null -` and require exit 0. Probe streams and require one H.264 `yuv420p` 1920×1080 30FPS stream and one AAC 48kHz stereo stream. Require A/V duration difference ≤50ms, parseable SRT within video duration, valid loudness metrics, and unchanged source hashes.

- [ ] **Step 4: Generate remaining artifacts**

Create a 1280×720 padded thumbnail from an approved non-black review frame. Write deterministic SRT, `review.json`, `validation-report.json`, and SHA-256 lines sorted by relative path.

- [ ] **Step 5: Publish atomically**

Write all artifacts to `output/<project>/releases/<runId>`, verify them there, then atomically update `output/<project>/current.json`. Inject failures at pointer write, sync, and rename in integration tests and prove the old release pointer remains intact.

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

Expected: all tests pass, Release is blocked without approval, the final MP4 fully decodes, and injected pointer failures preserve the previous successful release.

- [ ] **Step 2: Re-run the release artifact contract test verbosely**

```bash
pnpm test tests/integration/pipeline/release.test.ts --reporter=verbose
```

Expected: the integration assertions confirm all six required artifacts exist under `releases/<runId>`, the release is reachable through `output/<project>/current.json`, and failed publication preserves the previous pointer.

- [ ] **Step 3: Verify the orchestration boundary**

```bash
git status --short
git log --oneline --max-count=2
```

Expected: P06 registry/Runner/CLI orchestration files are not implemented early, and Tasks 13–14 have focused commits.
