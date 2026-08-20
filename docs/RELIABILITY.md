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
