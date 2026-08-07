import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../ui/ThemeContext';
import { RING_CIRCUMFERENCE, RING_RADIUS, bezier, motion, size } from '../ui/theme';

export type DownloadState =
  | 'idle'
  | 'ready'
  | 'resolving'
  | 'working'
  | 'done'
  | 'failed';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

type Props = {
  state: DownloadState;
  /** 0..1, only meaningful in `working`. */
  progress?: number;
  onPress: () => void;
};

const ICON: Record<DownloadState, keyof typeof MaterialIcons.glyphMap> = {
  idle: 'file-download',
  ready: 'file-download',
  resolving: 'file-download',
  working: 'stop',
  done: 'check',
  failed: 'refresh',
};

const ICON_SIZE: Record<DownloadState, number> = {
  idle: 22,
  ready: 22,
  resolving: 20,
  working: 18,
  done: 22,
  failed: 22,
};

export const A11Y_LABEL = (state: DownloadState, pct: number): string =>
  ({
    idle: 'Download, unavailable. No video on this page.',
    ready: 'Download video. Video detected on this page.',
    resolving: 'Finding available formats, please wait.',
    working: `Downloading, ${pct} percent. Double tap to cancel.`,
    done: 'Download complete, saved to Downloads. Double tap to open.',
    failed: "Download failed, couldn't reach YouTube. Double tap to retry.",
  })[state];

/**
 * Six states in one 48dp square.
 *
 * The button never leaves the bar, so it has only two currencies for salience:
 * contrast (it is the single element permitted to be accent-coloured) and time
 * (the halo runs exactly three cycles, then stops forever).
 */
export function DownloadButton({ state, progress = 0, onPress }: Props) {
  const { t, reduced } = useTheme();

  const pulse = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const breath = useRef(new Animated.Value(1)).current;
  const ring = useRef(new Animated.Value(RING_CIRCUMFERENCE)).current;

  // ready — halo + icon pulse, three cycles then still. Suppressed entirely
  // under reduced motion, where a persistent disc carries the salience instead.
  useEffect(() => {
    pulse.stopAnimation();
    pulse.setValue(0);
    if (state !== 'ready' || reduced) return;
    const anim = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: motion.pulseCycle,
        easing: Easing.bezier(...bezier.emphasized),
        useNativeDriver: true,
      }),
      { iterations: motion.pulseCycles },
    );
    anim.start();
    return () => anim.stop();
  }, [state, reduced, pulse]);

  // resolving — constant-rate arc.
  useEffect(() => {
    spin.stopAnimation();
    spin.setValue(0);
    if (state !== 'resolving' || reduced) return;
    const anim = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: motion.spin,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [state, reduced, spin]);

  // failed — slow opacity breath. Noticeable in peripheral vision, nothing
  // like an alert: no shake, no red, no sound.
  useEffect(() => {
    breath.stopAnimation();
    breath.setValue(1);
    if (state !== 'failed' || reduced) return;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 0.55,
          duration: motion.breath / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 1,
          duration: motion.breath / 2,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [state, reduced, breath]);

  // working — determinate ring. Never runs backwards; under reduced motion it
  // still fills (it encodes state) but jumps without easing.
  useEffect(() => {
    if (state !== 'working') return;
    const clamped = Math.max(0, Math.min(1, progress));
    const target = RING_CIRCUMFERENCE * (1 - clamped);
    Animated.timing(ring, {
      toValue: target,
      duration: reduced ? 0 : motion.progressStep,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
  }, [state, progress, reduced, ring]);

  useEffect(() => {
    if (state !== 'working') ring.setValue(RING_CIRCUMFERENCE);
  }, [state, ring]);

  const inert = state === 'idle';

  const discColor =
    state === 'done'
      ? t.successSurface
      : state === 'failed'
        ? t.warnSurface
        : t.accentSurface;

  const iconColor: string = {
    idle: t.iconDisabled,
    ready: t.accent,
    resolving: t.accent,
    working: t.accent,
    done: t.success,
    failed: t.warn,
  }[state];

  // Reduced motion swaps the moving halo for a persistent stroked disc.
  const showStaticDisc =
    state === 'done' || state === 'failed' || (state === 'ready' && reduced);

  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={A11Y_LABEL(state, Math.round(progress * 100))}
      accessibilityState={{ disabled: inert }}
      style={({ pressed }) => [styles.hit, pressed && !inert && styles.pressed]}
    >
      {state === 'ready' && !reduced && (
        <Animated.View
          style={[
            styles.disc,
            {
              backgroundColor: t.accent,
              opacity: pulse.interpolate({
                inputRange: [0, 0.22, 0.55, 1],
                outputRange: [0, 0.42, 0, 0],
              }),
              transform: [
                {
                  scale: pulse.interpolate({
                    inputRange: [0, 0.55, 1],
                    outputRange: [0.72, 1.18, 1.18],
                  }),
                },
              ],
            },
          ]}
        />
      )}

      {showStaticDisc && (
        <View
          style={[
            styles.disc,
            { backgroundColor: discColor },
            state === 'ready' && { borderWidth: 1.5, borderColor: t.accent },
          ]}
        />
      )}

      {state === 'resolving' && !reduced && (
        <Animated.View
          style={[
            styles.ring,
            {
              transform: [
                {
                  rotate: spin.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0deg', '360deg'],
                  }),
                },
              ],
            },
          ]}
        >
          <Svg width={size.ring} height={size.ring} viewBox="0 0 40 40">
            <Circle
              cx={20}
              cy={20}
              r={RING_RADIUS}
              fill="none"
              stroke={t.accent}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray="26 74"
            />
          </Svg>
        </Animated.View>
      )}

      {/* Reduced motion replaces the spinner with a static rest state. */}
      {state === 'resolving' && reduced && (
        <View style={[styles.ring, styles.dots]}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={[styles.dot, { backgroundColor: t.accent }]} />
          ))}
        </View>
      )}

      {state === 'working' && (
        <View style={styles.ring}>
          <Svg width={size.ring} height={size.ring} viewBox="0 0 40 40">
            <Circle
              cx={20}
              cy={20}
              r={RING_RADIUS}
              fill="none"
              stroke={t.ringTrack}
              strokeWidth={2.5}
            />
            {/* 12 o'clock origin, clockwise. */}
            <AnimatedCircle
              cx={20}
              cy={20}
              r={RING_RADIUS}
              fill="none"
              stroke={t.accent}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={ring}
              transform="rotate(-90 20 20)"
            />
          </Svg>
        </View>
      )}

      <Animated.View
        style={{
          opacity: state === 'failed' && !reduced ? breath : 1,
          transform: [
            {
              scale:
                state === 'ready' && !reduced
                  ? pulse.interpolate({
                      inputRange: [0, 0.18, 0.36, 0.72, 1],
                      outputRange: [1, 1.09, 1, 1, 1],
                    })
                  : 1,
            },
          ],
        }}
      >
        <MaterialIcons name={ICON[state]} size={ICON_SIZE[state]} color={iconColor} />
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hit: {
    width: size.target,
    height: size.target,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  disc: {
    position: 'absolute',
    width: size.ring,
    height: size.ring,
    borderRadius: size.ring / 2,
  },
  ring: { position: 'absolute', width: size.ring, height: size.ring },
  dots: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  dot: { width: 3, height: 3, borderRadius: 1.5 },
});
