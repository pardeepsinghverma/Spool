import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { remember, tokenFor, hasToken, reset, TTL_MS } from '../src/core/tokens.ts';

/**
 * The per-video PO token store.
 *
 * Every case here is really the same claim: **absent beats wrong**. yt-dlp
 * without a token walks the open clients and may still succeed; yt-dlp with a
 * token belonging to a different video pins itself to the web client and gets a
 * 403 that reads exactly like a refused client. So the interesting behaviour is
 * all about what this refuses to hand back.
 */

const NOW = 1_700_000_000_000;

beforeEach(reset);

describe('a token belongs to one video', () => {
  test('a token minted for one video is never offered for another', () => {
    remember('aaa', { poToken: 'tok-a', visitorData: 'v', mintedAt: NOW });
    assert.equal(tokenFor('aaa', NOW).poToken, 'tok-a');
    assert.deepEqual(tokenFor('bbb', NOW), {}, 'B gets nothing rather than A’s token');
  });

  test('two videos keep their own', () => {
    remember('aaa', { poToken: 'tok-a', mintedAt: NOW });
    remember('bbb', { poToken: 'tok-b', mintedAt: NOW });
    assert.equal(tokenFor('aaa', NOW).poToken, 'tok-a');
    assert.equal(tokenFor('bbb', NOW).poToken, 'tok-b');
  });

  test('no video id means no token, rather than any token', () => {
    remember('aaa', { poToken: 'tok-a', mintedAt: NOW });
    assert.deepEqual(tokenFor(null, NOW), {});
    assert.deepEqual(tokenFor(undefined, NOW), {});
    assert.deepEqual(tokenFor('', NOW), {});
  });

  test('an unnamed report is dropped rather than filed under nothing', () => {
    remember('', { poToken: 'orphan', mintedAt: NOW });
    assert.deepEqual(tokenFor('', NOW), {});
  });
});

describe('the two halves arrive separately', () => {
  test('visitorData first, then the token, merge into one entry', () => {
    // This is the real sequence: ytcfg gives visitorData as the page loads and
    // the token only turns up once a player response does.
    remember('aaa', { visitorData: 'visitor', mintedAt: NOW });
    assert.deepEqual(tokenFor('aaa', NOW), { poToken: undefined, visitorData: 'visitor' });

    remember('aaa', { poToken: 'tok', mintedAt: NOW + 1000 });
    assert.deepEqual(tokenFor('aaa', NOW), { poToken: 'tok', visitorData: 'visitor' });
  });

  test('a later empty report does not erase what is held', () => {
    remember('aaa', { poToken: 'tok', visitorData: 'visitor', mintedAt: NOW });
    remember('aaa', { poToken: '', visitorData: '', mintedAt: NOW + 1000 });
    assert.equal(tokenFor('aaa', NOW).poToken, 'tok');
    assert.equal(tokenFor('aaa', NOW).visitorData, 'visitor');
  });

  test('a fresh token replaces the old one for the same video', () => {
    remember('aaa', { poToken: 'old', mintedAt: NOW });
    remember('aaa', { poToken: 'new', mintedAt: NOW + 1000 });
    assert.equal(tokenFor('aaa', NOW).poToken, 'new');
  });
});

describe('going stale', () => {
  test('a token past its life is not offered', () => {
    remember('aaa', { poToken: 'tok', mintedAt: NOW });
    assert.equal(tokenFor('aaa', NOW + TTL_MS - 1).poToken, 'tok');
    assert.deepEqual(tokenFor('aaa', NOW + TTL_MS + 1), {}, 'expired');
  });

  test('an expired entry is dropped, not merely hidden', () => {
    remember('aaa', { poToken: 'tok', mintedAt: NOW });
    tokenFor('aaa', NOW + TTL_MS + 1);
    // Re-asking at a time it *would* have been valid still gets nothing.
    assert.deepEqual(tokenFor('aaa', NOW), {});
  });

  test('hasToken agrees with tokenFor', () => {
    remember('aaa', { visitorData: 'v', mintedAt: NOW });
    assert.equal(hasToken('aaa', NOW), false, 'visitorData alone is not a token');
    remember('aaa', { poToken: 'tok', mintedAt: NOW });
    assert.equal(hasToken('aaa', NOW), true);
    assert.equal(hasToken('aaa', NOW + TTL_MS + 1), false);
  });
});

describe('staying bounded', () => {
  test('a long browsing session evicts the least recently touched', () => {
    for (let i = 0; i < 70; i++) remember(`v${i}`, { poToken: `t${i}`, mintedAt: NOW });

    assert.deepEqual(tokenFor('v0', NOW), {}, 'the oldest went');
    assert.equal(tokenFor('v69', NOW).poToken, 't69', 'the newest stayed');
  });

  test('touching an entry saves it from eviction', () => {
    remember('keep', { poToken: 'tok', mintedAt: NOW });
    for (let i = 0; i < 40; i++) remember(`v${i}`, { poToken: `t${i}`, mintedAt: NOW });
    // Re-report it, as a page revisit would.
    remember('keep', { poToken: 'tok', mintedAt: NOW });
    for (let i = 40; i < 80; i++) remember(`v${i}`, { poToken: `t${i}`, mintedAt: NOW });

    assert.equal(tokenFor('keep', NOW).poToken, 'tok');
  });
});
