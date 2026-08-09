# Agent Video MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Execution split:** This master plan is retained as the cross-project reference. Execute work through `2026-08-09-agent-video-mvp-project-index.md` and its six linked project plans. The specification remains authoritative for behavior; each child plan is authoritative for its project task sequence and exit gate.

**Goal:** Build a macOS Apple Silicon local CLI that compiles `project.json`, `script.json`, and explicit `edit.json` into a reviewed 1080p H.264 video with local narration, BGM, captions, resumable stages, and auditable validation reports.

**Architecture:** Editable project inputs are validated with strict Zod schemas plus explicit cross-file invariants and compiled into immutable run artifacts. Remotion renders muted video only; FFmpeg owns narration normalization, BGM ducking, loudness, muxing, full-decode verification, and release packaging. A typed Stage registry builds the `assets`, `draft`, and `release` Presets and a read-only Execution Plan; the linear Runner consumes that plan using per-stage fingerprints, project locks, immutable run directories, and atomic `current.json` pointers instead of a general DAG.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript, React, Remotion, FFmpeg/ffprobe, Zod, Commander, Vitest.

---

## Delivery Checkpoints

1. **Checkpoint A — Muted video core:** strict project schemas, safe paths, ingest, timeline compile, and a muted Remotion draft.
2. **Checkpoint B — Narrated draft:** local TTS/file narration, segment captions, BGM ducking, draft muxing, and review records.
3. **Checkpoint C — Releasable MVP:** full validation, fingerprints, resume, locks, atomic release pointers, CLI, and end-to-end acceptance test.

## File Map

```text
package.json                              Scripts and dependency locks
tsconfig.json                             Strict TypeScript configuration
vitest.config.ts                          Unit and integration test configuration
remotion.config.ts                        Offline Remotion configuration
AGENTS.md                                 Workspace safety rules

src/cli/videoctl.ts                       Commander entry point
src/cli/exit-codes.ts                     Stable process exit codes
src/cli/output.ts                         Human and JSON output formatting

src/domain/mvp-profile.ts                 Fixed MVP media profile
src/domain/project-schema.ts              project.json schema
src/domain/script-schema.ts               script.json schema
src/domain/edit-schema.ts                 edit.json schema
src/domain/manifest-schema.ts             Generated manifest schemas
src/domain/timeline-schema.ts             Compiled timeline schema
src/domain/review-schema.ts               Review and approval schema
src/domain/load-project.ts                Strict input loading
src/domain/validate-authoring.ts           Cross-file script and edit invariants

src/fs/project-paths.ts                   Symlink-safe path resolution
src/fs/json-files.ts                      Atomic JSON read/write helpers

src/process/run-process.ts                Abortable argument-array subprocess runner
src/process/process-error.ts              Structured subprocess failure

src/pipeline/types.ts                     Check, report, and context types
src/pipeline/gate.ts                      Gate aggregation rules
src/pipeline/fingerprint.ts               Canonical JSON and SHA-256 fingerprints
src/pipeline/project-lock.ts              Single-writer project lock
src/pipeline/run-store.ts                 Immutable runs and atomic pointers
src/pipeline/stage.ts                     Stable Stage IDs and Stage contract
src/pipeline/stage-registry.ts            Ordered typed Stage registry
src/pipeline/presets.ts                   Built-in Stage subsets
src/pipeline/execution-plan.ts             Read-only numbered execution preview
src/pipeline/runner.ts                    Execution Plan consumer and resume logic
src/pipeline/stages/preflight.ts          Environment checks
src/pipeline/stages/ingest.ts             Asset ingest stage
src/pipeline/stages/narration.ts          Narration stage
src/pipeline/stages/compile.ts            Timeline compile stage
src/pipeline/stages/draft.ts              Draft render stage
src/pipeline/stages/review.ts             Review gate stage
src/pipeline/stages/release.ts            Final release stage

src/media/ffprobe.ts                      Typed ffprobe metadata
src/media/media-fixtures.ts               Test-only media generation helpers
src/media/transcode.ts                    Render-compatible asset copies
src/media/audio-mix.ts                    BGM envelope and audio mix
src/media/loudness.ts                     Two-pass loudnorm
src/media/contact-sheet.ts                Review frame extraction and tiling
src/media/release-verify.ts               Final stream and full-decode checks

src/providers/tts.ts                      TTS provider contract
src/providers/macos-say.ts                /usr/bin/say provider
src/providers/file-tts.ts                 Per-segment WAV provider
src/providers/mock-tts.ts                 Deterministic test provider

src/narration/build-narration.ts          Segment cache, normalization, concatenation
src/captions/build-captions.ts            One-segment/one-cue captions
src/captions/srt.ts                       SRT serialization
src/timeline/compile-timeline.ts           EDL compilation and bounds checks

src/remotion/index.ts                     registerRoot entry
src/remotion/Root.tsx                     Dynamic Composition metadata
src/remotion/ProjectComposition.tsx       Timeline renderer
src/remotion/registry.tsx                 Fixed component registry
src/remotion/components/BasicTitle.tsx    Registered title
src/remotion/components/Caption.tsx       Registered caption
src/remotion/render-video.ts              Bundle/select/render helper

tests/unit/**                              Pure unit tests
tests/integration/**                       FFmpeg, Remotion, lock, signal tests
tests/helpers/temp-project.ts              Isolated project fixture
projects/demo/**                           Runnable example project
```

## Task 1: Bootstrap the Toolchain and Test Harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `remotion.config.ts`
- Create: `src/domain/mvp-profile.ts`
- Test: `tests/unit/domain/mvp-profile.test.ts`

- [ ] **Step 1: Initialize and install exact dependencies**

Run:

```bash
pnpm init
pnpm add --save-exact react react-dom remotion @remotion/cli @remotion/bundler @remotion/renderer zod commander
pnpm add -D --save-exact typescript tsx vitest @types/node @types/react @types/react-dom
```

Expected: `package.json` and `pnpm-lock.yaml` are created, and all Remotion packages resolve to the same version.

- [ ] **Step 2: Replace package and compiler configuration**

`package.json` scripts and engine fields:

```json
{
  "name": "auto-cut-video",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@10.14.0",
  "engines": {
    "node": ">=22.17.0 <23"
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "video": "tsx src/cli/videoctl.ts",
    "remotion:studio": "remotion studio src/remotion/index.ts"
  }
}
```

Preserve the exact dependency versions written by pnpm.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests", "vitest.config.ts", "remotion.config.ts"]
}
```

`vitest.config.ts`:

```ts
import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 30_000,
  },
});
```

`remotion.config.ts`:

```ts
import {Config} from '@remotion/cli/config';

Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer('angle');
```

- [ ] **Step 3: Write the failing fixed-profile test**

```ts
import {describe, expect, it} from 'vitest';
import {MVP_PROFILE} from '../../../src/domain/mvp-profile';

