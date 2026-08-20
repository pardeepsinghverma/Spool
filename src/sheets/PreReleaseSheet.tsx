import { useEffect, useRef } from 'react';
import { Animated, Easing, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, size, space, type } from '../ui/theme';
import {
  CONTACT_EMAIL,
  LAUNCH_PRICE,
  TRIAL_PRICE,
  daysLeft,
  savesLeft,
  useTrial,
} from '../core/trial';

/**
 * What a tester sees on every cold launch.
 *
 * It is a nag, and it is meant to be — the build expires, and someone who never
 * reads why will read "it stopped working" instead. It shows once per launch
 * rather than once ever, and never on a tab change.
 *
 * The prices are stated the way they are actually true. `LAUNCH_PRICE` is what
 * the developer expects to charge, not a price anyone has been charged, so it
 * is labelled as expected rather than struck through — a crossed-out number
 * nobody ever paid is exactly the kind of invented fact the rest of this design
 * refuses to print.
 */
export function PreReleaseSheet({ onClose }: { onClose: () => void }) {
  const { t, reduced } = useTheme();
  const status = useTrial();
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reduced ? 0 : motion.sheetIn,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start();
  }, [rise, reduced]);

  const days = daysLeft(status);
  const over = status.expired || days === 0;
  const minutes = Math.round(status.maxSeconds / 60);

  const write = () => {
    const subject = encodeURIComponent('Spool — full copy');
    const body = encodeURIComponent(
      `Hi,\n\nI have been testing the Spool pre-release and would like the full version ` +
        `for a year at ${TRIAL_PRICE}.\n\n`,
    );
    void Linking.openURL(`mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`).catch(
      () => {},
    );
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose} />
      <Animated.View
        style={[
          styles.sheet,
          { backgroundColor: t.deep, borderTopColor: fixed.line },
          {
            opacity: rise,
            transform: [
              { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
            ],
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: fixed.line }]} />

        <Text style={[styles.eyebrow, { color: t.accent }]}>Pre-release</Text>
        <Text style={[styles.title, { color: t.on }]}>
          {over ? 'This build has expired' : 'Spool is nearly ready'}
        </Text>
        <Text style={[styles.body, { color: t.onDim }]}>
          {over
            ? 'Testing is over for this copy. Everything you saved is still on your device — Spool just will not download anything more.'
            : 'This is a test build, shared before release so it can be broken in private. The full version is coming very soon.'}
        </Text>

        {/* The limits, in mono, because every one of them is a number the user
            can check against what just happened to them. */}
        <View style={[styles.facts, { backgroundColor: t.tint }]}>
          <Fact
            label="Time left"
            value={over ? 'None' : `${days} ${days === 1 ? 'day' : 'days'}`}
            tone={over ? t.accent : t.on}
            dim={t.onDim}
          />
          <Fact
            label="Saves left"
            value={`${savesLeft(status)} of ${status.maxDownloads}`}
            tone={t.on}
            dim={t.onDim}
          />
          <Fact
            label="Longest video"
            value={`${minutes} min`}
            tone={t.on}
            dim={t.onDim}
          />
        </View>

        <Text style={[styles.offerLead, { color: t.on }]}>
          A full year for {TRIAL_PRICE}
        </Text>
        <Text style={[styles.body, { color: t.onDim }]}>
          For people testing this build. The price at launch is expected to be {LAUNCH_PRICE} a
          year — write now and you keep {TRIAL_PRICE}.
        </Text>

        <Pressable
          onPress={write}
          accessibilityRole="button"
          accessibilityLabel={`Email the developer at ${CONTACT_EMAIL}`}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: t.accent },
            pressed && { opacity: 0.75 },
          ]}
        >
          <MaterialIcons name="mail-outline" size={18} color={t.onAccent} />
          <Text style={[styles.primaryLabel, { color: t.onAccent }]}>Contact the developer</Text>
        </Pressable>
        <Text style={[styles.address, { color: t.onDim }]}>{CONTACT_EMAIL}</Text>

        <Pressable
          onPress={onClose}
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.6 }]}
        >
          <Text style={[styles.secondaryLabel, { color: t.onDim }]}>
            {over ? 'Close' : 'Keep testing'}
          </Text>
        </Pressable>
      </Animated.View>
    </Modal>
  );
}

function Fact({
  label,
  value,
  tone,
  dim,
}: {
  label: string;
  value: string;
  tone: string;
  dim: string;
}) {
  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: dim }]}>{label}</Text>
      <Text style={[styles.factValue, { color: tone }]}>{value}</Text>
    </View>
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
  grabber: {
    width: 32,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  eyebrow: { ...type.section, paddingHorizontal: space.gutter, marginBottom: 6 },
  title: { ...type.screenTitle, paddingHorizontal: space.gutter, marginBottom: 6 },
  body: {
    ...type.body,
    paddingHorizontal: space.gutter,
    marginBottom: space.gutter,
  },
  facts: {
    flexDirection: 'row',
    marginHorizontal: space.gutter,
    marginBottom: space.section,
    paddingVertical: space.row,
    borderRadius: radius.art,
  },
  fact: { flex: 1, alignItems: 'center', gap: 3 },
  factLabel: { ...type.section, fontSize: 9.5, letterSpacing: 0.6 },
  factValue: { ...type.monoStrong, fontSize: 13 },
  offerLead: {
    ...type.rowTitle,
    fontSize: 16,
    paddingHorizontal: space.gutter,
    marginBottom: 4,
  },
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
  address: {
    ...type.mono,
    textAlign: 'center',
    marginTop: space.insideChip,
  },
  secondary: {
    height: size.target,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  secondaryLabel: { ...type.body, fontSize: 13.5 },
});
