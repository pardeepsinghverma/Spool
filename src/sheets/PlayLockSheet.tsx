import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, size, space, type } from '../ui/theme';
import { dismissPlayNotice, takeOver, type Notice } from '../core/playLock';

/**
 * What the account play lock has to say — see `core/playLock`.
 *
 * A sheet rather than the notice strip, because the strip draws only on
 * Browse and this can happen on any tab (and while the app was in the
 * background, in which case it is waiting when the user comes back). Small on
 * purpose: one sentence, one choice.
 *
 * "Play here instead" is offered on both the refusal and the "moved" notice.
 * Spotify offers the same, and people expect to be able to take the music
 * back as easily as it was taken.
 */
export function PlayLockSheet({ notice }: { notice: Notice }) {
  const { t, reduced } = useTheme();
  const rise = useRef(new Animated.Value(0)).current;
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reduced ? 0 : motion.sheetIn,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start();
  }, [rise, reduced]);

  const here = async () => {
    setBusy(true);
    await takeOver();
    setBusy(false);
  };

  const title =
    notice.kind === 'elsewhere'
      ? `Playing on ${notice.device}`
      : notice.kind === 'moved'
        ? `Playback moved to ${notice.device}`
        : 'You are offline';
  const body =
    notice.kind === 'elsewhere'
      ? 'Your account is playing on another device. Play here instead? It will stop there.'
      : notice.kind === 'moved'
        ? 'Your account started playing on another device, so it paused here.'
        : 'Connect to the internet to keep playing on this account.';

  return (
    <Modal transparent visible animationType="none" onRequestClose={dismissPlayNotice}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={dismissPlayNotice} />
      <Animated.View
        style={[
          styles.sheet,
          { backgroundColor: t.deep, borderTopColor: fixed.line },
          {
            opacity: rise,
            transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: fixed.line }]} />
        <Text style={[styles.title, { color: t.on }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[styles.body, { color: t.onDim }]}>{body}</Text>

        {notice.kind !== 'offline' ? (
          <Pressable
            onPress={here}
            disabled={busy}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.primary,
              { backgroundColor: t.accent },
              (pressed || busy) && { opacity: 0.75 },
            ]}
          >
            {busy ? <ActivityIndicator size="small" color={t.onAccent} /> : null}
            <Text style={[styles.primaryLabel, { color: t.onAccent }]}>Play here instead</Text>
          </Pressable>
        ) : null}

        <Pressable
          onPress={dismissPlayNotice}
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.6 }]}
        >
          <Text style={[styles.secondaryLabel, { color: t.onDim }]}>
            {notice.kind === 'elsewhere' ? 'Not now' : 'OK'}
          </Text>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 8,
    paddingBottom: space.section,
  },
  grabber: { width: 32, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: 14 },
  title: { ...type.screenTitle, paddingHorizontal: space.gutter, marginBottom: 6 },
  body: { ...type.body, paddingHorizontal: space.gutter, marginBottom: space.gutter },
  primary: {
    height: size.target,
    marginHorizontal: space.gutter,
    borderRadius: radius.chip,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.insideChip,
  },
  primaryLabel: { ...type.rowTitle, fontSize: 14.5 },
  secondary: { height: size.target, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  secondaryLabel: { ...type.body, fontSize: 13.5 },
});
