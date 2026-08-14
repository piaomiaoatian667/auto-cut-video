import {execFile} from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';
import {
  createSystemDownloadDependencies,
  downloadVideo,
} from '../../../src/download/downloader';
import {DownloadReceiptSchema} from '../../../src/download/receipt-schema';

const CANONICAL_URL = 'https://www.youtube.com/watch?v=abc';
const FIXED_DOWNLOAD_TIME = new Date('2026-07-04T12:00:00.000Z');
const TITLE = 'System download fixture';
const FINAL_FILENAMES = [
  'receipt.json',
  'video.en.vtt',
  'video.info.json',
  'video.webm',
  'video.webp',
] as const;
const INFO_DOCUMENT = {
  id: 'abc',
  title: TITLE,
  webpage_url: CANONICAL_URL,
  extractor: 'youtube',
  extractor_key: 'Youtube',
  _type: 'video',
};
const COOKIE_INFO_DOCUMENT = {
  id: '7654841525762919726',
  title: 'Cookie-assisted Douyin fixture',
  webpage_url: 'https://www.douyin.com/video/7654841525762919726',
  extractor: 'Douyin',
  extractor_key: 'Douyin',
  _type: 'video',
  availability: 'public',
};
const SUBTITLE_CONTENTS = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:01.000',
  'Fixture subtitle.',
  '',
].join('\n');
const WEBM_BASE64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAHpEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggHT7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAyV0GNTGF2ZjYyLjEyLjEwMkSJiEBEAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYiEq3ddn3lI5JyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAJiWgDgkLCBELqBEJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAyc3PWY8CLY8WIhKt3XZ95SORnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMiBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjA0MDAwMDAwMAAfQ7Z1qOeBAKOjgQAAgBACAJ0BKhAAEAAARwiFhYiFhIgCAgAMDWAA/v+rUIAcU7trkbuPs4EAt4r3gQHxggGm8IED';
const WEBP_BASE64 = 'UklGRhoAAABXRUJQVlA4TA4AAAAvAAAAAAcQEf0PRET/Aw==';
const FAKE_YT_DLP_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'for argument in "$@"; do',
  '  if [ "$argument" = "--version" ]; then',
  '    printf \'%s\\n\' \'2026.07.04-test\'',
  '    exit 0',
  '  fi',
  'done',
  'executable_name=${0##*/}',
  'case "$executable_name" in',
  '  yt-dlp-cookie) cookie_mode=1 ;;',
  '  yt-dlp) cookie_mode=0 ;;',
  '  *) exit 72 ;;',
  'esac',
  'cookie_source=',
  'cookie_pair_count=0',
  'expecting_cookie_source=0',
  'for argument in "$@"; do',
  '  case "$argument" in',
  '    --cookies-from-browser=*) exit 69 ;;',
  '  esac',
  '  if [ "$expecting_cookie_source" -eq 1 ]; then',
  '    case "$argument" in',
  '      -*) exit 70 ;;',
  '    esac',
  '    cookie_source=$argument',
  '    cookie_pair_count=$((cookie_pair_count + 1))',
  '    expecting_cookie_source=0',
  '    continue',
  '  fi',
  '  if [ "$argument" = "--cookies-from-browser" ]; then',
  '    [ "$cookie_pair_count" -eq 0 ] || exit 71',
  '    expecting_cookie_source=1',
  '  fi',
  'done',
  '[ "$expecting_cookie_source" -eq 0 ] || exit 70',
  'if [ "$cookie_mode" -eq 1 ]; then',
  '  [ "$cookie_pair_count" -eq 1 ] || exit 67',
  '  [ "$cookie_source" = "chrome" ] || exit 67',
  'else',
  '  [ "$cookie_pair_count" -eq 0 ] || exit 68',
  'fi',
  'for argument in "$@"; do',
  '  if [ "$argument" = "--dump-single-json" ]; then',
  '    if [ "$cookie_mode" -eq 1 ]; then',
  `      printf '%s\\n' '${JSON.stringify(COOKIE_INFO_DOCUMENT)}'`,
  '    else',
  `      printf '%s\\n' '${JSON.stringify(INFO_DOCUMENT)}'`,
  '    fi',
  '    exit 0',
  '  fi',
  'done',
  'output=',
  'while [ "$#" -gt 0 ]; do',
  '  if [ "$1" = "--output" ]; then',
  '    shift',
  '    [ "$#" -gt 0 ] || exit 64',
  '    output=$1',
  '  fi',
  '  shift',
  'done',
  '[ -n "$output" ] || exit 65',
  '[ "$output" = "video.%(ext)s" ] || exit 66',
  `printf '%s\\n' '${WEBM_BASE64}' | /usr/bin/base64 -D > video.webm`,
  'if [ "$cookie_mode" -eq 1 ]; then',
  `  printf '%s\\n' '${JSON.stringify(COOKIE_INFO_DOCUMENT)}' > video.info.json`,
  'else',
  `  printf '%s\\n' '${JSON.stringify(INFO_DOCUMENT)}' > video.info.json`,
  'fi',
  'cat > video.en.vtt <<\'VTT\'',
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:01.000',
  'Fixture subtitle.',
  'VTT',
  `printf '%s\\n' '${WEBP_BASE64}' | /usr/bin/base64 -D > video.webp`,
  '',
].join('\n');
const FAKE_FFMPEG_SCRIPT = [
  '#!/bin/sh',
  'set -eu',
  'if [ "${1-}" = "-version" ]; then',
  '  printf \'%s\\n\' \'ffmpeg version test\'',
  '  exit 0',
  'fi',
  'printf \'%s\\n\' \'unexpected fake ffmpeg invocation\' >&2',
  'exit 64',
  '',
].join('\n');
const NETWORK_COMMAND = /(?:^|\n)\s*(?:\S*\/)?(?:curl|wget|nc|ssh)\b/mu;

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

