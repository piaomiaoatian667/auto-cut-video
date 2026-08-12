import {bundle, type WebpackConfiguration} from '@remotion/bundler';
import {
  renderMedia,
  selectComposition,
  type ChromeMode,
  type ChromiumOptions,
} from '@remotion/renderer';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CompiledTimelineSchema, type CompiledTimeline} from '../domain/timeline-schema';

export interface RenderTimelineVideoInput {
  timeline: CompiledTimeline;
  outputLocation: string;
  publicDir: string;
  entryPoint?: string;
  scale?: number;
}

const defaultEntryPoint = (): string => path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'index.ts',
);

const CHROME_MODES = ['headless-shell', 'chrome-for-testing'] as const;
const OPENGL_RENDERERS = [
  'swangle',
  'angle',
  'egl',
  'swiftshader',
  'vulkan',
  'angle-egl',
] as const;

const remotionBrowserOptions = (): {
  browserExecutable?: string;
  chromeMode?: ChromeMode;
  chromiumOptions?: ChromiumOptions;
} => {
  const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE?.trim();
  const chromeMode = process.env.REMOTION_CHROME_MODE?.trim();
  const openGlRenderer = process.env.REMOTION_OPENGL_RENDERER?.trim();
  if (
    chromeMode !== undefined
    && !CHROME_MODES.includes(chromeMode as ChromeMode)
  ) {
    throw new TypeError(`Invalid REMOTION_CHROME_MODE: ${chromeMode}`);
  }
  if (
    openGlRenderer !== undefined
    && !OPENGL_RENDERERS.includes(
      openGlRenderer as NonNullable<ChromiumOptions['gl']>,
    )
  ) {
    throw new TypeError(`Invalid REMOTION_OPENGL_RENDERER: ${openGlRenderer}`);
  }
  return {
    ...(browserExecutable === undefined || browserExecutable.length === 0
      ? {}
      : {browserExecutable}),
    ...(chromeMode === undefined ? {} : {chromeMode: chromeMode as ChromeMode}),
    ...(openGlRenderer === undefined
      ? {}
      : {
        chromiumOptions: {
          gl: openGlRenderer as NonNullable<ChromiumOptions['gl']>,
        },
      }),
  };
};

interface LoaderUseEntry {
  options?: Record<string, unknown>;
}

interface RuleWithUse {
  use?: LoaderUseEntry | LoaderUseEntry[];
}

const loaderEntries = (rule: RuleWithUse): LoaderUseEntry[] => {
  if (Array.isArray(rule.use)) return rule.use;
  return rule.use === undefined ? [] : [rule.use];
};

const injectTsconfigRaw = (configuration: WebpackConfiguration): WebpackConfiguration => {
  const rules = configuration.module?.rules;
  if (!Array.isArray(rules)) return configuration;
  for (const rule of rules) {
    if (rule === false || rule === '...') continue;
    for (const loader of loaderEntries(rule as RuleWithUse)) {
      if (loader.options?.remotionRoot !== undefined) {
        loader.options.tsconfigRaw ??= {
          compilerOptions: {
            jsx: 'react-jsx',
            module: 'ESNext',
            target: 'ES2022',
          },
        };
      }
    }
  }
  return configuration;
};

export const renderTimelineVideo = async ({
  timeline,
  outputLocation,
  publicDir,
  entryPoint = defaultEntryPoint(),
  scale,
}: RenderTimelineVideoInput): Promise<void> => {
  const inputProps = CompiledTimelineSchema.parse(timeline) as unknown as Record<string, unknown>;
  const bundleLocation = await bundle({
    entryPoint,
    publicDir,
    ignoreRegisterRootWarning: true,
    webpackOverride: injectTsconfigRaw,
  });
  const browserOptions = remotionBrowserOptions();
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'Project',
    inputProps,
    ...browserOptions,
  });
  await renderMedia({
    serveUrl: bundleLocation,
    composition,
    codec: 'h264',
    muted: true,
    pixelFormat: 'yuv420p',
    colorSpace: 'bt709',
    outputLocation,
    inputProps,
    overwrite: true,
    concurrency: 1,
    logLevel: 'warn',
    ...browserOptions,
    ...(scale === undefined ? {} : {scale}),
  });
};
