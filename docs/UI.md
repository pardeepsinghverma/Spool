# Spool v2 — UI knowledge book

Source of truth: Claude Design project `f1f711a7-7625-484d-a5a0-88f377c61411`,
file `Spool v2.dc.html`. **Read this file before changing anything visual.** If a
change contradicts what is written here, the design is what is wrong or this file
is stale — resolve it explicitly, do not silently diverge.

Implemented in `src/ui/theme.ts` (tokens) and `src/ui/*`, `src/screens/*`,
`src/player/*` (components).

---

## The three rules everything else follows from

**The artwork is the interface.** Every surface behind the current item derives
from its dominant colour. The app is a frame around the art, not chrome sitting
on top of it. Screens with no current artwork stay on the neutral base.

**Downloading is a consequence, not a task.** Play something three times and it
is on the device, at the quality set once in Profile. The rule has no interface
until the file exists. It is visible in Library and nowhere else.

### What actually counts as a play

The rule is only as trustworthy as its counter, and a counter that over-counts
fills someone's phone with things they never chose. Four guards, all load-
bearing:

- **Muted video never counts.** The page script refuses to report it, which is
  what keeps the home feed's autoplay previews out of the index entirely.
- **Watch time comes from the playhead, not the clock.** Buffering, a stalled
  network and a backgrounded process all keep wall time running while nothing is
  heard. Only forward movement of `currentTime` is credited.
- **Seeks are not watching.** A jump larger than one reporting interval (3s) is
  scrubbing: the position is adopted, the gap is not credited. Dragging to the
  end of an hour-long video earns nothing.
- **A play must be meant.** A start banks only after five real seconds, so
  opening something and leaving is not a play — and one visit cannot bank two
  starts without leaving and coming back.

Stored per video: `starts`, `seconds`, `lastAt`, and whether the page called it
music. Nothing records *when* each play happened; the rule needs a count and a
duration, and a timeline of someone's evening buys nothing. It never leaves the
device — `src/core/plays.ts` has no network call and must not gain one.

The index is capped at 300 videos, dropping already-saved entries first and then
the least recent.

**React Native StyleSheet only.** Flat fills, borders, opacity, transform. No
gradients, no shadow spread, no filters. Tints are computed as flat colours from
the artwork palette at decode time — never as live filters.

---

## Colour

Six fixed tokens. Two — `tint` and `accent` — are extracted from the current
artwork and pushed into the theme, clamped so text on them clears 4.5:1.

| Token | Value | Notes |
|---|---|---|
| `base` | `#0B0B0C` | app background when no artwork is current |
| `raised` | `#1A1A1D` | cards, chips, search field |
| `line` | `#2B2B30` | borders, dividers, inert FAB |
| `text` | `#F5F2EE` | 18.1:1 |
| `dim` | `#A5A09A` | 7.9:1 — secondary text |
| `mute` | `#5C5852` | tertiary, disabled, mono metadata |
| `saved` | `#7FD8A6` | the completed-download tick, and only that |
| `warn` | `#F0A868` | stalled/failed text — never a colour flood |

Extracted pairs ship as three worked examples; use them as fixtures until real
extraction lands:

| Palette | `tintDeep` | `tint` | `accent` |
|---|---|---|---|
| sepia | `#241C15` | `#3A2E22` | `#F0C08A` |
| teal | `#0F2224` | `#1D3A3D` | `#78D6C6` |
| violet | `#1D1528` | `#33264A` | `#BFA3F0` |

`tintDeep` is the screen background, `tint` the raised surface on top of it,
`accent` the active/selected colour. Text on tinted surfaces warms with the
tint (`#F5EFE7` on sepia, `#EAF3F1` on teal) rather than staying neutral.

## Type — Manrope, with IBM Plex Mono for anything measured

| Role | Size / weight | Use |
|---|---|---|
| `nowPlaying` | 24 · 700 | full player title |
| `screenTitle` | 20 · 600 | Library, Profile headers |
| `rowTitle` | 15 · 600 | list rows |
| `body` | 13 · 400 | artist, counts, descriptions |
| `section` | 11 · 500, +0.07em, uppercase | section headers |
| `mono` | 11.5 · 400 | `1080p · mp4 · 84 MB`, progress, sizes |

Mono is reserved for facts a user could check — bitrates, sizes, durations,
percentages. Never for prose.

## Spacing, size, radius

```
4  icon→label      8  inside chip     12 row gap
16 screen gutter   24 section         32 header

tab bar 60   mini player 58   target 48
radius: art 10, chip 18, sheet 20, fab 28
```

## Motion

| What | Duration |
|---|---|
| tap feedback | 90ms linear |
| tab switch | **0ms — instant** |
| tint recolour | 420ms standard |
| mini → full player | 340ms emphasized |
| full → mini | 260ms standard |
| audio ⇄ video swap | 200ms crossfade |
| sheet in / out | 280 / 220ms |
| progress step | 240ms linear |

`standard (.4,0,.2,1)` · `emphasized (.2,0,0,1)`

The art transition is the only long one. Everything the finger causes resolves
under 300ms; the tint follows the artwork on its own schedule.

---

## The five tabs

`Home · Search · Browse · Library · Profile` — local first on the left, the open
web in the middle, everything owned on the right. **The mini player sits above
the tab bar on the four local tabs and never unmounts.**

It is deliberately absent on **Browse**. That tab is someone else's page at full
bleed, and the FAB is already one control of ours sitting on top of it; a second
would make the page feel framed. The cost is real and accepted: audio started
from the library has no visible transport while browsing, so pausing means
leaving the tab. Playback itself continues, and the lock screen still holds the
controls.

**Home** — Recently added (124px 1:1 cards), then On repeat (46px rows with play
counts). The green tick here is the only place a completed auto-download is ever
announced, and it appears **only where the rule did the saving** — a file the
user chose themselves never earns it, or the signal is spent on nothing.

On repeat is the real counter, most-played first, subtitled "3 plays · 41 min".
That makes it the honest answer to "is the tracking working?", which is why it
shows counts rather than a curated list. Its `more-vert` forgets the counts for
that video after confirming, and says plainly that anything already saved stays.

