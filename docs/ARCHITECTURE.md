# Spool — architecture

What the pieces are, what talks to what, where state lives, and how it builds.
For *what the app does* see [FEATURES.md](FEATURES.md); for *the order it does it
in* see [FLOWS.md](FLOWS.md); for how it looks see [UI.md](UI.md).

---

## 1. The shape of the app

Spool is one Activity, one React tree, and one native module. Four things run
concurrently and none of them can be assumed to be alive when the others are:

| Runtime | What lives there | Dies when |
|---|---|---|
| **JS thread** | The whole React tree, all orchestration, the play index, the artwork index | The process does |
| **WebView renderer** | YouTube, and the three injected scripts | Android reclaims it under memory pressure — see [FLOWS § 12](FLOWS.md#12-the-webview-renderer-is-killed) |
| **`PlaybackService`** | The media notification, the `MediaSession`, the partial wake lock | Told to stop, or the task is swiped away |
| **`DownloadService`** | The download foreground notification | The last running job finishes or is cancelled |
| **yt-dlp** | A bundled Python 3.8 subprocess per job, on `Dispatchers.IO` | The job ends or is destroyed by id |

Everything above runs on the phone. There is one thing that does not:
**the licence server, a plain PHP + MySQL application that signs subscription
licences.** It holds accounts, issues UPI payment orders, checks the OCR'd text
of payment screenshots, and arbitrates the one-device-at-a-time play lock —
none of which can be done by an APK that anyone can decompile. It is not in the
table because nothing in the app *waits* on it for long — `LicenseGuard`
decides entitlement from a token already on disk, and the play lock lets a
device play for a day without contact — so the app is fully functional with
the server unreachable, unbuilt, or never configured. The one-sentence map of
the app half: `core/account.ts` owns the session and the only request helper,
`core/license.ts`, `core/payments.ts` and `core/playLock.ts` all go through it.

It does not live in this repository. On the development machine it is at
`c:\laragon\www\spool`; `server/` here keeps only a reference implementation of
the token format and the test that pins it. See
[FEATURES § 17](FEATURES.md#17-subscriptions) and
[`server/README.md`](../server/README.md).

The single most consequential structural fact: **there are two independent
playback engines, and Android has room for one media notification per app.**
The browser's `<video>` and the local `expo-audio`/`expo-video` player know
nothing about each other, so `src/player/nowPlaying.ts` arbitrates between them.
Almost every subtle bug this codebase has had came from that seam.

---

## 2. Layer map

```
                              index.ts
                  bootstrap.ts  ← crash captures, console bridge
                                 │
                              App.tsx
              ErrorBoundary → SafeArea → Theme → Player provider
                                 │
                        src/browser/BrowserScreen.tsx
              the shell: five tabs, one WebView, four download paths
                                 │
        ┌────────────────┬───────┴────────┬──────────────────┐
        │                │                │                  │
   screens/          player/          core/            browser/ hooks
   Home              PlayerContext    ytdlp.ts         useBackgroundPlayback
   Search            nowPlaying.ts    clients.ts       usePlayTracking
   Library           PlayerScreen     tokens.ts        pageNowPlaying
   Profile           NowPlayingBar    storage.ts       (+ injected page scripts)
   FirstRun          useLyrics.ts     plays.ts
                                      artwork.ts
                                      metadata.ts
                                      playlists.ts
                                      similar.ts
                                      lyrics.ts
                                      export.ts
                                      trial.ts
                                      log.ts / crash.ts
        │                │                │                  │
        └────────────────┴───────┬────────┴──────────────────┘
                                 │
                       modules/ytdlp/index.ts
                     (the typed bridge — the contract)
                                 │
        ┌──────────────┬─────────┴────────┬───────────────┐
   YtDlpModule.kt  PlaybackService.kt  DownloadService.kt  TrialGuard.kt
        │                                                  MediaStoreWriter.kt
   youtubedl-android (yt-dlp + Python 3.8 + ffmpeg)        CookieJar.kt
```

`BrowserScreen.tsx` is 3,224 lines and is genuinely the orchestrator: it owns
the WebView, the tab state, the library records, the job list, and all three
download paths (five ways in). That size is a deliberate consequence of one
rule — **the WebView is mounted once and never unmounted**, only hidden behind
whichever tab is showing. Unmounting it would cost a page reload every time
someone checked their library, which is the opposite of what a persistent
browser session is for. Everything that has to survive a tab change therefore
has to live above the tabs, which means here.

### The seam files

Three modules exist purely so that a three-thousand-line screen does not
re-render once a second:

- **`src/player/nowPlaying.ts`** — module-level store. Decides which source owns
  the media notification, and drops any publish that would not change what the
  card shows.
- **`src/browser/pageNowPlaying.ts`** — module-level store. What the page is
  playing, subscribed to only by the mini bar.
- **`src/core/artwork.ts`** — module-level index plus a change subscription.
  Screens read `artworkFor(id)` synchronously and use `useArtworkVersion()` only
  to know when to look again.
- **`src/core/metadata.ts`** — the single answer to what a thing is called.
  Applied at exactly **two boundaries**, and the choice of boundary is the whole
  design: `listFormats` in `core/ytdlp.ts` (every download path reads its
  `title`, and it becomes the filename in the user's gallery) and the `media`
  branch of `onMessage` in `BrowserScreen` (which feeds the play index, the mini
  bar, the media card and the replay rule). Cleaning at those two rather than at
  the dozen places a name is *used* is what stops one of them being forgotten.
  `loadDownloads` and `adoptSaved` run the same pass over what is already
  stored, so a library that predates this reads the same as one that does not.

One is a store for a *preference the device works out for itself*:

- **`src/core/clients.ts`** — which InnerTube client to ask first, scored per
  `(mode, client)` and persisted. `withClientFallback` already learns within a
  session; this is what stops every cold start re-paying the walk. It only ever
  reorders the chain — never removes a client — so a board that has learned
  something wrong costs time and can never be the reason a download fails, and
  it is wiped when the engine replaces its own extractor. Read alongside the
  engine in `initEngine`, which is the one point both early enough and on every
  path that walks a chain.

One more is a store in the same sense, but for evidence rather than state:

- **`src/core/log.ts`** — the flight recorder. A bounded in-memory ring of
  structured entries, flushed to AsyncStorage on a debounce and immediately on
  any error, with the previous run moved aside at boot so a crash cannot
  overwrite its own explanation. Nothing subscribes to it and no screen
  re-renders from it; it is written from everywhere and read in exactly two
  places — the Profile export row, and whoever opens the file it writes.

  `src/core/crash.ts` installs the three captures that the app is never told
  about directly: the global error handler, the unhandled-rejection tracker, and
  a `console` bridge that folds every existing `[spool] …` line into the same
  record. `src/core/bootstrap.ts` exists only to run that installation *before*
  the app tree is imported — see §6.

Two more exist so a callback can be replaced without re-threading props:

- **`setPlaybackGate`** on the player context — the shell registers "silence the
  browser page", and every path that makes a sound calls it. There are five such
  paths and missing one is inaudible in code and obvious in use.
- **`setPreReleaseOpener`** in `core/trial.ts` — the shell owns the pre-release
  sheet; the trial chip lives in three screen headers and opens it without any of
  them carrying a prop.

---

## 3. The native module contract

`modules/ytdlp/index.ts` is the whole surface. Read it before reading any
Kotlin — the TypeScript types carry the intent, and several of them document
constraints that are invisible on the Kotlin side.

### JS → native

| Function | Kind | What it does |
|---|---|---|
| `initialize()` | async | Extracts the bundled Python and ffmpeg. Slow on first launch; warmed at boot |
| `version()` | async | yt-dlp version, or `"unknown"` until an update has actually run |
| `listFormats(url, poToken, visitorData, clients)` | async | Returns yt-dlp's raw `--dump-single-json` string. Parsing is TypeScript's job |
| `download(args)` | async | Downloads to app-private storage. Returns `{ path, bytes }`, plus `salvagedFrom` when the file was complete and only a decoration failed — that field *is* the N10 fix, so nothing may drop it |
| `cancel(id)` | async | `destroyProcessById` |
| `updateEngine()` | async | Pulls a newer extractor at runtime. The app's only self-repair path |
| `publishToGallery(path, title, audioOnly)` | async | MediaStore insert into `Music/Spool` or `Movies/Spool`; returns a `content://` uri and **deletes the source** |
| `writeTextFile(name, mime, body)` | async | A playlist or a backup into `Downloads/Spool`. Same insert, nothing moved or deleted |
| `scanSaved()` | async | Everything ever published, read back off MediaStore |
| `readArtwork(key, path, urls)` | async | Cover art + dominant colour. Rejects when nothing yields anything |
| `filesExist(uris)` | sync | Which cached covers are still on disk. `cacheDir` can be emptied under an index that survives |
| `setNowPlaying(state)` | sync | Raises/refreshes the media notification. **The first call must happen while the app is on screen** |
| `stopBackgroundPlayback()` | sync | Takes the card down |
| `signOutOfYouTube()` | async | Drops this device's YouTube session — cookies, DOM storage, every cookie jar. Runs on the **main** thread and resolves after the removal, so the caller's WebView remount cannot race it. Not a sign-out at Google |
| `setSecureWindow(on)` | sync | FLAG_SECURE on the activity window, held only while the page is on a Google sign-in host |
| `setPageCommand(command, stamp)` | sync | Writes a `spool_cmd` cookie the page polls — the only channel that reaches a backgrounded WebView |
| `setWebViewVisible(pinned)` | sync | Tells the browser's WebView, once a second, that it is still on screen. Without it WebView suspends the media pipeline of a hidden WebView and the page stops within ~50ms of every resume |
| `recognizeText(uri)` | async | On-device OCR (ML Kit, bundled Latin model) of a payment screenshot. Resolves the text, lines joined by `\n` |
| `shrinkImage(uri, maxEdge, quality)` | async | Re-encodes a picked image as a small JPEG in `cacheDir/upload/` for the payment upload |
| `trialStatus()` | sync | What this build allows. **Not cheap, despite being sync**: in a release trial build it is three file reads, a possible file write (reading `highWater` writes it), a prefs write, a `getPackageInfo` binder call and a SHA-256 — all on the JS thread. Call it from a boot path or a cached value, never per frame |

### Native → JS

| Event | Payload | Emitted by |
|---|---|---|
| `onProgress` | `{ id, fraction, eta, line }` | `YtDlpModule` during `download` |
| `onPlaybackCommand` | `{ command, value }` | `PlaybackCommandBus`, fed by `PlaybackService` |
| `onLog` | — | **Declared in `Events(...)` and never emitted.** Dead |

`onPlaybackCommand` carries seven verbs: `play`, `pause`, `stop`, `next`,
`previous`, `seek` (with `value` in seconds) and `save`. They are delivered to
whichever source currently owns the card — see [FLOWS § 11](FLOWS.md#11-a-notification-button-is-pressed).

### Kotlin constraints worth knowing before editing

- **Keep function bodies out of the module DSL.** `Function` and `AsyncFunction`
  are inline builders with reified type parameters and `definition()` is one
  enormous inlined expression. Two more inline bodies once tipped it past what
  Kotlin would inline and every launch died before any JavaScript ran. Write
  `Function("name") { args -> memberFunction(args) }`. `showNowPlaying` and
  `writePageCommand` are private methods for exactly this reason.
- **No `Record` types.** `@OptimizedRecord` wants introspection data from a KSP
  step this module does not run. `Map<String, Any?>` is what `download` and
  `setNowPlaying` already use.
- **R8 cannot see `YtDlpModule`.** Expo resolves module classes by the name in
  `expo-module.config.json`, so nothing in the bytecode references it and R8
  strips it. Keep rules live in `app.json`, not in the generated
  `proguard-rules.pro`.

---

## 4. Where state lives

State is deliberately spread across five stores with different lifetimes. The
distinction that matters most: **app data dies with an uninstall, MediaStore
records do not.** That asymmetry is the whole reason `adoptSaved` exists.

### React state in `BrowserScreen`

`screen`, `records` (the library), `jobs` (in-flight downloads), `autoSave`
(settings), `recentSearches`, `sheet`, `meta`, `dl`/`progress` (the FAB),
`engine`, `preRelease`, `picker`, `entry`/`webviewKey`.

Several of these are mirrored into refs — `settingsRef`, `playsRef`,
`screenRef`, `forgottenRef`, `cardCanSave`, `cardSave`, `runAutoSave` — because
the WebView's `onMessage` handler and the notification's command listener are
subscribed **once** and must not be torn down and rebuilt when unrelated state
changes. Rebuilding them mid-video drops the messages the play counter runs on.

### Module-level stores

`nowPlaying.ts` (card owner + last published shape per source),
`pageNowPlaying.ts` (page playback), `artwork.ts` (cover index + in-flight map +
a 3-wide concurrency gate), `trial.ts` (cached `TrialStatus`), and
`core/ytdlp.ts` (`preferredOpen` and `preferredToken` — the pin is per mode, not one global one — plus `triedUpdate` and the `initEngine` promise), and
`core/log.ts` (the ring, the flow counter, the once-only restore latch).

The tests re-import these under a `?fresh=n` query specifically to get a clean
copy of that module-level state.

### AsyncStorage

| Key | Shape | Cap | Notes |
|---|---|---|---|
| `dl.firstRunDone` | `"1"` | — | |
| `dl.downloads` | `DownloadRecord[]` | 200 | The library index. Written on every change once booted |
| `dl.settings` | `Settings` | — | Merged over `DEFAULT_SETTINGS`, so an older blob is missing keys rather than breaking |
| `dl.session` | `{ ids, index, at }` | — | Resume point. **Ids, not tracks** — a removed row cannot resurrect as a queue entry |
| `dl.searches` | `string[]` | 8 | |
| `dl.forgotten` | `string[]` (uris) | 500 | What stops a rescan undoing a removal |
| `dl.plays` | `Record<id, PlayStat>` | 300 | Trimmed saved-first, then least-recent |
| `dl.playlists` | `Playlist[]` | 50 lists × 500 tracks | Download **ids**, in the user's order. Never pruned against the library — see below |
| `dl.artwork` | `Record<key, Artwork \| { failedAt } \| null>` | — | A failure is believed for 24 h; a legacy `null` is retried. Covers whose file is gone are dropped at load. Flushed 2s after a change |
| `dl.lyrics` | `Record<key, Lyrics \| null>` | 200 | Keyed on artist+title, not download id. `null` is "there are none" |
| `dl.lyricsOptIn` | `"1"` / `"0"` | — | Whether the user agreed to the one non-YouTube request. Absent means no |
| `dl.log` | `Entry[]` | 900 | This run's diagnostic ring. Flushed on a 4s debounce, and at once on any error |
| `dl.log.prev` | `Entry[]` | 900 | The **previous** run, moved here at boot before this one writes. The only copy that survives a crash |
| `spool.clients.v1` | `Record<"mode:client", number>` | ±4 per entry | The learned client order. Wiped when the engine replaces its own extractor |
| `dl.account` | `{ session, email }` | — | The Spool account session. A credential — never logged |
| `dl.serverContact` | epoch ms as a string | — | Last time the licence server answered at all; the play lock's offline grace runs from it |
| `dl.licence` | `{ paidThrough, plan }` | — | The subscription's end, so it displays offline. The token's own expiry is only a lease |
| `dl.pendingOrder` | `Order` | 1 | A UPI order being paid, kept until it expires or is approved |

Full shapes, corruption handling, and what survives an uninstall are in
[DATA.md](DATA.md).

**A playlist's stored ids are never pruned.** `resolve` turns them into rows
against the library as it stands and skips what it cannot find, but nothing
writes that back. An id that resolves to nothing today may simply be a library
that has not finished loading — downloads are read asynchronously at boot and
MediaStore adoption lands later still — so pruning on load would empty every
playlist on one slow launch, permanently, with nothing anywhere to say why.

Every loader swallows its own errors and returns something usable — corrupt
JSON, a blob from an older build, a full disk. `tests/storage.test.mjs` is
mostly about proving that what comes back is still usable.

### The device, outside the app sandbox

- `Downloads/Spool/` — exported `.m3u8` playlists and `spool-backup-*.json`.
  Written only when asked, and never read back — import is not built.
- `Music/Spool/` and `Movies/Spool/` — MediaStore records for **manual** saves.
  Survive uninstall. `scanSaved` reads them back; `adoptSaved` folds them into
  the library.
- `getExternalFilesDir(null)/downloads/` — where every download lands first, and
  where **automatic** saves stay permanently. Deleted with the app. Named
  `<videoId>.<a|vHEIGHT>.<ext>` from `partialKey`, never from the title (see
  below) and never from the job id — a name minted per attempt gives yt-dlp's
  `--continue` nothing to continue into.
- `cacheDir/artwork/` — re-encoded quality-85 JPEGs, short edge 640.
- `noBackupFilesDir/session/jar*.txt` — the WebView session as a Netscape cookie
  file, one per extraction and per download, **deleted in the caller's
  `finally`**. This is the user's YouTube login in plaintext, so it is scoped to
  the seconds yt-dlp is reading it rather than encrypted; see
  [NATIVE.md § 8](NATIVE.md#8-cookiejarkt) for why encryption would not help.
- `externalMediaDirs/.spool` — the trial's save-count mirror. Survives both
  "Clear storage" and an uninstall.
- `SharedPreferences("spool_trial")` — the fast copy of the same two numbers.
- `app_webview/` — the WebView's own store, and where the YouTube session
  actually lives. Not written by this app; read out by `CookieJar.write`, and
  removed in full by `CookieJar.clear` when the user signs out.

### What may not be backed up

Auto Backup is on and by default excludes only the cache directories, so
`app_webview/` — a live YouTube session once signed in — would be uploaded to
Google and restored onto another device as a working login. Two resource files
under `modules/ytdlp/android/src/main/res/xml/` exclude it, plus the trial's
`spool_trial.xml`: `spool_backup_rules.xml` for Android 11 and older,
`spool_data_extraction_rules.xml` for 12+ (which splits cloud backup from device
transfer, so both are named). `databases/` — the library index — is deliberately
left in.

### Native, compiled in

`BuildConfig.TRIAL`, `BUILT_AT`, `TRIAL_EXPIRES_AT`, `TRIAL_MAX_DOWNLOADS`,
`TRIAL_MAX_SECONDS`, `SIGNING_SHA256`. Stamped at build time so there is nothing
on the device to clear or reinstall past.

### Filenames are counted in bytes

Downloads are named by `partialKey`, and anything built from a title is trimmed
on a **byte** budget at a character boundary (`MediaStoreWriter.limitBytes`, 180
bytes). Kotlin and Python count characters; the filesystem counts bytes. A title
in styled Unicode or emoji runs four bytes to the character, so an 80-character
template is ~340 bytes, past the 255-byte limit, and the write dies with
`[Errno 36]` before any audio lands — permanently, for that video, while
plain-titled ones save fine.

---

## 5. The injected page scripts

Three scripts are concatenated into one `injectedJavaScriptBeforeContentLoaded`
payload, in this order:

```js
const PRELOAD = ADBLOCK_SCRIPT + POTOKEN_SCRIPT + BACKGROUND_SCRIPT;
```

All three must beat the page's own scripts. `BACKGROUND_SCRIPT` is the strictest:
it only works if its visibility listeners are registered ahead of YouTube's, in
the capture phase, so that `stopImmediatePropagation` can prevent YouTube's own
pause handler from ever running.

`NAV_SCRIPT` goes in `injectedJavaScript` (after load) instead, because it only
has to report navigation.

| Script | File | Job |
|---|---|---|
| `ADBLOCK_SCRIPT` | `browser/adblock.ts` | Strip ad fields from player responses, hide cosmetic slots, skip anything that gets through |
| `POTOKEN_SCRIPT` | `browser/potoken.ts` | Harvest the `pot` parameter and `visitorData` the page already has |
| `BACKGROUND_SCRIPT` | `browser/background.ts` | Freeze the visibility API, resume unwanted pauses, report media state, poll the command cookie |
| `NAV_SCRIPT` | `browser/youtube.ts` | Report SPA navigation, which `onNavigationStateChange` misses |

### Talking back to the page

Two channels, and both are sent for every command:

- `injectJavaScript` — instant while the app is on screen, **queued** while it is
  not. react-native-webview posts it as a UIManager view command, flushed on a
  Choreographer frame that an off-screen window never gets.
- The `spool_cmd` cookie via `YtDlp.setPageCommand` — arrives within a second
  whatever the app is doing, because the page's own timer keeps running.

Everything that has to reach the page goes through `say`/`seek` in
`useBackgroundPlayback`, never through `injectJavaScript` alone.

---

## 6. Threading and lifecycle rules

- All **async** native work runs on `CoroutineScope(SupervisorJob() + Dispatchers.IO)` in
  `YtDlpModule`. The five sync `Function`s — `setNowPlaying`, `trialStatus`,
  `stopBackgroundPlayback`, `setPageCommand`, `setWebViewVisible` — run on the
  caller's thread, which is the JS thread. Whatever they do, they do to it; see
  the note on `trialStatus` in §3.
- Artwork decoding in `PlaybackService` is on a single-thread executor, posted
  back to the main looper, and skipped when the path has not changed.
- The partial wake lock is held **only while sound is actually coming out**.
  A lock left on across a pause is the classic overnight battery drain.
- **`startForegroundService` is refused from a backgrounded process on Android
  12+.** Both playback sources therefore publish on *first play*, never on load
  and never when the user leaves. `startForegroundCompat` wraps the call in
  `runCatching` because an uncaught `ForegroundServiceStartNotAllowedException`
  takes the whole app down.
- `START_NOT_STICKY` on both services. A swiped-away task tears the playback
  notification down via `onTaskRemoved`.
- **Every path that starts a download takes one slot.** `DownloadService` has a
  single `currentId`, one ongoing notification, and an `ACTION_STOP` from
  whichever job finishes first — so two overlapping downloads do not queue, they
  interfere. `takeSlot()` in `BrowserScreen` is the lock; all four paths (the
  FAB, the replay rule, the notification's save button, a failed row's *Try
  again*) go through it, and **the release must sit in a `finally`** or one
  early return wedges every later download.
- **`index.ts` imports `src/core/bootstrap` first, and that has to stay first.**
  ES imports are hoisted and evaluated in source order, *before* any statement
  in the importing module's body — so calling the installer from `index.ts`'s
  body would run it after the whole app tree had already been imported, which is
  precisely when a module-level throw would go unrecorded.

---

## 7. Build and release

### Config plugins

`android/` is generated and not committed, so anything that must survive
`expo prebuild` lives in `app.json` or in a plugin:

| Plugin | What it does |
|---|---|
| `withReleaseSigning` | Injects the release signing config into the generated Gradle |
| `withAbiSplits` | One APK per ABI. yt-dlp ships Python + ffmpeg per architecture, so a universal APK carries four copies of each — 253 MB of native libraries out of a 226 MB download. x86 is excluded (emulator-only, unsupported); x86_64 is kept so the emulator works |
| `withPageSizeCompat` | Android 16 page-size compatibility opt-in |

`expo-build-properties` in `app.json` carries `enableMinifyInReleaseBuilds` and
the full R8 keep-rule block.

### R8 keep rules — all five are load-bearing

```
-keep class com.afinitycode.spool.ytdlp.YtDlpModule     # Expo resolves it by name; nothing references it
-keep class com.afinitycode.spool.ytdlp.PlaybackService # named in the manifest
-keep class com.afinitycode.spool.ytdlp.DownloadService # named in the manifest
-keep class com.yausername.**                           # reaches Python through JNI and reflection
-keep class org.apache.commons.compress.**              # see below
```

The `commons-compress` rule is the quiet one. Its `ExtraFieldUtils` registers
zip extra-field types from a static block by reflective `newInstance()`, so R8
concludes `AsiExtraField` is never instantiated and makes it **abstract**. The
initialiser then throws "not a concrete class", the Python payload never
unpacks, and ART marks the class permanently bad — every later attempt fails for
the life of the install. This shipped once, because engine init is lazy and the
emulator pass only proved the app launched.

`TrialGuard` is deliberately **not** kept: it is meant to be obfuscated. Neither
is `LicenseGuard`, for the same reason — it reaches the JCA through
`Signature.getInstance("SHA256withECDSA")` and `KeyFactory.getInstance("EC")`,
which are platform lookups by string and need no keep rule of their own.

### A release build refuses to be cut without a licence key

`modules/ytdlp/android/build.gradle` throws at configuration time when
`SPOOL_LICENCE_KEY` or `SPOOL_LICENCE_SERVER` is empty and a release task is in
the graph. Without that guard the APK would install, run, take payments and then
refuse every licence it was handed — a failure invisible until a real person had
paid real money. Debug builds ship both empty on purpose and **fail closed**:
`LicenseGuard` cannot construct a verifier, nobody is entitled, and the trial
applies as before.

### Gradle properties

| Property | Default | Effect |
|---|---|---|
| `SPOOL_TRIAL` | `true` | Whether this build is a pre-release |
| `SPOOL_TRIAL_DAYS` | `7` | Stamped as `BUILT_AT + days` into `TRIAL_EXPIRES_AT` |
| `SPOOL_TRIAL_SAVES` | `20` | `TRIAL_MAX_DOWNLOADS` |
| `SPOOL_TRIAL_SECONDS` | `180` | `TRIAL_MAX_SECONDS` — the per-video length cap |
| `SPOOL_SIGNING_SHA256` | a pinned hash | Release-variant only; empty on debug so local builds do not refuse to run |

Extending a trial is a rebuild, not a server call.

### CI — `.github/workflows/release.yml`

Push a `v*` tag. A `preflight` job checks whether `KEYSTORE_BASE64` exists
(the `secrets` context is unavailable in a job-level `if`, hence the separate
job) so a tag pushed before the secrets are configured skips cleanly instead of
failing red. The build job then prebuilds, decodes the keystore, runs
`assembleRelease`, and **verifies with `apksigner` that no APK is debug-signed**
before renaming them `spool-<version>-<abi>.apk` and writing `SHA256SUMS.txt`.

### Targets

`minSdk 24`, `compileSdk`/`targetSdk 36`, Java 17, Kotlin JVM target 17.
`useLegacyPackaging` on jniLibs, because the bundled Python payload is a zip
that must stay uncompressed to be extracted at runtime.

---

## 8. Testing

```bash
node --experimental-strip-types --import ./tests/harness/register.mjs --test "tests/*.test.mjs"
```

`tests/harness/loader.mjs` does two things the app's source makes necessary: it
retries extensionless imports with the extensions Metro would have tried, and it
swaps `react`, `expo-modules-core` and `@react-native-async-storage/async-storage`
for stubs. The stubs are also the handles a test reaches for to make a write fail
or a native call throw. A `?fresh=n` query is preserved through resolution so a
test can get a clean copy of a module's own state.

**21 suites, 477 tests.** The per-suite breakdown, what the harness fakes and
where it diverges from the real thing, and the four-rung verification ladder are
all in [TESTING.md](TESTING.md) — coverage figures live there so there is one
copy of them.

The one thing worth repeating here, because the shorthand used to be wrong in
both directions: React **components** are uncovered; React **hooks** are not, and
native **calls** are asserted through the bridge's call log. What no test reaches
is the Kotlin behind that log, which is verified on a device instead.

---

## 9. Known gaps in the wiring

Real, currently true, and not fixed. Documented so nobody rediscovers them by
debugging.

- **`DownloadService.updateProgress` is never called.** `YtDlpModule` sends
  progress to JavaScript but never back to the service, so the ongoing download
  notification shows an indeterminate "Preparing…" for the whole job. In-app
  progress is correct on **the Library row** — not on the FAB, which no longer
  follows a download at all (see the next entry).
- **The FAB's `working` state is unreachable.** `DownloadState` still declares
  it, but `setDl` is only ever called with `ready`, `idle`, `resolving` or
  `failed`, so `fabState` can never resolve to `working`. That makes `FabRing`,
  the press guard, the hold guard and the reset guard dead code, and "tap
  cancels" false. Deliberate: holding the button for the length of a download
  was N8. Do not restore it without reading
  [UI.md § The download rule](UI.md#the-download-rule).
- **`DownloadService.notifyComplete` is never called.** There is no completion
  notification.
- **`YtDlpCancelBus.register` is never called.** The CANCEL action on the
  download notification stops the service, but no listener is registered, so the
  yt-dlp process is not destroyed. Cancelling from inside the app works — that
  path goes through `YtDlp.cancel(id)`.
- **`onLog` is declared and never emitted.**
- **Dead v1 files:** `browser/BrowserChrome.tsx` and `browser/Pill.tsx` are
  unreferenced; `browser/DownloadButton.tsx` survives only as the source of the
  `DownloadState` type; `player/VideoScreen.tsx` is unreferenced since the full
  player took over video.
- **Dead imports/state in `BrowserScreen`:** `IS_PREVIEW` and `hostOf` are
  imported and unused; `loadProgress` is tracked and never rendered, because v2
  removed the chrome that displayed the load line.
- **`FirstRunScreen`'s "Choose folder" button opens no picker**, names
  `Movies/Spool` for a destination that is `Music/Spool` for audio, and is the
  last screen still using the v1 token aliases. See
  [FEATURES § 13](FEATURES.md#13-first-run-and-permissions).
