package com.afinitycode.spool.ytdlp

import android.content.Context
import android.provider.Settings
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/**
 * Whether this device has paid, and until when.
 *
 * The same split as [TrialGuard], for the same reason: this decides, and
 * `src/core/license.ts` only describes. A patched Hermes bundle can make the
 * paywall disappear from the screen and still not get a download, because
 * `YtDlpModule.download` asks *this* file.
 *
 * A licence is a token the server signed:
 *
 *     base64url(payloadJson) "." base64url(derSignature)
 *
 * and the signature covers **the ASCII of the first segment**, not the JSON it
 * decodes to. That is why [verify] checks the signature over the raw substring
 * and only then parses: JSON has no canonical form, so a verifier that parsed
 * first would be comparing its own re-serialisation against bytes signed by V8
 * and would reject perfectly good licences the moment either side changed key
 * order or number formatting.
 *
 * ECDSA P-256 rather than Ed25519 because this module's minSdk is 24 and
 * `Signature.getInstance("Ed25519")` needs API 33. A licence that silently
 * fails to verify on a four-year-old phone is the worst bug this file could
 * have, and it would only appear on the devices least likely to report it.
 *
 * **Offline is the normal case, not the fallback.** Spool plays a local library
 * with the screen off and no network, so nothing here ever reaches the
 * internet. The app fetches a token when it happens to be online; this file
 * only ever looks at what is already on disk. A user on a plane keeps their
 * subscription.
 */
object LicenseGuard {

  private const val PREFS = "spool_licence"
  private const val KEY_TOKEN = "token"
  private const val KEY_SEEN = "seen"

  /** Same 26 hours [TrialGuard] allows, and for the same time zones and NTP. */
  private const val CLOCK_SLACK_MS = 26L * 60 * 60 * 1000

  /**
   * The mirror, in the app's external media directory.
   *
   * For the trial this location is a deterrent — a counter that survives an
   * uninstall. Here it is a *courtesy*, and the difference is worth stating:
   * a paying user who reinstalls Spool, or clears its storage to fix something,
   * gets their subscription back without a round trip and without support. The
   * same property serves opposite purposes in the two files.
   */
  private fun mirror(context: Context): File? =
    runCatching {
      val dir = context.externalMediaDirs.firstOrNull() ?: return null
      if (!dir.exists()) dir.mkdirs()
      File(dir, ".spool_l")
    }.getOrNull()

