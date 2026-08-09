# Agent Video MVP P04 Narration and Audio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build segment-level TTS/file narration caching, exact caption/SRT generation, scalable BGM ducking, and deterministic loudness-normalized audio output.

**Architecture:** P04 consumes P01 Schemas/process contracts and the P02 opaque Work/Run/Output scope contract without modifying it. P04 directly uses Project and Run authorities; Work metadata remains Work-scoped, and any later publication remains exclusively Output-scoped. Each script segment has an independent cache key and WAV, captions join by stable segment ID, and FFmpeg receives fresh borrowed FDs from the owning Project or Run scope rather than user paths or unbounded command-line expressions.

**Tech Stack:** TypeScript, macOS `say`, FFmpeg/ffprobe, Zod, Vitest.

---

## Project Contract

- **Project ID:** P04
- **Specification:** `../specs/2026-08-09-remotion-ffmpeg-agent-video-mvp-design.md`
- **Project Index:** `2026-08-09-agent-video-mvp-project-index.md`
- **Master Tasks:** 8, 9, 12
- **Depends On:** P01 and P02 completed and merged.
- **May Run In Parallel With:** P03 after P02.
- **Primary Write Set:** `src/providers/**`, `src/narration/**`, `src/captions/**`, Narration Stage, `src/media/audio-mix.ts`, `src/media/loudness.ts`, and audio tests.
- **Must Not Modify:** Ingest/Compile/Remotion visual files, Review/Release, Stage registry, Presets, or Runner.
- **Exit Artifact:** Validated Narration and Captions Manifests, deterministic SRT, reusable segment WAVs, deterministic Audio Mix fingerprint/algorithm contracts, and fixed Draft-output contracts for `audio/filter-graph.txt` plus `audio/mixed-normalized.wav`.

## Entry Criteria

- P01 and P02 exit verification passes.
- Unit and generic integration tests use Mock/File providers; the macOS `say` test is an explicit target-Mac smoke check.
- Generated concat and filter graph files are stored only under immutable Run directories.
- Every independent consumer opens a fresh handle from exactly one owner: project-supplied media via `ProjectDirectoryScope`, current Run artifacts beneath `.work/<projectId>/runs/<runId>` via `RunDirectoryScope`, and release files/pointers via `OutputDirectoryScope`. Work lock/current authority remains a separate `WorkDirectoryScope` and is not widened into Run scope. Handles/FDs are one-shot and caller-owned, and close in `finally` after `runProcess()` settles.

---
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

Run the same contract tests against Mock and File providers. Verify cancellation, deterministic fingerprinting, missing input failure, and non-empty output. `FileTtsProvider` must require `sourceAudioPath`, open a fresh read `FileHandle` through `ProjectDirectoryScope`, pass it to each child consumer with `extraStdioFds`, and close it in `finally` after the Promise settles. Write the normalized copy through a fresh handle from the app-owned `RunDirectoryScope`; never modify the source WAV or reopen either file from a resolved string.

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

Represent gain as a piecewise function: unity before attack, linear ramp to `10 ** (duckDb / 20)`, hold during narration, linear release, unity afterward. Merge intervals whose attack begins before the previous release ends. Clamp every endpoint to `[0, compositionDurationMs]`. The envelope is derived at P04 runtime and is never persisted in `compiled-timeline.json`.

Freeze an explicit Audio Mix algorithm version such as `audio-mix-v1`. `audioMixFingerprint()` must cover, in deterministic order: narration intervals, Composition duration, BGM metadata, `backgroundMusicGainDb`, `duckDuringNarrationDb`, `duckAttackMs`, `duckReleaseMs`, `targetLufs`, `truePeakDb`, and the algorithm version. P05 includes this sub-fingerprint in the Draft Stage fingerprint; there is no separate Audio Mix Stage.

- [ ] **Step 3: Build the FFmpeg mix graph**

Create a `volume=<globalGain>*<piecewiseExpression>:eval=frame` filter for BGM, delay it by `backgroundMusic.startMs`, and mix with narration using `amix=inputs=2:normalize=0`. When P05 Draft invokes this implementation, serialize the complete graph once to the fixed write-once Run artifact `audio/filter-graph.txt`. Return its `{path, sha256}` reference for inclusion in Draft Stage outputs, then pass a fresh Run-scope read handle for that artifact to FFmpeg rather than placing the growing expression directly on the command line. Do not create or name an Audio Mix Stage.

Every independent project-supplied source-WAV/BGM consumer opens a fresh `ProjectDirectoryScope` handle; every narration-master/concat/filter/intermediate/final-mix consumer opens a separate fresh `RunDirectoryScope` handle. P04 opens no Work or Output scope; Work lock/current operations remain with `WorkDirectoryScope`, and P05 release publication must use `OutputDirectoryScope`. Scope kinds are not interchangeable. Map read and write descriptors with `extraStdioFds` (`/dev/fd/3`, `pipe:4`, and so on), consume each FD/pipe once, and close every caller-owned handle in `finally` after `runProcess()` settles. Trim the result to Composition duration, resample to 48kHz, and output stereo PCM WAV. The integration test must execute a graph generated from at least 100 narration intervals.

- [ ] **Step 4: Implement two-pass loudnorm**

First pass uses `loudnorm=I=<target>:TP=<peak>:LRA=11:print_format=json` to null output and parses measured values from stderr. Second pass supplies `measured_I`, `measured_LRA`, `measured_TP`, `measured_thresh`, and `offset`, then writes the fixed write-once Run artifact `audio/mixed-normalized.wav`. Return its `{path, sha256}` reference beside the filter-graph reference so P05 records both in Draft Stage outputs. Both passes use fresh scoped handles and borrowed read/write `extraStdioFds`; reject non-finite measurements.

- [ ] **Step 5: Verify and commit**

```bash
pnpm test tests/unit/media/audio-mix.test.ts tests/integration/media/audio-mix.test.ts
pnpm typecheck
git add src/media/audio-mix.ts src/media/loudness.ts tests/unit/media/audio-mix.test.ts tests/integration/media/audio-mix.test.ts
git commit -m "feat: mix and normalize narration audio"
```


## Project Exit Verification

- [ ] **Step 1: Run the complete portable P04 test set**

```bash
pnpm test tests/unit/providers/tts-contract.test.ts tests/unit/narration/build-narration.test.ts tests/unit/captions/build-captions.test.ts tests/unit/captions/srt.test.ts tests/unit/media/audio-mix.test.ts tests/integration/media/audio-mix.test.ts
pnpm typecheck
git diff --check
```

Expected: all tests pass, unchanged narration segments reuse their WAVs, caption boundaries obey the reviewed rounding rules, the 100-interval `audio/filter-graph.txt` executes successfully, both fixed Draft artifact references are returned, and every listed deterministic input independently changes `audioMixFingerprint()`.

- [ ] **Step 2: Run the target-Mac TTS smoke test**

```bash
RUN_SYSTEM_TTS_TESTS=1 pnpm test tests/integration/providers/macos-say.test.ts
```

Expected: the configured Chinese Voice produces non-empty decodable audio. If the target machine intentionally uses only File TTS, record this test as skipped with the configured per-segment WAV evidence.

- [ ] **Step 3: Verify the parallel-work boundary**

```bash
git status --short
git log --oneline --max-count=3
```

Expected: no files owned by P03, P05, or P06 are modified, and Tasks 8, 9, and 12 have focused commits.
