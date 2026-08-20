import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  adoptSaved,
  mediaKey,
  dedupeByFile,
  loadDownloads,
  saveDownloads,
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  loadSession,
  saveSession,
  loadForgotten,
  saveForgotten,
  loadSearches,
  saveSearches,
  hasSeenFirstRun,
  markFirstRunSeen,
} from '../src/core/storage.ts';
import { reset, seed, raw, faults } from './harness/stubs/async-storage.mjs';

/**
 * Every loader here swallows its own errors, on the reasonable grounds that
 * losing a preference is not worth crashing over. That is only sound if what
 * the caller gets back is still usable, which is what these check: corrupt
 * JSON, a blob written by an older build, a device with a full disk.
 *
 * `adoptSaved` gets the most attention because it is the one function in the
 * app that can *resurrect* something the user deleted.
 */

beforeEach(reset);

const found = (uri, over = {}) => ({
  uri,
  title: 'Song',
  bytes: 1000,
  savedAt: 5,
  audioOnly: true,
  artist: null,
  ...over,
});

const record = (id, over = {}) => ({
  id,
  title: 'Song',
  quality: 'audio',
  audioOnly: true,
  savedAt: 1,
  state: 'saved',
  ...over,
});

describe('mediaKey', () => {
  test('one MediaStore row is one key, whichever volume named it', () => {
    // The write path publishes under external_primary and the scan reads back
    // under external. The device resolves both to _id 99451; comparing the
    // strings did not, so every manual save was adopted a second time.
    assert.equal(
      mediaKey('content://media/external_primary/audio/media/99451'),
      mediaKey('content://media/external/audio/media/99451'),
    );
  });

  test('different rows stay different', () => {
    assert.notEqual(
      mediaKey('content://media/external/audio/media/1'),
      mediaKey('content://media/external/audio/media/2'),
    );
  });

  test('audio and video of the same id are not confused', () => {
    assert.notEqual(
      mediaKey('content://media/external/audio/media/7'),
      mediaKey('content://media/external/video/media/7'),
    );
  });

  test('a file path is left exactly as it is', () => {
    // Automatic saves stay app-private and never get a content uri.
    const path = 'file:///data/user/0/com.afinitycode.spool/files/downloads/x.m4a';
    assert.equal(mediaKey(path), path);
  });

  test('nothing is not a key', () => {
    assert.equal(mediaKey(undefined), '');
    assert.equal(mediaKey(''), '');
  });
});

describe('dedupeByFile', () => {
  const uri = 'content://media/external/audio/media/99451';
  const primary = 'content://media/external_primary/audio/media/99451';

  test('collapses a record and the adopted row of the same file', () => {
    // The pair the device actually had: one real record and one row the old
    // scan adopted because the volume names did not match as strings.
    const out = dedupeByFile([
      record('a', { uri: primary, title: 'Kaisi Teri | Music Video', videoId: 'vid1' }),
      record('found:' + uri, { id: 'found:' + uri, uri, title: 'Kaisi Teri _ Music Video' }),
    ]);
    assert.equal(out.length, 1);
  });

  test('keeps the app record, not the filename it was adopted under', () => {
    const out = dedupeByFile([
      record('found:' + uri, { id: 'found:' + uri, uri, title: 'Kaisi Teri _ Music Video' }),
      record('a', { uri: primary, title: 'Kaisi Teri | Music Video', videoId: 'vid1' }),
    ]);
    assert.equal(out[0].title, 'Kaisi Teri | Music Video');
    assert.equal(out[0].videoId, 'vid1', 'the replay rule still has to recognise this video');
  });

  test('fills gaps from whichever row had the fact', () => {
    const out = dedupeByFile([
      record('a', { uri: primary, title: 'Real', videoId: 'vid1', savedAt: 500 }),
      record('found:' + uri, { id: 'found:' + uri, uri, title: 'Real _ file', seconds: 202, bytes: 99, savedAt: 100 }),
    ]);
    assert.equal(out[0].seconds, 202);
    assert.equal(out[0].bytes, 99);
    assert.equal(out[0].savedAt, 100, 'the earlier date is when the file arrived');
  });

  test('two genuinely different files both survive', () => {
    const out = dedupeByFile([
      record('a', { uri: 'content://media/external/audio/media/1' }),
      record('b', { uri: 'content://media/external/audio/media/2' }),
    ]);
    assert.equal(out.length, 2);
  });

  test('failed rows are never merged', () => {
    // Two failures of one video are two things the user asked for, and neither
    // names a file.
    const out = dedupeByFile([
      record('a', { state: 'failed', uri: undefined, videoId: 'v' }),
      record('b', { state: 'failed', uri: undefined, videoId: 'v' }),
    ]);
    assert.equal(out.length, 2);
  });

  test('automatic saves are left alone', () => {
    // They are app-private file:// paths, distinct per job id.
    const out = dedupeByFile([
      record('a', { uri: 'file:///data/x/auto-1.m4a' }),
      record('b', { uri: 'file:///data/x/auto-2.m4a' }),
    ]);
    assert.equal(out.length, 2);
  });

  test('a healthy library is returned untouched', () => {
    const rows = [record('a', { uri: 'content://media/external/audio/media/1' })];
    assert.equal(dedupeByFile(rows), rows, 'same reference, so a clean launch writes nothing');
  });
});

