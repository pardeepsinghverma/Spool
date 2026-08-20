/**
 * Background playback for the browser.
 *
 * Leaving the app breaks WebView video in two independent places, and only one
 * of them is the system's. Android freezing the process and sleeping the CPU is
 * answered natively, by PlaybackService. This file answers the other half:
 * the page stopping itself.
 *
 * YouTube's player watches the Page Visibility API and pauses the moment it
 * believes nobody is looking. Nothing outside the page can talk it out of that,
 * so the page is told it is still visible — the flag is frozen, and the events
 * that announce a change are swallowed before any of YouTube's own listeners
 * see them. A watchdog covers what slips through.
 *
 * This has to be injected *before* page scripts run, or YouTube's listener is
 * already registered ahead of ours and blocking it comes too late.
 */

export type MediaMessage = {
  type: 'media';
  /** True while a video element exists on the page, playing or not. */
  hasMedia: boolean;
  playing: boolean;
  title: string;
  artist: string;
  /**
   * The page called this a track, not merely a video — either YouTube set a
   * real mediaSession artist or this is music.youtube.com. It is the only
   * evidence available for the "Match" keep-as rule.
   */
  music: boolean;
  /**
   * The watch page's video id, read from the page's own URL rather than taken
   * from React state. Navigation messages and media messages arrive on
   * different schedules, and attributing watch time to the previous video
   * because the URL had not landed yet would quietly corrupt the counts.
   */
  id: string;
  /** Playhead and length in seconds — the raw material for watch time. */
  at: number;
  length: number;
  /**
   * The page still means to be playing, even if nothing is at this instant.
   * True across a track change; false only once the user has actually stopped.
   */
  wanted: boolean;
};

