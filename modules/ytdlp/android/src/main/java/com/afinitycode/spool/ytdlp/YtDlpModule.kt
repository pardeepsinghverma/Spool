package com.afinitycode.spool.ytdlp

import android.content.ContentUris
import android.content.Context
import android.content.Intent
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
import android.webkit.CookieManager
import android.webkit.WebView
import java.lang.ref.WeakReference
import androidx.palette.graphics.Palette
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
        try {
          ensureInitialised()
          val request = YoutubeDLRequest(url).apply {
            addOption("--dump-single-json")
            addOption("--no-warnings")
            addOption("--no-playlist")
            applyExtractorArgs(poToken, visitorData, clients)
            applyBrowserSession()
          }
          val response = YoutubeDL.getInstance().execute(request)
          promise.resolve(response.out)
        } catch (e: Throwable) {
          promise.reject("E_EXTRACT", e.message ?: "Extraction failed", e)
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
       * The trial is enforced here rather than in the screen that asked.
       * JavaScript checks first so the refusal can be worded properly, but that
       * check ships as Hermes bytecode in the same APK as the thing it guards.
       * This one does not, and it is the one that decides.
       */
      TrialGuard.refuse(context, seconds)?.let { reason ->
        return@AsyncFunction promise.reject("E_TRIAL_$reason", trialMessage(reason), null)
      }

      scope.launch {
        try {
          ensureInitialised()
          running[id] = true
          startService(id, args["title"] as? String ?: "Downloading")

          val outputDir = File(context.getExternalFilesDir(null), "downloads").apply { mkdirs() }
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
            addOption("-o", File(outputDir, "$id.%(ext)s").absolutePath)
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
            applyBrowserSession()
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

          // Images are excluded because --embed-thumbnail leaves its source
          // behind on some paths, and "newest file in the directory" would then
          // hand back a jpg as the download.
          val media = { f: File ->
            f.extension.lowercase() !in setOf("jpg", "jpeg", "png", "webp", "part", "ytdl")
          }
          // Everything this attempt writes carries the job id, so the result is
          // found by name rather than by "newest thing in the folder". The old
          // rule fell back to the newest media file anywhere here when this
          // attempt produced none, which resolved a failed download as a success
          // pointing at some earlier track -- and then spent a trial save on it.
          val produced = outputDir.listFiles()
            ?.filter { it.name.startsWith(id) && media(it) }
            ?.maxByOrNull { it.lastModified() }

          running.remove(id)
          stopServiceIfIdle()

          if (produced == null) {
            promise.reject("E_NO_OUTPUT", "Download produced no file", null)
          } else {
            // Spent only once a file exists. A save that failed halfway has
            // cost the tester nothing and must not cost them a slot.
            TrialGuard.spend(context)
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
          promise.reject(
            if (cancelled) "E_CANCELLED" else "E_DOWNLOAD",
            e.message ?: "Download failed",
            e,
          )
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

  private fun sweepStalePartials() {
    val cutoff = System.currentTimeMillis() - PARTIAL_MAX_AGE_MS
    File(context.getExternalFilesDir(null), "downloads")
      .listFiles { f -> f.name.endsWith(".part") && f.lastModified() < cutoff }
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
      // A PO token is bound to the client that minted it. Ours comes from the
      // page, so it is a web token and only validates against web-client
      // requests — without pinning the client, yt-dlp asks as tv/ios and the
      // token is ignored, which is a 403 on the media fetch.
      parts += "player_client=web"
      parts += "po_token=web.gvs+$poToken"

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
   */
  private fun YoutubeDLRequest.applyBrowserSession() {
    val cookies = runCatching { CookieJar.write(context) }.getOrNull() ?: return
    addOption("--cookies", cookies)
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

