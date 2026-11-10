import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import * as log from '../core/log';
import { remember } from '../core/tokens';
import {
  hasSeenFirstRun,
  loadLastMode,
  markFirstRunSeen,
  saveLastMode,
} from '../core/storage';
import {
  setScreenOrientation,
  signOutOfYouTube,
  writeTextFile,
} from '../core/ytdlp';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { NowPlayingBar } from '../player/NowPlayingBar';
import { ProfileScreen } from '../screens/ProfileScreen';
import { TabBar, type Tab } from '../shell/TabBar';
import { PreReleaseSheet } from '../sheets/PreReleaseSheet';
import { refreshTrial, setPreReleaseOpener, trial, useIsAppLocked } from '../core/trial';
import {
  licence,
  loadLicenceFacts,
  refreshLicence,
  setPaywallOpener,
  syncLicence,
  watchLicence,
} from '../core/license';
import { type AccountIntent, loadAccount, setAccountOpener } from '../core/account';
import { usePlayNotice } from '../core/playLock';
import { AccountSheet } from '../sheets/AccountSheet';
import { PlayLockSheet } from '../sheets/PlayLockSheet';
import { SubscribeSheet } from '../sheets/SubscribeSheet';
import { useTheme } from '../ui/ThemeContext';
import { fixed, tintFromDominant } from '../ui/theme';
import { ADBLOCK_SCRIPT } from './adblock';
import { BACKGROUND_SCRIPT, type MediaMessage } from './background';
import { useBackgroundPlayback } from './useBackgroundPlayback';
import { POTOKEN_SCRIPT, type PoTokenMessage } from './potoken';
import {
  HOME_URL,
  MUSIC_HOME_URL,
  NAV_SCRIPT,
  USER_AGENT,
  isMusicUrl,
  type FullscreenMessage,
  type NavMessage,
} from './youtube';

type Screen = 'firstrun' | Tab;

/**
 * All three hooks must beat the page's own scripts, so they share one
 * injection. Background playback is the strictest of them: it only works if its
 * visibility listeners are registered ahead of YouTube's.
 */
const PRELOAD = ADBLOCK_SCRIPT + POTOKEN_SCRIPT + BACKGROUND_SCRIPT;

