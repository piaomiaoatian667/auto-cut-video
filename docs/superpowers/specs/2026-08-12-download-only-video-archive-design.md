# Download-Only Video Archive Design

**Date:** 2026-08-12
**Status:** Design approved in conversation; awaiting written-spec review
**Target:** Standalone download-and-archive command in `videoctl`

## 1. Goal

Add a download-only workflow for public video URLs so the user can keep local copies for learning and analysis.

The workflow must:

- accept one public video URL per invocation;
- support YouTube, Bilibili, Douyin, TikTok, and Vimeo URLs;
- require an explicit rights confirmation before network access;
- avoid browser cookies, credentials, private content, paywalls, region bypass, and DRM bypass;
- preserve the downloaded media without video or audio re-encoding;
- save available Chinese and English subtitles, automatic subtitles, thumbnail, and cleaned metadata;
- create a deterministic local archive with a provenance and integrity receipt;
- remain independent from the existing ingest, editing, Remotion, review, release, and publishing workflows.

## 2. Confirmed Decisions

The user approved these constraints:

1. The initial platform scope is YouTube, Bilibili, Douyin/TikTok, and Vimeo.
2. The initial release handles public URLs that do not require login.
3. The command does not read browser cookies or stored credentials.
4. The command does not process member-only, paid, private, or DRM-protected content.
5. The downloaded media is retained for learning and analysis only.
6. The command keeps the downloaded audio and video streams without re-encoding.
7. The command saves metadata, subtitles, and thumbnails when the platform exposes them.
8. The result does not enter the current video editing pipeline automatically.

## 3. Scope

### In scope

- One public video URL per command invocation.
- Public single-video pages, including supported short-video page URLs.
- Completed public replays reported as `live_status: was_live`, treated as ordinary non-live videos.
- Initial URL host validation before any network request.
- Post-probe extractor validation before downloading media.
- External `yt-dlp` and FFmpeg executables.
- Metadata probing before download.
- Best available media selection using `yt-dlp` defaults or an equivalent explicit best-video-plus-best-audio selection.
- FFmpeg stream merging when the platform exposes separate audio and video streams.
- No audio or video codec conversion.
- Chinese and English authored subtitles and automatic subtitles when available.
- Original thumbnail format when available.
- Cleaned `yt-dlp` information JSON.
- SHA-256 hashes for every archived file.
- A machine-readable download receipt.
- Human-readable and JSON CLI output.
- Duplicate detection by platform and video identifier.
- Unit and integration tests that do not contact real video sites.

### Out of scope

- Playlists, channels, feeds, profiles, and batch download lists.
- Active live streams, upcoming streams, and post-live streams that are still being finalized.
- Browser cookie import.
- Username, password, QR-code, SMS-code, session-token, or API-token handling.
- Member-only, paid, private, age-gated-login, or account-restricted content.
- CAPTCHA handling or risk-control bypass.
- DRM removal or decryption.
- User-supplied proxy configuration, geographic restriction bypass, or account-region switching.
- Browser network interception or extraction of signed media requests.
- Video editing, clipping, transcoding, normalization, caption conversion, or Remotion rendering.
- Automatic import into `assets/source`, `run-store`, ingest manifests, or project manifests.
- Uploading, publishing, sharing, or cloud synchronization.
- Download resumption across separate command invocations.
- Force-overwriting an existing archive.
- Automatic license detection or a legal determination that a download is permitted.

## 4. Chosen Approach

Add a TypeScript command to the existing `videoctl` CLI and invoke `yt-dlp` as a controlled external process.

On Darwin, media writes are descriptor-authorized rather than pathname-authorized. The archive layer opens the validated staging directory, passes its file descriptor to a fixed JXA wrapper as child FD `3`, and the wrapper calls `fchdir(3)` before launching `/usr/bin/env -- yt-dlp ...` through `NSTask` with argument arrays and the relative output template `video.%(ext)s`.

This approach is preferred over a shell script because it provides:

- typed inputs and outputs;
- deterministic URL and path validation;
- structured, sanitized errors;
- integration with the existing process runner;
- straightforward dependency injection and tests;
- no additional Python runtime contract beyond the installed `yt-dlp` executable.

