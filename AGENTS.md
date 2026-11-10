# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# The knowledge books live in docs/

`docs/` is the record of how this app actually works. Read the one that matches
the change **before** touching code, every time — these encode decisions that
are not recoverable by reading the source, and several of them are the reason a
line that looks redundant is load-bearing.

| Change you are about to make | Read first |
|---|---|
| **Anything at all, first time this session** | [`docs/ONBOARDING.md`](docs/ONBOARDING.md) — how to work here: routing, recipes, what counts as proof, and a symptom → trap index into this file |
| Structural, native module, storage, build, R8, CI | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Adding / changing / removing a capability | [`docs/FEATURES.md`](docs/FEATURES.md) |
| Anything with a lifecycle, or "why did it do that" | [`docs/FLOWS.md`](docs/FLOWS.md) |
| Any UI change, including cosmetic ones | [`docs/UI.md`](docs/UI.md) |
| Finding where something lives, or judging blast radius | [`docs/CODEMAP.md`](docs/CODEMAP.md) — every file, export and import edge |
| Writing Kotlin, or touching the build | [`docs/NATIVE.md`](docs/NATIVE.md) — the bridge contract, both services, R8, CI |
| Storing anything, or changing a stored shape | [`docs/DATA.md`](docs/DATA.md) — every key, and what survives an uninstall |
| Writing a test, or deciding what proof a change needs | [`docs/TESTING.md`](docs/TESTING.md) — the four-rung ladder and the harness's blind spots |
| Reporting a bug, or repeating a verification pass | [`docs/RELIABILITY.md`](docs/RELIABILITY.md) — what has actually been measured on a device |
| Subscriptions, payments, or anything that leaves the device | [`server/README.md`](server/README.md) — the token format and its test. **The server itself is not in this repo**; that file says where it is |

The map of all of them, with what belongs in which, is
[`docs/README.md`](docs/README.md).

**When a change lands that a book does not describe, update that book in the
same change.** A stale book is worse than none, because it will be trusted.

Two standing facts worth knowing before you read anything else:

- The root `README.md` was rewritten against the current code and is now the
  front door for a human who has just cloned the repo. `docs/` remains the
  record; keep the README current when a change lands that it describes. (It
  used to describe v1 and was flagged here as untrustworthy — that warning is
  retired, and both halves of it turned out to be needed: its *engine* sections
  had drifted as badly as its interface ones.)
- Tests run with `npm test -- "tests/*.test.mjs"` (the script exists now; it
  takes the pattern as an argument). The long form still works:
  `node --experimental-strip-types --import ./tests/harness/register.mjs --test "tests/*.test.mjs"`.

## UI work: read docs/UI.md first

`docs/UI.md` is the knowledge book for the Spool v2 design system — tokens,
type, spacing, motion, the five tabs, the player, and the auto-save rule.

**Read it before writing or changing any UI code**, every time, including changes
that look cosmetic. It encodes decisions that are not recoverable from the code:
which colour means what, what is deliberately absent, and which behaviours are
load-bearing rather than decorative.

When a UI change lands that the book does not describe, update `docs/UI.md` in
the same change. A stale book is worse than none, because it will be trusted.

Source of truth is the Claude Design project `Spool v2.dc.html`
(`f1f711a7-7625-484d-a5a0-88f377c61411`). If code and book disagree, go back to
the design rather than guessing.

# Non-obvious constraints that keep biting

Each of these cost a day. The books in `docs/` cross-reference them; this list is
here because it is the one file that is always loaded.