describe('MVP_PROFILE', () => {
  it('pins the only supported release profile', () => {
    expect(MVP_PROFILE).toEqual({
      width: 1920,
      height: 1080,
      fps: 30,
      sampleRate: 48_000,
      pixelFormat: 'yuv420p',
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
  });
});
```

- [ ] **Step 4: Run the test and verify failure**

Run: `pnpm test tests/unit/domain/mvp-profile.test.ts`

Expected: FAIL because `src/domain/mvp-profile.ts` does not exist.

- [ ] **Step 5: Implement the fixed profile**

```ts
export const MVP_PROFILE = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48_000,
  pixelFormat: 'yuv420p',
  videoCodec: 'h264',
  audioCodec: 'aac',
} as const;
```

- [ ] **Step 6: Verify tests and types**

Run:

```bash
pnpm test tests/unit/domain/mvp-profile.test.ts
pnpm typecheck
```

Expected: PASS and exit code 0.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts remotion.config.ts src/domain/mvp-profile.ts tests/unit/domain/mvp-profile.test.ts
git commit -m "chore: bootstrap agent video toolchain"
```

## Task 2: Define Strict Authoring and Generated Schemas

**Files:**
- Create: `src/domain/project-schema.ts`
- Create: `src/domain/script-schema.ts`
- Create: `src/domain/edit-schema.ts`
- Create: `src/domain/manifest-schema.ts`
- Create: `src/domain/timeline-schema.ts`
- Create: `src/domain/review-schema.ts`
- Test: `tests/unit/domain/schemas.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
import {describe, expect, it} from 'vitest';
import {ProjectSchema} from '../../../src/domain/project-schema';
import {ScriptSchema} from '../../../src/domain/script-schema';
import {EditSchema} from '../../../src/domain/edit-schema';

const project = {
  version: 1,
  id: 'demo',
  composition: {
    width: 1920,
    height: 1080,
    fps: 30,
    backgroundColor: '#000000',
    allowBackgroundGaps: false,
  },
  tts: {provider: 'macos-say', voice: 'Tingting', rate: 180},
  captions: {
    font: 'assets/fonts/NotoSansSC-Bold.otf',
    fontSize: 54,
    color: '#FFFFFF',
    bottomMargin: 90,
    maximumChineseCharacters: 28,
  },
  audio: {
    sampleRate: 48000,
    targetLufs: -16,
    truePeakDb: -1.5,
    backgroundMusicGainDb: -20,
    duckDuringNarrationDb: -12,
    duckAttackMs: 120,
    duckReleaseMs: 250,
  },
  render: {draftWidth: 960, draftHeight: 540, videoCodec: 'h264', pixelFormat: 'yuv420p'},
};

describe('authoring schemas', () => {
  it('accepts the fixed MVP project', () => {
    expect(ProjectSchema.parse(project).id).toBe('demo');
  });

  it('rejects unsupported output dimensions', () => {
    expect(() => ProjectSchema.parse({...project, composition: {...project.composition, width: 1280}})).toThrow();
  });

  it('rejects unknown fields', () => {
    expect(() => ProjectSchema.parse({...project, remoteUrl: 'https://example.com'})).toThrow();
  });

  it('accepts stable script segments without hard-coding the project display limit', () => {
    expect(ScriptSchema.parse({
      version: 1,
      language: 'zh-CN',
      segments: [{id: 'intro', text: '测'.repeat(29), normalizedText: '测'.repeat(29), pauseAfterMs: 300, requiredTerms: []}],
    }).segments[0]?.id).toBe('intro');
  });

  it('accepts an explicit video edit decision', () => {
    expect(EditSchema.parse({
      version: 1,
      visualClips: [{
        id: 'clip', kind: 'video', assetId: 'camera-a', startFrame: 0,
        durationInFrames: 30, sourceInMs: 0, sourceOutMs: 1000, fit: 'cover',
        position: {x: 0, y: 0}, scale: 1, opacity: 1, fadeInFrames: 0,
        fadeOutFrames: 0, zIndex: 0,
      }],
      overlays: [],
    }).visualClips).toHaveLength(1);
  });

  it('rejects a reversed video trim', () => {
    expect(() => EditSchema.parse({
      version: 1,
      visualClips: [{
        id: 'clip', kind: 'video', assetId: 'camera-a', startFrame: 0,
        durationInFrames: 30, sourceInMs: 1000, sourceOutMs: 1000, fit: 'cover',
        position: {x: 0, y: 0}, scale: 1, opacity: 1, fadeInFrames: 0,
        fadeOutFrames: 0, zIndex: 0,
      }],
      overlays: [],
    })).toThrow(/sourceOutMs must be greater than sourceInMs/);
  });

  it('rejects absolute authoring paths', () => {
    expect(() => ProjectSchema.parse({
      ...project,
      captions: {...project.captions, font: '/tmp/font.otf'},
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test tests/unit/domain/schemas.test.ts`

Expected: FAIL because schema modules do not exist.

- [ ] **Step 3: Implement the project and script schemas**

`src/domain/project-schema.ts`:

```ts
import {z} from 'zod';

const RelativePathSchema = z.string().min(1).refine((value) => !value.startsWith('/') && !value.includes('..'), 'must be a project-relative path');

export const ProjectSchema = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  composition: z.object({
    width: z.literal(1920),
    height: z.literal(1080),
    fps: z.literal(30),
    backgroundColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    allowBackgroundGaps: z.boolean(),
  }).strict(),
  tts: z.object({
    provider: z.enum(['macos-say', 'file', 'mock']),
    voice: z.string().min(1),
    rate: z.number().int().min(80).max(400),
  }).strict(),
  captions: z.object({
    font: RelativePathSchema,
    fontSize: z.number().int().min(16).max(120),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    bottomMargin: z.number().int().min(0).max(400),
    maximumChineseCharacters: z.number().int().min(8).max(40),
  }).strict(),
  audio: z.object({
    sampleRate: z.literal(48_000),
    targetLufs: z.number().min(-24).max(-10),
    truePeakDb: z.number().min(-3).max(-0.1),
    backgroundMusicGainDb: z.number().min(-60).max(0),
    duckDuringNarrationDb: z.number().min(-30).max(0),
    duckAttackMs: z.number().int().min(0).max(2_000),
    duckReleaseMs: z.number().int().min(0).max(5_000),
  }).strict(),
  render: z.object({
    draftWidth: z.literal(960),
    draftHeight: z.literal(540),
    videoCodec: z.literal('h264'),
    pixelFormat: z.literal('yuv420p'),
  }).strict(),
}).strict();

export type Project = z.infer<typeof ProjectSchema>;
```

`src/domain/script-schema.ts`:

```ts
import {z} from 'zod';

const RelativePathSchema = z.string().min(1).refine((value) => !value.startsWith('/') && !value.includes('..'));

export const ScriptSegmentSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  text: z.string().min(1),
  normalizedText: z.string().min(1),
  pauseAfterMs: z.number().int().min(0).max(5_000),
  requiredTerms: z.array(z.string().min(1)),
  audioPath: RelativePathSchema.optional(),
  notes: z.object({visualHint: z.string().min(1)}).strict().optional(),
}).strict();

export const ScriptSchema = z.object({
  version: z.literal(1),
  language: z.literal('zh-CN'),
  segments: z.array(ScriptSegmentSchema).min(1).superRefine((segments, context) => {
    const ids = new Set<string>();
    for (const segment of segments) {
      if (ids.has(segment.id)) context.addIssue({code: 'custom', message: `duplicate segment id: ${segment.id}`});
      ids.add(segment.id);
    }
  }),
}).strict();

export type Script = z.infer<typeof ScriptSchema>;
export type ScriptSegment = z.infer<typeof ScriptSegmentSchema>;
```

- [ ] **Step 4: Implement the edit schema**

`src/domain/edit-schema.ts`:

```ts
import {z} from 'zod';

const IdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const AssetIdSchema = IdSchema;
const TimelineBaseSchema = z.object({
  id: IdSchema,
  assetId: AssetIdSchema,
  startFrame: z.number().int().nonnegative(),
  durationInFrames: z.number().int().positive(),
  fit: z.enum(['cover', 'contain']),
  position: z.object({x: z.number(), y: z.number()}).strict(),
  scale: z.number().positive().max(10),
  opacity: z.number().min(0).max(1),
  fadeInFrames: z.number().int().nonnegative(),
  fadeOutFrames: z.number().int().nonnegative(),
  zIndex: z.number().int(),
});

export const VisualClipSchema = z.discriminatedUnion('kind', [
  TimelineBaseSchema.extend({
    kind: z.literal('video'),
    sourceInMs: z.number().int().nonnegative(),
    sourceOutMs: z.number().int().positive(),
  }).strict(),
  TimelineBaseSchema.extend({kind: z.literal('image')}).strict(),
]).superRefine((clip, context) => {
  if (clip.kind === 'video' && clip.sourceInMs >= clip.sourceOutMs) {
    context.addIssue({
      code: 'custom',
      path: ['sourceOutMs'],
      message: 'sourceOutMs must be greater than sourceInMs',
    });
  }
});

export const EditSchema = z.object({
  version: z.literal(1),
  visualClips: z.array(VisualClipSchema).min(1),
  overlays: z.array(z.object({
    id: IdSchema,
    component: IdSchema,
    startFrame: z.number().int().nonnegative(),
    durationInFrames: z.number().int().positive(),
    props: z.record(z.string(), z.unknown()),
    zIndex: z.number().int(),
  }).strict()),
  backgroundMusic: z.object({assetId: AssetIdSchema, startMs: z.number().int().nonnegative()}).strict().optional(),
}).strict().superRefine((edit, context) => {
  const ids = new Set<string>();
  for (const item of [...edit.visualClips, ...edit.overlays]) {
    if (ids.has(item.id)) context.addIssue({code: 'custom', message: `duplicate timeline id: ${item.id}`});
    ids.add(item.id);
  }
});

export type Edit = z.infer<typeof EditSchema>;
export type VisualClip = z.infer<typeof VisualClipSchema>;
```

- [ ] **Step 5: Implement generated schemas with the exact fields from the spec**

`src/domain/manifest-schema.ts` must export strict Zod schemas and inferred types for:

```ts
export type AssetCompatibility = 'direct' | 'transcoded' | 'rejected';

export interface AssetRecord {
  kind: 'video' | 'image' | 'audio';
  sourcePath: string;
  sourceHash: string;
  renderPath: string;
  durationMs?: number;
  width?: number;
  height?: number;
  videoCodec?: string;
  pixelFormat?: string;
  colorSpace?: string;
  hasAudio?: boolean;
  variableFrameRate?: boolean;
  compatibility: AssetCompatibility;
}

export interface NarrationSegmentRecord {
  id: string;
  inputHash: string;
  audioPath: string;
  audioHash: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  pauseAfterMs: number;
  sampleRate: 48000;
  channels: 1;
  providerFingerprint: string;
}

export interface AssetManifest {
  version: 1;
  assets: Record<string, AssetRecord>;
}

export interface NarrationManifest {
  version: 1;
  provider: 'macos-say' | 'file' | 'mock';
  segments: NarrationSegmentRecord[];
  master: {audioPath: string; audioHash: string; durationMs: number};
}

export interface CaptionCue {
  id: string;
  segmentId: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface CaptionsManifest {
  version: 1;
  sourceNarrationHash: string;
  cues: CaptionCue[];
}
```

Implement strict Zod objects corresponding to every interface above and export inferred types rather than maintaining separate handwritten runtime and compile-time shapes.

`src/domain/timeline-schema.ts` must implement this exact compile-time shape as a strict Zod schema:

```ts
export interface CompiledTimeline {
  version: 1;
  projectId: string;
  width: 1920;
  height: 1080;
  fps: 30;
  durationInFrames: number;
  inputHashes: Record<string, string>;
  visualClips: Array<{
    id: string;
    kind: 'video' | 'image';
    renderPath: string;
    startFrame: number;
    durationInFrames: number;
    sourceInMs?: number;
    fit: 'cover' | 'contain';
    position: {x: number; y: number};
    scale: number;
    opacity: number;
    fadeInFrames: number;
    fadeOutFrames: number;
    zIndex: number;
  }>;
  overlays: Array<{
    id: string;
    component: string;
    startFrame: number;
    durationInFrames: number;
    props: Record<string, unknown>;
    zIndex: number;
  }>;
  captions: Array<{
    id: string;
    segmentId: string;
    text: string;
    startFrame: number;
    endFrame: number;
  }>;
  narration: {
    audioPath: string;
    durationMs: number;
    intervals: Array<{segmentId: string; startMs: number; endMs: number}>;
  };
  backgroundMusic?: {renderPath: string; startMs: number; durationMs: number};
}
```

The frozen P01 Schema stores narration intervals plus BGM metadata only. It has no Ducking interval/envelope field; P04 derives that envelope deterministically from these fields, Composition duration, `project.audio`, and an explicit algorithm version.

`src/domain/review-schema.ts`:

```ts
import {z} from 'zod';

export const ReviewSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  projectId: z.string().min(1),
  status: z.enum(['approved', 'rejected']),
  reviewer: z.string().min(1),
  reviewedAt: z.string().datetime(),
  reason: z.string().min(1),
  evidencePaths: z.array(z.string().min(1)).min(1),
}).strict();

export type Review = z.infer<typeof ReviewSchema>;
```

- [ ] **Step 6: Verify schemas**

Run:

```bash
pnpm test tests/unit/domain/schemas.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain tests/unit/domain/schemas.test.ts
git commit -m "feat: define strict video project schemas"
```

## Task 3: Add Symlink-Safe Paths and Project Loading

**Files:**
- Create: `src/fs/project-paths.ts`
- Create: `src/fs/json-files.ts`
- Create: `src/domain/load-project.ts`
- Create: `src/domain/validate-authoring.ts`
- Create: `tests/helpers/temp-project.ts`
- Test: `tests/unit/fs/project-paths.test.ts`
- Test: `tests/unit/fs/project-directory-scope.test.ts`
- Test: `tests/unit/fs/json-files.test.ts`
- Test: `tests/unit/domain/load-project.test.ts`
- Test: `tests/unit/domain/load-project-root.test.ts`
- Test: `tests/unit/domain/validate-authoring.test.ts`
- Test: `tests/unit/helpers/temp-project.test.ts`

- [ ] **Step 1: Write handle-based path race tests**

Target macOS 15+ only. Tests must exercise real `fs.open()` behavior rather than assert a numeric constant:

- canonical in-root reads and exclusive creates succeed through `FileHandle` APIs;
- the async Scope factory rejects an initial project root resolving outside the canonical workspace root;
- project-internal symlinks into workspace siblings fail for read and write;
- lexical project-link replacement cannot expand an established Scope, and canonical-root symlink replacement fails closed;
- final and ancestor symlinks resolving outside the project fail;
- a stable internal symlink is canonicalized and can be opened safely;
- after canonicalization, replacing the canonical parent with an external symlink makes the final open fail and does not create the external file;
- static writable target symlinks become `ProjectPathError`, while a regular target appearing after preparation preserves `EEXIST`;
- non-Darwin calls fail before filesystem access with `ENV_PLATFORM_UNSUPPORTED`;
- every opened handle is closed in `finally`, and every temporary directory is registered with `onTestFinished()` or cleaned in `finally`.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test tests/unit/fs/project-directory-scope.test.ts tests/unit/fs/project-paths.test.ts`

Expected: FAIL because the handle/capability API and open-time substitution defense do not exist.

- [ ] **Step 3: Implement Darwin no-follow handle capabilities**

Use Darwin `O_NOFOLLOW_ANY = 0x20000000` as a numeric Node 22 open flag. Path-only canonicalization helpers remain module-private and never authorize production I/O.

- `createProjectDirectoryScope(workspaceRoot, projectRelativeRoot)` is the only async factory for the opaque `ProjectDirectoryScope`; the class carries a true private instance brand (`#private` or `declare private`), not merely a private constructor, so `{}` cannot satisfy the type under strict TypeScript. It stores the canonical project root only in class-private/module-private state and exposes no path string.
- `prepareExistingProjectFile()` and `openExistingProjectFile(projectDirectory, relativePath)` canonicalize the saved root and target, verify project containment, then open the canonical target with `O_RDONLY | O_NOFOLLOW_ANY`.
- `prepareNewProjectFile()` and `openNewProjectFile(projectDirectory, relativePath)` canonicalize the saved root and real parent, check a static final symlink with `lstat`, then open `parentReal + basename` with `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW_ANY` and mode `0o600`.
- Safe prepared capabilities may be exposed for staged operations and deterministic race tests, but they expose only `open()` and never a path string.
- Map canonicalization/open `ELOOP` to `ProjectPathError`; preserve ordinary `EEXIST` from exclusive create races.
- Reject non-Darwin platforms with `ENV_PLATFORM_UNSUPPORTED` before any path lookup.

Never call `writeFile()` directly on a user-derived writable target. Immutable artifacts use `openNewProjectFile()`. Pointer replacement uses a same-directory temporary capability, sync, and atomic rename.

Threat boundary: this prevents symlink traversal and symlink substitution between canonicalization and open. It does not claim to prevent hard-link substitution, replacement with ordinary directories or mount points, or concurrent modification of an already opened file's contents. Project Scope never authorizes `.work` or `output`; P02 supplies separate app-owned scopes.

- [ ] **Step 4: Implement JSON loading and project context**

`readJson(projectDirectory, filePath, schema)` must obtain a `FileHandle` from `openExistingProjectFile()`, read from that same handle, and always close it. The path is relative to the project root and the function owns the handle. Wrap open, read, JSON, and Zod failures in `JsonFileError` containing `filePath` and the primary `cause`. A simultaneous close failure is attached as `closeCause` without replacing that primary cause; a close-only failure also becomes a `JsonFileError` with `filePath` and consistent close diagnostics.

`src/domain/load-project.ts` rejects invalid IDs, creates one Scope from `workspaceRootReal + projects/<id>`, reads `project.json`, `script.json`, and `edit.json` relative to that Scope, returns `projectDirectory`, and exposes no public `projectRoot` string.

```ts
export interface ProjectInputs {
  workspaceRoot: string;
  projectDirectory: ProjectDirectoryScope;
  project: Project;
  script: Script;
  edit: Edit;
}
```

Downstream project file access must retain `projectDirectory`; generated Run/Output artifacts use their own app-owned scopes.

Check `project.json` ID mismatch immediately after its Schema parse, before reading `script.json` or `edit.json`. After all three Schemas pass, call `validateAuthoringInputs()`. Count `segment.text` with `Intl.Segmenter('zh-CN', {granularity: 'grapheme'})`; throw `SCRIPT_SEGMENT_TEXT_TOO_LONG` when a segment exceeds `project.captions.maximumChineseCharacters`.

- [ ] **Step 5: Add loader tests and verify**

Tests must prove valid files load, malformed JSON and unknown fields retain their causes through `JsonFileError`, project IDs cannot contain `/` or `..`, ID mismatch wins over damaged later files, every authoring read uses the same opaque Scope with project-relative file names, and cross-file validation runs only after all three Schemas pass. Add `@ts-expect-error` coverage proving `{}` cannot forge `ProjectDirectoryScope`. Verify handle closure on success, JSON failure, and Zod failure, plus JSON+close, Zod+close, and close-only failures with primary-error precedence. `createTempProject()` must remove a partially initialized workspace before rethrowing.

Run:

```bash
pnpm test tests/unit/fs/project-directory-scope.test.ts tests/unit/fs/project-paths.test.ts tests/unit/fs/json-files.test.ts tests/unit/domain/load-project.test.ts tests/unit/domain/load-project-root.test.ts tests/unit/domain/validate-authoring.test.ts tests/unit/helpers/temp-project.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fs src/domain/load-project.ts src/domain/validate-authoring.ts tests/helpers tests/unit/fs tests/unit/domain/load-project.test.ts tests/unit/domain/load-project-root.test.ts tests/unit/domain/validate-authoring.test.ts tests/unit/helpers/temp-project.test.ts
git commit -m "fix: enforce project directory file scopes"
```

## Task 4: Build the Abortable Process Runner and Gate Protocol

**Files:**
- Create: `src/process/process-error.ts`
- Create: `src/process/run-process.ts`
- Create: `src/pipeline/types.ts`
- Create: `src/pipeline/gate.ts`
- Test: `tests/unit/process/run-process.test.ts`
- Test: `tests/unit/pipeline/gate.test.ts`

- [ ] **Step 1: Write failing process tests**

```ts
import {describe, expect, it} from 'vitest';
import {runProcess} from '../../../src/process/run-process';

describe('runProcess', () => {
  it('passes arguments without shell interpolation', async () => {
    const result = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', '$(touch /tmp/should-not-exist)']);
    expect(result.stdout.trim()).toBe('$(touch /tmp/should-not-exist)');
  });

  it('times out and reports the structured reason', async () => {
    await expect(runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {timeoutMs: 30}))
      .rejects.toMatchObject({code: 'PROCESS_TIMEOUT'});
  });

  it('honors AbortSignal', async () => {
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {signal: controller.signal});
    controller.abort();
    await expect(pending).rejects.toMatchObject({code: 'PROCESS_ABORTED'});
  });
});
```

Add table-driven Darwin regressions for abort and timeout where the leader uses default `SIGTERM` behavior but a ready-signaled grandchild ignores `SIGTERM`; assert the grandchild is already gone when the Runner Promise settles. Add borrowed-FD tests for child reads/writes, `3 + index` mapping, invalid descriptors, post-call array mutation, spawn failure, and caller ownership after normal, nonzero, abort, and timeout outcomes. A stale FD from an already closed handle must fail before child side effects with `PROCESS_SPAWN_FAILED` and `cause.code === 'EBADF'`; a caller may close its handle immediately after `runProcess()` returns because validation and spawn have already occurred synchronously.

- [ ] **Step 2: Implement the runner**

`runProcess()` must use `spawn(command, args, {shell: false})`, collect capped stdout/stderr, kill the process group on timeout or abort, and return:

```ts
export interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}
```

`RunProcessOptions.extraStdioFds?: readonly number[]` snapshots and validates nonnegative integer parent FDs, synchronously calls `fstatSync()` on each snapshot before creating pipes or invoking `spawn()`, then maps index `i` to child FD `3 + i`. Closed/stale descriptors fail as `PROCESS_SPAWN_FAILED` with the original `EBADF` cause and no child command side effects. Every FD remains borrowed: the caller opens a fresh handle per independent consumer and closes it in `finally`; the Runner never seeks or closes it.

Reject non-zero exits with `ProcessExecutionError` carrying `PROCESS_EXIT_NONZERO`, and use `PROCESS_TIMEOUT` and `PROCESS_ABORTED` for those conditions. Once Darwin termination starts, settle only after leader `close` and process-group probe `ESRCH`; success/`EPERM` means alive, grace expiry sends group `SIGKILL`, and unexpected probe/kill errors or final timeout retain the original abort/timeout code with structured reason/cause.

- [ ] **Step 3: Write failing Gate tests**

```ts
import {describe, expect, it} from 'vitest';
import {aggregateChecks} from '../../../src/pipeline/gate';

describe('aggregateChecks', () => {
  it('fails on any error', () => {
    expect(aggregateChecks([{id: 'decode', severity: 'error', message: 'failed'}])).toBe('failed');
  });

  it('requires review for configured warnings', () => {
    expect(aggregateChecks([{id: 'black-frame', severity: 'warning', message: 'detected', requiresReview: true}])).toBe('needs_review');
  });

  it('passes informational checks', () => {
    expect(aggregateChecks([{id: 'hash', severity: 'info', message: 'ok'}])).toBe('passed');
  });
});
```

- [ ] **Step 4: Implement protocol types and Gate aggregation**

Define exact unions from the spec:

```ts
export type StageState = 'pending' | 'running' | 'cached' | 'skipped' | 'passed' | 'needs_review' | 'failed' | 'cancelled';
export type CheckSeverity = 'info' | 'warning' | 'error';

export interface CheckResult {
  id: string;
  severity: CheckSeverity;
  message: string;
  requiresReview?: boolean;
  value?: string | number | boolean;
  expected?: string | number | boolean;
  affectedPaths?: string[];
  suggestedAction?: string;
}
```

`aggregateChecks()` returns `failed` for any error, `needs_review` for a warning with `requiresReview`, otherwise `passed`.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test tests/unit/process/run-process.test.ts tests/unit/pipeline/gate.test.ts
pnpm typecheck
git add src/process src/pipeline/types.ts src/pipeline/gate.ts tests/unit/process tests/unit/pipeline/gate.test.ts
git commit -m "fix: complete process group and fd protocol"
```

### P01 Boundary Verification

```bash
pnpm test
pnpm typecheck
git diff --check
```

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

Define opaque `RunDirectoryScope` and `OutputDirectoryScope` values created only by async factories from a trusted canonical `workspaceRoot` plus an app-owned relative root. Each class has its own true private instance brand (`#private` or `declare private`), not merely a private constructor. Strict `@ts-expect-error` regressions reject `{}` forgery and all six cross-assignments among Project, Run, and Output scopes. The factory rejects an initial canonical root outside the canonical workspace. Store the canonical scope root only in a class `#private` field or module-private `WeakMap`; scope APIs accept only Run- or Output-relative paths and never expose/reaccept the root string as authority.

Both app-owned scopes expose existing-file read, exclusive write-only new-file, and exclusive read-write new-file capabilities. The read-write form opens with `O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW_ANY` and mode `0o600`. Release uses it through `RunDirectoryScope` for FFmpeg's seekable write-once intermediate MP4 and through `OutputDirectoryScope` for `qt-faststart`'s exclusive final output. Table-driven tests cover an initial canonical root outside the workspace, read/write escape through symlinks, lexical-root substitution after scope creation, canonical-root replacement with an external symlink, write-only and read-write exclusive create, read-write seek/readback permissions, and symbolic links at work/output pointer paths. Existing/new opens canonicalize the target or real parent, re-check containment against the saved canonical root, and use Darwin `O_NOFOLLOW_ANY`. FDs remain borrowed: each consumer opens a fresh handle from its owning scope and closes it in `finally` after success, failure, abort, or timeout.

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

`RunStore.createRun()` creates `.work/<project>/runs/<runId>` and returns its opaque `RunDirectoryScope`, never a root string. Add a safe `RunStore.openExistingRun()` that recreates authority only through the trusted workspace/app-root factory. `RunStore` retains module-private authority for `.work/<project>/current.json` and `pipeline.lock` without exposing that app-owned root as a string or per-Run scope. Stage output files are write-once; later stages append new files without overwriting earlier artifacts. Release creation/publication uses a separate `OutputDirectoryScope` rooted at `output/<project>`. Project, Run, and Output scopes are not interchangeable. FFmpeg's intermediate MP4 uses the Run scope's exclusive read-write capability; `qt-faststart` final output uses the Output scope's exclusive read-write capability; ordinary immutable files may use write-only creation. `publishCurrent()` opens a new same-directory `current.json.tmp` with no-follow/exclusive flags, writes and calls `sync()` on the file handle, atomically renames it, syncs the parent directory, and removes the temporary file on failure. Reject a symbolic link at either pointer path instead of following it.

Use the same helper for `output/<project>/current.json`, whose `relativePath` points at `releases/<runId>` and whose `completedStage` is always `release`.

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

Also cover canonical resolution of the configured/PATH-selected FFmpeg executable, sibling lookup of `<ffmpeg-real-dir>/qt-faststart`, regular-file/executable checks, and binary hashing. Missing, non-regular, or non-executable `qt-faststart` must return `ENV_TOOL_MISSING`. `doctor --json` exposes resolved FFmpeg/`qt-faststart` real paths and SHA-256 values, and changing either binary hash changes the environment fingerprint.

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

Resolve FFmpeg once through the injected executable resolver, canonicalize it with `realpath`, and execute every FFmpeg probe through that path. Derive only `<ffmpeg-real-dir>/qt-faststart`, require it to be a regular executable through the injected filesystem adapter, canonicalize it, and compute SHA-256 for both binaries. Persist their `{realPath, sha256}` records in Preflight outputs/`doctor --json` and include both in the environment fingerprint consumed by downstream provenance and cache decisions. Missing or unusable `qt-faststart` maps to `ENV_TOOL_MISSING` before `RunStore.createRun()`.

Require `process.platform === 'darwin'`, `process.arch === 'arm64'`, macOS 15 or newer, H.264 encoding, AAC encoding, `loudnorm`, `silencedetect`, and `blackdetect`. Hash every configured font. Estimate required bytes as `max(sourceBytes * 3, 2 GiB)` and compare with `statfs()` before `RunStore.createRun()`. Keep sibling resolution and hashing in `src/pipeline/stages/preflight.ts`; MVP does not add a separate probe helper or expand the file/test whitelist.

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

`videoctl doctor <project>` loads the project, runs Preflight, prints a table by default or JSON with `--json`, including FFmpeg/`qt-faststart` real paths, binary hashes, and the environment fingerprint, and exits with `environmentFailed` for errors. Missing or non-executable `qt-faststart` reports `ENV_TOOL_MISSING`.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test tests/unit/pipeline/preflight.test.ts tests/unit/cli/doctor.test.ts
pnpm typecheck
git add src/pipeline/stages/preflight.ts src/cli tests/unit/pipeline/preflight.test.ts tests/unit/cli
git commit -m "feat: add environment doctor command"
```

## Task 7: Implement ffprobe Ingest and Conditional Transcoding

**Files:**
- Create: `src/media/ffprobe.ts`
- Create: `src/media/transcode.ts`
- Create: `src/pipeline/stages/ingest.ts`
- Create: `tests/helpers/media-fixtures.ts`
- Test: `tests/unit/media/ffprobe.test.ts`
- Test: `tests/unit/media/compatibility.test.ts`
- Test: `tests/integration/pipeline/ingest.test.ts`

- [ ] **Step 1: Add deterministic media fixture helpers**

Use FFmpeg commands through `runProcess()`:

```ts
export async function createTestVideo(output: string, seconds = 2): Promise<void> {
  await runProcess('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=30:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-c:a', 'aac', '-shortest', output,
  ]);
}
```

Also add `createTestMusic()` using a 48kHz sine source and `createTestImage()` using FFmpeg `color` input.

- [ ] **Step 2: Write ffprobe parsing tests**

The parser must accept `ffprobe -v error -print_format json -show_format -show_streams` output and return duration milliseconds, video/audio streams, codecs, pixel format, dimensions, frame-rate rationals, color fields, and rotation.

- [ ] **Step 3: Implement metadata and compatibility classification**

`classifyVideo()` returns:

```ts
type CompatibilityDecision =
  | {compatibility: 'direct'}
  | {compatibility: 'transcoded'; reasons: string[]}
  | {compatibility: 'rejected'; errorCode: 'ASSET_HDR_UNSUPPORTED' | 'ASSET_DECODE_FAILED'; reasons: string[]};
