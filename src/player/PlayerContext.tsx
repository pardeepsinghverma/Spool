import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer,
  preload,
  clearPreloadedSource,
} from 'expo-audio';
import { createVideoPlayer, type VideoPlayer } from 'expo-video';
import { saveSession } from '../core/storage';
import { artworkFor, onArtworkChange } from '../core/artwork';
import { onNotificationCommand, publishNowPlaying, releaseNowPlaying } from './nowPlaying';

/**
 * Playback for downloaded media.
 *
 * The reason this exists is the one thing YouTube charges for: keeping the
 * sound going once the screen is off. Everything here is in service of that.
 *
 * Audio and video are separate engines but one seat — starting either stops the
 * other, so there is always exactly one thing playing and one set of lock
 * screen controls describing it.
 */

export type Track = {
  id: string;
  title: string;
  artist?: string;
  /** MediaStore content:// uri from publishToGallery. */
  uri: string;
  kind: 'audio' | 'video';
};

/** What the repeat control cycles through. See docs/UI.md §03. */
export type Repeat = 'off' | 'all' | 'one';

/**
 * A sleep timer, held as a deadline rather than a countdown.
 *
 * The distinction is load-bearing. A `setTimeout` that has to survive an hour
 * of a backgrounded, dozing process is exactly the thing Android is entitled to
 * defer, and a timer that fires late has already failed at the one job it had.
 * An absolute time is checked against the clock on the tick the player already
 * runs, so a delayed tick catches up instead of drifting, and nothing has to be
 * rescheduled when the process is frozen and thawed.
 */
export type Sleep = {
  at: number | null;
  endOfTrack: boolean;
  /**
   * The duration that was chosen, so the sheet can tick the row the user
   * picked. The sheet's rows are durations from now, and the deadline is not —
   * twelve minutes into a thirty-minute timer, ticking "30 minutes" says *what
   * was asked for*, while the player's own line says what is left. Storing only
   * the deadline meant the sheet ticked nothing at all, which reads as the
   * timer having failed to take.
   */
  minutes: number | null;
};

/** Nothing armed. Named because four places have to say it identically. */
const OFF: Sleep = { at: null, endOfTrack: false, minutes: null };

/** How often the resume point is written while something is loaded. */
const SESSION_FLUSH_MS = 5000;

/**
 * How often the media notification is offered the current state.
 *
 * Nearly all of these are dropped before they reach the bridge — `publishNowPlaying`
 * only pushes when what the card *shows* has changed, and the scrubber moves on
 * its own between pushes. The tick exists so no transport path can be the one
 * that forgot to tell the notification, which is the exact shape of every
 * playback bug this file has already had.
 */
const NOTIFICATION_TICK_MS = 1000;

type PlayerApi = {
  /** Set only while the current track is audio. */
  player: AudioPlayer | null;
  /** Set only while the current track is video. */
  video: VideoPlayer | null;
  track: Track | null;
  /** Plays `next`, or pauses/resumes it when it is already the loaded track. */
  toggle: (next: Track) => Promise<void>;
  /**
   * Play/pause whatever is already loaded.
   *
   * Every surface with a play button must come through here rather than calling
   * `play()` on the player it happens to hold. The lock screen is claimed on
   * first play, and a track resumed by touching the engine directly plays
   * perfectly while attaching no controls — which on Android means the system
   * kills it a few minutes after the app is backgrounded. See AGENTS.md.
   */
  togglePlayback: () => void;
  /** Move the playhead, whichever engine holds it. Seconds. */
  seekTo: (seconds: number) => Promise<void>;
  /**
   * Registered by the shell: run immediately before this app makes any sound,
   * to silence the browser page first.
   *
   * It lives here rather than at each call site because there are five of them
   * and missing one is inaudible in code and obvious in use. Under 'doNotMix'
   * our player takes exclusive audio focus, and a WebView that is still playing
   * takes it straight back — the track resumes for about a tenth of a second
   * and stops. That is what "resume did nothing" looked like from the outside.
   */
  setPlaybackGate: (fn: (() => void) | null) => void;
  stop: () => void;

  /**
   * The queue exists so the transport can be real. Skip buttons and an "Up
   * next" list with nothing behind them would be decoration, and this screen
   * already has enough that has to be true.
   */
  queue: Track[];
  /** Position of the current track within `queue`, or -1 when playing alone. */
  index: number;
  /** Replaces the queue and starts at `start`. */
  play: (tracks: Track[], start: number) => Promise<void>;
  /**
   * Loads a queue **paused**, at `at` seconds. This is the resume path after a
   * kill: the app puts the user back where they were without making noise on
   * launch, which nobody wants from a music app they did not just open to play.
   */
  restore: (tracks: Track[], start: number, at: number) => Promise<void>;
  next: () => Promise<void>;
  previous: () => Promise<void>;
  repeat: Repeat;
  cycleRepeat: () => void;
  shuffle: boolean;
  toggleShuffle: () => void;

  /**
   * When the music stops by itself.
   *
   * `at` is an absolute epoch time rather than a countdown, and `endOfTrack`
   * is the other kind of answer to the same question. Both are null/false when
   * nothing is armed.
   */
  sleep: Sleep;
  /** Minutes, `'track'` for the end of this one, or null to disarm. */
  setSleep: (after: number | 'track' | null) => void;
};

