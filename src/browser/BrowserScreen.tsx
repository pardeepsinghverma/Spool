import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, PermissionsAndroid, Platform, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, type WebViewNavigation } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import type { Format } from '../core/engine';
import {
  hasSeenFirstRun,
  loadDownloads,
  markFirstRunSeen,
  saveDownloads,
  type DownloadRecord,
} from '../core/storage';
import {
  IS_PREVIEW,
  initEngine,
  listFormats,
  publishToGallery,
  startDownload,
  type VideoMeta,
} from '../core/ytdlp';
import { DownloadsScreen, type DownloadItem } from '../screens/DownloadsScreen';
import { FirstRunScreen } from '../screens/FirstRunScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { QualitySheet, type SheetMode } from '../sheets/QualitySheet';
import { useTheme } from '../ui/ThemeContext';
import { motion } from '../ui/theme';
import { ADBLOCK_SCRIPT } from './adblock';
import { BrowserChrome } from './BrowserChrome';
import type { DownloadState } from './DownloadButton';
import { isAudioPick, toFormatRows, toQuickPicks } from './formatView';
import { pillFor } from './Pill';
import { POTOKEN_SCRIPT, type PoTokenMessage } from './potoken';
import {
  HOME_URL,
  NAV_SCRIPT,
  USER_AGENT,
  extractVideoId,
  hostOf,
  type NavMessage,
} from './youtube';

type Screen = 'firstrun' | 'browse' | 'downloads' | 'settings';

/** Both hooks must beat the page's own scripts, so they share one injection. */
const PRELOAD = ADBLOCK_SCRIPT + POTOKEN_SCRIPT;

