import { requireNativeModule } from 'expo-modules-core';
import type { EventSubscription } from 'expo-modules-core';

export type ProgressEvent = {
  id: string;
  fraction: number;
  eta: number;
  line: string;
};

export type DownloadArgs = {
  id: string;
  url: string;
  title?: string;
  /** yt-dlp format selector, e.g. "137+140" or "best". */
  format?: string;
  audioOnly?: boolean;
  poToken?: string;
  visitorData?: string;
  /** InnerTube client(s) to impersonate when no PO token is available. */
  clients?: string;
  /**
   * The video's length, so a pre-release build can refuse one that is over its
   * cap. 0 means the extractor did not say, and an unknown length is not
   * grounds for refusing.
   */
  seconds?: number;
};

/**
 * What a pre-release build allows.
 *
 * Read from the native side rather than held in JavaScript: this ships as
 * Hermes bytecode inside the same APK it guards, so it can describe the limits
 * but must not be the thing that enforces them. See TrialGuard.
 */
export type TrialStatus = {
  /** False in a full build, where every other field is meaningless. */
  trial: boolean;
  /** Epoch ms, stamped into the binary at build time. */
  expiresAt: number;
  expired: boolean;
  /** False once the APK's signing certificate stops matching the pin. */
  intact: boolean;
  used: number;
  maxDownloads: number;
  maxSeconds: number;
};

export type DownloadResult = { path: string; bytes: number };

/**
 * One file already in the gallery, as MediaStore describes it.
 *
 * No `videoId`: nothing in a MediaStore row records which YouTube video a file
 * came from, so a restored item plays and lists but is not linked back to its
 * play count. See `adoptSaved` for what that costs.
 */
export type SavedItem = {
  uri: string;
  title: string;
  bytes: number;
  /** Epoch ms — converted from MediaStore's seconds natively. */
  savedAt: number;
  durationMs: number;
  audioOnly: boolean;
  artist: string | null;
};
export type UpdateResult = { status: string; version: string };

/** A cached cover, and the single colour the theme is derived from. */
export type ArtworkResult = { uri: string; dominant: string };

/** What the lock screen, notification buttons and headset keys asked for. */
export type PlaybackCommandEvent = {
  command: 'play' | 'pause' | 'stop' | 'next' | 'previous' | 'seek' | 'save';
  /** Seconds, and only `seek` means anything by it. */
  value: number;
};

/**
 * What the media notification should say. Times are in seconds; a `duration` of
 * 0 means "not known yet", and the system then draws no scrubber rather than an
 * empty one.
 */
export type NowPlaying = {
  title: string;
  artist: string | null;
  /**
   * Where the sound is coming from — "YouTube" or "On this device".
   *
   * The card has no room for a line of its own, so this is appended to the
   * artist with a `·`. It is the only thing that tells a page apart from a
   * saved file once the app is off screen, and the two behave differently
   * enough that the difference is worth the characters.
   */
  source: string;
  playing: boolean;
  /** file:// path to a cached cover, or null for the placeholder. */
  artwork: string | null;
  position: number;
  duration: number;
  canNext: boolean;
  canPrevious: boolean;
  /**
   * Whether this is something that can be put on the device from here.
   *
   * True only for a page that is not already saved. A library track is already
   * a file, so the button is absent rather than present and inert — see the
   * "controls appear only where they are real" rule in docs/UI.md.
   */
  canSave: boolean;
};

type YtDlpNative = {
  initialize(): Promise<string>;
  version(): Promise<string>;
  listFormats(
    url: string,
    poToken: string | null,
    visitorData: string | null,
    clients: string | null,
  ): Promise<string>;
  download(args: DownloadArgs): Promise<DownloadResult>;
  cancel(id: string): Promise<void>;
  updateEngine(): Promise<UpdateResult>;
  publishToGallery(path: string, title: string, audioOnly: boolean): Promise<string>;
  /**
   * A text file into `Downloads/Spool` — an exported playlist, or a backup of
   * them. Returns the MediaStore uri.
   *
   * Downloads rather than Music/Spool on purpose: a backup is not a track, and
   * a `.json` sitting among someone's music ends up in another player's library
   * scan. `name` carries its own extension.
   */
  writeTextFile(name: string, mime: string, body: string): Promise<string>;
  /**
   * Everything Spool has ever published to Music/Spool and Movies/Spool.
   *
   * The library index is app data and dies with an uninstall; these files do
   * not. Called on every launch so a reinstalled app finds what is already on
   * the device rather than showing an empty Library over a full folder.
   */
  scanSaved(): Promise<SavedItem[]>;
  /**
   * Cover art for one item, from the file's own tags where it has them and the
   * first `urls` candidate that answers where it does not. Rejects when nothing
   * yields anything — that item simply keeps the neutral ground.
   */
  readArtwork(
    key: string,
    path: string | null,
    urls: string[],
  ): Promise<ArtworkResult>;
  /**
   * Raises the media foreground service, and refreshes what it displays.
   *
   * The first call has to be made while the app is on screen — Android 12
   * onwards refuses to start a foreground service from the background — which
   * is why both sources publish on first play rather than on load.
   */
  setNowPlaying(state: NowPlaying): void;
  stopBackgroundPlayback(): void;
  /**
   * Says `command` to the browser page through a cookie it polls, which is the
   * only route that works while the app is backgrounded — `injectJavaScript`
   * queues until the app is next drawn. `stamp` distinguishes a repeat of the
   * same verb from the previous one still sitting in the jar.
   */
  setPageCommand(command: string, stamp: number): void;
  /**
   * Tells the browser's WebView it is still on screen, once a second, until
   * this is called again with `false`.
   *
   * The rest of background playback keeps the *page* from learning it was
   * backgrounded. This is the layer below that: WebView suspends the media
   * pipeline of a WebView it considers hidden, decided from the Android view
   * and reachable by nothing in JavaScript. Without it a resumed page plays
   * for about 50ms and stops again — with the screen off or merely with the
   * app behind HOME.
   *
   * A pinned WebView goes on decoding video nobody can see, so pin only while
   * something the user asked for is playing, and unpin the moment it is not.
   */
  setWebViewVisible(pinned: boolean): void;
  /** What this build allows. Cheap enough to call on every launch and save. */
  trialStatus(): TrialStatus;
  addListener(event: 'onProgress', listener: (e: ProgressEvent) => void): EventSubscription;
  addListener(
    event: 'onPlaybackCommand',
    listener: (e: PlaybackCommandEvent) => void,
  ): EventSubscription;
};

const YtDlp = requireNativeModule<YtDlpNative>('YtDlp');

export default YtDlp;

export function onProgress(listener: (e: ProgressEvent) => void): EventSubscription {
  return YtDlp.addListener('onProgress', listener);
}

export function onPlaybackCommand(
  listener: (e: PlaybackCommandEvent) => void,
): EventSubscription {
  return YtDlp.addListener('onPlaybackCommand', listener);
}
