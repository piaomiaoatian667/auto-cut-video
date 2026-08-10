import {afterEach, describe, expect, it} from 'vitest';
import {loadProject} from '../../../src/domain/load-project';
import {createRunStore, openExistingRunFile, type RunDirectoryScope} from '../../../src/fs/app-directory-scopes';
import {parseFfprobeJson} from '../../../src/media/ffprobe';
import {MacOsSayProvider} from '../../../src/providers/tts';
import {runProcess} from '../../../src/process/run-process';
import {createTempProject, type TempProject} from '../../helpers/temp-project';

const tempProjects: TempProject[] = [];

afterEach(async () => {
  await Promise.all(tempProjects.splice(0).map(async (project) => await project.cleanup()));
});

const probeRunAudio = async (runDirectory: RunDirectoryScope, relativePath: string) => {
  const handle = await openExistingRunFile(runDirectory, relativePath);
  try {
    const result = await runProcess(process.env.FFPROBE_PATH ?? '/opt/homebrew/bin/ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '/dev/fd/3',
    ], {extraStdioFds: [handle.fd]});
    return parseFfprobeJson(result.stdout);
  } finally {
    await handle.close();
  }
};

describe('MacOsSayProvider', () => {
  it.skipIf(process.env.RUN_SYSTEM_TTS_TESTS !== '1')('produces decodable Chinese speech on the target machine', async () => {
    const tempProject = await createTempProject();
    tempProjects.push(tempProject);
    await loadProject(tempProject.workspaceRoot, 'demo');
    const runDirectory = await createRunStore(tempProject.workspaceRoot).createRun('demo', 'run-macos-say');
    const provider = new MacOsSayProvider({runDirectory});
    const voice = process.env.MACOS_TTS_VOICE ?? 'Tingting';

    const result = await provider.synthesize({
      segmentId: 'intro',
      text: '你好，京东。',
      voice,
      rate: 180,
      outputPath: 'audio/segments/intro.wav',
    }, new AbortController().signal);

    const metadata = await probeRunAudio(runDirectory, result.outputPath);
    expect(metadata.audioStreams).toHaveLength(1);
    expect(metadata.audioStreams[0]).toMatchObject({sampleRate: 48000, channels: 1});
  }, 30_000);
});
