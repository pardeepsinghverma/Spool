import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  Easing,
  PermissionsAndroid,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type { WebViewMessageEvent, WebViewProps } from 'react-native-webview';
import Svg, { Circle } from 'react-native-svg';
import type { Format } from '../core/engine';
import {
  DEFAULT_SETTINGS,
  hasSeenFirstRun,
  loadDownloads,
  loadSearches,
  loadSession,
  loadSettings,
  markFirstRunSeen,
  adoptSaved,
  loadForgotten,
  saveDownloads,
  saveForgotten,
  saveSearches,
  saveSettings,
  type DownloadRecord,
  type Settings,
} from '../core/storage';
import { describePlays, ranked, type PlayStat } from '../core/plays';
import { findDuplicate, runtimeLabel, type Match } from '../core/similar';
import { clean, knownArtists } from '../core/metadata';
import { buildBackup, describeExport, playlistToM3u } from '../core/export';
import {
  loadPlaylists,
  savePlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addTracks,
  removeTrack,
  moveTrack,
  resolve as resolvePlaylist,
  describePlaylist,
  type Playlist,
} from '../core/playlists';
import {
  artworkFor,
  forgetArtwork,
  loadArtworkIndex,
  resolveArtwork,
  useArtworkVersion,
} from '../core/artwork';
import { usePlayTracking } from './usePlayTracking';
import {
  IS_PREVIEW,
  engineVersion,
  initEngine,
  listFormats,
  publishToGallery,
  writeTextFile,
  scanSaved,
  startDownload,
  updateEngine,
  type VideoMeta,
} from '../core/ytdlp';
import { FirstRunScreen } from '../screens/FirstRunScreen';
import { NowPlayingBar } from '../player/NowPlayingBar';
import { usePlayer } from '../player/PlayerContext';
import { HomeScreen, type RepeatRow } from '../screens/HomeScreen';
import {
  LibraryScreen,
  type LibraryItem,
  type OpenPlaylist,
  type PlaylistRow,
} from '../screens/LibraryScreen';
import {
  AUDIO_QUALITIES,
  ProfileScreen,
  VIDEO_QUALITIES,
  type AutoSave,
} from '../screens/ProfileScreen';
import { SearchScreen, type LocalHit } from '../screens/SearchScreen';
import { TabBar, type Tab } from '../shell/TabBar';
import { PlayerScreen } from '../player/PlayerScreen';
import { ChoiceSheet } from '../sheets/ChoiceSheet';
import { NameSheet } from '../sheets/NameSheet';
import { PreReleaseSheet } from '../sheets/PreReleaseSheet';
import { refreshTrial, refuseSave, setPreReleaseOpener, trial } from '../core/trial';
import { QualitySheet, type SheetMode } from '../sheets/QualitySheet';
import { useTheme } from '../ui/ThemeContext';
import { fixed, motion, radius, size, space, type, tintFromDominant } from '../ui/theme';
import { ADBLOCK_SCRIPT } from './adblock';
import { BACKGROUND_SCRIPT, type MediaMessage } from './background';
import { useBackgroundPlayback } from './useBackgroundPlayback';
import type { DownloadState } from './DownloadButton';
import {
  bestAudio,
  bestVideo,
  heightFromQuality,
  isAudioPick,
  kbpsFromQuality,
  toFormatRows,
  toQuickPicks,
} from './formatView';
import { POTOKEN_SCRIPT, type PoTokenMessage } from './potoken';
import {
  HOME_URL,
  NAV_SCRIPT,
  USER_AGENT,
  extractVideoId,
  hostOf,
  type NavMessage,
} from './youtube';

/**
 * The shell: five tabs plus the one-time first-run gate. See docs/UI.md §02.
 *
 * The WebView is mounted once here and simply hidden off the Browse tab —
 * unmounting it would cost a page reload every time the user checked their
 * library, which is the opposite of what a persistent player is for.
 */
type Screen = 'firstrun' | Tab;

/** One running download, as Library's Downloading section needs it. */
type Job = {
  id: string;
  title: string;
  quality: string;
  audioOnly: boolean;
  /** 0..1. Stays at 0 until yt-dlp reports its first fraction. */
  progress: number;
  /** True when the replay rule started it rather than the user. */
  auto: boolean;
  /**
   * What is being saved, where that is known.
   *
   * Carried so a second request for the same video can be recognised as one
   * already in flight — the notification's save button is the case that made
   * this necessary, since it can be tapped again while the first download is
   * still extracting and nothing on screen says so.
   */
  videoId?: string;
  /**
   * Waiting its turn rather than running.
   *
   * A tap adds to this list and returns the button immediately, so several can
   * be waiting at once — but the browser's own downloads are started one at a
   * time, because `DownloadService` keeps a single `currentId` and a single
   * ongoing notification. Run two and the card flickers between them, its cancel
   * button stops whichever started last, and the first job to finish sends
   * ACTION_STOP and drops the foreground service out from under the others.
   *
   * The replay rule shares the same chain. The notification's save button and a
   * failed row's retry still start the moment they are asked — they always did,
   * and neither can be asked for in a burst the way the button can — so the
   * single-slot rule is not yet absolute. See docs/RELIABILITY.md.
   */
  queued: boolean;
  /** Each job cancels itself, so an automatic one cannot stop a manual one. */
  cancel: () => void;
};

/** What the notification's save button knows about what it is saving. */
type SaveRequest = { id: string; title: string; artist: string | null };

/**
 * Read off the prop rather than imported: react-native-webview declares this
 * type in `lib/WebViewTypes` and re-exports only a handful from its root, and
 * reaching into a package's internals for a type is how an upgrade breaks a
 * build for no reason.
 */
type RendererGone = Parameters<NonNullable<WebViewProps['onRenderProcessGone']>>[0];

/**
 * An error whose message is already the sentence the user should read, marked
 * so the yt-dlp translator leaves it alone.
 */
function stated(message: string): Error {
  return Object.assign(new Error(message), { code: 'E_STATED' });
}

/**
 * All three hooks must beat the page's own scripts, so they share one
 * injection. Background playback is the strictest of them: it only works if its
 * visibility listeners are registered ahead of YouTube's.
 */
const PRELOAD = ADBLOCK_SCRIPT + POTOKEN_SCRIPT + BACKGROUND_SCRIPT;

