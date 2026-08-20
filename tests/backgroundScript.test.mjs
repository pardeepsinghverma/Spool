import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BACKGROUND_SCRIPT, mediaCommand, seekCommand, setPageBackgrounded } from '../src/browser/background.ts';
import { createPage, FakeVideo } from './harness/dom.mjs';

/**
 * The page half of background playback, executed rather than read.
 *
 * This script never runs in the app process, which is why every bug it has had
 * shipped: there was no way to see it work except on a phone, off screen, with
 * the log scrolling past. Here it runs in a `vm` against a DOM that models the
 * three browser behaviours the whole design turns on — a hidden document
 * refusing to start media, `play()` reading back as unpaused before it has been
 * allowed, and autoplay swapping the <video> element between tracks.
 *
 * The cases below are, deliberately, the ones the comments in that file say
 * were measured breaking on a real device.
 */

function install(options = {}) {
  const page = createPage(options);
  page.run(BACKGROUND_SCRIPT);
  return page;
}

/** A video the user chose: unmuted, playing, and announced by a play event. */
function playing(page, over = {}) {
  const video = page.addVideo(new FakeVideo({ paused: false, ...over }));
  page.fireOnDocument('play', video);
  return video;
}

const api = (page) => page.window.__spoolMedia;

describe('installing', () => {
  test('reports once, and only once per page', () => {
    const page = install();
    assert.equal(page.messages.length, 1);
    assert.equal(page.last.hasMedia, false);
    assert.equal(page.last.wanted, false);

    page.run(BACKGROUND_SCRIPT);
    assert.equal(page.messages.length, 1, 'a second injection is a no-op');
  });

  test('tells YouTube the page is visible, whatever it actually is', () => {
    // YouTube pauses the moment it believes nobody is looking, and nothing
    // outside the page can talk it out of that.
    const page = install({ hidden: true });
    assert.equal(page.document.hidden, false);
    assert.equal(page.document.visibilityState, 'visible');
  });

  test('swallows the events that announce a change, before YouTube sees them', () => {
    const page = install();
    let reached = false;
    page.window.addEventListener('visibilitychange', () => {
      reached = true;
    });
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    assert.equal(reached, false, 'propagation is stopped in the capture phase');
  });
});

describe('what is worth reporting', () => {
  test('a muted preview clip is not playing', () => {
    // The home feed autoplays muted previews and every one fires the same
    // events as the video the user chose.
    const page = install();
    const video = page.addVideo(new FakeVideo({ paused: false, muted: true }));
    page.fireOnDocument('play', video);
    page.tick();
    assert.equal(page.last.playing, false);
    assert.equal(page.last.hasMedia, false, 'a muted element is not the page\'s media');
  });

  test('and is never resumed off screen', () => {
    const page = install();
    const video = page.addVideo(new FakeVideo({ paused: false, muted: true }));
    page.fireOnDocument('play', video);
    video.paused = true;
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    page.tick(3);
    assert.equal(video.playCalls, 0);
  });

  test('an unmuted video is preferred over a muted one on the same page', () => {
    const page = install();
    page.addVideo(new FakeVideo({ muted: true, paused: false }));
    const real = page.addVideo(new FakeVideo({ paused: false, currentTime: 42 }));
    page.tick();
    assert.equal(page.last.at, 42);
  });

  test('an idle paused page goes quiet instead of talking once a second', () => {
    const page = install();
    page.tick(5);
    assert.equal(page.messages.length, 1);
  });

  test('a playing page reports every tick, because the playhead moves', () => {
    // The tracker counts with these, so suppressing identical-looking ones
    // would stop watch time accruing.
    const page = install();
    const video = playing(page);
    const before = page.messages.length;
    for (let i = 1; i <= 3; i++) {
      video.currentTime = i;
      page.tick();
    }
    assert.equal(page.messages.length, before + 3);
    assert.deepEqual(page.messages.slice(-3).map((m) => m.at), [1, 2, 3]);
  });

  test('reads the id from the page\'s own URL, not from the app', () => {
    // Navigation and media messages arrive on different schedules; attributing
    // watch time to the previous video would quietly corrupt the counts.
    const page = install({ href: 'https://m.youtube.com/watch?v=abcdefghijk' });
    playing(page);
    assert.equal(page.last.id, 'abcdefghijk');

    const shorts = install({ href: 'https://m.youtube.com/shorts/abcdefghijk' });
    playing(shorts);
    assert.equal(shorts.last.id, 'abcdefghijk');

    const feed = install({ href: 'https://m.youtube.com/feed/subscriptions' });
    playing(feed);
    assert.equal(feed.last.id, '', 'watch time on a feed belongs to nothing');
  });

  test('prefers the page\'s own media metadata over the document title', () => {
    const page = install({
      title: 'A song - YouTube',
      metadata: { title: 'Real Title', artist: 'Real Artist' },
    });
    playing(page);
    assert.equal(page.last.title, 'Real Title');
    assert.equal(page.last.artist, 'Real Artist');
    assert.equal(page.last.music, true, 'a mediaSession artist is YouTube saying "track"');
  });

  test('falls back to the title with YouTube\'s suffix removed', () => {
    const page = install({ title: 'A song - YouTube' });
    playing(page);
    assert.equal(page.last.title, 'A song');
    assert.equal(page.last.music, false, 'an uploader is not an artist');
  });

  test('music.youtube.com is music even without a mediaSession artist', () => {
    const page = install({ hostname: 'music.youtube.com' });
    playing(page);
    assert.equal(page.last.music, true);
  });
});