The four chips — All / Music / Video / Offline — **filter both lists**. They
shipped inert: highlighting on tap and changing nothing, which is precisely what
this design keeps refusing to do everywhere else. *Music* and *Video* split on
what the page was, not on what was saved from it, so a music page that has never
been kept still files under Music. *Offline* means already on the device, which
is every card (a card exists only once a file does) and the saved subset of On
repeat.

There is **no cast button** in the header. The mock has one; the player already
drops it because there is nothing to cast to, and keeping it here made the app
claim a capability in one place and deny it in another.

**Search** — the local index answers instantly. The cloud is a button
("Search YouTube for X"), never an automatic second query. Off-artwork screens
stay on the neutral base.

**Browse** — the site's own page, full bleed, our layout nowhere. On a feed the
FAB sits inert at `line` colour. On a watch page it wakes: filled, tinted,
pulsing three times. That state change is the only notice that something can be
kept.

**Tap and hold do different things.** A tap commits: it downloads whatever
*One tap downloads* is set to (Audio or Video) with no sheet, because the common
case is wanting this one the same way as the last one. A **three-second hold**
opens the format sheet, which also carries the Audio/Video control for what a
tap does — that question is only ever asked while the alternatives are on
screen. The button swells over the full three seconds and snaps back on release,
so the hold is never a guess about whether anything is happening.

The quality sheet belongs to this tab and **closes when the user leaves it**. It
is drawn above the tab container so it can cover the page, which otherwise lets
it hang over Library or Profile describing a video that is no longer on screen.
Nothing is lost by closing it: only picking a format starts a download.

The FAB carries its states with its own glyph each — `download` idle and ready,
`hourglass` resolving, `check` on `saved` green when the page is already a file,
`refresh` on `warn` when the last attempt failed. Colour alone is not enough
here: a user who taps and sees no glyph change reads the tap as lost.

**The button is not held for the length of a download.** A tap resolves the
format, puts the job on the download list, says *Added to downloads* in the
notice strip, and hands the button straight back. Holding it until the file
landed turned Browse into a queue of one: nothing else could be asked for until
the current song finished, on the one screen whose entire purpose is finding the
next thing.

So the browser no longer draws progress at all, and the `working` ring is gone
from it. A running download is reported in three places that outlive the page it
was started from — the row under *Downloading* in Library, the ongoing system
notification, and the green tick that appears on the FAB if the user is still on
that page when it lands. The old arrangement tied all three to a button that
stopped being about that video the moment they navigated away.

**Downloads are started one at a time.** `DownloadService` keeps a single
`currentId` and a single ongoing notification, so two at once means a card
flickering between them, a cancel button that stops whichever started last, and
— the one that actually loses files — the first job to finish sending
`ACTION_STOP` and dropping the foreground service out from under the rest. The
replay rule already ran on a serial chain for a different reason (an invisible
feature must never compete for bandwidth with the video being watched); the
browser's downloads now share it. A waiting row says **Queued** and draws the
queued glyph rather than a ring stuck at zero, which is the difference between
"waiting its turn" and "not working".

**Library** — in-progress on top (ring progress, mono percentages), everything
owned below. "Saved automatically" versus "You saved this" is the only trace the
auto-save rule leaves.

The bulk action reads **Cancel all**, not "Pause all", and a running row's
trailing control is a cross rather than a pause glyph. yt-dlp cannot resume a
half-finished job, so a pause affordance would promise something the engine will
not honour.

Failed downloads get their own **"Didn't finish"** group above the owned list.
They cannot sit under "On this device" — nothing was written, and the heading
carries a count of what is actually there.

Failure text names the stage that broke. A download that dies on a full disk
must never be reported as an extraction problem: that sends someone to the
engine row, which is the one control that cannot help them. Where the cause is
unrecognisable the copy names free space and connection rather than inventing a
third cause.

A saved row's `more-vert` **asks before removing**, and the dialog says the file
itself stays on the device. The glyph reads as "show me options"; making it
delete on the first tap turns an exploratory press into silent data loss, and
the row disappearing otherwise looks like the download was discarded.

### Playlists

A **Playlists** section sits between "Didn't finish" and "On this device", and
only on the **All** chip — a playlist is not audio or video, and hiding it
behind a filter that cannot apply to it would make the chips feel like they had
lost it. The section header carries **New**, in accent, the same shape as
"Cancel all" above it.

A playlist row draws a `queue-music` glyph rather than a cover. Picking the
first track's artwork would make the row change picture whenever the first track
did, which is a list that will not sit still.

**Opening one replaces the library body rather than covering it.** It is a place
inside the Library tab, not a modal, so the tab bar and the back gesture keep
meaning what they meant — back leaves the playlist before it leaves the tab. The
header becomes a back chevron, the playlist's name, and `more-vert`; underneath
sits the count in mono and a **Play** button, which is *absent* while the list is
empty rather than present and inert.

Inside a playlist the library's own controls are all wrong and none of them are
drawn: the sort cycler would offer to reorder the one list in the app the user
arranged by hand, and the filters would hide tracks they put there on purpose.

The row's sub-line is **"3 of 12 · Arijit Singh"**. Position leads here, where
the library row leads with how the file got there — inside a playlist the
position is the thing being arranged.

An empty playlist says where tracks come from: *Add tracks from the ⋮ menu on
any saved row.* It is the one place in the app that explains an action on a
different screen, because a glyph on another tab cannot explain itself.

**Reordering is Move up / Move down in the row menu.** A drag needs a gesture
handler over a scrolling list, and this is the half of playlists people complain
is missing — a control that works on the first tap beats one that works on the
third attempt at a long press. An end of the list does not offer the direction
it cannot go.

**A saved row's `more-vert` now names two answers** — *Add to playlist* and
*Remove from library* — where it used to open the removal confirm directly. With
something non-destructive to offer, removal stops being what the glyph does on
its own. Add leads, because it is the one that is not a one-way door.

### The library rebuilds itself from the gallery

