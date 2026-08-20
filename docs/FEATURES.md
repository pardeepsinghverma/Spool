# Spool — feature map

Every user-visible capability, where it lives, and the rules it runs under.
Structure is in [ARCHITECTURE.md](ARCHITECTURE.md); sequences are in
[FLOWS.md](FLOWS.md); how any of it looks is in [UI.md](UI.md).

A rule marked **load-bearing** has already been broken once and cost real
debugging. Do not "simplify" one without reading why it is there.

---

## The five tabs

`src/shell/TabBar.tsx` — `home | search | browse | library | profile`. Local
first on the left, the open web in the middle, everything you own on the right.
Switching is instant; a tab that animates feels slower than one that does not.

The shell (`BrowserScreen`) renders the WebView once and lays the four local
tabs over it as absolutely-positioned views. The WebView is **never unmounted**
— leaving Browse must not cost a page reload.

Back-button precedence, in order: picker sheet → full player → quality sheet →
**open playlist** → WebView history (on Browse) → return to Browse from any
other tab → exit. A playlist is a place inside the Library tab, so back leaves
it before back leaves the tab.

---

## 1. Browse

**Where:** `browser/BrowserScreen.tsx`, `browser/youtube.ts`, `browser/adblock.ts`

A `react-native-webview` on `https://m.youtube.com`, presenting a plain Chrome
user agent — Android's stock WebView UA contains `; wv`, which Google rejects on
its sign-in flows.

- `thirdPartyCookiesEnabled`, `domStorageEnabled`, `mediaPlaybackRequiresUserAction={false}`,
  `allowsFullscreenVideo`, `setSupportMultipleWindows={false}`.
- Non-`http(s)` navigation is refused outright by `onShouldStartLoadWithRequest`.
- The app draws exactly one control over the page: the FAB. No floating bubble,
  no chrome bar. That restraint is the product's whole differentiator from
  Vidmate/Snaptube/TubeMate.

### SPA navigation

YouTube is a single-page app: `pushState`/`replaceState` change the route
without a page load, so the WebView's own `onNavigationStateChange` misses most
in-app navigation and the download button goes stale. `NAV_SCRIPT` patches both
history methods, listens for `yt-navigate-finish` and `popstate`, watches
`<title>` with a MutationObserver, and keeps a 1s poll as a safety net.

`extractVideoId` is regex-based rather than `URL` + `searchParams`, because
React Native's URL polyfill does not implement `searchParams`. It handles
`watch?v=`, `youtu.be/`, `/shorts/`, `/embed/`, `/live/`, `/v/`. The host test
must not be foolable by `youtube.com.evil.com` — see `tests/youtube.test.mjs`.

### Ad blocking

Three layers, because YouTube's ads are not one thing:

1. **Player-response stripping.** Pre-roll and mid-roll are described in the
   InnerTube player response, not fetched from a blockable host. `JSON.parse`,
   `Response.prototype.json` and the `ytInitialPlayerResponse` setter are all
   wrapped, and the ad keys deleted before YouTube's own JS reads them. This is
   the layer that matters.
2. **Cosmetic filtering.** One injected stylesheet hiding ~18 promo renderers.
3. **Skip fallback.** A 500ms interval that clicks a skip button or seeks past
   an ad that got through.

Honest limits: server-side stitched ads (SSAI) are part of the stream and
survive all of this; YouTube ships anti-adblock detection periodically; true
Brave parity would need a native `shouldInterceptRequest` hook, which this does
not attempt.

---

## 2. Downloading

Three separate code paths save a file, and they are separate on purpose. See
[FLOWS § 4–7](FLOWS.md).

| Path | Trigger | Quality from | Publishes to gallery | Marks the video "taken" |
|---|---|---|---|---|
| `beginDownload` | FAB tap or sheet pick | The user's pick | Yes | No |
| `autoSaveStat` | The replay rule | Profile defaults | **No** — stays app-private | Yes |
| `saveFromCard` | The notification's save button | Profile defaults | Yes | No |
| `retry` | A failed Library row | The failed row's own kind + defaults | Yes | No |

### The FAB

`BrowserScreen` renders it only on Browse. Six states, each with its own glyph
because v2 has no chrome to put words in:

| State | Glyph | Meaning |
|---|---|---|
| `idle` | download (line colour, inert) | Not a watch page |
| `ready` | download (filled, tinted) | A video is on screen |
| `resolving` | hourglass | Reading formats |
| `working` | close + progress ring | Downloading; tap cancels |
| `done` | check (saved green) | Tap opens Library |
| `failed` | refresh (warn) | Tap retries |

- **Tap commits.** It takes whatever `settings.instant` is (`audio` or `video`)
  and starts, because the common case is wanting this one the same way as the
  last one.
- **Hold for 3 seconds** opens the quality sheet. The button swells over exactly
  that duration and snaps back when the finger lifts, because three seconds with
  no feedback reads as a dead control.
- The wake pulse fires three times when a watch page resolves, then stops. A
  button that pulsed forever would be wallpaper within a day. Suppressed under
  reduced motion.

### Quality sheet

`sheets/QualitySheet.tsx`, fed by `browser/formatView.ts`. Four modes:
`quick` (up to three picks: Best / a 1080p rung / Audio only), `all` (the full
video table), `error`, `empty`. Never a raw format table on the front sheet.

The sheet also carries the "one tap downloads" segmented control, because "why
did tapping give me audio?" is only ever asked at the moment the alternatives
are on screen.

Leaving the Browse tab closes the sheet. The download is unaffected — only
picking a format starts one.

### Extraction

`core/ytdlp.ts` owns the strategy; Kotlin only executes it.

- **PO tokens.** Since 2025 essentially every stream request needs one or it
  403s. Standalone downloaders mint them by running BotGuard in a synthetic
  environment, which is fragile and is why they keep dying. Spool *is* a browser:
  `POTOKEN_SCRIPT` harvests the `pot` parameter off the page's own media URLs and
  out of the player response, plus `visitorData` from `ytcfg`. A harvested token
  is a web token and only validates against web-client requests, so supplying one
  pins `player_client=web`.
- **Client chain.** Without a token the only lever is which InnerTube client to
  impersonate, and which of them still serve unattested requests changes month to
  month. `CLIENT_CHAIN = ['android_vr', 'tv', 'ios', 'web', null]`, walked in
  order; the last worked client is remembered and tried first next time. `null`
  is yt-dlp's own default chain, kept last so a future version that has already
  solved this wins without a code change.
  **Retune this list in TypeScript, not Kotlin.**
