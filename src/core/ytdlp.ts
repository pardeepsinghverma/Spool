/**
 * The download engine, over the native yt-dlp module.
 *
 * Parsing lives here rather than in Kotlin so the Format model has exactly one
 * definition (see engine.ts).
 */

import YtDlp, { onProgress, type ProgressEvent } from '../../modules/ytdlp';
import type { DownloadProgress, Format, VideoRef } from './engine';
import { clean } from './metadata';

export const IS_PREVIEW = false;

export type VideoMeta = {
  id: string;
  title: string;
  channel: string;
  durationSeconds: number;
  formats: Format[];
};

type RawFormat = {
  format_id: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number;
  fps?: number;
  filesize?: number | null;
  filesize_approx?: number | null;
  abr?: number | null;
  format_note?: string;
};

/**
 * Without a PO token the only lever left is which InnerTube client we ask as,
 * and which of them still serve unattested requests changes month to month.
 * Betting on one guarantees the app breaks; walking them means it degrades.
 *
 * `null` is yt-dlp's own default chain, kept last so a future version that has
 * already solved this wins without a code change.
 */
const CLIENT_CHAIN: readonly (string | null)[] = ['android_vr', 'tv', 'ios', 'web', null];

/**
 * The client that last worked. Listing and downloading must agree on one — a
 * format id from one client's manifest 403s when fetched as another.
 */
let preferredClient: string | null | undefined;

/** The engine can only repair itself once per session; it is a network call. */
let triedUpdate = false;

/**
 * Whether this failure is worth asking a different client.
 *
 * `format is not available` earns its place here from a measurement. A client
 * that is refused mid-download does not always say 403 — it hands back a
 * manifest with nothing usable in it, and yt-dlp reports that as
 * `Requested format is not available`. Because that phrase matched nothing
 * here, the walk treated it as a real answer and stopped on the *second* client
 * of five, with `ios`, `web` and the default never tried at all.
 *
 * Seen on the phone three times on unrelated videos, always the same shape:
 * `client accepted: android_vr` while listing, `client refused: android_vr` on
 * the download, then the error. What the user gets is a download that fails for
 * no stated reason — `readableError` has no branch for it either, so the copy
 * blames free space and connection.
 *
 * The cost of being wrong in this direction is one extra round of the chain
 * ending in the same error; the cost of being wrong in the other is a video
 * that never downloads while four untried clients could have served it.
 */
const looksBlocked = (e: unknown) =>
  /403|forbidden|sign in|not a bot|unable to download|player response|precondition|unavailable|format is not available|no video formats/i.test(
    String((e as Error)?.message ?? e),
  );

/** Tries each client in turn, then repairs a stale extractor and tries again. */
async function withClientFallback<T>(
  hasToken: boolean,
  run: (client: string | null) => Promise<T>,
): Promise<T> {
  // A token pins the request to the web client (see applyExtractorArgs), so
  // walking the chain would just repeat the identical request five times.
  if (hasToken) return run(null);

  let lastError: unknown;

  for (let pass = 0; pass < 2; pass++) {
    const chain =
      preferredClient === undefined
        ? CLIENT_CHAIN
        : [preferredClient, ...CLIENT_CHAIN.filter((c) => c !== preferredClient)];

    for (const client of chain) {
      try {
        const result = await run(client);
        if (preferredClient !== client) {
          console.log(`[spool] client accepted: ${client ?? 'yt-dlp default'}`);
        }
        preferredClient = client;
        return result;
      } catch (e) {
        lastError = e;
        // A refusal is worth another client; a broken pipe or cancel is not.
        if (!looksBlocked(e)) throw e;
        console.log(`[spool] client refused: ${client ?? 'yt-dlp default'}`);
      }
    }

    // Every client was turned away, which is also exactly what a months-stale
    // extractor looks like. Sideloaded apps get no store updates, so the only
    // repair path is in-place — take it once, then walk the chain again.
    if (pass === 0 && !triedUpdate) {
      triedUpdate = true;
      try {
        const r = await YtDlp.updateEngine();
        console.log(`[spool] engine self-update: ${r.status} -> ${r.version}`);
        preferredClient = undefined;
        continue;
      } catch (e) {
        console.log('[spool] engine self-update failed:', String(e));
      }
    }
    break;
  }

  throw lastError;
}

let ready: Promise<string> | null = null;