describe('adoptSaved', () => {
  test('adopts a file the library has never seen', () => {
    const out = adoptSaved([], [found('content://1', { artist: 'Someone' })]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'found:content://1');
    assert.equal(out[0].artist, 'Someone');
    assert.equal(out[0].quality, 'audio');
    assert.equal(out[0].state, 'saved');
    // Nothing in a MediaStore row records which video a file came from.
    assert.equal(out[0].videoId, undefined);
  });

  test('a second scan recognises its own work rather than duplicating it', () => {
    const first = adoptSaved([], [found('content://1')]);
    const second = adoptSaved(first, [found('content://1')]);
    assert.equal(second.length, 1);
    // Same array back when nothing was adopted, so no needless re-render.
    assert.equal(second, first);
  });

  test('never hands back a row the user removed', () => {
    // "Stays on this device, only Spool's list of it goes" is a promise, and
    // re-adopting the file on the next launch would break it.
    const out = adoptSaved([], [found('content://1'), found('content://2')], [
      'content://1',
    ]);
    assert.deepEqual(out.map((r) => r.uri), ['content://2']);
  });

  test('matches an existing row on uri, whatever its id', () => {
    const existing = [record('dl-99', { uri: 'content://1' })];
    assert.equal(adoptSaved(existing, [found('content://1')]), existing);
  });

  test('ignores rows that never finished, which have no uri', () => {
    const existing = [record('failed-1', { state: 'failed', uri: undefined })];
    const out = adoptSaved(existing, [found('content://1')]);
    assert.equal(out.length, 2);
  });

  test('skips a scan entry with no uri instead of adopting a dead row', () => {
    assert.deepEqual(adoptSaved([], [found('')]), []);
  });

  test('a filename from an older build is cleaned like anything else', () => {
    const out = adoptSaved([], [
      found('content://1', {
        title: 'Jhol (Official Music Video) [4K]',
        artist: 'Maanu - Topic',
      }),
    ]);
    assert.equal(out[0].title, 'Jhol');
    assert.equal(out[0].artist, 'Maanu');
  });

  test('newest first once anything is adopted', () => {
    const out = adoptSaved(
      [record('old', { uri: 'content://old', savedAt: 10 })],
      [found('content://new', { savedAt: 30 }), found('content://mid', { savedAt: 20 })],
    );
    assert.deepEqual(out.map((r) => r.savedAt), [30, 20, 10]);
  });

  test('labels video and audio without inventing a resolution', () => {
    const out = adoptSaved([], [found('content://v', { audioOnly: false })]);
    // "1080p" here would be a number the user could check and find wrong.
    assert.equal(out[0].quality, 'video');
    assert.equal(out[0].audioOnly, false);
  });

  test('two scan rows sharing a uri collapse to one', () => {
    // This used to produce two rows carrying the same id, which collide as list
    // keys — documented as a gap because `known` is built from `existing` alone
    // and is not updated while adopting, so nothing inside a single scan
    // de-duplicated against itself. `dedupeByFile` now closes it from the other
    // end, by file rather than by bookkeeping.
    const out = adoptSaved([], [found('content://1'), found('content://1')]);
    assert.equal(out.length, 1);
  });
});