- **Listing and downloading must agree on one client** — a format id from one
  client's manifest 403s when fetched as another.
- **Self-repair.** If every client is refused, the engine updates its own
  extractor once per session and walks the chain again. A sideloaded app gets no
  store updates, so in-place repair is the only path there is.
- **Cookie handoff.** `CookieJar.write` reads the live WebView session through
  `CookieManager` — including the HttpOnly cookies `document.cookie` cannot see —
  and writes a Netscape cookie file for `--cookies`. This is the payoff of
  actually being a browser.
- **Merging** is yt-dlp's own, with the bundled ffmpeg
  (`--merge-output-format mp4`), which handles codec pairs `MediaMuxer` cannot.
  A video-only stream is selected as `<id>+bestaudio/best`.
- Every download gets `--embed-thumbnail` and `--embed-metadata`, so a file
  carries its cover and artist into any other player on the device.
- Audio downloads are extracted to `m4a`.
- Storyboard formats (`mhtml`, ids starting `sb`) are dropped; near-identical
  rungs are deduped, keeping the largest per resolution.

### Names

**Where:** `core/metadata.ts`, applied in `core/ytdlp.ts` and `BrowserScreen`

A library built from YouTube inherits its names from uploaders rather than from
a tagger, so the same recording arrives as
`Tum Hi Ho | Aashiqui 2 | Arijit Singh (Official Video) [4K]` where a player
wants *Tum Hi Ho* by *Arijit Singh*. The raw form makes every surface worse: the
row, the sort, local search, the second line of the media card, and the filename
the user later finds in their gallery.

Four passes, each of which can only ever **remove**:

1. **Bracketed asides that are packaging-only** — `(Official Music Video)`,
   `[4K]`, `【MV】`. The largest win and the safest, because a bracket is the
   uploader themselves marking a phrase as an aside.
2. **Pipe segments.** Packaging-only ones go; where more than one real segment
   survives the first is taken, since a pipe-delimited title is
   "name | film | singer | label" almost without exception. Unless the first
   segment *is* the known artist — the one arrangement where taking it leaves
   the row named after the singer rather than the song.
3. **A known artist used as a prefix** — "Arijit Singh - Tum Hi Ho" with the
   artist already known is provable duplication, not a guess.
4. **A packaging-only tail** after the last dash, which is where
   "- Official Video" lives when the uploader did not bracket it.

Rules that are load-bearing:

- **The packaging vocabulary is deliberately not `similar.ts`'s, and the two
  must not be merged.** That one decides whether two names are one recording, so
  it drops anything that cannot tell recordings apart — "ft", "feat", the
  language. This one decides what to show a person, and "(feat. Shreya Ghoshal)"
  is exactly what they want left on the row.
- **A fragment is dropped only when *every* word in it is packaging.** "Official
  Video" goes; "Live at Wembley", "(Acoustic)" and "(Remastered 2011)" stay. The
  cost of dropping a real name is a row nobody can identify; the cost of keeping
  a stray "Official" is a slightly long row.
- **Every pass falls back to what it was given.** A title that is *entirely*
  packaging survives as itself — a bad name beats an empty row, and a blank page
  title mid-navigation is exactly what produces one.
- **"Artist - Title" is a convention, not evidence, so the split is
  corroborated.** Film music is titled "Tum Hi Ho - Aashiqui 2" — song and film
  — and reading that as a name files the song under its own film permanently.
  The split fires only where the left side is an artist the library or the play
  index has already seen, which is a fact rather than a convention. With nothing
  to corroborate against, the whole string stays the title. Same rule as the
  storage meter: the app may not assert what it does not know.
- **A derived artist never sets `music`.** That flag is YouTube saying "this is
  a track" and it decides what *Match* keeps; an artist recovered from a dash is
  something to show, not a second opinion about what the video is.
- **`- Topic` is stripped from a channel name; `VEVO` is not.** The first is
  YouTube's own marker on generated artist channels. The second arrives welded
  to the name — cutting it yields "ArijitSingh", which is worse than the channel.

`loadDownloads` and `adoptSaved` run the same pass over what is already stored,
because the library this was built for is the one that has been collecting
uploader titles for weeks. Only the label moves: the file, its own tags and its
MediaStore record are untouched.

### Publishing

A finished file lands in app-private storage. `publishToGallery` inserts a
MediaStore record into `Music/Spool` (audio) or `Movies/Spool` (video), copies
the bytes in, clears `IS_PENDING`, and **deletes the source**. Only a MediaStore
record makes a file visible in Gallery on modern Android.

**Load-bearing:** automatic saves must **not** publish. Manual saves belong in
the user's gallery; hundreds of automatic ones do not, so they stay app-private
and play from a `file://` path.

### Errors

`readableError(e, stage)` turns yt-dlp's developer-facing stderr into one short
sentence, and always logs the raw message as `[spool] engine error`. **When a
failure makes no sense, read logcat before believing the copy** — several real
failures (`ENAMETOOLONG`, a dropped connection) once fell through to a generic
"check free space and connection" on a phone with 26 GB free.

The `stage` argument matters: telling someone whose disk is full to update their
extractor sends them to the one screen that cannot help.

---

## 3. The replay rule (auto-save)

**Where:** `browser/usePlayTracking.ts`, `core/plays.ts`, `autoSaveStat` in
`BrowserScreen`, configured on Profile.

The app quietly keeps what you go back to. It is invisible while it works: the
green tick on an "On repeat" row is the *only* announcement it ever makes.

### What counts as a play

The bar is deliberately high, because a counter that over-counts silently fills
someone's phone with things they never chose:

- **Muted video never counts.** The page script refuses to report it, which is
  what keeps the home feed's autoplay previews out of the index.
- **Watch time comes from the playhead, not the clock.** Buffering, a stalled
  network and a frozen process all keep wall time running while nothing is heard.
- **Seeks are not watching.** A step larger than `MAX_CREDITED_STEP` (3s, against
  a 1s reporting interval) adopts the position without crediting the gap.
  Dragging to the end of an hour-long video earns nothing.
- **A play must be meant.** The start banks only after `MIN_PLAY_SECONDS` (5) of
  real playback, which also means one video cannot bank two starts without the
  user leaving and coming back.

