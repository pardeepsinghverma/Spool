package com.afinitycode.spool.ytdlp

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.session.MediaButtonReceiver
import java.util.concurrent.Executors

/**
 * The one media notification, for both things Spool can play.
 *
 * Two jobs, and they are not the same job.
 *
 * The first is survival. Android freezes cached processes, which stops a media
 * pipeline dead, and the CPU sleeps a few seconds after the screen goes off. A
 * foreground service exempts us from the first; a partial wake lock, held only
 * while sound is actually coming out, answers the second. That is as true of a
 * local file as it is of the browser's <video>, so both sources come through
 * here rather than each raising a service of its own.
 *
 * The second is the card itself. On Android 13 and up the media control panel
 * is not built from the notification's actions — it is built from the
 * MediaSession's *PlaybackState*, its metadata, and nothing else. Buttons that
 * are only added to the notification are simply not drawn. That is why the
 * transport, the scrubber and the elapsed/total times below are expressed as
 * session state first and notification actions second: the actions are the
 * fallback for Android 12 and older, not the primary surface.
 *
 * What the system draws for us, given the right state:
 *
 *   - the output switcher chip ("Phone speaker") — from having a session at all;
 *   - the artwork, and the card's colours, taken from the large icon;
 *   - a working scrubber with both times — from ACTION_SEEK_TO plus a real
 *     METADATA_KEY_DURATION;
 *   - previous / play-pause / next — from the matching PlaybackState actions.
 *
 * Position is deliberately *not* pushed every second. A PlaybackState carries a
 * position, the wall clock it was measured at, and a speed, and the system
 * extrapolates between updates. Publishing on state changes and seeks alone
 * gives a scrubber that moves smoothly for nothing per second.
 */
class PlaybackService : Service() {

