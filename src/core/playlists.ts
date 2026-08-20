import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DownloadRecord } from './storage';

/**
 * Playlists — the one thing every local player is asked for and most of them
 * ship late, because it is the first feature where the *user's* order has to
 * outrank the app's.
 *
 * Everything else in the library is derived: newest first, largest first, title
 * A-Z, all answers the app works out. A playlist is the opposite — it is a list
 * somebody arranged by hand, and the whole value of it is that nothing
 * rearranges it afterwards. So the sort control in the Library header does not
 * reach in here, and neither does anything else.
 *
 * **Ids, not tracks**, for the same reason `dl.session` stores ids: a row
 * removed from the library while the app was closed must not come back as a
 * playlist entry pointing at a file that is no longer listed. `resolve` is what
 * turns stored ids into rows, against the library as it stands.
 *
 * **Stored ids are never pruned**, and that is the load-bearing half. An id
 * that resolves to nothing today may simply be a library that has not finished
 * loading — the boot sequence reads downloads asynchronously and adopts from
 * MediaStore later still — so pruning on load would empty every playlist on one
 * slow launch, permanently, with nothing anywhere to say why. Resolution is for
 * display; the stored list only ever changes when the user changes it.
 */

const KEY_PLAYLISTS = 'dl.playlists';

/** Enough to organise a library, few enough that the section stays a list. */
const MAX_PLAYLISTS = 50;

/** Past this a playlist is a library, and the queue it builds is unusable. */
const MAX_TRACKS = 500;

export type Playlist = {
  id: string;
  name: string;
  /** Download ids, in the order the user put them. */
  trackIds: string[];
  createdAt: number;
  updatedAt: number;
};

/** What an edit did, so the caller can say it without guessing. */
export type AddResult = {
  playlists: Playlist[];
  added: number;
  /** Already in the list, so not added again. */
  duplicate: number;
};

export async function loadPlaylists(): Promise<Playlist[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PLAYLISTS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // A blob from an older build, or a half-written one. Anything that is not
    // recognisably a playlist is dropped rather than allowed to crash a screen.
    return parsed
      .filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({
        id: p.id,
        name: p.name,
        trackIds: Array.isArray(p.trackIds)
          ? p.trackIds.filter((id: unknown) => typeof id === 'string')
          : [],
        createdAt: Number(p.createdAt) || 0,
        updatedAt: Number(p.updatedAt) || Number(p.createdAt) || 0,
      }));
  } catch {
    return [];
  }
}

export async function savePlaylists(playlists: Playlist[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PLAYLISTS, JSON.stringify(playlists.slice(0, MAX_PLAYLISTS)));
  } catch {
    // The in-memory list is still right for this session. Losing the write
    // costs the edit on the next launch, which is worth saying nothing about.
  }
}