const clearImmutableFlags = async (target: string): Promise<void> => {
  await execFileAsync('/usr/bin/chflags', ['-R', 'nouchg', target])
    .catch(() => {});
};

const makeTreeWritable = async (target: string): Promise<void> => {
  try {
    const stats = await lstat(target);
    if (stats.isSymbolicLink()) return;
    if (!stats.isDirectory()) {
      await chmod(target, 0o600);
      return;
    }
    await chmod(target, 0o700);
    for (const entry of await readdir(target)) {
      await makeTreeWritable(path.join(target, entry));
    }
  } catch {
    return;
  }
};

afterEach(async () => {
  const directories = temporaryDirectories.splice(0);
  await Promise.all(directories.map(async (directory) => {
    await clearImmutableFlags(directory);
    await makeTreeWritable(directory);
    await rm(directory, {recursive: true, force: true});
  }));
});

const createWorkspace = async (): Promise<string> => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'system-download-test-'));
  temporaryDirectories.push(workspace);
  return workspace;
};

const writeExecutable = async (target: string, source: string): Promise<void> => {
  await writeFile(target, source, {mode: 0o700});
  await chmod(target, 0o700);
};

interface FakeYtDlpLocation {
  directoryName?: string;
  executableName?: string;
}

const createFakeYtDlpExecutable = async ({
  directoryName = 'tools',
  executableName = 'yt-dlp',
}: FakeYtDlpLocation = {}): Promise<string> => {
  const workspaceRoot = await createWorkspace();
  const executableDirectory = path.join(workspaceRoot, directoryName);
  const executable = path.join(executableDirectory, executableName);
  await mkdir(executableDirectory, {recursive: true});
  await writeExecutable(executable, FAKE_YT_DLP_SCRIPT);
  return executable;
};

const runFakeYtDlp = async (
  arguments_: readonly string[],
  location: FakeYtDlpLocation = {},
) => execFileAsync(
  await createFakeYtDlpExecutable(location),
  [...arguments_],
);

interface NetworkSocketGuard {
  calls: readonly string[];
  restore(): void;
}

