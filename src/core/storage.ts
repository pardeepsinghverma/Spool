import AsyncStorage from '@react-native-async-storage/async-storage';
import { cleanArtist, cleanTitle } from './metadata';

/**
 * Persisted state. Kept deliberately small — the app stores what the user
 * downloaded and whether they've seen the first-run screen, and nothing else.
 * No analytics, no identifiers.
 */

const KEY_FIRST_RUN = 'dl.firstRunDone';
const KEY_DOWNLOADS = 'dl.downloads';
const KEY_SETTINGS = 'dl.settings';
const KEY_SESSION = 'dl.session';
const KEY_SEARCHES = 'dl.searches';
const KEY_FORGOTTEN = 'dl.forgotten';

export type DownloadRecord = {
  id: string;
  title: string;
  quality: string;
  /**
   * Where the file can be played from. A manual save publishes to MediaStore
   * and gets a content:// uri; an automatic one stays app-private and gets a
   * file:// path, because hundreds of automatic saves do not belong in the
   * user's gallery.
   */
  uri?: string;
  bytes?: number;
  audioOnly: boolean;
  /** Epoch ms. */
  savedAt: number;
  state: 'saved' | 'failed';
  error?: string;
  /** True when the replay rule saved this rather than the user. */
  auto?: boolean;
  /** The video this came from, so play counts can find their download. */
  videoId?: string;
  /**
   * Who made it, as the page reported it — a real mediaSession artist where
   * YouTube supplied one, the channel name otherwise.
   *
   * Copied off the play index at save time rather than read from it later: the
   * index is capped at 300 and evicts already-saved entries first, so the one
   * thing guaranteed to be dropped is exactly the video this row is about.
   */
  artist?: string;
  /**
   * Runtime in seconds, where the source said. Carried so the duplicate test
   * has something to corroborate a title with — see `src/core/similar.ts`. A
   * row rebuilt from the gallery gets this from the MediaStore duration, which
   * is the one identifying fact about a restored file that survives when its
   * `videoId` does not.
   */
  seconds?: number;
};

/**
 * The identity of a MediaStore row, independent of the volume name it was
 * reached through.
 *
 * `MediaStoreWriter` publishes under `VOLUME_EXTERNAL_PRIMARY` while the scan
 * reads back under `VOLUME_EXTERNAL`, so one file answers to two uris differing
 * only in that word — `content://media/external_primary/audio/media/99451` and
 * `content://media/external/audio/media/99451` are the same row, and the device
 * resolves both. Comparing the strings therefore never matched, so every manual
 * save was adopted a second time on the next launch: measured as 49 library
 * rows over 47 files, and a fresh download reliably becoming two rows after one
 * relaunch.
 *
 * Normalising here rather than changing either volume constant is what makes
 * this safe to ship. Rows already stored under either spelling collapse onto the
 * same key, so the first launch after it lands tidies up instead of adding one
 * more copy — and a `file://` path, which is what an automatic save gets, is
 * left exactly as it is.
 */
export function mediaKey(uri?: string): string {
  if (!uri) return '';
  const match = /^content:\/\/media\/[^/]+\/(.+)$/.exec(uri);
  return match ? `media:${match[1]}` : uri;
}

/**
 * Fold files already on the device into the library.
 *
 * The index above is app data and Android deletes it with the app; a manual
 * save is a MediaStore record in Music/Spool and outlives every uninstall. So a
 * reinstalled Spool would show an empty Library over a folder full of music
 * unless it goes and looks. This runs on every launch rather than only when the
 * library is empty — the same gap opens when app data is cleared, or when only
 * some rows survive — and it is safe to repeat because nothing in the app can
 * remove a saved row, so a rescan cannot resurrect something deliberately
 * dropped.
 *
 * Matched on `uri`, which is the one identifier both halves share.
 *
 * `forgotten` is what stops this undoing a removal. Removing a saved row keeps
 * the file and says so — "stays on this device, only Spool's list of it goes" —
 * so without that set the next launch would find the file, adopt it, and hand
 * back the row the user had just been promised was gone. The set is app data
 * like everything else here, so a reinstall does forget the forgetting; a fresh
 * install offering everything on the device is the right answer anyway.
 *
 * **A restored row has no `videoId`**, because nothing in a MediaStore row
 * records which video a file came from. It plays, it lists, it sorts by date.
 * What it cannot do is tell the replay rule it already exists, so a track the
 * user goes back to after a reinstall can be saved a second time — and on a
 * trial build that spends a second slot. Fixing it properly means writing the
 * id somewhere that travels with the file, which is a change to what the user
 * sees in their gallery, so it is deliberately not done here.
 */
