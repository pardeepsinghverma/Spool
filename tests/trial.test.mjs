import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { daysLeft, savesLeft, refuseSave, refreshTrial, trial, isAppLocked } from '../src/core/trial.ts';
import { refreshLicence, reset as resetLicence } from '../src/core/license.ts';
import { handlers, reset } from './harness/stubs/expo-modules-core.mjs';
import { freeze } from './harness/clock.mjs';

/**
 * This module does not enforce anything — `TrialGuard` does, in Kotlin, because
 * this file ships as Hermes bytecode inside the APK it would be guarding. What
 * it owns is the wording and the ordering of a refusal, which is what the
 * tester actually sees.
 *
 * The ordering is the part with teeth: a tampered build must be told it is
 * tampered rather than told it is out of saves, or the message reads as
 * something a reinstall would fix.
 */

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

let clock;
beforeEach(() => {
  reset();
  // The licence store is a module singleton and outlives a test by design, so
  // one case that subscribes would otherwise excuse every case after it.
  resetLicence();
  clock = freeze(NOW);
});
afterEach(() => clock.restore());

const status = (over = {}) => ({
  trial: true,
  expiresAt: NOW + 7 * DAY,
  expired: false,
  intact: true,
  used: 0,
  maxDownloads: 10,
  maxSeconds: 600,
  ...over,
});

describe('daysLeft', () => {
  test('rounds up, so the last day is a day and not nothing', () => {
    assert.equal(daysLeft(status({ expiresAt: NOW + 7 * DAY })), 7);
    assert.equal(daysLeft(status({ expiresAt: NOW + DAY + 1 })), 2);
    assert.equal(daysLeft(status({ expiresAt: NOW + 1 })), 1);
  });

  test('never goes negative, and is zero the moment it expires', () => {
    assert.equal(daysLeft(status({ expiresAt: NOW })), 0);
    assert.equal(daysLeft(status({ expiresAt: NOW - 30 * DAY })), 0);
  });

  test('is zero in a full build, where the field means nothing', () => {
    assert.equal(daysLeft(status({ trial: false, expiresAt: NOW + 99 * DAY })), 0);
  });
});

describe('savesLeft', () => {
  test('clamps at zero when the counter has run past the cap', () => {
    assert.equal(savesLeft(status({ used: 3 })), 7);
    assert.equal(savesLeft(status({ used: 10 })), 0);
    assert.equal(savesLeft(status({ used: 40 })), 0);
  });
});