Watch time is folded into the index every 15 credited seconds so long plays
survive the app being killed mid-video. Writes are batched on a 4s timer.

### What the index stores

Three numbers per video — `starts`, `seconds`, `lastAt` — plus title, artist, a
`music` flag and `savedAt`. **No history of when each play happened, no ordering,
nothing that reconstructs a session.** Capped at 300, trimmed saved-first then
least-recent. Nothing here is ever sent anywhere and there must never be a
network call in that module.

### Firing

When a start is banked and `starts >= settings.after` and `savedAt` is unset,
the video is queued. Automatic saves run **one at a time** — several thresholds
can fall in one session, and a queue of long videos all extracting at once would
compete for bandwidth with whatever the user is currently watching, which is the
one thing an invisible feature must never do.

`markSaved` is claimed **before** any slow work, so a second threshold crossing
during extraction cannot start the same download twice. It stays marked even if
the download fails — a retry loop that re-downloads on every play would be far
worse than one missed save. A failed automatic save is still recorded as a
Library row, because a silent failure leaves the user believing they have a file
they do not have.

A trial refusal here says nothing and simply does not save, leaving the video
unmarked so it is retried once the tester has a full copy.

### Settings (Profile)

`enabled` (default on), `after` (2 / 3 / 5, default 3), `keepAs`
(`audio` / `video` / `match`, default audio), `audioQuality`, `videoQuality`.

`match` reads the page's own `mediaSession.metadata.artist` — a real artist is
YouTube saying "this is a track", not just "this has an uploader" — or
`music.youtube.com`. That distinction is the only evidence the page offers about
music, so it is kept apart from the channel-name fallback used for display.

Quality settings are **ceilings, not demands**: the best rung at or below the
setting is taken, falling back to the smallest available rather than to nothing.
An unparseable audio setting means *no ceiling*, not a low one — capping
someone's audio because a string failed to parse is a failure they would never
trace back.

`instant` is deliberately separate from `keepAs`: wanting video when you ask and
audio when the app decides is a perfectly ordinary pair of preferences.

---

## 4. Library

**Where:** `screens/LibraryScreen.tsx`, `records`/`jobs` in `BrowserScreen`,
`core/storage.ts`

Sections top to bottom: **Downloading** (with Cancel all), **Didn't finish**,
then **On this device · N items · X GB**.

- Filters: All / Music / Video / Downloading. Kind follows what was *asked for*,
  not whether it worked — a failed music download still belongs on Music.
- Sort cycles Newest → Largest → Title A–Z → **Artist A–Z** on one header tap;
  the label appears only while it is not the default. Artist A–Z is grouping
  done as a sort: rows with no artist sink rather than sorting under the empty
  string, and title breaks the tie.
- The row leads with the artist where one is known. "Saved automatically" versus
  "You saved this" moves to second place rather than going — it is the rule's
  only trace — and the quality gives up its place instead.
- Subtitle wording is load-bearing: **"Saved automatically · <quality>"** versus
  **"You saved this · <quality>"** is the only trace the replay rule leaves
  anywhere in the app.
- In-progress rows read `Starting…` → `N%` → `Finishing…`. yt-dlp reports
  nothing for the first few seconds and hits 100% when the stream lands while
  ffmpeg still has to remux, so a ring alone would look like a hang and then like
  a lie.
- Three or more failures in the last 24 hours raises a one-line notice pointing
  at the extraction engine. Said once, never repeated.
- **Cancel, never pause.** yt-dlp cannot resume a half-finished job, so offering
  pause would promise something the engine will not honour.

### Row actions

- A saved row: **Remove from library?** — and it says plainly that the file
  survives, because the row vanishing otherwise reads as the download being
  thrown away.
- A failed row with a video id: **Try again / Remove**. Retry leads, because the
  common causes — a dropped connection, a momentary refusal, a since-updated
  extractor — are all fixed by asking again. The old row goes, so a retry does
  not leave its own failure sitting above the result.

### Adoption — the library rebuilds itself from the gallery

`scanSaved()` + `adoptSaved()` run at boot **and again the moment first run
grants media permission**. App data dies with an uninstall; MediaStore records do
not, so a reinstalled Spool would otherwise show an empty Library over a folder
full of music. Measured on a phone: 0 adopted on first launch, 43 on the next —
which is why the second call exists.

- Matched on `uri`, the one identifier both halves share.
- `dl.forgotten` is what stops a rescan undoing a removal.
- **A restored row has no `videoId`.** Nothing in a MediaStore row records which
  video a file came from, so it plays and lists and sorts, but cannot tell the
  replay rule it already exists — a track revisited after a reinstall can be
  saved twice. Fixing that properly means writing the id somewhere that travels
  with the file, which changes what the user sees in their gallery, so it is
  deliberately not done.
- Quality reads `audio`/`video` rather than an invented "1080p" the user could
  check and find wrong.
- Only shared storage is recoverable. Automatic saves live in app-private
  storage and are gone with the app.

### Export and backup

**Where:** `core/export.ts`, `MediaStoreWriter.writeText`, the playlist overflow
and the *Back up playlists* row on Profile

"My playlists were gone after a reinstall" is one of the oldest complaints in
this category, and Spool is *more* exposed to it than most: the library index
and the playlists are app data, and Android deletes app data with the app.
Manual saves survive because they are MediaStore records — `adoptSaved` is built
on that asymmetry — but nothing rebuilds the *arrangement*, because an
arrangement is not a file. This is what turns one into a file.

Two formats, for two readers, both written to **`Downloads/Spool`**:

- **`.m3u8` per playlist** — `#EXTM3U`, `#PLAYLIST:`, then `#EXTINF:secs,Artist
  - Title` and the file's uri. What every other player on the device
  understands.
- **one `.json`** — what a later Spool would read to put the lists back.

Rules worth knowing:

- **The backup carries tracks by name, never by id.** Ids are exactly the thing
  that does not survive: a reinstall rebuilds the library from MediaStore and
  every row returns under a `found:` id it has never had. A title and an artist
  are what the files themselves still carry.
- **A `content://` location is a real limit, and the code says so.** Some players
  resolve one and some only understand a path. The `#EXTINF` line always
  survives, so even where the location does not resolve the track is named well
  enough to find. An automatic save is app-private and will not open elsewhere
  at all.
