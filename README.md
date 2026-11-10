# Spool

**A local music and video library for Android, with a YouTube browser attached
to fill it.**

Spool is a WebView pointed at YouTube, a bundled yt-dlp behind it, and a player
that keeps going with the screen off. The library is the product; downloading is
how things get into it. There are no analytics and no account is needed —
everything the app knows lives on the device. Subscriptions add one server and
an optional Spool account (email and password) so that what you pay for follows
you to another phone; paying is a UPI transfer proved with a screenshot.

The design constraint that shapes the browser half: **the app draws exactly one
control over the page.** Every incumbent in this category — Vidmate, Snaptube,
TubeMate — puts a floating bubble over your video. Spool has a single floating
action button on the Browse tab and nothing else.

> **Android only, and sideloaded.** Spool is not on the Play Store and cannot be
> — see [Status](#status) and [Distribution](#distribution).

---

## Contents

- [Get it](#get-it)
- [What it does](#what-it-does)
- [Requirements and getting started](#requirements-and-getting-started)
- [How it works](#how-it-works)
- [Project layout](#project-layout)
- [Building and releasing](#building-and-releasing)
- [The documentation set](#the-documentation-set)
- [Privacy](#privacy)
- [Status](#status)
- [Distribution](#distribution)
- [Legal](#legal)
- [Licence](#licence)

---

## Get it

**[Latest APK](https://github.com/pardeepsinghverma/Spool/releases/latest)** —
Android 7.0 (API 24) or newer. You will need to allow installs from unknown
sources; Android prompts for this the first time.

Releases ship one APK per CPU architecture:

| File | For |
| --- | --- |
| `spool-<version>-arm64-v8a.apk` | **Almost certainly this one** — every phone since ~2016 |
| `spool-<version>-armeabi-v7a.apk` | Older 32-bit devices |
| `spool-<version>-x86_64.apk` | Emulators, ChromeOS |

Splitting by architecture is not cosmetic. yt-dlp arrives as a Python runtime
plus an ffmpeg build shipped *per ABI*, so a universal APK carries four copies of
each — about 253 MB of native libraries. Per-ABI builds are roughly a third of
that. `x86` is excluded as emulator-only; `x86_64` is kept so the emulator still
works. See [`plugins/withAbiSplits.js`](plugins/withAbiSplits.js).

Verify before installing:

```bash
sha256sum -c SHA256SUMS.txt --ignore-missing
```

---

## What it does

Five tabs — `home | search | browse | library | profile`
([`src/shell/TabBar.tsx`](src/shell/TabBar.tsx)). Local first on the left, the
open web in the middle, everything you own on the right. The WebView is mounted
once and **never unmounted**; the four local tabs are laid over it, because
leaving Browse must not cost a page reload.

Detail for every one of these lives in
[`docs/FEATURES.md`](docs/FEATURES.md), whose sections the `§` marks below refer
to. This list is a map, not documentation.

- **Browse** — YouTube in a real WebView, with three-layer ad blocking and SPA
  navigation tracking. `§ 1`
- **Download** — tap the FAB and it commits to whatever one-tap is set to
  (`audio` by default); hold it three seconds for the quality sheet. Any rung
  YouTube offers, or audio extracted to `.m4a`. `§ 2`
- **A library that rebuilds itself** — manual saves are MediaStore records in
  `Music/Spool` or `Movies/Spool`, and those survive an uninstall. `scanSaved` +
  `adoptSaved` read them back, so a reinstalled Spool does not show an empty
  library over a folder full of music. `§ 4`
- **A local player with a queue** — two engines, one seat, so exactly one thing
  is ever playing. Full player, mini bar, sleep timer, session resume. `§ 8`
- **One media notification, arbitrated** — the browser's `<video>` and the local
  player know nothing about each other and Android has room for one card per
  app, so `src/player/nowPlaying.ts` decides. You take the card by playing; a
  source making no sound cannot take one from a source that is. `§ 9`
- **Background playback for the page too** — the WebView keeps playing off
  screen, which takes considerably more machinery than it sounds like. `§ 10`
- **The replay rule** — play something three times (the threshold is yours) and
  Spool keeps it, without asking and without a notification. Those saves stay
  app-private. `§ 3`
- **Playlists, export and backup** — `.m3u8` per playlist plus one JSON backup
  into `Downloads/Spool`, because an arrangement is not a file and nothing else
  would rebuild it. `§ 4`
- **Lyrics** — the one request that is not YouTube's, off until you have read
  what is sent and agreed. `§ 8`
- **A flight recorder** — structured, correlated, redacted and bounded, with the
  previous run kept aside so a crash cannot overwrite its own explanation.
  Profile → Export diagnostics writes it to `Downloads/Spool`. `§ 16`

Things that look missing and are deliberately absent — casting, a storage
capacity meter, Wi-Fi-only downloads, pause/resume for downloads, folders, iOS —
are listed with their reasons in `docs/FEATURES.md § 15`. The rule they share:
the app may not assert what it does not know.

---

## Requirements and getting started

**Node 20+, JDK 17, Android SDK, and a device or emulator on API 24+.**

```bash
npm install
npm run android          # expo run:android
npm run typecheck        # tsc --noEmit
npm test -- "tests/*.test.mjs"
npm run apk              # prebuild + gradlew assembleRelease
```

The test script takes the pattern as an argument. The long form still works, and
the flag is required — without it every file fails to load:

```bash
node --experimental-strip-types --import ./tests/harness/register.mjs --test "tests/*.test.mjs"
```

The suite runs under Node's own test runner with a loader that resolves
Metro-style extensionless imports and swaps React, `expo-modules-core` and
AsyncStorage for stubs. It covers the pure-logic modules; anything with a React
component or a real native call in it is verified on a device instead. See
[`docs/TESTING.md`](docs/TESTING.md).

`android/` is generated by `expo prebuild` and is not committed —
`expo run:android` runs prebuild for you. Anything that has to survive a
regeneration belongs in [`app.json`](app.json) or in a config plugin under
[`plugins/`](plugins/), never in the generated tree.

> **A release-mode shrinking change is not verified until a real download
> completes on a real device from a fresh install.** Engine initialisation is
> lazy, so an emulator pass only ever proves the app launched. See
> [`AGENTS.md`](AGENTS.md) on R8.

---

## How it works

### The engine is bundled, and the strategy is not in it

Spool ships yt-dlp through
[youtubedl-android](https://github.com/JunkFood02/youtubedl-android): a Python
3.8 runtime and an ffmpeg build, extracted on first launch and warmed at boot.
Every job is a subprocess on `Dispatchers.IO`.

**Kotlin executes; TypeScript decides.** The native side runs
`--dump-single-json` and hands back yt-dlp's raw output verbatim; parsing,
dedupe, client selection and format-selector construction all happen in
[`src/core/ytdlp.ts`](src/core/ytdlp.ts). That keeps the `Format` model to
exactly one definition instead of a Kotlin data class and a TypeScript type
drifting apart — and it means the parts most likely to need retuning when
YouTube changes something are the parts you can change without touching native
code. Retune the client lists in TypeScript, not Kotlin.

### An explicit `player_client` is not optional

Without a proof-of-origin token, yt-dlp's default client chain 403s. The only
lever left is which InnerTube client to impersonate, and the order is not a
hunch — it follows yt-dlp's published requirement table:

| Client | GVS token | Player token |
| --- | --- | --- |
| `tv` | none | none |
| `web_embedded` | none | none (embeddable only) |
| `mweb` | required | none |
| `web` | required | none, and SABR-only |
| `android` / `ios` | required | required |
| `android_vr` | required since 2026 | none |

```
OPEN_CHAIN  = ['tv', null, 'web_embedded', 'mweb', 'android_vr']
TOKEN_CHAIN = ['mweb', 'web']
```

`tv` leads because it needs nothing at all — and the DRM-only formats it is
otherwise known for are exactly what the cookie handoff below prevents, which
makes it a good first choice for a browser and a bad one for a standalone
downloader. `null` is yt-dlp's own default, second because it is maintained
weekly by people watching this change. `android_vr` is *last*, having once been
first: per yt-dlp issue #17348 it now requires a token for everything except
format 18, so without one it answers with a single muxed 360p and nothing else.

Two rules that came out of that failure:

- **A client can refuse by answering, not only by throwing.** `judgeManifest`
  judges the manifest as well as the exception — no formats, or no audio-only
  rung — and carries on walking. A degraded answer is **kept as a fallback**
  rather than discarded, so judging too harshly costs a slower walk and never a
  failed download.
- **Listing and downloading must agree on one client.** A format id from one
  client's manifest 403s when fetched as another.

### The chain reorders itself, and remembers

[`src/core/clients.ts`](src/core/clients.ts) keeps a score per
`(mode, client)` in AsyncStorage, moved by `next = 0.75 × score + (won ? 1 : −1)`
and bounded at ±4. Without it every cold start re-paid the whole walk on a client
already proved wrong on that device.

Three properties keep it safe: it **never removes a client**, only reorders, so a
board that has learned something wrong costs time and can never be the reason a
download fails; a difference under 0.5 reorders nothing, so one unlucky request
cannot outvote the table above; and it is **wiped when the engine replaces its
own extractor**, because the scores describe how the *old* extractor got on with
YouTube. A cancel or a dropped connection scores nothing — no client deserves
blame for the user walking into a tunnel.

### PO tokens

Since 2025 essentially every YouTube stream request needs a **PO token**
(proof-of-origin) or it 403s. Tokens are minted by BotGuard inside a real
browser session, bound to that session and to the video, and expire quickly.
This is what kills standalone downloader apps: with no browser session to attest
with, they bolt on external token-provider services and fight a losing battle
against every extraction change YouTube ships.

**Spool is a browser.** It has a real WebView, a real visitor session, real
cookies and a real BotGuard execution environment — not as a workaround but as a
side effect of being a browser in the first place.
[`POTOKEN_SCRIPT`](src/browser/potoken.ts) harvests the `pot` parameter off the
page's own media URLs and out of the player response, plus `visitorData` from
`ytcfg`. [`src/core/tokens.ts`](src/core/tokens.ts) keys tokens **by video id**
with a six-hour TTL, taking the id from the player response's own
`videoDetails.videoId` rather than `location.href`, because YouTube prefetches
the next watch page while the current one is still on screen.

Three things about this that cost real debugging time:

- **The token names its own client.** `po_token` is supplied as
  `CLIENT.CONTEXT+TOKEN`, and a token labelled for a client you are not asking as
  is ignored. `gvs` is the context — the Google Video Server media fetch is the
  request that 403s. This was hardcoded to `web` in Kotlin and was wrong twice:
  our page is `m.youtube.com`, so the token is an `mweb` one, and `web` is
  SABR-only.
- **`visitor_data` alone is worse than nothing.** It pins requests to a session
  you have no attestation for. It is only ever sent alongside a token.
- **yt-dlp *replaces* rather than merges repeated `--extractor-args`** for the
  same extractor, so passing these as separate options silently drops all but the
  last. `applyExtractorArgs` joins them with `;` into one option.

And one rule about not being clever: **a held token must never leave the app
worse off than an empty pocket.** Holding one narrows the walk to the two clients
that could have minted it, so an expired or misbound token would leave two
chances where a tokenless request had five. `attempts()` appends the whole open
chain with the token dropped, so an exhausted token chain ends exactly where it
would have started with nothing harvested.

Measured across four videos on 2026-08-23: the hooks fire, streaming data is
reached, media URLs are seen — and this session's streaming data is
**SABR-only**, carrying no `pot` at all. YouTube is not challenging it, so the
page never mints one, consistent with every download in that pass succeeding on a
tokenless client. The remaining blind spot is SABR itself, where the token
travels as a field inside a protobuf request body: a parsing problem rather than
a vantage one, since a native `shouldInterceptRequest` would see the same bytes
and have the same problem. `docs/FEATURES.md § 2` has the whole story, including
the day the harvester saw nothing at all and the three independent reasons why.

### The cookie handoff

[`CookieJar.write`](modules/ytdlp/android/src/main/java/com/afinitycode/spool/ytdlp/CookieJar.kt)
reads the live WebView session through Android's `CookieManager` — which sees the
`HttpOnly` cookies page JavaScript cannot — and writes a Netscape-format cookie
file for yt-dlp's `--cookies`. This is the second payoff of actually being a
browser: a genuine, user-consented session, which is what makes members-only and
age-restricted material resolvable.

Cookies are collected across the YouTube hosts and `www.google.com` (consent
lives there), de-duplicated by name, and stamped with a far-future expiry so
yt-dlp does not discard them as session cookies. With no cookies in the session
`write()` returns `null` and the caller omits `--cookies` entirely rather than
passing an empty file.

**The file is written for one invocation and deleted in the caller's `finally`.**
What it holds is the login itself, so the question is how long it exists rather
than what is in it — encrypting it would only mean decrypting to a second
plaintext file, because yt-dlp needs a real path to a readable one. It lives
under `noBackupFilesDir`, owner-only, and a sweep at engine init clears anything
a killed process left behind. Per-invocation naming is also what makes the
deletion safe: extraction and a download run concurrently, and under one shared
name the first to finish would delete the file the other was reading.

### What happens to a session, and how to end it

Signing in is optional and nothing asks for it, but once it has happened the
device holds a credential, and the app treats that as its responsibility:

- **`app_webview/` is excluded from Android backup and device transfer**, so a
  live session cannot be uploaded to Google and restored onto another phone as a
  working login. Auto Backup would otherwise include it — only the cache
  directories are excluded by default. The library index is deliberately still
  backed up; carrying that to a new phone is a benefit, carrying a credential is
  not.
- **The sign-in page cannot be screenshotted or screen-recorded.** FLAG_SECURE is
  raised while the page is on a Google sign-in host and dropped everywhere else.
- **Profile → Sign out of YouTube** drops every cookie, the WebView's DOM
  storage, and any cookie jar on disk, then remounts the browser signed out. The
  library and the downloads stay. It does not end the session at Google — only
  Google can do that, from the account's device list — and the dialog says so.

### Selecting and merging formats

Merging is yt-dlp's own, with the bundled ffmpeg (`--merge-output-format mp4`),
not Android's `MediaMuxer` — which cannot handle every codec pair YouTube serves.
Audio is extracted with `-x --audio-format m4a`. Every download gets
`--embed-thumbnail` and `--embed-metadata`, so the file carries its cover and
artist into any other player on the device.

**Every selector ends in a term that cannot name nothing.** Format ids only mean
something inside the manifest that listed them, and `bestaudio` is itself absent
from a degraded manifest — so both branches end at `best`. Without that tail
yt-dlp answers `Requested format is not available`, which is about the manifest
and has nothing to do with the disk or the connection a generic error message
would name.

Related: **`audioOnly` is the intent, never `format.kind`.** `bestAudio` falls
back to a muxed format when the manifest has no audio-only rung, since `-x`
extracts the audio from it — so reading the kind back off the chosen format
answers "video" and saves a file the user did not ask for.

### Names on disk, and why a download resumes

The output used to be named for the job id, which is minted per attempt — so
yt-dlp, whose `--continue` is on by default, never had a partial file to continue
into. A 141 MB save interrupted at 90% began again at 0%, every time, on exactly
the connection that had already proved it would interrupt one. `partialKey` now
names it `{videoId}.{a|vHEIGHT}`: stable across retries of the same video at the
same quality, distinct across everything else. The quality has to be in there,
because a `.part` belongs to one format and resuming a 720p body into a 1080p
file corrupts it. The title must not be, because the filesystem counts **bytes**
while Kotlin and Python count characters, and a styled-Unicode or emoji title
runs four bytes to the character — past 255 before eighty characters, killing the
write with `[Errno 36]` before any media lands. Anything built from a title is
trimmed on a byte budget at a character boundary.

A shared name means "a file with this name exists" is no longer proof that *this*
attempt wrote one, so `finished()` prefers a file modified since the attempt
began.

### Salvage: a decoration may not fail the thing it decorates

Measured on a 31-minute save: the audio downloaded fully, converted to a 73 MB
m4a, had its source deleted — and the job then failed with
`Postprocessing: Conversion failed!` because the *cover art* would not embed.
Complete, correct audio on disk; "didn't finish" on screen. `finished()` is
consulted on the failure path too, and a complete file wins over the engine's
opinion of it.

What makes that safe rather than reckless is the exclusion list, which is longer
than it looks: `.part`, `.part-FragN` and `.ytdl` are a download in progress;
images are `--embed-thumbnail`'s leftovers; `.fNNN.` intermediates are the two
halves of a merge that never completed — without that one, a video whose merge
failed is published as a silent film; and `.temp.` is the merge ffmpeg is *still
writing*, which carries the real container's extension and matches no `.fNNN.`
pattern. A cancel is excluded outright. Verified in the dangerous direction, not
just the happy one.

### Publishing to the gallery

Writing a file to app-private storage — or dropping it into `Movies/` with raw
file I/O — leaves it **invisible to Gallery** on modern Android. Only a
MediaStore record makes it appear.
[`MediaStoreWriter`](modules/ytdlp/android/src/main/java/com/afinitycode/spool/ytdlp/MediaStoreWriter.kt)
inserts with `IS_PENDING=1`, streams the file in, clears the flag, and **deletes
the source**, so a half-copied file is never visible and there is never a second
copy. On failure it deletes the orphaned row. Below API 29 it falls back to the
legacy `DATA` column. Names are stripped of `\/:*?"<>|` and capped at 180 bytes.

**Automatic saves must not publish.** Manual saves belong in the user's gallery;
hundreds of automatic ones do not, so those stay app-private and play from a
`file://` path.

### Self-repair

A sideloaded app gets no store updates, so when YouTube changes something
`updateEngine()` pulls a newer extractor at runtime. It fires automatically once
per session when every client in the chain has been refused, and it is a
first-class row on Profile. This is the app's only path back to working, which is
why the client scoreboard is wiped when it runs.

### The page half

Three scripts are concatenated into one
`injectedJavaScriptBeforeContentLoaded` payload, in order, because all three
have to beat the page's own scripts:

| Script | File | Job |
| --- | --- | --- |
| `ADBLOCK_SCRIPT` | [`src/browser/adblock.ts`](src/browser/adblock.ts) | Strip ad fields out of player responses, hide cosmetic slots, skip anything that gets through |
| `POTOKEN_SCRIPT` | [`src/browser/potoken.ts`](src/browser/potoken.ts) | Harvest the token and `visitorData` the page already has |
| `BACKGROUND_SCRIPT` | [`src/browser/background.ts`](src/browser/background.ts) | Freeze the visibility API, resume unwanted pauses, report media state, poll the command cookie |

`NAV_SCRIPT` ([`src/browser/youtube.ts`](src/browser/youtube.ts)) runs after load
instead, because it only has to report navigation. YouTube is a single-page app:
`pushState`/`replaceState` change the route without a page load, so the WebView's
own `onNavigationStateChange` misses most in-app navigation and the download
button goes stale on the wrong video. The script patches both history methods,
listens for `yt-navigate-finish` and `popstate`, watches `<title>` with a
MutationObserver, and keeps a one-second poll as a safety net.

Ad blocking is three layers, because YouTube's ads are not one thing. The layer
that matters is **player-response stripping**: pre-roll and mid-roll are
described in the InnerTube player response rather than fetched from a blockable
host, so deleting the ad keys before YouTube's own JavaScript reads them means
the player never learns there was an ad. Cosmetic filtering and a skip fallback
sit behind it. Honest limits: server-side stitched ads are part of the stream and
survive all of it, YouTube ships anti-adblock detection periodically, and true
Brave parity would need a native `shouldInterceptRequest` hook this does not
attempt.

**Talking back to a backgrounded page needs a second channel.**
`injectJavaScript` is *queued* while the app is off screen — react-native-webview
posts it as a UIManager view command, flushed on a Choreographer frame an
off-screen window never gets. `YtDlp.setPageCommand` writes a `spool_cmd` cookie
the page polls on its own timer. Both are sent for every command.

---

## Project layout

```
App.tsx                   ErrorBoundary → SafeArea → Theme → Player → BrowserScreen
index.ts                  Expo entry — imports src/core/bootstrap first, and that must stay first
app.json                  Expo config: package id, R8 keep rules, config plugins
plugins/                  withReleaseSigning, withAbiSplits, withPageSizeCompat
.github/workflows/        release.yml — tag → prebuild → signed per-ABI APKs

src/
  browser/                The WebView half: the shell, the injected scripts, background playback
  core/                   Logic with no React in it: the engine bridge, storage, metadata, log
  player/                 The local playback half: one queue, two engines, one card
  screens/                Home, Search, Library, Profile, FirstRun
  sheets/                 Quality, Choice, Name, PreRelease
  shell/TabBar.tsx        The five tabs
  ui/                     Design tokens, theme context, error boundary

modules/ytdlp/            The Expo native module
  index.ts                The typed JS surface — read this first, it is the contract
  android/…/YtDlpModule.kt      Bridge: extract, download, publish, scan, artwork, cards
  android/…/PlaybackService.kt  The one media notification + MediaSession + wake lock
  android/…/DownloadService.kt  Foreground service for downloads
  android/…/MediaStoreWriter.kt Publishes finished files into Music/Spool or Movies/Spool
  android/…/CookieJar.kt        WebView session → Netscape cookie file
  android/…/TrialGuard.kt       Enforces the pre-release limits — the only copy that decides

tests/                    Node test suite over the pure-logic modules
docs/                     The knowledge books
```

[`docs/README.md`](docs/README.md) has the full tree with a line on every file,
and [`docs/CODEMAP.md`](docs/CODEMAP.md) is the file-by-file guide. Note that
`src/browser/BrowserScreen.tsx` genuinely is the orchestrator: it owns the
WebView, the tab state, the library records, the job list and all the save paths,
and its size is a direct consequence of the WebView never being unmounted —
everything that has to survive a tab change has to live above the tabs.

---

## Building and releasing

```bash
npx expo prebuild --platform android    # regenerate android/ explicitly
npm run apk                             # prebuild + gradlew assembleRelease
```

Output lands in `android/app/build/outputs/apk/release/`. Without signing
properties configured this produces a debug-signed APK, which is fine for testing
and unfit for distribution.

**Targets:** `minSdk 24`, `compileSdk`/`targetSdk 36`, Java and Kotlin JVM target
17. `useLegacyPackaging` is on, because the bundled Python payload is a zip that
must stay uncompressed to be extractable at runtime — turning it off produces an
app that builds fine and fails at the first download.

**Config plugins.** `android/` is generated and gitignored, so a hand-edit to its
Gradle lasts exactly until the next prebuild. Three plugins run *as part of*
prebuild and therefore survive regeneration, including on a clean CI checkout:
[`withReleaseSigning`](plugins/withReleaseSigning.js) injects the release signing
config, [`withAbiSplits`](plugins/withAbiSplits.js) splits the build per ABI, and
[`withPageSizeCompat`](plugins/withPageSizeCompat.js) opts into Android 16
page-size compatibility.

**R8 keep rules live in [`app.json`](app.json)**, not in the generated
`proguard-rules.pro`, and all five are load-bearing. `YtDlpModule` is resolved by
name from `expo-module.config.json`, so nothing in the bytecode references it and
R8 deletes it. Both services are named only in the manifest. `com.yausername.**`
reaches Python through JNI and reflection. And `org.apache.commons.compress.**`
is the quiet one — R8 sees no constructor call for the zip extra-field types its
static initialiser creates reflectively, makes them abstract, and the Python
payload then never unpacks *for the life of the install*. That one shipped.
`TrialGuard` is deliberately **not** kept: it is meant to be obfuscated.
Full detail in [`docs/ARCHITECTURE.md § 7`](docs/ARCHITECTURE.md).

**Trial properties.** Pre-release limits are stamped into `BuildConfig` at build
time rather than stored on the device, so there is nothing to clear or reinstall
past. Extending a trial is a rebuild, not a server call.

| Property | Default | Effect |
| --- | --- | --- |
| `SPOOL_TRIAL` | `true` | Whether this build is a pre-release |
| `SPOOL_TRIAL_DAYS` | `7` | Stamped as `BUILT_AT + days` into `TRIAL_EXPIRES_AT` |
| `SPOOL_TRIAL_SAVES` | `20` | `TRIAL_MAX_DOWNLOADS` |
| `SPOOL_TRIAL_SECONDS` | `180` | Per-video length cap |
| `SPOOL_SIGNING_SHA256` | a pinned hash | Release-variant only; empty on debug so local builds do not refuse to run |

```bash
cd android && ./gradlew assembleRelease -PSPOOL_TRIAL=false
```

**Signing.** [`withReleaseSigning`](plugins/withReleaseSigning.js) never contains
credentials. It injects Gradle that reads four properties — `SPOOL_STORE_FILE`,
`SPOOL_STORE_PASSWORD`, `SPOOL_KEY_ALIAS`, `SPOOL_KEY_PASSWORD` — supplied via
`-P` flags, `~/.gradle/gradle.properties`, or `ORG_GRADLE_PROJECT_*` environment
variables. When `SPOOL_STORE_FILE` is absent, release builds fall back to debug
signing, so a contributor without a keystore can still build.

> **Keep the keystore backed up.** Android identifies an app by its signing key.
> Lose it and you cannot ship an update — every user has to uninstall and
> reinstall, which takes their library index and playlists with it.

**Cutting a release** ([`.github/workflows/release.yml`](.github/workflows/release.yml)):

```bash
git tag v1.0.1
git push origin v1.0.1
```

A `preflight` job checks whether `KEYSTORE_BASE64` exists — the `secrets` context
is unavailable in a job-level `if`, hence the separate job — so a tag pushed
before the secrets are configured skips cleanly instead of failing red. The build
job then prebuilds, decodes the keystore, runs `assembleRelease`, and **verifies
with `apksigner` that no APK is debug-signed** before renaming them
`spool-<version>-<abi>.apk`, writing `SHA256SUMS.txt`, and attaching everything
to the GitHub release. Repository secrets: `KEYSTORE_BASE64` (base64 of the
`.jks`), `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.

---

## The documentation set

`docs/` is the record of how this app actually works, and it is kept current in
the same change as the code. A stale book is worse than none, because it will be
trusted.

| Document | What it answers | Read it before |
| --- | --- | --- |
| [`AGENTS.md`](AGENTS.md) | The traps that have already cost a day each | Every session — it is the one file always loaded |
| [`docs/README.md`](docs/README.md) | The map of the set, plus how to run, test and build | Anything, first time |
| [`docs/ONBOARDING.md`](docs/ONBOARDING.md) | The job rather than the app: which book to open, how the common changes are done, what counts as proof | Your first change, and once per session after |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | What the pieces are, what talks to what, where state lives, how it builds | Anything structural, the native module, storage, the build, R8, CI |
| [`docs/CODEMAP.md`](docs/CODEMAP.md) | Every file, what is in it, and what it is for | Finding where something lives |
| [`docs/FEATURES.md`](docs/FEATURES.md) | Every user-visible capability and the rules it runs under | Adding, changing or removing a capability |
| [`docs/FLOWS.md`](docs/FLOWS.md) | The end-to-end sequences, with the orderings that are load-bearing | Anything with a lifecycle, or "why did it do that" |
| [`docs/UI.md`](docs/UI.md) | The v2 design system: tokens, type, motion, the five tabs, the player, copy rules | **Every** UI change, including cosmetic ones |
| [`docs/NATIVE.md`](docs/NATIVE.md) | The Kotlin side: the module contract, the two services, the Expo DSL constraints | Touching anything under `modules/ytdlp/android/` |
| [`docs/DATA.md`](docs/DATA.md) | Every store, its shape, its cap and its lifetime | Persisting anything, or changing what is persisted |
| [`docs/TESTING.md`](docs/TESTING.md) | The harness, the stubs, what is covered and what is not | Writing a test, or trusting one |
| [`docs/RELIABILITY.md`](docs/RELIABILITY.md) | A full on-device pass and the checklist it produced | Verifying a release, or claiming something works |

[`docs/MARKET.md`](docs/MARKET.md) is not a knowledge book — it is dated outside
research kept as planning input. It describes the market, never the app.

---

## Privacy

No analytics, no crash reporting, and no account unless you want to pay.
Everything the app knows lives on the device and dies with an uninstall, except
the files themselves.

Signed out, the app sends the licence server nothing. **Signed in**, it sends
the account's session, a SHA-256 of `ANDROID_ID` and a device name so a licence
can be bound to each install, and — for the one-device-at-a-time play lock —
*when* the local player starts and stops (never what). **Paying** sends a
screenshot of the UPI receipt and the text read from it on the phone, because a
payment that may need a person to check it has to be checkable. The server holds
no library, no play history and no titles.

**The complete list of outbound requests:**

1. **YouTube** — through the page, and through yt-dlp using the browser's own
   session.
2. **`i.ytimg.com`** — cover art, when a file has none of its own.
3. **`lrclib.net`** — lyrics, and only ever from an explicit tap.
4. **The licence server** — only on a build configured with one, and only once
   the user has signed in to a Spool account: the session, a device hash and
   label, play start/stop for the play lock, and a payment screenshot when
   paying.
5. **`wa.me`** — only from a tap, to message support (a payment under review, a
   forgotten password).

The third is gated. [`src/core/lyrics.ts`](src/core/lyrics.ts) will not open a
socket until `hasLyricsConsent` is true (`dl.lyricsOptIn`), and the app asks in
words first: which host, what is sent, and that this is the only request Spool
makes that is not YouTube's. It never fires on a track starting — a privacy claim
that holds except when music is playing is not a privacy claim — and what goes is
the title, artist and duration, with no cookie and no identifier.

Two more things worth stating plainly:

- **Your YouTube session cookies are written to a file** in the app's cache
  directory so yt-dlp can use them. They stay in app-private storage and are sent
  nowhere except to YouTube as part of a normal request.
- **If you sign in to YouTube in the browser**, downloads act as your account.
  That is what makes members-only and age-restricted content resolvable, and it
  is also why it is worth knowing.

[`src/core/plays.ts`](src/core/plays.ts) is the only module that records
behaviour rather than results. It stores three numbers per video with no
timeline, and it must never make a network call. The flight recorder
(`docs/FEATURES.md § 16`) never records a credential — `redact` matches on the
*key*, because a token has no shape worth matching and that file leaves the
device when the user exports it.

---

## Status

This is a **sideloaded pre-release APK with a trial guard** — seven days, twenty
saves, a three-minute per-video cap by default, all stamped into `BuildConfig` at
build time. The guard is enforced in Kotlin and only *described* in TypeScript:
R8 obfuscates the native side and a signature pin refuses a repackaged APK,
neither of which touches the JavaScript bundle. None of it makes the build
uncrackable and the code says so; the goal is to move the cost from "clear app
data" to "decompile, patch, resign, defeat the pin".

**Android only.** The `DownloadEngine`, `Muxer` and `TokenProvider` interfaces in
[`src/core/engine.ts`](src/core/engine.ts) exist as porting seams so an iOS
backing implementation stays possible, but there is no second implementation and
none is being built.

Known gaps in the wiring — real, current, and written down so nobody rediscovers
them by debugging — are listed in
[`docs/ARCHITECTURE.md § 9`](docs/ARCHITECTURE.md). The download notification is
where most of them are: it shows an indeterminate "Preparing…" for the whole job
and its CANCEL action stops the service without destroying the yt-dlp process.
In-app progress is correct and cancelling from inside the app works.

Also unsupported: live streams, and playlists as a unit — `--no-playlist` is
passed everywhere, one video at a time.

---

## Distribution

YouTube's developer policies prohibit letting users download videos for offline
play outside of YouTube Premium, and Google Play enforces it. Apps in this
category get removed — sometimes at review, often after publishing. Apple's App
Store is stricter still.

So Spool is distributed by sideload:
[APK from GitHub Releases](https://github.com/pardeepsinghverma/Spool/releases/latest),
or via [Obtainium](https://github.com/ImranR98/Obtainium), which watches this
repo and auto-updates from it. This is well-trodden ground — Seal, YTDLnis and
NewPipe all live here.

Because there is no store doing it for you, **releases are the update channel**,
and the in-app engine updater is what keeps a given build working between them.

---

## Legal

**Downloading from YouTube violates YouTube's Terms of Service.** Spool says so
on first run, and it is worth repeating here.

Beyond ToS, the picture is genuinely jurisdiction-dependent. Several EU countries
have private-copying exceptions. US law is unsettled — GitHub reinstated
youtube-dl in 2020 after the RIAA takedown, backed by the EFF's argument that it
circumvents no technical protection measure — while German courts have gone the
other way on stream-rippers. PO-token handling sits closer to "circumventing an
access control" than plain downloading does.

Spool is built for the uses that are clearly legitimate: **your own uploads,
Creative Commons and public-domain material, and personal offline use where your
local law allows it.** You are responsible for what you download with it.

This is not legal advice.

---

## Licence

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Pardeep Verma.

Spool bundles [yt-dlp](https://github.com/yt-dlp/yt-dlp) (Unlicense) and
[ffmpeg](https://ffmpeg.org/) via
[youtubedl-android](https://github.com/JunkFood02/youtubedl-android) (GPL-3.0).
**If you redistribute builds, ffmpeg's licensing terms travel with the binary** —
the APK as a whole is subject to GPL-3.0, even though this source tree is MIT.
