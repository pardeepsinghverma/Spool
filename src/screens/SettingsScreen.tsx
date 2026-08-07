import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { engineVersion, updateEngine } from '../core/ytdlp';
import { useTheme } from '../ui/ThemeContext';
import { radius, size, space } from '../ui/theme';

type Props = {
  onBack: () => void;
  onNotice: (text: string) => void;
};

/**
 * Engine updates never announce themselves (design §6): the only unprompted
 * mention they get is a blue dot here and a three-second pill line.
 */
export function SettingsScreen({ onBack, onNotice }: Props) {
  const { t } = useTheme();
  const [version, setVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    engineVersion()
      .then(setVersion)
      .catch(() => setVersion('unavailable'));
  }, []);

  const update = useCallback(async () => {
    setBusy(true);
    try {
      const result = await updateEngine();
      setVersion(result.version);
      onNotice(
        result.status === 'ALREADY_UP_TO_DATE' ? 'Engine already current' : 'Engine updated',
      );
    } catch (e) {
      onNotice(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  }, [onNotice]);

  return (
    <View style={[styles.root, { backgroundColor: t.chrome }]}>
      <View style={[styles.header, { borderBottomColor: t.border }]}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.headerHit}
        >
          <MaterialIcons name="arrow-back" size={22} color={t.icon} />
        </Pressable>
        <Text style={[styles.title, { color: t.text }]}>Settings</Text>
      </View>

      <ScrollView contentContainerStyle={{ paddingVertical: space.insidePill }}>
        <Text style={[styles.section, { color: t.textDim }]}>Engine</Text>

        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, { color: t.text }]}>Extraction engine</Text>
            <Text style={[styles.rowDetail, { color: t.textDim }]}>
              {version ? `yt-dlp ${version}` : 'Checking…'}
            </Text>
          </View>
          {busy ? (
            <ActivityIndicator size="small" color={t.accent} />
          ) : (
            <Pressable
              onPress={update}
              accessibilityRole="button"
              style={[styles.updateBtn, { backgroundColor: t.accent }]}
            >
              <Text style={[styles.updateText, { color: t.onAccent }]}>Update</Text>
            </Pressable>
          )}
        </View>

        <Text style={[styles.help, { color: t.textDim }]}>
          The engine updates itself at runtime. This app can't ship store updates, so
          this is how it repairs itself when YouTube changes something.
        </Text>

        <Text style={[styles.section, { color: t.textDim }]}>Privacy</Text>
        <View style={styles.row}>
          <View style={styles.rowText}>
            <Text style={[styles.rowTitle, { color: t.text }]}>Ad and tracker blocking</Text>
            <Text style={[styles.rowDetail, { color: t.textDim }]}>
              Always on. Player ads are stripped before the page reads them.
            </Text>
          </View>
          <MaterialIcons name="check" size={20} color={t.success} />
        </View>

        <Text style={[styles.section, { color: t.textDim }]}>About</Text>
        <Text style={[styles.help, { color: t.textDim }]}>
          Downloading from YouTube violates YouTube's Terms of Service. This app is
          built for your own uploads, Creative Commons and public-domain material, and
          personal offline use where your local law allows it. You are responsible for
          what you download.
        </Text>
      </ScrollView>
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
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerHit: {
    width: size.target,
    height: size.target,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { flex: 1, fontSize: 18, fontWeight: '500' },
  section: {
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.66,
    textTransform: 'uppercase',
    paddingHorizontal: space.gutter,
    paddingTop: space.sheetBlock,
    paddingBottom: space.insidePill,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.barSide,
    minHeight: 56,
    paddingHorizontal: space.gutter,
  },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 14, lineHeight: 18, fontWeight: '500' },
  rowDetail: { fontSize: 12, lineHeight: 16, marginTop: 3 },
  updateBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: radius.pill,
  },
  updateText: { fontSize: 13, fontWeight: '500' },
  help: {
    fontSize: 12,
    lineHeight: 18,
    paddingHorizontal: space.gutter,
    paddingTop: space.insidePill,
  },
});
