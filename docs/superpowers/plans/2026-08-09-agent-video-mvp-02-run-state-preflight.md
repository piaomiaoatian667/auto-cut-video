# Agent Video MVP P02 Run State and Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic fingerprints, opaque app-owned Run/Output directory scopes, immutable Run storage, project locking, atomic pointers, and a target-Mac Preflight/`doctor` command without implementing media business logic.

**Architecture:** P02 consumes P01 filesystem, process, Schema, and Gate contracts. It establishes opaque app-owned filesystem scopes plus the durable execution-state protocol used by all Stages, and performs environment capability checks before any Run is created.

**Tech Stack:** Node.js filesystem and crypto APIs, TypeScript, Commander, Vitest, macOS process metadata, FFmpeg/ffprobe capability probes, and `qt-faststart` toolchain verification.

---

## Project Contract

- **Project ID:** P02
- **Specification:** `../specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- **Project Index:** `2026-08-09-agent-video-mvp-project-index.md`
- **Master Tasks:** 5–6
- **Depends On:** P01 completed and merged.
- **Primary Write Set:** `src/fs/app-directory-scopes.ts`, `src/pipeline/fingerprint.ts`, `src/pipeline/project-lock.ts`, `src/pipeline/run-store.ts`, Preflight Stage, CLI bootstrap/output/exit codes, and their tests.
- **Must Not Implement:** Ingest, narration, compile, render, review, release, Presets, Execution Plan, or Runner sequencing.
- **Exit Artifact:** Opaque `RunDirectoryScope`/`OutputDirectoryScope` APIs, stable fingerprint format, immutable Run layout, lock protocol, atomic `current.json`, verified FFmpeg/`qt-faststart` environment fingerprint, and passing `doctor` behavior.

## Entry Criteria

- P01 exit verification passes.
- P01 contract files are unchanged in the P02 branch except for an explicitly reviewed versioned amendment.
- Implementation runs on Apple Silicon macOS 15+ for the target smoke check; unit tests may use injected platform fixtures elsewhere.

---
## Task 5: Add App-Owned Scopes, Fingerprints, Immutable Runs, Atomic Pointers, and Project Locks

**Files:**
- Create: `src/fs/app-directory-scopes.ts`
- Create: `src/pipeline/fingerprint.ts`
- Create: `src/pipeline/project-lock.ts`
- Create: `src/pipeline/run-store.ts`
- Test: `tests/unit/fs/app-directory-scopes.test.ts`
- Test: `tests/unit/pipeline/fingerprint.test.ts`
- Test: `tests/integration/pipeline/project-lock.test.ts`
- Test: `tests/integration/pipeline/run-store.test.ts`

- [ ] **Step 1: Write fingerprint tests**

```ts
import {describe, expect, it} from 'vitest';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';

describe('fingerprintValue', () => {
  it('is independent of object key insertion order', () => {
    expect(fingerprintValue({a: 1, b: 2})).toBe(fingerprintValue({b: 2, a: 1}));
  });

  it('changes when an array order changes', () => {
    expect(fingerprintValue(['a', 'b'])).not.toBe(fingerprintValue(['b', 'a']));
  });
});
```

- [ ] **Step 2: Implement canonical hashing**

```ts
import {createHash} from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

export function fingerprintValue(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}
```

- [ ] **Step 3: Write lock behavior tests**

The tests must start one lock owner and assert a second acquisition returns `PROJECT_LOCKED`. They must then create a lock with a non-existent local PID and assert it is reported as `PROJECT_LOCK_STALE` but is not deleted until `clearStaleLock()` is explicitly called.

Lock JSON:

```ts
export interface ProjectLockRecord {
  pid: number;
  hostname: string;
  processStart: string;
  createdAt: string;
  runId: string;
}
```

- [ ] **Step 4: Implement the lock**

Use `open(lockPath, 'wx', 0o600)` for acquisition. Record `hostname()`, PID, run ID, ISO timestamp, and a process-start marker read through `ps -o lstart= -p <pid>` on macOS. On conflict, compare host, PID liveness via `process.kill(pid, 0)`, and process-start marker to avoid PID reuse. Return a release function that only unlinks a lock still owned by the same `runId`.

- [ ] **Step 5: Write app-owned scope and atomic pointer tests**

Define opaque `RunDirectoryScope` and `OutputDirectoryScope` values that can only be created asynchronously from a trusted canonical `workspaceRoot` plus an app-owned relative root. Each class must carry its own true private instance brand (`#private` or `declare private`), not merely a private constructor. Add strict type regressions using `@ts-expect-error` for `{}` forgery and all six cross-assignments among `ProjectDirectoryScope`, `RunDirectoryScope`, and `OutputDirectoryScope`; the three authorities must remain nominally incompatible. The factory must reject an initial canonical root outside the canonical workspace root. Keep each canonical scope root in a class `#private` field or module-private `WeakMap`; do not expose it as a string or accept a downstream string as a containment root. Every scope file API accepts only a path relative to that Run or Output root.

