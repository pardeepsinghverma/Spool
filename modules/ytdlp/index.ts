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
   * The name this attempt writes under, without an extension.
   *
   * Stable across retries of the same video at the same quality, and *only*
   * those — which is the whole point. yt-dlp resumes into the file it was
   * writing before, so a name that changes per attempt means a 140 MB download
   * interrupted at 90% starts again from zero, forever, on a connection bad
   * enough to have interrupted it once. Every earlier attempt's `.part` was left
   * behind for the 24-hour sweep to find.
   *
   * It must not be built from the title: the filesystem counts bytes and a
   * styled-Unicode title blows the 255-byte limit before any audio lands. A
   * video id is ASCII by construction.
   */
  resumeKey?: string;
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

/**
 * What this device has paid for.
 *
 * Read from the native side for the same reason `TrialStatus` is: this ships as
 * Hermes bytecode inside the APK it would be guarding. `LicenseGuard` re-checks
 * the token's signature on every one of these calls rather than caching a
 * boolean, so editing the preferences file by hand achieves nothing.
 */
export type LicenceStatus = {
  /** True while the held token is genuinely ours, this device's, and unexpired. */
  entitled: boolean;
  /**
   * Epoch ms the held token runs to. 0 when there is no licence.
   *
   * **A lease, not the subscription's end.** The server signs tokens that live
   * a few days at most and renews them on every sync; when the subscription
   * ends is `paidThrough`, which `core/license.ts` persists separately. Never
   * print this as "days left".
   */
  expiresAt: number;
  /** `"monthly"`, `"annual"`, or empty when there is no licence. */
  plan: string;
  /**
   * This install's anonymous name — SHA-256 of ANDROID_ID, base64url.
   *
   * Derived natively so there is exactly one definition of it. A second one in
   * JavaScript would eventually disagree, and a device that asks the server
   * under one name and verifies tokens under another is a device that has paid
   * and cannot prove it.
   */
  device: string;
  /** Where to ask for a licence, compiled in at build time. Empty in debug. */
  server: string;
};

/** What `shrinkImage` wrote. */
export type ShrunkImage = {
  /** `file://` in the app's cache. */
  uri: string;
  bytes: number;
  width: number;
  height: number;
};

export type DownloadResult = {
  path: string;
  bytes: number;
  /**
   * Set when the engine reported a failure *after* writing a complete file.
   *
   * Almost always a postprocessing step that only decorates — embedding cover
   * art or metadata tags — failing on a download that was otherwise finished.
   * The file is the one the user asked for; this is the engine's complaint,
   * carried across so the log can say why a success has an error beside it.
   */
  salvagedFrom?: string;
};

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
   * Which of these cached covers are still on disk, in the order given.
   *
   * `readArtwork` writes to `cacheDir`, which Android and "Clear cache" may
   * empty at any time, while the index that points at those files lives in
   * AsyncStorage and survives. Without this a cleared cache leaves every row
   * pointing at nothing, drawn blank, and never asked about again.
   */
  filesExist(uris: string[]): boolean[];
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
  /**
   * Drops the YouTube session: every cookie, the WebView's DOM storage, and any
   * cookie jar still on disk.
   *
   * Resolves only once the removal has actually happened, because the caller's
   * next act is to remount the WebView and a remount that overlaps it just
   * repopulates the jar from the page it loads.
   *
   * It does not sign the user out at Google — that is a session on Google's
   * side and only Google can revoke it. It removes this device's copy, which is
   * the part the app is responsible for.
   */
  signOutOfYouTube(): Promise<void>;
  /**
   * FLAG_SECURE on the app's window: no screenshots, no screen recording, no
   * mirroring to a non-secure display.
   *
   * Set only while the page is on a Google sign-in host, because the flag is
   * per-window and leaving it on would stop the user screenshotting their own
   * library. Fails open — an unreachable activity means no flag rather than a
   * blocked sign-in.
   */
  setSecureWindow(on: boolean): void;
  /**
   * Sets the activity screen orientation ('landscape', 'portrait', or 'unspecified').
   * Used for browser fullscreen video rotation.
   */
  setScreenOrientation(orientation: 'landscape' | 'portrait' | 'unspecified'): void;
  /**
   * Whether the user has battery-restricted Spool (Android's "Restricted"
   * battery setting, or Samsung's sleeping apps). While it is, Android strips
   * the playback service of foreground status the moment the screen goes off
   * and refuses to restore it, so screen-off playback lasts only as long as the
   * system tolerates the process. Nothing in the app can override it; it can
   * only be noticed and reported. False before Android 9, which has no such
   * setting.
   */
  backgroundRestricted(): boolean;
  /** What this build allows. Cheap enough to call on every launch and save. */
  trialStatus(): TrialStatus;
  /**
   * What this device has paid for. One ECDSA verification, no network, no
   * preference cached as a boolean — cheap enough to call on every launch.
   */
  licenceStatus(): LicenceStatus;
  /**
   * Offer a token to the native side, which verifies it before keeping it and
   * returns whether it did. A token that is malformed, signed by the wrong key,
   * minted for another device or already expired is refused and changes nothing.
   */
  rememberLicence(token: string): boolean;
  /** Drop the held licence. Used when the user hands the device on. */
  forgetLicence(): void;
  /**
   * Read the text off an image — a UPI payment screenshot — with ML Kit's
   * bundled on-device Latin model. Resolves every line, block by block, joined
   * by `\n`; an empty string when there is no text. Nothing leaves the device
   * here: the caller decides what to send.
   *
   * Rejects `E_OCR_READ` when the file cannot be opened and `E_OCR` when the
   * recognizer fails. Accepts `file://` and `content://` uris.
   */
  recognizeText(uri: string): Promise<string>;
  /**
   * Re-encode an image as a JPEG whose long edge is at most `maxEdge`, at
   * `quality` (30–95), into the app's cache. Exists because the picker's own
   * `quality` leaves a PNG screenshot a PNG. Only the latest result is kept on
   * disk. Rejects `E_IMAGE`.
   */
  shrinkImage(uri: string, maxEdge: number, quality: number): Promise<ShrunkImage>;
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

export function setScreenOrientation(
  orientation: 'landscape' | 'portrait' | 'unspecified',
): void {
  try {
    if (typeof YtDlp?.setScreenOrientation === 'function') {
      YtDlp.setScreenOrientation(orientation);
    }
  } catch {}
}

