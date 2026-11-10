# Spool — the native half

Everything under `modules/ytdlp/android/`, plus the build machinery that gets it
into an APK. For the JavaScript that calls it see
[ARCHITECTURE.md](ARCHITECTURE.md); for the order things happen in see
[FLOWS.md](FLOWS.md); for what the media card is supposed to look like see
[UI.md](UI.md).

---

## 1. What runs where, and why any of it is native

**The native half exists because everything that has to stay true while the app
is not on screen belongs to Android rather than to React** — a running download,
a playing track, a published file, a refused save. React can ask for those; it
cannot own them.

Concretely, four things are unreachable from JavaScript and each one is a file
here:

- **A yt-dlp process.** `youtubedl-android` ships a Python 3.8 runtime and an
  ffmpeg build per ABI, and can replace its own extractor at runtime. That last
  part is why a sideloaded app keeps working when YouTube changes something.
- **The surfaces Android reserves for itself** — a `MediaSession` and its
  notification, two foreground services, a partial wake lock, MediaStore.
- **Two things about the WebView that JavaScript inside it cannot see**: the
  HttpOnly half of its cookie jar, and its Android-level visibility.
- **An enforcement point that survives a patched bundle.** The JS ships as
  Hermes bytecode inside the APK it would be guarding.

| File | Lines | What it owns |
|---|---|---|
| `modules/ytdlp/index.ts` | 234 | The typed surface. **This is the contract**; the Kotlin honours it |
| `…/YtDlpModule.kt` | 1,051 | The bridge. Extraction, download, publish, scan, artwork, the card, the WebView pin |
| `…/PlaybackService.kt` | 611 | The one media notification, the `MediaSession`, the wake lock, `PlaybackCommandBus` |
| `…/DownloadService.kt` | 226 | The download foreground service and its single slot |
| `…/MediaStoreWriter.kt` | 192 | Publishing into `Music/Spool`, `Movies/Spool`, `Downloads/Spool` |
| `…/CookieJar.kt` | 76 | The browser session, as a Netscape cookie file |
| `…/TrialGuard.kt` | 177 | The only copy of the pre-release limits that *decides* |
| `…/AndroidManifest.xml` | 65 | Seven permissions, two services, one receiver |

All Kotlin is in one package, `com.afinitycode.spool.ytdlp`, and all of it is in
the app's process. There is no IPC anywhere: `PlaybackCommandBus` and
`YtDlpCancelBus` are plain objects with a listener list, because the service and
the module are the same process and the traffic is seven verbs
(`PlaybackService.kt:590-611`).

> `modules/ytdlp/android/build/` is generated output. Nothing in it is source.

---

## 2. Threading

The rule that matters: **an Expo `Function` is synchronous across JSI, so its
body runs on the caller's thread and blocks the JS thread for its duration.** An
`AsyncFunction` does not, and every one here immediately hands off to
`Dispatchers.IO` and returns.

| Entry point | Arrives on | Must not block | Work happens on |
|---|---|---|---|
| `AsyncFunction` bodies (`initialize`, `version`, `listFormats`, `cancel`, `updateEngine`, `scanSaved`, `publishToGallery`, `writeTextFile`, `readArtwork`) | Expo's async invocation — **not determined here**, and it does not matter: the body only launches | — | `scope`, `SupervisorJob() + Dispatchers.IO` (`YtDlpModule.kt:94`) |
| `AsyncFunction("download")` | as above, but it does real work *before* the launch | — | Argument parsing and **`TrialGuard.refuse`** run in the builder body (`YtDlpModule.kt:189-224`); everything after runs on IO |
| yt-dlp's progress callback | The IO thread running the process | that thread — it is the download | `sendEvent("onProgress", …)` is called straight from it (`YtDlpModule.kt:279-289`) |
| `Function("setNowPlaying")` | JS thread | **the JS thread** | Synchronous binder call — `startForegroundService` on O+ (`PlaybackService.kt:138`) |
| `Function("trialStatus")` | JS thread | **the JS thread** | Everything inline. See §9 for what that actually costs |
| `Function("setPageCommand")` | JS thread | the JS thread | `CookieManager.setCookie` ×3 plus `flush()` (`YtDlpModule.kt:1017`) |
| `Function("setWebViewVisible")` | JS thread | the JS thread | Returns at once; all of it is `main.post` (`YtDlpModule.kt:607-626`) |
| `Function("setSecureWindow")` | JS thread | the JS thread | Returns at once; `main.post`, then one `addFlags`/`clearFlags` on the activity window |
| `AsyncFunction("signOutOfYouTube")` | as the other async bodies | — | **`main.post`, not `scope`** — `CookieManager.removeAllCookies` and `WebStorage` both want the main thread, and the promise resolves from there so the caller's remount cannot overlap the removal |
| `Function("stopBackgroundPlayback")` | JS thread | the JS thread | `context.startService`, wrapped (`PlaybackService.kt:145`) |
| The visibility pin tick | Main looper, every 1,000 ms | main | `dispatchWindowVisibilityChanged` on one view |
| `PlaybackService.onStartCommand` | Main thread | main | `publish()` builds metadata, state and notification inline; only artwork decoding is moved off |
| Artwork decode | `Executors.newSingleThreadExecutor()` (`PlaybackService.kt:173`) | — | Result posted back to `main`, and stale results dropped (`PlaybackService.kt:478`) |
| `MediaSessionCompat.Callback` | Main thread | main | Mutates fields, `publish()`, then `PlaybackCommandBus.emit` |
| `DownloadService.onStartCommand` | Main thread | **main, and there is a fuse on it** | See §8 |

Two consequences worth holding on to.

**The `startForegroundService` fuse burns on the main thread while the download
runs on IO.** A contended main thread narrows the window, which is why the one
observed `ForegroundServiceDidNotStartInTimeException` looked random and has not
reproduced (`docs/RELIABILITY.md` § 7, N1). Nothing may assume the window is
wide.

**`sendEvent` is called from three different threads** — the IO thread for
`onProgress`, and the main thread for `onPlaybackCommand` (via the bus, from
`PlaybackService`). Both are wrapped in `runCatching` at the point of emission
(`YtDlpModule.kt:119`, `PlaybackService.kt:304`), because an event sent after
the JS runtime has gone is a normal part of teardown, not a fault.

---

## 3. The JS → native contract

`modules/ytdlp/index.ts` is the authority. The TypeScript carries intent the
Kotlin cannot: `DownloadArgs.resumeKey` explains in twelve lines why a name that
changes per attempt is a download that never completes, and nothing on the
Kotlin side says so.

### Functions

| Function | Kind | Arguments | Resolves | Rejects with |
|---|---|---|---|---|
| `initialize()` | async | — | `string` — yt-dlp version, or `"unknown"` | `E_INIT` |
| `version()` | async | — | `string` | `E_VERSION` |
| `listFormats(url, poToken, visitorData, clients)` | async | four; the last three nullable | `string` — raw `--dump-single-json` | `E_EXTRACT` |
| `download(args)` | async | `DownloadArgs` as a `Map<String, Any?>` | `{ path, bytes, salvagedFrom? }` | `E_ARGS`, `E_TRIAL_*`, `E_NO_OUTPUT`, `E_CANCELLED`, `E_DOWNLOAD` |
| `cancel(id)` | async | `string` | `null`, **always** | never — a double cancel is not a fault (`YtDlpModule.kt:364`) |
| `updateEngine()` | async | — | `{ status, version }` | `E_UPDATE` |
| `publishToGallery(path, title, audioOnly)` | async | `string, string, boolean` | `string` — a `content://` uri. **Deletes the source** | `E_PUBLISH` |
| `writeTextFile(name, mime, body)` | async | three strings | `string` — a `content://` uri. Moves and deletes nothing | `E_WRITE` |
| `scanSaved()` | async | — | `SavedItem[]`, newest first | `E_SCAN` |
| `readArtwork(key, path, urls)` | async | `string, string \| null, string[]` | `{ uri, dominant }` | `E_NO_ARTWORK`, `E_ARTWORK_DECODE`, `E_ARTWORK` |
| `filesExist(uris)` | **sync** | `string[]`, `file://` prefix optional | `boolean[]`, same order — a non-empty regular file | — |
| `setNowPlaying(state)` | **sync** | `NowPlaying` as a map | `void` | — |
| `stopBackgroundPlayback()` | **sync** | — | `void` | — |
| `setPageCommand(command, stamp)` | **sync** | `string, number` | `void` | — |
| `setWebViewVisible(pinned)` | **sync** | `boolean` | `void` | — |
| `trialStatus()` | **sync** | — | `TrialStatus` | — |
| `licenceStatus()` | **sync** | — | `LicenceStatus` | — |
| `rememberLicence(token)` | **sync** | `string` | `boolean` — whether it verified and was kept | — |
| `forgetLicence()` | **sync** | — | `void` | — |
| `recognizeText(uri)` | async | `string` — `file://` or `content://` | `string` — every line, block by block, joined by `
`; `""` when there is no text | `E_OCR_READ`, `E_OCR` |
| `shrinkImage(uri, maxEdge, quality)` | async | `string, number, number` | `{ uri, bytes, width, height }` — a JPEG in `cacheDir/upload/` | `E_IMAGE` |

