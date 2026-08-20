import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Lyrics, and the one place this app talks to somebody who is not YouTube.
 *
 * Everything else here is offline by construction: the page fetches its own
 * media, yt-dlp uses the browser's session, covers come from `i.ytimg.com` or
 * out of the file's own tags. Lyrics cannot be. They are not in the file — yt-dlp
 * has nothing to embed — and there is no way to derive them from audio on the
 * device. So they come from `lrclib.net`, and the whole design of this module is
 * about being straight about that.
 *
 * Three rules, and they are the feature as much as the parsing is:
 *
 * 1. **Never automatic.** Same rule as the Search tab, which will not fire a
 *    cloud query on a keystroke: the request happens because somebody tapped
 *    "Lyrics", never because a track started. A privacy claim that holds except
 *    when music is playing is not a privacy claim.
 * 2. **Asked once, in words, before the first request ever leaves.** The app
 *    tells the user which host, what is sent, and that this is the only request
 *    Spool makes that is not YouTube's. `hasLyricsConsent` is what that answer
 *    is stored as, and until it is `true` nothing here opens a socket.
 * 3. **What is sent is the track, and nothing else.** Title, artist, duration.
 *    No identifier, no device, no library, no history — LRCLIB has no accounts
 *    and the request carries no cookie, so there is nothing tying two lookups
 *    together beyond an IP address, which is worth saying plainly rather than
 *    implying otherwise.
 *
 * Answers are cached on disk, **"there are none" included** — same reason
 * `artwork.ts` remembers its misses: a track with no lyrics anywhere would
 * otherwise ask again on every open, which turns "one request when you tapped"
 * into a request per view of a screen. A *failure* is not an answer and is not
 * cached; see `fetchLyrics`.
 */

const KEY_LYRICS = 'dl.lyrics';
const KEY_CONSENT = 'dl.lyricsOptIn';

/** Past this the cache is trimmed oldest-first. Lyrics are a few KB each. */
const MAX_CACHED = 200;

const ENDPOINT = 'https://lrclib.net/api/get';

/** How long to wait before deciding the network is not going to answer. */
const TIMEOUT_MS = 8000;

/** One line of a synced lyric. `at` is seconds from the start of the track. */
export type LyricLine = { at: number; text: string };

export type Lyrics = {
  /** Timed lines, empty when only a plain-text version exists. */
  lines: LyricLine[];
  /** The unsynced text, which is what a plain result is and a synced one is not. */
  plain: string;
  /** True when `lines` can follow the playhead. */
  synced: boolean;
};

/** `null` is a remembered "there are none", which is different from "not asked". */
type Cache = Record<string, Lyrics | null>;

let cache: Cache | null = null;
let writing: ReturnType<typeof setTimeout> | null = null;

/**
 * The cache key.
 *
 * Deliberately the *names*, not the download id: the same recording saved twice,
 * or re-saved after a reinstall under a new id, is the same lyric — and a key
 * that changed with the id would ask again for something already on the device.
 */
export function lyricsKey(artist: string, title: string): string {
  return `${(artist || '').trim().toLowerCase()}|${(title || '').trim().toLowerCase()}`;
}

async function index(): Promise<Cache> {
  if (cache) return cache;
  try {
    const raw = await AsyncStorage.getItem(KEY_LYRICS);
    const parsed = raw ? JSON.parse(raw) : null;
    cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    cache = {};
  }
  return cache ?? {};
}

function flush() {
  if (writing) return;
  writing = setTimeout(() => {
    writing = null;
    void (async () => {
      try {
        const all = cache ?? {};
        const keys = Object.keys(all);
        const kept = keys.length > MAX_CACHED ? keys.slice(keys.length - MAX_CACHED) : keys;
        const out: Cache = {};
        for (const key of kept) out[key] = all[key];
        await AsyncStorage.setItem(KEY_LYRICS, JSON.stringify(out));
      } catch {
        // The in-memory copy is still right for this session.
      }
    })();
  }, 2000);
}

export async function hasLyricsConsent(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY_CONSENT)) === '1';
  } catch {
    // A read that failed is not a yes. Erring the other way would let a failed
    // disk turn into a request the user never agreed to.
    return false;
  }
}

