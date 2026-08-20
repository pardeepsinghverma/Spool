import { useMemo, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import Svg, { Circle } from 'react-native-svg';
import { useTheme } from '../ui/ThemeContext';
import { TrialChip } from '../ui/TrialChip';
import {
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  fixed,
  radius,
  size,
  space,
  type,
} from '../ui/theme';

/**
 * Library. See docs/UI.md §02.
 *
 * In-progress on top, everything owned below. "Saved automatically" versus
 * "You saved this" is the only trace the auto-save rule leaves anywhere in the
 * app — so the wording is load-bearing, not decoration.
 */

export type LibraryItem = {
  id: string;
  kind: 'audio' | 'video';
  title: string;
  /** "Ambient Archive · 12 plays" */
  subtitle: string;
  /** Who made it, where that is known. What "Artist A–Z" sorts on. */
  artist?: string;
  /** Right-aligned mono size, e.g. "84 MB". */
  size?: string;
  /** The same figure unformatted, so "largest first" can sort on it. */
  bytes?: number;
  /** file:// cover, once resolved. */
  art?: string;
  /** Set while fetching: 0..1 draws the ring, null shows the queued glyph. */
  progress?: number | null;
  /** Queued but held — shows why rather than a spinner. */
  queuedReason?: string;
  failed?: boolean;
  onPress?: () => void;
  onMore?: () => void;
};

/**
 * A playlist as the section draws it. The count is worked out against the
 * library rather than stored, so a list naming three tracks always has three
 * tracks that will actually play.
 */
export type PlaylistRow = {
  id: string;
  name: string;
  /** "12 tracks", or "Empty". */
  detail: string;
  onPress: () => void;
  onMore: () => void;
};

/**
 * The one playlist being looked at, which replaces the library body rather than
 * opening over it — this is a place in the Library tab, not a modal, so the
 * back gesture and the tab bar keep meaning what they meant.
 */
export type OpenPlaylist = {
  id: string;
  name: string;
  detail: string;
  items: LibraryItem[];
  onBack: () => void;
  /** Absent, not disabled, while there is nothing in it to play. */
  onPlay?: () => void;
  onMore: () => void;
};

type Filter = 'all' | 'audio' | 'video' | 'downloading';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'audio', label: 'Music' },
  { key: 'video', label: 'Video' },
  { key: 'downloading', label: 'Downloading' },
];

/**
 * Newest first is the default because the last thing saved is the thing most
 * likely to be wanted. The other two answer questions the first cannot: "what
 * is eating my storage" and "where is that one track".
 */
type Sort = 'newest' | 'largest' | 'title' | 'artist';

const SORTS: { key: Sort; label: string }[] = [
  { key: 'newest', label: 'Newest first' },
  { key: 'largest', label: 'Largest first' },
  { key: 'title', label: 'Title A–Z' },
  // Grouping, done as a sort. An artist's tracks end up together, which is the
  // part of "group by artist" a person is actually asking for, without a
  // second kind of row and a second empty state to go with it.
  { key: 'artist', label: 'Artist A–Z' },
];

type Props = {
  items: LibraryItem[];
  /** Items currently fetching or queued. */
  downloading: LibraryItem[];
  /** "34 items · 4.2 GB" */
  summary: string;
  /** Said once, at the top, when automatic saves have stopped. */
  notice?: string | null;
  /**
   * Cancel, not pause. yt-dlp cannot resume a half-finished job, so offering
   * "pause" would promise something the engine will not honour.
   */
  onCancelAll?: () => void;
  /** The header magnifier. There is a whole tab for this; it just goes there. */
  onSearch?: () => void;
  /** Newest first, as the store keeps them. */
  playlists?: PlaylistRow[];
  onNewPlaylist?: () => void;
  /** Set while the user is inside one, which takes over the body. */
  open?: OpenPlaylist | null;
};