  companion object {
    const val ACTION_SHOW = "com.afinitycode.spool.PLAYBACK_SHOW"
    const val ACTION_STOP = "com.afinitycode.spool.PLAYBACK_STOP"
    private const val ACTION_PLAY = "com.afinitycode.spool.PLAYBACK_PLAY"
    private const val ACTION_PAUSE = "com.afinitycode.spool.PLAYBACK_PAUSE"
    private const val ACTION_NEXT = "com.afinitycode.spool.PLAYBACK_NEXT"
    private const val ACTION_PREVIOUS = "com.afinitycode.spool.PLAYBACK_PREVIOUS"
    private const val ACTION_SAVE = "com.afinitycode.spool.PLAYBACK_SAVE"
    private const val ACTION_DISMISS = "com.afinitycode.spool.PLAYBACK_DISMISS"

    /**
     * The save button's identity on the session.
     *
     * Android 13+ builds the card from the PlaybackState, and the only way to
     * put a button on it that is not one of the fixed transport verbs is a
     * custom action. The notification action added alongside it is what Android
     * 12 and older draw — same split as the transport controls above.
     */
    private const val CUSTOM_SAVE = "com.afinitycode.spool.session.SAVE"

    const val EXTRA_TITLE = "title"
    const val EXTRA_ARTIST = "artist"
    const val EXTRA_SOURCE = "source"
    const val EXTRA_PLAYING = "playing"
    const val EXTRA_ARTWORK = "artwork"
    const val EXTRA_POSITION = "position"
    const val EXTRA_DURATION = "duration"
    const val EXTRA_NEXT = "canNext"
    const val EXTRA_PREVIOUS = "canPrevious"
    const val EXTRA_SAVE = "canSave"

    private const val CHANNEL = "playback"
    private const val NOTIFICATION_ID = 4712

    /**
     * Cover art is handed to the system by value, and a MediaMetadata crossing
     * a binder transaction has about a megabyte to live in. A 512px square at
     * ARGB_8888 is 1,048,576 bytes exactly — the whole budget, for one field.
     * 384 leaves room and is still more than the shade or the lock screen draws.
     */
    private const val ART_MAX_EDGE = 384

    /**
     * Starts or refreshes the notification.
     *
     * The first call has to happen while the app is on screen: from Android 12
     * a backgrounded process may not start a foreground service. Both callers
     * publish on first play for that reason, never on load and never on the
     * user leaving.
     */
    fun show(
      context: Context,
      title: String,
      artist: String?,
      source: String,
      playing: Boolean,
      artwork: String?,
      positionMs: Long,
      durationMs: Long,
      canNext: Boolean,
      canPrevious: Boolean,
      canSave: Boolean,
    ) {
      val intent = Intent(context, PlaybackService::class.java).apply {
        action = ACTION_SHOW
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_ARTIST, artist)
        putExtra(EXTRA_SOURCE, source)
        putExtra(EXTRA_PLAYING, playing)
        putExtra(EXTRA_ARTWORK, artwork)
        putExtra(EXTRA_POSITION, positionMs)
        putExtra(EXTRA_DURATION, durationMs)
        putExtra(EXTRA_NEXT, canNext)
        putExtra(EXTRA_PREVIOUS, canPrevious)
        putExtra(EXTRA_SAVE, canSave)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    fun stop(context: Context) {
      runCatching {
        context.startService(
          Intent(context, PlaybackService::class.java).apply { action = ACTION_STOP },
        )
      }
    }
  }

  private var session: MediaSessionCompat? = null
  private var wakeLock: PowerManager.WakeLock? = null

  private var title: String = "Playing"
  private var artist: String? = null
  private var source: String = ""
  private var playing: Boolean = false
  private var positionMs: Long = 0
  private var durationMs: Long = 0
  private var canNext: Boolean = false
  private var canPrevious: Boolean = false
  private var canSave: Boolean = false
  private var started: Boolean = false

  /** The cover the caller last asked for, and the one actually decoded. */
  private var artworkPath: String? = null
  private var artworkLoaded: String? = null
  private var artwork: Bitmap? = null

  private val decoder = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannel()
    session = MediaSessionCompat(this, "spool").apply {
      setCallback(
        object : MediaSessionCompat.Callback() {
          override fun onPlay() = command("play")

          /** Assumed to work, for the reason ACTION_PAUSE spells out. */
          override fun onPause() {
            playing = false
            publish()
            command("pause")
          }

          override fun onStop() = command("stop")
          override fun onSkipToNext() = command("next")
          override fun onSkipToPrevious() = command("previous")

          /** Where the card's save button arrives on Android 13 and up. */
          override fun onCustomAction(action: String?, extras: Bundle?) {
            if (action == CUSTOM_SAVE) command("save")
          }

          /**
           * The scrubber reports milliseconds; everything above this line
           * counts in seconds, because that is what both players take.
           */
          override fun onSeekTo(pos: Long) {
            positionMs = pos.coerceAtLeast(0)
            publish()
            command("seek", positionMs / 1000.0)
          }
        },
      )
      isActive = true
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_SHOW -> {
        title = intent.getStringExtra(EXTRA_TITLE)?.takeIf { it.isNotBlank() } ?: title
        artist = intent.getStringExtra(EXTRA_ARTIST)
        source = intent.getStringExtra(EXTRA_SOURCE).orEmpty()
        playing = intent.getBooleanExtra(EXTRA_PLAYING, playing)
        artworkPath = intent.getStringExtra(EXTRA_ARTWORK)
        positionMs = intent.getLongExtra(EXTRA_POSITION, 0)
        durationMs = intent.getLongExtra(EXTRA_DURATION, 0)
        canNext = intent.getBooleanExtra(EXTRA_NEXT, false)
        canPrevious = intent.getBooleanExtra(EXTRA_PREVIOUS, false)
        canSave = intent.getBooleanExtra(EXTRA_SAVE, false)
        publish()
      }

      /**
       * The buttons only ask. Whichever source owns the card is what actually
       * plays or pauses, and it reports back through ACTION_SHOW.
       *
       * A pause is reflected here immediately and a play deliberately is not,
       * and the asymmetry is not tidiness. Pausing always works. Resuming does
       * not: when the browser owns the card and the app is off screen, the page
       * is a hidden document, and a hidden document may not start media without
       * a user gesture — measured, it resumed for about eight seconds and died,
       * and the page's timers were frozen by then so no report ever arrived to
       * correct the card. It sat there saying PLAYING over silence, with the
       * only affordance being a pause button for something that was not going.
       *
       * So: assume a pause worked, never assume a play did. A play that does
       * work says so within a tick, from the source itself.
       */
      ACTION_PLAY -> command("play")

      ACTION_PAUSE -> {
        playing = false
        publish()
        command("pause")
      }

      ACTION_NEXT -> command("next")
      ACTION_PREVIOUS -> command("previous")

      /**
       * Nothing is reflected here. Whether the save is allowed, what quality it
       * lands at and whether it fails are all decided above this layer, and the
       * card stops offering the button when the download appears in the
       * library. Guessing at any of that from here would be a button that
       * reported its own wish rather than what happened.
       */
      ACTION_SAVE -> command("save")

      ACTION_DISMISS -> {
        command("stop")
        teardown()
      }

      ACTION_STOP -> teardown()

      // Headset and Bluetooth keys arrive as a raw media button intent and are
      // turned into the callbacks above by the session.
      else -> session?.let { MediaButtonReceiver.handleIntent(it, intent) }
    }

    return START_NOT_STICKY
  }

