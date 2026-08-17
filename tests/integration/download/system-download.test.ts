import {
  readFile,
  readdir,
} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {downloadVideo} from '../../../src/download/downloader';
import {DownloadReceiptSchema} from '../../../src/download/receipt-schema';
import {
  FAKE_YT_DLP_FIXTURE,
  FIXED_DOWNLOAD_TIME,
  NETWORK_COMMAND,
  PROBE_SECRET_MARKERS,
  createManagedDownloadFixture,
  installNetworkSocketGuard,
  type ManagedDownloadFixture,
  type NetworkSocketGuard,
} from './managed-toolchain-fixture';

const CANONICAL_URL = 'https://www.youtube.com/watch?v=abc';
const FINAL_FILENAMES = [
  'receipt.json',
  'video.en.vtt',
  'video.info.json',
  'video.webm',
  'video.webp',
] as const;
const INFO_DOCUMENT = {
  id: 'abc',
  title: 'youtube fixture abc',
  webpage_url: CANONICAL_URL,
  extractor: 'Youtube',
  extractor_key: 'Youtube',
  _type: 'video',
};
const COOKIE_INFO_DOCUMENT = {
  id: '7654841525762919726',
  title: 'douyin fixture 7654841525762919726',
  webpage_url: 'https://www.douyin.com/video/7654841525762919726',
  extractor: 'Douyin',
  extractor_key: 'Douyin',
  _type: 'video',
};
const fixtures: ManagedDownloadFixture[] = [];
const socketGuards: NetworkSocketGuard[] = [];

const expectNoProbeSecretMarkers = (value: unknown): void => {
  const source = Buffer.isBuffer(value)
    ? value.toString('utf8')
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);
  for (const marker of PROBE_SECRET_MARKERS) expect(source).not.toContain(marker);
};

const expectPublishedFilesContainNoProbeSecrets = async (
  finalDirectory: string,
): Promise<void> => {
  for (const filename of await readdir(finalDirectory)) {
    expectNoProbeSecretMarkers(await readFile(path.join(finalDirectory, filename)));
  }
};

afterEach(async () => {
  for (const guard of socketGuards.splice(0)) guard.restore();
  await Promise.all(fixtures.splice(0).map(async (fixture) => {
    await fixture.cleanup();
  }));
});

