import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import { reset as resetStorage, seed, raw } from './harness/stubs/async-storage.mjs';

/**
 * Cover art is resolved once per item and then remembered — three times over,
 * because the design's first rule is that the artwork *is* the interface and
 * the decode has to be native.
 *
 * The failures worth catching are all about doing too much: a library of three
 * hundred items opening three hundred connections on boot to fill rows nobody
 * has scrolled to, or retrying an item with no artwork anywhere on every single
 * render for the life of the app.
 */

let counter = 0;
const load = () => import(`../src/core/artwork.ts?fresh=${counter++}`);

beforeEach(() => {
  native.reset();
  resetStorage();
});

const record = (id, over = {}) => ({
  id,
  title: 'A song',
  quality: 'audio',
  audioOnly: true,
  savedAt: 1,
  state: 'saved',
  ...over,
});

const ART = { uri: 'file:///art.jpg', dominant: '#222222' };

/**
 * Hold every native decode open until the test lets it finish.
 *
 * Settling has to be done in rounds: releasing the three in flight lets three
 * more through, and those do not exist yet at the moment the first three are
 * released.
 */
function held() {
  const pending = [];
  native.handlers.readArtwork = () =>
    new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const settle = async (n, how) => {
    for (let i = 0; i < n && pending.length; i++) pending.shift()[how](
      how === 'resolve' ? ART : new Error('no artwork'),
    );
    await tick();
  };
  return {
    get open() {
      return pending.length;
    },
    release: (n = 1) => settle(n, 'resolve'),
    fail: (n = 1) => settle(n, 'reject'),
    /** Drain everything, round by round, until nothing is waiting. */
    async drain() {
      while (pending.length) await settle(pending.length, 'resolve');
    },
  };
}

const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

describe('asking once', () => {
  test('eight rows appearing at once produce one native call', async () => {
    // Otherwise eight races write the same cache file.
    const { resolveArtwork } = await load();
    const row = record('dl-1', { uri: 'content://1', videoId: 'dQw4w9WgXcQ' });
    const results = await Promise.all(Array.from({ length: 8 }, () => resolveArtwork(row)));
    assert.equal(native.callsTo('readArtwork').length, 1);
    assert.equal(new Set(results).size, 1);
  });

  test('a resolved item is never asked about again', async () => {
    const { resolveArtwork, artworkFor } = await load();
    const row = record('dl-1', { uri: 'content://1' });
    await resolveArtwork(row);
    await resolveArtwork(row);
    assert.equal(native.callsTo('readArtwork').length, 1);
    assert.equal(artworkFor('dl-1').dominant, '#101010');
  });

  test('a failure is remembered as hard as a success', async () => {
    // An item with no artwork anywhere would otherwise be a network call per
    // row per launch, forever.
    native.handlers.readArtwork = async () => {
      throw new Error('nothing found');
    };
    const { resolveArtwork, artworkFor } = await load();
    const row = record('dl-1', { uri: 'content://1' });
    assert.equal(await resolveArtwork(row), null);
    assert.equal(await resolveArtwork(row), null);
    assert.equal(native.callsTo('readArtwork').length, 1);
    assert.equal(artworkFor('dl-1'), null);
  });

  test('an item with nowhere to look is not asked about at all', async () => {
    const { resolveArtwork } = await load();
    assert.equal(await resolveArtwork(record('dl-1')), null);
    assert.equal(native.callsTo('readArtwork').length, 0);
  });

  test('a page and a saved file of the same video are kept apart', async () => {
    // The file's own embedded cover is the better of the two; sharing a key
    // would let whichever resolved first answer for both.
    const { resolveArtwork, resolveVideoArtwork } = await load();
    await resolveArtwork(record('dl-1', { uri: 'content://1', videoId: 'dQw4w9WgXcQ' }));
    await resolveVideoArtwork('dQw4w9WgXcQ');
    const keys = native.callsTo('readArtwork').map(([key]) => key);
    assert.deepEqual(keys, ['dl-1', 'yt:dQw4w9WgXcQ']);
  });

  test('a video with no id resolves to nothing without touching the bridge', async () => {
    const { resolveVideoArtwork } = await load();
    assert.equal(await resolveVideoArtwork(''), null);
    assert.equal(native.callsTo('readArtwork').length, 0);
  });
});

