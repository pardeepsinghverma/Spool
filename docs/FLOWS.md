# Spool — flows

The end-to-end sequences, in order. Where an ordering is load-bearing it is
called out, because most of the bugs this codebase has had were orderings rather
than logic.

Structure is in [ARCHITECTURE.md](ARCHITECTURE.md); what each feature does is in
[FEATURES.md](FEATURES.md).

---

## 1. Cold boot

`App.tsx` mounts `SafeAreaProvider → ThemeProvider → PlayerProvider → BrowserScreen`.
Fonts (Manrope, IBM Plex Mono) load first; until they do, a plain base-coloured
`Splash` fills the screen, because the type scale names those families directly
and rendering early would flash the system face at the wrong metrics.

`BrowserScreen`'s boot effect then runs, once:

1. **Load everything in parallel** — `hasSeenFirstRun`, `loadDownloads`,
   `loadSettings`, `loadSearches`, `loadSession`, `loadForgotten`, and
   `loadArtworkIndex`. The artwork index is in that list so a library whose
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

`FirstRunScreen` → "I understand — start browsing":

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
6. If this is a trial build, open the pre-release sheet.

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
3. Pick from settings: `bestAudio(formats, kbpsFromQuality(audioQuality))` or
   `bestVideo(formats, heightFromQuality(videoQuality))`.
4. Nothing of the requested kind → fall back to the sheet rather than failing
   silently, because the user did ask for something.
5. `beginDownload(format.id, info)` — **`info` is passed explicitly** because
   `setMeta` has not re-rendered yet, so reading component state here would look
   the pick up in the *previous* video's format list.

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
3. `setDl('working')`, add a `Job` to the list, subscribe to `onProgress`
   filtered by id.
4. `YtDlp.download(...)` — native. See [§ 6](#6-what-the-native-download-does).
5. On success: `publishToGallery(path, title, audioOnly)` → a `content://` uri.
6. `finish(record)` — prepend the record, **drop any earlier row for the same
   video**, `setDl('done')`, `refreshTrial()` (a save has just spent a slot), and
   after `motion.doneHold` reset the FAB.

   Dropping the older row is load-bearing: both paths write to one output file
   and publishing *moves* it, so a manual save of something already kept
   automatically deletes the file the old row points at. Without this the library
   lists a track that will not play.
7. On failure: `E_CANCELLED` resets quietly; anything else records a **failed**
   row carrying `videoId` — without it, the row does not know which video it was
   and the only thing it can offer is to forget itself.

---

## 6. What the native download does

`YtDlpModule.download`, on `Dispatchers.IO`:

1. **`TrialGuard.refuse(context, seconds)`** first — before any work. This is the
   check that decides.
2. `ensureInitialised()` — `YoutubeDL.init` + `FFmpeg.init` + sweep `.part` files
   older than 24h. A refused or interrupted 4K job leaves hundreds of megabytes
   the user never sees; yt-dlp resumes from `.part`, so only old ones are swept.
3. Start `DownloadService` in the foreground.
4. Build the request: `--no-playlist`, `--no-warnings`, `--newline`,
   `-o <downloads>/<jobId>.%(ext)s`, `--embed-thumbnail`, `--embed-metadata`,
   then either `-f <fmt> -x --audio-format m4a` or
   `-f <fmt> --merge-output-format mp4`, then `applyExtractorArgs` and
   `applyBrowserSession`.

   **The output template is named for the job id, not the title.** See
   [ARCHITECTURE § filenames](ARCHITECTURE.md#filenames-are-counted-in-bytes).
5. Execute, emitting `onProgress` per line.
6. **Find the result by name** — `listFiles().filter { it.name.startsWith(id) }`,
   excluding images, `.part` and `.ytdl`. The old rule fell back to the newest
   media file anywhere in the folder, which resolved a *failed* download as a
   success pointing at some earlier track — and then spent a trial save on it.
7. `TrialGuard.spend(context)` — only once a file exists.
8. Resolve `{ path, bytes }`.

`applyExtractorArgs` builds **one** `--extractor-args` string: yt-dlp *replaces*
rather than merges repeated args for the same extractor, so passing them
separately silently drops all but the last. With a token it emits
`player_client=web;po_token=web.gvs+<token>` (plus `visitor_data` only alongside
a token — on its own it pins requests to a session with no attestation, which is
worse than nothing). Without one it emits `player_client=<client>` from the
caller's chain.

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
4. The job is appended to `autoQueue`, a promise chain — **one at a time**, so
   several thresholds falling in one session cannot compete for bandwidth with
   whatever the user is currently watching.

### `autoSaveStat`

1. **`markSaved(stat.id)` before any slow work** — a second threshold crossing
   during extraction cannot start the same download twice.
2. Return if the library already has a saved row for this video.
3. `listFormats` on `https://m.youtube.com/watch?v=<id>` — its own url, not the
   page the user is on now.
4. `wantAudio = keepAs === 'audio' || (keepAs === 'match' && stat.music !== false)`
5. Pick with `bestAudio`/`bestVideo`; return if nothing fits.
6. `refuseSave` — the rule has no interface, so a refusal says nothing and simply
   does not save. The video stays unmarked so it is retried on a full copy.
7. Download, add a job with `auto: true`.
8. **Do not publish.** The record gets `uri: file://<path>` and `auto: true`.
9. On failure, record a failed row anyway — a silent failure leaves the user
   believing they have a file they do not have. It stays marked, so this does not
   become a retry loop.

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

## 15. Extraction refused: client walk and self-repair

`withClientFallback(hasToken, run)`:

```
hasToken → run(null) once           # a token pins player_client=web anyway,
                                    # so walking would repeat the same request 5×

otherwise, pass 1:  [preferredClient, ...rest]  or  CLIENT_CHAIN
    for each client:
        success → remember it, return
        looksBlocked(e) → next client
        anything else (broken pipe, cancel) → throw immediately

    every client refused, and this session has not updated yet:
        YtDlp.updateEngine(), clear preferredClient, go to pass 2

pass 2: walk the chain again
still failing → throw the last error
```

`looksBlocked` matches `403|forbidden|sign in|not a bot|unable to download|player response|precondition|unavailable`.
A refusal is worth another client; a broken pipe or a cancel is not.

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
