# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing any code.

# The knowledge books live in docs/

`docs/` is the record of how this app actually works. Read the one that matches
the change **before** touching code, every time — these encode decisions that
are not recoverable by reading the source, and several of them are the reason a
line that looks redundant is load-bearing.

| Change you are about to make | Read first |
|---|---|
| Anything at all, first time this session | [`docs/README.md`](docs/README.md) — the map, plus how to run, test and build |
| Structural, native module, storage, build, R8, CI | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Adding / changing / removing a capability | [`docs/FEATURES.md`](docs/FEATURES.md) |
| Anything with a lifecycle, or "why did it do that" | [`docs/FLOWS.md`](docs/FLOWS.md) |
| Any UI change, including cosmetic ones | [`docs/UI.md`](docs/UI.md) |

**When a change lands that a book does not describe, update that book in the
same change.** A stale book is worse than none, because it will be trusted.

Two standing facts worth knowing before you read anything else:

- The root `README.md` describes **v1** — a bottom chrome bar, a `DownloadsScreen`
  and a `SettingsScreen`, none of which exist. Its engine, extraction and release
  sections are still right; everything it says about the interface is not.
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
  client chain 403s. `src/core/ytdlp.ts` walks `android_vr → tv → ios → web` and
  self-updates the extractor if all are refused. Retune that list in TS, not
  Kotlin.
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
  counter is mirrored into `externalMediaDirs`, which survives both "Clear
  storage" and an uninstall. Verified on the emulator at +10 days (expired) and
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
  "sometimes it breaks forever". Downloads are named for the job id now, and
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
