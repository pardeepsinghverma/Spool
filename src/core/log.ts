/**
 * The flight recorder.
 *
 * Every other diagnostic in this app has been a `console.log` that only exists
 * while a laptop is plugged in. That is the wrong shape for the failures that
 * actually matter here: a download that dies in a pocket, a page that stops
 * playing with the screen off, a crash that takes the process with it. By the
 * time anyone asks "why", logcat has rotated and the evidence is gone.
 *
 * So this keeps a bounded ring of structured entries, survives the process that
 * wrote it, and can be handed to a person as a text file.
 *
 * Three rules it must never break, because a diagnostic that damages the thing
 * it is diagnosing is worse than none:
 *
 *  1. **It never throws.** Every public entry point is total. A logger that can
 *     fail turns a recoverable bug into a crash, and it does so on the exact
 *     path that was already going wrong.
 *  2. **It never blocks.** Writes are debounced and fire-and-forget. The one
 *     exception is `flush`, which callers await deliberately.
 *  3. **It never records a secret.** `redact` runs over every `data` object; a
 *     PO token is a credential and this file ends up in `Downloads/`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type Level = 'debug' | 'info' | 'warn' | 'error';

export type Entry = {
  /** Epoch ms. */
  t: number;
  level: Level;
  /** The subsystem: `download`, `engine`, `player`, `boot`, `page`... */
  scope: string;
  msg: string;
  /** Correlation id, shared by every entry of one `flow`. */
  flow?: string;
  /** Ms since that flow began. Absent outside a flow. */
  ms?: number;
  data?: Record<string, unknown>;
};

const KEY = 'dl.log';
const KEY_PREV = 'dl.log.prev';

/**
 * How much history is worth keeping.
 *
 * One download writes on the order of twenty entries, one page navigation about
 * five. 900 is roughly an hour of ordinary use, which is the window in which
 * someone still remembers what they were doing when it broke.
 */
const CAP = 900;

/** A single oversized value cannot be allowed to crowd out the ring. */
const MAX_STRING = 2000;
const MAX_KEYS = 24;

let ring: Entry[] = [];
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let restored = false;

/**
 * Whether `debug` is kept.
 *
 * Off by default: debug is the level that fires per progress tick, and letting
 * it into the ring evicts the entries that explain the failure with entries
 * that describe the thing working.
 */
let verbose = false;

export const setVerbose = (on: boolean) => {
  verbose = on;
};

export const isVerbose = () => verbose;

/**
 * Where entries also go while someone is watching.
 *
 * Kept as a seam rather than calling `console` directly so the tests can assert
 * on what was mirrored, and so the console bridge cannot recurse into itself
 * when it patches `console.log`.
 */
let mirror: ((e: Entry) => void) | null = null;

export const setMirror = (fn: ((e: Entry) => void) | null) => {
  mirror = fn;
};

/**
 * Keys whose values must never reach the ring, matched on the *key* rather than
 * the value — a token has no shape worth matching, and a false negative here
 * writes a credential to a file in `Downloads/`.
 *
 * The presence of a token is the diagnostic, not its bytes, so a redacted value
 * still says what the reader needs: `poToken: "<redacted 214>"` answers both
 * "was there one" and "was it plausible".
 */
const SECRET = /token|cookie|auth|password|secret|credential|session[_-]?id/i;

