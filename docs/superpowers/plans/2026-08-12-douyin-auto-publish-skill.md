# Douyin Auto Publish Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a repository-local Codex Skill that validates `publish/douyin.json`, uses an existing signed-in Douyin Creator Center browser session to upload and directly publish one video, and records safe local receipts.

**Architecture:** Keep deterministic local state handling in dependency-free Node.js modules and keep fragile web interaction in a concise Skill backed by a detailed SOP. The validator resolves repository-confined files, computes the video SHA-256, and blocks duplicate or ambiguous attempts; a separate writer atomically records `published`, `unknown`, or `failed` outcomes.

**Tech Stack:** Node.js 22 ESM, Node built-in test runner, Markdown/YAML Codex Skill files, existing browser-control Skill, Python skill-creator validation through `uv`.

**Repository policy:** Commit steps are intentionally omitted because Git commits require an explicit user request.

---

## File Map

| File | Responsibility |
| --- | --- |
| `.agents/skills/douyin-auto-publish/SKILL.md` | Trigger rules, required browser workflow, direct-publish authorization, and hard stop conditions. |
| `.agents/skills/douyin-auto-publish/agents/openai.yaml` | User-facing Skill metadata and default prompt. |
| `.agents/skills/douyin-auto-publish/scripts/publish-state.mjs` | Strict schema validation, confined path resolution, hashing, receipt scanning, and atomic receipt primitives. |
| `.agents/skills/douyin-auto-publish/scripts/validate-publish-config.mjs` | CLI wrapper returning normalized preflight JSON and stable exit codes. |
| `.agents/skills/douyin-auto-publish/scripts/record-publish-result.mjs` | CLI wrapper validating and atomically writing a publish result. |
| `.agents/skills/douyin-auto-publish/references/douyin-publish-sop.md` | Operator preparation, execution, verification, and recovery guide. |
| `publish/douyin.example.json` | Tracked schema example. |
| `tests/skills/douyin-auto-publish/publish-state.test.mjs` | Behavioral tests for config, paths, hashing, duplicate detection, and receipts. |
| `tests/skills/douyin-auto-publish/skill-contract.test.mjs` | Static contract tests for Skill metadata, workflow guardrails, and SOP coverage. |
| `.gitignore` | Ignore operator config and receipts while retaining the example. |
| `package.json` | Add a focused `test:douyin-skill` command. |

## Task 1: Add Focused Test Harness

**Files:**
- Create: `tests/skills/douyin-auto-publish/publish-state.test.mjs`
- Create: `tests/skills/douyin-auto-publish/skill-contract.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add the focused test command**

Add this script to `package.json`:

```json
"test:douyin-skill": "node --test tests/skills/douyin-auto-publish/*.test.mjs"
```

- [ ] **Step 2: Write the first failing state test**

Create a Node test that imports the future state module and validates a minimal configuration:

```js
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {validatePublishConfig} from '../../../.agents/skills/douyin-auto-publish/scripts/publish-state.mjs';