export function BrowserScreen() {
  const { t, reduced, setTint } = useTheme();
  const webview = useRef<WebView>(null);
  /** Bumps as covers land, so the view models below pick them up. */
  const artVersion = useArtworkVersion();

  const [screen, setScreen] = useState<Screen>('browse');
  const [query, setQuery] = useState('');
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [autoSave, setAutoSave] = useState<Settings>(DEFAULT_SETTINGS);
  const [booted, setBooted] = useState(false);
  const [url, setUrl] = useState(HOME_URL);
  const [title, setTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);

  const [dl, setDl] = useState<DownloadState>('idle');
  const [progress, setProgress] = useState(0);
  /**
   * In-flight downloads. v1 narrated these in the bottom pill; v2 removed that
   * chrome, so this list is the only place the app admits a download is
   * happening. Without it the FAB tap looks like it did nothing.
   */
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  /**
   * The pre-release notice. Opened once per cold launch rather than once ever:
   * this build expires, and a tester who never reads why reads "it stopped
   * working" instead. Also opened on demand by the trial chip.
   */
  const [preRelease, setPreRelease] = useState(false);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [quality, setQuality] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  /**
   * The extraction engine's real version, read from the native module at boot.
   * Until this lands the Profile row has nothing honest to say, so it says
   * "checking" rather than claiming to be up to date.
   */
  const [engine, setEngine] = useState<{ version: string; busy: boolean }>({
    version: '',
    busy: false,
  });

  const token = useRef<{ poToken: string; visitorData: string }>({
    poToken: '',
    visitorData: '',
  });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const {
    track: playing,
    player: audioPlayer,
    video,
    toggle,
    play: playQueue,
    restore: restoreQueue,
    setPlaybackGate,
    sleep,
    setSleep,
  } = usePlayer();

  /**
   * Which row the sleep sheet ticks — what was asked for, not what is left. The
   * player's own line carries the countdown; see `Sleep` in PlayerContext.
   */
  const sleepValue = sleep.endOfTrack ? 'track' : sleep.minutes ? String(sleep.minutes) : 'off';
  const playingId = playing?.id;
  const [videoOpen, setVideoOpen] = useState(false);

  /**
   * Stops whatever Spool itself is playing. Held in a ref because the WebView's
   * message handler is subscribed once and must not be torn down and rebuilt
   * every time the loaded player changes — doing that mid-video drops messages,
   * and those messages are what the play counter runs on.
   */
  const localEngines = useRef<{ audio: typeof audioPlayer; video: typeof video }>({
    audio: null,
    video: null,
  });
  localEngines.current = { audio: audioPlayer, video };
  const pauseLocal = useCallback(() => {
    const { audio, video: v } = localEngines.current;
    if (audio?.playing) audio.pause();
    if (v?.playing) v.pause();
  }, []);

  /**
   * Whether this app is making a sound of its own right now.
   *
   * Asked before the page is silenced on its behalf: the rule is mutual
   * exclusion, and with nothing local playing there is nothing to be exclusive
   * with. See the message handler.
   */
  const localSounding = useCallback(() => {
    const { audio, video: v } = localEngines.current;
    return !!audio?.playing || !!v?.playing;
  }, []);

  /** The video id the page last reported as playing, or null while it is not. */
  const browserPlaying = useRef<string | null>(null);

  /**
   * Recovery from Android killing the WebView's renderer.
   *
   * The renderer is a separate, sandboxed process, and while the app is off
   * screen it is one of the first things the system reclaims under memory
   * pressure. react-native-webview reports it and returns `true` so the app
   * does not die with it — which is the whole of the handling there was. The
   * WebView is left mounted and permanently dead: Android's contract is that
   * the instance must never be used again, so it does not repaint, does not
   * navigate, and reloading it does nothing. Coming back to the app showed a
   * page stuck mid-load, which is exactly the report.
   *
   * `entry` is what a fresh instance loads and changes *only* here. Binding it
   * to the live URL instead would hand the WebView a new source on every
   * navigation and make it reload the page the user had just left.
   */
  const [entry, setEntry] = useState(HOME_URL);
  const [webviewKey, setWebviewKey] = useState(0);
  const entryRef = useRef(HOME_URL);
  /**
   * Read by the WebView's message handler, which is subscribed once. Making it
   * depend on `screen` would rebuild the handler on every tab change, and the
   * messages it drops in the meantime are what the play counter runs on.
   */
  const screenRef = useRef<Screen>(screen);
  screenRef.current = screen;
  /**
   * The page on screen right now.
   *
   * A download outlives the page it was started from — that is the point of
   * freeing the button — so anything reporting back has to ask where the user
   * is *now*, not close over where they were.
   */
  const videoIdRef = useRef<string | null>(null);

  /**
   * The notification's save button, which is answered further down this file
   * than the hook that offers it. Assigned like `runAutoSave` below, for the
   * same reason: the hook subscribes once, and must not be rebuilt whenever the
   * library it consults changes.
   */
  const cardCanSave = useRef<(videoId: string) => boolean>(() => false);
  const cardSave = useRef<(video: SaveRequest) => void>(() => {});

  const {
    onMedia,
    pause: pauseBrowserMedia,
    reset: resetBrowserMedia,
    toggle: toggleBrowserMedia,
    stopPage: stopBrowserMedia,
  } = useBackgroundPlayback(webview, {
    canSave: (id) => cardCanSave.current(id),
    onSave: (video) => cardSave.current(video),
    // Two counts rather than their sum: a save finishing retires a job and adds
    // a record, which leaves any total unchanged at exactly the moment the card
    // most needs repainting.
    revision: `${records.length}:${jobs.length}`,
  });

  /**
   * Silence the page before this app makes any sound — from any of the places
   * that can start playback, including the mini bar and the full player's own
   * buttons, which never had a way to reach the WebView.
   */
  useEffect(() => {
    setPlaybackGate(pauseBrowserMedia);
    return () => setPlaybackGate(null);
  }, [setPlaybackGate, pauseBrowserMedia]);

  /** The trial chip lives in three screen headers; this is how it opens. */
  useEffect(() => {
    setPreReleaseOpener(() => setPreRelease(true));
    return () => setPreReleaseOpener(null);
  }, []);

  /**
   * Uris the user removed while keeping the file, so a rescan cannot undo it.
   * A ref rather than state: nothing renders from it, and `forget` writes to it
   * from inside a state updater.
   */
  const forgottenRef = useRef<string[]>([]);

  /**
   * Pull anything already in the gallery into the library.
   *
   * Called at boot *and* again the moment first run grants media permission,
   * because those two orderings disagree on a fresh install: the boot scan runs
   * before the user has been asked for anything, and reading files another
   * install wrote needs `READ_MEDIA_*`. Without the second call a reinstalling
   * user taps through the notice, lands on an empty Library over a full folder,
   * and only gets their music back if they happen to relaunch. Measured on the
   * phone: 0 adopted on first launch, 43 on the next.
   */
  const adoptFromGallery = useCallback(() => {
    void scanSaved()
      .then((found) => {
        if (!found.length) return;
        setRecords((prev) => {
          const merged = adoptSaved(prev, found, forgottenRef.current);
          if (merged.length !== prev.length) {
            console.log(`[spool] adopted ${merged.length - prev.length} file(s) from the gallery`);
          }
          return merged;
        });
      })
      .catch(() => {
        // No permission yet, or nothing there. The library keeps whatever was
        // stored, which is the behaviour this feature improves on rather than
        // replaces.
      });
  }, []);

  /** Which Profile row has a picker open, if any. */
  const [picker, setPicker] = useState<'audio' | 'video' | null>(null);

  /**
   * Playlists — the one part of the library the app never rearranges. Held here
   * with the records rather than in the screen, because the queue they build is
   * handed to the player and the screen is unmounted every time the user
   * changes tab.
   */
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  /** Which one is open, by id — a deleted playlist closes itself. */
  const [openList, setOpenList] = useState<string | null>(null);
  /**
   * The naming sheet: creating one, or renaming the one already open.
   *
   * `then` is what asked for it, and it is handed the list it was just added
   * to. Reaching "New playlist…" from the Add-to sheet has to end with the
   * track in the new playlist — without it the user names one, lands in it, and
   * finds the track they were filing is not there, which reads as the feature
   * not working. It takes the array rather than reading state because the
   * creation has not been flushed by the time it runs.
   */
  const [naming, setNaming] = useState<
    { id?: string; value: string; then?: (listId: string, lists: Playlist[]) => void } | null
  >(null);
  /** The track waiting to be filed, while the "Add to" sheet is up. */
  const [filing, setFiling] = useState<DownloadRecord | null>(null);
  /** The sleep-timer sheet, reached from the full player. */
  const [sleepSheet, setSleepSheet] = useState(false);

  /**
   * Read by the rule, which fires from a WebView message rather than a render,
   * so it must not close over a snapshot of the settings taken minutes ago.
   */
  const settingsRef = useRef(autoSave);
  settingsRef.current = autoSave;

  /**
   * Every download, one at a time — automatic and manual alike.
   *
   * The automatic rule needed this first: several thresholds can fall in one
   * session, and a queue of long videos all extracting at once would compete
   * for bandwidth with whatever the user is currently watching, which is the
   * one thing an invisible feature must never do.
   *
   * Manual downloads joined it when the button stopped being held for the
   * length of a download. Freeing the button means several can be asked for in
   * a row, and `DownloadService` cannot take that — see `Job.queued`. Sharing
   * one chain is also simply the honest reading of "download list": things in a
   * list are dealt with in order.
   */
  const downloadQueue = useRef<Promise<void>>(Promise.resolve());

  /**
   * Jobs cancelled before they ever started.
   *
   * A queued job has no native download to stop, so its cancel takes it off the
   * list and leaves this behind for the runner to find — otherwise the chain
   * reaches it a minute later and starts something the user already dismissed.
   */
  const abandoned = useRef<Set<string>>(new Set());
  const runAutoSave = useRef<(stat: PlayStat) => Promise<void>>(async () => {});

  const onPlayCounted = useCallback((stat: PlayStat) => {
    const settings = settingsRef.current;
    if (!settings.enabled) return;
    if (stat.savedAt) return;
    if (stat.starts < settings.after) return;
    downloadQueue.current = downloadQueue.current
      .then(() => runAutoSave.current(stat))
      .catch(() => {});
  }, []);

  const {
    plays,
    onMedia: trackMedia,
    markSaved,
    forget: forgetPlays,
  } = usePlayTracking(onPlayCounted);

  const videoId = useMemo(() => extractVideoId(url), [url]);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    // The notice clears itself on one of these timers, so cancelling them all
    // without this leaves it on screen for good. It bit the duplicate warning
    // first: the second tap that answers it starts a download, and starting a
    // download clears the timers — so the warning would sit there advising a
    // confirmation the user had already given, over a job already running.
    setNotice(null);
  }, []);

  // Boot: restore state, warm the engine, ask for notification permission.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [seen, saved, settings, searches, session, forgotten, lists] = await Promise.all([
        hasSeenFirstRun(),
        loadDownloads(),
        loadSettings(),
        loadSearches(),
        loadSession(),
        loadForgotten(),
        loadPlaylists(),
        // Before anything renders, so a library whose covers are already known
        // comes up with them rather than flashing placeholders on every launch.
        loadArtworkIndex(),
      ]);
      if (!alive) return;
      setRecords(saved);
      setAutoSave(settings);
      setPlaylists(lists);
      // Before the scan below, or the first adoption runs with an empty list
      // and hands back everything the user has ever removed.
      forgottenRef.current = forgotten;

      // The files outlive the app; this index does not. Off the critical path
      // on purpose — the library paints from what was stored, and anything the
      // gallery turns up folds in a moment later rather than holding the first
      // frame behind a MediaStore query.
      adoptFromGallery();
      setRecentSearches(searches);
      setScreen(seen ? 'browse' : 'firstrun');
      setBooted(true);

      // The limits come from the native side, which is the only copy of them
      // that a patched bundle cannot rewrite. A brand-new install reads the
      // legal notice before the sales pitch, so the sheet is deferred to the
      // end of first run rather than dropped — a tester who installs, taps
      // through and never relaunches would otherwise never be told this is a
      // pre-release at all, which is the one thing they must be told.
      const limits = refreshTrial();
      if (limits.trial && seen) setPreRelease(true);

      /**
       * Put the user back where they were. The session stores ids rather than
       * tracks, so this is also where a queue entry whose download was removed
       * in the meantime quietly disappears instead of restoring as a row that
       * plays nothing.
       */
      if (session) {
        const byId = new Map(saved.filter((r) => r.uri).map((r) => [r.id, r]));
        const survivors = session.ids
          .map((id) => byId.get(id))
          .filter((r): r is DownloadRecord => !!r);
        if (survivors.length) {
          // The playing track may itself be the one that went. Land on whatever
          // now occupies its place, from the start — resuming a *different*
          // track at the old track's playhead would be worse than either.
          const wanted = session.ids[session.index];
          const at = survivors.findIndex((r) => r.id === wanted);
          void restoreQueue(
            survivors.map((r) => toTrack(r)),
            at >= 0 ? at : 0,
            at >= 0 ? session.at : 0,
          );
        }
      }

      // Extracting the bundled Python takes a moment on first launch; do it now
      // rather than making the user wait on their first download.
      initEngine().catch(() => {});
      engineVersion()
        .then((v) => alive && setEngine({ version: v, busy: false }))
        .catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- boot runs once

  useEffect(
    () => () => {
      clearTimers();
      // Downloads are deliberately *not* cancelled here. They are on a queue and
      // under a foreground service, and the only thing that unmounts this is the
      // app going away — at which point a half-finished job the user asked for
      // should keep going, not be thrown away by a teardown they did not see.
    },
    [clearTimers],
  );

  // Guarded on `booted`, not on the list being non-empty: skipping the write
  // when the list is empty meant removing the last item never reached disk, and
  // it came back on the next launch.
  useEffect(() => {
    if (booted) void saveDownloads(records);
  }, [records, booted]);

  useEffect(() => {
    if (booted) void saveSearches(recentSearches);
  }, [recentSearches, booted]);

  // Same rule as the library above: guarded on `booted` rather than on the list
  // having anything in it, or deleting the last playlist would never reach disk.
  useEffect(() => {
    if (booted) void savePlaylists(playlists);
  }, [playlists, booted]);

  // Skipped until boot has replaced the defaults, or the first render would
  // write the defaults straight over whatever the user last chose.
  useEffect(() => {
    if (booted) void saveSettings(autoSave);
  }, [autoSave, booted]);

  // Stopping playback dismisses the player with it, so a later track does not
  // arrive with the screen already open behind it. Keyed on the track rather
  // than the video engine: the player is the full screen for audio too now, and
  // watching `video` would slam it shut the moment an audio track began.
  useEffect(() => {
    if (!playing) setVideoOpen(false);
  }, [playing]);

  /**
   * Where a replacement WebView should pick up. A ref, so following the page
   * costs no render and cannot itself become a reason to reload.
   */
  useEffect(() => {
    if (/^https?:/i.test(url)) entryRef.current = url;
  }, [url]);

  /**
   * The quality sheet belongs to Browse — it describes the page under it. It
   * sits above the tab container so it can cover the WebView, which also means
   * nothing stops it hanging over Library or Profile once the user moves on.
   * Leaving the tab is a clear enough "not now"; the download itself is
   * unaffected, since only picking a format starts one.
   */
  useEffect(() => {
    if (screen !== 'browse') setSheet(null);
  }, [screen]);

  useEffect(() => {
    videoIdRef.current = videoId;
  }, [videoId]);

  // Page nav resets the button, which restarts the pulse — once per navigation.
  useEffect(() => {
    // A "save anyway" was granted for one page, not for the session. Leaving and
    // coming back is a fresh decision, and a warning that only ever appears once
    // per video is one the user cannot get back to read.
    confirmed.current = null;
    if (dl === 'working' || dl === 'resolving') return;
    setDl(videoId ? 'ready' : 'idle');
    setProgress(0);
  }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (picker) {
        setPicker(null);
        return true;
      }
      // Closing the player is not stopping it — playback carries on behind,
      // and the Now Playing bar is the way back in.
      if (videoOpen) {
        setVideoOpen(false);
        return true;
      }
      if (sheet) {
        setSheet(null);
        return true;
      }
      // An open playlist is a place inside the Library tab, so back leaves it
      // before back leaves the tab. Without this the gesture skipped a whole
      // level and dropped the user on Browse from two screens in.
      if (openList) {
        setOpenList(null);
        return true;
      }
      if (screen === 'browse' && canGoBack) {
        webview.current?.goBack();
        return true;
      }
      // Any other tab falls back to Browse rather than exiting — leaving the
      // app from Library after two taps would feel like a dropped gesture.
      if (screen !== 'browse' && screen !== 'firstrun') {
        setScreen('browse');
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [sheet, screen, canGoBack, videoOpen, picker, openList]);

  /**
   * The FAB's wake. Three pulses when a watch page resolves, then stillness —
   * it is the only notice that anything here can be kept, and a button that
   * pulsed forever would become wallpaper within a day.
   */
  const pulse = useRef(new Animated.Value(0)).current;
  /** Grows over the hold so the three seconds are visibly doing something. */
  const hold = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!videoId || dl !== 'ready' || reduced || screen !== 'browse') return;
    pulse.setValue(0);
    const beat = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: motion.fabPulse / 2,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: motion.fabPulse / 2,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
      { iterations: motion.fabPulses },
    );
    beat.start();
    return () => {
      beat.stop();
      pulse.setValue(0);
    };
  }, [videoId, dl, reduced, screen, pulse]);

  const flashNotice = useCallback(
    // A passing remark can go in three seconds. A duplicate warning is a
    // question the user has to answer, so it is given long enough to read and
    // act on before it clears itself.
    (text: string, ms = 3000) => {
      setNotice(text);
      later(() => setNotice(null), ms);
    },
    [later],
  );

  /**
   * The page a "save anyway" has already been granted for.
   *
   * A similar match is a guess, so it may not block outright — but it may not
   * be a toast either, or the second tap that follows a warning nobody read
   * downloads the duplicate anyway. Arming this for the current video turns the
   * warning into a confirmation without a dialog: the first tap explains, the
   * second one commits. Navigating away changes `videoId` and the next page
   * gets its own warning.
   */
  const confirmed = useRef<string | null>(null);

  /**
   * Android took the renderer. Rebuild the WebView on the page it was showing.
   *
   * Three things have to happen together, and the order is not arbitrary. The
   * card goes first, because until it does it is describing a video that no
   * longer exists — and if the user is looking at the shade rather than the
   * app, that card is the only thing they can see. Then the entry point moves
   * to wherever they had got to, and only then does the key change, because the
   * replacement instance reads `entry` as it mounts.
   *
   * Playback genuinely is over at this point and nothing here pretends
   * otherwise. A hidden document may not start media without a gesture, so a
   * fresh page cannot resume itself off screen; the honest outcome is silence,
   * the notification gone, and the video where they left it when they return.
   */
  const onRenderProcessGone = useCallback(
    (event: RendererGone) => {
      const crashed = event.nativeEvent.didCrash;
      console.warn(
        `[spool] webview renderer ${crashed ? 'crashed' : 'was killed by the system'}` +
          ` — restoring ${entryRef.current}`,
      );
      resetBrowserMedia();
      browserPlaying.current = null;
      setEntry(entryRef.current);
      setWebviewKey((k) => k + 1);
    },
    [resetBrowserMedia],
  );

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    setUrl(nav.url);
    setCanGoBack(nav.canGoBack);
    setCanGoForward(nav.canGoForward);
    if (nav.title) setTitle(nav.title.replace(/\s*-\s*YouTube\s*$/, '').trim());
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: NavMessage | PoTokenMessage | MediaMessage;
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      if (message.type === 'media') {
        /**
         * The other boundary where a name enters the app, and the wider of the
         * two: what the page reports here becomes the play index, the mini
         * bar's sub-line, the media card, and — through the replay rule — the
         * title of a file the user later finds in their gallery. Cleaning it
         * once, here, is why none of those four has to know what "(Official
         * Music Video)" is.
         *
         * `message.music` is deliberately left as the page set it. That flag is
         * YouTube saying "this is a track" and it decides what *Match* keeps; an
         * artist recovered from a dash is something to show, not a second
         * opinion about what the video is.
         *
         * The object is only rebuilt when a name actually changed, because this
         * arrives once a second and `pageNowPlaying` drops publishes that would
         * not change what the card shows.
         */
        const named = clean(
          { title: message.title, artist: message.artist },
          artistHints.current,
        );
        const media =
          named.title === message.title && named.artist === message.artist
            ? message
            : { ...message, title: named.title, artist: named.artist };

        onMedia(media);
        trackMedia(media);

        /**
         * "Opening a video in the web view pauses Spool's own player" — the
         * other half of a rule that only ever ran in one direction. Two things
         * playing at once is never what was meant.
         *
         * Two guards, both found by testing rather than by reading:
         *
         * 1. Keyed on the page *starting* something, not on it merely being
         *    playing. The page reports once a second, so a plain
         *    `if (message.playing)` also fires on a report sampled just before
         *    our own pause reached the page — pausing the library track the user
         *    had that instant started, from the tap that asked for it.
         *
         * 2. **Only while the user is on Browse.** The WebView is never
         *    unmounted, so a hidden page can resume on its own — YouTube does
         *    this readily — and that read as a fresh start and paused the track
         *    the user had just tapped play on, from a tab where the browser was
         *    not even visible. Measured: it resumed for 92ms and stopped again.
         *    The rule is about the user opening a video; when something starts
         *    in a tab they are not looking at, the thing to stop is the page.
         */
        const startedSomething = message.playing && browserPlaying.current !== message.id;
        browserPlaying.current = message.playing ? message.id : null;
        if (startedSomething) {
          if (screenRef.current === 'browse') pauseLocal();
          /**
           * Third guard, and the one that was missing: silence the page only if
           * this app is actually making a sound to protect.
           *
           * The rule is mutual exclusion, so with nothing local playing there is
           * nothing to be exclusive with — and the cost of getting that wrong is
           * paid at exactly the worst moment. A Mix advancing to its next track
           * is a page "starting something", so with the user parked on any tab
           * but Browse and the phone in a pocket, every track boundary killed
           * the queue. Silence, from the one rule meant to prevent two things
           * playing at once, with nothing playing at all.
           */
          else if (localSounding()) pauseBrowserMedia();
        }
        return;
      }

      if (message.type === 'potoken') {
        // Keep whichever values we have; a later message may only carry one.
        if (message.poToken) token.current.poToken = message.poToken;
        if (message.visitorData) token.current.visitorData = message.visitorData;
        return;
      }

      if (message.type !== 'nav') return;
      setUrl(message.url);
      setTitle(message.title);
      // v1 mirrored the page's light/dark theme into the chrome. v2 keeps one
      // dark ground and borrows its surfaces from the artwork instead, so the
      // probe's theme field is read and deliberately ignored.
    },
    [onMedia, trackMedia, pauseLocal, localSounding, pauseBrowserMedia],
  );

  const finish = useCallback(
    (record: DownloadRecord) => {
      setRecords((prev) => [
        record,
        // Any earlier save of the same video is now a dead entry. Both paths
        // write to one output file, and publishing to the gallery *moves* it —
        // so a manual save of something already kept automatically deletes the
        // file the old row points at. Dropping that row here is what stops the
        // library listing a track that will not play.
        ...prev.filter((r) => !(record.videoId && r.videoId === record.videoId)),
      ]);
      // A save has just spent one of the trial's slots.
      refreshTrial();

      // The button is not told anything here. A download now outlives the page
      // it was started from, so a finished job has no claim on whatever is on
      // screen — and it does not need one: `fabState` reads the library, so the
      // tick appears by itself if the user is still on the page that earned it,
      // and stays away if they are not.
      if (videoIdRef.current && videoIdRef.current === record.videoId) {
        flashNotice(`Saved “${record.title}”`);
      }
    },
    [flashNotice],
  );

  const beginDownload = useCallback(
    // `info` lets an instant download pass the formats it just resolved:
    // setMeta has not re-rendered yet at that point, so reading component
    // state here would look up the pick in the *previous* video's list.
    async (pickId: string, info?: VideoMeta) => {
      const source = info ?? meta;
      if (!source || !videoId) return;
      const clean = pickId.replace(':explicit', '');
      const format = source.formats.find((f: Format) => f.id === clean);
      if (!format) return;

      const audioOnly = isAudioPick(clean, source.formats);
      const label = audioOnly ? 'audio' : `${format.height}p`;
      const jobId = `${videoId}-${Date.now()}`;

      // Checked here so the refusal can be worded, and again natively before
      // anything downloads. See src/core/trial.ts for why both.
      const refused = refuseSave(source.durationSeconds);
      if (refused) {
        setSheet(null);
        setDl(videoId ? 'ready' : 'idle');
        flashNotice(refused);
        return;
      }

      setQuality(label);
      setSheet(null);
      setError(null);

      // The button is free the moment the job is on the list. Holding it for
      // the length of a download made the browser feel like a queue of one:
      // nothing else could be asked for until this finished, on a screen whose
      // whole purpose is finding the next thing.
      setDl(videoId ? 'ready' : 'idle');
      setProgress(0);

      setJobs((prev) => [
        {
          id: jobId,
          title: source.title || title || 'Untitled',
          quality: label,
          audioOnly,
          progress: 0,
          auto: false,
          videoId,
          queued: true,
          // Nothing native exists to stop yet, so this takes it off the list and
          // tells the runner not to bother when its turn comes.
          cancel: () => {
            abandoned.current.add(jobId);
            setJobs((prev) => prev.filter((j) => j.id !== jobId));
          },
        },
        ...prev,
      ]);
      flashNotice('Added to downloads');

      const started = videoId;
      downloadQueue.current = downloadQueue.current
        .then(async () => {
          if (abandoned.current.delete(jobId)) return;

          const job = startDownload(
            {
              id: jobId,
              ref: { videoId: started, url, title: source.title || title },
              format,
              audioOnly,
              token: token.current,
              seconds: source.durationSeconds,
            },
            (p) => {
              const fraction = p.fraction ?? 0;
              setJobs((prev) =>
                prev.map((j) => (j.id === jobId ? { ...j, progress: fraction } : j)),
              );
            },
          );

          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId ? { ...j, queued: false, cancel: job.cancel } : j,
            ),
          );

          // Whatever happens next, the job stops being in flight.
          const retire = () => setJobs((prev) => prev.filter((j) => j.id !== jobId));

          try {
            const out = await job.promise;
            // Only a MediaStore record makes the file visible in Gallery.
            const uri = await publishToGallery(out.path, source.title || title, audioOnly);
            retire();
            finish({
              id: jobId,
              title: source.title || title || 'Untitled',
              quality: label,
              uri,
              bytes: out.bytes,
              audioOnly,
              savedAt: Date.now(),
              state: 'saved',
              videoId: started,
              artist: started ? playsRef.current[started]?.artist : undefined,
              seconds: source.durationSeconds,
            });
          } catch (e: any) {
            retire();
            if (e?.code === 'E_CANCELLED') return;

            const reason = readableError(e, 'download');
            setRecords((prev) => [
              {
                id: jobId,
                title: source.title || title || 'Untitled',
                quality: label,
                audioOnly,
                savedAt: Date.now(),
                state: 'failed',
                error: reason,
                // Without this a failed row does not know which video it was,
                // and the only thing it can offer is to forget itself. The
                // automatic path always recorded it; the manual one never did.
                videoId: started,
              },
              ...prev,
            ]);

            // The failure belongs to the page it was asked for, which by now may
            // not be the page on screen. Marking the button failed regardless
            // would blame whatever the user happened to be looking at.
            if (videoIdRef.current === started) {
              setError(reason);
              setDl('failed');
            } else {
              flashNotice(`Couldn't save “${source.title || title}”. It is in Library as failed.`);
            }
          }
        })
        .catch(() => {});
    },
    [meta, videoId, url, title, finish],
  );

  /**
   * The replay rule's own download. Deliberately not `beginDownload`:
   *
   * - it saves whatever page the user is on now, not this one, so it carries
   *   its own id and url rather than reading component state;
   * - it never touches the FAB or the sheet, because the user did not ask for
   *   anything and must not be interrupted mid-video;
   * - it never publishes to MediaStore. A manual save belongs in the gallery;
   *   hundreds of automatic ones do not, so these stay app-private and are
   *   played from a file:// path. See AGENTS.md.
   */
  const autoSaveStat = useCallback(
    async (stat: PlayStat) => {
      const settings = settingsRef.current;
      const watchUrl = `https://m.youtube.com/watch?v=${stat.id}`;
      const jobId = `auto-${stat.id}-${Date.now()}`;
      const name = stat.title || 'Untitled';

      // Claimed before any slow work, so a second threshold crossing while this
      // is still extracting cannot start the same download twice.
      markSaved(stat.id);

      // Already on the device because the user asked for it. Downloading it a
      // second time would waste the bandwidth and produce a duplicate row.
      if (records.some((r) => r.videoId === stat.id && r.state === 'saved')) return;

      try {
        const info = await listFormats(
          { videoId: stat.id, url: watchUrl, title: stat.title },
          token.current,
        );

        const wantAudio =
          settings.keepAs === 'audio' ||
          (settings.keepAs === 'match' && stat.music !== false);

        const format = wantAudio
          ? bestAudio(info.formats, kbpsFromQuality(settings.audioQuality))
          : bestVideo(info.formats, heightFromQuality(settings.videoQuality));
        if (!format) return;

        const audioOnly = format.kind === 'audio';
        const label = audioOnly ? 'audio' : `${format.height}p`;

        // The rule has no interface, so a trial refusal here says nothing and
        // simply does not save. The video stays unmarked, so it is retried
        // once the tester has a full copy.
        if (refuseSave(info.durationSeconds)) return;

        const job = startDownload(
          {
            id: jobId,
            ref: { videoId: stat.id, url: watchUrl, title: info.title || name },
            format,
            audioOnly,
            token: token.current,
            seconds: info.durationSeconds,
          },
          (p) => {
            const fraction = p.fraction ?? 0;
            setJobs((prev) =>
              prev.map((j) => (j.id === jobId ? { ...j, progress: fraction } : j)),
            );
          },
        );

        setJobs((prev) => [
          {
            id: jobId,
            title: info.title || name,
            quality: label,
            audioOnly,
            progress: 0,
            auto: true,
            videoId: stat.id,
            // Started as it is added: it is already at the head of the queue.
            queued: false,
            cancel: job.cancel,
          },
          ...prev,
        ]);

        const out = await job.promise;
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        setRecords((prev) => [
          {
            id: jobId,
            title: info.title || name,
            quality: label,
            uri: `file://${out.path}`,
            bytes: out.bytes,
            audioOnly,
            savedAt: Date.now(),
            state: 'saved',
            auto: true,
            videoId: stat.id,
            artist: stat.artist || undefined,
          },
          ...prev,
        ]);
        console.log(`[spool] auto-saved ${stat.id} after ${stat.starts} plays`);
      } catch (e: any) {
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        if (e?.code === 'E_CANCELLED') return;
        // Recorded rather than swallowed: an automatic save that fails silently
        // leaves the user believing they have a file they do not have. It stays
        // marked as taken, so this does not become a retry loop.
        setRecords((prev) => [
          {
            id: jobId,
            title: name,
            quality: settings.keepAs === 'video' ? settings.videoQuality : 'audio',
            audioOnly: settings.keepAs !== 'video',
            savedAt: Date.now(),
            state: 'failed',
            error: readableError(e, 'download'),
            auto: true,
            videoId: stat.id,
          },
          ...prev,
        ]);
      }
    },
    [markSaved, records],
  );

  runAutoSave.current = autoSaveStat;

  /**
   * The notification's save button. A third download path, and deliberately so
   * — the two above it are both wrong for this one.
   *
   * `beginDownload` wants a format the user picked from a sheet, and the whole
   * point here is that there is no screen: the phone is in a pocket. So the
   * quality comes from the Profile defaults, exactly as the replay rule's does.
   *
   * `autoSaveStat` is closer but not the same in the two ways that matter: this
   * *is* a deliberate save, so it publishes to the gallery like any other
   * manual one, and it must not mark the video as taken by the replay rule —
   * the rule counts plays, and one save from the shade should not spend the
   * user's third play on a file they already asked for.
   */
  const saveFromCard = useCallback(
    async (video: SaveRequest) => {
      const settings = settingsRef.current;
      const watchUrl = `https://m.youtube.com/watch?v=${video.id}`;
      const jobId = `card-${video.id}-${Date.now()}`;
      const name = video.title || 'Untitled';

      /**
       * Claimed before any slow work. Extraction takes seconds, the button is
       * still on the card for all of them, and a second tap would otherwise
       * start the same download twice — the one failure mode a control with no
       * screen behind it cannot show the user.
       */
      setJobs((prev) => [
        {
          id: jobId,
          title: name,
          quality: settings.keepAs === 'video' ? settings.videoQuality : 'audio',
          audioOnly: settings.keepAs !== 'video',
          progress: 0,
          auto: false,
          videoId: video.id,
          // Extraction is already under way, so this is working, not waiting.
          queued: false,
          cancel: () => {},
        },
        ...prev,
      ]);

      const retire = () => setJobs((prev) => prev.filter((j) => j.id !== jobId));

      try {
        const info = await listFormats(
          { videoId: video.id, url: watchUrl, title: video.title },
          token.current,
        );

        // What the page called itself decides what "Match" keeps, the same way
        // the replay rule reads it.
        const wantAudio =
          settings.keepAs === 'audio' ||
          (settings.keepAs === 'match' && playsRef.current[video.id]?.music !== false);

        const format = wantAudio
          ? bestAudio(info.formats, kbpsFromQuality(settings.audioQuality))
          : bestVideo(info.formats, heightFromQuality(settings.videoQuality));
        if (!format) throw stated('This page has no downloadable media');

        const audioOnly = format.kind === 'audio';
        const label = audioOnly ? 'audio' : `${format.height}p`;

        // Checked here so a refused save is recorded with a reason a tester can
        // read, and again natively before anything downloads. See core/trial.ts.
        const refused = refuseSave(info.durationSeconds);
        if (refused) throw stated(refused);

        const job = startDownload(
          {
            id: jobId,
            ref: { videoId: video.id, url: watchUrl, title: info.title || name },
            format,
            audioOnly,
            token: token.current,
            seconds: info.durationSeconds,
          },
          (p) => {
            const fraction = p.fraction ?? 0;
            setJobs((prev) =>
              prev.map((j) => (j.id === jobId ? { ...j, progress: fraction } : j)),
            );
          },
        );

        setJobs((prev) =>
          prev.map((j) =>
            j.id === jobId ? { ...j, quality: label, audioOnly, cancel: job.cancel } : j,
          ),
        );

        const out = await job.promise;
        // A manual save belongs in the gallery, wherever the tap came from.
        const uri = await publishToGallery(out.path, info.title || name, audioOnly);
        retire();
        setRecords((prev) => [
          {
            id: jobId,
            title: info.title || name,
            quality: label,
            uri,
            bytes: out.bytes,
            audioOnly,
            savedAt: Date.now(),
            state: 'saved',
            videoId: video.id,
            seconds: info.durationSeconds,
            artist: video.artist || playsRef.current[video.id]?.artist || undefined,
          },
          ...prev,
        ]);
        console.log(`[spool] saved ${video.id} from the notification`);
      } catch (e: any) {
        retire();
        if (e?.code === 'E_CANCELLED') return;
        /**
         * Recorded rather than swallowed. The user is not looking at the app —
         * a failure that leaves no trace means they find out when they go
         * looking for a file that was never there, which is the worst possible
         * moment. The row in Library is the only honest answer.
         */
        setRecords((prev) => [
          {
            id: jobId,
            title: name,
            quality: settings.keepAs === 'video' ? settings.videoQuality : 'audio',
            audioOnly: settings.keepAs !== 'video',
            savedAt: Date.now(),
            state: 'failed',
            // A refusal and a missing format already say exactly what happened;
            // running them through the yt-dlp translator would turn both into
            // "Extraction failed — try updating the engine", which is a lie
            // about the trial and a wild goose chase about the format.
            error: e?.code === 'E_STATED' ? String(e.message) : readableError(e, 'download'),
            videoId: video.id,
          },
          ...prev,
        ]);
      }
    },
    [],
  );

  cardSave.current = saveFromCard;

  /**
   * Offered only where it is real: a page that is not already a file, and not
   * one already being turned into one. Both halves matter — the first stops the
   * card offering to save something the library already has, and the second
   * stops a second tap during the seconds extraction takes.
   */
  cardCanSave.current = (id: string) =>
    !records.some((r) => r.videoId === id && r.state === 'saved') &&
    !jobs.some((j) => j.videoId === id);

  const resolve = useCallback(async () => {
    if (!videoId) return;
    clearTimers();
    setError(null);
    setDl('resolving');
    try {
      const info = await listFormats({ videoId, url, title }, token.current);
      setMeta(info);
      setDl('ready');
      setSheet(info.formats.length ? 'quick' : 'empty');
    } catch (e) {
      setError(readableError(e));
      setDl('failed');
      setSheet('error');
    }
  }, [videoId, url, title, clearTimers, records, flashNotice]);

  /**
   * A tap commits. No sheet, no choice — it takes whatever "instant" is set to
   * and starts, because the common case is wanting this one the same way as the
   * last one. The choice still exists; it lives behind the hold.
   */
  const instantDownload = useCallback(async () => {
    if (!videoId) return;
    clearTimers();
    setError(null);
    setDl('resolving');
    try {
      const info = await listFormats({ videoId, url, title }, token.current);
      setMeta(info);

      // A tap commits, so this is the last place a duplicate can be caught
      // before one is made. An exact match never gets here — the button is
      // already showing "saved" and a tap opens Library instead.
      const duplicate = findDuplicate(records, {
        videoId,
        title: info.title || title,
        seconds: info.durationSeconds,
      });
      if (duplicate && confirmed.current !== videoId) {
        confirmed.current = videoId;
        setDl('ready');
        flashNotice(describeDuplicate(duplicate, true), 7000);
        return;
      }

      const settings = settingsRef.current;
      const format =
        settings.instant === 'audio'
          ? bestAudio(info.formats, kbpsFromQuality(settings.audioQuality))
          : bestVideo(info.formats, heightFromQuality(settings.videoQuality));

      // Nothing of the requested kind — fall back to the sheet rather than
      // failing silently, since the user did ask for something.
      if (!format) {
        setDl('ready');
        setSheet(info.formats.length ? 'quick' : 'empty');
        return;
      }
      await beginDownload(format.id, info);
    } catch (e) {
      setError(readableError(e));
      setDl('failed');
      setSheet('error');
    }
  }, [videoId, url, title, clearTimers, beginDownload, records, flashNotice]);


  /**
   * The saved row this page is already a copy of, if there is one.
   *
   * Only the exact half is used for the button: `videoId` is proof, so the FAB
   * can say "saved" without hedging. A merely similar row is a guess and is
   * handled at the moment of the tap instead, where there is room to say what
   * was matched and let the user overrule it.
   */
  const alreadySaved = useMemo(
    () => (videoId ? records.find((r) => r.videoId === videoId && r.state === 'saved') : undefined),
    [videoId, records],
  );

  /**
   * What the button actually shows.
   *
   * Derived rather than stored, because the stored state has to go back to
   * `ready` after a save — `finish` resets it once the tick has been seen — and
   * an already-saved page must not offer to save itself again the moment that
   * reset lands. Deriving also covers the slower case: the library loads after
   * boot, so a page opened immediately is `ready` for a moment before its own
   * row arrives.
   *
   * The hold is deliberately still live in this state. Saving the video after
   * keeping the audio is a real thing to want, and it is one three-second press
   * away — it is only the accidental second tap that is worth refusing.
   */
  const fabState: DownloadState = !videoId
    ? 'idle'
    : dl === 'ready' && alreadySaved
      ? 'done'
      : dl;

  /**
   * The duplicate sentence the format sheet shows, if any.
   *
   * Said there, not enforced: reaching the sheet took a three-second hold and
   * picking a format is another deliberate act, so the user has already made it
   * clear they mean it and all this owes them is the fact. It is derived rather
   * than stored so it cannot outlive what it describes — the browser's notice
   * strip is the wrong surface for it either way, since the sheet is a `Modal`
   * and covers that strip entirely.
   */
  const sheetDuplicate = useMemo(() => {
    if (!sheet || !meta) return null;
    const duplicate = findDuplicate(records, {
      // Not narrowed here the way it is inside the download paths; a page with
      // no id still gets the title-and-runtime test, which is the half that
      // works for rows the gallery gave back anyway.
      videoId: videoId ?? undefined,
      title: meta.title || title,
      seconds: meta.durationSeconds,
    });
    return duplicate ? describeDuplicate(duplicate, false) : null;
  }, [sheet, meta, records, videoId, title]);

  const onDownloadPress = useCallback(() => {
    switch (fabState) {
      case 'ready':
      case 'failed':
        void instantDownload();
        break;
      case 'done':
        setScreen('library');
        break;
      default:
        break;
    }
  }, [fabState, instantDownload]);

  /** The hold is the way to every other format, and to changing what a tap does. */
  const onDownloadHold = useCallback(() => {
    if (dl === 'working' || !videoId) return;
    void resolve();
  }, [dl, videoId, resolve]);

  // v1 narrated download state in a pill in the bottom chrome. v2 has no
  // chrome: progress lives in Library under Downloading and in the ongoing
  // notification, and the FAB carries the only in-page state there is.

  const saved = useMemo(() => records.filter((r) => r.state === 'saved'), [records]);

  /**
   * Ask for any cover we do not have yet. `resolveArtwork` is idempotent and
   * remembers failures, so running this on every library change costs one map
   * lookup per item after the first pass.
   */
  useEffect(() => {
    if (!booted) return;
    saved.forEach((r) => void resolveArtwork(r));
  }, [saved, booted]);

  /**
   * The first rule in the book: the app is a frame around the art. This is the
   * line that makes it true — the whole palette follows whatever is playing,
   * and returns to the neutral ground when nothing is.
   *
   * Only the *playing* item tints the app, not the last one browsed. A theme
   * that follows the finger rather than the sound turns scrolling a library
   * into a light show.
   */
  useEffect(() => {
    const art = playing ? artworkFor(playing.id) : null;
    setTint(art ? tintFromDominant(art.dominant) : null);
  }, [playing, artVersion, setTint]);

  /**
   * The record's own artist where it has one, and the play index where it does
   * not — which is every item saved before the field existed. The index is
   * capped and drops saved entries first, so it is a fallback rather than the
   * store: what it knows is copied onto the record at save time.
   */
  const artistFor = useCallback(
    (r: DownloadRecord) => r.artist || (r.videoId ? plays[r.videoId]?.artist : undefined) || undefined,
    [plays],
  );

  /**
   * Read by the download callbacks, which are created once and would otherwise
   * ask a play index from whenever they were last built — which for a video the
   * user is watching right now is a snapshot taken before it had a name.
   */
  const playsRef = useRef(plays);
  playsRef.current = plays;

  /**
   * Every artist the app has already seen, for the one guess `clean` is allowed
   * to make — reading "Coldplay - Yellow" as a name and a song only where
   * Coldplay is somebody this library has heard of.
   *
   * A ref because the WebView's message handler is subscribed once and must not
   * be rebuilt when the library changes; a memo because the set is rebuilt from
   * up to 500 rows and the handler runs once a second.
   */
  const artistHints = useRef<ReadonlySet<string>>(new Set<string>());
  artistHints.current = useMemo(
    () => knownArtists(records, Object.values(plays)),
    [records, plays],
  );

  const asTrack = useCallback(
    (r: DownloadRecord) => toTrack(r, artistFor),
    [artistFor],
  );

  /**
   * Starting a track starts the library behind it, so the transport and "Up
   * next" have something real to move through. Everything playable is in the
   * queue, in the order it is shown.
   */
  const playRecord = useCallback(
    (r: DownloadRecord) => {
      if (!r.uri) return;
      const current = playingId === r.id;

      // Tapping the row of the thing already playing is a pause, not a restart
      // of the whole queue.
      if (current) {
        void toggle(asTrack(r));
        return;
      }

      // Silencing the page is the player context's gate now, so it covers
      // resuming the loaded track too — which this branch used to skip by
      // returning early above, leaving the page holding the audio focus.
      const playable = saved.filter((x) => x.uri);
      const at = playable.findIndex((x) => x.id === r.id);
      void playQueue(playable.map(asTrack), Math.max(0, at));
      if (!r.audioOnly) setVideoOpen(true);
    },
    [playingId, toggle, pauseBrowserMedia, saved, asTrack, playQueue],
  );

  const forget = useCallback((id: string) => {
    setRecords((prev) => {
      // The file survives a removal by design, which means the gallery scan
      // would find it again on the next launch and hand back the row the
      // dialog just promised was gone. Remembered by uri because that is what
      // the scan matches on.
      const going = prev.find((x) => x.id === id);
      if (going?.uri) {
        forgottenRef.current = [going.uri, ...forgottenRef.current.filter((u) => u !== going.uri)];
        void saveForgotten(forgottenRef.current);
      }
      return prev.filter((x) => x.id !== id);
    });
    // Otherwise a re-download of the same thing inherits the old row's cached
    // "no artwork here" and never looks again.
    forgetArtwork(id);
  }, []);

  /**
   * Try a failed download again.
   *
   * The row's copy has always said what went wrong; until now the only thing it
   * offered was to forget it, which means the answer to "the connection dropped"
   * was to go back to Browse, find the video again and start over. The record
   * already knows the video and what was asked for, so it can just re-run —
   * and the old row goes, because a retry that leaves its own failure sitting
   * above the result reads as though it failed twice.
   */
  const retry = useCallback(
    async (record: DownloadRecord) => {
      if (!record.videoId) return;
      const watchUrl = `https://m.youtube.com/watch?v=${record.videoId}`;
      const jobId = `retry-${record.videoId}-${Date.now()}`;
      const settings = settingsRef.current;
      forget(record.id);

      try {
        const info = await listFormats(
          { videoId: record.videoId, url: watchUrl, title: record.title },
          token.current,
        );
        const format = record.audioOnly
          ? bestAudio(info.formats, kbpsFromQuality(settings.audioQuality))
          : bestVideo(info.formats, heightFromQuality(record.quality));
        if (!format) throw new Error('No downloadable format');

        const label = record.audioOnly ? 'audio' : `${format.height}p`;
        const refused = refuseSave(info.durationSeconds);
        if (refused) throw new Error(refused);

        const job = startDownload(
          {
            id: jobId,
            ref: { videoId: record.videoId, url: watchUrl, title: info.title || record.title },
            format,
            audioOnly: record.audioOnly,
            token: token.current,
            seconds: info.durationSeconds,
          },
          (p) => {
            const fraction = p.fraction ?? 0;
            setJobs((prev) =>
              prev.map((j) => (j.id === jobId ? { ...j, progress: fraction } : j)),
            );
          },
        );

        setJobs((prev) => [
          {
            id: jobId,
            title: info.title || record.title,
            quality: label,
            audioOnly: record.audioOnly,
            progress: 0,
            auto: false,
            videoId: record.videoId,
            // Started as it is added: it is already at the head of the queue.
            queued: false,
            cancel: job.cancel,
          },
          ...prev,
        ]);

        const out = await job.promise;
        // A retry of something the user asked for is still a manual save, so it
        // belongs in the gallery exactly as the first attempt would have.
        const uri = await publishToGallery(
          out.path,
          info.title || record.title,
          record.audioOnly,
        );
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        setRecords((prev) => [
          {
            id: jobId,
            title: info.title || record.title,
            quality: label,
            uri,
            bytes: out.bytes,
            audioOnly: record.audioOnly,
            savedAt: Date.now(),
            state: 'saved',
            videoId: record.videoId,
            artist:
              record.artist ||
              (record.videoId ? playsRef.current[record.videoId]?.artist : undefined),
          },
          ...prev.filter((r) => !(r.videoId && r.videoId === record.videoId)),
        ]);
      } catch (e: any) {
        setJobs((prev) => prev.filter((j) => j.id !== jobId));
        if (e?.code === 'E_CANCELLED') return;
        setRecords((prev) => [
          {
            ...record,
            id: jobId,
            savedAt: Date.now(),
            state: 'failed',
            error: readableError(e, 'download'),
          },
          ...prev,
        ]);
      }
    },
    [forget],
  );

  const library: LibraryItem[] = useMemo(
    () =>
      records.map((r) => ({
        id: r.id,
        // Kind follows what was asked for, not whether it worked — a failed
        // music download still belongs on the Music tab.
        kind: r.audioOnly ? 'audio' : 'video',
        title: r.title,
        artist: artistFor(r),
        /**
         * The artist leads where one is known, because that is what a person
         * scanning a music library is reading — and it is what "Artist A–Z"
         * has just grouped the list by.
         *
         * "Saved automatically" vs "You saved this" stays, in second place. It
         * is the only trace the replay rule leaves anywhere in the app, so it
         * may be moved but not dropped. The quality gives up its place instead:
         * it is the least useful of the three on a row that already carries a
         * size, and it is still on the player and in the sheet.
         */
        subtitle:
          r.state === 'failed'
            ? (r.error ?? 'Download failed')
            : artistFor(r)
              ? `${artistFor(r)} · ${r.auto ? 'Saved automatically' : 'You saved this'}`
              : r.auto
                ? `Saved automatically · ${r.quality}`
                : `You saved this · ${r.quality}`,
        size: r.bytes ? `${Math.round(r.bytes / 1_000_000)} MB` : undefined,
        bytes: r.bytes,
        art: artworkFor(r.id)?.uri,
        failed: r.state === 'failed',
        onPress: r.uri ? () => playRecord(r) : undefined,
        // A failed row's options are "try it again" and "forget it". Only the
        // second existed, so the copy named a cause the user could do nothing
        // about from where they were standing.
        onMore: () =>
          r.state === 'failed' && r.videoId
            ? offerRetry(r, retry, forget)
            : r.uri
              // A saved row has two things worth doing now, and "remove" is the
              // destructive one, so it stops being what the glyph does on its
              // own and becomes one of two named answers.
              ? offerSavedActions(r, {
                  file: () => setFiling(r),
                  remove: () => confirmForget(r, forget),
                })
              : confirmForget(r, forget),
      })),
    [records, playRecord, forget, retry, artistFor, artVersion],
  );

  /**
   * Playing a playlist plays *that* list, not the library behind it. The queue
   * and "Up next" are the only promise the player makes about what happens
   * next, so a playlist that started the whole library from a matching row
   * would break it on the very first skip.
   */
  const playFromList = useCallback(
    (list: Playlist, at: number) => {
      const tracks = resolvePlaylist(list, records);
      if (!tracks.length) return;
      const start = Math.min(Math.max(0, at), tracks.length - 1);
      void playQueue(tracks.map(asTrack), start);
      if (!tracks[start].audioOnly) setVideoOpen(true);
    },
    [records, asTrack, playQueue],
  );

  /**
   * Worked out against the current list rather than inside a `setPlaylists`
   * updater. An updater has to be pure — React is entitled to run it twice —
   * and this one has to say what it did, which is exactly the kind of side
   * effect that shows up as a notice appearing twice and nothing else.
   */
  const fileInto = useCallback(
    (lists: Playlist[], listId: string, record: DownloadRecord) => {
      const list = lists.find((p) => p.id === listId);
      const out = addTracks(lists, listId, [record.id], Date.now());
      setPlaylists(out.playlists);
      // The counts come back from the store so this can say which of the three
      // things happened, rather than leaving the user to go and count rows.
      flashNotice(
        out.added
          ? `Added to “${list?.name ?? 'playlist'}”`
          : out.duplicate
            ? `Already in “${list?.name ?? 'playlist'}”`
            : `“${list?.name ?? 'Playlist'}” is full`,
      );
    },
    [flashNotice],
  );

  const addToList = useCallback(
    (listId: string, record: DownloadRecord) => fileInto(playlists, listId, record),
    [playlists, fileInto],
  );

  /**
   * Writing a playlist out, and writing all of them out.
   *
   * The library rebuilds itself from MediaStore after a reinstall because the
   * files are records the OS keeps; the *arrangement* of them is app data and
   * simply goes. This is the only thing that turns an arrangement into
   * something that survives, so the notice names the folder — a backup nobody
   * can find is not a backup.
   */
  const exportPlaylist = useCallback(
    (list: Playlist) => {
      const file = playlistToM3u(list, records, artistFor);
      void writeTextFile(file.name, file.mime, file.body)
        .then(() => flashNotice(`Wrote “${file.name}” to Downloads/Spool`))
        .catch((e: any) => flashNotice(e?.message ?? 'Could not write the file'));
    },
    [records, artistFor, flashNotice],
  );

  const exportEverything = useCallback(() => {
    const backup = buildBackup(playlists, records, Date.now(), artistFor);
    const files = [backup, ...playlists.map((l) => playlistToM3u(l, records, artistFor))];
    void (async () => {
      try {
        // One at a time: MediaStore inserts are cheap, and a failure halfway
        // through should stop rather than carry on writing half a backup.
        for (const file of files) await writeTextFile(file.name, file.mime, file.body);
        flashNotice(`Backed up ${describeExport(playlists, records)} to Downloads/Spool`);
      } catch (e: any) {
        flashNotice(e?.message ?? 'Could not write the backup');
      }
    })();
  }, [playlists, records, artistFor, flashNotice]);

  const playlistRows: PlaylistRow[] = useMemo(
    () =>
      playlists.map((list) => ({
        id: list.id,
        name: list.name,
        detail: describePlaylist(list, records),
        onPress: () => setOpenList(list.id),
        onMore: () =>
          offerPlaylistActions(list, {
            rename: () => setNaming({ id: list.id, value: list.name }),
            exportOne: () => exportPlaylist(list),
            remove: () => {
              setPlaylists(deletePlaylist(playlists, list.id));
              setOpenList((open) => (open === list.id ? null : open));
            },
          }),
      })),
    [playlists, records, exportPlaylist],
  );

  /**
   * The playlist on screen, resolved fresh every render against the library.
   *
   * A deleted playlist, or one whose id no longer exists, resolves to null and
   * the screen falls back to the library — closing itself rather than sitting
   * on a name with nothing behind it.
   */
  const openPlaylist: OpenPlaylist | null = useMemo(() => {
    const list = playlists.find((p) => p.id === openList);
    if (!list) return null;
    const tracks = resolvePlaylist(list, records);

    return {
      id: list.id,
      name: list.name,
      detail: describePlaylist(list, records),
      onBack: () => setOpenList(null),
      onPlay: tracks.length ? () => playFromList(list, 0) : undefined,
      onMore: () =>
        offerPlaylistActions(list, {
          rename: () => setNaming({ id: list.id, value: list.name }),
          exportOne: () => exportPlaylist(list),
          remove: () => {
            setOpenList(null);
            setPlaylists(deletePlaylist(playlists, list.id));
          },
        }),
      items: tracks.map((r, at) => ({
        id: r.id,
        kind: r.audioOnly ? ('audio' as const) : ('video' as const),
        title: r.title,
        // Inside a playlist the position is the useful fact — it is the thing
        // the user is arranging — so it leads, where the library row leads with
        // how the file got there.
        subtitle: `${at + 1} of ${tracks.length}${artistFor(r) ? ` · ${artistFor(r)}` : ''}`,
        art: artworkFor(r.id)?.uri,
        onPress: () => playFromList(list, at),
        onMore: () =>
          offerTrackInPlaylist(r, list, at, tracks.length, {
            move: (delta) =>
              setPlaylists((prev) => moveTrack(prev, list.id, r.id, delta, Date.now())),
            remove: () =>
              setPlaylists((prev) => removeTrack(prev, list.id, r.id, Date.now())),
          }),
      })),
    };
  }, [playlists, openList, records, playFromList, artistFor, artVersion]);

  /**
   * The ring reads the fraction; the subtitle says it in words too, because
   * yt-dlp reports nothing at all for the first few seconds of a job and a ring
   * frozen at zero with no text looks like a hang.
   */
  const downloading: LibraryItem[] = useMemo(
    () =>
      jobs.map((j) => ({
        id: j.id,
        kind: j.audioOnly ? ('audio' as const) : ('video' as const),
        title: j.title,
        // yt-dlp hits 100% when the stream lands, but ffmpeg still has to
        // remux, which on a long track is many seconds of a row that claims to
        // be finished and is not.
        subtitle: j.queued
          ? `Queued · ${j.quality}`
          : j.progress >= 0.999
            ? `Finishing · ${j.quality}`
            : j.progress > 0
              ? `${Math.round(j.progress * 100)}% · ${j.quality}`
              : `Starting · ${j.quality}`,
        // null draws the queued glyph rather than a ring at zero, which is the
        // difference between "waiting its turn" and "stuck at 0%".
        progress: j.queued ? null : j.progress,
        queuedReason: j.queued ? 'Waiting for the current download' : undefined,
        onMore: () => j.cancel(),
      })),
    [jobs],
  );

  const librarySummary = useMemo(() => {
    const bytes = saved.reduce((sum, r) => sum + (r.bytes ?? 0), 0);
    const gb = bytes / 1_000_000_000;
    return `${saved.length} item${saved.length === 1 ? '' : 's'} · ${
      gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1_000_000)} MB`
    }`;
  }, [saved]);

  /** Newest first — the shelf fills itself as things get kept. */
  const recentCards = useMemo(
    () =>
      saved.slice(0, 12).map((r) => ({
        id: r.id,
        title: r.title,
        artist: r.quality,
        kind: r.audioOnly ? ('audio' as const) : ('video' as const),
        art: artworkFor(r.id)?.uri,
        onPress: r.uri ? () => playRecord(r) : undefined,
      })),
    [saved, playRecord, artVersion],
  );

  /**
   * What the user actually replays, straight from the counters — so this list
   * is also the honest answer to "is the tracking working?".
   *
   * The green tick is the one announcement the rule ever makes, so it appears
   * only where the rule really did the saving. A file the user chose themselves
   * never earns it.
   */
  const repeatRows: RepeatRow[] = useMemo(() => {
    const savedByVideo = new Map(
      records.filter((r) => r.videoId && r.state === 'saved').map((r) => [r.videoId, r]),
    );

    return ranked(plays)
      .slice(0, 8)
      .map((stat) => {
        const record = savedByVideo.get(stat.id);
        const fetching = jobs.some((j) => j.auto && j.title === stat.title);
        return {
          id: stat.id,
          title: stat.title || stat.id,
          subtitle: describePlays(stat),
          state: record?.auto ? ('saved' as const) : fetching ? ('fetching' as const) : ('none' as const),
          // What the page was, not what was saved from it: a music page filtered
          // under Music whether or not anything was ever kept from it.
          kind: stat.music === false ? ('video' as const) : ('audio' as const),
          // On repeat is keyed by video, not by download, so the cover comes
          // from whichever saved row is that video — if one exists at all.
          art: record ? artworkFor(record.id)?.uri : undefined,
          onPress: record?.uri ? () => playRecord(record) : undefined,
          onMore: () => confirmForgetPlays(stat, forgetPlays),
        };
      });
  }, [plays, records, jobs, playRecord, forgetPlays, artVersion]);

  const hits: LocalHit[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    // Searching a music library by artist is not a refinement, it is half of
    // what the field is for — "arijit" finding nothing in a library full of him
    // reads as the search being broken rather than as a title-only search.
    return saved
      .filter((r) => {
        const artist = artistFor(r)?.toLowerCase() ?? '';
        return r.title.toLowerCase().includes(q) || artist.includes(q);
      })
      .map((r) => ({
        id: r.id,
        title: r.title,
        subtitle: artistFor(r)
          ? `${artistFor(r)}${r.bytes ? ` · ${Math.round(r.bytes / 1_000_000)} MB` : ''}`
          : `${r.quality}${r.bytes ? ` · ${Math.round(r.bytes / 1_000_000)} MB` : ''}`,
        kind: r.audioOnly ? ('audio' as const) : ('video' as const),
        art: artworkFor(r.id)?.uri,
        onPress: r.uri ? () => playRecord(r) : undefined,
      }));
  }, [saved, query, playRecord, artistFor, artVersion]);

  /** Hands the query to the page rather than running a second search of ours. */
  const searchWeb = useCallback(
    (q: string) => {
      setRecentSearches((prev) => [q, ...prev.filter((x) => x !== q)].slice(0, 8));
      const url = `https://m.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      webview.current?.injectJavaScript(`location.href=${JSON.stringify(url)};true;`);
      setScreen('browse');
    },
    [],
  );

  const failedToday = records.filter(
    (r) => r.state === 'failed' && Date.now() - r.savedAt < 86_400_000,
  ).length;

  /**
   * The engine repairs itself in place, because a sideloaded app gets no store
   * updates and a stale extractor is the single most common way everything here
   * stops working. The quality sheet's "Update engine" button already sent
   * people to this screen; until now there was nothing here to press.
   */
  const runEngineUpdate = useCallback(async () => {
    setEngine((prev) => ({ ...prev, busy: true }));
    try {
      const result = await updateEngine();
      const version = await engineVersion().catch(() => result.version);
      setEngine({ version, busy: false });
      Alert.alert(
        result.status === 'updated' ? 'Engine updated' : 'Already current',
        result.status === 'updated'
          ? `The extractor is now ${version}. Try that download again.`
          : `The extractor is already at ${version}, so a failure here is not a stale engine.`,
      );
    } catch (e) {
      setEngine((prev) => ({ ...prev, busy: false }));
      Alert.alert(
        'Couldn’t update',
        'The update needs a working connection. Nothing was changed.',
      );
      console.warn('[spool] engine update failed:', String(e));
    }
  }, []);

  if (!booted) return <View style={[styles.root, { backgroundColor: t.chrome }]} />;

  if (screen === 'firstrun') {
    return (
      <SafeAreaView
        style={[styles.root, { backgroundColor: t.chrome }]}
        edges={['top', 'bottom']}
      >
        <FirstRunScreen
          onStart={async () => {
            await markFirstRunSeen();
            await requestNotificationPermission();
            await requestMediaPermissions();
            setScreen('browse');
            // Only now can the gallery be read; the boot scan ran before the
            // user had granted anything.
            adoptFromGallery();
            if (trial().trial) setPreRelease(true);
          }}
          onChooseFolder={() => flashNotice('Files are saved to Movies/Spool')}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: t.chrome }]}
      edges={['top', 'bottom']}
    >
      <View style={styles.page}>
        {/* Never unmounted — leaving Downloads must not cost a page reload. */}
        <WebView
          // Changes only when the renderer has been killed, which is the one
          // case where the instance is unusable and has to be replaced rather
          // than reloaded.
          key={webviewKey}
          ref={webview}
          source={{ uri: entry }}
          userAgent={USER_AGENT}
          injectedJavaScriptBeforeContentLoaded={PRELOAD}
          injectedJavaScript={NAV_SCRIPT}
          onMessage={onMessage}
          onRenderProcessGone={onRenderProcessGone}
          onNavigationStateChange={onNavigationStateChange}
          onLoadProgress={({ nativeEvent }) =>
            setLoadProgress(nativeEvent.progress < 1 ? nativeEvent.progress : null)
          }
          onLoadEnd={() => setLoadProgress(null)}
          onShouldStartLoadWithRequest={(request) => /^https?:/i.test(request.url)}
          allowsBackForwardNavigationGestures
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          domStorageEnabled
          javaScriptEnabled
          thirdPartyCookiesEnabled
          setSupportMultipleWindows={false}
          style={{ flex: 1, backgroundColor: t.pageBg }}
        />

        {/* The FAB is the manual path and lives only in Browse. Inert at line
            colour on a feed; filled and tinted once a watch page resolves —
            that state change is the only notice that something can be kept. */}
        {screen === 'browse' && (
          <Animated.View
            style={[
              styles.fabSlot,
              {
                transform: [
                  {
                    scale: Animated.multiply(
                      pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] }),
                      hold.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] }),
                    ),
                  },
                ],
              },
            ]}
          >
            <Pressable
              onPress={onDownloadPress}
              onLongPress={onDownloadHold}
              // Three seconds is a long time to hold something with no sign it
              // is working, so the button swells for exactly that long and
              // snaps back the moment the finger lifts.
              delayLongPress={HOLD_MS}
              onPressIn={() => {
                if (!videoId) return;
                Animated.timing(hold, {
                  toValue: 1,
                  duration: HOLD_MS,
                  easing: Easing.linear,
                  useNativeDriver: true,
                }).start();
              }}
              onPressOut={() => {
                hold.stopAnimation();
                Animated.timing(hold, {
                  toValue: 0,
                  duration: motion.tap,
                  easing: Easing.out(Easing.quad),
                  useNativeDriver: true,
                }).start();
              }}
              disabled={!videoId}
              accessibilityRole="button"
              accessibilityLabel={FAB_LABEL[fabState]}
              accessibilityHint={
                videoId && fabState !== 'working'
                  ? 'Hold for all formats and download settings'
                  : undefined
              }
              style={({ pressed }) => [
                styles.fab,
                {
                  backgroundColor: videoId ? fabFill(fabState, t) : fixed.raised,
                  borderColor: fixed.line,
                  borderWidth: videoId ? 0 : 1,
                },
                pressed && { opacity: 0.8 },
              ]}
            >
              {/* The only in-page sign that a download is running. Library
                  shows the same job as a row; this keeps the browser honest. */}
              {fabState === 'working' && <FabRing value={progress} colour={t.onAccent} />}
              <MaterialIcons
                name={videoId ? FAB_ICON[fabState] : 'download'}
                size={26}
                color={videoId ? fabInk(fabState, t) : fixed.mute}
              />
            </Pressable>
          </Animated.View>
        )}

        {/* Where a refusal is actually said.

            `flashNotice` had no reader: it set state that nothing rendered, so
            every trial refusal was worded correctly and then thrown away. From
            the outside that is a download button that does nothing — and with
            the pre-release capped at three minutes, most music videos are over
            it, so the common case looked like a broken engine.

            Warn-coloured text in place, never a dialog and never a colour
            flood, above the FAB that caused it. See docs/UI.md — "a refusal, at
            the moment of refusing". */}
        {screen === 'browse' && notice && (
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.notice,
              { backgroundColor: t.tint, borderColor: fixed.line },
            ]}
          >
            <MaterialIcons name="info-outline" size={16} color={fixed.warn} />
            <Text style={[styles.noticeText, { color: t.on }]}>{notice}</Text>
          </View>
        )}

        {screen === 'home' && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.deep }]}>
            <HomeScreen recent={recentCards} repeat={repeatRows} />
          </View>
        )}

        {screen === 'search' && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.deep }]}>
            <SearchScreen
              query={query}
              onQuery={setQuery}
              hits={hits}
              recent={recentSearches}
              onRecent={searchWeb}
              onSearchWeb={searchWeb}
            />
          </View>
        )}

        {screen === 'library' && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.deep }]}>
            <LibraryScreen
              items={library}
              downloading={downloading}
              summary={librarySummary}
              playlists={playlistRows}
              open={openPlaylist}
              onNewPlaylist={() => setNaming({ value: '' })}
              onSearch={() => setScreen('search')}
              onCancelAll={
                jobs.length ? () => jobs.forEach((j) => j.cancel()) : undefined
              }
              notice={
                failedToday >= 3
                  ? `${failedToday} downloads failed today — the extraction engine may need updating.`
                  : null
              }
            />
          </View>
        )}

        {screen === 'profile' && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.deep }]}>
            <ProfileScreen
              autoSave={autoSave}
              onAutoSave={setAutoSave}
              // Absent while there are no playlists: a row offering to back up
              // nothing is a row that does nothing.
              onExport={playlists.length ? exportEverything : undefined}
              exportSummary={describeExport(playlists, records)}
              // No capacity figure without a native StatFs call, so the meter
              // stays off rather than inventing one. See docs/UI.md §04.
              storage={{ ours: null, others: 0, used: librarySummary, free: '' }}
              // The real version from the native module, not a claim. It used to
              // read "up to date" unconditionally — including on the build whose
              // extractor had just failed three times.
              //
              // "unknown" is what youtubedl-android reports until an update has
              // actually run, so it stays uncoloured: green would assert the one
              // thing that has not been established.
              engineSummary={
                engine.busy
                  ? 'updating…'
                  : !engine.version
                    ? 'checking…'
                    : engine.version === 'unknown'
                      ? 'tap to update'
                      : engine.version
              }
              engineTone={
                failedToday >= 3
                  ? 'warn'
                  : engine.version && engine.version !== 'unknown'
                    ? 'good'
                    : 'neutral'
              }
              onEngine={engine.busy ? undefined : runEngineUpdate}
              onAudioQuality={() => setPicker('audio')}
              onVideoQuality={() => setPicker('video')}
            />
          </View>
        )}

        {/* Above everything: the player is a sheet over the tab it was opened
            from, and nothing underneath it should show through. */}
        {videoOpen && playing && (
          <View style={StyleSheet.absoluteFill}>
            <PlayerScreen
              onDismiss={() => setVideoOpen(false)}
              saved={records.some((r) => r.id === playing.id && r.state === 'saved')}
              onSleep={() => setSleepSheet(true)}
              // The header's overflow was the only inert control left on this
              // screen. It now names the three things worth doing to what is
              // playing, rather than going straight to the destructive one.
              onMore={() => {
                const record = records.find((r) => r.id === playing.id);
                offerPlayingActions(record, {
                  sleep: () => setSleepSheet(true),
                  file: record ? () => setFiling(record) : undefined,
                  remove: record ? () => confirmForget(record, forget) : undefined,
                });
              }}
            />
          </View>
        )}
      </View>

      {/* Rides above the tab bar on the four local tabs. Browse is the site's
          own page at full bleed, and stacking our bar under the FAB would put
          two of our controls over someone else's layout. Hidden under the full
          player too, which already shows everything the bar would say. */}
      {!videoOpen && screen !== 'browse' && (
        <NowPlayingBar
          onOpen={() => setVideoOpen(true)}
          // A page has no full player to open — no queue, no shapes, nothing
          // the screen could show that Browse does not show better. Tapping it
          // goes back to the video, which is the thing the user is actually
          // reaching for.
          page={{
            onOpen: () => setScreen('browse'),
            onToggle: toggleBrowserMedia,
            onStop: stopBrowserMedia,
          }}
        />
      )}

      {!videoOpen && <TabBar value={screen} onChange={setScreen} />}

      {preRelease && <PreReleaseSheet onClose={() => setPreRelease(false)} />}

      <QualitySheet
        mode={sheet}
        video={
          meta
            ? {
                title: meta.title,
                channel: meta.channel,
                duration: formatDuration(meta.durationSeconds),
              }
            : null
        }
        quickPicks={toQuickPicks(meta?.formats ?? [])}
        formats={toFormatRows(meta?.formats ?? [])}
        duplicateWarning={sheetDuplicate}
        instant={autoSave.instant}
        onInstant={(instant) => setAutoSave((prev) => ({ ...prev, instant }))}
        emptyReason={
          error ?? 'This page has no downloadable media — it may be live or members-only.'
        }
        onPick={beginDownload}
        onExpand={() => setSheet('all')}
        onCollapse={() => setSheet('quick')}
        onClose={() => setSheet(null)}
        onUpdateEngine={() => {
          setSheet(null);
          setScreen('profile');
        }}
        onRetry={resolve}
      />

      {/* Naming: creating one, or renaming the one already open. The same
          sheet for both, because it is the same question. */}
      {naming && (
        <NameSheet
          title={naming.id ? 'Rename playlist' : 'New playlist'}
          value={naming.value}
          action={naming.id ? 'Rename' : 'Create'}
          onSubmit={(name) => {
            const at = Date.now();
            if (naming.id) {
              setPlaylists(renamePlaylist(playlists, naming.id, name, at));
              return;
            }
            const made = createPlaylist(playlists, name, at);
            if (!made) {
              flashNotice('That is as many playlists as Spool keeps.');
              return;
            }
            setPlaylists(made.playlists);
            if (naming.then) {
              // Filing a track was the reason this sheet opened, so the list is
              // finished by putting it in, not by opening an empty one.
              naming.then(made.created.id, made.playlists);
              return;
            }
            // Otherwise straight into it: it was made to put something in.
            setOpenList(made.created.id);
          }}
          onClose={() => setNaming(null)}
        />
      )}

      {/* Filing a track. "New playlist…" is last because it is the answer
          when none of the ones above is right. */}
      {filing && (
        <ChoiceSheet
          title="Add to playlist"
          note={filing.title}
          value=""
          options={[
            ...playlists.map((list) => ({
              key: list.id,
              label: list.name,
              detail: describePlaylist(list, records),
            })),
            { key: 'new', label: 'New playlist…' },
          ]}
          onPick={(key) => {
            const record = filing;
            if (key === 'new') {
              setNaming({
                value: '',
                then: (listId, lists) => fileInto(lists, listId, record),
              });
              return;
            }
            addToList(key, record);
          }}
          onClose={() => setFiling(null)}
        />
      )}

      {/* Minutes, or the end of what is playing. "Off" is a row rather than a
          separate gesture because turning it off is the same question. */}
      {sleepSheet && (
        <ChoiceSheet
          title="Sleep timer"
          note="Playback pauses. Nothing is closed and nothing is lost."
          value={sleepValue}
          options={SLEEP_OPTIONS}
          onPick={(key) =>
            setSleep(key === 'off' ? null : key === 'track' ? 'track' : Number(key))
          }
          onClose={() => setSleepSheet(false)}
        />
      )}

      {/* The two Profile rows that carried a chevron and went nowhere. Video
          quality is the load-bearing one: it decides what every automatic save
          and every one-tap download actually fetches. */}
      {picker && (
        <ChoiceSheet
          title={picker === 'audio' ? 'Audio quality' : 'Video quality'}
          note={
            picker === 'audio'
              ? 'A ceiling, not a demand — the best rung at or below this is taken.'
              : 'A ceiling, not a demand. Used by one-tap downloads and by the replay rule.'
          }
          options={
            picker === 'audio'
              ? AUDIO_QUALITIES.map((q) => ({ ...q }))
              : VIDEO_QUALITIES.map((q) => ({ ...q }))
          }
          value={picker === 'audio' ? autoSave.audioQuality : autoSave.videoQuality}
          onPick={(key) =>
            setAutoSave((prev) =>
              picker === 'audio'
                ? { ...prev, audioQuality: key }
                : { ...prev, videoQuality: key },
            )
          }
          onClose={() => setPicker(null)}
        />
      )}
    </SafeAreaView>
  );
}

