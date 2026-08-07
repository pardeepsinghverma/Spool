/**
 * Platform-agnostic seams.
 *
 * v1 ships Android only, but every native capability sits behind one of these
 * interfaces so an iOS backing implementation stays possible without reshaping
 * the app — cheap to design in now, expensive to retrofit.
 *
 * These are the shared type definitions. The Android implementation lives in
 * core/ytdlp.ts over the native module in modules/ytdlp.
 */

export type VideoRef = {
  videoId: string;
  url: string;
  title: string;
};

export type MediaKind = 'video' | 'audio';

export type Format = {
  /** yt-dlp format id, e.g. "137" or "251". */
  id: string;
  kind: MediaKind;
  /** Video height in px; undefined for audio-only. */
  height?: number;
  fps?: number;
  container: string;
  codec: string;
  /** Audio bitrate in kbps, audio formats only. */
  kbps?: number;
  /** Bytes, when yt-dlp reports it. */
  size?: number;
  /** True when the stream already carries both audio and video. */
  muxed: boolean;
};

export type DownloadProgress = {
  /** 0..1, or null while the total size is still unknown. */
  fraction: number | null;
  bytesPerSecond?: number;
  etaSeconds?: number;
};

/**
 * Resolves and fetches streams. Backed by yt-dlp (youtubedl-android) on Android.
 */
export interface DownloadEngine {
  listFormats(ref: VideoRef, token: ProofOfOriginToken | null): Promise<Format[]>;
  download(
    ref: VideoRef,
    format: Format,
    token: ProofOfOriginToken | null,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<{ filePath: string }>;
  cancel(videoId: string): Promise<void>;
  /**
   * Pulls a newer yt-dlp at runtime. Spool can't ship Play Store updates, so
   * this is the app's self-repair path when YouTube changes something.
   */
  updateExtractor(): Promise<{ updated: boolean; version: string }>;
}

/**
 * Combines separate video + audio streams into one MP4.
 *
 * Unimplemented on Android: yt-dlp merges the DASH pair itself with its bundled
 * ffmpeg (`--merge-output-format mp4`), which handles codec pairs MediaMuxer
 * cannot. This seam exists for a future platform that has no such bundle.
 */
export interface Muxer {
  remux(videoPath: string, audioPath: string, outputPath: string): Promise<void>;
}

export type ProofOfOriginToken = {
  poToken: string;
  visitorData: string;
  /** Epoch ms. Tokens are short-lived, so callers must check before use. */
  expiresAt: number;
};

/**
 * Supplies PO tokens. Ours come from the live WebView running BotGuard — the
 * structural advantage of actually being a browser.
 *
 * Android reads them off the page directly (see browser/potoken.ts); this
 * interface is the seam for a platform that would need to mint them another way.
 */
export interface TokenProvider {
  get(ref: VideoRef): Promise<ProofOfOriginToken | null>;
  invalidate(): void;
}
