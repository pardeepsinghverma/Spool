import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import * as storage from './harness/stubs/async-storage.mjs';
import {
  PRICES,
  daysLeft,
  forgetLicence,
  licence,
  loadLicenceFacts,
  refreshLicence,
  reset,
  syncLicence,
} from '../src/core/license.ts';
import { loadAccount, reset as resetAccount } from '../src/core/account.ts';

/**
 * The half of the subscription that ships as JavaScript.
 *
 * Enforcement is `LicenseGuard.kt` and is not reachable from here, so nothing
 * in this file proves anybody is entitled to anything. What it does prove is
 * the property that decides whether a paying user has a good week or a bad one:
 * **being offline never revokes a subscription.**
 *
 * That is the failure mode worth spending a suite on. A licence lives on the
 * device and expires on a date; every route by which "we could not ask the
 * server" turns into "you have not paid" is a paying customer locked out of
 * music they already own, on a train, with no way to fix it. Most of the cases
 * below are that one claim approached from a different direction.
 */

const NOW = 1_780_000_000_000;
const DEVICE = 'ZGV2aWNlLWhhc2gtMDAx';
const SERVER = 'https://licence.example';

/** What the native side reports. The real one has verified a signature first. */
const nativeSays = (over = {}) => {
  native.handlers.licenceStatus = () => ({
    entitled: false,
    expiresAt: 0,
    plan: '',
    device: DEVICE,
    server: SERVER,
    ...over,
  });
};

let fetches = [];
const realFetch = globalThis.fetch;

/** Answer the next fetch with `body`, or throw when `body` is an Error. */
const serverAnswers = (body, ok = true, status = ok ? 200 : 500) => {
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), method: init?.method ?? 'GET', headers: init?.headers ?? {} });
    if (body instanceof Error) throw body;
    return { ok, status, json: async () => body };
  };
};

/** A signed-in device: the licence route is authenticated now. */
const signIn = async () => {
  storage.seed('dl.account', JSON.stringify({ session: 'sess-1', email: 'a@b.co' }));
  resetAccount();
  await loadAccount();
};