- **The global `fetch` is Expo's, and it cannot upload a file.** It throws
  "Unsupported FormDataPart implementation" on React Native's `{uri, name,
  type}` part, before anything is sent — so a screenshot claim looked exactly
  like being offline. Multipart goes through `XMLHttpRequest` (`upload()` in
  `src/core/account.ts`). Unit tests stub `fetch` and cannot see this; it was
  found on the emulator.

- **`interruptionMode: 'doNotMix'` is load-bearing.** It is what gives our
  player exclusive audio focus, which is the whole mechanism behind the playback
  gate below — under any mixing mode a WebView that is still playing simply
  shares the output and neither side stops. Background survival now rests on the
  foreground service rather than on this, but the mode still is not a
  preference.

- **The media notification is ours — `PlaybackService` — for both sources.**
  Not `expo-audio`'s `setActiveForLockScreen`, which publishes a Media3 session
  whose available commands have `SEEK_TO_PREVIOUS_MEDIA_ITEM` and
  `SEEK_TO_NEXT_MEDIA_ITEM` removed outright in `AudioMediaSessionCallback`. No
  configuration puts skip buttons on that card, and a queue-based player whose
  notification cannot change track is most of the notification missing. What
  keeps background audio alive is the foreground service, not whose session it
  is — measured on the emulator at five minutes backgrounded and then a track
  played to its natural end. `expo-video`'s `showNowPlayingNotification` is off
  for the same reason: two sessions means two cards for one app.

- **On Android 13+ the card is built from the `PlaybackState`, not the
  notification's actions.** Buttons added only to the notification are not
  drawn. Transport, scrubber and times are all expressed as session state first;
  the notification actions are the fallback for Android 12 and older. The
  scrubber needs `ACTION_SEEK_TO` *and* a real `METADATA_KEY_DURATION` — a
  duration of 0 means "not known yet" and must be left unset, or the system
  draws a scrubber over a track it thinks is empty.

- **Position is not pushed on a timer.** A `PlaybackState` carries a position,
  the clock it was measured at, and a speed; the system extrapolates between
  updates. `publishNowPlaying` pushes only when what the card *shows* changes,
  or when the real playhead has drifted more than two seconds from where the
  system thinks it is. A track playing normally costs nothing per second.

- **You take the card by playing.** Spool has two engines that know nothing
  about each other and Android has room for one card per app, so
  `publishNowPlaying` arbitrates: a source that is not making a sound may update
  the card it already owns and may not take one from a source that is. Without
  that test both publish on every tick and each reads the other's publish as a
  claim — measured on the phone, the card alternated between the library track
  and the page title about twice a second, and the buttons acted on whichever
  had written last.

- **Browser background audio must not depend on a message from the app.**
  `BACKGROUND_SCRIPT` used to learn it had been backgrounded from an
  `injectJavaScript` round trip, and that race is unwinnable: Android pauses the
  media first, the page read its own pause as deliberate, cleared the "user
  wants this playing" flag, and the watchdog then had nothing to restore — audio
  died every single time the user left the app. The page now reads the *real*
  visibility itself (the `Document.prototype.hidden` descriptor is captured
  before being frozen) and decides intent from whether a finger was recently on
  the screen, not from where the app thinks it is. Resuming happens inside the
  `pause` handler, because background timers are throttled too hard to rely on.

  **A touch is the only usable evidence of intent — timing is not.** Treating
  "paused shortly after backgrounding" as Android's doing and anything later as
  the user's looks reasonable and was measured killing playback within ten
  seconds: the system's suspension does not arrive as one prompt event, it can
  come late and more than once. Do not reintroduce a grace window.

- **Never drop the playback foreground service on `hasMedia: false` alone.**
  Autoplay swaps the `<video>` element, so between two tracks the page honestly
  has none. Stopping the service there is not a recoverable mistake: the next
  `raise()` has to *start* a foreground service from the background, which
  Android 12+ refuses outright, and the queue goes silent mid-playlist with
  nothing in the log but a warning nobody reads. The page reports `wanted` —
  what it still intends, as opposed to what is happening this instant — and only
  `!hasMedia && !wanted` means stop.

- **A video ending must not clear the page's "wanted" flag.** It reads as the
  obvious place to, and it survived only because YouTube's own autoplay fires a
  `play` event that re-arms it. A hidden page is exactly where browsers block
  autoplay, and there the intent was already gone and the watchdog had nothing
  to act on. Keeping the flag cannot replay the finished video — `resume()`
  refuses an element that has ended — it only arms the next one.

- **`injectJavaScript` is queued, not run, while the app is backgrounded.** It
  executes on resume. react-native-webview posts it as a UIManager view command,
  and those are flushed on a Choreographer frame that an off-screen window never
  gets. The page's own timers keep running, so the asymmetry is easy to miss:
  the page can talk to the app, but the app cannot talk to the page.

  The route that does work is `setPageCommand` on the native module, which
  writes a `spool_cmd` cookie the page reads on its own tick. Both are sent for
  every command — the injection lands instantly while the app is on screen, the
  cookie within a second when it is not. Anything new that has to reach the page
  must go through `say`/`seek` in `useBackgroundPlayback`, not through
  `injectJavaScript` alone, however it is dressed up.

- **A hidden page cannot be made to resume, and must never claim it has.**
  Pausing from the notification always works; playing does not, because a hidden
  document may not start media without a user gesture. A `<video>` reads back as
  unpaused the instant `play()` is called, so reporting there reports a request
  as a fact — and once the play is refused the page's timers are frozen, so no
  correcting report ever arrives. Measured: the card sat on PLAYING over silence
  for thirty seconds, offering a pause button for something that was not going.
  `doPlay` reports when the play promise settles, and `PlaybackService` assumes
  a pause worked but never assumes a play did.

- **Lying to the page is not enough — the WebView itself has to be told it is
  visible.** Freezing `document.hidden` stops YouTube pausing itself and reaches
  nothing below that. WebView suspends the media pipeline of a WebView it
  considers hidden, decided from the Android view, so a backgrounded page played
  for ~50ms after every resume and stopped — identically with the screen off and
  with the app merely behind HOME, while audio focus was still ours
  (`gain: GAIN, loss: none`) and the renderer was still perceptible (`adj 51`).
  Both of those were checked precisely because they are the obvious suspects and
  both are innocent.

  `YtDlp.setWebViewVisible(true)` re-dispatches `View.VISIBLE` to the WebView
  once a second — repeated, because the real window visibility belongs to
  ViewRootImpl and our telling is not recorded there. Measured: five minutes
  screen-off with unbroken audio, the player at 6:08 against 1:14 when the
  screen went off.

  **It must be released the moment nothing is playing.** A pinned WebView goes
  on decoding video nobody is looking at. `syncPin` re-evaluates
  `away && (playing || wanted)` on every report; `wanted` is in there because
  between two tracks the page honestly has nothing playing and a WebView allowed
  to sleep there does not come back for the next one.

- **A resume buys a hardware decoder, so the watchdog must be metered.**
  `resume()` re-enables the page's video track and Chromium asks Android for a
  fresh decoder — for a 1080p AV1 stream, a hardware one. Off screen the element
  pauses again about 140ms later, so a pause handler that answers every pause
  unconditionally trades play and pause with Chromium about sixty times a
  second. Decoders were created roughly seven times faster than they were
  released, and at seventeen concurrent instances the pool was gone:
  `NO_MEMORY ... while in state 5/STARTING` and
  `reclaimResource: There aren't any clients to reclaim from`, permanently, for
  that renderer. Audio died after ~20s, the create/release loop ran on at ten a
  second until Android killed the renderer, and the user came back to a video
  stuck on "loading" over a full buffer.

  This is why it read as "sometimes": leaving within two or three seconds of
  starting a track was always fine, because YouTube had not yet upgraded to the
  stream that needs that decoder. One resume a second, three failures and stop —
  the budget comes back on a touch, an explicit play, the page returning to the
  screen, or playback surviving unaided. Measured on a Galaxy S21 FE, Android
  16, WebView 150.
