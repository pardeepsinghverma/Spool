import { useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, size, space, type } from '../ui/theme';
import { LAUNCH_PRICE, TRIAL_PRICE } from '../core/trial';
import { PRICES } from '../core/license';

type Props = {
  /** Finish onboarding and enter the app. */
  onDone: () => void;
  /** Finish onboarding and open the offer that applies to this build. */
  onSeeOffer: () => void;
  /** A subscriber never sees the premium step. */
  entitled: boolean;
  /** Trial builds pitch the tester offer; every other build pitches the subscription. */
  trial: boolean;
};

type Feature = {
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  text: string;
};

/**
 * Three screens, once — welcome, what it does, and the offer.
 *
 * This replaced a single `FirstRunScreen`, and two things about it are not
 * preference.
 *
 * **The legal acknowledgement is on the first step, not the last.** It is what
 * the button on that step acknowledges, so it has to be adjacent to it; putting
 * it under a sales pitch would make the acceptance a side effect of dismissing
 * an offer. The steps are also driven by their buttons rather than by swiping,
 * for the same reason — a swipe past a legal notice is not an acknowledgement
 * of it. [UI.md § Copy rules](../../docs/UI.md) requires the position stated
 * once on first run, and this is that once.
 *
 * **The premium step is the only sales surface on this path.** It replaces the
 * sheet that used to be raised the instant first run ended, rather than adding
 * to it — see `onSeeOffer`. Two pitches ten seconds apart is the "sold to
 * twice" failure the paywall section already names, and a fresh install is
 * where it would land hardest.
 *
 * A subscriber does not get the step at all. Someone who has paid is not a
 * prospect, and selling to them is the clearest possible signal that an app is
 * not paying attention.
 */
