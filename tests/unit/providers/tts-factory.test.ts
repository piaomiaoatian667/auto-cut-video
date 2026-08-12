import {stat as statFile} from 'node:fs/promises';
import {describe, expect, it, vi} from 'vitest';
import type {RunDirectoryScope} from '../../../src/fs/app-directory-scopes';
import type {ProjectDirectoryScope} from '../../../src/fs/project-paths';
import {fingerprintValue} from '../../../src/pipeline/fingerprint';
import {
  createTtsProvider,
  fingerprintTtsProvider,
  type TtsProviderId,
} from '../../../src/providers/tts';

const projectDirectory = {} as ProjectDirectoryScope;
const runDirectory = {} as RunDirectoryScope;

describe('createTtsProvider', () => {
  it.each(['mock', 'file', 'macos-say'] as const)(
    'creates the %s provider',
    (provider) => {
      const instance = createTtsProvider({
        provider,
        projectDirectory,
        runDirectory,
        ffmpegExecutable: '/tools/ffmpeg',
      });

      expect(instance.id).toBe(provider);
    },
  );
});

describe('fingerprintTtsProvider', () => {
  it('normalizes an actual Node Stats result before fingerprinting macos-say', async () => {
    const sayStats = await statFile(new URL(import.meta.url));
    const stat = vi.fn(async () => sayStats);

    await expect(fingerprintTtsProvider('macos-say', {stat})).resolves.toBe(
      fingerprintValue({
        provider: 'macos-say',
        algorithm: 'macos-say-v1',
        say: {mtimeMs: sayStats.mtimeMs, size: sayStats.size},
      }),
    );
    expect(stat).toHaveBeenCalledWith('/usr/bin/say');
  });

  it.each(['mock', 'file', 'macos-say'] as const)(
    'returns a sha256 identity for %s',
    async (provider: TtsProviderId) => {
      const say = {mtimeMs: 123, size: 456};
      const stat = vi.fn(async () => say);

      const fingerprint = await fingerprintTtsProvider(provider, {stat});

      expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
      if (provider === 'macos-say') {
        expect(stat).toHaveBeenCalledWith('/usr/bin/say');
        expect(fingerprint).toBe(fingerprintValue({
          provider,
          algorithm: 'macos-say-v1',
          say,
        }));
      } else {
        expect(stat).not.toHaveBeenCalled();
        expect(fingerprint).toBe(fingerprintValue({
          provider,
          algorithm: provider === 'mock' ? 'mock-tts-v2' : 'file-tts-v1',
        }));
      }
    },
  );
});
