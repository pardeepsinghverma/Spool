/**
 * Whether the library already has this video — or something that is plainly the
 * same recording under a different name.
 *
 * Two questions, deliberately answered separately, because the app is allowed
 * to be certain about one and only suspicious about the other.
 *
 * **Exact** is `videoId`. It is the same video, so re-saving it is never what
 * the user meant: both paths write the same output file and publishing *moves*
 * it, so a second save leaves a `Title (1).m4a` orphan in the gallery and a
 * library row pointing at a file the first save already consumed. This one is
 * blocked outright.
 *
 * **Similar** is a guess, and is treated like one. YouTube is full of the same
 * song uploaded by a dozen channels — "Kaisi Teri Khudgharzi OST" and
 * "Kaisi Teri Khudgharzi | Music Video | Danish Taimoor | Pakistani Drama OST"
 * are one recording with two names and two ids. Nothing in the metadata proves
 * they are the same, so this never blocks: it warns, and the user decides.
 *
 * It also quietly covers the gap left by a reinstall. A row rebuilt from the
 * gallery has no `videoId` — nothing in a MediaStore record says which video a
 * file came from — so exact matching cannot see it at all. Title and runtime
 * survive in the file, which is why the weaker test is the one that still works
 * after the stronger one has lost its evidence.
 */

/** How far two runtimes may differ and still be called the same recording. */
const RUNTIME_SLACK_SECONDS = 3;

/** Containment needed when both runtimes are known and agree. */
const SCORE_WITH_RUNTIME = 0.5;

/**
 * Containment needed when a runtime is missing on either side, plus the size
 * agreement that stops a short name matching everything it is a substring of.
 */
const SCORE_WITHOUT_RUNTIME = 0.8;
const JACCARD_WITHOUT_RUNTIME = 0.6;

/**
 * Words that say how a video was packaged rather than what it is.
 *
 * Reposts differ almost entirely in this vocabulary — one channel's "Official
 * Video" is another's "Full Song (Lyrical) 4K" over identical audio — so
 * dropping it is most of what makes two names comparable. Anything that could
 * distinguish two real recordings stays: no artist names, no language, no
 * "unplugged", "remix", "reprise" or "live", each of which is a genuinely
 * different take that a user may well want beside the original.
 */
const PACKAGING = new Set([
  '4k', '8k', 'hd', 'hq', 'full', 'video', 'song', 'songs', 'audio', 'lyric',
  'lyrics', 'lyrical', 'official', 'music', 'mv', 'ost', 'soundtrack', 'track',
  'original', 'new', 'latest', 'complete', 'watch', 'online', 'free', 'download',
  'status', 'whatsapp', 'shorts', 'short', 'presenting', 'present', 'releasing',
  'out', 'now', 'exclusive', 'hindi', 'movie', 'film', 'drama', 'serial', 'ft',
  'feat', 'featuring', 'prod', 'by', 'with', 'the', 'and', 'a', 'an', 'of',
]);

/**
 * A title reduced to the words that identify the recording.
 *
 * Bracketed asides go first and whole: they are where the packaging vocabulary
 * collects, and keeping them would let "(Official Music Video)" outvote the two
 * words that are actually the song's name.
 */
export function titleTokens(title: string): Set<string> {
  const stripped = (title || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\{[^}]*\}/g, ' ')
    // Anything that is not a letter or a digit, in any script — this has to
    // keep Devanagari and Arabic, so it cannot be written as [a-z0-9].
    .replace(/[^\p{L}\p{N}]+/gu, ' ');

  const out = new Set<string>();
  for (const word of stripped.split(' ')) {
    if (word.length < 2) continue;
    if (PACKAGING.has(word)) continue;
    out.add(word);
  }
  return out;
}

/**
 * How far two titles overlap, measured two ways because one is not enough.
 *
 * `containment` is the shared words over the *shorter* name. A repost routinely
 * appends the channel, the cast and the drama it came from, so the original
 * name is often a strict subset of the longer one — scoring that on combined
 * length would miss the exact case this exists for.
 *
 * `jaccard` is the shared words over the *combined* vocabulary, and it is the
 * check on containment. "Tum Hi Ho" sits wholly inside "Tum Hi Ho Gaya Hai
 * Tujhko To Pyar Sajna", which containment alone calls a perfect match and a
 * listener would call two different songs. Where runtime is there to corroborate
 * containment is trusted; where it is not, the names have to be close in size
 * as well as in content.
 *
 * The `overlap` floor stops a single shared word carrying either measure.
 */
export function titleOverlap(a: string, b: string): { containment: number; jaccard: number } {
  const left = titleTokens(a);
  const right = titleTokens(b);
  if (!left.size || !right.size) return { containment: 0, jaccard: 0 };

  let overlap = 0;
  for (const word of left) if (right.has(word)) overlap += 1;
  if (overlap < 2) return { containment: 0, jaccard: 0 };

  const union = left.size + right.size - overlap;
  return {
    containment: overlap / Math.min(left.size, right.size),
    jaccard: overlap / union,
  };
}

/** Containment on its own — the headline number, and what the tests pin. */
export const titleScore = (a: string, b: string): number => titleOverlap(a, b).containment;

export type Candidate = {
  videoId?: string;
  title: string;
  /** Runtime in seconds. 0 or undefined means the source never said. */
  seconds?: number;
  state?: 'saved' | 'failed';
};

export type Match<T> = { kind: 'exact' | 'similar'; record: T };

/**
 * The library row this download would duplicate, or null.
 *
 * Only saved rows count. A failed row is a video the user asked for and did not
 * get, so refusing the retry as a duplicate would strand them on the one row
 * that has nothing behind it.
 */
export function findDuplicate<T extends Candidate>(
  library: readonly T[],
  wanted: Candidate,
): Match<T> | null {
  const saved = library.filter((r) => (r.state ?? 'saved') === 'saved');

  if (wanted.videoId) {
    const exact = saved.find((r) => r.videoId && r.videoId === wanted.videoId);
    if (exact) return { kind: 'exact', record: exact };
  }

  for (const row of saved) {
    // A row for the same video that failed the exact test above cannot also be
    // "similar" to it — it is the same id and was already ruled out.
    if (wanted.videoId && row.videoId && row.videoId === wanted.videoId) continue;

    const bothTimed = !!wanted.seconds && !!row.seconds;
    if (bothTimed && Math.abs(row.seconds! - wanted.seconds!) > RUNTIME_SLACK_SECONDS) {
      continue;
    }

    const { containment, jaccard } = titleOverlap(row.title, wanted.title);
    const close = bothTimed
      ? containment >= SCORE_WITH_RUNTIME
      : containment >= SCORE_WITHOUT_RUNTIME && jaccard >= JACCARD_WITHOUT_RUNTIME;

    if (close) return { kind: 'similar', record: row };
  }

  return null;
}

/** Runtime as the row shows it — "4:07", or empty when nothing is known. */
export function runtimeLabel(seconds?: number): string {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
