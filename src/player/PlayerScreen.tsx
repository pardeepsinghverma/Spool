import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useEvent } from 'expo';
import { useAudioPlayerStatus, type AudioPlayer } from 'expo-audio';
import { VideoView, type VideoPlayer } from 'expo-video';
import { artworkFor, useArtworkVersion } from '../core/artwork';
import { useTheme } from '../ui/ThemeContext';
import { fixed, motion, radius, size, space, type } from '../ui/theme';
import { usePlayer, type Repeat, type Track, type Sleep } from './PlayerContext';
import { useLyrics, type LyricsState } from './useLyrics';
import { lineAt, type LyricLine } from '../core/lyrics';

/**
 * The full player. See docs/UI.md §03.
 *
 * One session, two shapes: a 320 square of artwork or a 202 16:9 frame, chosen
 * by the toggle at the top. Position, queue and buffer are shared — swapping
 * shape hides the picture, it does not reload anything.
 *
 * No tab bar. This is a sheet over the tab it was opened from, and the chevron
 * returns you there without stopping playback.
 *
 * The design also shows like counts, a share chip and a cast button. Those are
 * YouTube's, not ours: we have no like count to print and nothing to cast to,
 * and a row of controls that do nothing is worse than a row that is absent. The
 * queue actions that *are* real — skip, shuffle, repeat, up next — are here
 * because there is now a queue behind them.
 */

type Props = {
  onDismiss: () => void;
  /** True when this track is a file on the device rather than a stream. */
  saved?: boolean;
  onMore?: () => void;
  /** Opens the sleep-timer sheet. Also what the armed line taps through to. */
  onSleep?: () => void;
};

export function PlayerScreen({ onDismiss, saved, onMore, onSleep }: Props) {
  const { track, player, video } = usePlayer();
  if (!track) return null;
  if (video) {
    return (
      <Frame
        track={track}
        saved={saved}
        onDismiss={onDismiss}
        onMore={onMore}
        onSleep={onSleep}
        video={video}
      />
    );
  }
  if (player) {
    return (
      <Frame
        track={track}
        saved={saved}
        onDismiss={onDismiss}
        onMore={onMore}
        onSleep={onSleep}
        audio={player}
      />
    );
  }
  return null;
}

