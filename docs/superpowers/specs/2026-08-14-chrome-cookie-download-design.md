# Chrome Cookie-Assisted Public Video Download Design

**Date:** 2026-08-14
**Status:** Approved in conversation; awaiting written-spec review
**Branch:** `codex/download-chrome-cookies`

## Summary

Extend the existing authorized single-video archive command with an explicit,
Douyin-only Chrome cookie mode. The mode is never automatic: the caller must
provide both a browser-cookie source and a second cookie-access confirmation in
addition to the existing rights confirmation.

The initial motivating URL is a public Douyin Jingxuan modal link. The command
also normalizes that supported link shape to Douyin's canonical `/video/<id>`
shape before calling `yt-dlp`.

## Goals

- Allow an authorized public Douyin video to be archived when Douyin requires
  fresh browser cookies.
- Require two explicit, non-interactive command-line acknowledgements before
  Chrome cookies can be read.
- Preserve deterministic JSON output and scripting behavior.
- Keep cookie values, browser database paths, account identifiers, child
  command lines, and signed media URLs out of stdout, stderr, exceptions, and
  receipts.
- Preserve the existing single-video, HTTPS, supported-host, no-proxy,
  no-geo-bypass, no-transcoding, and no-editing boundaries.
- Record the fact that Chrome cookies were used without recording any cookie
  material.

## Non-Goals

- Automatic cookie fallback after an anonymous probe fails.
- Interactive prompts, terminal password input, QR-code login, SMS login, or
  account management.
- Cookie files supplied by users.
- Arbitrary browser names, Chrome profile paths, keyring names, or container
  identifiers.
- Reading Safari, Edge, Firefox, Arc, or Chromium cookies in this iteration.
- Cookie-assisted downloads for non-Douyin platforms in this iteration.
- Private, paid, subscriber-only, members-only, or otherwise access-controlled
  video retrieval.
- DRM, region, paywall, authentication, or anti-bot bypass mechanisms.
- Browser traffic interception or extraction of hidden signed media requests.

## Command Interface

Anonymous behavior remains unchanged:

```bash
pnpm video download "<public-video-url>" --rights-confirmed
```

Cookie-assisted Douyin behavior requires all three acknowledgements:

```bash
pnpm video download "<public-douyin-url>" \
  --rights-confirmed \
  --browser-cookies chrome \
  --cookie-access-confirmed
```

New options:

- `--browser-cookies <browser>` selects the local browser cookie source. The
  only accepted value is the exact lowercase literal `chrome`.
- `--cookie-access-confirmed` confirms that the caller authorizes this command
  invocation to let `yt-dlp` read the local Chrome cookie store.

The two new options form a pair:

| Browser option | Confirmation | Result |
| --- | --- | --- |
| absent | absent | Existing anonymous flow. |
| `chrome` | present | Cookie-assisted flow, only for Douyin. |
| `chrome` | absent | Validation failure before tool checks or network access. |
| absent | present | Validation failure before tool checks or network access. |
| any other value | either | Validation failure before tool checks or network access. |

`--rights-confirmed` remains independently mandatory. Cookie authorization is
not a substitute for permission to save the video.

JSON mode remains non-interactive and prints exactly one JSON document. The
command never asks questions on stdin.

## Link Normalization

The supported Douyin Jingxuan shape is:

```text
https://www.douyin.com/jingxuan?modal_id=<video-id>
```

When all of the following are true, normalize it to:

```text
https://www.douyin.com/video/<video-id>
```

Conditions:

- scheme is HTTPS;
- hostname is exactly a supported Douyin hostname;
- pathname is exactly `/jingxuan`;
- there is exactly one `modal_id` value;
- the value satisfies the existing safe video-ID character and length rules;
- no username or password is embedded;
- no unrelated query parameter or fragment is present.

Malformed or ambiguous modal links fail validation rather than being partially
interpreted. Other supported URL shapes retain their current canonicalization
behavior.

The normalized URL is used for platform validation, probing, downloading, and
the receipt canonical URL. The original query-bearing modal URL is never
printed or retained in an error.

