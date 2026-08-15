import {z} from 'zod';
import {
  runProcess as runSystemProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/run-process';
import type {BrowserCookieSource} from './browser-cookies';
import {DownloadError} from './errors';

const TOOL_MISSING_MESSAGE = 'Required download tools are unavailable.';
const PROBE_FAILED_MESSAGE = 'Video metadata could not be extracted.';
const PROCESS_FAILED_MESSAGE = 'The video could not be downloaded.';
const ACTIVE_LIVE_STATUSES = new Set([
  'is_live',
  'is_upcoming',
  'post_live',
]);
const FIXED_YT_DLP_ARGS = [
  '--ignore-config',
  '--proxy',
  '',
  '--no-geo-bypass',
  '--no-playlist',
  '--playlist-items',
  '1',
] as const;
const browserCookieArgs = (
  source: BrowserCookieSource | undefined,
): readonly string[] => source === undefined
  ? []
  : ['--cookies-from-browser', source];
const DARWIN_YT_DLP_WRAPPER_SCRIPT = [
  'ObjC.import("Foundation");',
  'ObjC.bindFunction("fchdir", ["int", ["int"]]);',
  'ObjC.bindFunction("exit", ["void", ["int"]]);',
  'function run(argv) {',
  '  if (Number($.fchdir(3)) !== 0) $.exit(126);',
  '  const task = $.NSTask.alloc.init;',
  '  if (!task.respondsToSelector("setStartsNewProcessGroup:")) $.exit(126);',
  '  task.setStartsNewProcessGroup(false);',
  '  task.launchPath = "/usr/bin/env";',
  '  task.arguments = ["--", argv[0]].concat(argv.slice(1));',
  '  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;',
  '  task.standardOutput = $.NSFileHandle.fileHandleWithStandardOutput;',
  '  task.standardError = $.NSFileHandle.fileHandleWithStandardError;',
  '  task.launch;',
  '  task.waitUntilExit;',
  '  $.exit(Number(task.terminationStatus));',
  '}',
].join('\n');

export type DownloadProcessRunner = (
  command: string,
  args: readonly string[],
  options?: RunProcessOptions,
) => Promise<ProcessResult>;

const ParseableUrlSchema = z.string().superRefine((value, context) => {
  try {
    new URL(value);
  } catch {
    context.addIssue({
      code: 'custom',
      message: 'webpage_url must be a parseable URL',
    });
  }
});

export const YtDlpInfoSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  webpage_url: ParseableUrlSchema,
  extractor: z.string().min(1),
  extractor_key: z.string().min(1).optional(),
  _type: z.string().optional(),
  is_live: z.boolean().nullable().optional(),
  live_status: z.string().nullable().optional(),
  availability: z.string().nullable().optional(),
}).passthrough();

export const SafeYtDlpMetadataSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  webpage_url: ParseableUrlSchema,
  extractor: z.string().min(1),
  extractor_key: z.string().min(1).optional(),
  _type: z.literal('video'),
}).strict();

export type SafeYtDlpMetadata = z.infer<typeof SafeYtDlpMetadataSchema>;

export interface YtDlpProbe {
  id: string;
  title: string;
  canonicalUrl: string;
  extractor: string;
  extractorKey?: string;
  availability?: string | null;
}

export const parseYtDlpInfo = (value: unknown): YtDlpProbe => {
  const info = YtDlpInfoSchema.parse(value);
  if (info._type !== undefined && info._type !== 'video') throw new Error();
  if (
    info.is_live === true ||
    (info.live_status !== null &&
      info.live_status !== undefined &&
      ACTIVE_LIVE_STATUSES.has(info.live_status))
  ) {
    throw new Error();
  }

  return {
    id: info.id,
    title: info.title,
    canonicalUrl: info.webpage_url,
    extractor: info.extractor,
    ...(info.extractor_key === undefined
      ? {}
      : {extractorKey: info.extractor_key}),
    ...(info.availability === undefined
      ? {}
      : {availability: info.availability}),
  };
};

export interface DownloadToolVersions {
  ytDlpVersion: string;
  ffmpegVersion: string;
}

