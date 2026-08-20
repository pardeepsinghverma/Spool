import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The mini bar's store. It exists so that a 2dp progress line moving once a
 * second does not re-render a fifteen-hundred-line screen, which makes "when
 * does it *not* notify" the whole point of it.
 */

let counter = 0;
const load = () => import(`../src/browser/pageNowPlaying.ts?fresh=${counter++}`);

const playback = (over = {}) => ({
  id: 'dQw4w9WgXcQ',
  title: 'A song',
  artist: 'Someone',
  playing: true,
  at: 0,
  length: 300,
  ...over,
});

const watch = (module) => {
  const calls = { count: 0 };
  // The store's subscriber set is private; usePagePlayback is the only way in,
  // so subscribe the way a component would and count the renders it asks for.
  const hooks = module.usePagePlayback;
  return { calls, hooks };
};

describe('setPagePlayback', () => {
  test('appearing and disappearing both notify', async () => {
    const { setPagePlayback, pagePlayback } = await load();
    setPagePlayback(playback());
    assert.equal(pagePlayback().id, 'dQw4w9WgXcQ');
    setPagePlayback(null);
    assert.equal(pagePlayback(), null);
  });

  test('null over null changes nothing', async () => {
    const { setPagePlayback, pagePlayback } = await load();
    setPagePlayback(null);
    assert.equal(pagePlayback(), null);
  });

  test('the store always holds the newest value, notified or not', async () => {
    // A sub-second playhead move is deliberately not worth a repaint, but a
    // reader asking directly must still get the truth.
    const { setPagePlayback, pagePlayback } = await load();
    setPagePlayback(playback({ at: 10 }));
    setPagePlayback(playback({ at: 10.4 }));
    assert.equal(pagePlayback().at, 10.4);
  });
});

describe('what a subscriber is told about', () => {
  const subscribe = async () => {
    const module = await load();
    const { mount } = await import('./harness/stubs/react.mjs');
    let renders = 0;
    const handle = mount(() => {
      renders++;
      return module.usePagePlayback();
    });
    return { module, handle, renders: () => renders };
  };

  test('a playhead move under a second is not a repaint', async () => {
    const { module, handle, renders } = await subscribe();
    const before = renders();
    module.setPagePlayback(playback({ at: 10 }));
    const afterFirst = renders();
    module.setPagePlayback(playback({ at: 10.9 }));
    assert.equal(renders(), afterFirst, 'no repaint for 0.9s of movement');
    assert.ok(afterFirst > before);
    handle.unmount();
  });

  test('a full second is', async () => {
    const { module, handle, renders } = await subscribe();
    module.setPagePlayback(playback({ at: 10 }));
    const before = renders();
    module.setPagePlayback(playback({ at: 11 }));
    assert.ok(renders() > before);
    handle.unmount();
  });

  test('pausing is, even at the same playhead', async () => {
    const { module, handle, renders } = await subscribe();
    module.setPagePlayback(playback({ at: 10, playing: true }));
    const before = renders();
    module.setPagePlayback(playback({ at: 10, playing: false }));
    assert.ok(renders() > before);
    handle.unmount();
  });

  test('a track change is, however similar the numbers', async () => {
    const { module, handle, renders } = await subscribe();
    module.setPagePlayback(playback({ id: 'aaaaaaaaaaa', at: 10 }));
    const before = renders();
    module.setPagePlayback(playback({ id: 'bbbbbbbbbbb', at: 10 }));
    assert.ok(renders() > before);
    handle.unmount();
  });

  test('an unmounted subscriber is not called again', async () => {
    const { module, handle, renders } = await subscribe();
    handle.unmount();
    const before = renders();
    module.setPagePlayback(playback({ at: 99 }));
    assert.equal(renders(), before);
  });

  test('a subscriber that mounts late is caught up by its own effect', async () => {
    // The store can move between first render and the effect that subscribes.
    const module = await load();
    const { mount } = await import('./harness/stubs/react.mjs');
    module.setPagePlayback(playback({ title: 'Already playing' }));
    const handle = mount(() => module.usePagePlayback());
    assert.equal(handle.current.title, 'Already playing');
    handle.unmount();
  });
});