/** Extracting Python on first run takes a moment; only do it once. */
export function initEngine(): Promise<string> {
  if (!ready) {
    ready = YtDlp.initialize().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export const engineVersion = () => YtDlp.version();

export async function updateEngine() {
  await initEngine();
  return YtDlp.updateEngine();
}

export async function listFormats(
  ref: VideoRef,
  token?: { poToken?: string; visitorData?: string } | null,
): Promise<VideoMeta> {
  await initEngine();
  const raw = await withClientFallback(!!token?.poToken, (client) =>
    YtDlp.listFormats(
      ref.url,
      token?.poToken ?? null,
      token?.visitorData ?? null,
      client,
    ),
  );

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Engine returned malformed metadata');
  }

  const formats: Format[] = (parsed.formats ?? [])
    .filter((f: RawFormat) => f && f.format_id && !isStoryboard(f))
    .map(toFormat)
    .filter((f: Format | null): f is Format => f !== null);

  // One of the two boundaries where a name enters the app, and the one every
  // download path runs through — the FAB, the replay rule, the notification's
  // save button and a failed row's retry all read this `title`, and it is what
  // ends up as the filename in the user's gallery. Cleaning it here rather than
  // at each of those four is what stops one of them being forgotten.
  const named = clean({
    title: parsed.title ?? ref.title,
    artist: parsed.channel ?? parsed.uploader ?? '',
  });

  return {
    id: parsed.id ?? ref.videoId,
    title: named.title,
    channel: named.artist,
    durationSeconds: Number(parsed.duration ?? 0),
    formats: dedupe(formats),
  };
}

export function startDownload(
  args: {
    id: string;
    ref: VideoRef;
    format: Format;
    audioOnly: boolean;
    token?: { poToken?: string; visitorData?: string } | null;
    /** Length of the video, so a pre-release build can refuse an over-long one. */
    seconds?: number;
  },
  onTick: (p: DownloadProgress) => void,
): { promise: Promise<{ path: string; bytes: number }>; cancel: () => void } {
  const sub = onProgress((e: ProgressEvent) => {
    if (e.id !== args.id) return;
    onTick({ fraction: e.fraction, etaSeconds: e.eta });
  });

  // Whether a token was harvested decides whether the media fetch 403s, so it
  // is the first thing worth knowing when a download fails.
  console.log(
    `[spool] download token: poToken=${args.token?.poToken ? 'yes' : 'NO'} ` +
      `visitorData=${args.token?.visitorData ? 'yes' : 'NO'}`,
  );

  const promise = initEngine()
    .then(() =>
      withClientFallback(!!args.token?.poToken, (client) =>
        YtDlp.download({
          id: args.id,
          url: args.ref.url,
          title: args.ref.title,
          format: selector(args.format, args.audioOnly),
          audioOnly: args.audioOnly,
          poToken: args.token?.poToken,
          visitorData: args.token?.visitorData,
          clients: client ?? undefined,
          seconds: args.seconds,
        }),
      ),
    )
    .finally(() => sub.remove());

  return {
    promise,
    cancel: () => {
      sub.remove();
      YtDlp.cancel(args.id).catch(() => {});
    },
  };
}

export const publishToGallery = (path: string, title: string, audioOnly: boolean) =>
  YtDlp.publishToGallery(path, title, audioOnly);

/**
 * A text file into `Downloads/Spool` — an exported playlist, or a backup.
 *
 * Here rather than called through the module directly, so every native call in
 * the app goes through the one file that knows what the native side is.
 */
export const writeTextFile = (name: string, mime: string, body: string) =>
  YtDlp.writeTextFile(name, mime, body);

/** What is already in Music/Spool and Movies/Spool. See `adoptSaved`. */
export const scanSaved = () => YtDlp.scanSaved();

/**
 * A video-only stream has to be paired with audio or the file is silent —
 * yt-dlp merges the pair itself using the bundled ffmpeg.
 *
 * **Every id is followed by a description of what it was.** A format id only
 * means anything inside the manifest it came from, and `withClientFallback` can
 * hand the download to a different client than the one that listed the formats:
 * the listing succeeds on `android_vr`, the download is refused there, the chain
 * moves on, and `140` now names nothing. Measured twice in a row on the phone,
 * on unrelated videos, and it surfaces as
 * `Requested format is not available` — which is not a phrase `looksBlocked`
 * recognises, so it is not retried either. It simply reads as a download that
 * failed for no reason.
 *
 * yt-dlp reads `/` as "or", left to right, so appending a description of the
 * same stream costs nothing when the id is valid and is the whole difference
 * between a working download and that error when it is not. The fallbacks are
 * ceilings rather than demands, which is the same rule the quality settings
 * follow: the point is to come back with the nearest thing, not to insist.
 */
function selector(format: Format, audioOnly: boolean): string {
  if (audioOnly) {
    const cap = format.kbps ? `bestaudio[abr<=${Math.round(format.kbps)}]/` : '';
    return `${format.id}/${cap}bestaudio`;
  }

  const cap = format.height ? `[height<=${format.height}]` : '';
  const fallback = `bestvideo${cap}+bestaudio/best${cap}`;

  return format.muxed
    ? `${format.id}/${fallback}`
    : `${format.id}+bestaudio/${fallback}`;
}

function toFormat(f: RawFormat): Format | null {
  const hasVideo = !!f.vcodec && f.vcodec !== 'none';
  const hasAudio = !!f.acodec && f.acodec !== 'none';
  if (!hasVideo && !hasAudio) return null;

  return {
    id: f.format_id,
    kind: hasVideo ? 'video' : 'audio',
    height: hasVideo ? (f.height ?? undefined) : undefined,
    fps: hasVideo ? (f.fps ?? undefined) : undefined,
    container: f.ext ?? 'mp4',
    codec: shortCodec(hasVideo ? f.vcodec! : f.acodec!),
    kbps: !hasVideo && f.abr ? Math.round(f.abr) : undefined,
    size: f.filesize ?? f.filesize_approx ?? undefined,
    muxed: hasVideo && hasAudio,
  };
}

const shortCodec = (codec: string): string => {
  const c = codec.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'h264';
  if (c.startsWith('vp9') || c.startsWith('vp09')) return 'vp9';
  if (c.startsWith('av01')) return 'av1';
  if (c.startsWith('mp4a')) return 'aac';
  if (c.startsWith('opus')) return 'opus';
  return c.split('.')[0];
};

const isStoryboard = (f: RawFormat) =>
  f.ext === 'mhtml' || f.format_id.startsWith('sb');

/** yt-dlp lists several near-identical rungs; keep the best per resolution. */
function dedupe(formats: Format[]): Format[] {
  const best = new Map<string, Format>();
  for (const f of formats) {
    const key = f.kind === 'audio' ? `a:${f.container}` : `v:${f.height}:${f.muxed}`;
    const existing = best.get(key);
    if (!existing || (f.size ?? 0) > (existing.size ?? 0)) best.set(key, f);
  }
  return [...best.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
    return (b.height ?? 0) - (a.height ?? 0);
  });
}
