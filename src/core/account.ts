import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import YtDlp from '../../modules/ytdlp';
import * as log from './log';

/**
 * The Spool account: an email, a password, and the session the server hands
 * back for them.
 *
 * It exists so that a subscription follows a person rather than a phone. Before
 * this, a licence was bound to one `ANDROID_ID` hash and the only way to carry
 * it to a new device was a support conversation. The token format did not have
 * to change for that — it is still minted per device and `LicenseGuard` still
 * verifies it offline — what changed is *who* the server will mint one for: any
 * device holding a session for an account that has paid.
 *
 * This module owns three things and each has a rule attached:
 *
 *  - **The session.** Opaque, persisted in AsyncStorage, sent as a Bearer token
 *    and never logged. A `401 {"error":"signed out"}` from any authenticated
 *    route means the server has already ended it (signed out elsewhere,
 *    revoked by the owner), so the only honest response is to drop it here too
 *    and forget the licence it was paying for.
 *  - **The request helper** that licence, payments and the play lock share, so
 *    that rule — and its twin for `403 {"error":"blocked"}` — is written once.
 *  - **The last time the server answered at all.** The play lock's offline
 *    grace is measured from it; see `core/playLock.ts`.
 *
 * **Server failures are "no news", here exactly as in `license.ts`.** A throw,
 * a timeout, a 5xx or a body that does not parse must never sign anybody out.
 * Only the two specific, parsed answers above do, which is why a 401 from a
 * captive portal's HTML page is treated as the network being broken rather than
 * as the session being gone.
 */

const KEY_ACCOUNT = 'dl.account';
const KEY_CONTACT = 'dl.serverContact';

/** How long an ordinary request may hang before the app stops waiting for it. */
export const TIMEOUT_MS = 8000;

export type Account = {
  /** Null when signed out. Opaque; the server decides what it means. */
  session: string | null;
  email: string | null;
};

const SIGNED_OUT: Account = { session: null, email: null };

let cached: Account = SIGNED_OUT;
let loading: Promise<void> | null = null;
/** Epoch ms of the last response the server actually produced; 0 when never. */
let lastContact = 0;
const listeners = new Set<() => void>();

/**
 * What else has to happen when a session ends. `license.ts` registers here to
 * drop its cached status and paid-through date, rather than this file importing it — licence already
 * imports this one, and a cycle between the two would be a module whose exports
 * are undefined for whichever of them the bundler evaluates first.
 */
const endedHandlers = new Set<(why: 'signed-out' | 'blocked' | 'logout') => void>();
export const onSessionEnded = (fn: (why: 'signed-out' | 'blocked' | 'logout') => void) => {
  endedHandlers.add(fn);
  return () => endedHandlers.delete(fn);
};

const notify = () => listeners.forEach((fn) => fn());

/**
 * Read the stored session once. Every request awaits this, so a sync fired
 * from the boot effect cannot race the read and go out unauthenticated.
 *
 * The read is memoised; the *answer* is not. It resolves to `cached` as it
 * stands when awaited, because a sign-in after boot replaces `cached` — and a
 * promise that had captured the boot-time value went on resolving to "signed
 * out" for the rest of the run, so every authenticated request after signing
 * in went out with no session at all.
 */
export async function loadAccount(): Promise<Account> {
  if (!loading) {
    loading = (async () => {
      try {
        const [rawAccount, rawContact] = await Promise.all([
          AsyncStorage.getItem(KEY_ACCOUNT),
          AsyncStorage.getItem(KEY_CONTACT),
        ]);
        const parsed = rawAccount ? JSON.parse(rawAccount) : null;
        // A blob from an older or damaged write reads as signed out, never as a
        // throw: the app must start either way, and signing in again is cheap.
        if (parsed && typeof parsed.session === 'string' && parsed.session) {
          cached = {
            session: parsed.session,
            email: typeof parsed.email === 'string' ? parsed.email : null,
          };
        }
        const contact = Number(rawContact);
        if (Number.isFinite(contact) && contact > 0) lastContact = contact;
      } catch {
        // Same reading as a missing blob.
      }
      notify();
    })();
  }
  await loading;
  return cached;
}

