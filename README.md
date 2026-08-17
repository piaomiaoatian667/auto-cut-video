# auto-cut-video

Local CLI support for archiving one authorized public video for local learning
and analysis.

> **Legal and authorization warning:** Download only public videos that you own
> or are explicitly authorized to save. You are responsible for complying with
> copyright, platform terms, privacy obligations, and applicable law. The
> `--rights-confirmed` flag records your confirmation; it does not grant rights.

## Supported environment

- macOS on Apple Silicon (`Darwin/arm64`) only.
- Node.js `>=22.17.0 <23`.
- pnpm `10.14.0`.
- Homebrew `ffmpeg`, Deno, and Git prerequisites.

`setup-downloader` is the only command that installs the pinned downloader and
its pinned compatibility components into the per-user application cache. It
verifies the expected assets and required capabilities, then reports either
`installed` or `already-present`. Ordinary `download` and
`doctor-downloader` commands never install or update executable code.

## Install and run

```sh
brew install ffmpeg deno git
pnpm install
pnpm --silent video setup-downloader --json
pnpm --silent video doctor-downloader --json
pnpm --silent video download \
  "https://www.youtube.com/watch?v=qCYCsTbaPy0" \
  --rights-confirmed \
  --json
```

`doctor-downloader` verifies the installed version, integrity, Deno, EJS,
YouTube PO-provider, Chrome impersonation, and FFmpeg capabilities. It can also
perform one metadata-only eligibility check with `--check-url`,
`--rights-confirmed`, and the same explicit proxy or Chrome options used for a
download. A metadata check does not write media.

The download command accepts one supported HTTPS video URL. Use
`--output <directory>` to select a workspace-relative archive root; the default
is `downloads`. The `pnpm --silent video ... --json` form suppresses pnpm's
wrapper output and emits one machine-readable JSON document.

## Explicit proxy and Chrome access

Proxy and Chrome access are explicit, non-interactive inputs. For example:

```sh
pnpm --silent video download \
  "https://www.douyin.com/jingxuan?modal_id=7654841525762919726" \
  --rights-confirmed \
  --proxy "http://127.0.0.1:7890" \
  --browser-cookies chrome \
  --cookie-access-confirmed \
  --json
```

`--proxy` accepts an explicit credential-free `http`, `https`, `socks5`, or
`socks5h` URL. Proxy usernames and passwords are unsupported. The application
does not read proxy environment variables or discover system, PAC, browser,
VPN, or network-service proxy settings. Without `--proxy`, it explicitly
disables inherited downloader proxy use.

Both Chrome flags are mandatory together. `--browser-cookies` accepts only the
exact lowercase value `chrome`, with `--cookie-access-confirmed`, for YouTube,
Bilibili, Douyin, TikTok, or Vimeo. The selected Chrome session is used on the
first probe and download; there is no anonymous-to-Cookie fallback. Cookie or
Keychain denial produces a controlled failure without profile guessing or a
prompting loop.

There is no browser-profile selector, Cookie file or export input, direct
Cookie-value input, PO-token input, arbitrary downloader or extractor argument,
hosted downloader or URL resolver, or transcoding feature.

## Archive layout

Each video is published atomically under:

```text
downloads/<platform>/<video-id>/
```

The final directory contains:

- `receipt.json`: strict receipt v3 with the canonical URL, authorization
  confirmation, toolchain and tool versions, timestamp, file sizes, SHA-256
  hashes, and coarse network and session audit facts.
- `video.<ext>`: the downloaded media file.
- `video.info.json`: cleaned `yt-dlp` metadata.
- `video.<language>.<subtitle-ext>`: subtitle sidecars when available.
- `video.<thumbnail-ext>`: one thumbnail sidecar when available.

Receipt v3 records only whether a proxy was used and its scheme, whether
Chrome-family impersonation was used, whether confirmed Chrome Cookie access
was used, and the managed or validated override toolchain identity. It does not
record proxy endpoints or credentials, Cookie values, account identifiers,
browser profiles, raw downloader arguments, or local cache paths.

If a valid archive already exists for the resolved platform and video ID, the
command reports `already-present` and does not redownload or overwrite it. An
incomplete or conflicting destination fails instead of being replaced.

## Supported platform families

- YouTube
- Bilibili
- Douyin
- TikTok
- Vimeo

## Explicit exclusions

Only public, explicitly authorized, non-live, non-DRM single videos are in
scope. Private, paid or premium, subscriber-only or members-only,
password-protected, authentication-required, live, upcoming,
post-live-in-progress, DRM-protected, or otherwise unauthorized content is
excluded. Completed public replays may be treated as ordinary videos only when
current metadata no longer marks them active, upcoming, or still processing.

Playlists, channels, login automation, automatic proxy or Cookie escalation,
geo-bypass, browser automation, editing, clipping, publishing, remuxing,
recoding, and re-encoding are also excluded. FFmpeg may merge separate audio
and video streams selected by the fixed downloader profile, but the application
does not request transcoding.

Missing setup, invalid capabilities, invalid input, unavailable networks,
rate limits, platform challenges, Cookie denial, restricted content, and
archive conflicts fail with controlled public messages and stable JSON error
codes. Raw third-party diagnostics and sensitive inputs are not printed or
written to the archive. A failed platform is not retried with a different
proxy, Cookie mode, browser profile, provider, or content scope, and media is
not published to the final archive until validation succeeds.
