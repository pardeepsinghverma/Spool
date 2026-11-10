package com.afinitycode.spool.ytdlp

import android.content.Context
import android.webkit.CookieManager
import android.webkit.WebStorage
import java.io.File

/**
 * Hands the browser's YouTube session to yt-dlp, and takes it straight back.
 *
 * This is the payoff of actually being a browser. The WebView holds a real,
 * consented YouTube session, and `CookieManager` can read all of it — including
 * the HttpOnly cookies that `document.cookie` cannot see. Writing those to a
 * Netscape cookie file lets yt-dlp make requests as the same session the user is
 * already browsing in, which is what stops the media fetch coming back 403.
 *
 * ## Why this file is ephemeral rather than encrypted
 *
 * What it holds is the login itself: `SAPISID`, `HSID`, `SSID`,
 * `__Secure-3PAPISID`. Anyone with those bytes is signed in as the user, on any
 * machine, until the user revokes the session at Google. So the obvious instinct
 * is to encrypt it — and that buys nothing here, because yt-dlp needs a real
 * path to a readable file. Encrypting at rest means decrypting to a second
 * plaintext file the moment it is used, which moves the exposure rather than
 * removing it.
 *
 * What actually shrinks the exposure is time. The file used to be one fixed
 * `cacheDir/youtube-cookies.txt`, overwritten before every extraction and
 * download and deleted by nothing — so a device that had ever been signed in
 * carried a plaintext copy of the credential for the life of the install.
 * Now one is minted per invocation and deleted in the caller's `finally`, so it
 * exists for the seconds yt-dlp is reading it and no longer. `sweep` covers the
 * one case that skips: the process dying mid-download.
 *
 * Per-invocation is also a correctness fix, not only a security one. Extraction
 * and a download run concurrently on the same scope, and with a shared name the
 * first to finish deleted the file the other was still reading.
 *
 * `noBackupFilesDir` rather than `cacheDir`: it is excluded from Android's
 * backup and device-transfer agents by definition, so a credential can never
 * leave the device by that route even in the window it exists.
 */
object CookieJar {

  private const val DIR_NAME = "session"

  /**
   * Long enough that no live download owns it, short enough that a jar orphaned
   * by a process death is gone before the next session is well underway.
   */
  private const val STALE_MS = 30L * 60 * 1000

  /** Hosts whose cookies matter for playback and consent. */
  private val ORIGINS = listOf(
    "https://www.youtube.com",
    "https://m.youtube.com",
    "https://music.youtube.com",
    "https://.youtube.com",
    "https://www.google.com",
  )

  private fun dir(context: Context): File =
    File(context.noBackupFilesDir, DIR_NAME).apply {
      mkdirs()
      lockDown(this, executable = true)
    }

  /**
   * Owner-only, explicitly.
   *
   * The app sandbox already gives every one of these paths a UID no other app
   * shares, so on a healthy device this changes nothing. It is here because the
   * cost is three syscalls and the thing being protected is a login — the
   * `false, false` call first is load-bearing, since it clears the bit for the
   * owner too and the `true, true` call after is what grants it back.
   */
  private fun lockDown(file: File, executable: Boolean) {
    runCatching {
      file.setReadable(false, false); file.setReadable(true, true)
      file.setWritable(false, false); file.setWritable(true, true)
      file.setExecutable(false, false); if (executable) file.setExecutable(true, true)
    }
  }

  /**
   * Returns a freshly written jar, or null when the session has no cookies
   * worth sending — in which case callers omit --cookies entirely rather than
   * pass an empty file.
   *
   * **Every caller owns what it gets back and must `discard` it in a `finally`.**
   */
  fun write(context: Context): File? {
    val manager = runCatching { CookieManager.getInstance() }.getOrNull() ?: return null

    // name -> "domain\tvalue", de-duplicated because origins overlap.
    val collected = LinkedHashMap<String, Pair<String, String>>()

    for (origin in ORIGINS) {
      val raw = runCatching { manager.getCookie(origin) }.getOrNull() ?: continue
      val domain = if (origin.contains("google")) ".google.com" else ".youtube.com"
      raw.split(';').forEach { pair ->
        val trimmed = pair.trim()
        val eq = trimmed.indexOf('=')
        if (eq <= 0) return@forEach
        val name = trimmed.substring(0, eq).trim()
        val value = trimmed.substring(eq + 1).trim()
        if (name.isNotEmpty()) collected[name] = domain to value
      }
    }

    if (collected.isEmpty()) return null

    // Netscape format: domain, includeSubdomains, path, secure, expiry, name, value.
    // A far-future expiry keeps yt-dlp from discarding them as session cookies.
    val expiry = (System.currentTimeMillis() / 1000) + 60L * 60 * 24 * 365
    val body = buildString {
      appendLine("# Netscape HTTP Cookie File")
      appendLine("# Written by Spool from the in-app browser session.")
      collected.forEach { (name, domainAndValue) ->
        val (domain, value) = domainAndValue
        append(domain).append('\t')
          .append("TRUE").append('\t')
          .append("/").append('\t')
          .append("TRUE").append('\t')
          .append(expiry).append('\t')
          .append(name).append('\t')
          .append(value).append('\n')
      }
    }

    return runCatching {
      // Created empty and locked down before a single credential byte is
      // written, so there is no instant at which it exists and is readable.
      val file = File.createTempFile("jar", ".txt", dir(context))
      lockDown(file, executable = false)
      file.writeText(body)
      file
    }.getOrNull()
  }

  /**
   * Truncate, then delete.
   *
   * The truncate is not a secure erase and is not claimed to be one — on a
   * flash device with wear levelling nothing at this layer can promise the
   * blocks are gone. It is here because it is free and it does clear the copy
   * anything still holding the path or the page cache would read.
   */
  fun discard(file: File?) {
    if (file == null) return
    runCatching { file.writeText("") }
    runCatching { file.delete() }
  }

  /**
   * Jars orphaned by a process death — the one path `discard` cannot cover.
   * Called from engine init, which is the first thing any extraction does.
   */
  fun sweep(context: Context) {
    val cutoff = System.currentTimeMillis() - STALE_MS
    runCatching {
      File(context.noBackupFilesDir, DIR_NAME)
        .listFiles { f -> f.lastModified() < cutoff }
        ?.forEach { discard(it) }
    }
  }

  /**
   * Signing out: drop the whole session, both copies of it.
   *
   * Order matters only in that the jars go last — a download racing this would
   * otherwise mint a new one from cookies that are already gone, which is
   * harmless but leaves a file behind. Must be called on the main thread:
   * `CookieManager.removeAllCookies` and `WebStorage` both want it.
   */
  fun clear(context: Context) {
    runCatching {
      val manager = CookieManager.getInstance()
      manager.removeAllCookies(null)
      manager.flush()
    }
    runCatching { WebStorage.getInstance().deleteAllData() }
    runCatching {
      File(context.noBackupFilesDir, DIR_NAME).listFiles()?.forEach { discard(it) }
    }
  }
}
