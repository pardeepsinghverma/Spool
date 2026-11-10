import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import YtDlp from '../../modules/ytdlp';
import type { DownloadRecord } from './storage';

/**
 * Cover art, resolved once per item and then remembered.
 *
 * The design's first rule is that the artwork is the interface — every surface
 * behind the current item derives from its dominant colour. That needs pixels,
 * which JavaScript cannot reach, so the decode is native. This is the part that
 * makes sure it happens exactly once.
 *
 * Three layers of memory, deliberately:
 *
 * - an in-memory map, so a scrolling list never asks twice in one session;
 * - an in-flight map, so eight rows appearing at once produce one native call
 *   rather than eight races writing the same cache file;
 * - AsyncStorage, so a relaunch does not re-decode a library the user already
 *   has, and so a cover fetched over the network is never fetched again.
 *
 * Failure is remembered too. An item with no artwork anywhere would otherwise
 * be retried on every render for the life of the app — and for a library saved
 * from pages that no longer exist, that is a network call per row per launch.
 *
 * **But not forever, and a success is not trusted blindly either.** Both used
 * to be permanent, and measured on the S21 FE they left most of a 104-item
 * library drawn as blank squares over files that each had a cover embedded:
 * whatever went wrong once — a build whose decode failed, a moment offline, a
 * cache Android had emptied — was never looked at again. A failure now expires
 * after `RETRY_FAILED_MS`, and a cover whose cached file is gone is dropped at
 * load so the next resolve rebuilds it.
 */

const KEY_ARTWORK = 'dl.artwork';

export type Artwork = {
  /** file:// path to the cached cover. */
  uri: string;
  /** "#RRGGBB" — what the whole tint is built from. See tintFromDominant. */
  dominant: string;
};

/** A remembered failure: asked for, nothing found, not asked again until it expires. */
type Failure = { failedAt: number };

/**
 * `null` is how a failure was stored before failures carried a time. It is
 * read as already expired, so a library that was blanked by the old rule is
 * looked at once more on the next launch rather than never.
 */
type Index = Record<string, Artwork | Failure | null>;

/**
 * How long "nothing here" is believed. Long enough that an item with no cover
 * anywhere costs one attempt a day rather than one per render; short enough
 * that a failure caused by the moment — offline, a refused thumbnail — heals
 * by itself.
 */
const RETRY_FAILED_MS = 24 * 60 * 60 * 1000;

const isArt = (entry: Index[string] | undefined): entry is Artwork =>
  !!entry && typeof (entry as Artwork).uri === 'string' && (entry as Artwork).uri.length > 0;

const failed = (): Failure => ({ failedAt: Date.now() });

let index: Index = {};
let loaded = false;
const inFlight = new Map<string, Promise<Artwork | null>>();

/**
 * How many covers may be resolved at once.
 *
 * The library hands over everything it has on boot, so without this a first run
 * against a few hundred saved items would open a few hundred simultaneous
 * connections — to fill list rows the user has not scrolled to yet. Three is
 * enough that the visible rows fill immediately and low enough that it never
 * competes with a download.
 */
const MAX_PARALLEL = 3;
let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<void> {
  if (active < MAX_PARALLEL) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waiting.push(resolve));
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else active--;
}

/** Subscribers are the screens; re-rendering them is how art appears. */
const listeners = new Set<() => void>();

export function onArtworkChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let flushTimer: ReturnType<typeof setTimeout> | null = null;
function schedule() {
  listeners.forEach((fn) => fn());
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void AsyncStorage.setItem(KEY_ARTWORK, JSON.stringify(index)).catch(() => {});
  }, 2000);
}

export async function loadArtworkIndex(): Promise<void> {
  if (loaded) return;
  try {
    const raw = await AsyncStorage.getItem(KEY_ARTWORK);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') index = parsed;
  } catch {
    // A lost cache costs one re-decode per item, nothing more.
  }
  dropMissingCovers();
  loaded = true;
}

/**
 * The covers live in `cacheDir`, which Android and "Clear cache" empty
 * whenever they like; this index lives in AsyncStorage and does not go with
 * it. An entry pointing at a deleted file draws a blank square and, being a
 * success, would never be asked about again. One synchronous native call for
 * the whole index, once per launch.
 */
