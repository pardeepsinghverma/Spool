import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Clipboard,
  Easing,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import QRCode from 'react-native-qrcode-svg';
import YtDlp from '../../modules/ytdlp';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, size, space, type } from '../ui/theme';
import { PRICES, type Plan, daysLeft, licence, syncLicence, useLicence } from '../core/license';
import { endpoint, openAccount, useAccount } from '../core/account';
import {
  type Claim,
  type LivePlan,
  type Order,
  clearPendingOrder,
  formatDate,
  formatRupees,
  loadPendingOrder,
  savePendingOrder,
  startPayment,
  submitScreenshot,
  useLivePlans,
  whatsappUrl,
} from '../core/payments';
import * as log from '../core/log';

/**
 * The paywall.
 *
 * Payment is a UPI transfer the user makes from their own UPI app, to the
 * owner's UPI ID, against an order code the server issues. There is no
 * gateway, no card form and nothing to type into Spool — which matters in an
 * app that injects JavaScript into pages. The proof is a screenshot: read on
 * the device, checked on the server, and granted on the spot when it checks
 * out.
 *
 * That gives the shape. Choose a plan; pay (a UPI button for this phone, a QR
 * for paying from another); come back and upload the screenshot; then one of
 * two endings. **The second ending is not an error screen.** A screenshot the
 * parser cannot vouch for goes to a person, and the sheet says exactly why and
 * hands over a prefilled WhatsApp message — someone who has just paid must
 * leave with a next step, never with "something went wrong".
 *
 * Signed out, the sheet offers the account first: a payment is added to an
 * account, so that it follows the user to their next phone.
 *
 * Read `docs/UI.md` before changing anything here, including the copy. The
 * pricing rule in particular is not decoration: no struck-through number that
 * nobody has ever been charged.
 */

type Phase =
  | 'choosing'
  | 'starting'
  | 'pay'
  | 'reading'
  | 'uploading'
  | 'approved'
  | 'held'
  | 'rechecking';

/** Long edge, px, of the uploaded copy. Legible to a person; a few hundred kB. */
const UPLOAD_EDGE = 1600;
const UPLOAD_QUALITY = 80;

