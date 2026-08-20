package com.afinitycode.spool.ytdlp

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

  /**
   * Not private: `scanSaved` reads the library back out of these folders after a
   * reinstall, and a scan looking somewhere other than where publish writes
   * would report an empty gallery with the files sitting right there.
   */
  const val FOLDER = "Spool"

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

  /**
   * Write a text file into the user's Downloads folder.
   *
   * Same machinery as `publish` above and deliberately so — a MediaStore insert
   * is the only way a file an app puts there is visible to the user, to a file
   * manager, or to whatever they later plug the phone into. Downloads rather
   * than Music/Spool: a backup is not a track, and dropping a `.json` among
   * someone's music is how it ends up in another player's library scan.
   *
   * Returns the uri. Unlike `publish` there is no source file to delete and
   * nothing is moved — the caller keeps whatever it had.
   *
   * `sanitise` is shared with `publish`, and it strips the characters a
   * filesystem refuses without touching the dot, so an extension passed in
   * survives.
   */
  fun writeText(context: Context, name: String, mime: String, body: String): Uri {
    val displayName = sanitise(name)

    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
      put(MediaStore.MediaColumns.MIME_TYPE, mime)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/$FOLDER")
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      } else {
        val dir = File(
          Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS),
          FOLDER,
        ).apply { mkdirs() }
        put(MediaStore.MediaColumns.DATA, File(dir, displayName).absolutePath)
      }
    }

    val resolver = context.contentResolver
    val uri = resolver.insert(downloadCollection(), values)
      ?: error("MediaStore refused the insert")

    try {
      resolver.openOutputStream(uri)?.use { out ->
        out.write(body.toByteArray(Charsets.UTF_8))
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

    return uri
  }

  /**
   * `MediaStore.Downloads` arrived in Q. Below that there is no downloads
   * collection at all — the file is written by path — so the files table is the
   * only handle there is.
   */
  private fun downloadCollection(): Uri =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
    } else {
      MediaStore.Files.getContentUri("external")
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
    name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().limitBytes(180).ifBlank { "video" }

  /**
   * Trim to a byte budget, never mid-character.
   *
   * `take(120)` counts characters and the filesystem counts bytes. A title in
   * styled Unicode or emoji runs four bytes to the character, so 120 of them is
   * 480 bytes and the insert fails with ENAMETOOLONG — the same defect that
   * stopped the download itself ever writing a file. 180 leaves room for the
   * extension and for MediaStore's own de-duplicating "(1)" suffix inside the
   * 255-byte limit.
   */
  private fun String.limitBytes(max: Int): String {
    if (toByteArray(Charsets.UTF_8).size <= max) return this
    val out = StringBuilder()
    var bytes = 0
    var i = 0
    while (i < length) {
      val cp = codePointAt(i)
      val width = String(Character.toChars(cp)).toByteArray(Charsets.UTF_8).size
      if (bytes + width > max) break
      out.appendCodePoint(cp)
      bytes += width
      i += Character.charCount(cp)
    }
    return out.toString().trim()
  }
}
