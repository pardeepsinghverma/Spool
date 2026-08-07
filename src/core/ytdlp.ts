/**
 * The download engine, over the native yt-dlp module.
 *
 * Parsing lives here rather than in Kotlin so the Format model has exactly one
 * definition (see engine.ts).
 */

import YtDlp, { onProgress, type ProgressEvent } from '../../modules/ytdlp';
import type { DownloadProgress, Format, VideoRef } from './engine';

export const IS_PREVIEW = false;

export type VideoMeta = {
  id: string;
  title: string;
  channel: string;
  durationSeconds: number;
  formats: Format[];
};

type RawFormat = {
  format_id: string;
  ext?: string;
  vcodec?: string;
  acodec?: string;
  height?: number;
  fps?: number;
  filesize?: number | null;
  filesize_approx?: number | null;
  abr?: number | null;
  format_note?: string;
};

let ready: Promise<string> | null = null;

/** Extracting Python on first run takes a moment; only do it once. */
export function initEngine(): Promise<string> {
  if (!ready) {
    ready = YtDlp.initialize().catch((e) => {
      ready = null;
      throw e;
    });
  }
  return ready;
}

export const engineVersion = () => YtDlp.version();

export async function updateEngine() {
  await initEngine();
  return YtDlp.updateEngine();
}

export async function listFormats(
  ref: VideoRef,
  token?: { poToken?: string; visitorData?: string } | null,
): Promise<VideoMeta> {
  await initEngine();
  const raw = await YtDlp.listFormats(
    ref.url,
    token?.poToken ?? null,
    token?.visitorData ?? null,
  );

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Engine returned malformed metadata');
  }

  const formats: Format[] = (parsed.formats ?? [])
    .filter((f: RawFormat) => f && f.format_id && !isStoryboard(f))
    .map(toFormat)
    .filter((f: Format | null): f is Format => f !== null);

  return {
    id: parsed.id ?? ref.videoId,
    title: parsed.title ?? ref.title,
    channel: parsed.channel ?? parsed.uploader ?? '',
    durationSeconds: Number(parsed.duration ?? 0),
    formats: dedupe(formats),
  };
}

export function startDownload(
  args: {
    id: string;
    ref: VideoRef;
    format: Format;
    audioOnly: boolean;
    token?: { poToken?: string; visitorData?: string } | null;
  },
  onTick: (p: DownloadProgress) => void,
): { promise: Promise<{ path: string; bytes: number }>; cancel: () => void } {
  const sub = onProgress((e: ProgressEvent) => {
    if (e.id !== args.id) return;
    onTick({ fraction: e.fraction, etaSeconds: e.eta });
  });

  // Whether a token was harvested decides whether the media fetch 403s, so it
  // is the first thing worth knowing when a download fails.
  console.log(
    `[spool] download token: poToken=${args.token?.poToken ? 'yes' : 'NO'} ` +
      `visitorData=${args.token?.visitorData ? 'yes' : 'NO'}`,
  );

  const promise = initEngine()
    .then(() =>
      YtDlp.download({
        id: args.id,
        url: args.ref.url,
        title: args.ref.title,
        format: selector(args.format, args.audioOnly),
        audioOnly: args.audioOnly,
        poToken: args.token?.poToken,
        visitorData: args.token?.visitorData,
      }),
    )
    .finally(() => sub.remove());

  return {
    promise,
    cancel: () => {
      sub.remove();
      YtDlp.cancel(args.id).catch(() => {});
    },
  };
}

export const publishToGallery = (path: string, title: string, audioOnly: boolean) =>
  YtDlp.publishToGallery(path, title, audioOnly);

/**
 * A video-only stream has to be paired with audio or the file is silent —
 * yt-dlp merges the pair itself using the bundled ffmpeg.
 */
function selector(format: Format, audioOnly: boolean): string {
  if (audioOnly) return format.id;
  return format.muxed ? format.id : `${format.id}+bestaudio/best`;
}

function toFormat(f: RawFormat): Format | null {
  const hasVideo = !!f.vcodec && f.vcodec !== 'none';
  const hasAudio = !!f.acodec && f.acodec !== 'none';
  if (!hasVideo && !hasAudio) return null;

  return {
    id: f.format_id,
    kind: hasVideo ? 'video' : 'audio',
    height: hasVideo ? (f.height ?? undefined) : undefined,
    fps: hasVideo ? (f.fps ?? undefined) : undefined,
    container: f.ext ?? 'mp4',
    codec: shortCodec(hasVideo ? f.vcodec! : f.acodec!),
    kbps: !hasVideo && f.abr ? Math.round(f.abr) : undefined,
    size: f.filesize ?? f.filesize_approx ?? undefined,
    muxed: hasVideo && hasAudio,
  };
}

const shortCodec = (codec: string): string => {
  const c = codec.toLowerCase();
  if (c.startsWith('avc1') || c.startsWith('h264')) return 'h264';
  if (c.startsWith('vp9') || c.startsWith('vp09')) return 'vp9';
  if (c.startsWith('av01')) return 'av1';
  if (c.startsWith('mp4a')) return 'aac';
  if (c.startsWith('opus')) return 'opus';
  return c.split('.')[0];
};

const isStoryboard = (f: RawFormat) =>
  f.ext === 'mhtml' || f.format_id.startsWith('sb');

/** yt-dlp lists several near-identical rungs; keep the best per resolution. */
function dedupe(formats: Format[]): Format[] {
  const best = new Map<string, Format>();
  for (const f of formats) {
    const key = f.kind === 'audio' ? `a:${f.container}` : `v:${f.height}:${f.muxed}`;
    const existing = best.get(key);
    if (!existing || (f.size ?? 0) > (existing.size ?? 0)) best.set(key, f);
  }
  return [...best.values()].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'video' ? -1 : 1;
    return (b.height ?? 0) - (a.height ?? 0);
  });
}
