import YtDlp, { onPlaybackCommand, type NowPlaying, type PlaybackCommandEvent } from '../../modules/ytdlp';
import type { EventSubscription } from 'expo-modules-core';

/**
 * One media notification, two things that can fill it.
 *
 * Spool plays from two engines that know nothing about each other — the local
 * player and the browser's own <video> — and Android has room for exactly one
 * card per app. This is the arbiter: whoever last published owns the card, and
 * commands coming back from it are delivered only to that owner.
 *
 * Without the ownership test both sources would act on every button. Pressing
 * pause on a YouTube page would also pause the library track that the gate had
 * already stopped, which then refuses to resume because the notification says
 * it is playing.
 */

export type Source = 'local' | 'browser';

let owner: Source | null = null;

/**
 * The last state each source published, kept per source rather than globally.
 *
 * A single "last published" string looked equivalent and was not: with the
 * browser holding the card, the local player's next idle tick would differ from
 * it in the source field alone and quietly steal the notification back while
 * nothing about the local player had changed.
 */
const published: Record<Source, string> = { local: '', browser: '' };
const positions: Record<Source, { at: number; clock: number; playing: boolean }> = {
  local: { at: 0, clock: 0, playing: false },
  browser: { at: 0, clock: 0, playing: false },
};

/**
 * How far the real playhead may drift from where the system thinks it is
 * before a correction is worth a bridge call.
 *
 * A PlaybackState carries a position, the moment it was measured, and a speed —
 * the system extrapolates the rest, so a track playing normally needs no
 * updates at all. Two seconds is under the width of the scrubber thumb and well
 * over what buffering costs.
 */
const DRIFT_SECONDS = 2;

/** Everything except the playhead, which moves on its own. */
const shapeOf = (state: NowPlaying) =>
  [
    state.title,
    state.artist ?? '',
    state.playing,
    state.artwork ?? '',
    Math.round(state.duration),
    state.canNext,
    state.canPrevious,
    // Here so the button disappears the moment the file exists. Left out, the
    // card would keep offering a save for something already in the library
    // until the next thing that happened to change its shape.
    state.canSave,
  ].join('|');

/**
 * Show `state` on the notification, and claim it for `source`.
 *
 * Cheap to call on every status tick: a call that would not change what the
 * card shows never reaches the bridge.
 */
export function publishNowPlaying(source: Source, state: NowPlaying): void {
  /**
   * You take the card by playing, and you keep it until something else does.
   *
   * Without this the two sources flap. Both describe themselves once a second,
   * and any publish from the source that did not currently hold the card was
   * taken as a claim — so a paused library track and a playing page rewrote the
   * notification past each other several times a second, and the transport
   * buttons acted on whichever had written last. Measured on the phone: the
   * card alternated between the track and the page title twice per second.
   *
   * Stated as a rule: a source that is not making a sound may update the card
   * it already owns, and may not take one from a source that is.
   */
  if (owner !== source && !state.playing) return;

  const shape = shapeOf(state);
  const mine = published[source];
  const seen = positions[source];

  if (shape === mine && owner === source) {
    const expected = seen.playing ? seen.at + (Date.now() - seen.clock) / 1000 : seen.at;
    if (Math.abs(state.position - expected) < DRIFT_SECONDS) return;
  }

  owner = source;
  published[source] = shape;
  positions[source] = { at: state.position, clock: Date.now(), playing: state.playing };
  YtDlp.setNowPlaying(state);
}

/**
 * Take the notification down, if this source is the one holding it.
 *
 * A source that has already lost the card to the other one must not be able to
 * remove it — that is how closing a browser tab would take down the card for a
 * library track that had just started.
 */
export function releaseNowPlaying(source: Source): void {
  published[source] = '';
  if (owner !== source) return;
  owner = null;
  YtDlp.stopBackgroundPlayback();
}

/** True while this source is the one the notification is describing. */
export const ownsNotification = (source: Source): boolean => owner === source;

/**
 * Buttons, headset keys and the scrubber, delivered only to whichever source
 * the card is currently showing.
 */
export function onNotificationCommand(
  source: Source,
  handler: (event: PlaybackCommandEvent) => void,
): EventSubscription {
  return onPlaybackCommand((event) => {
    if (owner !== source) return;
    handler(event);
  });
}
