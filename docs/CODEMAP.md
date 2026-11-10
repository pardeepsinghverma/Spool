# Spool — code map

The file and export index for the TypeScript half of the app: 51 files, 16,016
lines, of which `src/browser/BrowserScreen.tsx` is 3,224 on its own.

This book answers two questions and only two: **which file do I open for X**, and
**what may I call, and what does that value promise**. It is written so an agent
can answer both without reading the files.

It is deliberately not [FEATURES.md](FEATURES.md) — it does not explain what the
app does, only where the doing lives. It is not [FLOWS.md](FLOWS.md) — it names
no orderings. It is not [ARCHITECTURE.md](ARCHITECTURE.md) — it repeats no
reasoning about why the pieces are shaped this way. Where a rule exists that a
caller can break from the outside, it is stated here in one line and the pointer
goes to the book that explains it.

Signatures are copied from the source, not paraphrased. `file.ts:123` line
references are for jumping to; they drift, the names do not.

The Kotlin is not in here. `modules/ytdlp/index.ts` is documented because it is
the contract every native call goes through; everything under
`modules/ytdlp/android/` belongs to another book that does not exist yet.

---

## If you are changing X, open Y

| Change | File |
|---|---|
| Which InnerTube client is asked, or in what order | `src/core/ytdlp.ts`, `src/core/clients.ts` |
| Parsing yt-dlp's manifest, or the format selector string | `src/core/ytdlp.ts` |
| What a download is named on disk | `src/core/ytdlp.ts` (`partialKey`) |
| PO token capture, or which video a token belongs to | `src/browser/potoken.ts`, `src/core/tokens.ts` |
| The two screens (Browse & Account), browser header, and mode switching | `src/browser/BrowserScreen.tsx` |
| What the library index stores, or how the gallery is adopted | `src/core/storage.ts` |
| The play counter and the replay rule's evidence | `src/browser/usePlayTracking.ts`, `src/core/plays.ts` |
| What a row is *called* | `src/core/metadata.ts` |
| Whether two rows are the same thing | `src/core/similar.ts` |
| Playlists, and what a playlist resolves to | `src/core/playlists.ts` |
| Exported `.m3u8` and backup files | `src/core/export.ts` |
| Local playback, the queue, the sleep timer | `src/player/PlayerContext.tsx` |
| Which source owns the media notification | `src/player/nowPlaying.ts` |
| Page-side background playback (the injected script) | `src/browser/background.ts` |
| App-side background playback, the WebView pin | `src/browser/useBackgroundPlayback.ts` |
| Ad blocking | `src/browser/adblock.ts` |
| SPA navigation reporting, URL parsing | `src/browser/youtube.ts` |
| Cover art and the colour the theme is built from | `src/core/artwork.ts`, `src/ui/theme.ts` |
| Lyrics, and the consent gate on the one non-YouTube request | `src/core/lyrics.ts`, `src/player/useLyrics.ts` |
| Diagnostics, crash capture, what gets redacted | `src/core/log.ts`, `src/core/crash.ts` |
| What a pre-release build *says* (never what it allows) | `src/core/trial.ts` |
| What a subscription *says* (never what it allows) | `src/core/license.ts` |
| The Spool account, the session, the 401/403 rule | `src/core/account.ts` |
| UPI orders, screenshot claims, the WhatsApp link | `src/core/payments.ts`, `src/sheets/SubscribeSheet.tsx` |
| One device playing at a time | `src/core/playLock.ts`, `src/player/PlayerContext.tsx` (`lockPending`), `src/sheets/PlayLockSheet.tsx` |
| Payment screenshot OCR and resize | `YtDlpModule.kt` (`recognizeText`, `shrinkImage`) |
| Whether a device has actually paid | `modules/ytdlp/.../LicenseGuard.kt` |
| Anything off-device — accounts, payments, licence signing | the PHP server at `c:\laragon\www\spool`; `server/` keeps only the token-format reference |
| Any colour, size, duration or type style | `src/ui/theme.ts` |
| The five tabs | `src/shell/TabBar.tsx` |
| Any native call at all | `modules/ytdlp/index.ts` |

---

## Entry points

### `index.ts` — 13 lines

The Expo entry. Four statements, and their order is the whole content.

**Exports** — none.

**Depends on** `./src/core/bootstrap` (side-effect import), `expo`, `./App`.
**Used by** Metro, as the bundle root.

**Invariants**

- **`import './src/core/bootstrap'` must be the first import in the file.** ES
  imports are hoisted and evaluated in source order before any statement in the
  importing module's body, so calling the installer from the body would run it
  after the whole app tree had already been imported — which is exactly when a
  module-level throw would go unrecorded. See `AGENTS.md`, "`index.ts` must
  import `src/core/bootstrap` first".

### `App.tsx` — 70 lines

The provider stack, and nothing else. `ErrorBoundary → SafeAreaProvider →
ThemeProvider → PlayerProvider → BrowserScreen`.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| default | `function App()` — `App.tsx:21` | The root component. Holds fonts and renders `Splash` until they load. |

Two components are private: `Splash` (`App.tsx:52`) paints `fixed.base` so the
hold before Manrope lands reads as the app rather than a gap, and `Root`
(`App.tsx:61`) is `StatusBar` + `BrowserScreen`.

**Depends on** `src/browser/BrowserScreen`, `src/player/PlayerContext`,
`src/ui/ErrorBoundary`, `src/ui/ThemeContext`, `src/ui/theme`,
`@expo-google-fonts/manrope`, `@expo-google-fonts/ibm-plex-mono`.
**Used by** `index.ts`.

**Invariants**

- `ErrorBoundary` sits **outside** every provider. A boundary inside the tree it
  guards cannot draw once that tree is the thing that threw, and the providers
  are exactly where a bad restored value surfaces.
- The type scale in `src/ui/theme.ts` names font families directly, so rendering
  before `useFonts` resolves flashes the system face at the wrong metrics.

---

## `modules/ytdlp/index.ts` — the native contract, 234 lines

