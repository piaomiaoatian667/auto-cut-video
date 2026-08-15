# Chrome Cookie-Assisted Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly confirmed, Chrome-cookie-assisted Douyin download path that normalizes Jingxuan modal URLs, preserves the public-only safety contract, records a version 2 audit receipt, and archives the approved real video.

**Architecture:** Keep anonymous downloads unchanged. Add a closed Chrome cookie source at the CLI boundary, validate the dual-confirmation request after URL normalization, pass one immutable cookie option to both `yt-dlp` probe and download calls, and emit a version 2 receipt only for cookie-assisted archives. Extend the fake-tool integration harness so the feature remains fully testable without browser or network access.

**Tech Stack:** TypeScript 7, Node.js 22, Commander, Zod, Vitest, `yt-dlp`, FFmpeg/ffprobe, macOS Darwin descriptor-bound subprocess wrappers.

---

## File Map

- Create `src/download/browser-cookies.ts`: closed source type, raw CLI source parser, and dual-confirmation/platform validation.
- Create `tests/unit/download/browser-cookies.test.ts`: focused source and request validation tests.
- Modify `src/download/platforms.ts`: strict Douyin Jingxuan modal normalization.
- Modify `src/download/errors.ts`: controlled Cookie and restricted-content errors.
- Modify `src/cli/commands/download.ts`: browser source parsing and option forwarding.
- Modify `src/cli/videoctl.ts`: two non-interactive Cookie options.
- Modify `src/download/yt-dlp.ts`: immutable operation options, exact Chrome Cookie arguments, and availability metadata.
- Modify `src/download/downloader.ts`: validation order, Douyin-only scope, restricted-state rejection, and shared access mode.
- Modify `src/download/receipt-schema.ts`: strict receipt version 1/version 2 union.
- Modify `src/download/archive.ts`: version 2 Cookie audit receipt construction.
- Modify download unit and integration tests listed in each task.
- Modify `README.md`: standard anonymous and Cookie-assisted commands and boundaries.

---

### Task 1: Normalize Strict Douyin Jingxuan Modal URLs

**Files:**
- Modify: `src/download/platforms.ts:32-70`
- Test: `tests/unit/download/platforms.test.ts:44-116`

- [ ] **Step 1: Write the failing normalization and rejection tests**

Add inside `describe('download platforms', ...)`:

```ts
it('normalizes one strict Douyin Jingxuan modal URL', () => {
  expect(parseDownloadUrl(
    'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
  )).toEqual({
    url: 'https://www.douyin.com/video/7654841525762919726',
    hostname: 'www.douyin.com',
    platform: 'douyin',
  });
});

it.each([
  'https://www.douyin.com/jingxuan',
  'https://www.douyin.com/jingxuan?modal_id=',
  'https://www.douyin.com/jingxuan?modal_id=abc&modal_id=def',
  'https://www.douyin.com/jingxuan?modal_id=abc&tracking=1',
  'https://www.douyin.com/jingxuan?modal_id=video%2Fid',
  'https://www.douyin.com/jingxuan?modal_id=..',
  'https://www.douyin.com/jingxuan?modal_id=abc#tracking',
])('rejects malformed or ambiguous Douyin modal URL %s', (source) => {
  expectDownloadError(() => parseDownloadUrl(source), 'DOWNLOAD_URL_INVALID');
});
```

- [ ] **Step 2: Run the platform tests and verify RED**

```bash
pnpm vitest run tests/unit/download/platforms.test.ts
```

Expected: the normalized URL still contains `/jingxuan`, and malformed modal cases currently accepted fail their assertions.

- [ ] **Step 3: Implement strict modal normalization**

Add above `parseDownloadUrl`:

```ts
const safeDouyinVideoId = /^[A-Za-z0-9._-]{1,512}$/u;

const invalidDownloadUrl = (): DownloadError => new DownloadError(
  'DOWNLOAD_URL_INVALID',
  'The video URL is invalid.',
);

const normalizeDouyinJingxuanUrl = (
  parsed: URL,
  platform: DownloadPlatform,
): void => {
  if (platform !== 'douyin' || parsed.pathname !== '/jingxuan') return;

  const entries = [...parsed.searchParams.entries()];
  const modalId = entries.length === 1 && entries[0]?.[0] === 'modal_id'
    ? entries[0][1]
    : undefined;
  if (
    parsed.hash !== '' ||
    modalId === undefined ||
    modalId === '.' ||
    modalId === '..' ||
    !safeDouyinVideoId.test(modalId)
  ) {
    throw invalidDownloadUrl();
  }

  parsed.pathname = `/video/${modalId}`;
  parsed.search = '';
};
```

Replace the current URL parse error with `throw invalidDownloadUrl()`. After resolving `platform` and before general fragment removal, call:

```ts
normalizeDouyinJingxuanUrl(parsed, platform);
parsed.hash = '';
return {url: parsed.href, hostname, platform};
```

- [ ] **Step 4: Run focused URL regressions**

```bash
pnpm vitest run \
  tests/unit/download/platforms.test.ts \
  tests/unit/download/receipt-schema.test.ts
```

Expected: both files pass, including existing fragment handling for non-modal URLs.

- [ ] **Step 5: Commit modal normalization**

```bash
git add src/download/platforms.ts tests/unit/download/platforms.test.ts
git commit -m "feat: normalize Douyin modal video URLs"
```

---

