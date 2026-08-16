# Managed Multi-Platform Public Video Downloader Design

**Date:** 2026-08-16
**Status:** Approved design; implementation pending
**Branch:** `codex/multi-platform-downloader`

## 1. Summary

Upgrade the existing authorized single-video archive command so that its
declared YouTube, Bilibili, TikTok, and Vimeo support is operational on macOS
Apple Silicon instead of depending on an incomplete ambient `yt-dlp`
installation and unrestricted direct network access.

The application will manage a pinned official `yt-dlp_macos` executable and a
pinned local YouTube PO Token provider, expose an explicit user-supplied proxy,
extend the existing explicit Chrome Cookie flow to every supported platform,
select fixed per-platform browser-impersonation and retry profiles, and preserve
the existing public-content, single-video, atomic-archive, privacy, and
non-transcoding guarantees.

This design supersedes the previous no-proxy and Douyin-only Cookie limits. It
does not supersede the public-content boundary: private, paid, subscriber-only,
password-protected, live, DRM-protected, or otherwise restricted content remains
unsupported.

## 2. Confirmed Decisions

- Target platform is macOS Apple Silicon only.
- Use a project-managed, pinned official `yt-dlp_macos` toolchain by default.
- Preserve `YT_DLP_PATH` as an explicit override after equivalent capability
  validation.
- Continue using the system `ffmpeg` or explicit `FFMPEG_PATH`; do not manage a
  second FFmpeg distribution.
- Allow an explicit proxy supplied on each command invocation.
- Do not inherit, discover, or automatically use system proxy settings.
- Allow the exact Chrome Cookie source for YouTube, Bilibili, Douyin, TikTok,
  and Vimeo when separately confirmed.
- Do not accept browser-profile selectors, Cookie files, exported Cookie data,
  or arbitrary browser names.
- Use the local script mode of the pinned BgUtils YouTube PO Token provider; do
  not start Docker or a persistent HTTP service.
- Continue to support only public, authorized, non-live, non-DRM single videos.
- Keep the existing two-phase probe-then-download architecture so content policy
  checks complete before media bytes are written.
- Do not call third-party download, conversion, or URL-unlocking services.

## 3. Goals

- Make the downloader's runtime capabilities reproducible across supported
  macOS Apple Silicon machines.
- Fix the current Bilibili compatibility gap by moving from `yt-dlp 2026.06.09`
  to a release containing the upstream Bilibili API fix.
- Provide the EJS, browser impersonation, and PO Token capabilities currently
  required by modern YouTube extraction.
- Provide Chrome-compatible HTTP impersonation for Bilibili, TikTok, and Vimeo.
- Allow TikTok and Vimeo to use a caller-supplied proxy when direct access is
  unavailable.
- Reuse a separately authorized Chrome session without exporting or retaining
  Cookie material.
- Classify common network, rate-limit, platform-challenge, and missing-capability
  failures without exposing raw third-party diagnostics.
- Preserve atomic archive publication, strict receipt verification, duplicate
  detection, cancellation, and cleanup.
- Preserve deterministic human and JSON CLI output.

## 4. Non-Goals

- Windows, Linux, Intel macOS, mobile, containers, or server deployment.
- Automatic proxy discovery, PAC parsing, VPN management, or geo-bypass.
- Proxy credentials embedded in URLs or read from environment variables.
- Automatic escalation from anonymous access to Cookie or proxy access.
- Automatic toolchain update checks during ordinary commands.
- Automatic login, QR login, SMS login, account management, or profile guessing.
- Safari, Edge, Firefox, Arc, Chromium, or custom browser Cookie stores.
- Cookie files, Netscape Cookie exports, or direct Cookie values.
- Private, paid, subscriber-only, members-only, password-protected, premium,
  age-restricted-without-authorized-session, live, upcoming, post-live-in-
  progress, or DRM-protected content.
- Manual extraction, storage, or user entry of PO Tokens.
- Browser automation, traffic interception, DevTools media URL capture, or
  arbitrary signed-URL extraction.