export const account = (): Account => cached;
export const signedIn = (): boolean => Boolean(cached.session);
export const lastServerContact = (): number => lastContact;

async function persist(next: Account) {
  cached = next;
  notify();
  try {
    if (next.session) await AsyncStorage.setItem(KEY_ACCOUNT, JSON.stringify(next));
    else await AsyncStorage.removeItem(KEY_ACCOUNT);
  } catch {
    // The session still works for this run. Losing it at the next launch costs
    // a sign-in, which is not worth a crash on the way there.
  }
}

function markContact(now = Date.now()) {
  lastContact = now;
  void AsyncStorage.setItem(KEY_CONTACT, String(now)).catch(() => {});
}

/** Where to ask, and under which device id. Both come from the native side. */
export function endpoint(): { server: string; device: string } {
  try {
    const status = YtDlp.licenceStatus();
    return { server: status.server ?? '', device: status.device ?? '' };
  } catch {
    return { server: '', device: '' };
  }
}

/**
 * A name a person would recognise in their device list — "Samsung SM-A515F".
 * It is a label and nothing more: the server keys devices on the hash.
 */
export function deviceLabel(): string {
  const c = (Platform as unknown as { constants?: Record<string, unknown> }).constants ?? {};
  const maker = typeof c.Manufacturer === 'string' ? c.Manufacturer : '';
  const model = typeof c.Model === 'string' ? c.Model : '';
  const cap = maker ? maker[0].toUpperCase() + maker.slice(1) : '';
  // Many makers repeat themselves in the model string ("Google Pixel 8").
  const label = model.toLowerCase().startsWith(maker.toLowerCase()) ? model : `${cap} ${model}`;
  return label.trim() || 'Android device';
}

/**
 * Every way a request can come back, told apart.
 *
 * `offline` covers everything that is not an answer from the server: no
 * network, a timeout, a 5xx, a body that is not JSON. Callers treat it as no
 * news. `refused` is a real answer the caller has to read (`409`, `429`, a
 * `400` naming the field).
 */
export type Reply =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'refused'; status: number; body: Record<string, unknown> }
  | { kind: 'signed-out' }
  | { kind: 'blocked' }
  | { kind: 'offline' }
  | { kind: 'unconfigured' };

type RequestOptions = {
  method?: 'GET' | 'POST';
  /** A plain object is sent as JSON; a FormData is sent as multipart. */
  body?: Record<string, unknown> | FormData;
  /** Send the Bearer session. Refuses without asking when there is none. */
  auth?: boolean;
  timeoutMs?: number;
};

/**
 * The one request function for the licence server.
 *
 * Exported for `license.ts`, `payments.ts` and `playLock.ts`, which is the
 * point of it: the 401/403 rule lives here and nowhere else.
 */
/** The part of a fetch `Response` that `request` reads. */
type Answer = { status: number; ok: boolean; json: () => Promise<unknown> };

/**
 * A multipart POST through `XMLHttpRequest`, not `fetch`.
 *
 * Expo installs its own `fetch` as the global one, and it refuses React
 * Native's `{uri, name, type}` file part with "Unsupported FormDataPart
 * implementation" — thrown before a byte is sent, so on the emulator every
 * screenshot claim read as "could not reach Spool". React Native's XHR is the
 * layer that knows how to stream a `file://` URI into a multipart body.
 */
function upload(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: FormData,
  signal: AbortSignal,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.onload = () =>
      resolve({
        status: xhr.status,
        ok: xhr.status >= 200 && xhr.status < 300,
        json: async () => JSON.parse(xhr.responseText),
      });
    xhr.onerror = () => reject(new Error('network error'));
    xhr.ontimeout = () => reject(new Error('timed out'));
    signal.addEventListener('abort', () => {
      xhr.abort();
      reject(new Error('aborted'));
    });
    xhr.send(body);
  });
}

