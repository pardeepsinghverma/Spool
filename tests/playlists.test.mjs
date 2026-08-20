import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadPlaylists,
  savePlaylists,
  tidyName,
  uniqueName,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addTracks,
  removeTrack,
  moveTrack,
  resolve,
  describePlaylist,
  playlistsWith,
} from '../src/core/playlists.ts';
import { reset, seed, raw, faults } from './harness/stubs/async-storage.mjs';

/**
 * A playlist is the one list in the app the user arranged by hand, so the tests
 * that matter most are the ones about what must *not* happen to it: an order
 * quietly changing, a track added twice, and above all a list emptying itself
 * because the library had not finished loading when something looked.
 */

beforeEach(reset);

const NOW = 1_000;

const list = (over = {}) => ({
  id: 'pl-1',
  name: 'Night drive',
  trackIds: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

const song = (id, over = {}) => ({
  id,
  title: id,
  quality: 'audio',
  audioOnly: true,
  savedAt: 1,
  state: 'saved',
  uri: `content://${id}`,
  ...over,
});

describe('tidyName and uniqueName', () => {
  test('collapses whitespace and caps the length', () => {
    assert.equal(tidyName('  Night   drive  '), 'Night drive');
    assert.equal(tidyName('x'.repeat(200)).length, 60);
    assert.equal(tidyName('   '), '');
  });

  test('never hands back a name already taken', () => {
    // The add-to-playlist sheet is a list of names and nothing else, so two
    // identical rows is a choice the user cannot make.
    const lists = [list(), list({ id: 'pl-2', name: 'Night drive 2' })];
    assert.equal(uniqueName(lists, 'Night drive'), 'Night drive 3');
    assert.equal(uniqueName(lists, 'Morning'), 'Morning');
  });

  test('matches a taken name regardless of case', () => {
    assert.equal(uniqueName([list()], 'NIGHT DRIVE'), 'NIGHT DRIVE 2');
  });
});

describe('createPlaylist', () => {
  test('puts the newest first and starts it empty', () => {
    const out = createPlaylist([list()], 'Morning', NOW);
    assert.equal(out.playlists.length, 2);
    assert.equal(out.playlists[0].name, 'Morning');
    assert.deepEqual(out.playlists[0].trackIds, []);
  });

  test('refuses a blank name rather than making "Playlist"', () => {
    assert.equal(createPlaylist([], '   ', NOW), null);
  });

  test('refuses past the cap', () => {
    const many = Array.from({ length: 50 }, (_, i) => list({ id: `pl-${i}`, name: `L${i}` }));
    assert.equal(createPlaylist(many, 'One more', NOW), null);
  });

  test('two made in the same millisecond do not collide', () => {
    const first = createPlaylist([], 'A', NOW);
    const second = createPlaylist(first.playlists, 'B', NOW);
    assert.notEqual(first.created.id, second.created.id);
  });
});

describe('addTracks', () => {
  test('appends in the order given, at the end', () => {
    const out = addTracks([list({ trackIds: ['a'] })], 'pl-1', ['b', 'c'], NOW);
    assert.deepEqual(out.playlists[0].trackIds, ['a', 'b', 'c']);
    assert.equal(out.added, 2);
    assert.equal(out.duplicate, 0);
  });

  test('refuses a track already there and says so', () => {
    // Adding from two screens must not silently double the row.
    const out = addTracks([list({ trackIds: ['a'] })], 'pl-1', ['a'], NOW);
    assert.deepEqual(out.playlists[0].trackIds, ['a']);
    assert.equal(out.added, 0);
    assert.equal(out.duplicate, 1);
  });

  test('the same array back when nothing was added', () => {
    const before = [list({ trackIds: ['a'] })];
    assert.equal(addTracks(before, 'pl-1', ['a'], NOW).playlists, before);
  });

  test('stops at the track cap instead of growing without bound', () => {
    const full = list({ trackIds: Array.from({ length: 499 }, (_, i) => `t${i}`) });
    const out = addTracks([full], 'pl-1', ['x', 'y'], NOW);
    assert.equal(out.playlists[0].trackIds.length, 500);
    assert.equal(out.added, 1);
  });

  test('an unknown playlist id changes nothing', () => {
    const before = [list()];
    assert.equal(addTracks(before, 'nope', ['a'], NOW).playlists, before);
  });
});

describe('moveTrack', () => {
  const three = [list({ trackIds: ['a', 'b', 'c'] })];

  test('moves one place at a time', () => {
    assert.deepEqual(moveTrack(three, 'pl-1', 'c', -1, NOW)[0].trackIds, ['a', 'c', 'b']);
    assert.deepEqual(moveTrack(three, 'pl-1', 'a', 1, NOW)[0].trackIds, ['b', 'a', 'c']);
  });

  test('past either end is a no-op, never a wrap', () => {
    // A track leaping from the bottom to the top on a stray tap reads as a bug.
    assert.deepEqual(moveTrack(three, 'pl-1', 'a', -1, NOW)[0].trackIds, ['a', 'b', 'c']);
    assert.deepEqual(moveTrack(three, 'pl-1', 'c', 1, NOW)[0].trackIds, ['a', 'b', 'c']);
  });

  test('a track that is not in the list changes nothing', () => {
    assert.deepEqual(moveTrack(three, 'pl-1', 'zz', 1, NOW)[0].trackIds, ['a', 'b', 'c']);
  });
});

describe('removeTrack, deletePlaylist and renamePlaylist', () => {
  test('removes one entry and leaves the order alone', () => {
    const out = removeTrack([list({ trackIds: ['a', 'b', 'c'] })], 'pl-1', 'b', NOW);
    assert.deepEqual(out[0].trackIds, ['a', 'c']);
  });

  test('deletes by id', () => {
    const out = deletePlaylist([list(), list({ id: 'pl-2' })], 'pl-1');
    assert.deepEqual(out.map((p) => p.id), ['pl-2']);
  });

  test('renaming avoids the other names but not its own', () => {
    const lists = [list(), list({ id: 'pl-2', name: 'Morning' })];
    assert.equal(renamePlaylist(lists, 'pl-2', 'Night drive', NOW)[1].name, 'Night drive 2');
    // Renaming a playlist to what it is already called must not make it "X 2".
    assert.equal(renamePlaylist(lists, 'pl-1', 'Night drive', NOW)[0].name, 'Night drive');
  });

  test('a blank rename is refused rather than applied', () => {
    const lists = [list()];
    assert.equal(renamePlaylist(lists, 'pl-1', '  ', NOW), lists);
  });
});

describe('resolve', () => {
  const library = [song('b'), song('a'), song('c')];

  test('returns rows in the playlist order, not the library order', () => {
    const out = resolve(list({ trackIds: ['a', 'b'] }), library);
    assert.deepEqual(out.map((r) => r.id), ['a', 'b']);
  });

  test('skips what the library does not have', () => {
    const out = resolve(list({ trackIds: ['a', 'gone', 'c'] }), library);
    assert.deepEqual(out.map((r) => r.id), ['a', 'c']);
  });

  test('skips a row that never finished or has no file', () => {
    const out = resolve(list({ trackIds: ['a', 'f', 'n'] }), [
      ...library,
      song('f', { state: 'failed', uri: undefined }),
      song('n', { uri: undefined }),
    ]);
    assert.deepEqual(out.map((r) => r.id), ['a']);
  });

  test('an empty library resolves to nothing and stores nothing', () => {
    // The boot case: the library has not loaded yet. Resolution is for display,
    // so this must be a temporarily empty screen and never a permanent edit.
    const playlist = list({ trackIds: ['a', 'b'] });
    assert.deepEqual(resolve(playlist, []), []);
    assert.deepEqual(playlist.trackIds, ['a', 'b'], 'the stored ids are untouched');
  });

  test('no playlist resolves to nothing rather than throwing', () => {
    assert.deepEqual(resolve(null, library), []);
  });
});

describe('describePlaylist and playlistsWith', () => {
  test('counts what is actually playable', () => {
    const library = [song('a')];
    assert.equal(describePlaylist(list({ trackIds: ['a'] }), library), '1 track');
    assert.equal(describePlaylist(list({ trackIds: ['a', 'gone'] }), library), '1 track');
    assert.equal(describePlaylist(list({ trackIds: [] }), library), 'Empty');
    assert.equal(describePlaylist(list({ trackIds: ['gone'] }), library), 'Empty');
  });

  test('finds the lists a track is already in', () => {
    const lists = [list({ trackIds: ['a'] }), list({ id: 'pl-2', trackIds: ['b'] })];
    assert.deepEqual(playlistsWith(lists, 'a').map((p) => p.id), ['pl-1']);
    assert.deepEqual(playlistsWith(lists, 'z'), []);
  });
});

describe('storage', () => {
  test('round-trips', async () => {
    await savePlaylists([list({ trackIds: ['a'] })]);
    const back = await loadPlaylists();
    assert.deepEqual(back[0].trackIds, ['a']);
    assert.equal(back[0].name, 'Night drive');
  });

  test('an unreadable blob reads as empty rather than throwing', async () => {
    seed('dl.playlists', '{ not json');
    assert.deepEqual(await loadPlaylists(), []);

    seed('dl.playlists', '{"playlists":[]}');
    assert.deepEqual(await loadPlaylists(), [], 'an object is not a list');

    faults.read = true;
    assert.deepEqual(await loadPlaylists(), []);
  });

  test('a half-written entry is dropped, not allowed to crash a screen', async () => {
    seed(
      'dl.playlists',
      JSON.stringify([{ id: 'pl-1', name: 'Ok' }, { name: 'no id' }, null, 'nope']),
    );
    const back = await loadPlaylists();
    assert.equal(back.length, 1);
    assert.deepEqual(back[0].trackIds, [], 'a missing list of ids reads as empty');
  });

  test('keeps the cap on write', async () => {
    const many = Array.from({ length: 60 }, (_, i) => list({ id: `pl-${i}` }));
    await savePlaylists(many);
    assert.equal(JSON.parse(raw('dl.playlists')).length, 50);
  });

  test('a failed write is not fatal', async () => {
    faults.write = true;
    await savePlaylists([list()]);
    assert.equal(raw('dl.playlists'), null);
  });
});
