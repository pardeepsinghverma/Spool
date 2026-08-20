import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { TrialChip } from '../ui/TrialChip';
import { fixed, space, type } from '../ui/theme';

/**
 * Profile. See docs/UI.md §02 and §04.
 *
 * The whole auto-download rule is one card. Everything the rule does elsewhere
 * in the app is invisible, so this is the only place a user can find out what
 * it will do — which makes the copy here part of the feature, not labelling.
 */

export type KeepAs = 'audio' | 'video' | 'match';

/** Discrete because the rule is discrete; a continuous slider would imply 4. */
export const PLAY_THRESHOLDS = [2, 3, 5] as const;
export type PlayThreshold = (typeof PLAY_THRESHOLDS)[number];

/**
 * What the two quality rows offer.
 *
 * These are ceilings, not demands — nothing on YouTube is guaranteed to have the
 * rung asked for, so both settings mean "the best at or below this". The details
 * describe the trade the user is actually making, since a bitrate on its own
 * tells most people nothing.
 */
export const AUDIO_QUALITIES = [
  { key: 'Best available', label: 'Best available', detail: 'usually 128–160 kbps' },
  { key: '160 kbps', label: '160 kbps', detail: '~70 MB per hour' },
  { key: '128 kbps', label: '128 kbps', detail: '~55 MB per hour' },
  { key: '96 kbps', label: '96 kbps', detail: '~42 MB per hour' },
] as const;

export const VIDEO_QUALITIES = [
  { key: '2160p', label: '2160p', detail: '4K — very large files' },
  { key: '1440p', label: '1440p', detail: '2K' },
  { key: '1080p', label: '1080p', detail: 'full HD' },
  { key: '720p', label: '720p', detail: 'HD — a good deal smaller' },
  { key: '480p', label: '480p', detail: 'smallest worth keeping' },
] as const;

export type AutoSave = {
  enabled: boolean;
  after: number;
  keepAs: KeepAs;
  audioQuality: string;
  videoQuality: string;
  /** What one tap on the download button grabs, without opening the sheet. */
  instant: 'audio' | 'video';
};

export type Storage = {
  /**
   * 0..1 of total disk used by us, and by everything else — or null when the
   * device's capacity is not known. A meter drawn from a guess is worse than no
   * meter: it is the one control here that looks like a measurement.
   */
  ours: number | null;
  others: number;
  /** "4.2 GB Spool · 2.5 GB other" */
  used: string;
  /** "12 GB free", or empty when capacity is unknown. */
  free: string;
};

type Props = {
  autoSave: AutoSave;
  onAutoSave: (next: AutoSave) => void;
  storage: Storage;
  engineSummary: string;
  /**
   * Three states, not two. The engine can report a version it has no record of
   * — youtubedl-android only knows one after an update has run — and painting
   * that green would say "up to date" about something we have not established.
   * Green is a claim; neutral is the absence of one.
   */
  engineTone: 'good' | 'warn' | 'neutral';
  onEngine?: () => void;
  onAudioQuality?: () => void;
  onVideoQuality?: () => void;
  /**
   * Writes the playlists out to Downloads/Spool. Absent while there are none —
   * a row offering to export nothing is a row that does nothing.
   */
  onExport?: () => void;
  /** "3 playlists · 41 tracks", so the row says what it would write. */
  exportSummary?: string;
};

const KEEP: { key: KeepAs; label: string; icon: keyof typeof MaterialIcons.glyphMap }[] = [
  { key: 'audio', label: 'Audio', icon: 'headphones' },
  { key: 'video', label: 'Video', icon: 'smart-display' },
  { key: 'match', label: 'Match', icon: 'auto-awesome' },
];

const INSTANT: {
  key: 'audio' | 'video';
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap;
}[] = [
  { key: 'audio', label: 'Audio', icon: 'headphones' },
  { key: 'video', label: 'Video', icon: 'smart-display' },
];

