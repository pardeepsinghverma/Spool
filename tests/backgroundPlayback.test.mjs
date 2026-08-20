import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { useBackgroundPlayback } from '../src/browser/useBackgroundPlayback.ts';
import { releaseNowPlaying, publishNowPlaying } from '../src/player/nowPlaying.ts';
import { pagePlayback, setPagePlayback } from '../src/browser/pageNowPlaying.ts';
import { mount } from './harness/stubs/react.mjs';
import * as native from './harness/stubs/expo-modules-core.mjs';
import { setAppState, reset as resetAppState } from './harness/stubs/react-native.mjs';
import { freeze } from './harness/clock.mjs';

/**
 * The app half of browser background playback.
 *
 * One rule here is load-bearing above all the others: the foreground service
 * must never be dropped on `hasMedia: false` alone. Autoplay swaps the <video>
 * element, so between two tracks the page honestly has none — and stopping the
 * service there is unrecoverable, because the next raise has to *start* a
 * foreground service from the background, which Android 12+ refuses outright.
 * The queue goes quiet mid-playlist with nothing in the log but a warning.
 */

let clock;

beforeEach(() => {
  // Ownership of the card is module state shared with the local player; hand it
  // back before each case rather than inheriting the previous one's.
  releaseNowPlaying('local');
  releaseNowPlaying('browser');
  setPagePlayback(null);
  native.reset();
  resetAppState();
  clock = freeze(1_700_000_000_000);
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
  at: 12,
  length: 300,
  wanted: true,
  ...over,
});

function setup(options = {}) {
  const injected = [];
  const saved = [];
  const webview = { current: { injectJavaScript: (script) => injected.push(script) } };
  const save = {
    canSave: options.canSave ?? (() => true),
    onSave: (video) => saved.push(video),
    revision: 'r1',
  };
  const handle = mount(() => useBackgroundPlayback(webview, save));
  return { handle, injected, saved, api: () => handle.current, webview };
}

const cards = () => native.callsTo('setNowPlaying').map(([state]) => state);
const stopped = () => native.callsTo('stopBackgroundPlayback').length;

describe('holding the service up', () => {
  test('raises a card the moment something plays', () => {
    const { api } = setup();
    api().onMedia(media());
    assert.equal(cards().length, 1);
    assert.equal(cards()[0].title, 'A song');
    assert.equal(cards()[0].source, 'YouTube');
    assert.equal(cards()[0].position, 12);
    assert.equal(cards()[0].duration, 300);
  });

  test('a page between two tracks keeps the service, because it still wants one', () => {
    const { api } = setup();
    api().onMedia(media());
    api().onMedia(media({ hasMedia: false, playing: false, wanted: true }));
    assert.equal(stopped(), 0, 'the element is gone; the intent is not');
  });

  test('and only lets go once the page has actually given up', () => {
    const { api } = setup();
    api().onMedia(media());
    api().onMedia(media({ hasMedia: false, playing: false, wanted: false }));
    assert.equal(stopped(), 1);
  });

  test('a feed preview never gets a card of its own', () => {
    // An unmuted autoplay at the top of the home feed is enough to make the
    // page look like it is playing. A card titled "YouTube" over whatever the
    // user actually had on is not what a notification is for.
    const { api } = setup();
    api().onMedia(media({ id: '', title: '' }));
    assert.equal(cards().length, 0);
  });

  test('a paused watch page that never played does not raise one either', () => {
    const { api } = setup();
    api().onMedia(media({ playing: false }));
    assert.equal(cards().length, 0);
  });

  test('but a paused page that was playing keeps its card, now showing paused', () => {
    const { api } = setup();
    api().onMedia(media());
    api().onMedia(media({ playing: false }));
    assert.equal(cards().length, 2);
    assert.equal(cards()[1].playing, false);
  });

  test('offers no skip buttons, because there is nothing behind them', () => {
    // Advancing a Mix means clicking a button on a page the app cannot talk to
    // while it is backgrounded, so the control would be dead exactly when it
    // was wanted.
    const { api } = setup();
    api().onMedia(media());
    assert.equal(cards()[0].canNext, false);
    assert.equal(cards()[0].canPrevious, false);
  });

  test('offers a save only while the library says the file is not there', () => {
    let owned = false;
    const { api } = setup({ canSave: () => !owned });
    api().onMedia(media());
    assert.equal(cards()[0].canSave, true);
    owned = true;
    api().onMedia(media({ at: 13 }));
    assert.equal(cards().at(-1).canSave, false);
  });

  test('tearing the tree down takes the card with it', () => {
    const { api, handle } = setup();
    api().onMedia(media());
    handle.unmount();
    assert.equal(stopped(), 1);
  });
});