export interface YtDlpOperationOptions {
  browserCookieSource?: BrowserCookieSource;
  signal?: AbortSignal;
}

export interface YtDlpClient {
  checkTools(signal?: AbortSignal): Promise<DownloadToolVersions>;
  probe(url: string, options?: YtDlpOperationOptions): Promise<YtDlpProbe>;
  download(
    url: string,
    stagingDirectoryFd: number,
    options?: YtDlpOperationOptions,
  ): Promise<void>;
}

export interface YtDlpClientOptions {
  runProcess?: DownloadProcessRunner;
  ytDlpExecutable?: string;
  ffmpegExecutable?: string;
}

const firstNonemptyTrimmedLine = (stdout: string): string | undefined =>
  stdout
    .split(/\r\n|\n|\r/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

export const createYtDlpClient = (
  options: YtDlpClientOptions = {},
): YtDlpClient => {
  const runner = options.runProcess ?? runSystemProcess;
  const ytDlpExecutable = options.ytDlpExecutable ?? 'yt-dlp';
  const explicitFfmpegExecutable = options.ffmpegExecutable;
  const ffmpegExecutable = explicitFfmpegExecutable ?? 'ffmpeg';
  const runWithSignal = async (
    command: string,
    args: readonly string[],
    signal: AbortSignal | undefined,
  ): Promise<ProcessResult> => signal === undefined
    ? await runner(command, args)
    : await runner(command, args, {signal});

  return {
    async checkTools(signal?: AbortSignal): Promise<DownloadToolVersions> {
      try {
        const ytDlpResult = await runWithSignal(
          ytDlpExecutable,
          ['--version'],
          signal,
        );
        const ytDlpVersion = firstNonemptyTrimmedLine(ytDlpResult.stdout);
        if (ytDlpVersion === undefined) throw new Error();

        const ffmpegResult = await runWithSignal(
          ffmpegExecutable,
          ['-version'],
          signal,
        );
        const ffmpegVersion = firstNonemptyTrimmedLine(ffmpegResult.stdout);
        if (ffmpegVersion === undefined) throw new Error();

        return {ytDlpVersion, ffmpegVersion};
      } catch {
        throw new DownloadError('DOWNLOAD_TOOL_MISSING', TOOL_MISSING_MESSAGE);
      }
    },

    async probe(
      url: string,
      options?: YtDlpOperationOptions,
    ): Promise<YtDlpProbe> {
      const browserCookieSource = options?.browserCookieSource;
      const signal = options?.signal;
      try {
        const result = await runWithSignal(ytDlpExecutable, [
          ...FIXED_YT_DLP_ARGS,
          ...browserCookieArgs(browserCookieSource),
          '--skip-download',
          '--dump-single-json',
          url,
        ], signal);
        return parseYtDlpInfo(JSON.parse(result.stdout));
      } catch {
        throw new DownloadError('DOWNLOAD_PROBE_FAILED', PROBE_FAILED_MESSAGE);
      }
    },

    async download(
      url: string,
      stagingDirectoryFd: number,
      options?: YtDlpOperationOptions,
    ): Promise<void> {
      const browserCookieSource = options?.browserCookieSource;
      const signal = options?.signal;
      try {
        await runner('/usr/bin/osascript', [
          '-l',
          'JavaScript',
          '-e',
          DARWIN_YT_DLP_WRAPPER_SCRIPT,
          '--',
          ytDlpExecutable,
          ...FIXED_YT_DLP_ARGS,
          ...browserCookieArgs(browserCookieSource),
          '--no-progress',
          '--write-thumbnail',
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs',
          'zh.*,en.*',
          '--output',
          'video.%(ext)s',
          ...(explicitFfmpegExecutable === undefined
            ? []
            : ['--ffmpeg-location', ffmpegExecutable]),
          url,
        ], {
          ...(signal === undefined ? {} : {signal}),
          extraStdioFds: [stagingDirectoryFd],
        });
      } catch {
        throw new DownloadError('DOWNLOAD_PROCESS_FAILED', PROCESS_FAILED_MESSAGE);
      }
    },
  };
};
