import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Persisted state. Kept deliberately small — the app stores what the user
 * downloaded and whether they've seen the first-run screen, and nothing else.
 * No analytics, no identifiers.
 */

const KEY_FIRST_RUN = 'dl.firstRunDone';
const KEY_DOWNLOADS = 'dl.downloads';

export type DownloadRecord = {
  id: string;
  title: string;
  quality: string;
  /** MediaStore content:// uri once published. */
  uri?: string;
  bytes?: number;
  audioOnly: boolean;
  /** Epoch ms. */
  savedAt: number;
  state: 'saved' | 'failed';
  error?: string;
};

export async function hasSeenFirstRun(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(KEY_FIRST_RUN)) === '1';
  } catch {
    return false;
  }
}

export async function markFirstRunSeen(): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY_FIRST_RUN, '1');
  } catch {
    // A failed write only means the notice shows again; not worth surfacing.
  }
}

export async function loadDownloads(): Promise<DownloadRecord[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY_DOWNLOADS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveDownloads(records: DownloadRecord[]): Promise<void> {
  try {
    // Cap the history so the list can't grow without bound.
    await AsyncStorage.setItem(KEY_DOWNLOADS, JSON.stringify(records.slice(0, 200)));
  } catch {
    // Non-fatal: the in-memory list is still correct for this session.
  }
}