/**
 * A saved download as the player wants it. Module level rather than a hook, so
 * the boot effect can rebuild a restored queue before the component's own
 * callbacks exist.
 */
/**
 * A library row as something the player can hold.
 *
 * `artist` used to be the quality string, which put "audio" where every surface
 * in the app labels the artist — most visibly on the media notification, where
 * it is the line under the title. The real answer comes from the page that was
 * watched, via the play index, and is copied onto the record at save time so it
 * survives the index being trimmed.
 */
function toTrack(
  r: DownloadRecord,
  // The boot restore has no play index yet — it is loaded by the tracking hook,
  // which has not run at that point — so it takes what the record itself knows.
  artistFor: (r: DownloadRecord) => string | undefined = (x) => x.artist,
) {
  return {
    id: r.id,
    title: r.title,
    artist: artistFor(r),
    uri: r.uri as string,
    kind: r.audioOnly ? ('audio' as const) : ('video' as const),
  };
}

/**
 * Removing something from the library is the one destructive thing a row can
 * do, and `more-vert` reads as "show me options", not "delete this". So it asks
 * — and says plainly that the file itself survives, because the row vanishing
 * otherwise looks like the download was thrown away.
 */
function confirmForget(r: DownloadRecord, forget: (id: string) => void) {
  Alert.alert(
    'Remove from library?',
    r.uri
      ? `“${r.title}” stays on this device — only Spool's list of it goes.`
      : `“${r.title}” never finished, so there is nothing on disk to keep.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => forget(r.id) },
    ],
  );
}

/**
 * The sleep timer's answers.
 *
 * Minutes rather than a clock time, because the question a person asks at night
 * is "how long", not "until when". The end-of-track row is last: it is the one
 * that is not a duration, and putting it among the numbers made the list read
 * as though it were one.
 */
const SLEEP_OPTIONS = [
  { key: 'off', label: 'Off' },
  { key: '15', label: '15 minutes' },
  { key: '30', label: '30 minutes' },
  { key: '45', label: '45 minutes' },
  { key: '60', label: '1 hour' },
  { key: 'track', label: 'End of this track' },
];

/**
 * A saved row's options.
 *
 * `more-vert` reads as "show me options", and while removal was the only one it
 * could reasonably open the confirm directly. With something non-destructive to
 * offer as well it has to name both — and "Add to playlist" leads, because it
 * is the one that is not a one-way door.
 */
function offerSavedActions(
  r: DownloadRecord,
  on: { file: () => void; remove: () => void },
) {
  Alert.alert(r.title, undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove from library', style: 'destructive', onPress: on.remove },
    { text: 'Add to playlist', onPress: on.file },
  ]);
}

/**
 * The full player's overflow.
 *
 * A page being played has no library row behind it, so the two library actions
 * are absent rather than inert — which leaves the sleep timer, and that is
 * reason enough for the menu to exist.
 */
function offerPlayingActions(
  record: DownloadRecord | undefined,
  on: { sleep: () => void; file?: () => void; remove?: () => void },
) {
  const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
    { text: 'Cancel', style: 'cancel' },
  ];
  if (on.remove) {
    buttons.push({ text: 'Remove from library', style: 'destructive', onPress: on.remove });
  }
  if (on.file) buttons.push({ text: 'Add to playlist', onPress: on.file });
  buttons.push({ text: 'Sleep timer', onPress: on.sleep });

  Alert.alert(record?.title ?? 'Playing', undefined, buttons);
}

/** Rename or delete, from either the section row or the open playlist. */
function offerPlaylistActions(
  list: Playlist,
  on: { rename: () => void; exportOne: () => void; remove: () => void },
) {
  Alert.alert(list.name, undefined, [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Delete playlist',
      style: 'destructive',
      // The tracks are files and the playlist is a list of ids, so nothing is
      // lost but the arrangement — which is worth saying, because "delete" over
      // a list of music reads as deleting the music.
      onPress: () =>
        Alert.alert(
          'Delete this playlist?',
          `“${list.name}” goes. Every track in it stays on this device.`,
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Delete', style: 'destructive', onPress: on.remove },
          ],
        ),
    },
    { text: 'Export as .m3u8', onPress: on.exportOne },
    { text: 'Rename', onPress: on.rename },
  ]);
}

/**
 * A track's options inside a playlist: where it sits, and whether it stays.
 *
 * Up and down rather than a drag. Reordering is the half of playlists people
 * complain is missing, and a control that works on the first tap beats one that
 * works on the third attempt at a long press. An end of the list simply does
 * not offer the direction it cannot go, which is why the buttons are built
 * rather than listed.
 */
function offerTrackInPlaylist(
  r: DownloadRecord,
  list: Playlist,
  at: number,
  total: number,
  on: { move: (delta: number) => void; remove: () => void },
) {
  const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Remove from playlist', style: 'destructive', onPress: on.remove },
  ];
  if (at < total - 1) buttons.push({ text: 'Move down', onPress: () => on.move(1) });
  if (at > 0) buttons.push({ text: 'Move up', onPress: () => on.move(-1) });

  Alert.alert(r.title, `${at + 1} of ${total} in “${list.name}”`, buttons);
}

/**
 * A failed row has two sensible answers, and "forget it" was the only one on
 * offer. Retry leads, because the common causes — a dropped connection, a
 * momentary refusal from YouTube, an extractor that has since been updated —
 * are all fixed by simply asking again.
 */
function offerRetry(
  r: DownloadRecord,
  retry: (record: DownloadRecord) => void,
  forget: (id: string) => void,
) {
  Alert.alert(
    'Try again?',
    `“${r.title}” — ${r.error ?? 'the download did not finish'}.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => forget(r.id) },
      { text: 'Try again', onPress: () => retry(r) },
    ],
  );
}

