import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  titleTokens,
  titleScore,
  findDuplicate,
  runtimeLabel,
} from '../src/core/similar.ts';

/**
 * The duplicate test decides whether a tap downloads or refuses, so both of its
 * failure directions cost something real: a false negative fills the gallery
 * with `Title (1).m4a` orphans, and a false positive tells someone their song
 * is already saved when it is not. The cases below are drawn from the library
 * on the test device, which is where the packaging vocabulary came from.
 */

const row = (over = {}) => ({
  videoId: undefined,
  title: 'Kaisi Teri Khudgharzi',
  seconds: 202,
  state: 'saved',
  ...over,
});

describe('titleTokens', () => {
  test('drops packaging vocabulary but keeps the name', () => {
    const tokens = titleTokens('Kaisi Teri Khudgharzi | Full OST | 4K Video Song');
    assert.deepEqual([...tokens].sort(), ['kaisi', 'khudgharzi', 'teri']);
  });

  test('drops bracketed asides whole', () => {
    const tokens = titleTokens('Jhol (Official Music Video) [4K]');
    assert.deepEqual([...tokens], ['jhol']);
  });

  test('keeps non-Latin scripts', () => {
    // A regex written as [a-z0-9] would erase this title completely and match
    // it against everything else that had also been erased.
    const tokens = titleTokens('जन गण मन | National Anthem');
    assert.ok(tokens.has('जन'));
    assert.ok(tokens.has('मन'));
  });

  test('keeps words that distinguish real takes', () => {
    const tokens = titleTokens('Channa Mereya Unplugged Live Remix');
    for (const word of ['unplugged', 'live', 'remix']) {
      assert.ok(tokens.has(word), `${word} should survive`);
    }
  });
});

describe('titleScore', () => {
  test('one shared word is never a match', () => {
    assert.equal(titleScore('Tum Hi Ho', 'Tum Kya Mile'), 0);
  });

  test('a repost that appends cast and channel still scores high', () => {
    const score = titleScore(
      'Kaisi Teri Khudgharzi OST',
      'Kaisi Teri Khudgharzi | Music Video | Danish Taimoor | Pakistani Drama OST',
    );
    assert.ok(score >= 0.5, `expected >= 0.5, got ${score}`);
  });

  test('two different songs do not match', () => {
    assert.ok(titleScore('Tum Hi Ho Aashiqui 2', 'Sanam Re Title Song') < 0.5);
  });
});

describe('findDuplicate', () => {
  test('an identical videoId is exact', () => {
    const library = [row({ videoId: 'abc', title: 'Anything At All' })];
    const hit = findDuplicate(library, { videoId: 'abc', title: 'Different Name' });
    assert.equal(hit.kind, 'exact');
  });

  test('a repost under another name is similar, not exact', () => {
    const library = [row({ videoId: 'abc', title: 'Kaisi Teri Khudgharzi OST', seconds: 202 })];
    const hit = findDuplicate(library, {
      videoId: 'zzz',
      title: 'Kaisi Teri Khudgharzi | Music Video | Danish Taimoor | Pakistani Drama OST',
      seconds: 203,
    });
    assert.equal(hit.kind, 'similar');
  });

  test('a matching name at a different runtime is left alone', () => {
    // The full song and a 30-second teaser share every word. Runtime is the
    // only thing that separates them, which is why it is carried at all.
    const library = [row({ title: 'Kaisi Teri Khudgharzi', seconds: 202 })];
    const hit = findDuplicate(library, { title: 'Kaisi Teri Khudgharzi', seconds: 30 });
    assert.equal(hit, null);
  });

  test('without runtimes the bar is higher', () => {
    const library = [row({ title: 'Kaisi Teri Khudgharzi OST', seconds: 0 })];
    const loose = findDuplicate(library, {
      title: 'Kaisi Teri Khudgharzi | Music Video | Danish Taimoor | Pakistani Drama OST',
      seconds: 0,
    });
    assert.equal(loose, null, 'a partial name alone must not be enough');

    const tight = findDuplicate(library, { title: 'Kaisi Teri Khudgharzi', seconds: 0 });
    assert.equal(tight.kind, 'similar');
  });

  test('a short name inside a longer one is not a match on its own', () => {
    // Containment alone calls this perfect: every word of the first title is in
    // the second. They are two different songs, and with no runtime to
    // corroborate, size agreement is the only thing that separates them.
    const library = [row({ title: 'Tum Hi Ho', seconds: 0 })];
    const hit = findDuplicate(library, {
      title: 'Tum Hi Ho Gaya Hai Tujhko To Pyar Sajna',
      seconds: 0,
    });
    assert.equal(hit, null);
  });

  test('rows restored from the gallery still match, having no videoId', () => {
    // This is the reinstall case: the id is gone, the name and runtime are not.
    const library = [row({ videoId: undefined, title: 'Jhol _ Coke Studio Pakistan', seconds: 240 })];
    const hit = findDuplicate(library, {
      videoId: 'new',
      title: 'Jhol | Coke Studio Pakistan | Season 15',
      seconds: 241,
    });
    assert.equal(hit.kind, 'similar');
  });

  test('a failed row is not a duplicate', () => {
    // Otherwise the retry for a download that never landed is refused as a
    // duplicate of itself.
    const library = [row({ videoId: 'abc', state: 'failed' })];
    assert.equal(findDuplicate(library, { videoId: 'abc', title: 'Kaisi Teri Khudgharzi' }), null);
  });

  test('an empty library never matches', () => {
    assert.equal(findDuplicate([], { videoId: 'abc', title: 'Anything' }), null);
  });
});

describe('runtimeLabel', () => {
  test('formats and pads', () => {
    assert.equal(runtimeLabel(202), '3:22');
    assert.equal(runtimeLabel(65), '1:05');
  });

  test('says nothing when nothing is known', () => {
    assert.equal(runtimeLabel(0), '');
    assert.equal(runtimeLabel(undefined), '');
  });
});