```

Reject 10-bit, HDR transfer functions, Dolby Vision, and missing color metadata. Direct-use video must be H.264, `yuv420p`, SDR BT.709, non-VFR, and decodable. Other supported SDR video becomes `transcoded`.

- [ ] **Step 4: Implement safe render-copy transcoding**

Use:

```text
ffmpeg -y -i <source> -map 0:v:0 -an -vf fps=30,format=yuv420p \
  -c:v libx264 -crf 18 -preset medium \
  -color_primaries bt709 -color_trc bt709 -colorspace bt709 <render-copy.mp4>
```

Write to the current immutable run directory, never next to the source.

- [ ] **Step 5: Implement Ingest**

Open each source through `openExistingProjectFile(projectDirectory, projectRelativePath)`. Hashing, ffprobe, sample-decode, transcode, and final hash verification each open a fresh handle from `ProjectDirectoryScope`; generated manifests/render copies open fresh handles from `RunDirectoryScope`; any release publication opens fresh handles from `OutputDirectoryScope`. Scope kinds are not interchangeable. Child processes map every read and write FD through `extraStdioFds`; for example source child FD 3 is `/dev/fd/3` and a Run-scope output child FD 4 is `pipe:4` or `/dev/fd/4`. Each FD/pipe is one-shot and caller-owned, closes in `finally`, and is never reopened from a resolved string.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test tests/unit/media tests/integration/pipeline/ingest.test.ts
pnpm typecheck
git add src/media src/pipeline/stages/ingest.ts tests/helpers/media-fixtures.ts tests/unit/media tests/integration/pipeline/ingest.test.ts
git commit -m "feat: ingest and normalize local media"
```

