---
name: douyin-auto-publish
description: Use when the user explicitly asks to validate, upload, or directly publish a video through Douyin Creator Center using publish/douyin.json, including account checks, custom cover upload, duplicate prevention, and publish receipts.
---

# Douyin Auto Publish

Publish exactly one configured video through the signed-in Douyin Creator Center session. Keep local validation deterministic and treat the visible Creator Center form as authoritative.

**REQUIRED SUB-SKILL:** Use `browser:control-in-app-browser`. Do not substitute standalone Playwright or a saved browser profile. Read `references/douyin-publish-sop.md` for commands, result payloads, and recovery details.

## Choose The Mode

- For validation-only / 只校验 requests, run preflight and stop before browser work.
- For an explicit publish request, the request plus validated `publish/douyin.json` is action-time authorization to upload the configured video and custom cover and perform direct publish / 直接发布. After `final-check`, do not ask again / 不再二次询问.

## Preflight

Run from the repository root:

```bash
mkdir -p .work
node .agents/skills/douyin-auto-publish/scripts/validate-publish-config.mjs \
  --project-root . \
  --config publish/douyin.json \
  > .work/douyin-preflight.json
```

Stop on any nonzero exit. Exit `3` means a `published` or `unknown` receipt blocks the run. Never delete or bypass an `unknown` receipt to retry automatically.

## Browser Workflow

1. Open `https://creator.douyin.com/creator-micro/home` with the required browser Skill.
2. If signed out, ask the user to finish login, then resume. Never store credentials, Cookie data, QR codes, SMS codes, or other login material.
3. Compare the visible account exactly with `account.expectedName`; stop on mismatch and never switch accounts automatically.
4. Navigate through visible Creator Center controls to video publishing. Use semantic labels and fresh page state, not guessed internal URLs or fragile CSS classes.
5. Before selecting files, read the browser Skill's `file-uploads` guidance. Upload only the validated video path from preflight and wait for transfer and processing to finish.
6. Fill the configured title and topics. Confirm every topic is visibly applied.
7. Upload the configured custom cover / 自定义封面. If it cannot be visibly verified, stop; never publish with an automatic fallback cover.
8. Set visibility and download permission from config.
9. Perform `final-check`: re-read account, upload completion, title, topics, custom cover, visibility, download permission, validation messages, and enabled publish control.
10. Click the semantically identified publish control directly. Never use a coordinate-only final click.
11. Treat only an authoritative success message, success page, or matching new work-management item as published.

## Record The Outcome

Write `.work/douyin-result.json` using the payload shape in the SOP, then run:

```bash
node .agents/skills/douyin-auto-publish/scripts/record-publish-result.mjs \
  --preflight .work/douyin-preflight.json \
  --result .work/douyin-result.json
```

- Record `published` only after authoritative verification.
- If publish was clicked but the result is ambiguous, record `unknown` immediately and stop. Do not retry.
- For failures before clicking publish, record `failed` with the stage and a short sanitized message when preflight exists.
- If CAPTCHA / 验证码, QR confirmation, or risk control / 风控 appears, stop and hand control to the user. Never bypass it.