- **Silence the WebView before playing anything locally — from every path.**
  `setPlaybackGate` on the player context exists so this cannot be forgotten at
  one of the several call sites. Under `doNotMix` our player takes exclusive
  audio focus and a page that is still playing takes it right back: the track
  resumes for roughly 90ms and stops. The media session goes `PLAYING` then
  `PAUSED` at the same position, which reads as "the play button does nothing"
  and produces no error anywhere. `playRecord` used to pause the page only when
  starting a *new* track, so resuming the already-loaded one — the most common
  action in the app — was broken this way.

- **Never call `play()` on a player object from a UI component.** Everything goes
  through `togglePlayback` on the player context. The lock screen is claimed on
  first play rather than on load, so that restoring a session at launch does not
  raise a paused notification nobody asked for — which means a surface that
  starts the engine directly skips the claim entirely. The failure is silent and
  looks like success: audio plays perfectly, `dumpsys media_session` reports
  `state=PLAYING` with `metadata: size=2, description=null`, and Android kills it
  a few minutes after the app is backgrounded because nothing is attached. Both
  the mini bar and the full player had this bug the moment resume-on-launch
  landed.

- **yt-dlp needs an explicit `player_client`.** Without a PO token, the default
  client chain 403s. Two chains live in `src/core/ytdlp.ts` and both are read
  from there, never from Kotlin:

  ```
  OPEN_CHAIN  = ['tv', null, 'web_embedded', 'mweb', 'android_vr']
  TOKEN_CHAIN = ['mweb', 'web']
  ```

  `android_vr` is **last, having been first** — since 2026 it needs a GVS token
  and without one it answers with a degraded manifest rather than refusing, which
  is the failure `judgeManifest` exists to catch. A held token runs `TOKEN_CHAIN`
  first and then the whole open chain with the token dropped, so a bad token can
  never leave the app worse off than an empty pocket. The extractor self-updates
  once per session if everything is refused.

  The order is not fixed: `src/core/clients.ts` scores each `(mode, client)` pair
  across launches and reorders the chain, so what runs first on a given device is
  learned. It only ever reorders — never removes — which is why a wrong board
  costs time and can never be the reason a download fails. Call
  `resetClientScores()` in `beforeEach` or the second test in a file runs against
  a chain the first one taught.
- **Auto-downloads must not land in `Music/Spool`.** Manual saves go to shared
  storage and belong in the user's gallery; hundreds of automatic ones do not.

