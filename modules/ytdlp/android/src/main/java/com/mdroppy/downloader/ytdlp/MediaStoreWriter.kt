package com.mdroppy.downloader.ytdlp

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import java.io.File

/**
 * Publishes a finished download so it shows up in Gallery.
 *
 * This step is not optional cosmetics: a file written to app-private storage,
 * or even dropped into Movies/ with raw file I/O, stays invisible to Gallery on
 * modern Android. Only a MediaStore record makes it appear.
 */
object MediaStoreWriter {

  private const val FOLDER = "Spool"

  fun publish(context: Context, source: File, title: String, audioOnly: Boolean): Uri {
    require(source.exists()) { "Downloaded file is missing: ${source.absolutePath}" }

    val displayName = sanitise(title.ifBlank { source.nameWithoutExtension }) +
      "." + source.extension.ifBlank { if (audioOnly) "m4a" else "mp4" }

    val collection = if (audioOnly) audioCollection() else videoCollection()
    val relativePath = if (audioOnly) {
      "${Environment.DIRECTORY_MUSIC}/$FOLDER"
    } else {
      "${Environment.DIRECTORY_MOVIES}/$FOLDER"
    }

    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
      put(MediaStore.MediaColumns.MIME_TYPE, if (audioOnly) "audio/mp4" else "video/mp4")
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath)
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      } else {
        val dir = File(
          Environment.getExternalStoragePublicDirectory(
            if (audioOnly) Environment.DIRECTORY_MUSIC else Environment.DIRECTORY_MOVIES,
          ),
          FOLDER,
        ).apply { mkdirs() }
        put(MediaStore.MediaColumns.DATA, File(dir, displayName).absolutePath)
      }
    }

    val resolver = context.contentResolver
    val uri = resolver.insert(collection, values)
      ?: error("MediaStore refused the insert")

    try {
      resolver.openOutputStream(uri)?.use { out ->
        source.inputStream().use { input -> input.copyTo(out, DEFAULT_BUFFER_SIZE) }
      } ?: error("Could not open MediaStore output stream")

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        values.clear()
        values.put(MediaStore.MediaColumns.IS_PENDING, 0)
        resolver.update(uri, values, null, null)
      }
    } catch (e: Throwable) {
      runCatching { resolver.delete(uri, null, null) }
      throw e
    }

    // The temp copy has served its purpose; leaving it doubles disk use.
    runCatching { source.delete() }

    return uri
  }

  private fun videoCollection(): Uri =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      MediaStore.Video.Media.EXTERNAL_CONTENT_URI
    }

  private fun audioCollection(): Uri =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
    }

  private fun sanitise(name: String): String =
    name.replace(Regex("[\\\\/:*?\"<>|]"), "_").take(120).trim().ifBlank { "video" }
}