describe('deciding whether a pause was the user', () => {
  test('a pause with a finger behind it is the user, and stays paused', () => {
    const page = install();
    const video = playing(page);

    page.fireOnWindow('touchstart');
    page.advance(100);
    video.paused = true;
    page.fireOnDocument('pause', video);

    assert.equal(video.playCalls, 0, 'not undone');
    assert.equal(page.last.wanted, false, 'and the intent is cleared');

    page.tick(3);
    assert.equal(video.playCalls, 0, 'the watchdog leaves a deliberate pause alone');
  });

  test('a pause with no finger behind it is the system, and is undone at once', () => {
    // Background timers are throttled hard, so this cannot wait for the tick.
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    video.paused = true;
    page.fireOnDocument('pause', video);
    assert.equal(video.playCalls, 1);
  });

  test('a touch long ago is not evidence about this pause', () => {
    // Timing was tried the other way round — "paused soon after backgrounding
    // is Android's doing" — and was measured killing playback within ten
    // seconds, because the suspension does not arrive as one prompt event.
    const page = install();
    const video = playing(page);
    page.fireOnWindow('touchstart');
    page.advance(700);
    video.paused = true;
    page.fireOnDocument('pause', video);
    assert.equal(video.playCalls, 1, 'past the window, so treated as the system');
  });

  test('the system pausing twice in the same moment is undone once', async () => {
    // The pair used to be undone twice, and that is the whole defect. Every
    // resume re-enables the video track, which asks Android for another
    // hardware decoder; a pause answered without a gap comes straight back and
    // the two sides trade play and pause about sixty times a second until the
    // decoder pool is gone and nothing on that page can decode again. Measured
    // on a Galaxy S21 FE: seventeen concurrent AV1 decoders, then NO_MEMORY for
    // the life of the renderer.
    const page = install();
    const video = playing(page);
    for (let i = 0; i < 2; i++) {
      video.paused = true;
      page.fireOnDocument('pause', video);
      await page.settle();
    }
    assert.equal(video.playCalls, 1);
  });

  test('and again a second later, because one twitch is not a verdict', async () => {
    const page = install();
    const video = playing(page);

    video.paused = true;
    page.fireOnDocument('pause', video);
    await page.settle();

    page.advance(1000);
    video.paused = true;
    page.fireOnDocument('pause', video);
    await page.settle();

    assert.equal(video.playCalls, 2);
  });
});