describe('downloads', () => {
  test('an unreadable index reads as empty rather than throwing', async () => {
    seed('dl.downloads', '{ not json');
    assert.deepEqual(await loadDownloads(), []);

    seed('dl.downloads', '{"downloads":[]}');
    assert.deepEqual(await loadDownloads(), [], 'an object is not a list');

    faults.read = true;
    assert.deepEqual(await loadDownloads(), []);
  });

  test('keeps the newest 200 and drops the rest', async () => {
    const many = Array.from({ length: 250 }, (_, i) => record(`r${i}`, { savedAt: 250 - i }));
    await saveDownloads(many);
    const stored = JSON.parse(raw('dl.downloads'));
    assert.equal(stored.length, 200);
    assert.equal(stored[0].id, 'r0');
    assert.equal(stored[199].id, 'r199');
  });

  test('a failed write is not fatal', async () => {
    faults.write = true;
    await saveDownloads([record('r1')]);
    assert.equal(raw('dl.downloads'), null);
  });

  test('rows written before names were cleaned read as cleaned', async () => {
    // The library this was built for is the one that has been collecting
    // uploader titles for weeks, so the tidying has to reach what is already
    // stored and not only what arrives next.
    seed(
      'dl.downloads',
      JSON.stringify([
        record('r1', {
          title: 'Tum Hi Ho | Aashiqui 2 (Official Video) [4K]',
          artist: 'Arijit Singh - Topic',
        }),
      ]),
    );
    const [row] = await loadDownloads();
    assert.equal(row.title, 'Tum Hi Ho');
    assert.equal(row.artist, 'Arijit Singh');
    // Everything else about the row is left exactly as it was.
    assert.equal(row.id, 'r1');
    assert.equal(row.quality, 'audio');
  });

  test('a row that needs no cleaning is handed back untouched', async () => {
    seed('dl.downloads', JSON.stringify([record('r1', { title: 'Jhol' })]));
    const [row] = await loadDownloads();
    assert.equal(row.title, 'Jhol');
    assert.equal(row.artist, undefined);
  });
});

describe('settings', () => {
  test('a blob from an older build is missing keys, not broken', async () => {
    seed('dl.settings', JSON.stringify({ enabled: false, after: 7 }));
    const settings = await loadSettings();
    assert.equal(settings.enabled, false);
    assert.equal(settings.after, 7);
    assert.equal(settings.keepAs, DEFAULT_SETTINGS.keepAs);
    assert.equal(settings.instant, DEFAULT_SETTINGS.instant);
  });

  test('corrupt, null and non-object settings all fall back to the defaults', async () => {
    for (const stored of ['{ not json', 'null', '"a string"', '42']) {
      seed('dl.settings', stored);
      assert.deepEqual(await loadSettings(), DEFAULT_SETTINGS, stored);
    }
  });

  test('round-trips', async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, after: 9, keepAs: 'match' });
    const back = await loadSettings();
    assert.equal(back.after, 9);
    assert.equal(back.keepAs, 'match');
  });
});