- Arbitrary user-supplied `yt-dlp` arguments, extractor arguments, headers,
  impersonation targets, or retry policies.
- Third-party hosted downloader or URL-resolution APIs.
- Media editing, clipping, remuxing, recoding, or transcoding.

## 5. Chosen Approach

### 5.1 Managed official downloader

Add an explicit setup command that installs a pinned official `yt-dlp_macos`
release into a per-user application cache. The normal download command never
downloads executable code and never upgrades the cache automatically.

The initial pinned release is:

| Component | Version | Identity |
| --- | --- | --- |
| `yt-dlp_macos` | `2026.07.04` | `sha256:498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b` |
| `SHA2-256SUMS` | `2026.07.04` | `sha256:eca42575010efc77b8dc1e263c57e19c4bddc42d3e08ba789ccde72c97d48c64` |
| BgUtils plugin ZIP | `1.3.1` | `sha256:b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38` |
| BgUtils source | `1.3.1` | Git commit `7608dd51ee813b48cf9a6d68c6e42cb197ce10e0` |

The pinned `yt-dlp` release contains the upstream Bilibili API compatibility
fix, the standalone EJS component, and `curl_cffi` support used for browser
impersonation.

### 5.2 Platform capability profiles

Represent network, session, impersonation, JavaScript, provider, delay, and
retry behavior as closed application-owned profiles keyed by the already closed
`DownloadPlatform` union. No profile field contains arbitrary caller text.

### 5.3 Explicit network and session inputs

The caller may explicitly provide one proxy URL and may separately authorize
the exact Chrome Cookie source. The same selected network and session state is
used for both metadata probing and media downloading.

### 5.4 Local YouTube provider

Install the pinned BgUtils plugin ZIP and a source checkout at the pinned commit.
Use its on-demand local script provider through Deno. Do not start a persistent
server. The provider is a compatibility component for public YouTube playback;
it does not make restricted content eligible for archival.

## 6. Alternatives Considered

### 6.1 Ambient system toolchain

Continue using the first `yt-dlp` on `PATH` and document Homebrew and Python
extras. This was rejected because the current Homebrew installation exposes no
available impersonation targets and produced a false impression of supported
platform coverage.

### 6.2 Browser automation

Use Playwright or Chrome DevTools to capture signed media requests. This was
rejected because it is fragile, leaks browser-session details into a larger
trusted surface, and conflicts with the existing archive command's closed
process and privacy model.

### 6.3 Remote downloader service

Use a hosted or self-hosted third-party service such as a generic media URL
resolver. This was rejected because it transfers URLs, authorization context,
and operational trust outside the local application and weakens reproducibility
and auditability.

## 7. Managed Toolchain Contract

### 7.1 Cache layout

Use the macOS user cache root rather than the repository or workspace:

```text
~/Library/Caches/auto-cut-video/downloader/
  2026.07.04-macos-arm64/
    manifest.json
    bin/
      yt-dlp
    plugins/
      bgutil-ytdlp-pot-provider.zip
    provider/
      <git checkout at 7608dd51...>
    deno/
      <toolchain-scoped DENO_DIR>
```

The cache location prevents worktree duplication and accidental Git tracking.
The application treats a successfully published version directory as read-only
and never mutates it in place. Installation uses a unique sibling staging
directory and an atomic rename within the same cache parent.

### 7.2 Repository manifest

Add a checked-in closed manifest containing:

```ts
interface DownloaderToolchainManifest {
  schemaVersion: 1;
  platform: 'darwin-arm64';
  ytDlp: {
    version: '2026.07.04';
    url: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.07.04/yt-dlp_macos';
    bytes: 38256544;
    sha256: '498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b';
  };
  potPlugin: {
    version: '1.3.1';
    url: 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/1.3.1/bgutil-ytdlp-pot-provider.zip';
    bytes: 8067;
    sha256: 'b8ceec7f76143da172aaf5ebeec0c2d218e5680c063b931586bca48567069b38';
  };
  potProvider: {
    repository: 'https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git';
    version: '1.3.1';
    commit: '7608dd51ee813b48cf9a6d68c6e42cb197ce10e0';
  };
}
```