export function BrowserScreen() {
  const { t, setTint } = useTheme();
  const webview = useRef<WebView>(null);

  const [screen, setScreen] = useState<Screen>('browse');
  const [booted, setBooted] = useState(false);
  const [url, setUrl] = useState(HOME_URL);
  const [title, setTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [preRelease, setPreRelease] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  const [accountIntent, setAccountIntent] = useState<AccountIntent | null>(null);
  const playNotice = usePlayNotice();
  const appLocked = useIsAppLocked();

  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashNotice = useCallback((text: string, ms = 4000) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = setTimeout(() => setNotice(null), ms);
  }, []);

  const [entry, setEntry] = useState(HOME_URL);
  const entryRef = useRef(HOME_URL);
  const [webviewKey, setWebviewKey] = useState(0);

  const isMusic = useMemo(() => isMusicUrl(url), [url]);

  const {
    onMedia: onMediaMessage,
    toggle: toggleBrowserMedia,
    stopPage: stopBrowserMedia,
  } = useBackgroundPlayback(webview, {
    canSave: () => false,
    onSave: () => {},
    revision: '0',
  });

  // Global sheet openers
  useEffect(() => {
    setPaywallOpener(() => setPaywallOpen(true));
    setAccountOpener((intent) => setAccountIntent(intent));
    setPreReleaseOpener(() => setPreRelease(true));
  }, []);

  // Sync licences and account on mount
  useEffect(() => {
    void (async () => {
      try {
        await loadLicenceFacts();
        await loadAccount();
        syncLicence();
        refreshTrial();
      } catch (e) {
        log.warn('boot', 'licence sync failed', log.describe(e));
      }
    })();
    return watchLicence();
  }, []);

  // Boot check for first-run onboarding and last selected mode
  useEffect(() => {
    void (async () => {
      const [seen, mode] = await Promise.all([hasSeenFirstRun(), loadLastMode()]);
      if (mode === 'ytmusic') {
        setEntry(MUSIC_HOME_URL);
        setUrl(MUSIC_HOME_URL);
      }
      setScreen(seen ? 'browse' : 'firstrun');
      setBooted(true);
    })();
  }, []);

  // Keep entryRef current
  useEffect(() => {
    if (/^https?:/i.test(url)) entryRef.current = url;
  }, [url]);

  // Back button handling
  useEffect(() => {
    const handler = () => {
      if (isFullscreen) {
        setScreenOrientation('portrait');
        setIsFullscreen(false);
        return true;
      }
      if (screen === 'browse' && canGoBack) {
        webview.current?.goBack();
        return true;
      }
      if (screen !== 'browse') {
        setScreen('browse');
        return true;
      }
      return false;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => sub.remove();
  }, [screen, canGoBack, isFullscreen]);

  // Handle messages from the injected script
  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      const raw = event.nativeEvent.data;
      if (!raw || raw[0] !== '{') return;

      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'potoken') {
        const po = msg as PoTokenMessage;
        if (po.poToken) {
          remember(po.videoId, {
            poToken: po.poToken,
            visitorData: po.visitorData,
            mintedAt: Date.now(),
          });
        }
        return;
      }

      if (msg.type === 'nav') {
        const nav = msg as NavMessage;
        if (nav.url) {
          setUrl(nav.url);
          setTitle(nav.title || '');
        }
        if (nav.theme) {
          setTint(tintFromDominant(nav.theme === 'dark' ? '#111111' : '#f5f5f5'));
        }
        return;
      }

      if (msg.type === 'fullscreen') {
        const fs = msg as FullscreenMessage;
        setIsFullscreen(fs.isFullscreen);
        setScreenOrientation(fs.isFullscreen ? fs.orientation : 'portrait');
        return;
      }

      if (msg.type === 'media') {
        onMediaMessage(msg as MediaMessage);
      }
    },
    [onMediaMessage, setTint]
  );

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    setCanGoBack(nav.canGoBack);
    if (nav.url) setUrl(nav.url);
  }, []);

  const onRenderProcessGone = useCallback(() => {
    log.error('webview', 'renderer crashed', { restoring: entryRef.current });
    setEntry(entryRef.current);
    setWebviewKey((k) => k + 1);
  }, []);

  const signOut = useCallback(() => {
    Alert.alert(
      'Sign out of YouTube?',
      'This device forgets the session: cookies and site data.\n\n' +
        'It does not sign you out at Google — only Google can end the session ' +
        'there, from your account’s device list.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign out',
          style: 'destructive',
          onPress: () => {
            void signOutOfYouTube()
              .then(() => {
                setEntry(HOME_URL);
                setUrl(HOME_URL);
                setWebviewKey((k) => k + 1);
                setScreen('browse');
                flashNotice('Signed out on this device');
              })
              .catch((e) => {
                log.warn('ui', 'sign out failed', log.describe(e));
                flashNotice('Couldn’t sign out. Nothing was changed.');
              });
          },
        },
      ]
    );
  }, [flashNotice]);

  const exportDiagnostics = useCallback(() => {
    void (async () => {
      try {
        const prev = await log.previous();
        const body = log.dump(prev, log.entries(), {
          app: `Spool ${Platform.OS} api ${Platform.Version}`,
          trial: (() => {
            const tr = trial();
            return tr.trial ? `yes, intact=${tr.intact}` : 'no';
          })(),
        });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const name = `spool-log-${stamp}.txt`;
        await writeTextFile(name, 'text/plain', body);
        flashNotice(`Wrote ${name} to Downloads/Spool`, 6000);
      } catch (e: any) {
        log.warn('diag', 'export failed', log.describe(e));
        flashNotice(e?.message ?? 'Could not write the log');
      }
    })();
  }, [flashNotice]);

  const diagnosticsSummary = useMemo(() => {
    const all = log.entries();
    const bad = all.filter((e) => e.level === 'error').length;
    return `${all.length} entries · ${bad} errors`;
  }, []);

  if (!booted) return null;

  if (screen === 'firstrun') {
    return (
      <OnboardingScreen
        onDone={() => {
          void markFirstRunSeen();
          setScreen('browse');
        }}
        onSeeOffer={() => {
          void markFirstRunSeen();
          setScreen('browse');
          setPaywallOpen(true);
        }}
        entitled={licence().entitled}
        trial={trial().trial}
      />
    );
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: t.deep }]}
      edges={isFullscreen ? [] : ['top', 'bottom']}
    >
      <View style={styles.page}>
        {/* Browser header with YouTube / YouTube Music switcher and controls */}
        {screen === 'browse' && !isFullscreen && (
          <View
            style={[
              styles.browserHeader,
              { backgroundColor: t.chrome, borderBottomColor: fixed.line },
            ]}
          >
            {canGoBack ? (
              <Pressable
                onPress={() => webview.current?.goBack()}
                accessibilityRole="button"
                accessibilityLabel="Go back"
                style={({ pressed }) => [styles.navIconButton, pressed && { opacity: 0.6 }]}
              >
                <MaterialIcons name="arrow-back" size={20} color={t.on} />
              </Pressable>
            ) : (
              <View style={styles.navIconPlaceholder} />
            )}

            <View style={[styles.modeSwitcher, { backgroundColor: t.surface }]}>
              <Pressable
                onPress={() => {
                  if (isMusic) {
                    setUrl(HOME_URL);
                    setEntry(HOME_URL);
                    void saveLastMode('youtube');
                    webview.current?.injectJavaScript(`
                      try { window.onbeforeunload = null; } catch (e) {}
                      window.location.href = '${HOME_URL}';
                      true;
                    `);
                  }
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: !isMusic }}
                accessibilityLabel="YouTube mode"
                style={[
                  styles.modeTab,
                  !isMusic && [styles.modeTabActive, { backgroundColor: t.accent }],
                ]}
              >
                <MaterialIcons
                  name="smart-display"
                  size={15}
                  color={!isMusic ? t.onAccent : t.onDim}
                />
                <Text
                  style={[
                    styles.modeTabText,
                    { color: !isMusic ? t.onAccent : t.onDim },
                    !isMusic && styles.modeTabTextActive,
                  ]}
                >
                  YouTube
                </Text>
              </Pressable>

              <Pressable
                onPress={() => {
                  if (!isMusic) {
                    setUrl(MUSIC_HOME_URL);
                    setEntry(MUSIC_HOME_URL);
                    void saveLastMode('ytmusic');
                    webview.current?.injectJavaScript(`
                      try { window.onbeforeunload = null; } catch (e) {}
                      window.location.href = '${MUSIC_HOME_URL}';
                      true;
                    `);
                  }
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: isMusic }}
                accessibilityLabel="YouTube Music mode"
                style={[
                  styles.modeTab,
                  isMusic && [styles.modeTabActive, { backgroundColor: t.accent }],
                ]}
              >
                <MaterialIcons
                  name="music-note"
                  size={15}
                  color={isMusic ? t.onAccent : t.onDim}
                />
                <Text
                  style={[
                    styles.modeTabText,
                    { color: isMusic ? t.onAccent : t.onDim },
                    isMusic && styles.modeTabTextActive,
                  ]}
                >
                  YT Music
                </Text>
              </Pressable>
            </View>

            <Pressable
              onPress={() => webview.current?.reload()}
              accessibilityRole="button"
              accessibilityLabel="Reload page"
              style={({ pressed }) => [styles.navIconButton, pressed && { opacity: 0.6 }]}
            >
              <MaterialIcons name="refresh" size={20} color={t.onDim} />
            </Pressable>
          </View>
        )}

        {screen === 'browse' && !isFullscreen && loadProgress !== null && (
          <View style={[styles.loadProgressTrack, { backgroundColor: t.surface }]}>
            <View
              style={[
                styles.loadProgressBar,
                {
                  backgroundColor: t.accent,
                  width: `${Math.round(loadProgress * 100)}%`,
                },
              ]}
            />
          </View>
        )}

        {/* Never unmounted: switching to Account tab must not cost a page reload */}
        <WebView
          key={webviewKey}
          ref={webview}
          source={{ uri: entry }}
          userAgent={USER_AGENT}
          injectedJavaScriptBeforeContentLoaded={PRELOAD}
          injectedJavaScript={NAV_SCRIPT}
          onMessage={onMessage}
          onRenderProcessGone={onRenderProcessGone}
          onNavigationStateChange={onNavigationStateChange}
          onLoadProgress={({ nativeEvent }) =>
            setLoadProgress(nativeEvent.progress < 1 ? nativeEvent.progress : null)
          }
          onLoadEnd={() => setLoadProgress(null)}
          onShouldStartLoadWithRequest={(request) => /^https?:/i.test(request.url)}
          allowsBackForwardNavigationGestures
          mediaPlaybackRequiresUserAction={false}
          allowsFullscreenVideo
          domStorageEnabled
          javaScriptEnabled
          thirdPartyCookiesEnabled
          setSupportMultipleWindows={false}
          style={{ flex: 1, backgroundColor: t.pageBg }}
        />

        {screen === 'browse' && notice && (
          <View
            accessibilityLiveRegion="polite"
            style={[
              styles.notice,
              { backgroundColor: t.tint, borderColor: fixed.line },
            ]}
          >
            <MaterialIcons name="info-outline" size={16} color={fixed.warn} />
            <Text style={[styles.noticeText, { color: t.on }]}>{notice}</Text>
          </View>
        )}

        {/* Screen 2: Account & Subscriptions */}
        {(screen === 'account' || screen === 'profile') && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.deep }]}>
            <ProfileScreen
              onSignOut={signOut}
              onDiagnostics={exportDiagnostics}
              diagnosticsSummary={diagnosticsSummary}
            />
          </View>
        )}
      </View>

      {/* Mini player shown above the TabBar when on Account tab and web media is active */}
      {screen !== 'browse' && (
        <NowPlayingBar
          onOpen={() => setScreen('browse')}
          page={{
            onOpen: () => setScreen('browse'),
            onToggle: toggleBrowserMedia,
            onStop: stopBrowserMedia,
          }}
        />
      )}

      {!isFullscreen && <TabBar value={screen} onChange={setScreen} />}

      {appLocked && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: t.chrome,
              zIndex: 998,
              alignItems: 'center',
              justifyContent: 'center',
              padding: 24,
            },
          ]}
        >
          <MaterialIcons name="lock" size={48} color={fixed.warn} style={{ marginBottom: 16 }} />
          <Text
            style={{
              color: t.on,
              fontSize: 20,
              fontWeight: '700',
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            Trial Period Ended
          </Text>
          <Text
            style={{
              color: t.onDim,
              fontSize: 14,
              textAlign: 'center',
              lineHeight: 20,
              marginBottom: 24,
            }}
          >
            This pre-release trial build has reached its expiry date. Subscribe to continue enjoying ad-free streaming.
          </Text>
          <Pressable
            onPress={() => setPaywallOpen(true)}
            style={{
              backgroundColor: t.accent,
              paddingHorizontal: 24,
              paddingVertical: 12,
              borderRadius: 24,
            }}
          >
            <Text style={{ color: t.onAccent, fontWeight: '700', fontSize: 15 }}>View Plans</Text>
          </Pressable>
        </View>
      )}

      {preRelease && !appLocked && <PreReleaseSheet onClose={() => setPreRelease(false)} />}
      {playNotice && <PlayLockSheet notice={playNotice} />}
      {paywallOpen && <SubscribeSheet onClose={() => setPaywallOpen(false)} />}
      {accountIntent && (
        <AccountSheet
          intent={accountIntent}
          onClose={() => setAccountIntent(null)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1, overflow: 'hidden' },
  browserHeader: {
    height: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  modeSwitcher: {
    flexDirection: 'row',
    borderRadius: 20,
    padding: 3,
  },
  modeTab: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
  },
  modeTabActive: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.15,
    shadowRadius: 1,
    elevation: 1,
  },
  modeTabText: {
    fontSize: 12,
    fontWeight: '500',
    letterSpacing: 0.2,
  },
  modeTabTextActive: {
    fontWeight: '700',
  },
  navIconButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navIconPlaceholder: {
    width: 34,
    height: 34,
  },
  loadProgressTrack: {
    height: 2,
    width: '100%',
    overflow: 'hidden',
  },
  loadProgressBar: {
    height: '100%',
  },
  notice: {
    position: 'absolute',
    bottom: 12,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
});