- **An unknown runtime is `-1`**, which is what M3U reserves for it. `0` reads as
  a zero-length track, which is a different and wrong claim.
- **The backup filename uses the local date.** `toISOString` would name a
  September evening in India after the day before, and the only reader is a
  person picking yesterday's file out of a folder.
- **Everything is a pure function of what it is given**; the writing is one
  native call at the edge, which is what makes all of it testable.
- **Import is not built.** Reading a file back needs a document picker, which is
  a dependency and a native surface this build does not have. The export is
  still worth having without it — it is the half that stops the loss — but a
  restore that puts the lists back automatically is the obvious next step.

### Playlists

**Where:** `core/playlists.ts`, the Playlists section and detail view in
`screens/LibraryScreen.tsx`, `sheets/NameSheet.tsx`

The one list in the app the user arranges by hand. Everything else in the
library is derived — newest, largest, title A–Z are all answers the app works
out — and the whole value of a playlist is that nothing rearranges it
afterwards. The Library header's sort cycler does not reach into one, and
neither does anything else.

- **Ids, not tracks**, for the same reason `dl.session` stores ids: a row
  removed while the app was closed must not come back as a playlist entry
  pointing at a file that is no longer listed. `resolve` turns ids into rows
  against the library as it stands.
- **Stored ids are never pruned, and that half is load-bearing.** An id that
  resolves to nothing today may be a library that has not finished loading —
  downloads are read asynchronously at boot and gallery adoption lands later
  still. Pruning on load would empty every playlist on one slow launch,
  permanently, with nothing anywhere to say why. Resolution is for display; the
  stored list changes only when the user changes it.
- **Playing a playlist plays that list, not the library behind it.** The queue
  and *Up next* are the only promise the player makes about what comes next, and
  starting the whole library from a matching row would break it on the first
  skip.
- **Reorder is up/down in the row menu, not a drag.** Reordering is the half of
  playlists users complain is missing, and a control that works on the first tap
  beats one that works on the third attempt at a long press. Neither end offers
  the direction it cannot go, and moving past one is a no-op rather than a wrap
  — a track leaping from the bottom to the top on a stray tap reads as a bug.
- **A track already in the list is refused, and the notice says which happened.**
  Adding the same row from two screens must not silently double it. The store
  returns `added` and `duplicate` counts so the copy is a fact rather than a
  guess.
- **Deleting a playlist confirms, and says the tracks stay.** "Delete" over a
  list of music reads as deleting the music; only the arrangement goes.
- **Names are unique.** The Add-to sheet is a list of names and nothing else, so
  two called "Night drive" is a choice the user cannot make. A clash gets a
  numeric suffix; renaming a playlist to what it is already called does not.
- **"New playlist…" from the Add-to sheet ends with the track in it.** The sheet
  carries what asked for it, because naming a list and landing in an empty one
  reads as the feature not working.

Caps: 50 playlists, 500 tracks each. Past that a playlist is a library and the
queue it builds is unusable.

---

## 5. Home

**Where:** `screens/HomeScreen.tsx`

**Recently added** (the 12 newest saves, horizontal cards) then **On repeat** —
the top 8 by play count, straight from the counters, so this list is also the
honest answer to "is the tracking working?".

Chips: All / Music / Video / Offline. They filter for real. *Offline* means
already on the device, which for the cards is all of them and for On repeat is
the subset actually kept.

The green tick appears only where the **rule** did the saving. A file the user
chose themselves never earns it. `more-vert` on a row offers to forget its play
counts, stating the numbers before throwing them away and making clear anything
already saved stays.

The mock had a cast button here. There is nothing to cast to, and the player
already drops it for that reason — leaving it on Home made the app claim a
capability in one place and deny it in another.

---

## 6. Search

**Where:** `screens/SearchScreen.tsx`

The local index answers instantly, on a **title or artist** substring — a music
library that cannot be searched by artist reads as a broken search rather than a
title-only one. **The cloud is a button
and never an automatic second query** — nothing here may fire a network request
on a keystroke, and the screen says so in a footnote.

Tapping "Search YouTube for …" hands the query to the page (`injectJavaScript`
setting `location.href`) and switches to Browse. It is never a second search of
ours. Recent searches are capped at 8.

---

## 7. Profile

**Where:** `screens/ProfileScreen.tsx`, `sheets/ChoiceSheet.tsx`

- Identity: "This device — No account · nothing leaves the phone". There is no
  account, so there is nothing else to say.
- **Keep automatically**: the whole replay rule in one card — switch, threshold,
  Keep as, and the two quality rows. Everything the rule does elsewhere is
  invisible, which makes the copy here part of the feature rather than labelling.
- **The download button**: what one tap grabs, and a line explaining the hold.
- **Storage**: the used figure. The meter is drawn only when a capacity is
  known, which needs a native `StatFs` call this build does not have — a meter
  drawn from a guess is worse than no meter, because it is the one control here
  that looks like a measurement.
- **Extraction engine**: the real version from the native module, tappable to
  update. Three tones, not two: green claims "up to date", and `"unknown"` —
  what youtubedl-android reports until an update has actually run — stays
  uncoloured, because green would assert the one thing not established. Warn
  when three or more downloads failed today.
- The legal line.

A "Wi-Fi only" row used to sit here. Nothing enforced it — reading the
connection type needs a native probe this build does not have — so it asserted a
policy the app did not run, and was removed. Same rule as the storage meter: an
absence is honest, a claim is not.

---

## 8. The local player

**Where:** `player/PlayerContext.tsx`, `player/PlayerScreen.tsx`,
`player/NowPlayingBar.tsx`

Audio and video are separate engines (`expo-audio`, `expo-video`) but **one
seat**: starting either stops the other, so there is always exactly one thing
playing and one set of lock-screen controls describing it.

### Rules that are load-bearing

- **`interruptionMode: 'doNotMix'`.** Lock-screen controls only attach in that
  mode, and it is what gives the player exclusive audio focus — the mechanism
  the playback gate depends on.
- **Never call `play()` on a player object from a UI component.** Everything goes
  through `togglePlayback` on the context. The lock screen is claimed on first
  play (not on load, so restoring a session does not raise a card nobody asked
  for), so a surface that starts the engine directly skips the claim entirely.
  The failure is silent and looks like success: audio plays perfectly, and
  Android kills it a few minutes after backgrounding because nothing is attached.
