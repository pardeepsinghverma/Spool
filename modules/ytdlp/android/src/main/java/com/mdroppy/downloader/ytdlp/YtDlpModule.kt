package com.mdroppy.downloader.ytdlp

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
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

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val running = ConcurrentHashMap<String, Boolean>()

  @Volatile
  private var initialised = false

  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context unavailable" }

  override fun definition() = ModuleDefinition {
    Name("YtDlp")

    Events("onProgress", "onLog")

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
    AsyncFunction("listFormats") { url: String, poToken: String?, visitorData: String?, promise: Promise ->
      scope.launch {
        try {
          ensureInitialised()
          val request = YoutubeDLRequest(url).apply {
            addOption("--dump-single-json")
            addOption("--no-warnings")
            addOption("--no-playlist")
            applyExtractorArgs(poToken, visitorData)
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
            addOption("-o", File(outputDir, "%(title).80s [%(id)s].%(ext)s").absolutePath)
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
            applyExtractorArgs(poToken, visitorData)
            applyBrowserSession()
          }

          val before = outputDir.listFiles()?.map { it.absolutePath }?.toSet() ?: emptySet()

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

          val produced = outputDir.listFiles()
            ?.filter { it.absolutePath !in before }
            ?.maxByOrNull { it.lastModified() }
            ?: outputDir.listFiles()?.maxByOrNull { it.lastModified() }

          running.remove(id)
          stopServiceIfIdle()

          if (produced == null) {
            promise.reject("E_NO_OUTPUT", "Download produced no file", null)
          } else {
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

    OnDestroy {
      running.keys.forEach { id ->
        runCatching { YoutubeDL.getInstance().destroyProcessById(id) }
      }
      running.clear()
    }
  }

  @Synchronized
  private fun ensureInitialised() {
    if (initialised) return
    YoutubeDL.getInstance().init(context)
    FFmpeg.getInstance().init(context)
    initialised = true
  }

  private fun YoutubeDLRequest.applyExtractorArgs(poToken: String?, visitorData: String?) {
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
    }
    // visitor_data on its own is worse than nothing: it pins requests to a
    // session we have no attestation for. Only send it alongside a token.
    if (!poToken.isNullOrBlank() && !visitorData.isNullOrBlank()) {
      parts += "visitor_data=$visitorData"
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

  private fun stopServiceIfIdle() {
    if (running.isNotEmpty()) return
    context.startService(
      Intent(context, DownloadService::class.java).apply {
        action = DownloadService.ACTION_STOP
      },
    )
  }
}