The index is app data and Android deletes it with the app; a manual save is a
MediaStore record in `Music/Spool` and outlives every uninstall. So `scanSaved`
reads those two folders on launch and folds anything unknown back in — measured
on the phone as **43 items, 714 MB restored after a full uninstall**, artwork
included, because the covers come from the files' own tags.

Three things about it that are not obvious:

- **It runs again the moment first run grants media permission.** Reading files
  another install wrote needs `READ_MEDIA_*`, and the boot scan happens before
  the user has been asked for anything. Measured: 0 adopted on the first launch,
  43 on the next. A reinstalling user who taps through the notice and never
  relaunches would otherwise sit in front of an empty Library over a full
  folder.

- **Removals are remembered, or the scan undoes them.** The dialog promises the
  file stays and only the listing goes; the next scan would find that file and
  hand the row straight back. A list of removed uris is kept beside the library
  and every scan consults it.

- **Automatic saves cannot come back.** They live in app-private storage by
  design — hundreds of them do not belong in someone's gallery — and that is
  exactly the storage Android wipes with the app. Only what the user chose
  deliberately is recoverable, which is the right half to be able to recover.

A restored row has **no `videoId`**: nothing in a MediaStore row records which
video a file came from. It plays and lists, but it cannot tell the replay rule
it already exists, so a track returned to after a reinstall can be saved a
second time. Carrying the id would mean putting it in the filename the user sees
in their gallery, which is a worse trade than the duplicate.

A **failed** row's `more-vert` offers *Try again* first, then Remove. The row has
always named what went wrong; for a while the only thing it offered was to
forget it, so the answer to "the connection dropped" was to go back to Browse and
find the video by hand. The record already knows the video and what was asked
for. A retry replaces the failed row rather than stacking on top of it — a retry
that leaves its own failure sitting above the result reads as two failures.

The header's two glyphs do something. `swap-vert` cycles **Newest / Largest /
Title A–Z / Artist A–Z**, tinting and naming itself in mono while it is not on
the default; four options still do not earn a sheet.

**Artist A–Z is grouping, done as a sort.** An artist's tracks end up together,
which is the part of "group by artist" a person is actually asking for, and it
costs no second kind of row and no second empty state. Rows with no artist sink
to the bottom rather than sorting under the empty string, where they would sit
above every named row and read as a broken sort; title breaks the tie so one
artist's rows keep a stable order.

**A library row leads with the artist where one is known** —
`Arijit Singh · Saved automatically`. That is what someone scanning a music
library is reading, and it is what the sort has just grouped by. "Saved
automatically" versus "You saved this" moves to second place but does not go: it
is the only trace the replay rule leaves anywhere in the app. The quality gives
up its place instead — it is the least useful of the three on a row that already
carries a size, and it is still on the player and in the sheet.

**Search matches the artist as well as the title.** Typing "arijit" and finding
nothing in a library full of him reads as the search being broken, not as a
title-only search working correctly. The magnifier goes to the Search tab, which is
the screen for this and already searches the same library.

A running row never shows "100%". yt-dlp reports the stream complete before
ffmpeg has remuxed, which on a long track leaves many seconds of a row claiming
to be done. Past 99.9% the row says **Finishing** instead, and only leaves the
section when the file is actually written.

**Profile** — the whole auto-download rule is one card: a switch, a play-count
control, a Keep-as segmented control (Audio / Video / Match), and two quality
rows. "Match" keeps audio for music pages and video for everything else.

The play count is **three discrete steps (2 / 3 / 5)**, not the continuous
slider the mock shows. The rule is discrete; a smooth track would imply that 4
is selectable when it is not.

The helper text states the real threshold — *"A play counts after five seconds
of watching"* — not the "reaches the end" the design originally promised. The
counter has never measured completion, and a settings screen describing a rule
the code does not run is worse than one that says nothing.

**Keep as** decides what the rule saves: Audio, Video, or Match. *Match* keeps
audio when the page supplied real music metadata (a `mediaSession` artist, or
`music.youtube.com`) and video otherwise. That signal is deliberately kept apart
from the channel-name fallback used for display — otherwise every upload would
look like music.

`instant` (one tap) and `keepAs` (the rule) are **separate settings on purpose**.
Wanting video when you ask and audio when the app decides is an ordinary pair of
preferences, and collapsing them into one would force a choice nobody made.

**One video, one row.** The rule skips anything already saved by hand, and a
manual save drops any earlier row for the same video. This is not tidiness: both
paths write to the same output file, and publishing to the gallery *moves* it —
so manually saving something already kept automatically deletes the file the
older row points at, leaving a library entry that plays nothing. Observed as an
`ENOENT` on skip; the row looked perfectly healthy.

**Automatic saves never publish to MediaStore.** A manual save belongs in the
gallery; hundreds of automatic ones do not, so they stay app-private and play
from a `file://` path. They also run **one at a time** — an invisible feature
must never compete for bandwidth with the video the user is currently watching.
A failed automatic save is still recorded, and the video stays marked as taken:
believing you have a file you do not have is bad, but a retry loop that
re-downloads on every play is worse.

**Both quality rows open a picker**, and both are ceilings rather than demands —
"the best rung at or below this". Video quality is the load-bearing one: it is
what one-tap downloads and the replay rule actually fetch. Both rows carried a
chevron and went nowhere for a while, which left the user pinned to 1080p with a
control that looked like it should move. Audio quality was worse than inert:
`bestAudio` ignored it outright, so the setting described a behaviour that did
not exist even in principle.

An unreadable audio setting means **no ceiling**, not the lowest rung. "Best
available" is the default, so a parse failure has to fail upward — quietly
capping someone's audio because a string did not match is the one outcome they
would never trace back to this screen.

The **Extraction engine** row shows the real version from the native module and
updates in place on tap. It said "up to date" unconditionally before, including
on a build whose extractor had just failed three times in a row — and the format
sheet's *Update engine* button sent people to this screen, where nothing could be
pressed. A sideloaded app gets no store updates, so in-place repair is the only
path there is.

There is **no "Playback & network" row**. It read "Wi-Fi only" and nothing
enforced it: the connection type needs a native probe this build does not have.
Same rule as the meter below — the app may not assert a policy it does not run.

