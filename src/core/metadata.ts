/**
 * Turning what a video site calls a video into what a music player calls a
 * track.
 *
 * A library built from YouTube inherits its names from uploaders, not from a
 * tagger, so the same recording arrives as
 *
 *   "Tum Hi Ho | Aashiqui 2 | Arijit Singh (Official Video) [4K]"
 *
 * where a player wants "Tum Hi Ho" by "Arijit Singh". Every surface downstream
 * is made worse by the raw form: the row, the sort, the search, the second line
 * of the media card, and the filename the user later finds in their gallery.
 * This module is the one place that answers what a thing is called.
 *
 * **Nothing here is ever destroyed.** `clean` hands back `raw` alongside the
 * tidied name, so a caller that needs what the source actually said still has
 * it. Every rule below is a judgement about presentation, and one of them is a
 * guess.
 *
 * The duplicate test in `similar.ts` is deliberately left alone. Its thresholds
 * were measured against uploader titles, but it strips its own packaging
 * vocabulary before comparing anything, so a title cleaned here reduces to the
 * same tokens it always did. That is what lets a library holding both — rows
 * saved before this existed and rows saved after — go on matching across the
 * two.
 *
 * **A derived artist is not evidence of music.** `MediaMessage.music` is the
 * page saying "this is a track" — a real `mediaSession` artist, or
 * music.youtube.com — and it is what the *Match* keep-as rule reads. Splitting
 * "Artist - Title" produces something to *show*, not a second opinion about
 * what the video is, so nothing in this file may set that flag.
 */

/**
 * Words that describe how a video was packaged rather than what it is.
 *
 * Deliberately **not** `similar.ts`'s list, and the two must not be merged.
 * That one is comparing two names to decide whether they are one recording, so
 * it drops anything that cannot tell two recordings apart — including "ft",
 * "feat" and the language. This one is deciding what to show a person, and
 * "(feat. Shreya Ghoshal)" is exactly the kind of thing they want left on the
 * row. Only what is true of the *upload* rather than the *recording* belongs
 * here.
 */
const PACKAGING = new Set([
  'official', 'video', 'videos', 'audio', 'song', 'lyric', 'lyrics', 'lyrical',
  'music', 'mv', 'm', 'v', 'hd', 'hq', 'full', 'complete', 'visualizer',
  'visualiser', 'teaser', 'trailer', 'promo', 'out', 'now', 'new', 'latest',
  'watch', 'online', 'free', 'download', 'subscribe', 'presenting', 'presents',
  'exclusive', 'quality', 'with', 'in', 'the', 'and', 'a', 'an', 'of', 'on',
  'copyright', 'release', 'released', 'releasing', 'version',
]);

/** `1080p`, `4K` — a claim about the file, never about the song. */
const RESOLUTION = /^(?:\d{3,4}p|[248]k)$/;

/** A bare year, which in a bracket is a release stamp and not part of a name. */
const YEAR = /^(?:19|20)\d{2}$/;

/**
 * Bracketed asides, in the four shapes that actually turn up. `【】` is here
 * because CJK uploads use it the way Latin ones use square brackets, and a
 * regex written for `[]` alone leaves those titles untouched.
 */
const BRACKETS = /[([{【][^)\]}】]*[)\]}】]/g;

/** The separators an uploader uses to staple credits onto a name. */
const PIPES = /\s*[|｜]\s*/;
const DASHES = /\s+[-–—]\s+/;

/** Lowercased alphanumeric runs, in any script — Devanagari has to survive. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(Boolean);
}

/**
 * True when a fragment says nothing except how the video was packaged.
 *
 * The test is deliberately *all* rather than *any*: "Official Video" goes,
 * "Live at Wembley" stays, and "Official Audio (Remastered)" keeps the half
 * that names a version. One informative word is enough to keep the fragment,
 * because the cost of dropping a real name is a row the user cannot identify
 * and the cost of keeping a stray "Official" is a slightly long row.
 */
export function isPackaging(fragment: string): boolean {
  const tokens = words(fragment);
  if (!tokens.length) return false;
  return tokens.every(
    (word) => PACKAGING.has(word) || RESOLUTION.test(word) || YEAR.test(word),
  );
}