function scrub(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;

  const type = typeof value;
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'string') {
    const s = value as string;
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}...+${s.length - MAX_STRING}` : s;
  }
  if (type === 'bigint' || type === 'function' || type === 'symbol') return String(value);

  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message, depth), code: (value as any).code };
  }

  // Two levels is enough to carry a format list or a settings object, and not
  // enough for a React element or a native handle to drag the whole tree in.
  if (depth >= 2) return Array.isArray(value) ? `[${value.length} items]` : '[object]';

  if (Array.isArray(value)) return value.slice(0, MAX_KEYS).map((v) => scrub(v, depth + 1));

  const out: Record<string, unknown> = {};
  let n = 0;
  for (const key of Object.keys(value as object)) {
    if (n++ >= MAX_KEYS) {
      out['...'] = 'truncated';
      break;
    }
    const raw = (value as Record<string, unknown>)[key];
    if (SECRET.test(key)) {
      out[key] =
        raw === null || raw === undefined || raw === ''
          ? null
          : `<redacted ${typeof raw === 'string' ? raw.length : '?'}>`;
      continue;
    }
    out[key] = scrub(raw, depth + 1);
  }
  return out;
}

/** Public because callers sometimes build a `data` object worth checking. */
export function redact(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return undefined;
  try {
    return scrub(data, 0) as Record<string, unknown>;
  } catch {
    // A getter threw, or the object is hostile. The entry is still worth having.
    return { unserialisable: true };
  }
}

function push(entry: Entry) {
  ring.push(entry);
  if (ring.length > CAP) ring.splice(0, ring.length - CAP);
  dirty = true;

  if (mirror) {
    try {
      mirror(entry);
    } catch {
      // A broken mirror must not take the entry with it.
    }
  }

  // An error is the one thing that might be followed immediately by the process
  // dying, so it does not wait for the debounce.
  if (entry.level === 'error') void flush();
  else schedule();
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, 4000);
}

function record(
  level: Level,
  scope: string,
  msg: string,
  data?: Record<string, unknown>,
  flowId?: string,
  ms?: number,
) {
  try {
    if (level === 'debug' && !verbose) return;
    const entry: Entry = { t: Date.now(), level, scope, msg };
    if (flowId) entry.flow = flowId;
    if (ms !== undefined) entry.ms = ms;
    const clean = redact(data);
    if (clean && Object.keys(clean).length) entry.data = clean;
    push(entry);
  } catch {
    // Rule 1. Nothing this function can hit is worth a crash.
  }
}

export const debug = (scope: string, msg: string, data?: Record<string, unknown>) =>
  record('debug', scope, msg, data);
export const info = (scope: string, msg: string, data?: Record<string, unknown>) =>
  record('info', scope, msg, data);
export const warn = (scope: string, msg: string, data?: Record<string, unknown>) =>
  record('warn', scope, msg, data);
export const error = (scope: string, msg: string, data?: Record<string, unknown>) =>
  record('error', scope, msg, data);

/**
 * Everything worth knowing about a thrown value, including the parts that are
 * only on some of them.
 *
 * The native module rejects with a `code` (`E_TRIAL_TOO_LONG`, `E_NO_OUTPUT`,
 * `E_DOWNLOAD`...), and that code is a far better discriminator than the message
 * text every caller currently pattern-matches on. It is the first thing this
 * pulls out, so a log reader never has to guess which branch of `readableError`
 * a failure took.
 */
export function describe(e: unknown): Record<string, unknown> {
  try {
    if (e instanceof Error) {
      const code = (e as any).code ?? undefined;
      return {
        name: e.name,
        code,
        message: e.message,
        // **A coded error's stack is the bridge's, not the fault's.** Anything
        // carrying a native `code` was constructed by `CodedError` on the way
        // out of the module, so its stack names the bridge and then a bundle
        // URL — while the actual failure happened in Python, in another
        // process, and is already in `message`. Measured: one refused client
        // wrote 700 bytes of which about 30 were about the refusal, five times
        // per walk, evicting the history that explained it.
        //
        // Everything else keeps a stack, because for a JavaScript throw it is
        // the only thing that says where.
        stack:
          code || !e.stack ? undefined : e.stack.split('\n').slice(0, 8).join('\n'),
      };
    }
    if (e && typeof e === 'object') {
      return { code: (e as any).code, message: String((e as any).message ?? e) };
    }
    return { message: String(e) };
  } catch {
    return { message: 'unprintable error' };
  }
}

let flowSeq = 0;

export type Flow = {
  id: string;
  /** A named milestone. `data` is merged into the entry. */
  step: (msg: string, data?: Record<string, unknown>) => void;
  /** The flow finished as intended. */
  ok: (msg?: string, data?: Record<string, unknown>) => void;
  /** The flow ended badly. Records at `error`, which forces a flush. */
  fail: (e: unknown, data?: Record<string, unknown>) => void;
  /** Ended for a reason that is not a fault: a cancel, a duplicate, a refusal. */
  gaveUp: (why: string, data?: Record<string, unknown>) => void;
  /** Ms since the flow opened. */
  elapsed: () => number;
};

/**
 * A correlated sequence of entries, which is the half that answers "how was the
 * flow" rather than "what broke".
 *
 * A download crosses four files, two languages and a foreground service, and
 * the interesting failures are all *orderings* — a token that arrived after the
 * request that needed it, a client pinned by a listing and refused by the
 * download, a save that raced a page navigation. Flat lines cannot show that
 * when two downloads overlap; a shared id can.
 *
 * Every entry carries ms-since-open, so a log reader gets the timings for free
 * and a step that took thirty seconds is visible without arithmetic.
 */
export function flow(scope: string, name: string, data?: Record<string, unknown>): Flow {
  const id = `${scope}#${++flowSeq}`;
  const began = Date.now();
  const since = () => Date.now() - began;

  record('info', scope, `>> ${name}`, data, id, 0);

  return {
    id,
    elapsed: since,
    step: (msg, d) => record('info', scope, msg, d, id, since()),
    ok: (msg, d) => record('info', scope, `OK ${msg ?? name}`, d, id, since()),
    gaveUp: (why, d) => record('warn', scope, `-- ${why}`, d, id, since()),
    fail: (e, d) => record('error', scope, `XX ${name}`, { ...describe(e), ...d }, id, since()),
  };
}

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