/**
 * Forgetting a play count is the only way to undo the rule's arithmetic, so it
 * says what the numbers are before it throws them away — and makes clear that
 * any file already saved is not affected.
 */
function confirmForgetPlays(stat: PlayStat, forget: (id: string) => void) {
  Alert.alert(
    'Forget these plays?',
    `“${stat.title || stat.id}” — ${describePlays(stat)}. The count starts again ` +
      `from zero. Anything already saved stays.`,
    [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Forget', style: 'destructive', onPress: () => forget(stat.id) },
    ],
  );
}

/**
 * How a duplicate is worded.
 *
 * The matched row is named rather than merely counted: "Similar already
 * downloaded" on its own asks the user to trust a guess they cannot check,
 * and the whole point of showing the title and runtime is that they can look
 * at it and tell instantly whether the match is right.
 */
function describeDuplicate(match: Match<DownloadRecord>, confirmable: boolean): string {
  const runtime = runtimeLabel(match.record.seconds);
  const named = `“${match.record.title}”${runtime ? ` · ${runtime}` : ''}`;
  const head = match.kind === 'exact' ? 'Already downloaded' : 'Similar already downloaded';
  return confirmable ? `${head}: ${named}. Tap again to save anyway.` : `${head}: ${named}.`;
}

/**
 * The FAB's five states. v1 spelled these out in a pill with words; v2 has no
 * chrome to put words in, so the button itself has to carry the whole story —
 * which means every state needs its own glyph, not just its own colour.
 */
