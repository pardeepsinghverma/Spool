import { useEffect, useRef } from 'react';
import { Animated, Easing, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { useAudioPlayerStatus, type AudioPlayer } from 'expo-audio';
import type { VideoPlayer } from 'expo-video';
import { artworkFor, useArtworkVersion } from '../core/artwork';
import { useTheme } from '../ui/ThemeContext';
import { fixed, motion, size, space, type } from '../ui/theme';
import { usePlayer, type Track } from './PlayerContext';
import { usePagePlayback, type PagePlayback } from '../browser/pageNowPlaying';

/**
 * The mini player. See docs/UI.md §03.
 *
 * Rides above the tab bar on the four local tabs — never on Browse, which is
 * someone else's page at full bleed. Four states: audio,
 * video, buffering and stalled. The 2dp line across the top is the only
 * progress indicator — a stalled session says so in warn-coloured text and
 * nothing else. No colour flood, no dialog.
 */

export function NowPlayingBar({
  onOpen,
  page,
}: {
  onOpen?: () => void;
  /**
   * The browser's transport, when the page is what is making the sound.
   *
   * Absent means this app is the only source, which is how the bar behaved
   * before pages could hold the card.
   */
  page?: { onOpen: () => void; onToggle: () => void; onStop: () => void };
}) {
  const { player, video, track, stop, togglePlayback } = usePlayer();
  const pageState = usePagePlayback();

  /**
   * Which source the bar is for.
   *
   * A page that is actually playing wins outright — under `doNotMix` only one
   * of them is audible, and showing a paused library track over YouTube would
   * put a play button on the bar that stops the sound the user can hear when
   * they press it. Otherwise the local session wins, because it is the one with
   * a queue and a full player behind it; a paused page falls to the bottom and
   * is shown only when there is nothing else, so that leaving a video to go and
   * look at Library still leaves a way back to it.
   */
  const usePage = !!pageState && !!page && (pageState.playing || !track);
  if (usePage) {
    return <PageBar state={pageState!} {...page!} />;
  }

  // The status hooks need a real player, so the guard lives out here and they
  // are called unconditionally one level down.
  if (!track) return null;
  if (video) {
    return (
      <VideoBar
        player={video}
        track={track}
        onOpen={onOpen}
        onStop={stop}
        onToggle={togglePlayback}
      />
    );
  }
  if (player) {
    return (
      <AudioBar
        player={player}
        track={track}
        onOpen={onOpen}
        onStop={stop}
        onToggle={togglePlayback}
      />
    );
  }
  return null;
}

/**
 * The bar for a YouTube page.
 *
 * The sub-line is the artist where the page named one and **"YouTube"** where
 * it did not — the same word the notification puts after the artist, and the
 * only thing on the bar that says this is a page rather than a file. That
 * difference is load-bearing: a page stops when the tab moves on, its position
 * is not resumable from the library, and tapping it goes back to Browse rather
 * than opening a full player that has no queue to show.
 *
 * Square art, because the source is being listened to rather than watched — the
 * wide shape is for a local video the full player can put on screen.
 */
function PageBar({
  state,
  onOpen,
  onToggle,
  onStop,
}: {
  state: PagePlayback;
  onOpen: () => void;
  onToggle: () => void;
  onStop: () => void;
}) {
  useArtworkVersion();

  return (
    <Bar
      shape="square"
      // Resolved under the same key the notification uses, so a cover already
      // fetched for the card costs nothing here.
      art={artworkFor(`yt:${state.id}`)?.uri}
      title={state.title}
      subtitle={state.artist || 'YouTube'}
      subtitleTone="dim"
      played={state.length > 0 ? state.at / state.length : 0}
      playing={state.playing}
      loading={false}
      onToggle={onToggle}
      onOpen={onOpen}
      onStop={onStop}
    />
  );
}

function AudioBar({
  player,
  track,
  onOpen,
  onStop,
  onToggle,
}: {
  player: AudioPlayer;
  track: Track;
  onOpen?: () => void;
  onStop: () => void;
  onToggle: () => void;
}) {
  const status = useAudioPlayerStatus(player);
  const loading = status.isBuffering && !status.playing;
  useArtworkVersion();
  const art = artworkFor(track.id)?.uri;

  /**
   * The book's fourth state, which was unreachable: the tone read
   * `loading ? 'dim' : 'dim'`, so warn text never appeared however badly
   * playback was going.
   *
   * It is reworded from the book's "Paused · no connection" on purpose. Spool
   * plays files off this device — a local file does not stall on the network,
   * and blaming the connection would send someone to check their Wi-Fi over a
   * file that is simply not there any more. That failure is real and has been
   * seen: publishing to the gallery moves the file out from under a row that
   * still lists it.
   */
  const missing = !status.isLoaded && !status.isBuffering && status.duration <= 0;

  return (
    <Bar
      shape="square"
      art={art}
      title={track.title}
      subtitle={
        loading ? 'Buffering' : missing ? 'File is missing' : track.artist || 'Spool'
      }
      subtitleTone={missing ? 'warn' : 'dim'}
      played={status.duration > 0 ? status.currentTime / status.duration : 0}
      playing={status.playing}
      loading={loading}
      onToggle={onToggle}
      onOpen={onOpen}
      onStop={onStop}
    />
  );
}

function VideoBar({
  player,
  track,
  onOpen,
  onStop,
  onToggle,
}: {
  player: VideoPlayer;
  track: Track;
  onOpen?: () => void;
  onStop: () => void;
  onToggle: () => void;
}) {
  // expo-video has no status hook; the two events that move this bar are the
  // clock and the play state, so it subscribes to exactly those.
  const time = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    bufferedPosition: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });
  const state = useEvent(player, 'playingChange', { isPlaying: player.playing });
  const playing = state?.isPlaying ?? false;
  const at = time?.currentTime ?? 0;
  useArtworkVersion();

  return (
    <Bar
      shape="wide"
      art={artworkFor(track.id)?.uri}
      title={track.title}
      subtitle={track.artist || 'Spool'}
      subtitleTone="dim"
      played={player.duration > 0 ? at / player.duration : 0}
      playing={playing}
      loading={false}
      onToggle={onToggle}
      onOpen={onOpen}
      onStop={onStop}
    />
  );
}

