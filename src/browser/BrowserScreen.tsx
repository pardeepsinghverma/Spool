import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  BackHandler,
  Easing,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
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
  setSecureWindow,
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
import { fixed, size, tintFromDominant } from '../ui/theme';
import { ADBLOCK_SCRIPT } from './adblock';
import { BACKGROUND_SCRIPT, type MediaMessage } from './background';
import { useBackgroundPlayback } from './useBackgroundPlayback';
import { POTOKEN_SCRIPT, type PoTokenMessage } from './potoken';
import {
  HOME_URL,
  MUSIC_HOME_URL,
  NAV_SCRIPT,
  USER_AGENT,
  isSignInPage,
  type BarScrollMessage,
  type FullscreenMessage,
  type NavMessage,
} from './youtube';

type Screen = 'firstrun' | 'browse' | 'account';

/**
 * Injected scripts for ad blocking, poToken minting, and background audio.
 */
const PRELOAD = ADBLOCK_SCRIPT + POTOKEN_SCRIPT + BACKGROUND_SCRIPT;

export function BrowserScreen() {
  const { t, setTint } = useTheme();
  const insets = useSafeAreaInsets();

  // Dual WebViews: YouTube and YouTube Music stay loaded in parallel for zero-reload switching
  const ytWebview = useRef<WebView>(null);
  const musicWebview = useRef<WebView>(null);
  const activeWebviewRef = useRef<WebView | null>(null);

  const [mode, setMode] = useState<'youtube' | 'ytmusic'>('youtube');
  const [screen, setScreen] = useState<Screen>('browse');
  const [booted, setBooted] = useState(false);

  const [urlYt, setUrlYt] = useState(HOME_URL);
  const [urlMusic, setUrlMusic] = useState(MUSIC_HOME_URL);
  const [canGoBackYt, setCanGoBackYt] = useState(false);
  const [canGoBackMusic, setCanGoBackMusic] = useState(false);
  const [loadProgressYt, setLoadProgressYt] = useState<number | null>(null);
  const [loadProgressMusic, setLoadProgressMusic] = useState<number | null>(null);

  const [webviewKeyYt, setWebviewKeyYt] = useState(0);
  const [webviewKeyMusic, setWebviewKeyMusic] = useState(0);

  const [isFullscreen, setIsFullscreen] = useState(false);

  // Sheets & locks
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

  // Bottom bar auto-slide animation on scroll
  const barAnim = useRef(new Animated.Value(0)).current;
  const barHiddenRef = useRef(false);
  const [barHidden, setBarHiddenState] = useState(false);
  const barHeight = size.tabBar + insets.bottom;

  const setBarHidden = useCallback(
    (hidden: boolean) => {
      if (screen !== 'browse' || appLocked) {
        if (barHiddenRef.current) {
          barHiddenRef.current = false;
          setBarHiddenState(false);
          Animated.timing(barAnim, {
            toValue: 0,
            duration: 200,
            useNativeDriver: true,
          }).start();
        }
        return;
      }
      if (barHiddenRef.current === hidden) return;
      barHiddenRef.current = hidden;
      setBarHiddenState(hidden);
      Animated.timing(barAnim, {
        toValue: hidden ? barHeight + 10 : 0,
        duration: hidden ? 250 : 200,
        easing: hidden
          ? Easing.bezier(0.4, 0, 1, 1)
          : Easing.bezier(0, 0, 0.2, 1),
        useNativeDriver: true,
      }).start();
    },
    [barAnim, barHeight, screen, appLocked]
  );

  // Keep active webview ref pointing to currently selected or playing webview
  useEffect(() => {
    activeWebviewRef.current = mode === 'youtube' ? ytWebview.current : musicWebview.current;
  }, [mode]);

  // Background audio & media service
  const {
    onMedia: onMediaPlaybackMessage,
    toggle: toggleBrowserMedia,
    stopPage: stopBrowserMedia,
  } = useBackgroundPlayback(activeWebviewRef, {
    canSave: () => false,
    onSave: () => {},
    revision: '0',
  });

  const onYtMedia = useCallback(
    (mediaMsg: MediaMessage) => {
      if (mediaMsg.playing) {
        // When YouTube plays, pause YT Music
        musicWebview.current?.injectJavaScript(`
          try {
            var v = document.querySelector('video');
            if (v && !v.paused) v.pause();
          } catch (e) {}
          true;
        `);
        activeWebviewRef.current = ytWebview.current;
      }
      onMediaPlaybackMessage(mediaMsg);
    },
    [onMediaPlaybackMessage]
  );

  const onMusicMedia = useCallback(
    (mediaMsg: MediaMessage) => {
      if (mediaMsg.playing) {
        // When YT Music plays, pause YouTube
        ytWebview.current?.injectJavaScript(`
          try {
            var v = document.querySelector('video');
            if (v && !v.paused) v.pause();
          } catch (e) {}
          true;
        `);
        activeWebviewRef.current = musicWebview.current;
      }
      onMediaPlaybackMessage(mediaMsg);
    },
    [onMediaPlaybackMessage]
  );

  const stopBoth = useCallback(() => {
    ytWebview.current?.injectJavaScript(`try { var v = document.querySelector('video'); if (v) v.pause(); } catch(e){}`);
    musicWebview.current?.injectJavaScript(`try { var v = document.querySelector('video'); if (v) v.pause(); } catch(e){}`);
    stopBrowserMedia();
  }, [stopBrowserMedia]);

  // Stop playback when app is locked
  useEffect(() => {
    if (appLocked) {
      stopBoth();
    }
  }, [appLocked, stopBoth]);

  // Sheet openers
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

  // Boot check for onboarding and last mode
  useEffect(() => {
    void (async () => {
      const [seen, lastMode] = await Promise.all([hasSeenFirstRun(), loadLastMode()]);
      if (lastMode === 'ytmusic') {
        setMode('ytmusic');
      } else {
        setMode('youtube');
      }
      setScreen(seen ? 'browse' : 'firstrun');
      setBooted(true);
    })();
  }, []);

  // FLAG_SECURE on Google sign-in pages
  useEffect(() => {
    const currentUrl = mode === 'youtube' ? urlYt : urlMusic;
    setSecureWindow(isSignInPage(currentUrl));
  }, [mode, urlYt, urlMusic]);

  useEffect(() => {
    return () => {
      setSecureWindow(false);
    };
  }, []);

  // Hardware back button
  useEffect(() => {
    const handler = () => {
      if (isFullscreen) {
        setScreenOrientation('portrait');
        setIsFullscreen(false);
        return true;
      }
      if (screen === 'browse') {
        const currentWv = mode === 'youtube' ? ytWebview.current : musicWebview.current;
        const canBack = mode === 'youtube' ? canGoBackYt : canGoBackMusic;
        if (canBack) {
          currentWv?.goBack();
          setBarHidden(false);
          return true;
        }
      }
      if (screen !== 'browse') {
        setScreen('browse');
        setBarHidden(false);
        return true;
      }
      return false;
    };

    const sub = BackHandler.addEventListener('hardwareBackPress', handler);
    return () => sub.remove();
  }, [screen, mode, canGoBackYt, canGoBackMusic, isFullscreen, setBarHidden]);

  // Shared message parser
  const handleMessage = useCallback(
    (
      event: WebViewMessageEvent,
      isYt: boolean,
      setUrl: (u: string) => void,
      onMedia: (m: MediaMessage) => void
    ) => {
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
        }
        if (nav.theme && ((isYt && mode === 'youtube') || (!isYt && mode === 'ytmusic'))) {
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
        onMedia(msg as MediaMessage);
        return;
      }

      if (msg.type === 'barScroll') {
        const s = msg as BarScrollMessage;
        setBarHidden(s.hidden);
        return;
      }
    },
    [mode, setTint, setBarHidden]
  );

  const onYtMessage = useCallback(
    (e: WebViewMessageEvent) => handleMessage(e, true, setUrlYt, onYtMedia),
    [handleMessage, onYtMedia]
  );

  const onMusicMessage = useCallback(
    (e: WebViewMessageEvent) => handleMessage(e, false, setUrlMusic, onMusicMedia),
    [handleMessage, onMusicMedia]
  );

  const onNavStateChangeYt = useCallback((nav: WebViewNavigation) => {
    setCanGoBackYt(nav.canGoBack);
    if (nav.url) {
      setUrlYt(nav.url);
      if (mode === 'youtube') setSecureWindow(isSignInPage(nav.url));
    }
  }, [mode]);

  const onNavStateChangeMusic = useCallback((nav: WebViewNavigation) => {
    setCanGoBackMusic(nav.canGoBack);
    if (nav.url) {
      setUrlMusic(nav.url);
      if (mode === 'ytmusic') setSecureWindow(isSignInPage(nav.url));
    }
  }, [mode]);

  const onRenderProcessGoneYt = useCallback(() => {
    log.error('webview', 'youtube renderer crashed', { restoring: HOME_URL });
    setWebviewKeyYt((k) => k + 1);
  }, []);

  const onRenderProcessGoneMusic = useCallback(() => {
    log.error('webview', 'ytmusic renderer crashed', { restoring: MUSIC_HOME_URL });
    setWebviewKeyMusic((k) => k + 1);
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
                setUrlYt(HOME_URL);
                setUrlMusic(MUSIC_HOME_URL);
                setWebviewKeyYt((k) => k + 1);
                setWebviewKeyMusic((k) => k + 1);
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

  const handleTabChange = useCallback(
    (tab: Tab) => {
      setBarHidden(false);
      if (tab === 'youtube') {
        setScreen('browse');
        setMode('youtube');
        void saveLastMode('youtube');
      } else if (tab === 'ytmusic') {
        setScreen('browse');
        setMode('ytmusic');
        void saveLastMode('ytmusic');
      } else if (tab === 'account' || tab === 'profile') {
        setScreen('account');
      }
    },
    [setBarHidden]
  );

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

  const activeLoadProgress = mode === 'youtube' ? loadProgressYt : loadProgressMusic;

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: t.deep }]}
      edges={isFullscreen ? [] : ['top']}
    >
      <View style={styles.page}>
        {/* Top thin loading bar when initial page loads */}
        {screen === 'browse' && !isFullscreen && activeLoadProgress !== null && (
          <View style={styles.loadProgressTrack}>
            <View
              style={[
                styles.loadProgressBar,
                {
                  backgroundColor: t.accent,
                  width: `${Math.round(activeLoadProgress * 100)}%`,
                },
              ]}
            />
          </View>
        )}

        {/* Dual WebViews: Both stay mounted for instant 0-second switching without reloads */}
        <View style={StyleSheet.absoluteFill}>
          {/* YouTube WebView */}
          <View
            style={[
              StyleSheet.absoluteFill,
              mode === 'youtube' ? styles.paneVisible : styles.paneHidden,
            ]}
            pointerEvents={mode === 'youtube' && screen === 'browse' ? 'auto' : 'none'}
          >
            <WebView
              key={webviewKeyYt}
              ref={ytWebview}
              source={{ uri: HOME_URL }}
              userAgent={USER_AGENT}
              injectedJavaScriptBeforeContentLoaded={PRELOAD}
              injectedJavaScript={NAV_SCRIPT}
              onMessage={onYtMessage}
              onRenderProcessGone={onRenderProcessGoneYt}
              onNavigationStateChange={onNavStateChangeYt}
              onLoadProgress={({ nativeEvent }) =>
                setLoadProgressYt(nativeEvent.progress < 1 ? nativeEvent.progress : null)
              }
              onLoadEnd={() => setLoadProgressYt(null)}
              onShouldStartLoadWithRequest={(request) => {
                if (!/^https?:/i.test(request.url)) return false;
                if (isSignInPage(request.url)) {
                  setSecureWindow(true);
                }
                return true;
              }}
              allowsBackForwardNavigationGestures
              mediaPlaybackRequiresUserAction={false}
              allowsFullscreenVideo
              domStorageEnabled
              javaScriptEnabled
              thirdPartyCookiesEnabled
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              mixedContentMode="never"
              saveFormDataDisabled
              geolocationEnabled={false}
              setSupportMultipleWindows={false}
              style={{ flex: 1, backgroundColor: t.pageBg }}
            />
          </View>

          {/* YouTube Music WebView */}
          <View
            style={[
              StyleSheet.absoluteFill,
              mode === 'ytmusic' ? styles.paneVisible : styles.paneHidden,
            ]}
            pointerEvents={mode === 'ytmusic' && screen === 'browse' ? 'auto' : 'none'}
          >
            <WebView
              key={webviewKeyMusic}
              ref={musicWebview}
              source={{ uri: MUSIC_HOME_URL }}
              userAgent={USER_AGENT}
              injectedJavaScriptBeforeContentLoaded={PRELOAD}
              injectedJavaScript={NAV_SCRIPT}
              onMessage={onMusicMessage}
              onRenderProcessGone={onRenderProcessGoneMusic}
              onNavigationStateChange={onNavStateChangeMusic}
              onLoadProgress={({ nativeEvent }) =>
                setLoadProgressMusic(nativeEvent.progress < 1 ? nativeEvent.progress : null)
              }
              onLoadEnd={() => setLoadProgressMusic(null)}
              onShouldStartLoadWithRequest={(request) => {
                if (!/^https?:/i.test(request.url)) return false;
                if (isSignInPage(request.url)) {
                  setSecureWindow(true);
                }
                return true;
              }}
              allowsBackForwardNavigationGestures
              mediaPlaybackRequiresUserAction={false}
              allowsFullscreenVideo
              domStorageEnabled
              javaScriptEnabled
              thirdPartyCookiesEnabled
              allowFileAccess={false}
              allowFileAccessFromFileURLs={false}
              allowUniversalAccessFromFileURLs={false}
              mixedContentMode="never"
              saveFormDataDisabled
              geolocationEnabled={false}
              setSupportMultipleWindows={false}
              style={{ flex: 1, backgroundColor: t.pageBg }}
            />
          </View>
        </View>

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
        {screen === 'account' && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: t.deep, zIndex: 5 }]}>
            <ProfileScreen
              onSignOut={signOut}
              onDiagnostics={exportDiagnostics}
              diagnosticsSummary={diagnosticsSummary}
            />
          </View>
        )}
      </View>

      {/* Slide-down Bottom Bar with NowPlayingBar & Mode Switcher */}
      {!isFullscreen && !appLocked && (
        <Animated.View
          style={[
            styles.bottomBarContainer,
            {
              transform: [{ translateY: barAnim }],
            },
          ]}
        >
          {screen !== 'browse' && (
            <NowPlayingBar
              onOpen={() => setScreen('browse')}
              page={{
                onOpen: () => setScreen('browse'),
                onToggle: toggleBrowserMedia,
                onStop: stopBoth,
              }}
            />
          )}

          <TabBar
            value={screen === 'account' ? 'account' : mode}
            onChange={handleTabChange}
          />
        </Animated.View>
      )}

      {/* Tap receiver when bottom bar is hidden to quickly reveal it */}
      {barHidden && !isFullscreen && !appLocked && screen === 'browse' && (
        <Pressable
          style={styles.showBarTouchZone}
          onPress={() => setBarHidden(false)}
          accessibilityRole="button"
          accessibilityLabel="Reveal navigation bar"
        />
      )}

      {/* Locked overlay until subscription is active */}
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
          <MaterialIcons name="lock" size={54} color={fixed.warn} style={{ marginBottom: 16 }} />
          <Text
            style={{
              color: t.on,
              fontSize: 22,
              fontWeight: '700',
              textAlign: 'center',
              marginBottom: 8,
            }}
          >
            Subscription Required
          </Text>
          <Text
            style={{
              color: t.onDim,
              fontSize: 14,
              textAlign: 'center',
              lineHeight: 22,
              marginBottom: 28,
              maxWidth: 320,
            }}
          >
            An active subscription is required to use Spool. Subscribe now to enjoy unlimited, ad-free YouTube and YouTube Music with background playback.
          </Text>
          <Pressable
            onPress={() => setPaywallOpen(true)}
            style={{
              backgroundColor: t.accent,
              paddingHorizontal: 28,
              paddingVertical: 14,
              borderRadius: 24,
              marginBottom: 14,
              minWidth: 220,
              alignItems: 'center',
            }}
          >
            <Text style={{ color: t.onAccent, fontWeight: '700', fontSize: 16 }}>
              View Plans & Subscribe
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setAccountIntent({})}
            style={{
              paddingHorizontal: 20,
              paddingVertical: 10,
            }}
          >
            <Text style={{ color: t.onDim, fontWeight: '600', fontSize: 14 }}>
              Already subscribed? Sign In
            </Text>
          </Pressable>
        </View>
      )}

      {preRelease && !appLocked && <PreReleaseSheet onClose={() => setPreRelease(false)} />}
      {playNotice && <PlayLockSheet notice={playNotice} />}
      {paywallOpen && (
        <SubscribeSheet
          onClose={() => {
            setPaywallOpen(false);
            void syncLicence({ force: true });
          }}
        />
      )}
      {accountIntent && (
        <AccountSheet
          intent={accountIntent}
          onClose={() => {
            setAccountIntent(null);
            void syncLicence({ force: true });
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1, overflow: 'hidden' },
  paneVisible: {
    zIndex: 1,
    opacity: 1,
  },
  paneHidden: {
    zIndex: 0,
    opacity: 0,
  },
  bottomBarContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 15,
  },
  showBarTouchZone: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 18,
    zIndex: 14,
  },
  loadProgressTrack: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    zIndex: 20,
    overflow: 'hidden',
  },
  loadProgressBar: {
    height: '100%',
  },
  notice: {
    position: 'absolute',
    bottom: 64,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    zIndex: 25,
  },
  noticeText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
  },
});
