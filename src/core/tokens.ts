/**
 * PO tokens, kept per video.
 *
 * The app used to hold exactly one token — whichever the page last minted — and
 * send it with every download. That is wrong in a way nothing in the app could
 * see, because a token that is refused looks identical to a client that is
 * refused:
 *
 *   > "Most PO Tokens (such as for `web` GVS/Player) are bound to the video ID,
 *   >  so a new token is required for each video."
 *   >  — yt-dlp, PO Token Guide
 *
 * So a token harvested while watching A and spent on B is not a weaker token,
 * it is the wrong one, and the media fetch 403s. Downloading the video you are
 * *currently* watching happened to work; anything else — the replay rule, the
 * notification's save button, a retry from Library minutes later — was rolling
 * a die.
 *
 * Hence a store keyed by video id. It is deliberately tiny and synchronous:
 * every download path reads it on the way past, and none of them can afford to
 * wait for storage.
 */

/** What the page minted, and when. */
export type Token = {
  poToken: string;
  visitorData: string;
  /** Epoch ms, so staleness can be judged without a second clock. */
  mintedAt: number;
};

export type TokenView = { poToken?: string; visitorData?: string };

/**
 * How long a harvested token is trusted.
 *
 * The guide is unusually vague here — "a limited lifespan (possibly as short as
 * 12 hours)", with reports of some lasting months — so this is deliberately
 * well under the pessimistic end. Being too eager costs one re-harvest; being
 * too generous costs a 403 the user reads as a broken download.
 */
export const TTL_MS = 6 * 60 * 60 * 1000;

/**
 * A small cap, because this is a browsing session's worth of videos and the
 * only cost of a miss is asking the page again.
 */
const CAP = 60;

const store = new Map<string, Token>();

/**
 * Records what the page minted for one video.
 *
 * Merges rather than replaces: the harvester reports `visitorData` as soon as
 * the page loads and the `poToken` only once a player response arrives, so the
 * two halves routinely turn up in separate messages.
 */
export function remember(videoId: string, next: Partial<Token> & { mintedAt: number }): void {
  if (!videoId) return;

  const prior = store.get(videoId);
  const merged: Token = {
    poToken: next.poToken || prior?.poToken || '',
    visitorData: next.visitorData || prior?.visitorData || '',
    mintedAt: next.mintedAt,
  };

  // Re-inserting moves it to the end of the Map's iteration order, which is
  // what makes the eviction below least-recently-*touched* rather than oldest.
  store.delete(videoId);
  store.set(videoId, merged);

  while (store.size > CAP) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * The token for this video, or nothing.
 *
 * Returning `undefined` rather than a stale or foreign token is the whole
 * point: yt-dlp without a token walks the open clients and may still succeed,
 * whereas yt-dlp with the *wrong* token pins itself to the web client and
 * fails. Absent beats wrong.
 */
export function tokenFor(videoId: string | null | undefined, now: number): TokenView {
  if (!videoId) return {};
  const held = store.get(videoId);
  if (!held) return {};
  if (now - held.mintedAt > TTL_MS) {
    store.delete(videoId);
    return {};
  }
  return {
    poToken: held.poToken || undefined,
    visitorData: held.visitorData || undefined,
  };
}

/** Whether a usable token is held. Cheap enough for a render path. */
export const hasToken = (videoId: string | null | undefined, now: number): boolean =>
  !!tokenFor(videoId, now).poToken;

/** What the log wants to say about the store without naming any of it. */
export const summary = (): { videos: number } => ({ videos: store.size });

/** Test seam. */
export function reset(): void {
  store.clear();
}
