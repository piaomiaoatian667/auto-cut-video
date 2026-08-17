#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
delete process.env.__CF_USER_TEXT_ENCODING;

if (args.includes('--version')) {
  process.stdout.write('2026.07.04\n');
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write(
    '--js-runtimes RUNTIME[:PATH]\n--remote-components COMPONENT\n',
  );
  process.exit(0);
}
if (args.includes('--list-impersonate-targets')) {
  process.stdout.write('Chrome-136 Macos-15 curl_cffi\n');
  process.exit(0);
}

const failures = {
  'rate-limit': 'HTTP Error 429: Too Many Requests',
  'bot-check': 'Sign in to confirm you are not a bot',
  'bilibili-412': 'HTTP Error 412: Precondition Failed',
  timeout: 'Connection timed out',
  'missing-impersonation': 'Impersonate target is unavailable',
  'missing-provider': 'bgutil script provider unavailable',
  'keychain-denied': 'Keychain access denied',
  unknown: 'unclassified fixture failure',
};
const pairOptions = new Set([
  '--proxy',
  '--playlist-items',
  '--retries',
  '--fragment-retries',
  '--extractor-retries',
  '--retry-sleep',
  '--cookies-from-browser',
  '--plugin-dirs',
  '--js-runtimes',
  '--extractor-args',
  '--sleep-requests',
  '--impersonate',
  '--sub-langs',
  '--output',
  '--ffmpeg-location',
]);
const allowedFlags = new Set([
  '--ignore-config',
  '--no-geo-bypass',
  '--no-playlist',
  '--no-plugin-dirs',
  '--no-js-runtimes',
  '--no-remote-components',
  '--skip-download',
  '--dump-single-json',
  '--no-progress',
  '--write-thumbnail',
  '--write-subs',
  '--write-auto-subs',
]);
const forbiddenFlags = new Set([
  '--geo-bypass',
  '--yes-playlist',
  '--batch-file',
  '--remux-video',
  '--recode-video',
]);
const phaseOnlyFlags = new Set([
  '--skip-download',
  '--dump-single-json',
  '--no-progress',
  '--write-thumbnail',
  '--write-subs',
  '--write-auto-subs',
]);
const phaseOnlyPairs = new Set([
  '--sub-langs',
  '--output',
  '--ffmpeg-location',
]);

const reject = (message) => {
  process.stderr.write(`fake yt-dlp rejected arguments: ${message}\n`);
  process.exit(64);
};

const pairs = new Map();
const flags = [];
const positionals = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (!argument.startsWith('--')) {
    positionals.push(argument);
    continue;
  }
  if (argument.includes('=')) reject('equals-form options are unsupported');
  if (forbiddenFlags.has(argument)) reject(`forbidden flag ${argument}`);
  if (pairOptions.has(argument)) {
    if (index + 1 >= args.length) reject(`missing value for ${argument}`);
    const value = args[index + 1];
    const values = pairs.get(argument) ?? [];
    values.push(value);
    pairs.set(argument, values);
    index += 1;
    continue;
  }
  if (!allowedFlags.has(argument)) reject(`unknown flag ${argument}`);
  flags.push(argument);
}

if ((pairs.get('--proxy') ?? []).length !== 1) {
  reject('exactly one proxy pair is required');
}
if (positionals.length !== 1) reject('exactly one URL is required');
for (const value of pairs.get('--extractor-args') ?? []) {
  if (!value.startsWith('youtubepot-bgutilscript:server_home=')) {
    reject('arbitrary extractor arguments are unsupported');
  }
}

const requireFlag = (name) => {
  if (flags.filter((value) => value === name).length !== 1) {
    reject(`expected one ${name}`);
  }
};
const requirePair = (name, expectedValues) => {
  const values = pairs.get(name) ?? [];
  if (
    values.length !== expectedValues.length ||
    values.some((value, index) => value !== expectedValues[index])
  ) {
    reject(`unexpected ${name} values`);
  }
};

requireFlag('--ignore-config');
requireFlag('--no-geo-bypass');
requireFlag('--no-playlist');
requirePair('--playlist-items', ['1']);
requirePair('--retries', ['3']);
requirePair('--fragment-retries', ['3']);
requirePair('--extractor-retries', ['3']);
requirePair('--retry-sleep', [
  'http:exp=1:4',
  'fragment:exp=1:4',
  'extractor:exp=1:4',
]);
if ((pairs.get('--cookies-from-browser') ?? []).length > 1) {
  reject('duplicate browser Cookie pairs are unsupported');
}
if (
  (pairs.get('--cookies-from-browser') ?? []).some((value) => value !== 'chrome')
) {
  reject('only Chrome Cookies are supported');
}

