import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const skillRoot = '.agents/skills/douyin-auto-publish';

test('skill metadata exposes the intended trigger and prompt', async () => {
  const skill = await readFile(`${skillRoot}/SKILL.md`, 'utf8');
  const metadata = await readFile(`${skillRoot}/agents/openai.yaml`, 'utf8');

  assert.match(skill, /^---\nname: douyin-auto-publish\ndescription: Use when /u);
  assert.match(metadata, /display_name: "抖音自动发布"/u);
  assert.match(metadata, /short_description: ".{25,64}"/u);
  assert.match(metadata, /default_prompt: ".*\$douyin-auto-publish/u);
  assert.match(metadata, /allow_implicit_invocation: true/u);
});

test('skill documents direct publish guardrails', async () => {
  const skill = await readFile(`${skillRoot}/SKILL.md`, 'utf8');

  assert.match(skill, /browser:control-in-app-browser/u);
  assert.match(skill, /validate-publish-config\.mjs/u);
  assert.match(skill, /publish\/douyin\.json/u);
  assert.match(skill, /validation-only|只校验/iu);
  assert.match(skill, /account\.expectedName/u);
  assert.match(skill, /custom cover|自定义封面/iu);
  assert.match(skill, /final-check/u);
  assert.match(skill, /direct publish|直接发布/iu);
  assert.match(skill, /do not ask again|不再二次询问/iu);
  assert.match(skill, /CAPTCHA|验证码/iu);
  assert.match(skill, /risk control|风控/iu);
  assert.match(skill, /unknown/u);
  assert.match(skill, /record-publish-result\.mjs/u);
  assert.match(skill, /references\/douyin-publish-sop\.md/u);
  assert.match(skill, /Cookie|credentials|凭据/iu);
});

test('SOP covers preparation, publishing, verification, and recovery', async () => {
  const sop = await readFile(`${skillRoot}/references/douyin-publish-sop.md`, 'utf8');

  for (const section of [
    /Prerequisites|前置条件/iu,
    /Configuration|配置/iu,
    /Validate|校验/iu,
    /Publish|发布流程/iu,
    /Success verification|成功验收/iu,
    /Receipts|回执/iu,
    /Unknown outcome|unknown 状态/iu,
    /Login and CAPTCHA|登录与验证码/iu,
    /UI changes|页面变化/iu,
  ]) {
    assert.match(sop, section);
  }
  assert.match(sop, /preflight.*login-check.*account-check.*navigate/isu);
  assert.match(sop, /record-publish-result\.mjs/u);
  assert.match(sop, /"status": "published"/u);
  assert.match(sop, /"status": "unknown"/u);
  assert.match(sop, /"status": "failed"/u);
});

test('example config and ignore rules match the local-state contract', async () => {
  const example = JSON.parse(await readFile('publish/douyin.example.json', 'utf8'));
  const gitignore = await readFile('.gitignore', 'utf8');

  assert.deepEqual(Object.keys(example), [
    'version',
    'account',
    'video',
    'cover',
    'title',
    'topics',
    'visibility',
    'allowDownload',
    'publish',
  ]);
  assert.equal(example.publish.mode, 'immediate');
  assert.equal(example.publish.allowDuplicate, false);
  assert.match(gitignore, /^publish\/douyin\.json$/mu);
  assert.match(gitignore, /^publish\/receipts\/$/mu);
});
