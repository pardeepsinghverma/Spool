import { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { bezier, motion, radius, space, type } from '../ui/theme';

export type SheetMode = 'quick' | 'all' | 'error' | 'empty';

export type FormatRow = {
  id: string;
  res: string;
  note: string;
  codec: string;
  size: string;
  /** Set when the file will not fit; the row dims rather than disappearing. */
  tooLarge?: boolean;
};

export type QuickPick = {
  id: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  detail: string;
  /** "Best" is the only accented row. */
  highlight?: boolean;
};

type Props = {
  mode: SheetMode | null;
  video: { title: string; channel: string; duration: string } | null;
  quickPicks: QuickPick[];
  formats: FormatRow[];
  /** Rendered above the format list when storage is short. */
  storageWarning?: string | null;
  emptyReason?: string;
  onPick: (id: string) => void;
  onExpand: () => void;
  onCollapse: () => void;
  onClose: () => void;
  onUpdateEngine: () => void;
  onRetry: () => void;
};

/**
 * Quality selection and the failures that belong to it.
 *
 * A failure the user didn't cause never earns more than the pill. A failure
 * blocking an action the user just took gets the sheet they already opened —
 * so extraction errors and empty format lists replace the list in place.
 */
export function QualitySheet({
  mode,
  video,
  quickPicks,
  formats,
  storageWarning,
  emptyReason,
  onPick,
  onExpand,
  onCollapse,
  onClose,
  onUpdateEngine,
  onRetry,
}: Props) {
  const { t, reduced } = useTheme();
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, {
      toValue: mode ? 1 : 0,
      duration: reduced ? 0 : mode ? motion.sheetIn : motion.sheetOut,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start();
  }, [mode, reduced, rise]);

  if (!mode) return null;

  const expanded = mode === 'all';

  const animated = {
    opacity: rise,
    transform: [
      { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
    ],
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable
        style={styles.scrim}
        accessibilityLabel="Close"
        onPress={onClose}
      />
      <Animated.View
        style={[
          expanded ? styles.sheetFull : styles.sheetFront,
          { backgroundColor: t.chrome, borderTopColor: t.border },
          animated,
        ]}
      >
        <View style={[styles.grabber, { backgroundColor: t.border }]} />

        {expanded ? (
          <AllFormats
            formats={formats}
            storageWarning={storageWarning}
            onPick={onPick}
            onCollapse={onCollapse}
          />
        ) : mode === 'error' ? (
          <ExtractionFailed onUpdateEngine={onUpdateEngine} onRetry={onRetry} />
        ) : mode === 'empty' ? (
          <NothingHere reason={emptyReason} />
        ) : (
          <QuickPicks
            video={video}
            picks={quickPicks}
            storageWarning={storageWarning}
            onPick={onPick}
            onExpand={onExpand}
          />
        )}
      </Animated.View>
    </Modal>
  );
}

function QuickPicks({
  video,
  picks,
  storageWarning,
  onPick,
  onExpand,
}: {
  video: Props['video'];
  picks: QuickPick[];
  storageWarning?: string | null;
  onPick: (id: string) => void;
  onExpand: () => void;
}) {
  const { t } = useTheme();
  return (
    <>
      {video && (
        <View style={styles.videoRow}>
          <View style={[styles.thumb, { backgroundColor: t.ph }]}>
            <MaterialIcons name="movie" size={18} color={t.phText} />
          </View>
          <View style={styles.videoMeta}>
            <Text numberOfLines={1} style={[styles.videoTitle, { color: t.text }]}>
              {video.title}
            </Text>
            <Text numberOfLines={1} style={[styles.videoSub, { color: t.textDim }]}>
              {video.channel}
              {video.duration ? ` · ${video.duration}` : ''}
            </Text>
          </View>
        </View>
      )}

      <View style={[styles.hair, { backgroundColor: t.border }]} />

      {storageWarning && (
        <Text style={[styles.storage, { color: t.warn }]}>{storageWarning}</Text>
      )}

      {picks.map((p) => (
        <Pressable
          key={p.id}
          onPress={() => onPick(p.id)}
          accessibilityRole="button"
          accessibilityLabel={`${p.title}. ${p.detail}`}
          style={({ pressed }) => [styles.pickRow, pressed && { opacity: 0.6 }]}
        >
          <MaterialIcons
            name={p.icon}
            size={22}
            color={p.highlight ? t.accent : t.icon}
          />
          <View style={styles.pickText}>
            <Text style={[styles.pickTitle, { color: t.text }]}>{p.title}</Text>
            <Text style={[styles.pickDetail, { color: t.textDim }]}>{p.detail}</Text>
          </View>
        </Pressable>
      ))}

      <View style={[styles.hair, { backgroundColor: t.border, marginVertical: 4 }]} />

      <Pressable
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel="Show all formats"
        style={({ pressed }) => [styles.moreRow, pressed && { opacity: 0.6 }]}
      >
        <MaterialIcons name="expand-less" size={22} color={t.textDim} />
        <Text style={[styles.moreText, { color: t.textDim }]}>More…</Text>
      </Pressable>
    </>
  );
}

function AllFormats({
  formats,
  storageWarning,
  onPick,
  onCollapse,
}: {
  formats: FormatRow[];
  storageWarning?: string | null;
  onPick: (id: string) => void;
  onCollapse: () => void;
}) {
  const { t } = useTheme();
  return (
    <>
      <View style={styles.allHeader}>
        <Text style={[styles.allTitle, { color: t.text }]}>All formats</Text>
        <Pressable
          onPress={onCollapse}
          accessibilityRole="button"
          accessibilityLabel="Back to quick picks"
          style={styles.collapseHit}
        >
          <MaterialIcons name="expand-more" size={22} color={t.icon} />
        </Pressable>
      </View>

      <View style={styles.chips}>
        {['Video', 'Audio', 'Video only'].map((label, i) => (
          <View
            key={label}
            style={[
              styles.chip,
              i === 0
                ? { backgroundColor: t.accent }
                : { borderWidth: 1, borderColor: t.border },
            ]}
          >
            <Text
              style={[styles.chipText, { color: i === 0 ? t.onAccent : t.textDim }]}
            >
              {label}
            </Text>
          </View>
        ))}
      </View>

      {storageWarning && (
        <Text style={[styles.storage, { color: t.warn }]}>{storageWarning}</Text>
      )}

      <View style={[styles.tableHead, { borderBottomColor: t.border }]}>
        <Text style={[styles.headCell, { color: t.textDim, flex: 1 }]}>Resolution</Text>
        <Text style={[styles.headCell, { color: t.textDim, width: 66 }]}>Codec</Text>
        <Text
          style={[styles.headCell, { color: t.textDim, width: 56, textAlign: 'right' }]}
        >
          Size
        </Text>
      </View>

      <ScrollView>
        {formats.map((f) => (
          <Pressable
            key={f.id}
            disabled={f.tooLarge}
            onPress={() => onPick(f.id)}
            accessibilityRole="button"
            accessibilityLabel={
              f.tooLarge
                ? `${f.res}, ${f.size}, not enough space`
                : `${f.res}, ${f.note}, ${f.size}`
            }
            style={({ pressed }) => [
              styles.formatRow,
              { borderBottomColor: t.hair },
              // Formats that won't fit dim rather than disappear, so the user
              // sees why the option they wanted is gone.
              f.tooLarge && { opacity: 0.4 },
              pressed && !f.tooLarge && { opacity: 0.6 },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.formatRes, { color: t.text }]}>{f.res}</Text>
              <Text style={[styles.formatNote, { color: t.textDim }]}>{f.note}</Text>
            </View>
            <Text style={[styles.mono, { color: t.textDim, width: 66 }]}>{f.codec}</Text>
            <Text
              style={[styles.mono, { color: t.text, width: 56, textAlign: 'right' }]}
            >
              {f.size}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </>
  );
}

function ExtractionFailed({
  onUpdateEngine,
  onRetry,
}: {
  onUpdateEngine: () => void;
  onRetry: () => void;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.panel}>
      <View style={[styles.card, { backgroundColor: t.pageBg, borderColor: t.border }]}>
        <MaterialIcons name="build" size={22} color={t.warn} />
        <Text style={[styles.cardTitle, { color: t.text }]}>
          YouTube changed something
        </Text>
        <Text style={[styles.cardBody, { color: t.textDim }]}>
          The extraction engine couldn't read this page. An update may already fix it.
        </Text>
        <View style={styles.cardActions}>
          <Pressable
            onPress={onUpdateEngine}
            accessibilityRole="button"
            style={[styles.btnFilled, { backgroundColor: t.accent }]}
          >
            <Text style={[styles.btnText, { color: t.onAccent }]}>Update engine</Text>
          </Pressable>
          <Pressable
            onPress={onRetry}
            accessibilityRole="button"
            style={[styles.btnOutline, { borderColor: t.border }]}
          >
            <Text style={[styles.btnText, { color: t.accent }]}>Try again</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function NothingHere({ reason }: { reason?: string }) {
  const { t } = useTheme();
  return (
    <View style={styles.panel}>
      <View
        style={[
          styles.card,
          { backgroundColor: t.pageBg, borderColor: t.border, alignItems: 'center' },
        ]}
      >
        <MaterialIcons name="block" size={22} color={t.textDim} />
        <Text style={[styles.cardTitle, { color: t.text }]}>
          Nothing downloadable here
        </Text>
        {/* Always names the actual reason instead of a generic empty state. */}
        <Text style={[styles.cardBody, { color: t.textDim, textAlign: 'center' }]}>
          {reason ?? 'This page has no media we can read.'}
        </Text>
      </View>
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
  sheetFront: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 8,
    paddingBottom: 12,
  },
  sheetFull: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 34,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 8,
  },
  grabber: {
    width: 32,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  videoRow: {
    flexDirection: 'row',
    gap: space.barSide,
    paddingHorizontal: space.gutter,
    paddingBottom: 14,
    alignItems: 'center',
  },
  thumb: {
    width: 88,
    height: 50,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  videoMeta: { flex: 1, minWidth: 0 },
  videoTitle: { fontSize: 13.5, lineHeight: 18, fontWeight: '500', marginBottom: 3 },
  videoSub: { fontSize: 11.5 },
  hair: { height: StyleSheet.hairlineWidth },
  storage: {
    fontSize: 12.5,
    paddingHorizontal: space.gutter,
    paddingTop: 10,
  },
  pickRow: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: space.gutter,
  },
  pickText: { flex: 1 },
  pickTitle: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  pickDetail: { fontSize: 12, lineHeight: 16 },
  moreRow: {
    minHeight: space.emptyState + 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: space.gutter,
  },
  moreText: { fontSize: 14 },
  allHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.gutter,
    paddingRight: 8,
    paddingBottom: 10,
  },
  allTitle: { flex: 1, fontSize: type.rowTitle.fontSize, fontWeight: '500' },
  collapseHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  chips: {
    flexDirection: 'row',
    gap: space.insidePill,
    paddingHorizontal: space.gutter,
    paddingBottom: 10,
  },
  chip: { paddingHorizontal: space.barSide, paddingVertical: 7, borderRadius: 16 },
  chipText: { fontSize: 12, fontWeight: '500' },
  tableHead: {
    flexDirection: 'row',
    paddingHorizontal: space.gutter,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headCell: {
    fontSize: 10.5,
    fontWeight: '500',
    letterSpacing: 0.63,
    textTransform: 'uppercase',
  },
  formatRow: {
    minHeight: space.emptyState + 16,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.gutter,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  formatRes: { fontSize: 14, lineHeight: 18, fontWeight: '500' },
  formatNote: { fontSize: 11, lineHeight: 14 },
  mono: { fontSize: 12, fontFamily: 'monospace' },
  panel: { padding: space.gutter },
  card: { borderWidth: 1, borderRadius: 10, padding: space.gutter },
  cardTitle: { fontSize: 14, lineHeight: 19, fontWeight: '500', marginTop: 8 },
  cardBody: { fontSize: 12.5, lineHeight: 19, marginTop: 4 },
  cardActions: { flexDirection: 'row', gap: space.insidePill, marginTop: 14 },
  btnFilled: { paddingHorizontal: space.gutter, paddingVertical: 11, borderRadius: 20 },
  btnOutline: {
    paddingHorizontal: space.gutter,
    paddingVertical: 11,
    borderRadius: 20,
    borderWidth: 1,
  },
  btnText: { fontSize: 13, fontWeight: '500' },
});