const FAB_ICON: Record<DownloadState, keyof typeof MaterialIcons.glyphMap> = {
  idle: 'download',
  ready: 'download',
  resolving: 'hourglass-empty',
  working: 'close',
  done: 'check',
  failed: 'refresh',
};

/** How long the FAB must be held before it offers the full format list. */
const HOLD_MS = 3000;

const FAB_LABEL: Record<DownloadState, string> = {
  idle: 'Nothing to download here',
  ready: 'Download this video',
  resolving: 'Reading formats',
  working: 'Cancel download',
  done: 'Saved — open Library',
  failed: 'Download failed — try again',
};

const fabFill = (state: DownloadState, t: ReturnType<typeof useTheme>['t']) =>
  state === 'done' ? fixed.saved : state === 'failed' ? fixed.warn : t.accent;

/** Both saved-green and warn are light, so their ink is the dark ground. */
const fabInk = (state: DownloadState, t: ReturnType<typeof useTheme>['t']) =>
  state === 'done' || state === 'failed' ? fixed.base : t.onAccent;

/** Sits just inside the 56dp FAB: r=25, so 2πr ≈ 157. */
function FabRing({ value, colour }: { value: number; colour: string }) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <Svg width={size.fab} height={size.fab} style={StyleSheet.absoluteFill}>
      <Circle
        cx={size.fab / 2}
        cy={size.fab / 2}
        r={25}
        fill="none"
        stroke={colour}
        strokeOpacity={0.3}
        strokeWidth={2.5}
      />
      <Circle
        cx={size.fab / 2}
        cy={size.fab / 2}
        r={25}
        fill="none"
        stroke={colour}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={157}
        strokeDashoffset={157 * (1 - clamped)}
        transform={`rotate(-90 ${size.fab / 2} ${size.fab / 2})`}
      />
    </Svg>
  );
}

