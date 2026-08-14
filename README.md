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

The downloader ignores ambient `yt-dlp` configuration, forces an empty proxy,
and disables geo-bypass. These controls keep the operation explicit and do not
provide region or access-control circumvention.

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

This download feature does not support cookies or credentials; playlists,
channels, active or upcoming live streams, or post-live streams still being
processed; paid or private content; DRM; region or access-control bypass; or
publishing. Archived public replays may be treated as normal videos when current
metadata no longer marks them active or upcoming. The command does not request
transcoding, re-encoding, or editing. Under its default format selection,
`yt-dlp` may use FFmpeg to merge separately downloaded audio and video streams
into the archived media file. The tool is only for authorized public videos
used in local learning and analysis.
