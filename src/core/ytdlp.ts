/**
 * The download engine, over the native yt-dlp module.
 *
 * Parsing lives here rather than in Kotlin so the Format model has exactly one
 * definition (see engine.ts).
 */

import YtDlp, { onProgress, type ProgressEvent } from '../../modules/ytdlp';
import {
  clientLost,
  clientScores,
  clientWon,
  forgetClientScores,
  loadClientScores,
  orderChain,
  type Mode,
} from './clients';
import type { DownloadProgress, Format, VideoRef } from './engine';
import * as log from './log';
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
 * Which InnerTube client to ask as when we have **no** PO token.
 *
 * The order is not a guess; it follows yt-dlp's published requirement table:
 *
 *   client       GVS token   player token
 *   tv           none        none
 *   web_embedded none        none          (embeddable videos only)
 *   mweb         required    none
 *   web          required    none          (and SABR-only)
 *   android/ios  required    required
 *   android_vr   required    none          (since 2026)
 *
 * `tv` leads because it is the only one that needs nothing — and the DRM-only
 * formats it is otherwise known for are exactly what `applyBrowserSession`'s
 * cookie handoff prevents. Being a real browser is what makes it a good first
 * choice for us and a bad one for a standalone downloader.
 *
 * `null` is yt-dlp's own default chain, second because it is maintained by
 * people watching this change weekly, and it is what actually served the one
 * download that worked during the 2026-08-21 pass.
 *
 * **`android_vr` is last, having been first.** It now requires a GVS token for
 * everything except format 18, so without one it answers with a single muxed
 * 360p and nothing else — which is precisely the degraded manifest that made
 * downloads look broken. It stays on the list only because one muxed 360p
 * still beats nothing, and `judgeManifest` will only settle for it once every
 * other client has failed.
 */
const OPEN_CHAIN: readonly (string | null)[] = ['tv', null, 'web_embedded', 'mweb', 'android_vr'];

/**
 * Which client to ask as when we **do** hold a token for this video.
 *
 * A token is minted by a platform and only validates there, so holding one
 * removes the choice rather than widening it: the client has to be the one the
 * token belongs to. Ours comes from `m.youtube.com`, which is `mweb` — the
 * client yt-dlp's guide recommends pairing a token with. `web` follows as the
 * near neighbour, and is second rather than first because it is SABR-only.
 *
 * This used to be hardcoded to `web` in Kotlin with no way to try anything
 * else. Walking a short chain here means the right pairing is *measured* rather
 * than asserted — whichever answers gets pinned for the session.
 */
const TOKEN_CHAIN: readonly (string | null)[] = ['mweb', 'web'];

/**
 * The client that last worked, kept separately for the two chains.
 *
 * One slot would let a client pinned while tokenless be tried first on a
 * tokened request, where it means something different or nothing at all.
 */
let preferredOpen: string | null | undefined;
let preferredToken: string | null | undefined;

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
 * `needs to be reloaded` and `nsig` were added the same way, from the log of a
 * live failure rather than from guessing. On a release build, `android_vr`
 * answered with one muxed 360p — degraded, so the walk moved on — and `tv` then
 * threw `ERROR: [youtube] <id>: The page needs to be reloaded.` Nothing here
 * matched it, so a phrase that plainly means "ask me differently" was read as a
 * final answer and the walk stopped on the second client of five, with `ios`,
 * `web` and the default never tried. Same shape as `format is not available`,
 * and found within minutes because the manifest and the error text were both in
 * the flight recorder.
 *
 * The cost of being wrong in this direction is one extra round of the chain
 * ending in the same error; the cost of being wrong in the other is a video
 * that never downloads while four untried clients could have served it.
 */
const looksBlocked = (e: unknown) =>
  /403|forbidden|sign in|not a bot|unable to download|player response|precondition|unavailable|format is not available|no video formats|needs to be reloaded|nsig/i.test(
    String((e as Error)?.message ?? e),
  );

const name = (client: string | null) => client ?? 'yt-dlp default';

type Attempt = { client: string | null; useToken: boolean; mode: Mode };