- **Silence the WebView from every path**, via `setPlaybackGate`. Under
  `doNotMix` a page that is still playing takes the audio focus straight back:
  the track resumes for ~90ms and stops, the session goes PLAYING then PAUSED at
  the same position, and it reads as "the play button does nothing" with no error
  anywhere.
- **Players are reused, not replaced,** on a track change (`replace()` /
  `replaceAsync()`). Tearing one down and standing up a new one loses the
  lock-screen handoff — the new player reports the right duration, seeks
  correctly, and never makes a sound. It also avoids pointing a live `VideoView`
  at freed native state.
- `restore()` drops both engines first. It did not once, and a second call
  orphaned a live engine: two media sessions, one playing at 4:51 and one paused
  at 4:11, the UI bound to the paused one and the audible player unreachable by
  any control on screen.

### The gap between tracks

**Where:** the `warmed` effect in `player/PlayerContext.tsx`

The next track in the queue is preloaded while the current one plays, so a queue
advance is a swap rather than a load.

**This is not gapless playback and is deliberately not described as such
anywhere in the app.** True gapless on Android means an ExoPlayer playlist.
`expo-audio` ships one — `AudioPlaylist`, backed by its own `ExoPlayer` with
`addMediaItem` — and adopting it would mean replacing `AudioPlayer` with a
second player object owning its own session. Every rule in this file that was
learned the hard way is built on the current arrangement: one player reused
across the queue, the lock screen claimed on first play, `doNotMix` for
exclusive focus. Swapping the engine to buy the last few tens of milliseconds is
not a trade worth making blind, and it cannot be verified anywhere but on a
device.

What preloading removes is the load latency, which for a local file is most of
what a listener actually hears at a boundary. What it does not remove is the
silence a continuous album needs closed.

Two constraints, both load-bearing:

- **Audio only.** `AudioPreloadManager` on the Android side reads the whole
  source into a `ByteArray` and holds it until cleared. That is fine for one
  6 MB track and unacceptable for a video at a hundred times the size.
- **One at a time.** The previous warm source is released *before* the next is
  fetched, so the store never holds two — and the provider's teardown releases
  whatever is left, because that store outlives React.

### Lyrics

**Where:** `core/lyrics.ts`, `player/useLyrics.ts`, the Lyrics block in
`PlayerScreen`

The only part of this app that talks to somebody who is not YouTube, and the
whole design is about being straight about that. Lyrics are not in the file —
yt-dlp has nothing to embed — and cannot be derived from audio on the device, so
they come from `lrclib.net`.

- **Never automatic.** Same rule as the Search tab, which will not fire a cloud
  query on a keystroke. The request happens because somebody pressed *Look up
  lyrics*, never because a track started. A privacy claim that holds except when
  music is playing is not a privacy claim.
- **Asked once, in words, before the first request leaves.** The dialog names
  the host, says what is sent, and says this is the only request Spool makes
  that is not YouTube's. Until that answer is stored, nothing opens a socket —
  and a failed read of the answer counts as "no", because a broken disk must not
  become a request nobody agreed to.
- **What is sent is the track**: name, artist, length. No identifier, no device,
  no library, no history. The length is what lets LRCLIB tell a song from its
  own extended mix, and is left out entirely where it is not known.
- **"There are none" is cached; "we could not ask" is not.** A 404 is an answer
  and worth remembering. A timeout is not, and caching it would leave a track
  permanently lyric-less because of one dead moment on a train — so a failure
  throws, the screen says it could not reach lyrics, and it goes on offering.
- **Cached by name, not by download id.** The same recording saved twice, or
  re-saved under a new id after a reinstall, is the same lyric.
- Two-digit fractions are hundredths and three-digit ones are milliseconds.
  Reading `.50` as milliseconds puts every line 450ms early, which is enough to
  look like the wrong line is lit.
- Stamps with no text are kept as lines. They are the gaps between verses, and a
  follower that skips them runs the highlight through an instrumental break.

### Sleep timer

**Where:** `sleep` / `setSleep` on `player/PlayerContext.tsx`, the armed line in
`PlayerScreen`, the sheet in `BrowserScreen`

Off / 15 / 30 / 45 / 60 minutes / end of this track. Reached from the full
player's overflow, and from the armed line itself.

- **Held as a deadline, not a countdown, and checked on the tick the player
  already runs.** A `setTimeout` that has to survive an hour of a backgrounded,
  dozing process is exactly what Android is entitled to defer, and a sleep timer
  that fires late has failed at its only job. An absolute time is compared with
  the clock every second and **also immediately on arming**, so a process thawed
  after an hour honours a deadline that passed while it was frozen.
- **It pauses; it never stops.** `stop()` clears the session outright, so
  stopping would mean waking up to an app with no idea where it was. Pausing
  leaves the queue, the playhead and the notification exactly where they were.
- **It pauses directly rather than through `togglePlayback`.** The rule that
  every *play* goes through the context is about claiming the lock screen, and a
  pause claims nothing — but a toggle firing on something already paused would
  *start* it, which is the one outcome a sleep timer must never produce.
- **End-of-track is answered in `advance`, before the next track loads.** Letting
  the next one start and then pausing it is audibly wrong, and on a queue of
  short tracks it is how someone wakes up two songs later.
- **Stopping disarms it.** A timer left armed over silence is waiting to pause
  something that no longer exists.
- The sheet ticks **what was asked for** (30 minutes); the player's line says
  **what is left** ("Sleeps in 12 min"). Storing only the deadline meant the
  sheet ticked nothing, which reads as the timer not having taken.

Not covered by tests — it lives in a React component and a real timer. Verify on
a device: arm 15 minutes, background the app, confirm playback stops within a
few seconds of the deadline and the notification shows paused rather than gone.

### Queue

Everything playable is in the queue, in the order shown, so the transport and
"Up next" are real rather than decoration.

- **Repeat** cycles off → all → one. Reaching the end with repeat off *stops*,
  rather than silently restarting — a queue that loops forever without being
  asked is how a phone plays music all night.
- **Shuffle reorders the queue** rather than randomising each pick, because
  "Up next" is the only promise the screen makes about the future. Only what is
  still ahead is shuffled; already-played entries keep their order. Turning it
  off restores the library's order with the playing track still current.
- **Previous** restarts the track past 3 seconds, as every other player does.
- Tapping the row of the thing already playing is a pause, not a restart of the
  whole queue.

