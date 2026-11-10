# Spool — testing

How this app is verified, and what a green result is worth at each layer.

For *what has actually been found on a device* see
[RELIABILITY.md](RELIABILITY.md) — this book does not repeat its findings, it
explains the machinery those passes used. For what the pieces are see
[ARCHITECTURE.md](ARCHITECTURE.md); for the traps that make a green test lie see
[../AGENTS.md](../AGENTS.md).

Measured while writing this, on the working tree: **525 tests across 125 suites,
0 failures, 8.9s**, five consecutive clean runs. `tsc --noEmit` exits 0.
After accounts, UPI payments and the play lock landed: **586 tests across 140
suites, 0 failures** (one run; duration not recorded).

---

## 1. The verification ladder

Four rungs. Each proves a strictly different class of thing, and the cost goes
up by roughly an order of magnitude per rung — nine seconds, then a build, then
a device and a fresh install. That asymmetry is the whole reason to be precise
about which rung a change has to reach: climbing further than necessary is how
a project stops running its tests, and stopping early is how the two most
expensive bugs in this codebase shipped.

### Rung 1 — `npm run typecheck`

`tsc --noEmit` over every `.ts`/`.tsx` in the project, `strict` on, inheriting
`expo/tsconfig.base`.

**It can prove** that the seams line up. This app is one React tree talking to
one native module through `modules/ytdlp/index.ts`, and that file is the typed
contract: rename a native method there and forget a call site, change the shape
of a `Format`, drop a field from a stored record, and this is what says so. It
is also the only check that reads the twelve component files nothing else ever
loads.

**It cannot prove** anything about behaviour, and — this is the part people get
wrong — it does not check the tests. The resolved config pulls `tests/*.mjs` and
`tests/harness/**` into the program (`allowJs` is on), but `checkJs` is not set,
so those files are parsed and never type-checked. A suite that imports a
function which no longer exists fails at run time, not here.

### Rung 2 — the Node suite

`npm test -- "tests/*.test.mjs"`. Node's own runner, Node's own type stripping,
no framework, no devDependency. Nine seconds.

**It can prove** three things, and it is worth naming all three because the
second and third are usually assumed absent:

- **Pure logic.** Everything under `src/core/` that has a suite: the client
  walk, storage and its adoption rules, playlists, metadata cleaning, the
  duplicate test, the flight recorder.
- **Hook state machines.** `usePlayTracking` and `useBackgroundPlayback` run for
  real against a hooks runtime — ordered slots, effects, cleanup. What a hook
  banks, ignores, writes and tells the bridge is testable here.
- **The order and arguments of native calls.** `tests/harness/stubs/expo-modules-core.mjs`
  records every call, so "which client did the walk ask, in what order" and
  "did the card get republished for a playhead the system could extrapolate to"
  are assertions, not inferences.
- **The injected page scripts, executed.** `BACKGROUND_SCRIPT` and
  `ADBLOCK_SCRIPT` are strings that never run in the app process. They run here,
  in a `vm`, against a DOM that models the three browser behaviours they are
  built around.

**It cannot prove** that the native side does what the stub says it does. Every
`trialStatus`, every `download`, every `readArtwork` answer in this suite is a
statement about `tests/harness/stubs/expo-modules-core.mjs` and about nothing
else. It also cannot see React rendering, layout, timing, R8, MediaStore, or a
foreground service.

### Rung 3 — the emulator, release build

`npm run apk`, install, drive it. Passes 7 through 10 of
[RELIABILITY.md](RELIABILITY.md) are all this rung.

**It can prove** that the app launches, that a flow runs end to end, that a
service goes foreground, that the media card carries real metadata, and that a
failure surfaces as copy a person can act on. It is where every defect numbered
N1–N12 was found.

**It cannot prove** anything timing-sensitive. § 7 records a
`ForegroundServiceDidNotStartInTimeException` whose actual cause was main-thread
starvation on a loaded emulator, and which has never reproduced since — the
contract holes it exposed were real, the crash was the host. It also cannot
prove anything about the ABI the users get: § 10 records that only the `x86_64`
APK has ever been run, and that `arm64-v8a` and `armeabi-v7a` are built by CI
and never executed. And it is a poor witness for YouTube's own behaviour — `tv`
was refused 3/3 there with *The page needs to be reloaded*, which may be
specific to an emulator holding no real session.

### Rung 4 — a real device, fresh install, release APK, R8 on

**This is the only rung that verifies a shrinking change, and the rule is
absolute: a release-mode shrinking change is not verified until a real download
completes on a real device from a fresh install.** Launching successfully does
not test it, because engine init is lazy.