describe('the mini bar store', () => {
  test('a paused watch page still belongs on the bar', () => {
    // The bar is how the user gets back to it.
    const { api } = setup();
    api().onMedia(media({ playing: false }));
    assert.equal(pagePlayback().id, 'dQw4w9WgXcQ');
    assert.equal(pagePlayback().playing, false);
  });

  test('a page with nothing on it clears the bar', () => {
    const { api } = setup();
    api().onMedia(media());
    api().onMedia(media({ hasMedia: false, id: '', wanted: false }));
    assert.equal(pagePlayback(), null);
  });

  test('a track change keeps the bar rather than blanking it', () => {
    // Between two tracks the page has no element but still means to play.
    const { api } = setup();
    api().onMedia(media());
    api().onMedia(media({ hasMedia: false, id: '', wanted: true }));
    assert.equal(pagePlayback()?.id, 'dQw4w9WgXcQ');
  });
});

describe('dismissing from the bar', () => {
  test('the × takes down the bar and the card, and says stop to the page', () => {
    const { api, injected } = setup();
    api().onMedia(media());
    api().stopPage();
    assert.equal(pagePlayback(), null);
    assert.equal(stopped(), 1);
    assert.match(injected.at(-1), /__spoolMedia\.stop\(\)/);
  });

  test('and the same paused video reported a second later does not undo it', () => {
    // `stop` is `pause` on the page side — there is no verb that makes a watch
    // page stop being a watch page, so its own tick reports the same video
    // again a second later.
    const { api } = setup();
    api().onMedia(media());
    api().stopPage();
    api().onMedia(media({ playing: false }));
    assert.equal(pagePlayback(), null, 'the × has to keep meaning something');
  });

  test('playing it again is the user asking for it back', () => {
    const { api } = setup();
    api().onMedia(media());
    api().stopPage();
    api().onMedia(media({ playing: true }));
    assert.equal(pagePlayback()?.id, 'dQw4w9WgXcQ');
  });

  test('a different video is a different question', () => {
    const { api } = setup();
    api().onMedia(media());
    api().stopPage();
    api().onMedia(media({ id: 'abcdefghijk', playing: false }));
    assert.equal(pagePlayback()?.id, 'abcdefghijk');
  });

  test('an empty id between navigations is neither', () => {
    const { api } = setup();
    api().onMedia(media());
    api().stopPage();
    api().onMedia(media({ id: '', playing: false, hasMedia: false, wanted: true }));
    api().onMedia(media({ playing: false }));
    assert.equal(pagePlayback(), null);
  });

  test('a dead renderer clears everything, including the dismissal', () => {
    // The renderer that was showing that video is gone; whatever loads next has
    // not been refused yet.
    const { api } = setup();
    api().onMedia(media());
    api().stopPage();
    api().reset();
    api().onMedia(media({ playing: false }));
    assert.equal(pagePlayback()?.id, 'dQw4w9WgXcQ');
  });
});

describe('talking to the page', () => {
  test('every command goes by both routes at once', () => {
    // injectJavaScript is immediate on screen and queued off it; the cookie is
    // the reverse. Sending both means a tap from the shade is honoured now if
    // the app is open and within a second if it is not.
    const { api, injected } = setup();
    api().pause();
    assert.match(injected.at(-1), /__spoolMedia\.pause\(\)/);
    assert.deepEqual(native.callsTo('setPageCommand').at(-1), ['pause', clock.now]);
  });

  test('the bar toggles against what the page last said', () => {
    const { api, injected } = setup();
    api().onMedia(media({ playing: true }));
    api().toggle();
    assert.match(injected.at(-1), /pause\(\)/);
    api().onMedia(media({ playing: false }));
    api().toggle();
    assert.match(injected.at(-1), /play\(\)/);
  });

  test('a missing native function is not a crash — the injection still went', () => {
    native.handlers.setPageCommand = () => {
      throw new Error('no such function');
    };
    const { api, injected } = setup();
    api().pause();
    assert.match(injected.at(-1), /pause\(\)/);
  });

  test('backgrounding tells the page, and catches a play that started as the user left', () => {
    const { api, injected } = setup();
    api().onMedia(media({ playing: true }));
    native.reset();
    setAppState('background');
    assert.match(injected.at(-1), /setBackground\(true\)/);
    setAppState('active');
    assert.match(injected.at(-1), /setBackground\(false\)/);
  });

  test('a play that only started as the app left still gets its service', () => {
    const { api } = setup();
    // Paused reports raise nothing, so the service is down at this point.
    api().onMedia(media({ playing: false }));
    assert.equal(cards().length, 0);
    api().onMedia(media({ playing: true, hasMedia: true }));
    native.reset();
    setAppState('background');
    assert.equal(cards().length, 0, 'already up, so nothing more to do');
  });
});