export function SubscribeSheet({
  onClose,
  reason,
  canClose = true,
}: {
  onClose: () => void;
  reason?: string;
  canClose?: boolean;
}) {
  const { t, reduced } = useTheme();
  const status = useLicence();
  const { session } = useAccount();
  const rise = useRef(new Animated.Value(0)).current;

  const { plans, settings } = useLivePlans();
  const [plan, setPlan] = useState<string>('daily');
  const [phase, setPhase] = useState<Phase>('choosing');
  /** A subscriber who asked to pay for the next period sees the plans, not the receipt. */
  const [renewing, setRenewing] = useState(false);
  const [order, setOrder] = useState<Order | null>(null);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (plans.length > 0 && !plans.some((p) => p.code === plan)) {
      setPlan(plans[0].code);
    }
  }, [plans, plan]);

  /** Set once the sheet goes away, so a request that outlives it cannot setState. */
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

  // Back into the middle of a payment, if the process was killed while the
  // user was in their UPI app. See `savePendingOrder`.
  useEffect(() => {
    void loadPendingOrder().then((pending) => {
      if (gone.current || !pending) return;
      setOrder(pending);
      setPlan(pending.plan);
      setPhase('pay');
    });
  }, []);

  const begin = async () => {
    setProblem(null);
    setPhase('starting');
    const started = await startPayment(plan);
    if (gone.current) return;
    if (!started.ok) {
      setPhase('choosing');
      if (started.signedOut) {
        onClose();
        openAccount({ next: 'paywall', mode: 'signin', reason });
        return;
      }
      setProblem(started.message);
      return;
    }
    setOrder(started.order);
    void savePendingOrder(started.order);
    setPhase('pay');
  };

  const upload = async () => {
    if (!order) return;
    setProblem(null);
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      // Untouched: the text is read off the original, where it is sharpest.
      // The copy that is uploaded is made below, and made small.
      quality: 1,
    }).catch(() => null);
    if (gone.current || !picked || picked.canceled || !picked.assets?.length) return;
    const source = picked.assets[0].uri;

    setPhase('reading');
    let text = '';
    try {
      text = await YtDlp.recognizeText(source);
    } catch (e) {
      // Sent anyway, with no text: the server routes an unreadable
      // screenshot to a person, which is the right place for it.
      log.warn('pay', 'could not read the screenshot', log.describe(e));
    }
    let file = source;
    try {
      file = (await YtDlp.shrinkImage(source, UPLOAD_EDGE, UPLOAD_QUALITY)).uri;
    } catch (e) {
      log.warn('pay', 'could not shrink the screenshot', log.describe(e));
    }
    if (gone.current) return;

    setPhase('uploading');
    const result = await submitScreenshot(order.order, file, text);
    if (gone.current) return;
    if (result.status === 'error') {
      setPhase('pay');
      if (result.signedOut) {
        onClose();
        openAccount({ next: 'paywall', reason });
        return;
      }
      setProblem(result.message);
      return;
    }
    setClaim(result);
    setPhase(result.status === 'approved' ? 'approved' : 'held');
  };

  const startOver = () => {
    void clearPendingOrder();
    setOrder(null);
    setClaim(null);
    setProblem(null);
    setPhase('choosing');
  };

  /** For someone whose payment was approved on another launch, or by hand. */
  const recheck = async () => {
    setProblem(null);
    const back = phase;
    setPhase('rechecking');
    await syncLicence({ force: true });
    if (gone.current) return;
    setPhase(back);
    // Read fresh: `status` is this render's copy and predates the sync.
    if (!licence().entitled) {
      setProblem(
        'Nothing has come through on this account yet. If you sent a screenshot for review, it will show here once it is approved.',
      );
    }
  };

  const showSubscribed = status.entitled && !renewing && phase !== 'approved';

  return (
    <Modal transparent visible animationType="none" onRequestClose={canClose ? onClose : () => BackHandler.exitApp()}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={canClose ? onClose : undefined} />
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
        <ScrollView bounces={false} contentContainerStyle={styles.scroll}>
          {showSubscribed ? (
            <Subscribed
              status={status}
              t={t}
              onClose={onClose}
              onRenew={() => {
                setRenewing(true);
                setPhase('choosing');
              }}
            />
          ) : phase === 'approved' && claim?.status === 'approved' ? (
            <Approved claim={claim} t={t} onClose={onClose} />
          ) : phase === 'held' && claim && claim.status !== 'approved' && claim.status !== 'error' ? (
            <Held
              claim={claim}
              t={t}
              onRetry={() => {
                setClaim(null);
                setPhase('pay');
              }}
              onRecheck={recheck}
              onClose={onClose}
            />
          ) : order && phase !== 'choosing' && phase !== 'starting' ? (
            <Pay
              order={order}
              phase={phase}
              t={t}
              onUpload={upload}
              onStartOver={startOver}
            />
          ) : (
            <Choose
              plans={plans}
              plan={plan}
              onPick={setPlan}
              busy={phase === 'starting' || phase === 'rechecking'}
              reason={renewing ? undefined : reason}
              renewing={renewing}
              t={t}
              onContinue={begin}
              canClose={canClose}
              session={!!session}
              onClose={onClose}
            />
          )}

          {problem ? (
            <Text style={[styles.fine, { color: fixed.warn }]}>{problem}</Text>
          ) : null}

          {session && !showSubscribed && phase !== 'approved' && phase !== 'held' ? (
            <Pressable
              onPress={recheck}
              disabled={phase === 'rechecking' || phase === 'reading' || phase === 'uploading'}
              accessibilityRole="button"
              style={({ pressed }) => [styles.secondary, pressed && { opacity: 0.6 }]}
            >
              <Text style={[styles.secondaryLabel, { color: t.onDim }]}>
                {phase === 'rechecking' ? 'Checking…' : 'I have already paid'}
              </Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

type Tokens = ReturnType<typeof useTheme>['t'];

function Header({ eyebrow, title, t }: { eyebrow: string; title: string; t: Tokens }) {
  return (
    <>
      <Text style={[styles.eyebrow, { color: t.accent }]}>{eyebrow}</Text>
      <Text style={[styles.title, { color: t.on }]}>{title}</Text>
    </>
  );
}

function Primary({
  label,
  icon,
  busy,
  disabled,
  onPress,
  t,
}: {
  label: string;
  icon: keyof typeof MaterialIcons.glyphMap;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
  t: Tokens;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy || disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.primary,
        { backgroundColor: t.accent },
        (pressed || busy || disabled) && { opacity: 0.75 },
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

function Secondary({ label, onPress, t }: { label: string; onPress: () => void; t: Tokens }) {
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

/**
 * Signed out. One job: say why an account is needed and open it. The sheet
 * closes first, and the account sheet sends the user back here once they are
 * in — see `openAccount({ next: 'paywall' })`.
 */
function SignInFirst({ t, reason, onClose }: { t: Tokens; reason?: string; onClose: () => void }) {
  return (
    <>
      <Header eyebrow="Spool" title="Keep saving and playing" t={t} />
      <Text style={[styles.body, { color: t.onDim }]}>
        {reason ??
          'A subscription lifts the limits on saving. Everything already on your device stays yours either way — nothing you have saved is ever taken back.'}
      </Text>
      <Text style={[styles.body, { color: t.onDim }]}>
        Sign in first. What you pay is added to your Spool account, so it works on every phone
        you sign in on.
      </Text>
      <Primary
        label="Sign in or create an account"
        icon="person-outline"
        onPress={() => {
          onClose();
          openAccount({ next: 'paywall', reason });
        }}
        t={t}
      />
    </>
  );
}

function Choose({
  plans,
  plan,
  onPick,
  busy,
  reason,
  renewing,
  t,
  onContinue,
  canClose = true,
  session = false,
  onClose,
}: {
  canClose?: boolean;
  session?: boolean;
  onClose?: () => void;
  plans: LivePlan[];
  plan: string;
  onPick: (p: string) => void;
  busy: boolean;
  reason?: string;
  renewing: boolean;
  t: Tokens;
  onContinue: () => void;
}) {
  const currentPlan = plans.find((p) => p.code === plan) || plans[0];
  const continueLabel = busy ? 'One moment' : (currentPlan ? `Continue — ${currentPlan.amount}` : 'Continue');

  return (
    <>
      <Header
        eyebrow={canClose ? 'Spool' : 'Subscription Required'}
        title={renewing ? 'Pay for another period' : (canClose ? 'Keep saving and playing' : 'App Locked')}
        t={t}
      />
      <Text style={[styles.body, { color: t.onDim }]}>
        {renewing
          ? 'Whatever you pay now is added after the time you already have.'
          : (reason ??
            (canClose
              ? 'A subscription lifts the limits on saving. Everything already on your device stays yours either way — nothing you have saved is ever taken back.'
              : 'Your free trial has ended. Subscribe to an active plan to unlock Spool, enjoy background music playback, and save unlimited videos.'))}
      </Text>

      {plans.map((p) => (
        <PlanRow
          key={p.code}
          plan={p}
          selected={plan === p.code}
          disabled={busy}
          onPick={() => onPick(p.code)}
          t={t}
        />
      ))}

      <Primary
        label={continueLabel}
        icon="lock-outline"
        busy={busy}
        onPress={onContinue}
        t={t}
      />
      {!session ? (
        <Secondary
          label="Already have an account? Sign in"
          onPress={() => {
            onClose?.();
            openAccount({ next: 'paywall', mode: 'signin', reason });
          }}
          t={t}
        />
      ) : null}
      {!canClose ? (
        <Secondary
          label="Exit Spool"
          onPress={() => BackHandler.exitApp()}
          t={t}
        />
      ) : null}
      <Text style={[styles.fine, { color: t.onDim }]}>
        You pay by UPI from your own app, then upload a screenshot of the payment here.
      </Text>
    </>
  );
}

const LOCAL_PAYMENT_QR = require('../../assets/paymentqrcode.jpeg');

function PaymentQrImage({ order }: { order: Order }) {
  const [failed, setFailed] = useState(false);
  const { server } = endpoint();
  const remoteUri = order.qrImageUrl
    ? (order.qrImageUrl.startsWith('http') ? order.qrImageUrl : `${server}${order.qrImageUrl}`)
    : null;

  const source = !failed && remoteUri ? { uri: remoteUri } : LOCAL_PAYMENT_QR;

  return (
    <Image
      source={source}
      defaultSource={LOCAL_PAYMENT_QR}
      onError={() => setFailed(true)}
      style={styles.qrImage}
      resizeMode="contain"
      accessibilityLabel="UPI Payment QR Code"
    />
  );
}

function CopyableFact({
  label,
  value,
  subtext,
  gap,
  t,
}: {
  label: string;
  value: string;
  subtext?: string | null;
  gap?: boolean;
  t: Tokens;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    Clipboard.setString(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <View style={gap ? styles.gap : null}>
      <View style={styles.factLabelRow}>
        <Text style={[styles.factLabel, { color: t.onDim }]}>{label}</Text>
        <Pressable
          onPress={copy}
          accessibilityRole="button"
          accessibilityLabel={`Copy ${label}`}
          hitSlop={6}
          style={({ pressed }) => [styles.copyPill, pressed && { opacity: 0.6 }]}
        >
          <MaterialIcons
            name={copied ? 'check' : 'content-copy'}
            size={11}
            color={copied ? fixed.saved : t.accent}
          />
          <Text style={[styles.copyPillText, { color: copied ? fixed.saved : t.accent }]}>
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </Pressable>
      </View>
      <Text selectable style={[styles.factValue, { color: t.on }]}>
        {value}
      </Text>
      {subtext ? (
        <Text selectable style={[styles.planNote, { color: t.onDim }]}>
          {subtext}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The order. A button for paying on this phone, a QR for paying from another,
 * and the UPI ID and order code as text the user can select — because some
 * UPI apps refuse `upi://` links from other apps, and a payment made by typing
 * the ID in by hand is still a payment.
 */
function planDisplayName(code?: string | null): string {
  if (code === 'annual') return 'Yearly';
  if (code === 'daily') return '1-Day Pass';
  return 'Monthly';
}

function Pay({
  order,
  phase,
  t,
  onUpload,
  onStartOver,
}: {
  order: Order;
  phase: Phase;
  t: Tokens;
  onUpload: () => void;
  onStartOver: () => void;
}) {
  const amount = formatRupees(order.amountPaise);
  const working = phase === 'reading' || phase === 'uploading';
  return (
    <>
      <Header eyebrow={`${planDisplayName(order.plan)} plan`} title={`Scan QR to Pay ${amount}`} t={t} />

      <View style={styles.qrRow}>
        <View style={styles.qr}>
          <PaymentQrImage order={order} />
        </View>
        <View style={styles.qrFacts}>
          <CopyableFact label="UPI ID" value={order.vpa} subtext={order.payee} t={t} />
          <CopyableFact label="Order code" value={order.order} gap t={t} />
          <Text style={[styles.factLabel, styles.gap, { color: t.onDim }]}>Amount</Text>
          <Text selectable style={[styles.factValue, { color: t.on }]}>{amount}</Text>
        </View>
      </View>

      <Text style={[styles.body, { color: t.onDim }]}>
        Scan this QR code with any UPI app (Google Pay, PhonePe, Paytm, Amazon Pay) or pay to the UPI ID. Pay exactly {amount}, then upload your payment screenshot below to activate.
      </Text>

      <Primary
        label={
          phase === 'reading'
            ? 'Reading the screenshot'
            : phase === 'uploading'
              ? 'Sending'
              : 'Upload payment screenshot'
        }
        icon="image"
        busy={working}
        onPress={onUpload}
        t={t}
      />
      {!working ? <Secondary label="Start over" onPress={onStartOver} t={t} /> : null}
    </>
  );
}

function Approved({
  claim,
  t,
  onClose,
}: {
  claim: Extract<Claim, { status: 'approved' }>;
  t: Tokens;
  onClose: () => void;
}) {
  return (
    <>
      <Header eyebrow="Paid" title="You are all set" t={t} />
      <View style={[styles.facts, { backgroundColor: t.tint }]}>
        <Fact label="Plan" value={planDisplayName(claim.plan)} t={t} />
        <Fact label="Paid through" value={claim.paidThrough ? formatDate(claim.paidThrough) : '—'} t={t} />
      </View>
      <Text style={[styles.body, { color: t.onDim }]}>
        Nothing renews on its own — pay again before that date to keep going. Anything you have
        already saved stays on your device regardless.
      </Text>
      <Secondary label="Close" onPress={onClose} t={t} />
    </>
  );
}

/**
 * Review or rejected. The reasons are the server's own sentences, listed as
 * they came — they are already written for a person, and rewording them here
 * would put a second, drifting copy of the parser's rules in the app.
 */
function Held({
  claim,
  t,
  onRetry,
  onRecheck,
  onClose,
}: {
  claim: Extract<Claim, { status: 'review' | 'rejected' }>;
  t: Tokens;
  onRetry: () => void;
  onRecheck: () => void;
  onClose: () => void;
}) {
  const [problem, setProblem] = useState<string | null>(null);
  const send = () => {
    setProblem(null);
    Linking.openURL(whatsappUrl(claim.whatsapp, claim.message)).catch(() =>
      setProblem('WhatsApp could not be opened on this phone.'),
    );
  };
  return (
    <>
      <Header
        eyebrow={claim.status === 'review' ? 'Needs a look' : 'Not accepted'}
        title={claim.status === 'review' ? 'A person will check this one' : 'This screenshot did not check out'}
        t={t}
      />
      {claim.reasons.length ? (
        <View style={styles.reasons}>
          {claim.reasons.map((why) => (
            <View key={why} style={styles.reason}>
              <MaterialIcons name="info-outline" size={16} color={fixed.warn} />
              <Text style={[styles.reasonText, { color: t.on }]}>{why}</Text>
            </View>
          ))}
        </View>
      ) : null}
      <Text style={[styles.body, { color: t.onDim }]}>
        If you have paid, send the screenshot to Spool on WhatsApp. The message is written for you
        and includes your order code — attach the screenshot in WhatsApp before sending, because
        it cannot be attached from here. Your plan is added as soon as it is checked.
      </Text>
      <Primary label="Send screenshot on WhatsApp" icon="chat" onPress={send} t={t} />
      {problem ? <Text style={[styles.fine, { color: fixed.warn }]}>{problem}</Text> : null}
      <Secondary label="I have paid • Check approval" onPress={onRecheck} t={t} />
      <Secondary label="Try another screenshot" onPress={onRetry} t={t} />
      <Secondary label="Close" onPress={onClose} t={t} />
    </>
  );
}

/**
 * What a subscriber sees if they open this again.
 *
 * The date it is paid through, and a way to pay for the next period — which
 * has to exist now that nothing renews by itself. There is still no "manage"
 * or "cancel": there is nothing running that could be cancelled.
 */
function Subscribed({
  status,
  t,
  onClose,
  onRenew,
}: {
  status: ReturnType<typeof useLicence>;
  t: Tokens;
  onClose: () => void;
  onRenew: () => void;
}) {
  const days = daysLeft(status);
  return (
    <>
      <Header eyebrow="Subscribed" title="You are all set" t={t} />
      <View style={[styles.facts, { backgroundColor: t.tint }]}>
        <Fact label="Plan" value={planDisplayName(status.plan)} t={t} />
        <Fact
          label="Paid through"
          value={status.paidThrough ? formatDate(status.paidThrough) : 'Active'}
          t={t}
        />
        {days !== null ? (
          <Fact label="Left" value={`${days} ${days === 1 ? 'day' : 'days'}`} t={t} />
        ) : null}
      </View>
      <Text style={[styles.body, { color: t.onDim }]}>
        Nothing renews on its own. Pay for another period whenever you like — it is added after
        the time you already have. Anything you have saved stays on your device regardless.
      </Text>
      <Primary label="Pay for another period" icon="add" onPress={onRenew} t={t} />
      <Secondary label="Close" onPress={onClose} t={t} />
    </>
  );
}

function PlanRow({
  plan,
  selected,
  disabled,
  onPick,
  t,
}: {
  plan: LivePlan;
  selected: boolean;
  disabled: boolean;
  onPick: () => void;
  t: Tokens;
}) {
  return (
    <Pressable
      onPress={onPick}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${plan.amount} ${plan.per}. ${plan.note}`}
      style={({ pressed }) => [
        styles.plan,
        { backgroundColor: t.tint, borderColor: selected ? t.accent : 'transparent' },
        pressed && { opacity: 0.8 },
      ]}
    >
      <View style={styles.planText}>
        {/* Mono, because a price is a fact the user can check — the same rule
            that puts the trial's day count in mono. */}
        <Text style={[styles.planPrice, { color: t.on }]}>
          {plan.amount} <Text style={[styles.planPer, { color: t.onDim }]}>{plan.per}</Text>
        </Text>
        <Text style={[styles.planNote, { color: t.onDim }]}>{plan.note}</Text>
      </View>
      <MaterialIcons
        name={selected ? 'radio-button-checked' : 'radio-button-unchecked'}
        size={20}
        color={selected ? t.accent : t.onDim}
      />
    </Pressable>
  );
}

function Fact({ label, value, t }: { label: string; value: string; t: Tokens }) {
  return (
    <View style={styles.fact}>
      <Text style={[styles.factLabel, { color: t.onDim }]}>{label}</Text>
      <Text style={[styles.factValue, { color: t.on }]}>{value}</Text>
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
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
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
  body: {
    ...type.body,
    paddingHorizontal: space.gutter,
    marginTop: space.insideChip,
    marginBottom: space.insideChip,
  },
  plan: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: space.gutter,
    marginBottom: space.row,
    paddingHorizontal: space.gutter,
    paddingVertical: space.row,
    borderRadius: radius.art,
    borderWidth: 1,
  },
  planText: { flex: 1, gap: 2 },
  planPrice: { ...type.monoStrong, fontSize: 16 },
  planPer: { ...type.mono, fontSize: 12 },
  planNote: { ...type.body, fontSize: 12.5 },
  facts: {
    flexDirection: 'row',
    marginHorizontal: space.gutter,
    marginTop: space.insideChip,
    marginBottom: space.insideChip,
    paddingVertical: space.row,
    borderRadius: radius.art,
  },
  fact: { flex: 1, alignItems: 'center', gap: 3 },
  factLabel: { ...type.section, fontSize: 9.5, letterSpacing: 0.6 },
  factValue: { ...type.monoStrong, fontSize: 13 },
  qrRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.gutter,
    marginHorizontal: space.gutter,
    marginTop: space.gutter,
  },
  qr: {
    width: 148,
    height: 148,
    borderRadius: radius.art,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrImage: {
    width: 148,
    height: 148,
  },
  qrFacts: { flex: 1, gap: 2 },
  factLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  copyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: radius.art,
  },
  copyPillText: {
    fontFamily: 'Manrope_600SemiBold',
    fontSize: 10,
    lineHeight: 13,
  },
  gap: { marginTop: space.insideChip },
  reasons: { marginHorizontal: space.gutter, marginTop: space.insideChip, gap: space.insideChip },
  reason: { flexDirection: 'row', gap: space.insideChip, alignItems: 'flex-start' },
  reasonText: { ...type.body, flex: 1 },
  primary: {
    height: size.target,
    marginTop: space.insideChip,
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
