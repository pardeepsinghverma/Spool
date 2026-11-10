import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { fixed, size, type } from '../ui/theme';

/**
 * The two screens: Browse (YouTube / YouTube Music) and Account.
 * Switching is instant by design.
 */

export type Tab = 'browse' | 'account' | 'profile';

const TABS: { key: 'browse' | 'account'; label: string; icon: keyof typeof MaterialIcons.glyphMap }[] = [
  { key: 'browse', label: 'Browse', icon: 'explore' },
  { key: 'account', label: 'Account', icon: 'person' },
];

export function TabBar({
  value,
  onChange,
}: {
  value: Tab;
  onChange: (tab: Tab) => void;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: t.deep,
          borderTopColor: fixed.line,
          paddingBottom: insets.bottom,
          height: size.tabBar + insets.bottom,
        },
      ]}
    >
      {TABS.map(({ key, label, icon }) => {
        const active = key === value || (key === 'account' && value === 'profile');
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
              size={22}
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
