import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import type { RefObject } from 'react';
import type WebView from 'react-native-webview';
import YtDlp from '../../modules/ytdlp';
import { artworkFor, onArtworkChange, resolveVideoArtwork } from '../core/artwork';
import {
  onNotificationCommand,
  ownsNotification,
  publishNowPlaying,
  releaseNowPlaying,
} from '../player/nowPlaying';
import { mediaCommand, seekCommand, setPageBackgrounded, type MediaMessage } from './background';
import { pagePlayback, setPagePlayback } from './pageNowPlaying';

/**
 * The app half of browser background playback.
 *
 * Holds the media foreground service up while the page has something playing,
 * tells the page when it has gone off screen, and routes notification commands
 * back into it. The page half is BACKGROUND_SCRIPT.
 *
 * The card it fills is the same one the local player uses — see
 * `src/player/nowPlaying.ts`. A page and a library track are two engines that
 * know nothing about each other, and Android has room for one card per app.
 */
/**
 * How long the page gets to confirm a play before the card stops claiming it.
 *
 * Long enough for the cookie to be read on the page's next tick and for the
 * report to come back, short enough that a refusal is not left on screen.
 */
const PLAY_GRACE_MS = 4000;

/**
 * What the app has to tell this hook about saving, since the library lives
 * above it.
 *
 * `canSave` is asked on every report rather than passed as a value so the
 * button disappears as soon as the download lands, without the caller having to
 * notice and re-render anything.
 */
export type SaveHooks = {
  canSave: (videoId: string) => boolean;
  onSave: (video: { id: string; title: string; artist: string | null }) => void;
  /**
   * Changes whenever the library does, and exists because the page is not a
   * clock: it reports when something about it changes, so a save that finishes
   * while the page sits paused produces no report and nothing would repaint the
   * card. The button would stay, now offering to save a file that exists.
   */
  revision: string;
};

