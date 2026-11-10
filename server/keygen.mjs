/**
 * Mint the licence signing keypair. Run once, ever.
 *
 *   node server/keygen.mjs
 *
 * The private half goes into Cloudflare as a secret and must never be committed.
 * The public half is compiled into every APK — it is not a secret and belongs in
 * the tree, because a public key that lives in a private file is a public key
 * that gets lost and takes every issued licence with it.
 *
 * Losing the private key is not recoverable: every token in the field keeps
 * verifying until it expires, and no new one can be signed. Keep a copy
 * somewhere that is not this laptop.
 */
import { webcrypto } from 'node:crypto';

const pair = await webcrypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const b64 = async (format, key) =>
  Buffer.from(await webcrypto.subtle.exportKey(format, key)).toString('base64');

const priv = await b64('pkcs8', pair.privateKey);
const pub = await b64('spki', pair.publicKey);

console.log('\n--- PRIVATE (Cloudflare secret, never commit) -------------------\n');
console.log('npx wrangler secret put LICENCE_SIGNING_KEY');
console.log('  paste:', priv);
console.log('\n--- PUBLIC (goes in modules/ytdlp/android/build.gradle) ---------\n');
console.log(`def licenceKey = project.findProperty('SPOOL_LICENCE_KEY') ?: '${pub}'`);
console.log('');
