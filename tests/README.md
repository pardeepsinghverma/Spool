# Tests

```
npm test
```

269 cases, about five seconds, **no test dependencies**. Node's own runner and
its type stripping run the app's TypeScript directly — nothing is compiled,
nothing is mocked with a framework, and `package.json` gains no devDependency.
That is deliberate: this project ships a sideloaded APK with a self-updating
extractor, and a test tree that needs its own install is a test tree that stops
being run.

Run one file:

```
node --experimental-strip-types --import ./tests/harness/register.mjs --test tests/backgroundScript.test.mjs
```

## What is covered

| Suite | What it pins down |
| --- | --- |
| `backgroundScript` | The injected page script, executed. Whether a pause was the user, what a refused `play()` may claim, the cookie command channel, `wanted` across a track boundary. |
| `backgroundPlayback` | The app half. When the foreground service may be dropped, the mini bar's dismissal, notification commands. |
| `playTracking` | What counts as a play. Muted previews, scrubbing, buffering, a paused tab left open. |
| `ytdlp` | The client walk, the once-per-session self-repair, and the parse of yt-dlp's output. |
| `nowPlaying` | Which of the two engines owns the one media card, and who may take it down. |
| `storage` / `plays` / `artwork` | Corrupt blobs, caps, eviction order, the artwork semaphore. |
| `trial` | The wording and ordering of a refusal. Enforcement is `TrialGuard`, in Kotlin. |
| `adblock` | Player-response stripping, its depth cap, and the skip fallback. |
| `formatView` / `youtube` | Choosing a format with no human present; URL parsing that a lookalike host must not pass. |

## The harness

`tests/harness/` exists because the app's source is written for Metro, not Node.

- **`loader.mjs`** — retries extensionless imports with `.ts`, and swaps
  `react`, `react-native`, AsyncStorage and `expo-modules-core` for the stubs.
  A `?fresh=n` query survives both, which is how a suite gets a clean copy of
  module-level state such as `preferredClient` or the artwork index.
- **`stubs/react.mjs`** — a hooks runtime. Ordered slots, deps comparison,
  effects after commit, synchronous setState. Not React: no concurrent mode, no
  Suspense, and a bailout that never renders the extra pass React might. It
  exists because the play tracker is a hook and `react-test-renderer` is not
  installed.
- **`dom.mjs`** — a page with the three browser behaviours the background script
  is built around: a `Document.prototype.hidden` getter it can capture before
  freezing the property, a `play()` that reads back as unpaused before it has
  been allowed, and a swappable `<video>`. Scripts run in a `vm` context with
  `Date.now`, `setInterval` and `document.cookie` under the test's control.
- **`stubs/expo-modules-core.mjs`** — the native bridge, with a handler table
  the tests rewrite between cases and a call log to assert against.

## What these tests cannot tell you

Everything native. The trial guard's clock-rollback detection, R8 keep rules,
MediaStore publishing, the foreground service surviving a backgrounded process,
`limitBytes` on a four-byte-per-character title — all of it is Kotlin running on
a device, and the failures that matter there are the ones that only appear in a
release build from a fresh install. A green run here is not a release check.
See the shrinking note in `AGENTS.md`.