Both scopes provide existing-file read, exclusive write-only new-file, and exclusive read-write new-file capabilities. The read-write capability opens the verified new target with `O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW_ANY` and mode `0o600`. Release uses the Run-scope read-write capability for FFmpeg's seekable write-once intermediate MP4 and the Output-scope read-write capability for `qt-faststart`'s exclusive final output. Add table-driven tests for both scopes covering an initial canonical root outside the workspace, read and write escape through internal symlinks, replacement of the lexical scope path after factory creation, replacement of the original canonical root with an external symlink, exclusive create against an existing target, and symbolic links at work/output pointer paths. Prove the read-write handle supports write, seek, and readback, while the existing-file read capability cannot write and the write-only new-file capability cannot read; repeat symlink traversal, root substitution, and exclusive-create cases for the read-write capability. Scope substitution must fail closed rather than widening authority. Existing-file and both new-file opens must use Darwin `O_NOFOLLOW_ANY` after canonicalizing the target or real parent and confirming it is still contained by the canonical root saved in the opaque scope.

File descriptors returned by these APIs are borrowed when passed to `runProcess()`: the scope/runner never seeks or closes them. Each independent consumer opens its own handle from the correct scope and closes it in `finally` after the consumer promise settles. Tests must prove ownership remains with the caller across successful, failed, aborted, and timed-out consumers.

Use an injected `FileOps` interface to force failures in temporary-file write, sync, and rename. Each test begins with an existing `current.json` and asserts its contents remain unchanged after the simulated failure.

```ts
export interface CurrentPointer {
  runId: string;
  relativePath: string;
  preset: 'assets' | 'draft' | 'release';
  stageIds: Array<'preflight' | 'ingest' | 'narration' | 'compile' | 'draft' | 'review' | 'release'>;
  completedStage: 'preflight' | 'ingest' | 'narration' | 'compile' | 'draft' | 'review' | 'release';
  state: 'passed' | 'needs_review';
  publishedAt: string;
}
```

- [ ] **Step 6: Implement immutable runs and atomic pointer publication**

`RunStore.createRun()` creates `.work/<project>/runs/<runId>` and returns its opaque `RunDirectoryScope`, never a public root string. Add a safe `RunStore.openExistingRun()` API that recreates a Run scope only through the trusted workspace/app-root factory and rejects traversal or root substitution. `RunStore` may retain module-private authority for `.work/<project>/current.json` and `pipeline.lock`, but must not expose that app-owned root or misrepresent it as a per-Run scope. Stage output files are write-once; later stages append new files without overwriting earlier artifacts.

Create one `OutputDirectoryScope` rooted at the app-owned `output/<project>` tree for release artifact creation and publication. Run artifacts, including the FFmpeg mux intermediate, must be opened only through `RunDirectoryScope`; release files, the `qt-faststart` final output, and the output pointer must be opened only through `OutputDirectoryScope`; neither may be opened through `ProjectDirectoryScope` or a raw path. Ordinary immutable artifacts may use write-only creation, while the two seekable MP4 outputs use their owning scope's exclusive read-write new-file capability. `publishCurrent()` opens a new same-directory `current.json.tmp` with no-follow/exclusive flags, writes and calls `sync()` on the file handle, atomically renames it, syncs the parent directory, and removes the temporary file on failure. Reject a symbolic link at either pointer path instead of following it.

Use the same scoped publication protocol for `output/<project>/current.json`, whose `relativePath` points at `releases/<runId>` and whose `completedStage` is always `release`.

- [ ] **Step 7: Verify and commit**

```bash
pnpm test tests/unit/fs/app-directory-scopes.test.ts tests/unit/pipeline/fingerprint.test.ts tests/integration/pipeline/project-lock.test.ts tests/integration/pipeline/run-store.test.ts
pnpm typecheck
git add src/fs/app-directory-scopes.ts src/pipeline/fingerprint.ts src/pipeline/project-lock.ts src/pipeline/run-store.ts tests/unit/fs/app-directory-scopes.test.ts tests/unit/pipeline/fingerprint.test.ts tests/integration/pipeline
git commit -m "feat: add resumable run storage and locks"
```


## Task 6: Implement Preflight and the `doctor` Command

**Files:**
- Create: `src/pipeline/stages/preflight.ts`
- Create: `src/cli/exit-codes.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/videoctl.ts`
- Test: `tests/unit/pipeline/preflight.test.ts`
- Test: `tests/unit/cli/doctor.test.ts`

- [ ] **Step 1: Write failing Preflight tests**

Use an injected process runner and filesystem adapter. Cover:

```ts
it('fails on a non-darwin or non-arm64 runtime', async () => {
  const result = await runPreflight(fixtureContext({platform: 'linux', arch: 'x64'}));
  expect(result.checks).toContainEqual(expect.objectContaining({id: 'supported-platform', severity: 'error'}));
});

it('fails when ffmpeg lacks loudnorm', async () => {
  const result = await runPreflight(fixtureContext({ffmpegFilters: 'blackdetect\nsilencedetect'}));
  expect(result.checks).toContainEqual(expect.objectContaining({id: 'ffmpeg-filter-loudnorm', severity: 'error'}));
});

it('fails before creating a run when disk space is below the estimate', async () => {
  const result = await runPreflight(fixtureContext({availableBytes: 100, requiredBytes: 1_000}));
  expect(result.checks).toContainEqual(expect.objectContaining({id: 'disk-space', severity: 'error'}));
});
```

