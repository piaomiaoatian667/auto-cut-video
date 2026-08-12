# Agent Video MVP

Agent Video is a local-only, review-gated video pipeline for one authored project at a time. Strict JSON inputs are compiled into immutable Run artifacts, Remotion renders muted video, FFmpeg owns narration/BGM audio and muxing, and a verified Release is published only after explicit approval.

## Supported Target

- Apple Silicon Mac (`darwin/arm64`) running macOS 15 or newer.
- Node.js `>=22.17.0 <23`; the validated handoff runtime is Node 22.17.
- pnpm 10; `package.json` pins `pnpm@10.14.0`.
- Local executable `ffmpeg` and `ffprobe` binaries with H.264/AAC encoders plus `loudnorm`, `silencedetect`, and `blackdetect` filters.
- An executable `qt-faststart` in the same real directory as the resolved FFmpeg binary. The pipeline resolves the FFmpeg real path and then checks its sibling; a separate `QT_FASTSTART_PATH` is not used.
- At least 2 GiB free in the project Work filesystem, or three times the measured source bytes when that is larger.
- A preinstalled Remotion-compatible Chromium. Rendering accepts `REMOTION_BROWSER_EXECUTABLE`, `REMOTION_CHROME_MODE=headless-shell|chrome-for-testing`, and optional `REMOTION_OPENGL_RENDERER` such as `angle`.

Rendering and tests must not download fonts, browsers, media, or other network resources. Provision dependencies before running them.

## Install

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
```

The demo's pinned font is committed at `projects/demo/assets/fonts/NotoSansSC-Bold.otf`, with its license at `projects/demo/assets/fonts/OFL.txt`. `projects/demo/project.json` references that project-relative font path; do not replace it with a network font or fetch a font during render.

If FFmpeg is not selected from `PATH`, set both executable paths before invoking the CLI:

```bash
export FFMPEG_PATH=/absolute/path/to/ffmpeg
export FFPROBE_PATH=/absolute/path/to/ffprobe
```

`qt-faststart` must remain an executable sibling of the resolved FFmpeg real path.

## Demo Fixture Setup

The repository intentionally does not commit `projects/demo/assets/source`. The safest runnable fixture is a temporary workspace created by the existing test helper; it copies the real demo authoring files and pinned font, then generates `camera-a.mp4`, `camera-b.mp4`, `cover.png`, and `music-main.wav` with local FFmpeg. No network access is used.

```bash
set -euo pipefail

export AGENT_VIDEO_REPO="$(pwd)"
export FFMPEG_PATH="${FFMPEG_PATH:-$(command -v ffmpeg)}"
export FFPROBE_PATH="${FFPROBE_PATH:-$(command -v ffprobe)}"

export AGENT_VIDEO_SMOKE_ROOT="$(
  "$AGENT_VIDEO_REPO/node_modules/.bin/tsx" -e '
    import {copyDemoProject} from "./tests/helpers/demo-project.ts";
    void (async () => {
      const fixture = await copyDemoProject();
      process.stdout.write(fixture.workspaceRoot);
    })();
  '
)"

BROWSER_INFO="$(
  "$AGENT_VIDEO_REPO/node_modules/.bin/tsx" -e '
    import {findRemotionBrowser} from "./tests/helpers/demo-project.ts";
    void (async () => {
      const browser = await findRemotionBrowser();
      process.stdout.write(`${browser.executablePath}\t${browser.chromeMode}`);
    })();
  '
)"
IFS=$'\t' read -r REMOTION_BROWSER_EXECUTABLE REMOTION_CHROME_MODE <<<"$BROWSER_INFO"
export REMOTION_BROWSER_EXECUTABLE REMOTION_CHROME_MODE
export REMOTION_OPENGL_RENDERER=angle

videoctl() {
  (
    cd "$AGENT_VIDEO_SMOKE_ROOT"
    "$AGENT_VIDEO_REPO/node_modules/.bin/tsx" \
      "$AGENT_VIDEO_REPO/src/cli/videoctl.ts" "$@"
  )
}
```

The `videoctl` shell function above executes the current checkout's real `src/cli/videoctl.ts` while using the temporary directory as its workspace root. It is equivalent to the repository's `pnpm video` script without writing demo sources into the checkout. The helper-generated source media exists only inside the OS temporary fixture; it is not an Agent edit of the checkout's `projects/demo/assets/source`.

Remove the temporary fixture through Node's filesystem API when finished:

```bash
set -euo pipefail

