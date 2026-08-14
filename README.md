# auto-cut-video

Local CLI support for archiving one authorized public video for local learning
and analysis.

> **Legal and authorization warning:** Download only public videos that you own
> or are explicitly authorized to save. You are responsible for complying with
> copyright, platform terms, privacy obligations, and applicable law. The
> `--rights-confirmed` flag records your confirmation; it does not grant rights.

## Supported environment

- macOS on Apple Silicon (`Darwin/arm64`). The current secure archive
  publication implementation is limited to this platform and architecture.
- Node.js `>=22.17.0 <23`.
- pnpm `10.14.0`.
- Local `yt-dlp` and `ffmpeg` executables installed through Homebrew or an
  equivalent trusted package source.

## Install and run

```sh
brew install ffmpeg yt-dlp
pnpm install
pnpm video download "<authorized-public-video-url>" --rights-confirmed
pnpm video download "<authorized-public-video-url>" --rights-confirmed --json
```

The download command accepts one HTTPS video URL. Use
`--output <directory>` to select a workspace-relative archive root; the default
is `downloads`. Use `--json` for a single machine-readable result document.
These commands use anonymous mode, which remains the default.

The downloader ignores ambient `yt-dlp` configuration, forces an empty proxy,
and disables geo-bypass. These controls keep the operation explicit and do not
provide region or access-control circumvention.

## Cookie-assisted Douyin flow

Use this non-interactive flow only for a public Douyin video that you are
authorized to access, for local learning and analysis:

```sh
pnpm video download \
  "https://www.douyin.com/jingxuan?modal_id=7654841525762919726" \
  --rights-confirmed \
  --browser-cookies chrome \
  --cookie-access-confirmed
```

Both Cookie flags are mandatory together. `--browser-cookies` accepts only the
exact lowercase value `chrome`, and Cookie mode is Douyin-only. The command
does not prompt for missing confirmation or automatically retry an anonymous
request with browser access.

`yt-dlp` reads the local Chrome cookie store directly. The application does not
export, store, or print Cookie values; the receipt's `browserCookies` audit
field records only `"used": true` and `"source": "chrome"`. On macOS, the
operating system may request Keychain or local Chrome cookie access. Denial
fails safely, with no fallback or prompting loop.

## Archive layout

Each video is published atomically under:

```text
downloads/<platform>/<video-id>/
```

The final directory contains:

- `receipt.json`: strict archive receipt with the canonical URL, authorization
  confirmation, tool versions, timestamp, file sizes, and SHA-256 hashes.
- `video.<ext>`: the downloaded media file.
- `video.info.json`: cleaned `yt-dlp` metadata.
- `video.<language>.<subtitle-ext>`: subtitle sidecars when available.
- `video.<thumbnail-ext>`: one thumbnail sidecar when available.

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

Outside the explicit Douyin Chrome flow, this download feature does not support
other browser-cookie sources, cookie files, credentials, or login automation.
Private, paid or premium, subscriber-only, authentication-required, and DRM
content remain excluded. User or inherited proxies, geo-bypass, playlists,
channels, active or upcoming live streams, post-live streams still being
processed, editing, and publishing also remain excluded. Archived public
replays may be treated as normal videos when current metadata no longer marks
them active or upcoming. The command does not request transcoding or
re-encoding. Under its default format selection, `yt-dlp` may use FFmpeg to
merge separately downloaded audio and video streams into the archived media
file. The tool is only for authorized public videos used in local learning and
analysis.
