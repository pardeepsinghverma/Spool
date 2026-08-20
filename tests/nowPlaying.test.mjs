import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import { freeze } from './harness/clock.mjs';

/**
 * One card, two engines that know nothing about each other.
 *
 * This module has already produced the worst class of bug this app has had:
 * the card alternating between a library track and a page title twice a second,
 * with the transport buttons acting on whichever had written last. So the
 * ownership rule gets tested as a rule — who may take the card, who may only
 * update it, and who may take it down — rather than call by call.
 *
 * Each case gets a fresh copy of the module, because ownership is module-level
 * state and a test that inherited it would be testing the previous test.
 */

let counter = 0;
const load = () => import(`../src/player/nowPlaying.ts?fresh=${counter++}`);

const NOW = 1_700_000_000_000;
let clock;

beforeEach(() => {
  native.reset();
  clock = freeze(NOW);
});
afterEach(() => clock.restore());

const state = (over = {}) => ({
  title: 'Song',
  artist: 'Someone',
  source: 'On this device',
  playing: true,
  artwork: null,
  position: 0,
  duration: 300,
  canNext: false,
  canPrevious: false,
  canSave: false,
  ...over,
});

const published = () => native.callsTo('setNowPlaying').map(([s]) => s);

describe('taking the card', () => {
  test('a source that is playing takes it', async () => {
    const { publishNowPlaying, ownsNotification } = await load();
    publishNowPlaying('browser', state({ title: 'A page' }));
    assert.equal(ownsNotification('browser'), true);
    assert.equal(published().length, 1);
  });

  test('a silent source may not take one from a source that is playing', async () => {
    const { publishNowPlaying, ownsNotification } = await load();
    publishNowPlaying('browser', state({ title: 'A page', playing: true }));
    publishNowPlaying('local', state({ title: 'A track', playing: false }));
    assert.equal(ownsNotification('browser'), true);
    assert.deepEqual(published().map((s) => s.title), ['A page']);
  });

  test('a silent source may still update the card it already owns', async () => {
    const { publishNowPlaying, ownsNotification } = await load();
    publishNowPlaying('local', state({ title: 'A track', playing: true }));
    publishNowPlaying('local', state({ title: 'A track', playing: false }));
    assert.equal(ownsNotification('local'), true);
    assert.deepEqual(published().map((s) => s.playing), [true, false]);
  });

  test('nothing owns the card before anything has played', async () => {
    const { ownsNotification } = await load();
    assert.equal(ownsNotification('local'), false);
    assert.equal(ownsNotification('browser'), false);
  });

  test('two sources playing at once do trade the card back and forth', async () => {
    // Documents the limit of the rule rather than a defect: "playing" is what
    // entitles a source to take the card, so if both are audible they both
    // qualify. Nothing here prevents that — the playback gate does, by
    // silencing the page before local media starts. If that gate is ever
    // skipped, this is the flapping it produces.
    const { publishNowPlaying } = await load();
    for (let i = 0; i < 3; i++) {
      publishNowPlaying('browser', state({ title: 'A page', position: i }));
      publishNowPlaying('local', state({ title: 'A track', position: i }));
    }
    assert.equal(published().length, 6);
  });
});

