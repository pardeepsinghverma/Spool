import { useEffect, useRef } from 'react';
import { Animated, Easing, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, space, type } from '../ui/theme';

/**
 * One question, a short list of answers, a tick on the current one.
 *
 * Settings rows on Profile carry a chevron, which promises somewhere to go. Two
 * of them — audio and video quality — had nowhere, and one of those decides what
 * every automatic save and every one-tap download actually fetches. This is that
 * somewhere: deliberately the plainest sheet in the app, because choosing a
 * bitrate is not an occasion.
 */

export type Choice = {
  key: string;
  label: string;
  /** The consequence, not a restatement of the label. */
  detail?: string;
};

type Props = {
  title: string;
  /** Shown under the title when the choice has a cost worth naming. */
  note?: string;
  options: Choice[];
  value: string;
  onPick: (key: string) => void;
  onClose: () => void;
};

export function ChoiceSheet({ title, note, options, value, onPick, onClose }: Props) {
  const { t, reduced } = useTheme();
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reduced ? 0 : motion.sheetIn,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start();
  }, [rise, reduced]);

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
              {
                translateY: rise.interpolate({
                  inputRange: [0, 1],
                  outputRange: [14, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: fixed.line }]} />
        <Text style={[styles.title, { color: t.on }]}>{title}</Text>
        {note && <Text style={[styles.note, { color: t.onDim }]}>{note}</Text>}

        {options.map((option) => {
          const active = option.key === value;
          return (
            <Pressable
              key={option.key}
              onPress={() => {
                onPick(option.key);
                onClose();
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              accessibilityLabel={option.label}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
              <View style={styles.rowBody}>
                <Text style={[styles.label, { color: t.on }]}>{option.label}</Text>
                {option.detail && (
                  <Text style={[styles.detail, { color: t.onDim }]}>{option.detail}</Text>
                )}
              </View>
              {/* Only the chosen row is marked. An empty circle on every other
                  one turns a short list into a form. */}
              {active && <MaterialIcons name="check" size={20} color={t.accent} />}
            </Pressable>
          );
        })}
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
  grabber: {
    width: 32,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  title: { ...type.rowTitle, paddingHorizontal: space.gutter, marginBottom: 4 },
  note: {
    ...type.body,
    fontSize: 12.5,
    lineHeight: 18,
    paddingHorizontal: space.gutter,
    marginBottom: 6,
  },
  row: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.row,
    paddingHorizontal: space.gutter,
  },
  rowBody: { flex: 1, minWidth: 0 },
  label: { ...type.body, fontSize: 14.5, lineHeight: 19 },
  detail: { ...type.mono, marginTop: 2 },
});
