import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { fixed, size, type } from '../ui/theme';

/**
 * The five tabs. See docs/UI.md §02.
 *
 * Local first on the left, the open web in the middle, everything you own on
 * the right. Switching is instant by design — a tab that animates feels slower
 * than one that does not, and there is nothing to explain between two lists.
 */

export type Tab = 'home' | 'search' | 'browse' | 'library' | 'profile';

const TABS: { key: Tab; label: string; icon: keyof typeof MaterialIcons.glyphMap }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'search', label: 'Search', icon: 'search' },
  { key: 'browse', label: 'Browse', icon: 'explore' },
  { key: 'library', label: 'Library', icon: 'library-music' },
  { key: 'profile', label: 'Profile', icon: 'person' },
];

export function TabBar({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (tab: Tab) => void;
}) {
  const { t } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: t.deep, borderTopColor: fixed.line }]}>
      {TABS.map(({ key, label, icon }) => {
        const active = key === value;
        return (
          <Pressable
            key={key}
            onPress={() => onChange(key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={label}
            style={({ pressed }) => [styles.tab, pressed && { opacity: 0.6 }]}
          >
            <MaterialIcons
              name={icon}
              size={21}
              color={active ? t.accent : fixed.mute}
            />
            <Text
              style={[
                active ? type.tabActive : type.tab,
                { color: active ? t.accent : fixed.mute },
              ]}
            >
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    height: size.tabBar,
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    height: size.tabBar,
  },
});
