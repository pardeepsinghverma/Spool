package com.afinitycode.spool.ytdlp

import android.accounts.Account
import android.accounts.AccountManager
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.WebView
import java.lang.ref.WeakReference
import androidx.palette.graphics.Palette
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import java.net.URL
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Bridge to yt-dlp via youtubedl-android.
 *
 * The engine runs a bundled Python 3.8 and can replace its own extractor at
 * runtime — which is the whole reason this app can be sideloaded and still keep
 * working when YouTube changes something.
 */
class YtDlpModule : Module() {

  private companion object {
    /** Long enough to resume tomorrow, short enough not to hoard gigabytes. */
    const val PARTIAL_MAX_AGE_MS = 24L * 60 * 60 * 1000

    /**
     * Every name yt-dlp gives something that is not yet a download.
     *
     * Read off a real 360p save rather than from the documentation, because
     * the list is longer than it looks:
     *
     *   ZbP4VNJhRUk.v360.f134.mp4.part   the video stream, arriving
     *   ZbP4VNJhRUk.v360.f134.mp4        the video stream, whole
     *   ZbP4VNJhRUk.v360.f251.webm       the audio stream, whole
     *   ZbP4VNJhRUk.v360.temp.mp4        the merge, in progress
     *   ZbP4VNJhRUk.v360.mp4             the download
     *
     * `.temp.` is the one that matters and the one that was missed. It is the
     * merge ffmpeg is still writing, it carries the container extension of the
     * real thing, and it does not match `.fNNN.` -- so a merge that failed
     * halfway would have been rescued as a truncated video and published as a
     * success. `.part-FragN` is here for the same reason: `File.extension`
     * reads it as `part-Frag7`, so an extension test alone does not catch it.
     */
    val INTERMEDIATE = Regex("\\.f\\d+\\.|\\.temp\\.|\\.part(-Frag\\d+)?$|\\.ytdl$")

    /**
     * Short edge of a cached cover. The largest surface that shows one is the
     * 320dp player square, so this covers it at 2x with room to spare — and
     * keeps a cover to tens of kilobytes rather than the ~1.8MB maxres
     * thumbnail yt-dlp embeds.
     */
    const val CACHE_EDGE = 640

    /** Above this luminance a row is picture, not letterbox padding. */
    const val BAR_LUMA = 22

    /**
     * How often the browser's WebView is told again that it is on screen.
     *
     * The real window visibility is owned by ViewRootImpl and our telling is
     * not recorded there, so this cannot be a one-shot: anything that makes
     * Android re-dispatch the truth would put the page back to sleep, and off
     * screen nothing would ever notice. A second is well inside the gap
     * between Chromium hiding a page and suspending its media, and the call
     * itself is a no-op when the state has not changed.
     */
    const val VISIBILITY_PIN_MS = 1000L
  }

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val running = ConcurrentHashMap<String, Boolean>()

  private val main = Handler(Looper.getMainLooper())

  /** The repeating "you are still visible", or null when nothing is pinned. */
  private var visibilityPin: Runnable? = null

  /** Found by walking the view tree once; the browser mounts exactly one. */
  private var browserView = WeakReference<WebView>(null)

  @Volatile
  private var initialised = false

  private var pendingAccountPromise: Promise? = null
  private val REQ_CHOOSE_ACCOUNT = 8923

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

  /**
   * Lock screen, notification and headset buttons land here. Whatever they are
   * really aiming at — a <video> element in the WebView or an expo-audio player
   * — lives in JavaScript, so all this does is carry the verb across.
   *
   * `value` is a position in seconds, and only `seek` uses it.
   */
  private val playbackCommands: (String, Double) -> Unit = { command, value ->
    runCatching {
      sendEvent(
        "onPlaybackCommand",
        Bundle().apply {
          putString("command", command)
          putDouble("value", value)
        },
      )
    }
  }