export function LibraryScreen({
  items,
  downloading,
  summary,
  notice,
  onCancelAll,
  onSearch,
  playlists = [],
  onNewPlaylist,
  open = null,
}: Props) {
  const { t } = useTheme();
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('newest');

  /**
   * A failed download is not on the device, so it cannot sit under a heading
   * that counts what is. It gets its own group, above the things that worked.
   */
  const { shown, failed } = useMemo(() => {
    if (filter === 'downloading') return { shown: [], failed: [] };
    const scoped = filter === 'all' ? items : items.filter((i) => i.kind === filter);
    // `items` arrives newest first, so that order is the one to leave alone.
    const ordered =
      sort === 'newest'
        ? scoped
        : [...scoped].sort((a, b) => {
            if (sort === 'title') return a.title.localeCompare(b.title);
            if (sort === 'largest') return (b.bytes ?? 0) - (a.bytes ?? 0);
            // Anything with no artist sinks rather than sorting under the empty
            // string, where it would sit above every named row and read as a
            // broken sort. Title breaks the tie, so one artist's rows come out
            // in a stable order instead of whatever the library happened to be.
            const left = a.artist ?? '';
            const right = b.artist ?? '';
            if (!left !== !right) return left ? -1 : 1;
            return left.localeCompare(right) || a.title.localeCompare(b.title);
          });
    return {
      shown: ordered.filter((i) => !i.failed),
      failed: ordered.filter((i) => i.failed),
    };
  }, [items, filter, sort]);

  /** Cycles rather than opening a menu: three options do not earn a sheet. */
  const nextSort = () => {
    const at = SORTS.findIndex((s) => s.key === sort);
    setSort(SORTS[(at + 1) % SORTS.length].key);
  };

  const showDownloading = filter === 'all' || filter === 'downloading';

  /**
   * Inside a playlist the library's own controls are all wrong — the sort
   * cycler would offer to reorder the one list in the app the user arranged by
   * hand, and the filters would hide tracks they put there on purpose. So this
   * is a different screen rather than the same one with a filter applied.
   */
  if (open) {
    return (
      <View style={[styles.root, { backgroundColor: t.deep }]}>
        <View style={styles.header}>
          <Pressable
            onPress={open.onBack}
            accessibilityRole="button"
            accessibilityLabel="Back to Library"
            style={({ pressed }) => [styles.backHit, pressed && { opacity: 0.5 }]}
          >
            <MaterialIcons name="chevron-left" size={26} color={t.on} />
          </Pressable>
          <Text numberOfLines={1} style={[styles.screenTitle, { color: t.on }]}>
            {open.name}
          </Text>
          <Pressable
            onPress={open.onMore}
            accessibilityRole="button"
            accessibilityLabel="Playlist options"
            style={({ pressed }) => [styles.headerHit, pressed && { opacity: 0.5 }]}
          >
            <MaterialIcons name="more-vert" size={21} color={t.onDim} />
          </Pressable>
        </View>

        <View style={styles.playlistBar}>
          <Text style={[styles.mono, { color: fixed.mute }]}>{open.detail}</Text>
          {/* Absent while the list is empty rather than present and inert. */}
          {open.onPlay && (
            <Pressable
              onPress={open.onPlay}
              accessibilityRole="button"
              accessibilityLabel={`Play ${open.name}`}
              style={({ pressed }) => [
                styles.playButton,
                { backgroundColor: t.accent },
                pressed && { opacity: 0.8 },
              ]}
            >
              <MaterialIcons name="play-arrow" size={18} color={t.onAccent} />
              <Text style={[type.chipActive, { color: t.onAccent }]}>Play</Text>
            </Pressable>
          )}
        </View>

        <ScrollView contentContainerStyle={{ paddingBottom: space.section }}>
          {open.items.length > 0 ? (
            <View style={styles.list}>
              {open.items.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </View>
          ) : (
            <View style={styles.empty}>
              <MaterialIcons name="queue-music" size={22} color={fixed.mute} />
              <Text style={[styles.emptyText, { color: fixed.mute }]}>
                Nothing in here yet.
              </Text>
              {/* The one place that says how, because the action lives on a
                  different screen and a glyph cannot explain itself. */}
              <Text style={[styles.emptyHint, { color: fixed.mute }]}>
                Add tracks from the ⋮ menu on any saved row.
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: t.deep }]}>
      <View style={styles.header}>
        <Text style={[styles.screenTitle, { color: t.on }]}>Library</Text>
        <TrialChip />
        <Pressable
          onPress={nextSort}
          accessibilityRole="button"
          accessibilityLabel={`Sort: ${SORTS.find((s) => s.key === sort)?.label}`}
          style={({ pressed }) => [styles.headerHit, pressed && { opacity: 0.5 }]}
        >
          <MaterialIcons
            name="swap-vert"
            size={21}
            color={sort === 'newest' ? t.onDim : t.accent}
          />
        </Pressable>
        <Pressable
          onPress={onSearch}
          disabled={!onSearch}
          accessibilityRole="button"
          accessibilityLabel="Search your library"
          style={({ pressed }) => [styles.headerHit, pressed && { opacity: 0.5 }]}
        >
          <MaterialIcons name="search" size={21} color={t.onDim} />
        </Pressable>
      </View>

      {/* Only while it is not the default. A permanent label would be chrome;
          this is the receipt for a tap that otherwise just reorders a list. */}
      {sort !== 'newest' && (
        <Text style={[styles.sortNote, { color: t.accent }]}>
          {SORTS.find((s) => s.key === sort)?.label}
        </Text>
      )}

      <ScrollView contentContainerStyle={{ paddingBottom: space.section }}>
        <View style={styles.chips}>
          {FILTERS.map(({ key, label }) => {
            const active = key === filter;
            return (
              <Pressable
                key={key}
                onPress={() => setFilter(key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => [
                  styles.chip,
                  active
                    ? { backgroundColor: t.accent }
                    : { borderWidth: 1, borderColor: fixed.line },
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

        {/* Said once, never repeated — see "When space runs out" in docs/UI.md. */}
        {notice && (
          <View style={[styles.notice, { borderColor: fixed.line }]}>
            <MaterialIcons name="info-outline" size={18} color={fixed.warn} />
            <Text style={[styles.noticeText, { color: t.onDim }]}>{notice}</Text>
          </View>
        )}

        {showDownloading && downloading.length > 0 && (
          <>
            <View style={styles.sectionRow}>
              <Text style={[styles.section, { color: t.onDim }]}>
                Downloading · {downloading.length}
              </Text>
              {onCancelAll && (
                <Pressable onPress={onCancelAll} accessibilityRole="button">
                  <Text style={[styles.action, { color: t.accent }]}>Cancel all</Text>
                </Pressable>
              )}
            </View>
            <View style={styles.list}>
              {downloading.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </View>
          </>
        )}

        {failed.length > 0 && (
          <>
            <Text style={[styles.section, styles.sectionSolo, { color: t.onDim }]}>
              Didn’t finish · {failed.length}
            </Text>
            <View style={styles.list}>
              {failed.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </View>
          </>
        )}

        {/* Only on All. A playlist is not audio or video, and hiding the
            section behind a filter that cannot apply to it would make the
            chips feel like they had lost it. */}
        {filter === 'all' && (playlists.length > 0 || onNewPlaylist) && (
          <>
            <View style={styles.sectionRow}>
              <Text style={[styles.section, { color: t.onDim }]}>
                Playlists{playlists.length ? ` · ${playlists.length}` : ''}
              </Text>
              {onNewPlaylist && (
                <Pressable onPress={onNewPlaylist} accessibilityRole="button">
                  <Text style={[styles.action, { color: t.accent }]}>New</Text>
                </Pressable>
              )}
            </View>
            {playlists.length > 0 && (
              <View style={styles.list}>
                {playlists.map((playlist) => (
                  <PlaylistItem key={playlist.id} playlist={playlist} />
                ))}
              </View>
            )}
          </>
        )}

        {filter !== 'downloading' && (
          <>
            <Text style={[styles.section, styles.sectionSolo, { color: t.onDim }]}>
              On this device · {summary}
            </Text>
            <View style={styles.list}>
              {shown.map((item) => (
                <Row key={item.id} item={item} />
              ))}
            </View>
          </>
        )}

        {shown.length === 0 &&
          failed.length === 0 &&
          !(showDownloading && downloading.length) && (
            <View style={styles.empty}>
              <MaterialIcons name="library-music" size={22} color={fixed.mute} />
              <Text style={[styles.emptyText, { color: fixed.mute }]}>
                {filter === 'downloading'
                  ? 'Nothing downloading.'
                  : 'Nothing saved yet.'}
              </Text>
            </View>
          )}
      </ScrollView>
    </View>
  );
}

function PlaylistItem({ playlist }: { playlist: PlaylistRow }) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={playlist.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${playlist.name}, ${playlist.detail}`}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
    >
      {/* A playlist has no one cover, and picking the first track's would make
          the row change picture whenever the first track did. */}
      <View style={[styles.art, { backgroundColor: fixed.raised }]}>
        <MaterialIcons name="queue-music" size={17} color={fixed.mute} />
      </View>
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: t.on }]}>
          {playlist.name}
        </Text>
        <Text numberOfLines={1} style={[styles.rowSub, { color: t.onDim }]}>
          {playlist.detail}
        </Text>
      </View>
      <Pressable
        onPress={playlist.onMore}
        accessibilityRole="button"
        accessibilityLabel="Playlist options"
        style={({ pressed }) => [styles.moreHit, pressed && { opacity: 0.5 }]}
      >
        <MaterialIcons name="more-vert" size={19} color={t.onDim} />
      </Pressable>
    </Pressable>
  );
}

function Row({ item }: { item: LibraryItem }) {
  const { t } = useTheme();
  const fetching = item.progress != null;

  return (
    <Pressable
      onPress={item.onPress}
      disabled={!item.onPress}
      accessibilityRole={item.onPress ? 'button' : undefined}
      accessibilityLabel={item.title}
      style={({ pressed }) => [styles.row, pressed && item.onPress && { opacity: 0.6 }]}
    >
      <View style={[styles.art, { backgroundColor: fixed.raised }]}>
        {fetching ? (
          <ProgressRing value={item.progress ?? 0} colour={t.accent} />
        ) : item.queuedReason ? (
          <MaterialIcons name="wifi-off" size={18} color={fixed.mute} />
        ) : item.art ? (
          <Image source={{ uri: item.art }} style={styles.artImage} />
        ) : (
          <MaterialIcons
            name={item.kind === 'audio' ? 'music-note' : 'movie'}
            size={16}
            color={fixed.mute}
          />
        )}
      </View>

      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={[styles.rowTitle, { color: t.on }]}>
          {item.title}
        </Text>
        <Text
          numberOfLines={1}
          style={[
            fetching || item.queuedReason ? styles.rowMeta : styles.rowSub,
            {
              color: item.failed
                ? fixed.warn
                : fetching
                  ? t.accent
                  : t.onDim,
            },
          ]}
        >
          {item.queuedReason ?? item.subtitle}
        </Text>
      </View>

      {item.size && !fetching && (
        <Text style={[styles.size, { color: fixed.mute }]}>{item.size}</Text>
      )}

      <Pressable
        onPress={item.onMore}
        disabled={!item.onMore}
        accessibilityRole="button"
        accessibilityLabel={
          fetching || item.queuedReason ? 'Cancel download' : 'More options'
        }
        style={({ pressed }) => [styles.moreHit, pressed && { opacity: 0.5 }]}
      >
        <MaterialIcons
          name={fetching || item.queuedReason ? 'close' : 'more-vert'}
          size={fetching || item.queuedReason ? 20 : 19}
          color={t.onDim}
        />
      </Pressable>
    </Pressable>
  );
}

function ProgressRing({ value, colour }: { value: number; colour: string }) {
  const clamped = Math.min(1, Math.max(0, value));
  return (
    <Svg width={34} height={34} viewBox="0 0 34 34">
      <Circle
        cx={17}
        cy={17}
        r={RING_RADIUS}
        fill="none"
        stroke={colour}
        strokeOpacity={0.25}
        strokeWidth={2.5}
      />
      <Circle
        cx={17}
        cy={17}
        r={RING_RADIUS}
        fill="none"
        stroke={colour}
        strokeWidth={2.5}
        strokeLinecap="round"
        strokeDasharray={RING_CIRCUMFERENCE}
        strokeDashoffset={RING_CIRCUMFERENCE * (1 - clamped)}
        transform="rotate(-90 17 17)"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.gutter,
    paddingTop: space.insideChip,
    paddingBottom: space.gutter,
  },
  screenTitle: { ...type.screenTitle, flex: 1, fontSize: 22 },
  headerHit: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  sortNote: {
    ...type.mono,
    paddingHorizontal: space.gutter,
    paddingBottom: space.insideChip,
  },
  chips: {
    flexDirection: 'row',
    gap: space.insideChip,
    paddingHorizontal: space.gutter,
    paddingBottom: 18,
  },
  chip: {
    height: 32,
    borderRadius: radius.chip,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.row,
    marginHorizontal: space.gutter,
    marginBottom: space.gutter,
    padding: 14,
    borderWidth: 1,
    borderRadius: 12,
  },
  noticeText: { ...type.body, flex: 1 },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: space.gutter,
    paddingBottom: space.insideChip,
  },
  section: { ...type.section },
  sectionSolo: { paddingHorizontal: space.gutter, paddingBottom: space.row },
  action: { ...type.chip, fontFamily: 'Manrope_500Medium', fontSize: 11.5 },
  list: { gap: 14, paddingHorizontal: space.gutter, paddingBottom: space.section },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.row },
  art: {
    width: size.rowArt,
    height: size.rowArt,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  artImage: { width: '100%', height: '100%', resizeMode: 'cover' },
  rowBody: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { ...type.rowTitle, fontSize: 13.5, lineHeight: 18 },
  rowSub: { ...type.body, fontSize: 11.5, lineHeight: 15 },
  rowMeta: { ...type.mono },
  size: { ...type.mono, fontSize: 10.5 },
  moreHit: { width: 32, height: 40, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: space.row, paddingVertical: 64 },
  emptyText: { ...type.body, fontSize: 13.5 },
  emptyHint: { ...type.body, fontSize: 11.5, paddingHorizontal: space.section },
  backHit: { width: 34, height: 40, alignItems: 'center', justifyContent: 'center' },
  playlistBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.gutter,
    paddingBottom: 18,
  },
  mono: { ...type.mono },
  playButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.iconToLabel,
    height: 32,
    paddingHorizontal: 14,
    borderRadius: radius.chip,
  },
});