### Task 2: Add Closed Chrome Cookie Options and CLI Confirmation

**Files:**
- Create: `src/download/browser-cookies.ts`
- Create: `tests/unit/download/browser-cookies.test.ts`
- Modify: `src/download/errors.ts:1-12`
- Modify: `src/download/downloader.ts:15-36`
- Modify: `src/cli/commands/download.ts:16-91`
- Modify: `src/cli/videoctl.ts:534-542`
- Test: `tests/unit/cli/download.test.ts:1-360`

- [ ] **Step 1: Write failing browser-cookie primitive tests**

Create `tests/unit/download/browser-cookies.test.ts`:

```ts
import {describe, expect, it} from 'vitest';
import {
  parseBrowserCookieSource,
  validateBrowserCookieRequest,
} from '../../../src/download/browser-cookies';
import {isDownloadError} from '../../../src/download/errors';

const expectCode = (callback: () => unknown, code: string): void => {
  try {
    callback();
  } catch (error) {
    expect(isDownloadError(error)).toBe(true);
    if (!isDownloadError(error)) throw error;
    expect(error.code).toBe(code);
    expect(error.cause).toBeUndefined();
    return;
  }
  throw new Error(`Expected ${code}.`);
};

describe('browser cookie source parsing', () => {
  it('accepts only the exact Chrome source', () => {
    expect(parseBrowserCookieSource(undefined)).toBeUndefined();
    expect(parseBrowserCookieSource('chrome')).toBe('chrome');
  });

  it.each(['Chrome', 'chromium', 'firefox', '--config-location'])
    ('rejects unsupported source %s', (source) => {
      expectCode(
        () => parseBrowserCookieSource(source),
        'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      );
    });
});

describe('browser cookie request validation', () => {
  it('accepts anonymous and confirmed Douyin Chrome modes', () => {
    expect(validateBrowserCookieRequest(undefined, false, 'douyin'))
      .toBeUndefined();
    expect(validateBrowserCookieRequest('chrome', true, 'douyin'))
      .toBe('chrome');
  });

  it.each([
    ['chrome', false],
    [undefined, true],
  ] as const)('rejects mismatched source and confirmation', (source, confirmed) => {
    expectCode(
      () => validateBrowserCookieRequest(source, confirmed, 'douyin'),
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
    );
  });

  it('rejects Chrome cookie mode outside Douyin', () => {
    expectCode(
      () => validateBrowserCookieRequest('chrome', true, 'youtube'),
      'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
    );
  });
});
```

- [ ] **Step 2: Run the new test and verify RED**

```bash
pnpm vitest run tests/unit/download/browser-cookies.test.ts
```

Expected: FAIL because the module and error codes do not exist.

- [ ] **Step 3: Add controlled error codes and the browser-cookie module**

Add to `DownloadErrorCode`:

```ts
| 'DOWNLOAD_COOKIE_OPTIONS_INVALID'
| 'DOWNLOAD_COOKIE_HOST_UNSUPPORTED'
| 'DOWNLOAD_CONTENT_RESTRICTED'
```

Create `src/download/browser-cookies.ts`:

```ts
import {DownloadError} from './errors';
import type {DownloadPlatform} from './platforms';

export type BrowserCookieSource = 'chrome';

const COOKIE_OPTIONS_MESSAGE =
  'Chrome cookie access requires both browser selection and explicit confirmation.';
const COOKIE_HOST_MESSAGE =
  'Browser cookie access is supported only for Douyin downloads.';

export const parseBrowserCookieSource = (
  value: string | undefined,
): BrowserCookieSource | undefined => {
  if (value === undefined) return undefined;
  if (value === 'chrome') return value;
  throw new DownloadError(
    'DOWNLOAD_COOKIE_OPTIONS_INVALID',
    COOKIE_OPTIONS_MESSAGE,
  );
};

export const validateBrowserCookieRequest = (
  source: BrowserCookieSource | undefined,
  confirmed: boolean,
  platform: DownloadPlatform,
): BrowserCookieSource | undefined => {
  if ((source !== undefined) !== confirmed) {
    throw new DownloadError(
      'DOWNLOAD_COOKIE_OPTIONS_INVALID',
      COOKIE_OPTIONS_MESSAGE,
    );
  }
  if (source !== undefined && platform !== 'douyin') {
    throw new DownloadError(
      'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
      COOKIE_HOST_MESSAGE,
    );
  }
  return source;
};
```

- [ ] **Step 4: Run primitive tests and verify GREEN**

```bash
pnpm vitest run tests/unit/download/browser-cookies.test.ts
```

Expected: all source, pairing, and platform cases pass.

- [ ] **Step 5: Write failing CLI forwarding and sanitization tests**

Add to `tests/unit/cli/download.test.ts`:

