import {
  access,
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {EXIT_CODES} from '../../../src/cli/exit-codes';
import {runVideoctl} from '../../../src/cli/videoctl';
import {
  isDownloadError,
  type DownloadError,
  type DownloadErrorCode,
} from '../../../src/download/errors';
import {
  PROBE_SECRET_MARKERS,
  createManagedDownloadFixture,
  readDigestRecords,
  type FakeYtDlpScenario,
  type ManagedDownloadFixture,
} from './managed-toolchain-fixture';

const proxySource = 'socks5h://127.0.0.1:1080';
const proxyUrl = 'socks5h://127.0.0.1:1080';
const fixtures: ManagedDownloadFixture[] = [];
const rawFailures: Record<FakeYtDlpScenario, string> = {
  'rate-limit': 'HTTP Error 429: Too Many Requests',
  'bot-check': 'Sign in to confirm you are not a bot',
  'bilibili-412': 'HTTP Error 412: Precondition Failed',
  timeout: 'Connection timed out',
  'missing-impersonation': 'Impersonate target is unavailable',
  'missing-provider': 'bgutil script provider unavailable',
  'keychain-denied': 'Keychain access denied',
  unknown: 'unclassified fixture failure',
};
const cases: ReadonlyArray<{
  scenario: Exclude<FakeYtDlpScenario, 'keychain-denied'>;
  url: string;
  videoId: string;
  code: DownloadErrorCode;
  message: string;
}> = [
  {
    scenario: 'rate-limit',
    url: 'https://www.youtube.com/watch?v=rate-limit',
    videoId: 'rate-limit',
    code: 'DOWNLOAD_RATE_LIMITED',
    message: 'The video platform temporarily rate-limited this session.',
  },
  {
    scenario: 'bot-check',
    url: 'https://www.youtube.com/watch?v=bot-check',
    videoId: 'bot-check',
    code: 'DOWNLOAD_RATE_LIMITED',
    message: 'The video platform temporarily rate-limited this session.',
  },
  {
    scenario: 'bilibili-412',
    url: 'https://www.bilibili.com/video/BV1challenge',
    videoId: 'BV1challenge',
    code: 'DOWNLOAD_PLATFORM_CHALLENGE',
    message: 'The video platform rejected the selected public-session request.',
  },
  {
    scenario: 'timeout',
    url: 'https://vimeo.com/404',
    videoId: '404',
    code: 'DOWNLOAD_NETWORK_UNREACHABLE',
    message:
      'The video platform could not be reached with the selected network settings.',
  },
  {
    scenario: 'missing-impersonation',
    url: 'https://www.tiktok.com/@fixture/video/501',
    videoId: '501',
    code: 'DOWNLOAD_IMPERSONATION_UNAVAILABLE',
    message: 'The required browser compatibility capability is unavailable.',
  },
  {
    scenario: 'missing-provider',
    url: 'https://www.youtube.com/watch?v=provider',
    videoId: 'provider',
    code: 'DOWNLOAD_PO_TOKEN_UNAVAILABLE',
    message: 'The YouTube compatibility provider is unavailable.',
  },
  {
    scenario: 'unknown',
    url: 'https://www.douyin.com/video/unknown',
    videoId: 'unknown',
    code: 'DOWNLOAD_PROBE_FAILED',
    message: 'Video metadata could not be extracted.',
  },
];

const expectNoSensitiveFailureDetails = (
  error: DownloadError,
  rawFailure: string,
): void => {
  const serialized = `${String(error)}\n${JSON.stringify(error)}`;
  expect(error.cause).toBeUndefined();
  expect(serialized).not.toContain(rawFailure);
  for (const marker of PROBE_SECRET_MARKERS) expect(serialized).not.toContain(marker);
};

const readDirectoryOrEmpty = async (candidate: string): Promise<string[]> => {
  try {
    return await readdir(candidate);
  } catch (error) {
    if (
      typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'ENOENT'
    ) {
      return [];
    }
    throw error;
  }
};

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.cleanup();
  }));
});

