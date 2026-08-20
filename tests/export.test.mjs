import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  fileNameFor,
  playlistToM3u,
  buildBackup,
  describeExport,
} from '../src/core/export.ts';

/**
 * An export is only worth anything if it can be read back — by another player,
 * or by a later Spool after the reinstall that lost the originals. So these
 * pin the shape of what is written rather than merely that something was.
 */

const list = (over = {}) => ({
  id: 'pl-1',
  name: 'Night drive',
  trackIds: ['a', 'b'],
  createdAt: 1000,
  updatedAt: 1000,
  ...over,
});

const song = (id, over = {}) => ({
  id,
  title: id === 'a' ? 'Tum Hi Ho' : 'Kesariya',
  quality: 'audio',
  audioOnly: true,
  savedAt: 1,
  state: 'saved',
  uri: `content://media/external/audio/media/${id}`,
  seconds: id === 'a' ? 262 : 214,
  artist: 'Arijit Singh',
  ...over,
});

const library = [song('a'), song('b')];

describe('fileNameFor', () => {
  test('strips what a filesystem refuses and keeps the extension', () => {
    assert.equal(fileNameFor('Night/drive: 2?', 'm3u8'), 'Night_drive_ 2_.m3u8');
  });

  test('a nameless playlist still produces a file', () => {
    assert.equal(fileNameFor('   ', 'm3u8'), 'Playlist.m3u8');
  });

  test('caps the length', () => {
    assert.ok(fileNameFor('x'.repeat(300), 'json').length <= 85);
  });
});

describe('playlistToM3u', () => {
  test('writes the header, the runtime and Artist - Title', () => {
    const out = playlistToM3u(list(), library);
    const lines = out.body.split('\n');
    assert.equal(lines[0], '#EXTM3U');
    assert.equal(lines[1], '#PLAYLIST:Night drive');
    assert.equal(lines[2], '#EXTINF:262,Arijit Singh - Tum Hi Ho');
    assert.equal(lines[3], 'content://media/external/audio/media/a');
    assert.equal(out.name, 'Night drive.m3u8');
    assert.equal(out.mime, 'audio/x-mpegurl');
  });

  test('keeps the playlist order, not the library order', () => {
    const out = playlistToM3u(list({ trackIds: ['b', 'a'] }), library);
    assert.match(out.body.split('\n')[2], /Kesariya/);
  });

  test('an unknown runtime is -1, which is what the format reserves for it', () => {
    // 0 reads as a zero-length track, which is a different and wrong claim.
    const out = playlistToM3u(list({ trackIds: ['a'] }), [song('a', { seconds: undefined })]);
    assert.match(out.body, /#EXTINF:-1,/);
  });

  test('a track with no artist is named by title alone', () => {
    const out = playlistToM3u(list({ trackIds: ['a'] }), [song('a', { artist: undefined })]);
    assert.match(out.body.split('\n')[2], /^#EXTINF:262,Tum Hi Ho$/);
  });

  test('ends with a newline', () => {
    // A file that does not is what a strict parser refuses for no visible cause.
    assert.ok(playlistToM3u(list(), library).body.endsWith('\n'));
  });

  test('an empty playlist is still a valid file', () => {
    const out = playlistToM3u(list({ trackIds: [] }), library);
    assert.equal(out.body, '#EXTM3U\n#PLAYLIST:Night drive\n');
  });

  test('skips what the library no longer has', () => {
    const out = playlistToM3u(list({ trackIds: ['a', 'gone'] }), library);
    assert.equal(out.body.split('\n').filter((l) => l.startsWith('#EXTINF')).length, 1);
  });
});

describe('buildBackup', () => {
  const NOW = Date.parse('2026-08-20T21:00:00');

  test('carries tracks by name, because ids do not survive a reinstall', () => {
    const out = buildBackup([list()], library, NOW);
    const parsed = JSON.parse(out.body);
    assert.equal(parsed.format, 'spool-backup');
    assert.equal(parsed.version, 1);
    assert.deepEqual(parsed.playlists[0].tracks[0], {
      title: 'Tum Hi Ho',
      artist: 'Arijit Singh',
      seconds: 262,
    });
    // Nothing that a reinstall would invalidate.
    assert.equal(JSON.stringify(parsed).includes('found:'), false);
    assert.equal(parsed.playlists[0].tracks[0].id, undefined);
  });

  test('names the file for the local date, not UTC', () => {
    // toISOString would call a September evening in India the day before.
    const out = buildBackup([], [], NOW);
    assert.equal(out.name, 'spool-backup-2026-08-20.json');
    assert.equal(out.mime, 'application/json');
  });

  test('an empty library still writes a readable backup', () => {
    const parsed = JSON.parse(buildBackup([], [], NOW).body);
    assert.deepEqual(parsed.playlists, []);
  });
});

describe('describeExport', () => {
  test('counts what was actually written', () => {
    assert.equal(describeExport([list()], library), '1 playlist · 2 tracks');
    assert.equal(
      describeExport([list(), list({ id: 'pl-2', trackIds: ['a'] })], library),
      '2 playlists · 3 tracks',
    );
    assert.equal(describeExport([], []), '0 playlists · 0 tracks');
  });

  test('does not count tracks the library has lost', () => {
    assert.equal(describeExport([list({ trackIds: ['a', 'gone'] })], library), '1 playlist · 1 track');
  });
});
