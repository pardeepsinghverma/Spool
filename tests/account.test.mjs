import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import * as storage from './harness/stubs/async-storage.mjs';
import {
  account,
  explainAuthError,
  lastServerContact,
  loadAccount,
  login,
  logout,
  register,
  request,
  reset,
  setAccountOpener,
  signedIn,
} from '../src/core/account.ts';

/**
 * The account half of the server conversation.
 *
 * Two properties carry the weight, and they pull in opposite directions. A
 * session the server has *definitely* ended must be dropped here, with the
 * licence it was paying for — and nothing short of that definite answer may
 * drop it, because "the network is broken" arrives in more shapes than "you
 * are signed out" does, and a subscriber signed out by a captive portal is a
 * support conversation nobody needed.
 */

const SERVER = 'https://licence.example';
const DEVICE = 'ZGV2aWNl';

let fetches = [];
const realFetch = globalThis.fetch;

const answer = (status, body) => {
  globalThis.fetch = async (url, init) => {
    fetches.push({ url: String(url), init });
    if (body instanceof Error) throw body;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (body === undefined) throw new SyntaxError('Unexpected token <');
        return body;
      },
    };
  };
};

beforeEach(() => {
  native.reset();
  storage.reset();
  reset();
  fetches = [];
  native.handlers.licenceStatus = () => ({
    entitled: false,
    expiresAt: 0,
    plan: '',
    device: DEVICE,
    server: SERVER,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('register and login', () => {
  test('a successful login stores the session and the email', async () => {
    answer(200, { session: 's-1', account: { email: 'me@x.in' } });

    assert.equal(await login('  Me@X.in ', 'hunter22'), null);

    assert.equal(signedIn(), true);
    assert.equal(account().email, 'me@x.in');
    assert.deepEqual(JSON.parse(storage.raw('dl.account')), { session: 's-1', email: 'me@x.in' });
    const sent = JSON.parse(fetches[0].init.body);
    assert.equal(sent.email, 'me@x.in', 'addresses are compared lower-cased and trimmed');
    assert.equal(sent.device, DEVICE, 'the device id is the native one');
    assert.equal(typeof sent.label, 'string');
    assert.ok(fetches[0].url.endsWith('/v1/auth/login'));
  });

  test('a sign-in after boot is what the next authenticated request sends', async () => {
    // Found on the emulator: boot reads storage (signed out), the user signs
    // in, and every authenticated request for the rest of the run still went
    // out with no session — because the memoised boot read resolved to the
    // boot-time account forever. The paywall's Continue reopened the account
    // sheet instead of starting a payment.
    await loadAccount();
    answer(200, { session: 's-after-boot', account: { email: 'me@x.in' } });
    assert.equal(await login('me@x.in', 'hunter22'), null);

    answer(200, { order: 'SPL123456' });
    const reply = await request('/v1/pay/start', { method: 'POST', auth: true, body: { plan: 'monthly' } });

    assert.equal(reply.kind, 'ok');
    const last = fetches[fetches.length - 1];
    assert.equal(last.init.headers.authorization, 'Bearer s-after-boot');
  });

  test('a wrong password is a sentence, and signs nobody in', async () => {
    answer(401, { error: 'wrong email or password' });
    assert.equal(await login('a@b.co', 'nope'), 'That email and password do not match.');
    assert.equal(signedIn(), false);
  });

  test('each register refusal has its own copy', async () => {
    for (const [status, error, words] of [
      [400, 'bad email', /email address/],
      [400, 'weak password', /8 characters/],
      [409, 'email taken', /already an account/],
    ]) {
      answer(status, { error });
      assert.match(await register('a@b.co', 'x'), words);
    }
  });

  test('429 says how long to wait', async () => {
    answer(429, { error: 'slow down', retryAfter: 300 });
    assert.match(await login('a@b.co', 'x'), /5 minutes/);
  });

  test('offline is said as offline, not as a wrong password', async () => {
    answer(0, new Error('network down'));
    assert.match(await login('a@b.co', 'x'), /connection/);
  });

  test('explainAuthError never hands the raw server string to the user', () => {
    assert.doesNotMatch(
      explainAuthError({ kind: 'refused', status: 400, body: { error: 'bad device' } }),
      /bad device/,
    );
  });
});

describe('the session ends only on a definite answer', () => {
  const signedInWith = async (session = 's-9') => {
    storage.seed('dl.account', JSON.stringify({ session, email: 'a@b.co' }));
    reset();
    await loadAccount();
  };

  test('401 "signed out" drops the session and forgets the licence', async () => {
    await signedInWith();
    answer(401, { error: 'signed out' });

    const reply = await request('/v1/account', { auth: true });

    assert.equal(reply.kind, 'signed-out');
    assert.equal(signedIn(), false);
    assert.equal(native.callsTo('forgetLicence').length, 1);
  });

  test('403 "blocked" drops it too, and opens the account sheet on the explanation', async () => {
    await signedInWith();
    const opened = [];
    setAccountOpener((intent) => opened.push(intent));
    answer(403, { error: 'blocked' });

    assert.equal((await request('/v1/account', { auth: true })).kind, 'blocked');
    assert.equal(signedIn(), false);
    assert.deepEqual(opened, [{ blocked: true }]);
  });

  for (const [what, status, body] of [
    ['a thrown fetch', 0, new Error('offline')],
    ['a 500', 500, { error: 'db down' }],
    ['a 502 with HTML', 502, undefined],
    ['a 401 whose body is not ours', 401, undefined],
    ['a 401 with some other error', 401, { error: 'nope' }],
  ]) {
    test(`${what} keeps the session`, async () => {
      await signedInWith();
      answer(status, body);
      await request('/v1/account', { auth: true });
      assert.equal(signedIn(), true);
      assert.deepEqual(native.callsTo('forgetLicence'), []);
    });
  }

  test('an authenticated request with no session is not sent', async () => {
    answer(200, {});
    assert.equal((await request('/v1/account', { auth: true })).kind, 'unconfigured');
    assert.deepEqual(fetches, []);
  });

  test('a build with no server sends nothing at all', async () => {
    native.handlers.licenceStatus = () => ({ entitled: false, expiresAt: 0, plan: '', device: '', server: '' });
    answer(200, { session: 's' });
    assert.match(await login('a@b.co', 'password1'), /not connected/);
    assert.deepEqual(fetches, []);
  });
});

describe('last contact', () => {
  test('any parsed answer counts, including a refusal', async () => {
    answer(409, { error: 'email taken' });
    await register('a@b.co', 'password1');
    assert.ok(lastServerContact() > 0);
    assert.equal(Number(storage.raw('dl.serverContact')), lastServerContact());
  });

  test('a failure does not', async () => {
    answer(500, { error: 'x' });
    await login('a@b.co', 'password1');
    assert.equal(lastServerContact(), 0);
  });

  test('it is read back at boot', async () => {
    storage.seed('dl.serverContact', '12345');
    await loadAccount();
    assert.equal(lastServerContact(), 12345);
  });
});

describe('logout', () => {
  test('is local first — it signs out even with no network', async () => {
    storage.seed('dl.account', JSON.stringify({ session: 's', email: 'a@b.co' }));
    await loadAccount();
    answer(0, new Error('offline'));

    await logout();

    assert.equal(signedIn(), false);
    assert.equal(storage.raw('dl.account'), null);
    assert.equal(native.callsTo('forgetLicence').length, 1, 'the licence belonged to the account');
  });
});

describe('storage', () => {
  test('a corrupt blob reads as signed out, never as a throw', async () => {
    storage.faults.corrupt = '{not json';
    await loadAccount();
    assert.equal(signedIn(), false);
  });
});
