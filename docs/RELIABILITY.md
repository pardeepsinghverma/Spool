# Spool — reliability map

A full pass over the app on a physical device, and the checklist that pass
produced. Written so the next person can repeat it rather than rediscover it.

**Session:** 2026-08-15 · Samsung SM-G990E (Galaxy S21 FE), Android 16 / SDK 36,
arm64 · release APK built from the working tree at the time, R8 enabled, signed
with the real release key · trial build, 7 days, 20 saves, 3-minute cap.

Everything below was observed on that device unless it says otherwise. Where a
claim is inferred from code rather than seen, it says so.

---

## 1. What is confirmed working

These were exercised directly and behaved as `docs/UI.md` describes. This half
matters as much as the defects — it is the part that does not need re-testing
every time something nearby changes.

### The build itself

- **A real download completes from a shrunk release build.** This is the bar
  AGENTS.md sets for any R8 change, and it passes: the Python payload unpacked,
  extraction ran, and a 2,363,685-byte `.m4a` landed in `Music/Spool`. The
  `commons-compress` keep rules are doing their job.
- `tsc --noEmit` clean. Node suite **291 tests across 71 suites, all passing**
  (`node --experimental-strip-types --import ./tests/harness/register.mjs --test "tests/*.test.mjs"`
  — the flag is required; without it every file fails to load).

### Playback and the media notification — the strongest area

- **Background survival across a track boundary.** Backgrounded with HOME, the
  queue advanced at the track's natural end (`JANA GANA MANA` → `जन गण मन`),
  audio kept running, and `PlaybackService` stayed foreground
  (`isForeground=true types=0x2`).
- **The card is ours, and it is claimed on first play.** Before any play the
  only session is expo-audio's; on first play `com.afinitycode.spool/spool`
  appears, becomes the media-button session, and carries real metadata — not the
  `size=2, description=null` failure mode the book warns about.
- **The card matches the reference layout.** Artist · source on the second line
  (`Milind Mulekar Music · On this device`), a real scrubber reading
  `00:02 / 01:04`, prev/pause/next, artwork behind it.
- **Transport works from outside the app.** `KEYCODE_MEDIA_PAUSE` / `PLAY` /
  `NEXT` all took effect and advanced the queue.
- **Controls appear only where they are real.** Local track: `actions=819`
  (PLAY_PAUSE, SEEK_TO, SKIP_NEXT, SKIP_PREV, PAUSE, STOP). Page:
  `actions=771` — the skip bits are gone and `SEEK_TO` remains, exactly as
  documented, plus `custom actions=[Action:mName='Save]`.
- **The playback gate fires.** Starting a page video put the local session to
  `PAUSED` and handed the card to the page with the `YouTube` source label.
- **A feed does not get a card.** The home feed's muted autoplay preview ran
  without raising anything; the card still showed the local track.
- **Only one card**, despite two sessions existing (see §3).
- **Full player** — real cover, `saved` tick, working scrubber (1:27 / 3:49),
  shuffle/prev/play/next/repeat, populated *Up next*, no tab bar, and correctly
  **no shape toggle** on an audio track.
- **Mini bar carries the page** as its fifth state — square art, sub-line
  `YouTube`, pause control, progress line — on a local tab and never on Browse.
- **Resume comes back paused** after a cold launch.
- **Position is not pushed on a timer** and that is correct: the state pins
  `position` with a moving `updated` and `speed=1.0`, and the card's clock runs
  from the extrapolation. This reads as a stuck `position=0` in `dumpsys` and is
  not a bug.

### Screens

- **Home** — trial chip, 1:1 cards with real artwork, `On repeat` with counts
  (`1 play · 6 min`), mini bar above the tab bar.
- **Filter chips genuinely filter both lists**, with per-section empty states
  (`Nothing saved as video.` / `Nothing on repeat is video.` /
  `Nothing on repeat has been saved yet.`). The previously-inert control is wired.
- **Library** — `ON THIS DEVICE · N ITEMS · M MB`, provenance line
  (`You saved this`), sizes in mono, sort cycling Newest → Largest → Title A–Z
  with the label shown in mono only when off-default, and verified ordering
  (289 → 65 → 56 → 18 MB under *Largest*).
- **Remove asks first** and promises the file stays; removal persisted across a
  relaunch.