  override fun definition() = ModuleDefinition {
    Name("YtDlp")

    Events("onProgress", "onLog", "onPlaybackCommand")

    OnCreate {
      PlaybackCommandBus.register(playbackCommands)
    }

    AsyncFunction("initialize") { promise: Promise ->
      scope.launch {
        try {
          ensureInitialised()
          promise.resolve(YoutubeDL.getInstance().version(context) ?: "unknown")
        } catch (e: Throwable) {
          promise.reject("E_INIT", e.message ?: "Engine failed to initialise", e)
        }
      }
    }

    AsyncFunction("version") { promise: Promise ->
      scope.launch {
        try {
          ensureInitialised()
          promise.resolve(YoutubeDL.getInstance().version(context) ?: "unknown")
        } catch (e: Throwable) {
          promise.reject("E_VERSION", e.message ?: "Version unavailable", e)
        }
      }
    }

    /**
     * Returns yt-dlp's raw single-JSON dump. Parsing happens in TypeScript so
     * the format model lives in one place.
     */
    AsyncFunction("listFormats") { url: String, poToken: String?, visitorData: String?, clients: String?, promise: Promise ->
      scope.launch {
        var jar: File? = null
        try {
          ensureInitialised()
          val request = YoutubeDLRequest(url).apply {
            addOption("--dump-single-json")
            addOption("--no-warnings")
            addOption("--no-playlist")
            applyExtractorArgs(poToken, visitorData, clients)
            jar = applyBrowserSession()
          }
          val response = YoutubeDL.getInstance().execute(request)
          promise.resolve(response.out)
        } catch (e: Throwable) {
          promise.reject("E_EXTRACT", e.message ?: "Extraction failed", e)
        } finally {
          CookieJar.discard(jar)
        }
      }
    }

    /**
     * Downloads to app-private storage and returns the resulting file path.
     * Publishing to the gallery is a separate step — see MediaStoreWriter.
     */
    AsyncFunction("download") { args: Map<String, Any?>, promise: Promise ->
      val id = args["id"] as? String ?: return@AsyncFunction promise.reject(
        "E_ARGS", "id is required", null
      )
      val url = args["url"] as? String ?: return@AsyncFunction promise.reject(
        "E_ARGS", "url is required", null
      )
      val format = args["format"] as? String
      val audioOnly = args["audioOnly"] as? Boolean ?: false
      val poToken = args["poToken"] as? String
      val visitorData = args["visitorData"] as? String
      val clients = args["clients"] as? String
      val seconds = (args["seconds"] as? Number)?.toInt() ?: 0

      /**
       * The name this attempt writes under. Falls back to the job id, which is
       * what it used to always be -- and being per-attempt, that guaranteed
       * nothing ever resumed. See `partialKey` in src/core/ytdlp.ts.
       *
       * Filtered again here rather than trusted from the bridge: it becomes a
       * path, and `..` in it would write outside the download directory.
       */
      val stem = (args["resumeKey"] as? String)
        ?.filter { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }
        ?.replace("..", "")
        ?.takeIf { it.isNotBlank() }
        ?: id

      /**
       * The trial is enforced here rather than in the screen that asked.
       * JavaScript checks first so the refusal can be worded properly, but that
       * check ships as Hermes bytecode in the same APK as the thing it guards.
       * This one does not, and it is the one that decides.
       *
       * A paid device skips the trial entirely rather than having its limits
       * raised. The two are different states, not two points on one scale: a
       * subscriber has no save count, no length cap and no expiry date, so
       * asking `TrialGuard` about them and ignoring the answer would leave four
       * ways for a stale trial fact to refuse a paying customer.
       */
      if (!LicenseGuard.entitled(context)) {
        TrialGuard.refuse(context, seconds)?.let { reason ->
          return@AsyncFunction promise.reject("E_TRIAL_$reason", trialMessage(reason), null)
        }
      }

      scope.launch {
        // Both of these are read from the catch as well, which is where a
        // download that failed *after* writing its file is rescued -- so they
        // have to outlive the try that would otherwise scope them.
        val startedAt = System.currentTimeMillis()
        val outputDir = File(context.getExternalFilesDir(null), "downloads").apply { mkdirs() }
        // Hoisted for the same reason, one step further: the jar is the user's
        // login on disk and the `finally` that deletes it has to be able to see
        // it however this body leaves — including the `return@launch` in the
        // rescue path below.
        var jar: File? = null

        try {
          ensureInitialised()
          running[id] = true
          startService(id, args["title"] as? String ?: "Downloading")

          val request = YoutubeDLRequest(url).apply {
            addOption("--no-playlist")
            addOption("--no-warnings")
            addOption("--newline")
            // Named for the job, not the title. `%(title).80s` counts characters
            // while the filesystem counts bytes, and music channels title their
            // uploads in styled Unicode and emoji at four bytes apiece -- eighty
            // of those is ~340 bytes and the write dies with ENAMETOOLONG before
            // a single byte of audio lands. The failure is per-video and total:
            // the title never changes, so that video can never be saved, and the
            // message the user gets names free space and the connection because
            // "File name too long" matches no pattern the app knows. Measured on
            // an S21 FE against a #shorts upload titled in bold maths letters.
            //
            // The id is ASCII, unique per attempt, and nothing reads this name:
            // the gallery copy is named from the title in MediaStoreWriter, and
            // the library shows the title off the record.
            addOption("-o", File(outputDir, "$stem.%(ext)s").absolutePath)
            // Cover art in the file's own tags, so the library looks the same
            // with the network off. Best effort by design: if ffmpeg cannot
            // embed for this container, yt-dlp carries on and the artwork
            // reader falls back to the thumbnail URL.
            addOption("--embed-thumbnail")
            // Title and uploader into the file's own tags, so a track carries
            // its artist into any other player on the device — and so the media
            // notification has something to put under the title.
            addOption("--embed-metadata")
            if (audioOnly) {
              addOption("-f", format ?: "bestaudio")
              addOption("-x")
              addOption("--audio-format", "m4a")
            } else {
              // yt-dlp merges the separate DASH streams itself using the
              // bundled ffmpeg, which handles codec pairs MediaMuxer cannot.
              addOption("-f", format ?: "bestvideo+bestaudio/best")
              addOption("--merge-output-format", "mp4")
            }
            applyExtractorArgs(poToken, visitorData, clients)
            jar = applyBrowserSession()
          }

          YoutubeDL.getInstance().execute(request, id) { progress, etaSeconds, line ->
            sendEvent(
              "onProgress",
              Bundle().apply {
                putString("id", id)
                putDouble("fraction", (progress / 100f).toDouble().coerceIn(0.0, 1.0))
                putDouble("eta", etaSeconds.toDouble())
                putString("line", line)
              },
            )
          }

          val produced = finished(outputDir, stem, startedAt)

          running.remove(id)
          stopServiceIfIdle()

          if (produced == null) {
            promise.reject("E_NO_OUTPUT", "Download produced no file", null)
          } else {
            // Spent only once a file exists. A save that failed halfway has
            // cost the tester nothing and must not cost them a slot.
            spendTrialSlot()
            promise.resolve(
              Bundle().apply {
                putString("path", produced.absolutePath)
                putDouble("bytes", produced.length().toDouble())
              },
            )
          }
        } catch (e: Throwable) {
          running.remove(id)
          stopServiceIfIdle()
          val cancelled = e.message?.contains("cancel", ignoreCase = true) == true

          /**
           * A finished file is a finished download, whatever yt-dlp says next.
           *
           * Measured on the emulator: a 31-minute save downloaded fully,
           * converted to a 73 MB m4a, had its source deleted -- and then failed
           * with `Postprocessing: Conversion failed!` because embedding the
           * *cover art* did not work. The audio was complete and correct on
           * disk, and the user was told the download did not finish. Everything
           * after the media itself -- the thumbnail, the metadata tags -- only
           * decorates, and a decoration must never be able to fail the thing it
           * decorates.
           *
           * `finished` is what makes this safe rather than merely forgiving. It
           * only answers with a file this attempt wrote, that is not a `.part`,
           * and that is not one half of a merge yt-dlp never completed -- so a
           * dropped connection still fails (a `.part` and nothing else), and a
           * failed video merge still fails rather than handing back a silent
           * video. A cancel is excluded outright: the user asked for nothing,
           * and resolving here would put a track in their library and spend a
           * trial save on it.
           */
          val rescued = if (cancelled) null else finished(outputDir, stem, startedAt)
          if (rescued != null) {
            spendTrialSlot()
            promise.resolve(
              Bundle().apply {
                putString("path", rescued.absolutePath)
                putDouble("bytes", rescued.length().toDouble())
                // The engine did fail; the file survived it. Said out loud so a
                // log reader is never puzzled by a download that succeeded with
                // an error in the line above it.
                putString("salvagedFrom", e.message ?: "postprocessing failed")
              },
            )
            return@launch
          }

          promise.reject(
            if (cancelled) "E_CANCELLED" else "E_DOWNLOAD",
            e.message ?: "Download failed",
            e,
          )
        } finally {
          CookieJar.discard(jar)
        }
      }
    }

    AsyncFunction("cancel") { id: String, promise: Promise ->
      scope.launch {
        try {
          YoutubeDL.getInstance().destroyProcessById(id)
        } catch (_: Throwable) {
          // Already gone; cancelling twice is not an error worth surfacing.
        }
        running.remove(id)
        stopServiceIfIdle()
        promise.resolve(null)
      }
    }

    /**
     * Pulls a newer extractor at runtime. This is the app's self-repair path —
     * it can't ship Play Store updates.
     */
    AsyncFunction("updateEngine") { promise: Promise ->
      scope.launch {
        try {
          ensureInitialised()
          val status = YoutubeDL.getInstance()
            .updateYoutubeDL(context, YoutubeDL.UpdateChannel.STABLE)
          promise.resolve(
            Bundle().apply {
              putString("status", status?.name ?: "UNKNOWN")
              putString("version", YoutubeDL.getInstance().version(context) ?: "unknown")
            },
          )
        } catch (e: Throwable) {
          promise.reject("E_UPDATE", e.message ?: "Update failed", e)
        }
      }
    }

    /**
     * Everything Spool has published to the gallery, read back off MediaStore.
     *
     * The library index lives in AsyncStorage and dies with the app; the files
     * do not, because a manual save is a MediaStore record in Music/Spool or
     * Movies/Spool and those survive an uninstall. Without this the user
     * reinstalls, sees an empty Library and concludes their downloads are gone
     * while they are sitting in the gallery the whole time.
     *
     * Only the shared-storage half is recoverable. Automatic saves stay in
     * app-private external storage, which Android deletes with the app, and
     * nothing here can bring those back.
     */
    AsyncFunction("scanSaved") { promise: Promise ->
      scope.launch {
        try {
          promise.resolve(scanSavedMedia())
        } catch (e: Throwable) {
          promise.reject("E_SCAN", e.message ?: "Could not read the gallery", e)
        }
      }
    }

    AsyncFunction("publishToGallery") { path: String, title: String, audioOnly: Boolean, promise: Promise ->
      scope.launch {
        try {
          val uri = MediaStoreWriter.publish(context, File(path), title, audioOnly)
          promise.resolve(uri.toString())
        } catch (e: Throwable) {
          promise.reject("E_PUBLISH", e.message ?: "Could not save to gallery", e)
        }
      }
    }

    /**
     * A text file into Downloads/Spool — a playlist, or a backup of the lists
     * themselves. Same MediaStore machinery as `publishToGallery`, because a
     * file an app writes anywhere else is invisible to the user, to a file
     * manager, and to whatever they later plug the phone into.
     */
    AsyncFunction("writeTextFile") { name: String, mime: String, body: String, promise: Promise ->
      scope.launch {
        try {
          val uri = MediaStoreWriter.writeText(context, name, mime, body)
          promise.resolve(uri.toString())
        } catch (e: Throwable) {
          promise.reject("E_WRITE", e.message ?: "Could not write the file", e)
        }
      }
    }

    /**
     * Raises the media foreground service that keeps browser playback alive
     * off screen, and refreshes what the notification says.
     *
     * Called the moment the page starts playing rather than when the user
     * leaves: from Android 12 a backgrounded process is not allowed to start a
     * foreground service, so by the time leaving is observable it is too late.
     */
    /**
     * Cover art, and the one colour the whole theme is built from.
     *
     * Two sources, in order of honesty. A file's own embedded artwork is the
     * only one that is true offline, so it is tried first. The thumbnail URL is
     * the fallback, and it is what makes this work at all for a library saved
     * before downloads started embedding anything.
     *
     * The result is cached as a jpg in cacheDir. Callers are expected to
     * remember the returned pair themselves and never ask twice — this does the
     * decode, not the remembering.
     */
    AsyncFunction("readArtwork") { key: String, path: String?, urls: List<String>, promise: Promise ->
      scope.launch {
        try {
          val dir = File(context.cacheDir, "artwork").apply { mkdirs() }
          val file = File(dir, "${key.replace(Regex("[^A-Za-z0-9_-]"), "_")}.jpg")

          val bitmap = if (file.exists() && file.length() > 0) {
            BitmapFactory.decodeFile(file.absolutePath)
          } else {
            val raw = path?.let(::embeddedArtwork)
              ?: urls.firstNotNullOfOrNull { fetchBytes(it)?.takeIf { b -> b.isNotEmpty() } }
            if (raw == null || raw.isEmpty()) {
              return@launch promise.reject("E_NO_ARTWORK", "No artwork for this item", null)
            }
            /**
             * Re-encoded rather than stored as it arrived. yt-dlp embeds the
             * maxres thumbnail, so the raw bytes are ~1.8MB per item — measured
             * — and a library of a few hundred would put half a gigabyte of
             * cover art in the cache to fill a 320dp square. Decoded at the
             * largest size anything actually displays, then written back as a
             * quality-85 jpg.
             */
            val decoded = decodeSampled(raw, CACHE_EDGE)
              ?: return@launch promise.reject(
                "E_ARTWORK_DECODE", "Artwork could not be decoded", null
              )
            val trimmed = trimLetterbox(decoded)
            file.outputStream().use {
              trimmed.compress(Bitmap.CompressFormat.JPEG, 85, it)
            }
            trimmed
          } ?: return@launch promise.reject(
            "E_ARTWORK_DECODE", "Artwork could not be decoded", null
          )

          val palette = Palette.from(bitmap).clearFilters().maximumColorCount(16).generate()
          val swatch = palette.vibrantSwatch
            ?: palette.mutedSwatch
            ?: palette.dominantSwatch
          val colour = swatch?.rgb ?: bitmap.getPixel(bitmap.width / 2, bitmap.height / 2)
          bitmap.recycle()

          promise.resolve(
            Bundle().apply {
              putString("uri", "file://${file.absolutePath}")
              putString("dominant", String.format("#%06X", 0xFFFFFF and colour))
            },
          )
        } catch (e: Throwable) {
          promise.reject("E_ARTWORK", e.message ?: "Artwork unavailable", e)
        }
      }
    }

    /**
     * Publishes what is playing, whichever source it came from. Raising the
     * service is a side effect of the first call, which is why callers make it
     * on first play and never on load: Android 12 onwards refuses to start a
     * foreground service from a backgrounded process, and by the time the user
     * has left it is already too late.
     */
    Function("setNowPlaying") { state: Map<String, Any?> -> showNowPlaying(state) }

    /**
     * What the trial allows, for the screens that have to say so. Read every
     * launch and after every save — it is a SharedPreferences lookup and a
     * short file read, not a network call.
     */
    Function("trialStatus") { TrialGuard.status(context) }

    /** See `backgroundRestricted` in index.ts. */
    Function("backgroundRestricted") { isBackgroundRestricted() }

    /** See `filesExist` in index.ts. */
    Function("filesExist") { uris: List<String> -> filesExist(uris) }

    /**
     * On-device OCR of a payment screenshot. See `recognizeText` in index.ts
     * and the private method for why it is on the device at all.
     */
    AsyncFunction("recognizeText") { uri: String, promise: Promise -> recognizeText(uri, promise) }

    /** A picked image, re-encoded small enough to upload. See `shrinkImage` in index.ts. */
    AsyncFunction("shrinkImage") { uri: String, maxEdge: Int, quality: Int, promise: Promise ->
      shrinkImage(uri, maxEdge, quality, promise)
    }

    /**
     * The subscription, for the screens that describe it and for the fetch that
     * refreshes it. Carries the device id so JavaScript never has to derive one
     * — there is exactly one definition of who this device is, and it is
     * `LicenseGuard.deviceId`.
     */
    Function("licenceStatus") { LicenseGuard.status(context) }

    /**
     * Hand a token from the server to the only thing that may believe it.
     *
     * Returns whether it was kept. JavaScript performs the fetch because that is
     * where the app's networking and logging already live, but it does not get
     * to decide what the answer meant: a bundle patched to call this with a
     * token it invented gets `false` and no subscription.
     */
    Function("rememberLicence") { token: String -> LicenseGuard.remember(context, token) }

    Function("forgetLicence") { LicenseGuard.forget(context) }

    Function("stopBackgroundPlayback") {
      PlaybackService.stop(context)
    }

    /**
     * Keeps Chromium believing the browser's WebView is on screen.
     *
     * Everything else about background playback is arranged so that the *page*
     * does not find out it has been backgrounded. None of it reaches the layer
     * that actually stops the music: WebView suspends the media pipeline of a
     * WebView it considers hidden, and it decides that from the Android view,
     * not from anything JavaScript can be told. Measured on a Galaxy S21 FE:
     * each resume bought about 50ms of sound before Chromium paused the element
     * again, identically with the screen off and with HOME pressed and the
     * screen on. Audio focus was still ours and the renderer was still
     * perceptible, so neither was the cause.
     *
     * `dispatchWindowVisibilityChanged` is the public way to say it again.
     * Android sends GONE down the tree when the activity stops; sending VISIBLE
     * back to the WebView alone puts AwContents — and only AwContents — back to
     * visible, so the page keeps its decoder and keeps playing.
     *
     * This is the whole cost of the feature, and it is a real one: a pinned
     * WebView goes on decoding video nobody is looking at. So it is pinned only
     * while there is something playing that the user asked for, and unpinned
     * the moment that stops — see `useBackgroundPlayback`.
     */
    Function("setWebViewVisible") { pinned: Boolean -> pinWebViewVisibility(pinned) }

    /**
     * Says something to the browser page while the app is off screen.
     *
     * `injectJavaScript` cannot: react-native-webview posts it as a UIManager
     * view command, and those are flushed on a Choreographer frame. A window
     * that is not on screen gets no frames, so the command sits in the queue
     * and lands — retroactively, and confusingly — when the app is reopened.
     * That is why the notification's pause button used to do nothing until you
     * went back into Spool.
     *
     * A cookie is not routed through any of that. The page reads it on its own
     * timer, which keeps running while the app is away, so the verb arrives
     * without the app needing a frame to send it. The stamp is what makes a
     * repeat of the same verb a new command rather than the old one still
     * sitting there.
     */
    Function("setPageCommand") { command: String, stamp: Double ->
      writePageCommand(command, stamp)
    }

    /**
     * Drops the YouTube session — both copies of it.
     *
     * There was no way to do this before, which is a security gap rather than a
     * missing convenience: the WebView keeps a signed-in session across
     * restarts by design (see DATA.md on what is deliberately not persisted),
     * and the only way out of it was "Clear storage", which also deletes every
     * automatic save the user has. A lost or handed-on phone stayed signed in.
     *
     * Async because the caller has to know when it is safe to remount the
     * WebView: a remount that overlaps the cookie removal repopulates the jar
     * from the page it is loading.
     */
    AsyncFunction("signOutOfYouTube") { promise: Promise -> signOutOfYouTube(promise) }

    /**
     * FLAG_SECURE, on and off, for the window the browser is drawn in.
     *
     * Set while the page is on a Google sign-in host and cleared everywhere
     * else. It excludes the window from screenshots, from screen recording, and
     * from any non-secure display it might be mirrored to, which is the whole
     * of what the app can do about the one moment it shows a password field it
     * does not own.
     *
     * Scoped to the sign-in hosts rather than left on: FLAG_SECURE applies to
     * the whole window, so leaving it set would silently stop the user
     * screenshotting their own library. Failing open is deliberate — an
     * unreachable activity means no flag, never a blocked sign-in.
     */
    Function("setSecureWindow") { on: Boolean -> applySecureWindow(on) }
    Function("setScreenOrientation") { orientation: String -> setScreenOrientation(orientation) }
    AsyncFunction("pickGoogleAccount") { promise: Promise -> promptChooseAccount(promise) }

    OnActivityResult { _, payload ->
      handleActivityResult(payload.requestCode, payload.resultCode, payload.data)
    }

    OnDestroy {
      PlaybackCommandBus.unregister(playbackCommands)
      // A pin outlives React otherwise, and it holds a view from a tree that
      // is being torn down.
      pinWebViewVisibility(false)
      // Nothing is left playing once the module goes away, so the notification
      // it put up must go with it.
      runCatching { PlaybackService.stop(context) }
      running.keys.forEach { id ->
        runCatching { YoutubeDL.getInstance().destroyProcessById(id) }
      }
      running.clear()
    }
  }

