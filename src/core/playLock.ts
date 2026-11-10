import { useEffect, useState } from 'react';
import { endpoint, lastServerContact, request, signedIn, type Reply } from './account';
import * as log from './log';

/**
 * One account, one device making sound at a time.
 *
 * Accounts follow the user to any number of devices, which is the point of
 * them — and without this, also a way for one ₹29 to play in five houses at
 * once. So a signed-in device claims a short lease from the server before the
 * local player starts, renews it while playing, and gives it back on pause.
 * A second device asking while the lease is held is told where the music is,
 * and may take over, which ends the first device's lease; the first finds out
 * on its next heartbeat and pauses. That is the whole protocol — Spotify's,
 * deliberately, because people already know how it behaves.
 *
 * **Signed out, none of this applies.** The lock belongs to the account; a
 * device with no session plays its own library exactly as it always has.
 *
 * **The network is not allowed to be the reason music stops**, within reason.
 * Spool is an offline player first. A claim that cannot reach the server is
 * allowed as long as the server was last heard from inside `OFFLINE_GRACE_MS`;
 * past that the device has been out of contact long enough that the lock would
 * mean nothing if it did not ask, and the user is told to reconnect. A
 * heartbeat that fails is never a reason to pause — only a heartbeat the server
 * *answers* with "playing elsewhere" is.
 *
 * **Timers are not trusted to run.** A backgrounded React Native process gets
 * its timers late, and sometimes very late. Nothing here counts heartbeats: a
 * missed one just means the lease may have lapsed on the server, and the next
 * one re-claims *without* takeover. If that comes back 409, someone else
 * started playing in the gap — which is exactly the case where this device
 * should stop.
 *
 * The decision is `judge`, a pure function; everything else is plumbing around
 * it, kept here so `PlayerContext` changes by a handful of lines.
 */

/**
 * How long a device that cannot reach the server may keep starting playback.
 *
 * A day, because the offline cases worth serving are a flight, a commute
 * through a dead zone, a weekend somewhere without signal — and because the
 * lease being defended costs ₹29 a month. Longer makes the lock trivially
 * defeated by airplane mode; shorter punishes exactly the people this app was
 * built for.
 */
export const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;

/** Renewal cadence while playing. Half the server's 120 s lease, so one late tick is survivable. */
export const HEARTBEAT_MS = 60_000;

/** What the server grants when it does not say. */
const DEFAULT_LEASE_MS = 120_000;

/**
 * Taken off the lease before treating it as held, so a claim that took a few
 * seconds to arrive is not trusted to the last millisecond.
 */
const LEASE_MARGIN_MS = 10_000;

/** A start that waits on the network waits at most this long. */
const CLAIM_TIMEOUT_MS = 5000;

export type Verdict =
  /** Play. `until` is how long to go on believing so without asking again. */
  | { play: true; until: number; leased: boolean }
  /** Another device holds the lock. */
  | { play: false; elsewhere: string }
  /** Out of contact for longer than the grace. */
  | { play: false; offline: true };

/**
 * The whole decision, given what the server said (or did not).
 *
 * `signed-out` / `blocked` / `unconfigured` all allow: in each of them there is
 * no longer a session, so there is no longer an account lock to honour.
 * Anything that is not a clear grant or a clear 409 — a network failure, a
 * 5xx, a 429, a 400 — is no news, and falls to the grace.
 */
export function judge(reply: Reply, now: number, lastContact: number): Verdict {
  if (reply.kind === 'ok' && reply.body.ok === true) {
    const lease = Number(reply.body.leaseMs);
    const ms = Number.isFinite(lease) && lease > 0 ? lease : DEFAULT_LEASE_MS;
    return { play: true, until: now + Math.max(ms - LEASE_MARGIN_MS, ms / 2), leased: true };
  }
  if (reply.kind === 'refused' && reply.status === 409) {
    const device = typeof reply.body.device === 'string' && reply.body.device ? reply.body.device : 'another device';
    return { play: false, elsewhere: device };
  }
  if (reply.kind === 'signed-out' || reply.kind === 'blocked' || reply.kind === 'unconfigured') {
    // A permit rather than 0: with a session still stored but no server to ask
    // (a build without one), 0 would send the caller's retry straight back
    // here, forever.
    return { play: true, until: now + HEARTBEAT_MS, leased: false };
  }
  if (lastContact > 0 && now - lastContact < OFFLINE_GRACE_MS) {
    // A permit, not a lease: good until the next heartbeat asks again.
    return { play: true, until: now + HEARTBEAT_MS, leased: false };
  }
  return { play: false, offline: true };
}

