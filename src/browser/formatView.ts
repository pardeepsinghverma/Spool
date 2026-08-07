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