  /**
   * Start or stop telling the WebView it is visible. See the Function above.
   *
   * Unpinning hands the truth back rather than merely stopping: off screen the
   * real visibility is GONE, and a page left believing otherwise would hold a
   * hardware decoder for a track that has already stopped.
   */
  private fun pinWebViewVisibility(pinned: Boolean) {
    main.post {
      visibilityPin?.let { main.removeCallbacks(it) }
      visibilityPin = null

      if (!pinned) {
        runCatching { browserView.get()?.let { it.dispatchWindowVisibilityChanged(it.windowVisibility) } }
        return@post
      }

      val tick = object : Runnable {
        override fun run() {
          runCatching { browserWebView()?.dispatchWindowVisibilityChanged(View.VISIBLE) }
          main.postDelayed(this, VISIBILITY_PIN_MS)
        }
      }
      visibilityPin = tick
      main.post(tick)
    }
  }

  /** The browser's WebView, remembered once found — the tree does not move. */
  private fun browserWebView(): WebView? {
    browserView.get()?.let { if (it.isAttachedToWindow) return it }
    val root = appContext.currentActivity?.window?.decorView ?: return null
    val found = findWebView(root)
    browserView = WeakReference(found)
    return found
  }

  private fun findWebView(view: View): WebView? {
    if (view is WebView) return view
    if (view !is ViewGroup) return null
    for (i in 0 until view.childCount) {
      findWebView(view.getChildAt(i))?.let { return it }
    }
    return null
  }