export async function setLyricsConsent(agreed: boolean): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_CONSENT, agreed ? '1' : '0');
  } catch {
    // Costs the question being asked again, which is the safe direction.
  }
}

/**
 * `[mm:ss.xx] text` into timed lines.
 *
 * A line may carry several stamps — LRC's way of writing a repeated chorus
 * once — so each stamp becomes its own line rather than the first one winning.
 * Stamps without text are kept as empty lines: they are the gaps between
 * verses, and a follower that skips them jumps the highlight forward through an
 * instrumental break.
 */
export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const raw of (lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;

    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const stamp of stamps) {
      const minutes = Number(stamp[1]);
      const seconds = Number(stamp[2]);
      // Two digits are hundredths, three are milliseconds. Reading "50" as
      // milliseconds would put every line 450ms early, which is enough to look
      // like the wrong line is lit.
      const fraction = stamp[3]
        ? Number(stamp[3]) / (stamp[3].length === 3 ? 1000 : 100)
        : 0;
      out.push({ at: minutes * 60 + seconds + fraction, text });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Which line is current at `seconds`.
 *
 * The last line whose stamp has passed, or -1 before the first — a track that
 * opens with eight seconds of intro should light nothing rather than light the
 * first line early. Linear from the top: a lyric is a couple of hundred lines
 * and this runs on a screen that is already re-rendering on the playhead.
 */
export function lineAt(lines: readonly LyricLine[], seconds: number): number {
  let at = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].at > seconds) break;
    at = i;
  }
  return at;
}

/**
 * What is already known, without asking anybody.
 *
 * `undefined` means never looked; `null` means looked and there are none. The
 * screen needs to tell those apart — one offers a button, the other says there
 * are none and stops offering.
 */
export async function cachedLyrics(key: string): Promise<Lyrics | null | undefined> {
  const all = await index();
  return key in all ? all[key] : undefined;
}

/**
 * Ask LRCLIB. Only ever called from an explicit tap, and only with consent.
 *
 * Returns `null` for "there are none", which is cached exactly like a result:
 * the answer to "does this track have lyrics" is worth remembering either way.
 * A *failure* — no network, a timeout, a 500 — is deliberately **not** cached
 * and throws instead, because "we could not ask" is not "there are none", and
 * remembering it would leave a track permanently lyric-less because of one dead
 * moment on a train.
 */
export async function fetchLyrics(args: {
  artist: string;
  title: string;
  seconds?: number;
}): Promise<Lyrics | null> {
  if (!(await hasLyricsConsent())) return null;

  const key = lyricsKey(args.artist, args.title);
  const known = await cachedLyrics(key);
  if (known !== undefined) return known;

  const query = new URLSearchParams({
    artist_name: args.artist || '',
    track_name: args.title || '',
  });
  // The duration is what lets LRCLIB tell a song from its own extended mix, so
  // it is sent where it is known and left out entirely where it is not.
  if (args.seconds && args.seconds > 0) query.set('duration', String(Math.round(args.seconds)));

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${ENDPOINT}?${query.toString()}`, {
      signal: abort.signal,
      headers: { Accept: 'application/json' },
    });

    // A 404 is LRCLIB saying it does not have this one, which is an answer.
    if (response.status === 404) {
      const all = await index();
      all[key] = null;
      flush();
      return null;
    }
    if (!response.ok) throw new Error(`lrclib ${response.status}`);

    const body = await response.json();
    const synced = typeof body?.syncedLyrics === 'string' ? body.syncedLyrics : '';
    const plain = typeof body?.plainLyrics === 'string' ? body.plainLyrics : '';
    const lines = parseLrc(synced);

    const all = await index();
    const value: Lyrics | null =
      lines.length || plain ? { lines, plain, synced: lines.length > 0 } : null;
    all[key] = value;
    flush();
    return value;
  } finally {
    clearTimeout(timer);
  }
}

/** Drops everything fetched, for turning the feature back off. */
export async function forgetLyrics(): Promise<void> {
  cache = {};
  try {
    await AsyncStorage.removeItem(KEY_LYRICS);
  } catch {
    // The in-memory copy is already empty; the next launch tidies the rest.
  }
}