The storage meter draws **only when device capacity is actually known**. Reading
it needs a native `StatFs` call that does not exist yet, so today the section
shows the library's real size as text and no bar. A meter is the one control on
this screen that looks like a measurement, so it may never be drawn from a
guess — an empty space is honest, a filled bar is not.

## What a row is called

Names are cleaned once, where they enter the app, and every surface reads the
result — the row, the sort, local search, the mini bar, the media card, and the
filename in the user's gallery. See [FEATURES § Names](FEATURES.md#names) for
the passes and why each is safe.

Two things about it are visual decisions rather than parsing ones:

- **The row keeps anything that names a *version*.** "(Acoustic)", "(Live Aid)",
  "(feat. Shreya Ghoshal)" and "(Remastered 2011)" all survive, because a
  listener scanning a library is using exactly those words to tell two rows
  apart. Only what describes the *upload* — "Official Music Video", "4K",
  "Full Song HD" — comes off.
- **A name is never invented to fill a gap.** Where the artist is unknown the
  sub-line stays empty and falls back to "Spool", as it always did. A guessed
  attribution is the same mistake as a storage meter drawn from a guess: a fact
  the user can check, asserted by an app that does not know it.

## Mini player — four states, 58dp

The sub-line is the **artist**, and for a long time it was the quality string —
so every row and every notification said "audio" where a person's name belongs.
It comes from the page that was watched, copied onto the record at save time and
read back out of the play index for anything saved before the field existed.
Where nothing is known it falls back to "Spool" rather than inventing one.

| State | Art | Tint | Sub-line |
|---|---|---|---|
| audio | 40×40 square | from cover | artist |
| video | 62×36 16:9 | from cover | artist, live frame while playing |
| buffering | spinner, 900ms | holds previous | "Buffering" |
| missing | flat placeholder | neutral | "File is missing" in `warn` |
| page | 40×40 square | from thumbnail | artist, or **"YouTube"** |

### The bar carries the browser too

The notification has always drawn both sources; the bar only knew about files,
so leaving a playing video for Library left the user with no transport anywhere
on screen — the FAB is Browse-only and the bar was empty. It now draws a page as
a fifth state, on the same four local tabs, still never on Browse.

Square art, because the source is being *listened* to; the wide shape belongs to
a local video the full player can actually put on screen. The sub-line falls back
to **"YouTube"** — the same word the card appends after the artist, and the only
thing on the bar that says this is a page rather than a file.

**A playing page outranks a paused library track.** Under `doNotMix` only one of
them is audible, and showing the paused track would put a play button on the bar
that stops the sound the user can hear when they press it. Otherwise the local
session wins: it has a queue and a full player behind it. A paused page ranks
last and shows only when there is nothing else, so that wandering off to Library
still leaves a way back to the video.

**Tapping a page goes to Browse, not the full player.** There is no queue and no
second shape to switch to; the player would be a screen with nothing on it.

**Play works from here and does not from the notification.** The bar exists only
while the app is on screen, so the page is a visible document and is allowed to
start media. The card has no such guarantee — see `PLAY_GRACE_MS` and the
"a hidden page cannot be made to resume" rule.

The page's state reaches the bar through a small store rather than screen state:
the page reports about once a second, and re-rendering a fifteen-hundred-line
screen on every tick to move a 2dp line is the cost that buys.

A 2dp progress line sits at the top edge, `rgba(0,0,0,.35)` track with the
accent as fill. The warn state shows warn *text only* — no colour flood, no
dialog.

The fourth state was **unreachable until it was reworded**. Its tone was computed
as `loading ? 'dim' : 'dim'`, so warn text never appeared however badly playback
was going. It is no longer "Paused · no connection": Spool plays files off this
device, a local file does not stall on the network, and blaming the connection
would send someone to check their Wi-Fi over a file that is simply gone. That
failure is real and has been observed — publishing to the gallery *moves* the
file out from under a row that still lists it.

## Full player — one session, two shapes

A toggle at the top switches between a 320px square of artwork and a 202px 16:9
frame. **Position, queue and buffer are shared** — the swap is a 200ms
crossfade, not a reload. The transport stays put so the toggle never moves the
play button; in video mode the queue takes the space the cover gave up.

### As built

The **shape toggle appears only for a video track.** An audio file has no
picture to switch to, and a control that is present but inert is the thing this
design keeps refusing to ship. Switching to audio hides the frame; it does not
reload or re-fetch anything.

**Omitted from the mock, deliberately:** the like/dislike counts, the share
chip and the cast button. Those are YouTube's — we have no like count to print
and nothing to cast to, and printing "48K" next to a thumb we cannot verify
would be inventing data. If casting or sharing lands later they come back.

**Everything else is real, because there is now a queue behind it.** Playing a
library row starts the whole library from that point, in the order shown.
`skip`, `previous` (which restarts the track when more than 3s in, as every
other player does), auto-advance on finish, repeat off/all/one, and the *Up
next* list all read from it.

**Shuffle reorders the queue rather than randomising each pick**, and only what
is still ahead. Choosing at random would leave *Up next* naming a track that is
not going to play next, and that list is the only promise the screen makes about
what happens after this one.

The header's `more-vert` removes this track from the library, through the same
confirm as any list row. It was the last inert control on the screen.

**The cover is real**, and so is the tint it produces. See "Artwork" below.

### One player, not one per track

The audio engine is **reused across the queue** — `replace()` on the existing
player, never remove-and-recreate. Only one player may own the lock screen, and
under `doNotMix` that ownership *is* the audio session. Standing up a fresh
player for the next track loses the handoff in a way that looks like nothing at
all: the new track reports the right duration, seeks correctly, and never makes
a sound — and `play()` afterwards does nothing either. Measured on a queue skip.
The video path had always reused its player for the neighbouring reason.

Source (local file or stream) is never surfaced. Only the tick in the title row
hints at it: `saved` tick when on disk, `downloading` glyph while fetching.

No tab bar — the player is a sheet over the tab it was opened from, and swiping
down returns you there.

### Lyrics are a control until they are content

