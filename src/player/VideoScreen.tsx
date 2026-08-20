import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { VideoView } from 'expo-video';
import { size, space } from '../ui/theme';
import { usePlayer } from './PlayerContext';

/**
 * Full-screen playback for a downloaded video.
 *
 * Always black regardless of theme — it is a picture, and the chrome around a
 * picture should not tint it.
 *
 * Backing out does not stop playback. The player lives in PlayerContext, so the
 * video keeps going and the Now Playing bar picks it up; that is also what lets
 * it survive the app being closed entirely.
 */
export function VideoScreen({ onBack }: { onBack: () => void }) {
  const { video, track } = usePlayer();
  if (!video) return null;

  return (
    <View style={styles.root}>
      <VideoView
        player={video}
        style={StyleSheet.absoluteFill}
        contentFit="contain"
        nativeControls
        // Leaving the app hands the video to a floating window rather than
        // hiding it — the picture keeps going, not just the sound.
        allowsPictureInPicture
        startsPictureInPictureAutomatically
      />

      {/* The screen's own safe area is already applied by the shell this sits
          inside, so the bar only needs to be a bar. */}
      <View style={styles.bar} pointerEvents="box-none">
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to downloads"
          style={({ pressed }) => [styles.hit, pressed && { opacity: 0.5 }]}
        >
          <MaterialIcons name="arrow-back" size={22} color="#FFFFFF" />
        </Pressable>
        <Text numberOfLines={1} style={styles.title}>
          {track?.title ?? ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000000' },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.barSide,
    paddingRight: space.gutter,
    height: size.bar,
  },
  hit: {
    width: size.target,
    height: size.target,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The controls underneath are the player's own, so this text sits on video
  // with nothing behind it; a shadow is the only thing keeping it readable.
  title: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '500',
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowRadius: 4,
  },
});