- **The trial is enforced in Kotlin, described in TypeScript.** R8 obfuscates
  the native side and the signature pin refuses a repackaged APK; neither
  touches the JavaScript bundle, which ships as Hermes bytecode that decompiles.
  So `TrialGuard` decides and `src/core/trial.ts` only words the refusal. A
  patched bundle gets a UI that lies and a native layer that still says no.

  The expiry is stamped into `BuildConfig` at build time rather than stored on
  the device, so there is nothing to clear or reinstall past. Winding the clock
  back is caught two ways: before `BUILT_AT`, or behind the furthest-forward
  time ever seen, both with 26 hours of slack for time zones and NTP. The save
  counter is mirrored into `externalMediaDirs` — which **no longer survives
  either "Clear storage" or an uninstall.** Measured on Android 15 (API 35):
  `pm clear` empties `/sdcard/Android/media/<pkg>/` and an uninstall removes the
  directory outright. Google brought `Android/media` under the same cleanup as
  `Android/data` in Android 11, and every claim to the contrary in this file and
  in `docs/` predates that being checked. The mirror is therefore **not** a
  reset-resistant store: the save counter can be reset by reinstalling. The
  expiry cannot, because it is stamped into `BuildConfig`, so a trial build
  still dies on its date. Verified on the emulator at +10 days (expired) and
  −8 days (still expired).

  **None of it makes the build uncrackable and the code says so.** Anything
  running on the attacker's hardware can be patched. The goal is to move the
  cost from "clear app data" to "decompile, patch, resign, defeat the pin".

- **R8 will delete the native module.** Expo resolves each module class by the
  name in `expo-module.config.json`, so nothing in the bytecode references
  `YtDlpModule` and R8 strips it — the app then dies at startup with the module
  registry empty. The keep rules live in `app.json` under
  `expo-build-properties.android.extraProguardRules`, not in
  `android/app/proguard-rules.pro`, because `prebuild` regenerates that file.
  Keep the module class, both services and `com.yausername.**`; everything else
  in the package is meant to be obfuscated.

- **R8 also breaks what it cannot see being constructed.** Deleting the module
  is the loud failure; this is the quiet one. `commons-compress` registers its
  zip extra-field types from a static block by reflective `newInstance()`, so R8
  concludes `AsiExtraField` is never instantiated and makes it *abstract*.
  `ExtraFieldUtils`' initialiser then throws "not a concrete class",
  `ZipUtils.unzip` never unpacks the Python payload, and ART marks the class
  permanently bad — "Rejecting re-init on previously-failed class" — so every
  later attempt fails for the life of the install. Keeping `com.yausername.**`
  is not enough; the libraries it constructs through reflection need keeping
  too.

  This shipped. It survived because engine init is lazy and the emulator pass
  only proved the app *launched*. **A release-mode shrinking change is not
  verified until a real download completes on a real device from a fresh
  install** — anything less tests the wrong thing.

- **Work that needs a permission cannot run in the boot effect.** Permissions
  are requested at the *end* of first run, so anything at boot that touches
  media storage runs unasked and comes back empty — `scanSaved` adopted 0 files
  on a fresh install and 43 on the next launch. Same shape as the pre-release
  sheet, which was suppressed at boot and then never shown at all: on a fresh
  install the boot effect runs before the user has agreed to anything, and the
  first session is the one that decides what a tester thinks the app does.
  Anything gated on first run must be re-run when first run finishes, not
  skipped there.

- **Filesystem names are counted in bytes; Kotlin and Python count characters.**
  The output template was `%(title).80s` and `sanitise` used `take(120)`. Music
  and status channels title uploads in styled Unicode (𝐬𝐚𝐝 𝐬𝐨𝐧𝐠) and emoji at
  four bytes to the character, so eighty characters is ~340 bytes, past the
  255-byte limit, and the write dies with `[Errno 36]` before any audio lands.
  It is per-video and absolute: the title never changes, so that video can never
  be saved, while plain-titled ones save fine — which is why it reads as
  "sometimes it breaks forever". Downloads are named by `partialKey` now (see
  the resume bullet below — this bullet said "job id" for a while, which was
  true only between those two changes), and
  anything built from a title is trimmed on a byte budget at a character
  boundary.

  Neither error text matches any branch of `readableError`, so both surfaced as
  "check free space and connection" on a phone with 26GB free. When a failure
  makes no sense, read `[spool] engine error` in logcat before believing the
  copy.

- **Keep function bodies out of the Expo module DSL.** `Function` and
  `AsyncFunction` are inline builders with reified type parameters, and
  `definition()` is one enormous inlined expression. Two more inline bodies
  tipped it past what Kotlin would inline: the compiler stopped erasing
  `reifiedOperationMarker`, and every launch died before any JavaScript ran with
  "this function has a reified type parameter and thus can only be inlined at
  compilation time". Write `Function("name") { args -> memberFunction(args) }`
  and put the work in a private method. Records are worth avoiding here too —
  `@OptimizedRecord` wants introspection data from a KSP step this module does
  not run, and fails the same way. `Map<String, Any?>` is what `download`
  already uses.

- **The app keeps its own flight recorder, and it is the first place to look.**
  `src/core/log.ts` records structured, correlated entries; `src/core/crash.ts`
  installs the global error handler, the unhandled-rejection tracker and a
  `console` bridge. In a debug build everything is echoed to logcat as
  `[spool] hh:mm:ss …`; in a release build it is not, and **Profile → Export
  diagnostics** writes it to `Downloads/Spool` — previous run first, because a
  crash ends the process and the interesting session is the one that stopped.

  Three rules it may not break: it never throws (it runs on the failure path),
  it never blocks, and it never records a credential — `redact` matches on the
  *key*, because a token has no shape worth matching and this file leaves the
  device. See `docs/FEATURES.md § 16`.