A **Lyrics** section sits between the transport and *Up next*. Before anything
has been looked up it is a single accent row — *Look up lyrics* — because
nothing is fetched until it is pressed, and a section that quietly went and
asked would break the rule the Search tab already keeps.

After that it is one of four things, and they are deliberately distinguishable:

| State | What is drawn |
|---|---|
| looking | `Looking…` in dim |
| found, synced | the current line and three either side |
| found, unsynced | the plain text, as a block |
| none | `No lyrics for this track.` in mute — and it stops offering |
| could not ask | *Could not reach lyrics — try again*, still offering |

**"There are none" and "we could not ask" are different states and must stay
different.** One is an answer and the button goes; the other is a dead moment on
a train and the button stays.

**A window, not a scroller.** The page is already a `ScrollView` and a second
one inside it fights the first for the same drag — so a synced lyric draws the
current line and three either side, which needs no auto-scroll to stay on the
right line and no scrolling to fight the user's thumb. The current line is
`rowTitle` on `on`; the rest are body on `mute`. An empty stamp — the gap
between verses — draws as `·` rather than collapsing, so the window does not
jump.

### The sleep timer is a receipt, not a row

There is **no "Sleep timer: off" row** anywhere. The way in is the full player's
overflow; the armed state is a single mono line under the transport —
`Sleeps in 12 min`, or `Sleeps at the end of this track` — in accent, with a
`bedtime` glyph, and tapping it reopens the sheet to change or cancel.

Mono, because minutes remaining is a fact the user can check. Counted in whole
minutes rounded **up**, so the last sixty seconds read "1 min" rather than
"0 min": a countdown that reaches zero and keeps playing reads as a broken
promise.

Nothing is drawn while nothing is armed. A control that only labels its own
absence is the chrome this screen does not have.

### Continuity rules

| Event | Behaviour |
|---|---|
| tab switch | audio keeps playing; video keeps playing in the mini frame |
| app background | audio continues under the notification; **video drops to audio** |
| local ⇄ stream | a finished download swaps in at the next gapless boundary |
| browse tab | opening a video in the web view pauses Spool's own player |
| kill | position and queue restore on next launch, **paused** |
| renderer killed | the page is rebuilt where it was; the card goes, playback does not resume |

**The renderer is a process the app does not own, and Android reclaims it.** The
WebView's renderer is sandboxed and separate, and while the app is off screen it
is among the first things freed under memory pressure. Android's contract is
that the WebView instance is then dead forever — it will not repaint, navigate
or reload — so the only recovery is to build a new one, which is why the WebView
carries a `key` that changes on exactly this event and nothing else. Its
`source` is a separate `entry` value for the same reason: bound to the live URL
it would reload the page on every navigation.

Reported as: playback stopping while the app was away, and the page sitting on
a loading spinner when it was reopened. Before this the event was unhandled
entirely — react-native-webview swallows it so the app does not die, and the
dead WebView simply stayed on screen.

The card is released **first**, before anything else in the recovery. Someone
who is not looking at the app is looking at the shade, and until it goes that
card shows a title, a moving scrubber and a pause button for a video that no
longer exists. Playback deliberately does not resume: a hidden document may not
start media without a gesture, so silence and the page waiting where they left
it is the honest outcome, and pretending otherwise is the failure this book
keeps naming.

**Browse pausing the local player** ran in one direction only for a long time —
starting a library track stopped the page, but starting a page video over a
library track simply layered the two. Getting the other direction right took
three attempts, and each failure was silent:

1. Keyed on the page *starting* something, not on it merely being playing. The
   page reports once a second, so `if (message.playing)` also fires on a report
   sampled just before our own pause reached the page — pausing the library
   track the user had that instant started, from the very tap that started it.
2. **Only while the user is on Browse.** The WebView never unmounts, so a hidden
   page can resume by itself, and that read as a fresh start and stopped a track
   playing on the Library tab. When something starts in a tab the user is not
   looking at, the thing to stop is the page.
3. **The page must be silenced on every local play, not just new tracks.** See
   below — this was the one that actually broke playback.
4. **Only when something local is actually playing.** Guard 2 stops the page
   whenever it starts something outside Browse, and a Mix advancing to its next
   track *is* the page starting something. So with the user parked on any other
   tab and the phone in a pocket, every track boundary silenced the queue — the
   rule against two things playing at once, firing with nothing playing at all.
   Mutual exclusion needs something to exclude; with no local sound there is
   nothing to protect and the page is left alone.

### The playback gate

`setPlaybackGate` on the player context registers one callback, run immediately
before this app makes any sound. The shell registers "pause the browser page".

It is central rather than per-call-site because there are several places that
start playback — a library row, a Home card, the mini bar, the full player, a
queue advance — and the one that was missing its pause was invisible in code.
`playRecord` silenced the page only when starting a *new* track and returned
early when resuming the loaded one; the mini bar and the full player never had a
route to the WebView at all.

The symptom was not silence, which is why it survived review: under `doNotMix`
our player takes exclusive audio focus, and a WebView still holding it takes it
straight back. Measured, the track resumed for about 90ms and stopped — the
media session went `PLAYING` at 24306, then `PAUSED` at 24306. From the outside
that is "the play button does nothing", and nothing in the logs disagrees.

**Resume comes back paused.** The queue and playhead restore; the sound does not
start on its own. An app that begins playing because it was opened is a different
and worse app.

The session is written **every five seconds**, and stores download ids rather
than tracks — a kill is never announced, so there is no save-on-exit to rely on,
and resolving ids against the library at boot is what stops a row deleted in the
meantime restoring as a queue entry that plays nothing. The cost of the interval
is bounded and known: at most five seconds of replay.

### Every play button goes through the context

`togglePlayback` on the player context is the only way any surface may start
audio. Not a convenience — the lock screen is claimed on **first play** rather
than on load, so that restoring a session at launch does not put a paused
notification in someone's shade uninvited. A surface that calls `play()` on the
player object it happens to hold skips that claim, and the result is audio that
sounds perfect and has no controls attached, which is exactly the state Android
kills a few minutes after the app is backgrounded. Measured: after a restore, the
media session came up `state=PLAYING` with `metadata: size=2, description=null`.
Routing both the mini bar and the full player through the context restored it to
`size=4` with the real title.

