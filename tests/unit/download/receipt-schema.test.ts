import {describe, expect, expectTypeOf, it} from 'vitest';
import {
  DownloadReceiptSchema,
  type DownloadArchiveFile,
  type DownloadReceipt,
} from '../../../src/download/receipt-schema';

const CANONICAL_PLATFORM_ISSUE =
  'canonicalUrl must use a supported platform matching receipt.platform';

interface ArchiveFileFixture {
  role: string;
  path: string;
  bytes: number;
  sha256: string;
}

interface ReceiptFixture {
  version: number;
  status: string;
  platform: string;
  videoId: string;
  title: string;
  canonicalUrl: string;
  downloadedAt: string;
  purpose: string;
  rightsConfirmed: boolean;
  transcoded: boolean;
  tools: {
    ytDlpVersion: string;
    ffmpegVersion: string;
  };
  files: ArchiveFileFixture[];
  browserCookies?: {
    used: boolean;
    source?: string;
  };
  network?: {
    proxyUsed: boolean;
    proxyScheme?: string;
    browserImpersonation: boolean;
    browserFamily?: string;
  };
  toolchain?: {
    source: string;
    ytDlpVersion: string;
    managedAssetSha256?: string;
    potProvider?: {
      name: string;
      version: string;
      mode: string;
    };
  };
}

const sha256 = (character: string): string =>
  `sha256:${character.repeat(64)}`;

const metadataFile = (
  overrides: Partial<ArchiveFileFixture> = {},
): ArchiveFileFixture => ({
  role: 'metadata',
  path: 'video.info.json',
  bytes: 512,
  sha256: sha256('a'),
  ...overrides,
});

const mediaFile = (
  overrides: Partial<ArchiveFileFixture> = {},
): ArchiveFileFixture => ({
  role: 'media',
  path: 'video.webm',
  bytes: 1_024,
  sha256: sha256('b'),
  ...overrides,
});

const makeReceipt = (
  browserCookies?: ReceiptFixture['browserCookies'],
): ReceiptFixture => ({
  version: 1,
  status: 'downloaded',
  platform: 'youtube',
  videoId: 'abc_123-XYZ.0',
  title: 'Example video',
  canonicalUrl: 'https://www.youtube.com/watch?v=abc_123-XYZ.0',
  downloadedAt: '2026-08-13T10:30:00+08:00',
  purpose: 'learning-analysis',
  rightsConfirmed: true,
  transcoded: false,
  tools: {
    ytDlpVersion: '2026.08.01',
    ffmpegVersion: '7.1.1',
  },
  files: [metadataFile(), mediaFile()],
  ...(browserCookies === undefined ? {} : {browserCookies}),
});

const makeDouyinReceipt = (): ReceiptFixture => ({
  ...makeReceipt(),
  platform: 'douyin',
  videoId: '7654841525762919726',
  title: 'Public Douyin fixture',
  canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
});

const makeV3Receipt = (): ReceiptFixture => ({
  ...makeReceipt(),
  version: 3,
  videoId: 'abc',
  canonicalUrl: 'https://www.youtube.com/watch?v=abc',
  browserCookies: {used: false},
  network: {
    proxyUsed: true,
    proxyScheme: 'socks5h',
    browserImpersonation: false,
  },
  toolchain: {
    source: 'managed',
    ytDlpVersion: '2026.08.01',
    managedAssetSha256: sha256('c'),
    potProvider: {
      name: 'bgutil',
      version: '1.3.1',
      mode: 'script',
    },
  },
});

const SENSITIVE_VALUE = 'sensitive-value-marker';

