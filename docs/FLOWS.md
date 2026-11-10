# Spool — flows

The end-to-end sequences, in order. Where an ordering is load-bearing it is
called out, because most of the bugs this codebase has had were orderings rather
than logic.

Structure is in [ARCHITECTURE.md](ARCHITECTURE.md); what each feature does is in
[FEATURES.md](FEATURES.md).

---

## 1. Cold boot

**Before any of this**, `index.ts` imports `src/core/bootstrap`, whose module
body installs the crash captures and the `console` bridge and moves the previous
run's log aside. It has to be the first import in the file: ES imports are
hoisted and evaluated in source order, before any statement in the importing
module's body, so an installer called from `index.ts`'s body would run *after*
the whole app tree had been imported — which is exactly when a module-level
throw would go unrecorded. See [FEATURES § 16](FEATURES.md#16-diagnostics--the-flight-recorder).

`App.tsx` mounts `ErrorBoundary → SafeAreaProvider → ThemeProvider → PlayerProvider → BrowserScreen`.
The boundary is outside every provider on purpose: one inside the tree it guards
cannot draw once that tree is the thing that threw, and the providers are
exactly where a bad restored value would surface.
Fonts (Manrope, IBM Plex Mono) load first; until they do, a plain base-coloured
`Splash` fills the screen, because the type scale names those families directly
and rendering early would flash the system face at the wrong metrics.

`BrowserScreen`'s boot effect then runs, once:

1. **Load everything in parallel** — `hasSeenFirstRun`, `loadDownloads`,
   `loadSettings`, `loadSearches`, `loadSession`, `loadForgotten`,
   `loadPlaylists`, and `loadArtworkIndex`. The artwork index is in that list so a library whose
   covers are already known comes up with them rather than flashing placeholders
   on every launch.
2. **`forgottenRef.current = forgotten`** — *before* the scan below. Otherwise the
   first adoption runs against an empty forgotten-set and hands back everything
   the user has ever removed.
3. **`adoptFromGallery()`** — deliberately off the critical path. The library
   paints from what was stored and anything the gallery turns up folds in a
   moment later, rather than holding the first frame behind a MediaStore query.
   On a fresh install this comes back empty; see [§ 2](#2-first-run).
4. `setScreen(seen ? 'browse' : 'firstrun')`, `setBooted(true)`.
5. **`refreshTrial()`** — from the native side, the only copy a patched bundle
   cannot rewrite. If this is a trial build *and* first run is already done, the
   pre-release sheet opens. On a brand-new install it is deferred to the end of
   first run so the legal notice comes before the sales pitch.
   Just before it, `refreshLicence()` — a signature check against the token on
   disk, no network — because `refuseSave` consults the licence first.
   Then, not awaited: `loadAccount()` and `loadLicenceFacts()` in parallel, and
   only after both, `syncLicence()`. The order matters: the sync is
   authenticated and must not go out before the stored session has been read,
   and Profile's paid-through date comes from `dl.licence`, not the network.
   Signed out, the sync returns without a request. A separate effect registers
   `watchLicence()`, which syncs again whenever the app comes back to the front
   — the token is a lease of a few days now, and a music player can stay alive
   in the background for longer than that.
6. **Restore the session** — see [§ 9](#9-restoring-a-session-at-launch).
7. **`initEngine()`** — extracting the bundled Python takes a moment on first
   launch, so it happens now rather than making the user wait on their first
   download. Then `engineVersion()`, so the Profile row has something honest to
   say instead of claiming to be up to date.

The persistence effects (`records`, `searches`, `settings`) are all guarded on
`booted` rather than on the value being non-empty. Skipping the write when the
list was empty meant removing the last item never reached disk and it came back
on the next launch.

---

## 2. First run

`OnboardingScreen` — three steps, button-driven, no swiping:

1. **Welcome** → `I understand — continue`. The legal position is on this step,
   above the button that accepts it.
2. **What it does** → `Next`.
3. **Premium** → `Start browsing`, or `See the offer`. Absent entirely when
   `licence().entitled`.

Either button on the last step calls `finishFirstRun(showOffer)`, and its order
is load-bearing throughout:

1. `markFirstRunSeen()`
2. `requestNotificationPermission()` — API 33+ only
3. `requestMediaPermissions()` — branches on API level (see
   [FEATURES § 13](FEATURES.md#13-first-run-and-permissions))
4. `setScreen('browse')`
5. **`adoptFromGallery()` again** — load-bearing. The boot scan ran before the
   user had granted anything, and reading files another install wrote needs
   `READ_MEDIA_*`. Without this second call a reinstalling user taps through,
   lands on an empty Library over a full folder, and only gets their music back
   if they happen to relaunch. Measured: 0 adopted on first launch, 43 on the
   next.
6. **Only if `showOffer`**, raise a sheet: `PreReleaseSheet` in a trial build,
   `SubscribeSheet` otherwise.

**Step 6 used to be unconditional**, and with a premium step now in front of it
that was the same person sold to twice inside ten seconds. The sheet is raised
only when the user asked for it, and which sheet depends on which offer the
build has — see [UI.md](UI.md#first-run--three-screens-once).

**The general rule:** anything gated on first run must be re-run when first run
*finishes*, not skipped there.

---

## 3. Browsing to a watch page

1. The page navigates. `NAV_SCRIPT` posts a `nav` message (or
   `onNavigationStateChange` fires); `url` and `title` update.
2. `videoId = extractVideoId(url)` recomputes.
3. The FAB effect resets it to `ready` (or `idle`) and zeroes progress — once per
   navigation, and skipped while a download is `working` or `resolving`.
4. The wake pulse runs three beats, then stops.
5. Meanwhile `BACKGROUND_SCRIPT` starts reporting `media` messages about once a
   second, and `POTOKEN_SCRIPT` harvests `pot` / `visitorData` as the player
   response is parsed and media requests are issued.

Each `media` message does three things in `onMessage`:

- `onMedia(message)` — the background-playback hook (card, mini bar, service)
- `trackMedia(message)` — the play counter
- the **mutual-exclusion check** below

### Mutual exclusion, and its three guards

```js
const startedSomething = message.playing && browserPlaying.current !== message.id;
if (startedSomething) {
  if (screenRef.current === 'browse') pauseLocal();
  else if (localSounding()) pauseBrowserMedia();
}
```

Every clause was found by testing:

1. **Keyed on the page *starting* something**, not on it merely being playing.
   The page reports once a second, so a plain `if (message.playing)` also fires
   on a report sampled just before our own pause reached the page — pausing the
   library track the user had that instant started, from the tap that asked for
   it.
2. **`pauseLocal` only while the user is on Browse.** The WebView is never
   unmounted, so a hidden page can resume on its own (YouTube does this readily),
   and that read as a fresh start and paused the track the user had just tapped
   play on, from a tab where the browser was not even visible. Measured: it
   resumed for 92ms and stopped.
3. **`pauseBrowserMedia` only if something local is actually sounding.** The rule
   is mutual exclusion, so with nothing local playing there is nothing to be
   exclusive with. A Mix advancing to its next track is a page "starting
   something", so without this, with the user parked on any tab but Browse and
   the phone in a pocket, every track boundary killed the queue — silence, from
   the one rule meant to prevent two things playing at once.

---

## 4. One-tap download (`instantDownload`)

FAB tap in the `ready` or `failed` state:

1. `setDl('resolving')`
2. `listFormats({ videoId, url, title }, token.current)` — see
   [§ 15](#15-extraction-refused-client-walk-and-self-repair)
3. **Already in flight?** `jobs` is checked before `records`, because
   `findDuplicate` reads only rows that have *finished* — so a job still
   downloading was invisible to it. Measured: a retry and a tap on the same
   video produced two identical 48 MB files, of which the library showed one
   row and the other was disk nobody could see or reach. First tap explains,
   second commits, exactly as for a duplicate.
4. Pick from settings: `bestAudio(formats, kbpsFromQuality(audioQuality))` or
   `bestVideo(formats, heightFromQuality(videoQuality))`.
5. Nothing of the requested kind → fall back to the sheet rather than failing
   silently, because the user did ask for something.
6. `beginDownload(format.id, info, settings.instant === 'audio')` — **`info` is
   passed explicitly** because `setMeta` has not re-rendered yet, so reading
   component state here would look the pick up in the *previous* video's format
   list. The third argument is the *intent*, and it is passed for the same class
   of reason: `bestAudio` can answer with a muxed format when the manifest has
   no audio-only rung, and reading the kind back off that format would say
   "video" and save a file the user did not ask for. Only the sheet path has no
   intent to pass — there, the row that was tapped is the whole statement.

---

## 5. Held download (`resolve` → sheet → `beginDownload`)

Hold for 3,000ms → `resolve()` → `listFormats` → `setSheet(formats.length ? 'quick' : 'empty')`.
A pick then calls `beginDownload(pickId)`.

### `beginDownload`

1. Strip `:explicit`, find the format, derive `audioOnly` and a label
   (`audio` or `<height>p`), mint `jobId = <videoId>-<Date.now()>`.
2. **`refuseSave(durationSeconds)`** — checked here so the refusal can be worded,
   and again natively before anything downloads. On refusal: close the sheet,
   reset the FAB, flash the notice, stop.
3. Add a `Job` to the list and subscribe to `onProgress` filtered by id. **The
   FAB is handed straight back** — `setDl(videoId ? 'ready' : 'idle')`, "free the
   moment the job is on the list". It is not held for the length of a download;
   that arrangement was N8. Progress lives on the Library row.
4. `YtDlp.download(...)` — native. See [§ 6](#6-what-the-native-download-does).
5. On success: `publishToGallery(path, title, audioOnly)` → a `content://` uri.
6. `finish(record)` — prepend the record, **drop any earlier row for the same
   video**, `refreshTrial()` (a save has just spent a slot). The button is not
   told anything here; `fabState` derives `done` from the library itself.

   Dropping the older row is load-bearing: both paths write to one output file
   and publishing *moves* it, so a manual save of something already kept
   automatically deletes the file the old row points at. Without this the library
   lists a track that will not play.
7. On failure: `E_CANCELLED` resets quietly; anything else records a **failed**
   row carrying `videoId` — without it, the row does not know which video it was
   and the only thing it can offer is to forget itself.

---

## 6. What the native download does

**`DownloadService` has one slot, and every path must take it.** One
`currentId`, one ongoing notification, and an `ACTION_STOP` from whichever job
finishes first — so two overlapping downloads do not queue, they interfere: the
first to finish tears down the foreground service the other is still running
under, and Android 12+ will not let it simply be started again from the
background.

`takeSlot()` in `BrowserScreen` is the lock, over the one `downloadQueue`
promise chain. All four paths go through it — the FAB, the replay rule, the
notification's save button, and a failed row's *Try again*. The last two did not
until recently, and both are reachable while something is already downloading:
the card is reachable with the app off screen, and Library at any time.

**The release must sit in a `finally`.** Each of these bodies has an early
`return` on `E_CANCELLED`, and one path that skips the release wedges every
later download in the app until it is restarted. For the same reason the lock
swallows the previous holder's rejection: one failed download must not stop the
queue.

**And every command into `DownloadService` goes foreground before it is
dispatched.** `startForegroundService()` starts a ~5s fuse; if `startForeground()`
has not run by then the system throws
`ForegroundServiceDidNotStartInTimeException` at the main thread and kills the
process, uncatchably. Raising the notification unconditionally — even on a
`STOP`, which removes it in the same main-thread message — is what closes that.
See `AGENTS.md`.

`YtDlpModule.download`, on `Dispatchers.IO`:

1. **`TrialGuard.refuse(context, seconds)`** first — before any work. This is the
   check that decides.
2. `ensureInitialised()` — `YoutubeDL.init` + `FFmpeg.init` + sweep `.part` files
   older than 24h. A refused or interrupted 4K job leaves hundreds of megabytes
   the user never sees; yt-dlp resumes from `.part`, so only old ones are swept.
3. Start `DownloadService` in the foreground.
4. Build the request: `--no-playlist`, `--no-warnings`, `--newline`,
   `-o <downloads>/<stem>.%(ext)s`, `--embed-thumbnail`, `--embed-metadata`,
   then either `-f <fmt> -x --audio-format m4a` or
   `-f <fmt> --merge-output-format mp4`, then `applyExtractorArgs` and
   `applyBrowserSession`.

   **`stem` is `partialKey` — `{videoId}.{a|vHEIGHT}` — not the job id and not
   the title.** Not the title because
   [the filesystem counts bytes](ARCHITECTURE.md#filenames-are-counted-in-bytes);
   not the job id because a name minted per attempt is a name yt-dlp can never
   resume into, and `--continue` is on by default. The quality is in the key
   because a `.part` belongs to one format. Kotlin re-filters the string before
   it becomes a path.
5. Execute, emitting `onProgress` per line.
6. **`finished(outputDir, stem, startedAt)`** — files named `<stem>.*`, matched
   against the `INTERMEDIATE` pattern and excluding every one of: images
   (`--embed-thumbnail`'s leftovers), `.part` and `.part-FragN` and `.ytdl` (a
   download in progress), `.fNNN.` (half of a merge yt-dlp never completed), and
   **`.temp.` — the merge ffmpeg is still writing**. That last one is the
   dangerous omission rather than a tidy-up: a `.temp.` file carries the real
   container's extension and matches no `.fNNN.` pattern, so excluding only the
   latter publishes a *truncated* video. Caught on device with `.v144.mp4` and
   `.v144.temp.mp4` side by side, 35 MB against 33 MB. Among what survives that
   filter, prefer one modified since this attempt began.

   Two rules are folded in there. The old lookup fell back to the newest media
   file anywhere in the folder, which resolved a *failed* download as a success
   pointing at some earlier track and spent a trial save on it. And now that the
   name is shared across attempts, "a file with this name exists" is no longer
   proof this attempt wrote one — hence `startedAt`. Falling back to an older
   file of the same stem is still correct: that is yt-dlp's "already downloaded"
   case.
7. `TrialGuard.spend(context)` — only once a file exists.
8. Resolve `{ path, bytes }`.

**On failure, step 6 runs again before the rejection.** If a complete file is
there, it is resolved with `salvagedFrom` carrying the engine's complaint. This
is for the case where everything *after* the media succeeded except a
decoration: measured on a 31-minute save whose 73 MB of audio was complete and
whose cover art would not embed, and which the user was told did not finish. The
exclusions in `finished` are what keep it honest — a dropped connection leaves a
`.part` and nothing else, so it still fails — and a cancel is excluded outright,
since resolving there would put a track in the library the user never asked for.


`applyExtractorArgs` builds **one** `--extractor-args` string: yt-dlp *replaces*
rather than merges repeated args for the same extractor, so passing them
separately silently drops all but the last. With a token it emits
`player_client=<client>;po_token=<client>.gvs+<token>` — the client is the
caller's, not a constant, because a token is ignored when labelled for a client
we are not asking as — plus `visitor_data` only alongside a token, since on its
own it pins requests to a session with no attestation, which is worse than
nothing. Without one it emits `player_client=<client>` from the caller's chain.

Which attempt carries the token is `attempts()` in `core/ytdlp.ts`, not this
function: the token chain is walked first with it, and then the whole open chain
with it dropped, so **a bad token costs a slower walk rather than a failed
download**.

---

## 7. The replay rule fires

1. `usePlayTracking.onMedia` credits forward playhead movement, and when the
   session crosses `MIN_PLAY_SECONDS` it banks a start and calls `commit(..., true)`.
2. `commit` notifies `onPlayCounted(stat)` — **only on a banked start**, since
   only a fresh start can cross a threshold.
3. `onPlayCounted` reads `settingsRef.current` (a ref, because this fires from a
   WebView message rather than a render and must not close over settings from
   minutes ago). It returns early unless enabled, unsaved, and
   `starts >= settings.after`.
4. The job is appended to `downloadQueue` — **the same promise chain the browser's
   own saves use**, not a second one, so it is one at a time across both. Several
   thresholds falling in one session cannot compete for bandwidth with whatever
   the user is currently watching, and cannot land on top of a manual save.
   A separate auto queue is the pre-N6 arrangement in which two jobs shared
   `DownloadService`'s single `currentId`.

### `autoSaveStat`

1. **`markSaved(stat.id)` before any slow work** — a second threshold crossing
   during extraction cannot start the same download twice.
2. Return if the library already has a saved row for this video.
3. `listFormats` on `https://m.youtube.com/watch?v=<id>` — its own url, not the
   page the user is on now.
4. `wantAudio = keepAs === 'audio' || (keepAs === 'match' && stat.music !== false)`
5. Pick with `bestAudio`/`bestVideo`. **Nothing at all now throws a stated
   error rather than returning.** This used to `return` — no file, no row, no
   notice, and no line anywhere — on a rule whose entire contract is "this will
   be kept after N plays". It was also reachable far more often than it looked:
   a degraded manifest has no audio-only stream, so with `keepAs: audio` the
   rule was a silent no-op every time. See [§ 15](#15-extraction-refused-client-walk-and-self-repair).
6. `audioOnly` is **what was asked for**, not `format.kind` — `bestAudio` can
   answer with a muxed format, and `-x` extracts the audio from it.
7. `refuseSave` — a trial refusal is not a fault, so it records a `gave up` line
   rather than a failed row. The video stays unmarked so it is retried on a full
   copy.
8. Download, add a job with `auto: true`.
9. **Do not publish.** The record gets `uri: file://<path>` and `auto: true`.
10. On failure, record a failed row anyway — a silent failure leaves the user
   believing they have a file they do not have. It stays marked, so this does not
   become a retry loop.

The whole sequence runs under one `log.flow('replay', …)`, including the
decisions to do nothing. The rule has no interface, so the log *is* its
interface.

It never touches the FAB or the sheet: the user did not ask for anything and must
not be interrupted mid-video.

---

## 8. Saving from the notification

A third path, because the other two are both wrong for it. `beginDownload` wants
a format picked from a sheet and the whole point here is that there is no screen.
`autoSaveStat` is closer but differs in the two ways that matter: this *is* a
deliberate save, so it publishes to the gallery, and it must **not** mark the
video as taken — one save from the shade should not spend the user's third play
on a file they already asked for.

1. The card offers **save** only when `!!m.id && canSave(m.id)`, where `canSave`
   is `!records.some(saved for this video) && !jobs.some(for this video)`. Both
   halves matter: the first stops offering to save something already owned, the
   second stops a second tap during the seconds extraction takes.
2. `onNotificationCommand('browser', …)` receives `save`, **re-asks `canSave` at
   the moment of the tap** (the card is a picture of how things were when it was
   last painted; the library is the truth), and calls `onSave`.
3. `saveFromCard` **claims a job row immediately, before extraction**, for the
   same reason — a control with no screen behind it cannot show the user that a
   download is already running.
4. Quality from Profile defaults; `match` reads `playsRef.current[id]?.music`.
5. `refuseSave` and "no format" are thrown as `E_STATED` errors, so the recorded
   failure keeps its own wording. Running them through `readableError` would turn
   both into "Extraction failed — try updating the engine", which is a lie about
   the trial and a wild goose chase about the format.
6. Publish, record, done. **No acknowledgement is sent**: the download raises its
   own notification and appears in Library, and the card drops the button on its
   next report. A toast would be a third thing saying the same thing.

Saving does not touch playback at all. The user asked for a copy of what they are
hearing, not for it to stop while they get one.

---

## 9. Restoring a session at launch

1. `loadSession()` returns `{ ids, index, at }`.
2. Build `byId` from the **saved rows that have a uri**, map the ids through it,
   and drop the misses. This is where a queue entry whose download was removed
   while the app was closed quietly disappears instead of restoring as a row that
   plays nothing.
3. Find the previously-playing id among the survivors. If it is gone, land on
   whatever now occupies its place **from the start** — resuming a *different*
   track at the old track's playhead would be worse than either.
4. `restoreQueue(tracks, at, seconds)`:
   - drop both engines first (a second call would otherwise orphan a live one);
   - `claimed.current = false` and `releaseNowPlaying('local')` — a restored
     session has not played anything, so it is not entitled to a card, and
     putting one up here would mean starting a foreground service during launch
     for a track nobody asked to hear;
   - build the engine and seek, **without** `claimAudioSession()` — taking the
     session under `doNotMix` interrupts whatever else is playing, and this path
     was not asked for sound.

`toTrack` is a module-level function precisely so this can run before the
component's own callbacks exist. It takes the artist from the record itself here,
because the play index has not loaded yet.

---

## 10. Playing a library track

`playRecord(record)`:

- **Already the current track** → `toggle(track)`, which is a pause/resume. Not a
  restart of the whole queue.
- **Otherwise** → build the queue from every playable saved row in display order,
  find the index, `playQueue(tracks, index)`. If it is a video, open the full
  player.

Inside `PlayerContext.toggle`:

0. **The play lock** (`lockPending`, see [§ 19](#19-the-play-lock)) — only on a
   path that is about to make sound. Signed out, or holding a live lease, it
   returns synchronously and nothing below changes. Otherwise the start stops
   here, the claim goes out, and `toggle` is re-run from `toggleRef` once — and
   only if — it is granted. It sits *before* `silenceOthers` so a refused start
   has not paused the page on its way to doing nothing.
1. **`silenceOthers()`** — the playback gate, on *every* branch including the
   resume-the-loaded-track one. `playRecord` used to pause the page only when
   starting a *new* track, so resuming the already-loaded one — the most common
   action in the app — left the page holding audio focus and the track played for
   ~90ms.
2. Drop the other engine, `claimAudioSession()` for audio.
3. **Reuse the existing player** via `replace()` / `replaceAsync()` rather than
   building a new one, or the lock-screen handoff is lost.
4. `play()`, `claimed.current = true`, `trackRef.current = next` (ahead of the
   render, so a queue advance off screen describes the new track now), then
   `publish(0)`.

   **`publish(0)` and not `publish()`**: `replace()` swaps the file but
   `currentTime` still reads the *previous* track's playhead for a moment.
   Publishing that put a new track on the card at 54 seconds into a song that had
   just started.

### While it plays

- The `playbackStatusUpdate` / `timeUpdate` / `playingChange` listeners publish.
  The duration arrives with the first status update, not at load, so that is also
  where the scrubber gets its length.
- A 1s tick publishes as a backstop — every transport path publishes for itself
  and one will eventually be added that does not; that failure is silent.
- `publishNowPlaying` drops nearly all of these. See [§ 11](#11-a-notification-button-is-pressed).
- The session is written every 5s.
- `didJustFinish` / `playToEnd` → repeat-one seeks to 0 and replays, otherwise
  `advance.current()` steps forward. `step` wraps only when repeat is `all`, and
  sets `indexRef.current` ahead of the render so the card's skip buttons describe
  the track about to play.

---

## 11. A notification button is pressed

```
user taps            PlaybackService callback / onStartCommand
   │                        │
   │                        ├── pause: set playing=false, publish, then emit
   │                        ├── play:  emit only — never assume it worked
   │                        ├── seek:  set position, publish, emit seconds
   │                        └── save/next/previous/stop: emit
   ▼                        ▼
                     PlaybackCommandBus → YtDlpModule.sendEvent('onPlaybackCommand')
                            │
                     onNotificationCommand(source, handler)
                       delivers ONLY to the current card owner
                        ┌───────────┴───────────┐
                   'local'                  'browser'
              PlayerContext              useBackgroundPlayback
              togglePlayback/            say('play'|'pause'|'stop'),
              next/previous/             seek(n), onSave(...)
              seekTo/stop
```

The ownership test is why `pause` on a YouTube page does not also pause the
library track the gate had already stopped — which would then refuse to resume,
because the notification says it is playing.

`local`'s `play` and `pause` check the current state first, because these arrive
as explicit verbs: a `play` that blindly toggled would pause a track the card had
simply drawn stale.

`browser`'s `play` additionally arms a **4-second grace timer**; if the page has
not confirmed by then, the card is re-published as paused. See
[FEATURES § 9](FEATURES.md#9-the-media-notification--the-apps-fifth-surface).

### `publishNowPlaying`, in order

```js
if (owner !== source && !state.playing) return;   // you take the card by playing
const shape = shapeOf(state);                     // everything except the playhead
if (shape === mine && owner === source) {
  const expected = seen.playing ? seen.at + (Date.now() - seen.clock) / 1000 : seen.at;
  if (Math.abs(state.position - expected) < DRIFT_SECONDS) return;   // 2s
}
owner = source; published[source] = shape; positions[source] = {...};
YtDlp.setNowPlaying(state);
```

`published` is kept **per source**, not globally. A single "last published"
string looked equivalent and was not: with the browser holding the card, the
local player's next idle tick would differ from it in the *source field alone*
and quietly steal the notification while nothing about the local player had
changed.

---

## 12. The WebView renderer is killed

Android reclaims the renderer process under memory pressure while the app is off
screen, and its contract is that the instance must never be used again — it does
not repaint, does not navigate, and reloading does nothing. `onRenderProcessGone`
returns without letting the app die with it, and then does three things **in this
order**:

1. **`resetBrowserMedia()`** first — until it runs, the card is describing a video
   that no longer exists, and if the user is looking at the shade rather than the
   app that card is the only thing they can see.
2. `setEntry(entryRef.current)` — move the entry point to wherever they had got
   to. `entry` changes *only* here; binding it to the live URL would hand the
   WebView a new source on every navigation and reload the page the user had just
   left.
3. `setWebviewKey(k => k + 1)` — the replacement instance reads `entry` as it
   mounts, so the key must change last.

Playback genuinely is over at this point and nothing pretends otherwise: a hidden
document may not start media without a gesture, so a fresh page cannot resume
itself off screen. The honest outcome is silence, the notification gone, and the
video where they left it when they return.

---

## 13. Reinstall, or app data cleared

1. `scanSaved()` queries both MediaStore collections, matched on the **folder**
   (`RELATIVE_PATH` on Q+, the legacy `DATA` column below) rather than on
   anything stored in the file, because the folder is the only thing that
   survives every route a file can take.
2. `DATE_ADDED` is in **seconds** and the rest of the app in milliseconds; mixing
   them puts every restored row in 1970.
3. `adoptSaved(existing, found, forgotten)` adds anything whose uri is neither
   already known nor forgotten, with `id = found:<uri>` — derived from the uri so
   a second scan recognises its own work rather than adding the same file again.
4. Re-sorted newest first.

Safe to repeat on every launch: nothing in the app can remove a saved row, so a
rescan cannot resurrect something deliberately dropped — that is what `forgotten`
is for. A reinstall does forget the forgetting, and a fresh install offering
everything on the device is the right answer anyway.

Only manual saves come back. Automatic ones live in app-private storage, which
Android deletes with the app.

---

## 14. Removing a row

`forget(id)`:

1. If the row has a uri, prepend it to `forgottenRef` and persist. The file
   survives a removal by design, so without this the next launch's scan would
   find it and hand back the row the dialog just promised was gone.
2. Drop it from `records`.
3. `forgetArtwork(id)` — otherwise a re-download of the same thing inherits the
   old row's cached "no artwork here" and never looks again.

---

## 14b. Signing out of YouTube

`signOut` in `BrowserScreen`, from **Profile → Sign out of YouTube**:

1. `Alert.alert` confirms, and states the boundary: the device forgets the
   session, the library stays, and Google is not told.
2. `signOutOfYouTube()` → `AsyncFunction("signOutOfYouTube")` → `main.post` →
   `CookieJar.clear`: `CookieManager.removeAllCookies` + `flush`,
   `WebStorage.deleteAllData`, then every jar in `noBackupFilesDir/session/`.
3. The promise resolves **from the main thread, after the removal**.
4. Only then: `setEntry(HOME_URL)`, `setUrl(HOME_URL)`, bump `webviewKey`.

**Step 3 before step 4 is the load-bearing order.** The page on screen at the
moment of signing out is authenticated, and a WebView left running through the
removal writes its cookies straight back — so a remount that overlaps the clear
leaves the user signed in with a control that reported success. The native side
resolves on the main thread specifically so the JS side cannot get ahead of it.

Then `setScreen('browse')` and a `flashNotice`, because the notice strip only
draws on Browse and a signed-out home feed is the only proof the user can check.

### What it does not do

End the session at Google. That is Google's to revoke, from the account's device
list. A download already in flight keeps the jar it was handed — it was minted
before the clear and is discarded by its own `finally` — so signing out does not
break a running save, and the next one goes out unauthenticated.

---

## 15. Extraction refused: client walk and self-repair

`withClientFallback(hasToken, run, judge?)`:

`attempts()` builds the list of tries first. **Holding a token does not shorten
it** — that is the whole of N12:

```
attempts(hasToken):
    hasToken → leg('token', TOKEN_CHAIN)  ++  leg('open', OPEN_CHAIN, tokenDropped)
    else     → leg('open', OPEN_CHAIN)

    TOKEN_CHAIN = ['mweb', 'web']
    OPEN_CHAIN  = ['tv', null, 'web_embedded', 'mweb', 'android_vr']

    each leg is led by its own remembered client — `preferredToken` for the
    token leg, `preferredOpen` for the open one — and the rest of the leg is
    ordered by the persisted scoreboard in `core/clients.ts` (`orderChain`).
```

The second half of the token case is load-bearing. A held token narrows the
request to the two clients that could have minted it, so an expired one, or one
bound to another video, would leave two chances where a tokenless request had
five. Appending the open chain with the token dropped means an exhausted token
ends where an empty pocket would have started.

Then the walk over that list:

```
for each attempt:
    threw, and looksBlocked(e)      → next attempt
    threw anything else             → throw immediately (broken pipe, cancel)
    answered, judge says degraded   → keep as `fallback`, next attempt
    answered clean                  → remember it for its mode, return

every attempt refused or degraded, and this session has not updated yet:
    YtDlp.updateEngine(), clear both pins, wipe the scoreboard, drop
    fallback, walk the whole list again

still nothing clean, but something answered → return the best degraded answer
nothing answered at all                     → throw the last error
```

The pin is **per mode**, not one global one: a client that proved good while
tokenless says nothing about the same client on a tokened request.

`looksBlocked` matches
`403|forbidden|sign in|not a bot|unable to download|player response|precondition|unavailable|format is not available|no video formats|needs to be reloaded|nsig`.
A refusal is worth another client; a broken pipe or a cancel is not. The last two
terms were added from live logs, and `The page needs to be reloaded.` is the
specific phrase that twice stopped the walk on the second client of five — do not
trim them back.

### Why a successful answer can still be wrong

A client that is refused does not always throw. It can return, successfully, a
manifest holding one muxed 360p and nothing else — and the walk used to accept
that, because nothing had gone wrong in any way it could see.

Measured on the phone: `android_vr` answered thinly, was pinned for the rest of
the session, and the clients behind it were never asked. (It is last in
`OPEN_CHAIN` today for exactly this reason — since 2026 it needs a GVS token, and
without one it answers thinly rather than refusing.) Every layer downstream then behaved *correctly* on a manifest that
was wrong — `bestAudio` found no audio-only stream, and the replay rule returned
without a word.

`judgeManifest` therefore judges the answer as well as the throw: no formats at
all, or no audio-only rung, which every healthy YouTube manifest has. Audio is
the default `keepAs`, so that second rule is the difference between the replay
rule working and it doing nothing.

**A degraded answer is kept, not discarded.** If the whole chain does no better,
the best one seen is returned rather than thrown away — a thin manifest still
downloads something, and something is what the user asked for. That is what
makes it safe to judge harshly: being wrong costs a slower walk, never a failed
download.

The engine repairs itself **once per session** — it is a network call. Every
client being turned away is also exactly what a months-stale extractor looks
like, and a sideloaded app gets no store updates, so in-place repair is the only
path there is.

The user-facing route to the same thing is Profile → Extraction engine, which
reports honestly afterwards: "Engine updated — the extractor is now X" or
"Already current … so a failure here is not a stale engine".

---

## 16. A trial build refuses a save

Two checks, deliberately:

1. **TypeScript** (`refuseSave` in `core/trial.ts`) — so the refusal can be
   worded before the user waits for an extraction that was never going to be
   allowed. Order: tampered → expired → quota → too long. `seconds === 0` means
   the extractor did not say, and an unknown length is not grounds for refusing.
2. **Kotlin** (`TrialGuard.refuse`) — inside `download`, before any work. Same
   order, same rules, and this is the one that decides. It rejects with
   `E_TRIAL_<reason>` and its own wording, because that copy survives a patched
   bundle.

`refreshTrial()` is called after every completed save, so the chip and the sheet
move as slots are spent.

---

## 17. Browser background playback, end to end

```
user leaves the app
      │
      ├─ Android fires visibilitychange / pagehide
      │     BACKGROUND_SCRIPT catches it in the capture phase on window,
      │     reads the REAL hidden state from the saved descriptor,
      │     stopImmediatePropagation() so YouTube never sees it,
      │     and calls resume()
      │
      ├─ Android pauses the media anyway
      │     the 'pause' handler asks: was a finger on the screen in the last 700ms?
      │        yes → the user meant it. wanted = false.
      │        no  → a pause on the heels of our own resume is that resume
      │              failing, so it is counted; then resume() immediately,
      │              inside the handler.
      │              (not on the interval — background timers are throttled hard)
      │              resume() spends a budget: one a second, three failures and
      │              it stops asking. A resume buys a hardware decoder.
      │
      ├─ AppState 'change' fires in the app
      │     inject(setPageBackgrounded(true))   — queued, lands on return
      │     if the page was playing and the service is not up yet, raise() now.
      │       This is the last chance: Android 12+ refuses a foreground service
      │       started from the background.
      │
      └─ the page's 1s interval keeps running:
              background = reallyHidden()
              applyCommand()   — read the spool_cmd cookie (BEFORE resume, so a
                                 pause the user just asked for clears `wanted`
                                 before the watchdog can undo it)
              resume()         — wanted && !ended && paused → attempt(v)
              report()         — post a media message

app side, per report (useBackgroundPlayback.onMedia):
      clear a dismissal if this video plays again or another takes its place
      setPagePlayback(...)                      — feeds the mini bar
      if (!hasMedia && !wanted) drop() ; if (!hasMedia) return
      if (!id) return                           — a feed preview is not a card
      resolveVideoArtwork(id)                   — idempotent, one fetch per video
      if (playing || serviceUp) raise(message)  — publish to the card
```

### Why the watchdog has a budget

`resume()` looks free and is not. It re-enables the page's video track, and
Chromium answers by asking Android for a decoder — for a 1080p AV1 stream, a
hardware one. Off screen that decoder starts fine but the element pauses again
about 140ms later, so the unmetered handler and Chromium traded play and pause
about sixty times a second. Decoders were created roughly seven times faster
than they were released; at seventeen concurrent instances the pool was
exhausted and every later `MediaCodec.start()` returned `NO_MEMORY` for the life
of the renderer. Audio survived about twenty seconds of that and then stopped
for good, while the create/release loop ran on at ten a second until Android
killed the renderer.

What the user saw: playback stopped a few seconds after the screen went off, and
coming back showed a video stuck on "loading" over a progress bar that was
already buffered — the data was there, nothing could decode it. Backgrounding
within two or three seconds of starting a track looked fine, because YouTube had
not yet upgraded to the stream that needs that decoder.

So the watchdog pays: one resume a second, and it stands down after three in a
row are undone. The budget is restored by a touch, by an explicit `play`
command, by the page coming back on screen, or by playback surviving a few ticks
without help. `tests/backgroundScript.test.mjs` holds each of those.

### What the budget does not fix, and what does

With the metered watchdog alone, the meltdown was gone — three decoder creations
instead of thousands, no `NO_MEMORY`, the process alive at the end — **and the
page's audio still stopped**, about 50ms after each resume.

It was not the screen and not the codec pool: **pressing HOME with the screen on
stopped it exactly the same way.** It was not audio focus either — Chromium's
own `AudioFocusDelegate` still held `gain: GAIN, loss: none` — and it was not
starvation: backgrounded, the app sat at `adj 50` and the WebView renderer at
`adj 51`, both perceptible, so the foreground service was doing its job.

What was left is the layer under everything else in this section. Freezing
`document.hidden` keeps the *page* from finding out it was backgrounded.
**WebView suspends the media pipeline of a WebView it considers hidden**, and it
decides that from the Android view, which no amount of lying to YouTube reaches.

So the app tells the view instead. `YtDlp.setWebViewVisible(true)` re-dispatches
`View.VISIBLE` to the browser's WebView once a second, which puts AwContents —
and only AwContents — back to visible, and the page keeps its decoder and keeps
playing. Measured on the same device: five minutes with the screen off, the
audio stream `started` throughout, the session never leaving `PLAYING`, and the
player reading **6:08 / 7:39** on return against 1:14 when the screen went off.
Backgrounded with HOME and the screen on, the same.

The pin has to be re-sent because the real window visibility belongs to
ViewRootImpl and our telling is not recorded there — one shot would be undone by
the next thing that re-dispatched the truth, off screen where nothing would
notice.

**It is held only while something the user asked for is playing.** A pinned
WebView goes on decoding video nobody is looking at, so `syncPin` re-evaluates
on every report — `away && (playing || wanted)` — and unpinning hands the real
visibility back rather than merely stopping. Measured: pausing from the shade
while backgrounded put the session to `PAUSED`, tore the audio stream down, and
Chromium released the AV1 decoder and did not create another.

`wanted` as well as `playing`, for the reason the rest of this section keeps
giving: between two tracks the page honestly has nothing playing, and a WebView
allowed to sleep there does not come back for the next one.

The card is also re-raised, without the page having moved, when a cover lands
(`onArtworkChange`) and when the library changes (`save.revision`) — the page is
not a clock, so a save finishing while it sits paused would otherwise leave the
button offering to save a file that now exists. `revision` is
`` `${records.length}:${jobs.length}` `` rather than their sum, because a save
finishing retires a job *and* adds a record, which leaves any total unchanged at
exactly the moment the card most needs repainting.

---

## 18. Teardown

- **`stop()` on the player** — drops both engines, `claimed = false`,
  `releaseNowPlaying('local')`, clears queue and index, and `saveSession(null)`.
- **The mini bar's ×** for a page — records the dismissed id, says `stop` to the
  page (which is a pause, there being no other verb), clears the store, drops the
  card.
- **React unmount** — `releaseNowPlaying('local')`, `drop()` in the background
  hook, both engines released, any pending play-index write flushed. The
  notification outlives React, so tearing the tree down has to take it.
- **`YtDlpModule.OnDestroy`** — unregister the command bus, stop
  `PlaybackService`, destroy every running yt-dlp process by id.
- **Task swiped away** — `PlaybackService.onTaskRemoved` emits `stop` and tears
  down, so no notification is left behind.

---

## 19. The play lock

`src/core/playLock.ts`, wired into `PlayerContext` at four points. Only when
signed in.

**Starting sound** — `toggle`'s resume and new-track branches and
`togglePlayback`'s play branch call `lockPending(again)`:

1. `playPermitted()` — synchronous: no session, or a lease/permit whose `until`
   has not passed → go ahead now.
2. Otherwise `claimPlay(again)` posts `/v1/play/claim {device, takeover:false}`
   with a 5 s timeout and hands the reply to `judge` (pure):
   - `{ok:true, leaseMs}` → held until `now + leaseMs − 10 s`; `again()` runs.
   - `409 {device}` → the "Playing on *device*" sheet, holding `again` as the
     retry. `Play here instead` → `takeOver()` → claim with `takeover:true` →
     on success, `again()`.
   - anything else — offline, timeout, 5xx, 429, 400 — is no news: allowed as
     a 60 s permit if `dl.serverContact` is under 24 h old, otherwise the
     "offline" sheet and no sound.
   - the session ending mid-claim (401/403) → allowed; there is no account left.

**While anything is loaded** — an interval of `HEARTBEAT_MS` (60 s) calls
`beat(engine.playing, pauseNow, resume)`:

- playing → re-claim without takeover. A 409 here means another device took
  over: `pauseNow()` and the "Playback moved to *device*" sheet. A network
  failure changes nothing — the track plays on; only the *next* start is judged.
- not playing and holding a lease → release it. This is what catches a pause
  from a path that never said so.

A late tick (Android throttles background timers) just means the lease may have
lapsed on the server; the next beat re-claims *without* takeover, and a 409 then
correctly means someone else started in the gap.

**Stopping sound** — the pause branches of `toggle` and `togglePlayback`,
`pauseNow` and `stop` call `releasePlay()`: fire-and-forget
`/v1/play/release`, and only if a *lease* (not an offline permit) is held. The
consequence worth knowing: a resume after a pause pays one network round trip,
because the lease was given back.

Not gated: repeat-one's replay and anything else that continues the track
already playing — the lease is live, and the heartbeat is watching.

---

## 20. Paying for a subscription

`SubscribeSheet`, over `core/payments.ts`.

1. **Mount** — `loadPendingOrder()`: an unexpired order from before a process
   death reopens straight on the pay step.
2. **Signed out** → `openAccount({ next: 'paywall', reason })` closes this sheet
   and opens the account sheet; a successful sign-in there forces a licence
   sync and reopens the paywall with the same reason.
3. **Continue** → `startPayment(plan)` → `/v1/pay/start`. The order is saved as
   `dl.pendingOrder`. A `signed-out` answer goes back to step 2.
4. **Pay** → `Linking.openURL(upiUrl)`; the user leaves for a UPI app, or scans
   the QR from another phone.
5. **Upload** → `launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })`
   → `YtDlp.recognizeText(original)` (a failure leaves the text empty and
   carries on) → `YtDlp.shrinkImage(original, 1600, 80)` (a failure uploads the
   original) → `submitScreenshot(order, jpeg, text)`: multipart `order`, `text`,
   `image`, 45 s timeout.
6. **approved** → `rememberPaidThrough`, `clearPendingOrder`,
   `syncLicence({ force: true })` — all before the sheet renders "You are all
   set", so the download button is unlocked by the time it says so.
   **review / rejected** → reasons, and the WhatsApp message; the order is kept
   for "Try another screenshot".
7. **I have already paid** → `syncLicence({ force: true })`, then read
   `licence()` fresh.