export function BrowserScreen() {
  const { t, reduced, setName } = useTheme();
  const webview = useRef<WebView>(null);

  const [screen, setScreen] = useState<Screen>('browse');
  const [booted, setBooted] = useState(false);
  const [url, setUrl] = useState(HOME_URL);
  const [title, setTitle] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);

  const [dl, setDl] = useState<DownloadState>('idle');
  const [progress, setProgress] = useState(0);
  const [sheet, setSheet] = useState<SheetMode | null>(null);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [quality, setQuality] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [records, setRecords] = useState<DownloadRecord[]>([]);

  const token = useRef<{ poToken: string; visitorData: string }>({
    poToken: '',
    visitorData: '',
  });
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cancelRef = useRef<(() => void) | null>(null);

  const videoId = useMemo(() => extractVideoId(url), [url]);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  // Boot: restore state, warm the engine, ask for notification permission.
  useEffect(() => {
    let alive = true;
    (async () => {
      const [seen, saved] = await Promise.all([hasSeenFirstRun(), loadDownloads()]);
      if (!alive) return;
      setRecords(saved);
      setScreen(seen ? 'browse' : 'firstrun');
      setBooted(true);
      // Extracting the bundled Python takes a moment on first launch; do it now
      // rather than making the user wait on their first download.
      initEngine().catch(() => {});
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      clearTimers();
      cancelRef.current?.();
    },
    [clearTimers],
  );

  useEffect(() => {
    if (records.length) saveDownloads(records);
  }, [records]);

  // Page nav resets the button, which restarts the pulse — once per navigation.
  useEffect(() => {
    if (dl === 'working' || dl === 'resolving') return;
    setDl(videoId ? 'ready' : 'idle');
    setProgress(0);
  }, [videoId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sheet) {
        setSheet(null);
        return true;
      }
      if (screen === 'downloads' || screen === 'settings') {
        setScreen('browse');
        return true;
      }
      if (screen === 'browse' && canGoBack) {
        webview.current?.goBack();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [sheet, screen, canGoBack]);

  const flashNotice = useCallback(
    (text: string) => {
      setNotice(text);
      later(() => setNotice(null), 3000);
    },
    [later],
  );

  const onNavigationStateChange = useCallback((nav: WebViewNavigation) => {
    setUrl(nav.url);
    setCanGoBack(nav.canGoBack);
    setCanGoForward(nav.canGoForward);
    if (nav.title) setTitle(nav.title.replace(/\s*-\s*YouTube\s*$/, '').trim());
  }, []);

  const onMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let message: NavMessage | PoTokenMessage;
      try {
        message = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }

      if (message.type === 'potoken') {
        // Keep whichever values we have; a later message may only carry one.
        if (message.poToken) token.current.poToken = message.poToken;
        if (message.visitorData) token.current.visitorData = message.visitorData;
        return;
      }

      if (message.type !== 'nav') return;
      setUrl(message.url);
      setTitle(message.title);
      if (message.theme) setName(message.theme);
    },
    [setName],
  );

  const finish = useCallback(
    (record: DownloadRecord) => {
      setRecords((prev) => [record, ...prev]);
      setDl('done');
      setProgress(1);
      later(() => {
        setDl(videoId ? 'ready' : 'idle');
        setProgress(0);
      }, motion.doneHold);
    },
    [videoId, later],
  );

  const beginDownload = useCallback(
    async (pickId: string) => {
      if (!meta || !videoId) return;
      const clean = pickId.replace(':explicit', '');
      const format = meta.formats.find((f: Format) => f.id === clean);
      if (!format) return;

      const audioOnly = isAudioPick(clean, meta.formats);
      const label = audioOnly ? 'audio' : `${format.height}p`;
      const jobId = `${videoId}-${Date.now()}`;

      setQuality(label);
      setSheet(null);
      setError(null);
      setDl('working');
      setProgress(0);

      const job = startDownload(
        {
          id: jobId,
          ref: { videoId, url, title: meta.title || title },
          format,
          audioOnly,
          token: token.current,
        },
        (p) => setProgress(p.fraction ?? 0),
      );
      cancelRef.current = job.cancel;

      try {
        const out = await job.promise;
        // Only a MediaStore record makes the file visible in Gallery.
        const uri = await publishToGallery(out.path, meta.title || title, audioOnly);
        finish({
          id: jobId,
          title: meta.title || title || 'Untitled',
          quality: label,
          uri,
          bytes: out.bytes,
          audioOnly,
          savedAt: Date.now(),
          state: 'saved',
        });
      } catch (e: any) {
        cancelRef.current = null;
        if (e?.code === 'E_CANCELLED') {
          setDl(videoId ? 'ready' : 'idle');
          setProgress(0);
          return;
        }
        const reason = readableError(e);
        setError(reason);
        setDl('failed');
        setRecords((prev) => [
          {
            id: jobId,
            title: meta.title || title || 'Untitled',
            quality: label,
            audioOnly,
            savedAt: Date.now(),
            state: 'failed',
            error: reason,
          },
          ...prev,
        ]);
      }
    },
    [meta, videoId, url, title, finish],
  );

  const resolve = useCallback(async () => {
    if (!videoId) return;
    clearTimers();
    setError(null);
    setDl('resolving');
    try {
      const info = await listFormats({ videoId, url, title }, token.current);
      setMeta(info);
      setDl('ready');
      setSheet(info.formats.length ? 'quick' : 'empty');
    } catch (e) {
      setError(readableError(e));
      setDl('failed');
      setSheet('error');
    }
  }, [videoId, url, title, clearTimers]);

  const onDownloadPress = useCallback(() => {
    switch (dl) {
      case 'ready':
        resolve();
        break;
      case 'working':
        cancelRef.current?.();
        cancelRef.current = null;
        break;
      case 'failed':
        resolve();
        break;
      case 'done':
        setScreen('downloads');
        break;
      default:
        break;
    }
  }, [dl, resolve]);

  const pill = useMemo(() => {
    const base = pillFor(dl, t, reduced, {
      host: hostOf(url),
      percent: Math.round(progress * 100),
      quality,
      error: error ?? undefined,
      preview: IS_PREVIEW,
    });
    if (!notice) return base;
    return { ...base, text: notice, icon: 'check' as const, bg: t.surface, color: t.text };
  }, [dl, t, reduced, url, progress, quality, error, notice]);

  const onPillPress = useCallback(() => {
    if (dl === 'failed') resolve();
    else setScreen('downloads');
  }, [dl, resolve]);

  const items: DownloadItem[] = useMemo(
    () =>
      records.map((r) => ({
        id: r.id,
        icon: r.state === 'failed' ? 'error-outline' : r.audioOnly ? 'music-note' : 'movie',
        title: r.title,
        meta:
          r.state === 'failed'
            ? `Failed · ${r.error ?? 'unknown error'}`
            : `Saved · ${r.quality}${r.bytes ? ` · ${Math.round(r.bytes / 1_000_000)} MB` : ''}`,
        metaTone: r.state === 'failed' ? 'warn' : 'dim',
        progress: null,
        actions: [
          r.state === 'failed'
            ? { icon: 'refresh', label: 'Retry', tone: 'warn', onPress: resolve }
            : { icon: 'photo-library', label: 'Open in gallery', onPress: () => {} },
          {
            icon: 'delete-outline',
            label: 'Remove from list',
            tone: 'dim',
            onPress: () => setRecords((prev) => prev.filter((x) => x.id !== r.id)),
          },
        ],
      })),
    [records, resolve],
  );

  const failedToday = records.filter(
    (r) => r.state === 'failed' && Date.now() - r.savedAt < 86_400_000,
  ).length;

  if (!booted) return <View style={[styles.root, { backgroundColor: t.chrome }]} />;

  if (screen === 'firstrun') {
    return (
      <SafeAreaView
        style={[styles.root, { backgroundColor: t.chrome }]}
        edges={['top', 'bottom']}
      >
        <FirstRunScreen
          onStart={async () => {
            await markFirstRunSeen();
            await requestNotificationPermission();
            setScreen('browse');
          }}
          onChooseFolder={() => flashNotice('Files are saved to Movies/Spool')}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.root, { backgroundColor: t.chrome }]}
      edges={['top', 'bottom']}
    >
      <View style={styles.page}>
        {/* Never unmounted — leaving Downloads must not cost a page reload. */}
        <WebView
          ref={webview}
          source={{ uri: HOME_URL }}
          userAgent={USER_AGENT}
          injectedJavaScriptBeforeContentLoaded={PRELOAD}
          injectedJavaScript={NAV_SCRIPT}
          onMessage={onMessage}
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

        {screen === 'downloads' && (
          <View style={StyleSheet.absoluteFill}>
            <DownloadsScreen
              items={items}
              failureBanner={
                failedToday >= 3
                  ? {
                      title: `${failedToday} downloads failed today`,
                      detail: 'The extraction engine may need updating',
                      onUpdate: () => setScreen('settings'),
                    }
                  : null
              }
              onBack={() => setScreen('browse')}
            />
          </View>
        )}

        {screen === 'settings' && (
          <View style={StyleSheet.absoluteFill}>
            <SettingsScreen onBack={() => setScreen('browse')} onNotice={flashNotice} />
          </View>
        )}
      </View>

      <BrowserChrome
        pill={pill}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        loadProgress={screen === 'browse' ? loadProgress : null}
        downloadState={dl}
        downloadProgress={progress}
        onBack={() => webview.current?.goBack()}
        onForward={() => webview.current?.goForward()}
        onHome={() =>
          webview.current?.injectJavaScript(`location.href='${HOME_URL}';true;`)
        }
        onDownload={onDownloadPress}
        onPillPress={onPillPress}
      />

      <QualitySheet
        mode={sheet}
        video={
          meta
            ? {
                title: meta.title,
                channel: meta.channel,
                duration: formatDuration(meta.durationSeconds),
              }
            : null
        }
        quickPicks={toQuickPicks(meta?.formats ?? [])}
        formats={toFormatRows(meta?.formats ?? [])}
        emptyReason={
          error ?? 'This page has no downloadable media — it may be live or members-only.'
        }
        onPick={beginDownload}
        onExpand={() => setSheet('all')}
        onCollapse={() => setSheet('quick')}
        onClose={() => setSheet(null)}
        onUpdateEngine={() => {
          setSheet(null);
          setScreen('settings');
        }}
        onRetry={resolve}
      />
    </SafeAreaView>
  );
}