test('validates a complete immediate publish configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'douyin-publish-'));
  await mkdir(path.join(root, 'media'));
  await writeFile(path.join(root, 'media/video.mp4'), 'video');
  await writeFile(path.join(root, 'media/cover.jpg'), 'cover');
  await mkdir(path.join(root, 'publish'));
  await writeFile(path.join(root, 'publish/douyin.json'), JSON.stringify({
    version: 1,
    account: {expectedName: '测试账号'},
    video: 'media/video.mp4',
    cover: 'media/cover.jpg',
    title: '测试标题',
    topics: ['人工智能'],
    visibility: 'public',
    allowDownload: true,
    publish: {mode: 'immediate', allowDuplicate: false},
  }));

  const result = await validatePublishConfig({
    projectRoot: root,
    configPath: 'publish/douyin.json',
  });

  assert.equal(result.config.account.expectedName, '测试账号');
  assert.match(result.video.sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.receipt.blocked, false);
});
```

- [ ] **Step 3: Write the first failing Skill contract test**

Create a test that expects the future Skill, metadata, and SOP files:

```js
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('documents direct publish guardrails', async () => {
  const skill = await readFile('.agents/skills/douyin-auto-publish/SKILL.md', 'utf8');
  assert.match(skill, /Use when/u);
  assert.match(skill, /publish\/douyin\.json/u);
  assert.match(skill, /account\.expectedName/u);
  assert.match(skill, /direct publish|直接发布/iu);
  assert.match(skill, /unknown/u);
  assert.match(skill, /CAPTCHA|验证码/iu);
});
```

- [ ] **Step 4: Run tests to verify RED state**

Run:

```bash
pnpm test:douyin-skill
```

Expected: FAIL because `publish-state.mjs` and Skill files do not exist.

## Task 2: Implement Strict Configuration and File Validation

**Files:**
- Create: `.agents/skills/douyin-auto-publish/scripts/publish-state.mjs`
- Modify: `tests/skills/douyin-auto-publish/publish-state.test.mjs`

- [ ] **Step 1: Add failing schema and path cases**

Add table-driven tests for unknown fields, unsupported versions, topics beginning with `#`, duplicate topics, invalid visibility, scheduled mode, missing files, unsupported extensions, absolute paths, `..` escapes, and symlinks resolving outside the project root.

Use these stable error expectations:

```js
const invalidConfigs = [
  ['unknown top-level field', {...validConfig, typo: true}, /unknown field/iu],
  ['wrong version', {...validConfig, version: 2}, /version/iu],
  ['topic includes hash', {...validConfig, topics: ['#AI']}, /must not start with #/iu],
  ['duplicate topic', {...validConfig, topics: ['AI', 'AI']}, /unique/iu],
  ['invalid visibility', {...validConfig, visibility: 'all'}, /visibility/iu],
  ['scheduled mode', {...validConfig, publish: {mode: 'scheduled'}}, /immediate/iu],
];
```

- [ ] **Step 2: Run focused tests to verify RED state**

Run `pnpm test:douyin-skill`.

Expected: FAIL on each unimplemented schema or path rule.

- [ ] **Step 3: Implement state primitives**

Export these stable interfaces from `publish-state.mjs`:

```js
export const EXIT_CODES = Object.freeze({ok: 0, invalid: 2, blocked: 3, io: 4});

export class PublishStateError extends Error {
  constructor(kind, message, options = {}) {
    super(message, options);
    this.name = 'PublishStateError';
    this.kind = kind;
  }
}

export async function validatePublishConfig({projectRoot, configPath}) {}
export async function scanReceipts({receiptDirectory, allowDuplicate}) {}
export async function recordPublishResult({preflight, result, now}) {}
```

Implementation requirements:

- use only Node core modules;
- reject unknown keys at every object level;
- trim strings while rejecting empty values;
- require unique topics without leading `#`;
- resolve `projectRoot` and target files with `realpath`;
- reject absolute configured file paths;
- reject any final target outside the real project root;
- require regular files and allowed extensions;
- hash the video through a read stream;
- derive `publish/receipts/douyin/<hash-without-prefix>/`;
- return JSON-serializable values only.

- [ ] **Step 4: Run focused tests to verify GREEN state**

Run `pnpm test:douyin-skill`.

Expected: schema, path, and hash tests PASS; receipt tests may still be pending.

## Task 3: Implement Duplicate Detection and Atomic Receipts

**Files:**
- Modify: `.agents/skills/douyin-auto-publish/scripts/publish-state.mjs`
- Modify: `tests/skills/douyin-auto-publish/publish-state.test.mjs`

- [ ] **Step 1: Add failing receipt tests**

Create timestamped receipt fixtures and assert:

```js
assert.equal((await validate(false, ['published'])).receipt.blocked, true);
assert.equal((await validate(true, ['published'])).receipt.blocked, false);
assert.equal((await validate(true, ['unknown'])).receipt.blocked, true);
assert.equal((await validate(false, ['failed'])).receipt.blocked, false);
```

Verify the writer filename matches:

```js
/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z-(published|unknown|failed)\.json$/u
```

and that no temporary file remains after the atomic rename.

- [ ] **Step 2: Run tests to verify RED state**

Run `pnpm test:douyin-skill`.

Expected: FAIL because receipt scanning and writing are incomplete.

- [ ] **Step 3: Implement receipt rules**

Use this blocking rule:

```js
const blocked = statuses.includes('unknown')
  || (!allowDuplicate && statuses.includes('published'));
```

The writer must accept only `published`, `unknown`, or `failed`; match video hash, account, and title to preflight; validate status-specific fields; write JSON with a trailing newline; rename a unique temporary file atomically; and remove the temporary file on failure.

- [ ] **Step 4: Run focused tests to verify GREEN state**

Run `pnpm test:douyin-skill`.

Expected: all state and receipt tests PASS.

## Task 4: Add CLI Wrappers

**Files:**
- Create: `.agents/skills/douyin-auto-publish/scripts/validate-publish-config.mjs`
- Create: `.agents/skills/douyin-auto-publish/scripts/record-publish-result.mjs`
- Modify: `tests/skills/douyin-auto-publish/publish-state.test.mjs`

- [ ] **Step 1: Add failing CLI tests**

Use `spawn` to verify valid config exits `0`, invalid config exits `2`, duplicate or unknown state exits `3`, local I/O failure exits `4`, and the recorder prints the project-relative receipt path.

- [ ] **Step 2: Run CLI tests to verify RED state**

Run `pnpm test:douyin-skill`.

Expected: FAIL because both wrappers are missing.

- [ ] **Step 3: Implement stable CLI interfaces**

Validator:

```bash
node .agents/skills/douyin-auto-publish/scripts/validate-publish-config.mjs \
  --project-root . \
  --config publish/douyin.json
```

Recorder:

```bash
node .agents/skills/douyin-auto-publish/scripts/record-publish-result.mjs \
  --preflight .work/douyin-preflight.json \
  --result .work/douyin-result.json
```

Both CLIs emit one JSON document to stdout. Errors emit one sanitized JSON document to stderr and set the mapped exit code.

- [ ] **Step 4: Run focused tests to verify GREEN state**

Run `pnpm test:douyin-skill`.

Expected: all local helper and CLI tests PASS.

## Task 5: Scaffold and Write the Repository Skill

**Files:**
- Create: `.agents/skills/douyin-auto-publish/SKILL.md`
- Create: `.agents/skills/douyin-auto-publish/agents/openai.yaml`
- Modify: `tests/skills/douyin-auto-publish/skill-contract.test.mjs`

- [ ] **Step 1: Expand the failing Skill contract**

Assert that the Skill starts its description with `Use when`, requires `browser:control-in-app-browser`, validates before browser work, distinguishes validation-only requests, verifies `account.expectedName`, requires the custom cover, re-reads fields before submission, treats explicit publish invocation as authorization, never bypasses CAPTCHA, records `unknown`, and references the SOP.

- [ ] **Step 2: Run the contract test to verify RED state**

Run `pnpm test:douyin-skill`.

Expected: FAIL because Skill files are missing.

- [ ] **Step 3: Scaffold into a temporary directory**

Run:

```bash
rm -rf .work/douyin-auto-publish-skill
python3 /Users/liuweitian1/.codex/skills/.system/skill-creator/scripts/init_skill.py \
  douyin-auto-publish \
  --path .work/douyin-auto-publish-skill \
  --resources scripts,references \
  --interface 'display_name=抖音自动发布' \
  --interface 'short_description=通过创作者中心按配置上传视频并直接发布' \
  --interface 'default_prompt=使用 $douyin-auto-publish 按 publish/douyin.json 将成片直接发布到抖音。'
```