/**
 * yt-dlp's stderr is developer-facing; a row needs one short sentence.
 *
 * `stage` matters more than it looks. The engine reports a failed *download*
 * with the same shapeless "Download failed" it uses for everything else, and
 * telling someone whose disk is full to update their extractor sends them to
 * the one screen that cannot help. When the cause is not recognisable, the
 * fallback names the two things that actually go wrong at that stage rather
 * than guessing at a third.
 */
function readableError(e: unknown, stage: 'resolve' | 'download' = 'resolve'): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  // yt-dlp's real message is the only useful diagnostic when extraction breaks,
  // and the user-facing string deliberately throws it away.
  console.warn(`[spool] engine error (${stage}):`, raw);
  const text = raw.toLowerCase();
  if (text.includes('sign in') || text.includes('bot')) return 'Sign-in required for this video';
  if (text.includes('private')) return 'This video is private';
  if (text.includes('members-only') || text.includes('members only')) return 'Members-only video';
  if (text.includes('live')) return 'Live streams can’t be downloaded yet';
  if (text.includes('unavailable')) return 'Video unavailable';
  if (text.includes('403') || text.includes('forbidden')) return 'YouTube refused the request';
  // "No address associated with hostname" is what a dropped connection actually
  // produces — measured by pulling the network mid-download. It matched none of
  // these, so the clearest failure the app has fell through to the generic
  // fallback and told the user to go and check their free space.
  if (
    text.includes('network') ||
    text.includes('resolve host') ||
    text.includes('hostname') ||
    text.includes('unreachable') ||
    text.includes('connection') ||
    text.includes('timed out')
  ) {
    return 'Couldn’t reach YouTube';
  }
  if (text.includes('space') || text.includes('enospc')) return 'Not enough storage';
  if (text.includes('no file')) return 'The engine produced no file';
  return stage === 'download'
    ? 'Didn’t finish — check free space and connection'
    : 'Couldn’t read this video — try updating the engine';
}

