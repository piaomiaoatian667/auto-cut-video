#!/usr/bin/env node
import {appendFile, writeFile} from 'node:fs/promises';

const args = process.argv.slice(2);
const record = process.env.FAKE_YT_DLP_RECORD;

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
  process.stdout.write('Chrome-136      Macos-15     curl_cffi\n');
  process.exit(0);
}
if (record !== undefined) {
  await appendFile(
    record,
    `${args.includes('--dump-single-json') ? 'probe' : 'download'}\n`,
  );
}
if (args.includes('--dump-single-json')) {
  process.stdout.write(`${JSON.stringify({
    id: 'abc',
    title: 'Doctor fixture',
    webpage_url: 'https://www.youtube.com/watch?v=abc',
    extractor: 'youtube',
    extractor_key: 'Youtube',
    _type: 'video',
    has_drm: false,
  })}\n`);
  process.exit(0);
}
await writeFile('video.webm', Buffer.from('fixture'));