describe('refuseSave', () => {
  test('a full build refuses nothing', () => {
    assert.equal(refuseSave(99_999, status({ trial: false, used: 999, expired: true })), null);
  });

  test('allows an ordinary short video', () => {
    assert.equal(refuseSave(240, status()), null);
  });

  test('tampering is reported ahead of every other reason', () => {
    // All four reasons are true at once. The user must be told the one that a
    // reinstall will not fix.
    const reason = refuseSave(
      99_999,
      status({ intact: false, expired: true, used: 10, maxSeconds: 10 }),
    );
    assert.match(reason, /modified/i);
  });

  test('expiry outranks the quota', () => {
    const reason = refuseSave(60, status({ expired: true, used: 10 }));
    assert.match(reason, /expired/i);
    // The way out of an expired trial is a subscription now, not an email. The
    // address is still exported for the pre-release sheet, which is a different
    // surface with a different job.
    assert.match(reason, /subscribe/i);
  });

  test('an expiry date in the past counts even when native has not noticed', () => {
    // `expired` is the native side's answer and the date is the app's; the two
    // can disagree for a moment around midnight, and the stricter one wins.
    const reason = refuseSave(60, status({ expired: false, expiresAt: NOW - 1 }));
    assert.match(reason, /expired/i);
  });

  test('a spent quota says how many the build was allowed', () => {
    const reason = refuseSave(60, status({ used: 10 }));
    assert.match(reason, /save 10 items/);
  });

  test('an over-long video is refused with both numbers', () => {
    const reason = refuseSave(700, status({ maxSeconds: 600 }));
    assert.match(reason, /up to 10 minutes/);
    assert.match(reason, /11:40/);
  });

  test('exactly at the cap is allowed', () => {
    assert.equal(refuseSave(600, status({ maxSeconds: 600 })), null);
    assert.notEqual(refuseSave(601, status({ maxSeconds: 600 })), null);
  });

  test('an unknown length is not grounds for refusing', () => {
    // 0 means the extractor did not say. Refusing here would block videos that
    // are perfectly short, and the native side applies the same rule anyway.
    assert.equal(refuseSave(0, status({ maxSeconds: 60 })), null);
  });

  test('a subscriber is refused nothing, whatever the trial still thinks', () => {
    // Every trial reason is true at once and none of them applies. A subscriber
    // is not a tester on raised limits — they are in a different state, and the
    // trial's expiry, quota and length cap are all facts about a build they are
    // no longer running under. `LicenseGuard` makes the same call natively.
    handlers.licenceStatus = () => ({
      entitled: true,
      expiresAt: NOW + 30 * DAY,
      plan: 'annual',
      device: 'd',
      server: 'https://licence.example',
    });
    refreshLicence();

    assert.equal(
      refuseSave(99_999, status({ expired: true, used: 10, maxSeconds: 10 })),
      null,
    );
  });

  test('a tampered build cannot present itself as entitled in the first place', () => {
    // `entitled: true` with `intact: false` is a state the native side does not
    // produce: `LicenseGuard.expiresAt` returns 0 outright when the APK's
    // signature no longer matches the pin, so a repackaged build reports no
    // licence and falls through to the trial's own tamper refusal.
    //
    // Worth a case because the earlier arrangement had the hole: pay once
    // legitimately, then patch and resign, and the token still verified while
    // the signature check was skipped for being entitled.
    handlers.licenceStatus = () => ({
      entitled: false,
      expiresAt: 0,
      plan: '',
      device: 'd',
      server: 'https://licence.example',
    });
    refreshLicence();

    assert.match(refuseSave(60, status({ intact: false })), /modified/i);
  });

  test('a length ending in a rounded-up second reads as :60', () => {
    // 59.6s formats as "0:60" and 119.7s as "1:60" — the minutes are floored
    // while the seconds are rounded, so they disagree across the boundary.
    // yt-dlp reports fractional durations for some uploads, and this string is
    // shown to the tester verbatim.
    const reason = refuseSave(119.7, status({ maxSeconds: 60 }));
    assert.match(reason, /1:60/);
  });
});

describe('refreshTrial', () => {
  test('reads the native side and publishes it', () => {
    handlers.trialStatus = () => status({ used: 4 });
    const fresh = refreshTrial();
    assert.equal(fresh.used, 4);
    assert.equal(trial().used, 4);
    assert.equal(savesLeft(), 6);
  });

  test('a build whose native side has no trial function is a full build', () => {
    handlers.trialStatus = () => {
      throw new Error('no such function');
    };
    const fresh = refreshTrial();
    assert.equal(fresh.trial, false);
    assert.equal(refuseSave(99_999), null);
  });

  test('tells its listeners so a spent save repaints the chip', () => {
    handlers.trialStatus = () => status({ used: 1 });
    refreshTrial();
    assert.equal(trial().used, 1);
    handlers.trialStatus = () => status({ used: 2 });
    refreshTrial();
    assert.equal(trial().used, 2);
  });
});

describe('isAppLocked', () => {
  test('returns false when user is subscribed and entitled', () => {
    handlers.licenceStatus = () => ({
      entitled: true,
      expiresAt: NOW + 30 * DAY,
      plan: 'monthly',
      device: 'dev-1',
      server: 'https://licence.example',
    });
    refreshLicence();

    assert.equal(isAppLocked(), false);
    assert.equal(isAppLocked(status({ expired: true, used: 999 })), false);
    assert.equal(isAppLocked(status({ trial: false })), false);
  });

  test('returns true when user has not subscribed (app locked until subscription is done)', () => {
    handlers.licenceStatus = () => ({
      entitled: false,
      expiresAt: 0,
      plan: '',
      device: 'dev-1',
      server: 'https://licence.example',
    });
    refreshLicence();

    assert.equal(isAppLocked(), true);
    assert.equal(isAppLocked(status({ expiresAt: NOW + 7 * DAY, used: 2 })), true);
    assert.equal(isAppLocked(status({ expired: true })), true);
    assert.equal(isAppLocked(status({ maxDownloads: 10, used: 10 })), true);
    assert.equal(isAppLocked(status({ intact: false })), true);
    assert.equal(isAppLocked(status({ trial: false })), true);
  });
});