```ts
it('forwards explicit Chrome cookie acknowledgements', async () => {
  const run = fixture();

  const exitCode = await runVideoctl([
    'download',
    'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
    '--rights-confirmed',
    '--browser-cookies',
    'chrome',
    '--cookie-access-confirmed',
  ], run.dependencies);

  expect(exitCode).toBe(EXIT_CODES.success);
  expect(run.download).toHaveBeenCalledWith({
    workspaceRoot: '/workspace',
    url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
    outputRoot: 'downloads',
    rightsConfirmed: true,
    browserCookieSource: 'chrome',
    cookieAccessConfirmed: true,
  });
});

it('rejects an unsupported browser source without forwarding it', async () => {
  const run = fixture();

  const exitCode = await runVideoctl([
    'download',
    'https://www.douyin.com/video/7654841525762919726',
    '--rights-confirmed',
    '--browser-cookies',
    'secret-profile-marker',
    '--cookie-access-confirmed',
    '--json',
  ], run.dependencies);

  expect(exitCode).toBe(EXIT_CODES.validationFailed);
  expect(run.download).not.toHaveBeenCalled();
  expect(JSON.parse(run.stdout())).toEqual({
    command: 'download',
    ok: false,
    code: 'DOWNLOAD_COOKIE_OPTIONS_INVALID',
    message: 'Chrome cookie access requires both browser selection and explicit confirmation.',
  });
  expect(run.stdout()).not.toContain('secret-profile-marker');
  expect(run.stderr()).toBe('');
});

it('shows both Cookie options in download help', async () => {
  const run = fixture();
  const exitCode = await runVideoctl(['download', '--help'], run.dependencies);

  expect(exitCode).toBe(EXIT_CODES.success);
  expect(run.stdout()).toContain('--browser-cookies <browser>');
  expect(run.stdout()).toContain('--cookie-access-confirmed');
  expect(run.stderr()).toBe('');
});
```

Update existing anonymous `toHaveBeenCalledWith` assertions to include:

```ts
cookieAccessConfirmed: false,
```

and no `browserCookieSource` key.

- [ ] **Step 6: Run CLI tests and verify RED**

```bash
pnpm vitest run tests/unit/cli/download.test.ts
```

Expected: options are unknown and forwarding assertions fail.

- [ ] **Step 7: Wire the CLI options and controlled parsing**

Extend `DownloadCommandOptions`:

```ts
export interface DownloadCommandOptions {
  rightsConfirmed?: boolean;
  browserCookies?: string;
  cookieAccessConfirmed?: boolean;
  output?: string;
  json?: boolean;
}
```

Import `parseBrowserCookieSource`, add the new error codes to
`INVALID_INPUT_CODES`, and build the input in the existing `try` block:

```ts
const browserCookieSource = parseBrowserCookieSource(options.browserCookies);
const result = await dependencies.download({
  workspaceRoot: dependencies.workspaceRoot,
  url,
  outputRoot: options.output ?? 'downloads',
  rightsConfirmed: Boolean(options.rightsConfirmed),
  cookieAccessConfirmed: Boolean(options.cookieAccessConfirmed),
  ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
  ...(dependencies.downloadSignal === undefined
    ? {}
    : {signal: dependencies.downloadSignal}),
});
```

Register in `src/cli/videoctl.ts`:

```ts
.option('--browser-cookies <browser>', 'read browser cookies; supported value: chrome')
.option('--cookie-access-confirmed', 'confirm access to the local Chrome cookie store')
```

Import `BrowserCookieSource` into `src/download/downloader.ts` and add temporary
optional transport fields so this intermediate commit typechecks before Task 5
makes confirmation mandatory and enforces behavior:

```ts
browserCookieSource?: BrowserCookieSource;
cookieAccessConfirmed?: boolean;
```

- [ ] **Step 8: Run focused tests and typecheck**

```bash
pnpm vitest run \
  tests/unit/download/browser-cookies.test.ts \
  tests/unit/cli/download.test.ts
pnpm typecheck
```

Expected: focused tests and TypeScript pass with no errors.

- [ ] **Step 9: Commit the explicit CLI confirmation flow**

```bash
git add \
  src/download/browser-cookies.ts \
  src/download/errors.ts \
  src/download/downloader.ts \
  src/cli/commands/download.ts \
  src/cli/videoctl.ts \
  tests/unit/download/browser-cookies.test.ts \
  tests/unit/cli/download.test.ts
git commit -m "feat: require explicit Chrome cookie confirmation"
```

---

### Task 3: Pass Immutable Chrome Cookie Options Through `yt-dlp`

**Files:**
- Modify: `src/download/yt-dlp.ts:1-223`
- Modify: `src/download/downloader.ts:82-127`
- Test: `tests/unit/download/yt-dlp.test.ts:1-578`
- Test: `tests/unit/download/downloader.test.ts:327-460`

- [ ] **Step 1: Write failing metadata and exact-argument tests**

Add availability mapping:

```ts
it('maps optional availability metadata without coercion', () => {
  expect(parseYtDlpInfo({
    id: '7654841525762919726',
    title: 'Public Douyin fixture',
    webpage_url: 'https://www.douyin.com/video/7654841525762919726',
    extractor: 'Douyin',
    _type: 'video',
    availability: 'public',
  })).toMatchObject({availability: 'public'});
});
```

Add a Cookie probe test:

```ts
it('adds exact Chrome Cookie arguments to a probe', async () => {
  const runProcess = vi.fn<DownloadProcessRunner>()
    .mockResolvedValueOnce(processResult(JSON.stringify({
      id: '7654841525762919726',
      title: 'Public Douyin fixture',
      webpage_url: 'https://www.douyin.com/video/7654841525762919726',
      extractor: 'Douyin',
      _type: 'video',
      availability: 'public',
    })));

  await createYtDlpClient({runProcess}).probe(
    'https://www.douyin.com/video/7654841525762919726',
    {browserCookieSource: 'chrome'},
  );

  expect(runProcess).toHaveBeenCalledWith('yt-dlp', [
    '--ignore-config', '--proxy', '', '--no-geo-bypass',
    '--no-playlist', '--playlist-items', '1',
    '--cookies-from-browser', 'chrome',
    '--skip-download', '--dump-single-json',
    'https://www.douyin.com/video/7654841525762919726',
  ]);
});
```