### Session resume

Written every 5s (and on teardown) as `{ ids, index, at }` — **ids, not tracks**,
so a row removed while the app was closed cannot restore as a queue entry
pointing at a file that is no longer listed. At boot the ids are resolved
against the library just loaded and the survivors restored **paused**. If the
playing track itself is gone, playback lands on whatever now occupies its place,
from the start; resuming a *different* track at the old track's playhead would be
worse than either.

`stop()` clears the session outright: stopping is a decision, not an
interruption, so the next launch must not offer a place to return to.

### Full player

One session, two shapes — a 320 artwork square or a 202 16:9 frame, chosen by a
toggle that only appears for a video track. Position, queue and buffer are
shared; swapping shape hides the picture, it does not reload anything.

No tab bar: it is a sheet over the tab it was opened from, and the chevron
returns you there without stopping playback. Transport: shuffle, previous,
play/pause, next, repeat, plus a scrubber and "Up next". No like count, no share
chip, no cast — those are YouTube's, and a row of controls that do nothing is
worse than a row that is absent.

### Mini bar

Rides above the tab bar on the four local tabs, **never on Browse** — that is
someone else's page at full bleed, and stacking our bar under the FAB would put
two of our controls over someone else's layout. Hidden under the full player,
which already shows everything the bar would say.

It carries the browser too. A page that is actually playing wins outright: under
`doNotMix` only one of them is audible, and showing a paused library track over
YouTube would put a play button on the bar that stops the sound the user can
hear when they press it. Otherwise the local session wins; a paused page falls to
the bottom and shows only when there is nothing else, so leaving a video to check
Library still leaves a way back to it. Tapping a page bar goes back to Browse —
a page has no queue and no full player worth opening.

---

## 9. The media notification — the app's fifth surface

**Where:** `player/nowPlaying.ts` (arbiter), `PlaybackService.kt` (the card)

One card, two sources. `PlaybackService` is ours for both — deliberately **not**
`expo-audio`'s `setActiveForLockScreen`, which publishes a Media3 session with
`SEEK_TO_PREVIOUS_MEDIA_ITEM` and `SEEK_TO_NEXT_MEDIA_ITEM` removed outright, so
no configuration puts skip buttons on it. `expo-video`'s
`showNowPlayingNotification` is off for the same reason: two sessions means two
cards for one app.

### How the card is built

**On Android 13+ the media control panel is built from the `PlaybackState`, not
the notification's actions.** Buttons added only to the notification are not
drawn. Transport, scrubber and times are all expressed as session state first;
the notification actions are the fallback for Android 12 and older.

- The scrubber needs `ACTION_SEEK_TO` **and** a real `METADATA_KEY_DURATION`. A
  duration of 0 means "not known yet" and must be left unset, or the system draws
  a scrubber over a track it thinks is empty.
- The second line comes from the session's `ARTIST` and nowhere else — the
  notification's own `contentText` is not drawn. The source label ("YouTube" /
  "On this device") therefore rides after the artist with a `·`. `ALBUM` carries
  it alone for surfaces that show three lines.
- Artwork crosses a binder transaction with about a megabyte to live in. A 512px
  ARGB_8888 square is 1,048,576 bytes exactly — the whole budget for one field —
  so covers are capped at a 384px edge and decoded off the main thread only when
  the path changes.
- The **save** button is a custom session action, present only for a page that is
  not already on the device. A library track is already the file a save would
  produce, so the button is absent rather than inert.

### Arbitration

**You take the card by playing.** A source that is not making a sound may update
the card it already owns and may not take one from a source that is. Without that
test both publish on every tick and each reads the other's publish as a claim —
measured on a phone, the card alternated between the library track and the page
title about twice a second and the buttons acted on whichever had written last.

Commands come back only to the current owner. `releaseNowPlaying` from a source
that has already lost the card does nothing, so closing a browser tab cannot take
down the card for a library track that has just started.

### Position is not pushed on a timer

A `PlaybackState` carries a position, the clock it was measured at, and a speed;
the system extrapolates between updates. `publishNowPlaying` pushes only when
what the card *shows* changes, or when the real playhead has drifted more than
two seconds. A track playing normally costs nothing per second. The 1s tick in
`PlayerContext` exists only so no transport path can be the one that forgot to
tell the notification.

### Play is never assumed; pause always is

Pausing always works. Playing does not — off screen the page is a hidden document
and may not start media without a gesture. So `PlaybackService` reflects a pause
immediately and never reflects a play, and the app sets a 4-second grace timer
after asking the page to play; if no confirmation arrives, the card is put back
where it was. Measured: without it, the card sat on PLAYING over silence for
thirty seconds, offering a pause button for something that was not going.

---

## 10. Browser background playback

**Where:** `browser/background.ts` (page half), `browser/useBackgroundPlayback.ts`
(app half), `PlaybackService.kt` (survival)

Leaving the app breaks WebView video in two independent places.

**The system's half** — a frozen cached process and a sleeping CPU — is answered
natively: a `mediaPlayback` foreground service exempts the process from the
freezer, and a partial wake lock held only while sound is coming out answers the
CPU.

**The page's half** — YouTube pausing itself on the Page Visibility API — is
answered in the page:

- `hidden`, `webkitHidden`, `visibilityState` and `webkitVisibilityState` are
  **frozen**, not merely set once, because YouTube re-reads them on every check.
- `visibilitychange`, `webkitvisibilitychange`, `pagehide` and `freeze` are
  swallowed in the capture phase on `window`, ahead of anything the page attached
  to `document`. `blur` is deliberately absent — the page needs it for focus and
  it is not what YouTube pauses on.
- The real visibility is captured from `Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')`
  before the freeze, so the page can still tell where it is. The lie is
  convincing enough to fool us too.

### Rules that are load-bearing

- **The page must not learn it was backgrounded from a message.** That race is
  unwinnable: Android pauses the media first, the page reads its own pause as
  deliberate, clears the intent flag, and the watchdog has nothing to restore.
  Audio died every single time the user left the app.
- **A touch is the only usable evidence of intent — timing is not.** A pause
  within 700ms of a real touch is the user's; anything else is undone. Treating
  "paused shortly after backgrounding" as Android's and anything later as the
  user's looks reasonable and was measured killing playback within ten seconds:
  the system's suspension does not arrive as one prompt event, and can come late
  and more than once. **Do not reintroduce a grace window.**