Also cover resolution of the configured/PATH-selected FFmpeg executable to its canonical real path, derivation of sibling `<ffmpeg-real-dir>/qt-faststart`, executable-bit enforcement, and binary hashing. A missing, non-regular, or non-executable sibling must produce `ENV_TOOL_MISSING`. `doctor --json` must expose the resolved FFmpeg and `qt-faststart` real paths plus their SHA-256 values, and the environment fingerprint must change when either binary hash changes.

- [ ] **Step 2: Implement Preflight checks**

Run and parse:

```text
node --version
pnpm --version
/usr/bin/sw_vers -productVersion
ffmpeg -version
ffprobe -version
ffmpeg -hide_banner -encoders
ffmpeg -hide_banner -filters
/usr/bin/say -v ?
```

Resolve FFmpeg once through the injected executable resolver, canonicalize it with `realpath`, and run every FFmpeg probe through that resolved path. Locate `qt-faststart` only as the sibling of that canonical FFmpeg binary, require a regular executable file via the injected filesystem adapter, canonicalize it, and compute SHA-256 for both binaries. Record `{realPath, sha256}` for FFmpeg and `qt-faststart` in Preflight outputs/`doctor --json`; include both identities in the persisted environment fingerprint used by downstream provenance and cache decisions. Missing or unusable `qt-faststart` maps to `ENV_TOOL_MISSING` before `RunStore.createRun()`.

Require `process.platform === 'darwin'`, `process.arch === 'arm64'`, macOS 15 or newer, H.264 encoding, AAC encoding, `loudnorm`, `silencedetect`, and `blackdetect`. Hash every configured font. Estimate required bytes as `max(sourceBytes * 3, 2 GiB)` and compare with `statfs()` before `RunStore.createRun()`. Keep sibling resolution and hashing in `src/pipeline/stages/preflight.ts` for MVP; no additional probe helper or file/test whitelist expansion is required.

- [ ] **Step 3: Implement CLI output and exit codes**

```ts
export const EXIT_CODES = {
  success: 0,
  needsReview: 2,
  validationFailed: 3,
  environmentFailed: 4,
  cancelled: 130,
} as const;
```

`videoctl doctor <project>` loads the project, runs Preflight, prints a table by default or JSON with `--json`, including the resolved FFmpeg/`qt-faststart` paths, hashes, and environment fingerprint, and exits with `environmentFailed` for errors. Missing or non-executable `qt-faststart` is reported as `ENV_TOOL_MISSING`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test tests/unit/pipeline/preflight.test.ts tests/unit/cli/doctor.test.ts
pnpm typecheck
git add src/pipeline/stages/preflight.ts src/cli tests/unit/pipeline/preflight.test.ts tests/unit/cli
git commit -m "feat: add environment doctor command"
```


## Project Exit Verification

- [ ] **Step 1: Run the complete P02 test set**

```bash
pnpm test tests/unit/fs/app-directory-scopes.test.ts tests/unit/pipeline/fingerprint.test.ts tests/integration/pipeline/project-lock.test.ts tests/integration/pipeline/run-store.test.ts tests/unit/pipeline/preflight.test.ts tests/unit/cli/doctor.test.ts
pnpm typecheck
git diff --check
```

Expected: all tests pass, Project/Run/Output scope forgery and cross-assignment fail typechecking as expected, Run/Output scope escape and substitution fail closed, write-only/read-write exclusive create and pointer-symlink tests pass, missing/non-executable `qt-faststart` returns `ENV_TOOL_MISSING`, tool hashes affect the environment fingerprint, pointer-failure tests preserve the previous pointer, lock tests never delete a live lock, and TypeScript exits 0.

- [ ] **Step 2: Run the target-Mac environment smoke check**

```bash
node -p "process.platform + '/' + process.arch"
/usr/bin/sw_vers -productVersion
ffmpeg -version
ffprobe -version
FFMPEG_REAL="$(node -e 'const fs=require("node:fs"); process.stdout.write(fs.realpathSync(process.argv[1]))' "$(command -v ffmpeg)")"
QT_FASTSTART_REAL="$(node -e 'const fs=require("node:fs"); const path=require("node:path"); process.stdout.write(fs.realpathSync(path.join(path.dirname(process.argv[1]), "qt-faststart")))' "$FFMPEG_REAL")"
test -x "$QT_FASTSTART_REAL"
shasum -a 256 "$FFMPEG_REAL" "$QT_FASTSTART_REAL"
```

Expected: `darwin/arm64`, macOS 15 or newer, matching FFmpeg/ffprobe builds, and an executable `qt-faststart` sibling of the resolved FFmpeg binary. Record exact versions, real paths, binary hashes, and the resulting environment fingerprint in the P02 handoff.

- [ ] **Step 3: Verify the handoff boundary**

```bash
git status --short
git log --oneline --max-count=2
```

Expected: only P02-owned files and the minimal P01 imports are changed, with one focused commit per master task.