describe('what is handed to the decoder', () => {
  test('the uri whole, scheme and all', async () => {
    // Stripping to a bare path left the embedded cover unreachable for exactly
    // the items the user chose by hand, which is most of a real library.
    const { resolveArtwork } = await load();
    await resolveArtwork(record('dl-1', { uri: 'content://media/audio/7', videoId: 'dQw4w9WgXcQ' }));
    const [, path, urls] = native.callsTo('readArtwork')[0];
    assert.equal(path, 'content://media/audio/7');
    assert.equal(urls.length, 3);
  });

  test('thumbnails in shape-before-size order', async () => {
    // hqdefault is 4:3 with black bars baked in, which is what put a
    // letterboxed cover on the player. It stays last because it always exists.
    const { resolveVideoArtwork } = await load();
    await resolveVideoArtwork('dQw4w9WgXcQ');
    const [, , urls] = native.callsTo('readArtwork')[0];
    assert.deepEqual(urls, [
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg',
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hq720.jpg',
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
    ]);
  });

  test('no thumbnails for a row that is not linked to a video', async () => {
    // A row restored from MediaStore has no videoId — there is nothing in the
    // file to say which video it came from.
    const { resolveArtwork } = await load();
    await resolveArtwork(record('found:content://1', { uri: 'content://1' }));
    const [, , urls] = native.callsTo('readArtwork')[0];
    assert.deepEqual(urls, []);
  });
});

describe('not flooding the device on boot', () => {
  test('three at a time, however many the library hands over', async () => {
    const gate = held();
    const { resolveArtwork } = await load();
    const rows = Array.from({ length: 10 }, (_, i) =>
      record(`dl-${i}`, { uri: `content://${i}` }),
    );
    const all = Promise.all(rows.map(resolveArtwork));
    await tick();
    assert.equal(gate.open, 3);

    await gate.release(1);
    assert.equal(gate.open, 3, 'a finished decode hands its slot to the next');

    await gate.drain();
    await all;
    assert.equal(native.callsTo('readArtwork').length, 10);
  });

  test('a failed decode returns its slot too', async () => {
    // A leaked permit would stall every remaining cover in the library.
    const gate = held();
    const { resolveArtwork } = await load();
    const rows = Array.from({ length: 6 }, (_, i) =>
      record(`dl-${i}`, { uri: `content://${i}` }),
    );
    const all = Promise.all(rows.map(resolveArtwork));
    await tick();
    await gate.fail(3);
    assert.equal(gate.open, 3, 'three rejections released three permits');
    await gate.drain();
    assert.deepEqual(await all, [null, null, null, ART, ART, ART]);
  });
});

describe('remembering across launches', () => {
  test('a stored index answers without asking the device', async () => {
    seed('dl.artwork', JSON.stringify({ 'dl-1': { uri: 'file:///cached.jpg', dominant: '#abcdef' } }));
    const { loadArtworkIndex, artworkFor, resolveArtwork } = await load();
    await loadArtworkIndex();
    assert.equal(artworkFor('dl-1').dominant, '#abcdef');
    await resolveArtwork(record('dl-1', { uri: 'content://1' }));
    assert.equal(native.callsTo('readArtwork').length, 0);
  });

  test('a corrupt index costs one re-decode, not a crash', async () => {
    seed('dl.artwork', '{ not json');
    const { loadArtworkIndex, resolveArtwork } = await load();
    await loadArtworkIndex();
    await resolveArtwork(record('dl-1', { uri: 'content://1' }));
    assert.equal(native.callsTo('readArtwork').length, 1);
  });

  test('is written once, batched, rather than on every cover', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { resolveArtwork } = await load();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        resolveArtwork(record(`dl-${i}`, { uri: `content://${i}` })),
      ),
    );
    assert.equal(raw('dl.artwork'), null, 'still batched');
    t.mock.timers.tick(2000);
    await tick();
    assert.equal(Object.keys(JSON.parse(raw('dl.artwork'))).length, 5);
    t.mock.timers.reset();
  });
});

describe('forgetting', () => {
  test('lets a removed and re-added item look again', async () => {
    const { resolveArtwork, forgetArtwork, artworkFor } = await load();
    const row = record('dl-1', { uri: 'content://1' });
    await resolveArtwork(row);
    forgetArtwork('dl-1');
    assert.equal(artworkFor('dl-1'), null);
    await resolveArtwork(row);
    assert.equal(native.callsTo('readArtwork').length, 2);
  });

  test('forgetting something unknown changes nothing', async () => {
    const { forgetArtwork, onArtworkChange } = await load();
    let told = 0;
    onArtworkChange(() => told++);
    forgetArtwork('never-seen');
    assert.equal(told, 0);
  });

  test('subscribers hear about a cover arriving', async () => {
    const { resolveArtwork, onArtworkChange } = await load();
    let told = 0;
    const off = onArtworkChange(() => told++);
    await resolveArtwork(record('dl-1', { uri: 'content://1' }));
    assert.equal(told, 1);
    off();
    await resolveArtwork(record('dl-2', { uri: 'content://2' }));
    assert.equal(told, 1);
  });
});
