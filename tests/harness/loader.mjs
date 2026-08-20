/**
 * The module resolver the tests run under.
 *
 * Two jobs, both of which exist because the app's source is written for Metro
 * rather than for Node:
 *
 *  - **Extensionless imports.** `import './engine'` is what the bundler
 *    understands and what Node's ESM resolver refuses. Every miss is retried
 *    with the extensions Metro would have tried.
 *  - **React Native and Expo packages.** None of them load outside a device, so
 *    `react`, AsyncStorage and `expo-modules-core` are swapped for the stubs in
 *    ./stubs — which are also where a test reaches in to make a write fail or a
 *    native call throw.
 *
 * A `?fresh=n` query is preserved through both, because module-level state
 * (`preferredClient` in core/ytdlp, the artwork index) is exactly what several
 * of these tests are about, and re-importing under a new query is the only way
 * to get a clean copy of it.
 */

const HERE = new URL('./', import.meta.url);

const STUBS = {
  react: new URL('./stubs/react.mjs', HERE).href,
  'react-native': new URL('./stubs/react-native.mjs', HERE).href,
  'expo-modules-core': new URL('./stubs/expo-modules-core.mjs', HERE).href,
  '@react-native-async-storage/async-storage': new URL('./stubs/async-storage.mjs', HERE).href,
};

const EXTENSIONS = ['.ts', '.tsx', '/index.ts', '/index.tsx'];

const split = (specifier) => {
  const at = specifier.indexOf('?');
  return at === -1 ? [specifier, ''] : [specifier.slice(0, at), specifier.slice(at)];
};

export async function resolve(specifier, context, next) {
  const [path, query] = split(specifier);

  if (STUBS[path]) return { url: STUBS[path] + query, shortCircuit: true };

  try {
    return await next(specifier, context);
  } catch (error) {
    if (!path.startsWith('.') && !path.startsWith('/')) throw error;
    for (const extension of EXTENSIONS) {
      try {
        return await next(path + extension + query, context);
      } catch {
        // Try the next one; the original error is what gets reported.
      }
    }
    throw error;
  }
}