- **`index.ts` must import `src/core/bootstrap` first.** ES imports are hoisted
  and evaluated in source order *before* any statement in the importing module's
  body, so calling the installer from `index.ts`'s body runs it after the entire
  app tree has been imported — which is precisely when a module-level throw
  would go unrecorded. The side-effect module exists only to win that race.

- **A client can refuse by answering, not only by throwing.** Measured on the
  phone: with no PO token, `android_vr` returned a *successful* manifest holding
  one muxed 360p and nothing else. Nothing threw, so the walk accepted it,
  pinned it as `preferredClient` for the session, and never asked `tv`, `ios` or
  `web`. Every layer below then behaved correctly on a manifest that was wrong —
  `bestAudio` found no audio-only stream and the replay rule gave up silently.

  `judgeManifest` now judges the answer too (no formats, or no audio-only rung).
  A degraded answer is **kept as a fallback**, not discarded, so the cost of
  judging too harshly is a slower walk and never a failed download.

- **`audioOnly` is the intent, never `format.kind`.** `bestAudio` falls back to
  a *muxed* format when the manifest has no audio-only rung — `-x` extracts the
  audio from it — so reading the kind back off the chosen format answers "video"
  and saves a file the user did not ask for. Pass the intent down; only the
  format sheet has none to pass, because there the tapped row is the statement.

- **Every format selector needs a term that cannot name nothing.** Ids only mean
  something inside the manifest that listed them, and `bestaudio` is itself
  absent from a degraded manifest, so both branches end in `best`. Without that
  tail yt-dlp says `Requested format is not available` — which had no branch in
  `readableError` either, so it surfaced as "check free space and connection".

- **A coded error's stack is the bridge's, not the fault's.** Anything carrying
  a native `code` was built by `CodedError` on the way out of the module: the
  stack names the bridge and a bundle URL while the real failure happened in
  Python and is already in `message`. Measured: one refused client wrote ~700
  bytes of which about 30 were about the refusal — five times per walk, evicting
  the history that explained it. `log.describe` drops the stack when a code is
  present and keeps it when there is none.

- **`uiautomator dump` cannot see the notice strip, and a screenshot can.**
  Chasing "is the trial refusal visible?", forty view-tree dumps across the live
  window found nothing while a screenshot taken in the same second showed the
  strip drawn correctly over the WebView. It reports RN text elsewhere (the tab
  bar), so its silence is not evidence of absence. **Verify overlay UI by
  screenshot.** Also: the strip lasts three seconds and extraction takes an
  unpredictable four to eight, so a fixed sleep tests nothing — poll, or read
  the `ui notice` line out of the log and time from that.

- **A download must be named for what it is, not for the attempt.** The output
  template was `{jobId}.%(ext)s` and the job id is minted per attempt, so
  yt-dlp — whose `--continue` is on by default — never had a partial file to
  continue into. A 141 MB save interrupted at 90% started again at 0%, every
  time, on exactly the connection that had already proved it would interrupt
  one; each abandoned `.part` then waited a day for the sweep. `partialKey`
  names it `{videoId}.{a|vHEIGHT}`. The quality has to be in there — a `.part`
  belongs to one format and resuming a 720p body into a file opened for 1080p
  corrupts it — and the title must not be, for the byte-limit reason above.

  The consequence to hold on to: **a shared name means "a file with this name
  exists" is no longer proof that this attempt wrote one.** `finished()` prefers
  one modified since the attempt began, and anything reading that directory has
  to make the same distinction or it will resolve a failed download to an older
  success.

- **A decoration must never be able to fail the thing it decorates.** Measured:
  a 31-minute save downloaded fully, converted to a 73 MB m4a, had its source
  deleted — and then failed with `Postprocessing: Conversion failed!` because
  `--embed-thumbnail` could not embed the cover. Complete, correct audio on
  disk; "Didn't finish — check free space and connection" on screen. `finished()`
  is consulted on the failure path too, and a complete file wins over the
  engine's opinion of it.

  What makes that safe rather than reckless is what it refuses, and **the list
  is longer than it looks**. A 360p save writes `.f134.mp4.part`, `.f134.mp4`,
  `.f251.webm`, `.temp.mp4` and `.mp4`, in that order. `.fNNN.` is half a merge
  — without it a video whose merge failed is published as a silent film — and
  **`.temp.` is the merge ffmpeg is still writing**, which carries the real
  container's extension and matches no `.fNNN.` pattern, so excluding only the
  latter rescues a *truncated* video instead. Caught on device with `.v144.mp4`
  and `.v144.temp.mp4` side by side, 35 MB against 33 MB, the old lookup
  choosing between them by modification time.

  So: `.fNNN.`, `.temp.`, `.part`, `.part-FragN`, `.ytdl`, images, and any
  cancel. The stale sweep uses the same pattern rather than an extension set,
  because `File.extension` reads `.part-Frag7` as `part-Frag7` and those
  leftovers otherwise survive forever at the size of a whole video. Verified in
  the dangerous direction, not just the happy one: a download killed once the
  video half was complete still fails and still publishes nothing.

  **Test the merge path explicitly.** Everything above was invisible for a whole
  pass because every download tried was audio, and audio never merges.