/**
 * Collapse rows that are the same file.
 *
 * `mediaKey` stops *new* duplicates being adopted, and that is all it does —
 * the pairs already in a library stay there, because nothing was ever going to
 * revisit them. On the device that meant three rows over two files after four
 * days on the old build, which is not something a user should have to tidy by
 * hand one confirm dialog at a time.
 *
 * Where two rows describe one file the app's own record wins. An adopted row is
 * identified by its `found:` id and carries a filename for a title — the real
 * one sanitised, so `|` has become `_` — while the record it duplicates has the
 * title as written, a `videoId`, and an artist. Merging in that direction is
 * what keeps the replay rule able to recognise the video afterwards; merging
 * the other way would leave a tidier list that had quietly forgotten what it
 * was looking at.
 *
 * Returns the same array when there was nothing to merge, so a launch with a
 * healthy library writes nothing.
 */
export function dedupeByFile(records: DownloadRecord[]): DownloadRecord[] {
  const byKey = new Map<string, number>();
  const out: DownloadRecord[] = [];
  let merged = false;

  for (const row of records) {
    // Only saved rows name a file. A failed row has no uri and two failures of
    // the same video are two separate things the user asked for.
    const key = row.state === 'saved' ? mediaKey(row.uri) : '';
    if (!key) {
      out.push(row);
      continue;
    }

    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, out.length);
      out.push(row);
      continue;
    }

    merged = true;
    const kept = out[at];
    const record = kept.id.startsWith('found:') ? row : kept;
    const other = record === kept ? row : kept;
    out[at] = {
      ...record,
      videoId: record.videoId ?? other.videoId,
      artist: record.artist ?? other.artist,
      seconds: record.seconds ?? other.seconds,
      bytes: record.bytes ?? other.bytes,
      // The earlier date is when this file actually arrived; the later one is
      // only when the scan noticed it.
      savedAt: Math.min(record.savedAt, other.savedAt),
    };
  }

  return merged ? out : records;
}

export function adoptSaved(
  existing: DownloadRecord[],
  found: {
    uri: string;
    title: string;
    bytes: number;
    savedAt: number;
    audioOnly: boolean;
    artist: string | null;
    durationMs?: number;
  }[],
  forgotten: string[] = [],
): DownloadRecord[] {
  const known = new Set(existing.map((r) => mediaKey(r.uri)).filter(Boolean));
  const dropped = new Set(forgotten.map(mediaKey).filter(Boolean));
  const adopted: DownloadRecord[] = found
    .filter((f) => f.uri && !known.has(mediaKey(f.uri)) && !dropped.has(mediaKey(f.uri)))
    .map((f) => ({
      // Derived from the uri so a second scan recognises its own work rather
      // than adding the same file again under a fresh id.
      id: `found:${f.uri}`,
      // A filename written before names were cleaned, or by another app
      // entirely. Same treatment as everything else, for the same reason.
      title: cleanTitle(f.title, cleanArtist(f.artist)),
      // The real format is not in a MediaStore row and inventing "1080p" here
      // would be a number the user could check and find wrong.
      quality: f.audioOnly ? 'audio' : 'video',
      uri: f.uri,
      bytes: f.bytes,
      audioOnly: f.audioOnly,
      savedAt: f.savedAt,
      state: 'saved' as const,
      artist: cleanArtist(f.artist) || undefined,
      seconds: f.durationMs ? Math.round(f.durationMs / 1000) : undefined,
    }));

  if (!adopted.length) return dedupeByFile(existing);
  return dedupeByFile([...existing, ...adopted]).sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Everything on the Profile screen that has to survive a restart.
 *
 * `instant` is separate from `keepAs` on purpose: one is what a deliberate tap
 * on the download button grabs right now, the other is what the replay rule
 * keeps on the user's behalf. Wanting video when you ask and audio when the app
 * decides is a perfectly ordinary pair of preferences.
 */
export type Settings = {
  enabled: boolean;
  after: number;
  keepAs: 'audio' | 'video' | 'match';
  audioQuality: string;
  videoQuality: string;
  instant: 'audio' | 'video';
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  after: 3,
  keepAs: 'audio',
  audioQuality: 'Best available',
  videoQuality: '1080p',
  instant: 'audio',
};

export async function hasSeenFirstRun(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY_FIRST_RUN)) === '1';
  } catch {
    return false;
  }
}