const installNetworkSocketGuard = (): NetworkSocketGuard => {
  const calls: string[] = [];
  const restoreMethods: Array<() => void> = [];
  const guardMethod = (target: object, key: string, label: string): void => {
    const ownDescriptor = Object.getOwnPropertyDescriptor(target, key);
    const original = Reflect.get(target, key);
    if (typeof original !== 'function') {
      throw new Error(`Cannot guard ${label}.`);
    }

    Object.defineProperty(target, key, {
      configurable: ownDescriptor?.configurable ?? true,
      enumerable: ownDescriptor?.enumerable ?? false,
      writable: ownDescriptor?.writable ?? true,
      value: (..._arguments: unknown[]): never => {
        calls.push(label);
        throw new Error(`Unexpected network socket attempt through ${label}.`);
      },
    });
    restoreMethods.push(() => {
      if (ownDescriptor === undefined) {
        Reflect.deleteProperty(target, key);
      } else {
        Object.defineProperty(target, key, ownDescriptor);
      }
    });
  };

  guardMethod(net, 'connect', 'node:net.connect');
  guardMethod(net, 'createConnection', 'node:net.createConnection');
  guardMethod(net.Socket.prototype, 'connect', 'node:net.Socket.prototype.connect');
  guardMethod(tls, 'connect', 'node:tls.connect');
  guardMethod(
    tls.TLSSocket.prototype,
    'connect',
    'node:tls.TLSSocket.prototype.connect',
  );

  return {
    calls,
    restore: () => {
      for (const restore of restoreMethods.reverse()) restore();
    },
  };
};

describe('fake yt-dlp integration harness', () => {
  it('is valid POSIX shell', async () => {
    const executable = await createFakeYtDlpExecutable();

    await expect(execFileAsync('/bin/sh', ['-n', executable])).resolves.toMatchObject({
      stderr: '',
    });
  });

  it('detects bare and path-qualified network commands', () => {
    expect('curl https://example.test').toMatch(NETWORK_COMMAND);
    expect('/usr/bin/curl https://example.test').toMatch(NETWORK_COMMAND);
    expect('  ./wget https://example.test').toMatch(NETWORK_COMMAND);
  });

  it('keeps an anonymous basename anonymous under a cookie-named parent path', async () => {
    const result = await runFakeYtDlp(
      ['--dump-single-json', CANONICAL_URL],
      {directoryName: 'cookie-parent/tools', executableName: 'yt-dlp'},
    );

    expect(JSON.parse(result.stdout)).toEqual(INFO_DOCUMENT);
  });

  it('rejects unexpected executable basenames', async () => {
    await expect(runFakeYtDlp(
      ['--dump-single-json', CANONICAL_URL],
      {executableName: 'yt-dlp-other'},
    )).rejects.toMatchObject({code: 72});
  });

  it.each([
    {
      name: 'equals syntax in Cookie mode',
      executableName: 'yt-dlp-cookie',
      arguments: ['--cookies-from-browser=chrome', '--dump-single-json', CANONICAL_URL],
      exitCode: 69,
    },
    {
      name: 'empty equals syntax in anonymous mode',
      executableName: 'yt-dlp',
      arguments: ['--cookies-from-browser=', '--dump-single-json', CANONICAL_URL],
      exitCode: 69,
    },
    {
      name: 'a bare flag with no value',
      executableName: 'yt-dlp',
      arguments: ['--cookies-from-browser'],
      exitCode: 70,
    },
    {
      name: 'an option used as the source value',
      executableName: 'yt-dlp-cookie',
      arguments: ['--cookies-from-browser', '--dump-single-json', CANONICAL_URL],
      exitCode: 70,
    },
    {
      name: 'duplicate Cookie pairs',
      executableName: 'yt-dlp-cookie',
      arguments: [
        '--cookies-from-browser',
        'chrome',
        '--cookies-from-browser',
        'chrome',
        '--dump-single-json',
        CANONICAL_URL,
      ],
      exitCode: 71,
    },
    {
      name: 'a valid pair followed by another bare flag',
      executableName: 'yt-dlp-cookie',
      arguments: [
        '--cookies-from-browser',
        'chrome',
        '--dump-single-json',
        CANONICAL_URL,
        '--cookies-from-browser',
      ],
      exitCode: 71,
    },
    {
      name: 'a Cookie pair in anonymous mode',
      executableName: 'yt-dlp',
      arguments: [
        '--cookies-from-browser',
        'chrome',
        '--dump-single-json',
        CANONICAL_URL,
      ],
      exitCode: 68,
    },
    {
      name: 'a non-Chrome source in Cookie mode',
      executableName: 'yt-dlp-cookie',
      arguments: [
        '--cookies-from-browser',
        'firefox',
        '--dump-single-json',
        CANONICAL_URL,
      ],
      exitCode: 67,
    },
  ])('rejects $name', async ({executableName, arguments: arguments_, exitCode}) => {
    await expect(runFakeYtDlp(arguments_, {executableName}))
      .rejects.toMatchObject({code: exitCode});
  });
});

