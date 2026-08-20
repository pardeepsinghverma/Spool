import { useEffect, useState } from 'react';

/**
 * What the browser page is playing, for the surfaces that draw it.
 *
 * A store rather than state on the screen. `onMedia` fires about once a second
 * while a video runs, and BrowserScreen is fifteen hundred lines — re-rendering
 * all of it on every tick to move a 2dp progress line is the trade this avoids.
 * Only the mini bar subscribes, so only the mini bar repaints.
 *
 * Same shape as `nowPlaying.ts`, which arbitrates the notification between this
 * source and the local player, and for the same reason: the page and the
 * library are two engines that know nothing about each other.
 */

export type PagePlayback = {
  /** The video id, so artwork resolved for the card can be reused here. */
  id: string;
  title: string;
  artist: string | null;
  playing: boolean;
  /** Seconds. */
  at: number;
  length: number;
};

let current: PagePlayback | null = null;
const listeners = new Set<() => void>();

/** Below this the bar would repaint for a change nobody can see. */
const DRIFT_SECONDS = 1;

export function setPagePlayback(next: PagePlayback | null): void {
  const was = current;
  current = next;

  if (!was || !next) {
    if (was !== next) listeners.forEach((fn) => fn());
    return;
  }

  const changed =
    was.id !== next.id ||
    was.title !== next.title ||
    was.artist !== next.artist ||
    was.playing !== next.playing ||
    was.length !== next.length ||
    Math.abs(was.at - next.at) >= DRIFT_SECONDS;

  if (changed) listeners.forEach((fn) => fn());
}

export const pagePlayback = (): PagePlayback | null => current;

export function usePagePlayback(): PagePlayback | null {
  const [state, setState] = useState<PagePlayback | null>(current);
  useEffect(() => {
    const fn = () => setState(pagePlayback());
    listeners.add(fn);
    // The store may have moved between the first render and this effect.
    fn();
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return state;
}
