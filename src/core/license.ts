import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import YtDlp, { type LicenceStatus } from '../../modules/ytdlp';
import { endpoint, loadAccount, onSessionEnded, request, signedIn } from './account';
import * as log from './log';

/**
 * The subscription, as the screens see it.
 *
 * This module **describes** the subscription. It does not enforce it, and it
 * cannot: it ships as Hermes bytecode inside the APK it would be guarding, so
 * anyone willing to decompile the bundle can make every function here return
 * `entitled: true`. `LicenseGuard.kt` verifies an ECDSA signature over a token
 * bound to the device, and that is the check that decides whether a download
 * starts. Same split as `trial.ts`, for the same reason.
 *
 * What this file is actually for is the other half of the job — fetching a
 * token when the device happens to be online, wording the offer, and keeping
 * the screens in step. All three of those are honest jobs for JavaScript.
 *
 * **Nothing here blocks.** It runs from the boot effect and from a sheet the
 * user is looking at, and it treats every network failure as "no news" rather
 * than as "not subscribed" — a subscriber on a train must not be told they have
 * not paid.
 *
 * **The token's expiry is a lease, not the subscription.** Since accounts, the
 * server signs a token that lives at most about three days and is renewed on
 * every sync, so that a device signed out or blocked on the server stops being
 * entitled within days rather than at the end of a year. The date a person
 * cares about — when what they paid for runs out — is `paidThrough`, which the
 * server sends alongside and this file persists so it still reads correctly
 * offline. Anything that says "days left" reads that, never `expiresAt`.
 */

export type Plan = 'monthly' | 'annual' | 'daily' | string;

/**
 * The offer, stated the way it is actually true.
 *
 * The monthly-equivalent of the annual plan is a derived fact — 249 ÷ 12 — and
 * may be printed. What may not be printed is a struck-through price nobody has
 * been charged; that rule is in `docs/UI.md` and it applies to this file's copy
 * exactly as it applied to the pre-release sheet's.
 *
 * Neither plan renews by itself any more. Payment is a UPI transfer the user
 * makes by hand, once per period — there is no mandate anywhere to cancel, and
 * the notes say so rather than leaving "a month" to imply a subscription that
 * takes money on its own.
 */
export const PRICES: Record<string, { amount: string; per: string; note: string }> = {
  daily: {
    amount: '₹1',
    per: 'a day',
    note: '1 day of full access. Paid once, by UPI.',
  },
  monthly: {
    amount: '₹29',
    per: 'a month',
    note: 'Pay each month by UPI. Nothing renews on its own.',
  },
  annual: {
    amount: '₹249',
    per: 'a year',
    note: 'Works out at ₹20.75 a month. Paid once, by UPI.',
  },
};

export function updatePricesFromLivePlans(
  livePlans: Array<{ code: string; amount: string; per: string; note: string }>
) {
  for (const lp of livePlans) {
    PRICES[lp.code] = {
      amount: lp.amount,
      per: lp.per,
      note: lp.note,
    };
  }
}

/** Long enough that a relaunch loop cannot hammer the server; short enough to notice a payment. */
const MIN_SYNC_GAP_MS = 6 * 60 * 60 * 1000;

/**
 * The floor under the server's `refreshAfter`. A server that asked to be asked
 * again "now" on every answer would otherwise turn every foregrounding into a
 * request.
 */
const MIN_REFRESH_MS = 5 * 60 * 1000;

const KEY_FACTS = 'dl.licence';

const NONE: LicenceStatus = {
  entitled: false,
  expiresAt: 0,
  plan: '',
  device: '',
  server: '',
};

/** What the screens read: the native status plus the persisted subscription end. */
export type LicenceView = LicenceStatus & {
  /** Epoch ms the subscription is paid through; 0 when not known. */
  paidThrough: number;
};

type Facts = { paidThrough: number; plan: string };

let cached: LicenceStatus = NONE;
let facts: Facts = { paidThrough: 0, plan: '' };
let view: LicenceView = { ...NONE, paidThrough: 0 };
let nextSyncAt = 0;
const listeners = new Set<() => void>();

const rebuild = () => {
  view = {
    ...cached,
    // The token's plan is authoritative while there is one; the persisted one
    // covers the offline stretch after the lease has run out.
    plan: cached.plan || facts.plan,
    paidThrough: facts.paidThrough,
  };
  listeners.forEach((fn) => fn());
};

/** Re-read the native side. One signature verification, no network. */
export function refreshLicence(): LicenceStatus {
  try {
    cached = YtDlp.licenceStatus();
  } catch {
    // A build without the function is a build without subscriptions, not a
    // broken one — exactly the reading `trial.ts` takes of a missing trial.
    cached = NONE;
  }
  rebuild();
  return cached;
}

export const licence = (): LicenceView => view;

/** Read the persisted subscription end. Called once at boot. */
export async function loadLicenceFacts(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY_FACTS);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      facts = {
        paidThrough: Number(parsed.paidThrough) || 0,
        plan: typeof parsed.plan === 'string' ? parsed.plan : '',
      };
    }
  } catch {
    // Missing and unreadable read the same: no date to show until the next sync.
  }
  rebuild();
}

/**
 * Record what the server said the subscription runs to. Exported for
 * `payments.ts`, whose approval carries the same two facts a licence sync does.
 */
export function rememberPaidThrough(paidThrough: number, plan: string) {
  if (!Number.isFinite(paidThrough) || paidThrough <= 0) return;
  facts = { paidThrough, plan: plan || facts.plan };
  rebuild();
  void AsyncStorage.setItem(KEY_FACTS, JSON.stringify(facts)).catch(() => {});
}