describe('system download integration', () => {
  it('archives one video with fake local tools and no Node network sockets', async () => {
    const socketGuard = installNetworkSocketGuard();
    try {
      expect(FAKE_YT_DLP_SCRIPT).not.toMatch(NETWORK_COMMAND);
      expect(FAKE_FFMPEG_SCRIPT).not.toMatch(NETWORK_COMMAND);

      const workspaceRoot = await createWorkspace();
      const toolsDirectory = path.join(workspaceRoot, 'tools');
      const ytDlpExecutable = path.join(toolsDirectory, 'yt-dlp');
      const ffmpegExecutable = path.join(toolsDirectory, 'ffmpeg');
      await mkdir(toolsDirectory);
      await Promise.all([
        writeExecutable(ytDlpExecutable, FAKE_YT_DLP_SCRIPT),
        writeExecutable(ffmpegExecutable, FAKE_FFMPEG_SCRIPT),
      ]);

      const dependencies = createSystemDownloadDependencies({
        ytDlpExecutable,
        ffmpegExecutable,
      });
      dependencies.now = () => new Date(FIXED_DOWNLOAD_TIME);

      const input = {
        workspaceRoot,
        url: CANONICAL_URL,
        outputRoot: 'downloads',
        rightsConfirmed: true,
        cookieAccessConfirmed: false,
      } as const;
      const result = await downloadVideo(input, dependencies);
      expect(result.status).toBe('downloaded');
      if (result.status !== 'downloaded') {
        throw new Error('Expected a newly downloaded archive.');
      }
      expect(result.receipt.version).toBe(1);
      expect('browserCookies' in result.receipt).toBe(false);

      const finalDirectory = path.join(
        workspaceRoot,
        'downloads',
        'youtube',
        'abc',
      );
      const stagingRoot = path.join(workspaceRoot, 'downloads', '.staging');
      expect((await readdir(finalDirectory)).sort()).toEqual([...FINAL_FILENAMES]);
      expect(await readdir(stagingRoot)).toEqual([]);
      expect(result).toMatchObject({
        status: 'downloaded',
        platform: 'youtube',
        videoId: 'abc',
        directory: 'downloads/youtube/abc',
        mediaPath: 'downloads/youtube/abc/video.webm',
        receiptPath: 'downloads/youtube/abc/receipt.json',
      });

      const receiptSource = await readFile(
        path.join(finalDirectory, 'receipt.json'),
        'utf8',
      );
      const receipt = DownloadReceiptSchema.parse(JSON.parse(receiptSource));
      expect(receipt).toEqual(result.receipt);
      expect(receipt.version).toBe(1);
      expect('browserCookies' in receipt).toBe(false);
      expect(receipt).toMatchObject({
        downloadedAt: FIXED_DOWNLOAD_TIME.toISOString(),
        platform: 'youtube',
        videoId: 'abc',
        title: TITLE,
        canonicalUrl: CANONICAL_URL,
        tools: {
          ytDlpVersion: '2026.07.04-test',
          ffmpegVersion: 'ffmpeg version test',
        },
      });
      expect(receipt.files.map((file) => file.path)).toEqual([
        'video.en.vtt',
        'video.info.json',
        'video.webm',
        'video.webp',
      ]);

      expect(JSON.parse(await readFile(
        path.join(finalDirectory, 'video.info.json'),
        'utf8',
      ))).toEqual(INFO_DOCUMENT);
      expect(await readFile(
        path.join(finalDirectory, 'video.en.vtt'),
        'utf8',
      )).toBe(SUBTITLE_CONTENTS);
      expect((await readFile(path.join(finalDirectory, 'video.webm')))
        .subarray(0, 4)).toEqual(Buffer.from('1a45dfa3', 'hex'));
      const thumbnail = await readFile(path.join(finalDirectory, 'video.webp'));
      expect(thumbnail.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(thumbnail.subarray(8, 12).toString('ascii')).toBe('WEBP');

      const duplicate = await downloadVideo(input, dependencies);
      expect(duplicate.status).toBe('already-present');
      expect(duplicate.receipt).toEqual(receipt);
      expect((await readdir(finalDirectory)).sort()).toEqual([...FINAL_FILENAMES]);
      expect(await readdir(stagingRoot)).toEqual([]);
    } finally {
      const socketCalls = [...socketGuard.calls];
      socketGuard.restore();
      expect(socketCalls).toEqual([]);
    }
  });

  it('archives one normalized Douyin video with explicit Chrome Cookie mode', async () => {
    const socketGuard = installNetworkSocketGuard();
    try {
      expect(FAKE_YT_DLP_SCRIPT).not.toMatch(NETWORK_COMMAND);
      expect(FAKE_FFMPEG_SCRIPT).not.toMatch(NETWORK_COMMAND);

      const workspaceRoot = await createWorkspace();
      const toolsDirectory = path.join(workspaceRoot, 'tools');
      const ytDlpExecutable = path.join(toolsDirectory, 'yt-dlp-cookie');
      const ffmpegExecutable = path.join(toolsDirectory, 'ffmpeg');
      await mkdir(toolsDirectory);
      await Promise.all([
        writeExecutable(ytDlpExecutable, FAKE_YT_DLP_SCRIPT),
        writeExecutable(ffmpegExecutable, FAKE_FFMPEG_SCRIPT),
      ]);

      const dependencies = createSystemDownloadDependencies({
        ytDlpExecutable,
        ffmpegExecutable,
      });
      dependencies.now = () => new Date(FIXED_DOWNLOAD_TIME);

      const result = await downloadVideo({
        workspaceRoot,
        url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
        outputRoot: 'downloads',
        rightsConfirmed: true,
        browserCookieSource: 'chrome',
        cookieAccessConfirmed: true,
      }, dependencies);

      expect(result.status).toBe('downloaded');
      if (result.status !== 'downloaded') {
        throw new Error('Expected a newly downloaded Cookie-assisted archive.');
      }

      const finalDirectory = path.join(
        workspaceRoot,
        'downloads',
        'douyin',
        '7654841525762919726',
      );
      expect(result).toMatchObject({
        status: 'downloaded',
        platform: 'douyin',
        videoId: '7654841525762919726',
        receipt: {
          version: 2,
          canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
          browserCookies: {used: true, source: 'chrome'},
        },
      });
      expect(DownloadReceiptSchema.parse(result.receipt)).toEqual(result.receipt);
      expect((await readdir(finalDirectory)).sort()).toEqual([...FINAL_FILENAMES]);

      const receipt = DownloadReceiptSchema.parse(JSON.parse(
        await readFile(path.join(finalDirectory, 'receipt.json'), 'utf8'),
      ));
      expect(receipt).toEqual(result.receipt);
      expect(receipt).toMatchObject({
        version: 2,
        browserCookies: {used: true, source: 'chrome'},
      });
      expect(JSON.stringify(receipt)).not.toMatch(/cookie_value|profile|database/iu);
      expect(JSON.parse(await readFile(
        path.join(finalDirectory, 'video.info.json'),
        'utf8',
      ))).toEqual(COOKIE_INFO_DOCUMENT);
      expect(socketGuard.calls).toEqual([]);
    } finally {
      socketGuard.restore();
    }
  });
});