export async function markFirstRunSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_FIRST_RUN, '1');
  } catch {
    // A failed write only means the notice shows again; not worth surfacing.
  }
}

/**
 * A row as it should read, whenever it was written.
 *
 * Names are cleaned at the two boundaries where they enter the app, which
 * fixes everything saved from here on and nothing already in the library — and
 * a library that has been collecting uploader titles for weeks is exactly the
 * one the tidying was for. So it is applied on the way out of storage too,
 * where it costs one pass over at most 200 rows at boot and lands on the next
 * write like any other change.
 *
 * Only the label moves. The file, its own tags and its MediaStore record are
 * untouched, and `cleanTitle` only ever removes, so running it over a row that
 * has already been through it changes nothing.
 */
function named(record: DownloadRecord): DownloadRecord {
  const artist = cleanArtist(record.artist);
  const title = cleanTitle(record.title, artist);
  if (title === record.title && artist === (record.artist ?? '')) return record;
  return { ...record, title, artist: artist || undefined };
}

export async function loadDownloads(): Promise<DownloadRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_DOWNLOADS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(named) : [];
  } catch {
    return [];
  }
}

export async function saveDownloads(records: DownloadRecord[]): Promise<void> {
  try {
    // Cap the history so the list can't grow without bound.
    await AsyncStorage.setItem(KEY_DOWNLOADS, JSON.stringify(records.slice(0, 200)));
  } catch {
    // Non-fatal: the in-memory list is still correct for this session.
  }
}

/**
 * Merged over the defaults rather than trusted wholesale, so a settings blob
 * written by an older build is missing keys rather than breaking the screen.
 */
export async function loadSettings(): Promise<Settings> {
  try {
    const raw = await AsyncStorage.getItem(KEY_SETTINGS);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SETTINGS, JSON.stringify(settings));
  } catch {
    // The screen keeps working; only the next launch forgets.
  }
}

/**
 * Where the user was when the app last went away.
 *
 * Stored as download ids rather than tracks, so a row removed from the library
 * while the app was closed cannot resurrect itself as a queue entry pointing at
 * a file that is no longer listed. Whoever restores this resolves the ids
 * against the library it just loaded and drops whatever no longer exists.
 */
export type PlaybackSession = {
  ids: string[];
  index: number;
  /** Playhead in seconds. */
  at: number;
};

export async function loadSession(): Promise<PlaybackSession | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY_SESSION);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.ids) || !parsed.ids.length) return null;
    return {
      ids: parsed.ids.filter((id: unknown) => typeof id === 'string'),
      index: Number(parsed.index) || 0,
      at: Number(parsed.at) || 0,
    };
  } catch {
    return null;
  }
}

export async function saveSession(session: PlaybackSession | null): Promise<void> {
  try {
    if (!session || !session.ids.length) {
      await AsyncStorage.removeItem(KEY_SESSION);
      return;
    }
    await AsyncStorage.setItem(KEY_SESSION, JSON.stringify(session));
  } catch {
    // Losing the resume point costs a restart, nothing more.
  }
}

/**
 * Uris the user has removed from the library while keeping the file.
 *
 * Only these need remembering. A row with no `uri` never finished, so there is
 * nothing on disk for a scan to find and nothing to suppress.
 */
export async function loadForgotten(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_FORGOTTEN);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveForgotten(uris: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_FORGOTTEN, JSON.stringify(uris.slice(0, 500)));
  } catch {
    // The row is gone for this session either way; the cost of losing this is
    // that it comes back on the next launch.
  }
}

export async function loadSearches(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_SEARCHES);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((q) => typeof q === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveSearches(queries: string[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_SEARCHES, JSON.stringify(queries.slice(0, 8)));
  } catch {
    // Recent searches are a convenience; a failed write is not worth reporting.
  }
}
