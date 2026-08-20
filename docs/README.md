# Spool — the documentation set

Spool is an Android app: a WebView pointed at YouTube, a native yt-dlp engine
behind it, and a local library that plays with the screen off. It is not a
downloader with a player bolted on — the *library* is the product, and
downloading is how things get into it.

There is no account, no server, no analytics. Everything the app knows lives on
the device, and the only outbound requests are to YouTube (through the page) and
to `i.ytimg.com` (for cover art).

---

## Read these in this order

| Document | What it answers | Read it before |
|---|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | What the pieces are, what talks to what, where state lives, how it builds | Touching anything structural, the native module, storage, or the build |
| [FEATURES.md](FEATURES.md) | Every user-visible capability, where it lives, and the rules it runs under | Adding, changing, or removing a feature |
| [FLOWS.md](FLOWS.md) | The end-to-end sequences, in order, with the orderings that are load-bearing | Debugging "why did it do that", or changing anything with a lifecycle |
| [UI.md](UI.md) | The v2 design system: tokens, type, motion, the five tabs, the player, copy rules | **Every** UI change, including ones that look cosmetic |
| [../AGENTS.md](../AGENTS.md) | The short list of traps that have already cost a day each | Every session — it is loaded automatically |

[MARKET.md](MARKET.md) is not a knowledge book. It is dated outside research into
what listeners want and complain about, kept as planning input — it describes the
market, never the app.

`UI.md` and `AGENTS.md` came first and are the ones with the strongest claim on
being right. The three new documents describe the same app from the other three
directions: structure, capability, and sequence.

**Keep them current in the same change.** A stale book is worse than none,
because it will be trusted. When a change lands that a document describes,
update that document in the same commit.

---

## Where things are

```
App.tsx                          Providers: SafeArea → Theme → Player → BrowserScreen
index.ts                         Expo entry
app.json                         Expo config: package id, R8 keep rules, config plugins
plugins/
  withReleaseSigning.js          Injects the release signing config into generated Gradle
  withAbiSplits.js               One APK per ABI instead of one 226 MB universal one
  withPageSizeCompat.js          Android 16 page-size compatibility opt-in
.github/workflows/release.yml    Tag → prebuild → signed per-ABI APKs → artifact

src/
  browser/                       The WebView half
    BrowserScreen.tsx            The shell. Tabs, download orchestration, all three save paths
    background.ts                BACKGROUND_SCRIPT — page-side background playback
    useBackgroundPlayback.ts     App-side half of the same feature
    usePlayTracking.ts           Counts what was actually watched
    pageNowPlaying.ts            Store: what the page is playing, for the mini bar
    adblock.ts                   ADBLOCK_SCRIPT — three-layer ad blocking
    potoken.ts                   POTOKEN_SCRIPT — PO token harvesting
    youtube.ts                   URL parsing + NAV_SCRIPT (SPA navigation reporting)
    formatView.ts                Format lists → sheet rows, and the headless "best" pickers
    DownloadButton.tsx           v1 leftover; only its `DownloadState` type is still used
    BrowserChrome.tsx, Pill.tsx  v1 leftovers, unreferenced

  core/                          Logic with no React in it
    ytdlp.ts                     Engine bridge: client chain, parsing, dedupe, selectors
    engine.ts                    Platform-agnostic types and seams
    storage.ts                   AsyncStorage persistence + `adoptSaved`
    plays.ts                     The play index (the only behavioural record in the app)
    metadata.ts                  What a thing is called: uploader titles into track names
    playlists.ts                 The one list the app never rearranges
    lyrics.ts                    The only non-YouTube request, and its consent gate
    export.ts                    Playlists and backups, as files that outlive the app
    artwork.ts                   Cover resolution, three layers of memory
    trial.ts                     Describes the pre-release limits (never enforces them)

  player/                        The local playback half
    PlayerContext.tsx            One queue, two engines, one seat
    nowPlaying.ts                Arbiter for the single media notification
    PlayerScreen.tsx             The full player
    NowPlayingBar.tsx            The mini bar, including the page variant
    VideoScreen.tsx              v1 leftover, unreferenced

  screens/                       Home, Search, Library, Profile, FirstRun
  sheets/                        QualitySheet, ChoiceSheet, PreReleaseSheet
  shell/TabBar.tsx               The five tabs
  ui/                            theme.ts (tokens), ThemeContext.tsx, TrialChip.tsx

modules/ytdlp/                   The Expo native module
  index.ts                       The typed JS surface — read this first, it is the contract
  expo-module.config.json        How Expo finds YtDlpModule (R8 cannot see this reference)
  android/build.gradle           Trial BuildConfig fields, signature pin, dependencies
  android/src/main/
    AndroidManifest.xml          Permissions and both services
    java/.../YtDlpModule.kt      The bridge: extract, download, publish, scan, artwork, cards
    java/.../PlaybackService.kt  The one media notification + MediaSession + wake lock
    java/.../DownloadService.kt  Foreground service for downloads
    java/.../MediaStoreWriter.kt Publishes a finished file into Music/Spool or Movies/Spool
    java/.../CookieJar.kt        WebView session → Netscape cookie file for yt-dlp
    java/.../TrialGuard.kt       Enforces the pre-release limits. The only copy that decides
    res/                         Notification icons

tests/                           Node test suite over the pure-logic modules
  harness/                       Module loader + React/Expo/AsyncStorage stubs
```

---

## Running it

```bash
npm install
npm run android          # expo run:android — needs a device or emulator on API 24+
npm run typecheck        # tsc --noEmit
```

Requirements: Node 20+, JDK 17, Android SDK, a device or emulator on API 24+.

`android/` is generated by `expo prebuild` and is not committed. Anything that
has to survive a prebuild belongs in `app.json` or in a config plugin under
`plugins/`, never in the generated tree.

## Running the tests

There is no npm script for this yet. The suite runs under Node's own test
runner, with a loader that resolves Metro-style extensionless imports and swaps
React, `expo-modules-core` and AsyncStorage for stubs:

```bash
node --experimental-strip-types --import ./tests/harness/register.mjs --test "tests/*.test.mjs"
```

110 tests across 7 files, all passing as of this writing. They cover
`storage.ts` (especially `adoptSaved`, the one function that can resurrect
something the user deleted), `plays.ts`, `formatView.ts`, `youtube.ts`,
`trial.ts`, `nowPlaying.ts` and `pageNowPlaying.ts`. Nothing with a React
component or a native call in it is covered — that half is verified on a device.

**A release-mode shrinking change is not verified until a real download
completes on a real device from a fresh install.** See `AGENTS.md` on R8; the
emulator pass only ever proves the app launched.

## Building an APK

```bash
npm run apk              # prebuild + gradlew assembleRelease
```

Trial limits are stamped in at build time and can be overridden:

```bash
cd android && ./gradlew assembleRelease -PSPOOL_TRIAL=false
```

See [ARCHITECTURE.md § 7](ARCHITECTURE.md#7-build-and-release) for
every property, the signing pin, the R8 keep rules, and the CI pipeline.

---

## A note on the root README

`../README.md` describes **v1** — a browser with a bottom chrome bar, a
`DownloadsScreen` and a `SettingsScreen`, and the download button as the whole
interface. That app no longer exists: v2 replaced the chrome with five tabs, a
persistent player and a library, and both of those screens have been deleted.
Its sections on PO tokens, the cookie handoff, SPA navigation, ad blocking,
merging, MediaStore publishing and the release process are still accurate.
Everything it says about the interface is not.

Treat this directory as the current record and the root README as a partly
outdated introduction until it is rewritten.
