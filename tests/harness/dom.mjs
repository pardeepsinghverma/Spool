/**
 * A page, synthetic enough to run the app's injected scripts for real.
 *
 * `BACKGROUND_SCRIPT` is where the hardest behaviour in Spool lives — what
 * counts as the user pausing, what a refused `play()` may claim, whether the
 * queue survives a track boundary off screen — and it is a string of JavaScript
 * that never runs in the app process. Testing it by reading it is how it got
 * every bug it has had. So it is executed here, in a `vm` context, against a
 * DOM that implements exactly what it touches:
 *
 *  - a `Document.prototype.hidden` getter it can capture before freezing the
 *    property, which is the whole mechanism it uses to tell a real backgrounding
 *    apart from the lie it tells YouTube;
 *  - capture-phase listeners on window and document, dispatched by hand;
 *  - a `<video>` whose `play()` sets `paused` false immediately and only later
 *    settles — the browser behaviour the "never claim a hidden page resumed"
 *    rule is built around;
 *  - `Date.now`, `setInterval` and `document.cookie` under the test's control,
 *    so a second of playback, a touch 300ms ago and a command from the
 *    notification are all things a test states rather than waits for.
 */

import vm from 'node:vm';

export class FakeVideo {
  constructor(options = {}) {
    this.tagName = 'VIDEO';
    this.paused = options.paused ?? true;
    this.ended = false;
    this.muted = options.muted ?? false;
    this.currentTime = options.currentTime ?? 0;
    this.duration = options.duration ?? 300;
    this.isConnected = true;
    /** Whether the browser will honour a play(). False models a hidden page. */
    this.allowPlay = options.allowPlay ?? true;
    /** Every play() this element was asked for, settled or not. */
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.pending = [];
  }

  /**
   * Real behaviour, which is the point: `paused` flips to false the instant
   * play() is called, long before the browser has decided to allow it. A
   * rejection puts it back. Nothing settles until the test lets it.
   */
  play() {
    this.playCalls++;
    this.paused = false;
    return new Promise((resolve, reject) => {
      this.pending.push(() => {
        if (this.allowPlay) {
          resolve();
        } else {
          this.paused = true;
          reject(new Error('NotAllowedError'));
        }
      });
    });
  }

  pause() {
    this.pauseCalls++;
    this.paused = true;
  }

  /** Settle every outstanding play() promise. */
  settle() {
    const pending = this.pending;
    this.pending = [];
    for (const fn of pending) fn();
  }
}

class Listeners {
  constructor() {
    this.map = new Map();
  }

  addEventListener(type, handler) {
    if (!this.map.has(type)) this.map.set(type, []);
    this.map.get(type).push(handler);
  }

  removeEventListener(type, handler) {
    const list = this.map.get(type);
    if (list) this.map.set(type, list.filter((fn) => fn !== handler));
  }

  dispatch(type, event) {
    for (const handler of [...(this.map.get(type) ?? [])]) {
      if (event.__stopped) break;
      handler(event);
    }
  }

  count(type) {
    return (this.map.get(type) ?? []).length;
  }
}

export function createPage(options = {}) {
  const state = {
    hidden: options.hidden ?? false,
    now: options.now ?? 1_700_000_000_000,
  };

  const videos = [];
  const messages = [];
  const intervals = [];
  const timeouts = [];

  function Document() {}
  Object.defineProperty(Document.prototype, 'hidden', {
    configurable: true,
    get() {
      return state.hidden;
    },
  });

  const documentListeners = new Listeners();
  const windowListeners = new Listeners();
  const elements = new Map();

  const document = Object.create(Document.prototype);
  Object.assign(document, {
    title: options.title ?? 'A song - YouTube',
    cookie: options.cookie ?? '',
    addEventListener: (type, handler) => documentListeners.addEventListener(type, handler),
    removeEventListener: (type, handler) =>
      documentListeners.removeEventListener(type, handler),
    querySelectorAll: (selector) => (selector === 'video' ? [...videos] : []),
    querySelector: (selector) => {
      if (selector === 'video') return videos.find((v) => !v.muted) ?? videos[0] ?? null;
      if (selector === 'title') return null;
      return options.query?.(selector) ?? null;
    },
    getElementById: (id) => elements.get(id) ?? null,
    createElement: (tag) => ({ tagName: tag.toUpperCase(), textContent: '', id: '' }),
  });
  document.head = {
    appendChild: (element) => {
      if (element.id) elements.set(element.id, element);
    },
  };
  document.documentElement = { backgroundColor: '' };
  document.body = null;

  const location = {
    href: options.href ?? 'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
    hostname: options.hostname ?? 'm.youtube.com',
  };

  const navigator = { mediaSession: { metadata: options.metadata ?? null } };

  const window = {
    addEventListener: (type, handler) => windowListeners.addEventListener(type, handler),
    removeEventListener: (type, handler) =>
      windowListeners.removeEventListener(type, handler),
    ReactNativeWebView: {
      postMessage: (payload) => messages.push(JSON.parse(payload)),
    },
    location,
    navigator,
    document,
  };

  const context = vm.createContext({
    window,
    document,
    Document,
    navigator,
    location,
    console,
    Date: { now: () => state.now },
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval: () => {},
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms });
      return timeouts.length;
    },
    clearTimeout: () => {},
    XMLHttpRequest: function XMLHttpRequest() {},
    Object,
    JSON,
    Math,
    Array,
    String,
    RegExp,
    isFinite,
    parseFloat,
    parseInt,
    Promise,
    Error,
  });
  context.XMLHttpRequest.prototype.open = function open() {};
  context.window.self = context.window;

  return {
    state,
    document,
    window,
    location,
    navigator,
    messages,
    /** The last message the page posted, parsed. */
    get last() {
      return messages[messages.length - 1] ?? null;
    },
    videos,
    addVideo(video = new FakeVideo()) {
      videos.push(video);
      return video;
    },
    removeVideo(video) {
      video.isConnected = false;
      const at = videos.indexOf(video);
      if (at >= 0) videos.splice(at, 1);
    },
    run(script) {
      return vm.runInContext(script, context);
    },
    eval(code) {
      return vm.runInContext(code, context);
    },
    /** Advance the fake clock. Nothing here runs on a real timer. */
    advance(ms) {
      state.now += ms;
    },
    /** Run every registered interval callback once, oldest first. */
    tick(times = 1) {
      for (let i = 0; i < times; i++) for (const timer of intervals) timer.fn();
    },
    /** Run the timeouts the script registered, in order. */
    runTimeouts() {
      const due = [...timeouts].sort((a, b) => a.ms - b.ms);
      timeouts.length = 0;
      for (const timer of due) timer.fn();
    },
    fireOnDocument(type, target) {
      documentListeners.dispatch(type, event(target));
    },
    fireOnWindow(type, target) {
      windowListeners.dispatch(type, event(target));
    },
    /** Settle every video's outstanding play() promise, then drain microtasks. */
    async settle() {
      for (const video of videos) video.settle();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
    intervals,
    timeouts,
  };
}

const event = (target) => ({
  target,
  __stopped: false,
  stopImmediatePropagation() {
    this.__stopped = true;
  },
  stopPropagation() {},
  preventDefault() {},
});
