import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadPlays, savePlays, clearPlays, describePlays, ranked } from '../src/core/plays.ts';
import { reset, seed, raw, faults } from './harness/stubs/async-storage.mjs';

/**
 * The play index is the only thing in the app that records behaviour rather
 * than results, and the auto-save rule reads it to decide what to put on
 * someone's phone without asking. Two properties matter: it stays bounded, and
 * what it drops when it trims is the least damaging thing available.
 */

beforeEach(reset);

const stat = (id, over = {}) => ({
  id,
  title: id,
  artist: '',
  starts: 1,
  seconds: 60,
  lastAt: 1000,
  ...over,
});

const indexOf = (stats) => Object.fromEntries(stats.map((s) => [s.id, s]));

describe('loadPlays', () => {
  test('an array is not an index', async () => {
    seed('dl.plays', JSON.stringify([stat('a')]));
    assert.deepEqual(await loadPlays(), {});
  });

  test('corrupt, null and unreadable all read as empty', async () => {
    seed('dl.plays', '{ not json');
    assert.deepEqual(await loadPlays(), {});
    seed('dl.plays', 'null');
    assert.deepEqual(await loadPlays(), {});
    faults.read = true;
    assert.deepEqual(await loadPlays(), {});
  });
});

describe('savePlays trimming', () => {
  test('leaves an index at the cap untouched', async () => {
    const index = indexOf(Array.from({ length: 300 }, (_, i) => stat(`v${i}`, { lastAt: i })));
    await savePlays(index);
    assert.equal(Object.keys(JSON.parse(raw('dl.plays'))).length, 300);
  });

  test('drops what the rule has already acted on before anything else', async () => {
    // A saved entry's counters have done their job; an unsaved one still has a
    // threshold to cross.
    const index = indexOf([
      ...Array.from({ length: 300 }, (_, i) => stat(`fresh${i}`, { lastAt: 1 })),
      stat('taken', { lastAt: 9_999_999, savedAt: 1 }),
    ]);
    await savePlays(index);
    const kept = JSON.parse(raw('dl.plays'));
    assert.equal(Object.keys(kept).length, 300);
    assert.equal(
      kept.taken,
      undefined,
      'the most recently played entry is dropped because it was already saved',
    );
  });

  test('then evicts by least recently played', async () => {
    const index = indexOf(
      Array.from({ length: 305 }, (_, i) => stat(`v${i}`, { lastAt: i })),
    );
    await savePlays(index);
    const kept = JSON.parse(raw('dl.plays'));
    assert.equal(Object.keys(kept).length, 300);
    assert.equal(kept.v0, undefined);
    assert.equal(kept.v4, undefined);
    assert.notEqual(kept.v5, undefined);
    assert.notEqual(kept.v304, undefined);
  });

  test('an overfull index of saved entries loses its save markers', async () => {
    // Consequence worth stating: `savedAt` is what stops the replay rule taking
    // a video twice. Past 300 tracked videos the markers are the first thing
    // evicted, so a heavy user's older saves stop being remembered as saves.
    // The library's own `videoId` check is what catches it after that — and
    // that list is itself capped at 200.
    const index = indexOf([
      ...Array.from({ length: 300 }, (_, i) => stat(`fresh${i}`, { lastAt: 500 + i })),
      ...Array.from({ length: 5 }, (_, i) => stat(`taken${i}`, { lastAt: 1000, savedAt: 1 })),
    ]);
    await savePlays(index);
    const kept = JSON.parse(raw('dl.plays'));
    assert.equal(Object.values(kept).filter((s) => s.savedAt).length, 0);
  });

  test('does not mutate the index it was handed', async () => {
    const index = indexOf(Array.from({ length: 305 }, (_, i) => stat(`v${i}`, { lastAt: i })));
    await savePlays(index);
    assert.equal(Object.keys(index).length, 305);
  });

  test('a failed write leaves the caller with a working index', async () => {
    faults.write = true;
    await savePlays(indexOf([stat('a')]));
    assert.equal(raw('dl.plays'), null);
  });
});

describe('clearPlays', () => {
  test('removes the index and survives a failing store', async () => {
    seed('dl.plays', JSON.stringify(indexOf([stat('a')])));
    await clearPlays();
    assert.equal(raw('dl.plays'), null);
    faults.write = true;
    await clearPlays();
  });
});

describe('describePlays', () => {
  test('counts plays in words that survive one', () => {
    assert.equal(describePlays(stat('a', { starts: 1, seconds: 600 })), '1 play · 10 min');
    assert.equal(describePlays(stat('a', { starts: 3, seconds: 2460 })), '3 plays · 41 min');
    assert.equal(describePlays(stat('a', { starts: 0, seconds: 0 })), '0 plays · 0s');
  });

  test('falls to seconds below a minute', () => {
    assert.equal(describePlays(stat('a', { starts: 2, seconds: 29 })), '2 plays · 29s');
    assert.equal(describePlays(stat('a', { starts: 2, seconds: 30 })), '2 plays · 1 min');
  });
});

describe('ranked', () => {
  test('most played first, then most watched, then most recent', () => {
    const index = indexOf([
      stat('c', { starts: 2, seconds: 100, lastAt: 3 }),
      stat('a', { starts: 5, seconds: 10, lastAt: 1 }),
      stat('d', { starts: 2, seconds: 100, lastAt: 9 }),
      stat('b', { starts: 2, seconds: 500, lastAt: 2 }),
    ]);
    assert.deepEqual(ranked(index).map((s) => s.id), ['a', 'b', 'd', 'c']);
  });

  test('an empty index ranks to nothing', () => {
    assert.deepEqual(ranked({}), []);
  });
});
