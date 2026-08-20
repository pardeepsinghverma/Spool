/**
 * React Native, reduced to the one thing the app's hooks reach for outside a
 * component: AppState. Backgrounding is a state the tests need to cause.
 */

const listeners = new Set();

export const AppState = {
  currentState: 'active',
  addEventListener(event, handler) {
    if (event !== 'change') return { remove() {} };
    listeners.add(handler);
    return {
      remove() {
        listeners.delete(handler);
      },
    };
  },
};

/** Drive the app between foreground and background. */
export function setAppState(next) {
  AppState.currentState = next;
  for (const handler of [...listeners]) handler(next);
}

export function reset() {
  listeners.clear();
  AppState.currentState = 'active';
}

export const Platform = { OS: 'android', select: (map) => map.android ?? map.default };
export const NativeModules = {};