export function OnboardingScreen({ onDone, onSeeOffer, entitled, trial }: Props) {
  const { t, reduced } = useTheme();
  const [step, setStep] = useState(0);
  const fade = useRef(new Animated.Value(1)).current;

  /**
   * Built once, and conditionally: with the premium step absent the dots have
   * to show two, not three with one unreachable. A progress indicator that
   * counts a step nobody will see is a small lie of the same family as a
   * chevron with nowhere to go.
   */
  const steps = useMemo(() => (entitled ? ['welcome', 'features'] : ['welcome', 'features', 'premium']), [entitled]);
  const last = step === steps.length - 1;

  /**
   * Cross-fade rather than slide. The steps are different lengths, and a slide
   * between panels of different heights either clips the taller one or leaves
   * the shorter one floating — both of which read as a rendering bug rather
   * than as a transition.
   */
  const go = (next: number) => {
    if (reduced) {
      setStep(next);
      return;
    }
    Animated.timing(fade, {
      toValue: 0,
      duration: motion.sheetIn / 2,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start(() => {
      setStep(next);
      Animated.timing(fade, {
        toValue: 1,
        duration: motion.sheetIn / 2,
        easing: Easing.bezier(...bezier.emphasized),
        useNativeDriver: true,
      }).start();
    });
  };

  const advance = () => (last ? onDone() : go(step + 1));

  return (
    <View style={[styles.root, { backgroundColor: t.deep }]}>
      <Animated.View style={[styles.panel, { opacity: fade }]}>
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {steps[step] === 'welcome' && <Welcome />}
          {steps[step] === 'features' && <Features />}
          {steps[step] === 'premium' && <Premium trial={trial} />}
        </ScrollView>
      </Animated.View>

      <View style={[styles.footer, { borderTopColor: fixed.line }]}>
        <View style={styles.dots}>
          {steps.map((name, i) => (
            <View
              key={name}
              style={[
                styles.dot,
                { backgroundColor: i === step ? t.accent : fixed.line },
                i === step && styles.dotOn,
              ]}
            />
          ))}
        </View>

        <Pressable
          onPress={advance}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: t.accent },
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.primaryText, { color: t.onAccent }]}>
            {step === 0 ? 'I understand — continue' : last ? 'Start browsing' : 'Next'}
          </Text>
        </Pressable>

        {/*
          The offer is reachable from the premium step and from nowhere else on
          this path. It is secondary to "Start browsing" on purpose: the app has
          to be usable before it is worth paying for, and a first run whose
          loudest control is a purchase has the order backwards.
        */}
        {steps[step] === 'premium' && (
          <Pressable
            onPress={onSeeOffer}
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={[styles.secondaryText, { color: t.accent }]}>See the offer</Text>
          </Pressable>
        )}

        {step > 0 && (
          <Pressable
            onPress={() => go(step - 1)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          >
            <Text style={[styles.secondaryText, { color: t.onDim }]}>Back</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

function Welcome() {
  const { t } = useTheme();
  return (
    <>
      <Text style={[styles.kicker, { color: t.accent }]}>Welcome</Text>
      <Text style={[styles.heading, { color: t.on }]}>Browse YouTube. Keep what's yours.</Text>
      <Text style={[styles.lede, { color: t.onDim }]}>
        No ads, no account needed, no tracking. Everything you keep stays on this phone and plays
        without a connection.
      </Text>

      {/*
        Stated once, on first run, and again under Profile — the copy rule this
        screen exists to satisfy. It sits above the button that acknowledges it
        rather than three steps later.
      */}
      <View style={[styles.legalBlock, { borderColor: fixed.line }]}>
        <Text style={[styles.legal, { color: t.onDim }]}>
          Downloading from YouTube violates YouTube's Terms of Service. This app is built for
          your own uploads, Creative Commons and public-domain material, and personal offline
          use where your local law allows it. You are responsible for what you download.
        </Text>
      </View>
    </>
  );
}

/**
 * What the app does, in the order someone meets it.
 *
 * The download button is first because it is the only control that has ever
 * needed explaining — it is grey until a video is open, which reads as broken
 * if nobody says so once.
 */
const FEATURES: Feature[] = [
  {
    icon: 'file-download',
    title: 'One button, in the corner of Browse',
    text: 'Grey until you open a video. Tap it to keep the video, hold it to choose a quality.',
  },
  {
    icon: 'wifi-off',
    title: 'Plays with no connection',
    text: 'Anything you keep is a real file on this phone, in Music/Spool or Movies/Spool.',
  },
  {
    icon: 'lock',
    title: 'Keeps playing with the screen off',
    text: 'Both the library and the page you are browsing, with the usual controls on the lock screen.',
  },
  {
    icon: 'playlist-play',
    title: 'Playlists and a library that rebuilds itself',
    text: 'Reinstall the app and your saved music is found again from the gallery.',
  },
  {
    icon: 'replay',
    title: 'Saves what you keep replaying',
    // It is ON by default (DEFAULT_SETTINGS.enabled). This line said "Off by
    // default" while a fresh install shipped it on — found on the S21 FE,
    // 2026-09-19 — and first run is the one screen a tester reads in full.
    text: 'Play something a few times and it is kept automatically. On from the start; turn it off in Profile.',
  },
];

function Features() {
  const { t } = useTheme();
  return (
    <>
      <Text style={[styles.kicker, { color: t.accent }]}>What it does</Text>
      <Text style={[styles.heading, { color: t.on }]}>A library, not a downloader.</Text>
      <Text style={[styles.lede, { color: t.onDim }]}>
        Downloading is how things get in. The library is the point.
      </Text>

      {FEATURES.map((feature) => (
        <View key={feature.title} style={styles.feature}>
          <MaterialIcons name={feature.icon} size={20} color={t.accent} />
          <View style={styles.featureBody}>
            <Text style={[styles.featureTitle, { color: t.on }]}>{feature.title}</Text>
            <Text style={[styles.featureText, { color: t.onDim }]}>{feature.text}</Text>
          </View>
        </View>
      ))}
    </>
  );
}

const REASONS = [
  'No limit on how many you keep, or how long they are.',
  'Every quality the video has, up to 4K.',
  'It keeps working. The extractor updates itself when YouTube changes something.',
  'Nothing you have already saved is ever taken back.',
];

/**
 * Why premium — and the price of exactly one offer.
 *
 * Which offer depends on the build, and the two must never be shown together:
 * a tester meets `TRIAL_PRICE` here and `TRIAL_PRICE` in the sheet that
 * follows, everyone else meets the subscription in both. Printing the
 * subscription price here and the tester price a tap later would be two
 * different answers to the same question.
 *
 * `LAUNCH_PRICE` is labelled as expected rather than struck through. Nobody has
 * ever paid it, so a crossed-out number would be an invented fact printed to
 * make a discount look bigger — the rule that also keeps a storage meter off
 * Profile until there is a real measurement behind it.
 */
function Premium({ trial }: { trial: boolean }) {
  const { t } = useTheme();
  return (
    <>
      <Text style={[styles.kicker, { color: t.accent }]}>Premium</Text>
      <Text style={[styles.heading, { color: t.on }]}>Everything, without the limits.</Text>
      <Text style={[styles.lede, { color: t.onDim }]}>
        {trial
          ? 'This build is a pre-release and it expires. The full copy does not.'
          : 'The free app keeps what it keeps. Premium removes the ceiling.'}
      </Text>

      {REASONS.map((reason) => (
        <View key={reason} style={styles.reason}>
          <MaterialIcons name="check" size={17} color={t.accent} />
          <Text style={[styles.reasonText, { color: t.onDim }]}>{reason}</Text>
        </View>
      ))}

      <View style={[styles.price, { backgroundColor: t.tint }]}>
        <Text style={[styles.priceAmount, { color: t.on }]}>
          {trial ? `A full year for ${TRIAL_PRICE}` : `${PRICES.annual.amount} ${PRICES.annual.per}`}
        </Text>
        <Text style={[styles.priceNote, { color: t.onDim }]}>
          {trial
            ? `For people testing this build. The price at launch is expected to be ${LAUNCH_PRICE} a year.`
            : `${PRICES.annual.note} ${PRICES.monthly.amount} ${PRICES.monthly.per} if you would rather not commit.`}
        </Text>
      </View>

      {/*
        Said here rather than only in the sheet. It is the single thing most
        likely to be assumed otherwise, and the assumption is what stops people
        trying the app at all.
      */}
      <Text style={[styles.reassure, { color: t.onDim }]}>
        You can carry on without this. Nothing you have already saved is ever taken back.
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  panel: { flex: 1 },
  scroll: {
    flexGrow: 1,
    paddingHorizontal: space.section,
    paddingTop: space.header,
    paddingBottom: space.section,
  },

  kicker: { ...type.section, marginBottom: 14 },
  heading: { ...type.nowPlaying, marginBottom: space.row },
  lede: { ...type.body, fontSize: 13.5, lineHeight: 21, marginBottom: space.section },

  legalBlock: {
    marginTop: 'auto',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: space.gutter,
  },
  legal: { ...type.body, fontSize: 11.5, lineHeight: 18 },

  feature: {
    flexDirection: 'row',
    gap: space.row,
    alignItems: 'flex-start',
    marginBottom: space.section,
  },
  featureBody: { flex: 1 },
  featureTitle: { ...type.rowTitle, marginBottom: 3 },
  featureText: { ...type.body, fontSize: 12.5, lineHeight: 19 },

  reason: { flexDirection: 'row', gap: space.insideChip, alignItems: 'flex-start', marginBottom: 14 },
  reasonText: { ...type.body, fontSize: 12.5, lineHeight: 19, flex: 1 },

  price: {
    borderRadius: radius.art,
    padding: space.gutter,
    marginTop: space.insideChip,
    marginBottom: space.gutter,
  },
  priceAmount: { ...type.rowTitle, marginBottom: 4 },
  priceNote: { ...type.body, fontSize: 12.5, lineHeight: 19 },
  reassure: { ...type.body, fontSize: 12, lineHeight: 18 },

  footer: {
    paddingHorizontal: space.section,
    paddingTop: space.gutter,
    paddingBottom: space.insideChip,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  dots: { flexDirection: 'row', gap: space.iconToLabel + 2, justifyContent: 'center', marginBottom: space.gutter },
  dot: { width: 6, height: 6, borderRadius: 3 },
  dotOn: { width: 18 },

  primary: {
    height: size.target,
    borderRadius: size.target / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { ...type.rowTitle },

  secondary: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 2 },
  secondaryText: { ...type.body, fontSize: 13 },

  pressed: { opacity: 0.6 },
});