describe('a page that will not stay playing', () => {
  /** Resume, then have the page pause itself straight back, `times` over. */
  async function refuse(page, video, times) {
    for (let i = 0; i < times; i++) {
      page.advance(1000);
      video.paused = true;
      page.fireOnDocument('pause', video);
      await page.settle();
    }
  }

  test('is given up on rather than fought', async () => {
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');

    await refuse(page, video, 6);

    // Three tries, then the watchdog stops buying decoders it cannot use.
    assert.equal(video.playCalls, 3);
  });

  test('and is not fought by the tick either', async () => {
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');

    await refuse(page, video, 4);
    const spent = video.playCalls;

    for (let i = 0; i < 5; i++) {
      page.advance(1000);
      page.tick();
    }
    assert.equal(video.playCalls, spent, 'the interval respects the same budget');
  });

  test('until the page is on screen again', async () => {
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    await refuse(page, video, 4);

    // Back on screen a refused play is not a refused play any more.
    page.state.hidden = false;
    page.advance(1000);
    page.tick();
    await page.settle();

    assert.equal(video.playCalls, 4);
  });

  test('until a finger says otherwise', async () => {
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    await refuse(page, video, 4);
    const spent = video.playCalls;

    page.fireOnWindow('touchstart');
    // Far enough back that the pause is not read as the user's own.
    page.advance(1000);
    video.paused = true;
    page.fireOnDocument('pause', video);
    await page.settle();

    assert.equal(video.playCalls, spent + 1);
  });

  test('until the notification asks out loud', async () => {
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    await refuse(page, video, 4);
    const spent = video.playCalls;

    // An explicit ask is not the watchdog guessing: it is honoured, and it
    // re-arms the watchdog behind it.
    api(page).play();
    assert.equal(video.playCalls, spent + 1, 'the ask itself is never metered');

    page.advance(1000);
    video.paused = true;
    page.fireOnDocument('pause', video);
    await page.settle();
    assert.equal(video.playCalls, spent + 2, 'and the watchdog is armed again');
  });

  test('that refuses to start at all is asked three times, not forever', async () => {
    // A refused play settles with the element still paused and fires no 'pause'
    // event of its own, so it is the one failure the pause handler cannot see.
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    video.allowPlay = false;
    video.paused = true;

    for (let i = 0; i < 6; i++) {
      page.advance(1000);
      page.tick();
      await page.settle();
    }
    assert.equal(video.playCalls, 3);
  });

  test('and playback that survives on its own pays the budget back', async () => {
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.fireOnWindow('visibilitychange');
    await refuse(page, video, 4);
    const spent = video.playCalls;

    // Whatever was holding it down let go: it has been playing for several
    // ticks with no help from us.
    video.paused = false;
    for (let i = 0; i < 4; i++) {
      page.advance(1000);
      page.tick();
    }

    page.advance(1000);
    video.paused = true;
    page.fireOnDocument('pause', video);
    await page.settle();

    assert.equal(video.playCalls, spent + 1);
  });

  test('a pause from an element the page is not using is ignored', () => {
    const page = install();
    const video = playing(page);
    const other = page.addVideo(new FakeVideo({ paused: true }));
    page.fireOnDocument('pause', other);
    assert.equal(page.last.wanted, true);
    assert.equal(other.playCalls, 0);
  });

  test('a keypress counts as a finger, so keyboard pause is deliberate', () => {
    const page = install();
    const video = playing(page);
    page.fireOnWindow('keydown');
    video.paused = true;
    page.fireOnDocument('pause', video);
    assert.equal(video.playCalls, 0);
  });
});

