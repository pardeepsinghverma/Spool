import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { usePlayTracking, MIN_PLAY_SECONDS } from '../src/browser/usePlayTracking.ts';
import { mount } from './harness/stubs/react.mjs';
import { reset, seed, raw } from './harness/stubs/async-storage.mjs';
import { freeze } from './harness/clock.mjs';

/**
 * The counter the auto-save rule acts on.
 *
 * Everything downstream of this is invisible: a start banked here becomes a
 * file on someone's phone that they did not ask for, and on a pre-release build
 * it spends one of ten save slots. So the bar for crediting anything is high,
 * and these are the ways it has to stay high — muted previews, scrubbing,
 * buffering, a paused tab left open all afternoon.
 */

const NOW = 1_700_000_000_000;
let clock;

beforeEach(() => {
  reset();
  clock = freeze(NOW);
});
afterEach(() => clock.restore());

const media = (over = {}) => ({
  type: 'media',
  hasMedia: true,
  playing: true,
  title: 'A song',
  artist: 'Someone',
  music: false,
  id: 'dQw4w9WgXcQ',
  at: 0,
  length: 300,
  wanted: true,
  ...over,
});

async function setup(onCounted) {
  const counted = [];
  const handle = mount(() =>
    usePlayTracking((stat) => {
      counted.push(stat);
      onCounted?.(stat);
    }),
  );
  // The index loads from storage before anything is credited.
  await handle.flush();
  return { handle, counted, api: () => handle.current };
}

/** Feed `seconds` of real playback, one report per second, as the page does. */
const watch = (handle, seconds, over = {}) => {
  const from = over.from ?? 0;
  for (let t = from; t <= from + seconds; t++) {
    handle.current.onMedia(media({ ...over, at: t }));
  }
};

describe('what counts as a play', () => {
  test('five seconds of real playback banks a start', async () => {
    const { handle, counted, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS);
    assert.equal(counted.length, 1);
    assert.equal(counted[0].starts, 1);
    assert.equal(counted[0].seconds, MIN_PLAY_SECONDS);
    assert.equal(api().plays['dQw4w9WgXcQ'].starts, 1);
  });

  test('a look rather than a play banks nothing', async () => {
    const { handle, counted, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS - 1);
    assert.equal(counted.length, 0);
    assert.deepEqual(api().plays, {});
  });

  test('one visit cannot bank two starts however long it runs', async () => {
    const { handle, counted } = await setup();
    watch(handle, 300);
    assert.equal(counted.length, 1);
  });

  test('leaving and coming back is a second play', async () => {
    const { handle, counted, api } = await setup();
    watch(handle, 10);
    handle.current.onMedia(media({ id: '', hasMedia: false }));
    watch(handle, 10);
    assert.equal(counted.length, 2);
    assert.equal(api().plays['dQw4w9WgXcQ'].starts, 2);
  });

  test('reports before the index has loaded are ignored', async () => {
    // Crediting against an empty index would overwrite whatever is on disk with
    // a count that starts from zero.
    seed('dl.plays', JSON.stringify({ dQw4w9WgXcQ: { id: 'dQw4w9WgXcQ', title: 'x', artist: '', starts: 4, seconds: 100, lastAt: 1 } }));
    const handle = mount(() => usePlayTracking());
    watch(handle, 30);
    assert.deepEqual(handle.current.plays, {});
    await handle.flush();
    assert.equal(handle.current.plays['dQw4w9WgXcQ'].starts, 4);
  });
});

describe('what must never count', () => {
  test('a paused tab left open all afternoon earns nothing', async () => {
    const { handle, api } = await setup();
    for (let t = 0; t < 600; t++) {
      handle.current.onMedia(media({ playing: false, at: 10 }));
    }
    assert.deepEqual(api().plays, {});
  });

  test('scrubbing while paused is adopted, not credited', async () => {
    // The position has to be adopted so that resuming does not read as one
    // enormous forward step — while still crediting none of the jump.
    const { handle, api } = await setup();
    watch(handle, 3);
    handle.current.onMedia(media({ playing: false, at: 3 }));
    handle.current.onMedia(media({ playing: false, at: 200 }));
    for (let t = 200; t <= 204; t++) handle.current.onMedia(media({ at: t }));

    const stat = api().plays['dQw4w9WgXcQ'];
    assert.equal(stat.starts, 1, '3 + 4 real seconds crossed the threshold');
    assert.equal(stat.seconds, MIN_PLAY_SECONDS, 'the 197-second jump earned nothing');
  });

  test('dragging to the end of an hour-long video earns nothing', async () => {
    const { handle, api } = await setup();
    handle.current.onMedia(media({ at: 0 }));
    handle.current.onMedia(media({ at: 3599 }));
    assert.deepEqual(api().plays, {});
  });

  test('rewinding is not watching either', async () => {
    const { handle, api } = await setup();
    handle.current.onMedia(media({ at: 100 }));
    handle.current.onMedia(media({ at: 40 }));
    handle.current.onMedia(media({ at: 41 }));
    assert.equal(api().plays['dQw4w9WgXcQ'], undefined);
  });

  test('a three-second step is playback and a fraction more is a seek', async () => {
    // Reports arrive about once a second, so a three-second gap is a slow tick
    // on a busy page. Anything past it is the thumb on the scrubber.
    const { handle } = await setup();
    handle.current.onMedia(media({ at: 0 }));
    handle.current.onMedia(media({ at: 3 }));
    handle.current.onMedia(media({ at: 6 }));
    assert.equal(handle.current.plays['dQw4w9WgXcQ'].seconds, 6, 'both steps credited');

    const other = await setup();
    other.handle.current.onMedia(media({ at: 0 }));
    other.handle.current.onMedia(media({ at: 3.01 }));
    other.handle.current.onMedia(media({ at: 6.02 }));
    assert.equal(other.api().plays['dQw4w9WgXcQ'], undefined, 'neither step credited');
  });

  test('a report with no video id ends the session rather than crediting it', async () => {
    const { handle, api } = await setup();
    watch(handle, 3);
    handle.current.onMedia(media({ id: '', at: 4 }));
    handle.current.onMedia(media({ id: '', at: 5 }));
    assert.deepEqual(api().plays, {});
  });

  test('switching video mid-play does not credit the new one with the old seconds', async () => {
    const { handle, api } = await setup();
    watch(handle, 4, { id: 'aaaaaaaaaaa' });
    watch(handle, 5, { id: 'bbbbbbbbbbb' });
    assert.equal(api().plays['aaaaaaaaaaa'], undefined);
    assert.equal(api().plays['bbbbbbbbbbb'].seconds, MIN_PLAY_SECONDS);
  });
});

