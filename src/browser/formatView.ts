import type { Format } from '../core/engine';
import type { FormatRow, QuickPick } from '../sheets/QualitySheet';

const MB = 1_000_000;

export const formatSize = (bytes?: number): string =>
  bytes == null || bytes <= 0 ? '—' : `${Math.round(bytes / MB)} MB`;

/**
 * Three taps, max — never a raw format table on the front sheet. That's the
 * incumbent mistake the design calls out.
 */
export function toQuickPicks(formats: Format[]): QuickPick[] {
  const video = formats.filter((f) => f.kind === 'video' && f.height);
  const audio = formats
    .filter((f) => f.kind === 'audio')
    .sort((a, b) => (b.kbps ?? 0) - (a.kbps ?? 0))[0];

  const picks: QuickPick[] = [];
  if (!video.length && !audio) return picks;

  const best = video[0];
  // Prefer a 1080p rung for the explicit row; fall back to whatever is best.
  const preferred = video.find((f) => f.height === 1080) ?? best;

  if (best) {
    picks.push({
      id: best.id,
      icon: 'bolt',
      title: 'Best',
      detail: `${best.height}p · mp4 · ~${formatSize(best.size)}`,
      highlight: true,
    });
  }

  if (preferred && preferred.id !== best?.id) {
    picks.push({
      id: preferred.id,
      icon: 'hd',
      title: `${preferred.height}p`,
      detail: `mp4 · ${preferred.codec} · ~${formatSize(preferred.size)}`,
    });
  } else if (preferred) {
    picks.push({
      id: `${preferred.id}:explicit`,
      icon: 'hd',
      title: `${preferred.height}p`,
      detail: `mp4 · ${preferred.codec} · ~${formatSize(preferred.size)}`,
    });
  }

  if (audio) {
    picks.push({
      id: audio.id,
      icon: 'graphic-eq',
      title: 'Audio only',
      detail: `${audio.container} · ${audio.kbps ?? '?'} kbps · ~${formatSize(audio.size)}`,
    });
  }

  return picks;
}

export function toFormatRows(formats: Format[], freeBytes?: number): FormatRow[] {
  return formats
    .filter((f) => f.kind === 'video' && f.height)
    .map((f) => ({
      id: f.id,
      res: `${f.height}p`,
      note: [f.fps ? `${f.fps} fps` : null, f.muxed ? 'with audio' : 'video only']
        .filter(Boolean)
        .join(' · '),
      codec: f.codec,
      size: formatSize(f.size),
      tooLarge: freeBytes != null && f.size != null && f.size > freeBytes,
    }));
}

export const isAudioPick = (id: string, formats: Format[]): boolean => {
  const clean = id.replace(':explicit', '');
  return formats.find((f) => f.id === clean)?.kind === 'audio';
};

/**
 * Choosing without a human present.
 *
 * The sheet can afford to show everything and let the user judge. An instant
 * tap and the replay rule cannot, so these two make the call from the settings
 * alone — and both fall back rather than returning nothing, because a download
 * that silently does not happen is the worst outcome available.
 */
export function bestAudio(formats: Format[], maxKbps = Infinity): Format | undefined {
  const audio = formats
    .filter((f) => f.kind === 'audio')
    .sort((a, b) => (b.kbps ?? 0) - (a.kbps ?? 0));
  if (!audio.length) return undefined;
  // Rungs with no reported bitrate are not evidence of being small, so they are
  // only reached once nothing measurable fits.
  return audio.find((f) => f.kbps != null && f.kbps <= maxKbps) ?? audio[audio.length - 1];
}

/**
 * The best video at or below `maxHeight`. Falls back to the smallest available
 * when everything on offer is taller than the ceiling, so a 4K-only upload
 * still saves something rather than nothing.
 */
export function bestVideo(formats: Format[], maxHeight: number): Format | undefined {
  const video = formats
    .filter((f) => f.kind === 'video' && f.height)
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  if (!video.length) return undefined;
  return video.find((f) => (f.height ?? 0) <= maxHeight) ?? video[video.length - 1];
}

/** "1080p" → 1080. Unparseable settings fall back to 1080 rather than to 0. */
export function heightFromQuality(quality: string): number {
  const match = /(\d{3,4})\s*p/i.exec(quality);
  return match ? Number(match[1]) : 1080;
}

/**
 * "128 kbps" → 128, and anything without a number → no ceiling. "Best
 * available" is the default, so an unreadable setting has to mean *more* rather
 * than less: capping a user's audio because a string did not parse is the one
 * failure they would never trace back to here.
 */
export function kbpsFromQuality(quality: string): number {
  const match = /(\d{2,4})\s*k/i.exec(quality);
  return match ? Number(match[1]) : Infinity;
}

