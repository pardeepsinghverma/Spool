import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { extractVideoId, isYouTube, isMusicUrl, hostOf, isSignInPage, NAV_SCRIPT } from '../src/browser/youtube.ts';
import { ADBLOCK_SCRIPT } from '../src/browser/adblock.ts';
import { POTOKEN_SCRIPT } from '../src/browser/potoken.ts';
import { BACKGROUND_SCRIPT } from '../src/browser/background.ts';

/**
 * `extractVideoId` decides two things that are easy to get wrong and expensive
 * to get wrong: whether the download button is offered, and which video a play
 * is credited to. A host test that can be fooled by `youtube.com.evil.com` is a
 * download button on an attacker's page; an id matcher that accepts twelve
 * characters attributes watch time to a video that does not exist.
 */

describe('isYouTube', () => {
  test('accepts the hosts the app actually browses', () => {
    for (const url of [
      'https://m.youtube.com',
      'https://m.youtube.com/',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'http://youtu.be/dQw4w9WgXcQ',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      'HTTPS://M.YOUTUBE.COM/watch?v=dQw4w9WgXcQ',
    ]) {
      assert.equal(isYouTube(url), true, url);
    }
  });

  test('is not fooled by a lookalike host', () => {
    for (const url of [
      'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ',
      'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
      'https://evil-youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com.attacker.io',
      'https://fakeyoutu.be/dQw4w9WgXcQ',
      // Userinfo before an @ is the classic one: everything left of the @ is
      // credentials, so this page is served by evil.com.
      'https://m.youtube.com@evil.com/watch?v=dQw4w9WgXcQ',
    ]) {
      assert.equal(isYouTube(url), false, url);
    }
  });

  test('survives junk without throwing', () => {
    for (const url of ['', 'not a url', 'javascript:alert(1)', '//m.youtube.com']) {
      assert.equal(isYouTube(url), false, JSON.stringify(url));
    }
    assert.equal(isYouTube(undefined), false);
    assert.equal(isYouTube(null), false);
  });
});

describe('isMusicUrl', () => {
  test('identifies music.youtube.com URLs accurately', () => {
    for (const url of [
      'https://music.youtube.com',
      'https://music.youtube.com/',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/playlist?list=PL123',
      'https://music.youtube.com/explore',
      'HTTPS://MUSIC.YOUTUBE.COM/watch?v=dQw4w9WgXcQ',
    ]) {
      assert.equal(isMusicUrl(url), true, url);
    }
  });

  test('rejects standard YouTube and malicious host variants', () => {
    for (const url of [
      'https://m.youtube.com',
      'https://www.youtube.com',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://music.youtube.com.evil.com',
      'https://evilmusic.youtube.com',
      'https://not-music.youtube.com',
      '',
      null,
      undefined,
    ]) {
      assert.equal(isMusicUrl(url), false, String(url));
    }
  });
});

describe('extractVideoId', () => {
  test('reads every watch shape YouTube serves', () => {
    const cases = [
      ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/watch?v=dQw4w9WgXcQ#anchor', 'dQw4w9WgXcQ'],
      ['https://youtu.be/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://youtu.be/dQw4w9WgXcQ?t=90', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/shorts/dQw4w9WgXcQ?feature=share', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/embed/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      ['https://m.youtube.com/v/dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
      // Ids use the URL-safe alphabet, hyphens and underscores included.
      ['https://m.youtube.com/watch?v=_-aBcD3fGh1', '_-aBcD3fGh1'],
    ];
    for (const [url, expected] of cases) {
      assert.equal(extractVideoId(url), expected, url);
    }
  });

  test('refuses ids that are not eleven characters', () => {
    // Twelve characters is not a truncated id, it is a different string — and
    // silently taking the first eleven credits watch time to another video.
    assert.equal(extractVideoId('https://m.youtube.com/watch?v=dQw4w9WgXcQX'), null);
    assert.equal(extractVideoId('https://m.youtube.com/watch?v=short'), null);
    assert.equal(extractVideoId('https://m.youtube.com/shorts/dQw4w9WgXcQXY'), null);
  });

  test('returns null off a watch page, and for a hostile host', () => {
    assert.equal(extractVideoId('https://m.youtube.com'), null);
    assert.equal(extractVideoId('https://m.youtube.com/feed/subscriptions'), null);
    assert.equal(extractVideoId('https://evil.com/watch?v=dQw4w9WgXcQ'), null);
    assert.equal(extractVideoId(''), null);
    assert.equal(extractVideoId(null), null);
  });
});

describe('hostOf', () => {
  test('drops the scheme, the path and a www', () => {
    assert.equal(hostOf('https://www.youtube.com/watch?v=x'), 'youtube.com');
    assert.equal(hostOf('https://m.youtube.com'), 'm.youtube.com');
    assert.equal(hostOf('http://example.com:8080/a/b'), 'example.com:8080');
  });

  test('hands back whatever it was given when there is no host to find', () => {
    assert.equal(hostOf('not a url'), 'not a url');
    assert.equal(hostOf(''), '');
    assert.equal(hostOf(null), '');
  });
});

/**
 * `isSignInPage` is what raises FLAG_SECURE, so it is the difference between a
 * password field that cannot be screen-recorded and one that can. It fails in
 * two directions and they do not cost the same: a false positive blocks a
 * screenshot the user wanted, a false negative leaves a credential capturable.
 */
describe('isSignInPage', () => {
  test('matches the Google hosts that ask for a password', () => {
    for (const url of [
      'https://accounts.google.com/',
      'https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn',
      'https://accounts.youtube.com/accounts/SetSID',
      'https://myaccount.google.com/security',
      'https://signin.google.com/',
      'HTTPS://ACCOUNTS.GOOGLE.COM/signin',
      'http://accounts.google.com',
    ]) {
      assert.equal(isSignInPage(url), true, url);
    }
  });

  test('leaves ordinary browsing alone', () => {
    for (const url of [
      'https://m.youtube.com',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.google.com/search?q=x',
      'https://music.youtube.com/',
      '',
      null,
    ]) {
      assert.equal(isSignInPage(url), false, String(url));
    }
  });

  /**
   * The same lookalike trap `isYouTube` guards against, and it matters more
   * here in reverse: a page that only *looks* like the sign-in host must not
   * be trusted to be one, but neither should it silently get the flag and make
   * the app feel broken on a page nobody expects.
   */
  test('is not fooled by a lookalike host', () => {
    for (const url of [
      'https://accounts.google.com.evil.com/signin',
      'https://evil.com/accounts.google.com',
      'https://notaccounts.google.com/',
      'https://accounts.google.co/',
    ]) {
      assert.equal(isSignInPage(url), false, url);
    }
  });

  test('ensures all injected scripts refuse to run on Google sign-in / account domains', () => {
    const scripts = [
      ['NAV_SCRIPT', NAV_SCRIPT],
      ['ADBLOCK_SCRIPT', ADBLOCK_SCRIPT],
      ['POTOKEN_SCRIPT', POTOKEN_SCRIPT],
      ['BACKGROUND_SCRIPT', BACKGROUND_SCRIPT],
    ];
    for (const [name, script] of scripts) {
      assert.match(
        script,
        /accounts\|myaccount\|signin\|passwords\|id/,
        `${name} must guard against executing on Google authentication pages`
      );
    }
  });
});