describe('watch time', () => {
  test('accumulates across the whole session', async () => {
    const { handle, api } = await setup();
    watch(handle, 50);
    // 5 banked with the start, then folded in every 15.
    assert.equal(api().plays['dQw4w9WgXcQ'].seconds, 50);
  });

  test('adds to what was already stored rather than replacing it', async () => {
    seed(
      'dl.plays',
      JSON.stringify({
        dQw4w9WgXcQ: { id: 'dQw4w9WgXcQ', title: 'Old title', artist: 'Old artist', starts: 2, seconds: 400, lastAt: 1 },
      }),
    );
    const { handle, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS);
    const stat = api().plays['dQw4w9WgXcQ'];
    assert.equal(stat.starts, 3);
    assert.equal(stat.seconds, 405);
    assert.equal(stat.lastAt, NOW);
  });

  test('up to fifteen seconds are lost when the user navigates away', async () => {
    // The tally is folded into the index every 15 seconds so a kill mid-video
    // does not lose everything. A clean navigation away is not folded at all —
    // `onMedia` with no id drops the session and whatever it was holding.
    // Watch time under-reports by up to 15s per visit as a result.
    const { handle, api } = await setup();
    watch(handle, 19);
    handle.current.onMedia(media({ id: '', hasMedia: false }));
    assert.equal(api().plays['dQw4w9WgXcQ'].seconds, 5, '19 seconds watched, 5 recorded');
  });
});

describe('metadata', () => {
  test('keeps the first decent title, because YouTube blanks it mid-navigation', async () => {
    const { handle, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS);
    watch(handle, 20, { from: 6, title: '', artist: '' });
    const stat = api().plays['dQw4w9WgXcQ'];
    assert.equal(stat.title, 'A song');
    assert.equal(stat.artist, 'Someone');
  });

  test('once the page calls something music it stays music', async () => {
    // The flag decides what "Match" keeps, and YouTube only sets a mediaSession
    // artist some of the time on the same video.
    const { handle, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS, { music: true });
    watch(handle, 20, { from: 6, music: false });
    assert.equal(api().plays['dQw4w9WgXcQ'].music, true);
  });
});

describe('marking a video as taken', () => {
  test('stamps it so the rule cannot queue it twice', async () => {
    const { handle, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS);
    handle.current.markSaved('dQw4w9WgXcQ');
    assert.equal(api().plays['dQw4w9WgXcQ'].savedAt, NOW);
  });

  test('an unknown id is a no-op rather than a phantom row', async () => {
    const { handle, api } = await setup();
    handle.current.markSaved('never-seen');
    assert.deepEqual(api().plays, {});
  });

  test('the stamp survives further plays of the same video', async () => {
    const { handle, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS);
    handle.current.markSaved('dQw4w9WgXcQ');
    handle.current.onMedia(media({ id: '' }));
    watch(handle, MIN_PLAY_SECONDS);
    assert.equal(api().plays['dQw4w9WgXcQ'].savedAt, NOW);
    assert.equal(api().plays['dQw4w9WgXcQ'].starts, 2);
  });

  test('forget removes it entirely', async () => {
    const { handle, api } = await setup();
    watch(handle, MIN_PLAY_SECONDS);
    handle.current.forget('dQw4w9WgXcQ');
    assert.deepEqual(api().plays, {});
  });
});

describe('persistence', () => {
  test('a pending write is not lost on unmount', async () => {
    // The last few seconds watched are the newest truth; dropping them on
    // unmount would roll the count back.
    const { handle } = await setup();
    watch(handle, MIN_PLAY_SECONDS);
    assert.equal(raw('dl.plays'), null, 'the write is still batched');
    handle.unmount();
    await Promise.resolve();
    const stored = JSON.parse(raw('dl.plays'));
    assert.equal(stored['dQw4w9WgXcQ'].starts, 1);
  });

  test('a play does not hit disk once a second', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { handle } = await setup();
    watch(handle, 60);
    assert.equal(raw('dl.plays'), null);
    t.mock.timers.tick(4000);
    await Promise.resolve();
    assert.notEqual(raw('dl.plays'), null, 'one write, four seconds after the first change');
    t.mock.timers.reset();
  });
});