### Error codes, and where each is minted

| Code | Line | Means |
|---|---|---|
| `E_INIT` | `YtDlpModule.kt:145` | Python/ffmpeg extraction failed. In a release build, suspect the R8 keep rules first — see §12 |
| `E_VERSION` | `:156` | |
| `E_EXTRACT` | `:179` | Whatever yt-dlp said. `looksBlocked` in `src/core/ytdlp.ts` reads the *message*, not this code |
| `E_ARGS` | `:190`, `:193` | `id` or `url` missing. Rejected before anything is launched |
| `E_TRIAL_expired` · `E_TRIAL_tampered` · `E_TRIAL_quota` · `E_TRIAL_tooLong` | `:223` | Built as `"E_TRIAL_$reason"` from `TrialGuard`'s constants, which are camelCase (`TrialGuard.kt:26-29`). There is no `E_TRIAL_TOO_LONG` |
| `E_NO_OUTPUT` | `:297` | The engine claimed success and `finished()` found no publishable file |
| `E_CANCELLED` | `:352` | The only code any JavaScript branches on |
| `E_DOWNLOAD` | `:352` | Everything else, message carried through |
| `E_UPDATE` | `:390` | |
| `E_SCAN` | `:413` | |
| `E_PUBLISH` | `:424` | |
| `E_WRITE` | `:441` | |
| `E_NO_ARTWORK` | `:478` | Neither the file's tags nor any candidate URL yielded bytes. Expected, and the item keeps the neutral ground |
| `E_ARTWORK_DECODE` | `:490`, `:498` | Bytes arrived and were not an image |
| `E_ARTWORK` | `:515` | |
| `E_OCR_READ` | `recognizeText` | `InputImage.fromFilePath` could not open the picked file |
| `E_OCR` | `recognizeText` | ML Kit's recognizer failed. The paywall sends the screenshot anyway, with empty text — the server routes that to a person |
| `E_IMAGE` | `shrinkImage` | Not an image, or it would not decode. The paywall falls back to uploading the original |

**A coded rejection's stack is the bridge's, not the fault's.** Anything with a
`code` was built by Expo's `CodedError` on the way out, so the stack names the
bridge and a bundle URL while the real failure is already in `message`.
`log.describe` drops the stack when a code is present for exactly this reason —
see `AGENTS.md`.

### Events

| Event | Payload | Emitted from |
|---|---|---|
| `onProgress` | `{ id: string, fraction: number, eta: number, line: string }` | `YtDlpModule.kt:280`, per output line, on the IO thread. `fraction` is `progress / 100` clamped to `0…1` |
| `onPlaybackCommand` | `{ command: string, value: number }` | `YtDlpModule.kt:120`, fed by `PlaybackCommandBus` |
| `onLog` | — | **Declared at `YtDlpModule.kt:133` and never emitted anywhere.** Dead |

`onPlaybackCommand` carries seven verbs: `play`, `pause`, `stop`, `next`,
`previous`, `seek` and `save`. `value` is a position in **seconds** and only
`seek` means anything by it — the session reports milliseconds and
`PlaybackService.kt:209` divides.

### Shapes crossing the bridge

Everything native returns is a `Bundle` or a `Map<String, Any?>`; there are no
`Record` types anywhere. `@OptimizedRecord` wants introspection data from a KSP
step this module does not run, and asking for it fails the same way the reified
inlining does (§4). Sizes and durations cross as **doubles** (`putDouble` at
`:305`, `:341`, `scanCollection`'s `"bytes"` and `"durationMs"`), while
`savedAt` crosses as a `Long` (`:821`); TypeScript types all of them `number`
and the distinction never surfaces.

---

## 4. `YtDlpModule.kt`

### The DSL constraint, first, because it shapes the file

`Function` and `AsyncFunction` are inline builders with reified type parameters,
and `definition()` is one enormous inlined expression. Two more inline bodies
once tipped it past what Kotlin would inline: the compiler stopped erasing
`reifiedOperationMarker` and **every launch died before any JavaScript ran**
with *"this function has a reified type parameter and thus can only be inlined
at compilation time"*.

So `showNowPlaying` (`:998`) and `writePageCommand` (`:1017`) are private
members, and their call sites are one-liners: `Function("setNowPlaying") { state
-> showNowPlaying(state) }`. The comment at `:987-997` is the record of that.
**This is the constraint to check before adding anything to `definition()`** —
the failure is at launch, before any of your logging exists, and it does not
look like a size problem.

### Module state

```
scope           CoroutineScope(SupervisorJob() + Dispatchers.IO)   :94
running         ConcurrentHashMap<String, Boolean> — live job ids  :95
main            Handler(Looper.getMainLooper())                    :97
visibilityPin   the repeating "you are still visible", or null     :100
browserView     WeakReference<WebView>                             :103
initialised     @Volatile, guards ensureInitialised                :105
```

`context` (`:108`) is `appContext.reactContext` with a `requireNotNull` — it
throws once React is gone, which is why `OnDestroy` wraps its use in
`runCatching` (`:592`).

### `definition()`, in order

**`OnCreate` (`:135`)** registers `playbackCommands` on `PlaybackCommandBus`.
That single line is the whole path by which a lock-screen button becomes a
JavaScript event.

**`initialize` / `version` (`:139`, `:150`)** are the same body. Both call
`ensureInitialised()`, so `version()` is not free on a cold process.

**`listFormats` (`:165`)** adds `--dump-single-json --no-warnings --no-playlist`,
then `applyExtractorArgs` and `applyBrowserSession`, and resolves `response.out`
verbatim. **Parsing is deliberately TypeScript's job** so the format model lives
in one place; nothing here understands a format.

**`download` (`:188`)** is the largest function in the module and the only one
that does work before its coroutine:

1. Reads and type-checks the args (`:189-200`). Missing `id` or `url` →
   `E_ARGS`, synchronously.
2. Derives `stem` (`:210-214`) from `resumeKey`, **filtered again here rather
   than trusted from the bridge** — it becomes a path, and `..` in it would
   write outside the download directory. Falls back to the job id, which is what
   it used to always be and is why nothing ever resumed.
3. **`TrialGuard.refuse(context, seconds)` (`:222`).** Before the launch, before
   `ensureInitialised`, before anything. This is the check that decides; the
   TypeScript one only words the refusal.
4. Then `scope.launch`. `startedAt` and `outputDir` are declared **outside** the
   `try` (`:230-231`) because the catch reads them too — that is what makes the
   salvage path below possible.

Inside the try: `ensureInitialised()`, `running[id] = true`,
`startService(id, title)`, then the request (`:238-277`) —
`--no-playlist --no-warnings --newline`, `-o <outputDir>/<stem>.%(ext)s`,
`--embed-thumbnail`, `--embed-metadata`, and one of

- `-f <format ?: "bestaudio"> -x --audio-format m4a`, or
- `-f <format ?: "bestvideo+bestaudio/best"> --merge-output-format mp4`.

`execute(request, id) { progress, eta, line -> … }` emits `onProgress` per line.
Then `finished(outputDir, stem, startedAt)`, `running.remove(id)`,
`stopServiceIfIdle()`, and either `E_NO_OUTPUT` or **`TrialGuard.spend`
(`:301`) followed by resolve** — spent only once a file exists, so a save that
failed halfway costs the tester nothing.

The catch (`:309`) is the interesting half. It detects a cancel by string match
on the message (`:312`), and then **runs `finished()` again** (`:335`):

> A decoration must never be able to fail the thing it decorates. Measured: a
> 31-minute save downloaded fully, converted to a 73 MB m4a, had its source
> deleted, and then failed with `Postprocessing: Conversion failed!` because the
> *cover art* would not embed. Complete audio on disk, "Didn't finish" on
> screen.

What makes that safe rather than merely forgiving is `finished`'s exclusions
(below) and the outright exclusion of a cancel — resolving there would put a
track in the library the user never asked for and spend a trial save on it. A
rescue carries `salvagedFrom` (`:345`) so the log can explain a success with an
error beside it.

**`cancel` (`:360`)** destroys by id, swallows a failure, and always resolves.

**`updateEngine` (`:377`)** — `updateYoutubeDL(context, STABLE)`. The app's only
self-repair path; it cannot ship Play Store updates.

**`scanSaved` (`:408`)**, **`publishToGallery` (`:418`)**, **`writeTextFile`
(`:435`)** are thin wrappers over `scanSavedMedia()` and `MediaStoreWriter`.

**`readArtwork` (`:466`)** is the one place the app makes a network request on
its own behalf. Cache first (`cacheDir/artwork/<sanitised key>.jpg`), then the
file's own embedded picture, then the first URL that answers. Decoded to
`CACHE_EDGE` = 640 on the short edge, letterbox-trimmed, re-encoded at JPEG 85 —
**yt-dlp embeds the maxres thumbnail at ~1.8 MB per item, measured**, and a few
hundred of those is half a gigabyte of cache to fill a 320dp square. The colour
comes from `Palette` with filters cleared and 16 colours: vibrant → muted →
dominant → the centre pixel (`:501-505`).

**`setNowPlaying` (`:527`)**, **`trialStatus` (`:534`)**,
**`stopBackgroundPlayback` (`:536`)**, **`setWebViewVisible` (`:563`)**,
**`setPageCommand` (`:581`)** — the five synchronous ones. Note that the KDoc
above `readArtwork` at `:446-453` describes `setNowPlaying`; it is an orphan
left behind when the function moved, and the real `setNowPlaying` comment is at
`:520-526`.

**`recognizeText`** and **`shrinkImage`** — the payment screenshot's two
steps, both one-line DSL entries over private methods (`recognizeText(uri,
promise)`, `shrinkImage(…)`) for the inlining reason at the top of this section.
`recognizeText` decodes with `InputImage.fromFilePath` on `scope` (IO), hands
the image to ML Kit's bundled Latin `TextRecognition` client, resolves the
blocks' lines joined by `
` from the recognizer's main-thread callback, and
closes the client on completion. `shrinkImage` exists because
`expo-image-picker`'s `quality` only recompresses JPEG sources — a PNG
screenshot comes back a PNG, and a 1080×2400 one can be past the server's 2 MB
cap. It bounds-decodes through the `ContentResolver` (so `file://` and
`content://` both work), samples down by powers of two, scales the long edge to
`maxEdge`, and writes one JPEG to `cacheDir/upload/`, deleting whatever was
there first.

