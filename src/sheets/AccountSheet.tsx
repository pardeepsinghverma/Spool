import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, size, space, type } from '../ui/theme';
import {
  type AccountDetails,
  type AccountIntent,
  fetchAccount,
  login,
  logout,
  register,
  useAccount,
} from '../core/account';
import { licence, openPaywall, syncLicence } from '../core/license';
import { formatDate, supportWhatsapp, whatsappUrl } from '../core/payments';

/**
 * The Spool account: sign in, create one, or see the one you are in.
 *
 * Deliberately small. Two fields, one button, and a switch between "sign in"
 * and "create" — the same form, because the server takes the same fields and
 * a user who is not sure which they need should not have to find out by
 * navigating. Server refusals come back as sentences from
 * `explainAuthError`, never as the server's own error strings.
 *
 * There is no password reset flow in the app. "Forgot password?" is a
 * WhatsApp message to support, prefilled with the address: the server has no
 * mail sender, and a reset form that sent nothing would be the one control in
 * the app that lies.
 *
 * Signed in, it shows the email, the devices the account is used on, and
 * sign-out. Blocked, it shows only the explanation and the way to support.
 */
export function AccountSheet({ intent, onClose }: { intent: AccountIntent; onClose: () => void }) {
  const { t, reduced } = useTheme();
  const { session, email: signedInAs } = useAccount();
  const rise = useRef(new Animated.Value(0)).current;

  const [mode, setMode] = useState<'signin' | 'create'>(
    intent.mode ?? (intent.next === 'paywall' ? 'create' : 'signin'),
  );
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [details, setDetails] = useState<AccountDetails | null>(null);

  const gone = useRef(false);
  useEffect(
    () => () => {
      gone.current = true;
    },
    [],
  );

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reduced ? 0 : motion.sheetIn,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start();
  }, [rise, reduced]);

  // The device list is a nicety, fetched when the sheet opens signed in. Its
  // absence (offline) is not an error worth showing.
  useEffect(() => {
    if (!session) return;
    void fetchAccount().then((d) => {
      if (!gone.current) setDetails(d);
    });
  }, [session]);

  const submit = async () => {
    setProblem(null);
    if (!email.trim() || !password) {
      setProblem('Enter your email and a password.');
      return;
    }
    setBusy(true);
    const failed = mode === 'create' ? await register(email, password) : await login(email, password);
    if (gone.current) return;
    setBusy(false);
    if (failed) {
      setProblem(failed);
      return;
    }
    setPassword('');
    // An account that has already paid should not have to wait for the next
    // launch to be one on this phone.
    await syncLicence({ force: true });
    if (intent.next === 'paywall') {
      onClose();
      openPaywall(intent.reason);
    } else if (licence().entitled) {
      onClose();
    }
  };

  const forgot = () => {
    const who = email.trim() || signedInAs || '';
    const message = who
      ? `Hi, I have forgotten the password for my Spool account (${who}). Please help me reset it.`
      : 'Hi, I have forgotten the password for my Spool account. Please help me reset it.';
    Linking.openURL(whatsappUrl(supportWhatsapp(), message)).catch(() =>
      setProblem('WhatsApp could not be opened on this phone.'),
    );
  };

  const contactSupport = () => {
    Linking.openURL(
      whatsappUrl(supportWhatsapp(), 'Hi, my Spool account says it has been blocked. Can you help?'),
    ).catch(() => setProblem('WhatsApp could not be opened on this phone.'));
  };

  const signOut = async () => {
    setBusy(true);
    await logout();
    if (gone.current) return;
    setBusy(false);
    setDetails(null);
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose} />
      <KeyboardAvoidingView behavior="height" style={styles.avoid} pointerEvents="box-none">
        <Animated.View
          style={[
            styles.sheet,
            { backgroundColor: t.deep, borderTopColor: fixed.line },
            {
              opacity: rise,
              transform: [
                { translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
              ],
            },
          ]}
        >
          <View style={[styles.grabber, { backgroundColor: fixed.line }]} />
          <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
            {intent.blocked && !session ? (
              <>
                <Text style={[styles.eyebrow, { color: fixed.warn }]}>Account</Text>
                <Text style={[styles.title, { color: t.on }]}>This account is blocked</Text>
                <Text style={[styles.body, { color: t.onDim }]}>
                  It has been signed out on this phone. If you think this is a mistake, message
                  support on WhatsApp. Everything you have saved is still on your device.
                </Text>
                <Button label="Contact support on WhatsApp" icon="chat" onPress={contactSupport} t={t} />
                <Link label="Close" onPress={onClose} t={t} />
              </>
            ) : session ? (
              <>
                <Text style={[styles.eyebrow, { color: t.accent }]}>Account</Text>
                <Text style={[styles.title, { color: t.on }]} numberOfLines={1}>
                  {signedInAs ?? 'Signed in'}
                </Text>
                <Text style={[styles.body, { color: t.onDim }]}>
                  Your subscription works on every phone signed in to this account — but plays on
                  one at a time.
                </Text>
                {details?.paidThrough ? (
                  <Text style={[styles.body, { color: t.onDim }]}>
                    {details.entitled ? 'Paid through ' : 'Ended '}
                    <Text style={[styles.mono, { color: t.on }]}>{formatDate(details.paidThrough)}</Text>
                  </Text>
                ) : null}
                {details?.devices.length ? (
                  <View style={[styles.devices, { borderColor: fixed.line }]}>
                    {details.devices.map((d, i) => (
                      <View key={`${d.label}-${i}`} style={styles.device}>
                        <MaterialIcons
                          name="smartphone"
                          size={16}
                          color={d.current ? t.accent : t.onDim}
                        />
                        <Text style={[styles.deviceName, { color: t.on }]} numberOfLines={1}>
                          {d.label}
                          {d.current ? ' · this phone' : ''}
                        </Text>
                        <Text style={[styles.mono, { color: fixed.mute }]}>
                          {[d.city, d.lastSeen ? formatDate(d.lastSeen) : ''].filter(Boolean).join(' · ')}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
                <Button label="Sign out" icon="logout" busy={busy} onPress={signOut} t={t} />
                <Text style={[styles.fine, { color: t.onDim }]}>
                  Signing out removes the subscription from this phone until you sign in again.
                  Your library stays.
                </Text>
                <Link label="Close" onPress={onClose} t={t} />
              </>
            ) : (
              <>
                <Text style={[styles.eyebrow, { color: t.accent }]}>Account</Text>
                <Text style={[styles.title, { color: t.on }]}>
                  {mode === 'create' ? 'Create a Spool account' : 'Sign in to Spool'}
                </Text>
                <Text style={[styles.body, { color: t.onDim }]}>
                  {intent.next === 'paywall'
                    ? 'A payment is added to an account, so it follows you to any phone you sign in on.'
                    : 'Your subscription follows your account to any phone you sign in on.'}
                </Text>

                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email"
                  placeholderTextColor={fixed.mute}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  editable={!busy}
                  style={[styles.field, { color: t.on, backgroundColor: t.tint }]}
                />
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder={mode === 'create' ? 'Password (at least 8 characters)' : 'Password'}
                  placeholderTextColor={fixed.mute}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                  editable={!busy}
                  onSubmitEditing={submit}
                  style={[styles.field, { color: t.on, backgroundColor: t.tint }]}
                />

                {problem ? <Text style={[styles.fine, { color: fixed.warn }]}>{problem}</Text> : null}

                <Button
                  label={mode === 'create' ? 'Create account' : 'Sign in'}
                  icon="person-outline"
                  busy={busy}
                  onPress={submit}
                  t={t}
                />
                <Link
                  label={mode === 'create' ? 'I already have an account' : 'Create an account instead'}
                  onPress={() => {
                    setProblem(null);
                    setMode(mode === 'create' ? 'signin' : 'create');
                  }}
                  t={t}
                />
                {mode === 'signin' ? <Link label="Forgot password?" onPress={forgot} t={t} /> : null}
              </>
            )}
            {session && problem ? (
              <Text style={[styles.fine, { color: fixed.warn }]}>{problem}</Text>
            ) : null}
          </ScrollView>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

type Tokens = ReturnType<typeof useTheme>['t'];

function Button({
  label,
  icon,
  busy,
  onPress,
  t,
}: {
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  busy?: boolean;
  onPress: () => void;
  t: Tokens;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: t.accent },
        (pressed || busy) && { opacity: 0.75 },
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={t.onAccent} />
      ) : (
        <MaterialIcons name={icon} size={18} color={t.onAccent} />
      )}
      <Text style={[styles.primaryLabel, { color: t.onAccent }]}>{label}</Text>
    </Pressable>
  );
}

function Link({ label, onPress, t }: { label: string; onPress: () => void; t: Tokens }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.6 }]}
    >
      <Text style={[styles.secondaryLabel, { color: t.onDim }]}>{label}</Text>
    </Pressable>
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
  avoid: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    maxHeight: '92%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingTop: 8,
  },
  scroll: { paddingBottom: space.section },
  grabber: {
    width: 32,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 14,
  },
  eyebrow: { ...type.section, paddingHorizontal: space.gutter, marginBottom: 6 },
  title: { ...type.screenTitle, paddingHorizontal: space.gutter, marginBottom: 6 },
  body: { ...type.body, paddingHorizontal: space.gutter, marginBottom: space.insideChip },
  mono: { ...type.mono, fontSize: 12 },
  field: {
    ...type.body,
    fontSize: 14.5,
    height: size.target,
    marginHorizontal: space.gutter,
    marginTop: space.insideChip,
    paddingHorizontal: space.gutter,
    borderRadius: radius.art,
  },
  devices: {
    marginHorizontal: space.gutter,
    marginVertical: space.insideChip,
    borderTopWidth: 1,
  },
  device: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.insideChip,
    paddingVertical: space.insideChip + 2,
  },
  deviceName: { ...type.body, flex: 1 },
  primary: {
    height: size.target,
    marginTop: space.row,
    marginHorizontal: space.gutter,
    borderRadius: radius.chip,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.insideChip,
  },
  primaryLabel: { ...type.rowTitle, fontSize: 14.5 },
  fine: {
    ...type.body,
    fontSize: 12,
    textAlign: 'center',
    paddingHorizontal: space.gutter,
    marginTop: space.insideChip,
  },
  secondary: {
    height: size.target,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
  },
  secondaryLabel: { ...type.body, fontSize: 13.5 },
});