Checkpoint A now has safe media inputs but not rendering.

## Task 8: Implement TTS Providers and Narration Segment Caching

**Files:**
- Create: `src/providers/tts.ts`
- Create: `src/providers/macos-say.ts`
- Create: `src/providers/file-tts.ts`
- Create: `src/providers/mock-tts.ts`
- Create: `src/narration/build-narration.ts`
- Create: `src/pipeline/stages/narration.ts`
- Test: `tests/unit/providers/tts-contract.test.ts`
- Test: `tests/unit/narration/build-narration.test.ts`
- Test: `tests/integration/providers/macos-say.test.ts`

- [ ] **Step 1: Define and contract-test the provider interface**

```ts
export interface TtsInput {
  segmentId: string;
  text: string;
  voice: string;
  rate: number;
  outputPath: string;
  sourceAudioPath?: string;
}

export interface TtsResult {
  outputPath: string;
  providerFingerprint: string;
}

export interface TtsProvider {
  readonly id: 'macos-say' | 'file' | 'mock';
  capabilities(): Promise<{languages: string[]; voices: string[]}>;
  fingerprint(): Promise<string>;
  synthesize(input: TtsInput, signal: AbortSignal): Promise<TtsResult>;
}
```

Run the same contract tests against Mock and File providers. Verify cancellation, deterministic fingerprinting, missing input failure, and non-empty output. `FileTtsProvider` must require `sourceAudioPath`, open a fresh read handle through `ProjectDirectoryScope`, pass it through `extraStdioFds`, close it in `finally`, and copy through a separate fresh `RunDirectoryScope` handle. Project inputs, Run artifacts, and Output publications always use their owning scope and are never reopened from resolved strings.

