import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  isPackaging,
  cleanArtist,
  cleanTitle,
  splitArtist,
  clean,
  knownArtists,
} from '../src/core/metadata.ts';

/**
 * These names are the shapes the library on the test device actually holds.
 * The two failure directions cost different things and the tests are weighted
 * accordingly: leaving "(Official Video)" on a row is untidy, and dropping a
 * word that named the song leaves a row nobody can identify — so almost every
 * case below is about what must *survive*.
 */

describe('isPackaging', () => {
  test('a fragment made only of packaging words', () => {
    assert.equal(isPackaging('Official Music Video'), true);
    assert.equal(isPackaging('4K'), true);
    assert.equal(isPackaging('Full Video Song'), true);
    assert.equal(isPackaging('HD 1080p'), true);
    assert.equal(isPackaging('(Official Audio)'), true);
  });

  test('one informative word keeps the whole fragment', () => {
    // Each of these names a version a listener would want kept apart.
    assert.equal(isPackaging('Live at Wembley'), false);
    assert.equal(isPackaging('Acoustic'), false);
    assert.equal(isPackaging('feat. Shreya Ghoshal'), false);
    assert.equal(isPackaging('Remastered 2011'), false);
    assert.equal(isPackaging('Slowed + Reverb'), false);
  });

  test('an empty fragment is not packaging', () => {
    // Or every bracket pair with nothing in it would read as a match.
    assert.equal(isPackaging(''), false);
    assert.equal(isPackaging('()'), false);
  });
});

describe('cleanArtist', () => {
  test('drops the Topic suffix YouTube adds to generated channels', () => {
    assert.equal(cleanArtist('Arijit Singh - Topic'), 'Arijit Singh');
    assert.equal(cleanArtist('Arijit Singh – Topic'), 'Arijit Singh');
  });

  test('leaves VEVO alone', () => {
    // Cutting it gives "ArijitSingh", which is worse than the channel name.
    assert.equal(cleanArtist('ArijitSinghVEVO'), 'ArijitSinghVEVO');
  });

  test('nothing in, empty out — never invented', () => {
    assert.equal(cleanArtist(undefined), '');
    assert.equal(cleanArtist(null), '');
    assert.equal(cleanArtist('   '), '');
  });
});

describe('cleanTitle', () => {
  test('drops packaging brackets', () => {
    assert.equal(cleanTitle('Jhol (Official Music Video) [4K]'), 'Jhol');
    assert.equal(cleanTitle('Chaleya (From "Jawan")'), 'Chaleya (From "Jawan")');
  });

  test('keeps brackets that name a version', () => {
    assert.equal(cleanTitle('Tum Hi Ho (Acoustic)'), 'Tum Hi Ho (Acoustic)');
    assert.equal(
      cleanTitle('Kesariya (feat. Arijit Singh)'),
      'Kesariya (feat. Arijit Singh)',
    );
    assert.equal(cleanTitle('Bohemian Rhapsody (Live Aid)'), 'Bohemian Rhapsody (Live Aid)');
  });

  test('takes the song out of a pipe-delimited credit list', () => {
    assert.equal(
      cleanTitle('Kaisi Teri Khudgharzi | Music Video | Danish Taimoor | Pakistani Drama OST'),
      'Kaisi Teri Khudgharzi',
    );
    assert.equal(cleanTitle('Tum Hi Ho | Aashiqui 2 | Arijit Singh'), 'Tum Hi Ho');
  });

  test('skips the artist segment when the artist leads', () => {
    // Otherwise the row ends up named after the singer rather than the song.
    assert.equal(cleanTitle('Arijit Singh | Tum Hi Ho', 'Arijit Singh'), 'Tum Hi Ho');
  });

  test('drops the artist used as a prefix', () => {
    assert.equal(cleanTitle('Arijit Singh - Tum Hi Ho', 'Arijit Singh'), 'Tum Hi Ho');
    // The channel arrives with YouTube's suffix on it; the prefix does not.
    assert.equal(cleanTitle('Arijit Singh - Tum Hi Ho', 'Arijit Singh - Topic'), 'Tum Hi Ho');
  });

  test('leaves a dash alone when the prefix is not the artist', () => {
    // "Song - Film" is the common Indian arrangement, and reading it as a name
    // would file the song under its own film.
    assert.equal(cleanTitle('Tum Hi Ho - Aashiqui 2', 'Mithoon'), 'Tum Hi Ho - Aashiqui 2');
  });

  test('drops a packaging-only tail after a dash', () => {
    assert.equal(cleanTitle('Jhol - Official Video'), 'Jhol');
    assert.equal(cleanTitle('Jhol - Full Song HD'), 'Jhol');
  });

  test('drops the site suffix a page title carries', () => {
    assert.equal(cleanTitle('Jhol (Official Video) - YouTube'), 'Jhol');
  });

  test('a title that is nothing but packaging survives as itself', () => {
    // A bad name beats an empty row, and this is what a mid-navigation blank
    // page title looks like.
    assert.equal(cleanTitle('Official Music Video'), 'Official Music Video');
    assert.equal(cleanTitle('(Official Video)'), '(Official Video)');
  });

  test('keeps non-Latin scripts whole', () => {
    assert.equal(cleanTitle('तुम ही हो (Official Video)'), 'तुम ही हो');
    assert.equal(cleanTitle('夜に駆ける【MV】'), '夜に駆ける');
  });

  test('empty in, empty out', () => {
    assert.equal(cleanTitle(''), '');
    assert.equal(cleanTitle('   '), '');
  });
});

