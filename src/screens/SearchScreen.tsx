import {
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { fixed, size, space, type } from '../ui/theme';

/**
 * Search. See docs/UI.md §02.
 *
 * The local index answers instantly. The cloud is a button and never an
 * automatic second query — that restraint is the whole point of the screen, so
 * nothing here may fire a network request on keystroke.
 */

export type LocalHit = {
  id: string;
  title: string;
  /** "Ambient Archive · 62:14 · m4a" */
  subtitle: string;
  kind: 'audio' | 'video';
  /** file:// cover, once resolved. */
  art?: string;
  onPress?: () => void;
  onMore?: () => void;
};

type Props = {
  query: string;
  onQuery: (q: string) => void;
  hits: LocalHit[];
  recent: string[];
  onRecent: (q: string) => void;
  /** Only ever called from the button below — never on typing. */
  onSearchWeb: (q: string) => void;
};

export function SearchScreen({
  query,
  onQuery,
  hits,
  recent,
  onRecent,
  onSearchWeb,
}: Props) {
  const { t } = useTheme();
  const trimmed = query.trim();

  return (
    <View style={[styles.root, { backgroundColor: t.deep }]}>
      <View style={[styles.field, { backgroundColor: fixed.raised }]}>
        <MaterialIcons name="search" size={19} color={t.onDim} />
        <TextInput
          value={query}
          onChangeText={onQuery}
          placeholder="Search your library"
          placeholderTextColor={fixed.mute}
          style={[styles.input, { color: t.on }]}
          returnKeyType="search"
          autoCorrect={false}
        />
        {query.length > 0 && (
          <Pressable
            onPress={() => onQuery('')}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={8}
          >
            <MaterialIcons name="close" size={18} color={t.onDim} />
          </Pressable>
        )}
      </View>

      <ScrollView contentContainerStyle={{ paddingBottom: space.section }}>
        {trimmed.length > 0 && (
          <>
            {/* Heading only when it has something under it — with no hits the
                line below already says so, and twice is once too many. */}
            {hits.length > 0 && (
              <Text style={[styles.section, { color: t.onDim }]}>On this device</Text>
            )}
            <View style={styles.list}>
              {hits.map((hit) => (
                <Pressable
                  key={hit.id}
                  onPress={hit.onPress}
                  accessibilityRole="button"
                  accessibilityLabel={hit.title}
                  style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}
                >
                  <View style={[styles.art, { backgroundColor: fixed.raised }]}>
                    {hit.art ? (
                      <Image source={{ uri: hit.art }} style={styles.artImage} />
                    ) : (
                      <MaterialIcons
                        name={hit.kind === 'audio' ? 'music-note' : 'movie'}
                        size={16}
                        color={t.onDim}
                      />
                    )}
                  </View>
                  <View style={styles.rowBody}>
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: t.on }]}>
                      {hit.title}
                    </Text>
                    <Text numberOfLines={1} style={[styles.rowSub, { color: t.onDim }]}>
                      {hit.subtitle}
                    </Text>
                  </View>
                  <Pressable
                    onPress={hit.onMore}
                    disabled={!hit.onMore}
                    accessibilityRole="button"
                    accessibilityLabel="More options"
                    style={({ pressed }) => [styles.moreHit, pressed && { opacity: 0.5 }]}
                  >
                    <MaterialIcons name="more-vert" size={19} color={t.onDim} />
                  </Pressable>
                </Pressable>
              ))}
            </View>

            <View style={[styles.cloud, { borderTopColor: fixed.line }]}>
              <Text style={[styles.count, { color: t.onDim }]}>
                {hits.length === 0
                  ? 'Nothing on this device matches.'
                  : `${hits.length} on this device. Nothing else matches locally.`}
              </Text>
              <Pressable
                onPress={() => onSearchWeb(trimmed)}
                accessibilityRole="button"
                accessibilityLabel={`Search YouTube for ${trimmed}`}
                style={({ pressed }) => [
                  styles.cloudButton,
                  { backgroundColor: t.accent },
                  pressed && { opacity: 0.8 },
                ]}
              >
                <MaterialIcons name="travel-explore" size={19} color={t.onAccent} />
                <Text numberOfLines={1} style={[styles.cloudLabel, { color: t.onAccent }]}>
                  Search YouTube for “{trimmed}”
                </Text>
              </Pressable>
              <Text style={[styles.footnote, { color: fixed.mute }]}>
                the cloud is never searched without a tap
              </Text>
            </View>
          </>
        )}

        {/* With no query and no history the screen is otherwise a blank field
            on black, which reads as broken rather than as ready. */}
        {trimmed.length === 0 && recent.length === 0 && (
          <View style={styles.resting}>
            <MaterialIcons name="library-music" size={22} color={fixed.mute} />
            <Text style={[styles.restingText, { color: fixed.mute }]}>
              Search what you have saved. YouTube is only searched when you ask.
            </Text>
          </View>
        )}

        {recent.length > 0 && (
          <View style={[styles.recent, { borderTopColor: fixed.line }]}>
            <Text style={[styles.section, styles.recentHead, { color: t.onDim }]}>
              Recent searches
            </Text>
            {recent.map((q) => (
              <Pressable
                key={q}
                onPress={() => onRecent(q)}
                accessibilityRole="button"
                accessibilityLabel={q}
                style={({ pressed }) => [styles.recentRow, pressed && { opacity: 0.6 }]}
              >
                <MaterialIcons name="history" size={18} color={fixed.mute} />
                <Text numberOfLines={1} style={[styles.recentText, { color: t.onDim }]}>
                  {q}
                </Text>
                <MaterialIcons name="north-east" size={16} color={fixed.mute} />
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 44,
    borderRadius: 22,
    paddingHorizontal: 14,
    marginHorizontal: space.gutter,
    marginTop: space.insideChip,
    marginBottom: 18,
  },
  input: { ...type.body, flex: 1, fontSize: 14.5, padding: 0 },
  section: { ...type.section, paddingHorizontal: space.gutter, marginBottom: space.row },
  list: { gap: 14, paddingHorizontal: space.gutter, paddingBottom: 20 },
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
  moreHit: { width: 30, height: 40, alignItems: 'center', justifyContent: 'center' },
  cloud: {
    marginHorizontal: space.gutter,
    borderTopWidth: 1,
    paddingTop: 20,
  },
  count: { ...type.body, marginBottom: 14 },
  cloudButton: {
    height: size.target,
    borderRadius: 24,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 9,
    paddingHorizontal: space.gutter,
  },
  cloudLabel: { ...type.rowTitle, fontSize: 14 },
  footnote: { ...type.mono, marginTop: space.row },
  resting: {
    alignItems: 'center',
    gap: space.row,
    paddingHorizontal: space.header,
    paddingTop: 72,
  },
  restingText: { ...type.body, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  recent: {
    marginHorizontal: space.gutter,
    marginTop: 26,
    paddingTop: 20,
    borderTopWidth: 1,
  },
  recentHead: { paddingHorizontal: 0, marginBottom: 14 },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: space.row, paddingVertical: 8 },
  recentText: { ...type.body, flex: 1, fontSize: 14 },
});
