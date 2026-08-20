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
 */

const KEY_ARTWORK = 'dl.artwork';

export type Artwork = {
  /** file:// path to the cached cover. */
  uri: string;
  /** "#RRGGBB" — what the whole tint is built from. See tintFromDominant. */
  dominant: string;
};

/** `null` is a remembered failure: asked for, nothing found, do not ask again. */
type Index = Record<string, Artwork | null>;

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
  loaded = true;
}

/** What is known right now, without asking for anything. */
export const artworkFor = (id: string): Artwork | null => index[id] ?? null;

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
  if (id in index) return Promise.resolve(index[id]);
  const pending = inFlight.get(id);
  if (pending) return pending;

  if (!path && !urls.length) {
    index = { ...index, [id]: null };
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
      index = { ...index, [id]: null };
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