Only application code may load this manifest. CLI text cannot replace its URLs,
digests, sizes, versions, platform, repository, or commit.

### 7.3 Setup flow

`videoctl setup-downloader` performs these steps:

1. Require `process.platform === 'darwin'` and `process.arch === 'arm64'`.
2. Resolve and validate the user cache root without following a user-supplied
   path.
3. Acquire a same-user exclusive setup lock.
4. If the published version directory exactly matches the checked-in manifest,
   return `already-present` without network access.
5. If the exact application-owned version path exists but is invalid, rename it
   within the same cache parent to a unique quarantine name after validating
   ownership, location, and non-symlink directory identity. Do not delete it
   until replacement publication succeeds.
6. Create a unique sibling staging directory with mode `0700`.
7. Require `git --version` and Deno 2 or newer before downloading assets.
8. Download release assets over HTTPS with a byte cap and redirect-host
   allowlist.
9. Require exact byte length and SHA-256 for each downloaded release asset.
10. Set the downloader executable mode to `0700`.
11. Create the provider Git repository in staging, fetch the pinned commit, check
   it out detached, and require exact `HEAD` equality with the manifest commit.
12. Run Deno dependency installation from the provider's `server` directory
    using its committed lockfile, `--frozen`, the toolchain-scoped `DENO_DIR`,
    and only the provider-documented `npm:canvas` install-script permission.
13. Run local capability checks before publication.
14. Write a canonical `manifest.json` recording installed file hashes and
    component versions.
15. `fsync` required files and directories, then atomically rename staging to
    the final version directory.
16. After successful replacement publication, delete only the quarantined
    application-owned version that step 5 renamed.
17. On failure or cancellation, remove only the owned staging directory and, if
    replacement has not published, atomically restore the quarantined version.

The application-owned downloader uses these redirect hosts:

- `github.com`;
- `release-assets.githubusercontent.com`;
- `objects.githubusercontent.com`.

The setup command does not accept arbitrary asset URLs or redirect hosts.

### 7.4 Tool resolution precedence

1. If `YT_DLP_PATH` is explicitly set, validate that executable and use it only
   if all required capabilities are present.
2. Otherwise use the exact managed version from the checked-in manifest.
3. Do not fall back to `PATH` when either source is missing or invalid.

`FFMPEG_PATH` keeps its existing precedence. Otherwise use the system `ffmpeg`
resolution already implemented by the application.

### 7.5 Capability validation

Before network access, require:

- `yt-dlp --version` equals the managed manifest version, or an explicitly
  allowed override version at least as new as the manifest version;
- the executable is a regular non-symlink file owned by the current user;
- the managed executable's SHA-256 matches the manifest;
- `deno --version` reports Deno 2 or newer;
- the fixed plugin ZIP exists and matches its digest;
- the provider checkout equals the pinned commit;
- the plugin archive has the expected closed entry set and the pinned provider
  script entry point completes its local help/self-check without video-network
  access;
- `yt-dlp --list-impersonate-targets` includes a supported macOS Chrome target;
- `ffmpeg -version` succeeds.

An override executable cannot bypass provider, Deno, impersonation, or FFmpeg
checks.

## 8. CLI Contract

### 8.1 Setup

```bash
pnpm --silent video setup-downloader
pnpm --silent video setup-downloader --json
```

The command is idempotent. It emits `installed` or `already-present`. It never
prints release redirect URLs, cache staging paths, Git process arguments, or
raw setup stderr.

### 8.2 Doctor

```bash
pnpm --silent video doctor-downloader
pnpm --silent video doctor-downloader --json
```

