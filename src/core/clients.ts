/**
 * Which InnerTube client to ask first, remembered across launches.
 *
 * `withClientFallback` already learns within a session: the client that answers
 * gets pinned and every later request that session starts there. That memory
 * dies with the process, so **every cold start re-pays the whole walk** — and
 * the walk is not cheap. Measured on the emulator over six downloads: `tv` leads
 * the open chain and was refused 3/3 with `The page needs to be reloaded.`,
 * costing a few seconds of the user's first download every single session, for a
 * client that had already been proven wrong on that device.
 *
 * The fix is a scoreboard rather than a switch, for one reason: **which clients
 * work changes underneath us**, monthly and without warning, and a hard-coded
 * reorder would be a guess frozen into the binary at build time. A score that
 * moves lets the device decide, and lets it change its mind.
 *
 * ## What it deliberately does not do
 *
 * It never removes a client. A score only reorders the chain, so the worst a
 * badly-scored client suffers is being asked last — which means a scoreboard
 * that has learned something wrong costs time and never a failed download. That
 * is the same bargain `judgeManifest` makes, and it is what makes it safe to
 * let this file learn from thin evidence.
 *
 * It is also not a cache of *answers*. Nothing here is trusted enough to skip
 * asking; it only decides the order of asking.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as log from './log';

const KEY = 'spool.clients.v1';

/**
 * Tokened and tokenless walks score separately.
 *
 * A client that serves us well without a token means something different, or
 * nothing at all, on a request that carries one — `web` is SABR-only when open
 * and perfectly good when tokened. One board for both would have each half
 * teaching the other the wrong lesson.
 */
export type Mode = 'open' | 'token';

/**
 * How fast the board forgets.
 *
 * `next = DECAY * score + (won ? 1 : -1)`, which settles at ±1/(1−DECAY) = ±4.
 * At 0.75 a client that has been losing for a long time is back to neutral
 * after three wins and ahead after four, so a client YouTube re-opens is picked
 * up again within one browsing session. A slower decay remembers longer and
 * takes proportionally longer to notice it is wrong, which is the trade the
 * whole file exists to make and the one number worth tuning.
 */
const DECAY = 0.75;

/** Beyond this a score stops meaning anything except "sort me first/last". */
const LIMIT = 1 / (1 - DECAY);

/**
 * A difference smaller than this is noise, and noise must not reorder the base
 * chain — the base order encodes yt-dlp's published requirement table, which is
 * better evidence than one lucky request.
 */
const MEANINGFUL = 0.5;

type Board = Record<string, number>;

let board: Board = {};
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** `null` is yt-dlp's own default chain and needs a name to be a key. */
const key = (mode: Mode, client: string | null) => `${mode}:${client ?? '*'}`;

/**
 * Reads the board into memory. Safe to call repeatedly; only the first does
 * anything.
 *
 * Failure is silent on purpose. This file is an optimisation — with an empty
 * board every chain is simply its base order, which is exactly how the app
 * behaved before it existed — and a download must never fail because a
 * preference could not be read.
 */
export async function loadClientScores(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const clean: Board = {};
    for (const [k, v] of Object.entries(parsed)) {
      // A hand-edited or half-written file must not be able to poison the
      // ordering with a NaN, which sorts unpredictably rather than loudly.
      if (typeof v === 'number' && Number.isFinite(v)) {
        clean[k] = Math.max(-LIMIT, Math.min(LIMIT, v));
      }
    }
    board = clean;
    log.debug('engine', 'client scores loaded', { entries: Object.keys(clean).length });
  } catch (e) {
    log.warn('engine', 'client scores unreadable', log.describe(e));
  }
}

/**
 * Debounced because a single download scores up to five times as the chain
 * walks, and the board is worth exactly one write per burst.
 */
function persist(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    AsyncStorage.setItem(KEY, JSON.stringify(board)).catch((e) =>
      log.warn('engine', 'client scores unsaved', log.describe(e)),
    );
  }, 2000);
}

function score(mode: Mode, client: string | null, won: boolean): void {
  const k = key(mode, client);
  const next = DECAY * (board[k] ?? 0) + (won ? 1 : -1);
  board[k] = Math.max(-LIMIT, Math.min(LIMIT, next));
  persist();
}

/** This client answered with something usable. */
export const clientWon = (mode: Mode, client: string | null) => score(mode, client, true);

/**
 * This client refused, or answered with a manifest that was not worth having.
 *
 * A degraded answer counts the same as a refusal, and should: from the user's
 * side a client that returns one muxed 360p and a client that returns 403 are
 * the same event, and the whole reason `judgeManifest` exists is that the app
 * used to be unable to tell them apart.
 */
export const clientLost = (mode: Mode, client: string | null) => score(mode, client, false);

/**
 * The base chain, reordered by what this device has learned.
 *
 * Stable: equal scores keep the base order, so on a fresh install — and for
 * every client that has never been tried — this returns the chain exactly as
 * written. `MEANINGFUL` is what stops a single unlucky request from outvoting
 * the requirement table the base order encodes.
 */
export function orderChain<T extends string | null>(mode: Mode, base: readonly T[]): T[] {
  const scored = base.map((client, index) => ({
    client,
    index,
    value: board[key(mode, client)] ?? 0,
  }));
  scored.sort((a, b) => {
    const delta = b.value - a.value;
    return Math.abs(delta) < MEANINGFUL ? a.index - b.index : delta;
  });
  return scored.map((s) => s.client);
}

/**
 * Wipes the board.
 *
 * Called when the engine replaces its own extractor, because that is the one
 * event that invalidates everything here at once: the scores describe how an
 * old extractor got on with YouTube, and after an update neither side is the
 * one that was measured.
 */
export function forgetClientScores(): void {
  board = {};
  persist();
}

/** What the log wants to say about the board. Small enough to print whole. */
export function clientScores(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(board)) out[k] = Math.round(v * 100) / 100;
  return out;
}

/** Test seam. */
export function resetClientScores(): void {
  board = {};
  loaded = false;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
}
