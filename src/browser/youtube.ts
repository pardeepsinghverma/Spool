/**
 * YouTube URL parsing and the in-page script that keeps the chrome in sync.
 */

export const HOME_URL = 'https://m.youtube.com';
export const MUSIC_HOME_URL = 'https://music.youtube.com';

export function isMusicUrl(url: string | null | undefined): boolean {
  return /^https?:\/\/music\.youtube\.com(?:[/?#]|$)/i.test(url ?? '');
}

/**
 * Android's stock WebView UA contains "; wv", which Google rejects on its
 * sign-in flows. Presenting as plain Chrome avoids that dead end.
 */
export const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Mobile Safari/537.36';

const VIDEO_ID = '[A-Za-z0-9_-]{11}';

const YOUTUBE_HOST =
  /^https?:\/\/(?:[a-z0-9-]+\.)*(?:youtube\.com|youtu\.be|youtube-nocookie\.com)(?:[/?#]|$)/i;

const ID_PATTERNS = [
  new RegExp('[?&]v=(' + VIDEO_ID + ')(?:[&#]|$)'),
  new RegExp('youtu\\.be/(' + VIDEO_ID + ')(?:[?&#/]|$)'),
  new RegExp('/(?:shorts|embed|live|v)/(' + VIDEO_ID + ')(?:[?&#/]|$)'),
];

export function isYouTube(url: string): boolean {
  return YOUTUBE_HOST.test(url ?? '');
}

/**
 * Pulls the video id out of a watch/shorts/embed/youtu.be URL.
 *
 * Deliberately regex-based rather than URL + searchParams: React Native's URL
 * polyfill does not implement searchParams, so that route fails at runtime.
 */
export function extractVideoId(url: string): string | null {
  if (!url || !isYouTube(url)) return null;
  for (const pattern of ID_PATTERNS) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * The Google hosts that ask for a password.
 *
 * Signing in to YouTube always hands off to `accounts.google.com`, whatever
 * locale the user is in — Google does not run the sign-in flow on a country
 * domain — so an exact list is right rather than merely convenient. The other
 * two are the pages a signed-in user reaches to change a password or manage the
 * account, which show the same fields.
 *
 * Used to raise FLAG_SECURE, so the cost of being wrong is asymmetric: matching
 * one host too many blocks a screenshot the user might have wanted, matching one
 * too few leaves a password field screen-recordable. Err wide.
 */
const SIGN_IN_HOST =
  /^https?:\/\/(?:accounts|myaccount|signin|passwords|id)\.(?:google|youtube)\.com(?:[/?#]|$)/i;

export function isSignInPage(url: string | null | undefined): boolean {
  return SIGN_IN_HOST.test(url ?? '');
}

export function hostOf(url: string): string {
  const match = (url ?? '').match(/^[a-z]+:\/\/([^/?#]+)/i);
  return match ? match[1].replace(/^www\./, '') : url ?? '';
}

export type NavMessage = {
  type: 'nav';
  url: string;
  title: string;
  /** Derived from the page's own background luminance. */
  theme: 'dark' | 'light';
  reason: string;
};

export type FullscreenMessage = {
  type: 'fullscreen';
  isFullscreen: boolean;
  orientation: 'landscape' | 'portrait';
};

export type BarScrollMessage = {
  type: 'barScroll';
  hidden: boolean;
};

/**
 * Injected into the page to report navigation back to the app.
 *
 * YouTube is a single-page app: pushState/replaceState change the route without
 * triggering a page load, so the WebView's own onNavigationStateChange misses
 * most in-app navigation and the download button goes stale. We patch the
 * history methods, listen for YouTube's own navigation event, watch <title>
 * (which lands after the route change), and keep a slow poll as a safety net.
 */
export const NAV_SCRIPT = `
(function () {
  // Never run or hook on Google authentication and account management pages
  if (/(?:accounts|myaccount|signin|passwords|id)\.(?:google|youtube)\.com/i.test(location.hostname)) return;
  if (window.__dlNavHooked) return;
  window.__dlNavHooked = true;

  // Disarm beforeunload prompt so mode switching or navigating away is seamless
  try {
    window.addEventListener('beforeunload', function (e) {
      delete e.returnValue;
    }, true);
    Object.defineProperty(window, 'onbeforeunload', {
      get: function () { return null; },
      set: function () {},
      configurable: true
    });
  } catch (e) {}

  var last = '';

  // The bar borrows the page's own surface values, so it has to know which
  // theme the page is currently rendering.
  // A fully transparent background tells us nothing, so walk up until we find
  // a painted one. Treating rgba(0,0,0,0) as black reads every page as dark.
  function luminanceOf(el) {
    try {
      if (!el) return null;
      var c = getComputedStyle(el).backgroundColor || '';
      var m = c.match(/rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,\\s\\/]+([\\d.]+))?/i);
      if (!m) return null;
      var alpha = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (!alpha) return null;
      return 0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3];
    } catch (e) {
      return null;
    }
  }

  function pageTheme() {
    var lum = luminanceOf(document.body);
    if (lum === null) lum = luminanceOf(document.documentElement);
    if (lum === null) lum = 255; // browsers paint white when nothing is set
    return lum < 128 ? 'dark' : 'light';
  }

  function report(reason) {
    try {
      var payload = JSON.stringify({
        type: 'nav',
        url: location.href,
        title: (document.title || '').replace(/\\s*-\\s*YouTube(?:\\s*Music)?\\s*$/i, '').trim(),
        theme: pageTheme(),
        reason: reason
      });
      if (payload === last) return;
      last = payload;
      window.ReactNativeWebView.postMessage(payload);
    } catch (e) {}
  }

  var lastFs = '';
  function postFs(isFs, orient) {
    var key = isFs ? ('1:' + orient) : '0';
    if (key === lastFs) return;
    lastFs = key;
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'fullscreen',
        isFullscreen: isFs,
        orientation: orient
      }));
    } catch (e) {}
  }

  function reportFullscreen() {
    try {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      var v = (fsEl && fsEl.querySelector ? fsEl.querySelector('video') : null) || document.querySelector('video');
      var isVideoFs = !!(v && (v.webkitDisplayingFullscreen || v.displayingFullscreen));
      var player = document.querySelector('.html5-video-player, #movie_player, #player-control-overlay');
      var isPlayerFs = !!(player && (player.classList.contains('ytp-fullscreen') || player.classList.contains('fullscreen') || player.classList.contains('player-fullscreen')));
      var isFs = !!fsEl || isVideoFs || isPlayerFs;
      var orient = 'landscape';
      if (isFs && v && v.videoWidth && v.videoHeight && v.videoHeight > v.videoWidth) {
        orient = 'portrait';
      }
      postFs(isFs, orient);
    } catch (e) {}
  }

  if (window.screen && window.screen.orientation) {
    var origLock = window.screen.orientation.lock;
    window.screen.orientation.lock = function (orient) {
      var target = (typeof orient === 'string' && orient.indexOf('portrait') !== -1) ? 'portrait' : 'landscape';
      postFs(true, target);
      if (typeof origLock === 'function') {
        try { return origLock.call(window.screen.orientation, orient); } catch (e) {}
      }
      return Promise.resolve();
    };
    var origUnlock = window.screen.orientation.unlock;
    window.screen.orientation.unlock = function () {
      postFs(false, 'portrait');
      if (typeof origUnlock === 'function') {
        try { origUnlock.call(window.screen.orientation); } catch (e) {}
      }
    };
  }

  function attachVideoListeners() {
    var videos = document.querySelectorAll('video');
    for (var i = 0; i < videos.length; i++) {
      var vid = videos[i];
      if (!vid._spoolFs) {
        vid._spoolFs = true;
        vid.addEventListener('webkitbeginfullscreen', reportFullscreen);
        vid.addEventListener('webkitendfullscreen', reportFullscreen);
      }
    }
  }

  document.addEventListener('click', function (e) {
    var target = e.target;
    var btn = target && target.closest ? target.closest('button.fullscreen-icon, button.ytp-fullscreen-button, button[aria-label*="ull screen" i], button[aria-label*="ullscreen" i], [data-title-no-tooltip*="ull screen" i]') : null;
    if (btn) {
      setTimeout(reportFullscreen, 50);
      setTimeout(reportFullscreen, 300);
      setTimeout(reportFullscreen, 800);
    }
  }, true);

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      report(name);
      return result;
    };
  });

  // Scroll detection for auto-hiding the bottom navigation bar
  var lastScrollY = 0;
  var scrollTicking = false;
  function handleScroll(e) {
    if (!scrollTicking) {
      window.requestAnimationFrame(function () {
        var target = (e && e.target && e.target.scrollTop !== undefined) ? e.target : (document.scrollingElement || document.body);
        var currentY = window.scrollY || (target && target.scrollTop) || (document.documentElement && document.documentElement.scrollTop) || 0;
        var diff = currentY - lastScrollY;
        if (Math.abs(diff) > 15) {
          var shouldHide = diff > 0 && currentY > 50;
          try {
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: 'barScroll',
              hidden: shouldHide
            }));
          } catch (err) {}
          lastScrollY = currentY;
        }
        scrollTicking = false;
      });
      scrollTicking = true;
    }
  }

  window.addEventListener('scroll', handleScroll, { passive: true, capture: true });

  function showBottomBar() {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'barScroll',
        hidden: false
      }));
    } catch (e) {}
  }

  window.addEventListener('popstate', function () { report('popstate'); showBottomBar(); });
  window.addEventListener('yt-navigate-finish', function () { report('yt-navigate'); showBottomBar(); });
  window.addEventListener('ytmusic-navigate-finish', function () { report('ytmusic-navigate'); showBottomBar(); });
  document.addEventListener('fullscreenchange', reportFullscreen);
  document.addEventListener('webkitfullscreenchange', reportFullscreen);

  var titleEl = document.querySelector('title');
  if (titleEl && window.MutationObserver) {
    new MutationObserver(function () { report('title'); }).observe(titleEl, {
      childList: true, subtree: true, characterData: true
    });
  }

  setInterval(function () {
    report('poll');
    attachVideoListeners();
    reportFullscreen();
  }, 1000);

  attachVideoListeners();
  report('init');
  reportFullscreen();
})();
true;
`;