Embedding the Python `yt_dlp` package is not selected because it would introduce a second application runtime and cross-language packaging for capabilities already available through the CLI.

## 5. User Contract

### Primary command

```bash
pnpm video download "<public-video-url>" --rights-confirmed
```

### Optional output root

```bash
pnpm video download "<public-video-url>" \
  --rights-confirmed \
  --output downloads
```

### Machine-readable output

```bash
pnpm video download "<public-video-url>" \
  --rights-confirmed \
  --json
```

### Options

| Option | Required | Default | Meaning |
| --- | --- | --- | --- |
| `<url>` | Yes | None | One public video page URL. |
| `--rights-confirmed` | Yes | `false` | The operator confirms they are permitted to save the content. |
| `--output <directory>` | No | `downloads` | Workspace-relative archive root. |
| `--json` | No | `false` | Print one structured JSON result instead of the human summary. |

The command must reject missing `--rights-confirmed` before checking tools or accessing the network. The flag records operator intent; it does not prove ownership, permission, fair use, or license status.

## 6. Supported URL Contract

The initial host allowlist is:

| Platform | Accepted host suffixes |
| --- | --- |
| YouTube | `youtube.com`, `youtu.be` |
| Bilibili | `bilibili.com`, `b23.tv` |
| Douyin | `douyin.com` |
| TikTok | `tiktok.com` |
| Vimeo | `vimeo.com` |

Subdomains are allowed only when the parsed hostname is exactly the suffix or ends with `.` followed by the suffix. A hostname such as `youtube.com.example.test` must not pass validation.

Additional validation rules:

- only `https:` URLs are accepted;
- URL credentials are forbidden;
- fragments are ignored;
- the initial URL must not resolve through a generic unsupported host;
- short-link hosts are accepted only when explicitly listed above;
- playlist, channel, feed, profile, and batch probe results are rejected; `--no-playlist` remains a fixed defense-in-depth argument and the command never enumerates collections;
- active, upcoming, and post-live-in-progress metadata is rejected, while `live_status: was_live` is accepted after the replay is public and complete;
- after metadata probing, the returned extractor and normalized canonical URL must map to the same supported platform family as the initial host.

The extractor check prevents a whitelisted redirector URL from silently resolving to an unrelated generic extractor.

## 7. Tool Contract

### Executables

The command depends on:

- `yt-dlp`, overridden by `YT_DLP_PATH` when set;
- `ffmpeg`, overridden by the existing `FFMPEG_PATH` environment variable when set.

Both tools are checked before metadata probing:

```text
yt-dlp --version
ffmpeg -version
```

FFmpeg is required because high-quality platform formats may provide separate audio and video streams. Merging those streams is allowed; codec transcoding is not.

### Configuration isolation

Every metadata-probe and media-download `yt-dlp` invocation must include:

```text
--ignore-config
--proxy ''
--no-geo-bypass
--no-playlist
--max-downloads 1
```

This prevents a user-level configuration file from silently enabling cookies, authentication, playlists, output templates, proxies, post-processing, or other behavior outside this design. `--proxy ''` is passed as two argv elements, `--proxy` and the empty string, to explicitly disable ambient or user-configured proxy inheritance. `--no-geo-bypass` disables `yt-dlp`'s default geographic/X-Forwarded-For bypass behavior; neither flag enables circumvention.

The command must not pass authentication, cookie, password, remux, or recode options. No user-supplied proxy value or positive geo-bypass/bypass option is accepted; the fixed `--proxy ''` and `--no-geo-bypass` disabling flags are mandatory for every probe and download.

## 8. Download Flow

### Step 1: Validate local input

1. Require `--rights-confirmed`.
2. Parse the URL with the platform URL parser.
3. Enforce HTTPS, no embedded credentials, and the supported host allowlist.
4. Validate `--output` as a non-empty workspace-relative path without `..`, NUL bytes, or an absolute prefix.
5. Ensure the output root and existing ancestors are directories and not symbolic links.

No network request occurs before these checks pass.

