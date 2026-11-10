# Spool — the documentation set

Spool is an Android app: a WebView pointed at YouTube, a native yt-dlp engine
behind it, and a local library that plays with the screen off. It is not a
downloader with a player bolted on — the *library* is the product, and
downloading is how things get into it.

There is no account and no analytics. Everything the app knows lives on the
device. Four hosts are contacted and no others: YouTube through the page,
`i.ytimg.com` for cover art, `lrclib.net` for lyrics — only after an explicit
opt-in, and only from a tap — and the licence server, only on a build configured
with one and only to carry a device hash. See
[FEATURES.md § 14](FEATURES.md#14-privacy).

---

## Read these in this order

**Start with [ONBOARDING.md](ONBOARDING.md).** It is the shortest path from
nothing to a change that will survive review: the app in sixty seconds, which
book to open for which task, recipes for the dozen things that get asked for
most, what counts as proof, and a symptom-to-trap index.

| Document | What it answers | Read it before |
|---|---|---|
| [ONBOARDING.md](ONBOARDING.md) | How to work here: routing, recipes, the verification ladder, symptom → trap | Every session, before the book below that matches |
| [ARCHITECTURE.md](ARCHITECTURE.md) | What the pieces are, what talks to what, where state lives, how it builds | Touching anything structural, the native module, storage, or the build |
| [FEATURES.md](FEATURES.md) | Every user-visible capability, where it lives, and the rules it runs under | Adding, changing, or removing a feature |
| [FLOWS.md](FLOWS.md) | The end-to-end sequences, in order, with the orderings that are load-bearing | Debugging "why did it do that", or changing anything with a lifecycle |
| [UI.md](UI.md) | The v2 design system: tokens, type, motion, the five tabs, the player, copy rules | **Every** UI change, including ones that look cosmetic |
| [CODEMAP.md](CODEMAP.md) | Every file, its exports, its import edges, its invariants | Looking for where something lives, or judging blast radius |
| [NATIVE.md](NATIVE.md) | The Kotlin half: the bridge contract, both services, MediaStore, the trial, the build | Writing Kotlin, or changing anything about the build |
| [DATA.md](DATA.md) | Every store and shape, and what survives a clear, an uninstall, a reinstall | Storing anything, or changing a stored shape |
| [TESTING.md](TESTING.md) | The verification ladder, the harness and where it diverges, coverage, device recipes | Writing a test, or deciding what proof a change needs |
| [RELIABILITY.md](RELIABILITY.md) | What has actually been measured on a device, in five passes, and what it found | Reporting a bug, or repeating a verification pass |
| [../server/README.md](../server/README.md) | The licence server: where it lives, the token format and its test | Touching subscriptions, payments, or anything off-device |
| [../AGENTS.md](../AGENTS.md) | The traps that have already cost a day each | Every session — it is loaded automatically |

[MARKET.md](MARKET.md) is not a knowledge book. It is dated outside research into
what listeners want and complain about, kept as planning input — it describes the
market, never the app.

`UI.md` and `AGENTS.md` came first and are the ones with the strongest claim on
being right. Where two books disagree, prefer the more specific one, and prefer
`RELIABILITY.md` over both when the question is what the code *does* rather than
what it is meant to do — that one is measurement, the others are intent.

**Keep them current in the same change.** A stale book is worse than none,
because it will be trusted. When a change lands that a document describes,
update that document in the same commit.
[ONBOARDING.md § 9](ONBOARDING.md#9-the-documentation-contract) is the contract
for which book a given fact belongs in.

---

## Where things are

```
App.tsx                          ErrorBoundary → SafeArea → Theme → Player → BrowserScreen
index.ts                         Expo entry
app.json                         Expo config: package id, R8 keep rules, config plugins
plugins/
  withReleaseSigning.js          Injects the release signing config into generated Gradle
  withAbiSplits.js               One APK per ABI instead of one 226 MB universal one
  withPageSizeCompat.js          Android 16 page-size compatibility opt-in
.github/workflows/release.yml    Tag → prebuild → signed per-ABI APKs → artifact

src/
  browser/                       The WebView half
    BrowserScreen.tsx            The shell. Tabs, download orchestration, all four download paths
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

  core/                          Logic with no React in it (artwork and trial export hooks too)
    ytdlp.ts                     Engine bridge: both client chains, parsing, dedupe, selectors
    clients.ts                   Which client to ask first — scored per device, persisted
    tokens.ts                    Harvested PO tokens, per video id, 6h TTL
    engine.ts                    Platform-agnostic types and seams
    storage.ts                   AsyncStorage persistence + `adoptSaved`
    plays.ts                     The play index (the only behavioural record in the app)
    metadata.ts                  What a thing is called: uploader titles into track names
    playlists.ts                 The one list the app never rearranges
    similar.ts                   "More like this", computed locally from what is owned
    lyrics.ts                    The only non-YouTube request, and its consent gate
    log.ts                       The flight recorder — bounded, persisted, redacted
    crash.ts                     Global error handler, rejection tracker, console bridge
    bootstrap.ts                 Runs those first, before the app tree is imported
    export.ts                    Playlists and backups, as files that outlive the app
    artwork.ts                   Cover resolution, three layers of memory
    trial.ts                     Describes the pre-release limits (never enforces them)

  player/                        The local playback half
    PlayerContext.tsx            One queue, two engines, one seat
    nowPlaying.ts                Arbiter for the single media notification
    PlayerScreen.tsx             The full player
    NowPlayingBar.tsx            The mini bar, including the page variant
    useLyrics.ts                 Fetch, cache and consent, hooked to the current track
    VideoScreen.tsx              v1 leftover, unreferenced

  screens/                       Home, Search, Library, Profile,
                                 Onboarding (welcome → features → premium)
  sheets/                        QualitySheet, ChoiceSheet, NameSheet, PreReleaseSheet
  shell/TabBar.tsx               The five tabs
  ui/                            theme.ts (tokens), ThemeContext.tsx, TrialChip.tsx,
                                 ErrorBoundary.tsx (outside every provider, on purpose)

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
    java/.../CookieJar.kt        WebView session → an ephemeral cookie file for yt-dlp,
                                 and the only thing that can clear the session
    java/.../TrialGuard.kt       Enforces the pre-release limits. The only copy that decides
    res/drawable/                Notification icons
    res/xml/                     Backup exclusions — the WebView's session may not
                                 leave the device

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

```bash
npm test -- "tests/*.test.mjs"
```

The script exists now and takes the pattern as an argument. The long form still
works, and the flag is required — without it every file fails to load:

```bash
node --experimental-strip-types --import ./tests/harness/register.mjs --test "tests/*.test.mjs"
```

**525 tests across 125 suites, ~9 seconds**, all passing, run under Node's own
test runner with a loader that resolves Metro-style extensionless imports and
swaps React, `expo-modules-core` and AsyncStorage for stubs. The per-suite
breakdown and what each one deliberately does not pin down are in
[TESTING.md](TESTING.md); that is where the coverage figures live, so there is
one copy of them.

What is *not* covered, stated precisely, because the shorthand here used to be
wrong in both directions: React **components** are uncovered, but React hooks
are not — `usePlayTracking` and `useBackgroundPlayback` both have suites. Native
**calls** are asserted extensively through the bridge's call log; what is
uncovered is the Kotlin behind them, along with 9,372 lines of `.tsx`, 2,333
lines of Kotlin.

`src/browser/potoken.ts` used to be named here as the one injected script with
no executed test — the file whose blindness cost a day
([RELIABILITY.md § 10](RELIABILITY.md#10-fifth-pass--2026-08-23-making-downloads-production-ready)).
It has one now (`tests/potoken.test.mjs`), added when a per-fragment cost in it
turned out to be invisible to every other kind of review. What that suite pins
is deliberately narrow: **which request bodies the harvester is willing to pay
to read**, not whether a token is ever found — the second is YouTube's
infrastructure, not ours, and a test asserting it would measure them.

An earlier note here reported `tests/artwork.test.mjs` as intermittently failing
under the full-suite run. It did not reproduce across five consecutive full
runs; treat it as closed unless it returns.

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

`../README.md` was rewritten against the current code. It is the front door for
a human who has just cloned the repo; this directory is the record. Keep it
current when a change lands that it describes.

It used to describe v1 and carried a warning here saying so — that its interface
sections were wrong but its engine sections were still right. Half of that
warning was itself wrong, which is the more useful lesson: the engine sections
had drifted just as far. They described a `web` PO token when the page is
`m.youtube.com` and the token is `mweb`, a client chain that no longer exists,
a 120-character filename cap that is now a 180-**byte** one, and a job-id
filename that would defeat resume. **A section nobody has re-read is not more
trustworthy for being technical.**