export function useBackgroundPlayback(
  webview: RefObject<WebView | null>,
  save: SaveHooks,
) {
  const media = useRef<MediaMessage | null>(null);
  const serviceUp = useRef(false);
  const playCheck = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The video the user dismissed from the bar, and why this is not a boolean.
   *
   * `stop` is `pause` on the page side — there is no verb that makes a watch
   * page stop being a watch page. So a second after the ×, the page's own tick
   * reports the same paused video and `onMedia` puts the bar straight back,
   * now offering play. Measured: the card went down and the bar never left,
   * which reads as the × doing nothing.
   *
   * Holding the id rather than a flag means the dismissal is of *that* video:
   * navigating to another one, or playing this one again, brings the bar back
   * without needing anything to clear it.
   */
  const dismissed = useRef<string | null>(null);

  // Read through a ref so `raise` and the command listener stay stable — both
  // are hot paths, and rebuilding them on every render of a 1,500-line screen
  // would resubscribe the notification listener on every keystroke in the URL.
  const saveRef = useRef(save);
  saveRef.current = save;

  const inject = useCallback(
    (script: string) => webview.current?.injectJavaScript(script),
    [webview],
  );

  /**
   * Say something to the page by both routes at once.
   *
   * `injectJavaScript` is immediate while the app is on screen and queued while
   * it is not; the cookie is the reverse in spirit — it arrives on the page's
   * own next tick, up to a second later, whatever the app is doing. Sending
   * both means a tap from the shade is honoured now if the app is open and
   * within a second if it is not, and the page treats the second arrival of the
   * same verb as a no-op.
   */
  const say = useCallback(
    (command: 'play' | 'pause' | 'stop') => {
      inject(mediaCommand(command));
      try {
        YtDlp.setPageCommand(command, Date.now());
      } catch {
        // Older builds of the native module have no such function; the queued
        // injection is still there, which is what used to happen anyway.
      }
    },
    [inject],
  );

  /**
   * The card draws a scrubber for a page too — the page reports a real length,
   * so hiding it would be throwing away something true. Offering one that did
   * not move would be worse, which is the only reason this exists.
   */
  const seek = useCallback(
    (seconds: number) => {
      const at = Math.max(0, Math.round(seconds));
      inject(seekCommand(at));
      try {
        YtDlp.setPageCommand(`seek.${at}`, Date.now());
      } catch {
        // See `say`.
      }
    },
    [inject],
  );

  const raise = useCallback((m: MediaMessage) => {
    try {
      publishNowPlaying('browser', {
        title: m.title || 'Playing',
        artist: m.artist || null,
        // What the card cannot otherwise say: this is a page, not a file. The
        // difference is not cosmetic — a page stops when the tab moves on, and
        // its buttons behave differently from a saved track's.
        source: 'YouTube',
        playing: m.playing,
        // The page has no file and no library row, so the cover comes from the
        // thumbnail. Resolved under its own key — see resolveVideoArtwork.
        artwork: m.id ? (artworkFor(`yt:${m.id}`)?.uri ?? null) : null,
        // The page reports both every second, which is what gives this card a
        // working scrubber rather than the blank one it had.
        position: m.at,
        duration: m.length,
        // YouTube's own up-next is what advances a Mix, and reaching it means
        // clicking a button on a page the app cannot talk to while it is
        // backgrounded. A skip control here would be dead exactly when it was
        // wanted, so there is none.
        canNext: false,
        canPrevious: false,
        /**
         * The one control the card offers that is not transport.
         *
         * A page is the only thing that can be saved from here, and only while
         * it is not already on the device — the library asks, because it is the
         * only party that knows. Without a video id there is nothing to save.
         */
        canSave: !!m.id && saveRef.current.canSave(m.id),
      });
      serviceUp.current = true;
    } catch (e) {
      // Android 12+ refuses a foreground service started from the background.
      // Playback then lasts only as long as the process does; there is no
      // second lever to pull, so just say so.
      console.warn('[spool] background playback unavailable:', String(e));
    }
  }, []);

  /**
   * Hold the WebView open, or let it go.
   *
   * Everything else here keeps the *page* from noticing it was backgrounded.
   * This is the layer underneath: WebView suspends the media pipeline of a
   * WebView it considers hidden, and it reads that from the Android view, so
   * no amount of lying to YouTube reaches it. Measured without this, a resumed
   * page played for about 50ms and stopped again — the same with the screen
   * off as with the app merely behind HOME.
   *
   * It costs: a pinned WebView goes on decoding video nobody is looking at.
   * So it follows the service exactly — up while something the user asked for
   * is playing, down the moment it is not.
   */
  const pinned = useRef(false);
  const away = useRef(false);

  const pin = useCallback((held: boolean) => {
    if (held === pinned.current) return;
    pinned.current = held;
    try {
      YtDlp.setWebViewVisible(held);
    } catch {
      // Older builds of the native module have no such function. Background
      // playback is then what it was before this existed.
    }
  }, []);

  /**
   * Held only where it earns its cost: off screen, with something the user
   * asked for still going.
   *
   * `wanted` as well as `playing`, because the gap between two tracks is
   * exactly when letting go would be fatal — the page honestly has nothing
   * playing for a moment, and a WebView allowed to go to sleep there does not
   * come back for the next one. On screen it is never held: Android says the
   * window is visible and means it.
   */
  const syncPin = useCallback(() => {
    const m = media.current;
    pin(away.current && !!m && (m.playing || m.wanted));
  }, [pin]);

  const drop = useCallback(() => {
    if (!serviceUp.current) return;
    serviceUp.current = false;
    pin(false);
    releaseNowPlaying('browser');
  }, [pin]);

  /** Fed by the WebView's media messages. */
  const onMedia = useCallback(
    (message: MediaMessage) => {
      media.current = message;

      /**
       * A dismissal lasts until that video plays again, or until another one
       * takes its place. Playing is the user asking for it back; a different id
       * is a different question. An empty id is neither — the page reports one
       * between navigations, and reading that as "another video" would put the
       * bar back a second after it was dismissed.
       */
      if (
        dismissed.current &&
        (message.playing || (!!message.id && message.id !== dismissed.current))
      ) {
        dismissed.current = null;
      }

      /**
       * The mini bar draws from this. Fed on every report, including the ones
       * that do not raise a card: a paused watch page still belongs on the bar,
       * because the bar is how the user gets back to it.
       */
      setPagePlayback(
        dismissed.current
          ? null
          : message.hasMedia && message.id
            ? {
                id: message.id,
                title: message.title || 'YouTube',
                artist: message.artist || null,
                playing: message.playing,
                at: message.at,
                length: message.length,
              }
            : message.wanted
              ? pagePlayback()
              : null,
      );

      /**
       * Leaving the watch page ends playback in every sense that matters — but
       * only when the page has actually given up, which is what `wanted` says.
       *
       * `hasMedia` alone is not that. Autoplay swaps the <video> element, and
       * for a moment between two tracks the page truthfully has none. Dropping
       * on that is not a recoverable mistake: stopping the service while the
       * app is off screen means the next `raise()` has to *start* a foreground
       * service from the background, which Android 12+ refuses outright. The
       * queue would go quiet mid-playlist with nothing in the log but a warning
       * nobody is reading.
       */
      // Every report, because the thing that decides it — whether the page
      // still means to be playing — changes without the app being told: a
      // pause from the shade, a track ending, the user stopping. Held a
      // moment longer than needed is battery; let go a moment too early is
      // silence.
      syncPin();

      if (!message.hasMedia && !message.wanted) {
        drop();
        return;
      }
      if (!message.hasMedia) return;

      /**
       * No video id means this is not a watch page — a feed, a channel, a
       * search. YouTube autoplays a preview at the top of the home feed, and
       * one that comes up unmuted is enough to make the page look like it is
       * playing something. Raising for that put a card titled "YouTube" over
       * whatever the user actually had on. A notification is for something
       * being watched, and a preview clip is not that.
       */
      if (!message.id) return;

      // Asking is idempotent and remembers its failures, so this runs on every
      // report and does one fetch per video.
      void resolveVideoArtwork(message.id);

      // Raised the moment something plays rather than when the user leaves:
      // Android 12 onwards, a backgrounded process may not start a foreground
      // service, and by then the app is already backgrounded.
      if (message.playing || serviceUp.current) raise(message);
    },
    [raise, drop, syncPin],
  );

  /** Stops the page's own playback — used when local media takes the stage. */
  const pause = useCallback(() => {
    say('pause');
  }, [say]);

  /**
   * The mini bar's transport.
   *
   * `play` is safe from here in a way it is not from the notification: the bar
   * only exists while the app is on screen, so the page is a visible document
   * and is allowed to start media. The notification's play has no such
   * guarantee, which is why that path assumes nothing — see `PLAY_GRACE_MS`.
   */
  const toggle = useCallback(() => {
    say(pagePlayback()?.playing ? 'pause' : 'play');
  }, [say]);

  /** The bar's ×: end the page's session and take the card down with it. */
  const stopPage = useCallback(() => {
    dismissed.current = pagePlayback()?.id ?? media.current?.id ?? null;
    say('stop');
    media.current = null;
    setPagePlayback(null);
    drop();
  }, [say, drop]);

  /**
   * The page is gone and is not coming back on its own.
   *
   * Called when Android kills the WebView's renderer. Everything this hook
   * believes came from a page that no longer exists, and the card is the part
   * that matters: left alone it goes on showing a title, a moving scrubber and
   * a pause button for a video that stopped existing — the most complete
   * version there is of a control that does not do the thing it appears to do.
   */
  const reset = useCallback(() => {
    media.current = null;
    // Nothing is dismissed once there is no page: the renderer that was showing
    // that video is gone, and whatever loads next has not been refused yet.
    dismissed.current = null;
    setPagePlayback(null);
    if (playCheck.current) {
      clearTimeout(playCheck.current);
      playCheck.current = null;
    }
    drop();
  }, [drop]);

  /** A cover arriving after playback started still belongs on the card. */
  useEffect(
    () =>
      onArtworkChange(() => {
        const m = media.current;
        if (m && serviceUp.current && ownsNotification('browser')) raise(m);
      }),
    [raise],
  );

  /**
   * The save finishing is the other thing that changes the card without the
   * page having moved. Same repaint, different trigger — see `revision`.
   */
  useEffect(() => {
    const m = media.current;
    if (m && serviceUp.current && ownsNotification('browser')) raise(m);
  }, [save.revision, raise]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const gone = state !== 'active';
      inject(setPageBackgrounded(gone));

      // A last chance for anything that only started playing as the user left.
      if (gone && media.current?.playing && !serviceUp.current) raise(media.current);

      away.current = gone;
      syncPin();
    });
    return () => sub.remove();
  }, [inject, raise, syncPin]);

  useEffect(() => {
    const sub = onNotificationCommand('browser', ({ command, value }) => {
      console.log(`[spool] playback command from notification: ${command}`);
      if (command === 'seek') {
        seek(value);
        return;
      }

      /**
       * Saving does not touch playback at all — it neither pauses the page nor
       * says anything to it. The user asked for a copy of what they are
       * hearing, not for it to stop while they get one.
       *
       * There is no acknowledgement here either. The download raises its own
       * ongoing notification and appears in Library, and this card drops the
       * button on its next report once the file exists; a toast on top of that
       * would be a third thing saying the same thing.
       */
      if (command === 'save') {
        const m = media.current;
        // Asked again at the moment of the tap. The card is a picture of how
        // things were when it was last painted, and the library is the truth —
        // between the two, a second tap could otherwise start the same download
        // twice.
        if (!m?.id || !saveRef.current.canSave(m.id)) return;
        saveRef.current.onSave({ id: m.id, title: m.title, artist: m.artist || null });
        return;
      }

      /**
       * A play the page cannot honour must not leave the card claiming it did.
       *
       * Off screen the page is a hidden document, and a hidden document may not
       * start media without a user gesture. The page is careful to report only
       * a settled play — but by the time one is refused its timers are frozen,
       * so the report that would correct the card never arrives. The app is the
       * only party still running, so it is the one that has to check: if the
       * page has not said it is playing shortly after being asked, put the card
       * back where it was.
       */
      if (command === 'play') {
        if (playCheck.current) clearTimeout(playCheck.current);
        playCheck.current = setTimeout(() => {
          const m = media.current;
          if (m && !m.playing) raise({ ...m, playing: false });
        }, PLAY_GRACE_MS);
      }
      // Skipping is YouTube's own up-next, which lives behind a button on a
      // page — so the card never offers it for this source, and nothing here
      // has to pretend otherwise.
      if (command !== 'play' && command !== 'pause' && command !== 'stop') return;
      say(command);
      if (command === 'stop') {
        // The same intent as the bar's ×, arriving from the other surface, so
        // it leaves the same thing behind: no card, and no bar waiting on the
        // tab the user comes back to.
        dismissed.current = pagePlayback()?.id ?? media.current?.id ?? null;
        media.current = null;
        setPagePlayback(null);
        drop();
      }
    });
    return () => {
      sub.remove();
      if (playCheck.current) clearTimeout(playCheck.current);
    };
  }, [say, seek, drop, raise]);

  // The notification outlives React, so tearing the tree down has to take it.
  useEffect(() => () => drop(), [drop]);

  return { onMedia, pause, reset, toggle, stopPage };
}
