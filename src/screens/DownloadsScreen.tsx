import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { size, space, type } from '../ui/theme';

export type ItemAction = {
  icon: keyof typeof MaterialIcons.glyphMap;
  label: string;
  tone?: 'icon' | 'warn' | 'dim';
  onPress: () => void;
};

export type DownloadItem = {
  id: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  meta: string;
  metaTone: 'accent' | 'dim' | 'warn';
  /** 0..1 renders the bar; null hides it. */
  progress?: number | null;
  actions: [ItemAction, ItemAction];
};

type Props = {
  items: DownloadItem[];
  /** Set when a pattern of failure deserves surfacing. Never shown in the bar. */
  failureBanner?: { title: string; detail: string; onUpdate: () => void } | null;
  onBack: () => void;
};

export function DownloadsScreen({ items, failureBanner, onBack }: Props) {
  const { t } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: t.chrome }]}>
      <View style={[styles.header, { borderBottomColor: t.border }]}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to browser"
          style={styles.headerHit}
        >
          <MaterialIcons name="arrow-back" size={22} color={t.icon} />
        </Pressable>
        <Text style={[styles.title, { color: t.text }]}>Downloads</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="More options"
          style={styles.headerHit}
        >
          <MaterialIcons name="more-vert" size={22} color={t.icon} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ paddingVertical: space.insidePill }}>
        {/* A pattern of failure is a different problem from one failure. It
            surfaces once, here — a place the user chose to visit. */}
        {failureBanner && (
          <View
            style={[styles.banner, { backgroundColor: t.pageBg, borderColor: t.border }]}
          >
            <MaterialIcons name="error-outline" size={20} color={t.warn} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.bannerTitle, { color: t.text }]}>
                {failureBanner.title}
              </Text>
              <Text style={[styles.bannerDetail, { color: t.textDim }]}>
                {failureBanner.detail}
              </Text>
            </View>
            <Pressable onPress={failureBanner.onUpdate} accessibilityRole="button">
              <Text style={[styles.bannerAction, { color: t.accent }]}>Update</Text>
            </Pressable>
          </View>
        )}

        {items.length === 0 && (
          <View style={styles.empty}>
            <MaterialIcons name="file-download" size={22} color={t.textDim} />
            <Text style={[styles.emptyText, { color: t.textDim }]}>
              Nothing downloaded yet.
            </Text>
          </View>
        )}

        {items.map((item) => (
          <Row key={item.id} item={item} />
        ))}
      </ScrollView>
    </View>
  );
}

function Row({ item }: { item: DownloadItem }) {
  const { t } = useTheme();
  const metaColor =
    item.metaTone === 'accent' ? t.accent : item.metaTone === 'warn' ? t.warn : t.textDim;

  return (
    <View style={styles.row}>
      <View style={[styles.thumb, { backgroundColor: t.ph }]}>
        <MaterialIcons name={item.icon} size={16} color={t.phText} />
      </View>

      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: t.text }]}>
          {item.title}
        </Text>
        <Text style={[styles.rowMeta, { color: metaColor }]}>{item.meta}</Text>
        {item.progress != null && (
          <View style={[styles.track, { backgroundColor: t.border }]}>
            <View
              style={{
                height: 3,
                backgroundColor: t.accent,
                width: `${Math.round(item.progress * 100)}%`,
              }}
            />
          </View>
        )}
      </View>

      <View style={styles.actions}>
        {item.actions.map((a, i) => (
          <Pressable
            key={i}
            onPress={a.onPress}
            accessibilityRole="button"
            accessibilityLabel={a.label}
            style={({ pressed }) => [styles.actionHit, pressed && { opacity: 0.5 }]}
          >
            <MaterialIcons
              name={a.icon}
              size={19}
              color={a.tone === 'warn' ? t.warn : a.tone === 'dim' ? t.textDim : t.icon}
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    height: size.bar,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingLeft: space.iconToLabel,
    paddingRight: space.insidePill,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerHit: {
    width: size.target,
    height: size.target,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, fontSize: 18, fontWeight: '500' },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.barSide,
    marginHorizontal: space.gutter,
    marginBottom: space.insidePill,
    padding: 14,
    borderWidth: 1,
    borderRadius: 10,
  },
  bannerTitle: { fontSize: 13, lineHeight: 17, fontWeight: '500' },
  bannerDetail: { fontSize: 11.5, lineHeight: 15 },
  bannerAction: { fontSize: 12.5, fontWeight: '500' },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.barSide,
    paddingHorizontal: space.gutter,
    paddingVertical: space.barSide,
  },
  thumb: {
    width: 76,
    height: 44,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: { flex: 1, minWidth: 0, gap: 5 },
  rowTitle: {
    fontSize: type.itemTitle.fontSize,
    lineHeight: type.itemTitle.lineHeight,
    fontWeight: '500',
  },
  rowMeta: { fontSize: 11.5, lineHeight: 15 },
  track: { height: 3, borderRadius: 2, overflow: 'hidden', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 2 },
  actionHit: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: space.barSide, paddingVertical: 64 },
  emptyText: { fontSize: 13.5 },
});
