package com.afinitycode.spool.ytdlp

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.io.File
import java.security.MessageDigest

/**
 * The limits a pre-release build runs under.
 *
 * Everything here is deliberately Kotlin rather than TypeScript. R8 obfuscates
 * this code and the signature check below refuses a repackaged build; neither
 * of those reaches the JavaScript bundle, which ships as Hermes bytecode that
 * can be decompiled and edited. Enforcement therefore lives on this side and
 * the app's own screens only *display* what this reports — a patched bundle can
 * make the UI lie, and still not download anything.
 *
 * None of this makes the build uncrackable. Nothing that runs entirely on the
 * attacker's hardware can be. It raises the cost from "clear app data" to
 * "decompile, patch, resign, and defeat the pin", which is the honest goal.
 */
object TrialGuard {

  /** Why a request was refused, or null when it was not. */
  const val REASON_EXPIRED = "expired"
  const val REASON_TAMPERED = "tampered"
  const val REASON_QUOTA = "quota"
  const val REASON_TOO_LONG = "tooLong"

  private const val PREFS = "spool_trial"
  private const val KEY_SAVES = "saves"
  private const val KEY_SEEN = "seen"

  /**
   * A rollback smaller than this is a time zone, a DST change or an NTP
   * correction. Anything larger is someone buying themselves another week.
   */
  private const val CLOCK_SLACK_MS = 26L * 60 * 60 * 1000

  val enabled: Boolean get() = BuildConfig.TRIAL
  val expiresAt: Long get() = BuildConfig.TRIAL_EXPIRES_AT
  val maxDownloads: Int get() = BuildConfig.TRIAL_MAX_DOWNLOADS
  val maxSeconds: Int get() = BuildConfig.TRIAL_MAX_SECONDS

  /**
   * The count, kept in two places that fail differently.
   *
   * SharedPreferences is the fast one and dies with "Clear storage". The mirror
   * lives in the app's external *media* directory, which survives both clearing
   * data and uninstalling, and needs no permission to write. Reads take the
   * larger of the two, so wiping either one alone buys nothing.
   *
   * A tester who clears storage to reset the count loses their whole library
   * doing it, which is its own deterrent.
   */
  private fun mirror(context: Context): File? =
    runCatching {
      val dir = context.externalMediaDirs.firstOrNull() ?: return null
      if (!dir.exists()) dir.mkdirs()
      File(dir, ".spool")
    }.getOrNull()

  private fun readMirror(context: Context): Pair<Int, Long> {
    val file = mirror(context) ?: return 0 to 0L
    return runCatching {
      val parts = file.readText().trim().split(':')
      (parts.getOrNull(0)?.toIntOrNull() ?: 0) to (parts.getOrNull(1)?.toLongOrNull() ?: 0L)
    }.getOrDefault(0 to 0L)
  }

  private fun writeMirror(context: Context, saves: Int, seen: Long) {
    runCatching { mirror(context)?.writeText("$saves:$seen") }
  }

  /** How many saves this install has spent, whichever store remembers more. */
  fun used(context: Context): Int {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    return maxOf(prefs.getInt(KEY_SAVES, 0), readMirror(context).first)
  }

  fun remaining(context: Context): Int = (maxDownloads - used(context)).coerceAtLeast(0)

  /** Called once a download has actually produced a file. */
  fun spend(context: Context) {
    if (!enabled) return
    val next = used(context) + 1
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    prefs.edit().putInt(KEY_SAVES, next).apply()
    writeMirror(context, next, highWater(context))
  }

  /**
   * The furthest forward the clock has ever been seen, so winding it back is
   * detectable. Stored in both places for the same reason the count is.
   */
  private fun highWater(context: Context): Long {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    val seen = maxOf(prefs.getLong(KEY_SEEN, 0L), readMirror(context).second)
    if (now > seen) {
      prefs.edit().putLong(KEY_SEEN, now).apply()
      writeMirror(context, used(context), now)
      return now
    }
    return seen
  }

  /**
   * True once the trial is over — by the calendar, or because the clock went
   * backwards far enough that someone was clearly trying.
   */
  fun expired(context: Context): Boolean {
    if (!enabled) return false
    val now = System.currentTimeMillis()
    if (now >= expiresAt) return true
    // Before the build existed is not a date this build can be running on.
    if (now < BuildConfig.BUILT_AT - CLOCK_SLACK_MS) return true
    return now < highWater(context) - CLOCK_SLACK_MS
  }

  /**
   * Whether this APK is still the one that was signed.
   *
   * Repackaging is how a patched build gets back onto a device — apktool, edit,
   * resign with a throwaway key — and it always changes the certificate. An
   * empty pin means an unsigned-for-release build (the debug variant), where
   * this has nothing to compare against and must not refuse.
   */
  fun intact(context: Context): Boolean {
    val pinned = BuildConfig.SIGNING_SHA256
    if (pinned.isBlank()) return true
    return runCatching { certificateHash(context) == pinned }.getOrDefault(false)
  }

  private fun certificateHash(context: Context): String {
    val pm = context.packageManager
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      val info = pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
      info.signingInfo?.apkContentsSigners
    } else {
      @Suppress("DEPRECATION")
      pm.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES).signatures
    } ?: return ""

    val first = signatures.firstOrNull() ?: return ""
    return MessageDigest.getInstance("SHA-256")
      .digest(first.toByteArray())
      .joinToString("") { "%02X".format(it) }
  }

  /**
   * The one reason a download must not start, or null when it may.
   *
   * `seconds` is what the extractor said the video runs to; 0 means it did not
   * say, and an unknown length is not grounds for refusing.
   */
  fun refuse(context: Context, seconds: Int): String? {
    if (!enabled) return null
    if (!intact(context)) return REASON_TAMPERED
    if (expired(context)) return REASON_EXPIRED
    if (remaining(context) <= 0) return REASON_QUOTA
    if (seconds > maxSeconds) return REASON_TOO_LONG
    return null
  }

  /** Everything the app's own screens need to describe the trial. */
  fun status(context: Context): Map<String, Any?> = mapOf(
    "trial" to enabled,
    "expiresAt" to expiresAt.toDouble(),
    "expired" to expired(context),
    "intact" to intact(context),
    "used" to used(context),
    "maxDownloads" to maxDownloads,
    "maxSeconds" to maxSeconds,
  )
}