/**
 * Every (client, token) pair worth trying, in the order to try them.
 *
 * The second leg is the important one. Holding a token narrows the client
 * choice to the two that could have minted it, and if the token turns out to be
 * wrong — expired, bound to another video, or the wrong context entirely — that
 * leaves a two-client chain where a tokenless request would have had five. A
 * token would then make the app *worse* than having none, which is the one
 * thing it must never do. So an exhausted token chain falls through to the open
 * one with the token dropped, and the walk ends where it would have started if
 * nothing had been harvested at all.
 *
 * Each leg is ordered by its own scoreboard and led by its own remembered
 * client, because a client pinned while tokenless means something different, or
 * nothing at all, on a request that carries one.
 */
function attempts(hasToken: boolean): Attempt[] {
  const leg = (mode: Mode, base: readonly (string | null)[], useToken: boolean): Attempt[] => {
    // Reordered by what previous *launches* learned. The in-session pin still
    // wins outright — it is this run's evidence, and nothing beats that — so the
    // board only decides where a cold start begins. See ./clients.ts.
    const ordered = orderChain(mode, base);
    const preferred = mode === 'token' ? preferredToken : preferredOpen;
    const chain =
      preferred === undefined
        ? ordered
        : [preferred, ...ordered.filter((c) => c !== preferred)];
    return chain.map((client) => ({ client, useToken, mode }));
  };

  return hasToken
    ? [...leg('token', TOKEN_CHAIN, true), ...leg('open', OPEN_CHAIN, false)]
    : leg('open', OPEN_CHAIN, false);
}

/**
 * Tries each client in turn, then repairs a stale extractor and tries again.
 *
 * `judge` is the half that a thrown error cannot express. A client is not only
 * refused by failing — it can answer, successfully, with a manifest that has
 * almost nothing in it, and the walk used to treat that as the right answer
 * because nothing threw. Measured on the phone: `android_vr` returned a single
 * muxed 360p, was pinned as `preferredClient` for the rest of the session, and
 * `tv`, `ios` and `web` were never asked. Everything downstream then behaved
 * correctly on a manifest that was wrong — the replay rule found no audio
 * stream and gave up without a word.
 *
 * So a judged-degraded result does not win, but it is not thrown away either:
 * it is held as `fallback` and returned if the whole chain does no better. The
 * cost of judging too harshly is therefore only time, never a failed download,
 * which is what makes it safe to judge on "a healthy manifest has an audio-only
 * stream" rather than on something narrower.
 */
async function withClientFallback<T>(
  hasToken: boolean,
  run: (client: string | null, useToken: boolean) => Promise<T>,
  judge?: (result: T) => string | null,
): Promise<T> {
  const pin = (a: Attempt) => {
    if (a.mode === 'token') preferredToken = a.client;
    else preferredOpen = a.client;
  };

  let lastError: unknown;
  let fallback: { attempt: Attempt; result: T; why: string } | null = null;

  for (let pass = 0; pass < 2; pass++) {
    for (const attempt of attempts(hasToken)) {
      const { client, useToken, mode } = attempt;
      const preferred = mode === 'token' ? preferredToken : preferredOpen;
      try {
        const result = await run(client, useToken);
        const why = judge?.(result) ?? null;

        if (why) {
          if (!fallback) fallback = { attempt, result, why };
          // Scored as a loss, because from the user's side a client that hands
          // back one muxed 360p and a client that hands back 403 are the same
          // event — a download that does not do what was asked.
          clientLost(mode, client);
          log.warn('engine', 'client answered with a degraded manifest', {
            client: name(client),
            why,
          });
          continue;
        }

        if (preferred !== client) {
          // `mode`, not `hasToken` or `tokened`: `redact` matches the key on a
          // substring, so anything with "token" in its *name* comes out as
          // "<redacted ?>" — which is the one thing it must not do to a field
          // whose entire value is being a plain yes or no. Only keys are
          // matched, so "token" as a *value* is safe.
          log.info('engine', 'client accepted', { client: name(client), pass, mode });
        }
        clientWon(mode, client);
        pin(attempt);
        return result;
      } catch (e) {
        lastError = e;
        // A refusal is worth another client; a broken pipe or cancel is not.
        // Nor is either of them worth *scoring*: a client cannot be blamed for
        // a cancelled download or a dropped connection, and letting it be would
        // teach the board that whichever client was in hand when the user left
        // a tunnel is a bad one.
        if (!looksBlocked(e)) throw e;
        clientLost(mode, client);
        log.warn('engine', 'client refused', { client: name(client), mode, ...log.describe(e) });
      }
    }

    // Every client was turned away, which is also exactly what a months-stale
    // extractor looks like. Sideloaded apps get no store updates, so the only
    // repair path is in-place — take it once, then walk the chain again.
    //
    // A chain that only ever produced degraded answers gets the same treatment,
    // for the same reason: an extractor that has fallen behind YouTube reads as
    // a manifest with the interesting streams missing, not as an error.
    if (pass === 0 && !triedUpdate) {
      triedUpdate = true;
      try {
        const r = await YtDlp.updateEngine();
        log.info('engine', 'self-update', { status: r.status, version: r.version });
        preferredOpen = undefined;
        preferredToken = undefined;
        // The board describes how the *old* extractor got on with YouTube, and
        // after a replacement neither side is the one that was measured. Keeping
        // it would start the next walk from a preference about software that is
        // no longer installed.
        forgetClientScores();
        fallback = null;
        continue;
      } catch (e) {
        log.warn('engine', 'self-update failed', log.describe(e));
      }
    }
    break;
  }

  // Nothing was clean, but something answered. A thin manifest still downloads
  // something, and something is what the user asked for.
  if (fallback) {
    log.warn('engine', 'settling for the best degraded answer', {
      client: name(fallback.attempt.client),
      mode: fallback.attempt.mode,
      why: fallback.why,
    });
    pin(fallback.attempt);
    return fallback.result;
  }

  throw lastError;
}