The reason is the sharpest example in this whole document, and it shipped.
Everyone knows R8's loud failure: it deletes `YtDlpModule` because nothing in
the bytecode references it (Expo resolves it by name from
`expo-module.config.json`), and the app dies at startup with an empty module
registry. The quiet one is worse. `commons-compress` registers its zip
extra-field types from a static block by reflective `newInstance()`, so R8
concludes `AsiExtraField` is never instantiated and makes it **abstract**;
`ExtraFieldUtils`' initialiser throws, `ZipUtils.unzip` never unpacks the Python
payload, and ART marks the class permanently bad for the life of the install.
The app launches perfectly. Every download fails, for ever. An emulator smoke
test proved the wrong thing and the build went out. See
[../AGENTS.md](../AGENTS.md) on R8, and
[ARCHITECTURE.md § 7](ARCHITECTURE.md#7-build-and-release) for the keep rules.

### Which rung a change must reach

| Change | Lowest rung that can believe it |
|---|---|
| Logic in a module that has a suite | **2**, and the suite is extended in the same change |
| Logic in a module that has none | **2**, by writing one — or **3**, if it needs a component |
| Anything React: a screen, a sheet, the player, the tab bar | **3** — rung 2 cannot render, and overlay UI needs a screenshot |
| Copy the user reads on a surface | **3** — § 7's D2 was enforced correctly and invisible |
| Anything with a lifecycle: a service, the notification, backgrounding | **3** minimum, **4** for a soak |
| Kotlin, `app.json`, a config plugin, a dependency bump | **4** |
| **R8 keep rules, `minifyEnabled`, anything shrinking touches** | **4**, with a completed download from a fresh install |
| What the app asks yt-dlp for — the chain, the selector, the output template | **4**: a real extraction against real YouTube, audio *and* video |

The last row has its own trap. § 10's N10a exists only because a whole pass ran
nothing but audio downloads, and audio never merges — the merge path is exactly
the code the fix had to be right about.

---

## 2. Running them

The full suite:

```bash
npm test -- "tests/*.test.mjs"
```

Bare `npm test` also works — Node's default test-file discovery finds
`tests/*.test.mjs` on its own; measured, same 525. The explicit pattern is
better habit because it is also the single-file form:

```bash
npm test -- tests/ytdlp.test.mjs
```

`npm run test:only` is the same thing with `--test-reporter=spec`, which prints
each case name rather than a summary. Useful when you want to read the suite as
documentation, which is how these are written.

The script body in `package.json` is:

```
node --experimental-strip-types
     --disable-warning=ExperimentalWarning
     --disable-warning=MODULE_TYPELESS_PACKAGE_JSON
     --import ./tests/harness/register.mjs
     --test
```

**Both of the load-bearing flags are required, for different reasons:**

- `--experimental-strip-types` — the app's source is TypeScript and nothing in
  this pipeline compiles it. Node erases the annotations at load. Without it
  every `.ts` import is a syntax error. It *erases* rather than transforms, so
  any TypeScript needing real emit — `enum`, `namespace`, parameter properties,
  legacy decorators — cannot appear in a module a test imports. The app's source
  currently contains none of those, and should stay that way.
- `--import ./tests/harness/register.mjs` — three lines that call
  `register(new URL('./loader.mjs', …))`. It has to be a separate file loaded
  via `--import`, because the resolve hook must be installed before Node
  resolves any application module. Without it, `import './engine'` fails (Node's
  ESM resolver will not guess an extension) and `import 'react-native'` fails
  outright.

The two `--disable-warning` flags are noise suppression only: the experimental
type-stripping warning, and `MODULE_TYPELESS_PACKAGE_JSON`, which fires because
`package.json` has no `"type"` field while the harness is `.mjs`.

Node runs each test **file** in its own child process. That matters: module-level
state cannot leak between suites, only within one. Every "reset this in
`beforeEach`" rule below is about contamination inside a single file.

---

## 3. The harness, in detail

`tests/harness/` exists because the app's source is written for Metro, not for
Node. Everything in it is a model of something real, and every model diverges.
**The divergences are the interesting part**, because a divergence is exactly
where a green test stops meaning what it appears to mean.

### `register.mjs` and `loader.mjs` — the resolver

`loader.mjs` is a `resolve` hook with two jobs:

- **Extensionless imports.** `import './engine'` is what the bundler
  understands. Every failed resolution of a *relative* specifier is retried
  against `['.ts', '.tsx', '/index.ts', '/index.tsx']`. Bare specifiers are
  rethrown untouched.
- **Package substitution.** Four names map to stubs: `react`, `react-native`,
  `expo-modules-core`, `@react-native-async-storage/async-storage`.

A `?fresh=n` query is split off before matching and re-appended after, which is
what makes cache-busting work through both paths.

**Where it diverges from Metro:** it does nothing else Metro does. No platform
extensions (`.android.ts`, `.native.ts`), no asset resolution, no Babel. A
module that depends on any of those cannot be loaded under test at all — which
is a real constraint on where new logic is allowed to live, not a footnote.

### `clock.mjs` — a wall clock the tests own

`freeze(at)` swaps `globalThis.Date` for a subclass whose static `now()` returns
a value the test moves with `advance(ms)` / `set(ms)`. It exists because
`Date.now()` decides whether a trial has expired, whether the notification's
playhead has drifted past the two-second republish threshold, and whether a
pause was the user's doing — all things normally tested by waiting, which is
slow and still cannot reach the interesting values.

**Where it diverges:** it fakes the clock and *not the timers*. `setTimeout` and
`setInterval` are the real ones. Advancing the clock does not fire anything. A
suite that needs a debounce to elapse must either await it for real (see
`playTracking`'s two `async (t) =>` cases) or drive the module's own tick.
`restore()` in `afterEach` is mandatory — a leaked frozen `Date` silently breaks
every later case in the same file.

### `stubs/react.mjs` — the one that decides what a hook test means

A hooks runtime in 184 lines. It exists because the play tracker — the logic
that decides what gets auto-saved onto someone's phone — is a hook, and
`react-test-renderer` is not installed because this project carries no test
dependencies on purpose.

**What it implements faithfully enough to trust:** ordered hook slots (so a
conditional hook misaligns exactly as it would in React), `Object.is` deps
comparison, effects run after the render commits, cleanup before an effect
re-runs and again on unmount, and a bailout when `setState` is handed an
`Object.is`-equal value.

**Where it diverges, and what that costs a test:**

- **Rendering is synchronous and unbatched.** A `setState` re-renders before the
  setter returns. Two `setState`s in one handler produce two renders here and
  one in React. **So no test may conclude anything from a render count**, and
  logic whose correctness depends on batching will behave differently.
- **`useContext` always returns the context's default value.** `createContext`
  hands back `{_default, Provider: null, Consumer: null}` — there is no
  provider, no propagation, no subscription. Anything that reads a *provided*
  value is untestable at this rung, which is the direct reason
  `src/player/PlayerContext.tsx` (905 lines) has no suite.
- **`createElement` returns a plain object.** Nothing renders. No tree, no host
  components, no refs, no layout, no events.
- **Absent entirely:** concurrent mode, Suspense, error boundaries, StrictMode
  double-invocation, `useReducer`, `useSyncExternalStore`,
  `useImperativeHandle`. (The app uses none of those hooks today — checked.)
- `mount()`'s flush loop throws after 100 passes as a render-loop guard. Real
  loops are caught; the threshold is arbitrary.
- `mount().flush()` drains two microtask turns and one `setImmediate`. An effect
  waiting on a real timer is not flushed by it.

**So: a test written against this stub can conclude that a hook's state machine
is correct** — what it banks, what it refuses, what it persists, what it sends
to the bridge, and that its cleanup runs. **It can conclude nothing about
rendering**: not that the component renders, not what it renders, not how often,
not that memoisation prevents a repaint on a device.

### `stubs/react-native.mjs` — AppState and almost nothing else

33 lines: `AppState` with a `setAppState(next)` driver, a hardcoded
`Platform = { OS: 'android' }`, and an empty `NativeModules`.

**Where it diverges:** everything else React Native exports is missing. A module
that touches `View`, `StyleSheet`, `Dimensions`, `Linking`, `PermissionsAndroid`
or `Animated` throws at import. That, together with the context limitation
above, is most of why no `.tsx` file in this project has a suite.

### `stubs/async-storage.mjs` — in-memory, with a fault switch

A `Map`, plus `faults.read`, `faults.write` and `faults.corrupt`. Every storage
module in the app swallows its own errors on the grounds that losing a
preference is not worth crashing over — which is only sound if the caller is
left with something usable, so failure has to be inducible. `raw(key)`,
`seed(key, value)` and `keys()` are how a test asserts on what was actually
written rather than on what a getter says.

**Where it diverges:** it is synchronous under a promise, resolving on the next
microtask where the real one is a bridge call taking milliseconds. A device race
— a read landing after a write it should have preceded — cannot be reproduced
here. `multiGet`/`multiSet`/`mergeItem` do not exist. `clear()` ignores the
fault switch. And there is no size limit: the caps asserted in
`tests/storage.test.mjs` (200 downloads, 500 forgotten, 8 searches) are pinned
as *policy*, never as a limit that was actually hit.

### `stubs/expo-modules-core.mjs` — the native bridge

`requireNativeModule()` and `requireOptionalNativeModule()` both return one
stable object, because `modules/ytdlp/index.ts` captures the module at import
time. Every method forwards to `handlers[name] ?? defaults[name]`, so a test
rewrites behaviour between cases without re-importing the module under test —
which is how one case makes `listFormats` refuse four times and answer on the
fifth.

Three surfaces to assert with: `calls` (every call as `{method, args}`, in
order), `callsTo(name)` (that filtered to argument arrays), and `listenerCount`
(for leak assertions). `emit(event, payload)` fires a native event at whatever
the app subscribed with. `reset()` clears all three.

**The default `listFormats` answer is deliberately healthy — one adaptive video
rung and one audio-only rung — and that is load-bearing.** `formats: []` looks
like the benign default and is not: the walk reads a manifest with no audio-only
rung as a *degraded* answer and keeps walking, so an unconfigured test would
silently exercise the whole five-client chain and agree with a bug. The comment
saying so lives in the stub.

**Where it diverges:** nothing is serialised and nothing is Kotlin. An argument
that could never cross the real bridge passes here. A real `CodedError` carries
a native `code` and a stack that names the bridge rather than the fault; tests
fabricate that with `Object.assign(new Error('HTTP Error 403: Forbidden'), { code: 'E_LIST' })`,
which is close enough for `log.describe` and `readableError` and is not the real
object.

### `dom.mjs` — a page the injected scripts actually run in

269 lines of `vm` context implementing exactly what `BACKGROUND_SCRIPT` and
`ADBLOCK_SCRIPT` touch:

- `Document.prototype.hidden` as a real prototype getter, so the script can
  capture the descriptor before freezing the property — which is the entire
  mechanism it uses to tell a real backgrounding from the lie it tells YouTube;
- listener lists on `window` and `document`, dispatched by hand;
- `FakeVideo`, whose `play()` sets `paused = false` immediately and settles only
  when the test says — the browser behaviour the "never claim a hidden page
  resumed" rule is built around — and which counts `playCalls` and `pauseCalls`;
- `Date.now`, `setInterval`, `setTimeout` and `document.cookie` under the test's
  control, so a second of playback, a touch 300ms ago, and a command arriving
  from the notification are all things a test *states*.

**Where it diverges:** there is no event propagation model — the third argument
to `addEventListener` is ignored, so a script relying on capture-before-bubble
against page handlers proves nothing here. There are no real timers: `tick()`
runs every registered interval callback once regardless of its period, so a
1000ms and a 250ms interval tick together. `querySelector('video')` prefers the
first unmuted element, which is this harness's modelling decision and not the
DOM's. And `fetch`, `Response` and `XMLHttpRequest` are near-empty — each suite
builds what it needs (`adblock.test.mjs` installs its own `Response` class).
`potoken.test.mjs` does the same, and goes further because it has to: it
installs a `Headers`, a `Response`, a `fetch` and a `Request` whose `clone()` is
**counted**, which is the only way to assert that a body was never read. Nothing
in `dom.mjs` needed changing to support it — the pattern of building the fakes
in the suite scales further than the note above implies.

### `?fresh=n`, and the singleton it cannot reach

Several modules keep state at module level on purpose — `preferredOpen`/`preferredToken` and
`triedUpdate` in `src/core/ytdlp.ts`, card ownership in
`src/player/nowPlaying.ts`, the artwork index, the lyrics cache, the mini bar
store. A suite that shared one copy would be testing the previous case. So:

```js
let counter = 0;
const load = () => import(`../src/core/ytdlp.ts?fresh=${counter++}`);
```

The loader preserves the query through both stub-mapping and extension retry, so
each import is a distinct URL in Node's module cache and therefore a clean copy.
Five suites use it: `artwork`, `lyrics`, `nowPlaying`, `pageNowPlaying`,
`ytdlp`.

**The cache-buster does not reach what a fresh copy imports.** A fresh
`ytdlp.ts` still resolves `'./clients'` with no query, so every copy shares one
`src/core/clients.ts` — which is correct, because the client scoreboard is
deliberately built to outlive a session and does so across launches on a device.
It means `resetClientScores()` in `beforeEach` is **load-bearing in any suite
that runs an extraction**, and both `tests/ytdlp.test.mjs` and
`tests/clients.test.mjs` call it. Omit it and the second case in the file runs
against a chain the first one taught. The scoreboard never *removes* a client,
only reorders, so the symptom is not an error — it is an assertion on
`clientsTried()` failing for no visible reason.

---

## 4. Coverage, suite by suite

24 files, 125 `describe` groups, 525 cases. Counted per file by running each on
its own; the totals match the full run exactly.

| Suite | Cases | What it pins down | What it deliberately does not |
|---|--:|---|---|
| `ytdlp` | 47 | The client walk, what counts as a refusal, once-per-session self-repair, the parse, rung collapsing, the download call, and that the two session controls reach the bridge | That yt-dlp does any of it. Every manifest is a fixture. Nothing here proves a cookie jar is deleted — that is Kotlin |
| `backgroundScript` | 47 | `BACKGROUND_SCRIPT` executed: user-vs-system pause, the metered watchdog, `wanted` across a track boundary, the cookie channel | The WebView pin, audio focus, or that any of this holds off screen on a device |
| `storage` | 41 | `mediaKey`, `dedupeByFile`, `adoptSaved`, and every loader's behaviour on corrupt, stale and unwritable state | MediaStore. Nothing here has ever seen a real file |
| `backgroundPlayback` | 32 | When the foreground service may be dropped, mini-bar dismissal, both command routes, notification commands | That `injectJavaScript` is queued while backgrounded — the reason both routes exist |
| `metadata` | 31 | What survives title cleaning, and that an artist is never invented | Anything about how a cleaned name looks in a row |
| `playlists` | 31 | Order, caps, refusals, and that a list never empties itself because the library was still loading | Drag-and-drop, or any screen |
| `log` | 25 | That the recorder never throws, never grows, never records a credential, and puts the previous run first | That the file reaches `Downloads/Spool` |
| `playTracking` | 23 | What counts as a play: muted previews, scrubbing, buffering, a paused tab left open | The auto-save the count triggers — that is `BrowserScreen` |
| `formatView` | 22 | `bestAudio`/`bestVideo` — the two picks made with no human present — and the sheet's rows | That the chosen id still exists by the time yt-dlp is asked |
| `lyrics` | 21 | LRC parsing, and that no request leaves without consent on file | The network. `fetch` is replaced with a thrower by default |
| `nowPlaying` | 18 | Who may take the one media card, who may only update it, who may put it down | That Android draws it |
| `clients` | 17 | The scoreboard: never removes a client, changes its mind fast, survives a launch, ignores a corrupt board | Whether the order it learns is the right one |
| `adblock` | 16 | Player-response stripping, its six-level depth cap, the not-addy fast path, the skip fallback | Cosmetic filtering beyond "the stylesheet was added once" |
| `artwork` | 17 | One decode per item, three at a time, failures remembered as hard as successes, a batched index | The native decode, and every colour it returns |
| `similar` | 17 | The duplicate test in both failure directions, on titles from the real test library | An in-flight duplicate — that guard reads `jobs`, in `BrowserScreen` |
| `trial` | 19 | The *wording and ordering* of a refusal — tampering ahead of expiry ahead of quota | Enforcement. That is `TrialGuard.kt`, and only that |
| `license` | 23 | That **being offline never revokes a subscription** — a throw, a 500, a truthful `entitled: false` and a rejected token are all *no news* — plus: no request signed out, the Bearer header, `paidThrough` persisted and never confused with the lease, the `refreshAfter` floor, and the pricing-copy rule (including that nothing promises a renewal) | Enforcement, and whether any token is genuine. That is `LicenseGuard.kt` |
| `account` | 20 | That a session ends **only** on the exact `401 signed out` / `403 blocked` bodies — a throw, 500, HTML 502 or a foreign 401 keep it; login/register copy per server error; last-contact is written on any parsed answer and never on a failure; logout works offline and takes the licence | That the server issues or revokes sessions correctly |
| `payments` | 13 | `whatsappUrl` encoding, rupee/date formatting, the multipart parts and no hand-set content-type, that `approved` lands the token before resolving, reasons passed verbatim, every contract 4xx as a sentence, the pending order's expiry | OCR, image shrinking and the picker — all native — and the server's parser |
| `playLock` | 19 | `judge` in every direction (grant, 409, grace, past grace, never-contacted, 429/400 as no news, session ended), the synchronous fast path, takeover running the held retry, heartbeat 409 pausing, a network failure never pausing, release only of a held lease | `PlayerContext`'s wiring, and timer behaviour in a backgrounded process |
| `licenceToken` | 16 | The token **format**, which both minters must satisfy: DER-encoded, over the ASCII of the encoded payload, against an X.509 key, and a re-ordered payload must not verify. 100 round trips, because the DER edge cases are probabilistic | Accounts, payments, the database, and any routing. Nothing here makes a request, and nothing here runs the PHP that actually signs in production — that server has its own suite, `php tests/e2e.php`, 33 checks over real HTTP |
| `export` | 15 | The bytes of an M3U and a backup, so they can be read back | Writing the file |
| `plays` | 13 | The index stays bounded, and drops the least damaging entry first | What the auto-save rule then does with it |
| `tokens` | 12 | Absent beats wrong: a token is offered for one video, for six hours, or not at all | That a token has ever existed — see [RELIABILITY.md](RELIABILITY.md) § 10 |
| `pageNowPlaying` | 9 | When the mini bar store does *not* notify, which is the whole point of it | The bar |
| `youtube` | 11 | Host checks a lookalike must not pass, eleven-character ids, and which hosts raise FLAG_SECURE | Navigation. That the flag is actually raised — see the note on verifying it in UI.md |
| `potoken` | 7 | Which request bodies the harvester will clone and decode, and which it refuses — the per-fragment cost of reading SABR media POSTs | Whether a token is ever found. That is YouTube's infrastructure and changes without notice |

### The subtle ones

**`ytdlp` (45).** Two thirds of this file is about the walk, and the reason is
in [RELIABILITY.md](RELIABILITY.md) § 7: a client can refuse **by answering**.
`android_vr` returned a successful manifest holding one muxed 360p and nothing
else; nothing threw, the walk accepted it, pinned it for the session, and every
layer below behaved correctly on a manifest that was wrong. So the cases here
distinguish four outcomes that all look like success — a good answer, a degraded
answer that is kept as a fallback, an empty answer, and a throw — and assert
that a degraded answer is *not* remembered as the client that worked. The token
cases are the other half: a token narrows the walk to the two clients that could
have minted it, so `attempts()` appends the whole open chain with the token
dropped, and an exhausted token chain ends where a tokenless one would have
started. That code is correct, unit-tested, and has never executed on a device.

**`backgroundScript` (47).** The largest suite, and the only one where the cases
were chosen from a list of things measured breaking on a phone rather than from
the code. The metered watchdog is the group to read: one resume a second, three
failures and stop, with the budget repaid by a touch, an explicit play, the page
returning to the screen, or playback surviving unaided. Without the meter,
Chromium was traded play and pause sixty times a second and the decoder pool was
exhausted permanently for that renderer. What the suite cannot see is why the
meter is needed — hardware decoder allocation has no model here.

**`trial` (17).** Read the docstring before changing anything: this module
enforces nothing. `TrialGuard.kt` decides, because `src/core/trial.ts` ships as
Hermes bytecode inside the APK it would be guarding. What these 17 cases own is
the *ordering* of a refusal, which has teeth — a tampered build told it is out
of saves reads as something a reinstall would fix.

**`clients` (17).** Two properties carry the file: it must never remove a
client, so a board that has learned something wrong can only ever be slower and
never the reason a download fails; and it must change its mind faster than
YouTube does, because which clients serve unattested requests moves monthly.
Both are asserted directly, including that one unlucky request cannot outvote
the base order (which encodes yt-dlp's published requirement table).

**`storage` (41).** `adoptSaved` gets the most attention of anything in the
suite — ten cases of its own — because it is the one function in the app that
can *resurrect something the user deleted*. The case to read first is
`'never hands back a row the user removed'`; the rest surround it with the
shapes that could route around it: a second scan recognising its own work, a
match on `uri` whatever the id, two scan rows sharing a `uri`, and a scan entry
with no `uri` at all.

---

## 5. What is not covered at all

Stated concretely, because "the UI is untested" is easy to nod at and easy to
under-estimate.

**Every React component — 9,372 lines of `.tsx`, zero suites.** Not one file:

```
App.tsx                        src/screens/FirstRunScreen.tsx
src/browser/BrowserScreen.tsx  src/screens/HomeScreen.tsx
src/browser/DownloadButton.tsx src/screens/LibraryScreen.tsx
src/browser/BrowserChrome.tsx  src/screens/ProfileScreen.tsx
src/browser/Pill.tsx           src/screens/SearchScreen.tsx
src/player/PlayerContext.tsx   src/sheets/ChoiceSheet.tsx
src/player/PlayerScreen.tsx    src/sheets/NameSheet.tsx
src/player/NowPlayingBar.tsx   src/sheets/PreReleaseSheet.tsx
src/player/VideoScreen.tsx     src/sheets/QualitySheet.tsx
src/shell/TabBar.tsx           src/ui/ErrorBoundary.tsx
src/ui/ThemeContext.tsx        src/ui/TrialChip.tsx
```

Two of those matter far more than the rest. **`BrowserScreen.tsx` is 3,224
lines** and holds all five download paths, the tab shell, the notice strip and
the auto-save rule that acts on `usePlayTracking`'s count — so the *decision* to
download is tested and the *orchestration* of it is not. **`PlayerContext.tsx`
is 905 lines** and owns the one queue across two engines, including
`setPlaybackGate`, which is what stops the WebView taking audio focus back;
it cannot be reached at rung 2 at all, because the React stub's `useContext`
only ever returns a default value.

**`.ts` modules with no suite:**

| Module | Lines | Why not |
|---|--:|---|
| `src/core/crash.ts` | 168 | Patches `console` and RN's global error hook — process-global side effects, and `ErrorUtils` does not exist in Node |
| `src/player/useLyrics.ts` | 104 | A hook that reads context |
| `src/ui/theme.ts` | 403 | Tokens |
| `src/core/engine.ts` | 91 | Types only; rung 1 is the whole check |
| `src/core/bootstrap.ts` | 25 | A side-effect module whose only job is import ordering |
| `modules/ytdlp/index.ts` | 234 | Exercised indirectly through `src/core/ytdlp.ts`, never on its own |

`potoken.ts` was the uncomfortable one on this list and is no longer on it. It
is the file whose blindness cost a day and nearly bought a native rewrite that
would not have helped ([RELIABILITY.md](RELIABILITY.md) § 10), and it was the
one injected script with no executed test while the other two had 63 cases
between them. `tests/potoken.test.mjs` closed that — prompted not by the old
argument but by a new bug, which is the usual way these get paid for.

**Everything native — 2,333 lines of Kotlin, no test source set at all.**
`modules/ytdlp/android/src/` contains only `main/`; there is no `test/`, no
`androidTest/`, and no test dependency in the module's `build.gradle`.

```
YtDlpModule.kt      1051   PlaybackService.kt   611
DownloadService.kt   226   MediaStoreWriter.kt  192
TrialGuard.kt        177   CookieJar.kt          76
```

Which means all of the following are verified at rung 3 or 4 or not at all: the
trial's clock-rollback detection and its `externalMediaDirs` mirror, R8 keep
rules, MediaStore publishing, `DownloadService`'s single slot and its
`finally`-released lock, the foreground-service fuse, `PlaybackService`'s
`PlaybackState`-first card, the WebView visibility pin, the cookie handoff, and
`limitBytes` on a title written four bytes to the character.

---

## 6. How to add a test

### The shape, from a real suite

`tests/ytdlp.test.mjs` uses every mechanism in the harness. Its top is the
template:

```js
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as native from './harness/stubs/expo-modules-core.mjs';
import * as storage from './harness/stubs/async-storage.mjs';
import { clientLost, resetClientScores } from '../src/core/clients.ts';
import { bestAudio, kbpsFromQuality } from '../src/browser/formatView.ts';

let counter = 0;
const load = () => import(`../src/core/ytdlp.ts?fresh=${counter++}`);

beforeEach(() => {
  native.reset();
  storage.reset();
  resetClientScores();
});
```

Note what is *not* freshly imported: `clients.ts` is taken normally, because
that singleton is meant to be shared — and is therefore reset by hand.

A native behaviour goes into the handler table, and the assertion comes out of
the call log:

```js
/** Which client each listFormats call asked as, in order. */
const clientsTried = () => native.callsTo('listFormats').map((args) => args[3]);

test('walks the whole chain past a refusal', async () => {
  native.handlers.listFormats = async (_url, _pot, _vd, client) => {
    if (client !== 'mweb') throw blocked();
    return payload();
  };
  const { listFormats } = await load();
  const meta = await listFormats(ref);
  assert.deepEqual(clientsTried(), ['tv', null, 'web_embedded', 'mweb']);
  assert.equal(meta.title, 'A song');
});
```

`callsTo(name)` is the pattern to reach for every time. It gives argument arrays
in order, which lets an assertion be about *what was asked and in what order*
rather than about a count. Where a test needs to observe a second phase, the log
is truncated in place rather than reset — `native.calls.length = 0;` — so
subscriptions established in the first phase survive. Other spellings in use:

```js
const cards = () => native.callsTo('setNowPlaying').map(([state]) => state);
assert.deepEqual(native.callsTo('setPageCommand').at(-1), ['seek.43', clock.now]);
const [, path, urls] = native.callsTo('readArtwork')[0];
native.emit('onPlaybackCommand', { command: 'pause', value: 0 });
assert.equal(native.listenerCount('onProgress'), 0);
```

### The rules

1. **Import the app through the loader**, with the real extension:
   `'../src/core/thing.ts'`. Import stubs by relative path from `tests/`.
2. **Reset every stub you touch, in `beforeEach`** — `native.reset()`,
   `storage.reset()` (async-storage), `resetAppState()` (react-native). Any
   suite that performs an extraction must also call `resetClientScores()`.
3. **Freeze the clock with `freeze()` and `restore()` in `afterEach`.** A leaked
   frozen `Date` breaks every later case in the file, silently.
4. **Take a `?fresh=n` copy of anything with module-level state**, and remember
   the buster stops at the module boundary — what that copy imports is shared.
5. **Add no dependency.** This project ships a sideloaded APK with a
   self-updating extractor; a test tree that needs its own install is a test
   tree that stops being run. That is why there is no framework here.
6. **Name the case as a claim, in the app's voice.** `'a muted preview clip is
   not playing'`, not `'should not count muted video'`. Every one of the 525
   existing names is a claim, which is what makes `npm run test:only` readable
   as documentation.
7. **Say in a comment why a case exists** when it encodes something measured.
   Most of the cases in `backgroundScript` and `ytdlp` do, and those comments
   are the only surviving record of several device sessions.
8. **A test that needs to render is not a test for this tier.** Take it to
   rung 3 and verify by screenshot.
9. **Update this book and [../tests/README.md](../tests/README.md)** when the
   coverage table changes.

---

## 7. Device verification recipes

Distilled from [RELIABILITY.md](RELIABILITY.md) §§ 7–10 and
[../AGENTS.md](../AGENTS.md), as steps rather than lessons.

### A. Read the flight recorder live (debug build)

`src/core/crash.ts` mirrors every recorded entry to `console.log` in `__DEV__`
only, so:

```bash
adb logcat | grep "\[spool\]"
```

The line shape is `hh:mm:ss.mmm M scope [flow] +N.NNs message {json}`, where `M`
is blank for info, `!` for warn and `E` for error, and `flow` correlates the
steps of one operation. Grep a flow id to get a download's whole life.

The echo goes through `console.log` and never `warn`/`error` — deliberately.
Those two raise React Native's LogBox, which covers the bottom of the screen,
which is exactly where the notice strip and the format sheet are. A recorder
that hides the surface under test is worse than one that prints nothing.

### B. Get the record out of a release build

A release build prints nothing. Use **Profile → Export diagnostics**, which
writes `spool-log-<stamp>.txt` into `Downloads/Spool` and flashes a notice
naming the file. Then:

```bash
adb shell ls /sdcard/Download/Spool
adb pull /sdcard/Download/Spool/spool-log-<stamp>.txt
```

**The previous run is first in that file**, because a crash ends the process and
the interesting session is the one that stopped. When a failure makes no sense,
read this before believing the copy on screen: § 10 records four separate
failures that reached the "check free space and connection" message on a device
with 26 GB free.

### C. Verify the media notification

```bash
adb shell dumpsys media_session
```

Check four things: our session `com.afinitycode.spool/spool` is the
**media-button session**; `state=PLAYING`; `actions` is a real mask (819 was
measured); and `metadata: size=6` or more with a real title — `size=2,
description=null` is the specific failure that means the engine was started
without claiming the lock screen, and Android kills it minutes after
backgrounding. Then confirm the app owns exactly one *card*.

For the service behind it:

```bash
adb shell dumpsys activity services PlaybackService
```

`isForeground=true types=0x00000002` is the state that has to survive
backgrounding, a track boundary and a screen-off soak.

### D. Verify overlay UI by screenshot, never by view dump

`uiautomator dump` **cannot see the notice strip.** Forty polls across the live
window found nothing while a screenshot taken in the same second showed the
strip drawn correctly over the WebView. It reports React Native text elsewhere
(the tab bar), so its silence is not evidence of absence.

```bash
adb exec-out screencap -p > shot.png
```

**And do not sleep a fixed interval.** The strip lasts three seconds while
extraction takes an unpredictable four to eight, so any fixed wait tests
nothing. Poll, or time the screenshot off the `ui notice` line the app writes
(`log.info('ui', 'notice', …)` in `BrowserScreen.tsx`) — which is why that line
exists.

### E. Driving YouTube without fooling yourself

YouTube's home feed and search results **reshuffle between visits**, so tapping
the same screen coordinate twice opens two different videos. Three attempts at
verifying the replay rule failed on this alone. Drive from a search results
page, tap the first result, and screenshot to confirm the video id before
trusting a play count or a download.

### F. Test the failure directions, not the happy one

Most of § 10's findings came from breaking a download on purpose. The two that
matter:

1. **Cut the network mid-transfer** (airplane mode, or `adb shell svc wifi
   disable`). Confirm: the download fails, **nothing is published**, no library
   row appears, and a `.part` is left behind. Then *Try again* and confirm it
   resumes from exactly the byte count it stopped at, rather than from zero.
2. **Cut it once the video half is complete but the audio half is not.** This is
   the merge path, and it is where a rescue rule can publish a silent film or a
   truncated video. Confirm the download still fails and still publishes
   nothing, then that *Try again* skips the complete stream, resumes the other,
   merges, and publishes.

Run at least one **video** download in any pass that touches the download path.
An audio-only pass never merges, and § 10's N10a was invisible for exactly that
reason.

### G. The R8 recipe

Build the release APK, install it over nothing (`adb uninstall` first — a fresh
install is the point), walk first run, grant the permissions, and **complete a
real download**. A launch proves the module registry survived and nothing else;
the payload unpack happens lazily on the first extraction, which is where the
quiet R8 failure lives.

---

## 8. The pre-release checklist

It lives in [RELIABILITY.md § 6](RELIABILITY.md#6-the-pre-release-checklist),
ordered by how expensive each failure is to discover late. Follow it there
rather than a copy here.

Four things this ladder adds to it:

- **Its item 9 belongs first, not last.** `tsc --noEmit` and the Node suite are
  rungs 1 and 2 and cost about ten seconds together. Everything above them costs
  a build.
- **"A real device" means an arm64 device.** § 10 records that only the
  `x86_64` APK has ever been run; `arm64-v8a` and `armeabi-v7a` are built by CI
  and never executed, and that is the largest remaining gap in this project by
  some distance.
- **Item 1 needs a video download too.** The checklist says "a real download";
  the merge path is a different path, and it is the one `finished()` has to be
  right about.
- **For any change to R8 keep rules or to a dependency constructed
  reflectively, item 1 is not a smoke test — it is the entire test.** Nothing
  else can distinguish a working build from one that launches and can never
  download again.
