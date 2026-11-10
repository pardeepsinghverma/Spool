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

A `react-native-webview` supporting both **Standard YouTube** (`https://m.youtube.com`) and **YouTube Music** (`https://music.youtube.com`), presenting a plain Chrome
user agent — Android's stock WebView UA contains `; wv`, which Google rejects on
its sign-in flows.

### Dual-mode browser (YouTube + YT Music)

The Browse screen features a discreet, native header with a segmented mode switcher:
- **`[ YouTube | YT Music ]` Switcher:** Allows 1-tap switching between standard YouTube and YouTube Music. The active pill dynamically tracks the loaded URL (`isMusicUrl`) so it stays accurate whether the user navigated via button, in-page link, or redirect.
- **Back Navigation (`←`):** Appears conditionally whenever `canGoBack` is true, allowing effortless back navigation in web history without solely relying on Android hardware back gestures.
- **Reload (`↻`):** Direct refresh button to restart or recover stuck pages.
- **Progress Track:** A 2dp accent loading bar rendered immediately below the header while a page is loading (`loadProgress !== null`).

### YouTube Music specifics

- **Audio-first Instant Downloads:** On `music.youtube.com`, tapping the floating action button (FAB) automatically defaults to the best available audio format (Opus / M4A) according to the user's audio quality settings, bypassing video format selection.
- **Unified Sign-in & Cookies:** Both `m.youtube.com` and `music.youtube.com` share the `.youtube.com` cookie jar, so signing in once keeps the user's playlists, likes, and library active across both modes.
- **Cosmetic Promo Suppression:** YouTube Music's mobile upsell mealbars (`ytmusic-mealbar-promo-renderer`, "Try Music Premium", "Open in app" prompts) are hidden alongside regular YouTube ad components.
- **Metadata Extraction:** `BACKGROUND_SCRIPT` reads `ytmusic-player-bar` subtitles and track titles, correctly attributing music tracks, artists, and album tags.

- `thirdPartyCookiesEnabled`, `domStorageEnabled`, `mediaPlaybackRequiresUserAction={false}`,
  `allowsFullscreenVideo`, `setSupportMultipleWindows={false}`.
- Non-`http(s)` navigation is refused outright by `onShouldStartLoadWithRequest`.

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

**Four download paths, five ways in** — `instantDownload` and the format sheet
both land in `beginDownload`. They are separate on purpose. See
[FLOWS § 4–7](FLOWS.md).

| Path | Trigger | Quality from | Publishes to gallery | Marks the video "taken" |
|---|---|---|---|---|
| `beginDownload` | FAB tap or sheet pick | The user's pick | Yes | No |
| `autoSaveStat` | The replay rule | Profile defaults | **No** — stays app-private | Yes |
| `saveFromCard` | The notification's save button | Profile defaults | Yes | No |
| `retry` | A failed Library row | The failed row's own kind + defaults | Yes | No |

### The FAB

`BrowserScreen` renders it only on Browse. Five reachable states, each with its
own glyph because v2 has no chrome to put words in:

| State | Glyph | Meaning |
|---|---|---|
| `idle` | download (line colour, inert) | Not a watch page |
| `ready` | download (filled, tinted) | A video is on screen |
| `resolving` | hourglass | Reading formats |
| `done` | check (saved green) | Tap opens Library |
| `failed` | refresh (warn) | Tap retries |

