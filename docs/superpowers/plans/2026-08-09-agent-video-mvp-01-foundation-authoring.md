# Agent Video MVP P01 Foundation and Authoring Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the repository toolchain, strict authoring and generated-data contracts, symlink-safe filesystem APIs, and abortable process/Gate primitives used by every later project.

**Architecture:** P01 owns shared contracts and performs no media rendering or workflow orchestration. JSON inputs are parsed with strict Zod Schemas, cross-file rules run after parsing, filesystem writes use no-follow/exclusive creation, and subprocess results are converted into structured Gate checks.

**Tech Stack:** Node.js 22, pnpm 10, TypeScript, Zod, Vitest, Node filesystem/process APIs.

---

## Project Contract

- **Project ID:** P01
- **Specification:** `../specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- **Project Index:** `2026-08-09-agent-video-mvp-project-index.md`
- **Master Tasks:** 1–4
- **Depends On:** None
- **Primary Write Set:** `package.json`, `pnpm-lock.yaml`, package-manager configuration (`.npmrc`, `.pnpmfile.cjs`), TypeScript/test configuration, shared Schema primitives in `src/domain/schema-primitives.ts`, the remaining `src/domain/**`, `src/fs/**`, `src/process/**`, `src/pipeline/types.ts`, and `src/pipeline/gate.ts`.
- **Must Not Implement:** Media probing, TTS, Remotion rendering, release packaging, Stage registry, Presets, or Runner behavior.
- **Exit Artifact:** Frozen authoring Schemas, generated Manifest types, safe read/write path APIs, process protocol, and Gate aggregation.

## Entry Criteria

- Repository exists at the workspace root.
- Node.js 22 and pnpm 10 are available on the implementation machine.
- The product specification and project index have been reviewed.

---
## Task 1: Bootstrap the Toolchain and Test Harness

**Files:**
- Create: `package.json`
- Create: `.npmrc`
- Create: `.pnpmfile.cjs`
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

Package-manager portability requirements:
- `.npmrc` must set `auto-install-peers=false` and `lockfile-include-tarball-url=false` so pnpm does not auto-install unrequested peers and is configured not to include registry tarball URLs in the lockfile.
- `.pnpmfile.cjs` must remove `resolution.tarball` only when the same resolution has `integrity`, keeping the frozen lockfile portable and integrity-verifiable without retaining mirror-specific tarball addresses.

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
git add .npmrc .pnpmfile.cjs package.json pnpm-lock.yaml tsconfig.json vitest.config.ts remotion.config.ts src/domain/mvp-profile.ts tests/unit/domain/mvp-profile.test.ts
git commit -m "chore: bootstrap agent video toolchain"
```


## Task 2: Define Strict Authoring and Generated Schemas

**Files:**
- Create: `src/domain/schema-primitives.ts`
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

The regression suite must also cover lexical path rejection (URI schemes, Windows drives, backslashes, and exact `..` segments while allowing `font..otf`), fractional millisecond values, generated numeric and interval invariants, stable/generated ID uniqueness with precise issue paths, nested strictness, and the independent compiled-clip contract where either kind may omit or provide `sourceInMs`.

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test tests/unit/domain/schemas.test.ts`

Expected: FAIL because schema modules do not exist.

- [ ] **Step 3: Implement shared primitives plus the project and script schemas**

`src/domain/schema-primitives.ts` must export:

```ts
import {z} from 'zod';

const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;

export const StableIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const ProjectRelativePathSchema = z.string().min(1).superRefine((value, context) => {
  if (value.startsWith('/')) context.addIssue({code: 'custom', message: 'must not start with /'});
  if (WINDOWS_DRIVE_PATTERN.test(value)) {
    context.addIssue({code: 'custom', message: 'must not use a Windows drive path'});
  } else if (URI_SCHEME_PATTERN.test(value)) {
    context.addIssue({code: 'custom', message: 'must not use a URI scheme'});
  }
  if (value.includes('\\')) context.addIssue({code: 'custom', message: 'must use forward slashes'});
  if (value.split('/').includes('..')) context.addIssue({code: 'custom', message: 'must not contain a parent-directory segment'});
});
```

Use these shared primitives for every Task 2 stable ID and project-relative path field. Filesystem containment and symlink checks remain Task 3 responsibilities.

`src/domain/project-schema.ts`:

```ts
import {z} from 'zod';
import {ProjectRelativePathSchema, StableIdSchema} from './schema-primitives';

export const ProjectSchema = z.object({
  version: z.literal(1),
  id: StableIdSchema,
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
    font: ProjectRelativePathSchema,
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
    duckAttackMs: z.number().min(0).max(2_000),
    duckReleaseMs: z.number().min(0).max(5_000),
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
import {ProjectRelativePathSchema, StableIdSchema} from './schema-primitives';

export const ScriptSegmentSchema = z.object({
  id: StableIdSchema,
  text: z.string().min(1),
  normalizedText: z.string().min(1),
  pauseAfterMs: z.number().min(0).max(5_000),
  requiredTerms: z.array(z.string().min(1)),
  audioPath: ProjectRelativePathSchema.optional(),
  notes: z.object({visualHint: z.string().min(1)}).strict().optional(),
}).strict();

export const ScriptSchema = z.object({
  version: z.literal(1),
  language: z.literal('zh-CN'),
  segments: z.array(ScriptSegmentSchema).min(1).superRefine((segments, context) => {
    const ids = new Set<string>();
    for (const [index, segment] of segments.entries()) {
      if (ids.has(segment.id)) context.addIssue({code: 'custom', path: [index, 'id'], message: `duplicate segment id: ${segment.id}`});
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
import {StableIdSchema} from './schema-primitives';

const AssetIdSchema = StableIdSchema;
const TimelineBaseSchema = z.object({
  id: StableIdSchema,
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
}).strict();

export const VisualClipSchema = z.discriminatedUnion('kind', [
  TimelineBaseSchema.extend({
    kind: z.literal('video'),
    sourceInMs: z.number().nonnegative(),
    sourceOutMs: z.number().positive(),
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
    id: StableIdSchema,
    component: StableIdSchema,
    startFrame: z.number().int().nonnegative(),
    durationInFrames: z.number().int().positive(),
    props: z.record(z.string(), z.unknown()),
    zIndex: z.number().int(),
  }).strict()),
  backgroundMusic: z.object({assetId: AssetIdSchema, startMs: z.number().nonnegative()}).strict().optional(),
}).strict().superRefine((edit, context) => {
  const ids = new Set<string>();
  for (const [index, item] of edit.visualClips.entries()) {
    if (ids.has(item.id)) context.addIssue({code: 'custom', path: ['visualClips', index, 'id'], message: `duplicate timeline id: ${item.id}`});
    ids.add(item.id);
  }
  for (const [index, item] of edit.overlays.entries()) {
    if (ids.has(item.id)) context.addIssue({code: 'custom', path: ['overlays', index, 'id'], message: `duplicate timeline id: ${item.id}`});
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

Use `StableIdSchema` for asset record keys, generated segment/cue IDs and references. Use `ProjectRelativePathSchema` for every `sourcePath`, `renderPath`, and `audioPath`. Millisecond values may be fractional; starts are nonnegative, durations are positive, and narration/caption end fields must be greater than their starts with the issue path attached to the end field. Narration segments and caption cues are unique by their own `id`.

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

Keep `kind: 'video' | 'image'` independent from `sourceInMs?: number`; do not replace this exact shape with a discriminated union. When present, `sourceInMs` is nonnegative. Frame and layer fields use integer constraints, frame starts are nonnegative, frame durations are positive, and scale/opacity/fade constraints match the authoring Schema. Visual clips and overlays share one timeline ID namespace; compiled captions are unique by their own ID. Narration interval `segmentId` references are not required to be unique.

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
git add \
  src/domain/schema-primitives.ts \
  src/domain/project-schema.ts \
  src/domain/script-schema.ts \
  src/domain/edit-schema.ts \
  src/domain/manifest-schema.ts \
  src/domain/timeline-schema.ts \
  src/domain/review-schema.ts \
  tests/unit/domain/schemas.test.ts
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
- Test: `tests/unit/domain/load-project.test.ts`
- Test: `tests/unit/domain/validate-authoring.test.ts`

- [ ] **Step 1: Write path escape tests**

```ts
import {mkdtemp, mkdir, readFile, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {openNewProjectFile, resolveExistingProjectPath} from '../../../src/fs/project-paths';

describe('resolveExistingProjectPath', () => {
  it('accepts a regular file inside the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    await mkdir(path.join(root, 'assets'), {recursive: true});
    await writeFile(path.join(root, 'assets', 'clip.mp4'), 'fixture');
    await expect(resolveExistingProjectPath(root, 'assets/clip.mp4')).resolves.toBe(path.join(root, 'assets', 'clip.mp4'));
  });

  it('rejects a symlink that resolves outside the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
    await writeFile(path.join(outside, 'secret.mp4'), 'fixture');
    await symlink(path.join(outside, 'secret.mp4'), path.join(root, 'escape.mp4'));
    await expect(resolveExistingProjectPath(root, 'escape.mp4')).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
  });

  it('does not follow a writable target symlink outside the project', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-project-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
    const secret = path.join(outside, 'secret.txt');
    await writeFile(secret, 'unchanged');
    await symlink(secret, path.join(root, 'report.json'));

    await expect(openNewProjectFile(root, 'report.json')).rejects.toMatchObject({code: 'ASSET_PATH_OUTSIDE_PROJECT'});
    await expect(readFile(secret, 'utf8')).resolves.toBe('unchanged');
  });
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test tests/unit/fs/project-paths.test.ts`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Implement safe path resolution**

```ts
import {constants} from 'node:fs';
import {lstat, open, realpath, type FileHandle} from 'node:fs/promises';
import path from 'node:path';

export class ProjectPathError extends Error {
  readonly code = 'ASSET_PATH_OUTSIDE_PROJECT';
}

const isWithin = (root: string, target: string): boolean => target === root || target.startsWith(`${root}${path.sep}`);
const isNodeError = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && 'code' in error;

export async function resolveExistingProjectPath(projectRoot: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) throw new ProjectPathError('absolute paths are not allowed');
  const rootReal = await realpath(projectRoot);
  const targetReal = await realpath(path.resolve(rootReal, relativePath));
  if (!isWithin(rootReal, targetReal)) throw new ProjectPathError(`path escapes project: ${relativePath}`);
  return targetReal;
}

export async function resolveWritableProjectPath(projectRoot: string, relativePath: string): Promise<string> {
  if (path.isAbsolute(relativePath)) throw new ProjectPathError('absolute paths are not allowed');
  const rootReal = await realpath(projectRoot);
  const unresolvedTarget = path.resolve(rootReal, relativePath);
  const parentReal = await realpath(path.dirname(unresolvedTarget));
  if (!isWithin(rootReal, parentReal)) throw new ProjectPathError(`path escapes project: ${relativePath}`);
  const target = path.join(parentReal, path.basename(unresolvedTarget));
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new ProjectPathError(`writable target is a symlink: ${relativePath}`);
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error;
  }
  return target;
}

export async function openNewProjectFile(projectRoot: string, relativePath: string): Promise<FileHandle> {
  const target = await resolveWritableProjectPath(projectRoot, relativePath);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  return open(target, flags, 0o600);
}
```

Never call `writeFile()` directly on a user-derived writable target. Immutable artifacts use `openNewProjectFile()`. Pointer replacement uses a new same-directory temporary file opened with the same no-follow/exclusive flags, followed by sync and atomic rename.

- [ ] **Step 4: Implement JSON loading and project context**

`src/fs/json-files.ts`:

```ts
import {readFile} from 'node:fs/promises';
import type {ZodType} from 'zod';

export async function readJson<T>(filePath: string, schema: ZodType<T>): Promise<T> {
  const source = await readFile(filePath, 'utf8');
  return schema.parse(JSON.parse(source));
}
```

`src/domain/load-project.ts` must resolve `projects/<id>`, reject invalid IDs, read `project.json`, `script.json`, and `edit.json` with the schemas, and return:

```ts
export interface ProjectInputs {
  workspaceRoot: string;
  projectRoot: string;
  project: Project;
  script: Script;
  edit: Edit;
}
```

After independent Schema parsing, call `validateAuthoringInputs()` from `src/domain/validate-authoring.ts`. Count `segment.text` with `Intl.Segmenter('zh-CN', {granularity: 'grapheme'})`; throw `SCRIPT_SEGMENT_TEXT_TOO_LONG` when a segment exceeds `project.captions.maximumChineseCharacters`. Tests must cover a project limit lower than 28, a permitted limit above 28, and mixed CJK, ASCII, combining marks, and Emoji.

- [ ] **Step 5: Add loader tests and verify**

The loader test must prove valid files load, malformed JSON fails, unknown fields fail, project IDs cannot contain `/` or `..`, and cross-file authoring validation runs after all three Schemas parse.

Run:

```bash
pnpm test tests/unit/fs/project-paths.test.ts tests/unit/domain/load-project.test.ts tests/unit/domain/validate-authoring.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/fs src/domain/load-project.ts src/domain/validate-authoring.ts tests/helpers tests/unit/fs tests/unit/domain/load-project.test.ts tests/unit/domain/validate-authoring.test.ts
git commit -m "feat: load projects through safe paths"
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

Reject non-zero exits with `ProcessExecutionError` carrying `PROCESS_EXIT_NONZERO`, and use `PROCESS_TIMEOUT` and `PROCESS_ABORTED` for those conditions.

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
git commit -m "feat: add safe subprocess and gate protocol"
```


## Project Exit Verification

- [ ] **Step 1: Run the complete P01 test set**

```bash
pnpm test tests/unit/domain/mvp-profile.test.ts tests/unit/domain/schemas.test.ts tests/unit/domain/validate-authoring.test.ts tests/unit/domain/load-project.test.ts tests/unit/fs/project-paths.test.ts tests/unit/process/run-process.test.ts tests/unit/pipeline/gate.test.ts
pnpm typecheck
git diff --check
```

Expected: all tests pass, TypeScript exits 0, and `git diff --check` prints no errors.

- [ ] **Step 2: Verify the frozen contract boundary**

```bash
git status --short
git log --oneline --max-count=4
```

Expected: only P01 files are changed by this project, and Tasks 1–4 each have a focused commit. Record any target-specific skipped check in the handoff; P01 normally has none.