### Step 2: Check tools

Resolve and run `yt-dlp --version` and `ffmpeg -version`. Record their reported versions for the receipt. Missing or unusable executables fail before metadata probing. The operation's `AbortSignal`, when present, is passed to both checks.

### Step 3: Probe metadata

Run a metadata-only command equivalent to:

```text
yt-dlp
  --ignore-config
  --proxy ''
  --no-geo-bypass
  --no-playlist
  --max-downloads 1
  --skip-download
  --dump-single-json
  <url>
```

Parse only the required fields through a permissive Zod object:

```ts
{
  id: string;
  title: string;
  webpage_url: string;
  extractor: string;
  extractor_key?: string;
  _type?: string;
  is_live?: boolean | null;
  live_status?: string | null;
}
```

Use one shared `parseYtDlpInfo` validator for probe output, staged `video.info.json`, and existing-archive `video.info.json`. It requires a non-empty ID, title, parseable canonical page URL, and extractor; any explicit `_type` must be `video`. It rejects `is_live: true` and `live_status` values `is_live`, `is_upcoming`, or `post_live`, while allowing `was_live` as an ordinary completed replay. Reject non-video collection results, malformed live fields, or extractor/platform mismatch.

### Step 4: Detect duplicates

The final archive directory is derived only from validated program data:

```text
<output>/<platform>/<video-id>/
```

The title is never used as a directory name.

If a final directory exists, verify its exact entry set, parse `receipt.json`, rehash every recorded file, and parse the exact `video.info.json` bytes through the shared metadata validator. Cross-bind the requested platform and ID to the receipt, metadata ID to receipt ID, metadata extractor to receipt platform, and normalized metadata canonical URL to the normalized receipt canonical URL and platform. Only then return `already-present`; otherwise fail with a destination-conflict error without modifying the directory.

### Step 5: Download into staging

Create a unique staging directory under:

```text
<output>/.staging/<random-id>/
```

Immediately after `mkdtemp`, create a unique ownership marker. If preparation fails before stable ownership is recorded, marker-backed cleanup may unlink only that matching marker and remove the now-empty directory non-recursively. It must preserve a non-empty, replaced, or otherwise foreign directory.

Open the identity-validated staging directory as a `StagingDownloadAuthority` and pass its borrowed FD to the download adapter. Do not pass the staging pathname to `yt-dlp`.

Run the fixed Darwin wrapper with arguments equivalent to:

```text
/usr/bin/osascript -l JavaScript -e <fixed-jxa-wrapper> -- yt-dlp
  --ignore-config
  --proxy ''
  --no-geo-bypass
  --no-playlist
  --max-downloads 1
  --no-progress
  --write-info-json
  --clean-info-json
  --write-thumbnail
  --write-subs
  --write-auto-subs
  --sub-langs zh.*,en.*
  --output video.%(ext)s
  <url>
```

The wrapper calls `fchdir(3)` and launches the argument array through `NSTask`; it does not construct a shell command. Pass the operation `AbortSignal` and `extraStdioFds: [stagingDirectoryFd]` to the process runner. Close the staging authority after the download settles and before finalization starts, including cancellation and failure paths.

The final implementation may add quiet or structured-printing flags, but it must not add authentication, positive bypass-enabling, recoding, or arbitrary post-processing flags.

### Step 6: Validate archived files

After `yt-dlp` exits successfully:

1. Inspect through the validated staging authority rather than reopening an untrusted pathname.
2. Reject symbolic links, non-regular files, and leftover `.part`, `.tmp`, or `.ytdl` entries.
3. Bind the metadata role to exactly `video.info.json`.
4. Require exactly one media file matching `video.<alphanumeric-extension>` after excluding controlled subtitle and thumbnail extensions.
5. Allow zero or more subtitle files whose stable basename is `video.<track-or-language>[.<segment>...].<subtitle-extension>`, with alphanumeric, `_`, or `-` segments and extensions `ass`, `json3`, `lrc`, `srt`, `srv1`, `srv2`, `srv3`, `ttml`, or `vtt`.
6. Allow zero or one thumbnail named `video.<image-extension>`, where the extension is `avif`, `jpeg`, `jpg`, `png`, or `webp`.
7. Hash every regular file from its complete bytes. For `video.info.json`, also parse the complete bytes but return only the required semantic metadata fields from the worker so large descriptions or format lists do not cross the capped process-output channel.
8. Validate the projected metadata through `parseYtDlpInfo`; cross-bind its ID, extractor/platform, and normalized canonical URL to the probed finalization input.
9. Write and re-verify `receipt.json` atomically inside staging.