  @Synchronized
  private fun ensureInitialised() {
    if (initialised) return
    YoutubeDL.getInstance().init(context)
    FFmpeg.getInstance().init(context)
    sweepStalePartials()
    // A jar left behind by a process that died mid-download is the one copy of
    // the login `discard` cannot reach. Swept here because engine init is the
    // first thing any extraction or download does.
    CookieJar.sweep(context)
    initialised = true
  }

  /**
   * A refused or interrupted download leaves its .part behind, and at 4K those
   * run to hundreds of megabytes of storage the user never sees and cannot
   * find. yt-dlp resumes from .part files, so only sweep ones old enough that
   * no resume is plausibly still wanted.
   */
  /**
   * The cover a downloaded file carries in its own tags, if it carries one.
   *
   * Takes the uri exactly as the library stored it. Manual saves are published
   * to MediaStore and come back as `content://`, which the retriever reads only
   * through the context overload — handing it a bare path instead is how the
   * embedded cover stays invisible for every item the user saved deliberately.
   */
  private fun embeddedArtwork(uri: String): ByteArray? = runCatching {
    val retriever = MediaMetadataRetriever()
    try {
      when {
        uri.startsWith("content://") ->
          retriever.setDataSource(context, android.net.Uri.parse(uri))
        uri.startsWith("file://") -> retriever.setDataSource(uri.removePrefix("file://"))
        else -> retriever.setDataSource(uri)
      }
      retriever.embeddedPicture
    } finally {
      retriever.release()
    }
  }.getOrNull()

