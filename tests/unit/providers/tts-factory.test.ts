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
          algorithm: `${provider}-tts-v1`,
        }));
      }
    },
  );
});
