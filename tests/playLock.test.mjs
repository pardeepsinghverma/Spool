import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import * as storage from './harness/stubs/async-storage.mjs';
import { loadAccount, reset as resetAccount } from '../src/core/account.ts';
import {
  HEARTBEAT_MS,
  OFFLINE_GRACE_MS,
  beat,
  claimPlay,
  judge,
  playNotice,
  playPermitted,
  releasePlay,
  reset,
  takeOver,
} from '../src/core/playLock.ts';

/**
 * One account, one device playing.
 *
 * The rules under test, in the order they matter: signed out is never
 * affected; a clear 409 is the only thing that refuses or pauses; the network
 * failing is not a reason to stop within a day of last contact; and a start
 * on a device that already holds the lease does not wait on anything.
 */

const NOW = 1_780_000_000_000;
let sent = [];
const realFetch = globalThis.fetch;

const answer = (status, body) => {
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    if (body instanceof Error) throw body;
    return { ok: status < 300, status, json: async () => body };
  };
};

const signIn = async (contact = Date.now()) => {
  storage.seed('dl.account', JSON.stringify({ session: 's', email: 'a@b.co' }));
  storage.seed('dl.serverContact', String(contact));
  resetAccount();
  await loadAccount();
};

beforeEach(() => {
  native.reset();
  storage.reset();
  resetAccount();
  reset();
  sent = [];
  native.handlers.licenceStatus = () => ({
    entitled: false,
    expiresAt: 0,
    plan: '',
    device: 'dev-1',
    server: 'https://licence.example',
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('judge — the decision, pure', () => {
  test('a grant is held for the lease, less a margin', () => {
    const v = judge({ kind: 'ok', body: { ok: true, leaseMs: 120_000 } }, NOW, 0);
    assert.equal(v.play, true);
    assert.equal(v.leased, true);
    assert.ok(v.until > NOW && v.until < NOW + 120_000);
  });

  test('409 names the other device', () => {
    const v = judge({ kind: 'refused', status: 409, body: { error: 'playing elsewhere', device: 'Pixel 8' } }, NOW, NOW);
    assert.deepEqual(v, { play: false, elsewhere: 'Pixel 8' });
  });

  test('offline inside the grace plays, as a permit rather than a lease', () => {
    const v = judge({ kind: 'offline' }, NOW, NOW - OFFLINE_GRACE_MS + 60_000);
    assert.deepEqual(v, { play: true, until: NOW + HEARTBEAT_MS, leased: false });
  });

  test('offline past the grace does not', () => {
    assert.deepEqual(judge({ kind: 'offline' }, NOW, NOW - OFFLINE_GRACE_MS - 1), { play: false, offline: true });
  });

  test('never having reached the server is past the grace', () => {
    assert.equal(judge({ kind: 'offline' }, NOW, 0).play, false);
  });

  test('a 429 or 400 is no news, and falls to the grace like offline', () => {
    assert.equal(judge({ kind: 'refused', status: 429, body: {} }, NOW, NOW).play, true);
    assert.equal(judge({ kind: 'refused', status: 400, body: {} }, NOW, NOW).play, true);
  });

  test('a session that ended mid-claim leaves nothing to honour', () => {
    for (const kind of ['signed-out', 'blocked', 'unconfigured']) {
      assert.equal(judge({ kind }, NOW, 0).play, true, kind);
    }
  });
});

describe('claimPlay', () => {
  test('signed out: permitted synchronously, and nothing is sent', async () => {
    await loadAccount();
    assert.equal(playPermitted(), true);
    assert.equal(await claimPlay(), true);
    assert.deepEqual(sent, []);
  });

  test('signed in: not permitted until claimed, then the fast path holds', async () => {
    await signIn();
    assert.equal(playPermitted(), false);
    answer(200, { ok: true, leaseMs: 120_000 });

    assert.equal(await claimPlay(), true);

    assert.deepEqual(sent[0].body, { device: 'dev-1', takeover: false });
    assert.equal(playPermitted(), true, 'the next resume does not wait on the network');
  });

  test('409 refuses and raises the prompt, holding the retry', async () => {
    await signIn();
    answer(409, { error: 'playing elsewhere', device: 'Galaxy Tab' });
    const retry = () => {};

    assert.equal(await claimPlay(retry), false);

    assert.deepEqual(playNotice(), { kind: 'elsewhere', device: 'Galaxy Tab', retry });
  });

  test('"Play here instead" claims with takeover and runs the retry', async () => {
    await signIn();
    answer(409, { error: 'playing elsewhere', device: 'Galaxy Tab' });
    let ran = 0;
    await claimPlay(() => ran++);
    answer(200, { ok: true, leaseMs: 120_000 });

    assert.equal(await takeOver(), true);

    assert.equal(sent[1].body.takeover, true);
    assert.equal(ran, 1);
    assert.equal(playNotice(), null);
  });

  test('offline long past the grace refuses with the reconnect notice', async () => {
    await signIn(Date.now() - OFFLINE_GRACE_MS - 1000);
    answer(0, new Error('offline'));

    assert.equal(await claimPlay(), false);
    assert.deepEqual(playNotice(), { kind: 'offline' });
  });

  test('offline inside the grace plays', async () => {
    await signIn(Date.now() - 60_000);
    answer(0, new Error('offline'));
    assert.equal(await claimPlay(), true);
    assert.equal(playNotice(), null);
  });
});

describe('beat — the heartbeat', () => {
  test('while playing, a 409 pauses and says where the music went', async () => {
    await signIn();
    answer(200, { ok: true });
    await claimPlay();
    answer(409, { error: 'playing elsewhere', device: 'Pixel 8' });
    let paused = 0;

    await beat(true, () => paused++);

    assert.equal(paused, 1);
    assert.equal(playNotice().kind, 'moved');
    assert.equal(playNotice().device, 'Pixel 8');
    assert.equal(playPermitted(), false);
  });

  test('a missed beat just re-claims, without takeover', async () => {
    await signIn();
    answer(200, { ok: true });
    await beat(true, () => assert.fail('must not pause'));
    assert.equal(sent[0].body.takeover, false);
  });

  test('a failing network never pauses a track that is playing', async () => {
    await signIn(Date.now() - OFFLINE_GRACE_MS - 1000);
    answer(0, new Error('offline'));
    await beat(true, () => assert.fail('the network is not a reason to stop mid-song'));
  });

  test('not playing: gives a held lease back', async () => {
    await signIn();
    answer(200, { ok: true });
    await claimPlay();
    sent = [];

    await beat(false, () => {});
    // The release is fire-and-forget; let it reach fetch before looking.
    await new Promise((r) => setTimeout(r, 0));

    assert.ok(sent[0].url.endsWith('/v1/play/release'));
    assert.equal(playPermitted(), false);
  });

  test('signed out, it does nothing at all', async () => {
    await loadAccount();
    answer(200, { ok: true });
    await beat(true, () => assert.fail());
    assert.deepEqual(sent, []);
  });
});

describe('releasePlay', () => {
  test('only releases a lease it holds — a permit is not the server’s to free', async () => {
    await signIn(Date.now() - 1000);
    answer(0, new Error('offline'));
    await claimPlay();
    sent = [];
    releasePlay();
    assert.deepEqual(sent, []);
  });
});
