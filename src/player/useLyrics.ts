import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import {
  cachedLyrics,
  fetchLyrics,
  hasLyricsConsent,
  lyricsKey,
  setLyricsConsent,
  type Lyrics,
} from '../core/lyrics';

/**
 * The player's half of lyrics: what is known, and the one tap that asks.
 *
 * Reading the cache is free and happens whenever the track changes, so a lyric
 * already on the device is simply there. **Asking is never automatic** — see
 * `core/lyrics.ts` for why that rule is the feature — so the fetch only ever
 * runs from `request()`, which is wired to a control the user pressed.
 */

export type LyricsState =
  /** Never looked. The screen offers to. */
  | { kind: 'idle' }
  | { kind: 'loading' }
  /** Looked, and this track has none. The screen stops offering. */
  | { kind: 'none' }
  | { kind: 'ready'; lyrics: Lyrics }
  /** Could not ask. Different from `none`, and offers to try again. */
  | { kind: 'error' };

export function useLyrics(track: { title: string; artist?: string } | null, seconds: number) {
  const [state, setState] = useState<LyricsState>({ kind: 'idle' });
  const key = track ? lyricsKey(track.artist ?? '', track.title) : '';

  // Guards the async read below: a track change while a lookup is in flight
  // must not land the previous track's lyric on the current one.
  const wanted = useRef(key);
  wanted.current = key;

  useEffect(() => {
    if (!key) {
      setState({ kind: 'idle' });
      return;
    }
    setState({ kind: 'idle' });
    void (async () => {
      const known = await cachedLyrics(key);
      if (wanted.current !== key) return;
      if (known === undefined) return;
      setState(known ? { kind: 'ready', lyrics: known } : { kind: 'none' });
    })();
  }, [key]);

  const request = useCallback(() => {
    if (!track || !key) return;
    const title = track.title;
    const artist = track.artist ?? '';

    const run = async () => {
      setState({ kind: 'loading' });
      try {
        const found = await fetchLyrics({ artist, title, seconds });
        if (wanted.current !== key) return;
        setState(found ? { kind: 'ready', lyrics: found } : { kind: 'none' });
      } catch {
        if (wanted.current !== key) return;
        // Not `none`: "we could not ask" is not "there are none", and the
        // screen goes on offering to try rather than saying there are none.
        setState({ kind: 'error' });
      }
    };

    void (async () => {
      if (await hasLyricsConsent()) {
        void run();
        return;
      }
      /**
       * The one time this app asks permission to talk to somebody who is not
       * YouTube, so it says which host and what goes with it rather than
       * asking for a blanket yes to "lyrics".
       */
      Alert.alert(
        'Look up lyrics?',
        'Spool has no lyrics of its own — it would ask lrclib.net, sending the ' +
          'track name, artist and length. That is the only request Spool makes ' +
          'that is not YouTube’s. Nothing identifies you or this device, and ' +
          'the answer is kept on the phone so each track is asked once.',
        [
          { text: 'Not now', style: 'cancel' },
          {
            text: 'Look up lyrics',
            onPress: () => {
              void setLyricsConsent(true);
              void run();
            },
          },
        ],
      );
    })();
  }, [track, key, seconds]);

  return { state, request };
}
