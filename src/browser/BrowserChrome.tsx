import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { size, space } from '../ui/theme';
import { DownloadButton, type DownloadState } from './DownloadButton';
import { Pill, type PillContent } from './Pill';

type Props = {
  pill: PillContent;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 0..1 for a determinate line, null when the page is idle. */
  loadProgress: number | null;
  downloadState: DownloadState;
  downloadProgress: number;
  onBack: () => void;
  onForward: () => void;
  onHome: () => void;
  onDownload: () => void;
  onPillPress?: () => void;
};

/**
 * The app's entire UI surface while browsing.
 *
 * Everything lives below the page — no floating bubbles, no overlays. The 2dp
 * load line rides the top edge of the bar: the only pixel the app draws that
 * touches the page boundary, and it touches it from below.
 */
export function BrowserChrome({
  pill,
  canGoBack,
  canGoForward,
  loadProgress,
  downloadState,
  downloadProgress,
  onBack,
  onForward,
  onHome,
  onDownload,
  onPillPress,
}: Props) {
  const { t } = useTheme();

  return (
    <View
      style={[styles.bar, { backgroundColor: t.chrome, borderTopColor: t.border }]}
    >
      {loadProgress !== null && <LoadLine progress={loadProgress} />}

      <NavButton icon="arrow-back" label="Back" enabled={canGoBack} onPress={onBack} />
      <NavButton
        icon="arrow-forward"
        label="Forward"
        enabled={canGoForward}
        onPress={onForward}
      />
      <NavButton icon="home" label="Home" enabled onPress={onHome} />

      <Pill content={pill} onPress={onPillPress} />

      <DownloadButton
        state={downloadState}
        progress={downloadProgress}
        onPress={onDownload}
      />
    </View>
  );
}

function LoadLine({ progress }: { progress: number }) {
  const { t, reduced } = useTheme();
  const width = useRef(new Animated.Value(progress)).current;

  useEffect(() => {
    Animated.timing(width, {
      toValue: progress,
      duration: reduced ? 0 : 240,
      easing: Easing.linear,
      useNativeDriver: false,
    }).start();
  }, [progress, reduced, width]);

  return (
    <View style={[styles.loadTrack, { backgroundColor: t.border }]}>
      <Animated.View
        style={{
          height: 2,
          backgroundColor: t.accent,
          width: width.interpolate({
            inputRange: [0, 1],
            outputRange: ['0%', '100%'],
          }),
        }}
      />
    </View>
  );
}

function NavButton({
  icon,
  label,
  enabled,
  onPress,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  enabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={enabled ? label : `${label}, unavailable`}
      accessibilityState={{ disabled: !enabled }}
      style={({ pressed }) => [styles.navHit, pressed && enabled && styles.pressed]}
    >
      <MaterialIcons
        name={icon}
        size={22}
        color={enabled ? t.icon : t.iconDisabled}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: size.bar,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.iconToLabel,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  loadTrack: {
    position: 'absolute',
    top: -1,
    left: 0,
    right: 0,
    height: 2,
    overflow: 'hidden',
  },
  navHit: {
    width: size.navButton,
    height: size.target,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.5 },
});
