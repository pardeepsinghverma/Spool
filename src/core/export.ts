import type { DownloadRecord } from './storage';
import type { Playlist } from './playlists';
import { resolve } from './playlists';

/**
 * Getting a library back out of the app.
 *
 * "My playlists were gone after a reinstall" is one of the oldest complaints in
 * this category, and Spool is *more* exposed to it than most: the library index
 * and the playlists are app data, and Android deletes app data with the app.
 * Manual saves survive because they are MediaStore records — `adoptSaved` is
 * built entirely around that asymmetry — but nothing rebuilds the arrangement
 * of them, because an arrangement is not a file.
 *
 * So it becomes one. Two formats, for two different readers:
 *
 * - **`.m3u8` per playlist**, which is what every other player on the device
 *   understands.
 * - **one `.json`**, which is what a future Spool would read to put the lists
 *   back exactly as they were.
 *
 * Both are written to `Downloads/Spool`, where a person can actually find them.
 *
 * **Everything here is a pure function of what it is given.** The writing is
 * one native call at the edge, which is what makes all of this testable.
 */

/** The extension matters to whatever opens it, so it lives with the body. */
export type ExportFile = { name: string; mime: string; body: string };

/**
 * Names are trimmed of what a filesystem refuses *here* as well as natively.
 *
 * `MediaStoreWriter.sanitise` would do it anyway, but a name mangled after the
 * fact turns up in the user's Downloads folder looking like a bug, and the app
 * has already chosen a filename it can show them.
 */
export function fileNameFor(name: string, extension: string): string {
  const cleaned = (name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `${cleaned || 'Playlist'}.${extension}`;
}

/**
 * A playlist as M3U.
 *
 * `#EXTM3U` then a `#EXTINF` per track carrying its runtime and
 * `Artist - Title`, which is the form every player expects to parse back. The
 * location line is the file's own uri.
 *
 * **The uri is a `content://` for anything saved by hand, and that is a real
 * limit worth stating rather than papering over**: some players resolve one and
 * some only understand a path. The `#EXTINF` line is the part that always
 * survives, so even where the location does not resolve the file is named well
 * enough for a person to find. An automatic save is app-private and has no
 * meaning at all outside Spool, so it is exported for completeness and will not
 * open elsewhere.
 *
 * A runtime that is not known is written as `-1`, which is what the format
 * reserves for exactly that, rather than `0` — which reads as a zero-length
 * track.
 */
export function playlistToM3u(
  playlist: Playlist,
  records: readonly DownloadRecord[],
  artistFor: (r: DownloadRecord) => string | undefined = (r) => r.artist,
): ExportFile {
  const tracks = resolve(playlist, records);
  const lines = ['#EXTM3U', `#PLAYLIST:${playlist.name}`];

  for (const track of tracks) {
    const artist = artistFor(track);
    const seconds = track.seconds && track.seconds > 0 ? Math.round(track.seconds) : -1;
    lines.push(`#EXTINF:${seconds},${artist ? `${artist} - ` : ''}${track.title}`);
    lines.push(track.uri ?? '');
  }

  return {
    name: fileNameFor(playlist.name, 'm3u8'),
    mime: 'audio/x-mpegurl',
    // A trailing newline, because a file that does not end in one is the kind
    // of thing a strict parser refuses and nobody can see why.
    body: `${lines.join('\n')}\n`,
  };
}

/** What a backup carries. Versioned, because the reader will be a later build. */
export type Backup = {
  format: 'spool-backup';
  version: 1;
  exportedAt: number;
  playlists: {
    name: string;
    createdAt: number;
    /**
     * Tracks by **name**, not by id.
     *
     * The ids are the thing that does not survive: a reinstall rebuilds the
     * library from MediaStore and every row comes back under a `found:` id it
     * has never had before. A title and an artist are what the files themselves
     * still carry, which makes them the only handle a restore could use.
     */
    tracks: { title: string; artist?: string; seconds?: number }[];
  }[];
};

export function buildBackup(
  playlists: readonly Playlist[],
  records: readonly DownloadRecord[],
  now: number,
  artistFor: (r: DownloadRecord) => string | undefined = (r) => r.artist,
): ExportFile {
  const backup: Backup = {
    format: 'spool-backup',
    version: 1,
    exportedAt: now,
    playlists: playlists.map((list) => ({
      name: list.name,
      createdAt: list.createdAt,
      tracks: resolve(list, records).map((r) => ({
        title: r.title,
        artist: artistFor(r),
        seconds: r.seconds,
      })),
    })),
  };

  return {
    name: `spool-backup-${stamp(now)}.json`,
    mime: 'application/json',
    body: `${JSON.stringify(backup, null, 2)}\n`,
  };
}

/**
 * `2026-08-20` from an epoch, in local time.
 *
 * Local rather than UTC because the only reader is a person looking at a list
 * of files and deciding which one is yesterday's. `toISOString` would shift the
 * date by a day for anyone west of Greenwich in the evening.
 */
function stamp(now: number): string {
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "3 playlists · 41 tracks", so the confirmation states what was written. */
export function describeExport(
  playlists: readonly Playlist[],
  records: readonly DownloadRecord[],
): string {
  const tracks = playlists.reduce((sum, list) => sum + resolve(list, records).length, 0);
  const lists = `${playlists.length} playlist${playlists.length === 1 ? '' : 's'}`;
  return `${lists} · ${tracks} track${tracks === 1 ? '' : 's'}`;
}