Add a Cookie download test:

```ts
it('adds exact Chrome Cookie arguments to the FD-bound download', async () => {
  const runProcess = vi.fn<DownloadProcessRunner>()
    .mockResolvedValueOnce(processResult());

  await createYtDlpClient({runProcess}).download(
    'https://www.douyin.com/video/7654841525762919726',
    45,
    {browserCookieSource: 'chrome'},
  );

  const wrapperArgs = runProcess.mock.calls[0]?.[1] ?? [];
  expect(wrapperArgs.slice(6, 15)).toEqual([
    '--ignore-config', '--proxy', '', '--no-geo-bypass',
    '--no-playlist', '--playlist-items', '1',
    '--cookies-from-browser', 'chrome',
  ]);
});
```

Keep anonymous exact-array tests unchanged to prove no Cookie arguments appear by default.

- [ ] **Step 2: Run adapter tests and verify RED**

```bash
pnpm vitest run tests/unit/download/yt-dlp.test.ts
```

Expected: no availability field and no operation options.

- [ ] **Step 3: Add operation options and availability mapping**

Import `BrowserCookieSource` and add:

```ts
export interface YtDlpOperationOptions {
  browserCookieSource?: BrowserCookieSource;
  signal?: AbortSignal;
}

const browserCookieArgs = (
  source: BrowserCookieSource | undefined,
): readonly string[] => source === undefined
  ? []
  : ['--cookies-from-browser', source];
```

Extend `YtDlpInfoSchema`:

```ts
availability: z.string().nullable().optional(),
```

Extend `YtDlpProbe`:

```ts
availability?: string | null;
```

Return it with:

```ts
...(info.availability === undefined ? {} : {availability: info.availability}),
```

Change client methods to:

```ts
probe(url: string, options?: YtDlpOperationOptions): Promise<YtDlpProbe>;
download(
  url: string,
  stagingDirectoryFd: number,
  options?: YtDlpOperationOptions,
): Promise<void>;
```

Insert `...browserCookieArgs(options.browserCookieSource)` before
`--skip-download` in probe and before `--no-progress` in download. Pass
`options.signal` through the current cancellation path.

- [ ] **Step 4: Update signal and mutation tests**

Use:

```ts
await client.probe(url, {signal: controller.signal});
await client.download(url, 41, {signal: controller.signal});
```

Add:

```ts
const operationOptions: YtDlpOperationOptions = {browserCookieSource: 'chrome'};
const promise = client.probe(url, operationOptions);
delete operationOptions.browserCookieSource;
await promise;
expect(runProcess.mock.calls[0]?.[1]).toContain('chrome');
```

Snapshot the primitive source before the first `await` so caller mutation cannot change child arguments.

- [ ] **Step 5: Adapt existing downloader signal calls to operation options**

Before probe, create a signal-only option for the anonymous intermediate state:

```ts
const operationOptions = input.signal === undefined
  ? undefined
  : Object.freeze({signal: input.signal});
```

Use it for both calls:

```ts
const probe = await dependencies.client.probe(requested.url, operationOptions);
```

```ts
await dependencies.client.download(requested.url, authority.fd, operationOptions);
```

Update the downloader signal test to expect `{signal: controller.signal}` and
keep anonymous no-signal tests expecting `undefined`/an omitted second option.

- [ ] **Step 6: Run adapter and downloader tests plus typecheck**

```bash
pnpm vitest run \
  tests/unit/download/yt-dlp.test.ts \
  tests/unit/download/downloader.test.ts
pnpm typecheck
```

Expected: both test files and TypeScript pass.

- [ ] **Step 7: Commit adapter support**

```bash
git add \
  src/download/yt-dlp.ts \
  src/download/downloader.ts \
  tests/unit/download/yt-dlp.test.ts \
  tests/unit/download/downloader.test.ts
git commit -m "feat: pass Chrome cookies to yt-dlp"
```

---

### Task 4: Add Strict Version 2 Cookie Audit Receipts

**Files:**
- Modify: `src/download/receipt-schema.ts:115-213`
- Modify: `src/download/archive.ts:903-910,1188-1266`
- Test: `tests/unit/download/receipt-schema.test.ts:1-409`
- Test: `tests/unit/download/archive.test.ts`

- [ ] **Step 1: Write failing receipt union tests**

Add optional fixture shape:

```ts
browserCookies?: {
  used: boolean;
  source: string;
};
```

Add tests:

```ts
it('accepts a strict version 2 Chrome Cookie receipt', () => {
  const receipt = {
    ...makeReceipt(),
    version: 2,
    browserCookies: {used: true, source: 'chrome'},
  };
  expect(DownloadReceiptSchema.parse(receipt)).toEqual(receipt);
});

it('rejects Cookie audit fields on version 1', () => {
  expectInvalid({
    ...makeReceipt(),
    browserCookies: {used: true, source: 'chrome'},
  });
});

it.each([
  undefined,
  {used: false, source: 'chrome'},
  {used: true, source: 'firefox'},
  {used: true, source: 'chrome', profile: 'Default'},
])('rejects invalid version 2 Cookie audit value %j', (browserCookies) => {
  expectInvalid({
    ...makeReceipt(),
    version: 2,
    ...(browserCookies === undefined ? {} : {browserCookies}),
  });
});
```