function dropMissingCovers(): void {
  const known = Object.entries(index).filter((pair): pair is [string, Artwork] => isArt(pair[1]));
  if (!known.length) return;
  let present: boolean[];
  try {
    present = YtDlp.filesExist(known.map(([, art]) => art.uri));
  } catch {
    return; // Cannot tell, so believe the index — the old behaviour, no worse.
  }
  if (!Array.isArray(present)) return;
  const gone = known.filter((_, i) => present[i] === false).map(([id]) => id);
  if (!gone.length) return;
  const next = { ...index };
  gone.forEach((id) => delete next[id]);
  index = next;
  schedule();
}

/** What is known right now, without asking for anything. */
export const artworkFor = (id: string): Artwork | null => {
  const entry = index[id];
  return isArt(entry) ? entry : null;
};

/**
 * Thumbnail candidates, best first — the native side takes the first that
 * answers.
 *
 * Order is about shape before size. `maxresdefault` and `hq720` are true 16:9;
 * `hqdefault` is 4:3 with black bars padded into the image, which is what put a
 * letterboxed cover on the player. It stays last because it is the only one
 * guaranteed to exist, and the native trim removes its bars anyway — this
 * ordering just avoids relying on that.
 */
const thumbnailUrls = (videoId: string) => [
  `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
  `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
  `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
];

/**
 * Resolve the artwork for a saved download, if it has not been resolved before.
 *
 * The local file is offered first so an embedded cover wins; the thumbnail URL
 * is the fallback for everything downloaded before embedding existed.
 */
export function resolveArtwork(record: DownloadRecord): Promise<Artwork | null> {
  // Handed over whole, scheme and all. Manual saves are published to MediaStore
  // and come back as content:// — stripping to a bare path would have left the
  // embedded cover unreachable for exactly the items the user chose by hand,
  // which is most of a real library.
  return resolve(
    record.id,
    record.uri ?? null,
    record.videoId ? thumbnailUrls(record.videoId) : [],
  );
}

/**
 * The cover for a video that is only being *watched* — a YouTube page in the
 * browser, which has no library row and no file. It exists so the notification
 * looks the same whichever half of the app is playing.
 *
 * Keyed apart from download ids on purpose: the same video can be both a page
 * and a saved file, and the file's own embedded cover is the better source of
 * the two. Letting them share a key would let whichever resolved first answer
 * for both.
 */
export function resolveVideoArtwork(videoId: string): Promise<Artwork | null> {
  if (!videoId) return Promise.resolve(null);
  return resolve(`yt:${videoId}`, null, thumbnailUrls(videoId));
}

function resolve(id: string, path: string | null, urls: string[]): Promise<Artwork | null> {
  const known = index[id];
  if (isArt(known)) return Promise.resolve(known);
  if (known && Date.now() - known.failedAt < RETRY_FAILED_MS) return Promise.resolve(null);
  const pending = inFlight.get(id);
  if (pending) return pending;

  if (!path && !urls.length) {
    index = { ...index, [id]: failed() };
    schedule();
    return Promise.resolve(null);
  }

  const task = acquire()
    .then(() => YtDlp.readArtwork(id, path, urls))
    .then((result): Artwork | null => {
      const art = { uri: result.uri, dominant: result.dominant };
      index = { ...index, [id]: art };
      schedule();
      return art;
    })
    .catch(() => {
      index = { ...index, [id]: failed() };
      schedule();
      return null;
    })
    .finally(() => {
      inFlight.delete(id);
      release();
    });

  inFlight.set(id, task);
  return task;
}

/**
 * Bumps whenever anything is resolved. Screens read `artworkFor` directly; this
 * is only how they learn to look again — covers arrive after first paint, which
 * is exactly why the placeholder glyph has to stay good-looking.
 */
export function useArtworkVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => onArtworkChange(() => setVersion((n) => n + 1)), []);
  return version;
}

/** Drops one item's memory, so removing and re-adding it looks again. */
export function forgetArtwork(id: string): void {
  if (!(id in index)) return;
  const { [id]: _gone, ...rest } = index;
  index = rest;
  schedule();
}