- [ ] **Step 2: Implement MacOsSayProvider**

Call `/usr/bin/say` with an argument array:

```text
/usr/bin/say -v <voice> -r <rate> -o <segment.aiff> <normalizedText>
```

Convert to WAV using FFmpeg, then delete the AIFF. The provider fingerprint includes macOS version, selected voice, `say` binary metadata, and rate. The integration test runs only when `RUN_SYSTEM_TTS_TESTS=1` and verifies a configured Chinese voice produces decodable audio.

- [ ] **Step 3: Write failing narration cache tests**

Cover unchanged segment reuse, one-segment invalidation, stable script order, total duration including pauses, and rejection of a segment longer than 7,000ms.

- [ ] **Step 4: Implement segment normalization and cache keys**

For each segment, fingerprint:

```ts
fingerprintValue({
  segmentId: segment.id,
  normalizedText: segment.normalizedText,
  voice: project.tts.voice,
  rate: project.tts.rate,
  providerFingerprint,
  sampleRate: 48_000,
  channels: 1,
});
```

Normalize provider output to 48kHz mono PCM WAV. Probe duration, calculate a 10ms fade-out start as `max(0, durationSeconds - 0.01)`, and apply non-overlapping in/out fades.

- [ ] **Step 5: Concatenate narration without overlap**

For every segment, create a padded normalized WAV whose duration is `segmentDuration + pauseAfterMs`. Store them beside the concat list under a controlled run directory using generated names such as `0001-intro.wav`; list only these relative names in script order and keep `-safe 1`. Never place project absolute paths or original user filenames in the concat list. Add an integration test whose project root contains spaces. Record each segment `startMs`, `endMs`, and pause in `narration-manifest.json`.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test tests/unit/providers tests/unit/narration
pnpm typecheck
git add src/providers src/narration src/pipeline/stages/narration.ts tests/unit/providers tests/unit/narration tests/integration/providers
git commit -m "feat: generate cached local narration"
```

## Task 9: Build Segment Captions and Exact Time Conversion

**Files:**
- Create: `src/captions/build-captions.ts`
- Create: `src/captions/srt.ts`
- Test: `tests/unit/captions/build-captions.test.ts`
- Test: `tests/unit/captions/srt.test.ts`

- [ ] **Step 1: Write boundary tests from the reviewed specification**

```ts
import {describe, expect, it} from 'vitest';
import {millisecondsToFrameRange} from '../../../src/captions/build-captions';

