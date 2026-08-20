/**
 * A wall clock the tests own.
 *
 * `Date.now()` decides whether a trial has expired, whether the notification's
 * playhead has drifted far enough to be worth a bridge call, and whether a
 * pause was the user's doing. All three are the kind of thing that is normally
 * tested by waiting, which produces slow tests that still cannot reach the
 * interesting values.
 */

const RealDate = globalThis.Date;

export function freeze(at = 1_700_000_000_000) {
  let now = at;

  class FakeDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }

  globalThis.Date = FakeDate;

  return {
    get now() {
      return now;
    },
    advance(ms) {
      now += ms;
    },
    set(ms) {
      now = ms;
    },
    restore() {
      globalThis.Date = RealDate;
    },
  };
}