/**
 * Whether a manifest is worth stopping the walk on.
 *
 * Returns `null` when it is fine, and otherwise a short reason that ends up in
 * the log. Deliberately only two rules, both of which describe a manifest that
 * is *obviously* not what YouTube normally serves:
 *
 *  - nothing at all, which is a refusal wearing a success;
 *  - no audio-only stream, which every healthy YouTube manifest has (`140`,
 *    `251`) and which a client serving a degraded response is missing.
 *
 * The second is the one that matters. Audio is the app's default `keepAs`, so a
 * manifest without an audio-only rung is the difference between the replay rule
 * working and it doing nothing at all.
 */
function judgeManifest(formats: readonly Format[]): string | null {
  if (!formats.length) return 'no formats at all';
  if (!formats.some((f) => f.kind === 'audio')) {
    return `no audio-only stream (${formats.length} format(s), all carrying video)`;
  }
  return null;
}

let ready: Promise<string> | null = null;

/** Extracting Python on first run takes a moment; only do it once. */
export function initEngine(): Promise<string> {
  if (!ready) {
    // Read alongside the engine rather than at import time. It has to be in
    // memory before the first walk orders a chain, and every path that walks one
    // awaits this first — so this is the one place that is both early enough and
    // guaranteed. A failure to read it is not a failure to initialise: an empty
    // board is simply the base order, which is how the app behaved before it
    // existed.
    ready = Promise.all([YtDlp.initialize(), loadClientScores()])
      .then(([version]) => version)
      .catch((e) => {
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

/** The manifest, in the one line a log reader needs to see what came back. */
export function shape(formats: readonly Format[]): Record<string, unknown> {
  return {
    total: formats.length,
    audioOnly: formats.filter((f) => f.kind === 'audio').length,
    muxed: formats.filter((f) => f.muxed).length,
    videoOnly: formats.filter((f) => f.kind === 'video' && !f.muxed).length,
    heights: [...new Set(formats.filter((f) => f.height).map((f) => f.height))]
      .sort((a, b) => (b ?? 0) - (a ?? 0))
      .slice(0, 8),
  };
}

export async function listFormats(
  ref: VideoRef,
  token?: { poToken?: string; visitorData?: string } | null,
): Promise<VideoMeta> {
  const f = log.flow('extract', `listFormats ${ref.videoId}`, {
    // Presence, not bytes — see `redact`. Whether a token was harvested decides
    // whether the chain walks at all, so it is the first fact worth having.
    poToken: token?.poToken ? 'present' : null,
    visitorData: token?.visitorData ? 'present' : null,
    preferred:
      preferredOpen === undefined ? 'none yet' : name(preferredOpen),
  });

  try {
    await initEngine();
    f.step('engine ready');

    const meta = await withClientFallback(
      !!token?.poToken,
      async (client, useToken) => {
        const began = Date.now();
        const raw = await YtDlp.listFormats(
          ref.url,
          useToken ? (token?.poToken ?? null) : null,
          useToken ? (token?.visitorData ?? null) : null,
          client,
        );
        const parsed = parseMeta(raw, ref);
        f.step('client answered', {
          client: name(client),
          spent: useToken,
          ms: Date.now() - began,
          ...shape(parsed.formats),
        });
        return parsed;
      },
      (m) => judgeManifest(m.formats),
    );

    f.ok('formats resolved', {
      title: meta.title,
      seconds: meta.durationSeconds,
      ...shape(meta.formats),
    });
    return meta;
  } catch (e) {
    f.fail(e);
    throw e;
  }
}

function parseMeta(raw: string, ref: VideoRef): VideoMeta {
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
  const format = selector(args.format, args.audioOnly);
  const resumeKey = partialKey(args.ref.videoId, args.audioOnly, args.format);

  const f = log.flow('download', `${args.id}`, {
    videoId: args.ref.videoId,
    // Whether a token was harvested decides whether the media fetch 403s, so it
    // is the first thing worth knowing when a download fails.
    poToken: args.token?.poToken ? 'present' : null,
    visitorData: args.token?.visitorData ? 'present' : null,
    audioOnly: args.audioOnly,
    seconds: args.seconds,
    // The selector and the format it was built from, together: nearly every
    // "Requested format is not available" is one of these two disagreeing with
    // the manifest the download client actually served.
    selector: format,
    pick: { id: args.format.id, kind: args.format.kind, muxed: args.format.muxed },
    // The name on disk, which is what decides whether this attempt resumes an
    // earlier one or starts from zero. Worth a line: "why did this download
    // start again from 0%" is otherwise unanswerable from the record.
    resumeKey,
    preferred:
      preferredOpen === undefined ? 'none yet' : name(preferredOpen),
    scores: clientScores(),
  });

  // Progress is far too chatty for the ring, so only the crossings are kept —
  // enough to tell "died at 3%" from "died at 99%", which is the difference
  // between a refused fetch and a merge or a full disk.
  let mark = 0;
  const sub = onProgress((e: ProgressEvent) => {
    if (e.id !== args.id) return;
    if (e.fraction >= mark) {
      f.step(`progress ${Math.round(mark * 100)}%`, { eta: Math.round(e.eta) });
      // Infinity rather than a clamp at 1. yt-dlp reports 100% and then goes on
      // reporting it while ffmpeg remuxes — measured at six identical lines for
      // a nineteen-second video — and a clamped mark matches every one of them.
      mark = mark >= 1 ? Infinity : mark + 0.25;
    }
    onTick({ fraction: e.fraction, etaSeconds: e.eta });
  });

  const promise = initEngine()
    .then(() =>
      withClientFallback(!!args.token?.poToken, (client, useToken) => {
        // `spent` rather than `token`: the whole reason the walk has a second
        // leg is that a held token can be the thing that is wrong, and the log
        // has to be able to say which attempt carried it.
        f.step('asking', { client: name(client), spent: useToken });
        return YtDlp.download({
          id: args.id,
          url: args.ref.url,
          title: args.ref.title,
          format,
          audioOnly: args.audioOnly,
          poToken: useToken ? args.token?.poToken : undefined,
          visitorData: useToken ? args.token?.visitorData : undefined,
          clients: client ?? undefined,
          resumeKey,
          seconds: args.seconds,
        });
      }),
    )
    .then((out) => {
      // Loud, because it is the one success worth reading twice: the media is
      // complete and something after it went wrong. If this starts appearing
      // on every save, a postprocessor has broken and the files are quietly
      // losing their cover art and tags.
      if (out.salvagedFrom) {
        log.warn('download', 'kept a finished file the engine gave up on', {
          jobId: args.id,
          why: out.salvagedFrom,
        });
      }
      f.ok('file written', {
        bytes: out.bytes,
        ext: out.path.split('.').pop(),
        salvaged: !!out.salvagedFrom,
      });
      return out;
    })
    .catch((e) => {
      // A cancel is a decision, not a fault, and logging it as an error would
      // put a red line in the record for the user doing exactly as they meant.
      if ((e as any)?.code === 'E_CANCELLED') f.gaveUp('cancelled');
      else f.fail(e);
      throw e;
    })
    .finally(() => sub.remove());

  return {
    promise,
    cancel: () => {
      f.step('cancel requested');
      sub.remove();
      YtDlp.cancel(args.id).catch((e) => log.warn('download', 'cancel failed', log.describe(e)));
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
 * Drops this device's copy of the YouTube session — every cookie, the WebView's
 * DOM storage, and any cookie jar yt-dlp was handed.
 *
 * Not a sign-out at Google. The session on Google's side is still live and only
 * Google can revoke it; what this removes is the credential stored here, which
 * is the half the app is responsible for. The copy says so, because a control
 * labelled "sign out" that leaves a session standing somewhere is a lie the user
 * cannot check.
 *
 * The caller must remount the WebView after this resolves, not before — a page
 * loading through the removal simply writes the cookies back.
 */
export const signOutOfYouTube = () => YtDlp.signOutOfYouTube();

/**
 * FLAG_SECURE on the app's window: no screenshot, no screen recording, no
 * mirroring to a display that is not itself secure.
 *
 * Held only while the page is on a Google sign-in host — see `isSignInPage`.
 * The flag is per-window, not per-view, so leaving it on would quietly stop the
 * user screenshotting their own library.
 */
export const setSecureWindow = (on: boolean) => YtDlp.setSecureWindow(on);

/**
 * Sets screen orientation ('landscape', 'portrait', or 'unspecified') for fullscreen video playback.
 */
export const setScreenOrientation = (orientation: 'landscape' | 'portrait' | 'unspecified') => {
  try {
    if (typeof YtDlp?.setScreenOrientation === 'function') {
      YtDlp.setScreenOrientation(orientation);
    }
  } catch (err) {
    log.warn('orientation', `Failed to set screen orientation to ${orientation}`, { error: String(err) });
  }
};

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
/**
 * The name on disk this attempt writes under — stable across retries.
 *
 * Downloads used to be named for the job id, which is minted per attempt, so
 * nothing ever resumed: yt-dlp continues into the file it was already writing,
 * and a name that never repeats guarantees there is no such file. A 141 MB save
 * interrupted at 90% began again at 0%, and every abandoned `.part` sat in
 * app-private storage until the 24-hour sweep. On the connection that made the
 * download fail in the first place, "start again from zero" is not a retry
 * policy — it is a download that never completes.
 *
 * Two rules make the shared name safe, and both are why this is not simply the
 * video id:
 *
 *  - **The quality is in the key.** A `.part` is per-format, and resuming a
 *    720p body into a 1080p file would produce a corrupt one. Splitting audio
 *    from each video height means an attempt can only ever resume something
 *    that was asking for the same thing.
 *  - **It is ASCII by construction.** A title cannot be used here: the
 *    filesystem's 255 limit counts bytes and a styled-Unicode title exceeds it
 *    at eighty characters, killing the write before any media lands.
 *
 * The filter is defensive rather than necessary — a YouTube id is already in
 * this alphabet — but this value becomes a path, and a path built from a remote
 * string with no filter is a habit worth not having.
 */
export function partialKey(videoId: string, audioOnly: boolean, format: Format): string {
  const id = (videoId || 'video').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) || 'video';
  return `${id}.${audioOnly ? 'a' : `v${format.height ?? 0}`}`;
}

function selector(format: Format, audioOnly: boolean): string {
  if (audioOnly) {
    const cap = format.kbps ? `bestaudio[abr<=${Math.round(format.kbps)}]/` : '';
    // `/best` is the tail that makes this branch total.
    //
    // Every term before it can name nothing: the id belongs to whichever
    // manifest listed it, and `bestaudio` itself is absent from a degraded
    // manifest that came back holding only muxed streams — which is exactly the
    // manifest `bestAudio` now falls back to a muxed format for. Without a tail
    // that always resolves, yt-dlp answers `Requested format is not available`
    // and an audio save fails on a video whose audio was right there inside the
    // muxed rung. `-x` extracts it either way, so `best` is a correct answer
    // here and not merely a safe one.
    return `${format.id}/${cap}bestaudio/best`;
  }

  const cap = format.height ? `[height<=${format.height}]` : '';
  // The uncapped tail is already total, so only a capped one needs the extra
  // `/best` — every term in it can be filtered out of existence by the ceiling.
  const fallback = cap
    ? `bestvideo${cap}+bestaudio/best${cap}/best`
    : 'bestvideo+bestaudio/best';

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
