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
- Deno `2+`, FFmpeg, and Git available on `PATH`. The Homebrew command below
  is one installation example, not a required package source.

`setup-downloader` is the only command that installs the pinned downloader and
its pinned compatibility components into the per-user application cache. It
verifies the expected assets and required capabilities. On success it reports
either `installed` or `already-present`; otherwise it emits a controlled error.
Ordinary `download` and `doctor-downloader` commands never install or update
executable code.

The pinned BgUtils provider is accepted only when both canonical full-tree
identities match the checked-in manifest: the source tree excludes `.git/**`
and `server/node_modules/**`, while the dependency tree covers every regular
file and symlink under `server/node_modules`. Canonical records bind relative
path, executable bits, file SHA-256 or raw symlink target, and entry counts.
Traversal also requires current-UID ownership, rejects special files and
escaping or absolute symlinks, and never trusts the installed Git object
database. Verification opens the provider root and every child directory with
`O_DIRECTORY | O_NOFOLLOW`, enumerates each opened inode through its
`/dev/fd/<fd>` authority, and compares descriptor and original-path identity
before and after processing. Static or persistent tampering, one-way symlink or
rename substitution, and ordinary concurrent changes detected by those checks
fail closed. This local at-rest integrity model does not claim to defeat a
malicious same-UID process that continuously and precisely swaps entries between
every syscall; such a process can already modify or delete the per-user cache
directly. After Deno installation, setup isolates only
`server/node_modules/.deno/.setup-cache.bin` to a random basename within the
already-open `.deno` directory using no-replace, no-follow `renameatx_np`,
reopens the quarantine with `O_NOFOLLOW`, verifies the original identity, and
only then removes that quarantine with `unlinkat`. An identity mismatch is not
deleted and is restored without replacement when possible. The pinned
dependency identity is 9,715 entries (8,906 regular files and 809 symlinks) with SHA-256
`f2606eacd44bbf1a9c071f52a8bffbfc1298c3b3cd58ffa713efb06ffc15ae36`.
That normalized root was independently reproduced with Deno 2.5.6 and 2.8.3;
Deno remains supported as version 2 or newer, and any future layout mismatch
fails closed instead of being accepted.

The networked pinned-checkout regression is opt-in and remains skipped by the
default suite: set `RUN_SYSTEM_PROVIDER_INTEGRITY_TESTS=1` when running
`tests/integration/download/provider-integrity-system.test.ts`.

Every setup subprocess, including Git checks and checkout, Deno validation and
frozen dependency installation, and staging capability validation, receives a
frozen staging-local environment built from zero. Its `HOME` and `TMPDIR` point
inside staging, its `PATH` contains only absolute host entries plus the fixed
system directories, and its Git, Deno, and npm settings are fixed; credentials,
proxies, runtime injection variables, and all other unlisted host values are
excluded.

## Install and run

The concrete YouTube and Douyin URLs below are command examples only. Replace
them with, or independently confirm, public content that you own or are
explicitly authorized to archive. Neither these examples nor
`--rights-confirmed` grants authorization.

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

`doctor-downloader` verifies the installed version, both provider tree roots,
Deno, EJS, the exact BgUtils provider version `1.3.1`, Chrome impersonation,
and FFmpeg capabilities. It can also
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

Downloader capability checks, probes, and downloads do not copy the host
environment wholesale. Each child receives a frozen allowlist containing the
current UID's canonical home from the OS user record as `HOME` for Chrome and
Keychain access, only absolute deduplicated host `PATH` entries followed by the
deduplicated system directories `/usr/bin`, `/bin`, `/usr/sbin`, and `/sbin`,
an absolute `TMPDIR` when available, `LANG`, the fixed locale keys `LC_ALL`,
`LC_CTYPE`, `LC_COLLATE`,
`LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, and `LC_TIME`, required user and
macOS session identifiers, and fixed Deno, XDG, and npm settings. Proxy
variables, cloud or model credentials, SSH agent sockets, Node/Deno injection
settings, dynamic-loader variables, custom locale-shaped keys, and every other
unlisted value are omitted. Chrome access is still requested only through
`--cookies-from-browser chrome`; no Chrome profile path is added.

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

The archive intentionally retains content-identifying fields. Receipt v3 stores
the canonical URL, title, platform, and video ID, while `video.info.json` stores
their cleaned downloader equivalents. A canonical URL, such as a TikTok URL
containing `@handle`, may identify both content and an account.

Receipt v3 also records whether a proxy was used and its scheme, whether
Chrome-family impersonation was used, whether confirmed Chrome Cookie access
was used, and the managed or validated override toolchain identity. The archive
does not record additional Cookie-derived account fields, proxy endpoints or
credentials, Cookie values, browser profiles or paths, raw downloader
arguments, tokens, or cache or staging paths.

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
geo-bypass, browser automation, editing, clipping, publishing, and
user-specified remux, recode, re-encode, or transcoding options are also
excluded. The fixed downloader profile may use FFmpeg to mux or merge separate
audio and video streams without re-encoding.

Missing setup, invalid capabilities, invalid input, unavailable networks,
rate limits, platform challenges, Cookie denial, restricted content, and
archive conflicts fail with controlled public messages and stable JSON error
codes. Controlled failures do not write raw third-party diagnostics or
credential, session, or network secrets to the archive. Canonical URL, title,
platform, and video ID remain part of a successful archive as described above.
A failed platform is not retried with a different proxy, Cookie mode, browser
profile, provider, or content scope, and media is not published to the final
archive until validation succeeds.
