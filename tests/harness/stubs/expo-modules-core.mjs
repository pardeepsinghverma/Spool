/**
 * The native bridge, faked.
 *
 * `modules/ytdlp/index.ts` captures the module object once, at import time, so
 * this hands back a stable object whose methods forward to a handler table the
 * tests can rewrite between cases. Swapping the handlers is what lets one test
 * make `listFormats` 403 four times and succeed on the fifth without ever
 * re-importing the module under test.
 */

export const calls = [];

/** Overwrite any of these per test. Anything unset answers benignly. */
export const handlers = {};

const listeners = new Map();

const defaults = {
  initialize: async () => '2026.01.01',
  version: async () => '2026.01.01',
  listFormats: async () => JSON.stringify({ id: 'x', title: 'x', formats: [] }),
  download: async () => ({ path: '/data/x.m4a', bytes: 1 }),
  cancel: async () => {},
  updateEngine: async () => ({ status: 'updated', version: '2026.02.02' }),
  publishToGallery: async () => 'content://media/1',
  scanSaved: async () => [],
  readArtwork: async () => ({ uri: 'file:///art.jpg', dominant: '#101010' }),
  setNowPlaying: () => {},
  stopBackgroundPlayback: () => {},
  setPageCommand: () => {},
  trialStatus: () => ({
    trial: false,
    expiresAt: 0,
    expired: false,
    intact: true,
    used: 0,
    maxDownloads: 0,
    maxSeconds: 0,
  }),
};

const native = {
  addListener(event, listener) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(listener);
    calls.push({ method: 'addListener', args: [event] });
    return {
      remove() {
        listeners.get(event)?.delete(listener);
        calls.push({ method: 'removeListener', args: [event] });
      },
    };
  },
};

for (const name of Object.keys(defaults)) {
  native[name] = (...args) => {
    calls.push({ method: name, args });
    return (handlers[name] ?? defaults[name])(...args);
  };
}

/** Fire a native event at whatever the app subscribed with `onProgress` etc. */
export function emit(event, payload) {
  for (const listener of listeners.get(event) ?? []) listener(payload);
}

export const listenerCount = (event) => listeners.get(event)?.size ?? 0;

export function reset() {
  calls.length = 0;
  for (const key of Object.keys(handlers)) delete handlers[key];
  listeners.clear();
}

/** Every call to `name`, in order, as argument arrays. */
export const callsTo = (name) =>
  calls.filter((call) => call.method === name).map((call) => call.args);

export const requireNativeModule = () => native;
export const requireOptionalNativeModule = () => native;

export class EventEmitter {}
export class NativeModule {}
export class SharedObject {}