Without a URL, the doctor performs local capability checks only. It does not
read Chrome Cookies, access a video host, or inspect system proxy settings.

An explicit metadata-only platform check uses the normal authorization inputs:

```bash
pnpm --silent video doctor-downloader \
  --check-url "<AUTHORIZED_PUBLIC_VIDEO_URL>" \
  --rights-confirmed \
  --proxy "http://127.0.0.1:7890" \
  --browser-cookies chrome \
  --cookie-access-confirmed \
  --json
```

The URL check runs the same validation and probe profile as `download`, skips
media download, and reports a controlled capability, network, session, content,
or platform result.

### 8.3 Download

Anonymous, direct behavior remains valid:

```bash
pnpm --silent video download \
  "<AUTHORIZED_PUBLIC_VIDEO_URL>" \
  --rights-confirmed
```

Explicit network and session behavior is:

```bash
pnpm --silent video download \
  "<AUTHORIZED_PUBLIC_VIDEO_URL>" \
  --rights-confirmed \
  --proxy "http://127.0.0.1:7890" \
  --browser-cookies chrome \
  --cookie-access-confirmed
```

All options remain non-interactive.

## 9. Explicit Proxy Contract

Add a closed internal value produced only after parsing `--proxy <url>`.

Accepted schemes:

- `http:`;
- `https:`;
- `socks5:`;
- `socks5h:`.

Validation rules:

- the raw value cannot contain control characters;
- a valid absolute URL is required;
- username and password are forbidden;
- hostname is required;
- port, when present, must parse within `1..65535`;
- query and fragment are forbidden;
- pathname must be empty or `/`;
- the original text is not retained after conversion to the closed value.

When absent, both probe and download continue to receive:

```text
--proxy
<empty string>
```

When present, both receive:

```text
--proxy
<validated exact proxy URL>
```

