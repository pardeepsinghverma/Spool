/**
 * Content blocking.
 *
 * Three layers, because YouTube's ads are not one thing:
 *
 *  1. Player-response stripping — pre-roll and mid-roll are described in the
 *     InnerTube player response, not fetched from a blockable ad host. Delete
 *     those fields before YouTube's own JS reads them and the player never
 *     learns there was an ad to play. This is the layer that matters.
 *  2. Cosmetic filtering — feed promos, mastheads, companion slots. DOM only.
 *  3. Skip fallback — if an ad slips through anyway, skip or seek past it.
 *
 * Layers 1 and 3 must be installed before the page's own scripts run, so this
 * is injected via injectedJavaScriptBeforeContentLoaded.
 *
 * Known limits, worth being honest about:
 *  - Server-side stitched ads (SSAI) are part of the video stream itself and
 *    survive all of this.
 *  - YouTube ships anti-adblock detection periodically. This is an arms race on
 *    the same treadmill as extraction, and breaks for the same reasons.
 *  - True Brave parity needs network-level blocking via a native
 *    shouldInterceptRequest hook, which this does not attempt.
 */

const COSMETIC_SELECTORS = [
  'ytm-promoted-sparkles-web-renderer',
  'ytm-promoted-sparkles-text-search-renderer',
  'ytm-promoted-video-renderer',
  'ytm-compact-promoted-video-renderer',
  'ytm-companion-slot',
  'ytm-carousel-ad-renderer',
  'ytm-statement-banner-renderer',
  'ytm-shorts-ad-renderer',
  'ytm-inline-survey-renderer',
  'ad-slot-renderer',
  'ytd-promoted-sparkles-web-renderer',
  'ytd-display-ad-renderer',
  '#player-ads',
  '#masthead-ad',
  '.video-ads',
  '.ytp-ad-module',
  '.ytp-ad-overlay-container',
  '.ytp-ad-image-overlay',
].join(',');

export const ADBLOCK_SCRIPT = `
(function () {
  if (window.__dlBlockInstalled) return;
  window.__dlBlockInstalled = true;

  var AD_KEYS = [
    'adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams',
    'importantForAds', 'adParams'
  ];

  function scrub(node, depth) {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) scrub(node[i], depth + 1);
      return;
    }
    for (var k = 0; k < AD_KEYS.length; k++) {
      if (AD_KEYS[k] in node) {
        try { delete node[AD_KEYS[k]]; } catch (e) {}
      }
    }
    for (var key in node) {
      if (Object.prototype.hasOwnProperty.call(node, key)) {
        scrub(node[key], depth + 1);
      }
    }
  }

  // A cheap string test keeps us off the hot path — YouTube parses a lot of
  // JSON that has nothing to do with ads.
  var LOOKS_ADDY = /adPlacements|playerAds|adSlots|adBreakHeartbeat/;

  var nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    var out = nativeParse.call(this, text, reviver);
    try {
      if (typeof text === 'string' && LOOKS_ADDY.test(text)) scrub(out, 0);
    } catch (e) {}
    return out;
  };

  if (window.Response && window.Response.prototype && window.Response.prototype.json) {
    var nativeJson = window.Response.prototype.json;
    window.Response.prototype.json = function () {
      return nativeJson.call(this).then(function (data) {
        try { scrub(data, 0); } catch (e) {}
        return data;
      });
    };
  }

  // The first watch page inlines its player response into the document rather
  // than fetching it, so intercept the assignment itself.
  try {
    var inlined;
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: function () { return inlined; },
      set: function (value) {
        try { scrub(value, 0); } catch (e) {}
        inlined = value;
      }
    });
  } catch (e) {}

  function styleOnce() {
    if (document.getElementById('__dlBlockCss')) return;
    var head = document.head || document.documentElement;
    if (!head) return;
    var el = document.createElement('style');
    el.id = '__dlBlockCss';
    el.textContent = ${JSON.stringify(COSMETIC_SELECTORS + '{display:none !important}')};
    head.appendChild(el);
  }

  styleOnce();
  document.addEventListener('DOMContentLoaded', styleOnce);

  // Fallback for anything that still reaches the player.
  setInterval(function () {
    try {
      var skip = document.querySelector(
        '.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern'
      );
      if (skip) skip.click();

      var player = document.querySelector('.ad-showing');
      if (player) {
        var video = player.querySelector('video') || document.querySelector('video');
        if (video && isFinite(video.duration) && video.duration > 0) {
          video.currentTime = video.duration;
        }
      }
    } catch (e) {}
  }, 500);
})();
true;
`;