SMOKE_ROOT="$AGENT_VIDEO_SMOKE_ROOT" node --input-type=module -e '
  import {lstat, realpath, rm} from "node:fs/promises";
  import {tmpdir} from "node:os";
  import path from "node:path";

  const configured = process.env.SMOKE_ROOT;
  if (!configured) throw new Error("SMOKE_ROOT is required.");

  const [fixtureRoot, temporaryRoot] = await Promise.all([
    realpath(path.resolve(configured)),
    realpath(path.resolve(tmpdir())),
  ]);
  const fixturePrefix = "agent-video-demo-e2e-";
  if (
    path.dirname(fixtureRoot) !== temporaryRoot
    || !path.basename(fixtureRoot).startsWith(fixturePrefix)
  ) {
    throw new Error(`Refusing to remove unsafe fixture path: ${fixtureRoot}`);
  }
  if (!(await lstat(fixtureRoot)).isDirectory()) {
    throw new Error(`Fixture path is not a directory: ${fixtureRoot}`);
  }

  await rm(fixtureRoot, {recursive: true, force: false});
'
unset AGENT_VIDEO_SMOKE_ROOT BROWSER_INFO
```

The full deterministic E2E fixture can also be exercised directly:

```bash
pnpm test tests/integration/e2e/demo-pipeline.test.ts
```

## Authoring Inputs

Only these three JSON files are editable sources of truth:

| File | Role |
| --- | --- |
| `projects/<project>/project.json` | Fixed 1920x1080/30 fps composition, TTS provider, local caption font, audio targets, and draft render profile. |
| `projects/<project>/script.json` | Ordered `zh-CN` narration segments, normalized text, pauses, required terms, optional visual notes, and optional project-relative `audioPath` values for file TTS. |
| `projects/<project>/edit.json` | Visual EDL, registered overlays, and optional background music. Timeline positions/durations use integer frames; video source trims and BGM offsets use milliseconds. |

Referenced visual and BGM `assetId` values resolve recursively under `projects/<project>/assets/source` by **filename stem after removing only the final extension**. For example, `assetId: "camera-a"` may resolve to `assets/source/camera-a.mp4`. Every referenced stem must match exactly one regular file across the entire source tree; missing stems, duplicate stems such as `camera-a.mp4` plus `archive/camera-a.mov`, symlinks, or files that change during measurement fail validation.

For authored projects, adding, renaming, or deleting source files is a manual project-owner operation. Agents must report the required correction and wait for the owner; `AGENTS.md` prohibits Agents from modifying any `projects/*/assets/source` path.

Manifests, compiled timelines, Stage reports, Run artifacts, drafts, and Releases are generated outputs and must not be hand-edited.

## Stages and Presets

The stable Stage order is:

1. `preflight` — validate platform, tools, capabilities, font/voice, source measurement, Work authority, and disk space.
2. `ingest` — validate and ingest referenced source assets into immutable Run artifacts.
3. `narration` — synthesize or load segment audio, reuse matching segment cache entries, and build the narration master/caption timing inputs.
4. `compile` — compile authoring inputs and measured media into the immutable timeline.
5. `draft` — render muted draft video, mix/normalize narration and BGM, and create contact-sheet/review evidence.
6. `review` — stop at the explicit approval Gate and validate approval evidence.
7. `release` — render final muted video, mux approved audio, fast-start, fully decode, verify, package evidence, and publish.

The three built-in Presets are contiguous prefixes of that order:

| Preset | Stages |
| --- | --- |
| `assets` | `preflight`, `ingest` |
| `draft` | `preflight`, `ingest`, `narration`, `compile`, `draft` |
| `release` | `preflight`, `ingest`, `narration`, `compile`, `draft`, `review`, `release` |

`release` is the default Preset.

## CLI Contract

`pnpm video` is the package-script wrapper around `videoctl`. The exact supported command contract is:

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

Examples from a normal project workspace:

```bash
pnpm video doctor demo --json
pnpm video ingest demo --json
pnpm video run demo --to narration --json
pnpm video compile demo --json
pnpm video pipeline demo --preset release --plan --json
pnpm video release demo --json
pnpm video report demo --json
pnpm video clean demo
```

All convenience commands map through the same Execution Plan builder and Runner: `doctor` selects Release through `preflight`; `ingest` selects Assets through `ingest`; `run --to narration` selects Draft through `narration`; `compile` selects Draft through `compile`; and `release` selects the full Release Preset.

### Pipeline Options

- `--plan` prints the validated plan and exits 0 without locks, directory creation, writes, subprocesses, TTS, FFmpeg/ffprobe, `qt-faststart`, or Remotion. It may read and hash authoring/source inputs plus existing reports and pointers.
- `--from <stage>` and `--to <stage>` select an inclusive, registry-ordered range inside the chosen Preset. Every omitted prerequisite before `--from` must already exist in the current Run with matching fingerprints and verified artifacts; execution still performs runtime Preflight revalidation.
- `--resume` reuses the current `runId` only when the persisted Stage sequence, completed prefix, fingerprints, artifacts, and Review identity are compatible. With no compatible current Run, planning selects `runMode: "new"`; the Run is created only when that executable plan runs successfully through Preflight.
- `--force <stage>` must name a Stage inside the selected range. It invalidates that Stage and every selected downstream Stage while preserving matching reusable predecessors.
- `--json` writes deterministic machine-readable output to stdout. Text-mode failures are sanitized before stderr output.

`--resume --force` follows these rules:

1. If the forced Stage has not completed and the selected range, current pointer, fingerprints, artifacts, and Review evidence remain compatible, execution reuses the current Run. It resumes at the earliest incomplete selected Stage, which may be before the forced Stage; the forced Stage does not need to be the first incomplete Stage.
2. If the forced Stage is already complete and the selected range can establish a complete executable prerequisite chain, execution creates a new Run. Preflight always runs again; eligible matching Stages after Preflight and before the force boundary are materialized and hash-verified from the source Run, then the forced Stage and selected downstream Stages run.
3. If a selected slice omits prerequisites and therefore cannot establish a legal new-Run chain for the forced rerun, planning fails with `PLAN_RANGE_STALE` instead of always creating a new Run. Widen `--from` to the reported stale Stage or remove the range bound.

A range that omits prerequisites is bound to the current Run. Missing prerequisites fail with `PLAN_PREREQUISITE_MISSING`; changed, invalid, or already-completed forced Stages that cannot be legally rerun inside that slice fail with `PLAN_RANGE_STALE`.

### Exit Codes

| Code | Meaning |
| --- | --- |
| `0` | Success, including a read-only plan or no-op. |
| `2` | The pipeline reached `review` and needs explicit approval. |
| `3` | CLI, schema, source, plan, prerequisite, or review validation failed. |
| `4` | Environment, tool, lock, storage, report, cleanup, or unexpected execution failure. |
| `130` | Cancelled by `SIGINT`. |
| `143` | Terminated by `SIGTERM`. |

## Review

The first full Release execution stops after `review` with exit code 2 and leaves the current Work pointer on the same `runId` in `needs_review` state.

Approve only after inspecting the generated draft evidence:

```bash
pnpm video review demo --approve --reason "acceptance review"
pnpm video pipeline demo --preset release --resume --json
```

Approval verifies immutable draft evidence, writes `review.json` plus the canonical Review report, and updates the Work pointer without changing `runId`.

`--reject` is part of the CLI contract but is intentionally unsupported in the MVP. `pnpm video review demo --reject --reason "..."` returns validation exit code 3 and performs zero writes.

## Reports, Cleanup, and Pointers

```bash
pnpm video report demo --json
pnpm video clean demo
```

`report` is read-only. It resolves `.work/<project>/current.json`, opens only that Run, and returns canonical Stage reports in stable registry order followed by attempt reports. Each report preserves the `position/total` values of the selected plan that produced it.

`clean` removes every non-current `.work/<project>/runs/<runId>` and every non-current `output/<project>/releases/<runId>`, including an older previously published Release that is no longer selected by the Output current pointer. It reads both current pointers while building the scoped inventory, acquires the project lock, and re-opens the scoped directories and re-reads the relevant pointer before each candidate removal so a Run or Release that became current is protected. Cleanup is idempotent and never deletes authoring inputs or source assets.

There are two atomic current pointers:

- `.work/<project>/current.json` selects the current immutable Run at `.work/<project>/runs/<runId>` and tracks pipeline progress, review state, selected Preset, and selected Stage IDs.
- `output/<project>/current.json` selects the current verified Release at `output/<project>/releases/<runId>`.

Release publication writes and verifies the canonical Release report before publishing the Output pointer. Updating the Work pointer to `completedStage: release` happens afterward as best-effort progress metadata; a published Output may therefore be authoritative even if the result includes `WORK_POINTER_LAGGING`.

## Release Publication and Audio Ownership

Release uses a two-step scoped-file-descriptor flow and never interpolates project paths into shell command strings:

1. FFmpeg reads the Run-owned muted video and normalized mixed audio through borrowed `/dev/fd/*` descriptors, stream-copies H.264 video, encodes 48 kHz stereo AAC, and writes an exclusive Run-owned `release/final-intermediate.mp4` descriptor.
2. `qt-faststart` reads that Run-owned intermediate through a borrowed descriptor and writes an exclusive Output-owned `releases/<runId>/final.mp4` descriptor.

The final MP4 must fully decode, match the fixed 1920x1080/30 fps H.264 + 48 kHz stereo AAC profile, and place `moov` before `mdat`. The Release also writes `subtitles.srt`, `thumbnail.jpg`, `review.json`, `validation-report.json`, and `checksums.sha256` before publishing `output/<project>/current.json`.

Source-video audio is always muted in the MVP: each Remotion `OffthreadVideo` is muted and the renderer runs with `muted: true`. Only the Draft-owned narration/BGM mix is muxed into the final Release.

## Common Failures

| Code or family | Recovery |
| --- | --- |
| `PROJECT_LOAD_FAILED`, `PROJECT_ID_MISMATCH` | Fix strict `project.json`, `script.json`, and `edit.json` schema/cross-file errors; keep the directory name and `project.id` aligned. |
| `PROJECT_SOURCE_INVALID` | Public CLI code for every source-discovery validation failure. The project owner must inspect the source condition and act manually: for a missing stem, add the required local regular file; for an ambiguous stem, rename or delete the conflicting file; for an invalid source, check file type, project-relative path, symlinks, and whether the file changed during measurement. Agents report the condition but must not modify source files. |
| `ENV_PLATFORM_UNSUPPORTED` | Run on Apple Silicon macOS 15+ with the supported Node runtime. |
| `ENV_TOOL_MISSING`, `ENV_CAPABILITY_MISSING`, `ENV_TOOL_CHANGED` | Restore executable local FFmpeg/ffprobe plus sibling `qt-faststart`, required encoders/filters, then rerun `pnpm video doctor <project> --json`. |
| `ENV_FONT_MISSING`, `ENV_FONT_INVALID`, `ENV_VOICE_MISSING` | Restore the configured local font or voice/file-TTS inputs; do not fetch them during render. |
| `ENV_WORK_DIRECTORY_UNAVAILABLE`, `DISK_SPACE_EXHAUSTED` | Restore safe Work-directory authority, free at least the reported required bytes, run `clean` if appropriate, then resume. |
| `PLAN_STAGE_INVALID`, `PLAN_RANGE_INVALID`, `PLAN_PREREQUISITE_MISSING` | Use stable Stage IDs, keep ranges inside the Preset and in order, or widen `--from` to include the first missing prerequisite. |
| `PLAN_RANGE_STALE` | The current-bound slice cannot safely reuse or force-rerun its selected chain. Widen `--from` to the reported Stage or remove the range bound so a legal full plan can be built. |
| `PLAN_STALE` | Rerun the command so the CLI can rebuild from the current pointer; if authoring changed, start from the first invalid Stage. |
| `PROJECT_LOCK_*` | Let the active process finish or recover only a demonstrably stale lock; never delete a live lock blindly. |
| `PIPELINE_CANCELLED` | Inspect `report`, then rerun the same Preset with `--resume`; immutable completed Stages are verified before reuse. |
| `PIPELINE_REPORT_FAILED`, `PIPELINE_CLEANUP_FAILED` | Preserve current pointers, inspect filesystem permissions/authority, and retry after the underlying environment issue is fixed. |
| `REVIEW_APPROVAL_OUTCOME_UNKNOWN` | Do not approve again blindly. Read `videoctl report <project> --json`, inspect the current pointer and `review.json`, then retry only after confirming whether approval committed. |
| Review validation messages | Return to the current `needs_review` Run, restore unchanged draft evidence, and approve with a non-empty reason. Do not fabricate or edit `review.json`. |

## Verification and Acceptance Smoke

Repository verification:

```bash
pnpm test
pnpm typecheck
git diff --check
```

Without `RUN_SYSTEM_TTS_TESTS`, the macOS system-TTS integration is the only intentional skip.

After running the temporary fixture setup above, execute the real CLI through the `videoctl` function:

```bash
set -euo pipefail

videoctl doctor demo --json
videoctl pipeline demo --preset release --plan --json
videoctl pipeline demo --preset assets --resume --json
videoctl pipeline demo --preset draft --resume --json

set +e
videoctl pipeline demo --preset release --resume --json
review_gate_status=$?
set -e
test "$review_gate_status" -eq 2

videoctl review demo --approve --reason "acceptance review"
videoctl pipeline demo --preset release --resume --json
videoctl report demo --json
```

Acceptance requires the Doctor JSON to contain real paths and SHA-256 identities for FFmpeg, ffprobe, and sibling `qt-faststart`, plus an environment fingerprint. Plan mode must leave `.work` and `output` absent and start no subprocess. Assets and Draft reports must be reused without changing their immutable evidence; the first Release must exit 2; approval and final Release must retain the same `runId`; the final MP4 must fully decode; and the report must list stable Stage IDs with their persisted `position/total` values.