The application does not read `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, PAC
settings, network service settings, browser proxy state, or VPN configuration.

Errors and receipts never contain the proxy hostname, port, path, or full URL.

## 10. Chrome Cookie Contract

The existing exact browser source remains:

```ts
type BrowserCookieSource = 'chrome';
```

The two Cookie options remain paired and separately authorized:

```text
--browser-cookies chrome
--cookie-access-confirmed
```

The platform restriction is removed. The exact pair is allowed for YouTube,
Bilibili, Douyin, TikTok, and Vimeo.

Both probe and download receive:

```text
--cookies-from-browser
chrome
```

Rules retained from the existing Cookie design:

- no Cookie file option;
- no browser profile syntax;
- no profile guessing in application code;
- no direct browser database access in application code;
- no Cookie export or persistence;
- no account identifier in output or receipts;
- no automatic Cookie fallback;
- Keychain denial becomes a controlled failure without prompting loops.

If the caller provides Cookie authorization, the application uses it on the
first probe and the first download. It does not first make an anonymous request.

## 11. Platform Profiles

### 11.1 Shared fixed arguments

Every probe and download includes:

```text
--ignore-config
--no-geo-bypass
--no-playlist
--playlist-items
1
```

Every invocation also includes exactly one proxy pair, either empty or the
validated explicit value.

The application never adds positive geo-bypass, playlist, batch, remux, recode,
or transcoding options.

### 11.2 Shared retry arguments

For normal transient failures, use fixed `yt-dlp` retry settings equivalent to:

```text
--retries 3
--fragment-retries 3
--extractor-retries 3
--retry-sleep http:exp=1:4
--retry-sleep fragment:exp=1:4
--retry-sleep extractor:exp=1:4
```

These settings handle transport, HTTP 5xx, and fragment failures. They do not
authorize application-level process retries for authentication, access,
platform-challenge, or rate-limit failures.

### 11.3 YouTube

Required capabilities:

- Deno 2 or newer;
- standalone EJS from the managed `yt-dlp_macos` release;
- pinned BgUtils plugin ZIP;
- pinned BgUtils source checkout and script provider.

Fixed additional arguments include:

```text
--plugin-dirs
<managed plugin directory>
--js-runtimes
deno:<validated Deno executable>
--extractor-args
youtubepot-bgutilscript:server_home=<managed provider server directory>
--sleep-requests
1
```

After a successful probe, the application waits five seconds before launching
the separate download process. The delay is cancellation-aware.

Do not set user-selected YouTube clients, PO Tokens, visitor data, player URLs,
headers, or extractor arguments.

Rate-limit, BotGuard, and login-confirmation outcomes are not immediately
retried by launching another process.

### 11.4 Bilibili

Require the managed downloader version containing the upstream API fix and a
validated macOS Chrome impersonation target.

Fixed additional arguments include:

```text
--impersonate
<validated managed Chrome-on-macOS target>
```

Use the caller's explicit proxy and Cookie selection when present. A remaining
HTTP 412 after the fixed extractor, impersonation, and selected session is
classified as a platform challenge and is not retried with a new mode.

### 11.5 Douyin

Preserve the implemented Jingxuan modal normalization, Chrome Cookie behavior,
public-content checks, and canonical receipt URL.

Douyin does not require browser impersonation by default. It still receives an
explicit proxy only when the caller provides one.

### 11.6 TikTok

Require a validated macOS Chrome impersonation target and use it for both probe
and download. Apply the caller's explicit proxy and Chrome Cookie selection
when present.

Do not call mobile private APIs, synthesize device identifiers, reuse hidden
browser media URLs, or add arbitrary TikTok extractor arguments.

### 11.7 Vimeo

Require a validated macOS Chrome impersonation target and use it for both probe
and download. Apply the caller's explicit proxy and Chrome Cookie selection
when present.

Continue to reject password, private, premium, subscriber-only, and DRM states.
Ordinary public Vimeo and public embed URLs remain in scope.

## 12. Browser Impersonation Selection

The setup and doctor commands parse `yt-dlp --list-impersonate-targets` into a
closed capability set. The application selects a target from a checked-in
preference list limited to Chrome on macOS.

The exact target string comes only from validated tool output and is never
accepted from CLI input. If no compatible target is available, Bilibili,
TikTok, and Vimeo fail before network access with a controlled capability
error. YouTube and Douyin retain their profile-specific behavior.

Receipt data records only that Chrome-family impersonation was used, not the
full generated child argument list.

## 13. Download Flow

The complete flow is:

1. Parse CLI options into closed values.
2. Require independent rights confirmation.
3. Parse, normalize, and platform-classify the HTTPS video URL.
4. Validate proxy syntax without network access.
5. Validate Cookie option pairing.
6. Resolve the managed toolchain or explicit validated override.
7. Resolve the closed platform profile and required capabilities.
8. Resolve the workspace-relative output root.
9. Probe metadata using the final proxy, Cookie, impersonation, EJS, provider,
    and retry profile.
10. Reject collection, live, restricted availability, extractor mismatch, or
    unsupported canonical URL metadata.
11. Use the validated platform and video ID to locate and strictly verify an
    existing archive; return `already-present` when it is complete and bound to
    the probe metadata.
12. Wait the profile-specific cancellation-aware probe-to-download delay.
13. Open the descriptor-bound staging authority.
14. Download with the exact same network and session profile.
15. Write only validated safe probe metadata through `authority.writeMetadata`.
16. Close the staging authority.
17. Validate file roles, sizes, hashes, media structure, and canonical binding.
18. Create a receipt v3.
19. Seal files and publish the archive atomically.
20. On any failure or cancellation, clean only owned staging content.

No fallback changes the proxy, Cookie mode, platform, browser family, provider,
or content scope after step 10 begins.

## 14. Error Model

Add controlled codes for the new stable failure classes:

```ts
type NewDownloadErrorCode =
  | 'DOWNLOAD_TOOLCHAIN_MISSING'
  | 'DOWNLOAD_TOOLCHAIN_INVALID'
  | 'DOWNLOAD_PROXY_INVALID'
  | 'DOWNLOAD_IMPERSONATION_UNAVAILABLE'
  | 'DOWNLOAD_PO_TOKEN_UNAVAILABLE'
  | 'DOWNLOAD_NETWORK_UNREACHABLE'
  | 'DOWNLOAD_RATE_LIMITED'
  | 'DOWNLOAD_PLATFORM_CHALLENGE';