const sensitiveReceiptCases: ReadonlyArray<readonly [string, () => unknown]> = [
  ['proxy URL', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      network: {
        ...receipt.network,
        proxyUrl: `socks5h://user:${SENSITIVE_VALUE}@proxy.example`,
      },
    };
  }],
  ['proxy credentials', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      network: {
        ...receipt.network,
        proxyCredentials: {username: 'user', password: SENSITIVE_VALUE},
      },
    };
  }],
  ['browser path', () => ({
    ...makeV3Receipt(),
    browserCookies: {
      used: true,
      source: 'chrome',
      browserPath: `/private/${SENSITIVE_VALUE}`,
    },
  })],
  ['browser profile', () => ({
    ...makeV3Receipt(),
    browserCookies: {
      used: true,
      source: 'chrome',
      profile: SENSITIVE_VALUE,
    },
  })],
  ['browser impersonation target', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      network: {
        proxyUsed: true,
        proxyScheme: 'socks5h',
        browserImpersonation: true,
        browserFamily: 'chrome',
        impersonationTarget: SENSITIVE_VALUE,
      },
    };
  }],
  ['token', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      toolchain: {...receipt.toolchain, token: SENSITIVE_VALUE},
    };
  }],
  ['visitor data', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      network: {...receipt.network, visitorData: SENSITIVE_VALUE},
    };
  }],
  ['child arguments', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      toolchain: {...receipt.toolchain, childArgs: [SENSITIVE_VALUE]},
    };
  }],
  ['child environment', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      toolchain: {
        ...receipt.toolchain,
        childEnvironment: {TOKEN: SENSITIVE_VALUE},
      },
    };
  }],
  ['provider path', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      toolchain: {
        ...receipt.toolchain,
        potProvider: {
          ...receipt.toolchain?.potProvider,
          path: `/private/${SENSITIVE_VALUE}`,
        },
      },
    };
  }],
  ['staging path', () => ({
    ...makeV3Receipt(),
    stagingPath: `/tmp/${SENSITIVE_VALUE}`,
  })],
  ['nested unknown key', () => {
    const receipt = makeV3Receipt();
    return {
      ...receipt,
      tools: {...receipt.tools, futureAudit: SENSITIVE_VALUE},
    };
  }],
];

const expectInvalid = (receipt: unknown): void => {
  expect(DownloadReceiptSchema.safeParse(receipt).success).toBe(false);
};

const expectInvalidArchiveFilename = (path: string): void => {
  const receipt = makeReceipt();
  const result = DownloadReceiptSchema.safeParse({
    ...receipt,
    files: [metadataFile(), mediaFile({path})],
  });

  expect(result.success).toBe(false);
  if (result.success) throw new Error(`Expected invalid archive filename: ${path}`);
  expect(result.error.issues).toContainEqual(expect.objectContaining({
    message: 'path must be exactly one safe archive filename',
    path: ['files', 1, 'path'],
  }));
};

const expectCanonicalPlatformIssue = (
  receipt: ReceiptFixture,
): void => {
  const result = DownloadReceiptSchema.safeParse(receipt);

  expect(result.success).toBe(false);
  if (result.success) throw new Error('Expected canonical platform issue.');
  const issue = result.error.issues.find((candidate) =>
    candidate.message === CANONICAL_PLATFORM_ISSUE);
  expect(issue).toMatchObject({
    code: 'custom',
    message: CANONICAL_PLATFORM_ISSUE,
    path: ['canonicalUrl'],
  });
  expect(issue?.message).not.toContain(receipt.canonicalUrl);
};