describe('millisecondsToFrameRange', () => {
  it('does not expand exact frame boundaries', () => {
    expect(millisecondsToFrameRange(1000, 2000, 30)).toEqual({startFrame: 30, endFrame: 60});
  });

  it('expands each non-aligned boundary by less than one frame', () => {
    expect(millisecondsToFrameRange(1, 34, 30)).toEqual({startFrame: 0, endFrame: 2});
  });

  it('always produces at least one frame', () => {
    expect(millisecondsToFrameRange(100, 101, 30)).toEqual({startFrame: 3, endFrame: 4});
  });
});
```

- [ ] **Step 2: Implement frame conversion and caption creation**

```ts
export function millisecondsToFrameRange(startMs: number, endMs: number, fps: number) {
  const startFrame = Math.floor(startMs * fps / 1000);
  const rawEndFrame = Math.ceil(endMs * fps / 1000);
  return {startFrame, endFrame: Math.max(startFrame + 1, rawEndFrame)};
}
```

Create one cue per script segment by joining script text to narration timing through stable segment ID. Fail when either side has a missing or duplicate ID.

- [ ] **Step 3: Implement SRT formatting**

Serialize ordered cues with CRLF-independent deterministic output, `HH:MM:SS,mmm` timestamps, blank lines between cues, and a final newline. Add tests for times over one hour and millisecond zero-padding.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test tests/unit/captions
pnpm typecheck
git add src/captions tests/unit/captions
git commit -m "feat: generate segment captions and srt"
```

## Task 10: Compile the EDL and Fixed Component Registry

**Files:**
- Create: `src/remotion/registry.tsx`
- Create: `src/remotion/components/BasicTitle.tsx`
- Create: `src/remotion/components/Caption.tsx`
- Create: `src/timeline/compile-timeline.ts`
- Create: `src/pipeline/stages/compile.ts`
- Test: `tests/unit/timeline/compile-timeline.test.ts`
- Test: `tests/unit/remotion/registry.test.tsx`

- [ ] **Step 1: Write failing compiler tests**

Cover these exact outcomes:

```ts
it('rejects a video trim outside the source duration', () => {
  expect(() => compileTimeline(fixture({sourceOutMs: 60_001, assetDurationMs: 60_000})))
    .toThrowError(/EDIT_TRIM_OUT_OF_BOUNDS/);
});

it('rejects a reversed video trim defensively', () => {
  expect(() => compileTimeline(fixture({sourceInMs: 5_000, sourceOutMs: 3_000, assetDurationMs: 60_000})))
    .toThrowError(/EDIT_TRIM_OUT_OF_BOUNDS/);
});

it('rejects an unregistered overlay component', () => {
  expect(() => compileTimeline(fixture({component: 'arbitrary-code'})))
    .toThrowError(/EDIT_COMPONENT_UNREGISTERED/);
});

it('rejects undeclared visual gaps', () => {
  expect(() => compileTimeline(fixture({allowBackgroundGaps: false, gapFrames: 10})))
    .toThrowError(/TIMELINE_GAP_UNDECLARED/);
});

it('rejects BGM shorter than the remaining composition', () => {
  expect(() => compileTimeline(fixture({compositionMs: 10_000, bgmStartMs: 1_000, bgmDurationMs: 8_999})))
    .toThrowError(/AUDIO_BGM_TOO_SHORT/);
});
```

- [ ] **Step 2: Implement registered components with strict props**

The registry exports component and Zod props schema together:

```tsx
import {z} from 'zod';
import {BasicTitle} from './components/BasicTitle';

const BasicTitleProps = z.object({text: z.string().min(1).max(80)}).strict();

export const componentRegistry = {
  'basic-title': {component: BasicTitle, propsSchema: BasicTitleProps},
} as const;
```

`BasicTitle` and `Caption` must use only props and `useCurrentFrame()`, with no network, filesystem, current time, or unseeded randomness.

- [ ] **Step 3: Implement timeline compilation**

The compiler must:

1. Resolve asset IDs from `asset-manifest.json`.
2. Validate `0 <= sourceInMs < sourceOutMs <= assetDurationMs`, even though the authoring Schema already rejects a reversed interval.
3. Require source duration and timeline duration to differ by at most one frame.
4. Parse every overlay props object through its registry schema.
5. Convert caption milliseconds to frame ranges.
6. Calculate `durationInFrames` as the maximum visual, overlay, narration, and caption end.
7. Merge touching visual ranges and reject gaps unless `allowBackgroundGaps` is true.
8. Validate BGM available duration after `startMs`.
9. Emit only project-relative render paths and input hashes.
10. Persist narration intervals and BGM metadata only; P04 derives Ducking from those fields, Composition duration, `project.audio`, and its algorithm version.

- [ ] **Step 4: Verify and commit**

```bash
pnpm test tests/unit/timeline tests/unit/remotion/registry.test.tsx
pnpm typecheck
git add src/timeline src/remotion/registry.tsx src/remotion/components src/pipeline/stages/compile.ts tests/unit/timeline tests/unit/remotion
git commit -m "feat: compile explicit edit decisions"
```

## Task 11: Render Muted Video with Remotion

**Files:**
- Create: `src/remotion/index.ts`
- Create: `src/remotion/Root.tsx`
- Create: `src/remotion/ProjectComposition.tsx`
- Create: `src/remotion/render-video.ts`
- Test: `tests/integration/remotion/render-video.test.ts`

- [ ] **Step 1: Write the muted-render integration test**

The test creates a compiled timeline using a generated test video and font, renders 30 frames, probes the result, and asserts:

```ts
expect(metadata.videoStreams).toHaveLength(1);
expect(metadata.audioStreams).toHaveLength(0);
expect(metadata.width).toBe(1920);
expect(metadata.height).toBe(1080);
expect(metadata.fps).toBe(30);
```

- [ ] **Step 2: Implement the Remotion root**

Use one Composition ID, `Project`, with `calculateMetadata` returning width, height, FPS, and duration from validated input props. Register through:

```ts
import {registerRoot} from 'remotion';
import {RemotionRoot} from './Root';

registerRoot(RemotionRoot);
```

- [ ] **Step 3: Implement ProjectComposition**

For each visual clip, render a `Sequence` at `startFrame` for `durationInFrames`. Use muted `OffthreadVideo` for video, `Img` for images, absolute positioned transforms for fit/position/scale/opacity, and registered overlay components by z-index. Render caption cues with the fixed caption component. Do not render any `<Audio>` element.

- [ ] **Step 4: Implement programmatic rendering**

```ts
const bundleLocation = await bundle({entryPoint, publicDir});
const composition = await selectComposition({
  serveUrl: bundleLocation,
  id: 'Project',
  inputProps: timeline,
});
await renderMedia({
  serveUrl: bundleLocation,
  composition,
  codec: 'h264',
  muted: true,
  outputLocation,
  inputProps: timeline,
});
```

The render workspace must expose only generated render copies, images, and fonts through its public directory.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test tests/integration/remotion/render-video.test.ts
pnpm typecheck
git add src/remotion tests/integration/remotion
git commit -m "feat: render muted remotion timelines"
```

Checkpoint A is complete: a validated EDL can render a muted draft.

## Task 12: Mix BGM, Clamp Ducking, and Normalize Loudness

**Files:**
- Create: `src/media/audio-mix.ts`
- Create: `src/media/loudness.ts`
- Test: `tests/unit/media/audio-mix.test.ts`
- Test: `tests/integration/media/audio-mix.test.ts`

- [ ] **Step 1: Write Ducking envelope tests**

```ts
it('clamps mixed audio to composition duration', () => {
  expect(buildDuckingIntervals({
    narration: [{startMs: 9_500, endMs: 10_000}],
    attackMs: 120,
    releaseMs: 250,
    compositionDurationMs: 10_000,
  })).toEqual([{attackStartMs: 9_380, holdStartMs: 9_500, holdEndMs: 10_000, releaseEndMs: 10_000}]);
});

it('merges overlapping attack and release windows', () => {
  expect(buildDuckingIntervals({
    narration: [{startMs: 1000, endMs: 2000}, {startMs: 2100, endMs: 3000}],
    attackMs: 200,
    releaseMs: 300,
    compositionDurationMs: 4000,
  })).toHaveLength(1);
});

it('serializes a large set of narration intervals into a filter graph file', () => {
  const intervals = Array.from({length: 100}, (_, index) => ({startMs: index * 1000, endMs: index * 1000 + 500}));
  expect(buildAudioFilterGraph({narration: intervals}).script).toContain('volume=');
});

