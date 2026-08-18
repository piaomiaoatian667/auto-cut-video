import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PublishStateError,
  recordPublishResult,
  validatePublishConfig,
} from '../../../.agents/skills/douyin-auto-publish/scripts/publish-state.mjs';

const createConfig = (overrides = {}) => ({
  version: 1,
  account: {expectedName: '测试账号'},
  video: 'media/video.mp4',
  cover: 'media/cover.jpg',
  title: '测试标题',
  topics: ['人工智能'],
  visibility: 'public',
  allowDownload: true,
  publish: {mode: 'immediate', allowDuplicate: false},
  ...overrides,
});

const createProject = async (t, config = createConfig()) => {
  const root = await mkdtemp(path.join(tmpdir(), 'douyin-publish-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(path.join(root, 'media'));
  await mkdir(path.join(root, 'publish'));
  await writeFile(path.join(root, 'media/video.mp4'), 'video');
  await writeFile(path.join(root, 'media/cover.jpg'), 'cover');
  await writeFile(
    path.join(root, 'publish/douyin.json'),
    `${JSON.stringify(config)}\n`,
  );
  return root;
};

const validate = (root) => validatePublishConfig({
  projectRoot: root,
  configPath: 'publish/douyin.json',
});

const runNode = (scriptPath, args, cwd = process.cwd()) => new Promise((resolve) => {
  const child = spawn(process.execPath, [scriptPath, ...args], {cwd});
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.on('close', (code, signal) => resolve({code, signal, stdout, stderr}));
});

const expectInvalid = async (root, pattern) => {
  await assert.rejects(validate(root), (error) => {
    assert.ok(error instanceof PublishStateError);
    assert.equal(error.kind, 'invalid');
    assert.match(error.message, pattern);
    return true;
  });
};

test('validates and normalizes a complete immediate publish configuration', async (t) => {
  const root = await createProject(t, createConfig({
    account: {expectedName: '  测试账号  '},
    title: '  测试标题  ',
    topics: ['  人工智能  '],
  }));

  const result = await validate(root);

  assert.equal(result.config.account.expectedName, '测试账号');
  assert.equal(result.config.title, '测试标题');
  assert.deepEqual(result.config.topics, ['人工智能']);
  assert.match(result.video.sha256, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.video.size, 5);
  assert.equal(result.receipt.blocked, false);
  assert.equal(result.receipt.statuses.length, 0);
});

test('defaults allowDuplicate to false', async (t) => {
  const root = await createProject(t, createConfig({
    publish: {mode: 'immediate'},
  }));

  const result = await validate(root);

  assert.equal(result.config.publish.allowDuplicate, false);
});

test('rejects unknown fields at every object level', async (t) => {
  const cases = [
    createConfig({typo: true}),
    createConfig({account: {expectedName: '测试账号', typo: true}}),
    createConfig({publish: {mode: 'immediate', typo: true}}),
  ];

  for (const config of cases) {
    const root = await createProject(t, config);
    await expectInvalid(root, /unknown field/iu);
  }
});

test('rejects unsupported versions and field values', async (t) => {
  const cases = [
    [createConfig({version: 2}), /version/iu],
    [createConfig({visibility: 'all'}), /visibility/iu],
    [createConfig({allowDownload: 'yes'}), /allowDownload/iu],
    [createConfig({publish: {mode: 'scheduled'}}), /immediate/iu],
    [createConfig({publish: {mode: 'immediate', allowDuplicate: 'yes'}}), /allowDuplicate/iu],
  ];

  for (const [config, pattern] of cases) {
    const root = await createProject(t, config);
    await expectInvalid(root, pattern);
  }
});

test('rejects empty strings, invalid topics, and duplicate topics', async (t) => {
  const cases = [
    [createConfig({account: {expectedName: '  '}}), /expectedName/iu],
    [createConfig({title: ''}), /title/iu],
    [createConfig({topics: ['']}), /topic/iu],
    [createConfig({topics: ['#AI']}), /must not start with #/iu],
    [createConfig({topics: ['AI', ' AI ']}), /unique/iu],
  ];

  for (const [config, pattern] of cases) {
    const root = await createProject(t, config);
    await expectInvalid(root, pattern);
  }
});

test('rejects missing files and unsupported extensions', async (t) => {
  const missingVideo = await createProject(t, createConfig({video: 'media/missing.mp4'}));
  await expectInvalid(missingVideo, /video/iu);

  const missingCover = await createProject(t, createConfig({cover: 'media/missing.jpg'}));
  await expectInvalid(missingCover, /cover/iu);

  const unsupportedVideo = await createProject(t, createConfig({video: 'media/video.mov'}));
  await writeFile(path.join(unsupportedVideo, 'media/video.mov'), 'video');
  await expectInvalid(unsupportedVideo, /\.mp4/iu);

  const unsupportedCover = await createProject(t, createConfig({cover: 'media/cover.gif'}));
  await writeFile(path.join(unsupportedCover, 'media/cover.gif'), 'cover');
  await expectInvalid(unsupportedCover, /cover extension/iu);
});

test('rejects empty video and cover files', async (t) => {
  const emptyVideo = await createProject(t);
  await writeFile(path.join(emptyVideo, 'media/video.mp4'), '');
  await expectInvalid(emptyVideo, /video.*empty/iu);

  const emptyCover = await createProject(t);
  await writeFile(path.join(emptyCover, 'media/cover.jpg'), '');
  await expectInvalid(emptyCover, /cover.*empty/iu);
});

test('rejects absolute paths and parent-directory escapes', async (t) => {
  const absoluteVideo = await createProject(t, createConfig({video: '/tmp/video.mp4'}));
  await expectInvalid(absoluteVideo, /relative/iu);

  const root = await createProject(t, createConfig({video: '../outside.mp4'}));
  await writeFile(path.join(root, '../outside.mp4'), 'outside');
  await expectInvalid(root, /outside project root/iu);
});

test('rejects symlinks resolving outside the project root', async (t) => {
  const root = await createProject(t, createConfig({video: 'media/linked.mp4'}));
  const outsideDirectory = await mkdtemp(path.join(tmpdir(), 'douyin-outside-'));
  t.after(() => rm(outsideDirectory, {recursive: true, force: true}));
  const outsideVideo = path.join(outsideDirectory, 'outside.mp4');
  await writeFile(outsideVideo, 'outside');
  await symlink(outsideVideo, path.join(root, 'media/linked.mp4'));

  await expectInvalid(root, /outside project root/iu);
});

const addReceipt = async (preflight, fileName, receipt) => {
  await mkdir(preflight.receipt.directory, {recursive: true});
  await writeFile(
    path.join(preflight.receipt.directory, fileName),
    `${JSON.stringify(receipt)}\n`,
  );
};

test('blocks published receipts unless duplicates are explicitly allowed', async (t) => {
  const root = await createProject(t);
  const preflight = await validate(root);
  await addReceipt(preflight, 'published.json', {status: 'published'});

  const blocked = await validate(root);
  assert.equal(blocked.receipt.blocked, true);
  assert.equal(blocked.receipt.reason, 'published');

  await writeFile(
    path.join(root, 'publish/douyin.json'),
    `${JSON.stringify(createConfig({
      publish: {mode: 'immediate', allowDuplicate: true},
    }))}\n`,
  );
  const allowed = await validate(root);
  assert.equal(allowed.receipt.blocked, false);
  assert.deepEqual(allowed.receipt.statuses, ['published']);
});

test('always blocks unknown receipts and ignores failed receipts', async (t) => {
  const unknownRoot = await createProject(t, createConfig({
    publish: {mode: 'immediate', allowDuplicate: true},
  }));
  const unknownPreflight = await validate(unknownRoot);
  await addReceipt(unknownPreflight, 'unknown.json', {status: 'unknown'});
  const unknown = await validate(unknownRoot);
  assert.equal(unknown.receipt.blocked, true);
  assert.equal(unknown.receipt.reason, 'unknown');

  const failedRoot = await createProject(t);
  const failedPreflight = await validate(failedRoot);
  await addReceipt(failedPreflight, 'failed.json', {status: 'failed'});
  const failed = await validate(failedRoot);
  assert.equal(failed.receipt.blocked, false);
  assert.deepEqual(failed.receipt.statuses, ['failed']);
});

test('rejects malformed receipt state as an I/O failure', async (t) => {
  const root = await createProject(t);
  const preflight = await validate(root);
  await mkdir(preflight.receipt.directory, {recursive: true});
  await writeFile(path.join(preflight.receipt.directory, 'broken.json'), '{');

  await assert.rejects(validate(root), (error) => {
    assert.ok(error instanceof PublishStateError);
    assert.equal(error.kind, 'io');
    assert.match(error.message, /receipt/iu);
    return true;
  });
});

test('records a published result atomically', async (t) => {
  const root = await createProject(t);
  const preflight = await validate(root);
  const result = await recordPublishResult({
    preflight,
    result: {
      status: 'published',
      accountName: '测试账号',
      videoSha256: preflight.video.sha256,
      title: '测试标题',
      topics: ['人工智能'],
      visibility: 'public',
      allowDownload: true,
      workId: 'work-1',
      workUrl: 'https://creator.douyin.com/work-1',
    },
    now: () => new Date('2026-08-12T12:34:56.789Z'),
  });

  assert.match(
    path.basename(result.path),
    /^2026-08-12T12-34-56\.789Z-published\.json$/u,
  );
  const stored = JSON.parse(await readFile(result.path, 'utf8'));
  assert.equal(stored.status, 'published');
  assert.equal(stored.publishedAt, '2026-08-12T12:34:56.789Z');
  assert.equal(stored.workId, 'work-1');
  const directoryEntries = await readdir(preflight.receipt.directory);
  assert.deepEqual(directoryEntries, [path.basename(result.path)]);
});

test('records unknown and failed attempts with required stages', async (t) => {
  for (const status of ['unknown', 'failed']) {
    const root = await createProject(t);
    const preflight = await validate(root);
    const recorded = await recordPublishResult({
      preflight,
      result: {
        status,
        accountName: status === 'failed' ? null : '测试账号',
        videoSha256: preflight.video.sha256,
        title: '测试标题',
        stage: status === 'unknown' ? 'verify-after-submit' : 'upload-cover',
        lastKnownUrl: 'https://creator.douyin.com/creator-micro/home',
        message: status === 'failed' ? '封面上传失败' : undefined,
      },
      now: () => new Date('2026-08-12T12:34:56.789Z'),
    });
    const stored = JSON.parse(await readFile(recorded.path, 'utf8'));
    assert.equal(stored.status, status);
    assert.equal(stored.stage, status === 'unknown' ? 'verify-after-submit' : 'upload-cover');
  }
});

test('rejects result payloads that do not match preflight', async (t) => {
  const root = await createProject(t);
  const preflight = await validate(root);
  const baseResult = {
    status: 'published',
    accountName: '测试账号',
    videoSha256: preflight.video.sha256,
    title: '测试标题',
    topics: ['人工智能'],
    visibility: 'public',
    allowDownload: true,
    workId: null,
    workUrl: null,
  };

  for (const result of [
    {...baseResult, accountName: '错误账号'},
    {...baseResult, videoSha256: 'sha256:wrong'},
    {...baseResult, title: '错误标题'},
  ]) {
    await assert.rejects(
      recordPublishResult({preflight, result}),
      (error) => error instanceof PublishStateError && error.kind === 'invalid',
    );
  }
});

test('validator CLI prints preflight JSON and stable exit codes', async (t) => {
  const script = '.agents/skills/douyin-auto-publish/scripts/validate-publish-config.mjs';
  const validRoot = await createProject(t);
  const valid = await runNode(script, [
    '--project-root', validRoot,
    '--config', 'publish/douyin.json',
  ]);
  assert.equal(valid.code, 0);
  assert.equal(JSON.parse(valid.stdout).ok, true);

  const invalidRoot = await createProject(t, createConfig({version: 2}));
  const invalid = await runNode(script, [
    '--project-root', invalidRoot,
    '--config', 'publish/douyin.json',
  ]);
  assert.equal(invalid.code, 2);
  assert.equal(JSON.parse(invalid.stderr).error.kind, 'invalid');

  const blockedRoot = await createProject(t);
  const blockedPreflight = await validate(blockedRoot);
  await addReceipt(blockedPreflight, 'unknown.json', {status: 'unknown'});
  const blocked = await runNode(script, [
    '--project-root', blockedRoot,
    '--config', 'publish/douyin.json',
  ]);
  assert.equal(blocked.code, 3);
  assert.equal(JSON.parse(blocked.stderr).error.kind, 'blocked');

  const io = await runNode(script, [
    '--project-root', path.join(validRoot, 'missing'),
    '--config', 'publish/douyin.json',
  ]);
  assert.equal(io.code, 4);
  assert.equal(JSON.parse(io.stderr).error.kind, 'io');
});

test('recorder CLI writes a receipt and returns its relative path', async (t) => {
  const script = '.agents/skills/douyin-auto-publish/scripts/record-publish-result.mjs';
  const root = await createProject(t);
  const preflight = await validate(root);
  const workDirectory = path.join(root, '.work');
  await mkdir(workDirectory);
  const preflightPath = path.join(workDirectory, 'preflight.json');
  const resultPath = path.join(workDirectory, 'result.json');
  await writeFile(preflightPath, `${JSON.stringify({ok: true, preflight})}\n`);
  await writeFile(resultPath, `${JSON.stringify({
    status: 'published',
    accountName: '测试账号',
    videoSha256: preflight.video.sha256,
    title: '测试标题',
    topics: ['人工智能'],
    visibility: 'public',
    allowDownload: true,
    workId: null,
    workUrl: null,
  })}\n`);

  const recorded = await runNode(script, [
    '--preflight', preflightPath,
    '--result', resultPath,
  ]);

  assert.equal(recorded.code, 0);
  const output = JSON.parse(recorded.stdout);
  assert.equal(output.ok, true);
  assert.match(output.receipt.path, /^publish\/receipts\/douyin\//u);
  assert.equal(JSON.parse(await readFile(path.join(root, output.receipt.path), 'utf8')).status, 'published');
});
