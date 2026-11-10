# Spool — data

Every piece of state the app holds: where it lives, what shape it has, what
caps and evicts it, and what survives what.

[ARCHITECTURE.md § 4](ARCHITECTURE.md#4-where-state-lives) is the summary of
this — one table, enough to orient. This is the reference: the exact TypeScript
written under each key, the read path's behaviour against a blob it does not
recognise, the eviction order, and the survival matrix that says which of it is
still there after a reinstall.

Everything here was read out of the source. Where the source does not settle a
question — several of the OS-behaviour cells in the matrix are like this — it
says **not determined** rather than guessing.

Three things to hold on to before reading anything else:

- **App data dies with an uninstall; MediaStore records do not.** That asymmetry
  is the whole reason [`adoptSaved`](#3-adoptsaved--the-one-function-that-can-resurrect-a-deleted-row)
  exists, and it is the axis the survival matrix is organised around.
- **Every loader swallows its own error and returns something usable.** There is
  no store in this app whose corruption can stop the app starting. What differs
  between them is *how much* of a damaged blob survives, and that varies more
  than it looks — see [§ 10 Migrations](#10-migrations--what-happens-to-a-blob-that-predates-a-shape-change).
- **Only manual saves leave the sandbox.** Automatic saves stay app-private on
  purpose, because hundreds of files the user never chose do not belong in their
  gallery. See [FEATURES § 4](FEATURES.md#4-library).

---

## 1. The stores, at a glance

| Where | What | Lifetime |
|---|---|---|
| **AsyncStorage** (18 keys) | The library index, settings, playlists, plays, caches, the flight recorder, the client scoreboard, the Spool account session and subscription facts | App data |
| **Module singletons** (JS) | The notification arbiter, page playback, artwork index, PO tokens, the pinned client, the log ring | The process |
| **React state** in `BrowserScreen` / `PlayerContext` | The screen, the WebView's position, in-flight jobs, the queue | The mount |
| **`SharedPreferences("spool_trial")`** | Saves spent, furthest-forward clock seen | App data |
| **`externalMediaDirs/.spool`** | The same two numbers, mirrored | **Does not survive either** on Android 11+ — see § 6 |
| **`BuildConfig`** | The trial's terms | Compiled into the APK |
| **The filesystem** | Downloads, artwork cache, cookie jars | Mixed — see [§ 8](#8-on-device-file-layout) |
| **The WebView's own store** (`app_webview/`) | The YouTube session: cookies and DOM storage | App data, and **excluded from backup** — see [§ 6](#6-native-side-stores) |
| **MediaStore** | Published saves, exports, diagnostic logs | Outlives the app |

AsyncStorage on Android is a SQLite database — `RKStorage`, from
`@react-native-async-storage/async-storage` 2.2.0
(`node_modules/@react-native-async-storage/async-storage/android/src/main/java/com/reactnativecommunity/asyncstorage/ReactDatabaseSupplier.java`).
It lives in the app's internal data directory, which is what makes every row in
the matrix's "AsyncStorage" band identical.

---

## 2. AsyncStorage, key by key

Eighteen keys. Seventeen are `dl.*`, written by `src/core/`; one is
`spool.clients.v1`, and the name is different because it is the only key that
holds something the *device* worked out rather than something the user did.

### `dl.firstRunDone` — `src/core/storage.ts`

```ts
"1"   // the literal string; anything else, or absent, reads as false
```

No cap, no shape to get wrong. `hasSeenFirstRun` compares `=== '1'`, so a
failed read is `false` and the notice shows again — the safe direction, since
the alternative is skipping the legal notice on a real first run.

Load-bearing ordering, not shape: everything gated on first run must be re-run
when first run *finishes*, because permissions are granted at the end of it. See
[FLOWS § 2](FLOWS.md#2-first-run).

### `dl.downloads` — the library index — `src/core/storage.ts`

```ts
type DownloadRecord = {
  id: string;                      // a job id, or `found:<uri>` for an adopted row
  title: string;
  quality: string;                 // 'audio' | 'video' on an adopted row; the real label otherwise
  uri?: string;                    // content:// for a manual save, file:// for an automatic one
  bytes?: number;
  audioOnly: boolean;
  savedAt: number;                 // epoch ms
  state: 'saved' | 'failed';
  error?: string;
  auto?: boolean;                  // the replay rule saved this, not the user
  videoId?: string;                // absent on every adopted row — see § 3
  artist?: string;
  seconds?: number;                // runtime, for the duplicate test in similar.ts
};
```

Written as `DownloadRecord[]`. **Cap 200, applied at write** —
`records.slice(0, 200)` in `saveDownloads`, so the in-memory list is authoritative
for the session and the tail is dropped on the way to disk. Nothing sorts on the
way out; the array's order is the library's order.

Two fields are copies rather than references, deliberately:

- **`artist` is copied off the play index at save time.** The index is capped at
  300 and evicts already-saved entries *first*, so the one entry guaranteed to
  be gone later is exactly the video this row is about.
- **`seconds` is what the source said**, and on an adopted row it comes from
  MediaStore's `DURATION`. It is the only identifying fact about a restored file
  that survives when its `videoId` does not, which is what lets `similar.ts`
  still recognise a re-download after a reinstall.

**Read path.** `loadDownloads` parses, and if the result is not an array returns
`[]`. Every row that does come back is passed through `named()`, which re-runs
`cleanArtist`/`cleanTitle` from `src/core/metadata.ts` — so a library that has
been collecting uploader titles since before name-cleaning existed reads the
same as one saved after it. `cleanTitle` only ever removes, so running it over
an already-cleaned row is a no-op, and `named` returns the original object
unchanged when nothing moved.

**Write trigger.** `BrowserScreen`'s effect on `[records, booted]`, guarded on
`booted` rather than on the list being non-empty — skipping the write when the
list was empty meant removing the last item never reached disk and it came back
next launch.

### `dl.settings` — `src/core/storage.ts`

```ts
type Settings = {
  enabled: boolean;                  // the replay rule
  after: number;                     // plays before it fires
  keepAs: 'audio' | 'video' | 'match';
  audioQuality: string;              // 'Best available'
  videoQuality: string;              // '1080p'
  instant: 'audio' | 'video';        // what a tap on the FAB grabs
};
```

`instant` is separate from `keepAs` on purpose: what a deliberate tap grabs and
what the rule keeps on the user's behalf are two independent preferences, and
wanting video when you ask and audio when the app decides is ordinary.

**Read path.** `{ ...DEFAULT_SETTINGS, ...parsed }` — merged over the defaults,
never trusted whole, so a blob from an older build is *missing keys* rather than
breaking the Profile screen. A non-object parse returns `DEFAULT_SETTINGS`.
This is the only key in the app with a real forward-compatibility story; see
[§ 10](#10-migrations--what-happens-to-a-blob-that-predates-a-shape-change).

### `dl.session` — the resume point — `src/core/storage.ts`

```ts
type PlaybackSession = {
  ids: string[];      // download ids, not tracks
  index: number;
  at: number;         // playhead, seconds
};
```

**Ids, not tracks, is the load-bearing part.** A row removed from the library
while the app was closed must not be able to resurrect itself as a queue entry
pointing at a file that is no longer listed. Whoever restores resolves the ids
against the library it just loaded and drops what no longer exists.

**Read path.** Returns `null` unless `parsed.ids` is a non-empty array; then
filters `ids` to strings and coerces `index`/`at` through `Number(x) || 0`, so a
`null` or a string where a number belonged becomes `0` rather than `NaN`.

**Write trigger.** `src/player/PlayerContext.tsx` writes on an interval while a
track is loaded, plus once on effect entry and once on cleanup. There is no
"save on exit" hook to rely on — a kill is never announced — so the cost of
being wrong is a few seconds of replay. `stop()` writes `null`, which *removes*
the key: stopping is a decision, not an interruption, and the next launch must
not offer a place to return to.

### `dl.lastMode` — the Browse mode — `src/core/storage.ts`

`'youtube' | 'ytmusic'`, defaults to `'youtube'`. Persists whether the user last viewed standard YouTube (`m.youtube.com`) or YouTube Music (`music.youtube.com`), so launches restore the chosen mode.

### `dl.searches` — `src/core/storage.ts`

`string[]`, **cap 8 at write** (`queries.slice(0, 8)`). Read path filters to
strings; a non-array returns `[]`.

### `dl.forgotten` — `src/core/storage.ts`

`string[]` of **uris**, **cap 500 at write**. This is the set that stops a
gallery rescan undoing a removal, and it only ever needs to hold rows that got
as far as a file — a row with no `uri` never finished, so there is nothing on
disk for a scan to find.

`forget(id)` in `BrowserScreen` prepends the uri (de-duplicating first) and
persists immediately, then drops the row and calls `forgetArtwork(id)`. See
[FLOWS § 14](FLOWS.md#14-removing-a-row).

**It is app data, so a reinstall forgets the forgetting**, and that is the
intended answer: a fresh install offering everything on the device is right.

### `dl.plays` — the play index — `src/core/plays.ts`

The only file in the app that records *behaviour* rather than results, and the
module's own header is explicit about the shape of that:

```ts
type PlayStat = {
  id: string;          // YouTube's 11-character id
  title: string;
  artist: string;
  starts: number;      // plays past the "did they mean it" threshold
  seconds: number;     // total real playback, summed
  lastAt: number;      // epoch ms of the most recent play
  music?: boolean;     // the page called this a track — decides what "Match" keeps
  savedAt?: number;    // when the replay rule took it
};
type PlayIndex = Record<string, PlayStat>;   // keyed by video id
```

Three numbers per video and nothing more. **No history of when each play
happened, no ordering, nothing that reconstructs a session.** The auto-save rule
needs a count and a duration; anything else would be a log of someone's evening
for no benefit. There is no network call in this module and there must not be
one.

**What counts as a play** is not decided here — it is decided in
`src/browser/usePlayTracking.ts`, and the rules are written up in
[FEATURES § 3 "What counts as a play"](FEATURES.md#what-counts-as-a-play). Do
not re-derive them from the shape above; the shape only records the verdict.

**`savedAt` is set even when the download later fails.** Its presence is what
stops the rule firing again on every subsequent play, and a retry loop that
re-downloads on every play would be far worse than one missed save.

**Cap 300 (`MAX_TRACKED`), applied at write, in two tiers:**

1. Anything the rule has already acted on (`savedAt` present) is dropped first —
   its counters have done their job.
2. Only then does `lastAt` decide, least-recent going first.

The sort is `(a, b) => (!!a.savedAt !== !!b.savedAt ? (a.savedAt ? 1 : -1) : b.lastAt - a.lastAt)`
and the first 300 of that ranking are kept. Because the trim runs only in
`savePlays`, the in-memory index can exceed 300 within a session; what comes back
from `loadPlays` never does.

That eviction order has a consequence documented in two other files:
`metadata.ts`'s `knownArtists` reads both the library *and* the play index
precisely because they lose their evidence in opposite directions, and
`DownloadRecord.artist` is copied at save time because the entry being downloaded
right now is the one likeliest to be evicted.

**Read path.** Accepts any non-array object wholesale — there is no per-entry
validation, so a damaged `PlayStat` survives the load. See
[§ 10](#10-migrations--what-happens-to-a-blob-that-predates-a-shape-change).

**Write trigger.** `usePlayTracking` batches on a 4-second timer, plus once at
teardown.

`clearPlays()` exists and **nothing in the app calls it**. Same class of gap as
the ones in [ARCHITECTURE § 9](ARCHITECTURE.md#9-known-gaps-in-the-wiring).

### `dl.playlists` — `src/core/playlists.ts`

```ts
type Playlist = {
  id: string;            // `pl-<base36 time>-<5 random chars>`
  name: string;          // tidied, ≤ 60 chars, unique case-insensitively
  trackIds: string[];    // download ids, in the user's order
  createdAt: number;
  updatedAt: number;
};
```

Written as `Playlist[]`. **Cap 50 lists at write** (`slice(0, MAX_PLAYLISTS)`);
`createPlaylist` also refuses past 50, so the write-side slice is a backstop
rather than the enforcement. **Cap 500 tracks per list is enforced in
`addTracks` only** — nothing re-checks it on load or on save, so a list that got
past 500 by some other route would persist at that length.

The id carries a random tail because two playlists made in the same millisecond
is not a real scenario, but an id collision here silently merges two lists and
there is no cheaper insurance.

**Ids, not tracks**, for the same reason `dl.session` stores ids. And then the
half that is genuinely load-bearing:

> **Stored ids are never pruned.** `resolve` turns them into rows against the
> library as it stands and skips what it cannot find, but nothing writes that
> back. An id that resolves to nothing today may simply be a library that has
> not finished loading — downloads are read asynchronously at boot and MediaStore
> adoption lands later still — so pruning on load would empty every playlist on
> one slow launch, permanently, with nothing anywhere to say why.

`resolve` additionally requires `row.state === 'saved' && row.uri`, so a failed
row in a playlist is skipped for display without being removed from storage.

**Read path** is the strictest in the app. A non-array returns `[]`; each entry
must have string `id` and `name` or it is dropped outright; `trackIds` is
filtered to strings or replaced with `[]`; `createdAt`/`updatedAt` go through
`Number(x) || 0`, with `updatedAt` falling back to `createdAt`.

**Write trigger.** `BrowserScreen`'s effect on `[playlists, booted]`, same
`booted` guard and same reason as the library.

### `dl.artwork` — `src/core/artwork.ts`

```ts
type Artwork = { uri: string; dominant: string };   // file:// path, "#RRGGBB"
type Failure = { failedAt: number };                 // epoch ms
type Index = Record<string, Artwork | Failure | null>; // null: legacy failure
```

Keyed by **download id** for a library row, and by **`yt:<videoId>`** for a video
that is only being watched in the browser. Those are deliberately different
keyspaces: the same video can be both a page and a saved file, and the file's own
embedded cover is the better source of the two — one key would let whichever
resolved first answer for both.

**`{ failedAt }` is a remembered failure**, not an absence. An item with no
artwork anywhere would otherwise be retried on every render for the life of the
app, and for a library saved from pages that no longer exist that is a network
call per row per launch. It is believed for 24 hours (`RETRY_FAILED_MS`), then
asked again.

**Neither a failure nor a success is believed forever.** Both used to be. On the
S21 FE (2026-09-18) most of a 104-item library drew blank squares over files that
each had a JPEG cover embedded: some entries were a bare `null` from whatever went
wrong once, others pointed at a `cacheDir/artwork` file that no longer existed —
the tint still came from the stored `dominant` while the image drew nothing. A
bare `null` is now read as an expired failure, and `loadArtworkIndex` asks
`filesExist` about every stored cover and drops the ones whose file is gone.

**Read path.** `loadArtworkIndex` accepts any object wholesale, once
(`loaded` latch), then drops entries whose cached file is missing. If the bridge
cannot answer, the index is believed as stored.

**No cap.** The index grows with the library; nothing trims it. `forgetArtwork(id)`
removes exactly one entry, and `forget()` calls it on removal so a re-download of
the same thing does not inherit the old row's remembered "nothing here".

**Write trigger.** `schedule()` notifies subscribers synchronously and debounces
the AsyncStorage write by 2 seconds. That debounce is the documented likely cause
of `tests/artwork.test.mjs`'s intermittent failure under the full-suite run — see
[README § Running the tests](README.md#running-the-tests).

### `dl.lyrics` — `src/core/lyrics.ts`

```ts
type LyricLine = { at: number; text: string };      // `at` is seconds
type Lyrics = { lines: LyricLine[]; plain: string; synced: boolean };
type Cache = Record<string, Lyrics | null>;
```

**Keyed on `artist|title`, lowercased and trimmed** (`lyricsKey`), not on a
download id. The same recording saved twice, or re-saved after a reinstall under
a fresh `found:` id, is the same lyric — a key that changed with the id would ask
again for something already on the device.

`null` is a remembered "there are none", and `undefined` (key absent) is "never
looked". The screen has to tell those apart: one offers a button, the other says
there are none and stops offering. **A *failure* is never cached** — no network,
a timeout, a 500 — because "we could not ask" is not "there are none", and
remembering it would leave a track permanently lyric-less because of one dead
moment on a train.

**Cap 200 (`MAX_CACHED`), applied at write, oldest-first**: `flush` keeps the
*last* 200 keys of the object's insertion order. Debounced 2 seconds.

**This is the only non-YouTube network boundary in the app.** `fetchLyrics` hits
`https://lrclib.net/api/get` with an 8-second timeout, sending title, artist and
(where known) duration — no identifier, no cookie, no library, no history. It is
called only from an explicit tap and only behind the consent key below. See
[FEATURES § 8 Lyrics](FEATURES.md#lyrics) and
[FEATURES § 14 Privacy](FEATURES.md#14-privacy).

`forgetLyrics()` clears both the in-memory cache and the key, and **nothing in
the app calls it**.

### `dl.lyricsOptIn` — `src/core/lyrics.ts`

`"1"` or `"0"`. Absent means no. A read that *fails* also means no —
`hasLyricsConsent` returns `false` from its catch, because erring the other way
would let a failed disk turn into a request the user never agreed to.

### `dl.log` and `dl.log.prev` — `src/core/log.ts`

```ts
type Entry = {
  t: number;                          // epoch ms
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;                      // download, engine, player, boot, page, console, crash…
  msg: string;
  flow?: string;                      // correlation id, `<scope>#<n>`
  ms?: number;                        // ms since that flow opened
  data?: Record<string, unknown>;     // redacted — see below
};
```

Both keys hold `Entry[]`, oldest first.

**The ring.** In-memory, **cap 900 (`CAP`)**, enforced in `push` by
`ring.splice(0, ring.length - CAP)` — a straight FIFO, no priority. 900 is
roughly an hour of ordinary use: one download writes about twenty entries, one
page navigation about five.

`debug` is dropped unless `setVerbose(true)` — it is the level that fires per
progress tick, and letting it into the ring evicts the entries explaining a
failure with entries describing the thing working. **Nothing in the app calls
`setVerbose`**, so in practice the ring holds `info` and above.

**The flush.** `dl.log` is written on a 4-second debounce, and **immediately on
any `error`** — an error is the one entry that might be followed by the process
dying. `flush()` is a no-op when nothing is dirty.

**The rotation.** `restore()` — called from `src/core/bootstrap.ts`, which
`index.ts` imports first — copies `dl.log` to `dl.log.prev` and *removes*
`dl.log`, once per process (`restored` latch). This is the whole reason for
persisting at all: a crash ends the process without warning, and if the next
launch wrote into the same key, the boot sequence of the run trying to explain
the crash would overwrite it. Nothing ever clears `dl.log.prev`; it is simply
overwritten by the next boot. `log.clear()` empties `dl.log` and **nothing calls
it**.

**`redact` matches on the key, and this is the rule that matters most**, because
this file leaves the device. A token has no shape worth matching, so a
value-shaped test would have false negatives and a false negative here writes a
credential into `Downloads/`. The pattern, exactly:

```ts
const SECRET = /token|cookie|auth|password|secret|credential|session[_-]?id/i;
```

Matched case-insensitively as a **substring of the key name**, so `poToken`,
`access_token`, `Cookie`, `cookieFile`, `authHeader`, `password`, `clientSecret`,
`credentials`, `session_id`, `sessionId` and `session-id` are all redacted.
`visitorData` is **not** — it is not a credential, and the log wants it. A
matching key's value becomes `` `<redacted ${length}>` `` for a string, or
`<redacted ?>` otherwise, and `null` when the value was already null, undefined
or empty. **The presence is the diagnostic, not the bytes** — `poToken:
"<redacted 214>"` answers both "was there one" and "was it plausible".

The rest of `scrub`: strings over 2000 chars are truncated with a
`...+<n>` tail; objects are walked two levels deep and then rendered as
`'[object]'` or `` `[${n} items]` ``; at most 24 keys per object, with a
`'...': 'truncated'` marker; an `Error` becomes `{ name, message, code }`.
`redact` itself is wrapped — a hostile object yields `{ unserialisable: true }`
rather than a throw.

**`describe(e)` drops the stack when a native `code` is present.** Anything
carrying one was built by `CodedError` on the way out of the module, so the stack
names the bridge and a bundle URL while the real failure happened in Python and
is already in `message`. Measured: one refused client wrote ~700 bytes of which
about 30 were about the refusal, five times per walk, evicting the history that
explained it.

**Getting it out.** `exportDiagnostics` in `BrowserScreen` writes
`spool-log-<ISO timestamp>.txt` into `Downloads/Spool` via `writeTextFile`,
previous run first, with a header carrying the platform, engine version, trial
state, settings JSON and record counts. There is no upload path and there is not
going to be one. See [FEATURES § 16](FEATURES.md#16-diagnostics--the-flight-recorder).

### `spool.clients.v1` — the client scoreboard — `src/core/clients.ts`

```ts
type Board = Record<string, number>;   // key: `${'open'|'token'}:${client ?? '*'}`
```

The one key that is not `dl.*`, and the one store holding a preference the
*device* worked out rather than something the user did.

**The key format matters.** Tokened and tokenless walks score separately —
`web` is SABR-only when open and perfectly good when tokened, so one board for
both would have each half teaching the other the wrong lesson. `null` is
yt-dlp's own default chain and is keyed as `*`.

**The scoring.** `next = 0.75 * score + (won ? 1 : -1)`, clamped to
`±1/(1−0.75) = ±4`. At that decay a client that has been losing for a long time
is back to neutral after three wins and ahead after four, so a client YouTube
re-opens is picked up again within one browsing session. A difference smaller
than `MEANINGFUL = 0.5` does not reorder the base chain, because the base order
encodes yt-dlp's published requirement table and that is better evidence than one
lucky request.

**A degraded answer scores the same as a refusal.** From the user's side a client
that returns one muxed 360p and a client that returns 403 are the same event —
which is exactly the failure `judgeManifest` exists to catch.

**The invariant, and it is load-bearing:**

> **It only ever reorders. It never removes a client.** The worst a badly-scored
> client suffers is being asked last, so a scoreboard that has learned something
> wrong costs time and can never be the reason a download fails.

That is what makes it safe to let this file learn from thin evidence, and it is
the same bargain `judgeManifest` makes. It is also not a cache of *answers*:
nothing here is trusted enough to skip asking.

**Persistence.** Debounced 2 seconds (`persist`), because one download scores up
to five times as the chain walks and the board is worth exactly one write per
burst. `loadClientScores()` runs once, from `initEngine()` in `src/core/ytdlp.ts`
— the one point both early enough to be in memory before the first walk orders a
chain, and on every path that walks one. Failure is silent by design: an empty
board is simply the base order, which is how the app behaved before this file
existed, and a download must never fail because a preference could not be read.

**Read path** is the most defensive of the eighteen: non-object or array returns
without touching the board; each value must be `typeof 'number'` *and*
`Number.isFinite`, then clamps to ±4. A hand-edited or half-written file must not
be able to poison the ordering with a `NaN`, which sorts unpredictably rather
than loudly.

**`forgetClientScores()` wipes it**, and is called from exactly one place: when
the engine replaces its own extractor. That is the one event that invalidates
everything at once — the scores describe how an *old* extractor got on with
YouTube, and after an update neither side is the one that was measured.

### `dl.account` — the Spool account — `src/core/account.ts`

```ts
{ session: string, email: string | null }
```

Written on a successful register or login; **removed** (not overwritten) on
sign-out and on a server's `401 signed out` / `403 blocked`. The session is
opaque and is a credential: it is sent only as `Authorization: Bearer` to the
licence server, and nothing logs it (`log.ts`'s `redact` would not catch the
bare key `session`, so the rule is "never pass it to a log call", not "redact
it").

**Read path:** one read at boot, memoised in `loadAccount()`, which every
authenticated request awaits — a sync fired from the boot effect cannot go out
before the session has been read. A missing, unparseable or shapeless blob
reads as signed out; the app must start either way, and signing in again is
cheap.

**Backup: this key is in `databases/`, which Auto Backup uploads** (see § 7 —
only `app_webview/` and `spool_trial.xml` are excluded). So a session is
restored onto a phone the user restores to. That is judged tolerable rather than
right: the restored device has a different `ANDROID_ID` hash, so its licence
must still be fetched under its own name, and the account's device list shows
it. If that ever needs to change, the session has to move out of AsyncStorage
into its own excluded file — excluding `RKStorage` would drop the library index
from backups too.

### `dl.serverContact` — `src/core/account.ts`

Epoch ms, as a string: the last time the licence server produced a parseable
answer of any kind, including a refusal. Not written on a throw, a timeout or a
5xx. The play lock's 24-hour offline grace is measured from it
(`core/playLock.ts`), so it has to survive a restart — a device that relaunches
on a plane must not start the grace over. An unreadable value reads as 0,
"never", which is the strict direction.

### `dl.licence` — `src/core/license.ts`

```ts
{ paidThrough: number /* epoch ms */, plan: 'monthly' | 'annual' | '' }
```

The date the subscription is paid through, persisted because **the token's own
expiry is no longer it** — the server now signs a lease of a few days and
renews it on every sync, and a screen offline for a week must still say
"paid through 12 Mar". Written from a kept `/v1/licence` answer and from an
approved `/v1/pay/claim`; removed by `forgetLicence` and when the session ends.
Nothing is enforced from it: `LicenseGuard` still decides.

### `dl.pendingOrder` — `src/core/payments.ts`

The `Order` from `/v1/pay/start` (order code, amount, UPI link, VPA, payee,
WhatsApp number, `expiresAt`). Kept while the user is away paying in a UPI app,
because Android may kill Spool in the meantime and the order code is what ties
the payment to the account. Dropped on load once `expiresAt` has passed, on an
approved claim, and on "Start over".

---

## 3. `adoptSaved` — the one function that can resurrect a deleted row

`src/core/storage.ts`. Read this section carefully before changing anything in
it; it is the function most able to hand a user back something they were told
was gone.

### Why it exists

The library index is app data and Android deletes it with the app. A manual save
is a MediaStore record in `Music/Spool` or `Movies/Spool` and outlives every
uninstall. So a reinstalled Spool would show an empty Library over a folder full
of music unless it goes and looks.

It runs on **every launch**, not only when the library is empty — the same gap
opens when app data is cleared, or when only some rows survive.

### Signature and shape

```ts
adoptSaved(
  existing: DownloadRecord[],
  found: { uri: string; title: string; bytes: number; savedAt: number;
           audioOnly: boolean; artist: string | null; durationMs?: number }[],
  forgotten: string[] = [],
): DownloadRecord[]
```

`found` is whatever `YtDlp.scanSaved()` returned (`SavedItem[]` in
`modules/ytdlp/index.ts`), matched on the **folder** — `RELATIVE_PATH` on Q+, the
legacy `DATA` column below it — because the folder is the only thing that
survives every route a file can take, including the user moving it back after a
tidy-up.

### The five rules

**1. Identity is `mediaKey(uri)`, not the uri string.**

```ts
/^content:\/\/media\/[^/]+\/(.+)$/  →  `media:${match[1]}`;  anything else, unchanged
```

`MediaStoreWriter` publishes under `VOLUME_EXTERNAL_PRIMARY` while `scanSaved`
reads back under `VOLUME_EXTERNAL`, so one file answers to two uris differing
only in that word — `content://media/external_primary/audio/media/99451` and
`content://media/external/audio/media/99451` are the same row and the device
resolves both. Comparing the strings never matched, so **every manual save was
adopted a second time on the next launch**: measured as 49 library rows over 47
files, and a fresh download reliably becoming two rows after one relaunch.
Normalising here rather than changing either volume constant is what makes it
safe to ship — rows already stored under either spelling collapse onto the same
key, so the first launch after it lands *tidies up* instead of adding one more
copy. A `file://` path, which is what an automatic save gets, is left exactly as
it is.

**2. `forgotten` is what stops this undoing a removal.** Removing a saved row
keeps the file and says so — "stays on this device, only Spool's list of it
goes". Without that set the next launch would find the file, adopt it, and hand
back the row the user had just been promised was gone. The forgotten uris are
themselves passed through `mediaKey`, so the volume-name asymmetry cannot leak a
row back through this door either.

**3. An adopted row's id is derived from its uri**: `` `found:${f.uri}` ``. That
is what lets a second scan recognise its own work rather than adding the same
file again under a fresh id.

**4. A restored row has no `videoId`.** Nothing in a MediaStore record says which
video a file came from. It plays, it lists, it sorts by date. What it cannot do
is tell the replay rule it already exists, so a track the user goes back to after
a reinstall can be saved a second time — and on a trial build that spends a
second slot. Fixing it properly means writing the id somewhere that travels with
the file, which is a change to what the user sees in their gallery, so it is
deliberately not done. `similar.ts`'s weaker title-and-runtime test is what
partially covers the gap, and is the reason `seconds` is carried on the row at
all.

**5. `quality` is `'audio'` or `'video'`, never a resolution.** The real format
is not in a MediaStore row, and inventing "1080p" here would be a number the user
could check and find wrong.

The title goes through `cleanTitle(f.title, cleanArtist(f.artist))` like anything
else entering the app — a filename written before names were cleaned, or by
another app entirely, gets the same treatment.

### `dedupeByFile`, the tidy-up half

`mediaKey` stops *new* duplicates being adopted, and that is all it does. The
pairs already in a library stay there, because nothing was ever going to revisit
them — on the device that was three rows over two files after four days on the
old build.

`dedupeByFile` runs on every `adoptSaved` call (including the early return when
nothing was adopted) and collapses saved rows sharing a `mediaKey`. **Only saved
rows name a file**: a failed row has no uri, and two failures of the same video
are two separate things the user asked for.

Where two rows describe one file, **the app's own record wins**. An adopted row
is identified by its `found:` id prefix and carries a sanitised filename for a
title; the record it duplicates has the title as written, a `videoId` and an
artist. Merging in that direction is what keeps the replay rule able to recognise
the video afterwards. `videoId`, `artist`, `seconds` and `bytes` are filled in
from whichever row has them, and `savedAt` takes the **earlier** of the two —
that is when the file actually arrived; the later one is only when the scan
noticed it.

It returns the *same array reference* when nothing merged, so a launch with a
healthy library writes nothing.

### Sorting, and when it happens

When something was adopted, the merged list is re-sorted `b.savedAt - a.savedAt`
— newest first. When nothing was adopted, `dedupeByFile(existing)` is returned
**unsorted**, preserving whatever order the library was already in.

### Call sites

`adoptFromGallery()` in `BrowserScreen`, from exactly two places, and the second
is load-bearing:

1. The boot effect, after `forgottenRef.current` has been assigned — otherwise
   the first adoption runs against an empty forgotten-set and hands back
   everything the user has ever removed.
2. The end of `FirstRunScreen`'s "start browsing", **after permissions are
   granted**. The boot scan ran before the user had agreed to anything, and
   reading files another install wrote needs `READ_MEDIA_*`. Measured: 0 adopted
   on first launch, 43 on the next.

A `scanSaved()` rejection is swallowed — no permission yet, or nothing there —
and the library keeps whatever was stored. See
[FLOWS § 13](FLOWS.md#13-reinstall-or-app-data-cleared).

---

## 4. Module-level stores that are never persisted

These live for the life of the process and are written to no key. They are the
reason `?fresh=n` exists in the test harness — and the reason one of them cannot
be reached by it.

| Module | Holds | Cap / eviction | Test reset |
|---|---|---|---|
| `src/player/nowPlaying.ts` | `owner: Source \| null`, `published: Record<Source, string>`, `positions: Record<Source, {at, clock, playing}>` | 2 sources, fixed | **`?fresh=n` is enough** — `tests/nowPlaying.test.mjs` re-imports |
| `src/browser/pageNowPlaying.ts` | `current: PagePlayback \| null`, listener set | — | **`?fresh=n` is enough** — `tests/pageNowPlaying.test.mjs` re-imports |
| `src/core/artwork.ts` | `index`, `loaded` latch, `inFlight` map, 3-wide gate (`active`/`waiting`), flush timer | index uncapped | `?fresh=n` — `tests/artwork.test.mjs` |
| `src/core/tokens.ts` | `store: Map<videoId, Token>` | **cap 60, least-recently-touched** | exported **`reset()`**, called in `beforeEach` |
| `src/core/clients.ts` | `board`, `loaded` latch, save timer | ±4 clamp | **exported `resetClientScores()` — required, see below** |
| `src/core/log.ts` | `ring`, `dirty`, `timer`, `restored` latch, `flowSeq`, `verbose`, `mirror` | ring cap 900 | exported **`reset()`** |
| `src/core/ytdlp.ts` | `preferredOpen`, `preferredToken`, `triedUpdate`, the `ready` promise | — | `?fresh=n` — `tests/ytdlp.test.mjs` |
| `src/core/trial.ts` | `cached: TrialStatus`, listeners, `opener` | — | not determined — `tests/trial.test.mjs` not read for this |
| `src/core/metadata.ts` | `lastKey` / `lastValue`, a one-entry memo on `clean()` | 1 | keyed on the names plus the hint *count*, so a stale hit is not possible across a growing library |

### The one that `?fresh=n` cannot reach

**`src/core/clients.ts` is a module singleton and is deliberately meant to
outlive a session.** `import('../src/core/ytdlp.ts?fresh=N')` gives you a fresh
`ytdlp.ts` that shares **one** `clients.ts` with every other copy — exactly as
the app does across a launch. So:

> Call `resetClientScores()` in `beforeEach`, or the second test in a file runs
> against a chain the first one taught.

`tests/ytdlp.test.mjs` and `tests/clients.test.mjs` both do. Because the board
never removes a client, the worst a wrong board can do is cost time — a leaked
score makes a test *slow or oddly ordered*, not failed outright, which is why
this is easy to miss.

`src/core/tokens.ts` has the same property in principle — it is a plain
`Map` at module scope — and `tests/tokens.test.mjs` calls the exported `reset`
in `beforeEach` rather than re-importing.

### PO tokens, in more detail — `src/core/tokens.ts`

```ts
type Token = { poToken: string; visitorData: string; mintedAt: number };
```

**Scope: one video.** yt-dlp's PO Token Guide: *"Most PO Tokens (such as for
`web` GVS/Player) are bound to the video ID, so a new token is required for each
video."* A token harvested while watching A and spent on B is not a *weaker*
token, it is the *wrong* one, and the media fetch 403s. Downloading the video you
are currently watching happened to work; anything else — the replay rule, the
notification's save button, a retry from Library minutes later — was rolling a
die.

**Lifetime: `TTL_MS = 6 hours`.** The guide is unusually vague — "a limited
lifespan (possibly as short as 12 hours)", with reports of some lasting months —
so this sits well under the pessimistic end. Being too eager costs one
re-harvest; being too generous costs a 403 the user reads as a broken download.
`tokenFor` deletes an expired entry as it declines it.

**`remember` merges rather than replaces**, because the harvester reports
`visitorData` as soon as the page loads and `poToken` only once a player response
arrives, and the two halves routinely turn up in separate messages. Re-inserting
moves the entry to the end of the `Map`'s iteration order, which is what makes
the cap least-recently-*touched* rather than oldest.

**Absent beats wrong.** `tokenFor` returns `{}` rather than a stale or foreign
token: yt-dlp without a token walks the open clients and may still succeed,
whereas yt-dlp with the *wrong* token pins itself to the web client and fails.

And the rule from `AGENTS.md` that this store's shape alone does not carry:

> **A held token must never leave the app worse off than an empty pocket.**
> Holding one narrows the walk to the two clients that could have minted it, so a
> token that is expired, bound to another video, or the wrong context leaves two
> chances where a tokenless request had five.

That escape is implemented in `attempts()` in `src/core/ytdlp.ts`, not here: a
tokened walk appends the whole open chain with the token dropped, so an exhausted
token chain ends where it would have started with nothing harvested. Anything
that narrows a fallback set on the strength of a *guess about credentials* needs
the same escape.

**Nothing about the token store is written to disk**, and it must stay that way —
a persisted credential is the thing `redact` exists to keep out of a file.
`summary()` reports `{ videos: store.size }` and names none of it.

### Two more caches worth naming

- **`src/core/metadata.ts`** holds one memoised answer (`lastKey`/`lastValue`)
  because `clean()` is called about once a second while something plays. The key
  includes the *count* of the corroboration set, not just the names — the set
  grows as the library does, and a cache that ignored it would keep handing back
  the answer worked out before the app had ever heard of this artist.
- **`src/core/similar.ts` holds no state at all.** Every function is pure over
  what it is given. It is in this book only because `DownloadRecord.seconds`
  exists for its benefit, and because it is the test that still works after
  `videoId` has been lost to a reinstall.

---

## 5. React-owned state in `BrowserScreen`

`src/browser/BrowserScreen.tsx` is the orchestrator, and it is that size for one
reason: **the WebView is mounted once and never unmounted**, only hidden behind
whichever tab is showing. Everything that has to survive a tab change therefore
lives above the tabs, which means here.

### Persisted

Four effects, all guarded on `booted` rather than on the value being non-empty:

| State | Key | Effect |
|---|---|---|
| `records` | `dl.downloads` | `[records, booted]` |
| `recentSearches` | `dl.searches` | `[recentSearches, booted]` |
| `playlists` | `dl.playlists` | `[playlists, booted]` |
| `autoSave` | `dl.settings` | `[autoSave, booted]` |

The `booted` guard rather than a non-empty check is the load-bearing detail:
skipping the write when the list was empty meant **removing the last item never
reached disk** and it came back on the next launch.

`forgottenRef` is written imperatively inside `forget()` rather than by an
effect, because the row is dropped in the same call and there is no state change
left to depend on.

### Deliberately not persisted

- **`url`, `entry`, `webviewKey`, `title`, `canGoBack`, `canGoForward`.** The
  browser starts at `HOME_URL` (`https://m.youtube.com`) every launch. What
  *does* persist across a restart is the WebView's own session — cookies and
  DOM storage, owned by Android's `CookieManager` and the WebView data directory,
  not by this app's storage layer. So the user stays signed in and lands on the
  home feed, which is the intended pair. `webviewKey` exists to force a remount
  after a renderer kill (see [FLOWS § 12](FLOWS.md#12-the-webview-renderer-is-killed))
  and a persisted one would mean nothing on a fresh process.
- **`jobs`.** In-flight downloads. A job is a live yt-dlp process and a slot in
  `DownloadService`; persisting the *record* of one across a process death would
  describe something that is definitively not running. What does survive is the
  partial file on disk, which is the resumable half — see [§ 9](#9-naming--partialkey-the-output-template-and-the-byte-budget).
- **`screen`, `sheet`, `picker`, `naming`, `filing`, `openList`, `sleepSheet`,
  `videoOpen`, `preRelease`, `notice`, `error`, `errorStale`, `dl`/`progress`,
  `meta`, `quality`, `query`, `loadProgress`.** Transient UI. Restoring a modal
  sheet or an error strip on launch would be restoring a moment, not a state.
- **`engine`.** `{ version, busy }`, re-read from the native module at boot so
  the Profile row has something honest to say rather than a cached claim.
- **`plays`.** Mirrored from `usePlayTracking`, which owns the persistence.

### The refs, and why they exist

`settingsRef`, `playsRef`, `screenRef`, `forgottenRef`, `entryRef`, `videoIdRef`,
`cardCanSave`, `cardSave`, `runAutoSave`, `artistHints`, `abandoned`,
`harvestSig`, `downloadQueue`, `confirmed`, `browserPlaying`, `localEngines`,
`timers`.

These are not a style preference. **The WebView's `onMessage` handler and the
notification's command listener are subscribed once** and must not be torn down
and rebuilt when unrelated state changes — rebuilding them mid-video drops the
messages the play counter runs on. A ref is how a once-subscribed closure reads
state that has moved since it was created.

### `PlayerContext`

`src/player/PlayerContext.tsx` owns `player`, `video`, `track`, `queue`, `index`,
`repeat`, `shuffle`, `sleep` plus the mirroring refs. **Only the queue's ids, the
index and the playhead are persisted**, into `dl.session`. `repeat`, `shuffle`
and the sleep timer are not: a timer left armed across a relaunch would be
waiting to pause something that no longer exists.

---

## 6. Native-side stores

### `SharedPreferences("spool_trial")` — `TrialGuard.kt`

Two keys:

| Key | Type | Meaning |
|---|---|---|
| `saves` | `int` | Downloads that produced a file on this install |
| `seen` | `long` | Furthest-forward wall clock ever observed |

### `externalMediaDirs/.spool` — the mirror

One line, `"$saves:$seen"`, written by `writeMirror` into
`context.externalMediaDirs.first()`.

**Reads take the larger of the two stores** (`maxOf(prefs, mirror)`), so wiping
either one alone buys nothing. The mirror lives in the app's external *media*
directory because it needs no permission to write and *was believed* to survive
both "Clear storage" and an uninstall. **It does not, on Android 11 and newer.**
Measured on Android 15 (API 35): `pm clear` empties
`/sdcard/Android/media/<pkg>/` and an uninstall deletes the directory. Android 11
brought `Android/media` under the same cleanup as `Android/data`, and the claim
here predates anyone checking it on a modern release. As the source puts it: a tester
who clears storage to reset the count loses their whole library doing it, which
is its own deterrent.

`spend(context)` is called **only once a download has actually produced a file** —
from both the success path and the salvage path in `YtDlpModule.download`. A save
that failed halfway has cost the tester nothing and must not cost them a slot.

### `BuildConfig` — compiled in, `modules/ytdlp/android/build.gradle`

| Field | Type | Source |
|---|---|---|
| `TRIAL` | `boolean` | `-PSPOOL_TRIAL`, default `true` |
| `BUILT_AT` | `long` | `System.currentTimeMillis()` at configuration time |
| `TRIAL_EXPIRES_AT` | `long` | `BUILT_AT + SPOOL_TRIAL_DAYS × 86,400,000`, default 7 days |
| `TRIAL_MAX_DOWNLOADS` | `int` | `-PSPOOL_TRIAL_SAVES`, default `20` |
| `TRIAL_MAX_SECONDS` | `int` | `-PSPOOL_TRIAL_SECONDS`, default `180` |
| `SIGNING_SHA256` | `String` | Release variant only; empty on debug so local builds do not refuse to run |

**The expiry is stamped in rather than stored on the device, so there is nothing
to clear or reinstall past.** Extending a trial is a rebuild, not a server call.

Winding the clock back is caught two ways in `expired()`, both with 26 hours of
slack for time zones, DST and NTP: `now < BUILT_AT − slack`, and
`now < highWater − slack`.

### What `src/core/trial.ts` stores, by contrast

**A cached copy and nothing else.** `cached: TrialStatus`, refreshed by
`refreshTrial()` calling `YtDlp.trialStatus()`, plus a listener set for
`useTrial()` and a single `opener` callback for the pre-release sheet.

The split is the point:

> **The trial is enforced in Kotlin and described in TypeScript.** R8 obfuscates
> the native side and the signature pin refuses a repackaged APK; neither touches
> the JavaScript bundle, which ships as Hermes bytecode that decompiles. So
> `TrialGuard` decides and `src/core/trial.ts` only words the refusal. A patched
> bundle gets a UI that lies and a native layer that still says no.

`refuseSave()` in TypeScript and `refuse()` in Kotlin check the same four
conditions in the same order — tampered, expired, quota, too long — because the
JavaScript one exists so a refusal can be worded *before* the user has waited for
an extraction that was never going to be allowed. Neither treats `seconds === 0`
as grounds for refusing: an unknown length is not evidence of a long video.

None of it makes the build uncrackable, and the source says so. Anything running
on the attacker's hardware can be patched. The goal is to move the cost from
"clear app data" to "decompile, patch, resign, defeat the pin".

---

### `SharedPreferences("spool_licence")` — `LicenseGuard.kt`

| Key | Type | Meaning |
|---|---|---|
| `token` | `String` | The signed licence, verified before it was written |
| `seen` | `long` | Furthest-forward wall clock ever observed |

### `externalMediaDirs/.spool_l` — the licence mirror

The token again, verbatim. Same directory as the trial's `.spool` mirror and for
the same mechanical reason — it survives "Clear storage" *and* an uninstall — but
for the opposite purpose. For the trial that property is a **deterrent**: a
counter you cannot reset. For the licence it is a **courtesy**: a paying user who
reinstalls, or clears storage to fix something, gets their subscription back with
no round trip and no support conversation.

Reads prefer preferences and fall back to the mirror, rather than taking the
larger of the two the way the trial's counter does. There is no "larger" here —
a token either verifies or it does not.

**Nothing is trusted on the strength of being stored.** `expiresAt()` re-runs the
ECDSA verification on every call rather than caching a boolean, so editing either
store by hand achieves nothing. `remember()` verifies *before* writing, so a
hostile or misconfigured server cannot park bytes that every later launch has to
re-reject.

The clock high-water mark is separate from the trial's, and deliberately so: a
subscription expires in the *future*, so winding the clock back is how you extend
one — the mirror image of the trial, where winding it back is how you undo an
expiry. Same 26 hours of slack, same defence, opposite direction.

### `BuildConfig`, licence half — `modules/ytdlp/android/build.gradle`

| Field | Type | Source |
|---|---|---|
| `LICENCE_KEY` | `String` | `-PSPOOL_LICENCE_KEY`, the X.509 SPKI public key, base64. Empty by default |
| `LICENCE_SERVER` | `String` | `-PSPOOL_LICENCE_SERVER`. Empty by default |

Both empty is the debug case and **fails closed**: `LicenseGuard` cannot build a
verifier, every token fails, nobody is entitled and the trial applies. A *release*
build with either empty throws at configuration time, because shipping one would
produce an app that takes payments and then refuses every licence it is handed.

### What `src/core/license.ts` stores, by contrast

A cached `LicenceStatus`, a `nextSyncAt` timestamp, and `dl.licence` (§ 2) —
the subscription's paid-through date, which is a *description*: nothing
authoritative, the same relationship `trial.ts` has to `TrialGuard`. The token
in `spool_licence` is now a short lease, so its `exp` is not the date to show.

### MySQL — off the device entirely, in the licence server

Not in this repository. The server is a plain PHP + MySQL application at
`c:\laragon\www\spool`; its schema is `database/schema.sql` there and is that
project's to document — it is being reworked for accounts and UPI payments as
this is written, so no table list is repeated here to go stale.

What the app sends it, which is this book's business: signed in, the account's
email and password (only to register and log in), the session, the device hash
and a label such as "Samsung SM-A515F", `/v1/play/*` start/renew/release
events (when, never what), and — on a payment — the receipt screenshot and the
text read from it. Signed out: nothing.

## 7. The survival matrix

Columns: **Restart** = the process is killed and relaunched. **Clear cache** =
Settings → Storage → Clear cache, which empties `getCacheDir()` and
`getExternalCacheDir()`. **Clear storage** = Settings → Storage → Clear storage
(`clearApplicationUserData`). **Reinstall** = uninstall, then install again.
**Downgrade** = a lower-versioned APK replacing this one.

`✅` survives · `❌` gone · `⚠️` survives but changes meaning · `?` not determined

| Store | Restart | Clear cache | Clear storage | Reinstall | Downgrade |
|---|---|---|---|---|---|
| **AsyncStorage — all 18 keys** (`RKStorage` in the app's internal data dir) | ✅ | ✅ | ❌ | ❌ | ✅ |
| `dl.log` specifically | ⚠️ moved to `dl.log.prev` at boot | ✅ | ❌ | ❌ | ⚠️ same rotation |
| `dl.log.prev` specifically | ⚠️ overwritten each boot | ✅ | ❌ | ❌ | ⚠️ |
| `spool.clients.v1` specifically | ✅ | ✅ | ❌ | ❌ | ⚠️ wiped on the next self-update |
| **Module singletons** (`nowPlaying`, `pageNowPlaying`, `tokens`, the client pins, the log ring) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **React state** (`BrowserScreen`, `PlayerContext`) | ❌ | ❌ | ❌ | ❌ | ❌ |
| **WebView cookies + DOM storage** (`CookieManager`, WebView data dir) | ✅ | ? — not in `cacheDir`, so probably untouched | ❌ | ❌ | ? |
| `spool_cmd` cookie (`Max-Age=120`) | ❌ in practice — 2-minute lifetime | ? | ❌ | ❌ | ❌ |
| **`getExternalFilesDir(null)/downloads/`** — every download's first landing place, and where automatic saves stay | ✅ | ✅ — not `cacheDir` | ❌ | ❌ | ✅ |
| **`cacheDir/artwork/*.jpg`** | ✅ | ❌ | ❌ | ❌ | ✅ |
| **`cacheDir/upload/shot-*.jpg`** (the one payment screenshot copy `shrinkImage` keeps) | ✅ | ❌ | ❌ | ❌ | ✅ |
| **`noBackupFilesDir/session/jar*.txt`** | ❌ in practice — one per extraction or download, deleted in the caller's `finally` | n/a — not in `cacheDir` | ❌ | ❌ | ✅ if one is somehow live |
| **`Music/Spool/` + `Movies/Spool/`** (MediaStore, manual saves) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`Downloads/Spool/`** (`.m3u8`, `spool-backup-*.json`, `spool-log-*.txt`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`SharedPreferences("spool_trial")`** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **`externalMediaDirs/.spool`** (the mirror) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **`SharedPreferences("spool_licence")`** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **`externalMediaDirs/.spool_l`** (the licence mirror) | ✅ | ✅ | ✅ | ✅ | ✅ |
| **The account and its subscription on the server** | ✅ | ✅ | ✅ | ✅ | ✅ — it is not on the device; a reinstall signs in and gets it back |
| **`BuildConfig` constants** | ✅ | ✅ | ✅ | ⚠️ new `BUILT_AT`, new `TRIAL_EXPIRES_AT` | ⚠️ **older** `BUILT_AT` and expiry |

### Reading the matrix

**The `Music/Spool` ↔ AsyncStorage split is the whole design.** Manual saves are
`✅✅✅✅✅` and the index that describes them is `✅✅❌❌`, which is precisely the
gap `adoptSaved` closes. Automatic saves are on the *other* side of that line —
they live in `getExternalFilesDir` and are `❌` from "Clear storage" rightwards,
and [FLOWS § 13](FLOWS.md#13-reinstall-or-app-data-cleared) says so plainly:
*"Only manual saves come back."*

**"Clear storage" clears more than the app's own storage layer.** It takes the
AsyncStorage database, `SharedPreferences`, `cacheDir`, the WebView data
directory *and* `getExternalFilesDir` — which means it deletes every automatic
save the user has. `externalMediaDirs` is the one app-writable location that
survives it, and that is exactly why the trial's counter is mirrored there.

**The licence mirror is the one place this asymmetry is deliberately kind.**
Every other `externalMediaDirs` entry exists so something cannot be reset — the
trial counter. `.spool_l` exists so a paying user who reinstalls, or clears
storage to fix an unrelated problem, does not have to prove anything again. Same
mechanism, opposite intent, and the server's `subscriptions` row is a second net
under it: a device that loses both stores while online re-fetches its token on
the next launch and never notices.

**A reinstall's asymmetry, stated as a user experience.** Files come back, names
come back, dates come back. What does not come back: which video a file was
(`videoId` is absent on every adopted row), play counts, playlists, artwork
colours, forgotten-row suppressions, and the client scoreboard. The library is
whole and its *arrangement* is not — which is what `src/core/export.ts` exists
to answer.

**Downgrade.** A downgrade that Android refuses without an uninstall behaves as
`Reinstall`, not as `Downgrade`. Whether that applies here is **not determined**:
`app.json` sets `"version": "1.0.0"` and no explicit `android.versionCode`, so
what an older APK does over a newer install is not settled by this repo. Where a
downgrade *does* land in place, note the two `⚠️` rows: `BuildConfig` goes
*backwards*, so an older build's `TRIAL_EXPIRES_AT` may already have passed, and
`highWater` in the surviving mirror is still the newer date — so `expired()` will
say yes on both tests. The mirror is doing what it was built to do.

**Where a cell says `?`.** What Android's own "Clear cache" does to the WebView
data directory is not established here and is not guessed at — it is outside
`cacheDir`, which is the only reason to expect it survives.

What the repository itself does to that jar is now four things, not two:
`CookieJar.write` copies it out, `writePageCommand` sets `spool_cmd`,
`CookieJar.clear` **removes all of it** (`signOutOfYouTube`, from Profile), and
the backup rules below keep it off Google's servers.

**Backup is the row the matrix does not have.** Auto Backup is on — the Expo
template sets `android:allowBackup="true"` — and it excludes only `cache/`,
`code_cache/` and `no_backup/`. Everything else under the data directory goes to
Google's servers and is restored onto whatever device the user restores to.
Two paths are excluded by
`modules/ytdlp/android/src/main/res/xml/spool_backup_rules.xml` (Android 11 and
older) and `spool_data_extraction_rules.xml` (Android 12+, which splits cloud
backup from device-to-device transfer — both excluded):

| Path | Why |
|---|---|
| `app_webview` | The WebView's cookie jar. After a sign-in it holds the user's live YouTube session, so backing it up uploads the login and restores it as a working session on another device |
| `spool_trial.xml` | The save counter. A backup taken at zero saves, restored later, would be a reset button. The `externalMediaDirs` mirror would still catch it, but the two should not disagree in the first place |

`databases/` — the library index — is deliberately **not** excluded. Carrying
that to a new phone is a benefit; carrying a credential is not.

---

## 8. On-device file layout

| Path | Written by | Cleaned up by |
|---|---|---|
| `getExternalFilesDir(null)/downloads/<stem>.<ext>` | `YtDlpModule.download` — every download's first landing place | Never for a completed file. Automatic saves stay here permanently; manual ones are **moved** by `MediaStoreWriter.publish`, which deletes the source after copying |
| `getExternalFilesDir(null)/downloads/<stem>.<partial>` | yt-dlp, mid-download | `sweepStalePartials()` — see below |
| `cacheDir/artwork/<sanitised key>.jpg` | `YtDlpModule.readArtwork` — quality-85 JPEG, short edge 640, letterbox bars trimmed | Nothing in the app. "Clear cache", or Android. The index notices at the next launch (`filesExist`) and rebuilds |
| `noBackupFilesDir/session/jar<random>.txt` | `CookieJar.write`, one per extraction and per download | **`CookieJar.discard` in the caller's `finally`.** `CookieJar.sweep` at engine init takes anything older than 30 minutes — the process dying mid-download is the only way one survives. `CookieJar.clear` takes them all |
| `externalMediaDirs/.spool` | `TrialGuard.writeMirror` | Nothing, by design |
| `Music/Spool/<title>.<ext>` | `MediaStoreWriter.publish`, `audioOnly = true` | The user, in their gallery |
| `Movies/Spool/<title>.<ext>` | `MediaStoreWriter.publish`, `audioOnly = false` | The user |
| `Downloads/Spool/<name>.m3u8` | `MediaStoreWriter.writeText` via `writeTextFile` | The user |
| `Downloads/Spool/spool-backup-YYYY-MM-DD.json` | same | The user |
| `Downloads/Spool/spool-log-<ISO>.txt` | same | The user |

The artwork cache key is the artwork index key with everything outside
`[A-Za-z0-9_-]` replaced by `_`, so a library row's cover is
`<downloadId>.jpg` and a browsed video's is `yt_<videoId>.jpg`.

Covers are re-encoded rather than stored as they arrived: yt-dlp embeds the
maxres thumbnail, so raw bytes are ~1.8 MB per item — measured — and a library of
a few hundred would put half a gigabyte of cover art in the cache to fill a 320dp
square.

### The stale `.part` sweep

`sweepStalePartials()`, run once from `ensureInitialised()`. It deletes anything
in the download directory older than **24 hours** (`PARTIAL_MAX_AGE_MS`) that
matches either an image extension (`jpg`, `jpeg`, `png`, `webp`) or:

```
\.f\d+\.|\.temp\.|\.part(-Frag\d+)?$|\.ytdl$
```

**It matches on a pattern rather than an extension set, and that is not a style
choice.** `File.extension` reads `.part-Frag7` as `part-Frag7`, so an extension
test does not catch a fragmented download's leftovers; and `.temp.mp4` — the
merge ffmpeg is still writing — carries the *real* container's extension and
looks like a finished file. Both used to survive here forever, at the size of a
whole video each. `AGENTS.md` has the full account under *"A decoration must
never be able to fail the thing it decorates"*.

The 24-hour cutoff is what makes the sweep compatible with resumption: yt-dlp
resumes from `.part` files, so only ones old enough that no resume is plausibly
wanted are taken. It also means a cover belonging to a download running right now
is minutes old and cannot be reached from here whatever else changes about when
this is called.

Images are swept alongside the partials because they are only ever
intermediates — `--embed-thumbnail` downloads the cover and leaves the source
where it fell when the embed or the download fails. Measured at 179 KB from one
interrupted save.

The **same pattern** is what `finished()` refuses by, and it must stay the same
pattern in both places. `finished(outputDir, stem, startedAt)` answers "did this
attempt produce a real file", excluding images and everything `INTERMEDIATE`
matches, preferring a file modified since `startedAt` and falling back to an
older one — which is the "already downloaded" case, and is correct, because
yt-dlp leaves a complete file untouched and a complete file of exactly the video
and quality asked for is the right answer whoever wrote it.

---

## 9. Naming — `partialKey`, the output template, and the byte budget

### The output template

```kotlin
addOption("-o", File(outputDir, "$stem.%(ext)s").absolutePath)
```

`stem` is the `resumeKey` the bridge was given, **re-filtered natively** —
`filter { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }` then
`.replace("..", "")` — because it becomes a path and `..` in it would write
outside the download directory. It falls back to the job id when blank, which is
what it used to always be.

### `partialKey` — `src/core/ytdlp.ts`

```ts
export function partialKey(videoId: string, audioOnly: boolean, format: Format): string {
  const id = (videoId || 'video').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'video';
  return `${id}.${audioOnly ? 'a' : `v${format.height ?? 0}`}`;
}
```

So a 1080p video save writes `dQw4w9WgXcQ.v1080.mp4` and an audio save writes
`dQw4w9WgXcQ.a.m4a`.

**Why the job id is not in it, and why the quality is** — the arguments are made
in full in `AGENTS.md` under *"A download must be named for what it is, not for
the attempt"*; the short form:

- The job id is minted **per attempt**, so a name built from it guarantees
  yt-dlp's `--continue` never has a partial to continue into. A 141 MB save
  interrupted at 90% started again at 0%, every time, on exactly the connection
  that had already proved it would interrupt one.
- The **quality has to be in the key** because a `.part` belongs to one format,
  and resuming a 720p body into a file opened for 1080p corrupts it.
- The **title must not be in it**, for the byte-budget reason below.

And the consequence that has to be carried forward: **a shared name means "a file
with this name exists" is no longer proof that this attempt wrote one.**
`finished()` prefers one modified since the attempt began, and anything else
reading that directory has to make the same distinction or it will resolve a
failed download to an older success.

### The byte budget

Filesystem names are counted in **bytes**; Kotlin and Python count **characters**.
The old template was `%(title).80s` and the old sanitiser used `take(120)`. Music
and status channels title uploads in styled Unicode (𝐬𝐚𝐝 𝐬𝐨𝐧𝐠) and emoji at four
bytes to the character, so eighty characters is ~340 bytes, past the 255-byte
limit, and the write dies with `[Errno 36]` before any audio lands. It is
per-video and absolute — the title never changes, so that video can never be
saved, while plain-titled ones save fine, which is why it read as "sometimes it
breaks forever".

Two places now trim on a byte budget at a character boundary:

- **`MediaStoreWriter.limitBytes(180)`** — for the gallery filename, which *is*
  built from the title. 180 leaves room for the extension and for MediaStore's own
  de-duplicating `(1)` suffix inside the 255-byte limit.
- **`export.fileNameFor(name, ext)`** — 80 **characters**, not bytes, for a
  playlist's `.m3u8`. It is a deliberately separate trim: `sanitise` would do it
  natively anyway, but a name mangled after the fact turns up in the user's
  Downloads folder looking like a bug, and the app has already told them what it
  named the file.

Neither `[Errno 36]` nor `File name too long` matches any branch of
`readableError`, so both surfaced as "check free space and connection" on a phone
with 26 GB free. When a failure makes no sense, read `[spool] engine error` in
logcat — or the flight recorder — before believing the copy.

---

## 10. Migrations — what happens to a blob that predates a shape change

There is **no migration framework, no schema version on any AsyncStorage key, and
no upgrade step anywhere.** What each key does with a blob it does not recognise
is decided entirely by its own read path, and the results differ more than the
uniform "swallow and return something usable" summary suggests.

Ranked from most forgiving to least:

**1. `dl.settings` — merged, never replaced.** `{ ...DEFAULT_SETTINGS, ...parsed }`.
A blob from an older build is *missing keys* rather than breaking the screen, and
a blob from a *newer* build carries extra keys through harmlessly. This is the
only key with a real forward-compatibility story, and it is the pattern any new
object-shaped key should copy.

**2. `dl.downloads` — repaired on the way out.** A non-array becomes `[]`, but
every row that does load is re-run through `named()`, so name-cleaning applied to
a library saved before that feature existed. Individual rows are **not**
validated: a row missing `state` or carrying a number where a string belonged
loads as-is. Optional fields added later (`artist`, `seconds`, `auto`) are simply
`undefined` on old rows, and every consumer already treats them as optional.

**3. `dl.playlists` — validated per entry, and drops what fails.** Anything that
is not recognisably a playlist is dropped rather than allowed to crash a screen.
The `updatedAt` fallback to `createdAt` is a real, in-place migration: playlists
written before `updatedAt` existed get a sensible value rather than `0`.

**4. `dl.session` — coerced.** `ids` filtered to strings, `index`/`at` through
`Number(x) || 0`. A blob whose `ids` is not a non-empty array is dropped whole
(`null`), which costs a resume point and nothing else.

**5. `spool.clients.v1` — validated per value, and clamped.** Non-finite values
are dropped; finite ones are clamped into ±4. A hand-edited or half-written file
cannot poison the ordering with a `NaN`.

**6. `dl.searches`, `dl.forgotten` — filtered to strings.** Nothing else to get
wrong.

**7. `dl.plays`, `dl.artwork`, `dl.lyrics` — accepted wholesale.** Each checks
only that the parse produced a non-array object and then trusts every entry. A
`PlayStat` from a future or damaged build, an `Artwork` missing `dominant`, a
`Lyrics` whose `lines` is not an array — all load. **This is the honest gap.** In
practice each is consumed defensively enough that it has not bitten: `describePlays`
would render `NaN`, `artworkFor` hands whatever it has to an `<Image>` `source`,
and the lyric follower reads `.at` off objects that may not have one. It has not
been a defect and it is not defended against either.

**8. `dl.log`, `dl.log.prev` — array or empty.** `previous()` returns `[]` for
anything that is not an array. Individual entries are not validated, and `line()`
guards its own `JSON.stringify` with a `{unserialisable}` fallback.

**Where the code just drops the value**, stated plainly: `dl.downloads`,
`dl.searches`, `dl.forgotten`, `dl.artwork`, `dl.lyrics`, `dl.plays` and
`dl.log*` all return their empty value on a parse failure or a wrong top-level
type, with no attempt to salvage a partial blob and no notice to the user.
`dl.playlists` drops individual malformed rows and keeps the rest.
`spool.clients.v1` drops individual non-numeric values and keeps the rest.

**Renaming a key is a data loss event with no recovery path**, because nothing
reads an old name. `spool.clients.v1` is the only key carrying a version marker,
and it carries one precisely because its shape is the one most likely to change.

---

## 11. The on-disk export formats

`src/core/export.ts`. Everything in it is a **pure function of what it is
given** — the writing is one native call at the edge (`writeTextFile` →
`MediaStoreWriter.writeText`), which is what makes all of it testable
(`tests/export.test.mjs`).

It exists because of an asymmetry the rest of this book has already established:
manual saves survive a reinstall and *the arrangement of them does not*, because
an arrangement is not a file. So it becomes one.

### `.m3u8` — one per playlist

```
#EXTM3U
#PLAYLIST:<name>
#EXTINF:<seconds>,<Artist - >Title
<uri>
…
```

with a trailing newline, because a file that does not end in one is the kind of
thing a strict parser refuses and nobody can see why.

A runtime that is not known is written as **`-1`**, which is what the format
reserves for exactly that, rather than `0` — which reads as a zero-length track.

**The location line is a real limit, stated rather than papered over.** It is a
`content://` for anything saved by hand, and some players resolve one while some
only understand a path. The `#EXTINF` line is the part that always survives, so
even where the location does not resolve the file is named well enough for a
person to find it. An automatic save is app-private and has no meaning at all
outside Spool; it is exported for completeness and will not open elsewhere.

Filename: `fileNameFor(playlist.name, 'm3u8')` — `[\\/:*?"<>|]` → `_`,
whitespace collapsed, trimmed, ≤ 80 characters, `Playlist.m3u8` if nothing
survives. Mime `audio/x-mpegurl`.

### `spool-backup-YYYY-MM-DD.json` — the whole arrangement

```ts
type Backup = {
  format: 'spool-backup';
  version: 1;
  exportedAt: number;                       // epoch ms
  playlists: {
    name: string;
    createdAt: number;
    tracks: { title: string; artist?: string; seconds?: number }[];
  }[];
};
```

Written with `JSON.stringify(backup, null, 2)` plus a trailing newline, mime
`application/json`. The date stamp is **local time**, not `toISOString`, because
the only reader is a person looking at a list of files deciding which one is
yesterday's — and UTC would shift the date by a day for anyone west of Greenwich
in the evening.

**Tracks are stored by name, not by id, and that is the whole design.** The ids
are the thing that does not survive: a reinstall rebuilds the library from
MediaStore and every row comes back under a `found:` id it has never had before
(see [§ 3](#3-adoptsaved--the-one-function-that-can-resurrect-a-deleted-row)). A
title and an artist are what the files themselves still carry, which makes them
the only handle a restore could use.

Only tracks that `resolve()` currently returns are written — saved rows with a
uri. A playlist entry pointing at a row the library does not have is silently
absent from the backup.

### What importing one does to existing rows

**Nothing. Import is not built.** There is no reader for either format anywhere
in the repository — no `importBackup`, no `readBackup`, no `restoreBackup`, and
nothing that parses `.m3u8`. The `version: 1` field is there so that a future
build has something to branch on; today it is written and never read.

The user-facing consequence is worth being exact about: **the backup is a file
the user keeps, not a round trip the app offers.** After a reinstall, `adoptSaved`
gives them their files back and the backup tells them — or a future Spool — what
order those files were in. Turning that into an actual restore is unbuilt work,
not a bug.

`describeExport` is what the confirmation says: `"3 playlists · 41 tracks"`,
counted through `resolve` so the number stated is the number written.

---

## 12. Where the code and the other books disagree

Listed so nobody rediscovers them by debugging. All are in
[ARCHITECTURE § 4](ARCHITECTURE.md#4-where-state-lives) unless said otherwise.

1. **`spool.clients.v1` is missing from the AsyncStorage table.** § 4 lists
   thirteen keys; there are fourteen. The scoreboard *is* described in § 2 under
   "The seam files", so this is an omission from one table rather than an unknown
   store.

2. **§ 4 says downloads are named `<jobId>.<ext>`. They are not, and have not
   been since `partialKey` landed.** Both the "The device, outside the app
   sandbox" bullet (*"Named `<jobId>.<ext>`, never from the title"*) and the
   "Filenames are counted in bytes" paragraph (*"Downloads are named for the job
   id"*) predate it. The current name is `partialKey(videoId, audioOnly, format)`
   — `<videoId>.<a|vHEIGHT>` — with the job id as a fallback only when the bridge
   was given no `resumeKey`. `AGENTS.md` has the correct account under *"A
   download must be named for what it is, not for the attempt"*, so the two
   loaded files currently contradict each other on this point.

3. **§ 4's `dl.playlists` cap reads "50 lists × 500 tracks" as though both were
   enforced at the same place.** The 50 is enforced twice — in `createPlaylist`
   and again in `savePlaylists` — while the 500 is enforced only in `addTracks`.
   Nothing re-checks track count on load or save.

4. **§ 4 lists `dl.artwork` with no cap, which is right, but the entry does not
   say the index is unbounded.** It grows with the library and only
   `forgetArtwork(id)` ever removes anything.

5. **Four exported clear/reset functions have no caller in the app**:
   `clearPlays()` (`plays.ts`), `forgetLyrics()` (`lyrics.ts`), `log.clear()` and
   `log.setVerbose()`. Same class as the gaps in
   [ARCHITECTURE § 9](ARCHITECTURE.md#9-known-gaps-in-the-wiring), and worth
   knowing before writing a Profile row that assumes one is wired up.

6. **`AGENTS.md` and this book agree on everything else.** In particular the
   `INTERMEDIATE` pattern, the 24-hour sweep, the `redact`-on-key rule, the
   token-chain escape in `attempts()`, the `resetClientScores()` requirement in
   `beforeEach`, and the `externalMediaDirs` mirror all read out of the source
   exactly as `AGENTS.md` describes them.

---

**When a change lands that this book does not describe, update it in the same
change.** A stale book is worse than none, because it will be trusted.