const fingerprintMutations: Array<[
  string,
  (input: AudioMixFingerprintInput) => AudioMixFingerprintInput,
]> = [
  ['narration intervals', input => ({...input, narrationIntervals: input.narrationIntervals.map((value, index) => index === 0 ? {...value, endMs: value.endMs + 1} : value)})],
  ['composition duration', input => ({...input, compositionDurationMs: input.compositionDurationMs + 1})],
  ['BGM metadata', input => ({...input, backgroundMusic: {...input.backgroundMusic, startMs: input.backgroundMusic.startMs + 1}})],
  ['backgroundMusicGainDb', input => ({...input, backgroundMusicGainDb: input.backgroundMusicGainDb - 1})],
  ['duckDuringNarrationDb', input => ({...input, duckDuringNarrationDb: input.duckDuringNarrationDb - 1})],
  ['duckAttackMs', input => ({...input, duckAttackMs: input.duckAttackMs + 1})],
  ['duckReleaseMs', input => ({...input, duckReleaseMs: input.duckReleaseMs + 1})],
  ['targetLufs', input => ({...input, targetLufs: input.targetLufs - 1})],
  ['truePeakDb', input => ({...input, truePeakDb: input.truePeakDb - 0.1})],
  ['algorithm version', input => ({...input, algorithmVersion: 'audio-mix-v2'})],
];

it.each(fingerprintMutations)('changes when %s changes', (_label, mutate) => {
  const baseline = fixture();
  expect(audioMixFingerprint(mutate(baseline))).not.toBe(audioMixFingerprint(baseline));
});
```

- [ ] **Step 2: Implement deterministic envelope math**

Represent gain as a piecewise function: unity before attack, linear ramp to `10 ** (duckDb / 20)`, hold during narration, linear release, unity afterward. Merge intervals whose attack begins before the previous release ends. Clamp every endpoint to `[0, compositionDurationMs]`. Do not persist the derived envelope in the compiled timeline.

Freeze an algorithm version such as `audio-mix-v1`. `audioMixFingerprint()` covers narration intervals, Composition duration, BGM metadata, `backgroundMusicGainDb`, `duckDuringNarrationDb`, `duckAttackMs`, `duckReleaseMs`, `targetLufs`, `truePeakDb`, and the algorithm version. Draft includes this sub-fingerprint; there is no separate Audio Mix Stage.

- [ ] **Step 3: Build the FFmpeg mix graph**

Create a `volume=<globalGain>*<piecewiseExpression>:eval=frame` filter for BGM, delay it by `backgroundMusic.startMs`, and mix with narration using `amix=inputs=2:normalize=0`. When Draft invokes this implementation, serialize the complete graph once to fixed write-once Run artifact `audio/filter-graph.txt`, return its path/SHA-256 for Draft Stage outputs, and pass a fresh Run-scope read FD to FFmpeg rather than placing the growing expression on the command line. Every independent input/output opens a fresh handle from its owning `ProjectDirectoryScope`, `RunDirectoryScope`, or `OutputDirectoryScope`, maps both read and write FDs through `extraStdioFds`, consumes each FD/pipe once, and closes in `finally`. Trim to Composition duration and resample to 48kHz stereo PCM. The integration test executes at least 100 narration intervals. Do not create an Audio Mix Stage.

- [ ] **Step 4: Implement two-pass loudnorm**

First pass uses `loudnorm=I=<target>:TP=<peak>:LRA=11:print_format=json` to null output and parses measured values from stderr. Second pass supplies `measured_I`, `measured_LRA`, `measured_TP`, `measured_thresh`, and `offset`, then writes fixed write-once Run artifact `audio/mixed-normalized.wav`. Return its path/SHA-256 beside the filter-graph reference so Draft records both outputs. Both passes use fresh scoped handles and borrowed `extraStdioFds`; reject non-finite measurements.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test tests/unit/media/audio-mix.test.ts tests/integration/media/audio-mix.test.ts
pnpm typecheck
git add src/media/audio-mix.ts src/media/loudness.ts tests/unit/media/audio-mix.test.ts tests/integration/media/audio-mix.test.ts
git commit -m "feat: mix and normalize narration audio"
```

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

The selector must include frame 0, final frame, every visual start/end boundary, every caption midpoint, and evenly spaced coverage frames. Deduplicate and sort the result, then cap at 24 frames while preserving boundaries. Draft integration tests also assert outputs contain path/SHA-256 references for both `audio/filter-graph.txt` and `audio/mixed-normalized.wav`.

- [ ] **Step 2: Implement contact sheet generation**

Extract selected frames with FFmpeg and tile them into a labeled JPEG. Each decode/extract/tile input and output opens a fresh `RunDirectoryScope` handle and closes it after the consumer settles. Store individual review frames and `contact-sheet.jpg` under the Run's draft directory.

- [ ] **Step 3: Implement Draft stage**

Render 960×540 muted video, invoke P04 Audio Mix once to create write-once `audio/filter-graph.txt` and loudness-normalized `audio/mixed-normalized.wav`, record both path/SHA-256 references in Draft Stage outputs, mux that normalized audio into the draft MP4, fully decode it, verify one video and one audio stream, then generate review frames and the draft report. Draft fingerprint includes `audioMixFingerprint()`; no Audio Mix Stage exists.

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

`videoctl review <project> --approve --reason <text>` resolves the work pointer through `RunStore.openExistingRun()`, uses the returned opaque `RunDirectoryScope` to verify every evidence path, writes strict `review.json`, and never edits programmatic checks. A rejected review records `status: rejected` and blocks Release.

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

Generate one valid release and fixtures with missing audio, wrong dimensions, excessive A/V duration difference, and truncated MP4. Assert the exact errors `RELEASE_DECODE_FAILED` or `RELEASE_DURATION_MISMATCH`. Pre-create the Draft filter graph and normalized mixed audio, run Release, and prove their bytes/hashes remain unchanged.

Execute both commands in Step 2 through borrowed FDs. Assert FFmpeg's Run-scope intermediate is non-empty; `qt-faststart` receives a fresh Run-scope read handle and a fresh exclusive Output-scope read-write handle on a different path; the final output is non-empty, fully decodes, and has top-level `moov` before `mdat`. The atom parser covers bounded 32-bit sizes, extended 64-bit sizes, and size-zero-to-EOF atoms. Missing/failing `qt-faststart` must not publish a pointer and must preserve an existing output `current.json` byte-for-byte.

- [ ] **Step 2: Implement final rendering and muxing**

1. Render final muted H.264 video at 1920×1080 into the Run scope.
2. Read and verify the Draft Stage output references for `audio/filter-graph.txt` and `audio/mixed-normalized.wav`; include both hashes and P02's persisted FFmpeg/`qt-faststart` environment fingerprint in Release fingerprint/provenance and reuse the normalized mixed audio without executing the graph or writing either artifact again.
3. **Step A:** open fresh Run-scope read handles for final video and normalized mixed audio plus a fresh Run-scope exclusive read-write new-file handle for write-once `release/final-intermediate.mp4`, then mux with borrowed FDs and no `+faststart`:

```text
ffmpeg -y -i /dev/fd/3 -i /dev/fd/4 \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -ar 48000 -ac 2 \
  -f mp4 /dev/fd/5
```

4. After Step A's `runProcess()` settles, close all three handles in `finally` and require the intermediate to be non-empty.
5. **Step B:** reopen the intermediate through a fresh Run-scope read handle, open `releases/<runId>/final.mp4` through a fresh Output-scope exclusive read-write new-file handle, and invoke the exact `qt-faststart` real path recorded by Preflight:

```text
qt-faststart /dev/fd/3 /dev/fd/4
```

After Step B's `runProcess()` settles, close both handles in `finally`. Do not use `-shortest`; Draft already trims and normalizes the reusable audio to Composition duration, and Release verifies that duration/hash contract before Step A. The intermediate and final must never share a handle or scope-relative path.

On Darwin, direct FFmpeg `-movflags +faststart` output to one `/dev/fd/N` is forbidden: FFmpeg's internal rewrite reopens the descriptor path, and the resulting descriptors share one open-file-description offset, which can silently corrupt the MP4. The separate `qt-faststart` process keeps input and output offsets independent.

- [ ] **Step 3: Implement full release verification**

Open a fresh Output-scope read handle for each final full-decode, probe, atom-parse, and checksum consumer; run the equivalent of `ffmpeg -v error -xerror -i /dev/fd/3 -f null -` and require exit 0. Probe streams and require one H.264 `yuv420p` 1920×1080 30FPS stream and one AAC 48kHz stereo stream. Parse top-level atoms with bounds checks for 32-bit, extended 64-bit, and size-zero forms and require `moov` before `mdat`. Require A/V duration difference ≤50ms, parseable SRT within video duration, valid loudness metrics, unchanged source hashes, and unchanged Draft filter-graph/mixed-audio bytes and hashes. Each borrowed FD is consumed once and closed by the caller in `finally`.