export async function request(path: string, opts: RequestOptions = {}): Promise<Reply> {
  const { server } = endpoint();
  if (!server) return { kind: 'unconfigured' };

  const headers: Record<string, string> = { accept: 'application/json' };
  let session: string | null = null;
  if (opts.auth) {
    session = (await loadAccount()).session;
    if (!session) return { kind: 'unconfigured' };
    headers.authorization = `Bearer ${session}`;
  }

  let body: string | FormData | undefined;
  if (opts.body instanceof Object && typeof FormData !== 'undefined' && opts.body instanceof FormData) {
    // No content-type: fetch writes the multipart boundary itself, and a
    // hand-set header without one is a body the server cannot split.
    body = opts.body;
  } else if (opts.body) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  // No AbortSignal.timeout: it is not in the Hermes runtime this app ships on.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? TIMEOUT_MS);
  let response: Answer;
  try {
    const url = `${server}${path}`;
    const method = opts.method ?? (body ? 'POST' : 'GET');
    response =
      typeof body === 'object'
        ? await upload(url, method, headers, body, controller.signal)
        : await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (e) {
    log.debug('account', 'could not reach the server', { path, ...log.describe(e) });
    return { kind: 'offline' };
  } finally {
    clearTimeout(timer);
  }

  let parsed: Record<string, unknown>;
  try {
    const value = await response.json();
    if (!value || typeof value !== 'object') throw new Error('not an object');
    parsed = value as Record<string, unknown>;
  } catch {
    // A proxy's HTML, a truncated body: not an answer from our server.
    log.warn('account', 'unreadable answer', { path, status: response.status });
    return { kind: 'offline' };
  }

  if (response.status >= 500) {
    log.warn('account', 'server failed', { path, status: response.status, error: parsed.error });
    // One 5xx is a sentence the user needs — `503 payments not configured` —
    // so a named error is handed back as a refusal. Either way it is not
    // counted as contact, and nothing below can sign anybody out on it.
    return typeof parsed.error === 'string'
      ? { kind: 'refused', status: response.status, body: parsed }
      : { kind: 'offline' };
  }

  // The server answered, which is what the play lock's grace is measured from.
  markContact();

  if (response.ok) return { kind: 'ok', body: parsed };

  // Only for a session we actually sent, and only for the exact answer: a
  // login's 401 is a wrong password, not a session ending.
  if (session && cached.session === session) {
    if (response.status === 401 && parsed.error === 'signed out') {
      await endSession('signed-out');
      return { kind: 'signed-out' };
    }
    if (response.status === 403 && parsed.error === 'blocked') {
      await endSession('blocked');
      return { kind: 'blocked' };
    }
  }
  return { kind: 'refused', status: response.status, body: parsed };
}

async function endSession(why: 'signed-out' | 'blocked' | 'logout') {
  log.info('account', 'session ended', { why });
  await persist(SIGNED_OUT);
  // Here rather than only in the handler `license.ts` registers: the licence
  // must go with the session even in a bundle where nothing has imported
  // that file yet, and the native call is idempotent.
  try {
    YtDlp.forgetLicence();
  } catch {}
  endedHandlers.forEach((fn) => {
    try {
      fn(why);
    } catch {}
  });
  if (why === 'blocked') openAccount({ blocked: true });
}

/**
 * The server's refusal, in words a person can act on. Unknown errors get the
 * generic line rather than the raw string — "bad device" means nothing to the
 * user and everything to the log, which already has it.
 */
export function explainAuthError(reply: Reply): string {
  switch (reply.kind) {
    case 'offline':
      return 'Could not reach Spool. Check your connection and try again.';
    case 'unconfigured':
      return 'This build is not connected to a Spool server.';
    case 'blocked':
      return 'This account has been blocked. Contact support on WhatsApp.';
    case 'signed-out':
      return 'You have been signed out. Sign in again.';
    case 'ok':
      return '';
  }
  const error = String(reply.body.error ?? '');
  switch (error) {
    case 'bad email':
      return 'That does not look like an email address.';
    case 'weak password':
      return 'Use a password of at least 8 characters.';
    case 'email taken':
      return 'There is already an account with that email. Sign in instead.';
    case 'wrong email or password':
      return 'That email and password do not match.';
    case 'blocked':
      return 'This account has been blocked. Contact support on WhatsApp.';
    case 'slow down': {
      const wait = Number(reply.body.retryAfter);
      return Number.isFinite(wait) && wait > 0
        ? `Too many tries. Wait ${Math.ceil(wait / 60) <= 1 ? 'a minute' : `${Math.ceil(wait / 60)} minutes`} and try again.`
        : 'Too many tries. Wait a minute and try again.';
    }
    default:
      return 'Something went wrong on our side. Try again in a moment.';
  }
}

/** Register or sign in. Resolves to null on success, or to the copy to show. */
async function authenticate(
  path: '/v1/auth/register' | '/v1/auth/login',
  email: string,
  password: string,
): Promise<string | null> {
  const { device } = endpoint();
  const address = email.trim().toLowerCase();
  const reply = await request(path, {
    method: 'POST',
    body: { email: address, password, device, label: deviceLabel() },
  });
  if (reply.kind !== 'ok') return explainAuthError(reply);

  const session = reply.body.session;
  if (typeof session !== 'string' || !session) {
    return 'Something went wrong on our side. Try again in a moment.';
  }
  const who = (reply.body.account as { email?: unknown } | undefined)?.email;
  await persist({ session, email: typeof who === 'string' ? who : address });
  log.info('account', path.endsWith('register') ? 'account created' : 'signed in');
  return null;
}

export const register = (email: string, password: string) =>
  authenticate('/v1/auth/register', email, password);
export const login = (email: string, password: string) =>
  authenticate('/v1/auth/login', email, password);

/**
 * Sign out on this device.
 *
 * Local first, then the server, and the server's answer is not waited on for
 * anything: a user who taps "Sign out" on a train is signed out, whether or not
 * the request reaches anyone. The licence goes with the session — it was minted
 * because this account paid, and leaving it behind would let one subscription
 * be carried to any number of accounts one sign-out at a time.
 */
export async function logout(): Promise<void> {
  const session = cached.session;
  if (!session) return;
  const { server } = endpoint();
  if (server) {
    void fetch(`${server}/v1/auth/logout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session}` },
    }).catch(() => {});
  }
  await endSession('logout');
}

