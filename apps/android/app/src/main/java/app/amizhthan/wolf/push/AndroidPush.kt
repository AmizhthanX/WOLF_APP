package app.amizhthan.wolf.push

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.amizhthan.wolf.MainActivity
import app.amizhthan.wolf.R
import app.amizhthan.wolf.api.NotificationView
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.suspendCancellableCoroutine
import java.time.Instant
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Starting Firebase from this build's project settings, or reporting that the build has none.
 *
 * Firebase's own start-up provider is removed in the manifest; this is the only place it is started, and only when
 * all four settings were supplied at build time.
 */
object PushSetup {
    fun initialize(context: Context): Boolean {
        val resources = context.resources
        val applicationId = resources.getString(R.string.wolf_firebase_application_id)
        val projectId = resources.getString(R.string.wolf_firebase_project_id)
        val apiKey = resources.getString(R.string.wolf_firebase_api_key)
        val senderId = resources.getString(R.string.wolf_firebase_sender_id)
        if (listOf(applicationId, projectId, apiKey, senderId).any { it.isBlank() }) return false

        if (FirebaseApp.getApps(context).isEmpty()) {
            FirebaseApp.initializeApp(
                context,
                FirebaseOptions.Builder()
                    .setApplicationId(applicationId)
                    .setProjectId(projectId)
                    .setApiKey(apiKey)
                    .setGcmSenderId(senderId)
                    .build(),
            )
        }
        return true
    }
}

class FirebasePushTokens : PushTokens {
    override suspend fun current(): String? = FirebaseMessaging.getInstance().token.awaitResult()

    override suspend fun delete() {
        FirebaseMessaging.getInstance().deleteToken().awaitResult()
    }
}

private suspend fun <T> Task<T>.awaitResult(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        val error = task.exception
        when {
            error != null -> continuation.resumeWithException(error)
            task.isCanceled -> continuation.cancel()
            else -> continuation.resume(task.result)
        }
    }
}

/**
 * Notifications on this phone, from what was fetched from WOLF.
 *
 * The owner's own phone shows the alert's title and detail — but **not on the lock screen**, where the public
 * version says only that WOLF has something. Critical alerts get their own channel, so the owner can let those
 * through while quieting the rest. Nothing is posted without the notification permission.
 */
class AndroidNotifier(private val context: Context) : Notifier {
    private val manager = context.getSystemService(NotificationManager::class.java)

    fun allowed(): Boolean =
        manager.areNotificationsEnabled() &&
            (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    override fun show(notification: NotificationView) {
        if (!allowed()) return
        ensureChannels()

        val channel = if (notification.severity == "critical" && notification.kind != "resolved") CHANNEL_CRITICAL else CHANNEL_ALERTS
        val built = Notification.Builder(context, channel)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle(notification.title)
            .setContentText(notification.detail)
            .setStyle(Notification.BigTextStyle().bigText(notification.detail))
            .setWhen(runCatching { Instant.parse(notification.occurredAt).toEpochMilli() }.getOrDefault(System.currentTimeMillis()))
            .setShowWhen(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(channel))
            .setCategory(Notification.CATEGORY_STATUS)
            .setAutoCancel(true)
            .setContentIntent(openAlerts())
            .build()
        manager.notify(TAG, notification.id.hashCode(), built)
    }

    override fun showSummary(more: Int) {
        if (!allowed()) return
        ensureChannels()
        val built = Notification.Builder(context, CHANNEL_ALERTS)
            .setSmallIcon(android.R.drawable.stat_sys_warning)
            .setContentTitle("WOLF")
            .setContentText("$more more in WOLF")
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion(CHANNEL_ALERTS))
            .setAutoCancel(true)
            .setContentIntent(openAlerts())
            .build()
        manager.notify(TAG, SUMMARY_ID, built)
    }

    private fun publicVersion(channel: String): Notification = Notification.Builder(context, channel)
        .setSmallIcon(android.R.drawable.stat_sys_warning)
        .setContentTitle("WOLF")
        .setContentText("Something needs your attention. Unlock to see it.")
        .build()

    private fun ensureChannels() {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ALERTS, "Alerts", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "Alert rules and automations reporting in."
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_CRITICAL, "Critical alerts", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Alerts whose rules are marked critical."
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
    }

    private fun openAlerts(): PendingIntent = PendingIntent.getActivity(
        context,
        0,
        Intent(context, MainActivity::class.java)
            .putExtra(MainActivity.EXTRA_OPEN, MainActivity.OPEN_ALERTS)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    companion object {
        const val CHANNEL_ALERTS = "wolf-alerts"
        const val CHANNEL_CRITICAL = "wolf-critical"
        const val TAG = "wolf-notification"
        private const val SUMMARY_ID = 1
    }
}

class PrefsRegistrationStore(context: Context) : RegistrationStore {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override var marker: String?
        get() = prefs.getString("registered", null)
        set(value) {
            prefs.edit().putString("registered", value).apply()
        }
}

class PrefsSeenStore(context: Context, private val limit: Int = 500) : SeenStore {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    override fun seen(): Set<String> = ids().toSet()

    override fun remember(ids: Collection<String>) {
        val kept = (ids() + ids).distinct().takeLast(limit)
        prefs.edit().putString("seen", kept.joinToString(",")).apply()
    }

    private fun ids(): List<String> = prefs.getString("seen", "").orEmpty().split(',').filter { it.isNotEmpty() }
}

private const val PREFS = "wolf-push"
