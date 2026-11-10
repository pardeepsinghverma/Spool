import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  clientLost,
  clientScores,
  clientWon,
  forgetClientScores,
  loadClientScores,
  orderChain,
  resetClientScores,
} from '../src/core/clients.ts';
import { reset, seed, raw, faults } from './harness/stubs/async-storage.mjs';

/**
 * The client scoreboard decides which InnerTube client a cold start asks first.
 *
 * Two properties carry the whole file. It must **never remove a client** — a
 * board that has learned something wrong is then only ever slower, and can
 * never be the reason a download fails — and it must **change its mind faster
 * than YouTube does**, because which clients serve unattested requests moves
 * monthly and a preference that outlives the fact is worse than no preference.
 */

const KEY = 'spool.clients.v1';
const OPEN = ['tv', null, 'web_embedded', 'mweb', 'android_vr'];

beforeEach(() => {
  reset();
  resetClientScores();
});

/** Runs a client's score down to the floor, as a session of refusals would. */
const bury = (mode, client, times = 12) => {
  for (let i = 0; i < times; i++) clientLost(mode, client);
};

describe('orderChain', () => {
  test('an unscored chain is the chain, exactly as written', () => {
    // The base order encodes yt-dlp's published requirement table. On a fresh
    // install there is nothing better to go on, and this file must not invent
    // an opinion it has not earned.
    assert.deepEqual(orderChain('open', OPEN), OPEN);
  });

  test('a client that keeps refusing sinks, and is still asked', () => {
    bury('open', 'tv');
    const order = orderChain('open', OPEN);
    assert.equal(order[0], null, 'the next in the table leads instead');
    assert.equal(order.at(-1), 'tv');
    assert.equal(order.length, OPEN.length, 'nothing is dropped, ever');
    assert.deepEqual([...order].sort(byName), [...OPEN].sort(byName));
  });

  test('a client that keeps working leads', () => {
    for (let i = 0; i < 12; i++) clientWon('open', 'mweb');
    assert.equal(orderChain('open', OPEN)[0], 'mweb');
  });

  test('one unlucky request does not outvote the table', () => {
    // A single refusal moves the score by 1 while MEANINGFUL is 0.5, so this is
    // deliberately the *second* loss: the point is that the margin exists at
    // all, not where exactly it sits.
    clientLost('open', 'tv');
    assert.equal(orderChain('open', OPEN)[0], null, 'one loss is enough to yield');
    resetClientScores();
    clientWon('open', 'tv');
    assert.deepEqual(orderChain('open', OPEN), OPEN, 'a win keeps its place');
  });

  test('equal scores keep the base order', () => {
    for (const client of OPEN) clientWon('open', client);
    assert.deepEqual(orderChain('open', OPEN), OPEN);
  });

  test('four wins undo a buried client', () => {
    // The decay is the number that matters: a client YouTube re-opens has to be
    // picked back up inside a browsing session, not after a reinstall.
    bury('open', 'tv');
    for (let i = 0; i < 4; i++) clientWon('open', 'tv');
    assert.equal(orderChain('open', OPEN)[0], 'tv');
  });

  test('the two modes score separately', () => {
    // `web` is SABR-only without a token and perfectly good with one. One board
    // for both would have each half teaching the other the wrong lesson.
    bury('open', 'web');
    assert.deepEqual(
      orderChain('token', ['mweb', 'web']),
      ['mweb', 'web'],
      'burying it while tokenless taught the tokened walk nothing',
    );
    bury('token', 'mweb');
    assert.deepEqual(orderChain('token', ['mweb', 'web']), ['web', 'mweb']);
    assert.deepEqual(orderChain('open', ['mweb', 'web']), ['mweb', 'web'], 'and not the reverse');
  });

  test('the default chain is scored like any other client', () => {
    // `null` means "yt-dlp's own chain" and needs a key of its own, which is
    // the one thing a naive Record<string, number> gets wrong.
    bury('open', null);
    assert.equal(orderChain('open', OPEN).at(-1), null);
  });
});

describe('persistence', () => {
  test('a score survives a launch', async () => {
    bury('open', 'tv');
    await settle();
    resetClientScores();
    await loadClientScores();
    assert.equal(orderChain('open', OPEN).at(-1), 'tv');
  });

  test('one write per burst, not one per client asked', async () => {
    // A single download scores up to five times as the chain walks.
    for (const client of OPEN) clientLost('open', client);
    await settle();
    assert.equal(Object.keys(JSON.parse(raw(KEY))).length, OPEN.length);
  });

  test('a corrupt board reads as no board', async () => {
    seed(KEY, '{ not json');
    await loadClientScores();
    assert.deepEqual(orderChain('open', OPEN), OPEN);
  });

  test('an array is not a board', async () => {
    seed(KEY, JSON.stringify(['tv']));
    await loadClientScores();
    assert.deepEqual(orderChain('open', OPEN), OPEN);
  });

  test('a NaN cannot get in', async () => {
    // NaN sorts unpredictably rather than loudly, so a half-written file would
    // scramble the chain in a way nothing could be traced back to.
    seed(KEY, '{"open:tv": null, "open:mweb": "x", "open:web": 3}');
    await loadClientScores();
    const order = orderChain('open', OPEN);
    assert.deepEqual([...order].sort(byName), [...OPEN].sort(byName));
    assert.ok(Object.values(clientScores()).every(Number.isFinite));
  });

  test('an unreadable board is not a failed download', async () => {
    faults.read = true;
    await loadClientScores();
    assert.deepEqual(orderChain('open', OPEN), OPEN);
  });

  test('an unwritable board is not a failed download', async () => {
    faults.write = true;
    bury('open', 'tv');
    await settle();
    assert.equal(orderChain('open', OPEN).at(-1), 'tv', 'the session still learned');
  });

  test('reading twice does not undo what the session has learned', async () => {
    // `initEngine` is idempotent and calls this every time; a second read must
    // not overwrite scores earned since the first.
    await loadClientScores();
    bury('open', 'tv');
    await loadClientScores();
    assert.equal(orderChain('open', OPEN).at(-1), 'tv');
  });
});

describe('forgetClientScores', () => {
  test('an engine update wipes the board', async () => {
    // The scores describe how the *old* extractor got on with YouTube. After a
    // replacement, neither side is the one that was measured.
    bury('open', 'tv');
    forgetClientScores();
    assert.deepEqual(orderChain('open', OPEN), OPEN);
    await settle();
    assert.deepEqual(JSON.parse(raw(KEY)), {});
  });
});

const byName = (a, b) => String(a).localeCompare(String(b));

/** Long enough for the 2s save debounce. */
const settle = () => new Promise((r) => setTimeout(r, 2100));
