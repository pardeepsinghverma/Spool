import { useEffect, useState } from 'react';
import YtDlp, { type TrialStatus } from '../../modules/ytdlp';

/**
 * What a pre-release build allows, as the screens see it.
 *
 * This module **describes** the trial. It does not enforce it. Every limit is
 * checked again natively in `TrialGuard` before a download starts, because this
 * file ships as Hermes bytecode inside the APK it would be guarding — someone
 * who patches it gets a UI that lies and a native layer that still refuses.
 *
 * The checks here exist for the other reason: so a refusal can be worded before
 * the user has waited for an extraction that was never going to be allowed.
 */

/** Where a tester writes to ask for a full copy. See PRICE below. */
export const CONTACT_EMAIL = 'connect@afinitycode.com';

/**
 * The offer, stated the way it is actually true.
 *
 * `LAUNCH_PRICE` is what the developer expects to charge once this ships, not a
 * price anyone has ever paid — so the copy calls it "expected" rather than
 * striking it through like a discount. A crossed-out number nobody was ever
 * charged is the kind of thing this app's design rules already refuse
 * everywhere else.
 */
export const TRIAL_PRICE = '₹399';
export const LAUNCH_PRICE = '₹999';

const OFFLINE: TrialStatus = {
  trial: false,
  expiresAt: 0,
  expired: false,
  intact: true,
  used: 0,
  maxDownloads: 0,
  maxSeconds: 0,
};

let cached: TrialStatus = OFFLINE;
const listeners = new Set<() => void>();

/** Re-read the native side. Cheap: a preferences lookup and a short file read. */
export function refreshTrial(): TrialStatus {
  try {
    cached = YtDlp.trialStatus();
  } catch {
    // A build without the function is a full build, not a broken one.
    cached = OFFLINE;
  }
  listeners.forEach((fn) => fn());
  return cached;
}

export const trial = (): TrialStatus => cached;

/** Whole days left, rounded up — 0 on the last day, never negative. */
export function daysLeft(status: TrialStatus = cached): number {
  if (!status.trial) return 0;
  const ms = status.expiresAt - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

export const savesLeft = (status: TrialStatus = cached): number =>
  Math.max(0, status.maxDownloads - status.used);

/**
 * Why this video cannot be saved, already worded, or null when it can be.
 *
 * `seconds` of 0 means the extractor did not report a length. An unknown length
 * is not grounds for refusing — the native side will apply the same rule, and
 * refusing here on a missing field would block videos that are perfectly short.
 */
export function refuseSave(seconds: number, status: TrialStatus = cached): string | null {
  if (!status.trial) return null;
  if (!status.intact) return 'This build has been modified and will not download.';
  if (status.expired || daysLeft(status) === 0) {
    return `This pre-release has expired. Email ${CONTACT_EMAIL} for a full copy.`;
  }
  if (savesLeft(status) <= 0) {
    return `Pre-release builds can save ${status.maxDownloads} items, and this one has saved them all.`;
  }
  if (seconds > 0 && seconds > status.maxSeconds) {
    const cap = Math.round(status.maxSeconds / 60);
    return `Pre-release builds can save videos up to ${cap} minutes. This one is ${formatLength(seconds)}.`;
  }
  return null;
}

const formatLength = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

/**
 * How the trial chip opens the pre-release sheet.
 *
 * Registered by the shell, which owns the sheet, so the chip can live in four
 * different screen headers without any of them carrying a prop for it. Same
 * shape as `setPlaybackGate` on the player context, and for the same reason:
 * the alternative is threading one callback through four components that have
 * nothing else to do with it.
 */
let opener: (() => void) | null = null;
export const setPreReleaseOpener = (fn: (() => void) | null) => {
  opener = fn;
};
export const openPreRelease = () => opener?.();

/** Re-renders a screen when the trial state moves — a save spends a slot. */
export function useTrial(): TrialStatus {
  const [status, setStatus] = useState<TrialStatus>(cached);
  useEffect(() => {
    const fn = () => setStatus(trial());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return status;
}
