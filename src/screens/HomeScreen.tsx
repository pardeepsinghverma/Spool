import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { TrialChip } from '../ui/TrialChip';
import { fixed, radius, size, space, type } from '../ui/theme';

/**
 * Home. See docs/UI.md §02.
 *
 * Recently added, then what you actually replay. The green tick on an On-repeat
 * row is the only place a completed auto-download is ever announced — there is
 * no badge, no counter and no notification anywhere before that point.
 */

export type HomeCard = {
  id: string;
  title: string;
  artist: string;
  kind: 'audio' | 'video';
  /** file:// cover, once it has been resolved. Absent until then. */
  art?: string;
  onPress?: () => void;
};

export type RepeatRow = {
  id: string;
  title: string;
  /** "Ambient Archive · 14 plays" */
  subtitle: string;
  /** saved → green tick, fetching → downloading glyph, none → nothing. */
  state: 'saved' | 'fetching' | 'none';
  /** What the page was, so Music/Video can tell these apart. */
  kind: 'audio' | 'video';
  /** file:// cover, only where this video has a saved download behind it. */
  art?: string;
  onPress?: () => void;
  onMore?: () => void;
};

type Chip = 'All' | 'Music' | 'Video' | 'Offline';

const CHIPS: Chip[] = ['All', 'Music', 'Video', 'Offline'];

type Props = {
  recent: HomeCard[];
  repeat: RepeatRow[];
};