const PlayerCtx = createContext<PlayerApi | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [player, setPlayer] = useState<AudioPlayer | null>(null);
  const [video, setVideo] = useState<VideoPlayer | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [queue, setQueue] = useState<Track[]>([]);
  const [index, setIndex] = useState(-1);
  const [repeat, setRepeat] = useState<Repeat>('off');
  const [shuffle, setShuffle] = useState(false);
  const [sleep, setSleepState] = useState<Sleep>({
    at: null,
    endOfTrack: false,
    minutes: null,
  });
  // Read from inside the finish handler, which is attached once per engine and
  // would otherwise close over the arming that was in force when it was built.
  const sleepRef = useRef(sleep);
  sleepRef.current = sleep;

  // Read by the finish handlers, which are attached once per player and would
  // otherwise close over whatever these were when the track started.
  const repeatRef = useRef<Repeat>(repeat);
  repeatRef.current = repeat;
  const shuffleRef = useRef(shuffle);
  shuffleRef.current = shuffle;
  const advance = useRef<() => void>(() => {});
  /** The queue as the library handed it over, so shuffle can be undone. */
  const original = useRef<Track[]>([]);

  // Players outlive any single render, and releasing them is not optional — a
  // leaked one keeps the audio session and the notification alive.
  const liveAudio = useRef<AudioPlayer | null>(null);
  const liveVideo = useRef<VideoPlayer | null>(null);

  /**
   * Whether this session has ever made a sound, and so whether it is entitled
   * to a notification.
   *
   * Deferred to the first `play()` rather than done on load for two reasons.
   * Restoring a session at launch must not put a paused card in the shade of
   * someone who only opened the app to browse — and publishing is what *starts*
   * the foreground service, which from Android 12 may only happen while the app
   * is on screen. A first play is on screen by definition; a load is not.
   */
  const claimed = useRef(false);

  /** See `setPlaybackGate`. Called before anything here starts making sound. */
  const gate = useRef<(() => void) | null>(null);
  const setPlaybackGate = useCallback((fn: (() => void) | null) => {
    gate.current = fn;
  }, []);
  const silenceOthers = useCallback(() => gate.current?.(), []);

  // Read by the session writer, which runs on a timer and would otherwise
  // persist whatever the queue was when its effect last ran.
  const queueRef = useRef<Track[]>([]);
  queueRef.current = queue;
  const indexRef = useRef(index);
  indexRef.current = index;
  const trackRef = useRef<Track | null>(track);
  trackRef.current = track;

  const dropAudio = useCallback(() => {
    liveAudio.current?.remove();
    liveAudio.current = null;
    setPlayer(null);
  }, []);

  const dropVideo = useCallback(() => {
    liveVideo.current?.release();
    liveVideo.current = null;
    setVideo(null);
  }, []);

  useEffect(
    () => () => {
      dropAudio();
      dropVideo();
    },
    [dropAudio, dropVideo],
  );

  /** Metadata rides on the source — it is what the lock screen reads. */
  const sourceFor = (t: Track) => ({
    uri: t.uri,
    metadata: { title: t.title, artist: t.artist || 'Spool' },
  });

  /**
   * Describe the current track to the media notification.
   *
   * Deliberately not `expo-audio`'s own `setActiveForLockScreen`. That route
   * publishes a Media3 session whose available commands have
   * `SEEK_TO_PREVIOUS_MEDIA_ITEM` and `SEEK_TO_NEXT_MEDIA_ITEM` removed
   * outright, so no amount of configuration puts skip buttons on the card — and
   * a queue-based player whose notification cannot change track is most of the
   * notification missing. Ours is PlaybackService, which both sources share.
   *
   * Cheap to call on a tick: nothing reaches the bridge unless what the card
   * shows has actually changed. See `publishNowPlaying`.
   */
  const publish = useCallback((at?: number) => {
    if (!claimed.current) return;
    const t = trackRef.current;
    const engine = liveAudio.current ?? liveVideo.current;
    if (!t || !engine) return;

    const tracks = queueRef.current;
    const index = indexRef.current;
    /**
     * `at` is passed on a track change, where the engine is not yet a source of
     * truth: `replace()` swaps the file but `currentTime` still reads the
     * *previous* track's playhead for a moment. Publishing that put the new
     * track on the card at the old one's position — measured at 54 seconds into
     * a song that had just started. The tick corrects it a second later, which
     * is a second of the card being wrong for no reason.
     */
    const position = at ?? engine.currentTime ?? 0;

    publishNowPlaying('local', {
      title: t.title,
      artist: t.artist || null,
      source: 'On this device',
      playing: !!engine.playing,
      artwork: artworkFor(t.id)?.uri ?? null,
      position,
      // Zero reads as "not known yet" and the system draws no scrubber, which
      // is the honest state for the moment between loading and the first
      // status update.
      duration: engine.duration && isFinite(engine.duration) ? engine.duration : 0,
      canNext:
        index >= 0 &&
        (index < tracks.length - 1 || (repeatRef.current === 'all' && tracks.length > 1)),
      // `previous` restarts the track past three seconds, exactly as every
      // other player does, so it is a real control there even at the head of
      // the queue.
      canPrevious: tracks.length > 1 || position > 3,
      // Never for a library track: it is already the file a save would produce.
      canSave: false,
    });
  }, []);

  /** Builds an audio engine with the finish handler already attached. */
  const makeAudio = useCallback(
    (t: Track) => {
      const p = createAudioPlayer(t.uri);
      p.addListener('playbackStatusUpdate', (status) => {
        // The duration arrives with the first status update, not at load, so
        // this is also where the scrubber gets its length.
        publish();
        if (!status.didJustFinish) return;
        if (repeatRef.current === 'one') {
          void p.seekTo(0).then(() => p.play());
          return;
        }
        advance.current();
      });
      liveAudio.current = p;
      setPlayer(p);
      return p;
    },
    [publish],
  );

  const makeVideo = useCallback(
    (t: Track) => {
      const p = createVideoPlayer(sourceFor(t));
      p.addListener('playToEnd', () => {
        if (repeatRef.current === 'one') {
          p.currentTime = 0;
          p.play();
          return;
        }
        advance.current();
      });
      p.addListener('timeUpdate', () => publish());
      p.addListener('playingChange', () => publish());
      p.staysActiveInBackground = true;
      /**
       * Off, because PlaybackService already puts one up. Left on, expo-video
       * raises a second Media3 session and Android shows two cards for one app
       * — and the buttons on the wrong one reach a player nothing else in this
       * file knows about.
       */
      p.showNowPlayingNotification = false;
      // Same reasoning as the audio path: controls only attach to a player that
      // owns the audio session outright.
      p.audioMixingMode = 'doNotMix';
      // Only the Now Playing bar reads the clock, and it counts in seconds.
      p.timeUpdateEventInterval = 0.5;
      liveVideo.current = p;
      setVideo(p);
      return p;
    },
    [publish],
  );

  /**
   * 'doNotMix' is not a taste choice. Lock screen controls only attach in that
   * mode, and on Android the system kills background audio after about three
   * minutes without them — so this is what makes screen-off playback work at
   * all, not decoration on top of it.
   */
  const claimAudioSession = useCallback(
    () =>
      setAudioModeAsync({
        playsInSilentMode: true,
        shouldPlayInBackground: true,
        interruptionMode: 'doNotMix',
      }),
    [],
  );

  const toggle = useCallback(
    async (next: Track) => {
      const current = next.kind === 'audio' ? liveAudio.current : liveVideo.current;
      if (current && track?.id === next.id) {
        if (current.playing) {
          current.pause();
          publish();
          return;
        }
        silenceOthers();
        if (next.kind === 'audio') await claimAudioSession();
        current.play();
        // A restored session deliberately has no notification yet, so the first
        // play of this track is where it gets one.
        claimed.current = true;
        publish();
        return;
      }

      silenceOthers();

      if (next.kind === 'video') {
        dropAudio();

        // Reused rather than replaced when one already exists: releasing a
        // player the VideoView is still holding is how that view ends up
        // pointed at freed native state.
        const existing = liveVideo.current;
        if (existing) {
          setTrack(next);
          await existing.replaceAsync(sourceFor(next));
          existing.play();
          claimed.current = true;
          trackRef.current = next;
          publish(0);
          return;
        }

        setTrack(next);
        makeVideo(next).play();
        claimed.current = true;
        trackRef.current = next;
        publish(0);
        return;
      }

      dropVideo();
      await claimAudioSession();

      /**
       * Reused rather than replaced, for the same reason the video path is:
       * only one player may own the lock screen, and under 'doNotMix' that
       * ownership is the audio session itself. Tearing down the old player and
       * standing up a new one for the next track loses the handoff — the new
       * player reports the right duration, seeks correctly, and never makes a
       * sound. Measured on a queue skip; play() afterwards did nothing either.
       */
      const existing = liveAudio.current;
      if (existing) {
        setTrack(next);
        existing.replace(next.uri);
        existing.play();
        claimed.current = true;
        // trackRef follows a render, and a queue advance while the app is off
        // screen has to describe the new track now rather than a tick later.
        trackRef.current = next;
        publish(0);
        return;
      }

      const p = makeAudio(next);
      setTrack(next);
      p.play();
      claimed.current = true;
      trackRef.current = next;
      publish(0);
    },
    [
      track,
      dropAudio,
      dropVideo,
      makeAudio,
      makeVideo,
      claimAudioSession,
      publish,
      silenceOthers,
    ],
  );

  /**
   * The one play/pause every button routes through, so the notification claim
   * cannot be skipped by a surface that happens to hold the player object.
   */
  const togglePlayback = useCallback(() => {
    const audio = liveAudio.current;
    if (audio) {
      if (audio.playing) {
        audio.pause();
        publish();
        return;
      }
      silenceOthers();
      // Started before the session call resolves: waiting on it would put a
      // perceptible gap between the tap and the sound for no benefit, and the
      // mode lands a moment later either way.
      audio.play();
      void claimAudioSession();
      if (trackRef.current) claimed.current = true;
      publish();
      return;
    }

    const v = liveVideo.current;
    if (!v) return;
    if (v.playing) {
      v.pause();
      publish();
      return;
    }
    silenceOthers();
    v.play();
    if (trackRef.current) claimed.current = true;
    publish();
  }, [claimAudioSession, publish, silenceOthers]);

  /**
   * Pause whatever is playing, without going through `togglePlayback`.
   *
   * The rule that every *play* goes through the context is about claiming the
   * lock screen; a pause claims nothing. And the toggle would be actively
   * wrong here — the sleep timer firing on something already paused would
   * *start* it, which is the one outcome a sleep timer must never produce.
   */
  const pauseNow = useCallback(() => {
    const engine = liveAudio.current ?? liveVideo.current;
    if (!engine?.playing) return;
    engine.pause();
    publish();
  }, [publish]);

  const setSleep = useCallback((after: number | 'track' | null) => {
    if (after === null) {
      setSleepState(OFF);
      return;
    }
    if (after === 'track') {
      setSleepState({ at: null, endOfTrack: true, minutes: null });
      return;
    }
    setSleepState({ at: Date.now() + after * 60_000, endOfTrack: false, minutes: after });
  }, []);

  /**
   * The deadline, checked on the tick the player already runs rather than on a
   * timer of its own. See `Sleep` for why an absolute time.
   */
  useEffect(() => {
    if (!sleep.at) return;
    const check = () => {
      if (Date.now() < (sleepRef.current.at ?? Infinity)) return;
      pauseNow();
      setSleepState(OFF);
    };
    const timer = setInterval(check, 1000);
    // Immediately too, so a process thawed after an hour asleep does not wait
    // another second before honouring a deadline that passed long ago.
    check();
    return () => clearInterval(timer);
  }, [sleep.at, pauseNow]);

  /**
   * Warm the next track so the boundary is a swap rather than a load.
   *
   * **This is not gapless and must not be described as gapless.** True gapless
   * on Android is an ExoPlayer playlist — `expo-audio` has one, as
   * `AudioPlaylist`, and it is a *second* player object with its own session.
   * Adopting it would mean rebuilding the one file in this app whose rules were
   * all learned the hard way: one player reused across the queue, the lock
   * screen claimed on first play, `doNotMix` for exclusive focus. What this
   * does instead is remove the part of the gap that is load latency, which for
   * a local file is most of what a listener hears.
   *
   * Audio only, and one at a time. `AudioPreloadManager` on the Android side
   * reads the whole source into a `ByteArray` and holds it until it is cleared
   * — fine for one 6 MB track, not for a queue of them, and not for video at a
   * hundred times the size.
   */
  const warmed = useRef<string | null>(null);
  useEffect(() => {
    if (index < 0) return;
    const upcoming = queue[index + 1];
    const uri = upcoming && upcoming.kind === 'audio' ? upcoming.uri : null;
    if (uri === warmed.current) return;

    const previous = warmed.current;
    warmed.current = uri;
    // Released before the next is fetched, so the store never holds two.
    if (previous) void clearPreloadedSource(previous).catch(() => {});
    // A failure here costs a moment at the boundary and nothing else, so it is
    // swallowed rather than surfaced: there is no action for the user in it.
    if (uri) void preload(uri).catch(() => {});
  }, [queue, index]);

  // The store outlives React, so tearing the tree down has to release it.
  useEffect(
    () => () => {
      if (warmed.current) void clearPreloadedSource(warmed.current).catch(() => {});
      warmed.current = null;
    },
    [],
  );

  const seekTo = useCallback(
    async (seconds: number) => {
      const target = Math.max(0, seconds);
      const audio = liveAudio.current;
      if (audio) {
        await audio.seekTo(target);
        publish();
        return;
      }
      const v = liveVideo.current;
      if (!v) return;
      v.currentTime = target;
      publish();
    },
    [publish],
  );

  const stop = useCallback(() => {
    dropAudio();
    dropVideo();
    claimed.current = false;
    trackRef.current = null;
    releaseNowPlaying('local');
    setTrack(null);
    setQueue([]);
    setIndex(-1);
    // Stopping is a decision, not an interruption: there is no place to return
    // to, so the next launch must not offer one — and a timer left armed over
    // silence would be waiting to pause something that no longer exists.
    setSleepState(OFF);
    void saveSession(null);
  }, [dropAudio, dropVideo]);

  /**
   * The resume path. Loads everything `play` would, then stops short of the one
   * thing that makes noise — so the app reopens exactly where it was left
   * without starting audio nobody asked for on launch.
   */
  const restore = useCallback(
    async (tracks: Track[], start: number, at: number) => {
      if (!tracks.length) return;
      const idx = Math.min(Math.max(0, start), tracks.length - 1);
      const next = tracks[idx];

      /**
       * Every other path that builds a player drops the old one first; this one
       * did not, and a second call therefore orphaned a live engine. Observed
       * after a Fast Refresh remounted the shell: two of our own media sessions,
       * one playing at 4:51 and one paused at 4:11, the UI bound to the paused
       * one and the audible player unreachable by any control on screen. Boot
       * calls this once — but "only called once" is not a property this can
       * check, and the failure it produces is audio nothing can stop.
       */
      dropAudio();
      dropVideo();
      // A restored session has not played anything, so it is not entitled to a
      // card — and putting one up here would mean starting a foreground service
      // during launch for a track nobody has asked to hear.
      claimed.current = false;
      releaseNowPlaying('local');
      original.current = tracks;
      setQueue(tracks);
      setIndex(idx);
      setTrack(next);
      trackRef.current = next;

      if (next.kind === 'video') {
        const p = makeVideo(next);
        if (at > 0) p.currentTime = at;
        return;
      }

      // Deliberately not claimAudioSession(): taking the session under
      // 'doNotMix' interrupts whatever else is playing, and this path has not
      // been asked for sound at all. The first play() through `toggle` does it.
      const p = makeAudio(next);
      if (at > 0) await p.seekTo(at);
    },
    [makeAudio, makeVideo, dropAudio, dropVideo],
  );

  const play = useCallback(
    async (tracks: Track[], start: number) => {
      if (!tracks.length) return;
      const at = Math.min(Math.max(0, start), tracks.length - 1);
      setQueue(tracks);
      setIndex(at);
      await toggle(tracks[at]);
    },
    [toggle],
  );

  /**
   * Step by `delta`, wrapping only when repeat is 'all'. Reaching the end with
   * repeat off stops rather than silently restarting — a queue that loops
   * forever without being asked to is how a phone plays music all night.
   */
  const step = useCallback(
    async (delta: number) => {
      if (index < 0 || !queue.length) return;
      const target = index + delta;
      if (target < 0 || target >= queue.length) {
        if (repeatRef.current !== 'all') return;
        const wrapped = (target + queue.length) % queue.length;
        setIndex(wrapped);
        // Ahead of the render, so the notification's skip buttons describe the
        // track that is about to play rather than the one that just ended.
        indexRef.current = wrapped;
        await toggle(queue[wrapped]);
        return;
      }
      setIndex(target);
      indexRef.current = target;
      await toggle(queue[target]);
    },
    [index, queue, toggle],
  );

  const next = useCallback(() => step(1), [step]);

  /** What a finished track does: exactly what the Up next list says it will. */
  advance.current = () => {
    /**
     * "End of track" is the other shape of the same request, and it is answered
     * here rather than by pausing after the advance: letting the next track
     * start and then stopping it is audibly wrong, and on a queue of short
     * tracks it is how someone wakes up two songs later.
     */
    if (sleepRef.current.endOfTrack) {
      setSleepState(OFF);
      pauseNow();
      return;
    }
    void step(1);
  };

  /**
   * Restarts the track when the user is more than a few seconds in, which is
   * what every other player does and what the thumb expects.
   */
  const previous = useCallback(async () => {
    const current = liveAudio.current ?? liveVideo.current;
    const at = current?.currentTime ?? 0;
    if (at > 3) {
      if (liveAudio.current) await liveAudio.current.seekTo(0);
      else if (liveVideo.current) liveVideo.current.currentTime = 0;
      publish(0);
      return;
    }
    await step(-1);
  }, [step, publish]);

  const cycleRepeat = useCallback(() => {
    setRepeat((prev) => (prev === 'off' ? 'all' : prev === 'all' ? 'one' : 'off'));
  }, []);

  /**
   * Shuffle reorders the queue rather than randomising each pick. Choosing at
   * random would leave "Up next" naming a track that is not going to play next,
   * and that list is the only promise this screen makes about the future.
   *
   * Only what is still ahead is shuffled; already-played entries keep their
   * order so going back does not rewrite history under the user.
   */
  const toggleShuffle = useCallback(() => {
    setShuffle((on) => {
      const turningOn = !on;
      setQueue((current) => {
        if (index < 0 || current.length < 3) return current;
        if (turningOn) {
          original.current = current;
          const head = current.slice(0, index + 1);
          const tail = current.slice(index + 1);
          for (let i = tail.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tail[i], tail[j]] = [tail[j], tail[i]];
          }
          return [...head, ...tail];
        }
        // Back to the library's own order, with the playing track still current.
        const restored = original.current.length ? original.current : current;
        const playing = current[index];
        const at = restored.findIndex((t) => t.id === playing?.id);
        if (at >= 0) setIndex(at);
        return restored;
      });
      return turningOn;
    });
  }, [index]);

  /**
   * The resume point, written on a timer rather than on every tick. A kill can
   * come at any moment and is never announced, so there is no "save on exit"
   * hook to rely on — the cost of being wrong is a few seconds of replay.
   */
  useEffect(() => {
    if (!track) return;

    const write = () => {
      const engine = liveAudio.current ?? liveVideo.current;
      const tracks = queueRef.current;
      void saveSession({
        ids: tracks.length ? tracks.map((t) => t.id) : [track.id],
        index: tracks.length ? Math.max(0, indexRef.current) : 0,
        at: engine?.currentTime ?? 0,
      });
    };

    write();
    const timer = setInterval(write, SESSION_FLUSH_MS);
    return () => {
      clearInterval(timer);
      write();
    };
  }, [track]);

  /**
   * The notification's backstop.
   *
   * Every transport path publishes for itself, and one of them will eventually
   * be added that does not — that is the failure this file has had twice
   * already, and it is silent both times. A tick that offers the current state
   * once a second cannot be forgotten, and costs nothing when nothing changed:
   * the arbiter drops a publish that would not alter the card.
   */
  useEffect(() => {
    if (!track) return;
    const timer = setInterval(publish, NOTIFICATION_TICK_MS);
    return () => clearInterval(timer);
  }, [track, publish]);

  /** Covers land after playback starts, so the card has to be told. */
  useEffect(() => onArtworkChange(publish), [publish]);

  /**
   * The other half of the notification: what its buttons, the lock screen and
   * the headset ask for.
   *
   * `play` and `pause` are routed through `togglePlayback` rather than reaching
   * for the engine, for the reason that rule exists at all — and they check the
   * current state first, because these arrive as explicit verbs. A `play` that
   * blindly toggled would pause a track the card had simply drawn stale.
   */
  useEffect(() => {
    const sub = onNotificationCommand('local', ({ command, value }) => {
      const engine = liveAudio.current ?? liveVideo.current;
      switch (command) {
        case 'play':
          if (engine && !engine.playing) togglePlayback();
          break;
        case 'pause':
          if (engine?.playing) togglePlayback();
          break;
        case 'next':
          void next();
          break;
        case 'previous':
          void previous();
          break;
        case 'seek':
          void seekTo(value);
          break;
        case 'stop':
          stop();
          break;
      }
    });
    return () => sub.remove();
  }, [togglePlayback, next, previous, seekTo, stop]);

  // The notification outlives React, so tearing the tree down has to take it.
  useEffect(() => () => releaseNowPlaying('local'), []);

  const value = useMemo<PlayerApi>(
    () => ({
      player,
      video,
      track,
      toggle,
      togglePlayback,
      seekTo,
      setPlaybackGate,
      stop,
      queue,
      index,
      play,
      restore,
      next,
      previous,
      repeat,
      cycleRepeat,
      shuffle,
      toggleShuffle,
      sleep,
      setSleep,
    }),
    [
      player,
      video,
      track,
      toggle,
      togglePlayback,
      seekTo,
      setPlaybackGate,
      stop,
      queue,
      index,
      play,
      restore,
      next,
      previous,
      repeat,
      cycleRepeat,
      shuffle,
      toggleShuffle,
      sleep,
      setSleep,
    ],
  );

  return <PlayerCtx.Provider value={value}>{children}</PlayerCtx.Provider>;
}

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error('usePlayer must be used inside a PlayerProvider');
  return ctx;
}