  /** A swiped-away task should not leave a notification behind. */
  override fun onTaskRemoved(rootIntent: Intent?) {
    command("stop")
    teardown()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    releaseWakeLock()
    decoder.shutdownNow()
    session?.run {
      isActive = false
      release()
    }
    session = null
    artwork = null
    super.onDestroy()
  }

  private fun command(name: String, value: Double = 0.0) {
    runCatching { PlaybackCommandBus.emit(name, value) }
  }

  private fun publish() {
    loadArtworkIfNeeded()

    session?.apply {
      setMetadata(metadata())
      setPlaybackState(state())
    }

    val notification = build()
    if (!started) {
      startForegroundCompat(notification)
      started = true
    } else {
      getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification)
    }

    if (playing) acquireWakeLock() else releaseWakeLock()
  }

  /**
   * The card's second line.
   *
   * Android 13 and up take it from the session's ARTIST and nowhere else — the
   * notification's own `contentText` is not drawn, and `setSubText` lands in a
   * header the media template does not have. So the source label rides here,
   * after the artist, which is the only place on the card it can be seen at all.
   */
  private fun subtitle(): String =
    listOfNotNull(artist?.takeIf { it.isNotBlank() }, source.takeIf { it.isNotBlank() })
      .joinToString(" · ")
      .ifBlank { "Spool" }

  private fun metadata(): MediaMetadataCompat =
    MediaMetadataCompat.Builder()
      .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
      .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, subtitle())
      // Surfaces that show three lines — Android Auto, some watches — get the
      // source on its own rather than doubled into the artist.
      .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, source)
      .apply {
        // A duration of zero is not "zero seconds", it is "not known yet" —
        // a live page, or a file whose length has not been read. Set it anyway
        // and the system draws a scrubber over a track it thinks is empty.
        if (durationMs > 0) {
          putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs)
        }
        artwork?.let {
          putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it)
          putBitmap(MediaMetadataCompat.METADATA_KEY_ART, it)
        }
      }
      .build()

  private fun state(): PlaybackStateCompat {
    var actions = PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_STOP
    actions = actions or if (playing) {
      PlaybackStateCompat.ACTION_PAUSE
    } else {
      PlaybackStateCompat.ACTION_PLAY
    }
    if (canNext) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_NEXT
    if (canPrevious) actions = actions or PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
    if (durationMs > 0) actions = actions or PlaybackStateCompat.ACTION_SEEK_TO

    return PlaybackStateCompat.Builder()
      .setActions(actions)
      .apply {
        // Added only when saving is a real thing to do here — a page that is
        // not already on the device. A library track has nowhere to be saved
        // to, and the button is absent rather than inert.
        if (canSave) {
          addCustomAction(
            PlaybackStateCompat.CustomAction
              .Builder(CUSTOM_SAVE, "Save", R.drawable.spool_ic_save)
              .build(),
          )
        }
      }
      // The speed is what makes the scrubber move on its own between updates.
      // Zero while paused, or the thumb crawls on across a stopped track.
      .setState(
        if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
        positionMs,
        if (playing) 1f else 0f,
      )
      .build()
  }

  private fun build(): Notification {
    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setContentTitle(title)
      .setContentText(subtitle())
      .setSubText(source.takeIf { it.isNotBlank() })
      .setSmallIcon(R.drawable.spool_ic_notification)
      .setLargeIcon(artwork)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_TRANSPORT)
      .setSilent(true)
      .setOngoing(playing)
      .setShowWhen(false)
      .setContentIntent(launchIntent())
      .setDeleteIntent(service(4, ACTION_DISMISS))

    /**
     * Android 13 and up ignore these and read the session instead. They are
     * here for older releases, where the notification's own actions are the
     * only transport there is — and where the compact view shows exactly the
     * three named below.
     */
    val compact = mutableListOf<Int>()
    var slot = 0

    if (canPrevious) {
      builder.addAction(
        R.drawable.spool_ic_previous,
        "Previous",
        service(6, ACTION_PREVIOUS),
      )
      compact.add(slot++)
    }

    if (playing) {
      builder.addAction(R.drawable.spool_ic_pause, "Pause", service(2, ACTION_PAUSE))
    } else {
      builder.addAction(R.drawable.spool_ic_play, "Play", service(3, ACTION_PLAY))
    }
    compact.add(slot++)

    if (canNext) {
      builder.addAction(R.drawable.spool_ic_next, "Next", service(7, ACTION_NEXT))
      compact.add(slot++)
    }

    // Last, so the transport keeps the order the card has everywhere else, and
    // only into the collapsed view if the transport has not already filled it —
    // three is all the compact view draws.
    if (canSave) {
      builder.addAction(R.drawable.spool_ic_save, "Save", service(8, ACTION_SAVE))
      if (compact.size < 3) compact.add(slot)
    }

    return builder
      .setStyle(
        androidx.media.app.NotificationCompat.MediaStyle()
          .setMediaSession(session?.sessionToken)
          .setShowActionsInCompactView(*compact.toIntArray()),
      )
      .build()
  }

  /**
   * Covers are decoded off the main thread and only when the path changes.
   * `publish` runs on every transport change; re-reading and re-scaling a JPEG
   * each time would put file I/O on the main thread for a picture that has not
   * moved since the track started.
   */
  private fun loadArtworkIfNeeded() {
    val path = artworkPath
    if (path == artworkLoaded) return
    artworkLoaded = path

    if (path.isNullOrBlank()) {
      artwork = null
      return
    }

    decoder.execute {
      val bitmap = runCatching { decodeArtwork(path) }.getOrNull()
      main.post {
        // A later track may have overtaken this decode while it ran.
        if (artworkLoaded != path) return@post
        artwork = bitmap
        if (started) publish()
      }
    }
  }

  private fun decodeArtwork(path: String): Bitmap? {
    val file = Uri.parse(path).path?.let { java.io.File(it) } ?: return null
    if (!file.exists() || file.length() == 0L) return null

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    val longest = maxOf(bounds.outWidth, bounds.outHeight)
    if (longest <= 0) return null

    var sample = 1
    while (longest / (sample * 2) >= ART_MAX_EDGE) sample *= 2

    return BitmapFactory.decodeFile(
      file.absolutePath,
      BitmapFactory.Options().apply { inSampleSize = sample },
    )
  }

  private fun service(requestCode: Int, action: String): PendingIntent =
    PendingIntent.getService(
      this,
      requestCode,
      Intent(this, PlaybackService::class.java).apply { this.action = action },
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  private fun launchIntent(): PendingIntent? {
    val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return null
    return PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
  }

  private fun ensureChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL) != null) return
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
        setSound(null, null)
        enableVibration(false)
        setShowBadge(false)
      },
    )
  }

  /**
   * Wrapped, because this is the call Android 12 and up refuse when the process
   * that asked was already in the background — and an uncaught
   * ForegroundServiceStartNotAllowedException here takes the whole app down.
   * Failing means playback lasts only as long as the process does, which is bad
   * but survivable; crashing is neither.
   */
  private fun startForegroundCompat(notification: Notification) {
    runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
    }
  }

  /**
   * Only held while sound is actually coming out. A wake lock left on across a
   * pause is the classic way an app quietly eats a battery overnight.
   */
  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val power = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "spool:playback").apply {
      setReferenceCounted(false)
      runCatching { acquire(4L * 60 * 60 * 1000) }
    }
  }

  private fun releaseWakeLock() {
    wakeLock?.let { if (it.isHeld) runCatching { it.release() } }
    wakeLock = null
  }

  private fun teardown() {
    releaseWakeLock()
    started = false
    playing = false
    artwork = null
    artworkPath = null
    artworkLoaded = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
      stopForeground(STOP_FOREGROUND_REMOVE)
    } else {
      @Suppress("DEPRECATION")
      stopForeground(true)
    }
    stopSelf()
  }
}

/**
 * Carries lock screen, notification and headset commands to the module, which
 * forwards them to JavaScript. A plain object rather than a binder: the service
 * and the module live in the same process, and the traffic is six verbs.
 *
 * `value` is only meaningful for `seek`, where it is a position in seconds.
 */
object PlaybackCommandBus {
  private val listeners = mutableListOf<(String, Double) -> Unit>()

  fun register(listener: (String, Double) -> Unit) {
    synchronized(listeners) { listeners.add(listener) }
  }

  fun unregister(listener: (String, Double) -> Unit) {
    synchronized(listeners) { listeners.remove(listener) }
  }

  fun emit(command: String, value: Double = 0.0) {
    synchronized(listeners) { listeners.toList() }.forEach { runCatching { it(command, value) } }
  }
}
