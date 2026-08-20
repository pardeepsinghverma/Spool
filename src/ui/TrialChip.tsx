import { Pressable, StyleSheet, Text } from 'react-native';
import { useTheme } from './ThemeContext';
import { radius, space, type } from './theme';
import { daysLeft, openPreRelease, useTrial } from '../core/trial';

/**
 * The one permanent mark a pre-release build leaves on the interface.
 *
 * It sits in the header of the four local tabs and nowhere else — Browse is
 * someone else's page at full bleed and carries none of our chrome, which is a
 * rule this does not get to break for being important.
 *
 * Mono, because the number of days left is a fact the user can check, and mono
 * is reserved for exactly those. It turns `accent` on the last day: that is the
 * only state change, and it happens once.
 *
 * Tapping it opens the pre-release sheet. A label that only labels would be the
 * one inert control in an app whose design rules forbid them.
 */
export function TrialChip() {
  const { t } = useTheme();
  const status = useTrial();
  if (!status.trial) return null;

  const days = daysLeft(status);
  const last = days <= 1;
  const label = days === 0 ? 'TRIAL ENDED' : `TRIAL · ${days}D`;

  return (
    <Pressable
      onPress={openPreRelease}
      accessibilityRole="button"
      accessibilityLabel={
        days === 0
          ? 'Trial ended. Tap for a full copy.'
          : `Pre-release build, ${days} days left. Tap for details.`
      }
      style={({ pressed }) => [
        styles.chip,
        { backgroundColor: t.tint, borderColor: last ? t.accent : 'transparent' },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.label, { color: last ? t.accent : t.onDim }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    height: 24,
    borderRadius: radius.chip,
    borderWidth: 1,
    paddingHorizontal: space.insideChip + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { ...type.monoStrong, fontSize: 10.5, letterSpacing: 0.4 },
});