The typed JS surface over `YtDlpModule`. Read it before any Kotlin; the
TypeScript carries constraints that are invisible on the other side. The prose
counterpart is [ARCHITECTURE.md § 3](ARCHITECTURE.md#3-the-native-module-contract).

**Exports — types**

| Symbol | Signature | Meaning |
|---|---|---|
| `ProgressEvent` | `{ id: string; fraction: number; eta: number; line: string }` — `:4` | One `onProgress` tick. `id` is the job id the caller minted; a listener that does not filter on it will see every concurrent job. |
| `DownloadArgs` | `{ id; url; title?; format?; audioOnly?; poToken?; visitorData?; clients?; resumeKey?; seconds? }` — `:11` | Everything `download` needs. `format` is a yt-dlp selector string, not an id. `resumeKey` is the name on disk without an extension. `seconds` is the video's length so a trial build can refuse an over-long one; `0` means "the extractor did not say", which is not grounds for refusing. |
| `TrialStatus` | `{ trial; expiresAt; expired; intact; used; maxDownloads; maxSeconds }` — `:52` | What this build allows. `intact` goes false when the APK's signing certificate stops matching the pin. In a full build `trial` is false and every other field is meaningless. |
| `DownloadResult` | `{ path: string; bytes: number; salvagedFrom?: string }` — `:65` | Where the file landed. `salvagedFrom` is set when the engine reported a failure *after* writing a complete file — almost always a decoration (cover art, tags) that would not attach. Its presence means success with a complaint attached, not a partial file. |
| `SavedItem` | `{ uri; title; bytes; savedAt; durationMs; audioOnly; artist }` — `:86` | One MediaStore row. **No `videoId`** — nothing in a MediaStore record says which YouTube video a file came from, which is why an adopted row cannot tell the replay rule it already exists. |
| `UpdateResult` | `{ status: string; version: string }` — `:96` | What `updateEngine` did. |
| `ArtworkResult` | `{ uri: string; dominant: string }` — `:99` | A cached cover, and the single colour the whole theme is derived from. |
| `PlaybackCommandEvent` | `{ command: 'play' \| 'pause' \| 'stop' \| 'next' \| 'previous' \| 'seek' \| 'save'; value: number }` — `:102` | What the card, lock screen or a headset key asked for. Only `seek` means anything by `value`, and it is seconds. |
| `ShrunkImage` | `{ uri; bytes; width; height }` | What `shrinkImage` wrote: one JPEG in `cacheDir/upload/`. |
| `NowPlaying` | `{ title; artist; source; playing; artwork; position; duration; canNext; canPrevious; canSave }` — `:113` | What the card should say. Times are seconds. `duration: 0` means "not known yet" and the system then draws no scrubber rather than an empty one. `source` is appended to the artist with a `·` — it is the only thing that tells a page apart from a file once the app is off screen. |

**Exports — values**

| Symbol | Signature | Meaning |
|---|---|---|
| default `YtDlp` | `requireNativeModule<YtDlpNative>('YtDlp')` — `:222` | The module itself. `YtDlpNative` (`:142`) is private but is the real method list: `initialize`, `version`, `listFormats`, `download`, `cancel`, `updateEngine`, `publishToGallery`, `writeTextFile`, `scanSaved`, `readArtwork`, `filesExist`, `setNowPlaying`, `stopBackgroundPlayback`, `setPageCommand`, `setWebViewVisible`, `trialStatus`, `licenceStatus`, `rememberLicence`, `forgetLicence`, `recognizeText`, `shrinkImage`, `addListener`. |
| `onProgress` | `(listener: (e: ProgressEvent) => void): EventSubscription` — `:226` | Subscribes to download progress. The subscription must be removed; `startDownload` does it in a `finally`. |
| `onPlaybackCommand` | `(listener: (e: PlaybackCommandEvent) => void): EventSubscription` — `:230` | Raw notification commands. **Prefer `onNotificationCommand` in `src/player/nowPlaying.ts`**, which filters on card ownership; subscribing here means both engines act on one press. |

**Used by** `src/core/ytdlp.ts`, `src/core/artwork.ts`, `src/core/trial.ts`,
`src/core/license.ts`, `src/core/account.ts`, `src/player/nowPlaying.ts`,
`src/browser/useBackgroundPlayback.ts`, and `src/sheets/SubscribeSheet.tsx`
(`recognizeText` and `shrinkImage` only — the one sheet that calls native
directly, because the picked file is the sheet's own). Nothing else should call
it directly.

**Invariants**

- `publishToGallery` **deletes the source file**. `writeTextFile` does not move
  or delete anything.
- The first `setNowPlaying` has to happen while the app is on screen — Android 12
  onwards refuses to start a foreground service from the background — which is
  why both sources publish on first *play* rather than on load.
- `setPageCommand` is the only channel that reaches a backgrounded WebView.
  `injectJavaScript` queues until the app is next drawn. See `AGENTS.md`,
  "`injectJavaScript` is queued, not run".
- `setWebViewVisible(true)` must be released the moment nothing is playing — a
  pinned WebView goes on decoding video nobody is looking at.
- `onLog` is declared in the Kotlin `Events(...)` and never emitted. Dead.

---

## `src/core/` — logic with no React in it

16 files. Two of them (`artwork.ts`, `trial.ts`) export a hook and are therefore
not quite React-free; everything else is.

### `src/core/engine.ts` — 91 lines

Platform-agnostic type definitions and the seams an iOS backing implementation
would fill. `Format` is the one type the whole app is built on.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `VideoRef` | `{ videoId: string; url: string; title: string }` — `:12` | What identifies a video to the engine. |
| `MediaKind` | `'video' \| 'audio'` — `:18` | |
| `Format` | `{ id; kind; height?; fps?; container; codec; kbps?; size?; muxed }` — `:20` | One rung of a manifest. `id` is a yt-dlp format id and **only means anything inside the manifest that listed it**. `muxed` is true when the stream already carries both tracks. `size` is present only when yt-dlp reported it. |
| `DownloadProgress` | `{ fraction: number \| null; bytesPerSecond?; etaSeconds? }` — `:37` | `fraction` is `null` while the total size is unknown. |
| `DownloadEngine` | `interface` — `:47` | The seam: `listFormats`, `download`, `cancel`, `updateExtractor`. |
| `Muxer` | `interface { remux(...) }` — `:70` | Unimplemented — yt-dlp merges DASH pairs with its own bundled ffmpeg. |
| `ProofOfOriginToken` | `{ poToken; visitorData; expiresAt }` — `:74` | |
| `TokenProvider` | `interface { get, invalidate }` — `:88` | Unimplemented — Android reads tokens off the live page. |

**Depends on** nothing. **Used by** `src/core/ytdlp.ts`,
`src/browser/formatView.ts`, `src/browser/BrowserScreen.tsx` — all three for
`Format` only. `VideoRef` and `DownloadProgress` reach `ytdlp.ts`; the four
interfaces and `MediaKind` are referenced nowhere outside this file.

### `src/core/ytdlp.ts` — 716 lines

The engine bridge. Owns the client walk, the manifest parse, the format selector
and the resume key. Parsing lives here rather than in Kotlin so `Format` has
exactly one definition.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `IS_PREVIEW` | `false` — `:22` | A dry-run switch. Read in `BrowserScreen`; shipping it as `true` simulates saves without writing files. |
| `VideoMeta` | `{ id; title; channel; durationSeconds; formats: Format[] }` — `:24` | A parsed manifest, with names already cleaned. |
| `initEngine()` | `Promise<string>` — `:322` | Extracts the bundled Python and loads the client scoreboard, once. Every path that walks a chain awaits this first. |
| `engineVersion()` | `() => Promise<string>` — `:340` | |
| `updateEngine()` | `async () => Promise<UpdateResult>` — `:342` | Pulls a newer extractor at runtime. The app's only self-repair path. |
| `shape(formats)` | `(readonly Format[]) => Record<string, unknown>` — `:348` | A manifest in one log line: totals per kind plus the top eight heights. |
| `listFormats(ref, token?)` | `(ref: VideoRef, token?: { poToken?; visitorData? } \| null) => Promise<VideoMeta>` — `:360` | Walks the client chain, parses, judges, dedupes. **One of the two boundaries where a name enters the app** — every download path reads the `title` it returns, and it becomes the filename in the gallery. |
| `startDownload(args, onTick)` | `(args: { id; ref; format; audioOnly; token?; seconds? }, onTick: (p: DownloadProgress) => void) => { promise: Promise<{ path; bytes }>; cancel: () => void }` — `:443` | Starts one job. Returns synchronously with a cancel handle; the promise settles when the file is written or the engine gives up. |
| `publishToGallery(path, title, audioOnly)` | `=> Promise<string>` — `:554` | MediaStore insert. Returns a `content://` uri and deletes the source. |
| `writeTextFile(name, mime, body)` | `=> Promise<string>` — `:563` | A playlist or a backup into `Downloads/Spool`. Here rather than called through the module directly so every native call goes through one file. |
| `scanSaved()` | `=> Promise<SavedItem[]>` — `:567` | |
| `signOutOfYouTube()` | `=> Promise<void>` | Drops this device's YouTube session: every cookie, the WebView's DOM storage, and any cookie jar on disk. **Not** a sign-out at Google. Resolves after the removal, so the caller can remount the WebView without racing it. |
| `setSecureWindow(on)` | `(boolean) => void` | FLAG_SECURE on the app's window. Held only while the page is on a Google sign-in host — it is per-window, so leaving it on would stop the user screenshotting their own library. |
| `partialKey(videoId, audioOnly, format)` | `=> string` — `:615` | The name on disk this attempt writes under: `` `${id}.${audioOnly ? 'a' : 'v' + height}` ``. |

Private but load-bearing, and the reason to open this file: `OPEN_CHAIN` (`:74`,
`['tv', null, 'web_embedded', 'mweb', 'android_vr']`), `TOKEN_CHAIN` (`:89`,
`['mweb', 'web']`), `looksBlocked` (`:133`), `attempts` (`:158`),
`withClientFallback` (`:195`), `judgeManifest` (`:311`), `selector` (`:620`),
`dedupe` (`:680`).

**Depends on** `modules/ytdlp`, `./clients`, `./engine`, `./log`, `./metadata`.
**Used by** `src/browser/BrowserScreen.tsx` — and only it. Everything downstream
of a download goes through the shell.

**Invariants**

- **Retune the client list here, not in Kotlin.** Without a PO token the default
  chain 403s; `AGENTS.md`, "yt-dlp needs an explicit `player_client`".
- **A client can refuse by answering.** `judgeManifest` exists because a
  successful manifest holding one muxed 360p and nothing else used to win the
  walk and get pinned for the session. A judged-degraded result is kept as a
  fallback rather than discarded, so judging too harshly costs time and never a
  download. See [FLOWS.md § 15](FLOWS.md#15-extraction-refused-client-walk-and-self-repair).
- **Every branch of `selector` ends in a term that cannot name nothing.** Ids
  only mean something inside their own manifest and `bestaudio` is itself absent
  from a degraded one, so both branches tail in `best`. Without it yt-dlp says
  `Requested format is not available`.
- **`partialKey` must not be built from a title and must carry the quality.**
  The filesystem counts bytes; a `.part` belongs to one format and resuming a
  720p body into a 1080p file corrupts it.
- **A shared resume name means "a file with this name exists" is no longer proof
  that this attempt wrote one.** Anything reading the download directory has to
  make the same distinction the Kotlin `finished()` does.
- `preferredOpen`, `preferredToken`, `triedUpdate` and the `initEngine` promise
  are module-level and outlive a screen. Tests re-import under `?fresh=n`.

### `src/core/clients.ts` — 188 lines

Which InnerTube client to ask first, scored per `(mode, client)` and persisted,
so a cold start does not re-pay a walk the device has already lost.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Mode` | `'open' \| 'token'` — `:42` | Which leg of the walk a score belongs to. A client pinned while tokenless means something different on a request that carries one. |
| `loadClientScores()` | `Promise<void>` — `:84` | Reads the board once. Called from `initEngine`, not at import time. |
| `clientWon(mode, client)` | `(Mode, string \| null) => void` — `:129` | |
| `clientLost(mode, client)` | `(Mode, string \| null) => void` — `:139` | Also scored for a *degraded answer*: from the user's side, one muxed 360p and a 403 are the same event. |
| `orderChain<T>(mode, base)` | `<T extends string \| null>(mode: Mode, base: readonly T[]) => T[]` — `:149` | The base chain reordered by score. Differences under `0.5` keep the base order. |
| `forgetClientScores()` | `void` — `:170` | Wipes the board. Called when the engine replaces its own extractor — the board describes software no longer installed. |
| `clientScores()` | `Record<string, number>` — `:176` | Rounded, for the log. |
| `resetClientScores()` | `void` — `:183` | Test-only: clears the board *and* the loaded latch. |

**Depends on** AsyncStorage, `./log`. **Used by** `src/core/ytdlp.ts`, and the
tests.

**Invariants**

- It only ever **reorders**, never removes. A board that has learned something
  wrong costs time and can never be the reason a download fails.
- **Tests must call `resetClientScores()` in `beforeEach`.** This is a module
  singleton that deliberately outlives a session, so `import(…?fresh=N)` cannot
  reach it — `ytdlp.ts` gets a fresh copy and shares one scoreboard with every
  other copy. See `AGENTS.md`, "The client chain reorders itself across
  launches".

### `src/core/tokens.ts` — 113 lines

PO tokens, kept per video id, synchronously, capped at 60.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Token` | `{ poToken: string; visitorData: string; mintedAt: number }` — `:25` | |
| `TokenView` | `{ poToken?: string; visitorData?: string }` — `:32` | What a caller is given: fields are absent rather than empty. |
| `TTL_MS` | `6 * 60 * 60 * 1000` — `:42` | |
| `remember(videoId, next)` | `(videoId: string, next: Partial<Token> & { mintedAt: number }) => void` — `:59` | Merges over what is held, so a `visitorData`-only report does not erase a token. Re-inserts to refresh LRU order. |
| `tokenFor(videoId, now)` | `(videoId: string \| null \| undefined, now: number) => TokenView` — `:89` | Expired entries are deleted on read. |
| `hasToken(videoId, now)` | `=> boolean` — `:104` | |
| `summary()` | `=> { videos: number }` — `:108` | |
| `reset()` | `=> void` — `:111` | Test-only. |

**Depends on** nothing. **Used by** `src/browser/BrowserScreen.tsx` (`remember`,
`tokenFor` only) and the tests.

**Invariants**

- **A token is bound to a video id.** Spending A's token on B is not a weaker
  request, it is the wrong one, and the media fetch 403s. Never key this store
  on anything else.
- Reads must stay synchronous — every download path reads on the way past and
  none can wait for storage.

### `src/core/storage.ts` — 404 lines

AsyncStorage persistence, plus `adoptSaved`, the one function that can resurrect
something the user deleted.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `DownloadRecord` | `{ id; title; quality; uri?; bytes?; audioOnly; savedAt; state: 'saved' \| 'failed'; error?; auto?; videoId?; artist?; seconds? }` — `:17` | One library row. A manual save has a `content://` uri; an automatic one has a `file://` path, because hundreds of automatic saves do not belong in the gallery. `artist` is copied off the play index at save time, not read from it later — the index evicts already-saved entries first, so the one row guaranteed to be dropped is this one's. |
| `mediaKey(uri?)` | `(uri?: string) => string` — `:76` | The identity of a MediaStore row independent of the volume it was reached through. `external_primary` and `external` are the same row; comparing strings never matched, and every manual save was adopted a second time on the next launch. |
| `dedupeByFile(records)` | `(DownloadRecord[]) => DownloadRecord[]` — `:131` | Collapses rows describing one file. The app's own record wins over a `found:` row, so the replay rule can still recognise the video. Returns the **same array** when nothing merged, so a healthy launch writes nothing. |
| `adoptSaved(existing, found, forgotten?)` | `(DownloadRecord[], {uri;title;bytes;savedAt;audioOnly;artist;durationMs?}[], string[]) => DownloadRecord[]` — `:171` | Folds the gallery into the library. Adopted ids are `found:${uri}` so a second scan recognises its own work. |
| `Settings` | `{ enabled; after; keepAs; audioQuality; videoQuality; instant }` — `:219` | `instant` (a deliberate tap) is separate from `keepAs` (what the rule keeps) on purpose. |
| `DEFAULT_SETTINGS` | `Settings` — `:228` | `{ enabled: true, after: 3, keepAs: 'audio', audioQuality: 'Best available', videoQuality: '1080p', instant: 'audio' }` |
| `hasSeenFirstRun()` / `markFirstRunSeen()` | `Promise<boolean>` / `Promise<void>` — `:237`, `:245` | |
| `loadDownloads()` / `saveDownloads(records)` | `Promise<DownloadRecord[]>` / `Promise<void>` — `:274`, `:285` | Load runs every row through `named` (private, `:267`) so a library collecting uploader titles for weeks reads like a fresh one. Save caps at 200. |
| `loadSettings()` / `saveSettings(s)` | `:298`, `:310` | Load merges over `DEFAULT_SETTINGS`, so an older blob is missing keys rather than breaking the screen. |
| `PlaybackSession` | `{ ids: string[]; index: number; at: number }` — `:326` | |
| `loadSession()` / `saveSession(s \| null)` | `:333`, `:349` | Saving `null` or an empty queue removes the key. |
| `loadForgotten()` / `saveForgotten(uris)` | `:367`, `:378` | Capped at 500. |
| `loadSearches()` / `saveSearches(q)` | `:387`, `:398` | Capped at 8. |

**Depends on** AsyncStorage, `./metadata`. **Used by**
`src/browser/BrowserScreen.tsx`, `src/core/artwork.ts`, `src/core/export.ts`,
`src/core/playlists.ts`, `src/player/PlayerContext.tsx` (for `saveSession`).

**Invariants**

- **`forgotten` is what stops a rescan undoing a removal.** Removing a saved row
  keeps the file and promises so; without that set the next launch adopts it back.
- **A session is stored as ids, not tracks**, so a row removed while the app was
  closed cannot resurrect as a queue entry pointing at something no longer listed.
- **Every loader swallows its own error and returns something usable.** Corrupt
  JSON, an older build's blob, a full disk — the caller gets a value, never a
  throw. `tests/storage.test.mjs` is mostly about proving that.
- An adopted row has **no `videoId`**, so it cannot tell the replay rule it
  already exists. Deliberate; see the comment at `:103`.

### `src/core/plays.ts` — 109 lines

The play index. The only file in the app that records behaviour rather than
results, and there is no network call in it.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `PlayStat` | `{ id; title; artist; starts; seconds; lastAt; music?; savedAt? }` — `:26` | Three numbers per video and no history of *when*. `savedAt` is set when the rule takes one — its presence is what stops the rule firing again, so it is set even when the download later fails. |
| `PlayIndex` | `Record<string, PlayStat>` — `:48` | |
| `loadPlays()` / `savePlays(index)` / `clearPlays()` | `:50`, `:61`, `:70` | Save trims to 300, saved-first then least-recent. |
| `describePlays(stat)` | `=> string` — `:97` | `"3 plays · 41 min"` — the phrasing used wherever a stat is shown. |
| `ranked(index)` | `=> PlayStat[]` — `:105` | Most-played first, then longest, then most recent. The order "On repeat" wants. |

**Depends on** AsyncStorage. **Used by** `src/browser/usePlayTracking.ts`,
`src/browser/BrowserScreen.tsx`. `clearPlays` is reached only by the tests.

**Invariants**

- Nothing here is ever sent anywhere, and there must not be a network call in
  this module. See [FEATURES.md § 14](FEATURES.md#14-privacy).

### `src/core/metadata.ts` — 324 lines

What a thing is called. The single answer, applied at exactly two boundaries.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `isPackaging(fragment)` | `(string) => boolean` — `:89` | True when every word in the fragment is marketing, a resolution or a year — i.e. the fragment carries no name. |
| `cleanArtist(raw)` | `(string \| undefined \| null) => string` — `:116` | Strips the `- Topic` suffix and tidies. Returns `''` for nothing. |
| `cleanTitle(raw, artist?)` | `(string, string?) => string` — `:144` | Removes packaging brackets, picks the real pipe segment, drops a leading `Artist -` when the artist is known, drops a trailing packaging dash. **Only ever removes**, so running it twice changes nothing. |
| `ArtistHints` | `ReadonlySet<string> \| readonly string[]` — `:192` | |
| `splitArtist(title, known)` | `(string, ArtistHints) => { artist; title } \| null` — `:223` | Splits `Artist - Song` only when the left side is a name the library already knows, is ≤40 chars and ≤5 words. |
| `RawNames` | `{ title: string; artist?: string \| null }` — `:250` | |
| `CleanNames` | `{ title: string; artist: string; raw: string }` — `:255` | `raw` is the title as it arrived. |
| `clean(raw, known?)` | `(RawNames, ArtistHints) => CleanNames` — `:283` | The entry point. Memoised on the last call, because the page reports about once a second. |
| `knownArtists(...sources)` | `(...readonly { artist?: string \| null }[][]) => Set<string>` — `:313` | The hint set, built from whatever rows are to hand. |

**Depends on** nothing. **Used by** `src/core/ytdlp.ts` (`clean` in `parseMeta`),
`src/core/storage.ts` (`cleanTitle`/`cleanArtist` in `named`),
`src/browser/BrowserScreen.tsx` (`clean`, `knownArtists`).

**Invariants**

- **Applied at two boundaries, not at the dozen places a name is used**:
  `listFormats` in `core/ytdlp.ts`, and the `media` branch of `onMessage` in
  `BrowserScreen`. Cleaning at the boundary is what stops one of the call sites
  being forgotten. See [ARCHITECTURE.md § 2](ARCHITECTURE.md#2-layer-map).
- The file is not valid UTF-8 by `file(1)`'s reckoning — it contains styled
  Unicode in comments, which is why `grep` reports it as binary. Use `grep -a`.

### `src/core/similar.ts` — 176 lines

Whether two rows are the same thing. Used to warn before a second download of
something already saved.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `titleTokens(title)` | `(string) => Set<string>` — `:66` | Words with brackets, punctuation, one-character tokens and packaging removed. |
| `titleOverlap(a, b)` | `(string, string) => { containment: number; jaccard: number }` — `:102` | Both zero when fewer than two tokens overlap — one shared word is not evidence. |
| `titleScore(a, b)` | `(string, string) => number` — `:119` | Containment alone. Referenced only by the tests. |
| `Candidate` | `{ videoId?; title; seconds?; state? }` — `:121` | |
| `Match<T>` | `{ kind: 'exact' \| 'similar'; record: T }` — `:129` | |
| `findDuplicate(library, wanted)` | `<T extends Candidate>(readonly T[], Candidate) => Match<T> \| null` — `:138` | An id match is `exact`. Otherwise: with both runtimes known, ±3s and 0.5 containment; without, 0.8 containment *and* 0.6 Jaccard. Failed rows are never candidates. |
| `runtimeLabel(seconds?)` | `=> string` — `:171` | `"4:07"`, or `''` for unknown. |

**Depends on** nothing. **Used by** `src/browser/BrowserScreen.tsx`.

### `src/core/playlists.ts` — 269 lines

The one list the app never rearranges. Pure functions over an immutable array.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Playlist` | `{ id; name; trackIds: string[]; createdAt; updatedAt }` — `:36` | Download **ids**, in the user's order. |
| `AddResult` | `{ playlists: Playlist[]; added: number; duplicate: number }` — `:46` | Both counts, so the caller can say "3 added, 1 already there". |
| `loadPlaylists()` / `savePlaylists(p)` | `:53`, `:77` | Load validates each row and fills missing timestamps; save caps at 50 lists. |
| `tidyName(name)` | `=> string` — `:87` | Collapses whitespace, trims, 60 chars. |
| `uniqueName(playlists, base)` | `=> string` — `:98` | Appends ` 2`, ` 3`… up to 99. |
| `createPlaylist(playlists, name, now)` | `=> { playlists; created } \| null` — `:109` | `null` at the 50 cap or on an empty name. |
| `renamePlaylist(playlists, id, name, now)` | `=> Playlist[]` — `:131` | |
| `deletePlaylist(playlists, id)` | `=> Playlist[]` — `:145` | |
| `addTracks(playlists, id, trackIds, now)` | `=> AddResult` — `:158` | Caps at 500 tracks. Returns the input array untouched when nothing was added. |
| `removeTrack(playlists, id, trackId, now)` | `=> Playlist[]` — `:189` | |
| `moveTrack(playlists, id, trackId, delta, now)` | `=> Playlist[]` — `:212` | Out-of-range moves are no-ops. |
| `resolve(playlist, records)` | `(Playlist \| null \| undefined, readonly DownloadRecord[]) => DownloadRecord[]` — `:239` | Ids to rows, skipping what is not saved or has no uri. |
| `describePlaylist(playlist, records)` | `=> string` — `:254` | `"Empty"` or `"7 tracks"`. |
| `playlistsWith(playlists, trackId)` | `=> Playlist[]` — `:264` | |

**Depends on** AsyncStorage, `./storage` (type only). **Used by**
`src/browser/BrowserScreen.tsx`, `src/core/export.ts`.

**Invariants**

- **A playlist's stored ids are never pruned.** `resolve` skips what it cannot
  find and nothing writes that back. An id that resolves to nothing today may be
  a library that has not finished loading — downloads load asynchronously and
  gallery adoption lands later still — so pruning on load would empty every
  playlist on one slow launch, permanently. See
  [ARCHITECTURE.md § 4](ARCHITECTURE.md#4-where-state-lives).

### `src/core/lyrics.ts` — 255 lines

The only non-YouTube request in the app, and its consent gate.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `LyricLine` | `{ at: number; text: string }` — `:48` | |
| `Lyrics` | `{ lines: LyricLine[]; plain: string; synced: boolean }` — `:50` | |
| `lyricsKey(artist, title)` | `=> string` — `:72` | Lowercased `artist\|title`. **Not** a download id — the same song saved twice asks once. |
| `hasLyricsConsent()` / `setLyricsConsent(agreed)` | `Promise<boolean>` / `Promise<void>` — `:107`, `:117` | Absent means no. |
| `parseLrc(lrc)` | `(string) => LyricLine[]` — `:134` | Handles multiple stamps on one line and both 2- and 3-digit fractions. Sorted. |
| `lineAt(lines, seconds)` | `(readonly LyricLine[], number) => number` — `:164` | Index of the line in force, or `-1` before the first. |
| `cachedLyrics(key)` | `=> Promise<Lyrics \| null \| undefined>` — `:180` | Three states, and the distinction is the point: `undefined` is "never asked", `null` is "asked, there are none". |
| `fetchLyrics({ artist, title, seconds? })` | `=> Promise<Lyrics \| null>` — `:195` | Returns `null` immediately without consent. 8s timeout, 404 cached as `null`. |
| `forgetLyrics()` | `=> Promise<void>` — `:248` | Referenced nowhere. |

**Depends on** AsyncStorage, `fetch`. **Used by** `src/player/useLyrics.ts`,
`src/player/PlayerScreen.tsx` (`lineAt`, `LyricLine`).

**Invariants**

- **`fetchLyrics` must not be reachable without consent.** It re-checks itself
  rather than trusting the caller. See
  [FEATURES.md § 14](FEATURES.md#14-privacy).

### `src/core/artwork.ts` — 202 lines

Cover resolution, and the module-level index screens read synchronously.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Artwork` | `{ uri: string; dominant: string }` — `:29` | |
| `onArtworkChange(fn)` | `(() => void) => () => void` — `:73` | Subscribe; returns the unsubscribe. |
| `loadArtworkIndex()` | `Promise<void>` — `:88` | Once per process. |
| `artworkFor(id)` | `(string) => Artwork \| null` — `:101` | **Synchronous.** Never triggers a fetch. |
| `resolveArtwork(record)` | `(DownloadRecord) => Promise<Artwork \| null>` — `:125` | Keyed on `record.id`; tries the file's own tags, then `i.ytimg.com`. |
| `resolveVideoArtwork(videoId)` | `(string) => Promise<Artwork \| null>` — `:147` | Keyed `yt:${videoId}` — a page, not a file. |
| `useArtworkVersion()` | `() => number` — `:190` | A counter that changes when the index does. Screens read `artworkFor` synchronously and use this only to know when to look again. |
| `forgetArtwork(id)` | `(string) => void` — `:197` | |

**Depends on** `modules/ytdlp`, AsyncStorage, `./storage` (type only), React.
**Used by** `src/browser/BrowserScreen.tsx`,
`src/browser/useBackgroundPlayback.ts`, `src/player/NowPlayingBar.tsx`,
`src/player/PlayerContext.tsx`, `src/player/PlayerScreen.tsx`.

**Invariants**

- `{ failedAt }` in the index is a **remembered failure**, believed for
  `RETRY_FAILED_MS` (24 h) and then asked again. A bare `null` is a failure
  stored before failures carried a time, and is retried. A cover whose cached
  file is gone is dropped by `dropMissingCovers` at load.
- Three concurrent native reads at most (`MAX_PARALLEL`, `:52`), and the index is
  flushed on a 2-second debounce — which is the documented cause of
  `tests/artwork.test.mjs`'s intermittent full-suite failure.

### `src/core/export.ts` — 159 lines

Playlists and backups, as files that outlive the app. Pure — it builds strings
and never writes them.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `ExportFile` | `{ name: string; mime: string; body: string }` — `:29` | What `writeTextFile` wants. |
| `fileNameFor(name, extension)` | `(string, string) => string` — `:38` | Replaces `\/:*?"<>\|`, trims to 80 chars, falls back to `Playlist`. |
| `playlistToM3u(playlist, records, artistFor?)` | `=> ExportFile` — `:66` | `#EXTM3U` with `#EXTINF` per track; unknown runtimes are `-1`. |
| `Backup` | `{ format: 'spool-backup'; version: 1; exportedAt; playlists: {...}[] }` — `:91` | Titles and artists, not uris — a uri is meaningless on another device. |
| `buildBackup(playlists, records, now, artistFor?)` | `=> ExportFile` — `:110` | Named `spool-backup-YYYY-MM-DD.json`. |
| `describeExport(playlists, records)` | `=> string` — `:152` | `"3 playlists · 41 tracks"`. |

**Depends on** `./storage` and `./playlists` (types, plus `resolve`).
**Used by** `src/browser/BrowserScreen.tsx`.

**Invariants**

- Nothing here reads these files back. Import is not built; see
  [FEATURES.md § 4](FEATURES.md#4-library).

### `src/core/license.ts` — 313 lines

Describes the subscription and fetches tokens. **Never enforces it** —
`LicenseGuard.kt` does.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Plan` | `'monthly' \| 'annual'` | |
| `PRICES` | `Record<Plan, {amount, per, note}>` | `₹29` / `₹249`. Notes say payment is manual UPI and nothing renews. The annual note prints `₹20.75 a month`, arithmetic on a real price. |
| `LicenceView` | `LicenceStatus & { paidThrough }` | What screens read. |
| `refreshLicence()` | `() => LicenceStatus` | Re-reads the native side; one ECDSA verification, no network. |
| `licence()` | `() => LicenceView` | The cached copy, synchronously. |
| `loadLicenceFacts()` | `() => Promise<void>` | Reads `dl.licence` at boot. |
| `rememberPaidThrough(ms, plan)` | | Persists the subscription end. Used by `syncLicence` and `payments.ts`. |
| `daysLeft(view?)` | `({paidThrough}) => number \| null` | Days to **`paidThrough`**, ceiling, never negative; `null` when unknown. Never reads the token's lease. |
| `syncLicence({force})` | `(opts) => Promise<boolean>` | Authenticated `/v1/licence`; skipped signed out. Hands any token to `rememberLicence`, records `paidThrough`, honours `refreshAfter` (floored at 5 min, capped at 6 h). Returns whether anything **changed**. |
| `watchLicence()` | `() => () => void` | Syncs on every return to the foreground. Registered by `BrowserScreen`. |
| `forgetLicence()` | `() => void` | Native forget + clears `dl.licence`. |
| `setPaywallOpener(fn)` / `openPaywall(reason?)` | | Same registry shape as `setPreReleaseOpener`. |
| `useLicence()` | `() => LicenceView` | |
| `reset()` | `() => void` | Test seam. |

**Depends on** `modules/ytdlp`, `src/core/account.ts`, `src/core/log.ts`,
AsyncStorage, React, `react-native` (AppState). Registers an
`onSessionEnded` handler at module load. **Used by**
`src/browser/BrowserScreen.tsx`, `src/screens/ProfileScreen.tsx`,
`src/screens/OnboardingScreen.tsx`, `src/sheets/SubscribeSheet.tsx`,
`src/sheets/AccountSheet.tsx`, `src/core/payments.ts`, `src/core/trial.ts`,
`src/ui/TrialChip.tsx`.

**Invariants**

- **Nothing here is permission.** `LicenseGuard` decides.
- **No answer from the server ever revokes a licence** — except a session the
  server definitely ended, which `account.ts` handles.
- **A failed sync does not start the rate-limit gap.**
- **The device id comes from native and only native.**

### `src/core/account.ts` — 437 lines

The Spool account and the one request function for the licence server.

| Symbol | Signature | Meaning |
|---|---|---|
| `loadAccount()` | `() => Promise<Account>` | Memoised read of `dl.account` and `dl.serverContact`. Every authenticated request awaits it. |
| `account()` / `signedIn()` / `lastServerContact()` | sync | |
| `request(path, {method, body, auth, timeoutMs})` | `=> Promise<Reply>` | JSON or `FormData` body; Bearer session when `auth`. `Reply` is `ok \| refused \| signed-out \| blocked \| offline \| unconfigured`. **The only place the 401 "signed out" / 403 "blocked" rule is written.** Marks server contact on any parsed non-5xx answer. |
| `register(email, pw)` / `login(email, pw)` | `=> Promise<string \| null>` | `null` on success, else the copy to show. |
| `logout()` | `=> Promise<void>` | Local first; server told best-effort; forgets the licence. |
| `fetchAccount()` | `=> Promise<AccountDetails \| null>` | `/v1/account`, shaped. |
| `explainAuthError(reply)` | pure | Server refusal → sentence. |
| `deviceLabel()` / `endpoint()` | | `Platform.constants` Manufacturer + Model; server and device from `licenceStatus()`. |
| `onSessionEnded(fn)` | | Registry; `license.ts` uses it to avoid an import cycle. |
| `useAccount()` | hook | |
| `setAccountOpener` / `openAccount(intent)` | | `intent`: `{ next?: 'paywall', reason?, blocked? }`. |
| `reset()` | | Test seam. |

**Depends on** `modules/ytdlp`, `src/core/log.ts`, AsyncStorage, React,
`react-native` (Platform). Imports nothing else from `src/core/` on purpose.

### `src/core/payments.ts` — 290 lines

UPI orders and screenshot claims.

| Symbol | Signature | Meaning |
|---|---|---|
| `SUPPORT_WHATSAPP` / `supportWhatsapp()` | | The fallback support number, replaced by the server's once known. |
| `whatsappUrl(number, message)` | pure | `https://wa.me/<digits>?text=<encoded>`. |
| `formatRupees(paise)` / `formatDate(ms)` | pure | `₹29`, `₹29.50`; `12 Mar 2027`. |
| `startPayment(plan)` | `=> Promise<Started>` | `/v1/pay/start`. |
| `claimParts(order, uri, text)` | pure | The multipart fields, in order. |
| `submitScreenshot(order, uri, text)` | `=> Promise<Claim>` | `/v1/pay/claim`. On `approved` records `paidThrough`, clears the pending order and force-syncs the licence **before** resolving. |
| `savePendingOrder` / `loadPendingOrder` / `clearPendingOrder` | | `dl.pendingOrder`. |

**Depends on** `src/core/account.ts`, `src/core/license.ts`, `src/core/log.ts`,
AsyncStorage. **Used by** `SubscribeSheet`, `AccountSheet`, `ProfileScreen`
(`formatDate`).

### `src/core/playLock.ts` — 248 lines

One account, one device playing. See FLOWS § 19.

| Symbol | Signature | Meaning |
|---|---|---|
| `OFFLINE_GRACE_MS` / `HEARTBEAT_MS` | 24 h / 60 s | |
| `judge(reply, now, lastContact)` | pure → `Verdict` | The whole decision. |
| `playPermitted(now?)` | sync | The fast path: signed out, or a live lease/permit. |
| `claimPlay(retry?)` | `=> Promise<boolean>` | Claim before sound; raises the notice on refusal. |
| `takeOver()` | `=> Promise<boolean>` | "Play here instead"; runs the held retry. |
| `beat(playing, pause, resume?)` | `=> Promise<void>` | The heartbeat. 409 → pause + "moved" notice; not playing → release. |
| `releasePlay()` | | Best-effort release of a held lease. |
| `playNotice()` / `dismissPlayNotice()` / `usePlayNotice()` | | The notice store the shell renders. |

**Depends on** `src/core/account.ts`, `src/core/log.ts`, React. **Used by**
`src/player/PlayerContext.tsx`, `src/sheets/PlayLockSheet.tsx`,
`src/browser/BrowserScreen.tsx`.

### `src/core/trial.ts` — 131 lines

Describes the pre-release limits. **Never enforces them** — `TrialGuard.kt` does.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `CONTACT_EMAIL` | `'connect@afinitycode.com'` — `:17` | |
| `TRIAL_PRICE` / `LAUNCH_PRICE` | `'₹399'` / `'₹999'` — `:28`, `:29` | |
| `refreshTrial()` | `() => TrialStatus` — `:45` | Re-reads the native side and notifies every `useTrial`. Falls back to a permissive `OFFLINE` shape if the call throws. |
| `trial()` | `() => TrialStatus` — `:56` | The cached copy, synchronously. |
| `daysLeft(status?)` | `(TrialStatus) => number` — `:59` | Ceiling, so a part-day still reads as a day. |
| `savesLeft(status?)` | `(TrialStatus) => number` — `:65` | Never negative. |
| `refuseSave(seconds, status?)` | `(number, TrialStatus) => string \| null` — `:75` | The sentence to show, or `null` to allow. Order: modified build, expired, out of saves, too long. |
| `setPreReleaseOpener(fn)` | `((() => void) \| null) => void` — `:107` | The shell registers the sheet opener here. |
| `openPreRelease()` | `() => void` — `:110` | So the trial chip can open the sheet from three screen headers without any of them carrying a prop. |
| `useTrial()` | `() => TrialStatus` — `:113` | |

**Depends on** `modules/ytdlp`, `src/core/license.ts`, React. **Used by**
`src/browser/BrowserScreen.tsx`, `src/sheets/PreReleaseSheet.tsx`,
`src/ui/TrialChip.tsx`.

**Invariants**

- **`refuseSave` returning `null` is not permission.** The Kotlin decides; this
  only words the refusal. A patched JS bundle gets a UI that lies and a native
  layer that still says no. See `AGENTS.md`, "The trial is enforced in Kotlin,
  described in TypeScript".

### `src/core/log.ts` — 430 lines

The flight recorder: a bounded in-memory ring, flushed to AsyncStorage on a
debounce and immediately on any error, with the previous run moved aside at boot.
Nothing subscribes to it and no screen re-renders from it.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Level` | `'debug' \| 'info' \| 'warn' \| 'error'` — `:27` | |
| `Entry` | `{ t; level; scope; msg; flow?; ms?; data? }` — `:29` | |
| `setVerbose(on)` / `isVerbose()` | `:73`, `:77` | `debug` is dropped unless verbose. `isVerbose` is referenced nowhere. |
| `setMirror(fn)` | `(((e: Entry) => void) \| null) => void` — `:88` | One extra sink. `crash.ts` uses it for the debug-build logcat echo. |
| `redact(data)` | `(Record<string, unknown> \| undefined) => Record<string, unknown> \| undefined` — `:145` | Depth 2, 24 keys, 2000-char strings, and **key-matched** secret elision. |
| `debug` / `info` / `warn` / `error` | `(scope: string, msg: string, data?: Record<string, unknown>) => void` — `:205`–`:211` | |
| `describe(e)` | `(unknown) => Record<string, unknown>` — `:224` | Name, code, message — and the stack **only when there is no `code`**. |
| `Flow` | `{ id; step; ok; fail; gaveUp; elapsed }` — `:257` | |
| `flow(scope, name, data?)` | `=> Flow` — `:284` | Opens a correlated sequence. Every entry carries the flow id and ms since it opened. |
| `restore()` | `Promise<void>` — `:313` | Moves `dl.log` to `dl.log.prev`. Once per process. |
| `previous()` | `Promise<Entry[]>` — `:328` | |
| `flush()` | `Promise<void>` — `:338` | No-op when not dirty. |
| `entries()` | `() => readonly Entry[]` — `:350` | |
| `clear()` / `reset()` | `:352`, `:359` | `clear` empties and flushes; `reset` is test-only and also drops the mirror, the timer and the restore latch. |
| `line(e)` | `(Entry) => string` — `:388` | One formatted line. |
| `dump(prev, now, header?)` | `=> string` — `:409` | The export file, **previous run first**. |

**Depends on** AsyncStorage. **Used by** `src/browser/BrowserScreen.tsx`,
`src/core/bootstrap.ts`, `src/core/clients.ts`, `src/core/crash.ts`,
`src/core/ytdlp.ts`, `src/ui/ErrorBoundary.tsx`.

**Invariants**

- **It never throws, never blocks, and never records a credential.** It runs on
  the failure path. `record` (`:184`) wraps everything in a `try`/`catch` that
  does nothing.
- **`redact` matches on the *key*, not the value** — a token has no shape worth
  matching. The corollary bites: a field with "token" in its *name* is elided
  whatever it holds, which is why `ytdlp.ts` logs `mode` rather than `tokened`.
- **`describe` drops the stack when a `code` is present.** A coded error was
  built by `CodedError` on the way out of the bridge: the stack names the bridge
  and a bundle URL while the real failure is already in `message`. Measured at
  ~700 bytes per refused client, of which about 30 were about the refusal.
- See [FEATURES.md § 16](FEATURES.md#16-diagnostics--the-flight-recorder).

### `src/core/crash.ts` — 168 lines

The three captures the app is never told about directly.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `installDiagnostics()` | `() => void` — `:135` | Idempotent. Bridges `console`, installs the global error handler, enables rejection tracking, and in `__DEV__` mirrors every entry to logcat. |
| `resetInstalled()` | `() => void` — `:166` | Test-only. |

**Depends on** `./log`, `promise/setimmediate/rejection-tracking`. **Used by**
`src/core/bootstrap.ts`.

**Invariants**

- **The dev echo goes through `console.log` only** (`:160`). React Native's
  LogBox covers the bottom of the screen, which is where the notice strip and
  the format sheet are; mirroring to `warn` or `error` hides the surface under
  test. See `AGENTS.md`.
- The console bridge folds existing `[spool] …` lines into the same record by
  stripping the prefix (`:53`), and skips `scope === 'console'` when mirroring
  so the bridge cannot feed itself.

### `src/core/bootstrap.ts` — 25 lines

Exists only to win a race. Three statements, run as a side effect of import.

**Exports** — none. `installDiagnostics()` at `:18`, `void restore()` at `:23`,
`info('boot', 'bundle loaded')` at `:25`.

**Depends on** `./crash`, `./log`. **Used by** `index.ts`, as its first import.

---

## `src/browser/` — the WebView half

12 files, of which three are v1 leftovers (see the last section).

### `src/browser/BrowserScreen.tsx` — 3,224 lines

The shell. Five tabs, one WebView, all four download paths, the library records, the
job list, and every sheet. That size is a consequence of one rule: **the WebView
is mounted once and never unmounted**, only hidden behind whichever tab is
showing — so everything that has to survive a tab change lives above the tabs,
which means here.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `BrowserScreen` | `function BrowserScreen()` — `:201` | No props. Reads everything from storage and context. |

**Internal landmarks** — this is what the line numbers are for.

| What | Where |
|---|---|
| `Screen` / `Job` / `SaveRequest` types | `:132`, `:135`, `:176` |
| `stated(message)` — an error whose message is already the sentence to show, coded `E_STATED` | `:190` |
| `PRELOAD` = adblock + potoken + background, one injection | `:199` |
| React state (31 `useState`) | `:207`–`:460` |
| `pauseLocal` / `localSounding` — the playback gate the player context registers | `:299`, `:312` |
| `adoptFromGallery` | `:413` |
| `takeSlot()` — the single-download lock | `:510` |
| `onPlayCounted` → `runAutoSave` ref | `:531`, `:533` |
| Boot effect | `:568` |
| `flashNotice` — the three-second strip | `:794` |
| `onRenderProcessGone` | `:833` |
| `onMessage` — the one handler for `nav`, `potoken` and `media` | `:855` |
| `beginDownload` — the sheet's path | `:1008` |
| `autoSaveStat` — the replay rule's path | `:1193` |
| `saveFromCard` — the notification's path | `:1363` |
| `resolve` — extract, then open the sheet | `:1528` |
| `instantDownload` — the one-tap path | `:1551` |
| `fabState` | `:1657` |
| `playRecord` | `:1780` |
| `forget` | `:1803` |
| `retry` — a failed row's path | `:1831` |
| `exportDiagnostics` | `:2073` |
| `runEngineUpdate` | `:2321` |
| `toTrack` (module scope) | `:2787` |
| `looksStale` / `readableError` | `:3075`, `:3086` |
| `requestNotificationPermission` / `requestMediaPermissions` | `:3152`, `:3176` |
| JSX: WebView `:2375`, FAB `:2409`, notice `:2488`, screens `:2503`–`:2544`, player `:2590`, mini bar `:2615`, tab bar `:2629`, sheets `:2631`–`:2746` | |

**Depends on** essentially everything: `src/core/{ytdlp,storage,plays,similar,metadata,export,playlists,artwork,tokens,trial,log,engine}`,
`src/browser/{adblock,potoken,background,youtube,formatView,usePlayTracking,useBackgroundPlayback,DownloadButton}`,
`src/screens/*`, `src/sheets/*`, `src/shell/TabBar`, `src/player/{PlayerContext,PlayerScreen,NowPlayingBar}`,
`src/ui/{theme,ThemeContext}`. **Used by** `App.tsx`.

**Invariants**

- **`takeSlot()`'s release must sit in a `finally`.** `DownloadService` has one
  `currentId` and one notification; overlapping downloads interfere rather than
  queue. Every one of the four download bodies has an early return on
  `E_CANCELLED`, and a skipped release wedges every later download until the app
  restarts. See `AGENTS.md`, "`DownloadService` has one slot".
- **Several state values are mirrored into refs on purpose** — `settingsRef`,
  `playsRef`, `screenRef`, `forgottenRef`, `cardCanSave`, `cardSave`,
  `runAutoSave`. The WebView's `onMessage` and the notification's command
  listener are subscribed **once**; rebuilding them mid-video drops the messages
  the play counter runs on.
- **Work that needs a permission cannot run in the boot effect.** Permissions are
  requested at the *end* of first run, so anything at boot that touches media
  storage runs unasked and comes back empty. Anything gated on first run must be
  re-run when first run finishes.
- **Auto-downloads must not call `publishToGallery`.** Manual saves belong in the
  user's gallery; hundreds of automatic ones do not.
- **`audioOnly` is the intent, never `format.kind`.** `bestAudio` falls back to a
  muxed format when the manifest has no audio-only rung, so reading the kind back
  off the chosen format answers "video" and saves the wrong thing.
- **Verify the notice strip by screenshot.** `uiautomator dump` cannot see it;
  forty view-tree dumps found nothing while a screenshot in the same second
  showed it drawn correctly.
- The three injected scripts share `PRELOAD` because all three must beat the
  page's own scripts; `NAV_SCRIPT` goes in `injectedJavaScript` instead. See
  [ARCHITECTURE.md § 5](ARCHITECTURE.md#5-the-injected-page-scripts).

### `src/browser/background.ts` — 485 lines

`BACKGROUND_SCRIPT`: the page-side half of browser background playback. Freezes
`document.hidden`, swallows visibility events in the capture phase, and runs a
metered watchdog.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `MediaMessage` | `{ type: 'media'; hasMedia; playing; title; artist; music; id; at; length; wanted }` — `:19` | What the page reports, about once a second. `id` is read from the page's own URL, not from React state. `wanted` is what the page still *intends*, as opposed to what is happening this instant. `music` is the only evidence the "Match" keep-as rule has. |
| `BACKGROUND_SCRIPT` | `string` — `:49` | The injected source. |
| `mediaCommand(name)` | `('play' \| 'pause' \| 'stop') => string` — `:477` | An `injectJavaScript` payload. |
| `seekCommand(seconds)` | `(number) => string` — `:481` | |
| `setPageBackgrounded(value)` | `(boolean) => string` — `:484` | |

The page installs `window.__spoolMedia` (`:460`) with `play`, `pause`, `stop`,
`seek` and `setBackground`.

**Depends on** nothing. **Used by** `src/browser/BrowserScreen.tsx`,
`src/browser/useBackgroundPlayback.ts`, `src/browser/usePlayTracking.ts`.

**Invariants** — every one of these cost a day; `AGENTS.md` carries the
measurements and [FLOWS.md § 17](FLOWS.md#17-browser-background-playback-end-to-end)
the sequence.

- **The page must read its own visibility, never be told.** Learning it from an
  `injectJavaScript` round trip is an unwinnable race: Android pauses the media
  first, the page reads its own pause as deliberate, and the watchdog has nothing
  to restore.
- **A touch is the only usable evidence of intent — timing is not.** Do not
  reintroduce a grace window around backgrounding.
- **A video ending must not clear `wanted`.** Keeping the flag cannot replay the
  finished video (`resume()` refuses an ended element); it only arms the next one.
- **The watchdog must stay metered** — one resume a second, three failures and
  stop. An unmetered one trades play/pause with Chromium sixty times a second and
  exhausts the hardware decoder pool permanently for that renderer.
- **`doPlay` reports when the play promise settles.** A `<video>` reads back as
  unpaused the instant `play()` is called, so reporting eagerly reports a request
  as a fact — and a hidden page's timers are then frozen, so no correction ever
  arrives.
- It must be injected **before** page scripts run, in the capture phase, or
  `stopImmediatePropagation` comes too late to stop YouTube's own pause handler.

### `src/browser/useBackgroundPlayback.ts` — 462 lines

The app-side half: raises and releases the media card for the page, pins the
WebView, and routes notification commands back into it.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `SaveHooks` | `{ canSave: (videoId: string) => boolean; onSave: (video: { id; title; artist }) => void; revision: string }` — `:43` | `revision` is a string that changes whenever `canSave` would answer differently, so the card can be re-raised without re-subscribing anything. |
| `useBackgroundPlayback(webview, save)` | `(RefObject<WebView \| null>, SaveHooks) => { onMedia; pause; reset; toggle; stopPage }` — `:55` | `onMedia` is fed every `MediaMessage`; the other four are what the shell calls. |

**Depends on** `modules/ytdlp`, `src/core/artwork`, `src/player/nowPlaying`,
`./background`, `./pageNowPlaying`, `AppState`. **Used by**
`src/browser/BrowserScreen.tsx`.

**Invariants**

- **`say`/`seek` send both routes** — the injection lands instantly while the app
  is on screen, the `spool_cmd` cookie within a second when it is not. Anything
  new that has to reach the page goes through these, not through
  `injectJavaScript` alone.
- **Never drop the foreground service on `hasMedia: false` alone** (`:281`).
  Autoplay swaps the `<video>` element, so between two tracks the page honestly
  has none; stopping there means the next `raise()` has to start a foreground
  service from the background, which Android 12+ refuses outright.
- **`syncPin` re-evaluates `away && (playing || wanted)` on every report**
  (`:209`). `wanted` is in there because between two tracks a WebView allowed to
  sleep does not come back for the next one.
- **A pause from the card is assumed to have worked; a play is not.** `playCheck`
  (`PLAY_GRACE_MS`, 4s, `:430`) re-publishes as paused when the page did not
  actually start, so the card cannot sit on PLAYING over silence.

### `src/browser/potoken.ts` — 390 lines

`POTOKEN_SCRIPT`: harvests the PO token the page has already minted for itself.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `PoTokenMessage` | `{ type: 'potoken'; poToken; visitorData; videoId; mediaSeen: number; saw: string }` — `:54` | `videoId` is what the token is bound to — a bare token cannot be spent safely. `mediaSeen` counts `videoplayback` URLs; `saw` names which of the harvest points fired. |
| `POTOKEN_SCRIPT` | `string` — `:85` | |

**Depends on** nothing. **Used by** `src/browser/BrowserScreen.tsx`.

**Invariants**

- **Harvest where the data lands, not where you imagine it passes.** The first
  version hooked `JSON.parse`, `fetch` and `XMLHttpRequest.open` and saw nothing
  at all across 25 seconds of playback, for three independent reasons — the watch
  page inlines its first player response, `Response.json()` parses natively in
  C++, and `XHR.open` sees the request rather than the response.
- **`saw` and `mediaSeen` are not decoration.** A diagnostic that cannot tell
  "nothing fired" from "fired and found nothing" is not a diagnostic; that
  ambiguity cost a day and nearly bought a native rewrite that would not have
  helped.

### `src/browser/adblock.ts` — 143 lines

`ADBLOCK_SCRIPT`: three layers — player-response stripping, cosmetic selectors,
and a skip fallback.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `ADBLOCK_SCRIPT` | `string` — `:46` | |

`COSMETIC_SELECTORS` (`:25`) is the private selector list.

**Depends on** nothing. **Used by** `src/browser/BrowserScreen.tsx`.

**Invariants**

- Layers 1 and 3 must be installed before the page's own scripts run. Layer 1 —
  deleting ad fields out of the player response before YouTube's JS reads them —
  is the one that matters; the other two are fallbacks.
- Server-side stitched ads survive all of it, and that is stated in the file
  rather than pretended away.

### `src/browser/youtube.ts` — 160 lines

URL parsing and `NAV_SCRIPT`, the after-load reporter for SPA navigation.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `HOME_URL` | `'https://m.youtube.com'` — `:5` | Standard YouTube mobile entry point |
| `MUSIC_HOME_URL` | `'https://music.youtube.com'` — `:6` | YouTube Music mobile entry point |
| `USER_AGENT` | Chrome 128 / Android 14 mobile UA — `:13` | |
| `isYouTube(url)` | `(string) => boolean` — `:31` | Used only by `extractVideoId` and the tests. |
| `isMusicUrl(url)` | `(string) => boolean` — `:8` | Identifies `music.youtube.com` for mode switching and audio defaulting. |
| `extractVideoId(url)` | `(string) => string \| null` — `:41` | Handles `?v=`, `youtu.be/`, and `/shorts|embed|live|v/`. |
| `isSignInPage(url)` | `(string) => boolean` | The Google hosts that ask for a password: `accounts`/`myaccount`/`signin` under `google.com` or `youtube.com`. Raises FLAG_SECURE, so it errs wide — a false positive blocks a screenshot, a false negative leaves a password field recordable. |
| `hostOf(url)` | `(string) => string` | Host without `www.`. |
| `NavMessage` | `{ type: 'nav'; url; title; theme: 'dark' \| 'light'; reason: string }` — `:50` | `theme` is measured from the page's own background luminance. |
| `NAV_SCRIPT` | `string` — `:68` | Hooks `pushState`/`replaceState`, `popstate`, `yt-navigate-finish`, a title `MutationObserver`, and a 1-second poll. Deduped against the last payload. |

**Depends on** nothing. **Used by** `src/browser/BrowserScreen.tsx`.

**Invariants**

- `NAV_SCRIPT` goes in `injectedJavaScript` (after load), not in the preload
  bundle — it only has to report navigation.
- `isSignInPage` is matched against the whole URL from the scheme, not against
  `hostOf`, so `accounts.google.com.evil.com` cannot pass it.

### `src/browser/formatView.ts` — 152 lines

Manifest → sheet rows, and the headless "best" pickers the two automatic paths
use.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `formatSize(bytes?)` | `(number?) => string` — `:6` | `"41 MB"` or `"—"`. Referenced only by this file and the tests. |
| `toQuickPicks(formats)` | `(Format[]) => QuickPick[]` — `:13` | Best, a preferred 1080p rung, and audio. A preferred rung identical to Best gets an `:explicit` id suffix so the two rows are distinguishable. |
| `toFormatRows(formats, freeBytes?)` | `(Format[], number?) => FormatRow[]` — `:64` | Video rungs only. `tooLarge` is set against free space when it is known. |
| `isAudioPick(id, formats)` | `(string, Format[]) => boolean` — `:79` | Strips `:explicit` first. |
| `bestAudio(formats, maxKbps?)` | `(Format[], number) => Format \| undefined` — `:92` | The highest audio-only rung at or under the cap, else the lowest. **Falls back to the smallest muxed format when there is no audio-only rung at all** — `-x` extracts the audio from it. |
| `bestVideo(formats, maxHeight)` | `(Format[], number) => Format \| undefined` — `:128` | Highest at or under the ceiling, else the lowest. |
| `heightFromQuality(quality)` | `(string) => number` — `:137` | Parses `"1080p"`; defaults to 1080. |
| `kbpsFromQuality(quality)` | `(string) => number` — `:148` | Parses `"160 kbps"`; **`Infinity`** for "Best available". |

**Depends on** `src/core/engine` and `src/sheets/QualitySheet` (types only).
**Used by** `src/browser/BrowserScreen.tsx`.

**Invariants**

- **`bestAudio` can return a video format.** Its caller must pass the *intent*
  down rather than reading `format.kind` back off the result. See `AGENTS.md`,
  "`audioOnly` is the intent, never `format.kind`".
- Both quality parsers are ceilings, not demands — the point is to come back with
  the nearest thing.

### `src/browser/usePlayTracking.ts` — 195 lines

Counts what was actually watched, from the page's own reports.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `MIN_PLAY_SECONDS` | `5` — `:30` | What counts as "they meant it". |
| `usePlayTracking(onPlayCounted?)` | `((stat: PlayStat) => void) => { plays: PlayIndex; onMedia: (m: MediaMessage) => void; markSaved: (id: string) => void; forget: (id: string) => void }` — `:45` | `onMedia` is fed every media message; `onPlayCounted` fires only when a *start* is banked. |

**Depends on** `src/core/plays`, `./background` (type only). **Used by**
`src/browser/BrowserScreen.tsx`.

**Invariants**

- **A step larger than `MAX_CREDITED_STEP` (3s, `:27`) is not credited.** A seek
  is not watch time.
- The callback is held in a ref (`:56`) and refreshed on every render, so the
  hook's identity never changes and the subscription is never rebuilt.
- See [FEATURES.md § 3](FEATURES.md#3-the-replay-rule-auto-save) and
  [UI.md](UI.md#what-actually-counts-as-a-play).

### `src/browser/pageNowPlaying.ts` — 67 lines

A module-level store: what the page is playing, subscribed to only by the mini
bar. Exists so a 3,000-line screen does not re-render once a second.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `PagePlayback` | `{ id; title; artist; playing; at; length }` — `:16` | |
| `setPagePlayback(next)` | `(PagePlayback \| null) => void` — `:33` | Notifies only when something a viewer could see changed — a position drift under `DRIFT_SECONDS` (1s, `:31`) is silent. |
| `pagePlayback()` | `() => PagePlayback \| null` — `:53` | Synchronous read. |
| `usePagePlayback()` | `() => PagePlayback \| null` — `:55` | |

**Depends on** React. **Used by** `src/browser/useBackgroundPlayback.ts`,
`src/player/NowPlayingBar.tsx`.

---

## `src/player/` — the local playback half

### `src/player/PlayerContext.tsx` — 905 lines

One queue, two engines (`expo-audio` and `expo-video`), one seat. Playback
outlives every screen, so this sits above the shell in `App.tsx`.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Track` | `{ id; title; artist?; uri; kind: 'audio' \| 'video' }` — `:31` | `uri` is `content://` or `file://`. |
| `Repeat` | `'off' \| 'all' \| 'one'` — `:41` | |
| `Sleep` | `{ at: number \| null; endOfTrack: boolean; minutes: number \| null }` — `:53` | `minutes` is kept so the receipt can say what was asked for, not just when it lands. |
| `PlayerProvider` | `({ children }: { children: ReactNode })` — `:154` | |
| `usePlayer()` | `() => PlayerApi` — `:901` | Throws outside a provider. |

`PlayerApi` (`:84`) is **not exported** — it is reached only as the return type of
`usePlayer()`. Its members:

| Member | Signature | Meaning |
|---|---|---|
| `player` / `video` | `AudioPlayer \| null` / `VideoPlayer \| null` | The live engine, for the status hooks. Never call `play()` on these. |
| `track` | `Track \| null` | |
| `toggle(next)` | `(Track) => Promise<void>` | Play this, or pause it if it is already the one loaded. |
| `togglePlayback()` | `() => void` | Play/pause whatever is loaded. **The only sanctioned play button.** |
| `seekTo(seconds)` | `(number) => Promise<void>` | |
| `setPlaybackGate(fn)` | `((() => void) \| null) => void` | The shell registers "silence the browser page" here. |
| `stop()` | `() => void` | Drops both engines, releases the card, clears the queue and the session. |
| `queue` / `index` | `Track[]` / `number` | |
| `play(tracks, start)` | `(Track[], number) => Promise<void>` | |
| `restore(tracks, start, at)` | `(Track[], number, number) => Promise<void>` | Loads a session **without playing** and without claiming the card. |
| `next()` / `previous()` | `() => Promise<void>` | `previous` restarts the track when past 3 seconds. |
| `repeat` / `cycleRepeat()` | | off → all → one. |
| `shuffle` / `toggleShuffle()` | | Shuffles only what is ahead; turning it off restores the original order and finds the playing track in it. |
| `sleep` / `setSleep(after)` | `(number \| 'track' \| null) => void` | Minutes, end-of-track, or off. |

**Depends on** `expo-audio`, `expo-video`, `src/core/storage` (`saveSession`),
`src/core/artwork`, `src/core/playLock`, `./nowPlaying`. **Used by** `App.tsx`,
`src/browser/BrowserScreen.tsx`, `src/player/{NowPlayingBar,PlayerScreen,VideoScreen}`.

**Invariants**

- **`interruptionMode: 'doNotMix'` is load-bearing** (`claimAudioSession`,
  `:356`). It is what gives the player exclusive audio focus, which is the whole
  mechanism behind the playback gate.
- **The play lock is checked before the page is silenced** (`lockPending`), on
  every path that starts sound. Its fast path is synchronous; only a start with
  no live lease waits, and it re-runs through `toggleRef` / `togglePlaybackRef`
  once granted. Pauses and `stop` release; a 60 s heartbeat renews. See FLOWS
  § 19.
- **Silence the page from every path.** `setPlaybackGate` exists so this cannot be
  forgotten at one of the several call sites; a page still playing takes the
  focus straight back and the track resumes for ~90ms and stops.
- **Never call `play()` on `player`/`video` from a UI component.** The lock
  screen is claimed on first play rather than on load (`claimed`, `:197`), so a
  surface that starts the engine directly skips the claim entirely — audio plays
  perfectly and Android kills the session a few minutes after backgrounding. See
  [UI.md](UI.md#every-play-button-goes-through-the-context).
- **`showNowPlayingNotification = false`** on the video player (`:337`). Two
  sessions means two cards for one app.
- `publish` (`:254`) returns early unless `claimed`, and reports `duration: 0`
  rather than a non-finite one — a duration of 0 means "not known yet" and the
  system then draws no scrubber.
- The next audio track is preloaded and the previous preload cleared (`:553`);
  `clearPreloadedSource` also runs on unmount.

### `src/player/nowPlaying.ts` — 129 lines

The arbiter for the single media notification. Android has room for one card per
app and Spool has two engines that know nothing about each other.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Source` | `'local' \| 'browser'` — `:18` | |
| `publishNowPlaying(source, state)` | `(Source, NowPlaying) => void` — `:69` | Raises or refreshes the card, or drops the publish entirely. |
| `releaseNowPlaying(source)` | `(Source) => void` — `:107` | Only the owner can take the card down. |
| `ownsNotification(source)` | `(Source) => boolean` — `:115` | |
| `onNotificationCommand(source, handler)` | `(Source, (e: PlaybackCommandEvent) => void) => EventSubscription` — `:121` | Delivers only while `source` owns the card. |

**Depends on** `modules/ytdlp`. **Used by** `src/player/PlayerContext.tsx`,
`src/browser/useBackgroundPlayback.ts`.

**Invariants**

- **You take the card by playing** (`:83`): a source that is not making a sound
  may update the card it already owns and may not take one from a source that is.
  Without that test both publish on every tick and each reads the other's publish
  as a claim — measured on the phone, the card alternated about twice a second.
- **Position is not pushed on a timer.** A publish is dropped when the shape is
  unchanged and the real playhead is within `DRIFT_SECONDS` (2s, `:45`) of where
  the system's extrapolation would put it.
- `shapeOf` (`:48`) is the equality key. Anything added to `NowPlaying` that the
  card *shows* has to be added here too, or changes to it are silently swallowed.

### `src/player/PlayerScreen.tsx` — 708 lines

The full player. One session, two shapes — a 320 artwork square or a 202 16:9
frame — chosen by a toggle, sharing position, queue and buffer.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `PlayerScreen` | `({ onDismiss, saved, onMore, onSleep }: Props)` — `:49` | `Props` (`:40`) is private: `onDismiss: () => void`, `saved?: boolean`, `onMore?: () => void`, `onSleep?: () => void`. `saved` is true when the track is a file rather than a stream. |

**Depends on** `./PlayerContext`, `./useLyrics`, `src/core/lyrics`,
`src/core/artwork`, `src/ui/{theme,ThemeContext}`. **Used by**
`src/browser/BrowserScreen.tsx`.

**Invariants**

- No tab bar — it is a sheet over the tab it was opened from, and the chevron
  returns you there without stopping playback.
- The design's like count, share chip and cast button are deliberately absent: a
  control that does nothing is worse than one that is not there. See
  [UI.md](UI.md#full-player--one-session-two-shapes).

### `src/player/NowPlayingBar.tsx` — 392 lines

The mini player, 58dp, above the tab bar on the four local tabs and never on
Browse. Four states plus the page variant.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `NowPlayingBar` | `({ onOpen, page }: { onOpen?: () => void; page?: { onOpen: () => void; onToggle: () => void; onStop: () => void } })` — `:23` | `page` absent means this app is the only source. |

**Depends on** `./PlayerContext`, `src/browser/pageNowPlaying`,
`src/core/artwork`, `src/ui/{theme,ThemeContext}`. **Used by**
`src/browser/BrowserScreen.tsx`.

**Invariants**

- **A page that is actually playing wins outright** (`:50`). Under `doNotMix`
  only one of them is audible, and showing a paused library track over YouTube
  would put a play button on the bar that stops the sound the user can hear.
- The status hooks need a real player, so the `!track` guard lives in the outer
  component and the hooks are called unconditionally one level down.

### `src/player/useLyrics.ts` — 104 lines

Lyrics as a *control* until they are content: nothing is fetched until asked.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `LyricsState` | `{ kind: 'idle' } \| { kind: 'loading' } \| { kind: 'none' } \| { kind: 'ready'; lyrics: Lyrics } \| { kind: 'error' }` — `:21` | `none` is "asked, there are none"; `idle` is "not asked". |
| `useLyrics(track, seconds)` | `(track: { title: string; artist?: string } \| null, seconds: number) => { state: LyricsState; request: () => void }` — `:31` | On a track change it reads the cache and stays `idle` on a miss. `request()` shows the consent alert the first time. |

**Depends on** `src/core/lyrics`, `Alert`. **Used by**
`src/player/PlayerScreen.tsx`.

**Invariants**

- A late response for a track the user has moved off is discarded (`wanted` ref,
  `:37`).
- The consent copy names exactly what is sent and to whom. See
  [FEATURES.md § 8](FEATURES.md#8-the-local-player).

---

## `src/screens/` — the four tab screens plus first run

All five are presentational: they take arrays of rows with callbacks attached and
own no data. Everything they show is built in `BrowserScreen`.

### `src/screens/HomeScreen.tsx` — 321 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `HomeCard` | `{ id; title; artist; kind; art?; onPress? }` — `:16` | A "Pick up where you left off" card. |
| `RepeatRow` | `{ id; title; subtitle; state: 'saved' \| 'fetching' \| 'none'; kind; art?; onPress?; onMore? }` — `:26` | An "On repeat" row; `state` is whether the replay rule has it yet. |
| `HomeScreen` | `({ recent, repeat }: { recent: HomeCard[]; repeat: RepeatRow[] })` — `:50` | Owns only the All/Music/Video/Offline chip. |

**Depends on** `src/ui/{theme,ThemeContext}`, `src/ui/TrialChip`. **Used by**
`src/browser/BrowserScreen.tsx`.

### `src/screens/SearchScreen.tsx` — 258 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `LocalHit` | `{ id; title; subtitle; kind; art?; onPress?; onMore? }` — `:22` | |
| `SearchScreen` | `({ query, onQuery, hits, recent, onRecent, onSearchWeb }: Props)` — `:44` | Searches the device; `onSearchWeb` hands the query to the Browse tab. |

**Depends on** `src/ui/{theme,ThemeContext}`. **Used by**
`src/browser/BrowserScreen.tsx`.

### `src/screens/LibraryScreen.tsx` — 639 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `LibraryItem` | `{ id; kind; title; subtitle; artist?; size?; bytes?; art?; progress?: number \| null; queuedReason?; failed?; onPress?; onMore? }` — `:25` | One row, in the library or in the Downloading section. `bytes` is separate from `size` because the sort needs a number and the row needs a label. |
| `PlaylistRow` | `{ id; name; detail; onPress; onMore }` — `:53` | |
| `OpenPlaylist` | `{ id; name; detail; items: LibraryItem[]; onBack; onPlay?; onMore }` — `:67` | The screen's second mode. |
| `LibraryScreen` | `({ items, downloading, summary, notice, onCancelAll, onSearch, playlists, onNewPlaylist, open }: Props)` — `:126` | Owns the filter and sort state and nothing else. |

**Depends on** `src/ui/{theme,ThemeContext}`, `src/ui/TrialChip`,
`react-native-svg`. **Used by** `src/browser/BrowserScreen.tsx`.

**Invariants**

- Artist sort puts rows *with* an artist first, then alphabetical, then title —
  otherwise a library half-full of unnamed rows sorts as a block of blanks
  (`:159`).

### `src/screens/ProfileScreen.tsx` — 473 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `KeepAs` | `'audio' \| 'video' \| 'match'` — `:15` | |
| `PLAY_THRESHOLDS` | `[2, 3, 5] as const` — `:18` | |
| `PlayThreshold` | `(typeof PLAY_THRESHOLDS)[number]` — `:19` | |
| `AUDIO_QUALITIES` | `readonly { key; label; detail }[]` — `:29` | Best available, 160, 128, 96 kbps. The `key` is what `kbpsFromQuality` parses. |
| `VIDEO_QUALITIES` | `readonly { key; label; detail }[]` — `:36` | 2160p down to 480p. Parsed by `heightFromQuality`. |
| `AutoSave` | `{ enabled; after; keepAs; audioQuality; videoQuality; instant }` — `:44` | Structurally `Settings` from `core/storage`, named for the screen. |
| `Storage` | `{ ours: number \| null; others: number; used: string; free: string }` — `:54` | |
| `ProfileScreen` | `({ autoSave, onAutoSave, storage, engineSummary, engineTone, onEngine, onAudioQuality, onVideoQuality, onExport, exportSummary, onDiagnostics, diagnosticsSummary }: Props)` — `:117` | |

**Depends on** `src/ui/{theme,ThemeContext}`, `src/ui/TrialChip`. **Used by**
`src/browser/BrowserScreen.tsx`.

**Invariants**

- The quality `key` strings are parsed, not just displayed. Changing one without
  changing `heightFromQuality`/`kbpsFromQuality` silently falls back to the
  default (1080p / `Infinity`).

### `src/screens/OnboardingScreen.tsx`

Replaced `src/screens/FirstRunScreen.tsx`, which is deleted.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `OnboardingScreen` | `({ onDone, onSeeOffer, entitled, trial }: { onDone: () => void; onSeeOffer: () => void; entitled: boolean; trial: boolean })` | Welcome → What it does → Premium → Browse. Carries the legal notice on step one. |

**Depends on** `src/ui/{theme,ThemeContext}`, `src/core/trial` (`TRIAL_PRICE`,
`LAUNCH_PRICE`), `src/core/license` (`PRICES`). **Used by**
`src/browser/BrowserScreen.tsx`.

**Invariants**

- Permissions are requested when this screen is *dismissed*, not at boot. See
  [FLOWS.md § 2](FLOWS.md#2-first-run).
- **Steps advance by button, never by swipe.** A swipe past a legal notice is
  not an acknowledgement of it.
- **The legal notice is on step one**, adjacent to the button that accepts it.
- **`onSeeOffer` is the only route to a sales sheet on this path.** `onDone`
  must not raise one — that is the "sold to twice" failure.
- The premium step is omitted entirely when `entitled`, and the dots then count
  two.
- Prices come from `TRIAL_PRICE` / `PRICES`, never literals, and exactly one
  offer is shown per build.

---

## `src/sheets/`

All four are `Modal transparent` with a scrim, an `Animated` rise, and
`motion.sheetIn` / `bezier.emphasized` timing that collapses to 0 under
`reduced`.

### `src/sheets/QualitySheet.tsx` — 645 lines

The format sheet, in four modes.

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `SheetMode` | `'quick' \| 'all' \| 'error' \| 'empty'` — `:16` | `null` for the prop means closed. |
| `FormatRow` | `{ id; res; note; codec; size; tooLarge? }` — `:18` | |
| `QuickPick` | `{ id; icon; title; detail; highlight? }` — `:28` | |
| `QualitySheet` | `({ mode, video, quickPicks, formats, storageWarning, duplicateWarning, emptyReason, errorReason, errorStale, instant, onInstant, onPick, onExpand, onCollapse, onClose, onUpdateEngine, onRetry }: Props)` — `:91` | `errorStale` decides whether *Update engine* is offered as the first action. |

**Depends on** `src/ui/{theme,ThemeContext}`. **Used by**
`src/browser/BrowserScreen.tsx`; `FormatRow` and `QuickPick` are also imported by
`src/browser/formatView.ts`, which is what builds them.

**Invariants**

- **The tapped row is the statement.** This is the one place `audioOnly` has no
  intent to pass down, which is why `isAudioPick` reads it back off the id.
- The error copy names the failure rather than blaming the engine for everything.
  See [UI.md](UI.md#the-extraction-failure-sheet-names-the-failure).

### `src/sheets/ChoiceSheet.tsx` — 147 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Choice` | `{ key: string; label: string; detail?: string }` — `:17` | |
| `ChoiceSheet` | `({ title, note, options, value, onPick, onClose }: Props)` — `:34` | A single-select list. Used for audio quality, video quality and the sleep timer. |

### `src/sheets/NameSheet.tsx` — 195 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `NameSheet` | `({ title, value, placeholder, action, onSubmit, onClose }: Props)` — `:41` | One text field. `onSubmit` receives the trimmed value and the sheet closes itself. An empty field disables the action rather than submitting nothing. |

### `src/sheets/SubscribeSheet.tsx` — 786 lines

The paywall. Reads `useLicence()` and `useAccount()` itself.

| Symbol | Signature | Meaning |
|---|---|---|
| `SubscribeSheet` | `({ onClose, reason? })` | `reason` is the refusal sentence that raised it, when one did. |

Phases `choosing → starting → pay → reading → uploading → approved | held`,
plus `rechecking`. Signed out it renders only the hand-over to the account
sheet. Picks with `expo-image-picker`, OCRs with `YtDlp.recognizeText`, shrinks
with `YtDlp.shrinkImage`, draws the QR with `react-native-qrcode-svg`. A `gone`
ref stops a request that outlives the sheet from calling `setState`.

**Depends on** `src/core/license.ts`, `src/core/account.ts`,
`src/core/payments.ts`, `src/core/log.ts`, `modules/ytdlp`, `expo-image-picker`,
`react-native-qrcode-svg`, `src/ui/theme.ts`, `src/ui/ThemeContext`.
**Used by** `src/browser/BrowserScreen.tsx`.

### `src/sheets/AccountSheet.tsx` — 399 lines

| Symbol | Signature | Meaning |
|---|---|---|
| `AccountSheet` | `({ intent, onClose })` | Sign in / create / forgot (WhatsApp); signed in: email, paid-through, devices, sign out; `intent.blocked`: the explanation only. On success with `intent.next === 'paywall'`, reopens the paywall. |

**Depends on** `src/core/account.ts`, `src/core/license.ts`,
`src/core/payments.ts`. **Used by** `src/browser/BrowserScreen.tsx`, opened
through `setAccountOpener`.

### `src/sheets/PlayLockSheet.tsx` — 136 lines

| Symbol | Signature | Meaning |
|---|---|---|
| `PlayLockSheet` | `({ notice })` | "Playing on X" / "Playback moved to X" / offline. `Play here instead` → `takeOver()`. |

**Depends on** `src/core/playLock.ts`. **Used by** `src/browser/BrowserScreen.tsx`,
rendered whenever `usePlayNotice()` is non-null.

### `src/sheets/PreReleaseSheet.tsx` — 235 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `PreReleaseSheet` | `({ onClose }: { onClose: () => void })` — `:28` | Reads `useTrial()` itself. `write()` (`:46`) opens a prefilled `mailto:`. |

**Depends on** `src/core/trial`. **Used by** `src/browser/BrowserScreen.tsx`,
which registers its opener through `setPreReleaseOpener`.

---

## `src/shell/`

### `src/shell/TabBar.tsx` — 80 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Tab` | `'home' \| 'search' \| 'browse' \| 'library' \| 'profile'` — `:14` | Also the base of `BrowserScreen`'s `Screen` type. |
| `TabBar` | `({ value, onChange }: { value: Tab; onChange: (tab: Tab) => void })` — `:24` | The order is fixed in `TABS` (`:16`). |

**Depends on** `src/ui/{theme,ThemeContext}`. **Used by**
`src/browser/BrowserScreen.tsx`.

---

## `src/ui/`

### `src/ui/theme.ts` — 403 lines

Every token in the design system, plus the derivation from a cover's dominant
colour. No React.

**Exports — colour**

| Symbol | Signature | Meaning |
|---|---|---|
| `fixed` | `{ base, raised, line, text, dim, mute, saved, warn } as const` — `:15` | The colours that never move, whatever is playing. |
| `Tint` | `{ deep; tint; accent; on; onDim; onAccent }` — `:35` | The six that do. |
| `NEUTRAL` | `Tint` — `:48` | The ground with no artwork. |
| `TINTS` | `{ sepia, teal, violet } as const satisfies Record<string, Tint>` — `:61` | Hand-built examples. Referenced nowhere. |
| `TintName` | `keyof typeof TINTS` — `:88` | Referenced nowhere. |
| `tintFromDominant(hex)` | `(string) => Tint` — `:118` | The real path. Takes hue from the cover, clamps saturation and pins lightness per role, then raises `on`/`onDim` until they clear 4.5:1 against `deep`. Greys (s < 6) go fully desaturated rather than faintly tinted. Returns `NEUTRAL` for an unparseable hex. |
| `contrast(a, b)` | `(string, string) => number` — `:238` | WCAG ratio. Used only inside this file. |
| `Theme` | `typeof fixed & Tint & { chrome; pageBg; surface; border; hair; icon; iconDisabled; textDim; accentSurface; success; successSurface; warnSurface; ph; phText; ringTrack; navHandle }` — `:248` | What `useTheme().t` is. |
| `Palette` | `= Theme` — `:269` | Legacy alias; only the dead `Pill.tsx` uses it. |

**Exports — scales**

| Symbol | Where | Meaning |
|---|---|---|
| `type` | `:278` | `nowPlaying`, `screenTitle`, `rowTitle`, `body`, `section`, `mono`, `monoStrong`, `tab`, `tabActive`, `chip`, `chipActive`, `itemTitle`, `pill`. Families are named directly — hence the font gate in `App.tsx`. |
| `space` | `:311` | `iconToLabel` 4 … `header` 32, plus `insidePill`, `barSide`, `sheetBlock`, `emptyState`. |
| `size` | `:329` | `tabBar` 60, `miniPlayer` 58, `target` 48, art sizes, `fab` 56, `bar`, `ring`, `pillHeight`, `navButton`. |
| `radius` | `:348` | `art` 10, `chip` 18, `sheet` 20, `fab` 28, `pill` 18, `card` 8. |
| `motion` | `:367` | Durations in ms. `tabSwitch: 0` is deliberate. |
| `bezier` | `:393` | `standard`, `emphasized`, `decelerate` — tuples for `Easing.bezier(...)`. |
| `RING_CIRCUMFERENCE` / `RING_RADIUS` | `:402`, `:403` | 88 and 14, for the SVG progress rings. |

**Depends on** nothing. **Used by** every component file.

**Invariants**

- Read [UI.md](UI.md) before changing any of these, including a cosmetic one. The
  book records which colour means what and what is deliberately absent.

### `src/ui/ThemeContext.tsx` — 85 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `Theme` | re-export — `:17` | So consumers need one import, not two. |
| `ThemeProvider` | `({ children }: { children: React.ReactNode })` — `:59` | Holds the current `Tint` and the reduce-motion flag. |
| `useTheme()` | `() => { t: Theme; tint: Tint; setTint: (t: Tint \| null) => void; reduced: boolean }` — `:85` | `setTint(null)` returns to `NEUTRAL`. |

`compose` (`:19`) is private and is where the 16 derived names come from.

**Depends on** `./theme`, `AccessibilityInfo`. **Used by** every screen and
sheet, and `App.tsx`.

**Invariants**

- The default context value is a real composed theme, not `null`, so a component
  rendered outside the provider degrades to neutral rather than throwing.

### `src/ui/TrialChip.tsx` — 59 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `TrialChip` | `function TrialChip()` — `:20` | Renders `null` in a full build. Opens the pre-release sheet through `openPreRelease` — no prop, because it lives in three screen headers. |

**Depends on** `src/core/trial`, `./ThemeContext`, `./theme`. **Used by**
`src/screens/{HomeScreen,LibraryScreen,ProfileScreen}`.

### `src/ui/ErrorBoundary.tsx` — 84 lines

**Exports**

| Symbol | Signature | Meaning |
|---|---|---|
| `ErrorBoundary` | `class ErrorBoundary extends Component<Props, State>` — `:29` | `Props = { children: ReactNode }`. Renders a message, the error text, and a *Try again* that increments `attempt` and re-mounts the tree. |

**Depends on** `src/core/log` (`describe`, `error`, `flush`), `./theme` (`fixed`
only — it cannot use the theme context, which is inside the tree it guards).
**Used by** `App.tsx`.

**Invariants**

- `componentDidCatch` logs at `error` level, which `log.ts` flushes at once
  rather than on the 4-second debounce, and then calls `flush()` again anyway.
  Only the first 12 frames of the component stack are kept.
- It styles itself from `fixed`, never from `useTheme` — the provider is one of
  the things it is guarding.

---

## Dead code and leftovers

Verified by grep across `src/`, `App.tsx`, `index.ts` and `tests/`, not taken on
trust from the other books.

### Files nothing imports

| File | Lines | Status |
|---|---|---|
| `src/browser/BrowserChrome.tsx` | 154 | **Unreferenced.** The v1 bottom chrome bar. Its only importers would be a v1 screen that no longer exists. It imports `Pill` and `DownloadButton`, which is the only thing keeping either of them reachable. |
| `src/browser/Pill.tsx` | 165 | **Unreferenced except by `BrowserChrome.tsx`.** Exports `PillContent` (`:8`), `pillFor` (`:24`) and `Pill` (`:107`). The v1 status pill; v2 uses the notice strip in `BrowserScreen` instead. Sole consumer of the `Palette` alias in `theme.ts`. |
| `src/player/VideoScreen.tsx` | 82 | **Unreferenced.** Full-screen playback for a downloaded video, with picture-in-picture. v2 plays video inside `PlayerScreen`'s 16:9 frame. It still compiles and still imports `usePlayer`, so it would work if re-mounted. |

`docs/README.md` is **correct** on all three.

### Partly used files

`src/browser/DownloadButton.tsx` (319 lines) — `docs/README.md` says only its
`DownloadState` type is still used, and that is **correct**. `BrowserScreen.tsx:105`
imports `type DownloadState` and nothing else; the `DownloadButton` component
(`:60`) and `A11Y_LABEL` (`:43`) are reached only from the dead `BrowserChrome`
and from nowhere at all respectively. The FAB in `BrowserScreen` (`:2409`) is a
separate implementation that reuses the same six-state vocabulary — `FAB_ICON`
(`:2993`), `FAB_LABEL` (`:3005`), `fabFill` (`:3014`), `fabInk` (`:3018`) and
`FabRing` (`:3022`) all key off `DownloadState`.

So the type is genuinely load-bearing and the file cannot simply be deleted;
moving `DownloadState` into `BrowserScreen.tsx` or a small shared module would
retire three files at once.

### Exported, and reached only by tests

Not dead — the tests are a real consumer — but no app code calls them:
`mediaKey` and `dedupeByFile` (`src/core/storage.ts`, both used internally by
`adoptSaved`), `clearPlays` (`src/core/plays.ts`), `partialKey`
(`src/core/ytdlp.ts`, used internally by `startDownload`), `titleScore`
(`src/core/similar.ts`), `formatSize` (`src/browser/formatView.ts`, used
internally), `MIN_PLAY_SECONDS` (`src/browser/usePlayTracking.ts`), `TTL_MS`,
`hasToken` and `reset` (`src/core/tokens.ts`), `setVerbose` (`src/core/log.ts`),
`resetClientScores` (`src/core/clients.ts` — and it **must** stay exported; see
that file's invariants).

### Exported and reached by nothing at all

`isVerbose` (`src/core/log.ts:77`), `forgetLyrics` (`src/core/lyrics.ts:248`),
`TINTS` and `TintName` (`src/ui/theme.ts:61`, `:88`), `A11Y_LABEL`
(`src/browser/DownloadButton.tsx:43`), `summary` (`src/core/tokens.ts:108`), and
the four interfaces plus `MediaKind` in `src/core/engine.ts` (`DownloadEngine`,
`Muxer`, `TokenProvider`,
`ProofOfOriginToken`). The `engine.ts` seams are deliberate — they are the shape
an iOS implementation would fill, and the file says so at the top. The rest are
simply leftovers.

`IS_PREVIEW` (`src/core/ytdlp.ts:22`) is `false` and is read in
`BrowserScreen.tsx`; it is a dry-run switch, not dead code.
