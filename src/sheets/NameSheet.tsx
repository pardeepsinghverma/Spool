import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, space, type } from '../ui/theme';

/**
 * One short piece of text, typed by the user.
 *
 * The app had no such surface before playlists, because until then nothing in
 * it was named by a person — every title came off a page or a file. It is
 * deliberately the same sheet as `ChoiceSheet` with a field where the options
 * would be, rather than a dialog: naming a playlist is not an occasion either.
 *
 * `Alert.prompt` would have been shorter and is iOS-only, and this app is
 * Android. Writing it as a sheet also keeps the one keyboard-bearing surface
 * inside the design's own chrome.
 */

type Props = {
  title: string;
  /** Prefilled and selected, so a rename starts by replacing what is there. */
  value?: string;
  placeholder?: string;
  /** The affirmative button. "Create" and "Rename" read better than "OK". */
  action: string;
  onSubmit: (name: string) => void;
  onClose: () => void;
};

export function NameSheet({
  title,
  value = '',
  placeholder = 'Playlist name',
  action,
  onSubmit,
  onClose,
}: Props) {
  const { t, reduced } = useTheme();
  const rise = useRef(new Animated.Value(0)).current;
  const [text, setText] = useState(value);

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reduced ? 0 : motion.sheetIn,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start();
  }, [rise, reduced]);

  // A blank name is refused by the store anyway; disabling the button here is
  // what stops the sheet closing on a tap that was never going to do anything.
  const ready = text.trim().length > 0;
  const commit = () => {
    if (!ready) return;
    onSubmit(text.trim());
    onClose();
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose} />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.lift}
        pointerEvents="box-none"
      >
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

          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={fixed.mute}
            autoFocus
            selectTextOnFocus
            maxLength={60}
            returnKeyType="done"
            onSubmitEditing={commit}
            accessibilityLabel={title}
            style={[
              styles.field,
              { backgroundColor: fixed.raised, borderColor: fixed.line, color: t.on },
            ]}
          />

          <View style={styles.actions}>
            <Pressable
              onPress={onClose}
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, pressed && { opacity: 0.6 }]}
            >
              <Text style={[type.chip, { color: t.onDim }]}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={commit}
              disabled={!ready}
              accessibilityRole="button"
              accessibilityState={{ disabled: !ready }}
              style={({ pressed }) => [
                styles.button,
                { backgroundColor: ready ? t.accent : fixed.raised },
                pressed && { opacity: 0.8 },
              ]}
            >
              <Text style={[type.chipActive, { color: ready ? t.onAccent : fixed.mute }]}>
                {action}
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
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
  lift: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheet: {
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
  title: { ...type.rowTitle, paddingHorizontal: space.gutter, marginBottom: space.row },
  field: {
    ...type.body,
    fontSize: 15,
    height: 48,
    marginHorizontal: space.gutter,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderRadius: 12,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.insideChip,
    paddingHorizontal: space.gutter,
    paddingTop: space.row,
  },
  button: {
    height: 36,
    minWidth: 88,
    paddingHorizontal: 16,
    borderRadius: radius.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