---

## The pre-release build

A build cut for testers carries three limits — **seven days from the moment it
was built, twenty saves, and nothing longer than three minutes** — and says so
in three places, never more.

**The chip.** `TRIAL · 6D` in the header of Home, Library and Profile. Mono,
because days remaining is a fact the user can check and mono is reserved for
exactly those. It turns `accent` on the last day; that is its only state change.
Tapping it opens the sheet, because a label that only labels would be the one
inert control in a design that forbids them. It is **absent from Browse** — that
tab is someone else's page at full bleed and carries none of our chrome, a rule
the trial does not get to break for being important — and from Search, which has
a field where the other four have a title.

**The sheet, once per cold launch.** Not once ever: the build stops working on a
date, and a tester who never reads why reads "it broke" instead. It states what
the build is, the three limits as mono facts, and the offer. After expiry the
same sheet changes its title, empties Time left, and relabels its dismiss.

On a **brand-new install it is deferred, not skipped** — first run owns the
screen, and stacking the sales pitch on the legal notice would be two modals for
a user who has seen neither. It is raised the instant first run is dismissed,
in the same session. Suppressing it on `!seen` and leaving it there is the
obvious reading of "legal notice first" and it is wrong: a tester installs, taps
through once and may never cold-launch again, so the one launch that decides
whether they understand what they have been sent is exactly the launch that
would show them nothing.

**A refusal, at the moment of refusing.** The FAB path says why in the notice
strip — warn-coloured text sitting directly above the FAB that was tapped, never
a dialog. The automatic rule says nothing at all and simply declines — it has no
interface anywhere else and does not get one here — and it leaves the video
unmarked so a full copy picks it up later.

**The strip has to actually be rendered, and for a while it was not.**
`flashNotice` set a `notice` state that nothing in `BrowserScreen` ever read: the
only `notice=` prop in the file goes to `LibraryScreen` and carries a different
expression entirely. So every refusal was computed, worded and discarded. What
the user saw was a download button that did nothing at all — no message, no
progress, no failed row — and because the pre-release caps videos at three
minutes, nearly every music video is over the limit, so the *common* case looked
like a broken extraction engine rather than a trial limit.

Measured on the phone: a 5:05 video ran extraction (`client accepted: android_vr`)
and then stopped dead with no download token and nothing on screen, while a 0:47
video from the same session saved normally. Twenty view-tree polls over 25
seconds found no notice text at any point.

Two things follow, and the second is the one that generalises. A write-only
state is invisible to the type checker and to every test that does not drive the
real screen — so anything that exists only to be *said* to the user has to be
traced to a rendered node, not to the call that composes it. And a limit whose
refusal is silent is indistinguishable from a bug in the thing it is limiting.

### Pricing copy is held to the same standard as everything else

The offer reads **"A full year for ₹399 … the price at launch is expected to be
₹999"**. Not `~~₹999~~ ₹399`. Nobody has ever paid ₹999, so striking it through
would be inventing a fact to make a discount look bigger — which is the same
rule that keeps a storage meter off Profile until a native `StatFs` call exists.

### Where it is enforced, and where it is only described

`src/core/trial.ts` **describes** the trial. `TrialGuard.kt` **enforces** it. The
split is not tidiness: TypeScript ships as Hermes bytecode inside the APK it
would be guarding, so a patched bundle would produce a UI that lies and a native
layer that still refuses. Every limit is checked twice, and the second check is
the one that decides.

---

## The media notification — the app's fifth surface

Spool is used with the screen off more than with it on, which makes the shade
card the surface the user actually operates. It is modelled on Spotify's,
because that is the shape Android users already know:

```
┌──────────────────────────────────────────────┐
│ ♪  Phone speaker                             │   ← system, from having a session
│                                              │
│  Khairiyat 8K — BONUS TRACK                  │   ← title
│  Arijit Singh · On this device               │   ← artist · source
│  ●──────────────────────────────             │   ← draggable
│  00:10                                 03:45 │
│         ⏮        ⏸        ⏭                  │
└──────────────────────────────────────────────┘
        the artwork fills the card behind it
```

**One card, two sources.** The local player and the browser's own `<video>`
share it — see `src/player/nowPlaying.ts`. Whoever is playing owns it; a source
that is silent may update the card it holds but may not take one from a source
that is not. Both halves publish through the same arbiter, so the card never
describes two things at once.

**The source label is the one thing the layout adds to the reference.** Android
13+ gives a media card no line of its own, so it rides on the second line after
the artist — `Arijit Singh · On this device`, or `YouTube` for a page. It is not
decoration: a page and a saved file behave differently under the same buttons,
and once the phone is in a pocket this is the only thing that says which is
which.

**Controls appear only where they are real.**

| | local | browser |
|---|---|---|
| play / pause | yes | yes, but see below |
| previous | when the queue has more than one track, or past 3s | no |
| next | when there is a next track, or repeat is `all` | no |
| scrubber | yes | yes |
| save | no | when the page is not already a file |

Skip is absent for a page because advancing a Mix means clicking YouTube's own
up-next button, which the app cannot reach reliably — a control that is dead
exactly when it is wanted is worse than an absence. The scrubber *is* there
because the page reports a real length and a real playhead, and dragging it
sets `currentTime` on the element like any other seek.

**Save is the card's only non-transport control, and the only download path
with no screen behind it.** It exists because the shade is where this app is
actually operated: the phone is in a pocket, something good is playing, and
taking it out, unlocking it and finding the FAB is most of the reason a person
does not bother. One tap on a surface already in front of them is the whole
feature.

It is absent — not disabled — for a library track, which is already the file a
save would produce, and for a page whose download has finished or is still
running. That second case is not tidiness: extraction takes seconds during
which the button is still on screen, and a second tap would start the same
download twice with nothing anywhere to say so. `Job` carries a `videoId` for
exactly this test.