const formatDuration = (seconds: number): string => {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

async function requestNotificationPermission() {
  if (Platform.OS !== 'android' || Platform.Version < 33) return;
  try {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS as any,
    );
  } catch {
    // Downloads still work without it; only the progress notification is lost.
  }
}

/**
 * Storage access, which Android has redefined twice and so needs branching:
 *
 *   <= 28  saving into Movies/ or Music/ is plain file I/O and needs the write
 *          grant, so a denial here means downloads cannot be saved at all
 *   29-32  MediaStore publishes without any grant; the read grant only governs
 *          finding files back
 *   33+    that read grant split into one permission per media type
 *
 * Only the oldest branch is load-bearing. On 29+ a refusal costs nothing today
 * and only shows up after a reinstall, when previously saved files can no
 * longer be listed — so it is asked for once, up front, and never nagged.
 */
async function requestMediaPermissions() {
  if (Platform.OS !== 'android') return;
  const api = Platform.Version as number;

  const wanted =
    api >= 33
      ? ['android.permission.READ_MEDIA_VIDEO', 'android.permission.READ_MEDIA_AUDIO']
      : api >= 29
        ? ['android.permission.READ_EXTERNAL_STORAGE']
        : ['android.permission.WRITE_EXTERNAL_STORAGE'];

  try {
    await PermissionsAndroid.requestMultiple(wanted as any);
  } catch {
    // Nothing to recover here — publishing reports its own failure if it comes.
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1, overflow: 'hidden' },
  fabSlot: {
    position: 'absolute',
    right: space.gutter,
    bottom: space.gutter,
  },
  fab: {
    width: size.fab,
    height: size.fab,
    borderRadius: radius.fab,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Sits directly above the FAB, clear of it, so the answer appears where the
  // question was asked rather than on a screen the user would have to go find.
  notice: {
    position: 'absolute',
    left: space.gutter,
    right: space.gutter,
    bottom: space.gutter + size.fab + space.row,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.row,
    padding: 14,
    borderWidth: 1,
    borderRadius: 12,
  },
  noticeText: { ...type.body, flex: 1 },
});