**There is a sixth state in the type and it is unreachable.** `DownloadState`
still carries `working`, but `setDl` is never called with it — the button is
handed back the moment a job joins the list, so `fabState` can never resolve to
it. The ring (`FabRing`), the press guard, the hold guard and the reset guard
that test for it are all dead code, and "tap cancels" was never true after N8.
Progress belongs to the Library row and the ongoing notification. Do not restore
the `working` state without re-reading [UI.md § The download rule](UI.md#the-download-rule):
holding the FAB for the length of a download is the behaviour that was removed.

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
  out of the player response, plus `visitorData` from `ytcfg`.

- **A token belongs to one video, and is stored that way.** yt-dlp's PO Token
  Guide is explicit: *"Most PO Tokens (such as for `web` GVS/Player) are bound to
  the video ID, so a new token is required for each video."* The app used to hold
  a single token — whichever the page last minted — and spend it on every
  download, so a token harvested while watching A and used on B was not a weaker
  token but the wrong one, and the media fetch 403'd. That failure is
  indistinguishable from a refused client, which is why it hid for so long.

  **The harvester was blind, and as of 2026-08-23 it is not.** The first version
  hooked `JSON.parse`, `fetch` and `XMLHttpRequest.open`, and across 25 seconds
  of measured playback it saw **zero** media URLs — it had not even reached the
  point of looking for a token. Three independent reasons, each sufficient on
  its own:

  - the watch page's first player response is inlined as
    `var ytInitialPlayerResponse = {…}` and evaluated by the JavaScript parser,
    so nothing calls `JSON.parse` on it;
  - `Response.json()` parses natively in C++ and never calls `JSON.parse`, so
    every SPA navigation's `/youtubei/v1/player` fetch was missed too;
  - hooking `XMLHttpRequest.open` sees the request and never the response, which
    is the half a player response arrives in.

  The rule the file follows now is **harvest where the data lands, not where you
  imagine it passes**: a property trap on `ytInitialPlayerResponse`, a hook on
  `Response.prototype.json`, an XHR `load` reader, the original `JSON.parse`, a
  scan of request bodies for a `poToken` field, and the media-URL hooks. `saw`
  reports which of them fired, and exists because "no token" had two
  indistinguishable causes for a day.

  **What the working harvester found is that this session has no token to give.**
  Measured on 2026-08-23 across four videos: the hooks fire (`saw` reaches
  `req,parse,sd,sabr,url`), `streamingData` is reached, media URLs are seen —
  and the streaming data is **SABR-only**, its `serverAbrStreamingUrl` carries no
  `pot`, and no InnerTube request body contains a `poToken` field. YouTube is
  not challenging this session, so the page never mints one; consistent with
  every download in the same pass succeeding on a tokenless client.

  That is an answer rather than a failure, and it changes what is left to do. A
  session that *is* challenged puts `pot` on the media URLs, and those hooks now
  demonstrably fire. What remains genuinely out of reach is the SABR case, where
  the token travels in a protobuf request body — see § the harvest's remaining
  blind spot.

  `core/tokens.ts` keys them by video id with a 6-hour TTL, and every report
  from the page names the video it belongs to — taken from the player response's
  own `videoDetails.videoId`, never from `location.href`, because YouTube
  prefetches the *next* watch page while the current one is still on screen.
  **Absent beats wrong**: with no token yt-dlp walks the open clients and may
  still succeed; with the wrong one it pins itself to a web client and fails.

- **The harvest's remaining blind spot is SABR, and it is a parsing problem
  rather than a vantage one.** Under SABR the page issues one adaptive media
  request whose body is protobuf, and the token is a field inside it. No hook
  placed in page context can read that without decoding the message, and
  `WebViewClient.shouldInterceptRequest` on the native side would see the same
  bytes and have the same problem — so the native rewrite that looked like the
  answer while the harvester was blind is not one. If this ever becomes the
  blocking issue, the work is a minimal protobuf field reader, not a change of
  vantage point.

- **A token must never make the app worse than having none.** Holding one
  narrows the walk to the two clients that could have minted it, so a token that
  is expired, bound to another video or simply the wrong context would leave two
  chances where a tokenless request had five. `attempts()` therefore appends the
  whole open chain, token dropped, after the token chain is exhausted — the walk
  ends where it would have started had nothing been harvested.

- **The token names its own client.** `po_token` is supplied as
  `CLIENT.CONTEXT+TOKEN` and a token labelled for a client we are not asking as
  is ignored. `gvs` is the context — the Google Video Server media fetch is the
  request that 403s. The client used to be hardcoded to `web` in Kotlin, which
  was wrong twice: our page is `m.youtube.com`, so the token is an `mweb` one,
  and `web` is SABR-only. `TOKEN_CHAIN` now walks `mweb → web` so the pairing is
  measured rather than asserted.
- **Client chain.** Without a token the only lever is which InnerTube client to
  impersonate. The order is not a hunch — it follows yt-dlp's published
  requirement table:

  | Client | GVS token | Player token |
  |---|---|---|
  | `tv` | none | none |
  | `web_embedded` | none | none (embeddable only) |
  | `mweb` | required | none |
  | `web` | required | none, and SABR-only |
  | `android` / `ios` | required | required |
  | `android_vr` | **required since 2026** | none |

  `OPEN_CHAIN = ['tv', null, 'web_embedded', 'mweb', 'android_vr']`. `tv` leads
  because it needs nothing at all, and the DRM-only formats it is otherwise
  known for are exactly what the cookie handoff prevents — being a real browser
  makes it a good first choice for us and a bad one for a standalone
  downloader. `null` is yt-dlp's own default, second because it is maintained
  weekly by people watching this change.

  **`android_vr` is now last, having been first.** yt-dlp issue #17348: it
  requires a GVS token for everything except **format 18**, so without one it
  answers with a single muxed 360p and nothing else. That is precisely the
  degraded manifest that made downloads look broken for weeks. It stays on the
  list only because one muxed 360p beats nothing, and `judgeManifest` settles
  for it only after everything else has failed.

  The last worked client is remembered and tried first next time — **separately
  for the tokened and tokenless walks**, since a client pinned while tokenless
  means something different, or nothing, on a request carrying a token.
  **Retune these lists in TypeScript, not Kotlin.**

- **The chain reorders itself, and remembers across launches.** `core/clients.ts`
  keeps a score per `(mode, client)` in AsyncStorage, moved by
  `next = 0.75 × score + (won ? 1 : −1)` and bounded at ±4. Without it every
  cold start re-paid the whole walk: measured over six downloads, `tv` leads the
  open chain and was refused 3/3 on that device with `The page needs to be
  reloaded`, costing seconds off the front of the first download of every
  session for a client already proved wrong there. Verified after the fix — a
  fresh launch went straight to the winning client with no refusal at all.

  Three properties keep it safe. It **never removes a client**, only reorders,
  so a board that has learned something wrong costs time and can never be the
  reason a download fails. A difference under 0.5 does not reorder anything, so
  one unlucky request cannot outvote the requirement table above. And it is
  **wiped when the engine replaces its own extractor**, because the scores
  describe how the old extractor got on with YouTube and after an update neither
  side is the one that was measured.

  A degraded manifest scores as a loss — from the user's side a client returning
  one muxed 360p and a client returning 403 are the same event. A cancel or a
  dropped connection scores *nothing*: no client deserves blame for the user
  leaving a tunnel.
- **Downloads resume, because they are named for what they are.** The output
  used to be named for the job id, which is minted per attempt — so yt-dlp, whose
  `--continue` is on by default, never had a partial to continue into. A 141 MB
  save interrupted at 90% began again at 0%, every time, on precisely the
  connection that had already proved it would interrupt one, and each abandoned
  `.part` sat in app-private storage until the 24-hour sweep. `partialKey` now
  names it `{videoId}.{a|vHEIGHT}`: stable across retries of the same video at
  the same quality and distinct across everything else, since a `.part` belongs
  to one format and resuming a 720p body into a 1080p file would corrupt it.
  Measured end-to-end — a download cut at 1,622,016 bytes resumed from exactly
  1,622,016 rather than from zero.

  The name being shared means "a file with this name exists" is no longer proof
  that *this* attempt wrote one, which is why `finished()` prefers a file
  modified since the attempt began. Falling back to an older one is still right:
  that is the "already downloaded" case, and a complete file of exactly the video
  and quality asked for is the correct answer whoever wrote it.

- **A decoration must never fail the thing it decorates.** Measured on a
  31-minute save: the audio downloaded fully, converted to a 73 MB m4a, had its
  source deleted — and the job then failed with `Postprocessing: Conversion
  failed!` because the *cover art* would not embed. The file was complete and
  correct on disk and the user was told the download did not finish. (The proof
  is in the sizes: the clean re-run's m4a is 438 KB larger, which is the cover
  the failed one never got.) `finished()` is now consulted on the failure path
  too, and a complete file is kept with the engine's complaint carried across as
  `salvagedFrom` so the log can say why a success has an error beside it.

  Three exclusions make that safe rather than merely forgiving: `.part` and
  `.ytdl` are a download in progress, images are `--embed-thumbnail`'s leftovers,
  and `.fNNN.` intermediates are the two halves of a merge yt-dlp never
  completed — without that last one a video whose merge failed would be
  published as a silent film. A cancel is excluded outright. Verified in the
  dangerous direction: a download killed mid-transfer still fails, publishes
  nothing, and adds no library row.

- **Listing and downloading must agree on one client** — a format id from one
  client's manifest 403s when fetched as another.
- **`looksBlocked` is grown from logs, never from guesses.** It decides whether
  a failure is worth another client, and every phrase in it was put there by a
  measured failure: `format is not available`, and — found on a release build
  minutes after the flight recorder went in — `The page needs to be reloaded`,
  which stopped a walk on the second client of five with three untried. `nsig`
  went in beside it. Being wrong in this direction costs one extra round of the
  chain; being wrong in the other costs a video that never downloads.

- **A client is judged on its answer, not only on whether it threw.** A refusal
  does not always arrive as an error: a client can return, successfully, a
  manifest holding one muxed 360p and nothing else. `judgeManifest` calls that
  degraded — no formats at all, or no audio-only rung, which every healthy
  YouTube manifest has — and the walk carries on rather than pinning it.

  Measured on the phone, against the chain as it then stood: `android_vr`
  answered thinly, nothing threw, it was pinned for the whole session, and every
  client behind it went unasked. Everything downstream then behaved correctly on a manifest
  that was wrong, and the replay rule found no audio stream and gave up without
  a word.

  A degraded answer is **kept, not discarded**: if the whole chain does no
  better, the best one seen is returned. That is what makes it safe to judge
  harshly — being wrong costs a slower walk, never a failed download.
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
- **Every selector ends in a term that cannot name nothing.** Each id is
  followed by a description of the same stream, and the chain ends at `best`.
  An id only means something inside the manifest it came from, and `bestaudio`
  itself is absent from a degraded manifest — so without a total tail, yt-dlp
  answers `Requested format is not available` and the download fails on a video
  whose audio was sitting inside a muxed rung.
- **A muxed stream counts as audio when nothing else is on offer.** `bestAudio`
  falls back to the smallest muxed format rather than returning `undefined`;
  `-x` extracts the audio track from it exactly as it would from a separate
  stream. Before this, a degraded manifest meant an audio save was impossible by
  construction, and the replay rule's response was to return silently.
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
sentence, and always records the raw message **and the native error code** into
the flight recorder (§16). The code is the better discriminator: `E_NO_OUTPUT`,
`E_TRIAL_TOO_LONG` and `E_DOWNLOAD` are three very different failures that can
reach the same sentence.

**When a failure makes no sense, read the log before believing the copy** —
several real failures (`ENAMETOOLONG`, a dropped connection, and
`Requested format is not available`) fell through to a generic "check free space
and connection" on a phone with 26 GB free. That last one is now its own branch,
because it is about the *manifest* and has nothing to do with either the disk or
the connection the fallback names.

The `stage` argument matters: telling someone whose disk is full to update their
extractor sends them to the one screen that cannot help.

**No download path may fail silently.** Every one of the four ends in either a
saved row or a failed row that names a reason. The replay rule used to `return`
when it found no usable format — no file, no row, no notice and no log line, on
a rule whose whole contract is "this will be kept after N plays". It now throws
a stated error like the others and records the failure.

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

  A retry the **trial** refuses keeps the trial's own sentence on the row and
  opens the subscribe sheet, as the FAB does — a person has just tapped and is
  waiting. It used to throw a plain error that `readableError` rendered as
  "check free space and connection", so the button looked like it did nothing.

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

The local index answers instantly, on **title and artist** — a music library that
cannot be searched by artist reads as a broken search rather than a title-only
one. **Every word must appear, in any order, in either field**; the query is not
one substring. "jana gana mana anthem" used to find nothing over "Jana Gana Mana
- National Anthem" because the phrase was not contiguous there. **The cloud is a button
and never an automatic second query** — nothing here may fire a network request
on a keystroke, and the screen says so in a footnote.

Tapping "Search YouTube for …" hands the query to the page (`injectJavaScript`
setting `location.href`) and switches to Browse. It is never a second search of
ours. Recent searches are capped at 8.

---

## 7. Profile

**Where:** `screens/ProfileScreen.tsx`, `sheets/ChoiceSheet.tsx`

- Identity: the account's email and "Spool account · signed in", or "This
  device — No account · nothing leaves the phone" when signed out.
- **Account** (or **Sign in**) opens the account sheet: sign in / create,
  forgot-password over WhatsApp, the device list, sign out. **Subscription**
  opens the paywall; subscribed it reads the days left to `paidThrough` (or
  "Active" when that date is not known yet), never the token's lease. See § 17.
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
- **Sign out of YouTube** — "Library stays". Confirms first, then drops every
  cookie, the WebView's DOM storage, and any cookie jar on disk, and remounts
  the browser on a signed-out home feed with a "Signed out on this device"
  notice.

  Until this landed there was **no way out of a signed-in session**. The WebView
  keeps one across restarts by design — that is the pair that makes the app open
  on the user's own feed — and the only exit was Android's "Clear storage",
  which also deletes every automatic save the user has. So in practice a phone
  that had been signed in stayed signed in, including a lost or handed-on one.

  Always shown, never conditional on a session existing: reading that would mean
  a native call, and a row you can only find once you are signed in is a row you
  cannot find when you want it.

  **It does not sign the user out at Google**, and the dialog says so. That
  session is Google's and only Google can end it, from the account's device
  list. What this removes is the device's copy, which is the half the app is
  responsible for — a control labelled "sign out" that leaves a session standing
  somewhere is a lie the user cannot check.
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
render for the life of the app — **but for a day, not forever**, and a cover
whose cached file Android has since deleted is dropped at launch and rebuilt.
Both used to be permanent, and between them they left most of a real library
drawn blank over files with covers embedded (see
[DATA.md § dl.artwork](DATA.md)). At most 3 resolutions run at once, so a first
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
- **The save counter is mirrored** into `externalMediaDirs`, and reads take the
  larger of the two stores. **The mirror no longer outlives either "Clear
  storage" or an uninstall** — measured on Android 15, `pm clear` empties
  `/sdcard/Android/media/<pkg>/` and an uninstall deletes it, because Android 11
  brought that directory under the same cleanup as `Android/data`. So the count
  *is* resettable by reinstalling. The expiry is not: it is stamped into
  `BuildConfig` and there is nothing on the device to clear.
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
install it is **not** raised at all unless the tester taps *See the offer*: first
run's own Premium step already says the build is a pre-release that expires, and
two pitches ten seconds apart is the same person sold to twice (see § 13).
Verified on a fresh install on the S21 FE, 2026-09-19. The prices are stated the way
they are true: the launch price is labelled *expected*, not struck through, since
nobody has ever paid it.

---

## 13. First run and permissions

**Where:** `screens/OnboardingScreen.tsx`

Three steps, once: **Welcome → What it does → Premium → Browse.** Button-driven,
not swipeable. The legal notice is on the first step, above the button that
accepts it — downloading from YouTube violates YouTube's Terms of Service; the
app is built for your own uploads, Creative Commons and public-domain material,
and personal offline use where local law allows it. The layout rules and the
argument for each are in [UI.md](UI.md#first-run--three-screens-once).

The premium step is absent for a subscriber, and it is the **only** sales
surface on this path: the sheet that used to be raised the instant first run
ended is now raised only from `See the offer`, because two pitches ten seconds
apart is the same person sold to twice.

This replaced a single `FirstRunScreen`, which carried three defects this entry
used to list as "should be fixed rather than copied". All three are gone with
it: a **"Choose folder"** button that opened no picker and whose only effect was
a notice the screen could not render; a destination named as `Movies/Spool` when
audio lands in `Music/Spool`; and the v1 colour aliases (`t.text`, `t.border`,
`t.accentSurface`) rather than the v2 palette. Worth knowing that the last one
was re-introduced once, by copying the old screen as a starting point — a
deprecated alias spreads by being adjacent to the work, not by being chosen.

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

- No analytics, no crash reporting. **An account is optional** and nothing asks
  for one until the user wants to pay.
- **One server, and only accounts and subscriptions touch it.** Signed out and
  never subscribed, the app never contacts it: `syncLicence` returns before the
  fetch without a session, and a debug build configures no server at all.
- **Signed in, the server knows** the account's email, each device's
  `ANDROID_ID` hash and a human label for it ("Samsung SM-A515F"), the city it
  derives from the request, and — for the one-device-at-a-time play lock — *when*
  this device starts and stops playing. Never *what*: no titles, no library, no
  play history, no search.
- **Paying sends a screenshot of a UPI receipt** and the text read from it on the
  device. That names the payer and their UPI ID, and the server keeps it,
  because a payment that has to be checked by a person has to be checkable. The
  pay step says so on screen. See § 17.
- Outbound requests are YouTube's own (through the page and through yt-dlp,
  using the browser's session) and cover art from `i.ytimg.com` — **plus
  `lrclib.net`, and only ever from a tap**, and the licence server above. See § Lyrics: it is off until the
  user has read what is sent and agreed, it never fires on a track starting, and
  it carries the track name, artist and length and nothing else.
- `core/plays.ts` is the only module that records behaviour rather than results,
  and it stores three numbers per video with no timeline. It must never make a
  network call.
### The YouTube session

Signing in is optional and nothing asks for it, but the app is a browser, so it
can happen — and once it has, the device holds a credential. Four things follow
from that, and all four are the app's responsibility rather than Google's.

- **The cookie jar handed to yt-dlp is ephemeral.** One per extraction and per
  download, under `noBackupFilesDir/session/`, owner-only, deleted in the
  caller's `finally`. It used to be one fixed `cacheDir/youtube-cookies.txt`
  that nothing ever deleted, so a device that had ever been signed in carried a
  plaintext copy of the login for the life of the install. It is **not**
  encrypted, deliberately: yt-dlp needs a real path to a readable file, so
  encrypting at rest only means decrypting to a second plaintext file at the
  moment of use. Time is the lever, not ciphertext. See
  [NATIVE.md § 8](NATIVE.md#8-cookiejarkt).
- **The session is excluded from backup.** `app_webview/` — where the WebView
  keeps the session — is excluded from both Android cloud backup and
  device-to-device transfer, so the login cannot leave the phone it was granted
  on. See [DATA.md § 7](DATA.md#7-the-survival-matrix).
- **The sign-in page cannot be screenshotted or screen-recorded.** FLAG_SECURE
  is raised while the page is on a Google sign-in host (`isSignInPage`) and
  cleared everywhere else, including on unmount. It is per-window, so leaving it
  on would quietly stop the user screenshotting their own library.
- **There is a way out**, which there was not before. See § 7.

The app never sends the session anywhere but YouTube. It is read by
`CookieManager`, written to a local file, and passed to a local process.

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

- **Volume normalisation** — not built, but the route is known and the dead end
  has been ruled out rather than guessed at. It needs a loudness figure per
  track, which means measuring the file.

  `com.yausername.ffmpeg.FFmpeg` **cannot run it** — read out of
  `ffmpeg-0.18.1.aar`, the class has exactly two public members, `init(Context)`
  and `getInstance()`. It is an installer, not a wrapper: it unpacks
  `libffmpeg.so` and `libffprobe.so` (per ABI, plus a `libffmpeg.zip.so`
  payload) into a private `binDir` for yt-dlp to invoke. So there is no API to
  call, and anything built on the assumption that there is would not compile.

  What *would* work is what yt-dlp itself does — run the unpacked binary as a
  subprocess: `ffmpeg -i <file> -af ebur128 -f null -` and parse the `I:` line
  for LUFS. Measure once at save time, store the figure on the record, apply the
  trim through `player.volume`, which **is** exposed. That is a real piece of
  work against a private path of somebody else's library, and it needs a device
  to prove on, which is why it is here rather than in the code.
- **A share chip and like counts on the player** — those are YouTube's.

---

## 16. Diagnostics — the flight recorder

**Where:** `core/log.ts` (the recorder), `core/crash.ts` (the captures),
`core/bootstrap.ts` (installed first), `ui/ErrorBoundary.tsx`, and one row on
Profile.

Every failure this app has been debugged through was diagnosed from `logcat`
with a cable attached. That is the wrong instrument for the failures that
actually matter here — a download that dies in a pocket, a page that stops
playing with the screen off, a crash that takes the process with it. By the time
anyone asks "why", logcat has rotated and the evidence is gone.

So the app keeps its own record.

### What it records

- **Flows.** A `flow()` opens a correlation id and every entry under it carries
  ms-since-open. This is the half that answers *how* rather than *what*: a
  download crosses four files, two languages and a foreground service, and the
  interesting failures are all orderings. Flat lines cannot show that when two
  downloads overlap; a shared id can. Five scopes carry a `flow()` id —
  `extract`, `download`, `replay`, `card`, `retry` — and the rest are plain entry
  scopes: `save`, `engine`, `crash`, `boot`, `token`, `ui`, `diag`. `scope` is a
  free `string`, not a union type, so nothing catches a new one that never
  reaches this list.
- **The manifest, every time.** `shape()` records total / audio-only / muxed /
  video-only counts and the heights on offer. One line, and it is the line that
  makes a degraded manifest obvious instead of a mystery.
- **The native error code**, not just the message — see §2 Errors.
- **Everything already on `console`.** The bridge in `crash.ts` folds the app's
  existing `[spool] …` lines into the same record, so nothing had to be rewritten
  to be captured.
- **Crashes.** The global error handler, unhandled promise rejections, and a
  render fault caught by `ErrorBoundary` (which also keeps the component stack —
  it names the screen, which a bundle-offset JS stack does not).

### Rules that are load-bearing

- **It never throws.** Every entry point is total, including against a circular
  object, a getter that throws, and a storage layer refusing writes. A logger
  that can fail turns a recoverable bug into a crash, on the exact path that was
  already going wrong.
- **It never records a credential.** `redact` matches on the *key* — a token has
  no shape worth matching, and this file ends up in `Downloads/`. The presence
  is the diagnostic, so `poToken: "<redacted 214>"` still answers both "was
  there one" and "was it plausible".
- **The previous run is moved aside at boot, before this one writes.** This is
  the whole reason for persisting at all: a crash ends the process without
  warning, and if the next launch wrote into the same key, the boot sequence of
  the run trying to explain the crash would overwrite it.
- **Errors flush immediately; everything else is debounced.** An error is the
  one entry that might be followed by the process dying.
- **`debug` is dropped unless asked for.** It is the level that fires per
  progress tick, and letting it in evicts the entries explaining the failure
  with entries describing the thing working.

### Getting it out

**Profile → Export diagnostics** writes `spool-log-<timestamp>.txt` into
`Downloads/Spool`, previous run first. It leaves as a file the user can read
before they decide to share it, never as a report sent anywhere. The licence
server (§ 17) is not a destination for this and has no route that would accept
it — nothing in `core/log.ts` or `core/export.ts` can reach it. The row states the entry and error count before it writes.

There is no reporting, no upload, and no identifier of any kind in the file
beyond what the user was doing. §14 still holds.

---

## 17. Subscriptions

**Where:** `LicenseGuard.kt` (decides), `core/license.ts` (describes),
`core/account.ts` (the account and the one request helper), `core/payments.ts`
(UPI orders and screenshot claims), `core/playLock.ts` (one device playing at a
time), `sheets/SubscribeSheet.tsx`, `sheets/AccountSheet.tsx`,
`sheets/PlayLockSheet.tsx`, the licence server (issues — not in this repo),
Profile's Account and Subscription rows

₹29 a month or ₹249 a year, **paid by UPI to the owner and proved with a
screenshot**, on a sideloaded APK. There is no payment gateway — Razorpay was
removed entirely. Google Play Billing does not apply because the app is not
distributed through Play; if that ever changes, this whole feature has to
change with it.

**Same split as the trial, for the same reason.** `LicenseGuard` decides;
`core/license.ts` only describes and fetches. A patched bundle can make the
paywall vanish from the screen and still not get a download.

### Accounts

Email and password (`/v1/auth/register`, `/v1/auth/login`). A subscription
belongs to the account, and the account works on any number of devices: each
signed-in device asks `/v1/licence` with its own device hash and gets its own
device-bound token. **Signed out, the app never asks for a licence at all** —
the server would answer `entitled: false`, and a request whose answer is known
only tells the server the app was opened.

- The session is opaque, persisted as `dl.account`, sent as a Bearer header,
  never logged.
- `401 {"error":"signed out"}` or `403 {"error":"blocked"}` from any
  authenticated route drops the session and forgets the licence (`request()` in
  `core/account.ts`, the only place this is written). Blocked also opens the
  account sheet on an explanation with a WhatsApp link to support. Anything
  else that goes wrong — a throw, a timeout, a 5xx, an unparseable body, a 401
  that is not exactly that answer — is no news.
- Signing out on the device signs out locally first and tells the server
  best-effort, and **takes the licence with it**: it was minted because that
  account paid.
- **Forgot password** is a prefilled WhatsApp message to support. There is no
  reset form, because the server has no mail sender and a form that sent
  nothing would be a control that lies. The number is `SUPPORT_WHATSAPP` in
  `core/payments.ts`, replaced by the server's own once `/v1/pay/start` or
  `/v1/pay/claim` has answered.
- The device list (`/v1/account`) is shown in the account sheet: label, city,
  last seen, and which one is this phone.

### Paying

1. **Choose a plan.** Signed out, the sheet asks for an account first and comes
   back to itself afterwards (`openAccount({ next: 'paywall' })`).
2. **`/v1/pay/start`** returns an order code, the amount, the payee's UPI ID and
   a `upi://pay` link. The sheet shows a **"Pay ₹N with a UPI app"** button
   (`Linking.openURL(upiUrl)`), a QR of the same link for paying from another
   phone, and the UPI ID, order code and amount as selectable text. The order is
   persisted (`dl.pendingOrder`) until it expires or is approved, because paying
   means leaving for a UPI app and Android may kill Spool meanwhile.
3. **Upload the screenshot.** Picked with `expo-image-picker` from the gallery
   (the Android photo picker; the config plugin blocks the CAMERA and
   RECORD_AUDIO permissions the library would otherwise add). The original is
   OCR'd on the device by `YtDlp.recognizeText` — ML Kit's bundled Latin model —
   and a copy is re-encoded by `YtDlp.shrinkImage` to a JPEG with a 1600 px long
   edge, because the picker's `quality` leaves a PNG screenshot a PNG. Both go
   to **`/v1/pay/claim`** as multipart: `order`, `text`, `image`. An OCR
   failure still uploads, with empty text; the server routes that to a person.
4. **`approved`** — the paid-through date is recorded and the licence synced
   *before* the sheet says so. **`review` / `rejected`** — the server's reasons
   are listed verbatim, with a "Send screenshot on WhatsApp" button that opens
   the server's prefilled message (it carries the order code) and copy telling
   the user to attach the screenshot there, since it cannot be attached for
   them. "Try another screenshot" goes back to the upload step on the same order.

"I have already paid" is always there before an answer: it forces a licence
sync, which is how a claim approved by hand reaches the phone.

A subscriber who opens the sheet sees the paid-through date and **"Pay for
another period"** — which has to exist now that nothing renews on its own.

### One device playing at a time

`core/playLock.ts`. Signed in, the local player claims a lease
(`/v1/play/claim`, 120 s) before it makes a sound, renews it every 60 s while
playing, and releases it on pause and stop. Spotify's model, deliberately:

- A start that meets `409 playing elsewhere` raises "Playing on *device*. Play
  here instead?"; accepting claims with `takeover: true`, which ends the other
  device's lease.
- A heartbeat that meets 409 means someone took over: pause, and "Playback moved
  to *device*", with the same offer to take it back.
- **The network is not a reason to stop.** A claim that cannot reach the server
  is allowed while the last successful server contact (`dl.serverContact`) is
  under 24 h old (`OFFLINE_GRACE_MS`); past that, "Connect to the internet to
  keep playing on this account". A failed heartbeat never pauses a track that is
  already playing — only a *next* start is refused.
- **The fast path is synchronous.** A device that holds a live lease — or is
  signed out, which is most of them — starts sound exactly as fast as before.
  Only a start without a lease waits on the network, capped at 5 s. Because the
  lease is released on pause, **a resume after a pause does wait** for one
  round trip; that is the price of releasing promptly.
- Background timers are not trusted: nothing counts heartbeats, and a missed
  one only means the next re-claims without takeover. The heartbeat runs while
  anything is loaded, playing or not, so a pause from a path that never said so
  (notification, sleep timer, another app taking focus) still releases within a
  minute.

Signed out, none of this runs. The browser's page playback is not covered — the
lock is the local player's.

### What a licence is

A token the server signs and the phone verifies **offline**:

```
base64url(payloadJson) "." base64url(derSignature)
{ v, dev, sub, plan, exp, iat }
```

Offline is the normal case, not the fallback — Spool plays a local library with
the screen off and no network, so `LicenseGuard` never touches the internet. It
reads what is already on disk. The app fetches a token when it happens to be
online — at boot and whenever the app returns to the foreground
(`watchLicence`), no more often than the server's `refreshAfter` (floored at
five minutes) or six hours; nothing about entitlement waits on that.

- **`dev` binds the token to the install** — SHA-256 of `ANDROID_ID`. Copying the
  preferences file to another phone carries nothing.
- **`exp` is a lease of at most about three days**, renewed on every
  authenticated sync. It used to be `paid_through + 3 days`; it was shortened so
  that a device signed out or blocked on the server stops being entitled within
  days. The subscription's end is `paidThrough`, sent alongside the token and
  persisted as `dl.licence` so it displays offline — **anything that says "days
  left" reads that, never the token.** A device offline longer than the lease
  loses *downloads* until it syncs; never its library or playback.
- **The signature covers the ASCII of the first segment**, not the JSON it
  decodes to, so the two implementations never have to agree about key order or
  number formatting. `LicenseGuard.verify` checks before it parses.
- **ECDSA P-256, not Ed25519** — `Signature.getInstance("Ed25519")` needs API 33
  and minSdk here is 24.

### Where it is enforced

`YtDlpModule.download` asks `LicenseGuard.entitled` **before** `TrialGuard.refuse`,
and skips the trial entirely when it answers yes. A subscriber is not a tester on
raised limits — they are in a different state, with no expiry, no quota and no
length cap — so asking about the trial at all would leave four ways for a stale
trial fact to refuse someone who has paid. `refuseSave` in TypeScript makes the
identical call for the identical reason.

`spendTrialSlot()` is the other half of that: a subscriber's saves must not draw
down the trial counter, which outlives an uninstall. A year of paid downloads
would silently exhaust it, and the day the subscription lapsed the user would
meet a trial already spent by their own paid usage.

**A repackaged APK gets no licence.** `LicenseGuard.expiresAt` returns 0 outright
when `TrialGuard.intact` fails. Without that the signature pin had a hole shaped
like a paying customer: subscribe once legitimately, then decompile, patch and
resign — the token still verifies, because it is signed by the server and says
nothing about which APK holds it, and the trial's pin was being skipped for being
entitled.

### The offer, and how it is worded

`₹249 a year` and `₹29 a month`, with the annual note stating the derived
`₹20.75 a month`. Arithmetic on a real price may be printed. A struck-through
number nobody has been charged may not — the same rule that governs the
pre-release sheet's copy, and it is pinned by a test. **Nothing renews on its
own**, and the notes say so (`Pay each month by UPI. Nothing renews on its
own.`); a test forbids "cancel", "autopay" and "mandate" from creeping back.

### Being offline never revokes a subscription

The property most of `tests/license.test.mjs` exists to defend. Every route by
which "we could not ask the server" becomes "you have not paid" is a paying
customer locked out of music they already own, on a train, with no way to fix it.
So:

- a fetch that throws changes nothing;
- a 500 changes nothing;
- **a definite `entitled: false` changes nothing either** — clock skew, a
  payment still under review and a half-finished migration all produce that
  answer and all resolve themselves, while deleting a valid licence does not;
- a token the native side refuses changes nothing.

Only `rememberLicence` returning true moves anything, and it verifies first.
The single exception is a session the server has *definitely* ended (the exact
401/403 bodies above), which drops the licence with the session.

### What the server is for, and what it is not

A plain PHP + MySQL application, **not in this repository** — on the
development machine it is at `c:\laragon\www\spool`, and `server/` here keeps
only a reference implementation of the token format and the test that pins it.
It signs licences, holds accounts, issues UPI orders, parses the OCR'd text of
payment screenshots, and arbitrates the play lock. Its schema is its own
README's business, not this book's.

§14 is amended: signed in, the server knows the account's email, each device's
hash and human label (e.g. "Samsung SM-A515F") and approximate city, and *when*
a device starts and stops playing — never what. A payment sends a screenshot of
a UPI receipt, which names the payer, and the OCR'd text of it; the pay step
says so on screen.