/** yt-dlp's stderr is developer-facing; the pill needs one short sentence. */
function readableError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  // yt-dlp's real message is the only useful diagnostic when extraction breaks,
  // and the user-facing string deliberately throws it away.
  console.warn('[spool] engine error:', raw);
  const text = raw.toLowerCase();
  if (text.includes('sign in') || text.includes('bot')) return 'Sign-in required for this video';
  if (text.includes('private')) return 'This video is private';
  if (text.includes('members-only') || text.includes('members only')) return 'Members-only video';
  if (text.includes('live')) return 'Live streams can’t be downloaded yet';
  if (text.includes('unavailable')) return 'Video unavailable';
  if (text.includes('403') || text.includes('forbidden')) return 'YouTube refused the request';
  if (text.includes('network') || text.includes('resolve host') || text.includes('timed out')) {
    return 'Couldn’t reach YouTube';
  }
  if (text.includes('space')) return 'Not enough storage';
  return 'Extraction failed — try updating the engine';
}

const formatDuration = (seconds: number): string => {
  if (!seconds || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

async function requestNotificationPermission() {
  if (Platform.OS !== 'android' || Platform.Version < 33) return;
  try {
    await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS as any,
    );
  } catch {
    // Downloads still work without it; only the progress notification is lost.
  }
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  page: { flex: 1, overflow: 'hidden' },
});