- [ ] **Step 2: Run receipt tests and verify RED**

```bash
pnpm vitest run tests/unit/download/receipt-schema.test.ts
```

Expected: version 2 is rejected by the literal version 1 schema.

- [ ] **Step 3: Refactor into strict version variants**

Move the shared fields into `DownloadReceiptCommonShape`. Define:

```ts
const DownloadReceiptV1Schema = z.object({
  version: z.literal(1),
  ...DownloadReceiptCommonShape,
}).strict();

const DownloadReceiptV2Schema = z.object({
  version: z.literal(2),
  ...DownloadReceiptCommonShape,
  browserCookies: z.object({
    used: z.literal(true),
    source: z.literal('chrome'),
  }).strict(),
}).strict();

export const DownloadReceiptSchema = z.discriminatedUnion('version', [
  DownloadReceiptV1Schema,
  DownloadReceiptV2Schema,
]).superRefine(validateDownloadReceipt);
```

Move the existing canonical URL, duplicate path, sort order, and file-role counts into `validateDownloadReceipt` without changing messages or issue paths.

- [ ] **Step 4: Run receipt tests and verify GREEN**

```bash
pnpm vitest run tests/unit/download/receipt-schema.test.ts
```

Expected: all version 1 regressions and version 2 strictness tests pass.

- [ ] **Step 5: Write failing archive construction tests**

Add one finalization input with:

```ts
browserCookieSource: 'chrome',
```

Assert:

```ts
expect(result.receipt).toMatchObject({
  version: 2,
  browserCookies: {used: true, source: 'chrome'},
});
```

Keep an anonymous assertion:

```ts
expect(result.receipt.version).toBe(1);
expect('browserCookies' in result.receipt).toBe(false);
```

Add an existing-archive case with a sealed version 2 receipt and assert `prepareArchive` returns it unchanged.

- [ ] **Step 6: Run archive tests and verify RED**

```bash
pnpm vitest run tests/unit/download/archive.test.ts
```

Expected: `FinalizeArchiveInput` has no Cookie source and `buildReceipt` always emits version 1.

- [ ] **Step 7: Build versioned receipts**

Import `BrowserCookieSource` and extend `FinalizeArchiveInput`:

```ts
browserCookieSource?: BrowserCookieSource;
```

Replace the literal receipt with:

```ts
const commonReceipt = {
  status: 'downloaded' as const,
  platform: input.platform,
  videoId: input.videoId,
  title: input.title,
  canonicalUrl: inputCanonical.url,
  downloadedAt: input.downloadedAt.toISOString(),
  purpose: 'learning-analysis' as const,
  rightsConfirmed: true as const,
  transcoded: false as const,
  tools: input.tools,
  files,
};

const receipt = DownloadReceiptSchema.parse(
  input.browserCookieSource === undefined
    ? {version: 1, ...commonReceipt}
    : {
        version: 2,
        ...commonReceipt,
        browserCookies: {used: true, source: input.browserCookieSource},
      },
);
```

- [ ] **Step 8: Run receipt and archive tests**

```bash
pnpm vitest run \
  tests/unit/download/receipt-schema.test.ts \
  tests/unit/download/archive.test.ts
```

Expected: both files pass.

- [ ] **Step 9: Commit receipt support**

```bash
git add \
  src/download/receipt-schema.ts \
  src/download/archive.ts \
  tests/unit/download/receipt-schema.test.ts \
  tests/unit/download/archive.test.ts
git commit -m "feat: record Chrome cookie download receipts"
```

---

### Task 5: Enforce Cookie Safety in Download Orchestration

**Files:**
- Modify: `src/download/downloader.ts:15-181`
- Test: `tests/unit/download/downloader.test.ts:1-836`
- Test: `tests/unit/cli/download.test.ts:214-285`

- [ ] **Step 1: Add failing validation-order tests**

Add `cookieAccessConfirmed: false` to the shared anonymous `INPUT` fixture.
Add:

```ts
it.each([
  [{browserCookieSource: 'chrome' as const, cookieAccessConfirmed: false},
    'DOWNLOAD_COOKIE_OPTIONS_INVALID'],
  [{cookieAccessConfirmed: true}, 'DOWNLOAD_COOKIE_OPTIONS_INVALID'],
] as const)('rejects mismatched Cookie acknowledgement before archive access', async (
  overrides,
  code,
) => {
  const harness = makeHarness();
  const error = await captureRejection(downloadVideo({
    ...INPUT,
    url: 'https://www.douyin.com/video/7654841525762919726',
    ...overrides,
  }, harness.dependencies));

  expect(error).toMatchObject({code});
  expect(harness.calls).toEqual([]);
});

it('rejects Chrome Cookie mode for non-Douyin before archive access', async () => {
  const harness = makeHarness();
  const error = await captureRejection(downloadVideo({
    ...INPUT,
    browserCookieSource: 'chrome',
    cookieAccessConfirmed: true,
  }, harness.dependencies));

  expect(error).toMatchObject({code: 'DOWNLOAD_COOKIE_HOST_UNSUPPORTED'});
  expect(harness.calls).toEqual([]);
});
```

