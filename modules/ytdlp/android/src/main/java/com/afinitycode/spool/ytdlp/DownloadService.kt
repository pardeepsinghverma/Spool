package com.afinitycode.spool.ytdlp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the process alive while yt-dlp works, and owns the one surface this app
 * has outside its own window.
 *
 * Per the design system §6, the ongoing notification is silent and
 * non-dismissible; the completed one is dismissible, low priority, and never
 * makes a sound.
 */
class DownloadService : Service() {

  companion object {
    const val ACTION_START = "com.afinitycode.spool.START"
    const val ACTION_STOP = "com.afinitycode.spool.STOP"
    const val ACTION_PROGRESS = "com.afinitycode.spool.PROGRESS"
    const val ACTION_CANCEL = "com.afinitycode.spool.CANCEL"

    const val EXTRA_ID = "id"
    const val EXTRA_TITLE = "title"
    const val EXTRA_FRACTION = "fraction"

    private const val CHANNEL_ONGOING = "downloads"
    private const val CHANNEL_DONE = "downloads_done"
    private const val ONGOING_ID = 4711

    fun updateProgress(context: Context, id: String, title: String, fraction: Double) {
      context.startService(
        Intent(context, DownloadService::class.java).apply {
          action = ACTION_PROGRESS
          putExtra(EXTRA_ID, id)
          putExtra(EXTRA_TITLE, title)
          putExtra(EXTRA_FRACTION, fraction)
        },
      )
    }

    /** Completion notice. Dismissible, low priority, silent. */
    fun notifyComplete(context: Context, title: String, detail: String) {
      ensureChannels(context)
      val manager = context.getSystemService(NotificationManager::class.java)
      val notification = NotificationCompat.Builder(context, CHANNEL_DONE)
        .setContentTitle(title)
        .setContentText(detail)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .setSilent(true)
        .setAutoCancel(true)
        .setContentIntent(launchIntent(context))
        .build()
      manager.notify(title.hashCode(), notification)
    }

    private fun launchIntent(context: Context): PendingIntent? {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: return null
      return PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun ensureChannels(context: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val manager = context.getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ONGOING) == null) {
        manager.createNotificationChannel(
          NotificationChannel(
            CHANNEL_ONGOING,
            "Downloads in progress",
            NotificationManager.IMPORTANCE_LOW,
          ).apply { setSound(null, null); enableVibration(false) },
        )
      }
      if (manager.getNotificationChannel(CHANNEL_DONE) == null) {
        manager.createNotificationChannel(
          NotificationChannel(
            CHANNEL_DONE,
            "Completed downloads",
            NotificationManager.IMPORTANCE_LOW,
          ).apply { setSound(null, null); enableVibration(false) },
        )
      }
    }
  }

  private var currentTitle: String = "Downloading"
  private var currentId: String? = null
  private var currentFraction: Double? = null

  override fun onBind(intent: Intent?): IBinder? = null

  /**
   * **Every command becomes foreground before it does anything else.**
   *
   * `startForegroundService()` starts a ~5 second timer, and if `startForeground()`
   * has not been called by the time it expires Android throws
   * `ForegroundServiceDidNotStartInTimeException` at the app's main thread and
   * kills the process. That exception comes *from the system*, so no
   * `runCatching` anywhere in this file can stop it — the only defence is to
   * satisfy the contract, always, on the first thing that runs.
   *
   * It used to call `startForeground` on `ACTION_START` alone, which leaves two
   * ways to die. A `STOP` arriving as the first command to a fresh instance —
   * which is exactly what `stopServiceIfIdle()` sends when a download fails
   * early — called `stopSelf()` having never gone foreground at all. And a
   * `PROGRESS` that overtook its `START` did the same.
   *
   * Observed once on the emulator during a first-run download: the process died
   * with this exception while yt-dlp was still spawning, taking the download and
   * the whole app with it. Contended main threads make the window easy to miss
   * and impossible to rely on, so nothing here may assume it is wide.
   */
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannels(this)

    // Read what this command knows first, so the notification raised below is
    // already correct rather than being corrected a frame later.
    when (intent?.action) {
      ACTION_START -> {
        currentId = intent.getStringExtra(EXTRA_ID)
        currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: currentTitle
        currentFraction = null
      }

      ACTION_PROGRESS -> {
        currentTitle = intent.getStringExtra(EXTRA_TITLE) ?: currentTitle
        currentFraction = intent.getDoubleExtra(EXTRA_FRACTION, -1.0).takeIf { it >= 0 }
      }
    }

    // Unconditional, and before the dispatch below. On a stop this raises a
    // notification that the same main-thread message immediately removes, so
    // no frame is ever drawn with it — the cost is nothing and the alternative
    // is a killed process.
    startForegroundCompat(build(currentTitle, currentFraction))

    when (intent?.action) {
      ACTION_CANCEL -> {
        currentId?.let { id -> runCatching { YtDlpCancelBus.cancel(id) } }
        stopSelfCompat(startId)
      }

      ACTION_STOP -> stopSelfCompat(startId)
    }

    return START_NOT_STICKY
  }

  private fun build(title: String, fraction: Double?): Notification {
    val percent = fraction?.let { (it * 100).toInt().coerceIn(0, 100) }
    val cancel = PendingIntent.getService(
      this,
      1,
      Intent(this, DownloadService::class.java).apply { action = ACTION_CANCEL },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    return NotificationCompat.Builder(this, CHANNEL_ONGOING)
      .setContentTitle(title)
      .setContentText(percent?.let { "$it%" } ?: "Preparing…")
      .setSmallIcon(android.R.drawable.stat_sys_download)
      .setOngoing(true)
      .setSilent(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setProgress(100, percent ?: 0, percent == null)
      .setContentIntent(launchIntent(this))
      .addAction(android.R.drawable.ic_menu_close_clear_cancel, "CANCEL", cancel)
      .build()
  }

  /**
   * `runCatching` for the same reason `PlaybackService` has it: an uncaught
   * `ForegroundServiceStartNotAllowedException` takes the whole app down, and
   * Android 12+ throws it for a service started from the background. That is a
   * different failure from the timeout above — this one is throwable *by the
   * call*, so it can be caught, and a download that runs without a notification
   * is far better than a process that dies.
   */
  private fun startForegroundCompat(notification: Notification) {
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(ONGOING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else {
        startForeground(ONGOING_ID, notification)
      }
    }
  }

  /**
   * `stopSelfResult(startId)`, never bare `stopSelf()`.
   *
   * Android records a `startForegroundService` as owing a `startForeground`
   * when the call is *made*, and a service stopped while it owes one is killed
   * on the spot — the same uncatchable exception as above. A STOP from the job
   * that just ended, with the next job's START already issued behind it, is
   * exactly that: a bare `stopSelf()` brought the service down owing the call.
   * With the start id Android stops only if nothing has been started since,
   * and the queued START then goes foreground again as its first act.
   * `PlaybackService` died this way at track boundaries on a real phone.
   */
  private fun stopSelfCompat(startId: Int) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelfResult(startId)
  }
}

/** Lets the notification's CANCEL action reach the running yt-dlp process. */
object YtDlpCancelBus {
  private val listeners = mutableListOf<(String) -> Unit>()

  fun register(listener: (String) -> Unit) {
    synchronized(listeners) { listeners.add(listener) }
  }

  fun cancel(id: String) {
    synchronized(listeners) { listeners.toList() }.forEach { it(id) }
  }
}