- **The WebView has to be told it is still on screen, or none of the rest
  matters.** Freezing `document.hidden` keeps the *page* from finding out it was
  backgrounded; it does not reach WebView, which suspends the media pipeline of
  a WebView it considers hidden and decides that from the Android view. Without
  `YtDlp.setWebViewVisible(true)` a resumed page played for about 50ms and
  stopped again — the same with the screen off as with the app merely behind
  HOME, with audio focus still held and the renderer still perceptible. With it:
  five minutes screen-off, audio unbroken, the player reading 6:08 against 1:14
  when the screen went off. **Held only while `away && (playing || wanted)`** —
  a pinned WebView goes on decoding video nobody can see, so `syncPin` re-reads
  that on every report and unpinning hands the real visibility back.
- **A resume costs a hardware decoder, so the watchdog is metered.** Resuming
  re-enables the page's video track, and Chromium answers by asking Android for
  a fresh decoder — for a 1080p AV1 stream, a hardware one. Off screen the
  element pauses again about 140ms later, so a handler that resumes
  unconditionally trades play and pause with Chromium roughly sixty times a
  second. Decoders were created about seven times faster than they were
  released, and at **seventeen concurrent instances the pool was gone**:
  `Codec reported err 0xfffffff4/NO_MEMORY ... while in state 5/STARTING`, then
  `reclaimResource: There aren't any clients to reclaim from` for the life of
  that renderer. Audio died after about twenty seconds, the create/release loop
  ran on at ten a second until Android killed the renderer, and the user came
  back to a video stuck on "loading" over a buffer that was already full.
  **At most one resume a second, and stop after three in a row fail.** The
  budget comes back on a touch, on an explicit play, when the page is on screen
  again, or when playback has survived a few seconds unaided. Leaving within a
  couple of seconds of pressing play always looked fine, because YouTube had not
  yet upgraded to the stream that needs that decoder — which is why this read as
  "sometimes it stops".
- **A video ending must not clear the intent flag.** It reads as the obvious
  place to, and survived only because YouTube's autoplay fires a `play` event
  that re-arms it — but a hidden page is exactly where browsers block autoplay.
  Keeping the flag cannot replay the finished video (`resume()` refuses an ended
  element); it only arms the next one.
- **Never drop the foreground service on `hasMedia: false` alone.** Autoplay
  swaps the `<video>` element, so between two tracks the page honestly has none.
  Stopping there is not recoverable: the next raise has to *start* a foreground
  service from the background, which Android 12+ refuses, and the queue goes
  silent mid-playlist. Only `!hasMedia && !wanted` means stop.
- **Muted media never counts** — for the notification, for the wake lock, or for
  the play counter. The home feed autoplays muted previews that fire identical
  events.
- **No video id means no card.** A preview clip at the top of the feed is not
  something being watched, and raising for it put a card titled "YouTube" over
  whatever the user actually had on.
- **A play in flight is not reported.** A `<video>` reads back as unpaused the
  instant `play()` is called, long before the browser has decided to allow it.
  `doPlay` reports only when the promise settles.

### Dismissal

The bar's × holds the **id** of the dismissed video, not a boolean. `stop` is
`pause` on the page side — there is no verb that makes a watch page stop being
one — so a second later the page reports the same paused video and the bar would
come straight back. The dismissal lasts until that video plays again or another
takes its place; an empty id (reported between navigations) is neither.

---

## 11. Artwork and theming

**Where:** `core/artwork.ts`, `YtDlpModule.readArtwork`, `ui/theme.ts`,
`ui/ThemeContext.tsx`

The design's first rule is that the app is a frame around the art: the whole
palette derives from the dominant colour of whatever is **playing**, and returns
to the neutral ground when nothing is. A theme that followed the finger rather
than the sound would turn scrolling a library into a light show.

Resolution order, most honest first: the file's own embedded cover (the only
source that is true offline), then `maxresdefault` → `hq720` → `hqdefault`.
`hqdefault` is last because it is 4:3 with black bars padded *into* the image —
no `resizeMode` removes those, so the native side also trims letterbox rows
below luma 22.

Three layers of memory — an in-memory map, an in-flight map so eight rows
appearing at once produce one native call, and AsyncStorage. **Failure is
remembered too**, or an item with no artwork anywhere would be retried on every
render for the life of the app. At most 3 resolutions run at once, so a first
launch against a few hundred saved items does not open a few hundred connections
for rows nobody has scrolled to.

Covers are re-encoded rather than stored as they arrive: yt-dlp embeds the maxres
thumbnail at ~1.8 MB per item, which for a few hundred items would be half a
gigabyte of cache to fill a 320dp square. Decoded to a 640px short edge, written
back as quality-85 JPEG.

A page being watched is keyed `yt:<videoId>`, separately from download ids,
because the same video can be both a page and a saved file and the file's
embedded cover is the better of the two.

---

## 12. Pre-release / trial

**Where:** `TrialGuard.kt` (decides), `core/trial.ts` (describes),
`ui/TrialChip.tsx`, `sheets/PreReleaseSheet.tsx`

**The trial is enforced in Kotlin and described in TypeScript.** R8 obfuscates
the native side and the signature pin refuses a repackaged APK; neither touches
the JavaScript bundle, which ships as Hermes bytecode that decompiles. A patched
bundle gets a UI that lies and a native layer that still says no. The TypeScript
check exists only so a refusal can be worded before the user waits for an
extraction that was never going to be allowed.

Limits, all stamped into `BuildConfig` at build time: 7 days, 20 saves, 180
seconds per video. There is nothing on the device to clear or reinstall past.

- **Clock rollback is caught two ways**: before `BUILT_AT`, or behind the
  furthest-forward time ever seen — both with 26 hours of slack for time zones,
  DST and NTP.
- **The save counter is mirrored** into `externalMediaDirs`, which survives both
  "Clear storage" and an uninstall. Reads take the larger of the two stores. A
  tester who clears storage to reset the count loses their whole library doing it.
- **A slot is spent only once a file exists.** A save that failed halfway costs
  the tester nothing.
- The signature pin is skipped when empty, so debug builds do not refuse to run.

**None of it makes the build uncrackable, and the code says so.** Anything
running on the attacker's hardware can be patched. The goal is to move the cost
from "clear app data" to "decompile, patch, resign, defeat the pin".

