import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  daysLeft,
  savesLeft,
  refuseSave,
  refreshTrial,
  trial,
  CONTACT_EMAIL,
} from '../src/core/trial.ts';
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
    assert.ok(reason.includes(CONTACT_EMAIL));
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