**`OnDestroy` (`:585`)** unregisters the bus, **unpins the WebView** (a pin
outlives React otherwise, holding a view from a tree being torn down), stops
`PlaybackService`, and destroys every process still in `running`.

### The private half

**`ensureInitialised` (`:646`)** — `@Synchronized`, `YoutubeDL.init` +
`FFmpeg.init` + `sweepStalePartials()`. This is where an R8 failure lands, and
it is lazy, which is why "the app launched" proves nothing about a shrinking
change.

**`INTERMEDIATE` (`:68`)** — `\.f\d+\.|\.temp\.|\.part(-Frag\d+)?$|\.ytdl$`.
Read off a real 360p save rather than from documentation, because the list is
longer than it looks. A 360p download writes, in order:

```
ZbP4VNJhRUk.v360.f134.mp4.part   the video stream, arriving
ZbP4VNJhRUk.v360.f134.mp4        the video stream, whole
ZbP4VNJhRUk.v360.f251.webm       the audio stream, whole
ZbP4VNJhRUk.v360.temp.mp4        the merge, in progress
ZbP4VNJhRUk.v360.mp4             the download
```

`.fNNN.` is half a merge — without it a video whose merge failed is published as
a silent film. **`.temp.` is the one that was missed**: it is the merge ffmpeg is
still writing, it carries the real container's extension, and it matches no
`.fNNN.` pattern, so excluding only the latter rescues a *truncated* video
instead. Caught on device with `.v144.mp4` at 35,189,497 bytes and
`.v144.temp.mp4` at 33,030,192 side by side, both newer than the attempt began
(`docs/RELIABILITY.md` § 10, N10a). `.part-FragN` is in the pattern because
`File.extension` reads it as `part-Frag7`, so an extension test alone does not
catch it.

**`finished(outputDir, stem, startedAt)` (`:870`)** — files named `<stem>.*`,
excluding images and everything `INTERMEDIATE` matches, **preferring one
modified since `startedAt`** and falling back to the newest older one. That
fallback is yt-dlp's "already downloaded" case and is correct: a complete file
of exactly this video and quality is the right answer whoever wrote it. It is
also the one branch here that is reasoned rather than run.

The `startedAt` term is load-bearing and only became so recently: once the
output name is shared across attempts, *"a file with this name exists"* stopped
being proof that this attempt wrote one.

**`sweepStalePartials` (`:902`)** — deletes anything matching `INTERMEDIATE`, or
any image, older than `PARTIAL_MAX_AGE_MS` (24 h). Sweeping **by the same
pattern rather than by extension** is deliberate: `.part-Frag7` and `.temp.mp4`
have no extension an extension test recognises, and both otherwise survive
forever at the size of a whole video. Images go too — one interrupted save left
179 KB of orphaned cover art, and nothing reads it.

**`applyExtractorArgs` (`:913`)** builds **one** `--extractor-args` string,
because yt-dlp *replaces* rather than merges repeated args for the same
extractor and passing them separately silently drops all but the last (`:959`).
With a token it emits `player_client=<client>` and
`po_token=<client>.gvs+<token>` — the client is **the caller's**, never a
constant, because a token labelled for a client we are not asking as is ignored
and reads as a 403 on the media fetch. It was hardcoded to `web` once, wrong
twice over: the page is `m.youtube.com` so the token is an `mweb` one, and `web`
is SABR-only. `visitor_data` rides only alongside a token, since on its own it
pins requests to a session with no attestation.

**`applyBrowserSession`** — `CookieJar.write` or nothing, and it **returns the
jar to the caller, which must discard it in a `finally`**. A failure is silent
by design: `--cookies` with a missing file is worse than no `--cookies`. See §8.

**`startService` / `stopServiceIfIdle` (`:974`, `:1042`)** — the download
service's two commands.

**The artwork pipeline.** `embeddedArtwork` (`:669`) takes the uri **exactly as
the library stored it** and branches on scheme: a `content://` uri only works
through `MediaMetadataRetriever`'s context overload, and handing it a bare path
is how the embedded cover stays invisible for every item the user saved
deliberately. `fetchBytes` (`:689`) is 8-second timeouts and a browser-shaped
User-Agent, because a CDN refusing a default Java agent is indistinguishable
from "this item has no artwork". `decodeSampled` (`:746`) halves until the short
edge is under target. `trimLetterbox` (`:714`) cuts the black bands YouTube's
4:3 thumbnail sizes pad 16:9 video with — the bars are *inside* the image, so no
`resizeMode` removes them, and it is done here rather than by choosing a better
URL because it also fixes art from a file's own tags where there is no URL to
choose. Two guards keep it from eating a dark photograph: it only scans the
outer third from each edge, and it returns the original if it would trim less
than `height/20` or keep less than half (`:741`).

**The scan** — `scanSavedMedia` (`:764`) queries both collections and sorts by
`savedAt` descending. `scanCollection` (`:771`) matches on the **folder**, which
is the only thing that survives every route a file can take, including the user
moving it back after a tidy-up. `RELATIVE_PATH` only exists from Q; below that
the legacy `DATA` column is the path itself, hence the two `where` shapes
(`:787-792`). `DATE_ADDED` is in **seconds** and the rest of the app in
milliseconds — mixing them puts every restored row in 1970 (`:821`).

**`pinWebViewVisibility` (`:607`)** and **`browserWebView` (`:629`)** are the
answer to a failure that took a long time to find. Freezing `document.hidden`
stops YouTube pausing itself and reaches nothing below that: WebView suspends
the media pipeline of a WebView it considers hidden, decided from the Android
view and reachable by nothing in JavaScript. Measured on a Galaxy S21 FE, each
resume bought about **50 ms** of sound, identically with the screen off and with
HOME pressed and the screen on — while audio focus was still ours and the
renderer was still perceptible, both of which were checked precisely because
they are the obvious suspects.

`dispatchWindowVisibilityChanged(View.VISIBLE)` on the WebView alone puts
AwContents back to visible. It **cannot be a one-shot**: the real window
visibility belongs to `ViewRootImpl` and our telling is not recorded there, so
anything that makes Android re-dispatch the truth would put the page back to
sleep and off screen nothing would notice. Hence a 1,000 ms tick
(`VISIBILITY_PIN_MS`, `:91`), which is well inside the gap between Chromium
hiding a page and suspending its media.

Unpinning **hands the truth back** rather than merely stopping (`:613`) — it
re-dispatches the view's *real* `windowVisibility`, because a page left
believing it is visible holds a hardware decoder for a track that has already
stopped. The view is found by walking the decor view once and cached weakly; the
tree does not move, and `isAttachedToWindow` is the re-lookup trigger (`:630`).

**`writePageCommand` (`:1017`)** writes `spool_cmd=<verb>.<stamp>` on
`.youtube.com` with `Max-Age=120`, to all three hosts, then flushes. This exists
because **`injectJavaScript` is queued, not run, while the app is
backgrounded** — react-native-webview posts it as a UIManager view command,
flushed on a Choreographer frame an off-screen window never gets. A cookie is
routed through none of that; the page's own timer keeps running. The stamp is
what makes a repeat of the same verb a new command rather than the old one still
sitting in the jar.