describe('a track ending', () => {
  test('does not clear the intent to keep playing', () => {
    // A hidden page is exactly where autoplay is blocked, and clearing the flag
    // there left the watchdog with nothing to act on — the queue died silently
    // at a track boundary.
    const page = install();
    const video = playing(page);
    video.ended = true;
    video.paused = true;
    page.fireOnDocument('ended', video);
    assert.equal(page.last.wanted, true);
  });

  test('and the finished video is not replayed', () => {
    const page = install();
    const video = playing(page);
    video.ended = true;
    video.paused = true;
    page.fireOnDocument('ended', video);
    page.tick(3);
    assert.equal(video.playCalls, 0, 'resume() refuses an element that has ended');
  });

  test('so the next element autoplay swaps in is armed', () => {
    const page = install();
    const first = playing(page);
    first.ended = true;
    first.paused = true;
    page.fireOnDocument('ended', first);
    page.removeVideo(first);

    const next = page.addVideo(new FakeVideo({ paused: true }));
    page.tick();
    assert.equal(next.playCalls, 1);
  });

  test('the app is told the page still wants to play while it has no media', () => {
    // `hasMedia: false` alone must never drop the foreground service: between
    // two tracks the page honestly has none, and restarting a foreground
    // service from the background is refused outright by Android 12+.
    const page = install();
    const video = playing(page);
    video.ended = true;
    page.fireOnDocument('ended', video);
    page.removeVideo(video);
    page.tick();
    assert.equal(page.last.hasMedia, false);
    assert.equal(page.last.wanted, true);
  });

  test('and told it has given up once the user actually stops', () => {
    const page = install();
    const video = playing(page);
    page.fireOnWindow('touchstart');
    video.paused = true;
    page.fireOnDocument('pause', video);
    page.removeVideo(video);
    page.tick();
    assert.equal(page.last.hasMedia, false);
    assert.equal(page.last.wanted, false);
  });
});

describe('a play that may not be allowed', () => {
  test('says nothing at all until the browser has answered', async () => {
    // A <video> reads back as unpaused the instant play() is called. Reporting
    // in between reports a request as a fact.
    const page = install();
    const video = playing(page);
    video.paused = true;
    page.fireOnWindow('touchstart');
    page.fireOnDocument('pause', video);

    const before = page.messages.length;
    api(page).play();
    assert.equal(page.messages.length, before, 'no claim while the play is in flight');
    assert.equal(video.paused, false, 'even though the element already says otherwise');

    await page.settle();
    assert.equal(page.last.playing, true);
  });

  test('a refused play is reported as not playing, not as playing', async () => {
    // Measured: the card sat on PLAYING over silence for thirty seconds,
    // offering a pause button for something that was not going.
    const page = install({ hidden: true });
    const video = page.addVideo(new FakeVideo({ paused: true, allowPlay: false }));

    api(page).play();
    await page.settle();

    assert.equal(video.paused, true);
    assert.equal(page.last.playing, false);
    assert.ok(
      !page.messages.some((m) => m.playing),
      'no message ever claimed it was playing',
    );
  });

  test('sound coming out beats any promise that has not settled', () => {
    const page = install();
    const video = page.addVideo(new FakeVideo({ paused: true }));
    api(page).play();
    video.paused = false;
    page.fireOnDocument('play', video);
    assert.equal(page.last.playing, true);
  });
});

describe('commands from the notification', () => {
  test('pause stops the page and clears the intent', () => {
    const page = install();
    const video = playing(page);
    api(page).pause();
    assert.equal(video.pauseCalls, 1);
    assert.equal(page.last.wanted, false);
    page.tick(3);
    assert.equal(video.playCalls, 0, 'and the watchdog does not undo it');
  });

  test('seek moves the playhead and refuses nonsense', () => {
    const page = install();
    const video = playing(page);
    api(page).seek(90);
    assert.equal(video.currentTime, 90);
    api(page).seek(-5);
    assert.equal(video.currentTime, 0, 'clamped rather than rejected');
    api(page).seek(NaN);
    assert.equal(video.currentTime, 0);
    api(page).seek(Infinity);
    assert.equal(video.currentTime, 0);
  });

  test('stop is pause — there is no verb that unmakes a watch page', () => {
    const page = install();
    const video = playing(page);
    api(page).stop();
    assert.equal(video.pauseCalls, 1);
    assert.equal(page.last.wanted, false);
  });
});