export function HomeScreen({ recent, repeat }: Props) {
  const { t } = useTheme();
  const [chip, setChip] = useState<Chip>('All');

  /**
   * These chips used to highlight and filter nothing — the one thing this
   * design keeps refusing to ship. *Offline* means "already on the device",
   * which for the cards is all of them (a card only exists once a file does)
   * and for On repeat is the subset the rule or the user has actually kept.
   */
  const cards = useMemo(
    () =>
      chip === 'Music'
        ? recent.filter((c) => c.kind === 'audio')
        : chip === 'Video'
          ? recent.filter((c) => c.kind === 'video')
          : recent,
    [recent, chip],
  );

  const rows = useMemo(() => {
    if (chip === 'Music') return repeat.filter((r) => r.kind === 'audio');
    if (chip === 'Video') return repeat.filter((r) => r.kind === 'video');
    if (chip === 'Offline') return repeat.filter((r) => r.state === 'saved');
    return repeat;
  }, [repeat, chip]);

  return (
    <View style={[styles.root, { backgroundColor: t.deep }]}>
      <View style={styles.header}>
        <View style={[styles.mark, { backgroundColor: t.tint }]}>
          <View style={[styles.markRing, { borderColor: t.accent }]} />
          <View style={[styles.markBar, { backgroundColor: t.accent }]} />
        </View>
        <Text style={[styles.wordmark, { color: t.on }]}>Spool</Text>
        <TrialChip />
        {/* The mock has a cast button here. There is nothing to cast to, and the
            player already drops it for that reason — leaving it on Home made the
            app claim a capability in one place and deny it in another. */}
        <View style={[styles.avatar, { backgroundColor: t.tint }]}>
          <Text style={[styles.avatarText, { color: t.on }]}>A</Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: space.section }}>
        <View style={styles.chips}>
          {CHIPS.map((label) => {
            const active = label === chip;
            return (
              <Pressable
                key={label}
                onPress={() => setChip(label)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.chip,
                  { backgroundColor: active ? t.accent : t.tint },
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Text
                  style={[
                    active ? type.chipActive : type.chip,
                    { color: active ? t.onAccent : t.onDim },
                  ]}
                >
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={[styles.sectionTitle, { color: t.on }]}>Recently added</Text>
        {cards.length === 0 ? (
          <Text style={[styles.empty, { color: fixed.mute }]}>
            {recent.length === 0
              ? 'Nothing here yet — play something twice and it starts filling in.'
              : `Nothing saved as ${chip.toLowerCase()}.`}
          </Text>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.cards}
          >
            {cards.map((card) => (
              <Pressable
                key={card.id}
                onPress={card.onPress}
                accessibilityRole="button"
                accessibilityLabel={card.title}
                style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
              >
                <View style={[styles.cover, { backgroundColor: t.tint }]}>
                  {card.art ? (
                    <Image source={{ uri: card.art }} style={styles.coverImage} />
                  ) : (
                    <MaterialIcons
                      name={card.kind === 'audio' ? 'music-note' : 'movie'}
                      size={22}
                      color={t.onDim}
                    />
                  )}
                </View>
                <Text numberOfLines={2} style={[styles.cardTitle, { color: t.on }]}>
                  {card.title}
                </Text>
                <Text numberOfLines={1} style={[styles.cardArtist, { color: t.onDim }]}>
                  {card.artist}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        )}

        <View style={styles.repeatHead}>
          <Text style={[styles.sectionTitle, { marginBottom: 0, color: t.on }]}>
            On repeat
          </Text>
          <Text style={[styles.savedFor, { color: t.onDim }]}>saved for you</Text>
        </View>

        <View style={styles.list}>
          {rows.map((row) => (
            <Pressable
              key={row.id}
              onPress={row.onPress}
              accessibilityRole="button"
              accessibilityLabel={row.title}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
            >
              <View style={[styles.rowArt, { backgroundColor: t.tint }]}>
                {row.art ? (
                  <Image source={{ uri: row.art }} style={styles.rowArtImage} />
                ) : (
                  <MaterialIcons
                    name={row.kind === 'audio' ? 'music-note' : 'movie'}
                    size={16}
                    color={t.onDim}
                  />
                )}
              </View>
              <View style={styles.rowBody}>
                <Text numberOfLines={1} style={[styles.rowTitle, { color: t.on }]}>
                  {row.title}
                </Text>
                <Text numberOfLines={1} style={[styles.rowSub, { color: t.onDim }]}>
                  {row.subtitle}
                </Text>
              </View>

              {/* The one announcement the auto-save rule ever makes. */}
              {row.state === 'saved' && (
                <MaterialIcons name="check-circle" size={17} color={fixed.saved} />
              )}
              {row.state === 'fetching' && (
                <MaterialIcons name="downloading" size={17} color={t.onDim} />
              )}

              <Pressable
                onPress={row.onMore}
                disabled={!row.onMore}
                accessibilityRole="button"
                accessibilityLabel="More options"
                style={({ pressed }) => [styles.moreHit, pressed && { opacity: 0.5 }]}
              >
                <MaterialIcons name="more-vert" size={19} color={t.onDim} />
              </Pressable>
            </Pressable>
          ))}

          {rows.length === 0 && (
            // Already inside the gutter-padded list, so this one does not add
            // its own or it sits a gutter further in than everything above it.
            <Text style={[styles.empty, styles.emptyInList, { color: fixed.mute }]}>
              {repeat.length === 0
                ? 'Nothing on repeat yet.'
                : chip === 'Offline'
                  ? 'Nothing on repeat has been saved yet.'
                  : `Nothing on repeat is ${chip.toLowerCase()}.`}
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: space.gutter,
    paddingTop: space.insideChip,
    paddingBottom: 14,
  },
  mark: {
    width: 26,
    height: 26,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2.5,
  },
  markRing: { width: 11, height: 11, borderRadius: 6, borderWidth: 2.5 },
  markBar: { width: 15, height: 2.5, borderRadius: 2 },
  wordmark: { ...type.screenTitle, flex: 1, fontSize: 19, letterSpacing: -0.4 },
  avatar: { width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...type.chipActive, fontSize: 11 },
  chips: {
    flexDirection: 'row',
    gap: space.insideChip,
    paddingHorizontal: space.gutter,
    paddingBottom: space.gutter,
  },
  chip: {
    height: 32,
    borderRadius: radius.chip,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sectionTitle: {
    ...type.rowTitle,
    paddingHorizontal: space.gutter,
    marginBottom: space.row,
  },
  cards: { gap: space.row, paddingHorizontal: space.gutter, paddingBottom: 22 },
  card: { width: size.cardArt },
  cover: {
    width: size.cardArt,
    height: size.cardArt,
    borderRadius: radius.art,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  // YouTube thumbnails are 16:9 and these wells are square, so the cover is
  // cropped to fill rather than letterboxed. Bars inside the artwork would
  // undo the one thing this screen is built around.
  coverImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  cardTitle: { ...type.rowTitle, fontSize: 12.5, lineHeight: 17, marginTop: 9, marginBottom: 2 },
  cardArtist: { ...type.body, fontSize: 11, lineHeight: 14 },
  repeatHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingRight: space.gutter,
    marginBottom: space.row,
  },
  savedFor: { ...type.mono, fontSize: 10.5 },
  list: { gap: 14, paddingHorizontal: space.gutter },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.row },
  rowArt: {
    width: size.rowArt,
    height: size.rowArt,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  rowArtImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { ...type.rowTitle, fontSize: 13.5, lineHeight: 18 },
  rowSub: { ...type.body, fontSize: 11.5, lineHeight: 15 },
  moreHit: { width: 30, height: 40, alignItems: 'center', justifyContent: 'center' },
  empty: { ...type.body, paddingHorizontal: space.gutter, paddingVertical: space.section },
  emptyInList: { paddingHorizontal: 0 },
});
