/**
 * AsyncStorage, in memory, with a fault switch.
 *
 * Every storage module in the app swallows its own errors on the grounds that
 * losing a preference is not worth crashing over. That reasoning is only sound
 * if the swallow actually leaves the caller with something usable, which is a
 * claim the tests here check — so failure has to be inducible.
 */

const store = new Map();

export const faults = {
  /** Reads throw. */
  read: false,
  /** Writes throw. */
  write: false,
  /** getItem answers with this string instead of what was stored. */
  corrupt: null,
};

export function reset() {
  store.clear();
  faults.read = false;
  faults.write = false;
  faults.corrupt = null;
}

/** What is actually on "disk", for asserting on what a save wrote. */
export const raw = (key) => store.get(key) ?? null;
export const seed = (key, value) => store.set(key, value);
export const keys = () => [...store.keys()];

const AsyncStorage = {
  async getItem(key) {
    if (faults.read) throw new Error('storage read failed');
    if (faults.corrupt !== null) return faults.corrupt;
    return store.has(key) ? store.get(key) : null;
  },
  async setItem(key, value) {
    if (faults.write) throw new Error('storage write failed');
    store.set(key, value);
  },
  async removeItem(key) {
    if (faults.write) throw new Error('storage write failed');
    store.delete(key);
  },
  async clear() {
    store.clear();
  },
};

export default AsyncStorage;