Missing subtitles or thumbnails are not errors. Missing media or metadata is an error.

### Step 7: Publish the local archive

Create `<output>/<platform>/` if needed, then atomically rename the staging directory to `<output>/<platform>/<video-id>/`.

The destination must not exist at rename time. A concurrent destination conflict fails without replacing either archive.

On failure before finalization, clean only the identity-verified owned staging directory or its controlled publication quarantine. Never delete a foreign replacement or modify an existing final archive.

## 9. Archive Layout

```text
downloads/
├── .staging/
└── youtube/
    └── dQw4w9WgXcQ/
        ├── video.webm
        ├── video.info.json
        ├── video.en.vtt
        ├── video.zh-Hans.vtt
        ├── video.webp
        └── receipt.json
```

The exact media, subtitle, and thumbnail extensions are platform-controlled. The application controls only the stable basename and archive directory.

`downloads/` must be added to `.gitignore` because information JSON can contain large metadata and transient platform media URLs. The archive is local operator state, not source code.

## 10. Receipt Contract

Successful receipt schema version 1:

```json
{
  "version": 1,
  "status": "downloaded",
  "platform": "youtube",
  "videoId": "dQw4w9WgXcQ",
  "title": "Example title",
  "canonicalUrl": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "downloadedAt": "2026-08-12T00:00:00.000Z",
  "purpose": "learning-analysis",
  "rightsConfirmed": true,
  "transcoded": false,
  "tools": {
    "ytDlpVersion": "2026.07.04",
    "ffmpegVersion": "ffmpeg version ..."
  },
  "files": [
    {
      "role": "media",
      "path": "video.webm",
      "bytes": 123456,
      "sha256": "sha256:..."
    },
    {
      "role": "metadata",
      "path": "video.info.json",
      "bytes": 23456,
      "sha256": "sha256:..."
    }
  ]
}
```

Receipt rules:

- `platform` is one of `youtube`, `bilibili`, `douyin`, `tiktok`, or `vimeo`;
- `canonicalUrl` comes from validated extractor metadata rather than copying the raw input URL, is normalized through the supported URL parser, and must resolve to `receipt.platform`;
- the raw input URL is not persisted, avoiding retention of tracking parameters;
- `transcoded` is always `false` in version 1;
- `files` contains every regular archived file except `receipt.json` itself;
- paths are archive-relative POSIX paths;
- file roles are `media`, `metadata`, `subtitle`, or `thumbnail`, and each role is bound to the controlled stable basename rules above;
- the metadata entry is exactly `video.info.json`, the single media entry is `video.<extension>`, subtitle and thumbnail entries use only their allowed stable patterns, and there is at most one thumbnail;
- files are sorted by path for deterministic output;
- the receipt is written through a temporary file and same-directory rename.

No failure receipt is written to the final archive. Failures are returned through CLI output and staging is removed.

## 11. CLI Result Contract

### Human success output

```text
Download complete: youtube/dQw4w9WgXcQ
Media: downloads/youtube/dQw4w9WgXcQ/video.webm
Receipt: downloads/youtube/dQw4w9WgXcQ/receipt.json
```

### Human duplicate output

```text
Already downloaded: youtube/dQw4w9WgXcQ
Receipt: downloads/youtube/dQw4w9WgXcQ/receipt.json
```

### JSON success output

```json
{
  "command": "download",
  "ok": true,
  "status": "downloaded",
  "platform": "youtube",
  "videoId": "dQw4w9WgXcQ",
  "directory": "downloads/youtube/dQw4w9WgXcQ",
  "media": "downloads/youtube/dQw4w9WgXcQ/video.webm",
  "receipt": "downloads/youtube/dQw4w9WgXcQ/receipt.json"
}
```