  /**
   * Deliberately plain and deliberately capped. This is the one network call
   * the library makes on its own behalf, and it is for a thumbnail — it may
   * fail, and failing means the item keeps the neutral ground.
   */
  private fun fetchBytes(from: String): ByteArray? = runCatching {
    val connection = URL(from).openConnection().apply {
      connectTimeout = 8000
      readTimeout = 8000
      // i.ytimg.com answers a bare request, but a default Java user agent is
      // exactly the shape of client CDNs like to refuse, and a refusal here is
      // indistinguishable from "this item has no artwork".
      setRequestProperty("User-Agent", "Mozilla/5.0 (Android) Spool")
    }
    connection.getInputStream().use { it.readBytes() }
  }.onFailure {
    android.util.Log.w("YtDlp", "artwork fetch failed for $from: ${it.message}")
  }.getOrNull()

  /**
   * Cuts the black bars off a letterboxed thumbnail.
   *
   * YouTube's 4:3 thumbnail sizes — `hqdefault` and `sddefault` — pad 16:9 video
   * with black, and yt-dlp will happily embed one of those as the cover. The
   * bars are *inside* the image, so no amount of `resizeMode: cover` removes
   * them: the player showed a 640×480 cover with a black band top and bottom.
   *
   * Done here rather than by choosing a better URL because it also fixes art
   * that came out of the file's own tags, where there is no URL to choose.
   */
  private fun trimLetterbox(source: Bitmap): Bitmap {
    val width = source.width
    val height = source.height
    if (width < 8 || height < 8) return source

    // Sampled across the row rather than read whole: this only needs to know
    // whether anything in the row is brighter than black.
    val step = maxOf(1, width / 32)
    fun isBar(y: Int): Boolean {
      var x = 0
      while (x < width) {
        val p = source.getPixel(x, y)
        val luma = ((p shr 16 and 255) * 299 + (p shr 8 and 255) * 587 + (p and 255) * 114) / 1000
        if (luma > BAR_LUMA) return false
        x += step
      }
      return true
    }

    var top = 0
    while (top < height / 3 && isBar(top)) top++
    var bottom = height - 1
    while (bottom > height * 2 / 3 && isBar(bottom)) bottom--

    val kept = bottom - top + 1
    // A couple of dark rows is a dark photograph, not a letterbox; and if the
    // bars somehow ate most of the frame, trust the original.
    if (top + (height - 1 - bottom) < height / 20 || kept < height / 2) return source
    return Bitmap.createBitmap(source, 0, top, width, kept)
  }

