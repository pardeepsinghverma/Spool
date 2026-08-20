import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatSize,
  toQuickPicks,
  toFormatRows,
  isAudioPick,
  bestAudio,
  bestVideo,
  heightFromQuality,
  kbpsFromQuality,
} from '../src/browser/formatView.ts';

/**
 * `bestAudio` and `bestVideo` are the two functions that choose without a human
 * present — the instant tap and the replay rule both go through them. A wrong
 * pick here is silent by construction: the file lands, it plays, and nothing
 * ever says it is not what was asked for.
 */

const audio = (id, kbps, extra = {}) => ({
  id,
  kind: 'audio',
  container: 'm4a',
  codec: 'aac',
  kbps,
  muxed: false,
  ...extra,
});

const video = (id, height, extra = {}) => ({
  id,
  kind: 'video',
  height,
  container: 'mp4',
  codec: 'h264',
  muxed: false,
  ...extra,
});

describe('formatSize', () => {
  test('says nothing rather than zero when the size is unknown', () => {
    assert.equal(formatSize(undefined), '—');
    assert.equal(formatSize(null), '—');
    assert.equal(formatSize(0), '—');
    assert.equal(formatSize(-1), '—');
  });

  test('rounds to whole megabytes', () => {
    assert.equal(formatSize(1_000_000), '1 MB');
    assert.equal(formatSize(1_500_000), '2 MB');
    assert.equal(formatSize(499_999), '0 MB');
  });
});

describe('bestAudio', () => {
  test('takes the highest rung at or below the ceiling', () => {
    const formats = [audio('a48', 48), audio('a128', 128), audio('a160', 160)];
    assert.equal(bestAudio(formats, 128).id, 'a128');
    assert.equal(bestAudio(formats, 160).id, 'a160');
    assert.equal(bestAudio(formats, Infinity).id, 'a160');
  });

  test('falls back to the smallest rather than returning nothing', () => {
    // Nothing measurable fits, so a download still happens — the alternative is
    // an automatic save that silently does not occur.
    const formats = [audio('a128', 128), audio('a160', 160)];
    assert.equal(bestAudio(formats, 64).id, 'a128');
  });

  test('reaches an unmeasured rung only once nothing measurable fits', () => {
    const formats = [audio('unknown', undefined), audio('a160', 160)];
    assert.equal(bestAudio(formats, 160).id, 'a160');
    assert.equal(bestAudio(formats, 96).id, 'unknown');
  });

  test('ignores video and answers nothing when there is no audio', () => {
    assert.equal(bestAudio([video('137', 1080)], Infinity), undefined);
    assert.equal(bestAudio([], Infinity), undefined);
  });
});

describe('bestVideo', () => {
  test('takes the tallest at or below the ceiling', () => {
    const formats = [video('720', 720), video('1080', 1080), video('2160', 2160)];
    assert.equal(bestVideo(formats, 1080).id, '1080');
    assert.equal(bestVideo(formats, 1440).id, '1080');
    assert.equal(bestVideo(formats, 4320).id, '2160');
  });

  test('saves something from a 4K-only upload rather than nothing', () => {
    assert.equal(bestVideo([video('2160', 2160), video('4320', 4320)], 1080).id, '2160');
  });

  test('skips video rungs with no height, which are not playable choices', () => {
    assert.equal(bestVideo([video('bad', undefined)], 1080), undefined);
    assert.equal(bestVideo([audio('a128', 128)], 1080), undefined);
  });
});

describe('quality strings', () => {
  test('an unreadable height falls back to 1080, not to nothing', () => {
    assert.equal(heightFromQuality('1080p'), 1080);
    assert.equal(heightFromQuality('2160p'), 2160);
    assert.equal(heightFromQuality('720p60'), 720);
    assert.equal(heightFromQuality('Best available'), 1080);
    assert.equal(heightFromQuality(''), 1080);
  });

  test('an unreadable bitrate means no ceiling, never a low one', () => {
    // The one failure a user would never trace back here is being quietly
    // capped, so an unparseable setting has to mean *more*.
    assert.equal(kbpsFromQuality('160 kbps'), 160);
    assert.equal(kbpsFromQuality('96 kbps'), 96);
    assert.equal(kbpsFromQuality('128kbps'), 128);
    assert.equal(kbpsFromQuality('Best available'), Infinity);
    assert.equal(kbpsFromQuality(''), Infinity);
  });
});

describe('toQuickPicks', () => {
  test('never offers the same id twice, even when Best is the only rung', () => {
    // Best and the explicit row are the same format here, and two rows sharing
    // an id would make one of them un-selectable.
    const picks = toQuickPicks([video('2160', 2160), audio('a128', 128)]);
    const ids = picks.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, ids.join(','));
    assert.equal(picks.length, 3);
  });

  test('offers audio alone when the video list is empty', () => {
    const picks = toQuickPicks([audio('a128', 128)]);
    assert.equal(picks.length, 1);
    assert.equal(picks[0].title, 'Audio only');
  });

  test('offers nothing at all when there is nothing to offer', () => {
    assert.deepEqual(toQuickPicks([]), []);
    assert.deepEqual(toQuickPicks([video('novideo', undefined)]), []);
  });

  test('prefers a 1080p rung for the explicit row when one exists', () => {
    const picks = toQuickPicks([video('2160', 2160), video('1080', 1080)]);
    assert.equal(picks[0].title, 'Best');
    assert.equal(picks[1].title, '1080p');
    assert.equal(picks[1].id, '1080');
  });
});

describe('toFormatRows', () => {
  test('marks a rung too large for the space left', () => {
    const rows = toFormatRows(
      [video('a', 1080, { size: 900 }), video('b', 720, { size: 100 })],
      500,
    );
    assert.equal(rows[0].tooLarge, true);
    assert.equal(rows[1].tooLarge, false);
  });

  test('claims nothing about space when free space is unknown', () => {
    const rows = toFormatRows([video('a', 1080, { size: 9e15 })], undefined);
    assert.equal(rows[0].tooLarge, false);
  });

  test('says whether a rung carries its own audio', () => {
    const rows = toFormatRows([
      video('muxed', 720, { muxed: true, fps: 30 }),
      video('split', 1080, { fps: 60 }),
    ]);
    assert.equal(rows[0].note, '30 fps · with audio');
    assert.equal(rows[1].note, '60 fps · video only');
  });
});

describe('isAudioPick', () => {
  test('sees through the :explicit suffix the sheet adds', () => {
    const formats = [video('137', 1080), audio('140', 128)];
    assert.equal(isAudioPick('140', formats), true);
    assert.equal(isAudioPick('137:explicit', formats), false);
    assert.equal(isAudioPick('140:explicit', formats), true);
    assert.equal(isAudioPick('missing', formats), false);
  });
});
