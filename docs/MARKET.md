# What listeners want, and what they complain about

**Researched 2026-08-19. This is not a knowledge book.** Every other document in
`docs/` describes Spool; this one describes the market Spool is walking into. It
goes stale in a way the others do not — treat anything here as a claim about
August 2026, not a standing fact.

## How this was gathered, and where it is weak

- Reddit is not reachable by the tooling, so the largest single pool of candid
  user complaint is missing. Everything below is corroborated from at least two
  other kinds of source.
- Most "top features for a music app in 2026" articles are SEO filler written to
  sell app development. They agree with each other because they copy each other.
  They are used here only for what is uncontroversial (the table-stakes list).
- The strongest signal is **GitHub issue trackers of open-source Android players,
  sorted by reactions.** Those are real users voting with the only currency they
  have, on apps that already do the basics.
- The second strongest is **vendor community boards**, where the same request is
  filed hundreds of times over years.

---

## 1. The complaints, ranked by how loud and how universal

### 1. Playback dies in the background

The most cross-cutting complaint in the entire category, and it is not
app-specific: OEM battery optimisation kills audio minutes after the screen goes
off. Xiaomi stops playback 4–5 minutes after screen-off; Samsung kills it the
instant the app is swiped from Recents; a Pixel 6 with the app explicitly set to
"unrestricted" still stopped on backgrounding. Jellyfin, Spotify, YouTube Music
and every patched client carry long-running issues for it.

The standard user-facing answer is "go into Settings and disable battery
optimisation for this app", which is an admission of defeat dressed as support.

### 2. Shuffle is not shuffle, and the player does not obey

Spotify's loudest and longest-running complaint, filed as an idea over and over
since at least 2021 and still open. Users with 700+ track playlists report
hearing the same 40–50 songs; the algorithm favours recently added and recently
played. The ask is stated the same way every time: **a true shuffle that plays
every track once, then reshuffles.**

The generalised form of this complaint is bigger than shuffle: *the app decides
and I cannot make it stop.*

### 3. The feed is polluted, and the controls that should fix it do nothing

YouTube Music subscribers report recommendations filling with AI-generated
tracks by artists with enormous catalogues and generic names. Thumbs-down and
"Not interested" do not stick — the same synthetic artists resurface across
mixes and autoplay. Deezer has said 44% of new uploads to its platform are
AI-generated.

Adjacent, same root: podcasts and videos in a music app users only want music
from, with no filter to remove them.

Note the direction of travel — Android Authority's own conclusion is that this
pushes people toward **building offline libraries instead**. That is Spool's
thesis arriving from the outside.

### 4. Ownership anxiety — things vanish

- Tracks disappear from streaming catalogues over licensing disputes.
- Versions get swapped underneath you: remasters replacing originals, edits and
  remixes going missing.
- **Playlists lost on reinstall** is a recurring support-forum genre across
  Apple Music, iTunes, Samsung Music and third-party players — sometimes the
  playlist names survive with no tracks inside.
- Apple Music playlists live on Apple's servers and cannot be backed up locally
  at all; enabling Sync Library replaces the local library with the iCloud one.

The ask: export to something portable (M3U, CSV, JSON), and a library that
survives a reinstall.

### 5. Subscription fatigue, and it is now annual

Spotify raised US prices again in January 2026 (to $12.99), the third increase
since mid-2023, and the annual cadence is itself the complaint — users now
review the subscription every year. Community threads read as value disputes:
paying more for AI features and lossless nobody asked for. Meanwhile downloads
are 2.8% of the market and stubbornly not dying, vinyl did $1.04bn in 2025, and
Gen Z — supposedly the generation indifferent to ownership — downloads files for
music it actually cares about.

### 6. Local players: the same six missing features, everywhere

From the issue trackers, ranked by user reactions:

| Ask | Evidence |
|---|---|
| **Playlists** — create, reorder, import/export | Auxio's #1 and #4 issues by reactions; the top complaint in Play Store reviews of small offline players is "cannot reorder or remove tracks from a playlist" |
| **Gapless playback** | Auxio #3; treated as table stakes in every roundup |
| **Volume normalisation / ReplayGain** | RetroMusic's top-voted feature request |
| **Liked songs / favourites** | Auxio #5 |
| **Per-track artwork, correct artist images, multi-artist tags** | Four separate RetroMusic issue clusters |
| **Library scan speed**, and pull-to-rescan | Auxio #9, RetroMusic #1121 |

### 7. Metadata is a mess, and it is worst for downloaded music

Missing or wrong album art, wrong track and album names, art that does not
travel with the file when synced. This is a general complaint about local
libraries and it is *acutely* the failure mode of a library sourced from video
platforms, where the "title" is `Artist - Track (Official Video) [4K]` and the
"artist" is a channel name.

### 8. Regressions and dishonest controls