- [ ] **Step 2: Add failing restricted-content tests**

```ts
it.each(['private', 'premium_only', 'subscriber_only', 'needs_auth'])
  ('rejects restricted availability %s before staging', async (availability) => {
    const harness = makeHarness({
      probe: {
        id: '7654841525762919726',
        title: 'Restricted fixture',
        canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
        extractor: 'Douyin',
        availability,
      },
    });

    const error = await captureRejection(downloadVideo({
      ...INPUT,
      url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
    }, harness.dependencies));

    expect(error).toMatchObject({code: 'DOWNLOAD_CONTENT_RESTRICTED'});
    expect(harness.calls).toEqual(['validateRoot', 'checkTools', 'probe']);
    expect(harness.prepare).not.toHaveBeenCalled();
  });
```

Add an explicit no-escalation regression:

```ts
it('does not retry an anonymous probe with browser cookies', async () => {
  const probeFailure = new DownloadError(
    'DOWNLOAD_PROBE_FAILED',
    'Video metadata could not be extracted.',
  );
  const harness = makeHarness({probePromise: Promise.reject(probeFailure)});

  const error = await captureRejection(downloadVideo(INPUT, harness.dependencies));

  expect(error).toBe(probeFailure);
  expect(harness.probe).toHaveBeenCalledTimes(1);
  expect(harness.probe).toHaveBeenCalledWith(INPUT.url, undefined);
  expect(harness.download).not.toHaveBeenCalled();
});
```

This test is the executable guarantee that anonymous failure never triggers an
automatic Cookie retry.

- [ ] **Step 3: Add a failing shared-options success test**

```ts
it('uses one Chrome Cookie mode for probe, download, and receipt finalization', async () => {
  const harness = makeHarness({
    probe: {
      id: '7654841525762919726',
      title: 'Public Douyin fixture',
      canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
      extractor: 'Douyin',
    },
    preparation: {
      ...STAGED,
      platform: 'douyin',
      videoId: '7654841525762919726',
      finalDirectory: '/workspace/downloads/douyin/7654841525762919726',
      relativeDirectory: 'downloads/douyin/7654841525762919726',
    },
  });

  await downloadVideo({
    ...INPUT,
    url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
    browserCookieSource: 'chrome',
    cookieAccessConfirmed: true,
  }, harness.dependencies);

  expect(harness.probe).toHaveBeenCalledWith(
    'https://www.douyin.com/video/7654841525762919726',
    {browserCookieSource: 'chrome'},
  );
  expect(harness.download).toHaveBeenCalledWith(
    'https://www.douyin.com/video/7654841525762919726',
    AUTHORITY_FD,
    {browserCookieSource: 'chrome'},
  );
  expect(harness.finalize).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({browserCookieSource: 'chrome'}),
  );
});
```

The omitted `availability` field in this success case proves that missing
extractor availability metadata remains accepted, while Step 2 covers every
known restricted value.

- [ ] **Step 4: Run downloader tests and verify RED**

```bash
pnpm vitest run tests/unit/download/downloader.test.ts
```

Expected: input, client signature, validation, and restricted-state assertions fail.

- [ ] **Step 5: Implement validation and immutable operation options**

Import `BrowserCookieSource` and `validateBrowserCookieRequest`. Extend `DownloadInput`:

```ts
browserCookieSource?: BrowserCookieSource;
cookieAccessConfirmed: boolean;
```

After `parseDownloadUrl(input.url)` and before archive root validation:

```ts
const browserCookieSource = validateBrowserCookieRequest(
  input.browserCookieSource,
  input.cookieAccessConfirmed,
  requested.platform,
);
const operationOptions = browserCookieSource === undefined && input.signal === undefined
  ? undefined
  : Object.freeze({
      ...(browserCookieSource === undefined ? {} : {browserCookieSource}),
      ...(input.signal === undefined ? {} : {signal: input.signal}),
    });
```

Use:

```ts
const probe = await dependencies.client.probe(requested.url, operationOptions);
```

and:

```ts
await dependencies.client.download(requested.url, authority.fd, operationOptions);
```

Reject restricted states:

```ts
const RESTRICTED_AVAILABILITY = new Set([
  'private',
  'premium_only',
  'subscriber_only',
  'needs_auth',
]);

if (
  probe.availability !== null &&
  probe.availability !== undefined &&
  RESTRICTED_AVAILABILITY.has(probe.availability)
) {
  throw new DownloadError(
    'DOWNLOAD_CONTENT_RESTRICTED',
    'The requested video is not available as authorized public content.',
  );
}
```

Pass this into finalization:

```ts
...(browserCookieSource === undefined ? {} : {browserCookieSource}),
```

Update all anonymous direct inputs with `cookieAccessConfirmed: false`. Update mock client signatures to accept the operation options object.

- [ ] **Step 6: Map controlled errors to validation exit code**

Add to `INVALID_INPUT_CODES`:

```ts
'DOWNLOAD_COOKIE_OPTIONS_INVALID',
'DOWNLOAD_COOKIE_HOST_UNSUPPORTED',
'DOWNLOAD_CONTENT_RESTRICTED',
```

Add the three codes and controlled messages to the CLI table-driven validation test.

- [ ] **Step 7: Run focused orchestration tests and typecheck**

```bash
pnpm vitest run \
  tests/unit/download/browser-cookies.test.ts \
  tests/unit/download/downloader.test.ts \
  tests/unit/download/yt-dlp.test.ts \
  tests/unit/cli/download.test.ts
pnpm typecheck
```