describe('the cookie channel', () => {
  // injectJavaScript cannot reach a backgrounded WebView — react-native-webview
  // posts it as a view command, flushed on a frame an invisible window never
  // gets. The page's own timer reads a cookie instead.

  test('a command left over from an earlier session is not obeyed', () => {
    const page = install({ cookie: 'spool_cmd=pause.111' });
    const video = playing(page);
    page.tick();
    assert.equal(video.pauseCalls, 0);
    assert.equal(page.last.wanted, true);
  });

  test('a fresh command is obeyed on the next tick', () => {
    const page = install();
    const video = playing(page);
    page.document.cookie = 'spool_cmd=pause.222';
    page.tick();
    assert.equal(video.pauseCalls, 1);
  });

  test('the same command sitting in the jar is not obeyed twice', () => {
    const page = install();
    const video = playing(page);
    page.document.cookie = 'spool_cmd=pause.222';
    page.tick();
    video.paused = false;
    page.tick(3);
    assert.equal(video.pauseCalls, 1);
  });

  test('a repeat of the same verb with a new stamp is', () => {
    // The stamp is what distinguishes a second tap from the first one still
    // sitting in the jar.
    const page = install();
    const video = playing(page);
    page.document.cookie = 'spool_cmd=pause.222';
    page.tick();
    video.paused = false;
    page.document.cookie = 'spool_cmd=pause.333';
    page.tick();
    assert.equal(video.pauseCalls, 2);
  });

  test('a seek arrives as three dot-separated parts', () => {
    // Dots throughout because a cookie value may carry no comma, semicolon or
    // space, and the seconds are rounded so no part can contain one.
    const page = install();
    const video = playing(page);
    page.document.cookie = 'spool_cmd=seek.90.444';
    page.tick();
    assert.equal(video.currentTime, 90);
  });

  test('a pause is applied before the watchdog gets a chance to undo it', () => {
    // Ordering inside the tick is load-bearing: applyCommand runs first so a
    // pause the user has just asked for clears the intent before resume() sees
    // it.
    const page = install();
    const video = playing(page);
    page.state.hidden = true;
    page.document.cookie = 'spool_cmd=pause.555';
    page.tick();
    assert.equal(video.pauseCalls, 1);
    assert.equal(video.playCalls, 0);
  });

  test('play from the cookie arms the watchdog for whatever comes next', () => {
    const page = install();
    const video = page.addVideo(new FakeVideo({ paused: true }));
    page.document.cookie = 'spool_cmd=play.666';
    page.tick();
    assert.equal(video.playCalls, 1);
    assert.equal(page.window.__spoolMedia !== undefined, true);
  });

  test('other cookies on the page are not commands', () => {
    const page = install({ cookie: 'VISITOR_INFO1_LIVE=abc; PREF=f6=400' });
    const video = playing(page);
    page.tick(3);
    assert.equal(video.pauseCalls, 0);
  });
});

describe('the command strings the app sends', () => {
  test('are guarded so an un-injected page is not a crash', () => {
    assert.match(mediaCommand('play'), /window\.__spoolMedia &&/);
    assert.match(seekCommand(12.7), /seek\(13\)/);
    assert.match(seekCommand(-4), /seek\(0\)/);
    assert.match(setPageBackgrounded(true), /setBackground\(true\)/);
  });

  test('reach the page when it is on screen', () => {
    const page = install();
    const video = playing(page);
    page.eval(mediaCommand('pause'));
    assert.equal(video.pauseCalls, 1);
    page.eval(seekCommand(42));
    assert.equal(video.currentTime, 42);
  });
});
