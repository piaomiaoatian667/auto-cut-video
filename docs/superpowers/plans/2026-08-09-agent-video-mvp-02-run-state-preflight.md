# Agent Video MVP P02 Run State and Preflight Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic fingerprints, opaque app-owned Work/Run/Output directory scopes, immutable Run storage, project locking, atomic pointers, and a target-Mac Preflight/`doctor` command without implementing media business logic.

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
- **Exit Artifact:** Opaque `WorkDirectoryScope`/`RunDirectoryScope`/`OutputDirectoryScope` APIs, stable fingerprint format, immutable Run layout, lock protocol, atomic `current.json`, verified FFmpeg/`qt-faststart` environment fingerprint, and passing `doctor` behavior.

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

Define opaque `WorkDirectoryScope`, `RunDirectoryScope`, and `OutputDirectoryScope` values. In `src/fs/app-directory-scopes.ts`, every low-level constructor/minter that accepts or resolves an app-owned relative root is module-private; no exported class static method or exported generic factory may accept an arbitrary relative root. High-level APIs validate `projectId`/`runId` before minting authority and derive only fixed prefixes: Work authority is `.work/<projectId>` for locking, `current.json`, and Run creation; Run authority is `.work/<projectId>/runs/<runId>` and is returned only by `RunStore.createRun(projectId, runId)` or `RunStore.openExistingRun(projectId, runId)`; Output authority is `output/<projectId>` and is returned only by the output/release store. Each class carries its own true private instance brand (`#private` or `declare private`), not merely a private constructor. Add strict `@ts-expect-error` regressions for `{}` forgery and every cross-assignment among `ProjectDirectoryScope`, `WorkDirectoryScope`, `RunDirectoryScope`, and `OutputDirectoryScope`; all four authorities remain nominally incompatible. Keep canonical scope roots in class-private/module-private state, never expose/reaccept a root string as authority, and accept only paths relative to the owning Work, Run, or Output root.

Work authority provides the safe lock, pointer, and Run-creation operations needed beneath `.work/<projectId>`. Run and Output scopes provide existing-file read, exclusive write-only new-file, and exclusive read-write new-file capabilities. The read-write capability opens the verified new target with `O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW_ANY` and mode `0o600`; Release uses it through Run scope for FFmpeg's seekable write-once intermediate MP4 and through Output scope for `qt-faststart`'s exclusive final output. Add table-driven authority tests for Work/Run/Output covering a fixed lexical authority resolving outside the workspace, internal-symlink escape, lexical scope-path replacement after authority creation, and original canonical-root replacement with an external symlink. Work tests additionally cover lock/current pointer symlinks and confined Run creation. Run/Output tests cover read/write escape, exclusive create, and read-write seek/readback permissions; repeat symlink traversal, root substitution, and exclusive-create cases for the read-write capability. Scope substitution must fail closed rather than widening authority. Existing-file and new-file opens use Darwin `O_NOFOLLOW_ANY` after canonicalizing the target or real parent and confirming it remains contained by the canonical root saved in the opaque scope.

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

The fixed-prefix Work API validates `projectId` and returns authority for `.work/<projectId>`; project locking, work `current.json`, and Run creation use that `WorkDirectoryScope` rather than a raw path. `RunStore.createRun(projectId, runId)` and `RunStore.openExistingRun(projectId, runId)` validate both IDs, derive `.work/<projectId>/runs/<runId>` internally, and are the only APIs that return `RunDirectoryScope`; they never expose a root string or call an exported arbitrary-root factory. Stage output files are write-once; later stages append new files without overwriting earlier artifacts.

The output/release store validates `projectId`, internally derives `output/<projectId>`, and is the only authority source for `OutputDirectoryScope`; no free-standing public Output factory exists. Run artifacts, including the FFmpeg mux intermediate, must be opened only through `RunDirectoryScope`; release files, the `qt-faststart` final output, and the output pointer must be opened only through `OutputDirectoryScope`; neither may be opened through `ProjectDirectoryScope`, `WorkDirectoryScope`, or a raw path. Ordinary immutable artifacts may use write-only creation, while the two seekable MP4 outputs use their owning scope's exclusive read-write new-file capability. `publishCurrent()` opens a new same-directory `current.json.tmp` with no-follow/exclusive flags, writes and calls `sync()` on the file handle, atomically renames it, syncs the parent directory, and removes the temporary file on failure. Reject a symbolic link at either pointer path instead of following it.

Use the same scoped publication protocol for `output/<projectId>/current.json`, whose `relativePath` points at `releases/<runId>` and whose `completedStage` is always `release`.

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

Resolve FFmpeg once through the injected executable resolver, canonicalize it with `realpath`, and run every FFmpeg probe through that resolved path. Locate `qt-faststart` only as the sibling of that canonical FFmpeg binary, require a regular executable file via the injected filesystem adapter, canonicalize it, and compute SHA-256 for both binaries. Record `{realPath, sha256}` for FFmpeg and `qt-faststart` in Preflight outputs/`doctor --json`; include both identities in the persisted environment fingerprint used by downstream provenance and cache decisions. Missing or unusable `qt-faststart` maps to `ENV_TOOL_MISSING` before `RunStore.createRun(projectId, runId)`.

Require `process.platform === 'darwin'`, `process.arch === 'arm64'`, macOS 15 or newer, H.264 encoding, AAC encoding, `loudnorm`, `silencedetect`, and `blackdetect`. Hash every configured font. Estimate required bytes as `max(sourceBytes * 3, 2 GiB)` and compare with `statfs()` before `RunStore.createRun(projectId, runId)`. Keep sibling resolution and hashing in `src/pipeline/stages/preflight.ts` for MVP; no additional probe helper or file/test whitelist expansion is required.

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

Expected: all tests pass, Project/Work/Run/Output scope forgery and cross-assignment fail typechecking as expected, Work/Run/Output scope escape and substitution fail closed, Work pointer/Run-creation confinement and Run/Output write-only/read-write exclusive-create tests pass, missing/non-executable `qt-faststart` returns `ENV_TOOL_MISSING`, tool hashes affect the environment fingerprint, pointer-failure tests preserve the previous pointer, lock tests never delete a live lock, and TypeScript exits 0.

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