  /**
   * A stable, anonymous name for this install.
   *
   * SHA-256 of ANDROID_ID, which since Android 8 is already per-app and per-user
   * rather than per-device. Hashing it again means the server never holds
   * anything that could be joined against another app's records — it sees a
   * 43-character string and nothing else, which is the most the licence table is
   * allowed to know about anybody.
   */
  fun deviceId(context: Context): String {
    val raw = runCatching {
      Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
    }.getOrNull().orEmpty().ifBlank { "unknown" }
    val digest = MessageDigest.getInstance("SHA-256").digest(raw.toByteArray())
    return Base64.encodeToString(digest, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
  }

  private const val FALLBACK_LICENCE_KEY =
    "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEnky9ApmTh5fbzQObijVHD4f/dqYQnWTd2ZazXyRY7ClWtlb8U6JtueCpK0aTrJs5Azm+KAVSR+zGkzXxeuq0FQ=="

  private fun publicKey() =
    KeyFactory.getInstance("EC").generatePublic(
      X509EncodedKeySpec(Base64.decode(BuildConfig.LICENCE_KEY.ifBlank { FALLBACK_LICENCE_KEY }, Base64.DEFAULT)),
    )

  /**
   * The payload of `token` if it is genuinely ours and genuinely this device's,
   * or null.
   *
   * Null for every failure, deliberately: a caller that could tell a bad
   * signature from a wrong device from malformed base64 would be a caller that
   * could be used as an oracle, and no screen in the app has anything different
   * to say about the three cases anyway.
   */
  private fun verify(context: Context, token: String): JSONObject? = runCatching {
    val dot = token.indexOf('.')
    if (dot <= 0 || dot == token.length - 1) return null

    val head = token.substring(0, dot)
    val signature = Base64.decode(
      token.substring(dot + 1),
      Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP,
    )

    val ok = Signature.getInstance("SHA256withECDSA").run {
      initVerify(publicKey())
      update(head.toByteArray(Charsets.US_ASCII))
      verify(signature)
    }
    if (!ok) return null

    val payload = JSONObject(
      String(
        Base64.decode(head, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP),
        Charsets.UTF_8,
      ),
    )

    // Bound to this install. Without it a token is a file, and a file can be
    // pulled off one phone and dropped onto a hundred.
    if (payload.optString("dev") != deviceId(context)) return null
    payload
  }.getOrNull()

  /**
   * Take a token from the server, if it survives being checked.
   *
   * Verified *before* it is written, so a hostile or misconfigured server
   * cannot park bytes in preferences that every later launch will re-check and
   * re-reject. Returns whether it was kept.
   */
  fun remember(context: Context, token: String): Boolean {
    val payload = verify(context, token) ?: return false
    // Never accept something already dead: it would replace a good token with a
    // bad one on a server that answered wrongly, which is a fault the user
    // could not clear from inside the app.
    if (payload.optLong("exp") <= System.currentTimeMillis()) return false

    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .edit().putString(KEY_TOKEN, token).apply()
    runCatching { mirror(context)?.writeText(token) }
    return true
  }

  /** Whichever store still has one; preferences first because it is the fast one. */
  private fun stored(context: Context): String? {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      .getString(KEY_TOKEN, null)
    if (!prefs.isNullOrBlank()) return prefs
    return runCatching { mirror(context)?.takeIf { it.exists() }?.readText()?.trim() }
      .getOrNull()?.takeIf { it.isNotBlank() }
  }

  /**
   * The furthest forward this device's clock has ever been seen.
   *
   * A subscription expires in the future, so winding the clock *back* is how
   * you extend one — the mirror image of the trial, where winding it back is
   * how you undo an expiry. Same defence either way.
   */
  private fun highWater(context: Context): Long {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val now = System.currentTimeMillis()
    val seen = prefs.getLong(KEY_SEEN, 0L)
    if (now > seen) {
      prefs.edit().putLong(KEY_SEEN, now).apply()
      return now
    }
    return seen
  }

  /** True while this device is paid up. The only question that gates anything. */
  fun entitled(context: Context): Boolean = expiresAt(context) > System.currentTimeMillis()

  /**
   * When the held licence runs out, or 0 if there is not a valid one.
   *
   * Re-verifies the signature on every call rather than trusting a cached
   * boolean. It costs one ECDSA verification — tens of microseconds — and it
   * means editing the preferences file by hand achieves nothing.
   */
  fun expiresAt(context: Context): Long {
    // A repackaged APK gets no licence, exactly as it gets no trial.
    //
    // Without this the pin has a hole shaped like a paying customer: subscribe
    // once legitimately, then decompile, patch and resign — the token still
    // verifies, because it is signed by the server and says nothing about which
    // APK is holding it. `YtDlpModule.download` skips `TrialGuard` entirely for
    // an entitled device, so the signature check would never run at all. Folding
    // it in here means a modified build is refused whether or not it has paid,
    // which is the rule `TrialGuard.intact` was always supposed to express.
    if (!TrialGuard.intact(context)) return 0

    val token = stored(context) ?: return 0
    val payload = verify(context, token) ?: return 0
    val exp = payload.optLong("exp")
    val now = System.currentTimeMillis()

    // A clock behind where this device has already been is not a clock to
    // grant a subscription from.
    if (now < highWater(context) - CLOCK_SLACK_MS) return 0
    if (now < BuildConfig.BUILT_AT - CLOCK_SLACK_MS) return 0

    return exp
  }

  /** Forget the licence — used when the user says the subscription is not theirs. */
  fun forget(context: Context) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_TOKEN).apply()
    runCatching { mirror(context)?.delete() }
  }

  /** Everything the app's own screens need in order to describe the subscription. */
  fun status(context: Context): Map<String, Any?> {
    val expires = expiresAt(context)
    val token = stored(context)
    val plan = token?.let { verify(context, it) }?.optString("plan").orEmpty()
    return mapOf(
      "entitled" to (expires > System.currentTimeMillis()),
      "expiresAt" to expires.toDouble(),
      "plan" to plan,
      "device" to deviceId(context),
      "server" to BuildConfig.LICENCE_SERVER.ifBlank { if (BuildConfig.DEBUG) "http://127.0.0.1:8765" else "" },
    )
  }
}
