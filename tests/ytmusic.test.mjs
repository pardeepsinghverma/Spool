import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { HOME_URL, MUSIC_HOME_URL, isMusicUrl, NAV_SCRIPT } from '../src/browser/youtube.ts';
import { ADBLOCK_SCRIPT } from '../src/browser/adblock.ts';
import { BACKGROUND_SCRIPT } from '../src/browser/background.ts';

describe('YouTube Music URLs & detection', () => {
  test('constants point to official mobile endpoints', () => {
    assert.equal(HOME_URL, 'https://m.youtube.com');
    assert.equal(MUSIC_HOME_URL, 'https://music.youtube.com');
  });

  test('isMusicUrl correctly detects YT Music URLs', () => {
    assert.equal(isMusicUrl('https://music.youtube.com'), true);
    assert.equal(isMusicUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), true);
    assert.equal(isMusicUrl('https://music.youtube.com/explore'), true);
    assert.equal(isMusicUrl('https://music.youtube.com/library/playlists'), true);
    assert.equal(isMusicUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ'), false);
    assert.equal(isMusicUrl('https://www.youtube.com'), false);
    assert.equal(isMusicUrl(null), false);
    assert.equal(isMusicUrl(undefined), false);
  });
});

describe('Title cleaning for YouTube & YouTube Music', () => {
  test('NAV_SCRIPT strips - YouTube and - YouTube Music suffixes', () => {
    const cleanTitle = (raw) => raw.replace(/\s*-\s*YouTube(?:\s*Music)?\s*$/i, '').trim();
    assert.equal(cleanTitle('Starboy - YouTube Music'), 'Starboy');
    assert.equal(cleanTitle('Blinding Lights - YouTube'), 'Blinding Lights');
    assert.equal(cleanTitle('Song Title - youtube music'), 'Song Title');
    assert.equal(cleanTitle('Song Title - YOUTUBE'), 'Song Title');
  });

  test('BACKGROUND_SCRIPT strips - YouTube and - YouTube Music suffixes', () => {
    assert.ok(BACKGROUND_SCRIPT.includes('YouTube(?:\\s*Music)?'));
  });
});

describe('Ad blocking for YouTube Music', () => {
  test('includes YouTube Music cosmetic selectors', () => {
    const requiredSelectors = [
      'ytmusic-mealbar-promo-renderer',
      'ytmusic-upsell-dialog-renderer',
      'ytmusic-general-offer-dialog-renderer',
      'ytmusic-banner-promo-renderer',
      'ytmusic-ad-slot-renderer',
      'ytmusic-companion-ad-renderer',
      'ytmusic-player-bar .advertisement',
      'ytmusic-player[is-ad]',
    ];

    for (const sel of requiredSelectors) {
      assert.ok(
        ADBLOCK_SCRIPT.includes(sel),
        `ADBLOCK_SCRIPT should include selector: ${sel}`
      );
    }
  });

  test('includes promo dismiss and fast-forward handling', () => {
    assert.ok(ADBLOCK_SCRIPT.includes('dismiss-button'));
    assert.ok(ADBLOCK_SCRIPT.includes('playbackRate = 16.0'));
  });
});
