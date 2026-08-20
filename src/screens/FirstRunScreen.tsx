import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { space } from '../ui/theme';

type Props = {
  onStart: () => void;
  onChooseFolder: () => void;
};

/**
 * One screen, once.
 *
 * The button refuses to be the only teacher — this points at it plainly a
 * single time, then never appears again.
 */
export function FirstRunScreen({ onStart, onChooseFolder }: Props) {
  const { t } = useTheme();

  return (
    <View style={[styles.root, { backgroundColor: t.chrome }]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={[styles.kicker, { color: t.accent }]}>One screen, once</Text>
        <Text style={[styles.heading, { color: t.text }]}>
          Browse YouTube. Keep what's yours.
        </Text>
        <Text style={[styles.lede, { color: t.textDim }]}>
          Spool has no ads, no account, no tracking. Everything you keep stays on this
          phone, and plays without a connection.
        </Text>

        <View
          style={[
            styles.card,
            { backgroundColor: t.accentSurface, borderColor: t.accentSurface },
          ]}
        >
          <MaterialIcons name="file-download" size={20} color={t.accent} />
          <View style={styles.cardBody}>
            <Text style={[styles.cardTitle, { color: t.text }]}>
              This is the only button that matters
            </Text>
            <Text style={[styles.cardText, { color: t.textDim }]}>
              It sits in the corner of Browse, grey until you open a video. Tap it to
              choose a quality.
            </Text>
          </View>
        </View>

        <View style={[styles.card, { borderColor: t.border }]}>
          <MaterialIcons name="folder" size={20} color={t.textDim} />
          <View style={styles.cardBody}>
            <Text style={[styles.cardTitle, { color: t.text }]}>Where files go</Text>
            <Text style={[styles.cardText, { color: t.textDim, marginBottom: 10 }]}>
              Movies/Spool. Android will ask for permission once.
            </Text>
            <Pressable
              onPress={onChooseFolder}
              accessibilityRole="button"
              style={[styles.folderBtn, { backgroundColor: t.accent }]}
            >
              <Text style={[styles.folderText, { color: t.onAccent }]}>
                Choose folder
              </Text>
            </Pressable>
          </View>
        </View>

        <View style={[styles.footer, { borderTopColor: t.border }]}>
          <Text style={[styles.legal, { color: t.textDim }]}>
            Downloading from YouTube violates YouTube's Terms of Service. This app is
            built for your own uploads, Creative Commons and public-domain material, and
            personal offline use where your local law allows it. You are responsible for
            what you download.
          </Text>
          <Pressable
            onPress={onStart}
            accessibilityRole="button"
            style={[styles.startBtn, { backgroundColor: t.accent }]}
          >
            <Text style={[styles.startText, { color: t.onAccent }]}>
              I understand — start browsing
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: space.sheetBlock,
    paddingTop: 28,
    paddingBottom: space.gutter,
  },
  kicker: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 1.3,
    textTransform: 'uppercase',
    marginBottom: 14,
  },
  heading: { fontSize: 24, lineHeight: 30, fontWeight: '500', marginBottom: space.barSide },
  lede: { fontSize: 13.5, lineHeight: 21, marginBottom: 22 },
  card: {
    flexDirection: 'row',
    gap: space.barSide,
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    marginBottom: space.gutter,
  },
  cardBody: { flex: 1 },
  cardTitle: { fontSize: 13.5, lineHeight: 18, fontWeight: '500', marginBottom: 4 },
  cardText: { fontSize: 12.5, lineHeight: 19 },
  folderBtn: {
    alignSelf: 'flex-start',
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: space.gutter,
    borderRadius: 20,
  },
  folderText: { fontSize: 13, fontWeight: '500' },
  footer: { marginTop: 'auto', paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth },
  legal: { fontSize: 11.5, lineHeight: 18, marginBottom: 14 },
  startBtn: { height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  startText: { fontSize: 14, fontWeight: '500' },
});