beforeEach(async () => {
  native.reset();
  storage.reset();
  resetAccount();
  reset();
  fetches = [];
  nativeSays();
  await signIn();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('being offline never revokes a subscription', () => {
  test('a fetch that throws leaves the held licence exactly where it was', async () => {
    nativeSays({ entitled: true, expiresAt: NOW + 86_400_000, plan: 'annual' });
    refreshLicence();
    serverAnswers(new Error('network down'));

    const moved = await syncLicence({ force: true });

    assert.equal(moved, false, 'nothing changed');
    assert.equal(licence().entitled, true, 'still subscribed after a failed sync');
  });

  test('a 500 from the server is not an answer about whether the user has paid', async () => {
    nativeSays({ entitled: true, expiresAt: NOW + 86_400_000, plan: 'monthly' });
    refreshLicence();
    serverAnswers({ error: 'unavailable' }, false);

    await syncLicence({ force: true });
    assert.equal(licence().entitled, true);
  });

  test('a definite "not entitled" still does not delete a working licence', async () => {
    nativeSays({ entitled: true, expiresAt: NOW + 86_400_000, plan: 'annual' });
    refreshLicence();
    serverAnswers({ entitled: false });

    await syncLicence({ force: true });

    assert.equal(licence().entitled, true, 'a webhook that has not landed yet is not a refund');
    assert.deepEqual(native.callsTo('forgetLicence'), [], 'nothing was thrown away');
  });

  test('a token the native side refuses changes nothing', async () => {
    nativeSays({ entitled: true, expiresAt: NOW + 86_400_000, plan: 'annual' });
    refreshLicence();
    serverAnswers({ entitled: true, token: 'forged.token' });
    native.handlers.rememberLicence = () => false;

    const moved = await syncLicence({ force: true });

    assert.equal(moved, false);
    assert.equal(licence().entitled, true, 'the previously held licence survives a bad answer');
  });
});

describe('syncLicence', () => {
  test('a token that verifies is kept, and the new expiry is reported as a change', async () => {
    serverAnswers({ entitled: true, token: 'good.token' });
    native.handlers.rememberLicence = () => {
      // The real native side keeps it and then reports the new state.
      nativeSays({ entitled: true, expiresAt: NOW + 30 * 86_400_000, plan: 'monthly' });
      return true;
    };

    const moved = await syncLicence({ force: true });

    assert.equal(moved, true);
    assert.equal(licence().entitled, true);
    assert.deepEqual(native.callsTo('rememberLicence'), [['good.token']]);
  });

  test('an unconfigured build never reaches for the network at all', async () => {
    native.handlers.licenceStatus = () => ({
      entitled: false,
      expiresAt: 0,
      plan: '',
      device: '',
      server: '',
    });
    serverAnswers({ entitled: true, token: 'x.y' });

    assert.equal(await syncLicence({ force: true }), false);
    assert.deepEqual(fetches, [], 'a debug build with no server does not phone anywhere');
  });

  test('it asks under the device id the native side minted, never one of its own', async () => {
    serverAnswers({ entitled: false });
    await syncLicence({ force: true });

    assert.equal(fetches.length, 1);
    assert.ok(
      fetches[0].url.includes(encodeURIComponent(DEVICE)),
      'asking under a different name than it verifies under is a licence that can never be proved',
    );
  });

  test('an unforced sync inside the gap does not repeat the request', async () => {
    serverAnswers({ entitled: false });

    await syncLicence({ force: true });
    assert.equal(fetches.length, 1);

    await syncLicence();
    assert.equal(fetches.length, 1, 'a relaunch loop must not hammer the server');
  });

  test('a failed sync does not start the gap, so the next attempt is allowed', async () => {
    serverAnswers(new Error('offline'));
    await syncLicence({ force: true });

    serverAnswers({ entitled: false });
    await syncLicence();

    assert.equal(fetches.length, 2, 'a device that was offline must be free to try again');
  });
});

describe('accounts', () => {
  test('signed out, the licence server is not asked at all', async () => {
    storage.reset();
    resetAccount();
    await loadAccount();
    serverAnswers({ entitled: true, token: 'x.y' });

    assert.equal(await syncLicence({ force: true }), false);
    assert.deepEqual(fetches, [], 'an answer known in advance is not worth telling the server the app opened');
  });

  test('the session goes as a Bearer header', async () => {
    serverAnswers({ entitled: false });
    await syncLicence({ force: true });
    assert.equal(fetches[0].headers.authorization, 'Bearer sess-1');
  });

  test('a 401 "signed out" ends the session and forgets the licence', async () => {
    nativeSays({ entitled: true, expiresAt: NOW + 86_400_000, plan: 'annual' });
    refreshLicence();
    serverAnswers({ error: 'signed out' }, false, 401);

    await syncLicence({ force: true });

    assert.equal(native.callsTo('forgetLicence').length, 1, 'the licence went with the session');
    assert.equal(storage.raw('dl.account'), null, 'the session is gone from disk');
  });

  test('a 401 without the exact answer is a broken network, not a sign-out', async () => {
    serverAnswers({ error: 'captive portal says hello' }, false, 401);
    await syncLicence({ force: true });
    assert.deepEqual(native.callsTo('forgetLicence'), []);
    assert.notEqual(storage.raw('dl.account'), null);
  });
});

describe('paidThrough — the date the screens show', () => {
  test('a kept token records the subscription end, persisted for offline', async () => {
    const paid = NOW + 200 * 86_400_000;
    serverAnswers({ entitled: true, token: 'good.token', paidThrough: paid, plan: 'annual', expiresAt: NOW + 3 * 86_400_000 });
    native.handlers.rememberLicence = () => {
      nativeSays({ entitled: true, expiresAt: NOW + 3 * 86_400_000, plan: 'annual' });
      return true;
    };

    await syncLicence({ force: true });

    assert.equal(licence().paidThrough, paid);
    assert.equal(JSON.parse(storage.raw('dl.licence')).paidThrough, paid);
  });

  test('it is read back at boot, before any network', async () => {
    storage.seed('dl.licence', JSON.stringify({ paidThrough: NOW + 5, plan: 'monthly' }));
    await loadLicenceFacts();
    assert.equal(licence().paidThrough, NOW + 5);
    assert.equal(licence().plan, 'monthly');
  });

  test('forgetting the licence forgets the date too', async () => {
    storage.seed('dl.licence', JSON.stringify({ paidThrough: NOW + 5, plan: 'monthly' }));
    await loadLicenceFacts();
    forgetLicence();
    assert.equal(licence().paidThrough, 0);
  });

  test('refreshAfter brings the next unforced sync forward, but not to "now"', async () => {
    serverAnswers({ entitled: false, refreshAfter: Date.now() - 1 });
    await syncLicence({ force: true });
    await syncLicence();
    assert.equal(fetches.length, 1, 'a server asking to be asked again immediately is floored');
  });
});

describe('daysLeft', () => {
  test('a paid-through date in the past is 0, never negative', () => {
    assert.equal(daysLeft({ paidThrough: Date.now() - 86_400_000 }), 0);
  });

  test('a part-day rounds up, so the last day reads 1 rather than 0', () => {
    assert.equal(daysLeft({ paidThrough: Date.now() + 3_600_000 }), 1);
  });

  test('it never reads the token lease', () => {
    assert.equal(
      daysLeft({ ...licence(), expiresAt: Date.now() + 3 * 86_400_000, paidThrough: 0 }),
      null,
      'three days of lease printed as "3 days left" would be a false alarm on a year paid',
    );
  });
});

describe('the copy states only things that are true', () => {
  test('the annual note is arithmetic on the annual price, not an invented discount', () => {
    assert.equal(PRICES.annual.amount, '₹249');
    assert.equal((249 / 12).toFixed(2), '20.75', 'the figure printed in the note');
    assert.match(PRICES.annual.note, /20\.75/);
  });

  test('nothing promises a renewal that does not happen', () => {
    for (const plan of Object.values(PRICES)) {
      assert.doesNotMatch(plan.note, /cancel|renews automatically|autopay|mandate/i);
    }
    assert.match(PRICES.monthly.note, /Nothing renews on its own/);
  });

  test('no price is struck through or compared against one nobody has paid', () => {
    for (const plan of Object.values(PRICES)) {
      const copy = `${plan.amount} ${plan.per} ${plan.note}`;
      assert.doesNotMatch(copy, /~~|was |instead of |RRP|MRP/i);
    }
  });
});
