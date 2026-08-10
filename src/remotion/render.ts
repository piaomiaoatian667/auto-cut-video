import {bundle, type WebpackConfiguration} from '@remotion/bundler';
import {renderMedia, selectComposition} from '@remotion/renderer';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {CompiledTimelineSchema, type CompiledTimeline} from '../domain/timeline-schema';

export interface RenderTimelineVideoInput {
  timeline: CompiledTimeline;
  outputLocation: string;
  publicDir: string;
  entryPoint?: string;
}

const defaultEntryPoint = (): string => path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'index.ts',
);

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
}: RenderTimelineVideoInput): Promise<void> => {
  const inputProps = CompiledTimelineSchema.parse(timeline) as unknown as Record<string, unknown>;
  const bundleLocation = await bundle({
    entryPoint,
    publicDir,
    ignoreRegisterRootWarning: true,
    webpackOverride: injectTsconfigRaw,
  });
  const composition = await selectComposition({
    serveUrl: bundleLocation,
    id: 'Project',
    inputProps,
  });
  await renderMedia({
    serveUrl: bundleLocation,
    composition,
    codec: 'h264',
    muted: true,
    pixelFormat: 'yuv420p',
    outputLocation,
    inputProps,
    overwrite: true,
    concurrency: 1,
    logLevel: 'warn',
  });
};