const url = positionals[0];
let parsedUrl;
try {
  parsedUrl = new URL(url);
} catch {
  reject('URL must be parseable');
}
const hostname = parsedUrl.hostname.toLowerCase();
const platform = hostname.endsWith('youtube.com') || hostname === 'youtu.be'
  ? 'youtube'
  : hostname.endsWith('bilibili.com') || hostname === 'b23.tv'
    ? 'bilibili'
    : hostname.endsWith('douyin.com')
      ? 'douyin'
      : hostname.endsWith('tiktok.com')
        ? 'tiktok'
        : hostname.endsWith('vimeo.com')
          ? 'vimeo'
          : undefined;
if (platform === undefined) reject('unsupported fixture platform');

if (platform === 'youtube') {
  requireFlag('--no-plugin-dirs');
  requireFlag('--no-js-runtimes');
  requireFlag('--no-remote-components');
  if ((pairs.get('--plugin-dirs') ?? []).length !== 1) {
    reject('one plugin directory is required');
  }
  if ((pairs.get('--js-runtimes') ?? []).length !== 1) {
    reject('one JavaScript runtime is required');
  }
  if ((pairs.get('--extractor-args') ?? []).length !== 1) {
    reject('one provider extractor argument is required');
  }
  requirePair('--sleep-requests', ['1']);
  if ((pairs.get('--impersonate') ?? []).length !== 0) {
    reject('YouTube must not use browser impersonation');
  }
} else {
  for (const option of [
    '--plugin-dirs',
    '--js-runtimes',
    '--extractor-args',
    '--sleep-requests',
  ]) {
    if ((pairs.get(option) ?? []).length !== 0) {
      reject(`${platform} must not use YouTube provider options`);
    }
  }
  const impersonationExpected = new Set(['bilibili', 'tiktok', 'vimeo'])
    .has(platform);
  requirePair(
    '--impersonate',
    impersonationExpected ? ['Chrome-136:Macos-15'] : [],
  );
}

const phase = flags.includes('--dump-single-json') ? 'probe' : 'download';
if (phase === 'probe') {
  requireFlag('--skip-download');
  requireFlag('--dump-single-json');
  for (const flag of [
    '--no-progress',
    '--write-thumbnail',
    '--write-subs',
    '--write-auto-subs',
  ]) {
    if (flags.includes(flag)) reject(`probe received ${flag}`);
  }
  for (const option of phaseOnlyPairs) {
    if ((pairs.get(option) ?? []).length !== 0) {
      reject(`probe received ${option}`);
    }
  }
} else {
  for (const flag of [
    '--no-progress',
    '--write-thumbnail',
    '--write-subs',
    '--write-auto-subs',
  ]) requireFlag(flag);
  if (flags.includes('--skip-download') || flags.includes('--dump-single-json')) {
    reject('download received probe flags');
  }
  requirePair('--sub-langs', ['zh.*,en.*']);
  requirePair('--output', ['video.%(ext)s']);
  if ((pairs.get('--ffmpeg-location') ?? []).length > 1) {
    reject('duplicate FFmpeg locations are unsupported');
  }
}

const commonArguments = [];
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  if (!argument.startsWith('--')) continue;
  if (pairOptions.has(argument)) {
    const value = args[index + 1];
    if (!phaseOnlyPairs.has(argument)) commonArguments.push(argument, value);
    index += 1;
    continue;
  }
  if (!phaseOnlyFlags.has(argument)) commonArguments.push(argument);
}
const digest = createHash('sha256')
  .update(JSON.stringify(commonArguments))
  .digest('hex');
const recordDirectory = process.env.FAKE_YT_DLP_RECORD_DIRECTORY;
if (recordDirectory !== undefined) {
  await mkdir(recordDirectory, {recursive: true});
  const operationsPath = path.join(recordDirectory, 'operations.jsonl');
  if (phase === 'download') {
    let probeRecord;
    try {
      const records = (await readFile(operationsPath, 'utf8'))
        .split(/\r?\n/u)
        .filter((line) => line.length > 0);
      probeRecord = JSON.parse(records.at(-1));
    } catch {
      reject('download has no matching probe digest');
    }
    if (probeRecord?.phase !== 'probe' || probeRecord.digest !== digest) {
      reject('probe/download common arguments differ');
    }
  }
  await appendFile(
    operationsPath,
    `${JSON.stringify({phase, digest})}\n`,
  );
}
const legacyRecord = process.env.FAKE_YT_DLP_RECORD;
if (legacyRecord !== undefined) await appendFile(legacyRecord, `${phase}\n`);

