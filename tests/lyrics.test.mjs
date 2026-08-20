import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { parseLrc, lineAt, lyricsKey } from '../src/core/lyrics.ts';
import { reset, seed, raw } from './harness/stubs/async-storage.mjs';

/**
 * The cache is module-level and survives an AsyncStorage reset, exactly as it
 * does in the app — so anything that exercises it takes a fresh copy of the
 * module rather than sharing one across tests and reading the previous test's
 * answer back as its own.
 */
let counter = 0;
const load = () => import(`../src/core/lyrics.ts?fresh=${counter++}`);

/**
 * The parsing is ordinary; the consent gate is not. This module is the only
 * thing in the app that talks to a host that is not YouTube, so the test that
 * matters most is the one proving nothing leaves without an answer on file.
 */

beforeEach(() => {
  reset();
  globalThis.fetch = async () => {
    throw new Error('no test may reach the network without saying so');
  };
});

describe('parseLrc', () => {
  test('reads stamps into seconds', () => {
    const lines = parseLrc('[00:12.50]Hello\n[01:05.00]World');
    assert.deepEqual(lines, [
      { at: 12.5, text: 'Hello' },
      { at: 65, text: 'World' },
    ]);
  });

  test('two digits are hundredths and three are milliseconds', () => {
    // Reading "50" as milliseconds puts every line 450ms early, which is enough
    // to look like the wrong line is lit.
    assert.equal(parseLrc('[00:01.50]x')[0].at, 1.5);
    assert.equal(parseLrc('[00:01.500]x')[0].at, 1.5);
    assert.equal(parseLrc('[00:01.05]x')[0].at, 1.05);
  });

  test('a repeated chorus written once becomes one line per stamp', () => {
    const lines = parseLrc('[00:10.00][01:10.00]Chorus');
    assert.deepEqual(lines.map((l) => l.at), [10, 70]);
    assert.equal(lines[1].text, 'Chorus');
  });

  test('keeps empty lines, which are the gaps between verses', () => {
    // A follower that skips them jumps the highlight through an instrumental.
    const lines = parseLrc('[00:10.00]One\n[00:20.00]\n[00:30.00]Two');
    assert.equal(lines.length, 3);
    assert.equal(lines[1].text, '');
  });

  test('ignores metadata and anything with no stamp', () => {
    const lines = parseLrc('[ar:Someone]\n[ti:Song]\njust text\n[00:01.00]Real');
    assert.deepEqual(lines, [{ at: 1, text: 'Real' }]);
  });

  test('sorts out-of-order stamps', () => {
    assert.deepEqual(parseLrc('[00:30.00]b\n[00:10.00]a').map((l) => l.text), ['a', 'b']);
  });

  test('empty in, empty out', () => {
    assert.deepEqual(parseLrc(''), []);
    assert.deepEqual(parseLrc('   '), []);
  });
});

describe('lineAt', () => {
  const lines = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c');

  test('lights nothing before the first stamp', () => {
    // An eight-second intro should light nothing rather than the first line.
    assert.equal(lineAt(lines, 0), -1);
    assert.equal(lineAt(lines, 9.9), -1);
  });

  test('lights the last stamp that has passed', () => {
    assert.equal(lineAt(lines, 10), 0);
    assert.equal(lineAt(lines, 19.9), 0);
    assert.equal(lineAt(lines, 20), 1);
    assert.equal(lineAt(lines, 999), 2);
  });

  test('an empty lyric lights nothing rather than throwing', () => {
    assert.equal(lineAt([], 10), -1);
  });
});

describe('lyricsKey', () => {
  test('keyed on the names, so a re-save is not a second lookup', () => {
    assert.equal(lyricsKey('Arijit Singh', 'Tum Hi Ho'), lyricsKey('  ARIJIT SINGH ', 'tum hi ho'));
  });
});

