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
 * **Every report names the video it belongs to.** A web PO token is bound to a
 * video id — yt-dlp's guide is explicit that "a new token is required for each
 * video" — so a token without an id attached cannot be spent safely on
 * anything. It used to be reported bare and kept in a single slot, which meant
 * the app confidently sent A's token with B's download and read the 403 as a
 * refused client. See src/core/tokens.ts.
 *
 * ## Why there are five harvest points and not one
 *
 * The first version hooked `JSON.parse`, `fetch` and `XMLHttpRequest.open`, and
 * across a measured 25 seconds of playback it harvested **nothing at all** —
 * `mediaSeen` was zero, meaning it had not even seen a media URL go past, let
 * alone one carrying a token. Three separate reasons, and each on its own is
 * enough to explain the zero:
 *
 *  - **The first player response is never parsed.** It is inlined into the
 *    watch page's HTML as `var ytInitialPlayerResponse = {...}`, evaluated by
 *    the JavaScript parser. Nothing calls `JSON.parse`, so a hook on it cannot
 *    see the one response that is guaranteed to be there.
 *  - **`Response.json()` does not call `JSON.parse`.** It is native, and it
 *    parses in C++. Every SPA navigation fetches `/youtubei/v1/player` and reads
 *    it with `.json()`, so hooking the global parser misses all of them too.
 *  - **Hooking `XMLHttpRequest.open` sees the request, never the response.**
 *    The player response comes back in the body.
 *
 * So the rule this file now follows: **harvest where the data lands, not where
 * we imagine it passes.** The three response-side hooks below (`ytInitial…`,
 * `Response.prototype.json`, XHR `load`) are the ones that can actually see a
 * player response; the two request-side hooks are kept because a media URL is
 * the only place a token appears when the response was SABR-only.
 *
 * `saw` reports which of them fired. It exists because "no token" had two
 * indistinguishable causes for a day — no hook firing, versus hooks firing on
 * responses with no token in them — and telling those apart is the difference
 * between fixing this in an hour and rewriting it natively for nothing.
 */

export type PoTokenMessage = {
  type: 'potoken';
  poToken: string;
  visitorData: string;
  /** The video this token is bound to. Empty when the page has not said. */
  videoId: string;
  /**
   * How many `videoplayback` URLs the page has issued so far.
   *
   * Purely diagnostic, and it earns its place: "no token" has two very
   * different causes and they need telling apart. Zero here means the page is
   * not fetching media the way we expect — YouTube's SABR delivery does not use
   * this endpoint — while a non-zero count with no token means the URLs are
   * there but carry no `pot`. Guessing between those two was going to cost a
   * day.
   */
  mediaSeen: number;
  /**
   * Which harvest points have fired, comma-joined and in no order.
   *
   * One of `init` (inline player response), `resjson` (`Response.json`), `xhr`
   * (XHR response body), `parse` (global `JSON.parse`), `url` (a media request),
   * plus `sd` when a `streamingData` was actually reached, `sabr` when the
   * response was SABR-only, `req`/`reqbin` when an InnerTube request went past
   * with a text/non-text body, `reqskip` when a non-GET fetch was left unread
   * because its body was binary, and `bodypot` when a request body carried a
   * `poToken` field. An empty string means nothing fired at all, which is a
   * different bug from every one of them firing and finding no token.
   *
   * `reqskip` is the one to read if a token stops being found after the clone
   * was gated: `reqskip` climbing with no `req` alongside it would mean the
   * content-type test is throwing away the InnerTube call it is meant to keep.
   */
  saw: string;
};