### Two rough edges

**`stopServiceIfIdle` (`:1042`) is the one `startService` call in this package
that is not wrapped.** `PlaybackService.stop` wraps the identical shape in
`runCatching` (`PlaybackService.kt:146`), which is the file's own evidence that
the call is considered throwable. In `download` it sits inside the try and the
catch — and a throw *from the catch* escapes the coroutine, which has a
`SupervisorJob` and no `CoroutineExceptionHandler`. In `cancel` (`:368`) it sits
outside the try entirely, so a throw there leaves `promise` never settled.
Whether the call can actually throw in these states is **not determined here**;
no failure of this shape appears in `docs/RELIABILITY.md`.

**Two KDoc blocks are orphaned** — `:446-453` (describes `setNowPlaying`, sits
above `readArtwork`) and `:655-660` (describes the partial sweep, sits above
`embeddedArtwork`). Harmless, and worth knowing before you trust a comment's
position in this file.

---

## 5. `PlaybackService.kt`

### Two jobs, and they are not the same job

**Survival.** Android freezes cached processes, which stops a media pipeline
dead, and the CPU sleeps a few seconds after the screen goes off. A foreground
service exempts us from the first; a partial wake lock, held **only while sound
is actually coming out**, answers the second. That is as true of a local file as
of the browser's `<video>`, which is why both sources come through here rather
than each raising a service of its own — and why there is exactly one card.

**The card itself.** On Android 13 and up **the media control panel is built
from the `MediaSession`'s `PlaybackState` and metadata, and from nothing else.**
Buttons added only to the notification are not drawn. Everything below is
therefore expressed as session state first and notification actions second; the
actions are the fallback for Android 12 and older.

This is also why the media notification is ours and not `expo-audio`'s
`setActiveForLockScreen`, which publishes a Media3 session with
`SEEK_TO_PREVIOUS_MEDIA_ITEM` and `SEEK_TO_NEXT_MEDIA_ITEM` removed outright in
`AudioMediaSessionCallback`. No configuration puts skip buttons on that card,
and a queue-based player whose notification cannot change track is most of the
notification missing. `expo-video`'s `showNowPlayingNotification` is off for the
same reason: two sessions means two cards for one app.

### What the system draws, given the right state

| Element | Comes from |
|---|---|
| The output switcher chip | Having a session at all |
| Artwork and the card's colours | `METADATA_KEY_ALBUM_ART` / `METADATA_KEY_ART`, and the notification's large icon |
| A working scrubber, with both times | **`ACTION_SEEK_TO` *and* a real `METADATA_KEY_DURATION`** |
| Previous / play-pause / next | The matching `PlaybackState` actions |
| The Save button | A **custom action**, `CUSTOM_SAVE` (`:80`) — the only way to put a non-transport button on an Android 13+ card |

**A duration of 0 is "not known yet", not "zero seconds"** — a live page, or a
file whose length has not been read. `metadata()` (`:350`) leaves the key unset
in that case and `state()` (`:369`) withholds `ACTION_SEEK_TO` with it, because
setting either draws a scrubber over a track the system thinks is empty.

**Position is not pushed on a timer.** A `PlaybackState` carries a position, the
wall clock it was measured at, and a speed, and the system extrapolates between
updates (`:387-391`). The speed is `1f` while playing and `0f` while paused —
zero, or the thumb crawls on across a stopped track. Verified on device: this
reads as a stuck `position=0` in `dumpsys` and is not a bug
(`docs/RELIABILITY.md` § 1).

### The subtitle carries the source, because there is nowhere else

`subtitle()` (`:334`) joins artist and source with a `·`. Android 13+ take the
card's second line from the session's `ARTIST` **and nowhere else** — the
notification's `contentText` is not drawn and `setSubText` lands in a header the
media template does not have. `METADATA_KEY_ALBUM` also carries the bare source
for surfaces that show three lines (Android Auto, some watches).

### Play is never assumed; pause always is

`onPause` and `ACTION_PAUSE` set `playing = false` and `publish()` before
emitting the verb (`:187`, `:251`). `onPlay` and `ACTION_PLAY` emit and change
nothing (`:184`, `:249`).

The asymmetry is not tidiness. Pausing always works. Resuming does not: when the
browser owns the card and the app is off screen the page is a hidden document,
and **a hidden document may not start media without a user gesture**. A
`<video>` reads back as unpaused the instant `play()` is called, so reporting
there reports a request as a fact — and once the play is refused the page's
timers are frozen, so no correcting report ever arrives. Measured: the card sat
on PLAYING over silence, offering a pause button for something that was not
going. A play that *does* work says so within a tick, from the source itself.

`ACTION_SAVE` (`:267`) reflects nothing at all, for the same class of reason:
whether the save is allowed, what quality it lands at and whether it fails are
all decided above this layer.

### `publish()`, and a latch worth knowing about

`publish()` (`:307`) loads artwork if the path changed, sets metadata and state,
builds the notification, and then either goes foreground or calls `notify()`.
The wake lock is acquired or released on the same pass (`:323`).

