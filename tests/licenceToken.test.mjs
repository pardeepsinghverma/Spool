import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto, createPublicKey, verify as nodeVerify } from 'node:crypto';

import {
  GRACE_MS,
  b64url,
  extend,
  mintLicence,
  rawToDer,
  readLicence,
  unb64url,
} from '../server/src/license.js';

/**
 * The licence token, from both ends.
 *
 * The claim every case here serves is the one this project cannot test any
 * other way: **a token minted by the Worker verifies on the phone.** Kotlin is
 * not reachable from `node --test`, so the proxy is Node's own verifier, which
 * wants exactly what the JCA wants — an X.509 SubjectPublicKeyInfo public key
 * and a DER-encoded ECDSA signature. WebCrypto produces neither of those by
 * itself, and the gap between them is `rawToDer`.
 *
 * That gap is the reason this file exists rather than being folded into a
 * server-side smoke test. A raw `r || s` signature is accepted by WebCrypto's
 * own verifier and refused by every JCA on earth, so a round trip that stayed
 * inside WebCrypto would pass while shipping a build in which no licence has
 * ever worked.
 */

const NOW = 1_780_000_000_000;
const DEVICE = 'Zm9vYmFyYmF6cXV4MDAx';

const keypair = () =>
  webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

/** The public half in the form both Java and Node want it. */
async function spki(pair) {
  const raw = Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  return createPublicKey({ key: raw, format: 'der', type: 'spki' });
}

async function signingKey(pair) {
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  return webcrypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

describe('a minted token verifies the way Android will verify it', () => {
  test('Node — which wants DER, exactly as the JCA does — accepts the signature', async () => {
    const pair = await keypair();
    const { token } = await mintLicence(await signingKey(pair), {
      device: DEVICE,
      ref: 'sub_test',
      plan: 'annual',
      paidThrough: NOW + 86_400_000,
      now: NOW,
    });

    const [head, sig] = token.split('.');
    const ok = nodeVerify('sha256', Buffer.from(head, 'ascii'), await spki(pair), unb64url(sig));
    assert.equal(ok, true, 'a DER signature over the ASCII of the first segment');
  });

  test('the signature covers the encoded head, so re-ordering the JSON cannot forge one', async () => {
    const pair = await keypair();
    const { token } = await mintLicence(await signingKey(pair), {
      device: DEVICE,
      ref: 'sub_test',
      plan: 'monthly',
      paidThrough: NOW,
      now: NOW,
    });

    const [head, sig] = token.split('.');
    const payload = JSON.parse(new TextDecoder().decode(unb64url(head)));
    // Same facts, different key order — a verifier that parsed before checking
    // would accept this, and Kotlin deliberately does not parse first.
    const reordered = b64url(
      new TextEncoder().encode(JSON.stringify({ exp: payload.exp, dev: payload.dev })),
    );
    const ok = nodeVerify(
      'sha256',
      Buffer.from(reordered, 'ascii'),
      await spki(pair),
      unb64url(sig),
    );
    assert.equal(ok, false);
  });

  test('a token signed by another key is refused', async () => {
    const mine = await keypair();
    const theirs = await keypair();
    const { token } = await mintLicence(await signingKey(theirs), {
      device: DEVICE,
      ref: '',
      plan: 'annual',
      paidThrough: NOW,
      now: NOW,
    });
    const [head, sig] = token.split('.');
    assert.equal(
      nodeVerify('sha256', Buffer.from(head, 'ascii'), await spki(mine), unb64url(sig)),
      false,
    );
  });

  test('a hundred round trips, because the DER edge cases are probabilistic', async () => {
    const pair = await keypair();
    const key = await signingKey(pair);
    const pub = await spki(pair);
    for (let i = 0; i < 100; i++) {
      const { token } = await mintLicence(key, {
        device: DEVICE,
        ref: `sub_${i}`,
        plan: 'monthly',
        paidThrough: NOW + i,
        now: NOW,
      });
      const [head, sig] = token.split('.');
      assert.equal(
        nodeVerify('sha256', Buffer.from(head, 'ascii'), pub, unb64url(sig)),
        true,
        `round trip ${i} — a high bit set in r or s is a one-in-two event, so a ` +
          'missing leading zero shows up here and nowhere else',
      );
    }
  });
});

describe('rawToDer', () => {
  test('a half whose top bit is set gains a leading zero, or it decodes negative', () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; // r's top bit
    raw[32] = 0x01; // s stays positive
    const der = rawToDer(raw);
    assert.equal(der[0], 0x30, 'SEQUENCE');
    assert.equal(der[2], 0x02, 'INTEGER r');
    assert.equal(der[3], 33, 'r is padded to 33 bytes');
    assert.equal(der[4], 0x00, 'with the pad byte first');
  });

  test('leading zero bytes are stripped, because DER integers are minimal', () => {
    const raw = new Uint8Array(64);
    raw[31] = 0x07; // r is just 7
    raw[63] = 0x09; // s is just 9
    const der = rawToDer(raw);
    assert.deepEqual([...der], [0x30, 0x06, 0x02, 0x01, 0x07, 0x02, 0x01, 0x09]);
  });

  test('an all-zero half keeps one byte rather than becoming empty', () => {
    const der = rawToDer(new Uint8Array(64));
    assert.deepEqual([...der], [0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x00]);
  });

  test('anything that is not 64 bytes is a bug, not a signature', () => {
    assert.throws(() => rawToDer(new Uint8Array(63)), /64-byte/);
    assert.throws(() => rawToDer(new Uint8Array(70)), /64-byte/);
  });
});