describe('platform error classification integration', () => {
  for (const phase of ['probe', 'download'] as const) {
    it.each(cases)(
      `maps $scenario during ${phase} without an application retry`,
      async ({scenario, url, videoId, code, message}) => {
        const fixture = await createManagedDownloadFixture({
          scenario,
          failurePhase: phase,
        });
        fixtures.push(fixture);
        const expectedCode = scenario === 'unknown'
          ? phase === 'probe'
            ? 'DOWNLOAD_PROBE_FAILED'
            : 'DOWNLOAD_PROCESS_FAILED'
          : code;
        const expectedMessage = scenario === 'unknown'
          ? phase === 'probe'
            ? 'Video metadata could not be extracted.'
            : 'The video could not be downloaded.'
          : message;

        const run = fixture.createCommandHarness();
        const realDownload = run.dependencies.download;
        let capturedError: DownloadError | undefined;
        run.dependencies.download = async (input) => {
          try {
            return await realDownload(input);
          } catch (error) {
            if (isDownloadError(error)) capturedError = error;
            throw error;
          }
        };
        const exitCode = await runVideoctl([
          'download',
          url,
          '--rights-confirmed',
          '--proxy',
          proxySource,
          '--browser-cookies',
          'chrome',
          '--cookie-access-confirmed',
          '--json',
        ], run.dependencies);
        if (capturedError === undefined) {
          throw new Error('Expected a controlled download error.');
        }
        const error = capturedError;

        expect(error).toMatchObject({
          code: expectedCode,
          message: expectedMessage,
        });
        expect(exitCode).toBe(
          expectedCode === 'DOWNLOAD_IMPERSONATION_UNAVAILABLE'
          || expectedCode === 'DOWNLOAD_PO_TOKEN_UNAVAILABLE'
            ? EXIT_CODES.environmentFailed
            : EXIT_CODES.operationFailed,
        );
        expect(run.stdout()).toBe(`${JSON.stringify({
          command: 'download',
          ok: false,
          code: expectedCode,
          message: expectedMessage,
        }, null, 2)}\n`);
        expect(run.stderr()).toBe('');
        expectNoSensitiveFailureDetails(error, rawFailures[scenario]);
        expect(`${run.stdout()}${run.stderr()}`)
          .not.toContain(rawFailures[scenario]);
        for (const marker of PROBE_SECRET_MARKERS) {
          expect(`${run.stdout()}${run.stderr()}`).not.toContain(marker);
        }
        expect(fixture.operations.map((operation) => operation.phase)).toEqual(
          phase === 'probe' ? ['probe'] : ['probe', 'download'],
        );
        expect(fixture.processFailures).toHaveLength(1);
        expect(fixture.processFailures[0]?.result.stderr)
          .toContain(rawFailures[scenario]);
        const records = await readDigestRecords(fixture.recordPath);
        expect(records.map((record) => record.phase)).toEqual(
          phase === 'probe' ? ['probe'] : ['probe', 'download'],
        );
        expect(records.every((record) => (
          Object.keys(record).sort().join(',') === 'digest,phase'
        ))).toBe(true);
        const recordSource = await readFile(fixture.recordPath, 'utf8');
        expect(recordSource).not.toContain(url);
        expect(recordSource).not.toContain(proxyUrl);
        expect(recordSource).not.toContain(rawFailures[scenario]);
        for (const marker of PROBE_SECRET_MARKERS) {
          expect(recordSource).not.toContain(marker);
        }
        expect(await readDirectoryOrEmpty(path.join(
          fixture.workspaceRoot,
          'downloads/.staging',
        ))).toEqual([]);
        await expect(access(path.join(
          fixture.workspaceRoot,
          'downloads',
          new URL(url).hostname.includes('youtube')
            ? 'youtube'
            : new URL(url).hostname.includes('bilibili')
              ? 'bilibili'
              : new URL(url).hostname.includes('tiktok')
                ? 'tiktok'
                : new URL(url).hostname.includes('vimeo')
                  ? 'vimeo'
                  : 'douyin',
          videoId,
        ))).rejects.toMatchObject({code: 'ENOENT'});
      },
    );
  }

  it('keeps Chrome keychain denial generic with no anonymous or Cookie retry', async () => {
    const fixture = await createManagedDownloadFixture({
      scenario: 'keychain-denied',
      failurePhase: 'probe',
    });
    fixtures.push(fixture);
    const url = 'https://www.douyin.com/video/keychain';

    const run = fixture.createCommandHarness();
    const realDownload = run.dependencies.download;
    let capturedError: DownloadError | undefined;
    run.dependencies.download = async (input) => {
      try {
        return await realDownload(input);
      } catch (error) {
        if (isDownloadError(error)) capturedError = error;
        throw error;
      }
    };
    const exitCode = await runVideoctl([
      'download',
      url,
      '--rights-confirmed',
      '--proxy',
      proxySource,
      '--browser-cookies',
      'chrome',
      '--cookie-access-confirmed',
    ], run.dependencies);
    if (capturedError === undefined) {
      throw new Error('Expected a controlled keychain error.');
    }
    const error = capturedError;

    expect(error).toMatchObject({
      code: 'DOWNLOAD_PROBE_FAILED',
      message: 'Video metadata could not be extracted.',
    });
    expect(exitCode).toBe(EXIT_CODES.operationFailed);
    expect(run.stdout()).toBe('');
    expect(run.stderr()).toBe(
      'Download failed [DOWNLOAD_PROBE_FAILED]: '
      + 'Video metadata could not be extracted.\n',
    );
    expectNoSensitiveFailureDetails(error, rawFailures['keychain-denied']);
    expect(`${run.stdout()}${run.stderr()}`).not.toContain('Keychain access denied');
    for (const marker of PROBE_SECRET_MARKERS) {
      expect(`${run.stdout()}${run.stderr()}`).not.toContain(marker);
    }
    expect(fixture.operations).toHaveLength(1);
    expect(fixture.operations[0]?.phase).toBe('probe');
    const cookieIndexes = fixture.operations[0]?.args
      .map((argument, index) => argument === '--cookies-from-browser' ? index : -1)
      .filter((index) => index >= 0) ?? [];
    expect(cookieIndexes).toHaveLength(1);
    expect(fixture.operations[0]?.args[(cookieIndexes[0] ?? -1) + 1])
      .toBe('chrome');
    expect(fixture.processFailures).toHaveLength(1);
    expect(fixture.processFailures[0]?.result.stderr)
      .toContain('Keychain access denied');
    expect(fixture.processFailures[0]?.result.stderr)
      .toContain('/Users/fixture/Library/Application Support/Google/Chrome/Default/Cookies');
    expect(await readDigestRecords(fixture.recordPath)).toHaveLength(1);
    expect(await readDirectoryOrEmpty(path.join(
      fixture.workspaceRoot,
      'downloads/.staging',
    ))).toEqual([]);
    await expect(access(path.join(
      fixture.workspaceRoot,
      'downloads/douyin/keychain',
    ))).rejects.toMatchObject({code: 'ENOENT'});
  });
});