/** Whitespace, and the separators left dangling once something between them went. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s*([|｜])\s*(?=[|｜]|$)/g, '')
    .replace(/^[\s|｜\-–—·:,]+/, '')
    .replace(/[\s|｜\-–—·:,]+$/, '')
    .trim();
}

/**
 * The channel name as a person would write it.
 *
 * "- Topic" is YouTube's own marker for the auto-generated artist channels
 * behind most music, so it is on a large share of everything this app sees and
 * it is never part of a name. `VEVO` is left alone on purpose: it arrives
 * welded to the name ("ArijitSinghVEVO") and cutting it yields "ArijitSingh",
 * which is worse than what we started with.
 */
export function cleanArtist(raw: string | undefined | null): string {
  if (!raw) return '';
  const stripped = raw.replace(/\s*[-–—]\s*Topic\s*$/i, '');
  return tidy(stripped) || tidy(raw);
}

/**
 * The song's name, with the upload's packaging taken off.
 *
 * Four passes, in this order, each of which can only ever remove:
 *
 * 1. **Bracketed asides that are packaging-only.** The largest single win and
 *    the safest, because a bracket is the uploader themselves marking a phrase
 *    as an aside.
 * 2. **Pipe segments.** Packaging-only ones go outright. Where more than one
 *    real segment survives the first is taken, since a pipe-delimited title is
 *    "name | film | singer | label" almost without exception — unless the first
 *    segment is the artist we already know, which is the one arrangement where
 *    taking it would leave the row named after the singer rather than the song.
 * 3. **A known artist's name used as a prefix.** "Arijit Singh - Tum Hi Ho"
 *    with the artist already known is provable duplication, not a guess.
 * 4. **A packaging-only tail** after the last dash, which is where "- Official
 *    Video" lives when the uploader did not bracket it.
 *
 * Every pass falls back to what it was given rather than returning nothing: a
 * title that is *entirely* packaging ("Official Music Video") is a bad name, and
 * an empty row is a worse one.
 */
export function cleanTitle(raw: string, artist?: string): string {
  const started = tidy((raw || '').replace(/\s*[-–—]\s*YouTube\s*$/i, ''));
  if (!started) return (raw || '').trim();

  const known = cleanArtist(artist).toLowerCase();

  // 1. Bracketed asides.
  let text = tidy(started.replace(BRACKETS, (group) => (isPackaging(group) ? ' ' : group)));
  if (!text) text = started;

  // 2. Pipe segments.
  const segments = text.split(PIPES).map(tidy).filter(Boolean);
  if (segments.length > 1) {
    const real = segments.filter((segment) => !isPackaging(segment));
    if (real.length) {
      // Skipping the artist's own segment is what stops "Arijit Singh | Tum Hi
      // Ho" resolving to the singer's name.
      const named = real.find((segment) => segment.toLowerCase() !== known);
      text = named ?? real[0];
    }
  }

  // 3. The artist as a prefix.
  if (known) {
    const parts = text.split(DASHES);
    if (parts.length > 1 && tidy(parts[0]).toLowerCase() === known) {
      const rest = tidy(parts.slice(1).join(' - '));
      if (rest) text = rest;
    }
  }

  // 4. A packaging-only tail.
  const tail = text.split(DASHES);
  if (tail.length > 1 && isPackaging(tail[tail.length - 1])) {
    const rest = tidy(tail.slice(0, -1).join(' - '));
    if (rest) text = rest;
  }

  return tidy(text) || started;
}

/**
 * Artists the app has already seen, for corroborating a dash split.
 *
 * Deliberately not a bare `Iterable`: `clean` caches its last answer and has to
 * be able to tell one corroboration set from another cheaply, which needs a
 * count rather than a walk.
 */
export type ArtistHints = ReadonlySet<string> | readonly string[];

const hintCount = (known: ArtistHints): number =>
  known instanceof Set ? known.size : (known as readonly string[]).length;

/** How long the left of a dash may be before it stops looking like a name. */
const ARTIST_MAX_CHARS = 40;
const ARTIST_MAX_WORDS = 5;