export const POTOKEN_SCRIPT = `
(function () {
  // Never run or hook on Google authentication and account management pages
  if (/(?:accounts|myaccount|signin|passwords|id)\.(?:google|youtube)\.com/i.test(location.hostname)) return;
  if (window.__dlPotHooked) return;
  window.__dlPotHooked = true;

  var lastSent = '';
  var mediaSeen = 0;
  var saw = {};

  function note(what) { saw[what] = 1; }
  function sawList() {
    var out = [];
    for (var k in saw) if (saw.hasOwnProperty(k)) out.push(k);
    return out.join(',');
  }

  /**
   * The video the page is on, as a last resort.
   *
   * A player response names its own video and that is always preferred — this
   * only covers a token seen on a media URL, which does not carry the id in any
   * dependable form.
   */
  function currentVideoId() {
    try {
      var m = /[?&]v=([A-Za-z0-9_-]{6,})/.exec(location.href);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

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

  function report(token, videoId) {
    try {
      var payload = JSON.stringify({
        type: 'potoken',
        poToken: token || '',
        visitorData: visitorData(),
        videoId: videoId || currentVideoId(),
        mediaSeen: mediaSeen,
        saw: sawList()
      });
      if (payload === lastSent) return;
      lastSent = payload;
      window.ReactNativeWebView.postMessage(payload);
    } catch (e) {}
  }

  function inspect(url, videoId) {
    try {
      if (!url) return;
      var s = String(url);
      if (s.indexOf('videoplayback') === -1 && s.indexOf('/initplayback') === -1) return;
      mediaSeen++;
      note('url');
      var m = /[?&]pot=([^&]+)/.exec(s);
      if (m && m[1]) report(decodeURIComponent(m[1]), videoId);
    } catch (e) {}
  }

  // The player response carries fully-signed stream URLs, so the token is
  // available there before any media request is issued -- and it is present even
  // if the user never presses play.
  function harvestFromPlayerResponse(obj) {
    try {
      var root = obj && obj.playerResponse ? obj.playerResponse : obj;
      var sd = root && root.streamingData;
      if (!sd) return;
      note('sd');

      // The response names its own video, and that is the only trustworthy
      // source: YouTube prefetches the *next* watch page while the current one
      // is still on screen, so location.href at this moment can easily belong
      // to a different video than the token being read here.
      var id = '';
      try {
        id = (root.videoDetails && root.videoDetails.videoId) || '';
      } catch (e) {}

      // SABR serves one adaptive endpoint instead of a URL per format, and when
      // it is in play the per-format urls are simply absent -- so this is the
      // only place the token appears. It is checked first for that reason.
      if (sd.serverAbrStreamingUrl) {
        note('sabr');
        inspect(sd.serverAbrStreamingUrl, id);
      }

      var groups = [sd.formats, sd.adaptiveFormats];
      for (var g = 0; g < groups.length; g++) {
        var list = groups[g];
        if (!list) continue;
        for (var i = 0; i < list.length; i++) {
          if (list[i] && list[i].url) inspect(list[i].url, id);
        }
      }
    } catch (e) {}
  }

  /** Anything that might be a player response, from any of the five hooks. */
  function consider(obj, from) {
    try {
      if (!obj || typeof obj !== 'object') return;
      if (!obj.streamingData && !obj.playerResponse) return;
      note(from);
      harvestFromPlayerResponse(obj);
    } catch (e) {}
  }

  function considerText(text, from) {
    try {
      if (typeof text !== 'string') return;
      if (text.indexOf('streamingData') === -1) return;
      // YouTube prefixes some responses with an anti-JSON-hijacking guard.
      var body = text.charAt(0) === ')' ? text.slice(text.indexOf('{')) : text;
      consider(nativeParse.call(JSON, body), from);
    } catch (e) {}
  }

  /**
   * The watch page inlines its first player response as a global assignment,
   * which no parser hook can see. Trapping the property does.
   *
   * A \`var x = ...\` at global scope does not redefine an own property that is
   * already there, so declaring the accessor first means the page's own
   * assignment runs through this setter. It has to keep behaving exactly like a
   * plain data property afterwards -- the page reads it back constantly -- so
   * the value is stored and returned unchanged.
   */
  function trap(name, from) {
    try {
      var held = window[name];
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: function () { return held; },
        set: function (v) { held = v; consider(v, from); }
      });
      if (held) consider(held, from);
    } catch (e) {}
  }
  trap('ytInitialPlayerResponse', 'init');

  var nativeParse = JSON.parse;
  JSON.parse = function (text, reviver) {
    var out = nativeParse.call(this, text, reviver);
    try {
      if (typeof text === 'string' && text.indexOf('streamingData') !== -1) {
        consider(out, 'parse');
      }
    } catch (e) {}
    return out;
  };

  /**
   * \`Response.json()\` parses natively, so a \`JSON.parse\` hook never sees a
   * single one of the /youtubei/v1/player responses every SPA navigation makes.
   * This is the hook that covers every video after the first.
   */
  if (window.Response && Response.prototype && Response.prototype.json) {
    var nativeJson = Response.prototype.json;
    Response.prototype.json = function () {
      var p = nativeJson.apply(this, arguments);
      try {
        p.then(function (out) { consider(out, 'resjson'); })['catch'](function () {});
      } catch (e) {}
      return p;
    };
  }

  /**
   * The token the page minted, read out of its own player request.
   *
   * With SABR in play there is no \`pot\` on any URL to harvest -- the token
   * travels in the protobuf body of the media request instead -- so the URL
   * hooks above find nothing however many media requests go past. What the page
   * *does* send in plain JSON is its \`/youtubei/v1/player\` request, and that
   * carries \`serviceIntegrityDimensions.poToken\` for the exact video it is
   * asking about. Same token, same session, named alongside its video id.
   *
   * Read with a regex rather than by parsing: the body is YouTube's shape, not
   * ours, and a regex over two fields cannot be broken by them nesting things
   * differently next month.
   */
  function harvestFromRequestBody(url, body) {
    try {
      var s = String(url || '');
      var inner = s.indexOf('/youtubei/v1/') !== -1;
      if (typeof body !== 'string' || !body) {
        if (inner && body) note('reqbin');
        return;
      }
      if (inner) note('req');
      // Deliberately not restricted to the player endpoint. Which request
      // carries the token is YouTube's business and has already moved once;
      // an indexOf over a string we are handed anyway costs nothing, and
      // matching on the token's own field name cannot go out of date the way
      // an endpoint path can.
      if (body.indexOf('poToken') === -1) return;
      note('bodypot');
      var t = /"poToken"\s*:\s*"([^"]+)"/.exec(body);
      if (!t || !t[1]) return;
      var v = /"videoId"\s*:\s*"([^"]+)"/.exec(body);
      report(t[1], v ? v[1] : '');
    } catch (e) {}
  }

  /**
   * Is this body worth turning into a string?
   *
   * Content-type rather than URL on purpose. \`harvestFromRequestBody\` refuses
   * to match on the endpoint path because which request carries the token is
   * YouTube's business and has already moved once — that reasoning is right and
   * this does not undo it. A content-type is not an endpoint: it does not go
   * stale when \`/youtubei/v1/player\` moves, and every request that could carry
   * a \`"poToken"\` **field** is by definition sending JSON or text.
   *
   * A missing content-type is treated as binary. A string body given to
   * \`fetch\` always gets \`text/plain;charset=UTF-8\` by default, so the only
   * things that arrive with no type at all are the ones built from an
   * ArrayBuffer or a typed array — which is exactly what is being skipped.
   */
  function textualBody(headers) {
    try {
      if (!headers || typeof headers.get !== 'function') return false;
      var type = String(headers.get('content-type') || '').toLowerCase();
      if (!type) return false;
      return type.indexOf('json') !== -1 ||
        type.indexOf('text/') === 0 ||
        type.indexOf('x-www-form-urlencoded') !== -1;
    } catch (e) {
      return false;
    }
  }

  /**
   * A \`fetch\` can carry its body on a Request rather than in \`init\`, and a
   * Request's body is a stream that may only be read once -- so it has to be
   * cloned, and the read is asynchronous. Harvesting a moment late is fine:
   * nothing downstream is waiting on this, and the store is read at download
   * time rather than at report time.
   *
   * **The clone is gated, and this is the one call site where that matters.**
   * \`harvestFromRequestBody\` says an indexOf over the body "costs nothing
   * because we were handed the string anyway". True for the other two callers —
   * \`init.body\` and XHR \`send\` both already hold one. False here: this
   * function *creates* the string, by buffering the body and decoding it as
   * UTF-8.
   *
   * Ungated, that ran on every non-GET fetch. Under SABR the player requests
   * each media segment as a POST carrying a protobuf body, several times a
   * second for the whole of playback, so every audio and video chunk was being
   * cloned and decoded into a JS string to be searched for a JSON field it
   * cannot contain — allocation and GC churn, per fragment, while a video is
   * playing. Reported as "YouTube is slow when playing a video" on a Pixel,
   * where 16 KB page-size compat mode makes memory churn cost more (see
   * plugins/withPageSizeCompat.js).
   */
  function harvestFromRequest(req) {
    try {
      if (!req || typeof req.clone !== 'function' || !req.url) return;
      if (String(req.method || 'GET').toUpperCase() === 'GET') return;
      if (!textualBody(req.headers)) {
        // Told apart from "no hook fired" deliberately. This file already cost
        // a day to a diagnostic that could not distinguish "nothing ran" from
        // "everything ran and found nothing", and a silent skip would rebuild
        // exactly that ambiguity one layer down.
        note('reqskip');
        return;
      }
      req.clone().text().then(function (body) {
        harvestFromRequestBody(req.url, body);
      })['catch'](function () {});
    } catch (e) {}
  }

  var nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (body) {
    try {
      harvestFromRequestBody(this.__dlUrl, body);
    } catch (e) {}
    return nativeSend.apply(this, arguments);
  };

  var nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      // \`send\` gets the body but not the URL, so the two halves of an XHR have
      // to be introduced to each other.
      this.__dlUrl = url;
      inspect(url);
      // Reading the body is what actually finds a token; \`open\` alone only ever
      // sees the request, which is the wrong half of an XHR to watch.
      var s = String(url || '');
      if (s.indexOf('/youtubei/v1/player') !== -1 || s.indexOf('get_video_info') !== -1) {
        this.addEventListener('load', function () {
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              considerText(this.responseText, 'xhr');
            } else if (this.responseType === 'json') {
              consider(this.response, 'xhr');
            }
          } catch (e) {}
        });
      }
    } catch (e) {}
    return nativeOpen.apply(this, arguments);
  };

  if (window.fetch) {
    var nativeFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var href = typeof input === 'string' ? input : (input && input.url);
        inspect(href);
        if (init && init.body) harvestFromRequestBody(href, init.body);
        if (typeof input !== 'string') harvestFromRequest(input);
      } catch (e) {}
      return nativeFetch.apply(this, arguments);
    };
  }

  // visitorData is useful on its own, so don't wait for playback to report it.
  setTimeout(function () { if (!lastSent) report('', ''); }, 2500);
  setTimeout(function () { report('', ''); }, 8000);

  // YouTube is a single-page app, so this script runs once per *real* page load
  // and those timers fire against whatever was on screen then -- usually the
  // feed, which has no video id at all. Every later watch page is an SPA
  // navigation that re-runs none of this, so without watching the URL the store
  // never learns which video the session is actually on.
  //
  // The tick also re-reports while a watch page is open, because \`saw\` and
  // \`mediaSeen\` keep changing after the last token was found and the app has no
  // other way to learn that a hook fired late.
  var lastHref = location.href;
  setInterval(function () {
    if (location.href !== lastHref) {
      lastHref = location.href;
      mediaSeen = 0;
      saw = {};
    }
    report('', '');
  }, 1000);
})();
true;
`;
