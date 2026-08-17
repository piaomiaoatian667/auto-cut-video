import {z} from 'zod';
import {ProcessExecutionError} from '../process/process-error';
import {
  runProcess as runSystemProcess,
  type ProcessResult,
  type RunProcessOptions,
} from '../process/run-process';
import {DownloadError} from './errors';
import type {ResolvedPlatformProfile} from './platform-profiles';
import type {ResolvedDownloaderToolchain} from './toolchain/types';

const PROBE_FAILED_MESSAGE = 'Video metadata could not be extracted.';
const PROCESS_FAILED_MESSAGE = 'The video could not be downloaded.';
const STDERR_CLASSIFICATION_LIMIT_BYTES = 64 * 1024;
const ACTIVE_LIVE_STATUSES = new Set([
  'is_live',
  'is_upcoming',
  'post_live',
]);
const CLASSIFICATIONS = [
  [
    /HTTP Error 429|Too Many Requests|confirm you(?:'| a)re not a bot/iu,
    [
      'DOWNLOAD_RATE_LIMITED',
      'The video platform temporarily rate-limited this session.',
    ],
  ],
  [
    /HTTP Error 412|Precondition Failed/iu,
    [
      'DOWNLOAD_PLATFORM_CHALLENGE',
      'The video platform rejected the selected public-session request.',
    ],
  ],
  [
    /timed out|failed to connect|network is unreachable|could not resolve/iu,
    [
      'DOWNLOAD_NETWORK_UNREACHABLE',
      'The video platform could not be reached with the selected network settings.',
    ],
  ],
  [
    /impersonat(?:e|ion).*(?:unavailable|unsupported|missing)/iu,
    [
      'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
      'The required browser compatibility capability is unavailable.',
    ],
  ],
  [
    /bgutil|po token provider|generate_once\.(?:ts|js)/iu,
    [
      'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
      'The YouTube compatibility provider is unavailable.',
    ],
  ],
] as const;
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
  has_drm: z.boolean().nullable().optional(),
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
  hasDrm: boolean;
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
    hasDrm: info.has_drm === true,
  };
};

export interface DownloadToolVersions {
  ytDlpVersion: string;
  ffmpegVersion: string;
}

export interface YtDlpClientOptions {
  toolchain: ResolvedDownloaderToolchain;
  runProcess?: DownloadProcessRunner;
}

export interface YtDlpOperationOptions {
  profile: ResolvedPlatformProfile;
  signal?: AbortSignal;
}

export interface YtDlpClient {
  checkTools(signal?: AbortSignal): Promise<DownloadToolVersions>;
  probe(url: string, options: YtDlpOperationOptions): Promise<YtDlpProbe>;
  download(
    url: string,
    stagingDirectoryFd: number,
    options: YtDlpOperationOptions,
  ): Promise<void>;
}

const boundedStderr = (stderr: string): string => {
  const candidate = stderr.length <= STDERR_CLASSIFICATION_LIMIT_BYTES
    ? stderr
    : stderr.slice(-STDERR_CLASSIFICATION_LIMIT_BYTES);
  const bytes = Buffer.from(candidate);
  if (bytes.byteLength <= STDERR_CLASSIFICATION_LIMIT_BYTES) return candidate;

  let start = bytes.byteLength - STDERR_CLASSIFICATION_LIMIT_BYTES;
  while (
    start < bytes.byteLength &&
    ((bytes[start] ?? 0) & 0xc0) === 0x80
  ) {
    start += 1;
  }
  return bytes.subarray(start).toString('utf8');
};

const classifiedDownloadError = (
  error: unknown,
): DownloadError | undefined => {
  if (!(error instanceof ProcessExecutionError)) return undefined;
  const stderr = boundedStderr(error.result.stderr);
  for (const [pattern, [code, message]] of CLASSIFICATIONS) {
    if (pattern.test(stderr)) return new DownloadError(code, message);
  }
  return undefined;
};

const processOptions = (
  environment: Readonly<NodeJS.ProcessEnv>,
  signal: AbortSignal | undefined,
  extraStdioFds?: readonly number[],
): RunProcessOptions => ({
  ...(signal === undefined ? {} : {signal}),
  env: environment,
  ...(extraStdioFds === undefined ? {} : {extraStdioFds}),
});

export const createYtDlpClient = (
  options: YtDlpClientOptions,
): YtDlpClient => {
  const runner = options.runProcess ?? runSystemProcess;
  const toolchain = Object.freeze({
    ytDlpExecutable: options.toolchain.ytDlpExecutable,
    ffmpegExecutable: options.toolchain.ffmpegExecutable,
    ytDlpVersion: options.toolchain.ytDlpVersion,
    ffmpegVersion: options.toolchain.ffmpegVersion,
    ffmpegExplicit: options.toolchain.ffmpegExplicit,
    childEnvironment: options.toolchain.childEnvironment,
  });

  return {
    async checkTools(): Promise<DownloadToolVersions> {
      return {
        ytDlpVersion: toolchain.ytDlpVersion,
        ffmpegVersion: toolchain.ffmpegVersion,
      };
    },

    async probe(
      url: string,
      operation: YtDlpOperationOptions,
    ): Promise<YtDlpProbe> {
      const args = [
        ...operation.profile.commonArgs,
        '--skip-download',
        '--dump-single-json',
        url,
      ];
      try {
        const result = await runner(
          toolchain.ytDlpExecutable,
          args,
          processOptions(toolchain.childEnvironment, operation.signal),
        );
        return parseYtDlpInfo(JSON.parse(result.stdout));
      } catch (error) {
        throw classifiedDownloadError(error)
          ?? new DownloadError('DOWNLOAD_PROBE_FAILED', PROBE_FAILED_MESSAGE);
      }
    },

    async download(
      url: string,
      stagingDirectoryFd: number,
      operation: YtDlpOperationOptions,
    ): Promise<void> {
      const args = [
        '-l',
        'JavaScript',
        '-e',
        DARWIN_YT_DLP_WRAPPER_SCRIPT,
        '--',
        toolchain.ytDlpExecutable,
        ...operation.profile.commonArgs,
        '--no-progress',
        '--write-thumbnail',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'zh.*,en.*',
        '--output',
        'video.%(ext)s',
        ...(toolchain.ffmpegExplicit
          ? ['--ffmpeg-location', toolchain.ffmpegExecutable]
          : []),
        url,
      ];
      try {
        await runner(
          '/usr/bin/osascript',
          args,
          processOptions(
            toolchain.childEnvironment,
            operation.signal,
            [stagingDirectoryFd],
          ),
        );
      } catch (error) {
        throw classifiedDownloadError(error)
          ?? new DownloadError('DOWNLOAD_PROCESS_FAILED', PROCESS_FAILED_MESSAGE);
      }
    },
  };
};