```

Classification uses a bounded internal child-stderr buffer and a small
allowlisted matcher set. The raw buffer is discarded after classification and
is never attached as an error cause, printed, serialized, logged, or written to
the archive.

Classification affects only user-facing stable codes and retry suppression. It
does not make authorization, content-eligibility, platform, or archive-safety
decisions.

Unknown probe and download failures retain the existing generic controlled
errors.

Suggested messages remain non-sensitive:

| Code | Message |
| --- | --- |
| `DOWNLOAD_TOOLCHAIN_MISSING` | `The managed downloader is not installed. Run setup-downloader.` |
| `DOWNLOAD_TOOLCHAIN_INVALID` | `The managed downloader failed integrity or capability checks.` |
| `DOWNLOAD_PROXY_INVALID` | `The proxy URL is invalid.` |
| `DOWNLOAD_IMPERSONATION_UNAVAILABLE` | `The required browser compatibility capability is unavailable.` |
| `DOWNLOAD_PO_TOKEN_UNAVAILABLE` | `The YouTube compatibility provider is unavailable.` |
| `DOWNLOAD_NETWORK_UNREACHABLE` | `The video platform could not be reached with the selected network settings.` |
| `DOWNLOAD_RATE_LIMITED` | `The video platform temporarily rate-limited this session.` |
| `DOWNLOAD_PLATFORM_CHALLENGE` | `The video platform rejected the selected public-session request.` |

## 15. Receipt v3

New downloads write `version: 3`. Existing receipt v1 and v2 parsing and strict
archive validation remain supported.

Receipt v3 adds:

```ts
interface DownloadReceiptV3 {
  version: 3;
  // existing v2 fields
  browserCookies: {
    used: boolean;
    source?: 'chrome';
  };
  network: {
    proxyUsed: boolean;
    proxyScheme?: 'http' | 'https' | 'socks5' | 'socks5h';
    browserImpersonation: boolean;
    browserFamily?: 'chrome';
  };
  toolchain: {
    source: 'managed' | 'override';
    ytDlpVersion: string;
    managedAssetSha256?: `sha256:${string}`;
    potProvider?: {
      name: 'bgutil';
      version: '1.3.1';
      mode: 'script';
    };
  };
}
```

The receipt never stores:

- proxy hostname, port, path, or full URL;
- proxy credentials;
- Cookie values or database paths;
- browser profile names;
- PO Token values, visitor data, or player responses;
- impersonation target strings;
- child arguments or environment;
- signed media URLs;
- managed cache staging paths.

When validating an existing v3 archive, cross-check toolchain and network audit
field shapes but do not require the current machine to have the same proxy,
Cookie session, provider cache, or installed version.

## 16. Doctor Result Contract

Human output is concise and secret-free. JSON mode emits exactly one document:

```json
{
  "command": "doctor-downloader",
  "ok": true,
  "toolchain": {
    "source": "managed",
    "ytDlpVersion": "2026.07.04",
    "integrity": "verified",
    "deno": "available",
    "ejs": "available",
    "potProvider": "available",
    "chromeImpersonation": "available",
    "ffmpeg": "available"
  }
}
```

A URL check may add only the normalized platform and controlled result category.
It does not return the original URL, canonical URL, title, account, proxy,
browser path, provider path, or third-party diagnostics.

## 17. Proposed Repository Changes

```text
config/
  downloader-toolchain.json