describe('consent', () => {
  test('nothing is agreed until it is agreed', async () => {
    const { hasLyricsConsent, setLyricsConsent } = await load();
    assert.equal(await hasLyricsConsent(), false);
    await setLyricsConsent(true);
    assert.equal(await hasLyricsConsent(), true);
    assert.equal(raw('dl.lyricsOptIn'), '1');
  });

  test('a refusal is stored as a refusal, not as an absence', async () => {
    const { hasLyricsConsent, setLyricsConsent } = await load();
    await setLyricsConsent(false);
    assert.equal(await hasLyricsConsent(), false);
    assert.equal(raw('dl.lyricsOptIn'), '0');
  });

  test('no request leaves without consent', async () => {
    const { fetchLyrics } = await load();
    let asked = false;
    globalThis.fetch = async () => {
      asked = true;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    const out = await fetchLyrics({ artist: 'A', title: 'B' });
    assert.equal(out, null);
    assert.equal(asked, false, 'the network was reached without an answer on file');
  });
});

describe('fetchLyrics', () => {
  test('parses a synced result and caches it', async () => {
    const { fetchLyrics, setLyricsConsent } = await load();
    await setLyricsConsent(true);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ syncedLyrics: '[00:01.00]Hi', plainLyrics: 'Hi' }),
      };
    };

    const first = await fetchLyrics({ artist: 'A', title: 'B', seconds: 200 });
    assert.equal(first?.synced, true);
    assert.deepEqual(first?.lines, [{ at: 1, text: 'Hi' }]);

    const second = await fetchLyrics({ artist: 'A', title: 'B', seconds: 200 });
    assert.deepEqual(second, first);
    assert.equal(calls, 1, 'a cached answer must not ask again');
  });

  test('a plain-only result is not marked synced', async () => {
    const { fetchLyrics, setLyricsConsent } = await load();
    await setLyricsConsent(true);
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ syncedLyrics: '', plainLyrics: 'Just words' }),
    });
    const out = await fetchLyrics({ artist: 'A', title: 'B' });
    assert.equal(out?.synced, false);
    assert.equal(out?.plain, 'Just words');
  });

  test('a 404 is an answer, and is remembered', async () => {
    const { fetchLyrics, setLyricsConsent } = await load();
    await setLyricsConsent(true);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return { ok: false, status: 404, json: async () => ({}) };
    };
    assert.equal(await fetchLyrics({ artist: 'A', title: 'B' }), null);
    assert.equal(await fetchLyrics({ artist: 'A', title: 'B' }), null);
    assert.equal(calls, 1, '"there are none" is worth remembering');
  });

  test('a failure is not remembered, because it is not an answer', async () => {
    // "We could not ask" is not "there are none". Caching it would leave a
    // track permanently lyric-less because of one dead moment on a train.
    const { fetchLyrics, setLyricsConsent } = await load();
    await setLyricsConsent(true);
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      return {
        ok: true,
        status: 200,
        json: async () => ({ syncedLyrics: '[00:02.00]Later', plainLyrics: '' }),
      };
    };

    await assert.rejects(() => fetchLyrics({ artist: 'A', title: 'B' }));
    const out = await fetchLyrics({ artist: 'A', title: 'B' });
    assert.equal(out?.lines[0].text, 'Later');
    assert.equal(calls, 2);
  });

  test('sends the duration only when it is known', async () => {
    const { fetchLyrics, setLyricsConsent } = await load();
    await setLyricsConsent(true);
    const urls = [];
    globalThis.fetch = async (url) => {
      urls.push(url);
      return { ok: false, status: 404, json: async () => ({}) };
    };

    await fetchLyrics({ artist: 'A', title: 'B', seconds: 214 });
    await fetchLyrics({ artist: 'C', title: 'D' });
    assert.match(urls[0], /duration=214/);
    assert.doesNotMatch(urls[1], /duration/);
  });

  test('sends the track and nothing else', async () => {
    const { fetchLyrics, setLyricsConsent } = await load();
    await setLyricsConsent(true);
    let seen = '';
    globalThis.fetch = async (url) => {
      seen = url;
      return { ok: false, status: 404, json: async () => ({}) };
    };
    await fetchLyrics({ artist: 'Arijit Singh', title: 'Tum Hi Ho', seconds: 100 });
    const query = new URL(seen).searchParams;
    assert.deepEqual([...query.keys()].sort(), ['artist_name', 'duration', 'track_name']);
  });

  test('a cached answer from an earlier launch is used', async () => {
    const { fetchLyrics, setLyricsConsent } = await load();
    await setLyricsConsent(true);
    seed('dl.lyrics', JSON.stringify({ 'a|b': { lines: [], plain: 'Stored', synced: false } }));
    const out = await fetchLyrics({ artist: 'A', title: 'B' });
    assert.equal(out?.plain, 'Stored');
  });
});
