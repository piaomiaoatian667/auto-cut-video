import {createHash} from 'node:crypto';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  createTestImage,
  createTestMusic,
  createTestVideo,
} from './media-fixtures';

const DEMO_PROJECT_ROOT = fileURLToPath(new URL('../../projects/demo', import.meta.url));
const SOURCE_FILES = [
  'camera-a.mp4',
  'camera-b.mp4',
  'cover.png',
  'music-main.wav',
] as const;
const FFMPEG_EXECUTABLE = '/opt/homebrew/bin/ffmpeg';
const FFPROBE_EXECUTABLE = '/opt/homebrew/bin/ffprobe';
const QT_FASTSTART_EXECUTABLE = '/opt/homebrew/bin/qt-faststart';

const sha256 = (bytes: Buffer): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export type DemoSourceHashes = Record<(typeof SOURCE_FILES)[number], string>;

export interface DemoProjectFixture {
  workspaceRoot: string;
  projectRoot: string;
  sourceRoot: string;
  sourceHashes: DemoSourceHashes;
  cleanup(): Promise<void>;
}

export async function hashDemoSources(sourceRoot: string): Promise<DemoSourceHashes> {
  return Object.fromEntries(await Promise.all(SOURCE_FILES.map(async (fileName) => [
    fileName,
    sha256(await readFile(path.join(sourceRoot, fileName))),
  ]))) as DemoSourceHashes;
}

export async function copyDemoProject(): Promise<DemoProjectFixture> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'agent-video-demo-e2e-'));
  try {
    const projectRoot = path.join(workspaceRoot, 'projects', 'demo');
    const fontRoot = path.join(projectRoot, 'assets', 'fonts');
    const sourceRoot = path.join(projectRoot, 'assets', 'source');
    await Promise.all([
      mkdir(fontRoot, {recursive: true}),
      mkdir(sourceRoot, {recursive: true}),
    ]);
    await Promise.all([
      copyFile(path.join(DEMO_PROJECT_ROOT, 'project.json'), path.join(projectRoot, 'project.json')),
      copyFile(path.join(DEMO_PROJECT_ROOT, 'script.json'), path.join(projectRoot, 'script.json')),
      copyFile(path.join(DEMO_PROJECT_ROOT, 'edit.json'), path.join(projectRoot, 'edit.json')),
      copyFile(
        path.join(DEMO_PROJECT_ROOT, 'assets', 'fonts', 'NotoSansSC-Bold.otf'),
        path.join(fontRoot, 'NotoSansSC-Bold.otf'),
      ),
    ]);
    await Promise.all([
      createTestVideo(path.join(sourceRoot, 'camera-a.mp4'), 1, {includeAudio: true}),
      createTestVideo(path.join(sourceRoot, 'camera-b.mp4'), 1, {
        includeAudio: false,
        colorProfile: 'smpte170m',
      }),
      createTestImage(path.join(sourceRoot, 'cover.png'), 'blue'),
      createTestMusic(path.join(sourceRoot, 'music-main.wav'), 5),
    ]);
    const sourceHashes = await hashDemoSources(sourceRoot);
    return {
      workspaceRoot,
      projectRoot,
      sourceRoot,
      sourceHashes,
      cleanup: async () => rm(workspaceRoot, {recursive: true, force: true}),
    };
  } catch (error) {
    await rm(workspaceRoot, {recursive: true, force: true});
    throw error;
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;

export type RecordedTool = 'ffmpeg' | 'ffprobe' | 'qt-faststart';

export interface RecordedToolchain {
  ffmpegExecutable: string;
  ffprobeExecutable: string;
  qtFaststartExecutable: string;
  readCalls(tool: RecordedTool): Promise<string[]>;
}

const createRecordedTool = async (
  toolRoot: string,
  tool: RecordedTool,
  target: string,
): Promise<{executablePath: string; logPath: string}> => {
  const executablePath = path.join(toolRoot, tool);
  const logPath = path.join(toolRoot, `${tool}.log`);
  await writeFile(executablePath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${shellQuote(logPath)}`,
    `exec ${shellQuote(target)} "$@"`,
    '',
  ].join('\n'), 'utf8');
  await chmod(executablePath, 0o755);
  return {executablePath, logPath};
};

export async function createRecordedToolchain(
  workspaceRoot: string,
): Promise<RecordedToolchain> {
  const toolRoot = path.join(workspaceRoot, 'tools');
  await mkdir(toolRoot, {recursive: true});
  const [ffmpeg, ffprobe, qtFaststart] = await Promise.all([
    createRecordedTool(toolRoot, 'ffmpeg', FFMPEG_EXECUTABLE),
    createRecordedTool(toolRoot, 'ffprobe', FFPROBE_EXECUTABLE),
    createRecordedTool(toolRoot, 'qt-faststart', QT_FASTSTART_EXECUTABLE),
  ]);
  const logs = new Map<RecordedTool, string>([
    ['ffmpeg', ffmpeg.logPath],
    ['ffprobe', ffprobe.logPath],
    ['qt-faststart', qtFaststart.logPath],
  ]);
  return {
    ffmpegExecutable: ffmpeg.executablePath,
    ffprobeExecutable: ffprobe.executablePath,
    qtFaststartExecutable: qtFaststart.executablePath,
    readCalls: async (tool) => {
      try {
        return (await readFile(logs.get(tool)!, 'utf8'))
          .split('\n')
          .filter((line) => line.length > 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}

export interface RemotionBrowserFixture {
  executablePath: string;
  chromeMode: 'headless-shell' | 'chrome-for-testing';
}

export interface RecordedRemotionBrowser extends RemotionBrowserFixture {
  readCalls(): Promise<string[]>;
}

export async function findRemotionBrowser(): Promise<RemotionBrowserFixture> {
  const configured = process.env.REMOTION_BROWSER_EXECUTABLE;
  if (configured !== undefined) {
    await access(configured, constants.X_OK);
    return {
      executablePath: configured,
      chromeMode: configured.includes('headless-shell')
        ? 'headless-shell'
        : 'chrome-for-testing',
    };
  }
  const browserRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? path.join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const entries = await readdir(browserRoot, {recursive: true, withFileTypes: true});
  const candidates = entries
    .filter((entry) => entry.isFile() && (
      entry.name === 'chrome-headless-shell'
      || entry.name === 'Google Chrome for Testing'
    ))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort((left, right) => right.localeCompare(left));
  for (const executablePath of candidates) {
    try {
      await access(executablePath, constants.X_OK);
      return {
        executablePath,
        chromeMode: executablePath.includes('headless-shell')
          ? 'headless-shell'
          : 'chrome-for-testing',
      };
    } catch {
      continue;
    }
  }
  throw new Error(`No executable Playwright Chromium found below ${browserRoot}`);
}

export async function createRecordedRemotionBrowser(
  workspaceRoot: string,
  browser: RemotionBrowserFixture,
): Promise<RecordedRemotionBrowser> {
  const browserRoot = path.join(workspaceRoot, 'browser');
  await mkdir(browserRoot, {recursive: true});
  const executablePath = path.join(browserRoot, 'chromium');
  const logPath = path.join(browserRoot, 'chromium.log');
  await writeFile(executablePath, [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${shellQuote(logPath)}`,
    `exec ${shellQuote(browser.executablePath)} "$@"`,
    '',
  ].join('\n'), 'utf8');
  await chmod(executablePath, 0o755);
  return {
    executablePath,
    chromeMode: browser.chromeMode,
    readCalls: async () => {
      try {
        return (await readFile(logPath, 'utf8'))
          .split('\n')
          .filter((line) => line.length > 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