- **Under SABR, a media request is a POST — so anything that reads request
  bodies runs per fragment, all through playback.** `harvestFromRequest` cloned
  and UTF-8-decoded the body of *every* non-GET fetch to search it for a
  `"poToken"` field, which is fine on the handful of InnerTube calls a page
  makes and is not fine on the several-per-second segment requests SABR issues
  for audio and video. Reported as "YouTube is slow when playing a video", and
  worst on a Pixel, where 16 KB page-size compat mode
  (`plugins/withPageSizeCompat.js`, whose own comment says it "costs a little
  memory performance") makes allocation churn dearer.

  The justification in `harvestFromRequestBody` — *"an indexOf over a string we
  are handed anyway costs nothing"* — is true of its two other callers and false
  of this one, which **creates** the string. When a comment justifies a cost by
  saying the work was already done, check that it was already done at every call
  site.

  The gate is on **content-type, not URL**, and that distinction is
  load-bearing: the file refuses to match on endpoint paths because which
  request carries the token has already moved once, and a content-type does not
  go stale when `/youtubei/v1/player` does. `note('reqskip')` exists so a skip
  can be told from a hook that never fired — the same ambiguity, one layer down,
  that cost the day in the first place.

- **Hook where the data lands, not where you imagine it passes.** The PO token
  harvester hooked `JSON.parse`, `fetch` and `XMLHttpRequest.open` and saw
  *nothing at all* — zero media URLs across 25 seconds of playback — for three
  independent reasons, any one of which was enough: the watch page inlines its
  first player response as `var ytInitialPlayerResponse = {…}` so nothing parses
  it; `Response.json()` parses natively in C++ and never calls `JSON.parse`, so
  every SPA navigation was missed; and `XMLHttpRequest.open` sees the request,
  never the response the player data arrives in.

  Two lessons, and the second is the expensive one. A property trap plus
  `Response.prototype.json` plus an XHR `load` reader covers what one global
  hook cannot. And **a diagnostic that cannot tell "nothing fired" from "fired
  and found nothing" is not a diagnostic** — `saw` exists because that ambiguity
  cost a day and nearly bought a native rewrite that would not have helped.

- **A held token must never leave the app worse off than an empty pocket.**
  Holding one narrows the walk to the two clients that could have minted it, so
  a token that is expired, bound to another video, or the wrong context leaves
  two chances where a tokenless request had five. `attempts()` appends the whole
  open chain with the token dropped, so an exhausted token chain ends where it
  would have started with nothing harvested. Anything that narrows a fallback
  set on the strength of a *guess about credentials* needs the same escape.

- **The cookie jar handed to yt-dlp is the user's login, and deleting it is only
  safe because the name is unique.** It was one fixed
  `cacheDir/youtube-cookies.txt` that nothing ever deleted, so any device that
  had ever signed in kept a plaintext `SAPISID`/`HSID`/`__Secure-3PAPISID` for
  the life of the install. The fix reads as one change and is two: extraction
  and a download run concurrently on the same `scope`, so with a shared name the
  first to finish would delete the file the other was still reading. Per
  invocation, `noBackupFilesDir/session/`, discarded in the caller's `finally` —
  and the `finally` matters because `download`'s catch has a `return@launch` on
  the rescue path.

  **Do not "fix" this by encrypting it.** yt-dlp needs a real path to a readable
  file, so an encrypted jar has to be decrypted to a second plaintext file at
  the moment of use; that moves the exposure and adds a key to lose. The lever
  here is how long the file exists, not what is in it. `CookieJar.sweep` at
  engine init covers the one case `discard` cannot — the process dying
  mid-download.

- **Android Auto Backup uploads the WebView's cookie jar unless you stop it.**
  `allowBackup` defaults to true and the Expo template sets it explicitly, and
  the default exclusions are only `cache/`, `code_cache/` and `no_backup/` —
  `app_webview/` is not among them. So a signed-in session was going to Google's
  servers and would be restored onto any device the user restored to, as a
  working login, with nobody having decided that. Excluded now in
  `modules/ytdlp/android/src/main/res/xml/`, in **two** files: `fullBackupContent`
  is read on Android 11 and older, `dataExtractionRules` on 12 and newer, and
  the newer one splits cloud backup from device transfer so both need saying.
  `spool_trial.xml` is excluded too — a backup taken at zero saves would
  otherwise be a trial reset button.

  `android:allowBackup` is deliberately *not* repeated in the module manifest.
  The generated app manifest already sets it and a second declaration in a
  library manifest is a merge conflict, not an override.

- **The client chain reorders itself across launches, so tests must reset it.**
  `src/core/clients.ts` is a module singleton and deliberately outlives a
  session, which means `import(…?fresh=N)` cannot reach it: `ytdlp.ts` gets a
  fresh copy and shares one scoreboard with every other copy. Call
  `resetClientScores()` in `beforeEach` or the second test in a file runs against
  a chain the first one taught. It never *removes* a client, only reorders, so
  the worst a wrong board can do is cost time.

- **`DownloadService` has one slot and all four paths must take it.** One
  `currentId`, one notification, and an `ACTION_STOP` from whichever job ends
  first, so overlapping downloads interfere rather than queue. `takeSlot()` is
  the lock; **its release must sit in a `finally`**, because every one of these
  bodies has an early `return` on `E_CANCELLED` and a skipped release wedges
  every later download until the app restarts.

- **React Native's LogBox covers the bottom of the screen — which is where the
  notice strip and the format sheet are.** Anything mirrored to `console.warn`
  or `console.error` in a debug build raises it and hides the surface under
  test. The dev echo goes through `console.log` only.

- **`startForegroundService()` starts a five-second fuse, and the exception that
  ends it cannot be caught.** If `startForeground()` has not run by then Android
  throws `ForegroundServiceDidNotStartInTimeException` *at the app's main
  thread* and kills the process — no `runCatching` in the service can stop it,
  because the throw comes from the system rather than from the call.

  `DownloadService` used to call `startForeground` on `ACTION_START` alone,
  which leaves two ways to die: a `STOP` arriving as the first command to a
  fresh instance — which is exactly what `stopServiceIfIdle()` sends when a
  download fails early — called `stopSelf()` having never gone foreground, and
  a `PROGRESS` that overtook its `START` did the same. Observed on the emulator
  during a first-run download: the process died while yt-dlp was still spawning
  and took the app with it.

  **Every command now goes foreground before it is dispatched.** On a stop that
  raises a notification the same main-thread message removes, so no frame is
  drawn with it. Note the fuse burns on the *main* thread while the download
  runs on an IO thread, so a contended main thread makes the window narrow and
  the failure look random — never assume it is wide.

  **A foreground service can be demoted without being told, and then every
  `startForegroundService` to it is a crash waiting.** Measured on the S21 FE
  (six crashes in DropBox, reported as "crashes after a song or two"): Spool was
  battery-restricted, and for a restricted app Android demotes the service the
  moment the screen goes off, then ignores `startForeground` *silently* — no
  exception. `PlaybackService` believed it was still foreground, answered the
  next track's SHOW with `notify()`, and the process was killed. So:
  `startForegroundService` only to raise the card and a plain `startService`
  for every refresh; ask `getForegroundServiceType` rather than trusting a flag;
  check after `startForeground` that it took; answer every owed start; stop with
  `stopSelfResult(startId)`, because the debt is recorded when the call is
  *made* and a service stopped owing it dies on the spot. `adb logcat -s
  SpoolPlayback` shows all of it. And the restriction itself cannot be fixed
  from inside the app: with it on, screen-off playback has no service at all.

- **expo-audio's `remove()` does not stop a player.** On Android it only
  deletes the player from the module's table; the ExoPlayer is released when
  the JS object is garbage-collected or `release()`d, and plays on until then,
  unreachable from any control. Measured: five stop-then-play rounds left six
  live players, one still audible five minutes later. `dropAudio` pauses,
  removes, and releases two seconds later — not at once, because the screens
  unsubscribe from the object only after React re-renders without it.

- **A subscriber is a different state from a tester, not a tester with bigger
  numbers.** `YtDlpModule.download` asks `LicenseGuard.entitled` *before*
  `TrialGuard.refuse` and skips the trial entirely when it answers yes;
  `refuseSave` does the same in TypeScript. Raising the limits instead would
  leave four separate ways — expiry, quota, length cap, tamper — for a stale
  trial fact to refuse someone who has paid. `spendTrialSlot()` is the other
  half: a subscriber's saves must not draw down a counter that survives an
  uninstall, or a year of paid downloads silently exhausts the trial and the day
  the subscription lapses the user meets a quota their own paid usage spent.

- **A licence must be verified before it is stored, and the store re-verified
  on every read.** `LicenseGuard.remember` refuses a token that does not verify
  rather than parking bytes every later launch has to re-reject, and
  `expiresAt()` re-runs the signature check each call instead of caching a
  boolean. It costs tens of microseconds and it is what makes editing the
  preferences file by hand achieve nothing.

- **ECDSA P-256, and the signature must be DER.** `Signature.getInstance("Ed25519")`
  needs API 33 and this module's minSdk is 24, so Ed25519 is not available on the
  phones most likely to be running it. WebCrypto emits a raw `r || s` pair which
  every JCA on earth refuses, so `rawToDer` converts on the *server* — where
  `node --test` can reach it. A round trip that stayed inside WebCrypto passes
  while shipping a build in which no licence has ever worked. Two DER edge cases
  both occur in the field: a half whose top bit is set needs a leading zero or it
  decodes negative (one time in two), and leading zeros must be stripped or the
  length is wrong.

- **The signature covers the ASCII of the encoded payload, not the JSON.** JSON
  has no canonical form, so a verifier that parsed before checking would compare
  its own re-serialisation against bytes signed by V8, and key order or number
  formatting would eventually drift between the server and ART. `LicenseGuard.verify`
  checks the substring first and only then parses.

- **Offline must never revoke a subscription — and a definite "no" is not
  grounds either.** Spool plays a local library with no network by design, so
  every route from "could not ask the server" to "you have not paid" is a paying
  customer locked out of music they already own. `syncLicence` treats a throw, a
  500, an `entitled: false` and a token the native side rejects as *no news*:
  only `rememberLicence` returning true moves anything. Clock skew, a payment
  still under review and a half-finished migration all produce a truthful
  `entitled: false` and all resolve themselves; deleting a valid licence does not.

  **The one exception is a session the server has definitely ended.** Since
  accounts, `401 {"error":"signed out"}` and `403 {"error":"blocked"}` on an
  authenticated route drop the session and forget the licence — in
  `request()` in `src/core/account.ts`, the only place that rule is written.
  It matches the *exact* body on purpose: a captive portal's HTML 401 is the
  network being broken, and must stay no news like every other failure.

- **The licence token's `expiresAt` is a lease, not the subscription.** The
  server now signs tokens good for a few days and renews them on every sync, so
  a signed-out or blocked device stops being entitled within days. Anything that
  prints "days left" reads `paidThrough` (persisted as `dl.licence`), never the
  token — printing the lease told a year's subscriber they had three days.

- **A repackaged APK must get no licence, or the pin has a hole shaped like a
  paying customer.** Subscribe once legitimately, then decompile, patch and
  resign: the token still verifies, because the server signed it and it says
  nothing about which APK is holding it — and `download` skips `TrialGuard`
  entirely for an entitled device, so the signature check never ran at all.
  `LicenseGuard.expiresAt` returns 0 when `TrialGuard.intact` fails, which is
  what that pin was always meant to express.

- **A release build with no licence key fails at configuration time, on
  purpose.** It would otherwise install, run, take payments and then refuse every
  licence it was handed. The failure is invisible until a real person has paid
  real money, which is the worst possible moment to discover it. Debug builds
  ship an empty key and fail closed — nobody is entitled, the trial applies.

- **There is no payment gateway.** Razorpay was removed entirely: the user pays
  by UPI to the owner, uploads a screenshot, the app OCRs it on the device
  (`recognizeText`, ML Kit bundled model) and the server parses the text and
  grants on the spot or routes it to a person over WhatsApp. `review` and
  `rejected` are ordinary outcomes, not errors — the sheet's job there is to
  hand over a next step. See `docs/FEATURES.md § 17`.

- **The licence server is a PHP application and it is not in this repository.**
  On the development machine it is `c:\laragon\www\spool`, with its own
  README, its own schema and its own 33-check HTTP suite (`php tests/e2e.php`).
  What stays in `server/` here is a reference implementation of the token format
  and the Node test that pins it — that test is the only thing in the app's own
  suite that fails when the format drifts, which is why it survives the move.

- **PHP signs DER directly and JavaScript does not, and making them "consistent"
  breaks every licence.** `openssl_sign` on a P-256 key already emits DER, which
  is what the Android JCA wants; WebCrypto emits a raw `r || s` pair, so
  `rawToDer` in `server/src/license.js` has to convert and the PHP must not. The
  asymmetry looks like a bug in whichever file you read second.

- **A payment's claim and its grant must share one transaction** (server side).
  This was learned on the Razorpay webhook, which is gone, and it applies
  unchanged to `/v1/pay/claim`: recording the UTR/order as used in one
  transaction and granting in another is the shape that loses money — the
  grant rolls back, the "used" row survives, the retry is told `order already
  used`, and someone who paid is granted nothing, permanently.

- **Android blocks cleartext HTTP, and `syncLicence` cannot tell that from being
  offline.** A refused-before-it-left request arrives as a thrown fetch, which is
  treated as "no news" by design — so testing a debug build against a licence
  server on `http://…` produces a server that never sees a request and an app
  that reports nothing wrong. The debug source set carries a network security
  config permitting cleartext; release denies it *explicitly* rather than by
  default, so a manifest merge cannot quietly re-enable it.

- **Laragon points `DocumentRoot` at the project root, not `public/`.** Left
  alone that serves `config.php` — the database credentials and the licence
  signing key — over HTTP. The server's root `.htaccess` hard-denies the sensitive paths
  and funnels everything else into `public/`; deleting it on a host configured
  that way is a credential leak, not a tidy-up.