describe('commands arriving from the notification', () => {
  const command = (name, value = 0) =>
    native.emit('onPlaybackCommand', { command: name, value });

  test('reach the page only while this source owns the card', () => {
    const { api, injected } = setup();
    api().onMedia(media());
    const before = injected.length;
    command('pause');
    assert.equal(injected.length, before + 1);

    // The local player takes the card by playing.
    publishNowPlaying('local', {
      title: 'A track', artist: null, source: 'On this device', playing: true,
      artwork: null, position: 0, duration: 100, canNext: false, canPrevious: false, canSave: false,
    });
    command('pause');
    assert.equal(injected.length, before + 1, 'not ours to act on');
  });

  test('seek rounds and clamps before it leaves', () => {
    const { api, injected } = setup();
    api().onMedia(media());
    command('seek', 42.6);
    assert.match(injected.at(-1), /seek\(43\)/);
    assert.deepEqual(native.callsTo('setPageCommand').at(-1), ['seek.43', clock.now]);
    command('seek', -9);
    assert.match(injected.at(-1), /seek\(0\)/);
  });

  test('skip is not offered and is not acted on', () => {
    const { api, injected } = setup();
    api().onMedia(media());
    const before = injected.length;
    command('next');
    command('previous');
    assert.equal(injected.length, before);
  });

  test('save does not touch playback', () => {
    // The user asked for a copy of what they are hearing, not for it to stop
    // while they get one.
    const { api, injected, saved } = setup();
    api().onMedia(media());
    const before = injected.length;
    command('save');
    assert.deepEqual(saved, [{ id: 'dQw4w9WgXcQ', title: 'A song', artist: 'Someone' }]);
    assert.equal(injected.length, before);
  });

  test('save asks the library again at the moment of the tap', () => {
    // The card is a picture of how things were when it was last painted; a
    // second tap could otherwise start the same download twice.
    let owned = false;
    const { api, saved } = setup({ canSave: () => !owned });
    api().onMedia(media());
    command('save');
    owned = true;
    command('save');
    assert.equal(saved.length, 1);
  });

  test('stop leaves no card and no bar waiting on the tab', () => {
    const { api } = setup();
    api().onMedia(media());
    command('stop');
    assert.equal(stopped(), 1);
    assert.equal(pagePlayback(), null);
  });

  test('a play the page never confirms leaves no card claiming it is playing', async (t) => {
    // Off screen the page is a hidden document and may not start media without
    // a gesture — and once refused, its timers are frozen, so the report that
    // would correct the card never arrives. The app is the only party still
    // running, so it is the one that has to check.
    //
    // The correction re-raises the last known state, which the arbiter then
    // drops if the card already agrees — and `PlaybackService.onPlay` is
    // careful never to assume a play worked, so it usually does agree. What has
    // to hold either way is the invariant, not the bridge call.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { api } = setup();
    api().onMedia(media({ playing: true }));
    api().onMedia(media({ playing: false, at: 13 }));

    command('play');
    t.mock.timers.tick(4000);

    assert.equal(cards().at(-1).playing, false);
    assert.equal(
      cards().slice(1).some((card) => card.playing),
      false,
      'nothing after the page stopped ever claimed it was playing',
    );
    t.mock.timers.reset();
  });

  test('the pending check does not outlive the screen', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { api, handle } = setup();
    api().onMedia(media({ playing: false }));
    api().onMedia(media({ playing: true }));
    command('play');
    handle.unmount();
    t.mock.timers.tick(4000);
    t.mock.timers.reset();
  });

  test('a play the page does honour is left alone', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { api } = setup();
    api().onMedia(media({ playing: false }));
    api().onMedia(media({ playing: true }));
    command('play');
    api().onMedia(media({ playing: true, at: 14 }));
    const before = cards().length;
    t.mock.timers.tick(4000);
    assert.equal(cards().length, before, 'nothing to correct');
    t.mock.timers.reset();
  });
});