export type AccountDevice = { label: string; lastSeen: number; city: string; current: boolean };
export type AccountDetails = {
  email: string;
  entitled: boolean;
  plan: string;
  paidThrough: number;
  devices: AccountDevice[];
};

/** `/v1/account`, shaped. Null when it could not be had, for any reason. */
export async function fetchAccount(): Promise<AccountDetails | null> {
  const reply = await request('/v1/account', { auth: true });
  if (reply.kind !== 'ok') return null;
  const b = reply.body;
  const devices = Array.isArray(b.devices) ? b.devices : [];
  return {
    email: String(b.email ?? cached.email ?? ''),
    entitled: b.entitled === true,
    plan: typeof b.plan === 'string' ? b.plan : '',
    paidThrough: Number(b.paidThrough) || 0,
    devices: devices
      .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
      .map((d) => ({
        label: String(d.label ?? 'Unknown device'),
        lastSeen: Number(d.lastSeen) || 0,
        city: typeof d.city === 'string' ? d.city : '',
        current: d.current === true,
      })),
  };
}

/** Re-renders a screen when the session changes. */
export function useAccount(): Account {
  const [value, setValue] = useState<Account>(cached);
  useEffect(() => {
    const fn = () => setValue(cached);
    listeners.add(fn);
    // A screen mounted before the boot read finished would otherwise show
    // "Sign in" to someone who is signed in until the next change.
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return value;
}

/**
 * How the account sheet is opened from a surface that does not own it — same
 * registry shape as `setPaywallOpener`. `next: 'paywall'` sends a user who
 * signed in *in order to pay* straight back to the paywall; `blocked` opens it
 * on the explanation instead of a form.
 */
export type AccountIntent = { next?: 'paywall'; reason?: string; blocked?: boolean; mode?: 'signin' | 'create' };
let opener: ((intent: AccountIntent) => void) | null = null;
export const setAccountOpener = (fn: ((intent: AccountIntent) => void) | null) => {
  opener = fn;
};
export const openAccount = (intent: AccountIntent = {}) => opener?.(intent);

/** Test seam — the store outlives a screen, so it must be resettable. */
export function reset() {
  cached = SIGNED_OUT;
  loading = null;
  lastContact = 0;
  listeners.clear();
  opener = null;
}