  /**
   * Read the text off a payment screenshot, with ML Kit's bundled Latin model.
   *
   * Bundled rather than the Play-services-downloaded variant: this app is
   * sideloaded and runs on phones whose Play services may be old, absent or
   * unwilling to fetch a model on demand, and the moment someone has just paid
   * is the worst possible moment to discover that. It costs a few megabytes of
   * APK per ABI; see NATIVE.md.
   *
   * Blocks in the order ML Kit reports them, each block's lines joined by a
   * newline — the server's parser reads label and value lines, and ML Kit's
   * own `text` would give the same order with less control over separators.
   *
   * Decoding the file is IO and is done off the main thread; the recognizer
   * runs on its own executor and answers on the main thread.
   */
  private fun recognizeText(uri: String, promise: Promise) {
    scope.launch {
      val image = try {
        InputImage.fromFilePath(context, Uri.parse(uri))
      } catch (e: Throwable) {
        return@launch promise.reject("E_OCR_READ", e.message ?: "Could not open the image", e)
      }
      val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
      recognizer.process(image)
        .addOnSuccessListener { result ->
          val text = result.textBlocks.joinToString("\n") { block ->
            block.lines.joinToString("\n") { it.text }
          }
          promise.resolve(text)
        }
        .addOnFailureListener { e ->
          promise.reject("E_OCR", e.message ?: "Could not read the screenshot", e)
        }
        .addOnCompleteListener { runCatching { recognizer.close() } }
    }
  }

  /**
   * Re-encode a picked image as a JPEG whose long edge is at most `maxEdge`.
   *
   * expo-image-picker's `quality` only recompresses a JPEG source; a PNG —
   * which is what most Android screenshots are — comes back as the same PNG,
   * and a 1080x2400 one is easily over the server's upload cap. Downscaling to
   * a long edge of ~1600 keeps every character a UPI receipt prints legible
   * to a person reviewing it while landing in the low hundreds of kilobytes.
   *
   * Written to `cacheDir/upload/`, which is emptied first: there is only ever
   * one screenshot in flight, and anything older is a receipt nobody needs a
   * second copy of on disk.
   */
  private fun shrinkImage(uri: String, maxEdge: Int, quality: Int, promise: Promise) {
    scope.launch {
      try {
        val source = Uri.parse(uri)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(source).use { BitmapFactory.decodeStream(it, null, bounds) }
        val longest = maxOf(bounds.outWidth, bounds.outHeight)
        if (longest <= 0) return@launch promise.reject("E_IMAGE", "That file is not an image", null)

        var sample = 1
        while (longest / (sample * 2) >= maxEdge) sample *= 2
        val decoded = context.contentResolver.openInputStream(source).use {
          BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
        } ?: return@launch promise.reject("E_IMAGE", "That image could not be decoded", null)

        val scale = maxEdge.toFloat() / maxOf(decoded.width, decoded.height)
        val sized = if (scale < 1f) {
          Bitmap.createScaledBitmap(
            decoded,
            (decoded.width * scale).toInt().coerceAtLeast(1),
            (decoded.height * scale).toInt().coerceAtLeast(1),
            true,
          ).also { if (it !== decoded) decoded.recycle() }
        } else decoded

        val dir = File(context.cacheDir, "upload").apply {
          mkdirs()
          listFiles()?.forEach { it.delete() }
        }
        val out = File(dir, "shot-${System.currentTimeMillis()}.jpg")
        out.outputStream().use { sized.compress(Bitmap.CompressFormat.JPEG, quality.coerceIn(30, 95), it) }
        val result = Bundle().apply {
          putString("uri", "file://${out.absolutePath}")
          putDouble("bytes", out.length().toDouble())
          putInt("width", sized.width)
          putInt("height", sized.height)
        }
        sized.recycle()
        promise.resolve(result)
      } catch (e: Throwable) {
        promise.reject("E_IMAGE", e.message ?: "Could not prepare the image", e)
      }
    }
  }