export function ProfileScreen({
  autoSave,
  onAutoSave,
  storage,
  engineSummary,
  engineTone,
  onEngine,
  onAudioQuality,
  onVideoQuality,
  onExport,
  exportSummary,
}: Props) {
  const { t } = useTheme();
  const set = (patch: Partial<AutoSave>) => onAutoSave({ ...autoSave, ...patch });

  return (
    <View style={[styles.root, { backgroundColor: t.deep }]}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.identity}>
          <View style={[styles.avatar, { backgroundColor: t.tint }]}>
            <Text style={[styles.avatarText, { color: t.accent }]}>A</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.identityTitle, { color: t.on }]}>This device</Text>
            <Text style={[styles.identitySub, { color: t.onDim }]}>
              No account · nothing leaves the phone
            </Text>
          </View>
          <TrialChip />
        </View>

        <Text style={[styles.section, { color: t.onDim }]}>Keep automatically</Text>

        <View style={[styles.card, { borderColor: fixed.line }]}>
          <View style={styles.switchRow}>
            <Text style={[styles.switchLabel, { color: t.on }]}>Save what I replay</Text>
            <Pressable
              onPress={() => set({ enabled: !autoSave.enabled })}
              accessibilityRole="switch"
              accessibilityState={{ checked: autoSave.enabled }}
              accessibilityLabel="Save what I replay"
              style={[
                styles.switchTrack,
                {
                  backgroundColor: autoSave.enabled ? t.accent : fixed.line,
                  justifyContent: autoSave.enabled ? 'flex-end' : 'flex-start',
                },
              ]}
            >
              <View
                style={[
                  styles.switchThumb,
                  { backgroundColor: autoSave.enabled ? t.onAccent : fixed.mute },
                ]}
              />
            </Pressable>
          </View>
          {/* States the real threshold. The earlier copy promised a play had to
              reach the end, which the counter never measured — a settings
              screen that describes a rule the code does not run is worse than
              one that says nothing. */}
          <Text style={[styles.help, { color: t.onDim }]}>
            A play counts after five seconds of watching. Scrubbing and muted
            previews never count.
          </Text>

          <View style={styles.afterRow}>
            <Text style={[styles.fieldLabel, { color: t.onDim }]}>After</Text>
            <Text style={[styles.fieldValue, { color: t.accent }]}>
              {autoSave.after} plays
            </Text>
          </View>
          <View style={styles.steps}>
            {PLAY_THRESHOLDS.map((n) => {
              const active = n === autoSave.after;
              return (
                <Pressable
                  key={n}
                  onPress={() => set({ after: n })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`After ${n} plays`}
                  style={styles.step}
                >
                  <View
                    style={[
                      styles.stepTrack,
                      { backgroundColor: active ? t.accent : fixed.line },
                    ]}
                  />
                  <Text
                    style={[
                      styles.stepLabel,
                      { color: active ? t.accent : fixed.mute },
                    ]}
                  >
                    {n}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.fieldLabel, styles.keepLabel, { color: t.onDim }]}>
            Keep as
          </Text>
          <View style={[styles.segmented, { backgroundColor: fixed.raised }]}>
            {KEEP.map(({ key, label, icon }) => {
              const active = key === autoSave.keepAs;
              return (
                <Pressable
                  key={key}
                  onPress={() => set({ keepAs: key })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={label}
                  style={[
                    styles.segment,
                    active && { backgroundColor: t.accent },
                  ]}
                >
                  <MaterialIcons
                    name={icon}
                    size={16}
                    color={active ? t.onAccent : t.onDim}
                  />
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

          <SettingRow
            label="Audio quality"
            value={autoSave.audioQuality}
            onPress={onAudioQuality}
          />
          <SettingRow
            label="Video quality"
            value={autoSave.videoQuality}
            onPress={onVideoQuality}
          />
        </View>

        <Text style={[styles.section, { color: t.onDim }]}>The download button</Text>

        <View style={[styles.card, { borderColor: fixed.line }]}>
          <Text style={[styles.fieldLabel, styles.keepLabel, { color: t.onDim }]}>
            One tap downloads
          </Text>
          <View style={[styles.segmented, { backgroundColor: fixed.raised }]}>
            {INSTANT.map(({ key, label, icon }) => {
              const active = key === autoSave.instant;
              return (
                <Pressable
                  key={key}
                  onPress={() => set({ instant: key })}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={`One tap downloads ${label}`}
                  style={[styles.segment, active && { backgroundColor: t.accent }]}
                >
                  <MaterialIcons
                    name={icon}
                    size={16}
                    color={active ? t.onAccent : t.onDim}
                  />
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
          <Text style={[styles.help, styles.helpLast, { color: t.onDim }]}>
            Hold the button for three seconds to see every format instead.
          </Text>
        </View>

        <Text style={[styles.section, { color: t.onDim }]}>Storage</Text>
        {storage.ours != null && (
          <View style={[styles.meter, { backgroundColor: fixed.raised }]}>
            <View
              style={{
                width: `${Math.round(storage.ours * 100)}%`,
                backgroundColor: t.accent,
              }}
            />
            <View
              style={{
                width: `${Math.round(storage.others * 100)}%`,
                backgroundColor: t.tint,
              }}
            />
          </View>
        )}
        <View style={styles.meterLabels}>
          <Text style={[styles.mono, { color: t.onDim }]}>{storage.used}</Text>
          {storage.free.length > 0 && (
            <Text style={[styles.mono, { color: fixed.mute }]}>{storage.free}</Text>
          )}
        </View>

        {/* App data dies with an uninstall and MediaStore records do not, which
            is why the library rebuilds itself and the *arrangement* of it
            cannot. This is the one way an arrangement becomes a file. */}
        {onExport && (
          <SettingRow
            label="Back up playlists"
            value={exportSummary ?? ''}
            onPress={onExport}
          />
        )}

        {/* A "Wi-Fi only" row used to sit here. Nothing enforced it: reading the
            connection type needs a native probe this build does not have, so the
            row asserted a policy the app did not run. Same rule as the storage
            meter above — an absence is honest, a claim is not. */}
        <SettingRow
          label="Extraction engine"
          value={engineSummary}
          valueColour={
            engineTone === 'good'
              ? fixed.saved
              : engineTone === 'warn'
                ? fixed.warn
                : undefined
          }
          onPress={onEngine}
        />

        <Text style={[styles.legal, { color: fixed.mute }]}>
          Built for your own uploads, Creative Commons and public-domain
          material, and personal offline use where your local law allows it.
        </Text>
      </ScrollView>
    </View>
  );
}

function SettingRow({
  label,
  value,
  valueColour,
  onPress,
}: {
  label: string;
  value: string;
  valueColour?: string;
  onPress?: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => [
        styles.settingRow,
        { borderTopColor: fixed.line },
        pressed && onPress && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.settingLabel, { color: t.on }]}>{label}</Text>
      <Text style={[styles.mono, { color: valueColour ?? t.onDim }]}>{value}</Text>
      <MaterialIcons name="chevron-right" size={17} color={fixed.mute} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { paddingHorizontal: space.gutter, paddingTop: space.insideChip, paddingBottom: space.section },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 13, marginBottom: 20 },
  avatar: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...type.nowPlaying, fontSize: 18, lineHeight: 22 },
  identityTitle: { ...type.rowTitle, fontSize: 16, marginBottom: 2 },
  identitySub: { ...type.body, fontSize: 12 },
  section: { ...type.section, marginBottom: 14 },
  card: { borderWidth: 1, borderRadius: 12, padding: space.gutter, marginBottom: space.section },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: space.row, marginBottom: 6 },
  switchLabel: { ...type.rowTitle, flex: 1, fontSize: 14.5 },
  switchTrack: {
    width: 44,
    height: 26,
    borderRadius: 13,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 3,
  },
  switchThumb: { width: 20, height: 20, borderRadius: 10 },
  help: { ...type.body, fontSize: 12.5, lineHeight: 19, marginBottom: space.gutter },
  helpLast: { marginBottom: 0 },
  afterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.insideChip,
  },
  fieldLabel: { ...type.chip, fontSize: 12.5 },
  fieldValue: { ...type.monoStrong, fontSize: 12.5 },
  steps: { flexDirection: 'row', gap: 6, marginBottom: 20 },
  step: { flex: 1, gap: 6, alignItems: 'center' },
  stepTrack: { height: 3, borderRadius: 2, width: '100%' },
  stepLabel: { ...type.mono, fontSize: 10.5 },
  keepLabel: { marginBottom: 9 },
  segmented: { flexDirection: 'row', gap: 6, borderRadius: 10, padding: 4, marginBottom: 18 },
  segment: {
    flex: 1,
    height: 34,
    borderRadius: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderTopWidth: 1,
  },
  settingLabel: { ...type.rowTitle, flex: 1, fontSize: 13.5 },
  mono: { ...type.mono, fontSize: 12 },
  meter: { height: 6, borderRadius: 3, overflow: 'hidden', flexDirection: 'row', marginBottom: space.insideChip },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: space.gutter },
  legal: { ...type.body, fontSize: 11.5, lineHeight: 17, marginTop: space.section },
});