export const BACKGROUND_SCRIPT = `
(function () {
  if (window.__spoolMedia) return;

  var wanted = false;      // what the user last asked for, not what is happening
  var background = false;  // the app is off screen, so self-pauses are suspect
  var current = null;      // the <video> the page is using right now
  var last = '';
  var touchedAt = 0;       // when the user last actually touched the page

  /**
   * The watchdog's budget, and why an unmetered one is not merely wasteful.
   *
   * Measured on a Galaxy S21 FE (Android 16, WebView 150). The screen goes off,
   * Chromium hides the page and releases its video decoder, and the element
   * pauses. Resuming re-enables the video track, which asks Android for a fresh
   * 1920x1072 AV1 hardware decoder — and about 140ms later the element pauses
   * again. The pause handler answered that immediately and unconditionally, so
   * the two sides traded pause and play roughly sixty times a second.
   *
   * Each round asked for another decoder. They were created about seven times
   * faster than they were released, and at seventeen concurrent instances the
   * hardware pool was gone:
   *
   *   E/MediaCodec  Codec reported err 0xfffffff4/NO_MEMORY, while in state 5/STARTING
   *   I/ResourceManagerService  reclaimResource: There aren't any clients to reclaim from
   *
   * There is no coming back from that within the page: nothing can decode for
   * the life of that renderer. Audio died after about twenty seconds, the
   * create/release loop ran on at ten a second until Android killed the
   * renderer, and the user returned to a video stuck on "loading" over a buffer
   * that was already full. Starting a track and leaving within a couple of
   * seconds looked fine only because YouTube had not yet upgraded to the stream
   * that needs that decoder.
   *
   * So a resume costs something, and the watchdog pays for it: at most one a
   * second, and it stops asking after a few in a row have failed. Three
   * decoders spread over three seconds is nowhere near the pool.
   */
  var RESUME_GAP_MS = 1000;
  var RESUME_LIMIT = 3;
  var resumedAt = 0;       // when the watchdog last asked for a play
  var failures = 0;        // consecutive resumes that did not survive

  // The real visibility, captured before it is frozen. Without this the page
  // has no way of knowing it has been backgrounded — we lie to YouTube about
  // it, and the lie is convincing enough to fool us too.
  var playPending = false;  // a play() has been asked for and has not settled
  var trueHidden = null;
  try {
    trueHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  } catch (e) {}

  function reallyHidden() {
    try {
      return !!(trueHidden && trueHidden.get && trueHidden.get.call(document));
    } catch (e) {
      return false;
    }
  }

  // Frozen rather than merely lied to once: YouTube re-reads these on every
  // check, so a stale value would only survive until the next one.
  function freeze(name, value) {
    try {
      Object.defineProperty(document, name, {
        configurable: true,
        get: function () { return value; }
      });
    } catch (e) {}
  }

  freeze('hidden', false);
  freeze('webkitHidden', false);
  freeze('visibilityState', 'visible');
  freeze('webkitVisibilityState', 'visible');

  // Capture on window runs ahead of anything the page attached to document,
  // including an onvisibilitychange property, so stopping propagation here
  // means YouTube's pause handler is never reached.
  //
  // 'pagehide' and 'freeze' are in the list for the same reason: both are the
  // page being told to wind down, and both are wrong once the point is to keep
  // playing. 'blur' is deliberately absent — the page needs it for focus, and
  // it is not what YouTube pauses on.
  ['visibilitychange', 'webkitvisibilitychange', 'pagehide', 'freeze'].forEach(
    function (name) {
      window.addEventListener(name, function (e) {
        // We are first in the capture phase, so this is the one place the true
        // state can still be read before the event is destroyed. Waiting for
        // the app to tell us instead loses a race we cannot afford: Android
        // pauses the media before an injectJavaScript round trip can land, and
        // by then the pause has already been mistaken for the user's own.
        background = reallyHidden() || name === 'pagehide' || name === 'freeze';
        e.stopImmediatePropagation();
        if (background) resume();
      }, true);
    }
  );

  // The only evidence available that a pause was the user's doing. A pause with
  // no touch behind it came from the page or the system, and those are exactly
  // the ones worth undoing.
  ['touchstart', 'pointerdown', 'mousedown', 'keydown'].forEach(function (name) {
    window.addEventListener(name, function () {
      touchedAt = Date.now();
      // A finger on the screen is a new situation. Whatever the watchdog gave
      // up on happened to a page nobody was looking at.
      failures = 0;
    }, true);
  });

  // The home feed autoplays muted preview clips, and every one of them fires
  // the same events as the video the user actually chose. Muted is the line
  // between the two: nothing silent is worth a notification, a wake lock, or
  // being resumed off screen.
  function watched(el) {
    return !!el && el.tagName === 'VIDEO' && !el.muted;
  }

  /**
   * Ask an element to play, and say nothing until the answer is in.
   *
   * A <video> reads back as unpaused the *instant* play() is called, long
   * before the browser has decided whether to allow it — so any report taken in
   * between reports a request as a fact. That is survivable on screen and a lie
   * off it: a hidden document may not start media without a user gesture, and
   * once the play is refused the page's timers are frozen, so no later report
   * arrives to correct the notification. Measured twice — once refused
   * outright, once allowed for fourteen seconds and then suspended — and both
   * times the card sat on PLAYING over silence, offering a pause button for
   * something that was not going.
   */
  function attempt(el) {
    var p;
    try {
      p = el.play();
    } catch (e) {
      return;
    }
    if (!p || !p.then) return;
    playPending = true;
    p.then(settle, settle);
  }

  function settle() {
    playPending = false;
    // Settled and still paused means the play was refused outright, which off
    // screen is the ordinary answer. It has to count too: a refusal fires no
    // 'pause' event, so without this the watchdog would ask once a second for
    // as long as the app stayed backgrounded.
    var v = video();
    if (v && v.paused) failures++;
    report();
  }

  // Media events do not bubble, but capture still walks down through document,
  // so one listener here covers whichever <video> the page swaps in.
  document.addEventListener('play', function (e) {
    if (!watched(e.target)) return;
    // A different element is a different track, and the budget the watchdog
    // spent on the last one says nothing about this one.
    if (e.target !== current) failures = 0;
    current = e.target;
    wanted = true;
    // Sound is coming out, whatever a promise has yet to say about it.
    playPending = false;
    report();
  }, true);

  document.addEventListener('pause', function (e) {
    if (e.target !== current) return;

    // Intent is decided by whether a finger was involved, not by whether the
    // app had got round to telling us it was leaving. The old test asked only
    // about the background flag, which is set from a message that arrives
    // after Android has already paused the media — so every backgrounded pause
    // was read as deliberate, the wanted flag went false, and the watchdog then
    // had nothing to restore. Silence, every time the user left the app.
    // A touch is the only reliable evidence of intent available here.
    //
    // Timing is not: an attempt to treat "paused soon after backgrounding" as
    // Android's doing and anything later as the user's was measured breaking
    // playback within ten seconds, because the system's suspension does not
    // arrive as one prompt event — it can come late, and more than once.
    var byHand = Date.now() - touchedAt < 700;

    if (byHand) {
      wanted = false;
      failures = 0;
    } else {
      // A pause arriving on the heels of our own resume *is* that resume
      // failing — the play was allowed, sound came out for a moment, and
      // whatever paused it the first time paused it again. Counting it is the
      // only way the watchdog can tell "the system twitched once" from "this
      // page cannot be made to play right now", and the second one has to end
      // in giving up rather than in trying harder.
      if (Date.now() - resumedAt < RESUME_GAP_MS * 2) failures++;
      // Undo it here rather than waiting for the interval: background timers
      // are throttled hard, and a second of silence is a second too many.
      resume();
    }
    report();
  }, true);

  document.addEventListener('ended', function (e) {
    if (e.target !== current) return;

    // Deliberately does NOT clear 'wanted'. A video ending is not the user
    // asking for silence — on a Mix or a playlist it is the moment autoplay is
    // supposed to take over, and that is exactly when the app is most likely to
    // be off screen with the phone in a pocket.
    //
    // Clearing it here worked only by luck: YouTube's own autoplay fires a
    // 'play' event which re-arms the flag. When autoplay is blocked or slow —
    // and a hidden page is where browsers block it — the intent was already
    // gone and the watchdog had nothing to act on, so the queue died silently
    // at a track boundary.
    //
    // Keeping it cannot replay the finished video: resume() refuses an element
    // that has ended. It only arms the next one.
    report();
  }, true);

  function video() {
    if (current && current.isConnected) return current;
    var all = document.querySelectorAll('video');
    for (var i = 0; i < all.length; i++) {
      if (watched(all[i])) {
        current = all[i];
        return current;
      }
    }
    current = null;
    return null;
  }

  function meta() {
    var m = null;
    try {
      m = navigator.mediaSession && navigator.mediaSession.metadata;
    } catch (e) {}

    // The page's own media metadata is the accurate answer; <title> is what is
    // left when YouTube has not set one yet.
    var title = (m && m.title) || (document.title || '').replace(/\\s*-\\s*YouTube\\s*$/, '');
    var artist = (m && m.artist) || '';

    // A real mediaSession artist is YouTube saying "this is a track", not just
    // "this has an uploader". That distinction is the only evidence the page
    // offers about music, so it is kept apart from the channel-name fallback
    // used for display — otherwise every video would look like music.
    var music = !!artist || location.hostname === 'music.youtube.com';

    if (!artist) {
      var owner = document.querySelector(
        'ytm-slim-owner-renderer a, ytm-channel-name a, #owner-name a, ytd-channel-name a'
      );
      artist = (owner && owner.textContent) || '';
    }
    return { title: (title || '').trim(), artist: artist.trim(), music: music };
  }

  // Both watch shapes YouTube serves. Anything else — a feed, a channel, a
  // search — has no id, and watch time there belongs to nothing.
  function videoId() {
    try {
      var m = location.href.match(/[?&]v=([A-Za-z0-9_-]{11})/)
        || location.href.match(/\\/shorts\\/([A-Za-z0-9_-]{11})/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  function report() {
    // A play is in flight and the element already claims to be unpaused, so
    // there is nothing truthful to say yet. settle() reports when there is.
    if (playPending) return;
    try {
      var v = video();
      var m = meta();
      var playing = !!v && !v.paused && !v.ended && !v.muted;
      var payload = JSON.stringify({
        type: 'media',
        hasMedia: !!v,
        playing: playing,
        title: m.title,
        artist: m.artist,
        music: m.music,
        id: videoId(),
        at: v && isFinite(v.currentTime) ? v.currentTime : 0,
        length: v && isFinite(v.duration) ? v.duration : 0,
        // What the page still intends, as opposed to what is happening right
        // now. The app needs this to tell "the user stopped" apart from "we are
        // between two videos", which look identical from the outside.
        wanted: wanted
      });
      // The playhead moves every tick, so the old identical-payload guard would
      // never fire again. Suppressing only the paused-and-unchanged case keeps
      // an idle page quiet while still delivering one message per second of
      // actual playback, which is what the tracker counts with.
      if (!playing && payload === last) return;
      last = payload;
      window.ReactNativeWebView.postMessage(payload);
    } catch (e) {}
  }

  // Belt and braces for whatever the visibility block misses — a codec the
  // system suspends, an audio-focus loss, a YouTube build that pauses by some
  // route we did not anticipate. It only ever acts on a pause the user did not
  // ask for, so a genuine pause from the lock screen stays paused.
  // Deliberately no longer conditioned on the background flag. That flag is set
  // from a message that loses the race against Android's own pause, so gating
  // on it meant the watchdog stood down at precisely the moment it was needed.
  // The honest condition is simply: the user wanted this playing, it is not
  // playing, and they did not stop it themselves.
  function resume() {
    if (!wanted) return;
    // Spent. Something is holding this page down and asking again only costs a
    // hardware decoder — see RESUME_LIMIT. A touch, a command, the page coming
    // back on screen or playback surviving on its own all restore the budget.
    if (failures >= RESUME_LIMIT) return;
    var v = video();
    if (!v || v.ended || !v.paused) return;
    if (Date.now() - resumedAt < RESUME_GAP_MS) return;
    resumedAt = Date.now();
    attempt(v);
  }

  function doPlay() {
    wanted = true;
    // Someone asked out loud — from the notification, the lock screen or the
    // mini bar. That is not the watchdog guessing, so it is neither metered nor
    // counted against it, and it re-arms the watchdog behind it.
    failures = 0;
    resumedAt = Date.now();
    var v = video();
    if (v) attempt(v);
    report();
  }

  function doPause() {
    wanted = false;
    var v = video();
    if (v) { try { v.pause(); } catch (e) {} }
    report();
  }

  function doSeek(seconds) {
    var v = video();
    if (!v || !isFinite(seconds)) return;
    try { v.currentTime = Math.max(0, seconds); } catch (e) {}
    report();
  }

  // The one channel the app can use while it is off screen.
  //
  // injectJavaScript cannot reach a backgrounded WebView: react-native-webview
  // sends it as a view command, and those are flushed on a Choreographer frame
  // that an invisible window never gets — so it lands, retroactively, whenever
  // the app is next opened. This page's own timer keeps running, so it reads
  // the verb out of a cookie instead. See setPageCommand on the native module.
  function readCommand() {
    try {
      var m = document.cookie.match(/(?:^|;\\s*)spool_cmd=([^;]+)/);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  // Seeded now, so a cookie left over from an earlier session is not read as a
  // fresh instruction the moment a page loads.
  var lastCommand = readCommand();

  // "<verb>.<stamp>", or "seek.<seconds>.<stamp>" — dots throughout because a
  // cookie value may not carry a comma, a semicolon or a space, and the
  // seconds are rounded so none of the three parts can contain one either.
  function applyCommand() {
    var token = readCommand();
    if (!token || token === lastCommand) return;
    lastCommand = token;
    var parts = token.split('.');
    if (parts[0] === 'play') doPlay();
    else if (parts[0] === 'pause' || parts[0] === 'stop') doPause();
    else if (parts[0] === 'seek') doSeek(parseFloat(parts[1]));
  }

  setInterval(function () {
    background = reallyHidden();

    // Two ways the budget comes back without anyone touching anything: the page
    // is on screen again, where a refused play is not a refused play any more;
    // or playback has held on its own for long enough that the last thing the
    // watchdog did clearly worked.
    if (!background) failures = 0;
    else {
      var live = video();
      if (live && !live.paused && Date.now() - resumedAt > RESUME_GAP_MS * 3) {
        failures = 0;
      }
    }

    // Before the watchdog, deliberately: a pause the user has just asked for
    // must clear 'wanted' before resume() has a chance to undo it.
    applyCommand();
    resume();
    report();
  }, 1000);

  window.__spoolMedia = {
    play: doPlay,
    pause: doPause,
    stop: doPause,
    seek: doSeek,
    setBackground: function (value) {
      background = !!value;
      if (background) resume();
    }
  };

  report();
})();
true;
`;

/** Commands the notification and lock screen can send back into the page. */
export const mediaCommand = (name: 'play' | 'pause' | 'stop') =>
  `window.__spoolMedia && window.__spoolMedia.${name}(); true;`;

/** The scrubber, which the card offers for a page as much as for a file. */
export const seekCommand = (seconds: number) =>
  `window.__spoolMedia && window.__spoolMedia.seek(${Math.max(0, Math.round(seconds))}); true;`;

export const setPageBackgrounded = (value: boolean) =>
  `window.__spoolMedia && window.__spoolMedia.setBackground(${value}); true;`;