const scenario = process.env.FAKE_YT_DLP_SCENARIO;
const failurePhase = process.env.FAKE_YT_DLP_FAILURE_PHASE;
if (
  scenario !== undefined &&
  Object.hasOwn(failures, scenario) &&
  (failurePhase === undefined || failurePhase === phase)
) {
  const sensitiveDetails = scenario === 'keychain-denied'
    ? '\nChrome profile database: /Users/fixture/Library/Application Support/Google/Chrome/Default/Cookies\nCookie: secret-cookie-marker\n'
    : '\n';
  process.stderr.write(`${failures[scenario]}${sensitiveDetails}`);
  process.exit(1);
}

const identifier = platform === 'youtube'
  ? parsedUrl.searchParams.get('v') ?? parsedUrl.pathname.split('/').filter(Boolean).at(-1)
  : parsedUrl.pathname.split('/').filter(Boolean).at(-1);
if (identifier === undefined || identifier.length === 0) reject('missing video ID');
const canonicalUrl = platform === 'youtube'
  ? `https://www.youtube.com/watch?v=${identifier}`
  : platform === 'bilibili'
    ? `https://www.bilibili.com/video/${identifier}`
    : platform === 'douyin'
      ? `https://www.douyin.com/video/${identifier}`
      : platform === 'tiktok'
        ? `https://www.tiktok.com/@fixture/video/${identifier}`
        : `https://vimeo.com/${identifier}`;
const extractor = {
  youtube: 'Youtube',
  bilibili: 'BiliBili',
  douyin: 'Douyin',
  tiktok: 'TikTok',
  vimeo: 'Vimeo',
}[platform];

if (phase === 'probe') {
  process.stdout.write(`${JSON.stringify({
    id: identifier,
    title: `${platform} fixture ${identifier}`,
    webpage_url: canonicalUrl,
    extractor,
    extractor_key: extractor,
    _type: 'video',
    availability: 'public',
    has_drm: false,
    cookies: 'cookie-value-marker',
    url: 'signed-url-marker',
    filepath: '/private/browser-profile-marker',
    http_headers: {Authorization: 'header-secret-marker'},
  })}\n`);
  process.exit(0);
}

if (process.env.FAKE_YT_DLP_LONG_RUNNING === '1') {
  const stateDirectory = process.env.FAKE_YT_DLP_STATE_DIRECTORY;
  if (stateDirectory === undefined) reject('long-running state directory is required');
  await mkdir(stateDirectory, {recursive: true});
  for (let index = 0; index < 2000; index += 1) {
    await writeFile(`video.${index}.tmp`, 'x');
  }
  process.on('SIGTERM', () => {});
  const childScript = [
    'const {writeFileSync, appendFileSync, renameSync} = require("node:fs");',
    'const path = require("node:path");',
    'const state = process.env.FAKE_YT_DLP_STATE_DIRECTORY;',
    'delete process.env.__CF_USER_TEXT_ENCODING;',
    'writeFileSync(path.join(state, "child-environment.json"), JSON.stringify(process.env));',
    'process.on("SIGTERM", () => {});',
    'let count = 0;',
    'setInterval(() => {',
    '  count += 1;',
    '  const temporary = path.join(state, "write-count.tmp");',
    '  writeFileSync(temporary, String(count));',
    '  renameSync(temporary, path.join(state, "write-count"));',
    '  appendFileSync("video.part", "x");',
    '}, 20);',
  ].join('\n');
  const child = spawn(process.execPath, ['-e', childScript], {
    env: {...process.env},
    stdio: 'ignore',
  });
  await writeFile(
    path.join(stateDirectory, 'pids.json'),
    `${JSON.stringify({parent: process.pid, child: child.pid})}\n`,
  );
  await writeFile(path.join(stateDirectory, 'ready'), 'ready\n');
  await new Promise((resolve) => child.once('exit', resolve));
  process.exit(0);
}

const media = Buffer.from(
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHpEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggHT7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiEBEAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYiEq3ddn3lI5JyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAJiWgDgkLCBELqBEJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAyc3PWY8CLY8WIhKt3XZ95SORnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMiBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjA0MDAwMDAwMAAfQ7Z1qOeBAKOjgQAAgBACAJ0BKhAAEAAARwiFhYiFhIgCAgAMDWAA/v+rUIAcU7trkbuPs4EAt4r3gQHxggGm8IED',
  'base64',
);
const thumbnail = Buffer.from(
  'UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==',
  'base64',
);
await Promise.all([
  writeFile('video.webm', media),
  writeFile('video.en.vtt', [
    'WEBVTT',
    '',
    '00:00:00.000 --> 00:00:01.000',
    `Fixture subtitle for ${platform}.`,
    '',
  ].join('\n')),
  writeFile('video.webp', thumbnail),
]);