Expected: all focused tests and TypeScript pass.

- [ ] **Step 8: Commit orchestration safety**

```bash
git add \
  src/download/downloader.ts \
  src/cli/commands/download.ts \
  tests/unit/download/downloader.test.ts \
  tests/unit/cli/download.test.ts
git commit -m "feat: enforce Chrome cookie download safety"
```

---

### Task 6: Cover Cookie Mode With Offline System Integration

**Files:**
- Modify: `tests/integration/download/system-download.test.ts:24-298`

- [ ] **Step 1: Extend the fake tool for Cookie mode**

Add:

```ts
const COOKIE_INFO_DOCUMENT = {
  id: '7654841525762919726',
  title: 'Cookie-assisted Douyin fixture',
  webpage_url: 'https://www.douyin.com/video/7654841525762919726',
  extractor: 'Douyin',
  extractor_key: 'Douyin',
  _type: 'video',
  availability: 'public',
};
```

Handle `--version` before Cookie mode validation so the system tool check stays
anonymous, then validate Cookie arguments for probe and download:

```sh
for argument in "$@"; do
  if [ "$argument" = "--version" ]; then
    printf '%s\n' '2026.07.04-test'
    exit 0
  fi
done
case "$0" in
  *cookie*) cookie_mode=1 ;;
  *) cookie_mode=0 ;;
esac
cookie_source=
previous=
for argument in "$@"; do
  if [ "$previous" = "--cookies-from-browser" ]; then
    cookie_source=$argument
  fi
  previous=$argument
done
if [ "$cookie_mode" -eq 1 ]; then
  [ "$cookie_source" = "chrome" ] || exit 67
else
  [ -z "$cookie_source" ] || exit 68
fi
```

Remove the old `--version` branch from the later argument loop. When
`--dump-single-json` is present, print `COOKIE_INFO_DOCUMENT` in Cookie mode and
`INFO_DOCUMENT` otherwise. Write the matching document to `video.info.json`
during download.

- [ ] **Step 2: Add the failing offline Cookie integration test**

```ts
it('archives one normalized Douyin video with explicit Chrome Cookie mode', async () => {
  const socketGuard = installNetworkSocketGuard();
  try {
    const workspaceRoot = await createWorkspace();
    const toolsDirectory = path.join(workspaceRoot, 'tools');
    const ytDlpExecutable = path.join(toolsDirectory, 'yt-dlp-cookie');
    const ffmpegExecutable = path.join(toolsDirectory, 'ffmpeg');
    await mkdir(toolsDirectory);
    await Promise.all([
      writeExecutable(ytDlpExecutable, FAKE_YT_DLP_SCRIPT),
      writeExecutable(ffmpegExecutable, FAKE_FFMPEG_SCRIPT),
    ]);

    const dependencies = createSystemDownloadDependencies({
      ytDlpExecutable,
      ffmpegExecutable,
    });
    dependencies.now = () => new Date(FIXED_DOWNLOAD_TIME);

    const result = await downloadVideo({
      workspaceRoot,
      url: 'https://www.douyin.com/jingxuan?modal_id=7654841525762919726',
      outputRoot: 'downloads',
      rightsConfirmed: true,
      browserCookieSource: 'chrome',
      cookieAccessConfirmed: true,
    }, dependencies);

    expect(result).toMatchObject({
      status: 'downloaded',
      platform: 'douyin',
      videoId: '7654841525762919726',
      receipt: {
        version: 2,
        canonicalUrl: 'https://www.douyin.com/video/7654841525762919726',
        browserCookies: {used: true, source: 'chrome'},
      },
    });
    expect(DownloadReceiptSchema.parse(result.receipt)).toEqual(result.receipt);
    expect(socketGuard.calls).toEqual([]);
  } finally {
    socketGuard.restore();
  }
});
```

- [ ] **Step 3: Run the integration test and verify RED**

```bash
pnpm vitest run tests/integration/download/system-download.test.ts
```

Expected: the fake tool and production argument flow do not yet agree.

- [ ] **Step 4: Verify real archive fields in the fake-tool test**

Assert:

```ts
expect((await readdir(finalDirectory)).sort()).toEqual([...FINAL_FILENAMES]);
const receipt = DownloadReceiptSchema.parse(JSON.parse(
  await readFile(path.join(finalDirectory, 'receipt.json'), 'utf8'),
));
expect(receipt).toMatchObject({
  version: 2,
  browserCookies: {used: true, source: 'chrome'},
});
expect(JSON.stringify(receipt)).not.toMatch(/cookie_value|profile|database/iu);
```

Keep the anonymous integration case and assert its receipt remains version 1 with no `browserCookies` key.

- [ ] **Step 5: Run download integration and cancellation tests**

```bash
pnpm vitest run \
  tests/integration/download/system-download.test.ts \
  tests/integration/download/cli-cancellation.test.ts
```

Expected: both files pass without real network sockets.

- [ ] **Step 6: Commit offline integration coverage**

```bash
git add tests/integration/download/system-download.test.ts
git commit -m "test: cover Chrome cookie system downloads"
```

---

### Task 7: Document the Standard Cookie-Assisted Flow

**Files:**
- Modify: `README.md:1-76`
- Modify: `docs/superpowers/specs/2026-08-14-chrome-cookie-download-design.md:1-358`

