/**
 * The licence token — the one thing the server and the app both have to agree
 * about, byte for byte.
 *
 * A token is two base64url segments joined by a dot:
 *
 *     b64url(payloadJson) "." b64url(derSignature)
 *
 * The signature covers the **ASCII of the first segment**, not the raw JSON.
 * Signing the encoded form is what makes the two implementations agree without
 * either of them having to canonicalise JSON: Kotlin never parses the payload
 * before checking the signature, so key order, whitespace and number formatting
 * cannot drift between a Worker running V8 and a phone running ART.
 *
 * ECDSA P-256, not Ed25519, and the reason is the phone. `Signature.getInstance
 * ("Ed25519")` needs API 33; this module's minSdk is 24, and a licence that
 * silently fails to verify on a four-year-old phone is the worst bug this file
 * could have. P-256 with SHA-256 has been in the JCA since API 11 and is in
 * WebCrypto everywhere.
 */

/** How long past `paidThrough` a token stays good, so a renewal can be late. */
export const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/** Beyond this the app asks for a fresh token; below it, it uses what it has. */
export const REFRESH_AFTER_MS = 12 * 60 * 60 * 1000;

export const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const unb64url = (text) => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/**
 * WebCrypto hands back a raw `r || s` pair; the JCA wants DER. Converting here
 * rather than on the phone is deliberate — this half is reachable by
 * `node --test` and the Kotlin half is not, so the fiddly encoding lives where
 * a test can actually fail on it.
 *
 * DER integers are signed, so a 32-byte half whose top bit is set needs a
 * leading zero or it decodes as negative; a half with leading zero bytes must
 * have them stripped or the length is wrong. Both cases occur roughly half the
 * time and one in 256 of the time respectively, which is exactly often enough
 * to ship and then fail for a few users a week.
 */
export function rawToDer(raw) {
  if (raw.length !== 64) throw new Error(`expected a 64-byte P-256 signature, got ${raw.length}`);
  const int = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    const body = bytes.slice(i);
    const lead = body[0] & 0x80 ? [0x00] : [];
    return [0x02, lead.length + body.length, ...lead, ...body];
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32, 64));
  const body = [...r, ...s];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** Import a PKCS#8 P-256 private key given as base64 (no PEM armour). */
export async function importSigningKey(pkcs8Base64) {
  return crypto.subtle.importKey(
    'pkcs8',
    unb64url(pkcs8Base64.replace(/\s+/g, '')),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/**
 * Mint a token for one device.
 *
 * `exp` is the moment the app stops honouring it, which is the paid-through
 * date plus the grace window — never "now plus a month". A token that outlives
 * the subscription it describes is a free subscription.
 */
export async function mintLicence(key, { device, ref, plan, paidThrough, now }) {
  const payload = {
    v: 1,
    dev: device,
    sub: ref,
    plan,
    exp: paidThrough + GRACE_MS,
    iat: now,
  };
  const head = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(head),
    ),
  );
  return { token: `${head}.${b64url(rawToDer(raw))}`, payload };
}

/**
 * Read a token without trusting it.
 *
 * Used by the app to decide whether it is worth asking for a new one, and by
 * the tests. It deliberately does not verify: the only verification that counts
 * happens in `LicenseGuard.kt`, and a second one in JavaScript would invite
 * someone to believe this file is a security boundary. It is not.
 */
export function readLicence(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  try {
    const json = new TextDecoder().decode(unb64url(token.slice(0, dot)));
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object') return null;
    if (typeof payload.exp !== 'number' || typeof payload.dev !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

/** How far a plan carries a subscriber from the moment it is paid for. */
export function extend(plan, from) {
  const at = new Date(from);
  if (plan === 'annual') at.setUTCFullYear(at.getUTCFullYear() + 1);
  else at.setUTCMonth(at.getUTCMonth() + 1);
  return at.getTime();
}