Copy only the generated `SKILL.md` and `agents/openai.yaml` into the tested Skill directory so the existing scripts are not overwritten.

- [ ] **Step 4: Replace the generated Skill body**

Use this frontmatter:

```yaml
---
name: douyin-auto-publish
description: Use when the user explicitly asks to validate, upload, or directly publish a video through Douyin Creator Center using publish/douyin.json, including account checks, custom cover upload, duplicate prevention, and publish receipts.
---
```

Keep the body concise and place detailed operator steps in the SOP. Hard-stop rules remain in `SKILL.md`.

- [ ] **Step 5: Validate metadata and contract tests**

Run:

```bash
uv run --with pyyaml python \
  /Users/liuweitian1/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/douyin-auto-publish
pnpm test:douyin-skill
```

Expected: Skill validator succeeds and contract tests PASS.

## Task 6: Write the SOP and Example Configuration

**Files:**
- Create: `.agents/skills/douyin-auto-publish/references/douyin-publish-sop.md`
- Create: `publish/douyin.example.json`
- Modify: `.gitignore`
- Modify: `tests/skills/douyin-auto-publish/skill-contract.test.mjs`

- [ ] **Step 1: Add failing SOP coverage assertions**

Require sections for prerequisites, configuration, validation, publishing, success verification, receipts, unknown outcomes, login/CAPTCHA, and UI changes.

- [ ] **Step 2: Run contract tests to verify RED state**

Run `pnpm test:douyin-skill`.

Expected: FAIL because the SOP and example are incomplete.

- [ ] **Step 3: Write the operator SOP**

Document exact commands and this stage sequence:

```text
preflight → login-check → account-check → navigate → upload-video
→ fill-metadata → upload-cover → set-options → final-check
→ publish → verify → receipt
```

Include a recovery table matching the approved design and state that `unknown` must be manually resolved before retry.

- [ ] **Step 4: Add tracked example and ignore local state**

Add to `.gitignore`:

```gitignore
publish/douyin.json
publish/receipts/
```

Create `publish/douyin.example.json` with every schema field and safe placeholder paths.

- [ ] **Step 5: Run focused tests to verify GREEN state**

Run `pnpm test:douyin-skill`.

Expected: all Skill, SOP, example, state, and CLI tests PASS.

## Task 7: Full Verification and Spec Coverage Audit

**Files:**
- Verify: all files listed in the File Map
- Compare: `docs/superpowers/specs/2026-08-12-douyin-auto-publish-skill-design.md`

- [ ] **Step 1: Run focused Skill tests**

```bash
pnpm test:douyin-skill
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run repository verification**

```bash
pnpm typecheck
pnpm test
```

Expected: TypeScript exits `0`; the existing Vitest suite exits `0`.

- [ ] **Step 3: Run Skill packaging validation**

```bash
uv run --with pyyaml python \
  /Users/liuweitian1/.codex/skills/.system/skill-creator/scripts/quick_validate.py \
  .agents/skills/douyin-auto-publish
```

Expected: the Skill is valid.

- [ ] **Step 4: Exercise the validator through a temporary fixture**

Copy the example to a temporary project, create small placeholder `.mp4` and `.jpg` files, run the validator, and verify `ok: true`, a SHA-256, and `receipt.blocked: false`.

- [ ] **Step 5: Audit acceptance criteria**

Verify wrong-account, missing-cover, CAPTCHA, form-mismatch, duplicate, and ambiguous-submit rules are present in `SKILL.md` and expanded in the SOP.

- [ ] **Step 6: Inspect the final diff**

```bash
git diff --check
git status --short
git diff --stat
```

Expected: no whitespace errors; only the approved Skill, tests, docs, example, package script, and ignore rules are changed.
