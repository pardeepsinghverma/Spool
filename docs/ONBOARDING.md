# Spool — working on it

The book for whoever is about to change something. Everything else in `docs/`
describes the app; this one describes the *job*. It answers: what do I need to
know before I touch anything, which book do I open, how do I do the twelve
things that get asked for most, and what counts as proof that I did it.

Read it once per session, before the book that matches your change.

---

## 1. The app in sixty seconds

Spool is one Android Activity, one React tree, one WebView and one native
module. A user browses YouTube in the WebView, saves what they want through a
bundled yt-dlp, and plays it back from a local library with the screen off.
There are no analytics, and an account is optional; everything else the app
knows is on the device. There is exactly one server — a plain PHP + MySQL
application, outside this repository — which holds Spool accounts, signs
subscription licences, checks UPI payment screenshots and arbitrates the
one-device-at-a-time play lock. **Signed out, the app sends it nothing.**
Signed in, it sends the account's session, a device hash and label, and when
the local player starts and stops; paying sends a receipt screenshot. A build
with no licence server configured never contacts it at all.

Five facts explain most of the code and nearly all of the bugs it has had:

1. **There are two playback engines and they know nothing about each other.**
   The page's `<video>` and the local `expo-audio`/`expo-video` player. Android
   has room for one media notification per app, so `src/player/nowPlaying.ts`
   arbitrates between them. Almost every subtle bug this codebase has had came
   from that seam.
2. **The WebView is mounted once and never unmounted.** Tabs hide it; nothing
   tears it down. That is why `src/browser/BrowserScreen.tsx` is 3,200 lines —
   everything that must survive a tab change has to live above the tabs.
3. **The app cannot talk to a backgrounded WebView by injection.**
   `injectJavaScript` is queued and delivered on resume. The channel that works
   is a cookie the page polls. The asymmetry is the trap: the page can always
   talk to the app.
4. **App data dies with an uninstall; MediaStore records do not.** That
   asymmetry is the entire reason `adoptSaved` exists, and the reason a library
   can rebuild itself from the gallery.
5. **The trial is decided in Kotlin and only described in TypeScript.** The JS
   bundle ships as Hermes bytecode that decompiles; `TrialGuard.kt` is the only
   copy that says no.

If you internalise nothing else, internalise 1 and 3.

---

## 2. Which book, for which change

Read in the order given. The first column is what you are about to do, not what
the code looks like.