Negative-review clustering across the category returns the same four buckets in
every app: **crashes, missing features, billing, and updates that broke it.**
Below that, the recurring specific gripes are ads in the free tier, basics behind
a paywall, no one-time purchase option on Android where iOS has one, no Android
Auto support, and controls that are unintuitive or actively wrong (Poweramp's
back gesture exiting the app; Musicolet's non-standard skip gesture).

---

## 2. What they want

**Table stakes — absence is a review-score problem, not a roadmap item:**
playlists with reordering · a visible, editable queue · gapless · equaliser ·
sleep timer · lock-screen and notification controls that actually work · a
home-screen widget · Android Auto and headset-button handling · browsing by
artist, album, genre and folder · sorting and filtering · instant search ·
synced lyrics · offline that stays offline · backup and export.

**Differentiators people specifically say they are missing:** true shuffle ·
no account and no telemetry · files that play in other apps · human curation
over algorithmic feeds · scrobbling (Last.fm / ListenBrainz — an open request on
Metrolist) · blocking an artist or track outright (the single most duplicated
request on Metrolist) · audio quality, which 74% of listeners claim to rank
above catalogue size.

---

## 3. What this means for Spool

### Already answered, and unusually well

Background survival via a real foreground service and wake lock rather than a
support article telling the user to fix their phone (#1). A media card built
from `PlaybackState` with working transport and scrubber (#8). Shuffle that
reorders the visible queue rather than randomising each pick — literally the
thing Spotify users have been asking for since 2021 (#2). No account, no
telemetry, no server; a plays index of three numbers with no timeline (#3, #5).
Files carrying embedded cover and metadata so they play anywhere, and a library
that rebuilds itself from MediaStore after a reinstall (#4). Honest absences —
no dead cast button, no storage meter drawn from a guess (#8).

### The gaps, ranked by demand × fit

1. **Metadata cleanup at save time.** The highest-leverage gap. A library built
   from YouTube inherits `Artist - Track (Official Video) [4K]` as a title and a
   channel name as an artist, which is precisely complaint #7, and it degrades
   every surface downstream — sorting, search, the notification's second line,
   any future grouping. `mediaSession.metadata` is already read for the `match`
   rule and already knows more than the page title does.
2. **Playlists.** The #1 ask in every local-player tracker, and currently listed
   under "deliberately absent". Nothing else on this list is asked for as often.
3. **Sleep timer.** Cheap, universally expected, and specifically right for an
   app whose whole pitch is playing with the screen off.
4. **Gapless playback.** Table stakes; a queue-based player without it is
   noticed immediately on albums and live sets.
5. **Grouping — artist / album / folder.** Search is title-substring only today
   and there is no grouping anywhere; both get worse the moment the library is
   large enough to be worth having.
6. **Synced lyrics.** Has moved from luxury to expectation.
7. **Equaliser and volume normalisation.** RetroMusic's top request; the
   normalisation half matters more here than for most players, because a library
   assembled from web sources has wildly inconsistent levels.
8. **Widget and Android Auto.** The two places a music app is used where the
   screen is not the interface.
9. **Export and backup.** Manual saves already survive a reinstall through
   MediaStore; automatic saves do not, and playlists will not the day they
   exist. Complaint #4 is entirely about this.

### Worth continuing to refuse

- **Social feeds and Wrapped-style stats** — needs a play history with a
  timeline, which `core/plays.ts` deliberately does not keep.
- **Accounts and cloud sync** — the identity line on Profile is the product.
- **AI playlist generation** — currently a source of complaint rather than
  delight, and inseparable from the slop people are running from.
- **Casting** — still nothing to cast to.

---

## Sources

Streaming complaints: [Spotify Community — pure shuffle](https://community.spotify.com/t5/Live-Ideas/WE-NEED-PURE-SHUFFLE/idc-p/5768640/highlight/true),
[Spotify Community — 2026 price rise](https://community.spotify.com/t5/Subscriptions/This-time-a-20-sudden-price-increase-for-Premium-2026/td-p/7327991),
[Android Authority — YouTube Music AI slop](https://www.androidauthority.com/youtube-music-ai-slop-recommendation-issues-3629759/),
[Android Authority — what YouTube Music must change](https://www.androidauthority.com/google-fan-wont-use-youtube-music-until-these-things-change-3640461/),
[TechJournal — Spotify 2026 pricing](https://techjournal.org/spotify-raises-us-subscription-prices-to-12-99-in-2026-what-subscribers-should-know).

Local players and feature demand: [Auxio issues by reactions](https://github.com/OxygenCobalt/Auxio/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc),
[Metrolist issues by reactions](https://github.com/mostafaalagamy/Metrolist/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc),
[RetroMusicPlayer issues by reactions](https://github.com/RetroMusicPlayer/RetroMusicPlayer/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc),
[InnerTune issues](https://github.com/z-huang/InnerTune/issues?q=is%3Aissue+sort%3Areactions-%2B1-desc),
[How-To Geek — testing personal music players](https://www.howtogeek.com/i-tested-the-best-personal-music-players-on-android-and-this-is-the-one-im-sticking-with/),
[Android Authority — best music player apps](https://www.androidauthority.com/best-music-player-apps-for-android-208990/).

Background playback: [jellyfin-android #219](https://github.com/jellyfin/jellyfin-android/issues/219),
[jellyfin-android #1378](https://github.com/jellyfin/jellyfin-android/issues/1378),
[morphe-patches #1777](https://github.com/MorpheApp/morphe-patches/issues/1777),
[Play-Fi — battery optimisation](https://play-fi.com/faq/entry/playback-stops-after-a-few-minutes-battery-optimization).

Ownership and market context: [Yahoo — offline music is back in style](https://www.yahoo.com/entertainment/music/articles/offline-music-back-style-during-191700905.html),
[MIDiA — subscription fatigue](https://www.midiaresearch.com/blog/are-we-headed-towards-subscription-fatigue),
[SoundStage! — the persistence of downloads](https://www.soundstagesimplifi.com/index.php/feature-articles/298-the-persistence-of-downloads),
[IFPI Engaging with Music](https://www.ifpi.org/wp-content/uploads/2023/12/IFPI-Engaging-With-Music-2023_full-report.pdf),
[Billboard on IFPI's listening study](https://www.billboard.com/pro/ifpi-engaging-music-study-listening-habits-global-stats/),
[Apple Support — missing or greyed-out songs](https://support.apple.com/en-us/118287),
[Unstar — negative review clustering](https://unstar.app/).
