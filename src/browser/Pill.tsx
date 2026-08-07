import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import type { Palette } from '../ui/theme';
import { bezier, motion, radius, size, space, type } from '../ui/theme';
import type { DownloadState } from './DownloadButton';

export type PillContent = {
  text: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  bg: string;
  color: string;
  iconColor: string;
  /** Trailing affordance, e.g. "Retry". */
  action?: string;
  actionColor?: string;
};

/**
 * The pill is the app's only sentence. Three modes ranked by
 * right-of-interruption: status outranks host, error outranks status. Status
 * and error are temporary tenants — the pill always returns to the host readout.
 */
export function pillFor(
  state: DownloadState,
  t: Palette,
  reduced: boolean,
  opts: {
    host: string;
    percent: number;
    quality?: string;
    error?: string;
    /** True while the preview engine is driving; nothing is really saved. */
    preview?: boolean;
  },
): PillContent {
  switch (state) {
    case 'resolving':
      return {
        text: 'Finding formats…',
        icon: 'file-download',
        bg: t.accentSurface,
        color: t.text,
        iconColor: t.accent,
      };
    case 'working':
      return {
        text: `Downloading ${opts.quality ?? ''} · ${opts.percent}%`.replace('  ', ' '),
        icon: 'file-download',
        bg: t.accentSurface,
        color: t.text,
        iconColor: t.accent,
      };
    case 'done':
      // The design's copy is "Saved to Downloads", which is a filesystem claim.
      // Until a real engine writes a real file, saying it would be a lie.
      return opts.preview
        ? {
            text: 'Simulated — no file saved',
            icon: 'science',
            bg: t.warnSurface,
            color: t.text,
            iconColor: t.warn,
          }
        : {
            text: 'Saved to Downloads',
            icon: 'check',
            bg: t.successSurface,
            color: t.text,
            iconColor: t.success,
          };
    case 'failed':
      return {
        text: opts.error ?? "Couldn't reach YouTube",
        icon: 'error-outline',
        bg: t.warnSurface,
        color: t.text,
        iconColor: t.warn,
        action: 'Retry',
        actionColor: t.warn,
      };
    case 'ready':
      // Under reduced motion the pill repays the salience the pulse can't carry.
      if (reduced) {
        return {
          text: 'Video ready to download',
          icon: 'file-download',
          bg: t.accentSurface,
          color: t.text,
          iconColor: t.accent,
        };
      }
      return hostPill(opts.host, t);
    default:
      return hostPill(opts.host, t);
  }
}

const hostPill = (host: string, t: Palette): PillContent => ({
  text: host,
  icon: 'lock',
  bg: t.surface,
  color: t.textDim,
  iconColor: t.textDim,
});

export function Pill({
  content,
  onPress,
}: {
  content: PillContent;
  onPress?: () => void;
}) {
  const fade = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    fade.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: motion.pillSwap,
      easing: Easing.bezier(...bezier.decelerate),
      useNativeDriver: true,
    }).start();
  }, [content.text, fade]);

  const Wrapper = onPress ? Pressable : View;

  return (
    <Wrapper
      onPress={onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={content.text}
      style={[styles.pill, { backgroundColor: content.bg }]}
    >
      <MaterialIcons name={content.icon} size={15} color={content.iconColor} />
      <Animated.Text
        numberOfLines={1}
        style={[styles.text, { color: content.color, opacity: fade, flex: 1 }]}
      >
        {content.text}
      </Animated.Text>
      {content.action && (
        <Text style={[styles.action, { color: content.actionColor }]}>
          {content.action}
        </Text>
      )}
    </Wrapper>
  );
}

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    minWidth: 0,
    height: size.pillHeight,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: space.barSide,
    marginHorizontal: space.iconToLabel,
  },
  text: { fontSize: type.pill.fontSize },
  action: { fontSize: 12.5, fontWeight: '500' },
});
