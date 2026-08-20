/**
 * A hooks runtime, standing in for React.
 *
 * The app's most consequential logic — the play tracker that decides what gets
 * auto-saved — lives inside a hook, and real React refuses to run one without a
 * renderer. `react-test-renderer` is not installed and this project deliberately
 * carries no test dependencies, so this is the smallest thing that runs a hook
 * honestly: ordered hook slots, deps comparison, effects after commit, and a
 * setState that re-renders.
 *
 * It is a model, not React, and the differences are deliberate:
 *
 *  - Renders are synchronous. A setState re-renders before the setter returns,
 *    so tests never have to await a scheduler.
 *  - A setState to an `Object.is`-equal value is dropped, as React's bailout
 *    does — but React may still render once more before bailing, and this does
 *    not. Nothing under test counts renders.
 *  - There is no concurrent mode, no Suspense, no context propagation beyond a
 *    default value.
 *
 * Anything that depends on those differences is not a test worth trusting, and
 * none of the suites here do.
 */

let current = null;
let slot = 0;

const changed = (a, b) =>
  !a || !b || a.length !== b.length || a.some((value, i) => !Object.is(value, b[i]));

function nextSlot(initial) {
  if (!current) throw new Error('hook called outside a render — mount() it first');
  const hooks = current.hooks;
  if (hooks.length <= slot) hooks[slot] = initial();
  return hooks[slot++];
}

export function useState(initial) {
  const instance = current;
  const hook = nextSlot(() => ({
    value: typeof initial === 'function' ? initial() : initial,
  }));
  const set = (next) => {
    const value = typeof next === 'function' ? next(hook.value) : next;
    if (Object.is(value, hook.value)) return;
    hook.value = value;
    instance.dirty = true;
    if (!instance.rendering) flush(instance);
  };
  return [hook.value, set];
}

export function useRef(initial) {
  return nextSlot(() => ({ current: initial }));
}

export function useMemo(factory, deps) {
  const hook = nextSlot(() => ({ deps: null, value: undefined, first: true }));
  if (hook.first || changed(hook.deps, deps)) {
    hook.value = factory();
    hook.deps = deps;
    hook.first = false;
  }
  return hook.value;
}

export const useCallback = (fn, deps) => useMemo(() => fn, deps);

export function useEffect(create, deps) {
  const instance = current;
  const hook = nextSlot(() => ({ deps: null, cleanup: undefined, first: true }));
  if (hook.first || changed(hook.deps, deps)) {
    hook.deps = deps;
    hook.first = false;
    instance.pending.push(hook);
    hook.create = create;
  }
}

export const useLayoutEffect = useEffect;

export function createContext(defaultValue) {
  return { _default: defaultValue, Provider: null, Consumer: null };
}

export const useContext = (context) => context._default;

/** Reference identity only — nothing here renders elements. */
export const createElement = (type, props, ...children) => ({ type, props, children });

function render(instance) {
  current = instance;
  slot = 0;
  instance.rendering = true;
  try {
    instance.result = instance.fn();
  } finally {
    instance.rendering = false;
    current = null;
  }
  instance.renders++;
}

function runEffects(instance) {
  const pending = instance.pending;
  instance.pending = [];
  for (const hook of pending) {
    if (typeof hook.cleanup === 'function') hook.cleanup();
    const cleanup = hook.create();
    hook.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  }
}

function flush(instance) {
  let guard = 0;
  while (instance.dirty || instance.pending.length) {
    if (++guard > 100) {
      throw new Error('render did not settle after 100 passes — probable render loop');
    }
    if (instance.dirty) {
      instance.dirty = false;
      render(instance);
    } else {
      runEffects(instance);
    }
  }
}

/**
 * Run `fn` as a component body and keep it mounted.
 *
 * `current` is whatever it last returned; `flush` drains pending microtasks and
 * then any renders they caused, which is how an effect that awaits AsyncStorage
 * is observed landing.
 */
export function mount(fn) {
  const instance = {
    fn,
    hooks: [],
    pending: [],
    rendering: false,
    dirty: true,
    renders: 0,
    result: undefined,
  };
  flush(instance);
  return {
    get current() {
      return instance.result;
    },
    get renders() {
      return instance.renders;
    },
    rerender() {
      instance.dirty = true;
      flush(instance);
    },
    async flush() {
      // Two turns: one for the awaited value, one for anything it chained.
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      flush(instance);
    },
    unmount() {
      for (const hook of instance.hooks) {
        if (hook && typeof hook.cleanup === 'function') hook.cleanup();
      }
      instance.unmounted = true;
    },
  };
}

export default {
  useState,
  useRef,
  useMemo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useContext,
  createContext,
  createElement,
};