- **Profile** — discrete 2/3/5 play steps, the honest helper text ("A play counts
  after five seconds of watching"), Keep-as segmented control, **both quality
  rows open real pickers** (2160p…480p), storage as **text with no meter**, no
  "Playback & network" row, legal copy present.
- **Extraction engine row does update in place** — reported
  `The extractor is already at 2026.07.04` after a tap. Its resting label is
  "tap to update", which is not a version; see §4.
- **Search** — local index answers instantly, honest count
  (`4 on this device. Nothing else matches locally.`), the cloud strictly behind
  a button, and the mono line `the cloud is never searched without a tap`.
- **Browse** — full-bleed page, no mini bar, FAB inert grey on a feed and filled
  + tinted on a watch page, 3-second hold opens the format sheet with mono
  metadata (`1080p · mp4 · ~6 MB`).

### Trial

- Pre-release sheet raised **once per cold launch**, showing `7 days`,
  `16 of 20`, `3 min`, and the pricing copy with no fake strikethrough.
- **The save counter survived a reinstall** — the `externalMediaDirs` mirror
  read `4` after `adb install -r` and incremented to `5` only once a real file
  landed.
- Chip present on Home/Library/Profile, absent from Search and Browse.

---

## 2. Defects found

### D1 — Every manual save became two library rows *(high — fixed)*

**`MediaStoreWriter.publish()` writes under `VOLUME_EXTERNAL_PRIMARY`;
`YtDlpModule.audioCollectionUri()` / `videoCollectionUri()` scan under
`VOLUME_EXTERNAL`.** The same MediaStore row therefore has two different uri
strings, and `adoptSaved` de-dupes on exact string equality of `uri` — so the
scan never recognises a file that a record already owns and adopts it a second
time.

Verified two ways:

- Both volumes resolve the identical row:
  `content://media/external/audio/media/99451` and
  `content://media/external_primary/audio/media/99451` both return `_id=99451`.
- Reproduced from a clean action: downloaded one file → **1 row, 48 items**;
  restarted the app → **2 identical rows, 49 items**, with one file on disk.

Standing damage on the test device: **49 rows for 47 files**, with duplicate
pairs visible everywhere — Search for "jana" returns **4 rows for 2 files**, each
appearing once with its real title (`JANA GANA MANA || …`) and once
filename-derived (`JANA GANA MANA __ …`).

Second consequence, same root cause: the `forgotten` set is keyed on the same
uri. Removing a *record* row stores the `external_primary` form, which a later
scan's `external` form will not match — so a removal can be undone by the next
launch. (Not reproduced here: on this device both files already had adopted rows,
so there was nothing new to re-adopt. The mechanism is the same one proven above.)

**Fixed in two halves, and the second was only obvious once the first was on the
phone.**

`mediaKey` in `src/core/storage.ts` normalises the uri before comparing it,
rather than changing either volume constant. Normalising is what makes it safe
to ship: changing the scan to `EXTERNAL_PRIMARY` would have made every existing
adopted row stop matching and be adopted *again*. `forgotten` is normalised the
same way, which is what makes a removal stick regardless of which half spelled
the uri.

That stops new duplicates and does nothing about the ones already there —
which is a distinction worth stating plainly, because the first version of this
note claimed the fix "tidies the library up" and it did not. Measured four days
later on the device, after the old build had been in use throughout: **three
rows over two files** for one title, and 75 rows against 69 files overall.

So `dedupeByFile` collapses rows that name the same file, keeping the app's own
record over the row adopted under a filename — the record has the real title, the
`videoId` and the artist, and merging the other way would leave a tidier list
that had forgotten which video it was looking at. It returns the same array when
there is nothing to merge, so a healthy launch writes nothing.

Covered by `tests/storage.test.mjs`: both spellings resolve to one key, audio and
video of the same id stay distinct, `file://` paths are untouched, an existing
row is not re-adopted under the other volume, a removal survives the mismatch,
the record wins over the adopted row, gaps are filled from whichever row had the
fact, and failed rows are never merged. Closing this also closed a gap the suite
had previously only documented — two scan rows sharing a uri used to produce two
rows with the same id, which collide as list keys.

Covered by `tests/storage.test.mjs`: both spellings resolve to one key, audio and
video of the same id stay distinct, `file://` paths are untouched, an existing
row is not re-adopted under the other volume, and a removal survives the
mismatch.

### D2 — The trial refused over-length videos silently *(high — root-caused and fixed)*

**This is what "downloads are failing" actually was.** The engine was never
broken.

Controlled comparison, same device, same build, minutes apart:

| Video | Length | Result |
|---|---|---|
| Kaisi Teri Khudgharzi OST | **5:05** | extraction ran (`client accepted: android_vr`), then no download token and nothing on screen |
| Jana Gana Mana (HD) | **0:47** | `download token` → **3,169,777 bytes saved**, trial counter 0 → 1 |

The trial caps videos at 180s, so `TrialGuard` correctly returned
`REASON_TOO_LONG` for the 5:05 — but the refusal never reached the screen.
Twenty view-tree polls over 25 seconds after the tap found no notice text at any
point.

**Root cause: `notice` was a write-only state.** `BrowserScreen` declares
`const [notice, setNotice] = useState(...)`; `flashNotice` sets it for 3s;
`beginDownload` calls `flashNotice(refused)` — and the bare `notice` identifier
is never rendered in the file. The only `notice=` prop goes to `LibraryScreen`
and passes an unrelated expression (`failedToday >= 3 ? … : null`). The second
caller, `flashNotice('Files are saved to Movies/Spool')`, was invisible for the
same reason.

**Fixed** by rendering the strip on Browse, above the FAB that was tapped —
warn-coloured text in place, no dialog. `docs/UI.md` updated in the same change.

**The fix is not yet confirmed on the device, and should not be treated as
done.** It typechecks, the 269-test suite passes, and it is built and installed;
but the verification run never got a clean sample. The phone fell to 11% battery
with `mBatteryLevelLow=true`, dozed repeatedly, and — the part that actually
blocked it — the Browse page kept auto-advancing through a YouTube Mix, so the
watch page changed under each tap and `videoId` reset with it. In those attempts
the FAB produced *no* `ReactNativeJS` output at all, which says the tap never
reached an extraction, not that the strip failed to draw. Re-test on a charged
phone, on a watch page that is not part of a Mix.

Note the two halves are separate: the fix makes the app *honest*, but the
3-minute cap still stands. Downloading ordinary 3–6 minute music on this build
needs a different cap — `-PSPOOL_TRIAL_SECONDS=…` — or `-PSPOOL_TRIAL=false`.

The general lesson is worth keeping: a write-only state is invisible to the type
checker and to every test that does not drive the real screen, and a limit whose
refusal is silent is indistinguishable from a bug in the thing it limits.

**One caller is still dead, and the fix above does not reach it.**
`onChooseFolder={() => flashNotice('Files are saved to Movies/Spool')}` is a prop
on `FirstRunScreen`, and the `screen === 'firstrun'` branch **returns early** —
before the strip in the main tree is ever reached. So that string still cannot
appear. Either render a strip inside the first-run branch too, or hoist the
notice above the early return. Left undone deliberately rather than folded into
an unrelated build.

### D3 — Video downloads have no cover art *(low)*

Rows for saved `.mp4` files (`Big Buck Bunny`, `Meem Se Mohabbat`,
`MERI ZINDAGI HAI TU`) show the placeholder film-strip glyph while every audio
row has real artwork. Consistent with the book's "no cover anywhere" case for
restored rows with no `videoId`, so not a contradiction — but it means the video
half of the library is uniformly grey, which is worth a deliberate decision
rather than an inherited one.

---

### D4 — Two downloads can still overlap from the other two paths *(medium, known)*

`DownloadService` is single-slot: one `currentId`, one ongoing notification, and
an `ACTION_STOP` from whichever job finishes first. The browser's own downloads
and the replay rule now share one serial chain, so neither can overlap. **The
notification's save button and a failed row's *Try again* still start
immediately**, as they always have, so either can land on top of a running job.

Not fixed here because it predates the queue work, neither can be triggered in a
burst the way the FAB can, and routing them through the chain is a change worth
testing on a device rather than shipping blind. The honest state is: the common
path is safe, two uncommon ones are not yet.

---

### D5 — A denied media permission silently halves the library *(high)*

Observed on 2026-08-19, on the user's own device: Library reported **31 items**
where the two Spool folders held **64 files**. MediaStore knew all 64. The cause
was `READ_MEDIA_AUDIO: granted=false` — under scoped storage the scan then
returns only rows this install owns, so a little over half the library simply was
not there. `POST_NOTIFICATIONS` was denied in the same state, which also means no
ongoing download notification and no media card.

Granting `READ_MEDIA_AUDIO` by hand and relaunching took it straight to 75 rows,
so nothing was lost — it was never being read.

What makes this worth fixing rather than noting: **the app says nothing.** The
whole reason `scanSaved` exists is that an empty Library over a full folder is
unacceptable, and a half-empty one is the same failure wearing a disguise —
harder to notice, because it looks like a library rather than a bug. Permissions
are requested once at the end of first run and never again, so a denial, a
"Clear storage", or Android's split of audio from video leaves no path back. The
scan can tell: it knows how many rows MediaStore returned and whether it holds
the permission to see other apps' files.

---

### D6 — The client walk gave up on the second client of five *(high — fix believed, not yet confirmed)*

Observed live on 2026-08-19, twice in a row on unrelated videos, and it is a
plain download failure with no explanation on screen:

```
[spool] client accepted: android_vr      ← listFormats resolved here
[spool] download token: poToken=NO       ← the download begins
[spool] client refused: android_vr       ← and is turned away
[spool] engine error (download): ERROR: [youtube] ukbgoQNFbqg:
        Requested format is not available.
```

`withClientFallback` walks `android_vr → tv → ios → web` for *each* call, so the
client that listed the formats is not always the client that downloads them. A
format id only means something inside the manifest it came from, so once the
chain moves on, `140` names nothing. `preferredClient` exists precisely to keep
the two in agreement — its comment says so — but it cannot help when the
preferred client is refused mid-download.

It compounds: `looksBlocked` does not match "Requested format is not available",
so this is not treated as worth another client either. The job simply dies, and
`readableError` has no branch for it, so what the user gets is the free-space
and connection copy on a phone with neither problem.

**The first attempt at this was wrong, and it is worth writing down why.** The
reading above — a stale format id used against a client that never published it
— fits the log exactly, so `selector` was changed to follow every id with a
description of the same stream (`140/bestaudio[abr<=130]/bestaudio`). Rebuilt,
installed, retried: **identical failure on a third video.** A tidy explanation
that fits the evidence is not the same as the cause.

The actual fault is one line further out. `looksBlocked` decides whether a
failure is worth asking a different client, and it did not match
`format is not available` — so the walk read that as a real answer and stopped
on the **second client of five**, with `ios`, `web` and the default never tried.
A client refused mid-download does not always say 403; sometimes it returns a
manifest with nothing usable in it, and that is what yt-dlp calls this.

Both changes are kept. Widening `looksBlocked` is the fix; the `selector`
fallbacks are worth having anyway, since a chain that now walks further is a
chain more likely to land on a client whose ids differ. Neither is confirmed on
the device yet — the phone kept locking behind its keyguard, and this needs the
same three-videos-in-a-row test that exposed it.

Covered by `tests/ytdlp.test.mjs`, including a walk that reaches `web` through
four clients returning nothing usable.

---

### D7 — Without a PO token, gated videos are refused by every client *(open)*

After D6 was fixed the walk runs to the end, and on one video **all five clients
refused**, every attempt logging `poToken=NO visitorData=yes`. No file, no
explanation on screen.

`src/browser/potoken.ts` harvests the token from the page's own media requests —
the app is a browser, so the page has already minted a real one — and its
docstring states the condition plainly: *"harvesting needs the page to actually
start streaming."*

**In the failing runs the page was not streaming.** Checked directly: no audio
from the app's pid and no media session at all, on a watch page opened
programmatically ~55s earlier. So this is not evidence that the harvester is
broken; it is evidence that a download started before playback has no token, and
that a gated video then has nothing to fall back on.

What is not known, and needs the user's own session to answer: whether their real
failures happen this way. Someone who watches and then downloads should have a
token by then. Worth measuring before designing around it — the obvious
candidates (wait briefly for a token, or say why) are both premature until the
real case is observed.

The one thing that is certain: when it happens, the app says nothing. The job
ends and `readableError` has no branch for it, so the copy blames free space and
connection.

---

## 3. Risks that are not yet failures

### R1 — Two active media sessions for one app

With a library track playing, our package owns **two** sessions, both `active`
and both `PLAYING`:

- `com.afinitycode.spool/spool` — ours, correct metadata, holds media buttons
- `androidx.media3.session.id.ExpoAudioBasicMediaSession_…` — expo-audio's

Only **one notification** is posted, so the "two cards for one app" failure
AGENTS.md warns about is **not** happening today. But which session Android hands
media keys to is arbitration between two of your own sessions, and the loser
changes with publish order. If a headset or Bluetooth control ever acts
inconsistently, this is the first place to look.

### R2 — A release build without the keystore refuses every download

Inferred from code, **not observed** — this machine has the real keystore in
`~/.gradle/gradle.properties`, so the build was release-signed and the pin
matched.

The trap: `modules/ytdlp/android/build.gradle` sets `SIGNING_SHA256` to the
hardcoded release certificate hash for **every** release build, while
`plugins/withReleaseSigning.js` falls back to **debug signing** when
`SPOOL_STORE_FILE` is absent. A contributor without the keystore therefore gets a
debug-signed APK pinned to the release cert → `TrialGuard.intact()` false →
`REASON_TAMPERED` on every download. README currently says the opposite:

> Without signing properties configured this produces a debug-signed APK, which
> is fine for testing.

Either derive the pin from the key actually used, skip the pin when falling back
to debug signing, or correct the README.

---

## 4. Book drift

`docs/UI.md` is trusted, so these should be reconciled rather than left:

- The format sheet's door reads **"More…"**; the book says *"All 14 formats"*.
- No pick in the sheet carries the documented **"your default"** label.
- The **Extraction engine** row's resting label is "tap to update"; the book says
  it *"shows the real version from the native module"*. It does show the version
  after a tap.
- The sheet's video header shows a **placeholder** thumbnail even though the same
  video's artwork resolves correctly on the notification card.

---

## 5. Not covered in this pass

Stated plainly so nobody reads this as a clean bill of health:

- **The replay rule end to end.** Requires playing one video to threshold and
  waiting for the automatic save; `On repeat` counts are populated and the
  Profile controls are wired, but no auto-download was observed completing.
- **First run on a fresh install**, and the `scanSaved` re-run after the
  permission grant. Not attempted because the device holds the user's real
  library and auto-saved files are app-private and unrecoverable by design.
- **The card's Save button** (the download path with no screen behind it).
- **Renderer-killed recovery** — the WebView `key` change under memory pressure.
- **Failure surfaces**: "Didn't finish" group, *Try again*, out-of-space
  behaviour, and the `Finishing` state past 99.9%.
- Expiry and quota-exhausted trial states (only the length limit was reached).
- iOS entirely.

---

## 6. The pre-release checklist

Ordered by how expensive the failure is to discover late.

1. **A real download completes on a real device from a fresh install**, release
   build, R8 on. Nothing below matters if this fails, and launching successfully
   does not test it — engine init is lazy.
2. **Background audio survives a track boundary** with the app off screen:
   confirm the queue advances and `PlaybackService` is still
   `isForeground=true types=0x2`.
3. **`dumpsys media_session`** — our `spool` session is the media-button session,
   metadata is `size≥6` with a real title, and the app owns no second *card*.
4. **The card, by eye**: artist · source on line two, a scrubber with real
   elapsed and duration, and skip buttons present for a track and absent for a
   page.
5. **The gate**: start a page video over a library track and confirm the local
   session goes `PAUSED`.
6. **Save one item, then relaunch** and confirm the library count goes up by
   exactly one. (This is D1's regression test.)
7. **Attempt something the trial must refuse** and confirm the refusal is
   *visible*, not just enforced. (D2's regression test.)
8. **Remove a row, relaunch**, confirm it stays removed.
9. `tsc --noEmit` and the Node suite, with `--experimental-strip-types`.


---

## 7. Second pass — 2026-08-21, emulator (SDK 35, x86_64)

A pass focused on **downloads and the diagnostics that explain them**, on a
release build with R8 on and `-PSPOOL_TRIAL=false`, from a fresh install. Where
a claim is inferred rather than seen, it says so.

### Closed from the list above

- **D2 (trial refusal invisible) — confirmed fixed on a device.** The strip
  draws over the WebView above the FAB and reads *"Pre-release builds can save
  videos up to 3 minutes. This one is 9:57."*

  Two things made this hard to check and are worth knowing: `uiautomator dump`
  **cannot see it** — forty polls across the live window found nothing while a
  screenshot in the same second showed it drawn — and it lasts three seconds
  while extraction takes an unpredictable four to eight, so a fixed sleep tests
  nothing. Verify overlay UI by screenshot, timed off the `ui notice` log line.

- **Book drift: the Extraction engine row** does show the real version after a
  tap (`2026.08.19`, green), and reports *"Already current … so a failure here
  is not a stale engine"*.

### New defects, all fixed in this pass

- **N1 — `DownloadService` could kill the whole app.** Observed once: the
  process died with `ForegroundServiceDidNotStartInTimeException` while yt-dlp
  was still spawning, taking the download with it. `startForeground()` was
  called on `ACTION_START` alone, so a `STOP` arriving first to a fresh instance
  — what `stopServiceIfIdle()` sends when a download fails early — called
  `stopSelf()` having never gone foreground. Every command now goes foreground
  before it is dispatched, and the call is wrapped like `PlaybackService`'s.

  **Be careful about what this fixes.** The crash actually observed was
  main-thread starvation: the log's last line is `progress 0%` and the kill came
  ~10s later, which means `onStartCommand` never ran at all — no ordering fix
  reaches that, and it was very likely the loaded emulator. The contract holes
  were real and are closed; the specific crash is unreproduced since.

- **N2 — the extraction-failure sheet blamed YouTube for everything.** It read
  "YouTube changed something … an update may already fix it" for every failure
  and offered *Update engine* first. With the network off, that is a wrong
  diagnosis attached to an action that needed the connection it had just failed
  to use. `readableError` had already worked out the truth; the sheet simply
  never took it. Same shape as D2. Now the reason is the body, and the title and
  update button appear only when `looksStale` says the engine is a suspect.

- **N3 — the walk stopped on client two of five, again, with a new phrase.**
  Live on the release build: `android_vr` answered with **one muxed 360p** (the
  degraded manifest from D7, now correctly rejected), then `tv` threw
  `The page needs to be reloaded.` — which `looksBlocked` did not match, so the
  chain gave up with `ios`, `web` and the default untried. Added, with `nsig`.

- **N4 — the replay rule could fail in total silence.** With no usable format it
  simply `return`ed: no file, no row, no notice, no log line, on a rule whose
  contract is "this will be kept after N plays". And it was reachable far more
  often than it looked — a degraded manifest has no audio-only stream, so with
  `keepAs: audio` it was a silent no-op every time. It now throws a stated error
  and records a failed row like every other path.

- **N5 — `bestAudio` could not see a muxed stream**, so an audio save was
  impossible by construction on a degraded manifest even though `-x` extracts
  the audio perfectly well. Its own docstring already promised it "falls back
  rather than returning nothing".

- **N6 — D4 (overlapping downloads) closed.** `takeSlot()` is one lock and all
  four paths take it; the release sits in a `finally`. Confirmed on the device:
  a *Try again* and a FAB tap in the same minute produced **"DOWNLOADING · 2"**
  with one row *Finishing · audio* and the other **"Waiting for the current
  download"** — queued, not overlapping. Both then completed and the app
  survived. (That run also confirmed the **"Finishing"** state past 99.9%, which
  §5 had listed as never covered.)

- **N7 — the duplicate test could not see a download in flight.** `findDuplicate`
  reads `records`, which only holds rows that have *finished*, so a second tap
  on a page whose first job was still running went straight past it. The test
  above produced **two identical 48 MB files**; `dedupeByFile` then collapsed
  them to one library row, which is worse than it sounds — the second file was
  disk nobody could see or reach. `instantDownload` now checks `jobs` first,
  with the same "first tap explains, second commits" answer a duplicate gets.

### Confirmed working

- **First run on a fresh install**, both permission prompts, and the
  pre-release sheet firing *after* first run rather than during it — one of the
  gaps §5 listed as never covered.
- **A real download completes from a shrunk release build** — `Me at the zoo`,
  648,107 bytes of `.m4a` into `Music/Spool`, with the full flow recorded. Then
  a full-length one: a 4:28 track, **12,285,824 bytes**, non-trial release build.

- **That second download is also the proof that every fix here was needed.**
  The recorded walk:

  | Client | Answer |
  |---|---|
  | `android_vr` | 1 format: a muxed 360p, no audio-only — **rejected by `judgeManifest`** |
  | `tv` | `The page needs to be reloaded.` — **matched only after N3** |
  | `ios` | `Requested format is not available` |
  | `web` | `Requested format is not available` |
  | `yt-dlp default` | **8 formats, 2 audio-only, up to 1080p — accepted** |

  Before this pass the walk stopped at `android_vr`, pinned it for the session,
  and `bestAudio` found nothing — the silent no-op of N4. With only N3 missing
  it would have thrown at `tv` with three clients untried. Nothing downstream
  was ever broken; the manifest was.
- **Library** shows it with real artwork, `You saved this · audio`, correct size
  and **no duplicate row** (D1's regression test).
- **Every failure path tried produced a row or a sheet, and none crashed**:
  network pulled before extraction (all five clients refused, self-update
  attempted and failed, error surfaced), trial refusal, degraded manifest.
- **The flight recorder survived a crash it could not itself prevent**, and the
  previous run's tail named the last thing the download did.

- **Local playback and backgrounding.** A saved track played, our session
  `com.afinitycode.spool/spool` was the media-button session with
  `state=PLAYING`, `actions=819` and `metadata: size=6` — not the
  `size=2, description=null` failure mode. Backgrounded with HOME, the position
  went on advancing (30s in) and `PlaybackService` stayed
  `isForeground=true types=0x00000002`, with the transport notification
  `ONGOING_EVENT|NO_CLEAR|FOREGROUND_SERVICE|NO_DISMISS`.

### The replay rule, end to end — previously never observed

§5 listed this as never covered, and it now is. Two videos crossed the threshold
in one session (set to 2 plays to make it reachable), and the recorder has the
whole thing:

```
replay#1  +0.00s  >> auto-save _OBlgSz8sSM {"title":"Charlie bit my finger - again !","starts":2,"keepAs":"audio"}
extract#2 +13.77s OK formats resolved {"seconds":56,"total":9,"audioOnly":2,...}
download#3 +30.50s OK file written {"bytes":925005,"ext":"m4a"}
replay#1  +44.27s OK kept {"bytes":925005,"quality":"audio","plays":2}
replay#4  +0.00s  >> auto-save 0EqSXDwTq6U ...
```

Three things worth keeping from it:

- **The files landed app-private** (`files/downloads/auto-<videoId>-<stamp>.m4a`)
  and `Music/Spool` was untouched, which is the rule AGENTS.md sets.
- **`replay#4` opened one millisecond after `replay#1` closed** — the two
  auto-saves serialised rather than competing.
- **The rule now says what it did.** It has no interface, so this log *is* its
  interface; before this pass a threshold crossing that found nothing usable
  produced no evidence anywhere (N4).

The slot is visible in the same file from the run before it: a FAB tap was
`queued` at 21:43:56.779 while a retry was still downloading, and its
`download#7` opened at 21:44:39.991 — **0.7s after** that retry's
`OK file written` at 21:44:39.290.

### A note for whoever repeats this

**YouTube's home feed and search results reshuffle between visits**, so tapping
the same screen coordinate twice opens two different videos. Three attempts at
the replay rule failed on this alone before it worked. Drive it from a search
results page, tap the *first* result, and screenshot to confirm the id before
trusting the play count.

### Not covered in this pass

- A physical device — everything here is the emulator, which is a poor witness
  for anything timing-sensitive (see N1).
- The card's **Save** button — the one download path still never driven.
- Screen-off playback over a long period, and a track boundary crossed while
  locked. Backgrounding was checked (below) but not a soak.
- iOS.


---

## 8. Third pass — 2026-08-22, the download model

A rebuild of *how* the app decides what to ask YouTube for, rather than more
patching of the walk. Release build, R8, `-PSPOOL_TRIAL=false`, emulator.

### What the research established

- **`android_vr` was the worst possible first client, and it was first.** yt-dlp
  issue #17348: since 2026 it requires a GVS PO token for everything except
  **format 18** — H.264 360p with pre-merged AAC. That is bit-for-bit the
  degraded manifest measured in §7 (`total:1, muxed:1, heights:[360]`). The
  chain led with the one client guaranteed to answer uselessly.
- **A web PO token is bound to a video id.** yt-dlp's guide: *"a new token is
  required for each video."* The app held one token and spent it on every
  download, so a token minted while watching A and used on B was not weaker but
  *wrong* — and a refused token is indistinguishable from a refused client,
  which is why this hid in plain sight.
- **The token was labelled `web`; our page is `mweb`.** And `web` is SABR-only.

### What changed

`OPEN_CHAIN` is now ordered from yt-dlp's published requirement table —
`tv → default → web_embedded → mweb → android_vr` — with `tv` leading because
it needs no token and our cookie handoff is exactly what stops it serving
DRM-only formats. `TOKEN_CHAIN` (`mweb → web`) walks the candidates a token
could belong to, so the pairing is measured rather than asserted, and the two
walks keep separate remembered clients. `core/tokens.ts` files tokens per video
with a 6-hour TTL.

### Measured

Extraction now settles on **the second client instead of the fifth**, and the
manifest is better: 10 formats up to 2160p with 2 audio-only rungs, against 8
before. Two full downloads completed on the reordered chain — 24 MB and 50 MB,
one of them titled entirely in Devanagari, which also exercises the byte-budget
filename rule.

```
tv              -> "The page needs to be reloaded."
yt-dlp default  -> 10 formats, 2 audio-only, up to 2160p   [accepted]
```

### The finding that matters most, and it is not good news

**No PO token has ever been harvested — on any run, before or after this work.**
`mediaSeen` counts `videoplayback` URLs seen by the page hooks; across 25
seconds of playback it read **zero**. The page is not fetching media through
that endpoint, so the `pot` parameter the harvester looks for is never present.

So the token half of the model is implemented, unit-tested, and **has never
executed on a device**. Everything that works today works *without* a token, on
the shrinking set of clients that still allow it. That is exactly the runway the
research says is closing.

The fix is a vantage point, not a better regex: `shouldInterceptRequest` on the
native `WebViewClient` sees every request the WebView makes, including ones a
page script cannot observe. That is the deferred Layer 2 work and it is now the
highest-value thing left in the download path.


---

## 9. Fourth pass — 2026-08-23, every download path on the new model

A deliberate sweep of **all five** download paths on a clean install, release
build with R8, `-PSPOOL_TRIAL=false`, emulator (SDK 35, x86_64). Fresh install,
first run walked, 3 permissions granted.

### Result: 0 crashes, 131 log entries, 2 errors — both a network cut I caused

| Path | Result |
|---|---|
| **FAB, one tap** | 6 downloads completed, 13 MB – 141 MB |
| **Format sheet (3s hold)** | Quick picks + sizes + "Already downloaded" warning; pick downloaded |
| **Notification Save button** | **First time ever driven.** 62-min video, 141 MB, app backgrounded |
| **Replay rule** | Fired at 2 plays, kept app-private, gallery untouched |
| **Try again (Library)** | Recovered a network-killed download, 70 MB |

### What each one proved

- **The card's Save button** was the last untested path. It logged
  `card#10 slot acquired` — so it takes the download lock like everything else —
  then `+170.47s OK saved from the notification {"bytes":141092060}`. The Save
  action **disappeared from the card** once the job existed, which is the
  "controls appear only where they are real" rule working.
- **The in-flight duplicate guard fires.** Two FAB taps on the same video:
  `queued` then, 14s later, `Already downloading "Can Humans Ever Leave…"`. One
  file, one download.
- **The chain settles on the second client, not the fifth**, and
  `preferredOpen` then pins it — `tv` appears only 3 times across a session with
  6 downloads, so its cost is paid once per session rather than per download.
- **`tv` refused 3/3** here, always `The page needs to be reloaded.` It stays
  first because the requirement table says it is the only tokenless client and
  this may be specific to an emulator with no real YouTube session — but if a
  future pass sees the same, reorder it behind `null`.
- **Failure copy stayed honest**: a mid-download network cut produced
  *"Couldn't reach YouTube"*, never the free-space fallback.

### One more defect, found and fixed

**N8 — the FAB kept claiming failure after a successful retry.** `fabState`
promoted `alreadySaved` to "done" only from the `ready` state, so a download
rescued by *Try again* left the button showing the amber retry icon on a video
whose file was in the library. Same honesty class as D2 and N2: the UI
asserting something the app already knows is false. Fixed so a saved file
outranks any past verdict, while `resolving`/`working` still win.

### Still not covered

- A physical device. Everything here is the emulator.
- Screen-off playback over a long period, and a track boundary crossed while
  locked.
- **The PO token path**, which still has never executed — see § 8. Nothing in
  this pass changes that; every download here succeeded without a token.

---

## 10. Fifth pass — 2026-08-23, making downloads production-ready

Release build, R8, non-trial, emulator-5554 (SDK 35, x86_64). This pass went
looking for what would break a download in the field rather than on a desk, so
the interesting results are the two failures it caused deliberately and the one
it did not expect.

### What the PO token question actually turned out to be

§ 8 recorded that no token had ever been harvested and concluded the harvest
needed a native vantage point. **That conclusion was wrong, and the reason is
worth keeping.** The harvester was not blind because it was in the wrong place;
it was blind because it hooked three things none of which a player response
passes through:

- the watch page inlines its first player response as
  `var ytInitialPlayerResponse = {…}`, evaluated by the JavaScript parser, so
  nothing calls `JSON.parse` on it;
- `Response.json()` parses natively in C++, so every SPA navigation's
  `/youtubei/v1/player` fetch was missed;
- `XMLHttpRequest.open` sees the request, never the response.

With a property trap, a `Response.prototype.json` hook, an XHR `load` reader and
a request-body scan added, the hooks fire on the first video tried:
`saw:"parse,sd,sabr,url"`, `mediaSeen:3`. **And the answer is that this session
has no token to give**: the streaming data is SABR-only, `serverAbrStreamingUrl`
carries no `pot`, and no InnerTube request body contains a `poToken` field.
YouTube is not challenging this session — consistent with every download in this
pass succeeding on a tokenless client.

That is a measured answer rather than a dead end. A session that *is* challenged
puts `pot` on the media URLs, and those hooks now demonstrably fire. What is
genuinely still out of reach is the SABR case, where the token rides in a
protobuf body — a parsing problem, not a vantage one, which is why the native
rewrite that looked obvious would not have helped.

**The diagnostic is the lesson.** `saw` exists because "no token" had two
indistinguishable causes for a day, and telling them apart took one build cycle
and saved a rewrite.

### N9 — a download interrupted at 90% started again at 0%, forever

The output template was `{jobId}.%(ext)s` and a job id is minted per attempt, so
yt-dlp — whose `--continue` is on by default — never had a partial to continue
into. On the connection that made a download fail in the first place, "start
again from zero" is not a retry policy; it is a download that never completes.
Every abandoned `.part` then waited a day for the sweep.

Fixed by naming the output `partialKey` = `{videoId}.{a|vHEIGHT}`. **Measured
twice**: a save cut at 1,622,016 bytes resumed from exactly 1,622,016, and a
second at 770,048 resumed from exactly 770,048 and went on to publish.

### N10 — a finished file thrown away because its cover art would not embed

Found by accident while testing N9, and the most serious thing in this pass. A
31-minute save downloaded fully, converted to a 73 MB m4a, had its source
deleted — and then failed with `Postprocessing: Conversion failed!` because
`--embed-thumbnail` could not embed the cover. Complete, correct audio on disk;
*"Didn't finish — check free space and connection"* on screen.

The proof that the audio was fine is in the sizes: the clean re-run's m4a is
73,474,823 bytes against the failed run's 73,036,036 — a difference of 438 KB,
which is the cover the failed one never got.

Two fixes. `finished()` is now consulted on the failure path, so a complete file
outranks the engine's opinion of it, with `salvagedFrom` carried across so the
log says why a success has an error beside it. And `readableError` grew a branch
for it — the *fourth* failure to reach the free-space copy while having nothing
to do with free space — with `looksStale` taught not to offer an engine update
for a failure that happened after extraction.

**Verified in the dangerous direction rather than the happy one.** A download
killed mid-transfer still fails, still publishes nothing, and still adds no
library row: a `.part` and nothing else is not a finished file.

### N10a — the same fix, one intermediate short

Found by finally running a **video** download, which the rest of this pass had
not: every save until then was audio, and the merge path is exactly the code
`finished()` had to be right about. A 360p save writes

```
ZbP4VNJhRUk.v360.f134.mp4.part   the video stream, arriving
ZbP4VNJhRUk.v360.f134.mp4        the video stream, whole
ZbP4VNJhRUk.v360.f251.webm       the audio stream, whole
ZbP4VNJhRUk.v360.temp.mp4        the merge, in progress
ZbP4VNJhRUk.v360.mp4             the download
```

`.temp.` was not excluded. It carries the real container's extension and does
not match `.fNNN.`, so a merge that failed halfway would have been *rescued* as
a truncated video and published as a success — the N10 fix creating a worse bug
than the one it fixed. Caught on device in a single frame of a retry, with
`.v144.mp4` at 35,189,497 bytes and `.v144.temp.mp4` at 33,030,192 bytes
side by side, both `.mp4`, both newer than the attempt started: the old lookup
chose between them by modification time, which is a coin flip on a truncated
file.

`INTERMEDIATE` now matches `.fNNN.`, `.temp.`, `.part`, `.part-FragN` and
`.ytdl`, and the stale sweep uses the same pattern rather than an extension set
— `.part-Frag7` reads as extension `part-Frag7`, so a fragmented download's
leftovers used to survive the sweep forever at the size of a whole video.

**Both failure modes then verified on device.** Network cut once the video half
was complete, leaving a whole `wVmPKf5Q9C4.v144.f160.mp4` and a partial audio
stream: the download failed, published nothing, and added no row — the silent
film refused. *Try again* skipped the complete video half, resumed the audio
from exactly 344,064 bytes, merged, and published 37.4 MB to `Movies/Spool`.

A cancel is excluded from the rescue outright, since resolving there would put
a track in the library the user never asked for and spend a trial save on it.

### N11 — every cold start re-paid a walk it had already lost

`tv` leads the open chain and was refused 3/3 on this device, always with `The
page needs to be reloaded`. The in-session pin meant it cost seconds once per
session rather than once per download, but a session is a launch and the cost
came back every time.

`src/core/clients.ts` scores each `(mode, client)` and persists it.
**Measured after a reinstall and force-stop**: the first extract of a fresh
launch went straight to the winning client with no refusal line at all, carrying
`scores:{"open:tv":-1,"open:*":3.05}`.

It never removes a client, a margin under 0.5 cannot outvote the requirement
table, and it is wiped when the engine replaces its own extractor — so the worst
a wrong board can do is cost time.

### N12 — a token could make the app worse than no token

Not a field failure; a hole found by reading, and closed before harvesting
started working. Holding a token narrowed the walk to `mweb → web`, so a token
that was expired or bound to another video left two chances where a tokenless
request had five. `attempts()` now appends the whole open chain with the token
dropped.

### Smaller

- Orphaned cover art is swept with the partials. One interrupted save left
  179 KB behind; nothing reads it, and `finished` excludes images precisely so
  it can never be handed back as the download.
- The harvest log is deduplicated on shape. The page re-reports once a second so
  a late hook is not invisible, and logging each would be a line a second
  against a 900-entry ring.

### Still not covered

- **A physical device. Everything here is the emulator**, and only the
  `x86_64` APK — `arm64-v8a` and `armeabi-v7a` are built and never run. This is
  the largest remaining gap by some distance.
- **Two of the four download paths were not re-run on this build.** The
  notification's save button and the replay rule were verified in § 9 against
  the previous build. Neither wrapper changed, and the core they share is the
  most exercised code in this pass — seven downloads across audio and video,
  success and failure — but that is an argument, not a measurement.
- **`finished()`'s "already downloaded" branch is reasoned, not run.** It
  returns an older file of the same stem when nothing newer exists, which is
  what happens when a manual save follows a replay auto-save of the same video
  and quality: yt-dlp leaves the complete file untouched. Reaching it needs an
  app-private file from the replay rule, so it goes with the item above.
- **The N10 rescue itself has not been triggered on device.** The failure that
  revealed it did not reproduce on a clean re-run, and no cheap way to force a
  postprocessor to fail was found. What *is* verified is `finished()` — now the
  only lookup on the success path, so every download exercised it — and both
  refusal directions, which are the ones that could publish a broken file.
- Screen-off playback over a long period, and a track boundary crossed while
  locked.
- **A token has still never been spent on a real download**, because this
  session has none to spend. `attempts()` and `TOKEN_CHAIN` remain unit-tested
  only.

---

## 11. Sixth pass — 2026-08-23, the YouTube session

Not a device pass. This one is a **security review of the login path**, prompted
by a request to encrypt the stored YouTube session, and its findings are
mostly things nothing had gone looking for before. Every item below is either
verified by the build or explicitly marked as unverified — the split matters
more here than usual, because the change touches the one credential the app
ever holds.

### What the review found

| # | Finding | Severity | Status |
|---|---|---|--:|
| S1 | `app_webview/` — the WebView's cookie jar, and after a sign-in the user's live YouTube session — was in Android Auto Backup. `allowBackup` defaults to true, the Expo template sets it explicitly, and the default exclusions are only `cache/`, `code_cache/` and `no_backup/`. So the login was eligible to be uploaded to Google and restored onto another device as a working session | **High** | Fixed |
| S2 | `cacheDir/youtube-cookies.txt` held `SAPISID`/`HSID`/`SSID`/`__Secure-3PAPISID` in plaintext, was rewritten before every extraction and download, and was deleted by **nothing**. Any device that had ever signed in carried a usable copy of the login for the life of the install | **High** | Fixed |
| S3 | One fixed filename, two concurrent callers. `listFormats` and `download` run on the same `scope`, so any attempt to delete the jar after use would have deleted a file the other caller was still reading — the fix for S2 is only safe *because* the name is now unique per invocation | Medium (latent) | Avoided |
| S4 | The trial's `spool_trial.xml` was in Auto Backup too. A backup taken at zero saves and restored later resets the counter — the `externalMediaDirs` mirror still catches it, but the two stores should not disagree | Medium | Fixed |
| S5 | **There was no way to sign out.** The WebView keeps the session across restarts by design and the only exit was Android's "Clear storage", which also deletes every automatic save the user has. A lost or handed-on phone stayed signed in | Medium | Fixed |
| S6 | The Google sign-in page — the one screen in the app that shows a password field, rendered in a WebView we do not control — could be screenshotted, screen-recorded, and mirrored | Low–Medium | Fixed |

### On the request that prompted it

The ask was to **encrypt** the stored login. The honest answer is that
encryption is not the lever here, and the review says so rather than shipping
something that looks like a fix:

- **The primary store cannot be encrypted by this app.** The session lives in
  Android's WebView cookie jar, in a format and location the WebView owns. The
  OS already encrypts it at rest through file-based encryption; what was missing
  was not ciphertext but *exclusion from backup* (S1) and *a way to revoke*
  (S5).
- **Encrypting the yt-dlp jar buys nothing.** yt-dlp needs a real path to a
  readable file, so an encrypted jar must be decrypted to a second plaintext
  file at the moment of use. That moves the exposure and adds a key to lose.
  Ephemerality is the real lever, and it is what shipped (S2).
- **A second, app-managed encrypted copy would be a net loss.** It would mean
  two copies of the credential where there was one, both of which have to be
  revoked correctly.

Anyone revisiting this should read those three points before "adding
encryption", because the instinct is strong and each of the three costs
something real.

### Verified

- **The release build compiles, R8 passes, and the manifest merges.**
  `./gradlew assembleRelease`, BUILD SUCCESSFUL in 1m 22s, all three ABIs
  packaged.
- **The backup exclusions actually reach the shipped manifest.** Read back out
  of `merged_manifests/release/processReleaseManifest/arm64-v8a/AndroidManifest.xml`:
  `android:allowBackup="true"`, `android:dataExtractionRules="@xml/spool_data_extraction_rules"`,
  `android:fullBackupContent="@xml/spool_backup_rules"` — all three present, no
  merge conflict against the template's `allowBackup`. This was the main risk in
  the change and it is the one thing that had to be checked rather than argued.
- **482 tests across 112 suites**, all passing, including new coverage of
  `isSignInPage` (the lookalike-host case included) and both new bridge calls.
- `npm run typecheck` clean.

### Not verified — and what each would take

- **Nothing here has run on a device.** The build is proof the code compiles and
  the manifest is right; it is not proof the behaviour is.
- **The sign-out control has never been tapped.** Needs: sign in, save something,
  tap Profile → Sign out of YouTube, confirm, then check the browser shows a
  signed-out feed *and* the library is intact. The library half matters most —
  it is what the row's "Library stays" promises.
- **FLAG_SECURE has not been observed.** Needs a screenshot attempt on
  `accounts.google.com` (expected: black or refused) and another on Library
  immediately after leaving that page (expected: normal). The second is the real
  test — a flag that sticks is worse than one that never raised, and it would be
  invisible until someone tried to screenshot their own library.
  **Note for whoever runs it:** a blocked screenshot looks exactly like broken
  capture tooling. That is the expected result.
- **The backup exclusion is verified as configuration, not as behaviour.**
  Proving it end to end means `bmgr backupnow` and inspecting the transport, or
  a real device-to-device restore. The manifest read-back is strong evidence and
  it is not the same thing.
- **No jar has been observed being deleted.** `ls` on
  `noBackupFilesDir/session/` during and after a download would settle it, and
  is the cheapest of these to run.
- **The `discard`-in-`finally` path on cancel is reasoned, not run** — the same
  early-`return@launch` shape that has bitten `takeSlot()` before.

### The one thing to watch

S3 is the trap most likely to be re-broken by a well-meaning later change:
per-invocation naming reads like an incidental detail next to "delete the file
when done", and it is the load-bearing half. It is recorded in `AGENTS.md` for
that reason.

---

## 12. 2026-09-18 — "the app crashes after a song or two", Galaxy S21 FE

Reported from daily use on the S21 FE (Android 16, One UI, WebView 150). Tested
on that phone with release builds of this change installed over the user's own
(same keystore, library intact), driven over wireless adb.

### What the phone had recorded

- `dumpsys activity exit-info`: five `APP CRASH(EXCEPTION)` exits between
  2026-09-15 and 2026-09-18, all at importance 325 — on top, screen off.
- `dumpsys dropbox --print data_app_crash`: six traces, **all
  `ForegroundServiceDidNotStartInTimeException` on `PlaybackService`**. Five had
  `YtDlpModule.showNowPlaying` → `startForegroundService` as the last start, one
  androidx's `MediaButtonReceiver.onReceive`.

### The cause: Spool was battery-restricted

`cmd appops get com.afinitycode.spool RUN_ANY_IN_BACKGROUND` → `ignore`, and
`dumpsys activity processes` → `backgroundRestricted=true`. That is the user's
"Restricted" battery setting (or Samsung's sleeping apps), and it changes three
things, each measured:

1. **The service is demoted the moment the screen goes off.** Screen off at
   19:15:31.106, `am_foreground_service_stop … STOP_FOREGROUND` at .568 with our
   card still posted and nothing of ours having asked.
2. **`startForeground` is then ignored silently.** "Service.startForeground()
   not allowed due to bg restriction" in the system log, *no exception*.
3. **The demoted service is stopped as idle** about a minute later
   (`am_stop_idle_service`), taking the card with it; a new raise from the
   screen-off state is refused (`Background started FGS: Disallowed … TPSL`).

The crash was (1) meeting the old code: the next track's SHOW arrived through
`startForegroundService` at a service that believed it was still foreground, so
it only called `notify()`, never answered, and Android killed the process.

### What changed

- `show` uses `startForegroundService` only to raise a card; refreshes are plain
  `startService` and owe nothing. A SHOW that *was* sent as a foreground start
  is marked `owed` and always answered.
- `publish` asks the system (`getForegroundServiceType`) instead of trusting a
  flag, re-promotes while playing, and checks after `startForeground` that it
  took — because under restriction a clean return proves nothing.
- `teardown` stops with `stopSelfResult(startId)`; so does `DownloadService`.
- Media-button starts go foreground before anything else.
- A refused raise is caught in `publishNowPlaying`, logged once with
  `backgroundRestricted()`, and retried after 15 s or on a new track — it was
  retried twice a second.
- **Found on the way, and worse than the crash to live with:** `dropAudio`
  called expo-audio's `remove()`, which on Android only deletes the player from
  a table. Five stop-then-play rounds left **six live players**, the first still
  audible five minutes later with the screen off, unreachable from any control.
  It now pauses, removes, and `release()`s two seconds later.

### Measured after the change, restricted as the user has it

| Scenario | Result |
|---|---|
| Six `next` keys, screen off | No crash; each re-promotion answered |
| Owed start whose `startForeground` was silently ignored (19:30:54) | **No crash** — the ignored call still clears the obligation |
| Service stopped as idle, then a natural track end, screen off | No crash; queue advanced, audio continued, card could not return |
| Five stop-then-play rounds | No crash; **1** audio player and **1** session left (was 6) |
| Media keys after the card was gone | No crash; keys could not resume playback |

### What the restriction still costs, and cannot be fixed from inside the app

With Spool restricted, screen-off playback has no card after about a minute and
no foreground service at all — it lasts only as long as Android tolerates the
process. Nothing in the app can override the user's setting. **The fix is on the
phone: Settings → Apps → Spool → Battery → Unrestricted** (and remove it from
Sleeping apps). An in-app prompt when `backgroundRestricted()` is true is not
built; it needs a design decision.

### Not yet verified

- **Unrestricted, on this phone — since verified, § 13.** Two natural track ends
  across six minutes screen off, service foreground at every sample.
- **The browser source — since verified, same evening.** A YouTube Mix in the
  Browse tab, screen off, still battery-restricted: two natural autoplay
  boundaries (23:15:15 and 23:19:32) across eleven minutes, one process
  throughout, service foreground throughout, audio `started` at every sample, no
  crash. (Taps on the feed register over adb as `input motionevent DOWN`/`UP`
  pairs; plain `input tap` does not open a video.)

  The user reported "crashed again after one song" on this build before that
  run; the phone recorded **no crash, ANR or tombstone** for it. What it did
  record is Samsung's own power management acting on Spool:
  `MARsPolicyManager … disablepolicy`, a kill as `change com.afinitycode.spool`
  while cached (21:30:41, the kind deep sleeping makes), and Freecess freezing
  it whenever it fell to the background. On a restricted, sleeping-listed app
  those are enough to stop music and cold-start the app on reopen, which reads
  as a crash from the outside. Not determined whether that is what the user saw.
- **The download half** of the `stopSelfResult` change is reasoned, not run.

## 13. 2026-09-18 — end-user pass on the S21 FE, "is it production ready"

Every tab driven by hand over wireless adb on the release build from § 12, the
user's own library (104 items) intact, battery now **Unrestricted**
(`RUN_ANY_IN_BACKGROUND: allow`). Rungs 1 and 2 first: typecheck clean, 525/525.

### Worked as specified

| Feature | Observed |
|---|---|
| Library search | Three local matches instantly; the cloud only on a tap |
| "Search YouTube for …" | Switched to Browse with the results page loaded |
| Trial length cap, FAB | A 4:34 video refused with the pre-release sheet and the true sentence |
| Hold-to-open quality sheet | Opens on a 3 s hold (a 0.9 s press does nothing, as designed) |
| 1080p video save (merge path) | 44.5 MB in 11 s; one video and one audio track, 168.3 s against a 2:48 source |
| FAB after a save | Tap opens Library, per the `done` state |
| Local play over a playing page | The page went quiet, the track took the card |
| Media keys (`cmd media_session dispatch`) | next / pause / play all reached `PlaybackService` and moved the queue |
| Natural track end, screen on | Advanced to the next queue entry |
| Lyrics consent | The dialog names lrclib.net and what is sent |
| Lyrics lookup failing | "Could not reach lyrics — try again", not cached. lrclib itself was answering `503 ServerOverloaded` to every request at the time |
| New playlist from the player | Created, listed in Library as "1 track" |
| **Screen off, unrestricted** | 23:46 → 23:52: NIMRAT → Diljit → Maahi by natural ends, `isForeground=true` at every 30 s sample, one pid |
| Home chips | Video narrows both rows; "Nothing on repeat is video." |
| Profile | Quality sheet, engine `2026.08.19`, playlist backup count, export diagnostics |

`expo-audio` 57 publishes its own `ExpoAudioBasicMediaSession` alongside ours
even with lock-screen mode off. It posts no notification and media keys still
reached `PlaybackService`, so it is harmless today — but it is a second session
for one app, and it is the first suspect if a car or headset ever acts on the
wrong one.

### Defects found, fixed in this pass

- **Sleep timer unreachable.** Android's `Alert` draws at most three buttons and
  drops the rest silently. The full player's overflow had four, and the timer was
  last. The playlist menu lost **Rename** and a mid-playlist track lost **Move
  up** the same way. All three now go through `offerMenu` (UI.md § The sleep
  timer is a receipt).
- **Blank artwork across most of the library.** Both saved files checked had a
  JPEG cover embedded (`covr` atom), yet the rows, player and notification drew
  nothing. Two causes, both permanent under the old rule: a remembered failure
  (grey, no tint) and a cover whose `cacheDir` file was gone while its `dominant`
  survived (tinted, no image). Failures now expire after a day, legacy `null`s
  are retried, and `filesExist` drops dead covers at launch (DATA.md § dl.artwork).
- **"Try again" on a too-long video looked like it did nothing.** The row came
  back reading "check free space and connection"; the flight recorder had the
  truth — `Pre-release builds can save videos up to 3 minutes. This one is
  38:18.` `retry` threw a plain error; it now uses `stated` and opens the
  subscribe sheet, as the FAB does.

### After the fixes — release build installed over, 2026-09-19 00:00

- **Artwork**: every visible row, the mini bar and the player drew their covers
  on the first launch — Nashtar, Mil Ke Baithange, Koshish, NIMRAT, Diljit,
  Maahi, all blank before.
- **Session resume**: the queue came back paused on DXB Cheema Y, the track it
  had advanced to.
- **Sleep timer**: on the overflow (three buttons, stacked); *End of this track*
  paused at 206.8 s of a 3:26 track and did not start the next.
- **Try again** on the 38:18 video: the subscribe sheet with the true sentence,
  and the row reads the same sentence.
- No crash, ANR or tombstone. The only exit on record is `PACKAGE UPDATED`; the
  old process had run unbroken through the whole pass.

### Found, not fixed here

- **The production licence server fails every lookup.**
  `GET https://spool.pardeep.app/v1/licence?device=<any valid id>` answers
  `502 {"error":"unavailable"}` — the app's two `licence server refused` entries
  — while `/health` reports `{"ok":true,"db":true,"key":true}` and `/v1/checkout`
  answers. So the failure is in `Entitlement::current`'s join over `subscriptions`,
  `users` and `plans`: most likely a deployed schema that is behind `schema.sql`.
  Not determined — the production error log was not reachable from here. The app
  treats it as no news, by design, so **a paying user would stay on the trial**.
- **Artists read "Spool" on rows where the file is tagged.** "Koshish" is tagged
  Prem Dhillon (expo-audio's session reads it) while the player shows the
  fallback. Cosmetic; the lyrics lookup sends the real field, not "Spool".
- **Two different prices on one screen-flow.** The cold-launch pre-release
  sheet offers "a full year for ₹399 … expected to be ₹999", while the subscribe
  sheet and Profile sell ₹249 a year / ₹29 a month. A pricing decision, not a
  code one.

### Fresh install — uninstalled and reinstalled, 2026-09-19 00:06

The user approved a wipe; the 39 app-private automatic saves (371 MB) were
copied to the PC first. After `adb uninstall`, `Android/data` and
`Android/media` for the package were gone and `Music/Spool` (65 files) was not.

| Step | Observed |
|---|---|
| First run | Welcome with the legal notice above its button → What it does → Premium → *Start browsing* |
| Permissions, at the end | Notifications, then music and audio, then photos and videos (Allow all) |
| Adoption | **66 items back on the first launch**, covers and artists included — not 0 then 43 |
| Pre-release sheet | Not raised; only *See the offer* raises it (§ 13 of FEATURES) — § 12 of FEATURES said otherwise and was corrected |
| Engine on a clean install, release build | `engine ready` at +0.01 s; `tv` refused ("The page needs to be reloaded"), yt-dlp's default client answered, formats in 19.6 s |
| Duplicate guard | "Similar already downloaded … Tap again to save anyway" for a video the gallery already held |
| A real download | A Devanagari-titled audio save published to `Music/Spool` and listed with its cover; 67 items. yt-dlp keeps the upload date as mtime, so it does not sort first in `ls -t` |
| Trial counter | 0/20 after the reinstall, as FEATURES § 12 says it would be |
| Playlist menus after the fix | Rename present and worked; a middle track offered Move down *and* Move up, and Move up reordered; Delete confirmed and left every track |
| Crashes | None (`logcat -b crash` empty for the package) |

Two more defects found and fixed on this pass:

- **Onboarding said the replay rule is "Off by default"**; `DEFAULT_SETTINGS.enabled`
  is `true` and FEATURES § 3 says on. The copy was wrong, not the default.
- **Local search needed the query as one contiguous substring.** "jana gana mana
  anthem" found nothing over "Jana Gana Mana - National Anthem". Every word now
  has to appear, in any order, in title or artist: 5 hits after the fix.