describe('session', () => {
  test('drops entries that are not ids', async () => {
    seed('dl.session', JSON.stringify({ ids: ['a', 3, null, 'b'], index: 1, at: 12 }));
    assert.deepEqual((await loadSession()).ids, ['a', 'b']);
  });

  test('coerces a numeric field written as a string', async () => {
    seed('dl.session', JSON.stringify({ ids: ['a'], index: '2', at: '5.5' }));
    const session = await loadSession();
    assert.equal(session.index, 2);
    assert.equal(session.at, 5.5);
  });

  test('treats an unusable index or playhead as the start', async () => {
    seed('dl.session', JSON.stringify({ ids: ['a'], index: 'x', at: null }));
    const session = await loadSession();
    assert.equal(session.index, 0);
    assert.equal(session.at, 0);
  });

  test('an empty or missing session is null', async () => {
    assert.equal(await loadSession(), null);
    seed('dl.session', JSON.stringify({ ids: [], index: 0, at: 0 }));
    assert.equal(await loadSession(), null);
    seed('dl.session', '{ not json');
    assert.equal(await loadSession(), null);
  });

  test('a list of only non-ids survives the empty check and comes back empty', () => {
    // The guard runs before the filter, so `{ids: [1, 2]}` passes it and then
    // filters down to nothing. Callers do `if (!tracks.length) return`, so this
    // is inert — but the guard does not mean what it looks like it means.
    seed('dl.session', JSON.stringify({ ids: [1, 2], index: 0, at: 0 }));
    return loadSession().then((session) => {
      assert.notEqual(session, null);
      assert.deepEqual(session.ids, []);
    });
  });

  test('stopping clears the resume point rather than storing an empty one', async () => {
    await saveSession({ ids: ['a'], index: 0, at: 3 });
    assert.notEqual(raw('dl.session'), null);
    await saveSession(null);
    assert.equal(raw('dl.session'), null);
    await saveSession({ ids: ['a'], index: 0, at: 3 });
    await saveSession({ ids: [], index: 0, at: 0 });
    assert.equal(raw('dl.session'), null);
  });
});

describe('forgotten and searches', () => {
  test('forgotten keeps strings only, and caps at 500', async () => {
    seed('dl.forgotten', JSON.stringify(['a', 5, null, 'b']));
    assert.deepEqual(await loadForgotten(), ['a', 'b']);

    await saveForgotten(Array.from({ length: 600 }, (_, i) => `u${i}`));
    assert.equal(JSON.parse(raw('dl.forgotten')).length, 500);
  });

  test('forgetting more than 500 items lets the oldest be re-adopted', async () => {
    // The cap is the only bound on this set, and falling off it means the next
    // launch finds the file and offers it back. 500 removals is a lot; it is
    // still the mechanism by which "removed" can silently stop meaning removed.
    const uris = Array.from({ length: 501 }, (_, i) => `content://${i}`);
    await saveForgotten(uris);
    const kept = await loadForgotten();
    assert.equal(kept.includes('content://500'), false);
    const out = adoptSaved([], [found('content://500')], kept);
    assert.equal(out.length, 1, 'the dropped uri is adopted again');
  });

  test('searches keep the most recent eight', async () => {
    await saveSearches(Array.from({ length: 20 }, (_, i) => `q${i}`));
    assert.deepEqual(JSON.parse(raw('dl.searches')).length, 8);
    seed('dl.searches', JSON.stringify(['a', 7]));
    assert.deepEqual(await loadSearches(), ['a']);
    seed('dl.searches', 'nope');
    assert.deepEqual(await loadSearches(), []);
  });
});

describe('first run', () => {
  test('is false until marked, and false again if the read fails', async () => {
    assert.equal(await hasSeenFirstRun(), false);
    await markFirstRunSeen();
    assert.equal(await hasSeenFirstRun(), true);
    faults.read = true;
    assert.equal(await hasSeenFirstRun(), false);
  });

  test('a failed write means the notice shows again, not a crash', async () => {
    faults.write = true;
    await markFirstRunSeen();
    faults.write = false;
    assert.equal(await hasSeenFirstRun(), false);
  });
});