JSON mode prints exactly one JSON document to stdout. Diagnostic details go to stderr only when they are sanitized and do not contain the raw URL, query parameters, signed media URLs, cookies, credentials, or child-process command lines.

## 12. Error Model

| Code | Meaning | Exit code |
| --- | --- | --- |
| `DOWNLOAD_RIGHTS_NOT_CONFIRMED` | Required acknowledgement is missing. | `validationFailed` (`3`) |
| `DOWNLOAD_URL_INVALID` | URL cannot be parsed or violates HTTPS/credential rules. | `validationFailed` (`3`) |
| `DOWNLOAD_HOST_UNSUPPORTED` | Initial URL host is outside the allowlist. | `validationFailed` (`3`) |
| `DOWNLOAD_OUTPUT_INVALID` | Output path is absolute, escapes the workspace, or crosses a symlink. | `validationFailed` (`3`) |
| `DOWNLOAD_TOOL_MISSING` | `yt-dlp` or FFmpeg cannot be executed. | `environmentFailed` (`4`) |
| `DOWNLOAD_PROBE_FAILED` | Metadata could not be extracted. | `operationFailed` (`5`) |
| `DOWNLOAD_EXTRACTOR_MISMATCH` | Probe result does not match the allowed platform family. | `operationFailed` (`5`) |
| `DOWNLOAD_DESTINATION_CONFLICT` | Existing archive is incomplete, invalid, or appeared concurrently. | `operationFailed` (`5`) |
| `DOWNLOAD_PROCESS_FAILED` | Media download or stream merge failed. | `operationFailed` (`5`) |
| `DOWNLOAD_ARCHIVE_INVALID` | Download exited successfully but required files are invalid or missing. | `operationFailed` (`5`) |
| `DOWNLOAD_FINALIZE_FAILED` | Receipt creation or atomic finalization failed. | `operationFailed` (`5`) |

Add `operationFailed: 5` to the shared exit-code contract. Existing exit codes keep their current values.

Unexpected errors produce a deterministic generic failure and never expose the raw thrown error to CLI users.

## 13. Proposed Repository Layout

```text
src/
├── cli/
│   ├── commands/
│   │   └── download.ts
│   ├── download-output.ts
│   ├── exit-codes.ts
│   └── videoctl.ts
├── download/
│   ├── archive.ts
│   ├── downloader.ts
│   ├── errors.ts
│   ├── platforms.ts
│   ├── receipt-schema.ts
│   └── yt-dlp.ts
└── process/
    └── run-process.ts

tests/
├── integration/
│   └── download/
│       ├── cli-cancellation.test.ts
│       └── system-download.test.ts
└── unit/
    ├── cli/
    │   └── download.test.ts
    └── download/
        ├── archive.test.ts
        ├── downloader.test.ts
        ├── platforms.test.ts
        ├── receipt-schema.test.ts
        └── yt-dlp.test.ts
```

### Responsibilities

- `src/cli/commands/download.ts`: command orchestration and exit-code mapping.
- `src/cli/download-output.ts`: sanitized human and JSON rendering.
- `src/download/platforms.ts`: URL parsing, host allowlist, and extractor/platform matching.
- `src/download/yt-dlp.ts`: deterministic tool arguments, shared non-live video metadata validation, signal propagation, and descriptor-bound Darwin download execution.
- `src/download/archive.ts`: output-root validation, staging authorities, full-byte worker inspection, file classification, hashing, metadata/receipt cross-binding, duplicate checks, cleanup ownership, and atomic finalization.
- `src/download/receipt-schema.ts`: strict receipt, canonical-platform, and role-to-stable-filename contracts.
- `src/download/errors.ts`: stable domain error codes without sensitive causes in user-facing messages.
- `src/download/downloader.ts`: typed use-case boundary joining platform, tool, and archive dependencies.
- `src/cli/videoctl.ts`: Commander registration, dependency wiring, and direct-download signal-handler lifetime.