Quality comes from the Profile defaults, because there is no sheet to ask with
— the same defaults the replay rule uses. Unlike the replay rule, this **does**
publish to the gallery (it is a deliberate save, and manual saves belong there)
and does **not** mark the video as taken by the rule (a save from the shade
should not spend someone's third play).

Nothing is acknowledged on the card. The download raises its own ongoing
notification, the row appears in Library, and the save button disappears on the
next report — three signals already, and a toast would be a fourth saying the
same thing. A failure is written to Library as a failed row rather than
swallowed: the user is not looking at the app, and the alternative is finding
out much later that a file they believed in was never there.

> Android 13+ builds this card from the session's `PlaybackState`, so Save is a
> **custom action** on the state, not a notification action. A notification
> action is added alongside it for Android 12 and older — the same split the
> transport controls use. A button added only to the notification is not drawn
> on modern Android at all, which is the trap this whole section exists to warn
> about.

**A YouTube feed does not get a card.** The home feed autoplays a preview clip,
and one that comes up unmuted looks exactly like playback. Raising for it put a
card titled "YouTube" over whatever the user actually had on. No video id, no
card.

**Artwork is the same artwork.** A library track uses its cached cover; a page
uses its thumbnail, resolved through the same native decoder under a `yt:` key
so a saved file's own embedded cover still wins for the file. Android colours
the whole card from it, which is the artwork-is-the-interface rule reaching one
surface further than the app itself.

**Pausing from the card always works; resuming does not, and the card must not
pretend otherwise.** While the app is off screen the page is a hidden document,
and a hidden document may not start media without a user gesture. The card
reflects a pause immediately and a play only once it has actually happened. See
AGENTS.md — this is the failure the "no control that does not do the thing it
appears to do" rule looks like in the shade.

---

## Artwork — where the tint actually comes from

The first rule in this book is that the artwork is the interface. This is the
machinery that makes it true, and the shape of it is a deliberate refusal.

**Only the hue is borrowed.** Lightness is fixed and saturation is clamped, per
step of the ramp — `deep` is always L11, `tint` L19, `accent` L72, `on` L94,
`onDim` L67, and `onAccent` is `deep` exactly. That is how the three fixtures
above were built by hand, and reproducing the recipe rather than sampling more
colours out of the image is the entire safety argument. A palette taken wholesale
from a cover is unreadable about as often as it is beautiful: one dark album and
the body copy is grey on grey, and nobody finds out until a user does.

So the cover moves the hue, and within limits the intensity. It never decides how
dark the ground is or how bright the text is.

**A grey cover gets a grey app.** Near-neutral artwork bypasses the saturation
floors entirely rather than arriving at them with s=0 — clamping 0 into [45,70]
is how a black-and-white photograph came out pink, which the sweep below caught
and no amount of looking at the code would have.

**The guarantee is measured, not assumed.** `tintFromDominant` computes the WCAG
ratio and lifts `on`/`onDim` in 4% steps if either falls short. Swept over 1805
sampled colours — every hue at five saturations and five lightnesses, plus pure
black, white and greys — the worst ratios are **13.55** for `on`/`deep`, **6.80**
for `onDim`/`deep`, and **5.86** for `onAccent`/`accent`, against a 4.5 floor and
zero failures. The hand-checked fixtures sit at 14.68 / 7.21 / 10.07, so generated
tints land in the same band as the ones a person chose.

**Where the image comes from**, in order of honesty:

1. the downloaded file's **own embedded cover** — the only source that is true
   offline. Downloads now pass `--embed-thumbnail` so this is the normal case
   going forward;
2. the **YouTube thumbnail URL**, which is what makes any of this work for a
   library saved before embedding existed.

**Black bars are cut off before anything is cached.** YouTube's 4:3 thumbnail
sizes — `hqdefault` and `sddefault` — pad 16:9 video with black, and yt-dlp will
happily embed one of those as the file's cover. The bars are *inside* the image,
so no amount of `resizeMode: cover` removes them: the player showed a 640×480
cover with a band top and bottom. A native trim scans inward for rows that are
uniformly near-black and crops them, which took that same cover to 640×360.

It is done by trimming rather than by picking a better URL because it also fixes
art that came out of the file's own tags, where there is no URL to pick. The URL
list is still ordered by *shape* first — `maxresdefault`, then `hq720`, then
`hqdefault` last as the only one guaranteed to exist — so the trim is a safety
net rather than the primary mechanism. Two dark rows are a dark photograph, not
a letterbox: the crop only applies past a threshold, and never takes more than
half the frame.

**Covers are re-encoded, never stored as they arrive.** yt-dlp embeds the maxres
thumbnail, so the raw bytes are ~1.8MB per item — measured — and a few hundred
of those would put half a gigabyte of cover art in the cache to fill a 320dp
square. Each is decoded to a 640px short edge and written back at JPEG 85: the
same cover went from **1,822,804 bytes to 37,625**, a 48× reduction, with nothing
visible lost at any size the app draws.

**Resolved once, then remembered** — in memory, in an in-flight map so eight rows
appearing together make one native call rather than eight racing writes, and in
AsyncStorage so a relaunch never re-decodes. **Failures are remembered too:**
an item with no artwork anywhere would otherwise be retried on every render, and
for a library saved from pages that have since gone, that is a network call per
row per launch.

**Three at a time, no more.** Boot hands the whole library over at once, so
without a limit a first run against a few hundred saved items opens a few
hundred simultaneous connections to fill rows nobody has scrolled to. Three
fills the visible rows immediately and never competes with a download.

**An item with no cover anywhere keeps the glyph, permanently, and that is
correct.** Downloads saved before the record carried a `videoId` have no
thumbnail to ask for, and their files predate embedding, so both sources are
genuinely empty. Recovering them would mean searching YouTube by title — an
automatic cloud query, which this app does not make. They fill in if re-saved.

**Only the playing item tints the app.** Not the last one browsed. A theme that
follows the finger rather than the sound turns scrolling a library into a light
show.

Both sources are exercised in practice: a fresh download resolved its cover from
the `covr` atom in its own m4a, and the same item — with the file deleted out
from under it — resolved the identical cover from the thumbnail URL instead. A
failed fetch logs the reason natively (`Unable to resolve host` is what a dead
connection looks like here) rather than disappearing into a silent `null`.

Covers land after first paint, which is exactly why the placeholder glyph has to
stay good-looking — it is not a loading state, it is the resting state for
anything the app could not find a cover for.

---

## The download rule

The FAB is the manual path **inside the app**, and lives only in Browse. The
media notification's save button is the manual path from outside it — same
deliberate act, no screen, Profile-default quality; see the notification section
above. The automatic path has no interface at all until the file is on the
device.

- **Play 1 and 2** — nothing. No badge, no counter, no hint anything is counted.
  What counts as a play is defined once, above: **five real seconds of unmuted
  playhead movement**. (An earlier draft of this section said 90% of the
  duration. Nothing ever measured that, and it contradicted the section this
  book already had — the five-second rule is the one in the code.)
- **Play 3** — queued at the Profile quality. Still nothing on screen; it runs
  behind the session that triggered it and never interrupts playback.

  It is **not** held for Wi-Fi, and this section used to say it was. Reading the
  connection type needs a native probe this build does not have, so the promise
  had nothing behind it. A Profile row asserting "Wi-Fi only" has been removed
  for the same reason — see Profile below.
- **While it runs** — visible in Library under Downloading, and in the ongoing
  notification if backgrounded. The player shows a small `downloading` glyph.
- **Done** — a green tick appears on the row, wherever that row is. If the item
  is playing, the stream is swapped for the file at the next boundary,
  inaudibly. Cover art is written into the file's tags so the library looks the
  same offline.
- **Out of space** — automatic saves stop first and say so once, at the top of
  Library. Manual downloads keep working until the disk genuinely cannot take
  them. **Nothing is ever deleted without a tap.**

### FAB sheet

Three picks and a door to the rest ("All 14 formats"). The Profile default is
**labelled** ("your default") rather than pre-selected, so the tap is always
deliberate.

### Nothing is downloaded twice by accident

Two different confidences, deliberately handled differently.

**The same video is certain, so the button simply stops offering.** A page whose
`videoId` is already a saved row shows the FAB in its `done` state — `check` on
`saved` green — and a tap opens Library instead of downloading. This is derived
at render rather than stored, because the stored state has to fall back to
`ready` after a save (the tick is held, then released) and an already-saved page
must not start offering itself again the moment that reset lands. Deriving also
covers the slow case: the library loads after boot, so a page opened straight
away is `ready` for a moment before its own row arrives.

The cost of getting this wrong is not a tidy list — it is orphaned files. Both
paths write one output file and publishing to the gallery *moves* it, so a second
save leaves a `Title (1).m4a` in the user's music alongside a row pointing at the
file the first save already consumed. Observed on the test device as three
`Mujhe Pyaar Hua Tha …` files, `(1)` and `(2)` included.

**The hold stays live in that state, and that is not an oversight.** Keeping the
video after keeping the audio is an ordinary thing to want, and it is one
three-second press away. Only the accidental second *tap* is worth refusing.

**A repost is a guess, so it warns rather than blocks.** YouTube carries the same
recording under a dozen names — "Kaisi Teri Khudgharzi OST" and "Kaisi Teri
Khudgharzi | Music Video | Danish Taimoor | Pakistani Drama OST" are one song
with two ids — and nothing in the metadata proves it. So `src/core/similar.ts`
strips the packaging vocabulary ("official", "full", "4K", "lyrical", bracketed
asides) and compares what is left, corroborated by runtime.

The warning names what it matched — *Similar already downloaded: "…" · 3:22* —
because "similar already downloaded" alone asks the user to trust a guess they
cannot check. Given the title and the runtime they can tell in a second whether
it is right.

On the tap path it appears in the notice strip, and **the first tap explains
while the second one commits**. A warning that does not hold the download is a
toast, and the tap that follows it saves the duplicate anyway; a dialog is the
thing this design refuses everywhere else. Arming a confirmation for the current
page is the middle path, and it disarms on navigation, so the next page argues
its own case.

**In the sheet the same sentence is drawn inside the sheet, not in the strip.**
The strip is pinned above the FAB and the sheet is a `Modal` that covers it
completely, so a warning left there is drawn underneath the thing it is warning
about — the same "composed and never seen" failure as the refusal notice above,
one surface along. It sits over the picks in warn colour, beside the storage
note and before it, since which file you are about to duplicate outranks how big
it is. It carries no invitation to tap again: reaching the sheet took a
three-second hold and picking a format is another deliberate act, so all it is
owed is the fact.

**Two measures, because one was not enough.** Containment (shared words over the
shorter title) is what catches a repost that appends the cast and the channel.
On its own it also matches any name that is a substring of another — "Tum Hi Ho"
sits wholly inside "Tum Hi Ho Gaya Hai Tujhko To Pyar Sajna", which containment
calls perfect and a listener calls two songs. So where runtime corroborates,
containment is trusted; where it does not, the titles must be close in size as
well. A full song and its thirty-second teaser share every word and are
separated by runtime alone, which is why runtime is carried on the record at all.

**It also covers what a reinstall destroys.** A row rebuilt from the gallery has
no `videoId` — nothing in a MediaStore record says which video a file came from
— so the exact test cannot see it. Title and runtime survive in the file, so the
weaker test is the one that still works after the stronger one has lost its
evidence.

---

## Copy rules

- "Saved automatically" / "You saved this" — the only trace of the rule
- "the cloud is never searched without a tap"
- Legal position stated once on first run and again under Profile: built for
  your own uploads, Creative Commons and public-domain material, and personal
  offline use where local law allows it.

## What the design deliberately does not do

- No badges, counters, or progress hints before a download exists
- No dialogs for network failure — warn-coloured text in place, nothing modal
- No indication of whether playback is local or streaming
- No automatic cloud search
- No deletion without an explicit tap
- **No control that does not do the thing it appears to do.** This is the rule
  the others are instances of, and it is the one most often broken by accident:
  a chip that highlights and filters nothing, a chevron with nowhere to go, a
  glyph for a capability that does not exist, a row asserting a policy no code
  enforces. Each arrived as a plausible placeholder. Wire it or remove it — a
  control that lies costs more than an absence, because the user changes their
  behaviour around it.