function clearFacts() {
  facts = { paidThrough: 0, plan: '' };
  rebuild();
  void AsyncStorage.removeItem(KEY_FACTS).catch(() => {});
}

/**
 * Whole days of subscription left, rounded up — 0 on the last day, never
 * negative. Null when the end date is not known (a licence synced before the
 * server sent `paidThrough`), so a screen can say "Active" rather than print
 * the lease's three days as though they were the subscription's.
 */
export function daysLeft(status: Pick<LicenceView, 'paidThrough'> = view): number | null {
  if (!status.paidThrough) return null;
  const ms = status.paidThrough - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/**
 * Ask the server what this device is entitled to and hand any token straight to
 * the native side.
 *
 * The return value is whether anything changed, not whether the user is
 * subscribed — callers that need the latter read `licence()` afterwards. That
 * distinction is deliberate: "the sync failed" and "the sync succeeded and you
 * have not paid" must not collapse into one falsy value, because the first is a
 * reason to try again later and the second is a reason to show the paywall.
 *
 * Signed out, it does not ask at all: the server answers `entitled: false` to a
 * request without a session, and a request whose answer is known in advance is
 * a request that only tells the server the app was opened.
 */
export async function syncLicence({ force = false } = {}): Promise<boolean> {
  const now = Date.now();
  if (!force && now < nextSyncAt) return false;

  const { server, device } = endpoint();
  if (!server || !device) return false;

  await loadAccount();
  if (!signedIn()) return false;

  const reply = await request(`/v1/licence?device=${encodeURIComponent(device)}`, {
    auth: true,
  });
  // `signed-out` and `blocked` have already forgotten the licence by the time
  // they get here, through `onSessionEnded` below. Everything else that is not
  // `ok` is no news.
  if (reply.kind !== 'ok') return false;
  const body = reply.body;
  const asked = Number(body.refreshAfter);
  nextSyncAt =
    Number.isFinite(asked) && asked > 0
      ? Math.max(now + MIN_REFRESH_MS, Math.min(asked, now + MIN_SYNC_GAP_MS))
      : now + MIN_SYNC_GAP_MS;

  if (!body.entitled || typeof body.token !== 'string') {
    // A definite "no" from the server is not grounds for throwing away a token
    // that is still valid. Clock skew, a payment still being reviewed and a
    // half-finished migration all produce this answer, and all of them resolve
    // themselves; deleting a working licence does not.
    log.info('licence', 'server reports no active subscription');
    return false;
  }

  const kept = YtDlp.rememberLicence(body.token);
  if (!kept) {
    // The token did not verify. That is the server's fault or an attack, and in
    // either case the app carries on with whatever it already had.
    log.warn('licence', 'server sent a token this build will not accept');
    return false;
  }

  const before = cached.expiresAt;
  const paidBefore = facts.paidThrough;
  rememberPaidThrough(Number(body.paidThrough), typeof body.plan === 'string' ? body.plan : '');
  refreshLicence();
  return cached.expiresAt !== before || facts.paidThrough !== paidBefore;
}

/**
 * Sync when the app comes back to the front.
 *
 * The boot effect's one sync used to be enough, when a token lasted as long as
 * the subscription. A lease of a few days on an app that is a music player —
 * left running in the background for a week at a time — needs a second
 * trigger, and "the user opened it again" is the cheapest honest one. The gap
 * in `syncLicence` keeps it from being a request per foregrounding.
 */
let watching: { remove(): void } | null = null;
export function watchLicence(): () => void {
  watching?.remove();
  watching = AppState.addEventListener('change', (state) => {
    if (state === 'active') void syncLicence();
  });
  return () => {
    watching?.remove();
    watching = null;
  };
}

/** Drop the licence held on this device. */
export function forgetLicence(): void {
  try {
    YtDlp.forgetLicence();
  } catch {
    // Nothing to forget in a build without the function.
  }
  clearFacts();
  nextSyncAt = 0;
  refreshLicence();
}

/**
 * A session the server ended, or the user did, takes the licence with it — it
 * was issued because *that account* paid. Registered at module load rather
 * than imported by `account.ts`, which this file already imports.
 */
onSessionEnded(() => {
  // The native token is already forgotten by `account.ts`; this is the half
  // only this file holds.
  clearFacts();
  nextSyncAt = 0;
  refreshLicence();
});

/**
 * How the paywall gets opened from a screen that does not own it.
 *
 * Same registry shape as `setPreReleaseOpener` in `trial.ts` and
 * `setPlaybackGate` on the player context, and it exists for the same reason:
 * the alternative is threading one callback through every surface that might
 * have to raise it.
 */
let opener: ((reason?: string) => void) | null = null;
export const setPaywallOpener = (fn: ((reason?: string) => void) | null) => {
  opener = fn;
};
export const openPaywall = (reason?: string) => opener?.(reason);

/** Re-renders a screen when the subscription state moves. */
export function useLicence(): LicenceView {
  const [status, setStatus] = useState<LicenceView>(view);
  useEffect(() => {
    const fn = () => setStatus(licence());
    listeners.add(fn);
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return status;
}

/** Test seam — the module store deliberately outlives a screen, so it must be resettable. */
export function reset() {
  cached = NONE;
  facts = { paidThrough: 0, plan: '' };
  view = { ...NONE, paidThrough: 0 };
  nextSyncAt = 0;
  listeners.clear();
}