- [ ] **Step 4: Generate remaining artifacts**

Create a 1280×720 padded thumbnail from an approved non-black review frame. Write deterministic SRT, `review.json`, `validation-report.json`, and SHA-256 lines sorted by relative path.

- [ ] **Step 5: Publish atomically**

Write all release artifacts through `OutputDirectoryScope` under `releases/<runId>`, verify them there, then atomically update scoped `current.json`. Step A/Step B failures never publish the pointer. Run cleanup owns failed-stage intermediates; Release cleanup owns release directories not referenced by output `current.json`; neither may delete the currently referenced Run or release. Inject missing/failing `qt-faststart` plus pointer write, sync, and rename failures and prove the old release pointer remains intact. Release never overwrites Draft-owned Run artifacts or existing release files.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test tests/unit/media/release-verify.test.ts tests/integration/pipeline/release.test.ts
pnpm typecheck
git add src/media/release-verify.ts src/pipeline/stages/release.ts tests/unit/media/release-verify.test.ts tests/integration/pipeline/release.test.ts
git commit -m "feat: package and verify final releases"
```

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

Tests must cover full, prefix, and sliced plans; cached and resume actions; forced invalidation; missing prerequisites; and insertion of a fake Stage without changing Runner code. Draft fingerprint fixtures include the complete P04 audio sub-fingerprint (`targetLufs` and `truePeakDb` included). Release fingerprint fixtures consume the exact Draft output hashes for `audio/filter-graph.txt` and `audio/mixed-normalized.wav` plus the persisted FFmpeg/`qt-faststart` environment fingerprint; there is no Audio Mix Stage. `--plan` prints this object and exits without creating a Run, acquiring a write lock, writing a pointer, or starting a subprocess.

- [ ] **Step 4: Implement the Execution Plan Runner and resume behavior**

Use fake stages with deterministic fingerprints. Verify an unchanged second run reports `cached`, changing any one frozen audio-mix input invalidates Draft and Release, changing one narration segment invalidates Narration and every downstream Stage, switching from `draft` to `release` reuses the matching Draft filter-graph/mixed-audio hashes without creating or overwriting an Audio Mix Stage, and `--force compile` reruns Compile through Release while reusing Preflight, Ingest, and Narration.

The Runner receives an already validated `ExecutionPlan` and has no Preset-specific branches. It carries the opaque `ProjectDirectoryScope` returned by project loading, obtains `RunDirectoryScope` only from `RunStore.createRun()`/`openExistingRun()`, and obtains `OutputDirectoryScope` only for release publication; no Stage receives raw root strings or may substitute one scope for another. It acquires the project lock only for an executable plan and reads work `current.json` through the app-owned scope protocol. With `--resume`, it continues the same `runId` while recorded fingerprints match; otherwise it creates a new Run only after successful Preflight. After every materialized `passed` Stage and when Review enters `needs_review`, update work `current.json` with `preset`, the selected `stageIds` snapshot, `completedStage`, and `state`. Reports include `preset`, stable Stage ID, `position`, and `total`. Release records the reused Draft artifact hashes as inputs/provenance and does not claim or rewrite them as Release outputs. Stop on `failed` or `needs_review`, write reports after every Stage, and release the lock in `finally`.

- [ ] **Step 5: Implement signal behavior**

Create one `AbortController`, map `SIGINT` and `SIGTERM` to `abort()`, wait for child termination, then clean failed Run-local intermediates through Run authority and unpublished release files through Output authority. Preserve prior pointers and return exit code 130 for SIGINT. Integration tests send real signals to a child CLI process and assert the lock is released and the previously published release remains current.

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

`clean` may remove failed/unreferenced work Runs and unpublished release directories not referenced by output `current.json`. It must never remove source assets, the Run referenced by work `current.json`, or the release referenced by output `current.json`. Failed Release intermediates are cleaned only through Run authority; partial final files/directories are cleaned only through Output authority.

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
expect(await fullDecodeFromOutputScope(outputDirectory, finalRelativePath)).toEqual({ok: true});
const atoms = await readTopLevelAtomsFromOutputScope(outputDirectory, finalRelativePath);
expect(atoms.moov.offset).toBeLessThan(atoms.mdat.offset);
expect(await sourceHashesAfter()).toEqual(await sourceHashesBefore());
```

It also verifies `subtitles.srt`, `thumbnail.jpg`, `review.json`, `validation-report.json`, and `checksums.sha256` exist under the release referenced by `output/<project>/current.json`. Stage reports must retain stable IDs while displaying the correct `position/total` for each selected Preset.

The acceptance test also inspects process results and scoped artifact references: Step A is the exact FFmpeg command ending in `-f mp4 /dev/fd/5` with no `+faststart`, writing a non-empty Run-scope intermediate; Step B is `qt-faststart /dev/fd/3 /dev/fd/4`, reading that intermediate through a fresh Run-scope handle and writing the final through a fresh Output-scope handle on a different path. Both final-MP4 helpers open their own fresh Output-scope read handle. Missing/failing `qt-faststart` leaves the previous output pointer unchanged.

- [ ] **Step 4: Write cache invalidation acceptance test**

Run the `release` Preset twice, change only the second script segment, and assert the first segment WAV hash is reused, the second changes, and Narration plus all downstream Stages receive new fingerprints. Also assert Draft regenerates new filter-graph/mixed-audio hashes, while an unchanged `draft` followed by `release` reuses the exact Draft hashes and leaves the write-once files untouched. Insert a fake registered Stage in the unit fixture and prove Runner behavior does not require modification.

- [ ] **Step 5: Document exact local usage**

`README.md` must include prerequisites—including an executable `qt-faststart` sibling beside the resolved FFmpeg binary—installation, fixture generation, the seven stable Stage IDs, built-in Presets, Execution Plan numbering, `--plan`/`--from`/`--to`/`--force`, authoring-file roles, commands, review workflow, output pointer resolution, common error codes, the two-step scoped-FD publication flow, and the statement that source video audio is muted in MVP.

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
- Doctor reports no errors on the target Mac and records FFmpeg/`qt-faststart` real paths, SHA-256 values, and the environment fingerprint.
- Plan mode reports numbered Stage IDs and performs no writes or subprocess calls.
- `assets`, `draft`, and `release` reuse all matching shared Stage artifacts; Release references the Draft filter-graph/mixed-audio hashes without rerunning audio mixing.
- The first release run stops when Review returns `needs_review` before approval.
- The explicit review command succeeds, and the resumed `release` Preset publishes a new output pointer without changing `runId`.
- The current release was produced by the two-step FFmpeg-intermediate/`qt-faststart` flow, fully decodes, has `moov` before `mdat`, and matches the fixed media profile.

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
- [ ] Project/Run/Output nominal forgery/cross-assignment, read/write escape, scope substitution, write-only/read-write exclusive-create, seek/readback, and atomic pointer-symlink tests pass.
- [ ] Lock contention, stale lock, SIGINT, and SIGTERM tests pass.
- [ ] Preflight and runtime disk exhaustion remain distinct failures.
- [ ] Exact-frame and non-aligned caption boundary tests pass.
- [ ] Draft-derived Ducking reused by Release is clamped to Composition duration.
- [ ] A 100-interval `audio/filter-graph.txt` executes; it and `audio/mixed-normalized.wav` appear with path/SHA-256 in Draft Stage outputs, every frozen Audio Mix input independently changes the fingerprint, and Release reuses both hashes without overwriting either artifact.
- [ ] Narration concat succeeds from a project path containing spaces while retaining `-safe 1`.
- [ ] Remotion output contains no audio stream.
- [ ] Preflight requires the executable `qt-faststart` sibling, records FFmpeg/`qt-faststart` real paths and binary hashes, and returns `ENV_TOOL_MISSING` when unavailable.
- [ ] Step A copies H.264 video and encodes AAC audio into a distinct non-empty Run-scope read-write intermediate with exact `-f mp4 /dev/fd/5` and no `+faststart`.
- [ ] Step B runs `qt-faststart /dev/fd/3 /dev/fd/4` with fresh Run-input/Output-output handles; the non-empty final passes full FFmpeg decode and has top-level `moov` before `mdat`.
- [ ] Direct Darwin FFmpeg `-movflags +faststart` output through one `/dev/fd/N` is absent from implementation and tests.
- [ ] Failed publication preserves previous work and release pointers.
- [ ] Changing one script segment reuses all unchanged segment audio.
- [ ] Stage registry IDs are unique and every Preset references a contiguous registered sequence.
- [ ] `--plan` is side-effect free and `--from` rejects missing prerequisite artifacts.
- [ ] Adding a fake ordinary Stage requires no Runner, lock, pointer, or report-protocol changes.
- [ ] Original source hashes remain unchanged.
- [ ] README commands match the implemented CLI.