## Validation Order

The downloader validates in this order before starting any child process:

1. Confirm `--rights-confirmed`.
2. Parse and normalize the HTTPS video URL.
3. Enforce the supported-host and single-video URL rules.
4. Validate the cookie option pair.
5. Reject cookie mode unless the normalized platform is Douyin.
6. Resolve and validate the workspace-relative output root.
7. Check required tools.
8. Probe metadata.
9. Reject known non-public availability states.
10. Download, verify, seal, and publish the archive atomically.

Cookie option failures therefore cannot trigger Chrome database access, tool
execution, or network requests.

## Cookie Handling

Cookie mode adds these exact `yt-dlp` arguments to both probe and download
invocations:

```text
--cookies-from-browser
chrome
```

The browser value is represented internally as a closed union containing only
`chrome`; user text is never copied directly into child arguments.

The existing mandatory arguments remain in force for both invocations:

```text
--ignore-config
--proxy
<empty string>
--no-geo-bypass
--no-playlist
--max-downloads
1
```

`--ignore-config` prevents user `yt-dlp` configuration from silently adding
authentication, proxy, playlist, output, post-processing, or other behavior.
The empty proxy and disabled geo-bypass controls remain mandatory.

The application does not open, copy, parse, decrypt, export, or persist the
Chrome cookie database itself. It delegates the explicitly authorized read to
the local `yt-dlp` process. No cookie file is created by the application.

Cookie values and Chrome paths must never enter application errors. Tool
failures continue to be replaced by controlled `DownloadError` values without
retaining the original process error as a cause.

## Public-Content Boundary

Cookie mode does not authorize private or paid retrieval. Extend the parsed
`yt-dlp` probe metadata with optional `availability` and reject known restricted
states before download, including:

- `private`;
- `premium_only`;
- `subscriber_only`;
- `needs_auth`.

Missing availability metadata does not by itself fail a public Douyin probe,
because extractors do not consistently populate it. The existing live-stream,
playlist, extractor-family, supported-host, and rights checks remain required.

The command cannot prove that every cookie-visible resource is anonymous. The
dual confirmation, Douyin-only scope, explicit public-content contract, known
restricted-state rejection, and receipt audit field make this boundary visible
and reviewable without pretending it is technically absolute.

## Internal Types and Data Flow

Add a closed source type:

```ts
type BrowserCookieSource = 'chrome';
```

The CLI command options accept raw Commander values, validate them, and pass
only the closed type into `DownloadInput`:

```ts
interface DownloadInput {
  // existing fields
  browserCookieSource?: BrowserCookieSource;
  cookieAccessConfirmed: boolean;
}
```

The downloader passes the optional source into the `YtDlpClient` probe and
download operations. The same source must be used for both operations so the
validated metadata and downloaded media share one access mode.

The system dependency factory snapshots the option before any asynchronous
work. Caller mutation cannot change the source after validation.

## Receipt Versioning

Existing anonymous archives remain receipt version 1 and stay byte-compatible.

Cookie-assisted archives use receipt version 2 and add this strict object:

```json
{
  "browserCookies": {
    "used": true,
    "source": "chrome"
  }
}
```

The receipt schema becomes a discriminated union:

- version 1: existing strict anonymous schema with no `browserCookies` field;
- version 2: the same archive fields plus the strict Chrome cookie audit field.

The verifier accepts both versions. A version 1 receipt containing cookie
fields, a version 2 receipt without the exact audit object, or any receipt that
contains cookie values, paths, profiles, or additional keys is invalid.

The human and JSON CLI success outputs remain unchanged; cookie mode is visible
in the receipt rather than echoed to the terminal.

## Errors and Exit Codes

Add validation errors that map to the existing validation exit code:

| Code | Meaning |
| --- | --- |
| `DOWNLOAD_COOKIE_OPTIONS_INVALID` | The browser source is absent, unsupported, or paired incorrectly with the second confirmation. |
| `DOWNLOAD_COOKIE_HOST_UNSUPPORTED` | Cookie mode was requested for a non-Douyin supported platform. |
| `DOWNLOAD_CONTENT_RESTRICTED` | Probe metadata identifies a private, premium, subscriber-only, or authentication-required video. |

