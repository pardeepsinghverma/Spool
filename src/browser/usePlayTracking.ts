import { useCallback, useEffect, useRef, useState } from 'react';
import { loadPlays, savePlays, type PlayIndex, type PlayStat } from '../core/plays';
import type { MediaMessage } from './background';

/**
 * Counts what the user actually watched in the browser.
 *
 * The whole auto-save rule rests on these two numbers, and a counter that
 * over-counts silently fills someone's phone with things they never chose. So
 * the bar for incrementing anything is deliberately high:
 *
 * - **Muted video never counts.** The page script already refuses to report it,
 *   which is what keeps the home feed's autoplay previews out of the index.
 * - **Watch time comes from the playhead, not the clock.** Buffering, a stalled
 *   network and a backgrounded process all keep wall time running while nothing
 *   is heard. Only forward movement of `currentTime` counts.
 * - **Seeks are not watching.** A jump larger than one reporting interval is
 *   scrubbing, so the position is adopted without crediting the gap. Dragging
 *   to the end of an hour-long video earns nothing.
 * - **A play must be meant.** Opening something and leaving after two seconds
 *   is not a play; the start only counts once MIN_PLAY_SECONDS have genuinely
 *   been watched, which also means one video cannot bank two starts without the
 *   user leaving and coming back.
 */

/** Reports arrive once a second; anything past this is a seek, not playback. */
const MAX_CREDITED_STEP = 3;

/** Below this, opening a video was a look rather than a play. */
export const MIN_PLAY_SECONDS = 5;

/** Batching window for writes, so a play does not hit disk once a second. */
const FLUSH_MS = 4000;

type Session = {
  id: string;
  /** Last known playhead, for measuring forward movement. */
  at: number;
  /** Seconds credited during this visit to this video. */
  seconds: number;
  /** Whether this visit has already banked its start. */
  counted: boolean;
};

export function usePlayTracking(
  /** Called the first time a video's start count lands on a new value. */
  onPlayCounted?: (stat: PlayStat) => void,
) {
  const [plays, setPlays] = useState<PlayIndex>({});
  const index = useRef<PlayIndex>({});
  const session = useRef<Session | null>(null);
  const flush = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ready = useRef(false);
  // Held in a ref so a changing callback identity never re-subscribes the
  // WebView's message handler mid-play.
  const notify = useRef(onPlayCounted);
  notify.current = onPlayCounted;

  useEffect(() => {
    let alive = true;
    loadPlays().then((stored) => {
      if (!alive) return;
      index.current = stored;
      ready.current = true;
      setPlays(stored);
    });
    return () => {
      alive = false;
    };
  }, []);

  const schedule = useCallback(() => {
    if (flush.current) return;
    flush.current = setTimeout(() => {
      flush.current = null;
      void savePlays(index.current);
    }, FLUSH_MS);
  }, []);

  /** Writes the session's tally into the index under its video's id. */
  const commit = useCallback(
    (
      current: Session,
      meta: { title: string; artist: string; music: boolean },
      bankStart: boolean,
    ) => {
      const previous = index.current[current.id];
      const next: PlayStat = {
        id: current.id,
        // Keep the first decent title we saw; YouTube blanks it mid-navigation.
        title: meta.title || previous?.title || '',
        artist: meta.artist || previous?.artist || '',
        starts: (previous?.starts ?? 0) + (bankStart ? 1 : 0),
        seconds: (previous?.seconds ?? 0) + current.seconds,
        lastAt: Date.now(),
        music: meta.music || previous?.music,
        savedAt: previous?.savedAt,
      };
      index.current = { ...index.current, [current.id]: next };
      setPlays(index.current);
      schedule();
      // Only a fresh start can cross a threshold, so this is the one moment the
      // rule needs to look — checking on every tick would ask the same question
      // once a second and get the same answer.
      if (bankStart) notify.current?.(next);
    },
    [schedule],
  );

  const onMedia = useCallback(
    (message: MediaMessage) => {
      if (!ready.current) return;

      const current = session.current;
      const id = message.id;

      // Left the watch page, or landed somewhere with nothing to attribute.
      if (!id) {
        session.current = null;
        return;
      }

      if (!current || current.id !== id) {
        session.current = { id, at: message.at, seconds: 0, counted: false };
        return;
      }

      if (!message.playing) {
        // Adopt the position so a pause-and-resume does not read as a seek, but
        // credit nothing: paused is not watched.
        current.at = message.at;
        return;
      }

      const step = message.at - current.at;
      current.at = message.at;
      // Backwards is a rewind, too far forward is a scrub. Neither is watching.
      if (step > 0 && step <= MAX_CREDITED_STEP) current.seconds += step;

      if (!current.counted && current.seconds >= MIN_PLAY_SECONDS) {
        current.counted = true;
        commit(current, message, true);
        current.seconds = 0;
        return;
      }

      // Fold the running tally in periodically so watch time survives the app
      // being killed mid-video, which is exactly when long plays happen.
      if (current.counted && current.seconds >= 15) {
        commit(current, message, false);
        current.seconds = 0;
      }
    },
    [commit],
  );

  /** Marks a video as taken by the rule, so it is never queued twice. */
  const markSaved = useCallback(
    (id: string) => {
      const stat = index.current[id];
      if (!stat) return;
      index.current = {
        ...index.current,
        [id]: { ...stat, savedAt: Date.now() },
      };
      setPlays(index.current);
      schedule();
    },
    [schedule],
  );

  const forget = useCallback(
    (id: string) => {
      const { [id]: _gone, ...rest } = index.current;
      index.current = rest;
      setPlays(rest);
      schedule();
    },
    [schedule],
  );

  // A pending write is the newest truth; losing it on unmount would roll back
  // whatever was watched in the last few seconds.
  useEffect(
    () => () => {
      if (!flush.current) return;
      clearTimeout(flush.current);
      flush.current = null;
      void savePlays(index.current);
    },
    [],
  );

  return { plays, onMedia, markSaved, forget };
}