| You are about to… | Read, in this order |
|---|---|
| Anything at all, first time this session | [README.md](README.md) → `AGENTS.md` → this file |
| Change what a screen looks like, however cosmetic | [UI.md](UI.md) — **every time**, no exceptions |
| Add, change or remove a capability | [FEATURES.md](FEATURES.md) → [UI.md](UI.md) if it is visible |
| Debug "why did it do that" | [FLOWS.md](FLOWS.md) → the flight recorder (§7 below) |
| Touch anything with a lifecycle — playback, downloads, services, the WebView | [FLOWS.md](FLOWS.md) → [ARCHITECTURE.md § 6](ARCHITECTURE.md#6-threading-and-lifecycle-rules) |
| Find which file owns something | [CODEMAP.md](CODEMAP.md) |
| Write Kotlin, or change the build | [NATIVE.md](NATIVE.md) → [ARCHITECTURE.md § 7](ARCHITECTURE.md#7-build-and-release) |
| Store something, or change a stored shape | [DATA.md](DATA.md) |
| Write or fix a test, or decide what proof a change needs | [TESTING.md](TESTING.md) |
| Understand what has already been measured on a device | [RELIABILITY.md](RELIABILITY.md) |

`AGENTS.md` is loaded automatically every session and is not optional reading.
It is the list of traps that have each already cost a day. This file indexes
them by symptom in §8.

`MARKET.md` is dated outside research kept as planning input. It describes the
market, never the app. Do not cite it as though it described behaviour.

---

## 3. Before you write a line

- **Expo 57 is not the Expo you remember.** Read the exact versioned docs at
  `https://docs.expo.dev/versions/v57.0.0/` before writing Expo code. This is
  the first rule in `AGENTS.md` because it keeps being the cause.
- **`android/` is generated and not committed.** Anything that must survive
  `expo prebuild` belongs in `app.json` or in a plugin under `plugins/`. An edit
  to `android/app/proguard-rules.pro` will be gone by the next build and the
  failure will land weeks later, in release only.
- **No new dependencies without a reason that survives being said out loud.**
  The test tree deliberately has none: this project ships a sideloaded APK with
  a self-updating extractor, and a test tree that needs its own install is one
  that stops being run.
- **Check the tree before assuming a file is dead.** Four files are documented
  as v1 leftovers and one of them is not dead: `src/browser/DownloadButton.tsx`
  still exports the `DownloadState` type that `BrowserScreen.tsx:105` imports and
  the FAB is built on. `grep` before deleting.
- **A "must" in a book is not always an "is".** `AGENTS.md` states rules the code
  is meant to hold to, and [RELIABILITY.md](RELIABILITY.md) records where it does
  not yet — §5.4 below is the live example. When the two disagree, RELIABILITY is
  the measurement and `AGENTS.md` is the intent.

---

## 4. Conventions this codebase actually keeps

Read three files before writing in an area and match them. The house style is
strong and consistent, and a patch that reads like a different project is a
patch that will be rewritten.

**Comments explain why, never what.** The density is high — `src/core/ytdlp.ts`
carries 251 comment lines in 691, `src/player/PlayerContext.tsx` 238 in 905 —
and almost every one of them is the reason a line that looks removable is not.
When you delete a line, read the comment above it first; when you add one that
looks redundant, say why in a comment or the next agent will delete it.

**Layering.** `src/core/` is logic with no React in it, with two deliberate
exceptions (`artwork.ts` and `trial.ts` export hooks alongside their stores).
`src/browser/`, `src/player/`, `src/screens/`, `src/sheets/`, `src/shell/` and
`src/ui/` are the React halves. The native surface is reached only through
`modules/ytdlp/index.ts` — nothing imports Kotlin behaviour by any other route,
and `src/core/engine.ts` holds the platform-agnostic seam that keeps iOS
possible.

**Module-level stores over prop threading.** `nowPlaying.ts`, `pageNowPlaying.ts`,
`artwork.ts`, `clients.ts` and `log.ts` are module singletons on purpose: they
exist so that a 3,200-line screen does not re-render once a second. Two
callback registries (`setPlaybackGate` on the player context, `setPreReleaseOpener`
in `core/trial.ts`) exist for the same reason. Adding state to `BrowserScreen`
is the default; adding a store is the choice you make when a re-render per tick
is the cost.

**Refs where a subscription must not be rebuilt.** `settingsRef`, `playsRef`,
`screenRef`, `forgottenRef`, `cardCanSave`, `cardSave`, `runAutoSave` are
mirrors of state, and they exist because the WebView's `onMessage` handler and
the notification command listener are subscribed once. Rebuilding them mid-video
drops the messages the play counter runs on. If you find yourself adding a
dependency to one of those effects, you are probably introducing that bug.

**Copy is part of the code.** [UI.md](UI.md#copy-rules) holds the rules. An
error string that does not match a real failure is a defect, not a wording
choice — three separate failures once surfaced as "check free space and
connection" on a phone with 26 GB free.

---

## 5. Recipes

Each of these is a path that has been walked. Follow the order; the ordering is
usually the part that is load-bearing.

### 5.1 Change something on screen

1. Read [UI.md](UI.md) for the surface you are touching. It encodes which colour
   means what, what is deliberately absent, and which behaviours are structural
   rather than decorative.
2. Use tokens from `src/ui/theme.ts` — `fixed` for what never changes, the
   theme's `t` for what borrows from artwork. Never a literal colour, never a
   literal type size.
3. If the change is visible over the WebView (the notice strip, sheets, the mini
   bar), verify it by **screenshot**. `uiautomator dump` cannot see those
   surfaces and its silence is not evidence — forty dumps once found nothing
   that a screenshot in the same second showed drawn correctly.
4. Update [UI.md](UI.md) in the same change.

### 5.2 Add a function to the native module

1. Declare it in `modules/ytdlp/index.ts` first. That file is the contract and
   the TypeScript types carry intent the Kotlin cannot.
2. In `YtDlpModule.kt`, write `Function("name") { args -> memberFunction(args) }`
   and put the body in a private method. **Bodies inside the DSL are how every
   launch once died before any JavaScript ran** — `definition()` is one enormous
   inlined expression and two more inline bodies tipped it past what Kotlin
   would inline.
3. Use `Map<String, Any?>` for structured arguments. `Record` types need a KSP
   step this module does not run and fail the same way.
4. Anything slow goes on `Dispatchers.IO`. Anything that raises a notification
   must reckon with the foreground-service rules in [NATIVE.md](NATIVE.md).
5. If it is a new class, ask whether R8 can see it being constructed. If Expo or
   the manifest resolves it by name, it needs a keep rule in `app.json`.
6. Update [NATIVE.md](NATIVE.md) and [ARCHITECTURE.md § 3](ARCHITECTURE.md#3-the-native-module-contract).

### 5.3 Store something new

1. Read [DATA.md](DATA.md) for the key naming (`dl.*`), the cap conventions and
   the corruption rules.
2. Every loader swallows its own errors and returns something usable. A blob
   from an older build must read as *missing keys*, not as a throw — settings
   are merged over `DEFAULT_SETTINGS` for exactly this reason.
3. Decide the lifetime deliberately: app data dies with an uninstall, MediaStore
   records do not, and `externalMediaDirs` survives "Clear storage". Put the
   thing where its survival is what you want, not where it is convenient.
4. Add a suite to `tests/storage.test.mjs` or a sibling — the storage tests are
   mostly about proving that what comes back is still usable.
5. Update the table in [DATA.md](DATA.md) and [ARCHITECTURE.md § 4](ARCHITECTURE.md#4-where-state-lives).

### 5.4 Touch the download path

1. Read [FLOWS.md § 4–§6](FLOWS.md#4-one-tap-download-instantdownload) end to
   end. Four paths start a download — the FAB, the replay rule, the
   notification's save button, and a failed row's *Try again* — and the rule is
   that all four take the single slot, whose release must sit in a `finally`
   because every one of these bodies has an early `return` on `E_CANCELLED`.

   **Today only two of them do.** `takeSlot()` in `BrowserScreen.tsx:510` has
   exactly two call sites (`:1403` and `:1848`); the notification's save button
   and *Try again* still start immediately and can land on top of a running job.
   That is recorded as a known defect in
   [RELIABILITY.md § D4](RELIABILITY.md#d4--two-downloads-can-still-overlap-from-the-other-two-paths-medium-known),
   not as an invariant that holds. If you are in this code, closing it is
   cheap — but it needs a device pass, which is why it was left.
2. Names are `partialKey`, never the job id and never the title: a job id per
   attempt means yt-dlp's `--continue` never has a partial to continue into, and
   a title in the filename means a byte-limit failure that is permanent for that
   video. The quality belongs in the key; resuming a 720p body into a file
   opened for 1080p corrupts it.
3. A shared name means "a file with this name exists" is no longer proof that
   *this attempt* wrote one. Anything reading that directory must prefer a file
   modified since the attempt began.
4. `finished()` is consulted on the failure path too, because a decoration must
   never be able to fail the thing it decorates — but it refuses `.fNNN.`,
   `.temp.`, `.part`, `.part-FragN`, `.ytdl`, images and any cancel. Read the
   `AGENTS.md` entry before touching that list; the reasons are not symmetrical.
5. **Test the merge path explicitly.** Everything above was invisible for a
   whole verification pass because every download tried was audio, and audio
   never merges.

### 5.5 Change the extraction / client chain

1. It is TypeScript, not Kotlin. `src/core/ytdlp.ts` holds both chains —
   `OPEN_CHAIN = ['tv', null, 'web_embedded', 'mweb', 'android_vr']` and
   `TOKEN_CHAIN = ['mweb', 'web']` — and `src/core/clients.ts` reorders them from
   what has worked on this device. Retune the lists in TS; Kotlin takes the
   client it is given.
2. **A client can refuse by answering, not only by throwing.** `judgeManifest`
   judges the answer — no formats, or no audio-only rung — and keeps a degraded
   answer as a *fallback* rather than discarding it, so judging too harshly
   costs a slower walk and never a failed download.
3. Every selector needs a tail term that cannot name nothing. Ids only mean
   something inside the manifest that listed them, and `bestaudio` is itself
   absent from a degraded manifest, so both branches end in `best`.
4. A held PO token narrows the chain to the clients that could have minted it,
   so `attempts()` appends the whole open chain with the token dropped. Anything
   that narrows a fallback set on a guess about credentials needs the same
   escape.
5. `resetClientScores()` in `beforeEach`, or the second test in a file runs
   against a chain the first one taught.

### 5.6 Touch playback or the media notification

1. Read [FEATURES.md § 8–§10](FEATURES.md#8-the-local-player) and
   [FLOWS.md § 10–§11](FLOWS.md#10-playing-a-library-track).
2. **Never call `play()` on a player object from a component.** Everything goes
   through `togglePlayback` on the player context, which claims the lock screen
   on first play. A surface that starts the engine directly skips the claim, and
   the failure looks exactly like success until Android kills the session a few
   minutes after backgrounding.
3. **Silence the page from every path that makes a sound** — `silenceOthers()`
   in `PlayerContext`, fed by `setPlaybackGate`. Under `doNotMix` a page that is
   still playing takes the audio focus straight back and the track plays for
   about 90 ms.
4. On Android 13+ the card is built from the `PlaybackState`, not the
   notification's actions. The scrubber needs `ACTION_SEEK_TO` *and* a real
   `METADATA_KEY_DURATION`; a duration of 0 means "not known yet" and must be
   left unset.
5. Position is not pushed on a timer, and a source that is not making a sound
   may not take the card from one that is. Both rules are what stop the two
   engines fighting over the card twice a second.

### 5.7 Touch browser background playback

This is the most fragile area in the app. Read `AGENTS.md` on it in full and
[FLOWS.md § 17](FLOWS.md#17-browser-background-playback-end-to-end) before
changing a line. The three rules that are counter-intuitive and were each
measured:

- The page must read its own visibility and infer intent from a **touch**, never
  from timing and never from a message the app sends.
- A video ending must not clear `wanted`, and `!hasMedia` alone must never drop
  the foreground service.
- The watchdog must stay metered — one resume a second, three failures and stop
  — because a resume buys a hardware decoder and an unmetered loop exhausts the
  pool permanently for that renderer.

### 5.8 Add a log point

`src/core/log.ts`. Three rules it may not break: it never throws (it runs on the
failure path), it never blocks, and it never records a credential — `redact`
matches on the **key**, because a token has no shape worth matching and this
file leaves the device. Dev echo goes through `console.log` only: `console.warn`
and `console.error` raise React Native's LogBox, which covers the bottom of the
screen, which is where the notice strip and the format sheet are.

### 5.9 Add a test

Read [TESTING.md](TESTING.md). In short: Node's own runner, the loader in
`tests/harness/`, `?fresh=n` for a clean copy of module state, and the
`expo-modules-core` stub's handler table for native calls. Nothing with a React
component or a real native call is covered, and pretending otherwise is how a
green suite lies.

### 5.10 Change the build, or anything R8 touches

1. Keep rules live in `app.json` under
   `expo-build-properties.android.extraProguardRules`. All of them are
   load-bearing; [ARCHITECTURE.md § 7](ARCHITECTURE.md#7-build-and-release)
   explains each failure they prevent.
2. R8 deletes what it cannot see referenced, and makes abstract what it cannot
   see constructed. The second is the quiet one and it shipped once.
3. **A release-mode shrinking change is not verified until a real download
   completes on a real device from a fresh install.** The emulator pass only
   proves the app launched, and engine init is lazy.

### 5.11 Change trial behaviour

Decide in `TrialGuard.kt`; word it in `src/core/trial.ts`. Limits are stamped
into `BuildConfig` at build time, so extending a trial is a rebuild, not a
server call. `TrialGuard` is deliberately *not* kept by R8 — it is meant to be
obfuscated.

### 5.12 Update the books

Whenever a change lands that a book describes, update that book **in the same
change**. A stale book is worse than none, because it will be trusted. §9 below
is the contract for what goes where.

---

## 6. What proof a change needs

Four rungs. Each proves strictly less than the one below it, and a change is not
done until it has reached the rung its class requires.

| Rung | Command / action | Proves | Does not prove |
|---|---|---|---|
| 1 | `npm run typecheck` | The types agree | Nothing about behaviour |
| 2 | `npm test -- "tests/*.test.mjs"` | Pure logic, the injected page script, the client walk — **477 tests, 110 suites, ~9 s** | Anything React, anything native, anything visual |
| 3 | Emulator (`npm run android`) | It launches, screens draw, in-app flows run | Anything lazy, anything R8, anything that needs real hardware or a real network |
| 4 | Release APK, fresh install, real device | The only rung that counts for shrinking, the engine, downloads and background survival | — |

Which rung your change needs:

- Copy, layout, a pure function → rung 2, plus a screenshot if it draws over the
  WebView.
- Anything in `src/core/` with a test → rung 2.
- Anything React, anything with a lifecycle → rung 3 at minimum.
- The engine, downloads, R8, keep rules, services, background playback, the
  trial → **rung 4, no exceptions.** These are the areas whose failures are
  invisible on the emulator by construction.

Two measurement rules that have already cost a day each:

- **A fixed sleep tests nothing.** Extraction takes an unpredictable four to
  eight seconds; poll, or read the timing out of the log.
- **Verify overlay UI by screenshot**, not by view-tree dump.

---

## 7. Debugging: where to look, in order

1. **The flight recorder.** `src/core/log.ts` keeps a bounded, correlated,
   redacted ring; `src/core/crash.ts` installs the global error handler, the
   unhandled-rejection tracker and the `console` bridge. In a debug build every
   entry is echoed to logcat as `[spool] hh:mm:ss …`. In a release build it is
   not: **Profile → Export diagnostics** writes it to `Downloads/Spool`, previous
   run first, because a crash ends the process and the interesting session is
   the one that stopped.
2. **`[spool] engine error` in logcat**, before believing any copy on screen.
   When a failure makes no sense, the readable error is probably the fallback
   branch, not a diagnosis.
3. **`dumpsys media_session`** for anything about the card. `state=PLAYING` with
   `metadata: size=2, description=null` is the signature of a session claimed
   without being attached.
4. **A screenshot** for anything drawn over the WebView.
5. **[RELIABILITY.md](RELIABILITY.md)** — five verification passes are recorded
   there with what each one found. Check whether your symptom is already a
   closed defect before re-deriving it.

A coded error's stack is the bridge's, not the fault's: anything carrying a
native `code` was built by `CodedError` on the way out of the module, so the
stack names the bridge and a bundle URL while the real failure is already in
`message`.

---

## 8. Symptom → trap

The index into `AGENTS.md`. Read the full entry there before acting; this table
only gets you to the right one.

| What you are seeing | Trap |
|---|---|
| A track plays for ~90 ms and stops | The page still has audio focus — the playback gate was not called on this path |
| The play button "does nothing", no error anywhere | Same as above, or `play()` called directly on the player object |
| Audio dies every time the app is backgrounded | Background playback depending on a message from the app instead of the page's own visibility read |
| Audio dies ~20 s after leaving, video stuck "loading" on return | The watchdog's resume budget — decoder pool exhausted |
| Background audio plays ~50 ms after each resume, then stops | The WebView itself was never told it is visible (`setWebViewVisible`) |
| The queue goes silent between two tracks | The foreground service dropped on `hasMedia: false`, or `wanted` cleared when a video ended |
| The card flickers between two titles about twice a second | Both sources publishing; the "you take the card by playing" test was bypassed |
| The card shows PLAYING over silence | A refused `play()` on a hidden page reported as fact |
| No skip buttons on the media card | `setActiveForLockScreen` publishing Media3's session instead of `PlaybackService` |
| Every launch dies before any JavaScript runs | A function body inline in the Expo module DSL, or a `Record` type |
| The app dies at startup with an empty module registry | R8 deleted `YtDlpModule` — keep rules |
| Downloads fail forever after a fresh release install | R8 made a `commons-compress` extra-field type abstract |
| The process dies mid-download, taking the app with it | A `DownloadService` command that did not go foreground before dispatch |
| Every later download hangs until restart | `takeSlot()` released outside a `finally` |
| A 90%-complete download restarts at 0% | The output template naming the attempt instead of the content |
| "Didn't finish — check free space and connection", 26 GB free | An error with no branch in `readableError`; read the engine error |
| A complete file reported as a failure | A decoration (`--embed-thumbnail`) failing the thing it decorates |
| A video that can never be saved while others save fine | A title in the filename, past the 255-**byte** limit |
| Only 360p available, no audio-only rung | A client refusing by answering — `judgeManifest` |
| `Requested format is not available` | A selector with no tail term that cannot name nothing |
| A download that fails with a token and would have worked without one | `attempts()` must append the open chain with the token dropped |
| The second test in a file fails against a chain the first taught | `resetClientScores()` missing from `beforeEach` |
| The library is empty on a fresh install and full on the next launch | Work that needs a permission running in the boot effect |
| A sheet that should show on first run never shows | Same shape: gated on first run, suppressed at boot, never re-run |
| The surface under test is hidden by a red box | LogBox — something reached `console.warn`/`console.error` |
| A harvester that sees nothing at all | Hooking where you imagine the data passes, not where it lands |
| Overlay UI "not present" in forty view dumps | `uiautomator dump` cannot see it; screenshot instead |

---

## 9. The documentation contract

Ten books in `docs/`, plus `AGENTS.md` and this one. Each has a job, and putting
a fact in the wrong one is how books rot. (`MARKET.md` is not a book — see §2.)

| Book | Holds | Does not hold |
|---|---|---|
| [README.md](README.md) | The map, how to run, test and build | Any behaviour |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Structure, seams, state ownership, threading, build | What the user sees |
| [FEATURES.md](FEATURES.md) | Every user-visible capability and the rules it runs under | Sequences, and pixels |
| [FLOWS.md](FLOWS.md) | End-to-end sequences, in order, with the load-bearing orderings | Anything static |
| [UI.md](UI.md) | Tokens, type, spacing, motion, the five tabs, the player, copy | Logic |
| [CODEMAP.md](CODEMAP.md) | Files, exports, signatures, import edges | Why a feature exists |
| [NATIVE.md](NATIVE.md) | The Kotlin half, the bridge contract, the build | Anything above the bridge |
| [DATA.md](DATA.md) | Every store, shape, cap, and what survives what | How the data is used |
| [TESTING.md](TESTING.md) | The ladder, the harness, coverage, recipes | Findings |
| [RELIABILITY.md](RELIABILITY.md) | What was measured, when, on what, and what it found | Prescriptions |
| `../AGENTS.md` | Traps that have each cost a day, with the measurement that proved them | Anything routine |

Rules:

- **Same change, same commit.** A book updated a week later is a book that was
  wrong for a week.
- **Facts, measured.** Every claim in these books that sounds specific — "~140 ms",
  "seventeen concurrent instances", "43 files on the next launch" — is a real
  observation. Do not add one you have not made. Write "not determined" instead;
  it is worth more than a plausible number.
- **A new trap goes in `AGENTS.md` only if it cost a day and is not derivable
  from the source.** That file is loaded on every request; padding it is not
  free.
- **The design is the source of truth for UI.** If `docs/UI.md` and the code
  disagree, go back to the Claude Design project named in `AGENTS.md` rather
  than guessing which is right.

---

## 10. Things that look like improvements and are not

Each of these has been proposed, tried, or shipped and reverted.

- Unmounting the WebView when another tab is showing. It costs a page reload
  every time someone checks their library.
- Any audio interruption mode other than `doNotMix`. It is the mechanism behind
  the playback gate, not a preference.
- `expo-audio`'s `setActiveForLockScreen`, or `expo-video`'s
  `showNowPlayingNotification`. Two sessions means two cards for one app, and
  Media3's callback removes the skip commands outright.
- Pruning a playlist's stored ids against the library on load. Downloads load
  asynchronously and adoption lands later still, so one slow launch would empty
  every playlist permanently.
- Treating "paused shortly after backgrounding" as Android's doing. Timing is
  not evidence of intent; a touch is.
- Clearing the page's `wanted` flag when a video ends. It cannot replay the
  finished video — it only arms the next one.
- Answering every pause from the watchdog. That is the decoder-pool exhaustion.
- Dropping the stack from a log entry that has no native `code`, or keeping it
  on one that does. The rule is the opposite of the instinct in both directions.
- Adding a devDependency to the test tree.
- Editing anything under `android/`.
- Adding analytics, or any outbound request that is not the licence server's.
  The privacy claim in [FEATURES.md § 14](FEATURES.md#14-privacy) is a property
  of the code. The Spool account is the one deliberate exception, and it is
  opt-in and scoped: see FEATURES § 17.

---

## 11. Known gaps, so nobody rediscovers them

[ARCHITECTURE.md § 9](ARCHITECTURE.md#9-known-gaps-in-the-wiring) is the current
list — dead wiring that is real, currently true, and deliberately not fixed. Read
it before reporting one of them as a bug. The short version: the download
notification never shows progress or completion, its CANCEL action stops the
service without destroying the process, `onLog` is declared and never emitted,
and several v1 files survive in the tree unreferenced.