Messages are controlled constants and contain no URL, video title, cookie
value, Chrome profile, database path, or child-process text.

Chrome/keychain access failures during a probe remain
`DOWNLOAD_PROBE_FAILED`; download-stage failures remain
`DOWNLOAD_PROCESS_FAILED`. This avoids parsing unstable third-party stderr.

## Security Properties

- No Cookie access without both explicit command-line options.
- No Cookie access without the independent rights confirmation.
- No Cookie access for unsupported or non-Douyin hosts.
- No automatic retry that silently escalates an anonymous request into a
  browser-session request.
- No arbitrary browser/profile/keyring string reaches `yt-dlp`.
- No raw URL, query parameter, cookie, credential, browser path, signed media
  URL, or child argument list reaches terminal or JSON errors.
- No proxy inheritance, user proxy, positive geo-bypass, playlist, batch,
  remux, recode, or transcoding option is introduced.
- Cookie mode uses the same descriptor-bound staging directory, archive
  verification, atomic publish, duplicate handling, cancellation, and cleanup
  mechanisms as anonymous mode.

## Testing Strategy

Implementation follows test-driven development.

### CLI Tests

- RED tests for each invalid option pairing.
- RED test for an unsupported browser value.
- RED test for Cookie mode on a non-Douyin URL.
- RED test that all three confirmations reach the downloader only when valid.
- JSON failure tests asserting exactly one sanitized document.
- Help-output test documenting both new options.

### URL Tests

- RED test that the provided Jingxuan modal URL normalizes to the canonical
  `/video/<id>` URL.
- Rejection tests for missing, duplicate, unsafe, empty, or extra `modal_id`
  parameters; extra query parameters; fragments; and unsupported hosts.
- Regression tests for existing Douyin and non-Douyin URL shapes.

### Adapter Tests

- RED probe test asserting the exact fixed Cookie arguments and their order.
- RED download test asserting the exact fixed Cookie arguments through the
  Darwin descriptor-bound wrapper.
- Anonymous regression tests proving no Cookie arguments are present by
  default.
- Mutation and sanitization tests proving browser values and process failures
  cannot leak or change after construction.

### Downloader and Receipt Tests

- RED tests for the Cookie pair validation order before tool calls.
- RED tests rejecting known restricted availability values.
- RED tests for version 2 receipt construction and strict parsing.
- Regression tests accepting existing version 1 receipts.
- Duplicate, cancellation, cleanup, and atomic publish tests in Cookie mode.

### Integration Tests

- Extend the fake `yt-dlp` integration harness to require
  `--cookies-from-browser chrome` during both probe and download.
- Confirm the fake archive receives a version 2 receipt with only the audit
  object, never Cookie data.
- Confirm malformed confirmation combinations launch no fake child process.

### Real Validation

After automated verification, run the approved command against:

```text
https://www.douyin.com/jingxuan?modal_id=7654841525762919726
```

Real validation may trigger a local macOS/Chrome keychain permission prompt.
The command must fail safely if the user denies it. On success, verify the
media with `ffprobe`, parse the strict receipt, compare recorded sizes and
SHA-256 values, move the completed archive into the persistent project
`downloads/` directory, and remove the temporary worktree without retaining
Cookie material.

## Documentation Updates

Update `README.md` to:

- keep anonymous mode as the default;
- document the exact dual-confirmation command;
- state that Cookie mode is Chrome-only and Douyin-only;
- explain that `yt-dlp` reads the local browser store directly and the
  application does not export Cookie files;
- warn that the local OS may request keychain permission;
- retain all public-only, authorization, no-proxy, no-geo-bypass, no-DRM,
  single-video, and no-editing boundaries.

The original download-only design remains the definition of anonymous mode.
This document is a narrow, explicit amendment for approved Douyin Chrome
Cookie access.