- [ ] **Step 1: Document the exact command and boundaries**

Add:

```bash
pnpm video download \
  "https://www.douyin.com/jingxuan?modal_id=7654841525762919726" \
  --rights-confirmed \
  --browser-cookies chrome \
  --cookie-access-confirmed
```

State:

- anonymous mode remains default;
- both Cookie flags are mandatory and non-interactive;
- only exact lowercase `chrome` is accepted;
- Cookie mode is Douyin-only;
- `yt-dlp` reads the local Chrome store directly;
- the application does not export or print Cookie values;
- macOS may request keychain access and denial fails safely;
- private, paid, subscriber-only, DRM, proxy, geo-bypass, playlist, live, editing, and publishing behavior remains excluded.

Change the design status to:

```text
**Status:** Approved and implemented
```

- [ ] **Step 2: Verify help and documentation consistency**

```bash
pnpm video download --help
rg -n "browser-cookies|cookie-access-confirmed|Douyin|anonymous" README.md \
  docs/superpowers/specs/2026-08-14-chrome-cookie-download-design.md
git diff --check
```

Expected: help and both documents use identical option names and scope.

- [ ] **Step 3: Commit documentation**

```bash
git add README.md docs/superpowers/specs/2026-08-14-chrome-cookie-download-design.md
git commit -m "docs: document Chrome cookie downloads"
```

---

### Task 8: Run Full Verification and the Approved Real Download

**Files:**
- Verify: all changed source, tests, docs, and ignored generated archive.

- [ ] **Step 1: Run focused Cookie feature tests**

```bash
pnpm vitest run \
  tests/unit/download/browser-cookies.test.ts \
  tests/unit/download/platforms.test.ts \
  tests/unit/download/yt-dlp.test.ts \
  tests/unit/download/downloader.test.ts \
  tests/unit/download/receipt-schema.test.ts \
  tests/unit/download/archive.test.ts \
  tests/unit/cli/download.test.ts \
  tests/integration/download/system-download.test.ts \
  tests/integration/download/cli-cancellation.test.ts
```

Expected: all focused files pass with zero failures.

- [ ] **Step 2: Run the complete repository gate**

```bash
pnpm typecheck
pnpm test
git diff --check
git status --short --branch
```

Expected: typecheck and full suite pass; diff check emits no output; no Cookie files are present.

- [ ] **Step 3: Run the real explicitly authorized Douyin command**

```bash
pnpm video download \
  "https://www.douyin.com/jingxuan?modal_id=7654841525762919726" \
  --rights-confirmed \
  --browser-cookies chrome \
  --cookie-access-confirmed \
  --output downloads \
  --json | tee /tmp/douyin-download-result.json
```

Expected JSON has `ok: true`, platform `douyin`, video ID
`7654841525762919726`, and relative archive paths. The media extension may vary.
If macOS or Chrome denies access, stop and report the controlled failure; do not
add login automation, profile guessing, Cookie export, proxy, or bypass flags.

- [ ] **Step 4: Verify the real archive**

```bash
archive="downloads/douyin/7654841525762919726"
media_relative=$(pnpm tsx -e '
import {readFile} from "node:fs/promises";
import {DownloadReceiptSchema} from "./src/download/receipt-schema.ts";
const receipt = DownloadReceiptSchema.parse(JSON.parse(
  await readFile("downloads/douyin/7654841525762919726/receipt.json", "utf8"),
));
if (receipt.version !== 2 || receipt.browserCookies.source !== "chrome") {
  throw new Error("unexpected receipt mode");
}
const media = receipt.files.find((file) => file.role === "media");
if (media === undefined) throw new Error("missing media receipt entry");
process.stdout.write(media.path);
')
test -n "$media_relative"
media="$archive/$media_relative"
ffprobe -v error -show_entries format=duration,size -of json "$media"
```

Expected: strict version 2 receipt parses, source is `chrome`, one media path is
found, and ffprobe reports positive duration and size.

- [ ] **Step 5: Move the verified archive to persistent project storage**

```bash
project_root=/Users/liuweitian1/Desktop/AICoding/auto-cut-video
source_archive="$PWD/downloads/douyin/7654841525762919726"
destination_parent="$project_root/downloads/douyin"
destination_archive="$destination_parent/7654841525762919726"
mkdir -p "$destination_parent"
test ! -e "$destination_archive"
mv "$source_archive" "$destination_archive"
printf '%s\n' "$destination_archive"
```

Expected: the absolute destination prints and the source path no longer exists.
Delete the non-sensitive command result after recording success fields:

```bash
unlink /tmp/douyin-download-result.json
```

- [ ] **Step 6: Re-run status and archive checks**

```bash
git status --short --branch
find /Users/liuweitian1/Desktop/AICoding/auto-cut-video/downloads/douyin/7654841525762919726 \
  -maxdepth 1 -type f -print | sort
```

Expected: source worktree remains clean because `downloads/` is ignored; the persistent archive contains `receipt.json`, one media file, `video.info.json`, and any available subtitle or thumbnail sidecars.

- [ ] **Step 7: Review the completed branch before integration**

```bash
git log --oneline main..HEAD
git diff --stat main...HEAD
git diff --check main...HEAD
```

Expected: focused implementation, test, and documentation commits; no diff errors. Invoke `superpowers:finishing-a-development-branch` and present the standard integration options.