/** What the shell shows. `retry` re-runs whatever was refused. */
export type Notice =
  | { kind: 'elsewhere'; device: string; retry: (() => void) | null }
  | { kind: 'moved'; device: string; retry: (() => void) | null }
  | { kind: 'offline' };

let until = 0;
let leased = false;
let notice: Notice | null = null;
const listeners = new Set<() => void>();

const setNotice = (next: Notice | null) => {
  notice = next;
  listeners.forEach((fn) => fn());
};

export const playNotice = () => notice;
export const dismissPlayNotice = () => setNotice(null);

/**
 * The fast path. True when this device may start sound *now* without waiting
 * on anything — signed out, or holding a lease or permit that has not run out.
 * Synchronous on purpose: the common resume must not grow a network round trip.
 */
export function playPermitted(now = Date.now()): boolean {
  if (!signedIn()) return true;
  return until > now;
}

async function claim(takeover: boolean): Promise<Verdict> {
  const { device } = endpoint();
  const reply = await request('/v1/play/claim', {
    method: 'POST',
    auth: true,
    body: { device, takeover },
    timeoutMs: CLAIM_TIMEOUT_MS,
  });
  const verdict = judge(reply, Date.now(), lastServerContact());
  if (verdict.play) {
    until = verdict.until;
    leased = verdict.leased;
  } else {
    until = 0;
    leased = false;
  }
  return verdict;
}

/**
 * Ask for the lock before starting sound. Resolves true when the caller may
 * go ahead; false when it must not, in which case the notice explaining why
 * is already up. `retry` is what "Play here instead" runs once the takeover
 * has been granted.
 */
export async function claimPlay(retry?: () => void): Promise<boolean> {
  if (!signedIn()) return true;
  const verdict = await claim(false);
  if (verdict.play) {
    if (notice?.kind !== 'moved') setNotice(null);
    return true;
  }
  if ('elsewhere' in verdict) {
    log.info('playlock', 'playing elsewhere');
    setNotice({ kind: 'elsewhere', device: verdict.elsewhere, retry: retry ?? null });
  } else {
    log.info('playlock', 'refused offline');
    setNotice({ kind: 'offline' });
  }
  return false;
}

/**
 * "Play here instead." Takes the lock from the other device and re-runs what
 * was refused. The notice stays up with the failure if the takeover itself
 * fails, rather than vanishing as though it had worked.
 */
export async function takeOver(): Promise<boolean> {
  const pending = notice && notice.kind !== 'offline' ? notice.retry : null;
  const verdict = await claim(true);
  if (!verdict.play) {
    setNotice('elsewhere' in verdict ? { kind: 'elsewhere', device: verdict.elsewhere, retry: pending } : { kind: 'offline' });
    return false;
  }
  log.info('playlock', 'took over playback');
  setNotice(null);
  pending?.();
  return true;
}

/**
 * The heartbeat. Called on a timer by the player whether or not anything is
 * playing, so that a pause from any path — the notification, the sleep timer,
 * another app taking audio focus — releases the lease within one tick even if
 * that path never told us.
 *
 * `resume` is what the "moved" notice offers to run if the user wants the
 * music back here.
 */
export async function beat(playing: boolean, pause: () => void, resume?: () => void): Promise<void> {
  if (!signedIn()) return;
  if (!playing) {
    if (leased) releasePlay();
    return;
  }
  const verdict = await claim(false);
  if (verdict.play) return;
  if ('elsewhere' in verdict) {
    log.info('playlock', 'playback moved elsewhere');
    pause();
    setNotice({ kind: 'moved', device: verdict.elsewhere, retry: resume ?? null });
    return;
  }
  // Out of contact past the grace. The track already playing is left to
  // finish — pausing mid-song over a network fault is the thing this module
  // promises not to do — and the permit is gone, so the next start will ask.
}

/** Give the lease back. Best-effort: the server's own expiry is the backstop. */
export function releasePlay(): void {
  const wasLeased = leased;
  until = 0;
  leased = false;
  if (!wasLeased || !signedIn()) return;
  const { device } = endpoint();
  void request('/v1/play/release', { method: 'POST', auth: true, body: { device } }).catch(() => {});
}

/** Re-renders the shell when the notice changes. */
export function usePlayNotice(): Notice | null {
  const [value, setValue] = useState<Notice | null>(notice);
  useEffect(() => {
    const fn = () => setValue(notice);
    listeners.add(fn);
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return value;
}

/** Test seam. */
export function reset() {
  until = 0;
  leased = false;
  notice = null;
  listeners.clear();
}