describe('suppressing publishes that would change nothing', () => {
  test('an unchanged state does not reach the bridge', async () => {
    const { publishNowPlaying } = await load();
    publishNowPlaying('local', state({ position: 10 }));
    publishNowPlaying('local', state({ position: 10 }));
    publishNowPlaying('local', state({ position: 10 }));
    assert.equal(published().length, 1);
  });

  test('a playhead the system can extrapolate to is not worth a call', async () => {
    // A PlaybackState carries a position, the clock it was taken at and a
    // speed. A second later the system already thinks the track is at 11.
    const { publishNowPlaying } = await load();
    publishNowPlaying('local', state({ position: 10 }));
    clock.advance(1000);
    publishNowPlaying('local', state({ position: 11 }));
    assert.equal(published().length, 1);
  });

  test('a real drift past two seconds is', async () => {
    const { publishNowPlaying } = await load();
    publishNowPlaying('local', state({ position: 10 }));
    clock.advance(1000);
    publishNowPlaying('local', state({ position: 30 }));
    assert.equal(published().length, 2);
    assert.equal(published()[1].position, 30);
  });

  test('a paused track does not drift, so its playhead is trusted as still', async () => {
    // The card has to be claimed by playing first — a source that has never
    // made a sound cannot take one at all, which is the rule above.
    const { publishNowPlaying } = await load();
    publishNowPlaying('local', state({ position: 10, playing: true }));
    publishNowPlaying('local', state({ position: 10, playing: false }));
    assert.equal(published().length, 2, 'pausing changes the shape');
    clock.advance(60_000);
    publishNowPlaying('local', state({ position: 10, playing: false }));
    assert.equal(published().length, 2, 'a minute later it is still at 10');
  });

  test('the save button appearing is a change, so the card repaints', async () => {
    // Left out of the shape, the card would go on offering a save for a file
    // that already exists until something else happened to change.
    const { publishNowPlaying } = await load();
    publishNowPlaying('browser', state({ canSave: true }));
    publishNowPlaying('browser', state({ canSave: false }));
    assert.equal(published().length, 2);
  });

  test('artwork arriving repaints', async () => {
    const { publishNowPlaying } = await load();
    publishNowPlaying('local', state({ artwork: null }));
    publishNowPlaying('local', state({ artwork: 'file:///cover.jpg' }));
    assert.equal(published().length, 2);
  });

  test('a per-source memory stops the other one being stolen back by an idle tick', async () => {
    // With one shared "last published" string, the local player's next idle
    // tick differs from the browser's entry in the source field alone and
    // silently retakes the card while nothing about it has changed.
    const { publishNowPlaying, ownsNotification } = await load();
    publishNowPlaying('local', state({ title: 'A track', playing: true }));
    publishNowPlaying('browser', state({ title: 'A page', playing: true }));
    publishNowPlaying('local', state({ title: 'A track', playing: false }));
    assert.equal(ownsNotification('browser'), true);
    assert.equal(published().length, 2);
  });
});

describe('putting the card down', () => {
  test('the owner may', async () => {
    const { publishNowPlaying, releaseNowPlaying, ownsNotification } = await load();
    publishNowPlaying('browser', state());
    releaseNowPlaying('browser');
    assert.equal(native.callsTo('stopBackgroundPlayback').length, 1);
    assert.equal(ownsNotification('browser'), false);
  });

  test('a source that has already lost it may not', async () => {
    // Closing a browser tab must not take down the card for a library track
    // that has just started.
    const { publishNowPlaying, releaseNowPlaying, ownsNotification } = await load();
    publishNowPlaying('browser', state({ title: 'A page' }));
    publishNowPlaying('local', state({ title: 'A track' }));
    releaseNowPlaying('browser');
    assert.equal(native.callsTo('stopBackgroundPlayback').length, 0);
    assert.equal(ownsNotification('local'), true);
  });

  test('after a release the same state publishes again rather than being suppressed', async () => {
    const { publishNowPlaying, releaseNowPlaying } = await load();
    publishNowPlaying('local', state({ position: 5 }));
    releaseNowPlaying('local');
    publishNowPlaying('local', state({ position: 5 }));
    assert.equal(published().length, 2);
  });
});

describe('commands coming back', () => {
  test('reach only the source the card is describing', async () => {
    const { publishNowPlaying, onNotificationCommand } = await load();
    const heard = { local: 0, browser: 0 };
    onNotificationCommand('local', () => heard.local++);
    onNotificationCommand('browser', () => heard.browser++);

    publishNowPlaying('browser', state());
    native.emit('onPlaybackCommand', { command: 'pause', value: 0 });
    assert.deepEqual(heard, { local: 0, browser: 1 });

    publishNowPlaying('local', state());
    native.emit('onPlaybackCommand', { command: 'pause', value: 0 });
    assert.deepEqual(heard, { local: 1, browser: 1 });
  });

  test('reach nobody once the card is down', async () => {
    const { publishNowPlaying, releaseNowPlaying, onNotificationCommand } = await load();
    let heard = 0;
    onNotificationCommand('local', () => heard++);
    publishNowPlaying('local', state());
    releaseNowPlaying('local');
    native.emit('onPlaybackCommand', { command: 'play', value: 0 });
    assert.equal(heard, 0);
  });

  test('unsubscribing stops delivery', async () => {
    const { publishNowPlaying, onNotificationCommand } = await load();
    let heard = 0;
    const sub = onNotificationCommand('local', () => heard++);
    publishNowPlaying('local', state());
    sub.remove();
    native.emit('onPlaybackCommand', { command: 'play', value: 0 });
    assert.equal(heard, 0);
  });
});