The existing `src/process/run-process.ts` supplies `AbortSignal` handling, borrowed extra stdio FDs, capped stdout/stderr, and detached Darwin process-group termination. Download-specific workers parse and hash full files locally, projecting only bounded semantic results through that capped channel.

## 14. Security and Compliance Boundaries

### Rights acknowledgement

The command requires an explicit acknowledgement but does not determine copyright status. A publicly accessible URL does not itself establish download permission.

### Authentication isolation

The implementation must not:

- import browser cookies;
- read cookie databases;
- accept cookie files;
- pass username, password, netrc, video-password, or OAuth options;
- expose an option that forwards arbitrary `yt-dlp` arguments.

### Bypass isolation

The implementation must not:

- decrypt DRM;
- inspect browser requests for hidden media URLs;
- bypass membership or payment controls;
- solve CAPTCHA or risk-control challenges;
- accept a user-supplied proxy value or positive geographic-bypass option;
- alter headers to impersonate an authenticated browser session.

### Process safety

- Use argument arrays rather than shell command strings.
- Resolve executables explicitly.
- Use `--ignore-config`, `--proxy ''`, and `--no-geo-bypass` for every probe and download `yt-dlp` process.
- Bind downloads to a validated staging FD; the fixed JXA wrapper calls `fchdir(3)` and launches `/usr/bin/env -- yt-dlp ...` through `NSTask` with the relative `video.%(ext)s` output template.
- Pass one per-operation `AbortSignal` through tool checks, probe, and download. Direct CLI `SIGINT`/`SIGTERM` handlers remain installed until detached process-group termination, staging-authority close, and staging cleanup finish; repeated signals are idempotently ignored while cleanup is in progress.
- Suppress progress output. Full metadata bytes are hashed and parsed inside archive workers, which emit only required semantic fields so the existing one-megabyte process-output cap remains sufficient.
- Never print the raw child command or raw URL on failure.

### File safety

- Keep the output root inside the workspace.
- Reject symlinked output ancestors and staged files.
- Derive final directory names only from validated platform and identifier values.
- Never use the remote title as a path component.
- Stage before publishing the final directory.
- Never overwrite or recursively delete an existing final archive.
- Use marker-backed, non-recursive cleanup for failures during staging preparation; never delete a foreign replacement merely because it occupies the former pathname.
- Add `downloads/` to `.gitignore`.

### Metadata privacy

Cleaned information JSON is still local-only data. It may be much larger than the process-output cap and may contain descriptions, uploader data, thumbnails, format details, and transient media URLs. Archive workers read, hash, and parse the full exact bytes but return only ID, title, canonical URL, extractor fields, `_type`, and live-status fields to the parent. The CLI must not print the information JSON or include it in logs.

## 15. Testing Strategy

### Platform validation tests

- accept exact supported hosts and valid subdomains;
- accept `youtu.be`, `b23.tv`, and platform short-link subdomains;
- reject lookalike suffixes such as `youtube.com.example.test`;
- reject HTTP, embedded credentials, localhost, IP literals, and unsupported hosts;
- map supported extractor names to the correct platform;
- reject an extractor mismatch after a supported short-link probe.

### Tool argument tests

- every probe and download includes `--ignore-config`, `--proxy ''`, `--no-geo-bypass`, `--no-playlist`, and `--max-downloads 1`;
- `--proxy` is immediately followed by an empty-string argv value, and `--no-geo-bypass` is present;
- probe includes `--skip-download` and `--dump-single-json`;
- shared metadata validation rejects explicit non-video `_type`, `is_live: true`, and `live_status` values `is_live`, `is_upcoming`, and `post_live`, while accepting `was_live`;
- download includes metadata, thumbnail, subtitle, and automatic-subtitle flags;
- one operation signal reaches tool checks, probe, and descriptor-bound download;
- probe and download do not include cookies, authentication, remux, recode, a non-empty proxy value, or a positive geo-bypass/bypass option;
- the URL remains the final `yt-dlp` argument, the output template is exactly relative `video.%(ext)s`, and the staging FD is passed separately through `extraStdioFds`.

### Archive tests

