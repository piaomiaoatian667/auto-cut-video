# Agent Video MVP P03 Media and Visual Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build local media ingest, explicit EDL compilation, fixed Remotion components, and deterministic muted-video rendering.

**Architecture:** P03 consumes P01 Schemas/safe paths and P02 Run storage without modifying their contracts. Ingest produces an immutable asset Manifest, Compile produces a strict read-only timeline, and Remotion renders only muted visual output from registered components and project-local render assets.

**Tech Stack:** TypeScript, FFmpeg/ffprobe, Remotion, React, Zod, Vitest.

---

## Project Contract

- **Project ID:** P03
- **Specification:** `../specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- **Project Index:** `2026-08-09-agent-video-mvp-project-index.md`
- **Master Tasks:** 7, 10, 11
- **Depends On:** P01 and P02 completed and merged.
- **May Run In Parallel With:** P04 after P02.
- **Primary Write Set:** `src/media/ffprobe.ts`, `src/media/transcode.ts`, Ingest/Compile Stages, `src/timeline/**`, `src/remotion/**`, media fixture helpers, and visual-pipeline tests.
- **Must Not Modify:** TTS providers, narration/caption implementations, audio mixing, Review/Release, Stage registry, Presets, or Runner.
- **Exit Artifact:** Validated `asset-manifest.json`, validated `compiled-timeline.json`, fixed visual component registry, and decodable muted H.264 render.

## Entry Criteria

- P01 and P02 exit verification passes.
- Fixture Narration and Captions Manifests are permitted for Compile/Remotion tests; P03 must not implement P04 business logic.
- FFmpeg and ffprobe target capabilities pass P02 Preflight.

---
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

Hash source files, resolve paths through `resolveExistingProjectPath()`, probe them, decode beginning/middle/end samples, transcode only when required, and write `asset-manifest.json`. Verify source hashes again after processing.

- [ ] **Step 6: Verify and commit**

```bash
pnpm test tests/unit/media tests/integration/pipeline/ingest.test.ts
pnpm typecheck
git add src/media src/pipeline/stages/ingest.ts tests/helpers/media-fixtures.ts tests/unit/media tests/integration/pipeline/ingest.test.ts
git commit -m "feat: ingest and normalize local media"
```

Checkpoint A now has safe media inputs but not rendering.


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


## Project Exit Verification

- [ ] **Step 1: Run the complete P03 test set**

```bash
pnpm test tests/unit/media/ffprobe.test.ts tests/unit/media/compatibility.test.ts tests/integration/pipeline/ingest.test.ts tests/unit/timeline/compile-timeline.test.ts tests/unit/remotion/registry.test.tsx tests/integration/remotion/render-video.test.ts
pnpm typecheck
git diff --check
```

Expected: all tests pass, reversed/out-of-bounds Trim fails before rendering, and the rendered MP4 contains one video stream and no audio stream.

- [ ] **Step 2: Re-run the visual artifact contract tests verbosely**

```bash
pnpm test tests/integration/pipeline/ingest.test.ts tests/integration/remotion/render-video.test.ts --reporter=verbose
```

Expected: the integration assertions confirm generated Manifests and muted video stay under Run-owned directories, the video has no audio stream, and source assets remain unchanged.

- [ ] **Step 3: Verify the parallel-work boundary**

```bash
git status --short
git log --oneline --max-count=3
```

Expected: no files owned by P04, P05, or P06 are modified, and Tasks 7, 10, and 11 have focused commits.
