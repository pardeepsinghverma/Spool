/**
 * Everything that turns an unexplained death into a logged one.
 *
 * `log.ts` records what the app deliberately reports. This file catches the
 * three things it never gets told about:
 *
 *  - a JavaScript error nobody caught, which in a release build closes the app
 *    with no message at all;
 *  - a rejected promise nobody awaited, which is how an async failure hides;
 *  - everything already written to `console`, because the app is full of
 *    `[spool] ...` lines that were only ever visible over a cable.
 *
 * All three are installed once, at boot, before anything else runs. Each is
 * wrapped so that a fault *inside* the capture cannot become the crash — the
 * whole point is to be the last thing standing.
 */

import * as log from './log';

/** RN's global error hook. Not an import: it is installed onto the global. */
type ErrorUtils = {
  getGlobalHandler?: () => ((e: any, fatal?: boolean) => void) | undefined;
  setGlobalHandler?: (fn: (e: any, fatal?: boolean) => void) => void;
};

let installed = false;

/**
 * Bridges `console` into the ring.
 *
 * Returns the untouched originals, which matters more than it looks: the mirror
 * below writes *to* the console, so if it were handed the patched function
 * every entry would record itself for ever. Capturing the originals first is
 * what makes the two features composable.
 */
function bridgeConsole(): Record<string, (...a: unknown[]) => void> {
  const original: Record<string, (...a: unknown[]) => void> = {};
  const levels: Array<['log' | 'info' | 'warn' | 'error', log.Level]> = [
    ['log', 'info'],
    ['info', 'info'],
    ['warn', 'warn'],
    ['error', 'error'],
  ];

  for (const [name, level] of levels) {
    const prior = (console as any)[name]?.bind(console) as (...a: unknown[]) => void;
    original[name] = prior ?? (() => {});
    (console as any)[name] = (...args: unknown[]) => {
      try {
        // The app's own lines are already scoped; keeping the prefix in the
        // message would double it in every exported line.
        const text = args.map(stringify).join(' ');
        const spool = text.startsWith('[spool] ');
        log[level]('console', spool ? text.slice(8) : text);
      } catch {
        // Never let logging break printing.
      }
      original[name](...args);
    };
  }
  return original;
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/**
 * Catches what nobody else did.
 *
 * The previous handler is always called afterwards. Swallowing a fatal would
 * leave the app running in whatever broken state produced it, which is a worse
 * outcome than the crash and much harder to diagnose — the log would show the
 * error and then a session that apparently carried on fine.
 */
function catchCrashes() {
  const utils = (globalThis as any).ErrorUtils as ErrorUtils | undefined;
  if (!utils?.setGlobalHandler) return;

  const prior = utils.getGlobalHandler?.();
  utils.setGlobalHandler((e: any, fatal?: boolean) => {
    try {
      log.error('crash', fatal ? 'fatal error' : 'uncaught error', {
        fatal: !!fatal,
        ...log.describe(e),
      });
      // Errors flush synchronously-ish, but a fatal races the process going
      // away, so ask again and do not wait on it.
      void log.flush();
    } catch {
      // Nothing here is worth replacing the real crash with.
    }
    prior?.(e, fatal);
  });
}

/**
 * Rejected promises nobody handled.
 *
 * Reached through RN's bundled rejection tracker rather than `process.on`,
 * which Hermes does not have. It is an internal path and may move between
 * versions, so the whole thing is optional — losing this capture costs a class
 * of log entry, not correctness.
 */
function catchRejections() {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tracking = require('promise/setimmediate/rejection-tracking');
    tracking.enable({
      allRejections: true,
      onUnhandled: (id: number, e: unknown) => {
        log.error('crash', 'unhandled rejection', { id, ...log.describe(e) });
      },
      onHandled: (id: number) => {
        log.info('crash', 'rejection handled late', { id });
      },
    });
  } catch {
    // Not available in this React Native. Continue without it.
  }
}

/**
 * Installs all three captures and opens the log for this run.
 *
 * Idempotent: React's development double-invoke would otherwise patch `console`
 * twice and record every line twice with it.
 */
export function installDiagnostics(): void {
  if (installed) return;
  installed = true;

  const original = bridgeConsole();
  catchCrashes();
  catchRejections();

  // In development, everything recorded is also printed, so `adb logcat` shows
  // the flow live rather than only after someone exports the file. A release
  // build stays quiet: the ring is the record there, and printing it would put
  // every step of every download into the system log for no reader.
  //
  // Printed through the *captured* console, never the patched one — the bridge
  // above records what it prints, so echoing through it would make each entry
  // record itself for ever. Entries the bridge produced are skipped for the
  // same reason: they have already been printed once, by the caller.
  if (__DEV__) {
    log.setMirror((e) => {
      if (e.scope === 'console') return;
      // Always `log`, never `warn`/`error`: those two raise React Native's
      // LogBox, which covers the bottom of the screen — which is exactly where
      // the notice strip and the format sheet are. A recorder that hides the
      // surface being tested is worse than one that prints nothing, and the
      // rendered line already carries its own `!`/`E` marker.
      original.log(`[spool] ${log.line(e)}`);
    });
  }
}

/** Test seam. Does not un-patch — nothing in a test needs the real console back. */
export function resetInstalled() {
  installed = false;
}
