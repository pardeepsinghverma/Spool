package com.afinitycode.spool.ytdlp

import android.content.Context
import android.webkit.CookieManager
import java.io.File

/**
 * Hands the browser's YouTube session to yt-dlp.
 *
 * This is the payoff of actually being a browser. The WebView holds a real,
 * consented YouTube session, and `CookieManager` can read all of it — including
 * the HttpOnly cookies that `document.cookie` cannot see. Writing those to a
 * Netscape cookie file lets yt-dlp make requests as the same session the user is
 * already browsing in, which is what stops the media fetch coming back 403.
 */
object CookieJar {

  private const val FILE_NAME = "youtube-cookies.txt"

  /** Hosts whose cookies matter for playback and consent. */
  private val ORIGINS = listOf(
    "https://www.youtube.com",
    "https://m.youtube.com",
    "https://.youtube.com",
    "https://www.google.com",
  )

  /**
   * Returns the cookie file path, or null when the session has no cookies worth
   * sending — in which case callers should omit --cookies entirely rather than
   * pass an empty file.
   */
  fun write(context: Context): String? {
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

    val file = File(context.cacheDir, FILE_NAME)
    file.writeText(body)
    return file.absolutePath
  }
}