  /** Decodes at roughly `target` px on the short edge, never larger than source. */
  private fun decodeSampled(bytes: ByteArray, target: Int): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val shortest = minOf(bounds.outWidth, bounds.outHeight)
    var sample = 1
    while (shortest / (sample * 2) >= target) sample *= 2
    val options = BitmapFactory.Options().apply { inSampleSize = sample }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
  }

  /**
   * Both Spool folders, audio and video, newest first.
   *
   * Matched on the folder rather than on anything stored in the file, because
   * the folder is the only thing that survives every route a file can take —
   * including the user moving it back after a tidy-up. `RELATIVE_PATH` only
   * exists from Q; below that the legacy `DATA` column is the path itself.
   */
  private fun scanSavedMedia(): List<Map<String, Any?>> {
    val out = mutableListOf<Map<String, Any?>>()
    scanCollection(audioCollectionUri(), Environment.DIRECTORY_MUSIC, true, out)
    scanCollection(videoCollectionUri(), Environment.DIRECTORY_MOVIES, false, out)
    return out.sortedByDescending { it["savedAt"] as? Long ?: 0L }
  }

  private fun scanCollection(
    collection: Uri,
    directory: String,
    audioOnly: Boolean,
    into: MutableList<Map<String, Any?>>,
  ) {
    val columns = mutableListOf(
      MediaStore.MediaColumns._ID,
      MediaStore.MediaColumns.DISPLAY_NAME,
      MediaStore.MediaColumns.SIZE,
      MediaStore.MediaColumns.DATE_ADDED,
      MediaStore.MediaColumns.DURATION,
    )
    if (audioOnly) columns += MediaStore.Audio.AudioColumns.ARTIST

    val modern = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
    val where = if (modern) {
      "${MediaStore.MediaColumns.RELATIVE_PATH} LIKE ?"
    } else {
      "${MediaStore.MediaColumns.DATA} LIKE ?"
    }
    val arg = if (modern) "$directory/${MediaStoreWriter.FOLDER}%" else "%/$directory/${MediaStoreWriter.FOLDER}/%"

    context.contentResolver.query(
      collection,
      columns.toTypedArray(),
      where,
      arrayOf(arg),
      "${MediaStore.MediaColumns.DATE_ADDED} DESC",
    )?.use { cursor ->
      val id = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns._ID)
      val name = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DISPLAY_NAME)
      val size = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.SIZE)
      val added = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DATE_ADDED)
      val length = cursor.getColumnIndexOrThrow(MediaStore.MediaColumns.DURATION)
      val artist = if (audioOnly) {
        cursor.getColumnIndex(MediaStore.Audio.AudioColumns.ARTIST)
      } else {
        -1
      }

      while (cursor.moveToNext()) {
        val display = cursor.getString(name) ?: continue
        into += mapOf(
          "uri" to ContentUris.withAppendedId(collection, cursor.getLong(id)).toString(),
          // The extension is ours, not the user's — the row shows a title.
          "title" to display.substringBeforeLast('.', display),
          "bytes" to cursor.getLong(size).toDouble(),
          // MediaStore keeps DATE_ADDED in seconds and the rest of the app in
          // milliseconds; mixing them puts every restored row in 1970.
          "savedAt" to cursor.getLong(added) * 1000L,
          "durationMs" to if (cursor.isNull(length)) 0.0 else cursor.getLong(length).toDouble(),
          "audioOnly" to audioOnly,
          "artist" to artist.takeIf { it >= 0 }
            ?.let { cursor.getString(it) }
            ?.takeIf { it.isNotBlank() && it != "<unknown>" },
        )
      }
    }
  }

  private fun audioCollectionUri(): Uri =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
    } else {
      MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
    }

  private fun videoCollectionUri(): Uri =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
    } else {
      MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    }

  /**
   * The media file this attempt finished writing, or null.
   *
   * Three exclusions, and each is the difference between a useful answer and a
   * dangerous one:
   *
   *  - **Images**, because `--embed-thumbnail` leaves its source behind on some
   *    paths and "newest file with this name" would otherwise hand back a jpg
   *    as the download.
   *  - **Everything `INTERMEDIATE` matches**, which is every name yt-dlp gives
   *    something that is not yet a download: `.part`, `.ytdl`, the `.fNNN.`
   *    halves of a merge, and `.temp.` -- the merge ffmpeg is still writing.
   *    Without the first of those a video whose merge failed would resolve to
   *    the video-only stream and be published as a silent film; without the
   *    last it would resolve to a truncated one. Both are saved, listed, and
   *    never explained.
   *
   * Preferring a file modified since `startedAt` is what keeps "this attempt
   * produced a file" answerable now that the name is shared across attempts.
   * Falling back to an older one is still right, and is the "already
   * downloaded" case: yt-dlp leaves a complete file untouched, and a complete
   * file of exactly the video and quality asked for is the correct answer
   * whoever wrote it.
   */
  private fun finished(outputDir: File, stem: String, startedAt: Long): File? {
    val usable = { f: File ->
      f.extension.lowercase() !in setOf("jpg", "jpeg", "png", "webp") &&
        !INTERMEDIATE.containsMatchIn(f.name)
    }
    val candidates = outputDir.listFiles()
      ?.filter { it.name.startsWith("$stem.") && usable(it) }
      .orEmpty()
    return candidates.filter { it.lastModified() >= startedAt }.maxByOrNull { it.lastModified() }
      ?: candidates.maxByOrNull { it.lastModified() }
  }

  /**
   * Deletes what an interrupted download left behind and will never resume.
   *
   * Images are swept alongside the partials because they are only ever an
   * intermediate: `--embed-thumbnail` downloads the cover, and when the embed
   * fails -- or the download does -- the source is left where it fell. Measured
   * at 179 KB from one interrupted save, which is nothing once and a folder of
   * dead covers over a few hundred. Nothing reads them: `finished` excludes
   * images precisely so one can never be handed back as the download.
   *
   * It sweeps by the same `INTERMEDIATE` pattern `finished` refuses by, rather
   * than by extension. A merge abandoned partway leaves `.temp.mp4` and a
   * fragmented download leaves `.part-Frag7`, and neither has an extension an
   * extension test would recognise -- so both used to survive here forever, at
   * the size of a whole video each.
   *
   * The same 24-hour cutoff guards both. A cover belonging to a download that
   * is running right now is minutes old, so it cannot be reached from here
   * whatever else changes about when this is called.
   */
  private fun sweepStalePartials() {
    val cutoff = System.currentTimeMillis() - PARTIAL_MAX_AGE_MS
    val images = setOf("jpg", "jpeg", "png", "webp")
    File(context.getExternalFilesDir(null), "downloads")
      .listFiles { f ->
        (INTERMEDIATE.containsMatchIn(f.name) || f.extension.lowercase() in images) &&
          f.lastModified() < cutoff
      }
      ?.forEach { runCatching { it.delete() } }
  }

  private fun YoutubeDLRequest.applyExtractorArgs(
    poToken: String?,
    visitorData: String?,
    clients: String?,
  ) {
    // Since 2025 essentially every stream request needs a PO token or it 403s.
    // We can harvest real ones because we are a browser.
    val parts = mutableListOf<String>()

    if (!poToken.isNullOrBlank()) {
      /**
       * A PO token is bound to the client that minted it, so the client and the
       * token's label have to be the same word — `po_token` is given as
       * `CLIENT.CONTEXT+TOKEN`, and a token labelled for a client we are not
       * asking as is simply ignored, which reads as a 403 on the media fetch.
       *
       * **Which client that is, is the caller's to decide, not this file's.**
       * It used to be hardcoded to `web` here, which was wrong twice over: our
       * page is `m.youtube.com`, so the token is an `mweb` one, and `web` is
       * SABR-only in any case. Worse, being hardcoded in Kotlin meant the
       * pairing could not be tried any other way without a native rebuild.
       * TOKEN_CHAIN in src/core/ytdlp.ts now walks the candidates, so the right
       * pairing is measured rather than asserted.
       *
       * `gvs` is the context: the token is for the Google Video Server media
       * fetch, which is the request that 403s. The player request does not need
       * one for web-family clients.
       */
      val client = clients?.takeIf { it.isNotBlank() } ?: "mweb"
      parts += "player_client=$client"
      parts += "po_token=$client.gvs+$poToken"

      // visitor_data on its own is worse than nothing: it pins requests to a
      // session we have no attestation for. Only send it alongside a token.
      if (!visitorData.isNullOrBlank()) {
        parts += "visitor_data=$visitorData"
      }
    } else if (!clients.isNullOrBlank()) {
      // No token, so the only lever left is *which* client we impersonate.
      // Some InnerTube clients still serve unattested requests; which ones do
      // changes month to month, so the caller owns the list and walks it. See
      // CLIENT_CHAIN in src/core/ytdlp.ts.
      parts += "player_client=$clients"
    }
    if (parts.isEmpty()) return

    // yt-dlp *replaces* rather than merges repeated --extractor-args for the
    // same extractor, so passing these as separate options silently drops all
    // but the last one.
    addOption("--extractor-args", "youtube:" + parts.joinToString(";"))
  }

  /**
   * Hands the in-app browser's YouTube session to yt-dlp. Being a real browser
   * is the whole advantage; this is where it gets spent.
   *
   * **The caller owns what comes back and must `CookieJar.discard` it in a
   * `finally`.** The jar is the user's YouTube login in plaintext and it is
   * minted per invocation, so nothing else will delete it inside the half hour
   * the sweep waits. See the note at the top of `CookieJar` for why this is
   * ephemeral rather than encrypted, and why per-invocation is a correctness
   * fix as well as a security one.
   */
  private fun YoutubeDLRequest.applyBrowserSession(): File? {
    val jar = runCatching { CookieJar.write(context) }.getOrNull() ?: return null
    addOption("--cookies", jar.absolutePath)
    return jar
  }

  /**
   * Cookies, DOM storage, and any jar on disk.
   *
   * `CookieJar.clear` wants the main thread, and the promise is resolved from
   * there too so that the JavaScript side's next act — remounting the WebView —
   * cannot start before the removal has actually happened.
   */
  private fun signOutOfYouTube(promise: Promise) {
    main.post {
      CookieJar.clear(context)
      promise.resolve(null)
    }
  }

  private fun applySecureWindow(on: Boolean) {
    main.post {
      val window = appContext.currentActivity?.window ?: return@post
      runCatching {
        if (on) {
          window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
          window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        }
      }
    }
  }

  private fun setScreenOrientation(orientation: String) {
    main.post {
      val activity = appContext.currentActivity ?: return@post
      runCatching {
        activity.requestedOrientation = when (orientation) {
          "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
          "portrait" -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
          "unspecified" -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
          else -> ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
        }
      }
    }
  }

  private fun promptChooseAccount(promise: Promise) {
    main.post {
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
        return@post
      }
      pendingAccountPromise = promise
      try {
        val intent = AccountManager.newChooseAccountIntent(
          null,
          null as List<Account>?,
          arrayOf("com.google"),
          null,
          null,
          null,
          null
        )
        activity.startActivityForResult(intent, REQ_CHOOSE_ACCOUNT)
      } catch (e: Throwable) {
        pendingAccountPromise = null
        promise.resolve(null)
      }
    }
  }

  private fun handleActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode == REQ_CHOOSE_ACCOUNT) {
      val promise = pendingAccountPromise ?: return
      pendingAccountPromise = null
      if (resultCode == android.app.Activity.RESULT_OK && data != null) {
        val accountName = data.getStringExtra(AccountManager.KEY_ACCOUNT_NAME)
        promise.resolve(accountName)
      } else {
        promise.resolve(null)
      }
    }
  }

  private fun startService(id: String, title: String) {
    val intent = Intent(context, DownloadService::class.java).apply {
      action = DownloadService.ACTION_START
      putExtra(DownloadService.EXTRA_ID, id)
      putExtra(DownloadService.EXTRA_TITLE, title)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      context.startForegroundService(intent)
    } else {
      context.startService(intent)
    }
  }

  /**
   * Both of these are member functions rather than lambda bodies on purpose.
   *
   * `Function` is an inline builder with reified type parameters, and the whole
   * `definition()` block is one enormous inlined expression. Written inline,
   * these two tipped it over: the compiler stopped erasing
   * `reifiedOperationMarker`, and every launch died before any JavaScript ran
   * with "this function has a reified type parameter and thus can only be
   * inlined at compilation time". Keeping the bodies out here holds the block
   * small enough to inline, which is the only reason the shape matters.
   */
  private fun showNowPlaying(state: Map<String, Any?>) {
    val ms = { key: String ->
      ((state[key] as? Number)?.toDouble() ?: 0.0).times(1000).toLong().coerceAtLeast(0)
    }
    PlaybackService.show(
      context,
      state["title"] as? String ?: "",
      state["artist"] as? String,
      state["source"] as? String ?: "",
      state["playing"] as? Boolean ?: false,
      state["artwork"] as? String,
      ms("position"),
      ms("duration"),
      state["canNext"] as? Boolean ?: false,
      state["canPrevious"] as? Boolean ?: false,
      state["canSave"] as? Boolean ?: false,
    )
  }

  private fun filesExist(uris: List<String>): List<Boolean> =
    uris.map { uri ->
      runCatching { File(uri.removePrefix("file://")).let { it.isFile && it.length() > 0 } }
        .getOrDefault(false)
    }

  private fun isBackgroundRestricted(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return false
    val manager = context.getSystemService(android.app.ActivityManager::class.java) ?: return false
    return runCatching { manager.isBackgroundRestricted }.getOrDefault(false)
  }

  private fun writePageCommand(command: String, stamp: Double) {
    val value = "spool_cmd=$command.${stamp.toLong()}; Domain=.youtube.com; Path=/; Max-Age=120"
    val manager = runCatching { CookieManager.getInstance() }.getOrNull() ?: return
    listOf(
      "https://www.youtube.com/",
      "https://m.youtube.com/",
      "https://music.youtube.com/",
    ).forEach { url -> runCatching { manager.setCookie(url, value) } }
    runCatching { manager.flush() }
  }

  /**
   * Charge a save against the trial quota, unless this device has paid.
   *
   * A subscriber's saves must not draw down the trial counter. The counter
   * outlives an uninstall by design, so a year of paid downloads would silently
   * exhaust it, and the day a subscription lapsed the user would find a trial
   * that had already been spent by their own paid usage — a refusal that is
   * impossible to explain and impossible for them to clear.
   */
  private fun spendTrialSlot() {
    if (LicenseGuard.entitled(context)) return
    TrialGuard.spend(context)
  }

  /**
   * The refusal a tester actually reads. Worded here as well as in TypeScript
   * because this is the copy that survives a patched bundle.
   */
  private fun trialMessage(reason: String): String = when (reason) {
    TrialGuard.REASON_EXPIRED -> "This pre-release build has expired. Contact the developer for a full copy."
    TrialGuard.REASON_TAMPERED -> "This build has been modified and will not run."
    TrialGuard.REASON_QUOTA ->
      "Pre-release builds can save ${TrialGuard.maxDownloads} items. That is all of them."
    TrialGuard.REASON_TOO_LONG ->
      "Pre-release builds can save videos up to ${TrialGuard.maxSeconds / 60} minutes long."
    else -> "Not available in this pre-release build."
  }

  private fun stopServiceIfIdle() {
    if (running.isNotEmpty()) return
    context.startService(
      Intent(context, DownloadService::class.java).apply {
        action = DownloadService.ACTION_STOP
      },
    )
  }
}