describe('download receipt schema', () => {
  it('parses a valid strict receipt unchanged', () => {
    const receipt = makeReceipt();
    const parsed: DownloadReceipt = DownloadReceiptSchema.parse(receipt);

    expect(parsed).toEqual(receipt);
    expectTypeOf(parsed.files).toEqualTypeOf<DownloadArchiveFile[]>();
  });

  it('parses a valid strict version 2 cookie audit receipt unchanged', () => {
    const receipt = {
      ...makeDouyinReceipt(),
      version: 2,
      browserCookies: {used: true, source: 'chrome'},
    };

    expect(DownloadReceiptSchema.parse(receipt)).toEqual(receipt);
  });

  it('parses a valid strict version 3 audit receipt unchanged', () => {
    const receipt = makeV3Receipt();
    const parsed: DownloadReceipt = DownloadReceiptSchema.parse(receipt);

    expect(parsed).toEqual(receipt);
    expect(parsed.version).toBe(3);
    if (parsed.version !== 3) throw new Error('Expected a version 3 receipt.');
    expect(parsed.browserCookies).toEqual({used: false});
    expect(parsed.network).toEqual({
      proxyUsed: true,
      proxyScheme: 'socks5h',
      browserImpersonation: false,
    });
    expect(parsed.toolchain).toEqual({
      source: 'managed',
      ytDlpVersion: '2026.08.01',
      managedAssetSha256: sha256('c'),
      potProvider: {name: 'bgutil', version: '1.3.1', mode: 'script'},
    });
  });

  it('parses a valid version 3 override audit without a managed digest', () => {
    const receipt = makeV3Receipt();
    const overrideReceipt = {
      ...receipt,
      toolchain: {
        source: 'override',
        ytDlpVersion: receipt.tools.ytDlpVersion,
      },
    };

    expect(DownloadReceiptSchema.parse(overrideReceipt)).toEqual(overrideReceipt);
  });

  it('rejects a version 2 cookie receipt for YouTube', () => {
    expectInvalid({
      ...makeReceipt(),
      version: 2,
      browserCookies: {used: true, source: 'chrome'},
    });
  });

  it('rejects cookie audit fields on version 1', () => {
    expectInvalid(makeReceipt({used: true, source: 'chrome'}));
  });

  it.each([
    ['version 1', {
      ...makeReceipt(),
      network: {proxyUsed: false, browserImpersonation: false},
      toolchain: {
        source: 'managed',
        ytDlpVersion: '2026.08.01',
        managedAssetSha256: sha256('c'),
      },
    }],
    ['version 2', {
      ...makeDouyinReceipt(),
      version: 2,
      browserCookies: {used: true, source: 'chrome'},
      network: {proxyUsed: false, browserImpersonation: false},
      toolchain: {
        source: 'managed',
        ytDlpVersion: '2026.08.01',
        managedAssetSha256: sha256('c'),
      },
    }],
  ])('rejects version 3 audit fields on %s', (_caseName, receipt) => {
    expectInvalid(receipt);
  });

  it.each([
    ['omitted browserCookies', {...makeDouyinReceipt(), version: 2}],
    [
      'undefined browserCookies',
      {...makeDouyinReceipt(), version: 2, browserCookies: undefined},
    ],
    [
      'unused Chrome cookies',
      {
        ...makeDouyinReceipt(),
        version: 2,
        browserCookies: {used: false, source: 'chrome'},
      },
    ],
    [
      'unsupported cookie source',
      {
        ...makeDouyinReceipt(),
        version: 2,
        browserCookies: {used: true, source: 'firefox'},
      },
    ],
    [
      'unexpected cookie profile',
      {
        ...makeDouyinReceipt(),
        version: 2,
        browserCookies: {used: true, source: 'chrome', profile: 'Default'},
      },
    ],
  ])('rejects version 2 receipt with %s', (_caseName, receipt) => {
    expectInvalid(receipt);
  });

  it.each([
    ['proxy enabled without scheme', {
      proxyUsed: true,
      browserImpersonation: false,
    }, 'proxy audit fields disagree'],
    ['proxy disabled with scheme', {
      proxyUsed: false,
      proxyScheme: 'https',
      browserImpersonation: false,
    }, 'proxy audit fields disagree'],
    ['impersonation enabled without family', {
      proxyUsed: false,
      browserImpersonation: true,
    }, 'browser impersonation audit fields disagree'],
    ['impersonation disabled with family', {
      proxyUsed: false,
      browserImpersonation: false,
      browserFamily: 'chrome',
    }, 'browser impersonation audit fields disagree'],
  ])('rejects version 3 network audit with %s', (
    _caseName,
    network,
    message,
  ) => {
    const result = DownloadReceiptSchema.safeParse({
      ...makeV3Receipt(),
      network,
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected invalid network audit.');
    expect(result.error.issues).toContainEqual(expect.objectContaining({message}));
  });

  it.each([
    ['unused cookies with a source', {used: false, source: 'chrome'}],
    ['used cookies without a source', {used: true}],
    ['used cookies with an unsupported source', {used: true, source: 'firefox'}],
  ])('rejects version 3 Cookie audit with %s', (
    _caseName,
    browserCookies,
  ) => {
    expectInvalid({...makeV3Receipt(), browserCookies});
  });

  it('rejects version 3 tools and toolchain version disagreement', () => {
    const receipt = makeV3Receipt();

    expectInvalid({
      ...receipt,
      toolchain: {...receipt.toolchain, ytDlpVersion: '2026.08.02'},
    });
  });

  it.each([
    ['managed toolchain without digest', {
      source: 'managed',
      ytDlpVersion: '2026.08.01',
    }],
    ['managed toolchain with malformed digest', {
      source: 'managed',
      ytDlpVersion: '2026.08.01',
      managedAssetSha256: 'sha256:not-a-digest',
    }],
    ['override toolchain with digest', {
      source: 'override',
      ytDlpVersion: '2026.08.01',
      managedAssetSha256: sha256('c'),
    }],
  ])('rejects version 3 %s', (_caseName, toolchain) => {
    expectInvalid({...makeV3Receipt(), toolchain});
  });

  it.each(sensitiveReceiptCases)(
    'rejects version 3 receipt containing %s without retaining its value',
    (_caseName, makeUnsafeReceipt) => {
      const result = DownloadReceiptSchema.safeParse(makeUnsafeReceipt());

      expect(result.success).toBe(false);
      if (result.success) throw new Error('Expected a private audit field rejection.');
      expect(result.error.message).not.toContain(SENSITIVE_VALUE);
      expect(JSON.stringify(result)).not.toContain(SENSITIVE_VALUE);
    },
  );

  it('rejects an unexpected top-level key', () => {
    expectInvalid({...makeReceipt(), unexpected: true});
  });

  it('rejects an unexpected tools key', () => {
    const receipt = makeReceipt();
    expectInvalid({
      ...receipt,
      tools: {...receipt.tools, unexpected: true},
    });
  });

  it('rejects an unexpected file key', () => {
    const receipt = makeReceipt();
    expectInvalid({
      ...receipt,
      files: [{...metadataFile(), unexpected: true}, mediaFile()],
    });
  });

  it('requires confirmed rights', () => {
    expectInvalid({...makeReceipt(), rightsConfirmed: false});
  });

  it('requires an untranscoded archive', () => {
    expectInvalid({...makeReceipt(), transcoded: true});
  });

  it('rejects an HTTP canonical URL', () => {
    expectInvalid({
      ...makeReceipt(),
      canonicalUrl: 'http://www.youtube.com/watch?v=abc',
    });
  });

  it.each([
    ['youtube', 'https://www.youtube.com/watch?v=abc'],
    ['bilibili', 'https://www.bilibili.com/video/BV1xx411c7mD'],
    ['douyin', 'https://www.douyin.com/video/1234567890'],
    ['tiktok', 'https://www.tiktok.com/@creator/video/1234567890'],
    ['vimeo', 'https://vimeo.com/123456789'],
  ])('accepts and preserves a valid %s canonical URL', (platform, canonicalUrl) => {
    expect(DownloadReceiptSchema.parse({
      ...makeReceipt(),
      platform,
      canonicalUrl,
    }).canonicalUrl).toBe(canonicalUrl);
  });

  it('rejects an unsupported canonical host with a stable issue', () => {
    expectCanonicalPlatformIssue({
      ...makeReceipt(),
      canonicalUrl: 'https://example.com/video?id=abc',
    });
  });

  it('rejects a canonical platform mismatch with a stable issue', () => {
    expectCanonicalPlatformIssue({
      ...makeReceipt(),
      canonicalUrl: 'https://vimeo.com/123456789',
    });
  });

  it.each([
    ' https://example.com/video',
    'https://example.com/video ',
    'https://example.com/video\n',
    'https://example.com/video\tsegment',
    'https://example.com/\u0085video',
    'https:example.com',
    'https://user:pass@example.com/video',
  ])('rejects non-canonical HTTPS URL %j', (canonicalUrl) => {
    expectInvalid({...makeReceipt(), canonicalUrl});
  });

  it.each([
    '',
    'a'.repeat(513),
    'video id',
    '../video',
    'video\\id',
    'video?id=secret',
  ])('rejects invalid or unsafe video ID %j', (videoId) => {
    expectInvalid({...makeReceipt(), videoId});
  });

  it.each(['.', '..'])('rejects dot-segment video ID %j', (videoId) => {
    expectInvalid({...makeReceipt(), videoId});
  });

  it('rejects files that are not sorted by path', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [mediaFile(), metadataFile()],
    });
  });

  it('rejects duplicate file paths', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [metadataFile(), mediaFile({path: 'video.info.json'})],
    });
  });

  it('accumulates duplicate-path and role-count issues', () => {
    const result = DownloadReceiptSchema.safeParse({
      ...makeReceipt(),
      files: [metadataFile(), metadataFile()],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error('Expected accumulated file issues.');
    expect(result.error.issues).toHaveLength(3);
    expect(result.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: 'duplicate file path: video.info.json',
        path: ['files', 1, 'path'],
      }),
      expect.objectContaining({
        message: 'files must contain exactly one media entry',
        path: ['files'],
      }),
      expect.objectContaining({
        message: 'files must contain exactly one metadata entry',
        path: ['files'],
      }),
    ]));
  });

  it('rejects a missing media file', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [
        metadataFile(),
        metadataFile({role: 'subtitle', path: 'video.vtt'}),
      ],
    });
  });

  it('rejects extra media files', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [
        metadataFile(),
        mediaFile({path: 'video.part-1.webm'}),
        mediaFile({path: 'video.part-2.webm'}),
      ],
    });
  });

  it('rejects a missing metadata file', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [
        mediaFile({role: 'subtitle', path: 'video.vtt'}),
        mediaFile(),
      ],
    });
  });

  it('rejects extra metadata files', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [
        metadataFile({path: 'video.description.json'}),
        metadataFile(),
        mediaFile(),
      ],
    });
  });

  it.each([
    ['media.bin', [
      mediaFile({path: 'media.bin'}),
      metadataFile(),
    ]],
    ['meta.bin', [
      metadataFile({path: 'meta.bin'}),
      mediaFile(),
    ]],
  ] as const)('rejects forged role path %s', (_caseName, files) => {
    expectInvalid({...makeReceipt(), files});
  });

  it('rejects metadata and media role/path swaps', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [
        metadataFile({role: 'media'}),
        mediaFile({role: 'metadata'}),
      ],
    });
  });

  it.each([
    ['subtitle basename', {
      role: 'subtitle',
      path: 'caption.en.vtt',
    }],
    ['subtitle extension', {
      role: 'subtitle',
      path: 'video.en.txt',
    }],
    ['thumbnail basename', {
      role: 'thumbnail',
      path: 'thumbnail.webp',
    }],
    ['thumbnail extension', {
      role: 'thumbnail',
      path: 'video.bmp',
    }],
  ])('rejects an invalid %s', (_caseName, overrides) => {
    const sidecar = metadataFile(overrides);
    expectInvalid({
      ...makeReceipt(),
      files: [sidecar, metadataFile(), mediaFile()]
        .sort((left, right) => left.path.localeCompare(right.path)),
    });
  });

  it('accepts stable subtitle and thumbnail paths', () => {
    const receipt = makeReceipt();
    const files = [
      metadataFile(),
      mediaFile(),
      metadataFile({role: 'subtitle', path: 'video.zh-Hans.vtt'}),
      metadataFile({role: 'thumbnail', path: 'video.webp'}),
    ].sort((left, right) => left.path.localeCompare(right.path));

    expect(DownloadReceiptSchema.parse({...receipt, files}).files).toEqual(files);
  });

  it('rejects two thumbnails', () => {
    expectInvalid({
      ...makeReceipt(),
      files: [
        metadataFile(),
        metadataFile({role: 'thumbnail', path: 'video.jpg'}),
        mediaFile(),
        metadataFile({role: 'thumbnail', path: 'video.webp'}),
      ],
    });
  });

  it.each([
    '',
    '.',
    '..',
    'dir/video.webm',
    'dir\\video.webm',
    'video\0.webm',
    'video\n.webm',
    'video\t.webm',
    'video\u007f.webm',
    'video\u0085.webm',
    'receipt.json',
  ])('rejects invalid archive filename %j', (path) => {
    expectInvalidArchiveFilename(path);
  });

  it.each([-1, 1.5])('rejects invalid byte count %s', (bytes) => {
    expectInvalid({
      ...makeReceipt(),
      files: [metadataFile(), mediaFile({bytes})],
    });
  });

  it.each([
    'a'.repeat(64),
    `sha256:${'a'.repeat(63)}`,
    `sha256:${'A'.repeat(64)}`,
    `sha256:${'g'.repeat(64)}`,
  ])('rejects malformed SHA-256 %j', (hash) => {
    expectInvalid({
      ...makeReceipt(),
      files: [metadataFile(), mediaFile({sha256: hash})],
    });
  });

  it.each([
    'not-a-date',
    '2026-08-13',
    '2026-08-13T10:30:00',
    '2026-02-30T10:30:00+08:00',
  ])('rejects invalid downloadedAt %j', (downloadedAt) => {
    expectInvalid({...makeReceipt(), downloadedAt});
  });
});
