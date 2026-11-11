import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { TrialChip } from '../ui/TrialChip';
import { fixed, space, type } from '../ui/theme';
import { PRICES, daysLeft, openPaywall, useLicence } from '../core/license';
import { openAccount, useAccount, type AccountIntent } from '../core/account';
import { formatDate } from '../core/payments';
import { SubscribeSheet } from '../sheets/SubscribeSheet';
import { AccountSheet } from '../sheets/AccountSheet';

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
  autoSave?: AutoSave;
  onAutoSave?: (next: AutoSave) => void;
  storage?: Storage;
  engineSummary?: string;
  engineTone?: 'good' | 'warn' | 'neutral';
  onEngine?: () => void;
  onAudioQuality?: () => void;
  onVideoQuality?: () => void;
  onExport?: () => void;
  exportSummary?: string;
  onDiagnostics?: () => void;
  onSignOut?: () => void;
  onSignInGoogle?: () => void;
  diagnosticsSummary?: string;
};

export function ProfileScreen({
  onDiagnostics,
  onSignOut,
  onSignInGoogle,
  diagnosticsSummary,
}: Props) {
  const { t } = useTheme();
  const lic = useLicence();
  const { email } = useAccount();
  const licenceDays = daysLeft(lic);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [accountIntent, setAccountIntent] = useState<AccountIntent | null>(null);

  return (
    <View style={[styles.root, { backgroundColor: t.deep }]}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={styles.identity}>
          <View style={[styles.avatar, { backgroundColor: t.tint }]}>
            <Text style={[styles.avatarText, { color: t.accent }]}>A</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.identityTitle, { color: t.on }]} numberOfLines={1}>
              {email ?? 'This device'}
            </Text>
            <Text style={[styles.identitySub, { color: t.onDim }]}>
              {email ? 'Spool account · signed in' : 'No account · nothing leaves the phone'}
            </Text>
          </View>
          <TrialChip />
        </View>

        <Text style={[styles.section, { color: t.onDim }]}>Subscription</Text>

        <SettingRow
          label={email ? 'Account' : 'Sign in'}
          value={email ?? 'Use it on every phone'}
          onPress={() => setAccountIntent({})}
        />
        <SettingRow
          label={
            lic.entitled
              ? (lic.plan === 'annual' ? 'Yearly plan' : (lic.plan === 'daily' ? '1-Day plan' : 'Monthly plan'))
              : 'Subscribe'
          }
          value={
            lic.entitled
              ? licenceDays === null
                ? 'Active'
                : `${licenceDays} ${licenceDays === 1 ? 'day' : 'days'} left`
              : lic.paidThrough && lic.paidThrough > Date.now()
                ? `Paid to ${formatDate(lic.paidThrough)}`
                : `${PRICES.annual?.amount || '₹249'} a year`
          }
          valueColour={lic.entitled ? fixed.saved : undefined}
          onPress={() => setPaywallOpen(true)}
        />

        <Text style={[styles.section, styles.sectionAfterRow, { color: t.onDim }]}>
          Session & Settings
        </Text>

        {onSignInGoogle && (
          <SettingRow
            label="Google Account"
            value="Pick from device"
            onPress={onSignInGoogle}
          />
        )}

        {onSignOut && (
          <SettingRow
            label="Sign out of YouTube"
            value="Clear session"
            onPress={onSignOut}
          />
        )}

        {onDiagnostics && (
          <SettingRow
            label="Export diagnostics"
            value={diagnosticsSummary ?? ''}
            onPress={onDiagnostics}
          />
        )}

        <Text style={[styles.legal, { color: fixed.mute }]}>
          Ad-free YouTube & YouTube Music player. Built for your personal offline and online listening.
        </Text>
      </ScrollView>
      {paywallOpen ? (
        <SubscribeSheet onClose={() => setPaywallOpen(false)} />
      ) : null}
      {accountIntent ? (
        <AccountSheet
          intent={accountIntent}
          onClose={() => setAccountIntent(null)}
        />
      ) : null}
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
  /** A section title that follows a SettingRow needs the room the card gives. */
  sectionAfterRow: { marginTop: space.section },
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