describe('splitArtist', () => {
  const known = ['Arijit Singh', 'Coldplay'];

  test('splits on a corroborated name', () => {
    assert.deepEqual(splitArtist('Arijit Singh - Tum Hi Ho', known), {
      artist: 'Arijit Singh',
      title: 'Tum Hi Ho',
    });
  });

  test('refuses a name the app has never seen', () => {
    // The convention is not evidence: this is the "Song - Film" shape and
    // guessing would file the song under its own film for good.
    assert.equal(splitArtist('Tum Hi Ho - Aashiqui 2', known), null);
  });

  test('refuses with nothing to corroborate against', () => {
    assert.equal(splitArtist('Arijit Singh - Tum Hi Ho', []), null);
  });

  test('refuses more than one dash', () => {
    assert.equal(
      splitArtist('Kabhi Kabhi Aditi - Jaane Tu - Ya Jaane Na', ['Kabhi Kabhi Aditi']),
      null,
    );
  });

  test('refuses a track number or a year on the left', () => {
    assert.equal(splitArtist('01 - Tum Hi Ho', ['01']), null);
    assert.equal(splitArtist('2011 - Tum Hi Ho', ['2011']), null);
  });

  test('matches a known name through its Topic suffix', () => {
    assert.deepEqual(splitArtist('Arijit Singh - Tum Hi Ho', ['Arijit Singh - Topic']), {
      artist: 'Arijit Singh',
      title: 'Tum Hi Ho',
    });
  });
});

describe('clean', () => {
  test('the whole job on a real page report', () => {
    assert.deepEqual(
      clean({ title: 'Tum Hi Ho | Aashiqui 2 (Official Video) [4K]', artist: 'Arijit Singh - Topic' }),
      { title: 'Tum Hi Ho', artist: 'Arijit Singh', raw: 'Tum Hi Ho | Aashiqui 2 (Official Video) [4K]' },
    );
  });

  test('keeps the raw title, so nothing above is irreversible', () => {
    const raw = 'Jhol (Official Music Video)';
    assert.equal(clean({ title: raw }).raw, raw);
  });

  test('a real artist is never overridden by a split', () => {
    // The page said who this is; the dash is not a second opinion.
    const out = clean({ title: 'Coldplay - Yellow', artist: 'Some Uploader' }, ['Coldplay']);
    assert.equal(out.artist, 'Some Uploader');
  });

  test('splits only where the library corroborates it', () => {
    assert.equal(clean({ title: 'Coldplay - Yellow' }, ['Coldplay']).artist, 'Coldplay');
    assert.equal(clean({ title: 'Coldplay - Yellow' }, []).artist, '');
  });

  test('never invents an artist', () => {
    const out = clean({ title: 'Jhol (Official Video)' });
    assert.equal(out.artist, '');
    assert.equal(out.title, 'Jhol');
  });

  test('repeating the same names is answered from the cache', () => {
    const first = clean({ title: 'Jhol (Official Video)', artist: 'Maanu' });
    const second = clean({ title: 'Jhol (Official Video)', artist: 'Maanu' });
    assert.equal(first, second);
  });
});

describe('knownArtists', () => {
  test('folds both stores into one lowercased set', () => {
    const library = [{ artist: 'Arijit Singh' }, { artist: undefined }];
    const plays = [{ artist: 'Coldplay - Topic' }, { artist: '' }];
    const names = knownArtists(library, plays);
    assert.deepEqual([...names].sort(), ['arijit singh', 'coldplay']);
  });

  test('an empty library is an empty set, not a crash', () => {
    assert.equal(knownArtists([], []).size, 0);
  });
});