describe('system download integration', () => {
  it('archives one video with the strict managed toolchain and no Node network sockets', async () => {
    const socketGuard = installNetworkSocketGuard();
    socketGuards.push(socketGuard);
    expect(await readFile(FAKE_YT_DLP_FIXTURE, 'utf8')).not.toMatch(NETWORK_COMMAND);
    const fixture = await createManagedDownloadFixture();
    fixtures.push(fixture);

    const input = {
      workspaceRoot: fixture.workspaceRoot,
      url: CANONICAL_URL,
      outputRoot: 'downloads',
      rightsConfirmed: true,
      cookieAccessConfirmed: false,
    } as const;
    const result = await downloadVideo(input, fixture.dependencies);
    expect(result.status).toBe('downloaded');
    if (result.status !== 'downloaded') {
      throw new Error('Expected a newly downloaded archive.');
    }
    expect(result.receipt).toMatchObject({
      version: 3,
      browserCookies: {used: false},
      network: {
        proxyUsed: false,
        browserImpersonation: false,
      },
      toolchain: {
        source: 'managed',
        potProvider: {name: 'bgutil', version: '1.3.1', mode: 'script'},
      },
    });

    const finalDirectory = path.join(
      fixture.workspaceRoot,
      'downloads',
      'youtube',
      'abc',
    );
    const stagingRoot = path.join(fixture.workspaceRoot, 'downloads', '.staging');
    expect((await readdir(finalDirectory)).sort()).toEqual([...FINAL_FILENAMES]);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(result).toMatchObject({
      status: 'downloaded',
      platform: 'youtube',
      videoId: 'abc',
      directory: 'downloads/youtube/abc',
      mediaPath: 'downloads/youtube/abc/video.webm',
      receiptPath: 'downloads/youtube/abc/receipt.json',
    });

    const receiptSource = await readFile(
      path.join(finalDirectory, 'receipt.json'),
      'utf8',
    );
    const receipt = DownloadReceiptSchema.parse(JSON.parse(receiptSource));
    expect(receipt).toEqual(result.receipt);
    expectNoProbeSecretMarkers(result);
    expectNoProbeSecretMarkers(receiptSource);
    expect(receipt).toMatchObject({
      version: 3,
      downloadedAt: FIXED_DOWNLOAD_TIME.toISOString(),
      platform: 'youtube',
      videoId: 'abc',
      title: 'youtube fixture abc',
      canonicalUrl: CANONICAL_URL,
      tools: {
        ytDlpVersion: '2026.07.04',
        ffmpegVersion: '8.1.2',
      },
    });
    expect(receipt.files.map((file) => file.path)).toEqual([
      'video.en.vtt',
      'video.info.json',
      'video.webm',
      'video.webp',
    ]);

    const metadata = JSON.parse(await readFile(
      path.join(finalDirectory, 'video.info.json'),
      'utf8',
    )) as unknown;
    expect(metadata).toEqual(INFO_DOCUMENT);
    expect(Object.keys(metadata as Record<string, unknown>)).toEqual([
      'id',
      'title',
      'webpage_url',
      'extractor',
      'extractor_key',
      '_type',
    ]);
    expect(await readFile(
      path.join(finalDirectory, 'video.en.vtt'),
      'utf8',
    )).toContain('Fixture subtitle for youtube.');
    expect((await readFile(path.join(finalDirectory, 'video.webm')))
      .subarray(0, 4)).toEqual(Buffer.from('1a45dfa3', 'hex'));
    const thumbnail = await readFile(path.join(finalDirectory, 'video.webp'));
    expect(thumbnail.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(thumbnail.subarray(8, 12).toString('ascii')).toBe('WEBP');

    const duplicate = await downloadVideo(input, fixture.dependencies);
    expect(duplicate.status).toBe('already-present');
    expect(duplicate.receipt).toEqual(receipt);
    expect((await readdir(finalDirectory)).sort()).toEqual([...FINAL_FILENAMES]);
    expect(await readdir(stagingRoot)).toEqual([]);
    expect(fixture.operations.map((operation) => operation.phase))
      .toEqual(['probe', 'download', 'probe']);
    await expectPublishedFilesContainNoProbeSecrets(finalDirectory);
    expect(socketGuard.calls).toEqual([]);
  });

  it('archives one normalized Douyin video with explicit Chrome Cookie mode', async () => {
    const socketGuard = installNetworkSocketGuard();
    socketGuards.push(socketGuard);
    const fixture = await createManagedDownloadFixture();
    fixtures.push(fixture);

    const result = await downloadVideo({
      workspaceRoot: fixture.workspaceRoot,
      url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
      outputRoot: 'downloads',
      rightsConfirmed: true,
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
    }, fixture.dependencies);

    expect(result.status).toBe('downloaded');
    if (result.status !== 'downloaded') {
      throw new Error('Expected a newly downloaded Cookie-assisted archive.');
    }
    const finalDirectory = path.join(
      fixture.workspaceRoot,
      'downloads',
      'douyin',
      '7654841525762919726',
    );
    expect(result).toMatchObject({
      status: 'downloaded',
      platform: 'douyin',
      videoId: '7654841525762919726',
      receipt: {
        version: 3,
        canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
        browserCookies: {used: true, source: 'chrome'},
        network: {proxyUsed: false, browserImpersonation: false},
      },
    });
    if (result.receipt.version !== 3) {
      throw new Error('Expected receipt version 3.');
    }
    expect(result.receipt.toolchain).not.toHaveProperty('potProvider');
    expect(DownloadReceiptSchema.parse(result.receipt)).toEqual(result.receipt);
    expectNoProbeSecretMarkers(result);
    expect((await readdir(finalDirectory)).sort()).toEqual([...FINAL_FILENAMES]);

    const receipt = DownloadReceiptSchema.parse(JSON.parse(
      await readFile(path.join(finalDirectory, 'receipt.json'), 'utf8'),
    ));
    expect(receipt).toEqual(result.receipt);
    expectNoProbeSecretMarkers(receipt);
    const metadata = JSON.parse(await readFile(
      path.join(finalDirectory, 'video.info.json'),
      'utf8',
    )) as unknown;
    expect(metadata).toEqual(COOKIE_INFO_DOCUMENT);
    expect(Object.keys(metadata as Record<string, unknown>)).toEqual([
      'id',
      'title',
      'webpage_url',
      'extractor',
      'extractor_key',
      '_type',
    ]);
    await expectPublishedFilesContainNoProbeSecrets(finalDirectory);
    expect(socketGuard.calls).toEqual([]);
  });
});