- create staging only below the validated output root;
- reject symlinked output ancestors;
- classify one `video.<ext>` media file, exact `video.info.json`, and optional sidecars only through the controlled stable basename patterns;
- reject multiple media files, missing metadata, non-regular files, and temporary files;
- hash and parse complete large metadata bytes while projecting only required fields through worker stdout;
- cross-bind finalized and existing metadata ID, extractor/platform, and normalized canonical URL to the input or receipt;
- compute deterministic SHA-256 and file ordering;
- atomically write and parse the receipt;
- atomically rename staging to the final directory;
- close the download authority before finalization and remove only identity-verified owned staging after failure;
- use marker-backed non-recursive cleanup for preparation failures and preserve foreign replacements;
- preserve existing final directories after all failures;
- return `already-present` for a valid existing receipt;
- reject incomplete or invalid existing archives.

### CLI tests

- missing rights confirmation performs no tool call and no network probe;
- invalid URL performs no tool call;
- missing executable maps to exit code `4`;
- platform, network, and archive failures map to exit code `5`;
- human output is concise and sanitized;
- JSON mode prints exactly one valid document;
- direct `SIGINT` and `SIGTERM` cancellation waits for process-group termination, FD close, and staging cleanup, and repeated signals during cleanup do not terminate the CLI early;
- raw URLs, query parameters, and child stderr are absent from user-facing errors.

### Integration tests

Use fake executable scripts or injected process dependencies to simulate:

- successful metadata probing;
- successful media and sidecar creation;
- separate-stream merge success without real network access;
- unavailable subtitles and thumbnails;
- extractor mismatch;
- active/upcoming/post-live rejection and completed `was_live` replay acceptance;
- descriptor-bound relative-output execution;
- process failure with sensitive stderr;
- cancellation with descendant-process termination and staging cleanup;
- concurrent destination creation;
- duplicate archive detection.

Real platform requests are excluded from automated tests because they are nondeterministic, rate-limited, and dependent on external site behavior.

## 16. Acceptance Criteria

The design is implemented successfully when:

1. `pnpm video download <url> --rights-confirmed` downloads one supported public video into `downloads/<platform>/<id>/`.
2. The command refuses to run without rights confirmation.
3. Unsupported, non-HTTPS, credential-bearing, private-login, playlist/channel/feed/batch, active-live, upcoming-live, and post-live-in-progress inputs fail safely; completed public `was_live` replays may succeed as ordinary videos.
4. No browser cookie, credential, user-supplied proxy, DRM, or positive geographic-bypass capability is exposed; the fixed proxy and geo-bypass disabling flags are mandatory for probe and download calls.
5. The media is not video- or audio-transcoded.
6. Available Chinese and English subtitles, automatic subtitles, thumbnail, and cleaned information JSON are retained.
7. A versioned receipt records canonical provenance, tool versions, file sizes, and SHA-256 hashes, with canonical platform and stable filename roles validated.
8. Duplicate downloads return success only after exact receipt/file/metadata verification and cross-binding, without overwriting the archive.
9. Failed or cancelled downloads terminate the detached child process group, close the staging authority, and leave no published partial archive.
10. Existing archives are never overwritten or deleted.
11. The download command does not invoke ingest, Remotion, editing, review, release, or publishing code.
12. Unit, integration, type-check, and full test commands pass.

## 17. Deferred Evolution

Future specifications may independently add:

- explicit playlist and batch manifests;
- configurable subtitle language patterns;
- import of an approved archive into a project asset directory;
- optional technical analysis reports based on FFprobe;
- account-authenticated export of the operator's own content;
- official platform API adapters;
- download resumption and bandwidth limits;
- additional supported sites.

None of these capabilities are implicit in the version 1 command.

## 18. Final Decision Summary

Build a standalone, public-URL, download-only `videoctl` command around isolated `yt-dlp` and FFmpeg processes. Require explicit rights confirmation, enforce a small platform allowlist, prohibit authentication and bypass behavior, retain media without codec conversion, save analysis sidecars, publish archives atomically, and keep the complete workflow separate from automatic editing and publishing.
