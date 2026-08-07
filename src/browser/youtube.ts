/**
 * YouTube URL parsing and the in-page script that keeps the chrome in sync.
 */

export const HOME_URL = 'https://m.youtube.com';

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
  if (window.__dlNavHooked) return;
  window.__dlNavHooked = true;

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
        title: (document.title || '').replace(/\\s*-\\s*YouTube\\s*$/, '').trim(),
        theme: pageTheme(),
        reason: reason
      });
      if (payload === last) return;
      last = payload;
      window.ReactNativeWebView.postMessage(payload);
    } catch (e) {}
  }

  ['pushState', 'replaceState'].forEach(function (name) {
    var original = history[name];
    if (typeof original !== 'function') return;
    history[name] = function () {
      var result = original.apply(this, arguments);
      report(name);
      return result;
    };
  });

  window.addEventListener('popstate', function () { report('popstate'); });
  window.addEventListener('yt-navigate-finish', function () { report('yt-navigate'); });

  var titleEl = document.querySelector('title');
  if (titleEl && window.MutationObserver) {
    new MutationObserver(function () { report('title'); }).observe(titleEl, {
      childList: true, subtree: true, characterData: true
    });
  }

  setInterval(function () { report('poll'); }, 1000);

  report('init');
})();
true;
`;
