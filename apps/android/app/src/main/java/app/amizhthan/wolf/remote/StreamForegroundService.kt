package app.amizhthan.wolf.remote

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

/**
 * Keeps a remote desktop stream's connections alive while WOLF is not the app on screen.
 *
 * Android blocks network access for apps in the background, and "background" includes a moment behind the system
 * file picker. On the owner's phone, choosing a file to send to the PC cut the relay connection five seconds later
 * (`blocked=APP_BACKGROUND`, "Software caused connection abort"), which ended the stream and the upload with it.
 * A foreground service for as long as a stream is open is how Android lets a remote desktop keep its connection, and
 * says so to the owner with a notification that cannot be missed.
 *
 * The service holds no stream and does no work: it only marks the app as in use. The notification names no PC, so
 * a locked phone shows nothing about what the owner is connected to.
 */
class StreamForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Remote desktop", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Shown while a remote desktop stream is open."
                setShowBadge(false)
            },
        )
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
            PendingIntent.getActivity(this, 0, it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
        }
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("Remote desktop open")
            .setContentText("WOLF keeps the connection while you use another app. Disconnect in WOLF to end it.")
            .setOngoing(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .apply { open?.let(::setContentIntent) }
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_NOT_STICKY
    }

    companion object {
        private const val CHANNEL = "wolf-remote-desktop"
        private const val NOTIFICATION_ID = 7301

        fun start(context: Context) {
            runCatching { context.startForegroundService(Intent(context, StreamForegroundService::class.java)) }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, StreamForegroundService::class.java))
        }
    }
}
