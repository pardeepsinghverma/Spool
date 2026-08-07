/**
 * Proof-of-Origin token harvesting.
 *
 * Since 2025 essentially every YouTube stream request needs a PO token or it
 * returns 403. Standalone downloaders have to mint one by running BotGuard in a
 * synthetic environment, which is fragile and is why they keep dying.
 *
 * We don't have to. We *are* a browser: the page is playing the video itself,
 * which means it has already minted a valid token and is attaching it to its own
 * media requests as the `pot` query parameter. Harvesting that is both simpler
 * and more durable than re-implementing the attestation — the token is real by
 * construction, because YouTube issued it to this exact session.
 *
 * `visitorData` comes straight out of ytcfg and is available immediately, even
 * before any media request happens.
 *
 * Caveat: harvesting needs the page to actually start streaming. If the user
 * taps download before playback begins we may only have visitorData, so callers
 * must treat poToken as optional and let yt-dlp try without it.
 */

export type PoTokenMessage = {
  type: 'potoken';
  poToken: string;
  visitorData: string;
};

export const POTOKEN_SCRIPT = `
(function () {
  if (window.__dlPotHooked) return;
  window.__dlPotHooked = true;

  var lastSent = '';

  function visitorData() {
    try {
      if (window.ytcfg && typeof window.ytcfg.get === 'function') {
        var ctx = window.ytcfg.get('INNERTUBE_CONTEXT');
        if (ctx && ctx.client && ctx.client.visitorData) return ctx.client.visitorData;
        var direct = window.ytcfg.get('VISITOR_DATA');
        if (direct) return direct;
      }
    } catch (e) {}
    return '';
  }

  function report(token) {
    try {
      var payload = JSON.stringify({
        type: 'potoken',
        poToken: token || '',
        visitorData: visitorData()
      });
      if (payload === lastSent) return;
      lastSent = payload;
      window.ReactNativeWebView.postMessage(payload);
    } catch (e) {}
  }

  function inspect(url) {
    try {
      if (!url) return;
      var s = String(url);
      if (s.indexOf('videoplayback') === -1) return;
      var m = /[?&]pot=([^&]+)/.exec(s);
      if (m && m[1]) report(decodeURIComponent(m[1]));
    } catch (e) {}
  }

  // The player response carries fully-signed stream URLs, so the token is
  // available there before any media request is issued — and it is present even
  // if the user never presses play.
  function harvestFromPlayerResponse(obj) {
    try {
      var sd = obj && (obj.streamingData ||
        (obj.playerResponse && obj.playerResponse.streamingData));
      if (!sd) return;
      var groups = [sd.formats, sd.adaptiveFormats];
      for (var g = 0; g < groups.length; g++) {
        var list = groups[g];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].url) inspect(list[i].url);
        }
      }
    } catch (e) {}
  }

  var nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    var out = nativeParse.call(this, text, reviver);
    try {
      if (typeof text === 'string' && text.indexOf('streamingData') !== -1) {
        harvestFromPlayerResponse(out);
      }
    } catch (e) {}
    return out;
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    inspect(url);
    return nativeOpen.apply(this, arguments);
  };

  if (window.fetch) {
    var nativeFetch = window.fetch;
    window.fetch = function (input) {
      try {
        inspect(typeof input === 'string' ? input : (input && input.url));
      } catch (e) {}
      return nativeFetch.apply(this, arguments);
    };
  }

  // visitorData is useful on its own, so don't wait for playback to report it.
  setTimeout(function () { if (!lastSent) report(''); }, 2500);
  setTimeout(function () { report(''); }, 8000);
})();
true;
`;