describe('what the token says', () => {
  test('it expires at paid-through plus the grace window, never at paid-through', async () => {
    const pair = await keypair();
    const paidThrough = NOW + 30 * 86_400_000;
    const { payload } = await mintLicence(await signingKey(pair), {
      device: DEVICE,
      ref: '',
      plan: 'monthly',
      paidThrough,
      now: NOW,
    });
    assert.equal(payload.exp, paidThrough + GRACE_MS);
    assert.ok(payload.exp > paidThrough, 'a late renewal must not lock the user out at midnight');
  });

  test('it names the device it was minted for', async () => {
    const pair = await keypair();
    const { payload } = await mintLicence(await signingKey(pair), {
      device: DEVICE,
      ref: '',
      plan: 'annual',
      paidThrough: NOW,
      now: NOW,
    });
    assert.equal(payload.dev, DEVICE, 'copying the file to another phone must not carry the licence');
  });
});

describe('readLicence refuses to guess', () => {
  test('garbage is null rather than a throw — it runs on the failure path', () => {
    assert.equal(readLicence(null), null);
    assert.equal(readLicence(''), null);
    assert.equal(readLicence('nodot'), null);
    assert.equal(readLicence('.'), null);
    assert.equal(readLicence('abc.'), null);
    assert.equal(readLicence('.abc'), null);
    assert.equal(readLicence(b64url(new TextEncoder().encode('not json')) + '.x'), null);
  });

  test('a payload missing an expiry is not a licence', () => {
    const head = b64url(new TextEncoder().encode(JSON.stringify({ dev: DEVICE })));
    assert.equal(readLicence(`${head}.sig`), null);
  });

  test('a well-formed payload reads back', () => {
    const head = b64url(new TextEncoder().encode(JSON.stringify({ dev: DEVICE, exp: NOW })));
    assert.deepEqual(readLicence(`${head}.sig`), { dev: DEVICE, exp: NOW });
  });
});

describe('extend', () => {
  test('a month is a calendar month, not thirty days', () => {
    const jan31 = Date.UTC(2026, 0, 31);
    assert.equal(extend('monthly', jan31), new Date(Date.UTC(2026, 2, 3)).getTime());
  });

  test('a year is a calendar year', () => {
    const start = Date.UTC(2026, 5, 15);
    assert.equal(extend('annual', start), Date.UTC(2027, 5, 15));
  });

  test('an unknown plan extends by a month rather than by nothing', () => {
    const start = Date.UTC(2026, 5, 15);
    assert.equal(extend('whatever', start), Date.UTC(2026, 6, 15));
  });
});
