import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ADBLOCK_SCRIPT } from '../src/browser/adblock.ts';
import { createPage } from './harness/dom.mjs';

/**
 * The layer that matters is the first one: pre-roll and mid-roll are described
 * in the InnerTube player response, not fetched from a blockable host, so
 * deleting those fields before YouTube's own JS reads them means the player
 * never learns there was an ad to play.
 *
 * That makes `JSON.parse` a hot path on every page the user browses, which is
 * the other half of what is tested here — a scrub that walked everything would
 * be a tax on every request YouTube makes.
 */

function install(options = {}) {
  const page = createPage(options);
  // The script only patches Response when the page has one.
  page.window.Response = class Response {
    constructor(body) {
      this.body = body;
    }
    json() {
      return Promise.resolve(JSON.parse(this.body));
    }
  };
  page.run(ADBLOCK_SCRIPT);
  return page;
}

/** Parse `value` through the page's own patched JSON.parse. */
const parse = (page, value) =>
  page.eval(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`);

describe('stripping the player response', () => {
  test('removes every ad field it knows about', () => {
    const page = install();
    const out = parse(page, {
      adPlacements: [{ x: 1 }],
      playerAds: [{ x: 1 }],
      adSlots: [{ x: 1 }],
      adBreakHeartbeatParams: 'abc',
      streamingData: { formats: [] },
    });
    assert.equal(out.adPlacements, undefined);
    assert.equal(out.playerAds, undefined);
    assert.equal(out.adSlots, undefined);
    assert.equal(out.adBreakHeartbeatParams, undefined);
    assert.deepEqual(out.streamingData, { formats: [] }, 'the video itself is untouched');
  });

  test('reaches ad fields nested inside the response', () => {
    const page = install();
    const out = parse(page, {
      playerResponse: { adPlacements: [1], videoDetails: { title: 'A song' } },
    });
    assert.equal(out.playerResponse.adPlacements, undefined);
    assert.equal(out.playerResponse.videoDetails.title, 'A song');
  });

  test('walks through arrays as well as objects', () => {
    const page = install();
    const out = parse(page, {
      adPlacements: 1,
      contents: [{ adSlots: [1] }, { keep: true }],
    });
    assert.equal(out.contents[0].adSlots, undefined);
    assert.equal(out.contents[1].keep, true);
  });

  test('stops at six levels down, so a deeply buried placement survives', () => {
    // The depth cap is what keeps this off the hot path. Finding the boundary
    // by measurement rather than by reading the constant, so that changing it
    // changes this test.
    const page = install();
    const nest = (depth) => {
      const leaf = { adPlacements: ['an ad'] };
      let node = leaf;
      for (let i = 0; i < depth; i++) node = { down: node, adSlots: ['also an ad'] };
      return node;
    };
    const at = (out, depth) => {
      let node = out;
      for (let i = 0; i < depth; i++) node = node.down;
      return node;
    };

    assert.equal(at(parse(page, nest(6)), 6).adPlacements, undefined, 'six is reached');
    assert.notEqual(at(parse(page, nest(7)), 7).adPlacements, undefined, 'seven is not');
  });

  test('a payload that does not look addy is not walked at all', () => {
    // The cheap string test is the thing that makes this affordable: YouTube
    // parses a great deal of JSON that has nothing to do with ads.
    const page = install();
    const out = parse(page, { importantForAds: true, adParams: 'x', other: 1 });
    assert.equal(
      out.importantForAds,
      true,
      'importantForAds and adParams are in the delete list but not in the fast-path test, ' +
        'so a payload carrying only those is never scrubbed through JSON.parse',
    );
  });

  test('survives payloads that are not objects', () => {
    const page = install();
    assert.equal(parse(page, 'adPlacements'), 'adPlacements');
    assert.equal(parse(page, 42), 42);
    assert.equal(parse(page, null), null);
  });

  test('leaves the reviver working', () => {
    const page = install();
    const out = page.eval(
      `JSON.parse('{"adPlacements":[1],"n":2}', function (k, v) { return k === 'n' ? v * 10 : v; })`,
    );
    assert.equal(out.n, 20);
    assert.equal(out.adPlacements, undefined);
  });

  test('is installed once however many times it is injected', () => {
    const page = install();
    const first = page.eval('JSON.parse');
    page.run(ADBLOCK_SCRIPT);
    assert.equal(page.eval('JSON.parse'), first, 'no chain of wrappers per navigation');
  });
});

describe('the inlined player response', () => {
  test('is scrubbed as it is assigned, before the page can read it', () => {
    // The first watch page inlines its player response into the document rather
    // than fetching it, so there is no parse to intercept.
    const page = install();
    page.eval(`window.ytInitialPlayerResponse = { adPlacements: [1], videoDetails: { title: 'A song' } }`);
    const stored = page.eval('window.ytInitialPlayerResponse');
    assert.equal(stored.adPlacements, undefined);
    assert.equal(stored.videoDetails.title, 'A song');
  });

  test('reads back as whatever was assigned, ads aside', () => {
    const page = install();
    page.eval(`window.ytInitialPlayerResponse = null`);
    assert.equal(page.eval('window.ytInitialPlayerResponse'), null);
  });
});

describe('fetched responses', () => {
  test('are scrubbed whatever they look like', async () => {
    const page = install();
    const out = await page.eval(
      `new window.Response(JSON.stringify({ adPlacements: [1], importantForAds: true, keep: 2 })).json()`,
    );
    assert.equal(out.adPlacements, undefined);
    assert.equal(out.importantForAds, undefined, 'no fast-path test on this route');
    assert.equal(out.keep, 2);
  });
});

describe('cosmetic filtering', () => {
  test('adds its stylesheet once', () => {
    const page = install();
    assert.notEqual(page.document.getElementById('__dlBlockCss'), null);
    const style = page.document.getElementById('__dlBlockCss');
    assert.match(style.textContent, /ytm-promoted-video-renderer/);
    assert.match(style.textContent, /display:none !important/);
    page.run(ADBLOCK_SCRIPT);
    assert.equal(page.document.getElementById('__dlBlockCss'), style);
  });
});

describe('the skip fallback', () => {
  test('clicks a skip button that made it through', () => {
    let clicks = 0;
    const page = install({
      query: (selector) =>
        selector.includes('ytp-ad-skip-button') ? { click: () => clicks++ } : null,
    });
    page.tick();
    assert.equal(clicks, 1);
  });

  test('seeks an unskippable ad to its end', () => {
    const video = { duration: 15, currentTime: 0 };
    const page = install({
      query: (selector) => {
        if (selector === '.ad-showing') return { querySelector: () => video };
        return null;
      },
    });
    page.tick();
    assert.equal(video.currentTime, 15);
  });

  test('leaves a video of unknown length alone', () => {
    // Seeking to Infinity or to NaN is worse than letting the ad run.
    const video = { duration: NaN, currentTime: 0 };
    const page = install({
      query: (selector) => (selector === '.ad-showing' ? { querySelector: () => video } : null),
    });
    page.tick();
    assert.equal(video.currentTime, 0);
  });

  test('does nothing on a page with no ad showing', () => {
    const page = install();
    page.tick(5);
  });
});
