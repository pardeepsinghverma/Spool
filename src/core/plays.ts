import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * What the user actually watched, kept on the device and nowhere else.
 *
 * This is the only file in the app that records behaviour rather than results,
 * so it is worth being explicit about the shape of it:
 *
 *   dQw4w9WgXcQ    starts 3    seconds 412    lastAt 1786…
 *
 * Three numbers per video — how many times a play began, how long was actually
 * watched in total, and when it last happened. No history of *when* each play
 * occurred, no ordering, nothing that reconstructs a session. The auto-save
 * rule needs a count and a duration; anything more would be a log of someone's
 * evening for no benefit.
 *
 * Nothing here is ever sent anywhere. There is no network call in this module
 * and there must not be one.
 */

const KEY_PLAYS = 'dl.plays';

/** Beyond this the index is trimmed by least-recently-played. */
const MAX_TRACKED = 300;

export type PlayStat = {
  /** YouTube's 11-character id, which is the only stable key a page gives us. */
  id: string;
  title: string;
  artist: string;
  /** Plays that got past the "did they mean it" threshold. */
  starts: number;
  /** Total seconds of real playback, summed across every start. */
  seconds: number;
  /** Epoch ms of the most recent play. */
  lastAt: number;
  /** The page called this a track. Decides what "Match" keeps. */
  music?: boolean;
  /**
   * Epoch ms when the auto-save rule took this one. Its presence is what stops
   * the rule firing again on every subsequent play, so it is set even when the
   * download later fails — a retry loop that re-downloads on every play would
   * be far worse than one missed save.
   */
  savedAt?: number;
};

export type PlayIndex = Record<string, PlayStat>;

export async function loadPlays(): Promise<PlayIndex> {
  try {
    const raw = await AsyncStorage.getItem(KEY_PLAYS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function savePlays(index: PlayIndex): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_PLAYS, JSON.stringify(trim(index)));
  } catch {
    // Non-fatal: the in-memory index is still right for this session, and the
    // cost of losing it is a play count that restarts, not a broken app.
  }
}

export async function clearPlays(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY_PLAYS);
  } catch {
    // Nothing to recover: the caller has already dropped its copy.
  }
}

/**
 * Keeps the index bounded. Anything the rule has already acted on is dropped
 * first — its counters have done their job — and only then does age decide.
 */
function trim(index: PlayIndex): PlayIndex {
  const all = Object.values(index);
  if (all.length <= MAX_TRACKED) return index;

  const ranked = all.sort((a, b) => {
    if (!!a.savedAt !== !!b.savedAt) return a.savedAt ? 1 : -1;
    return b.lastAt - a.lastAt;
  });

  const kept: PlayIndex = {};
  for (const stat of ranked.slice(0, MAX_TRACKED)) kept[stat.id] = stat;
  return kept;
}

/** "3 plays · 41 min", the phrasing used wherever a stat is shown. */
export function describePlays(stat: PlayStat): string {
  const plays = `${stat.starts} play${stat.starts === 1 ? '' : 's'}`;
  const minutes = Math.round(stat.seconds / 60);
  if (minutes >= 1) return `${plays} · ${minutes} min`;
  return `${plays} · ${Math.round(stat.seconds)}s`;
}

/** Most-played first, then most recent — the order "On repeat" wants. */
export function ranked(index: PlayIndex): PlayStat[] {
  return Object.values(index).sort(
    (a, b) => b.starts - a.starts || b.seconds - a.seconds || b.lastAt - a.lastAt,
  );
}