`startForegroundCompat` is wrapped in `runCatching`, and it returns whether the
service **is foreground afterwards** — checked with `getForegroundServiceType`,
not inferred from the call not throwing. For a battery-restricted app Android
ignores `startForeground` from the background *silently* ("not allowed due to bg
restriction", no exception), so a clean return proves nothing.

**`publish` asks, it does not remember.** The system can demote the service by
itself — for a battery-restricted app it does so the moment the screen goes off
— and nothing tells the service. So each publish reads the real state, and when
not foreground it calls `startForeground` if a start is **owed** (skipping that
is the uncatchable crash) or if sound is playing. Paused and owed nothing, a
demotion is left alone. The card is drawn with `notify()` whenever it was not
just drawn by `startForeground`.

**Only a raise owes anything.** `PlaybackService.show` sends a plain
`startService` whenever an instance is `live` (a SHOW has described something
since the last teardown) and falls back to `startForegroundService` — tagged
`EXTRA_OWED` — only when none is, or the plain start is refused. A
`startForegroundService` is a debt: the process is killed, uncatchably, if the
service is stopped, or is not foreground at delivery and does not answer in
time. Before this, every refresh was one — and after a silent demotion every one
of them went unanswered. That was the S21 FE's crash (`docs/RELIABILITY.md` § 12).

**Stopped while owing is fatal too.** Android records the debt when the call is
*made*, so `teardown()` uses `stopSelfResult(lastStartId)`, never bare
`stopSelf()`: with a SHOW queued behind a STOP, the service stays up and that
SHOW answers for itself. `DownloadService.stopSelfCompat` does the same.

**Media keys with no card** arrive through androidx's `MediaButtonReceiver`,
which also uses `startForegroundService`. The `else` branch of `onStartCommand`
goes foreground first, hands the key to the session, and tears down again in the
same main-thread message unless a SHOW has described something.

A refused raise is caught once, in `publishNowPlaying` (`src/player/nowPlaying.ts`),
because the local player publishes from inside engine listeners where a throw is
a fatal JS error. It is logged once per run of refusals with
`backgroundRestricted()`, and retried after 15 s or on a new track.

`Log.i` lines tagged `SpoolPlayback` record each promotion, demotion found, and
teardown. They survive R8 and are the fastest way to see this machinery on a
device: `adb logcat -s SpoolPlayback`.

### Artwork has a one-megabyte budget

`ART_MAX_EDGE` is 384 (`:102`). Cover art is handed to the system **by value**,
and a `MediaMetadata` crossing a binder transaction has about a megabyte to live
in — a 512px square at ARGB_8888 is 1,048,576 bytes exactly, the whole budget
for one field. Decoding is on a single-thread executor and only when the path
changes, because `publish()` runs on every transport change and re-reading a
JPEG each time puts file I/O on the main thread for a picture that has not moved
(`:464`). A decode that a later track overtook is dropped on the way back
(`:478`).

### Lifecycle

`START_NOT_STICKY` (`:281`). `onTaskRemoved` (`:285`) emits `stop` and tears
down, so a swiped-away task leaves no notification. `setOngoing(playing)`
(`:406`) means the card is dismissible exactly when it is paused, and the delete
intent is `ACTION_DISMISS` (`:409`) → `stop` + teardown. `teardown()` (`:573`)
releases the wake lock, clears the artwork fields, `stopForeground(REMOVE)` and
`stopSelf()`.

The wake lock is a `PARTIAL_WAKE_LOCK` named `spool:playback`, not reference
counted, with a four-hour timeout as a backstop (`:559-566`).

Anything not an understood action falls through to
`MediaButtonReceiver.handleIntent` (`:278`), which is how headset and Bluetooth
keys become the callbacks above.

### `PlaybackCommandBus` (`:597`)

A plain object with a synchronized listener list. Emission copies the list
before iterating and wraps each call, so a listener that throws does not stop
the others. The module registers in `OnCreate` and unregisters in `OnDestroy`.

---

## 6. `DownloadService.kt`

### The five-second fuse — verified

`startForegroundService()` starts a ~5 second timer, and if `startForeground()`
has not been called by the time it expires Android throws
`ForegroundServiceDidNotStartInTimeException` **at the app's main thread** and
kills the process. That exception comes from the system, so no `runCatching`
anywhere in this file can stop it. The only defence is to satisfy the contract
on the first thing that runs.

**Checked against the code: every command path does go foreground before it is
dispatched.** `onStartCommand` (`:128`) reads what the command knows in a first
`when` (`:133-144`, `START` and `PROGRESS` only), calls
`startForegroundCompat(build(...))` **unconditionally at `:150`**, and only then
enters the dispatch `when` at `:152`. `ACTION_CANCEL` and `ACTION_STOP` — and an
unrecognised or null action — all pass through line 150 first. On a stop this
raises a notification that the same main-thread message immediately removes, so
no frame is ever drawn with it; the cost is nothing and the alternative is a
killed process.

Both failure modes `AGENTS.md` names are closed by that one line: a `STOP`
arriving as the first command to a fresh instance (exactly what
`stopServiceIfIdle()` sends when a download fails early) and a `PROGRESS` that
overtook its `START`.

`startForegroundCompat` (`:194`) is separately wrapped for the *other*
foreground-service exception — `ForegroundServiceStartNotAllowedException`,
which is throwable **by the call** and therefore catchable, unlike the timeout.

### One slot, and it is enforced elsewhere

There is one `currentId`, one ongoing notification (`ONGOING_ID` 4711), and an
`ACTION_STOP` from whichever job ends first. **Two overlapping downloads do not
queue, they interfere**: the first to finish tears down the foreground service
the other is still running under, and Android 12+ will not let it simply be
started again from the background.

Nothing in this file prevents that. The lock is `takeSlot()` in
`src/browser/BrowserScreen.tsx`, over a single promise chain, and **its release
must sit in a `finally`** — every one of those bodies has an early return on
`E_CANCELLED`, and one skipped release wedges every later download until the app
restarts. See [FLOWS.md § 6](FLOWS.md#6-what-the-native-download-does).

### Three dead entry points

Confirmed by search across the whole tree:

- **`updateProgress` (`:39`) is never called.** `YtDlpModule` sends progress to
  JavaScript and never back to the service, so the ongoing notification shows an
  indeterminate *"Preparing…"* for the entire job. In-app progress is correct.
- **`notifyComplete` (`:51`) is never called.** There is no completion notice,
  and `CHANNEL_DONE` is created and never used.
- **`YtDlpCancelBus.register` (`:219`) is never called.** The notification's
  CANCEL action stops the service (`:154-156`) but no listener exists, so the
  yt-dlp process is not destroyed. Cancelling from inside the app works — that
  path is `YtDlp.cancel(id)` → `destroyProcessById`.

---

## 7. `MediaStoreWriter.kt`

A file written to app-private storage — or even dropped into `Movies/` with raw
file I/O — stays invisible to Gallery on modern Android. **Only a MediaStore
record makes it appear.** That is what this file is for, and it is why the
playlist and backup export goes through the same machinery.

`publish` (`:27`) and `writeText` (`:98`) share one shape: build
`ContentValues`, `insert`, stream into `openOutputStream`, clear `IS_PENDING`,
and **delete the row if anything in between threw** (`:71`, `:130`) — a half-
written pending row is a file the user can see and cannot play.

`IS_PENDING` only exists from Q. Below that there is no pending concept and the
legacy `DATA` column is set to an absolute path under
`getExternalStoragePublicDirectory`, with the directory created by hand
(`:46-54`, `:107-113`).

`publish` **deletes the source** on success (`:77`); the temp copy has served its
purpose and leaving it doubles disk use. `writeText` moves and deletes nothing.

### Where things land

| Call | Collection | Folder |
|---|---|---|
| `publish(audioOnly = true)` | `Audio.Media`, `VOLUME_EXTERNAL_PRIMARY` | `Music/Spool` |
| `publish(audioOnly = false)` | `Video.Media`, `VOLUME_EXTERNAL_PRIMARY` | `Movies/Spool` |
| `writeText` | `Downloads` from Q, `Files` below | `Downloads/Spool` |

`FOLDER` is deliberately not private (`:25`): `scanSaved` reads the library back
out of these folders, and a scan looking somewhere other than where publish
writes reports an empty gallery with the files sitting right there.

**Downloads rather than `Music/Spool` for text is deliberate**: a backup is not a
track, and a `.json` sitting among someone's music ends up in another player's
library scan.

### The volume mismatch, and what actually fixed it

`publish` writes under `VOLUME_EXTERNAL_PRIMARY` (`:145`, `:152`, `:159`) while
`YtDlpModule.audioCollectionUri` / `videoCollectionUri` scan under
`VOLUME_EXTERNAL` (`:834`, `:841`). **Both spellings resolve to the identical
row** — verified on device, `content://media/external/audio/media/99451` and
`content://media/external_primary/audio/media/99451` both return `_id=99451` —
but they are different *strings*, and `adoptSaved` de-duped on string equality,
so every manual save became two library rows.

**The constants were deliberately left mismatched.** `mediaKey` in
`src/core/storage.ts` normalises the uri instead, because changing the scan to
`EXTERNAL_PRIMARY` would have made every already-adopted row stop matching and
be adopted *again*. `forgotten` is normalised the same way, which is what makes
a removal stick. See `docs/RELIABILITY.md` D1. **Do not "fix" the volume
constants here** — that is the change the normalisation exists to avoid.

### Names are counted in bytes

`sanitise` (`:164`) strips `\ / : * ? " < > |`, trims, and calls
`limitBytes(180)`. `limitBytes` (`:177`) walks code points and stops before the
budget is exceeded, so it never cuts mid-character.

`take(120)` counts characters and the filesystem counts bytes. A title in styled
Unicode or emoji runs four bytes to the character, so 120 of them is 480 bytes
and the insert fails with `ENAMETOOLONG` — **the same defect that stopped the
download itself ever writing a file**, and it is per-video and absolute: the
title never changes, so that video can never be saved while plain-titled ones
save fine. 180 leaves room for the extension and for MediaStore's own
de-duplicating `(1)` suffix inside the 255-byte limit.

### Collisions

On Q and above the name is a `DISPLAY_NAME` and MediaStore de-duplicates it
itself with a `(1)` suffix — which is the reason for the 180-byte budget rather
than something closer to 250. Below Q the `DATA` path is given explicitly and
what MediaStore does with a colliding path is **not determined here**. Nothing
in this file checks for an existing row first.

---

## 8. `CookieJar.kt`

This is where being a real browser gets spent. The WebView holds a real,
consented YouTube session, and `CookieManager` can read **all** of it —
including the HttpOnly cookies `document.cookie` cannot see. Writing those to a
Netscape cookie file lets yt-dlp request as the same session the user is already
browsing in, which is what stops the media fetch coming back 403.

Four origins — `www.`, `m.`, `.youtube.com` and `www.google.com` —
de-duplicated by cookie name into a `LinkedHashMap`, with the domain flattened
to `.google.com` or `.youtube.com`.

Two details about the format:

- **Empty means `null`, not an empty file.** Callers omit `--cookies` entirely
  rather than passing a file with nothing in it.
- **A far-future expiry** — one year — because yt-dlp discards cookies that look
  like session cookies, and every one of these does.

### The jar is per-invocation and the caller deletes it

`write` returns a `File`, and **every caller owns what it gets back and must
`CookieJar.discard` it in a `finally`.** Both do: `listFormats` and `download`
each hold a `var jar: File?` and discard it however the body leaves — including
the `return@launch` on the rescue path in `download`'s catch.

This replaced one fixed `cacheDir/youtube-cookies.txt`, and it fixed two things
at once.

**A security one.** What the file holds is the login itself — `SAPISID`, `HSID`,
`SSID`, `__Secure-3PAPISID`. Anyone with those bytes is signed in as the user,
on any machine, until the user revokes the session at Google. The old file was
overwritten before every extraction and download and deleted by *nothing*, so a
device that had ever been signed in carried a plaintext copy of the credential
for the life of the install.

**A correctness one, which is the part that is easy to miss.** Extraction and a
download run concurrently on the same `scope`. With one shared name, the first
to finish would have deleted the file the other was still reading — so
"delete it when you are done with it" is only safe *because* the name is unique
per invocation. Doing the deletion without the rename would have been a new bug.

### Why it is ephemeral rather than encrypted

Encrypting the jar at rest buys nothing here: yt-dlp needs a real path to a
readable file, so an encrypted jar has to be decrypted to a second plaintext
file the moment it is used. That moves the exposure rather than removing it.
What shrinks the exposure is time, and the jar now exists for the seconds yt-dlp
is reading it.

`sweep` covers the one path `discard` cannot — the process dying mid-download —
and runs from `ensureInitialised`, which is the first thing any extraction or
download does. Anything older than 30 minutes goes.

`discard` truncates before deleting. That is **not** a secure erase and is not
claimed to be one; on a flash device with wear levelling nothing at this layer
can promise the blocks are gone. It is there because it costs nothing and does
clear the copy anything still holding the path would read.

### Where it lives

`noBackupFilesDir/session/`, not `cacheDir`. That directory is excluded from
Android's backup and device-transfer agents by definition, so a credential
cannot leave the device by that route even inside the window it exists.

Files are created empty, locked to owner-only, and *then* written, so there is
no instant at which the file exists and is group- or world-readable. The app
sandbox already makes that true on a healthy device — `lockDown` is three
syscalls against an OEM with a permissive umask, and the `setReadable(false,
false)` call before `setReadable(true, true)` is load-bearing, because the first
clears the bit for the owner too.

### `clear` — signing out

`CookieManager.removeAllCookies` + `flush`, `WebStorage.deleteAllData`, then
every jar on disk. Main thread only: both of the first two want it. Reached from
`AsyncFunction("signOutOfYouTube")`, which resolves the promise from the main
thread *after* the removal — the JS side's next act is to remount the WebView,
and a remount that overlaps the removal just writes the cookies back.

It does not sign the user out at Google. That session is Google's and only
Google can revoke it; this removes the device's copy, and the UI copy says so.

---

## 9. `TrialGuard.kt`

**This is the only copy that decides.** R8 obfuscates it and the signature pin
refuses a repackaged APK; neither reaches the JavaScript bundle, which ships as
Hermes bytecode that decompiles. `src/core/trial.ts` only *words* the refusal —
a patched bundle gets a UI that lies and a native layer that still says no.

None of it makes the build uncrackable, and the file says so in its own header.
Anything running on the attacker's hardware can be patched. The goal is to move
the cost from "clear app data" to "decompile, patch, resign, defeat the pin".

### `refuse(context, seconds)` (`:158`) — the whole decision

```
!enabled            -> null          (a full build refuses nothing)
!intact             -> "tampered"
expired             -> "expired"
remaining <= 0      -> "quota"
seconds > maxSeconds-> "tooLong"
```

`seconds` is what the extractor said; **0 means it did not say, and an unknown
length is not grounds for refusing.**

### The count is kept in two places that fail differently

`SharedPreferences("spool_trial")` is the fast one and dies with "Clear
storage". The mirror is `externalMediaDirs/.spool`, which was believed to
survive both — **and does not, on Android 11 and newer.** Measured on API 35:
`pm clear` empties the directory and an uninstall removes it. Treat the text
below as the original intent rather than as current behaviour. It once **survived both
clearing data and an uninstall** and needs no permission to write. `used()`
(`:77`) takes the larger of the two, so wiping either alone buys nothing — and a
tester who clears storage to reset the count loses their whole library doing it.

Verified on device: the mirror read `4` after `adb install -r` and incremented
to `5` only once a real file landed (`docs/RELIABILITY.md` § 1).

### The clock is checked in both directions

`expired()` (`:113`) refuses three ways, each with 26 hours of slack for time
zones, DST and NTP:

1. `now >= expiresAt` — the ordinary case.
2. `now < BUILT_AT - slack` — before the build existed is not a date this build
   can be running on.
3. `now < highWater - slack` — behind the furthest-forward time ever seen.

`highWater` (`:97`) is itself mirrored, and **it writes on read** when the clock
has moved forward. That is the one function here with a side effect, and it is
why `status()` is not purely a read.

### The pin

`intact()` (`:130`) compares SHA-256 of the first APK signer against
`BuildConfig.SIGNING_SHA256`. **A blank pin returns `true`** — that is the debug
variant, which has nothing to compare against and must not refuse.
`certificateHash` (`:136`) uses `GET_SIGNING_CERTIFICATES` from P and the
deprecated `GET_SIGNATURES` below it.

### What `trialStatus()` actually costs

`index.ts` and [ARCHITECTURE § 3](ARCHITECTURE.md#3-the-native-module-contract)
both call it "a preferences lookup and a short file read". In a **release trial
build** `status()` (`:168`) does rather more, all of it synchronously on the JS
thread: `expired()` → `highWater()` → a prefs read, a mirror **read**, and on a
forward clock a prefs write plus a mirror **write** (which itself re-reads via
`used()`); `intact()` → a `getPackageInfo` binder call and a SHA-256; `used()` →
another prefs read and mirror read.

Bounded in practice, because `src/core/trial.ts` caches the result and
`refreshTrial()` is called at launch and after a save, not per render. Worth
knowing before calling it anywhere hot.

In a **full build** (`TRIAL=false`) it is nearly free: `expired` short-circuits
at `:114` and `used` is the only I/O. In a **debug build** the pin is blank so
`intact` short-circuits too.

---


## 9b. `LicenseGuard.kt`

The same shape as `TrialGuard` — Kotlin decides, `src/core/license.ts` describes
— and for the same reason. What differs is what it is guarding against.

### It never touches the network

Spool plays a local library with the screen off and no signal, so entitlement is
decided entirely from a token already on disk. `src/core/license.ts` fetches one
when the device happens to be online; nothing here waits on that, and a user on
a plane keeps their subscription.

**Since accounts, a token is a lease of a few days, not the subscription.** The
format and this verifier are unchanged — `exp` is simply nearer, because the
server now renews it on every authenticated sync so that a device signed out or
blocked on the server loses entitlement within days. The consequence for this
file: `expiresAt` (and so `licenceStatus().expiresAt`) is no longer anything a
screen may print as "days left". The subscription's end is `paidThrough`, which
JavaScript persists (`dl.licence`, see DATA.md). The practical offline limit on
downloading is now the lease — a device offline for longer than it loses
*downloads* until it syncs, never its library or playback.

### `verify(context, token)` (`:99`) — the whole decision

Four things must hold, and null is returned for every failure without saying
which. A caller able to tell a bad signature from a wrong device from malformed
base64 would be an oracle, and no screen has anything different to say anyway.

1. The token splits into two base64url segments on the first `.`.
2. `SHA256withECDSA` over **the ASCII of the first segment** verifies against
   `BuildConfig.LICENCE_KEY`, parsed as an X.509 `SubjectPublicKeyInfo`.
3. Only then is the payload parsed. JSON has no canonical form, so a verifier
   that parsed first would compare its own re-serialisation against bytes signed
   by the server — key order and number formatting would eventually drift
   and licences would start failing for no visible reason.
4. `dev` equals `deviceId(context)`. Without it a licence is a file, and a file
   copies to a hundred phones.

**P-256 rather than Ed25519 because of minSdk 24.**
`Signature.getInstance("Ed25519")` needs API 33. The failure would appear only on
older phones — the ones least likely to report it.

**The signature the JCA accepts is DER, and WebCrypto emits raw `r || s`.** The
conversion is on the server (`rawToDer` in `server/src/license.js`) because
`node --test` can reach it and Kotlin cannot; `tests/licenceToken.test.mjs` verifies
the output with Node's own verifier, which wants exactly what Java wants.

### Nothing is trusted for having been stored

`remember()` verifies **before** writing, so a hostile or misconfigured server
cannot park bytes that every later launch has to re-reject, and it refuses a
token already expired — that would replace a good licence with a dead one, a
fault the user could not clear from inside the app.

`expiresAt()` re-runs the whole verification on **every** call rather than
caching a boolean. It costs tens of microseconds and it is what makes hand-editing
the preferences file achieve nothing.

### The clock is checked, in the opposite direction to the trial

A subscription expires in the *future*, so winding the clock back extends one —
the mirror image of the trial, where winding it back undoes an expiry. Same 26
hours of slack for time zones, DST and NTP.

### The pin applies here too, and that is not decoration

`expiresAt()` returns 0 outright when `TrialGuard.intact` fails. Without it the
pin had a hole shaped like a paying customer: subscribe legitimately, then
decompile, patch and resign — the token still verifies, because the server signed
it and it says nothing about which APK holds it, and `YtDlpModule.download` skips
`TrialGuard` entirely for an entitled device, so the pin never ran.

### Where `download` asks

Before `TrialGuard.refuse`, and the trial is skipped entirely when entitled — a
subscriber is a different state, not a tester on raised limits. `spendTrialSlot()`
is the matching half: a subscriber's saves must not draw down a counter that
survives an uninstall.

---

## 10. `AndroidManifest.xml`

### Permissions

| Permission | Why |
|---|---|
| `INTERNET` | yt-dlp, and the one artwork fetch |
| `ACCESS_NETWORK_STATE` | **Not referenced anywhere in `android/src/`.** Present for the libraries that read it |
| `FOREGROUND_SERVICE` | Both services |
| `FOREGROUND_SERVICE_DATA_SYNC` | `DownloadService`'s type. Android 14+ requires the per-type permission |
| `FOREGROUND_SERVICE_MEDIA_PLAYBACK` | `PlaybackService`'s type, same rule |
| `POST_NOTIFICATIONS` | 33+. Denying it costs the download notification **and the media card** |
| `WAKE_LOCK` | The partial lock in `PlaybackService` |
| `WRITE_EXTERNAL_STORAGE`, `maxSdkVersion=28` | Below Q, writing into `Movies/` or `Music/` is ordinary file I/O and needs the grant. On 29+ MediaStore lets an app insert its own media freely |
| `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` | **Reading is the opposite of writing.** Once the app is reinstalled — or the row was written by a previous install — its own published files count as someone else's media, so `scanSaved` needs a read grant. API 33 split the single permission into per-type ones |

The read permissions are not optional politeness. Measured on the user's device:
with `READ_MEDIA_AUDIO: granted=false`, Library showed **31 items over 64
files** — a half-empty library, which is the same failure as an empty one
wearing a disguise. Granting it by hand and relaunching went straight to 75 rows
(`docs/RELIABILITY.md` D5).

### Services

Both `exported="false"`.

`DownloadService` is `foregroundServiceType="dataSync"`.

`PlaybackService` is `foregroundServiceType="mediaPlayback"` — declared so the
system exempts it from the cached-process freezer and lets it run with the
screen off — and it carries an `intent-filter` for `MEDIA_BUTTON` so headset and
Bluetooth keys reach the session.

### The receiver

`androidx.media.session.MediaButtonReceiver`, `exported="true"`.
**`MediaSessionCompat` looks for this at construction** and logs the session as
unable to receive media buttons without it. It forwards the key to the service,
which hands it to the session's own callback.

---

## 11. Build

### `expo-module.config.json`, and the reference R8 cannot see

```json
{ "platforms": ["android"],
  "android": { "modules": ["com.afinitycode.spool.ytdlp.YtDlpModule"] } }
```

Expo resolves each module class **by that string**, at runtime, by reflection.
Nothing in the bytecode references `YtDlpModule`, so R8 concludes it is
unreachable and deletes it — and the app then dies at startup with an empty
module registry. This is the loudest of the R8 failures and the easiest to
diagnose.

### `modules/ytdlp/android/build.gradle`

Dependencies:

```
io.github.junkfood02.youtubedl-android:library:0.18.1   yt-dlp + Python 3.8
io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1    the merge/extract step
androidx.media:media:1.7.0                              MediaSessionCompat + MediaStyle
androidx.palette:palette-ktx:1.0.0                      the dominant colour
com.google.mlkit:text-recognition:16.0.1                OCR of payment screenshots
kotlinx-coroutines-android:1.8.1, core-ktx:1.13.1
```

**ML Kit is the bundled artifact, deliberately.** `text-recognition` carries
its Latin model inside the APK; the alternative,
`play-services-mlkit-text-recognition`, downloads the model through Play
services on first use. A sideloaded app cannot assume Play services is present,
current or willing, and the first use is the moment someone has just paid — the
worst time to discover it. The cost is APK size: a few MB of model and native
code per ABI (not measured on this build yet — see §12). 16.0.1 was the latest
on Google's Maven (`lastUpdated` 2024-08-07) when it was added.

It needs no keep rule: the AAR ships its own consumer ProGuard rules, and
nothing of ours reaches it by name. That is an expectation, not a measurement —
the first release APK with it in must run a screenshot through `recognizeText`
on a device before it is believed (the R8 rule below).

`androidx.media` rather than the platform classes because the compat pair is
what makes one notification builder work down to `minSdk 24`. `palette` because
the design's whole premise is that surfaces derive from the artwork, and pixels
are not reachable from JavaScript.

Trial fields, stamped into `BuildConfig` at build time:

| Property | Default | Becomes |
|---|---|---|
| `SPOOL_TRIAL` | `true` | `BuildConfig.TRIAL` |
| — | — | `BuildConfig.BUILT_AT` = `System.currentTimeMillis()` at configuration time |
| `SPOOL_TRIAL_DAYS` | `7` | `TRIAL_EXPIRES_AT` = `BUILT_AT + days` |
| `SPOOL_TRIAL_SAVES` | `20` | `TRIAL_MAX_DOWNLOADS` |
| `SPOOL_TRIAL_SECONDS` | `180` | `TRIAL_MAX_SECONDS` |
| `SPOOL_SIGNING_SHA256` | a pinned hash | `SIGNING_SHA256`, **release variant only**; `""` on debug |

The expiry is computed at build rather than stored on the device precisely so
there is nothing to clear, reset or reinstall past. **Extending a trial is a
rebuild, not a server call.** The pin is not a secret — it is readable from any
signed APK — so it lives in the tree.

Two packaging notes:

- **`useLegacyPackaging true` on jniLibs.** The bundled Python payload is a zip
  that must stay uncompressed-on-disk to be extracted at runtime; see the page
  size plugin below for the conflict this creates.
- **`abiFilters` here does *not* control APK size.** It constrains this module's
  own native compilation, not the jniLibs the youtubedl-android AAR brings
  transitively. Size is `withAbiSplits`' job.

Targets: `minSdk 24`, `compileSdk`/`targetSdk 36`, Java 17, Kotlin JVM target 17.

### The three config plugins

`android/` is generated by `expo prebuild` and is not committed, so a hand-edit
to its Gradle lasts exactly until the next prebuild. A config plugin runs *as
part of* prebuild and is therefore reapplied every time — including on a clean
CI checkout. All three are idempotent and all three throw rather than silently
no-op when the generated file is not shaped as expected.

**`withReleaseSigning.js`** injects a `release` entry into `signingConfigs` and
repoints the release build type at it. Credentials are never in the tree; the
injected Gradle reads `SPOOL_STORE_FILE`, `SPOOL_STORE_PASSWORD`,
`SPOOL_KEY_ALIAS`, `SPOOL_KEY_PASSWORD`. **When `SPOOL_STORE_FILE` is absent the
release build falls back to `signingConfigs.debug`** (`:64`) — otherwise Gradle
fails on a signing config with no store file.

**`withAbiSplits.js`** enables per-ABI splits with `universalApk false`. yt-dlp
arrives as a Python runtime plus an ffmpeg build **per ABI** — ~33 MB of ffmpeg
and ~13 MB of Python each — so a universal APK carries four copies of both:
253 MB of native libraries out of a 226 MB download. `x86` is excluded (emulator
only, and the module does not claim to support it); `x86_64` is kept so the
emulator works.

**`withPageSizeCompat.js`** sets `android:pageSizeCompat="enabled"` on
`<application>`. Android 16 devices use 16 KB pages and want native libraries
mapped directly out of the APK, which requires them stored **uncompressed** —
and we need them **compressed and extracted**, because youtubedl-android reads
`libpython.zip.so` off the filesystem. The two requirements are in direct
conflict; compat mode is the supported way out. Without it the system shows
*"This app isn't compatible with the latest version of Android"* on every
launch. Play would reject this for apps targeting Android 15+, which does not
bind a sideloaded app. The clean fix, if youtubedl-android ever reads its
payload via `ApplicationInfo.sourceDir`, is to drop legacy packaging and delete
this plugin.

### R8 — the keep rules in `app.json`

They live in `expo-build-properties.android.extraProguardRules`, **not** in
`android/app/proguard-rules.pro`, because prebuild regenerates that file. There
are **five** keeps and two `-dontwarn`s:

| Rule | The failure it prevents |
|---|---|
| `-keep class …ytdlp.YtDlpModule { *; }` | Expo resolves it by name from `expo-module.config.json`; R8 sees no reference and deletes it. App dies at startup with an empty module registry |
| `-keep class …ytdlp.PlaybackService { *; }` | Named in the manifest, which R8 does not rewrite |
| `-keep class …ytdlp.DownloadService { *; }` | Same |
| `-keep class com.yausername.** { *; }` | The engine reaches its Python payload through JNI and reflection |
| `-keep class org.apache.commons.compress.** { *; }` | **The quiet one.** `ExtraFieldUtils` registers each zip extra-field type from a static block by reflective `newInstance()`. R8 sees no constructor call, concludes `AsiExtraField` is never instantiated, and makes it **abstract**; the static block then throws "not a concrete class", `ZipUtils.unzip` never unpacks Python, and **ART marks the class permanently bad** — *"Rejecting re-init on previously-failed class"* — so every later attempt fails for the life of the install |

`TrialGuard` is deliberately **not** kept. It is meant to be obfuscated, and so
is everything else in the package.

No rule was added for ML Kit or `expo-image-picker`; both ship consumer rules
in their AARs. `recognizeText` in a release build is therefore on the list of
things only a device can prove.

**The commons-compress rule shipped missing once.** It survived because engine
init is lazy and the emulator pass only proved the app *launched*. Hence the
standing rule: **a release-mode shrinking change is not verified until a real
download completes on a real device from a fresh install.**

### CI — `.github/workflows/release.yml`

Push a `v*` tag (or dispatch manually).

1. **`preflight`** checks whether `KEYSTORE_BASE64` exists and emits
   `signable=true/false`. It is a separate job because **the `secrets` context is
   unavailable in a job-level `if`** — so a tag pushed before the secrets are
   configured skips cleanly with a warning instead of failing red.
2. **`build`** — Node 20, Temurin 17, `setup-android`, `npm ci`,
   `npx expo prebuild --platform android --no-install` (the signing config comes
   back through the plugin), decode the keystore into `$RUNNER_TEMP/release.jks`,
   then `./gradlew assembleRelease --no-daemon` with the four
   `ORG_GRADLE_PROJECT_SPOOL_*` variables.
3. **Verify and collect.** For every APK: `apksigner verify --print-certs`, and
   **fail hard if the certificate is `CN=Android Debug`** — a debug-signed
   release would mean the secrets silently failed to apply, and shipping one
   strands every user on the wrong key. Then rename
   `app-<abi>-release.apk` → `spool-<version>-<abi>.apk`, fail if zero were
   produced, and write `SHA256SUMS.txt`.
4. Upload as an artifact, and on a tag publish a GitHub release with the APKs,
   the checksums, generated notes and the sideload preamble.

---

## 12. What only a device can prove

Nothing in `tests/` executes a line of Kotlin. The Node suite covers the pure
TypeScript around this module — the client walk, the format model, storage — and
stops at the bridge. Everything below was established by measurement, and the
citation is where the measurement is written down.

| Behaviour | How it was established |
|---|---|
| **A download completes from a shrunk release build** | `Me at the zoo`, 648,107 bytes of `.m4a` into `Music/Spool`, fresh install, R8 on (§ 7). Earlier: 2,363,685 bytes on the S21 FE (§ 1). This is the bar every R8 change has to clear |
| **The card is ours and is claimed on first play** | Before any play the only session is expo-audio's; on first play `com.afinitycode.spool/spool` appears, becomes the media-button session, and carries `metadata: size=6` — not the `size=2, description=null` failure mode (§ 1, § 7) |
| **`PlaybackService` survives backgrounding across a track boundary** | Queue advanced at a track's natural end with the app behind HOME; `isForeground=true types=0x2` throughout (§ 1, § 7) |
| **Controls appear only where they are real** | Local track `actions=819`; page `actions=771` — skip bits gone, `SEEK_TO` kept, plus `custom actions=[Action:mName='Save]` (§ 1) |
| **Position extrapolation** | `dumpsys` shows a pinned `position` with a moving `updated` and `speed=1.0`, and the card's clock runs from that. Reads as a stuck `position=0` and is correct (§ 1) |
| **The WebView pin is what keeps a hidden page playing** | Without it, ~50 ms of sound per resume — identically screen-off and behind HOME, with audio focus still ours (`gain: GAIN, loss: none`) and the renderer still perceptible (`adj 51`). With it: five minutes screen-off unbroken, player at 6:08 against 1:14. Galaxy S21 FE, Android 16, WebView 150 (`AGENTS.md`) |
| **The resume watchdog must be metered** | An unmetered pause handler traded play/pause with Chromium ~60×/s; decoders created ~7× faster than released; at seventeen instances `NO_MEMORY … while in state 5/STARTING` and the pool was gone permanently for that renderer (`AGENTS.md`) |
| **Resume names and `--continue`** | A save cut at 1,622,016 bytes resumed from exactly 1,622,016; a second at 770,048 from exactly 770,048 (§ 10, N9) |
| **`finished()`'s exclusions, in the dangerous direction** | Network cut once the video half was complete: the download failed, published nothing, added no row — the silent film refused. *Try again* skipped the complete video half, resumed audio from exactly 344,064 bytes, merged, published 37.4 MB (§ 10, N10a) |
| **The `.temp.` exclusion specifically** | Caught in one frame of a retry: `.v144.mp4` at 35,189,497 bytes beside `.v144.temp.mp4` at 33,030,192, both `.mp4`, both newer than the attempt (§ 10, N10a) |
| **The N10 salvage itself** | The 73,474,823-byte clean run against the 73,036,036-byte failed one — a 438 KB difference, which is the cover the failed one never got. **The rescue path has still not been triggered on device**; no cheap way to force a postprocessor to fail was found (§ 10) |
| **The trial mirror survives a reinstall** | Read `4` after `adb install -r`, incremented to `5` only once a real file landed (§ 1) |
| **The notification's Save button** | `card#10 slot acquired`, then `+170.47s OK saved from the notification {"bytes":141092060}` with the app backgrounded — and the Save action disappeared from the card once the job existed (§ 9) |
| **The byte-budget filename rule** | Exercised by a download titled entirely in Devanagari (§ 8) |
| **`DownloadService` can kill the app** | Observed once on the emulator: process died with `ForegroundServiceDidNotStartInTimeException` while yt-dlp was still spawning. **The specific crash was main-thread starvation and has not reproduced**; the contract holes were real and are closed (§ 7, N1) |
| **Overlay UI cannot be verified by `uiautomator dump`** | Forty view-tree dumps found nothing while a screenshot in the same second showed the strip drawn over the WebView. Verify overlay UI by screenshot, timed off the `ui notice` log line (§ 7) |

### Still not proven, and worth saying plainly

- **`recognizeText` and `shrinkImage` have never run.** Added with UPI
  payments; `:ytdlp:compileDebugKotlin` builds, and nothing more. Unmeasured:
  OCR quality on real UPI receipts (GPay, PhonePe, Paytm, bank apps), the APK
  size ML Kit adds per ABI, and whether R8 leaves the recognizer working in a
  release build.

- **A physical device has not seen the current download model.** Passes § 7–10
  are all emulator, and only the `x86_64` APK — `arm64-v8a` and `armeabi-v7a`
  are built and never run. The largest remaining gap by some distance.
- **`finished()`'s "already downloaded" branch is reasoned, not run.**
- **A PO token has never been spent on a real download**, because no session
  tested has had one to give. `applyExtractorArgs`' token branch is therefore
  unit-tested only.
- **Screen-off playback over a long period**, and a track boundary crossed while
  locked.
- **Two active `MediaSession`s exist** whenever a library track plays — ours and
  expo-audio's — and only one notification is posted, so the "two cards" failure
  is not happening. But which session Android hands media keys to is arbitration
  between two of your own, and the loser changes with publish order. First place
  to look if a headset control ever acts inconsistently (§ 3, R1).
- **A debug-signed *release* build refuses every download in a trial build.**
  `build.gradle` pins `SIGNING_SHA256` for every release variant while
  `withReleaseSigning` falls back to debug signing when no keystore is supplied,
  so `intact()` is false and `refuse()` returns `tampered`. Inferred from code,
  not observed (§ 3, R2). It only bites trial builds: `refuse` returns `null` at
  `TrialGuard.kt:159` when `TRIAL` is false, so `-PSPOOL_TRIAL=false` is a clean
  way for a contributor without the keystore to build.

---

## 13. Where the code and the other books disagree

Recorded here rather than fixed, because a book is edited in the change that
makes it wrong.

- **`ARCHITECTURE.md` § 4** says downloads are named `<jobId>.<ext>`, in two
  places. They are named from `resumeKey` — `{videoId}.{a|vHEIGHT}` — with the
  job id only as a fallback (`YtDlpModule.kt:210`). `AGENTS.md` says the same
  thing in its byte-budget bullet and then corrects itself in the later
  "named for what it is, not for the attempt" bullet.
- **`ARCHITECTURE.md` § 7** heads the keep-rule block *"all four are
  load-bearing"* and then lists five. There are five keeps in `app.json`.
- **`ARCHITECTURE.md` § 3** types `download` as returning `{ path, bytes }`. It
  can also return `salvagedFrom` (`YtDlpModule.kt:345`), which is the whole N10
  fix.
- **`ARCHITECTURE.md` § 6** says *"all native work runs on … `Dispatchers.IO`"*.
  The five synchronous `Function`s do not — see §2.
- **`ARCHITECTURE.md` § 3** and `modules/ytdlp/index.ts:213` both describe
  `trialStatus()` as *"a preferences lookup and a short file read"*. See §9 for
  what it does in a release trial build.
- **`FLOWS.md` § 6** lists `finished`'s exclusions as images, `.part`/`.ytdl`
  and `.fNNN.`. `INTERMEDIATE` also matches **`.temp.`** and `.part-FragN`, and
  `.temp.` is the one N10a was about.
- **`src/core/log.ts:218` and `BrowserScreen.tsx:3090`** name a code
  `E_TRIAL_TOO_LONG`. The reason constants are camelCase, so the real code is
  `E_TRIAL_tooLong`. Nothing branches on it, so it costs only a misleading
  comment.
- **`README.md:343`** says a release build without signing properties *"produces
  a debug-signed APK, which is fine for testing"*. True only for
  `-PSPOOL_TRIAL=false` — see § 12.