/**
 * The artist hiding in "Artist - Title", where the app has independent reason
 * to believe the left side is a person.
 *
 * **The convention is not evidence.** "Artist - Title" is what a tagger assumes
 * and it is wrong often enough to matter: film music is titled
 * "Tum Hi Ho - Aashiqui 2", which is song and film, and reading it as a name
 * would attribute the song to itself and file it under the wrong artist
 * permanently. That is the same class of mistake as the storage meter drawn
 * from a guess — a row the user can check, asserting something the app does not
 * know.
 *
 * So the split is corroborated rather than assumed: the left side has to be an
 * artist the library or the play index has already seen elsewhere, which is a
 * fact rather than a convention. With nothing to corroborate against the whole
 * string stays the title, which is what the app did before this existed. A row
 * named after the song with no artist is ordinary; a row attributed to a film
 * is a mistake somebody has to undo by hand.
 *
 * Only a single spaced dash is considered — "Kabhi Kabhi Aditi - Jaane Tu - Ya
 * Jaane Na" has two and nothing says which one is the seam.
 */
export function splitArtist(
  title: string,
  known: ArtistHints,
): { artist: string; title: string } | null {
  const names = new Set<string>();
  for (const name of known) {
    const cleaned = cleanArtist(name).toLowerCase();
    if (cleaned) names.add(cleaned);
  }
  if (!names.size) return null;

  const parts = title.split(DASHES);
  if (parts.length !== 2) return null;

  const left = tidy(parts[0]);
  const right = tidy(parts[1]);
  if (!left || !right) return null;
  if (left.length > ARTIST_MAX_CHARS) return null;
  if (words(left).length > ARTIST_MAX_WORDS) return null;
  // A number on its own is a track index; a year is a reissue stamp.
  if (/^\d+\.?$/.test(left) || YEAR.test(left)) return null;
  if (isPackaging(left) || isPackaging(right)) return null;
  if (!names.has(left.toLowerCase())) return null;

  return { artist: left, title: right };
}

export type RawNames = {
  title: string;
  artist?: string | null;
};

export type CleanNames = {
  /** What to show, and what to name the file in the user's gallery. */
  title: string;
  /** Who made it, where that is known at all. Empty rather than invented. */
  artist: string;
  /** Exactly what the source said, kept so nothing above is irreversible. */
  raw: string;
};

/**
 * The whole job, at the two boundaries where a name enters the app: a page
 * reporting what it is playing, and yt-dlp reporting what it is about to
 * download. Everything downstream reads the result, so neither the library nor
 * the media card has to know any of the above.
 *
 * `known` is the artists the app has already seen, and it is only ever used to
 * corroborate a dash split. Leaving it out means no split at all, never a
 * guessed one.
 *
 * Cheap enough to call on every page report, but it is called once a second
 * while something plays, so the last answer is kept and handed straight back
 * when the inputs have not moved. The cache is keyed on the names alone:
 * `known` only ever grows, and a title that failed to split a second ago
 * failing again is not worth a re-render.
 */
let lastKey = '';
let lastValue: CleanNames = { title: '', artist: '', raw: '' };

export function clean(raw: RawNames, known: ArtistHints = []): CleanNames {
  // The corroboration set is part of the key, not just the names. It grows as
  // the library does, and a cache that ignored it would keep handing back the
  // answer worked out before the app had ever heard of this artist.
  const key = `${hintCount(known)} ${raw.title} ${raw.artist ?? ''}`;
  if (key === lastKey) return lastValue;

  const artist = cleanArtist(raw.artist);
  const title = cleanTitle(raw.title, artist);

  let value: CleanNames = { title, artist, raw: raw.title || '' };
  if (!artist) {
    const split = splitArtist(title, known);
    if (split) value = { title: split.title, artist: split.artist, raw: raw.title || '' };
  }

  lastKey = key;
  lastValue = value;
  return value;
}

/**
 * Every artist the app already knows, for the corroboration above.
 *
 * Both stores are worth reading because they lose their evidence in opposite
 * directions: the play index is capped at 300 and drops already-saved entries
 * first, so the artist of the thing being downloaded right now is exactly the
 * one likely to have been evicted, while the library only ever knew the
 * artists that reached a file.
 */
export function knownArtists(
  ...sources: readonly (readonly { artist?: string | null }[])[]
): Set<string> {
  const names = new Set<string>();
  for (const source of sources) {
    for (const row of source) {
      const name = cleanArtist(row.artist).toLowerCase();
      if (name) names.add(name);
    }
  }
  return names;
}
