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
  // Healthy by default: one adaptive video rung and one audio-only rung, which
  // is the shape of every real YouTube manifest. An empty list is not the
  // benign answer it looks like — the client walk reads a manifest with no
  // audio-only stream as a degraded response and keeps walking, so defaulting
  // to `formats: []` would make every unconfigured test walk the whole chain.
  listFormats: async () =>
    JSON.stringify({
      id: 'x',
      title: 'x',
      formats: [
        { format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080 },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128 },
      ],
    }),
  download: async () => ({ path: '/data/x.m4a', bytes: 1 }),
  cancel: async () => {},
  updateEngine: async () => ({ status: 'updated', version: '2026.02.02' }),
  publishToGallery: async () => 'content://media/1',
  scanSaved: async () => [],
  readArtwork: async () => ({ uri: 'file:///art.jpg', dominant: '#101010' }),
  // Every cached cover still on disk — the state of a cache nobody cleared.
  filesExist: (uris) => uris.map(() => true),
  setNowPlaying: () => {},
  stopBackgroundPlayback: () => {},
  setPageCommand: () => {},
  setWebViewVisible: () => {},
  writeTextFile: async () => 'content://downloads/1',
  signOutOfYouTube: async () => {},
  setSecureWindow: () => {},
  setScreenOrientation: () => {},
  pickGoogleAccount: async () => null,
  trialStatus: () => ({
    trial: false,
    expiresAt: 0,
    expired: false,
    intact: true,
    used: 0,
    maxDownloads: 0,
    maxSeconds: 0,
  }),
  // Unconfigured by default — no server and no device — which is what a debug
  // build actually reports. A suite that wants a subscription says so, and one
  // that does not is never accidentally tested against a live-looking licence.
  licenceStatus: () => ({
    entitled: false,
    expiresAt: 0,
    plan: '',
    device: '',
    server: '',
  }),
  // The real one verifies a signature. This one cannot, so it accepts nothing
  // by default: a test that wants a token kept has to say so, which keeps the
  // asymmetry visible rather than letting `rememberLicence` look free.
  rememberLicence: () => false,
  forgetLicence: () => {},
  // A screenshot with nothing legible on it, and a shrink that hands back a
  // small file. Payment suites that care about either say so.
  recognizeText: async () => '',
  shrinkImage: async () => ({ uri: 'file:///cache/upload/shot.jpg', bytes: 1, width: 1, height: 1 }),
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
