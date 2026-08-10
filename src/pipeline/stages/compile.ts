import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {z} from 'zod';
import {
  CaptionsManifestSchema,
  NarrationManifestSchema,
} from '../../domain/manifest-schema';
import type {ProjectInputs} from '../../domain/load-project';
import {CompiledTimelineSchema, type CompiledTimeline} from '../../domain/timeline-schema';
import {
  openExistingRunFile,
  openNewRunFile,
  type RunDirectoryScope,
} from '../../fs/app-directory-scopes';
import {openExistingProjectFile} from '../../fs/project-paths';
import {compileTimeline} from '../../timeline/compiler';
import {IngestManifestSchema} from './ingest';

export interface CompileInput extends ProjectInputs {
  runDirectory: RunDirectoryScope;
}

export interface CompileFileSystem {
  openExistingRunFile(scope: RunDirectoryScope, relativePath: string): Promise<FileHandle>;
  openNewRunFile(scope: RunDirectoryScope, relativePath: string): Promise<FileHandle>;
  openExistingProjectFile: typeof openExistingProjectFile;
}

export interface CompileDependencies {
  fileSystem: CompileFileSystem;
}

export const createSystemCompileDependencies = (): CompileDependencies => ({
  fileSystem: {
    openExistingRunFile,
    openNewRunFile,
    openExistingProjectFile,
  },
});

const readRunJson = async <Output>(
  input: CompileInput,
  dependencies: CompileDependencies,
  relativePath: string,
  schema: z.ZodType<Output>,
): Promise<Output> => {
  const handle = await dependencies.fileSystem.openExistingRunFile(
    input.runDirectory,
    relativePath,
  );
  try {
    return schema.parse(JSON.parse(await handle.readFile('utf8')));
  } finally {
    await handle.close();
  }
};

const writeRunJson = async (
  input: CompileInput,
  dependencies: CompileDependencies,
  relativePath: string,
  value: unknown,
): Promise<void> => {
  const handle = await dependencies.fileSystem.openNewRunFile(
    input.runDirectory,
    relativePath,
  );
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const hashProjectFile = async (
  input: CompileInput,
  dependencies: CompileDependencies,
  relativePath: string,
): Promise<string> => {
  const handle = await dependencies.fileSystem.openExistingProjectFile(
    input.projectDirectory,
    relativePath,
  );
  try {
    const data = await handle.readFile();
    return `sha256:${createHash('sha256').update(data).digest('hex')}`;
  } finally {
    await handle.close();
  }
};

const authoringHashes = async (
  input: CompileInput,
  dependencies: CompileDependencies,
): Promise<Record<string, string>> => ({
  'authoring:project': await hashProjectFile(input, dependencies, 'project.json'),
  'authoring:script': await hashProjectFile(input, dependencies, 'script.json'),
  'authoring:edit': await hashProjectFile(input, dependencies, 'edit.json'),
});

export const runCompile = async (
  input: CompileInput,
  dependencies = createSystemCompileDependencies(),
): Promise<{timelinePath: 'compiled-timeline.json'; timeline: CompiledTimeline}> => {
  const [assetManifest, narrationManifest, captionsManifest, inputHashes] = await Promise.all([
    readRunJson(input, dependencies, 'asset-manifest.json', IngestManifestSchema),
    readRunJson(input, dependencies, 'narration-manifest.json', NarrationManifestSchema),
    readRunJson(input, dependencies, 'captions.json', CaptionsManifestSchema),
    authoringHashes(input, dependencies),
  ]);
  const timeline = CompiledTimelineSchema.parse(compileTimeline({
    project: input.project,
    script: input.script,
    edit: input.edit,
    assetManifest,
    narrationManifest,
    captionsManifest,
    inputHashes,
  }));
  await writeRunJson(input, dependencies, 'compiled-timeline.json', timeline);
  return {timelinePath: 'compiled-timeline.json', timeline};
};