/**
 * The tail of the previous run, moved aside before this one starts writing.
 *
 * This is the whole point of persisting at all. A crash, an Android kill or a
 * force-stop all end the process without warning, and if the next launch wrote
 * into the same key the evidence would be overwritten by the boot sequence of
 * the run that is trying to explain it.
 */
export async function restore(): Promise<void> {
  if (restored) return;
  restored = true;
  try {
    const raw = await AsyncStorage.getItem(KEY);
    if (raw) {
      await AsyncStorage.setItem(KEY_PREV, raw);
      await AsyncStorage.removeItem(KEY);
    }
  } catch {
    // Starting with no history is a worse log, not a broken app.
  }
}

/** What the previous run left behind, oldest first. */
export async function previous(): Promise<Entry[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PREV);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function flush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(ring));
  } catch {
    // Out of space, or storage is wedged. The ring is still in memory and the
    // next flush may well succeed; losing the file is not worth a crash.
  }
}

/** This run's entries, oldest first. */
export const entries = (): readonly Entry[] => ring;

export function clear() {
  ring = [];
  dirty = true;
  void flush();
}

/** Test seam: forget everything, including the once-only restore latch. */
export function reset() {
  ring = [];
  dirty = false;
  restored = false;
  flowSeq = 0;
  verbose = false;
  mirror = null;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

const two = (n: number) => String(n).padStart(2, '0');

/** Wall clock, because the reader is correlating with what they were doing. */
function stamp(t: number): string {
  const d = new Date(t);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, '0')}`;
}

const MARK: Record<Level, string> = { debug: ' ', info: ' ', warn: '!', error: 'E' };

export function line(e: Entry): string {
  const ms = e.ms === undefined ? '' : ` +${(e.ms / 1000).toFixed(2)}s`;
  const flowId = e.flow ? ` [${e.flow}]` : '';
  let body = '';
  if (e.data) {
    try {
      body = ` ${JSON.stringify(e.data)}`;
    } catch {
      body = ' {unserialisable}';
    }
  }
  return `${stamp(e.t)} ${MARK[e.level]} ${e.scope.padEnd(9)}${flowId}${ms} ${e.msg}${body}`;
}

/**
 * The whole record as a text file, previous run first.
 *
 * Previous first because the reason anyone exports this is that something went
 * wrong, and the run that went wrong is usually the one that is no longer
 * running.
 */
export function dump(
  prev: readonly Entry[],
  now: readonly Entry[],
  header?: Record<string, unknown>,
): string {
  const out: string[] = ['# Spool diagnostic log', ''];
  if (header) {
    for (const [k, v] of Object.entries(header)) out.push(`${k}: ${String(v)}`);
    out.push('');
  }
  out.push(`exported: ${new Date().toISOString()}`);
  out.push('');

  if (prev.length) {
    out.push(`--- previous run (${prev.length} entries) ---`);
    for (const e of prev) out.push(line(e));
    out.push('');
  }
  out.push(`--- this run (${now.length} entries) ---`);
  for (const e of now) out.push(line(e));
  return out.join('\n');
}