The chip sits in the Home, Library and Profile headers and nowhere else — Search
has no header row to put it in, and Browse is someone else's page at full bleed.
(Comments in `TrialChip.tsx` and `core/trial.ts` say "four"; the code renders
three. The code is right.) It is mono, because days-left is a fact the
user can check, and mono is reserved for exactly those. It turns accent on the
last day: one state change, once. Tapping opens the sheet.

The sheet shows **once per cold launch**, not once ever — the build expires, and
a tester who never reads why reads "it stopped working" instead. On a fresh
install it is deferred to the *end* of first run, so the legal notice comes
before the sales pitch and a tester who installs, taps through and never
relaunches is still told this is a pre-release. The prices are stated the way
they are true: the launch price is labelled *expected*, not struck through, since
nobody has ever paid it.

---

## 13. First run and permissions

**Where:** `screens/FirstRunScreen.tsx`

One screen, once. It points at the download button plainly a single time, says
where files go, and carries the legal notice: downloading from YouTube violates
YouTube's Terms of Service; the app is built for your own uploads, Creative
Commons and public-domain material, and personal offline use where local law
allows it.

Two things on this screen are currently out of step with the rest of the app and
should be fixed rather than copied: the **"Choose folder"** button opens no
picker — it flashes a notice saying where files go, which is a control that
labels rather than does — and the destination it names is `Movies/Spool`, while
audio actually lands in `Music/Spool`. It is also the one screen still on the v1
token names (`t.text`, `t.border`, `t.accentSurface`) rather than the v2 palette.

Permissions are requested at the **end** of first run, and this ordering has
bitten twice:

- **Anything that needs a permission cannot run in the boot effect.** On a fresh
  install the boot effect runs before the user has agreed to anything, so
  `scanSaved` came back empty. Anything gated on first run must be **re-run when
  first run finishes**, not skipped there.
- Notifications: `POST_NOTIFICATIONS` on API 33+. Downloads still work without
  it; only the progress notification is lost.
- Storage splits three ways: `WRITE_EXTERNAL_STORAGE` on ≤28 (load-bearing —
  saving is plain file I/O there), `READ_EXTERNAL_STORAGE` on 29–32, and
  `READ_MEDIA_VIDEO` + `READ_MEDIA_AUDIO` on 33+. On 29+ a refusal costs nothing
  today and only shows up after a reinstall, when previously saved files can no
  longer be listed — so it is asked once, up front, and never nagged.

---

## 14. Privacy

- No account, no identifiers, no analytics, no crash reporting, no server.
- Outbound requests are YouTube's own (through the page and through yt-dlp,
  using the browser's session) and cover art from `i.ytimg.com` — **plus
  `lrclib.net`, and only ever from a tap.** See § Lyrics: it is off until the
  user has read what is sent and agreed, it never fires on a track starting, and
  it carries the track name, artist and length and nothing else.
- `core/plays.ts` is the only module that records behaviour rather than results,
  and it stores three numbers per video with no timeline. It must never make a
  network call.
- The cookie file is written to `cacheDir` and used only as `--cookies` for the
  local yt-dlp process.

---

## 15. Deliberately absent

Things that look missing and are not:

- **Casting** — nothing to cast to. Dropped from the player *and* Home, so the
  app does not claim a capability in one place and deny it in another.
- **A storage capacity meter** — needs a native `StatFs` call this build lacks.
- **Wi-Fi-only downloads** — needs a native connection probe this build lacks.
- **Pause/resume for downloads** — yt-dlp cannot resume a half-finished job.
- **Skip controls on the card for a browser page** — advancing a Mix means
  clicking a button on a page the app cannot talk to while backgrounded, so the
  control would be dead exactly when it was wanted.
- **Folders and iOS** — not built. `core/engine.ts` keeps platform-agnostic
  seams so an iOS backing implementation stays possible.

- **A home-screen widget and Android Auto** — not built, and deliberately not
  attempted blind. Both are the same want — transport without the screen — and
  the media card already answers most of it, which is why they rank below
  everything above.

  What a **widget** needs, so nobody has to work it out twice: `PlaybackService`
  keeps title, artist, artwork and playing state in `private var` instance
  fields, so the widget cannot see them. It needs a snapshot on the companion
  object, updated wherever the notification already is, plus an
  `AppWidgetProvider`, a `RemoteViews` layout, an `appwidget-provider` XML, and
  a `<receiver>` in the manifest. Transport is `PendingIntent`s onto the actions
  `PlaybackService` already handles. **The receiver is named only in the
  manifest, which is precisely the R8 trap that deleted the module once** — it
  needs its own keep rule in `app.json`, and that is only provable from a
  release build on a device.

  What **Android Auto** needs is bigger: `MediaBrowserServiceCompat` (already
  available through `androidx.media`, which is a dependency) and a browse tree.
  The hard part is not the service, it is that the library lives in AsyncStorage
  on the JS side and the browse tree is asked for by the system, often while no
  React tree exists. That means a snapshot of the library written somewhere
  native can read it — a real design decision about a second source of truth for
  what is on the device, and the one thing this app has been careful to keep
  single.

- **An equaliser** — *not reachable from here*, which is a different thing from
  not wanted. An `android.media.audiofx.Equalizer` has to be attached to an
  audio session id, and `expo-audio` does not expose the one its `ExoPlayer`
  uses: `audioSessionId` appears in its Kotlin exactly once, to build the
  `Visualizer`, and never crosses to JavaScript. Attaching to session 0 — the
  global output mix — is deprecated and blocked on modern Android. So a working
  equaliser means either replacing the playback engine or patching a dependency,
  and neither is a change to make without a device to prove it on. **Sliders
  that move and change nothing are the one thing this design refuses
  everywhere**, so until one of those routes is taken there is no equaliser.

- **Volume normalisation** — same answer, one step further along. It needs a
  loudness figure per track, which means measuring the file: ffmpeg *is*
  bundled, but `com.yausername.ffmpeg.FFmpeg` is there to install the binary for
  yt-dlp rather than to run filters, and building a measurement path on an API
  that has not been confirmed is how unverifiable native code ships. The plan if
  it is picked up: measure once at save time with `ebur128`, store the LUFS
  figure on the record, and apply the trim through `player.volume`, which *is*
  exposed.
- **A share chip and like counts on the player** — those are YouTube's.