/** Trimmed, collapsed, and capped at something a row can draw. */
export function tidyName(name: string): string {
  return (name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * A name nobody already has.
 *
 * Two playlists called "Night drive" are not an error, but they are unusable in
 * a picker — the "Add to playlist" sheet is a list of names and nothing else,
 * so a duplicate makes the user choose between two identical rows.
 */
export function uniqueName(playlists: readonly Playlist[], base: string): string {
  const wanted = tidyName(base) || 'Playlist';
  const taken = new Set(playlists.map((p) => p.name.toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${wanted} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return wanted;
}

export function createPlaylist(
  playlists: readonly Playlist[],
  name: string,
  now: number,
): { playlists: Playlist[]; created: Playlist } | null {
  if (playlists.length >= MAX_PLAYLISTS) return null;
  const tidy = tidyName(name);
  if (!tidy) return null;

  const created: Playlist = {
    // Time plus a short random tail: two playlists made in the same
    // millisecond is not a real scenario, but an id collision here silently
    // merges two lists and there is no cheaper insurance.
    id: `pl-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: uniqueName(playlists, tidy),
    trackIds: [],
    createdAt: now,
    updatedAt: now,
  };
  return { playlists: [created, ...playlists], created };
}

export function renamePlaylist(
  playlists: readonly Playlist[],
  id: string,
  name: string,
  now: number,
): Playlist[] {
  const tidy = tidyName(name);
  if (!tidy) return playlists as Playlist[];
  const others = playlists.filter((p) => p.id !== id);
  return playlists.map((p) =>
    p.id === id ? { ...p, name: uniqueName(others, tidy), updatedAt: now } : p,
  );
}

export function deletePlaylist(playlists: readonly Playlist[], id: string): Playlist[] {
  return playlists.filter((p) => p.id !== id);
}

/**
 * Add tracks, keeping the order they were given and refusing what is already
 * there.
 *
 * A playlist that can hold the same track twice is defensible; a playlist that
 * *silently* holds it twice because the user tapped "Add to playlist" from two
 * different screens is not. The count comes back so the caller can say which
 * happened rather than leaving the user to count rows.
 */
export function addTracks(
  playlists: readonly Playlist[],
  id: string,
  trackIds: readonly string[],
  now: number,
): AddResult {
  let added = 0;
  let duplicate = 0;

  const next = playlists.map((p) => {
    if (p.id !== id) return p;
    const have = new Set(p.trackIds);
    const room = MAX_TRACKS - p.trackIds.length;
    const fresh: string[] = [];
    for (const trackId of trackIds) {
      if (have.has(trackId)) {
        duplicate += 1;
        continue;
      }
      if (fresh.length >= room) break;
      have.add(trackId);
      fresh.push(trackId);
    }
    added = fresh.length;
    if (!fresh.length) return p;
    return { ...p, trackIds: [...p.trackIds, ...fresh], updatedAt: now };
  });

  return { playlists: added ? next : (playlists as Playlist[]), added, duplicate };
}

export function removeTrack(
  playlists: readonly Playlist[],
  id: string,
  trackId: string,
  now: number,
): Playlist[] {
  return playlists.map((p) =>
    p.id === id && p.trackIds.includes(trackId)
      ? { ...p, trackIds: p.trackIds.filter((t) => t !== trackId), updatedAt: now }
      : p,
  );
}

/**
 * Move one track by `delta` places.
 *
 * Up and down rather than a drag: a drag needs a gesture handler over a
 * scrolling list, and "reorder" is the half of playlists users complain is
 * missing — a control that works on the first tap beats one that works on the
 * third attempt at a long press. Moving past either end is a no-op rather than
 * a wrap, because a track that leaps from the bottom to the top on a stray tap
 * reads as a bug.
 */
export function moveTrack(
  playlists: readonly Playlist[],
  id: string,
  trackId: string,
  delta: number,
  now: number,
): Playlist[] {
  return playlists.map((p) => {
    if (p.id !== id) return p;
    const from = p.trackIds.indexOf(trackId);
    if (from < 0) return p;
    const to = from + delta;
    if (to < 0 || to >= p.trackIds.length) return p;
    const ids = [...p.trackIds];
    ids.splice(from, 1);
    ids.splice(to, 0, trackId);
    return { ...p, trackIds: ids, updatedAt: now };
  });
}

/**
 * Stored ids as library rows, in the playlist's order.
 *
 * Anything the library does not have is skipped — a download removed since,
 * or, at boot, one the library has simply not loaded yet. Skipping is why
 * nothing here writes: see the note at the top about what pruning would cost.
 */
export function resolve(
  playlist: Playlist | null | undefined,
  records: readonly DownloadRecord[],
): DownloadRecord[] {
  if (!playlist) return [];
  const byId = new Map(records.map((r) => [r.id, r]));
  const out: DownloadRecord[] = [];
  for (const id of playlist.trackIds) {
    const row = byId.get(id);
    if (row && row.state === 'saved' && row.uri) out.push(row);
  }
  return out;
}

/** "12 tracks", and the two cases where that sentence would be wrong. */
export function describePlaylist(
  playlist: Playlist,
  records: readonly DownloadRecord[],
): string {
  const count = resolve(playlist, records).length;
  if (!count) return 'Empty';
  return `${count} track${count === 1 ? '' : 's'}`;
}

/** Which playlists a track is already in, for the row menu. */
export function playlistsWith(
  playlists: readonly Playlist[],
  trackId: string,
): Playlist[] {
  return playlists.filter((p) => p.trackIds.includes(trackId));
}