function Bar({
  shape,
  art,
  title,
  subtitle,
  subtitleTone,
  played,
  playing,
  loading,
  onToggle,
  onOpen,
  onStop,
}: {
  shape: 'square' | 'wide';
  art?: string;
  title: string;
  subtitle: string;
  subtitleTone: 'dim' | 'warn';
  played: number;
  playing: boolean;
  loading: boolean;
  onToggle: () => void;
  onOpen?: () => void;
  onStop: () => void;
}) {
  const { t, reduced } = useTheme();
  const pct = Math.round(Math.min(1, Math.max(0, played)) * 100);

  return (
    <View style={[styles.root, { backgroundColor: t.tint }]}>
      <View style={styles.track}>
        <View style={{ height: 2, width: `${pct}%`, backgroundColor: t.accent }} />
      </View>

      <View style={styles.body}>
        <View
          style={[
            shape === 'square' ? styles.artSquare : styles.artWide,
            { backgroundColor: t.deep },
          ]}
        >
          {loading ? (
            <Spinner colour={t.onDim} reduced={reduced} />
          ) : art ? (
            <Image source={{ uri: art }} style={styles.artImage} />
          ) : (
            <MaterialIcons
              name={shape === 'square' ? 'music-note' : 'movie'}
              size={16}
              color={t.onDim}
            />
          )}
        </View>

        <Pressable
          onPress={onOpen}
          disabled={!onOpen}
          accessibilityRole={onOpen ? 'button' : undefined}
          accessibilityLabel={onOpen ? `Open player — ${title}` : undefined}
          style={({ pressed }) => [styles.labels, pressed && onOpen && { opacity: 0.6 }]}
        >
          <Text numberOfLines={1} style={[styles.title, { color: t.on }]}>
            {title}
          </Text>
          <Text
            numberOfLines={1}
            style={[
              styles.subtitle,
              { color: subtitleTone === 'warn' ? fixed.warn : t.onDim },
            ]}
          >
            {subtitle}
          </Text>
        </Pressable>

        <Pressable
          onPress={onToggle}
          accessibilityRole="button"
          accessibilityLabel={playing ? 'Pause' : 'Play'}
          style={({ pressed }) => [styles.hit, pressed && { opacity: 0.5 }]}
        >
          <MaterialIcons
            name={playing ? 'pause' : 'play-arrow'}
            size={26}
            color={t.on}
          />
        </Pressable>

        <Pressable
          onPress={onStop}
          accessibilityRole="button"
          accessibilityLabel="Stop playback"
          style={({ pressed }) => [styles.hitSmall, pressed && { opacity: 0.5 }]}
        >
          <MaterialIcons name="close" size={19} color={t.onDim} />
        </Pressable>
      </View>
    </View>
  );
}

/** 900ms linear, matching the buffering state in the design. */
function Spinner({ colour, reduced }: { colour: string; reduced: boolean }) {
  const spin = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduced) return;
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: motion.spin,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin, reduced]);

  return (
    <Animated.View
      style={{
        transform: [
          {
            rotate: spin.interpolate({
              inputRange: [0, 1],
              outputRange: ['0deg', '360deg'],
            }),
          },
        ],
      }}
    >
      <MaterialIcons name="refresh" size={17} color={colour} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { height: size.miniPlayer, overflow: 'hidden' },
  track: { height: 2, width: '100%', backgroundColor: 'rgba(0,0,0,.35)' },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingLeft: 10,
    paddingRight: space.insideChip,
  },
  artSquare: {
    width: size.miniArt,
    height: size.miniArt,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  artWide: {
    width: size.miniArtVideoW,
    height: size.miniArtVideoH,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  artImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  labels: { flex: 1, minWidth: 0, gap: 2 },
  title: { ...type.rowTitle, fontSize: 13, lineHeight: 17 },
  subtitle: { ...type.body, fontSize: 11, lineHeight: 14 },
  hit: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  hitSmall: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
});
