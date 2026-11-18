import { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../ui/ThemeContext';
import { bezier, fixed, motion, radius, space, type } from '../ui/theme';

const REPO_URL = 'https://github.com/pardeepsinghverma/Spool';
const ISSUES_URL = 'https://github.com/pardeepsinghverma/Spool/issues';
const LICENSE_URL = 'https://www.gnu.org/licenses/gpl-3.0.html';

export function SubscribeSheet({
  onClose,
  reason,
}: {
  onClose: () => void;
  reason?: string;
  canClose?: boolean;
}) {
  const { t, reduced } = useTheme();
  const rise = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: reduced ? 0 : motion.sheetIn,
      easing: Easing.bezier(...bezier.emphasized),
      useNativeDriver: true,
    }).start();
  }, [rise, reduced]);

  const openUrl = (url: string) => {
    void Linking.openURL(url).catch(() => {});
  };

  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.scrim} accessibilityLabel="Close" onPress={onClose} />
      <Animated.View
        style={[
          styles.sheet,
          {
            backgroundColor: t.tint,
            transform: [
              {
                translateY: rise.interpolate({
                  inputRange: [0, 1],
                  outputRange: [600, 0],
                }),
              },
            ],
          },
        ]}
      >
        <View style={styles.handle} />

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          {/* Header */}
          <View style={styles.header}>
            <View style={[styles.badge, { backgroundColor: t.accent }]}>
              <MaterialIcons name="code" size={16} color={t.onAccent} />
              <Text style={[styles.badgeText, { color: t.onAccent }]}>OPEN SOURCE</Text>
            </View>
            <Text style={[styles.title, { color: t.on }]}>Spool v2.0</Text>
            <Text style={[styles.subtitle, { color: t.onDim }]}>
              Free and open-source dual-engine media player licensed under GNU GPL v3.0.
            </Text>
          </View>

          {reason && (
            <View style={[styles.reasonBanner, { borderColor: fixed.line }]}>
              <MaterialIcons name="info-outline" size={18} color={fixed.warn} />
              <Text style={[styles.reasonText, { color: t.onDim }]}>{reason}</Text>
            </View>
          )}

          {/* Features Card */}
          <View style={[styles.card, { backgroundColor: t.deep }]}>
            <Text style={[styles.cardTitle, { color: t.on }]}>Features & Freedom</Text>

            <View style={styles.featureRow}>
              <MaterialIcons name="check-circle" size={18} color={fixed.saved} />
              <Text style={[styles.featureText, { color: t.onDim }]}>
                100% Free & Unrestricted — No subscriptions, trial periods, or forced paywalls.
              </Text>
            </View>

            <View style={styles.featureRow}>
              <MaterialIcons name="check-circle" size={18} color={fixed.saved} />
              <Text style={[styles.featureText, { color: t.onDim }]}>
                Seamless Dual-Engine — Instant switching between YouTube & YouTube Music.
              </Text>
            </View>

            <View style={styles.featureRow}>
              <MaterialIcons name="check-circle" size={18} color={fixed.saved} />
              <Text style={[styles.featureText, { color: t.onDim }]}>
                True Background Audio — Screen-off audio and media notification playback controls.
              </Text>
            </View>

            <View style={styles.featureRow}>
              <MaterialIcons name="check-circle" size={18} color={fixed.saved} />
              <Text style={[styles.featureText, { color: t.onDim }]}>
                Ad-Free Experience — Native ad blocking with zero tracker injection.
              </Text>
            </View>

            <View style={styles.featureRow}>
              <MaterialIcons name="check-circle" size={18} color={fixed.saved} />
              <Text style={[styles.featureText, { color: t.onDim }]}>
                Offline Downloads — Audio & Video downloading powered by embedded yt-dlp.
              </Text>
            </View>
          </View>

          {/* Source & Community Card */}
          <View style={[styles.card, { backgroundColor: t.deep }]}>
            <Text style={[styles.cardTitle, { color: t.on }]}>Source Code & Community</Text>
            <Text style={[styles.cardBody, { color: t.onDim }]}>
              Spool is community-driven. You can inspect the source code, report bugs, suggest features, or submit pull requests on GitHub.
            </Text>

            <Pressable
              style={({ pressed }) => [
                styles.actionBtn,
                { backgroundColor: t.accent },
                pressed && { opacity: 0.8 },
              ]}
              onPress={() => openUrl(REPO_URL)}
            >
              <MaterialIcons name="open-in-new" size={18} color={t.onAccent} />
              <Text style={[styles.actionBtnText, { color: t.onAccent }]}>View on GitHub</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.secondaryBtn,
                { borderColor: fixed.line },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => openUrl(ISSUES_URL)}
            >
              <MaterialIcons name="bug-report" size={18} color={t.on} />
              <Text style={[styles.secondaryBtnText, { color: t.on }]}>Report Issue / Feedback</Text>
            </Pressable>

            <Pressable
              style={({ pressed }) => [
                styles.secondaryBtn,
                { borderColor: fixed.line, marginTop: 8 },
                pressed && { opacity: 0.7 },
              ]}
              onPress={() => openUrl(LICENSE_URL)}
            >
              <MaterialIcons name="verified-user" size={18} color={t.on} />
              <Text style={[styles.secondaryBtnText, { color: t.on }]}>GNU General Public License v3.0</Text>
            </Pressable>
          </View>

          {/* Close button */}
          <Pressable
            style={({ pressed }) => [
              styles.closeBtn,
              { backgroundColor: fixed.line },
              pressed && { opacity: 0.7 },
            ]}
            onPress={onClose}
          >
            <Text style={[styles.closeBtnText, { color: t.on }]}>Close</Text>
          </Pressable>
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: '88%',
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    overflow: 'hidden',
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: fixed.mute,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 8,
  },
  scrollContent: {
    padding: space.gutter,
    paddingBottom: 36,
  },
  header: {
    alignItems: 'center',
    marginBottom: 20,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    marginBottom: 10,
    gap: 6,
  },
  badgeText: {
    ...type.section,
    fontSize: 10,
    letterSpacing: 0.8,
  },
  title: {
    ...type.nowPlaying,
    fontSize: 24,
    marginBottom: 6,
  },
  subtitle: {
    ...type.body,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
    paddingHorizontal: 16,
  },
  reasonBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: radius.card,
    borderWidth: 1,
    marginBottom: 16,
    gap: 10,
  },
  reasonText: {
    ...type.body,
    fontSize: 13,
    flex: 1,
  },
  card: {
    padding: 16,
    borderRadius: radius.card,
    marginBottom: 16,
  },
  cardTitle: {
    ...type.rowTitle,
    fontSize: 16,
    marginBottom: 12,
  },
  cardBody: {
    ...type.body,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 16,
  },
  featureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 10,
    gap: 10,
  },
  featureText: {
    ...type.body,
    fontSize: 13,
    lineHeight: 18,
    flex: 1,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.pill,
    marginBottom: 8,
    gap: 8,
  },
  actionBtnText: {
    ...type.rowTitle,
    fontSize: 14,
  },
  secondaryBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: radius.pill,
    borderWidth: 1,
    gap: 8,
  },
  secondaryBtnText: {
    ...type.rowTitle,
    fontSize: 13,
  },
  closeBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.pill,
    marginTop: 8,
  },
  closeBtnText: {
    ...type.rowTitle,
    fontSize: 14,
  },
});