function Frame({
  track,
  saved,
  onDismiss,
  onMore,
  onSleep,
  audio,
  video,
}: {
  track: Track;
  saved?: boolean;
  onDismiss: () => void;
  onMore?: () => void;
  onSleep?: () => void;
  audio?: AudioPlayer;
  video?: VideoPlayer;
}) {
  const { t, reduced } = useTheme();
  const {
    queue,
    index,
    next,
    previous,
    repeat,
    cycleRepeat,
    shuffle,
    toggleShuffle,
    // Never `audio.play()` from here: the lock screen claim lives in the
    // context, and a restored session that skips it plays with no controls
    // attached — which Android treats as background audio to kill.
    togglePlayback: onToggle,
    sleep,
  } = usePlayer();

  const sleepLabel = useSleepLabel(sleep);

  /**
   * Which shape is showing. Only a video track can offer both — an audio file
   * has no picture to switch to, so the toggle is simply absent rather than
   * present and inert.
   */
  const [shape, setShape] = useState<'audio' | 'video'>(video ? 'video' : 'audio');
  useEffect(() => {
    setShape(video ? 'video' : 'audio');
  }, [video]);

  const clock = useClock(audio, video);
  const playing = clock.playing;

  const lyrics = useLyrics(track, clock.duration);

  // Read at render rather than carried on the Track: a cover can land seconds
  // after playback starts, and the screen it most belongs on is this one.
  useArtworkVersion();
  const art = artworkFor(track.id)?.uri;

  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reduced ? 0 : motion.miniToFull,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [rise, reduced]);

  const upNext = queue.slice(index + 1, index + 4);
  const canSkip = index >= 0 && queue.length > 1;

  return (
    <Animated.View
      style={[
        styles.root,
        { backgroundColor: t.deep },
        {
          opacity: rise,
          transform: [
            { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) },
          ],
        },
      ]}
    >
      <View style={styles.header}>
        <Pressable
          onPress={onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Close player"
          style={({ pressed }) => [styles.headerHit, pressed && { opacity: 0.6 }]}
        >
          <MaterialIcons name="keyboard-arrow-down" size={26} color={t.on} />
        </Pressable>

        <View style={styles.shapeSlot}>
          {video && (
            <View style={[styles.shapeGroup, { backgroundColor: t.tint }]}>
              {(['audio', 'video'] as const).map((mode) => {
                const active = mode === shape;
                return (
                  <Pressable
                    key={mode}
                    onPress={() => setShape(mode)}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={mode === 'audio' ? 'Audio only' : 'Show video'}
                    style={[
                      styles.shapeOption,
                      active && { backgroundColor: t.accent },
                    ]}
                  >
                    <MaterialIcons
                      name={mode === 'audio' ? 'headphones' : 'smart-display'}
                      size={17}
                      color={active ? t.onAccent : t.onDim}
                    />
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        <Pressable
          onPress={onMore}
          disabled={!onMore}
          accessibilityRole="button"
          accessibilityLabel="More options"
          style={({ pressed }) => [styles.headerHit, pressed && onMore && { opacity: 0.6 }]}
        >
          <MaterialIcons name="more-vert" size={21} color={t.on} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={styles.page}
        showsVerticalScrollIndicator={false}
      >
        {shape === 'video' && video ? (
          // Black behind the picture regardless of tint: it is a photograph,
          // and tinting the surround changes what the user sees in it.
          <View style={styles.stage}>
            <VideoView
              player={video}
              style={StyleSheet.absoluteFill}
              contentFit="contain"
              nativeControls={false}
              allowsPictureInPicture
              startsPictureInPictureAutomatically
            />
          </View>
        ) : (
          <View style={[styles.cover, { backgroundColor: t.tint }]}>
            {art ? (
              <Image source={{ uri: art }} style={styles.coverImage} />
            ) : (
              <MaterialIcons
                name={track.kind === 'audio' ? 'music-note' : 'movie'}
                size={44}
                color={t.onDim}
              />
            )}
          </View>
        )}

        <View style={styles.titleRow}>
          <View style={styles.titleBody}>
            <Text numberOfLines={2} style={[styles.title, { color: t.on }]}>
              {track.title}
            </Text>
            <Text numberOfLines={1} style={[styles.artist, { color: t.onDim }]}>
              {track.artist || 'Spool'}
            </Text>
          </View>
          {/* The only hint that this is a file rather than a stream. */}
          {saved && (
            <MaterialIcons name="check-circle" size={19} color={fixed.saved} />
          )}
        </View>

        <Scrubber
          played={clock.duration > 0 ? clock.at / clock.duration : 0}
          colour={t.on}
          onSeek={(fraction) => {
            const to = fraction * clock.duration;
            if (!isFinite(to)) return;
            if (audio) void audio.seekTo(to);
            else if (video) video.currentTime = to;
          }}
        />

        <View style={styles.times}>
          <Text style={[styles.time, { color: t.onDim }]}>{mmss(clock.at)}</Text>
          <Text style={[styles.time, { color: t.onDim }]}>{mmss(clock.duration)}</Text>
        </View>

        <View style={styles.transport}>
          <Pressable
            onPress={toggleShuffle}
            accessibilityRole="button"
            accessibilityState={{ selected: shuffle }}
            accessibilityLabel={shuffle ? 'Shuffle on' : 'Shuffle off'}
            style={({ pressed }) => [styles.sideHit, pressed && { opacity: 0.6 }]}
          >
            <MaterialIcons
              name="shuffle"
              size={23}
              color={shuffle ? t.accent : t.onDim}
            />
          </Pressable>

          <Pressable
            onPress={() => void previous()}
            disabled={!canSkip}
            accessibilityRole="button"
            accessibilityLabel="Previous"
            style={({ pressed }) => [styles.skipHit, pressed && { opacity: 0.6 }]}
          >
            <MaterialIcons
              name="skip-previous"
              size={34}
              color={canSkip ? t.on : fixed.mute}
            />
          </Pressable>

          <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={playing ? 'Pause' : 'Play'}
            style={({ pressed }) => [
              styles.play,
              { backgroundColor: t.on },
              pressed && { opacity: 0.85 },
            ]}
          >
            <MaterialIcons
              name={playing ? 'pause' : 'play-arrow'}
              size={34}
              color={t.deep}
            />
          </Pressable>

          <Pressable
            onPress={() => void next()}
            disabled={!canSkip}
            accessibilityRole="button"
            accessibilityLabel="Next"
            style={({ pressed }) => [styles.skipHit, pressed && { opacity: 0.6 }]}
          >
            <MaterialIcons
              name="skip-next"
              size={34}
              color={canSkip ? t.on : fixed.mute}
            />
          </Pressable>

          <Pressable
            onPress={cycleRepeat}
            accessibilityRole="button"
            accessibilityLabel={REPEAT_LABEL[repeat]}
            style={({ pressed }) => [styles.sideHit, pressed && { opacity: 0.6 }]}
          >
            <MaterialIcons
              name={repeat === 'one' ? 'repeat-one' : 'repeat'}
              size={23}
              color={repeat === 'off' ? t.onDim : t.accent}
            />
          </Pressable>
        </View>

        {/* Only while something is armed. A row that said "Sleep timer: off"
            would be chrome on the one screen that has none — the way in is the
            header's overflow, and this is the receipt. */}
        {sleepLabel && (
          <Pressable
            onPress={onSleep}
            disabled={!onSleep}
            accessibilityRole="button"
            accessibilityLabel={`${sleepLabel}. Change or cancel.`}
            style={({ pressed }) => [styles.sleepRow, pressed && { opacity: 0.6 }]}
          >
            <MaterialIcons name="bedtime" size={15} color={t.accent} />
            <Text style={[styles.sleepText, { color: t.accent }]}>{sleepLabel}</Text>
          </Pressable>
        )}

        {/* Lyrics are the one thing here that is not on the device, so the
            section is a control until it is content: nothing is fetched until
            this is pressed. See core/lyrics.ts. */}
        <Text style={[styles.section, { color: t.onDim }]}>Lyrics</Text>
        <LyricsBlock state={lyrics.state} at={clock.at} onAsk={lyrics.request} />

        {upNext.length > 0 && (
          <>
            <Text style={[styles.section, { color: t.onDim }]}>Up next</Text>
            <View style={styles.queue}>
              {upNext.map((item) => (
                <View key={item.id} style={styles.queueRow}>
                  <View style={[styles.queueArt, { backgroundColor: t.tint }]}>
                    {artworkFor(item.id)?.uri ? (
                      <Image
                        source={{ uri: artworkFor(item.id)!.uri }}
                        style={styles.queueArtImage}
                      />
                    ) : (
                      <MaterialIcons
                        name={item.kind === 'audio' ? 'music-note' : 'movie'}
                        size={15}
                        color={t.onDim}
                      />
                    )}
                  </View>
                  <View style={styles.queueBody}>
                    <Text numberOfLines={1} style={[styles.queueTitle, { color: t.on }]}>
                      {item.title}
                    </Text>
                    <Text numberOfLines={1} style={[styles.queueSub, { color: t.onDim }]}>
                      {item.artist || 'Spool'}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </Animated.View>
  );
}

const REPEAT_LABEL: Record<Repeat, string> = {
  off: 'Repeat off',
  all: 'Repeat queue',
  one: 'Repeat this track',
};

/**
 * One clock for two engines. expo-audio has a status hook and expo-video has
 * events, so this is the only place the difference is allowed to show.
 */
/** How many lines either side of the current one are drawn. */
const LYRIC_WINDOW = 3;

/**
 * Lyrics, as a window rather than a scroller.
 *
 * The page is already a `ScrollView`, and a second one inside it fights the
 * first for the same drag. So a synced lyric draws the current line and three
 * either side, which needs no scrolling to stay on the right line and no
 * auto-scroll to fight the user's thumb. An unsynced one is just text and sits
 * in the page like any other block.
 */
function LyricsBlock({
  state,
  at,
  onAsk,
}: {
  state: LyricsState;
  at: number;
  onAsk: () => void;
}) {
  const { t } = useTheme();

  if (state.kind === 'loading') {
    return <Text style={[styles.lyricNote, { color: t.onDim }]}>Looking…</Text>;
  }

  if (state.kind === 'none') {
    // It asked and there are none. Offering again would be a button that does
    // the same nothing every time it is pressed.
    return (
      <Text style={[styles.lyricNote, { color: fixed.mute }]}>
        No lyrics for this track.
      </Text>
    );
  }

  if (state.kind === 'idle' || state.kind === 'error') {
    return (
      <Pressable
        onPress={onAsk}
        accessibilityRole="button"
        accessibilityLabel="Look up lyrics"
        style={({ pressed }) => [styles.lyricAsk, pressed && { opacity: 0.6 }]}
      >
        <MaterialIcons name="lyrics" size={16} color={t.accent} />
        <Text style={[styles.lyricAskText, { color: t.accent }]}>
          {state.kind === 'error' ? 'Could not reach lyrics — try again' : 'Look up lyrics'}
        </Text>
      </Pressable>
    );
  }

  const { lyrics } = state;
  if (!lyrics.synced) {
    return <Text style={[styles.lyricPlain, { color: t.onDim }]}>{lyrics.plain}</Text>;
  }

  const current = lineAt(lyrics.lines, at);
  const from = Math.max(0, current - LYRIC_WINDOW);
  const to = Math.min(lyrics.lines.length, Math.max(current, 0) + LYRIC_WINDOW + 1);

  return (
    <View style={styles.lyricLines}>
      {lyrics.lines.slice(from, to).map((line: LyricLine, i: number) => {
        const isCurrent = from + i === current;
        return (
          <Text
            key={`${line.at}-${from + i}`}
            style={[
              isCurrent ? styles.lyricNow : styles.lyricLine,
              { color: isCurrent ? t.on : fixed.mute },
            ]}
          >
            {line.text || '·'}
          </Text>
        );
      })}
    </View>
  );
}

/**
 * The armed timer as one line, or nothing at all.
 *
 * Counted in whole minutes, rounded **up**, so the line reads "1 min" for the
 * last sixty seconds rather than "0 min" — a countdown that reaches zero and
 * keeps playing reads as a broken promise. It ticks once a second only while
 * something is armed, and not at all otherwise.
 */
function useSleepLabel(sleep: Sleep): string | null {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!sleep.at) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [sleep.at]);

  if (sleep.endOfTrack) return 'Sleeps at the end of this track';
  if (!sleep.at) return null;
  const left = Math.max(0, sleep.at - Date.now());
  const minutes = Math.ceil(left / 60_000);
  return `Sleeps in ${minutes} min`;
}

function useClock(audio?: AudioPlayer, video?: VideoPlayer) {
  if (audio) return audioClock(audio);
  if (video) return videoClock(video);
  return { at: 0, duration: 0, playing: false };
}

function audioClock(player: AudioPlayer) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the branch above is
  // stable for the lifetime of the screen: a track is audio or video, and
  // changing kind remounts through PlayerScreen's own guard.
  const status = useAudioPlayerStatus(player);
  return {
    at: status.currentTime,
    duration: status.duration,
    playing: status.playing,
  };
}

function videoClock(player: VideoPlayer) {
  /* eslint-disable react-hooks/rules-of-hooks -- see audioClock. */
  const time = useEvent(player, 'timeUpdate', {
    currentTime: player.currentTime,
    bufferedPosition: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
  });
  const state = useEvent(player, 'playingChange', { isPlaying: player.playing });
  /* eslint-enable react-hooks/rules-of-hooks */
  return {
    at: time?.currentTime ?? 0,
    duration: player.duration,
    playing: state?.isPlaying ?? false,
  };
}

/**
 * 4dp track with a 12dp thumb. Tapping anywhere on it seeks — the row is a full
 * touch target rather than the 4dp line it looks like.
 */
function Scrubber({
  played,
  colour,
  onSeek,
}: {
  played: number;
  colour: string;
  onSeek: (fraction: number) => void;
}) {
  const [width, setWidth] = useState(0);
  const pct = Math.round(Math.min(1, Math.max(0, played)) * 100);

  return (
    <Pressable
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      onPress={(e) => {
        if (width <= 0) return;
        onSeek(Math.min(1, Math.max(0, e.nativeEvent.locationX / width)));
      }}
      accessibilityRole="adjustable"
      accessibilityLabel="Seek"
      accessibilityValue={{ min: 0, max: 100, now: pct }}
      style={styles.scrubHit}
    >
      <View style={[styles.scrubTrack, { backgroundColor: `${colour}38` }]}>
        <View style={{ height: 4, width: `${pct}%`, backgroundColor: colour }} />
      </View>
      <View
        style={[
          styles.thumb,
          { backgroundColor: colour, left: `${pct}%` },
        ]}
      />
    </Pressable>
  );
}

const mmss = (seconds: number): string => {
  if (!isFinite(seconds) || seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

const styles = StyleSheet.create({
  sleepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.iconToLabel,
    paddingTop: space.row,
  },
  sleepText: { ...type.mono },
  lyricAsk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.iconToLabel,
    paddingVertical: space.insideChip,
  },
  lyricAskText: { ...type.body, fontSize: 13 },
  lyricNote: { ...type.body, fontSize: 13, paddingVertical: space.insideChip },
  lyricPlain: { ...type.body, fontSize: 14, lineHeight: 22 },
  lyricLines: { gap: 6, paddingVertical: space.insideChip },
  lyricLine: { ...type.body, fontSize: 14, lineHeight: 21 },
  lyricNow: { ...type.rowTitle, fontSize: 15.5, lineHeight: 22 },
  root: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 6,
    paddingBottom: 14,
  },
  headerHit: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  shapeSlot: { flex: 1, alignItems: 'center' },
  shapeGroup: { flexDirection: 'row', borderRadius: 18, padding: 3 },
  shapeOption: {
    width: 52,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  page: { paddingHorizontal: 20, paddingBottom: space.section },
  cover: {
    aspectRatio: 1,
    width: '100%',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 22,
    overflow: 'hidden',
  },
  coverImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  stage: {
    width: '100%',
    aspectRatio: 16 / 9,
    backgroundColor: '#000000',
    borderRadius: 10,
    overflow: 'hidden',
    marginBottom: 18,
  },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 20 },
  titleBody: { flex: 1, minWidth: 0 },
  title: { ...type.nowPlaying, fontSize: 21, lineHeight: 26, marginBottom: 5 },
  artist: { ...type.body, fontSize: 13.5 },
  scrubHit: { height: 24, justifyContent: 'center' },
  scrubTrack: { height: 4, borderRadius: 2, overflow: 'hidden' },
  thumb: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    marginLeft: -6,
  },
  times: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  time: { ...type.mono },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 24,
  },
  sideHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  skipHit: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  play: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { ...type.section, marginBottom: 14 },
  queue: { gap: 14 },
  queueRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  queueArt: {
    width: size.miniArtVideoW,
    height: size.miniArtVideoH,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  queueArtImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  queueBody: { flex: 1, minWidth: 0 },
  queueTitle: { ...type.rowTitle, fontSize: 13, lineHeight: 17, marginBottom: 2 },
  queueSub: { ...type.body, fontSize: 11, lineHeight: 14 },
});