src/
  cli/
    commands/
      setup-downloader.ts
      doctor-downloader.ts
  download/
    browser-cookies.ts
    downloader.ts
    errors.ts
    network-options.ts
    platform-profiles.ts
    receipt-schema.ts
    toolchain/
      capabilities.ts
      installer.ts
      manifest.ts
      paths.ts
      resolver.ts
      types.ts
    yt-dlp.ts
tests/
  fixtures/
    fake-yt-dlp/
  unit/
    download/
      network-options.test.ts
      platform-profiles.test.ts
      toolchain-capabilities.test.ts
      toolchain-installer.test.ts
      toolchain-manifest.test.ts
  integration/
    download/
      doctor-downloader.test.ts
      managed-toolchain-download.test.ts
      platform-error-classification.test.ts
```

Existing archive, downloader, CLI, cancellation, and system-download tests are
extended rather than replaced.

## 18. Testing Strategy

Implementation follows test-driven development. Every production behavior is
introduced by a failing test that is observed before the implementation change.

### 18.1 Manifest tests

- reject unknown manifest keys and schema versions;
- reject non-Darwin-ARM64 manifests;
- reject non-HTTPS asset URLs;
- reject asset hosts outside the fixed allowlist;
- reject malformed or non-lowercase SHA-256 values;
- require positive byte limits;
- require the pinned provider commit shape.

### 18.2 Installer tests

Use injected local fetch, Git, Deno, filesystem, and hashing dependencies. The
default test suite never downloads GitHub assets.

Cover:

- exact-size and exact-digest publication;
- redirect allowlist enforcement;
- oversized response rejection;
- digest mismatch cleanup;
- cancellation cleanup;
- concurrent setup locking;
- idempotent `already-present` behavior;
- invalid published cache replacement through owned staging only;
- provider commit mismatch;
- Deno frozen-install failure;
- atomic publication;
- no secret or staging-path output.

### 18.3 Capability tests

Use fake executables to cover:

- version parsing and minimum-version comparison;
- managed hash mismatch;
- missing Deno;
- missing EJS;
- missing BgUtils provider;
- missing Chrome macOS impersonation;
- missing FFmpeg;
- valid managed and override toolchains.

### 18.4 Proxy tests

- accept the four exact schemes;
- reject relative URLs, credentials, missing hosts, invalid ports, queries,
  fragments, paths, controls, and unsupported schemes;
- pass the exact validated value to both probe and download;
- pass an explicit empty proxy when absent;
- exclude proxy details from errors and receipts.

### 18.5 Cookie tests

- preserve exact source and confirmation pairing;
- allow the pair for all five platforms;
- reject arbitrary browsers and profile syntax;
- pass Cookie arguments to both probe and download without anonymous fallback;
- exclude Cookie and browser path details from all output.

### 18.6 Platform-profile tests

- YouTube receives plugin, Deno, provider, sleep, shared retry, and selected
  network/session arguments;
- YouTube uses the five-second cancellation-aware inter-process delay;
- Bilibili, TikTok, and Vimeo receive the validated Chrome macOS target;
- Douyin keeps its modal normalization and no default impersonation;
- probe and download profiles are identical except for phase-specific output
  and metadata flags;
- no platform can inject arbitrary extractor arguments.

### 18.7 Error-classification tests

Fake bounded stderr for:

- YouTube rate limits and bot confirmation;
- Bilibili 412 challenge;
- TikTok/Vimeo connect timeout;
- missing impersonation;
- missing provider;
- unrelated unknown errors;
- raw URL, proxy, Cookie, token, browser path, and signed URL redaction.

### 18.8 Receipt tests

- parse and validate v1, v2, and v3;
- write only v3 for new archives;
- validate network and toolchain audit shapes;
- reject stored proxy addresses, credentials, tokens, or browser paths;
- preserve strict existing-archive validation and `already-present` behavior.

### 18.9 Integration tests

Use a fake `yt-dlp` executable that implements version, impersonation-list,
provider-discovery, probe, download, rate-limit, 412, timeout, and cancellation
scenarios. Validate exact child arguments, FD-bound staging, archive output,
cleanup, and JSON result contracts.

### 18.10 Live acceptance

Live validation is opt-in and not part of the deterministic default test suite.
Use one short public authorized video for each platform:

- YouTube through the managed EJS and PO Provider profile;
- Bilibili through the fixed extractor and Chrome impersonation;
- Douyin through the existing explicit Chrome flow;
- TikTok through explicit proxy, impersonation, and optional Cookie;
- Vimeo through explicit proxy, impersonation, and optional Cookie.

For every successful archive, validate receipt v3, SHA-256, file modes, metadata
binding, FFprobe streams, and cleanup. The caller must supply the TikTok/Vimeo
proxy explicitly; the application does not discover one.

## 19. Security and Privacy Properties

- Tool downloads are explicit, pinned, size-capped, digest-verified, and
  atomically published.
- Ordinary downloads never install or update executable code.
- No unvalidated tool override reaches process execution.
- No shell command is constructed from URL, proxy, Cookie, platform, or tool
  input.
- Proxy use is explicit and scoped to the current command.
- Proxy credentials are unsupported.
- System proxy state is ignored.
- Geo-bypass remains disabled.
- Cookie access remains explicit and separately confirmed.
- Browser profiles and Cookie material remain outside application code.
- Browser impersonation is selected only from validated managed capability
  output and a fixed application allowlist.
- PO Tokens are generated and consumed locally and are never accepted from CLI,
  logged, serialized, or archived.
- The PO Provider is on-demand script mode; no persistent local service is
  created.
- Public-content checks complete before media writing begins.
- Known restricted availability states, live states, collection metadata, and
  extractor/platform mismatches remain blocked.
- Raw third-party stderr is bounded, classified, discarded, and never exposed.
- Archive publication remains descriptor-bound, verified, sealed, and atomic.

## 20. Acceptance Criteria

The feature is complete when all of the following are true:

- `setup-downloader` installs or reuses the exact pinned toolchain atomically.
- `doctor-downloader` reports every required local capability without network or
  Cookie access by default.
- Explicit proxy parsing is closed, validated, non-persistent, and applied
  identically to probe and download.
- Explicit Chrome Cookie mode works for every supported platform without
  profiles, files, exports, or automatic fallback.
- YouTube uses managed Deno, EJS, and BgUtils script-provider capabilities.
- Bilibili uses the fixed upstream extractor and managed Chrome impersonation.
- TikTok and Vimeo use managed Chrome impersonation and caller-supplied proxy
  when provided.
- Douyin behavior and modal normalization remain compatible.
- New archives write receipt v3; v1 and v2 archives remain valid.
- Stable errors distinguish missing toolchain, invalid proxy, missing
  impersonation/provider, network failure, rate limit, and platform challenge.
- No sensitive network, browser, token, or child-process data appears in output,
  exceptions, receipts, or tests.
- Targeted unit and integration tests, full `pnpm test`, `pnpm typecheck`, and
  `git diff --check` pass.
- Live validation succeeds for five authorized public samples under explicitly
  supplied network and session settings.

## 21. Deferred Evolution

- Intel macOS, Windows, and Linux managed assets.
- Managed FFmpeg.
- Additional browser Cookie sources.
- Authenticated proxy credentials through a separate secret channel.
- Automatic version update discovery or background maintenance.
- Persistent local PO Token service for high concurrency.
- Multiple simultaneous downloads.
- A first-party proxy/VPN manager.
- Private, paid, live, DRM, or password-protected content.

## 22. Reference Sources

- `https://github.com/yt-dlp/yt-dlp/releases/tag/2026.07.04`
- `https://github.com/yt-dlp/yt-dlp/blob/master/README.md`
- `https://github.com/yt-dlp/yt-dlp/wiki/EJS`
- `https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide`
- `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/tag/1.3.1`
- `https://github.com/Brainicism/bgutil-ytdlp-pot-provider/blob/1.3.1/README.md`
