package app.amizhthan.wolf

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.compose.setContent
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableIntStateOf
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import app.amizhthan.wolf.push.AndroidNotifier
import app.amizhthan.wolf.push.FirebasePushTokens
import app.amizhthan.wolf.push.PrefsRegistrationStore
import app.amizhthan.wolf.push.PrefsSeenStore
import app.amizhthan.wolf.push.PushRegistrar
import app.amizhthan.wolf.push.PushSetup
import app.amizhthan.wolf.push.PushTokens
import app.amizhthan.wolf.push.WakeHandler
import androidx.lifecycle.viewmodel.compose.viewModel
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.remote.RemoteDesktopController
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreLockCipher
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.ui.AlertsAutomationsViewModel
import app.amizhthan.wolf.storage.ContentResolverDocuments
import app.amizhthan.wolf.ui.AppViewModel
import app.amizhthan.wolf.ui.ConfigurationViewModel
import app.amizhthan.wolf.ui.WolfApp
import kotlinx.coroutines.launch
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** A FragmentActivity because the system's biometric prompt is shown from one. */
class MainActivity : FragmentActivity() {
    private val graph by lazy { AppGraph.get(applicationContext) }

    private var appViewModel: AppViewModel? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // No screenshots, no screen recording, no thumbnail in the recent-apps view. This app shows
        // other machines' screens and the owner's password field; neither belongs in a gallery.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        if (savedInstanceState == null && opensAlerts(intent)) alertsRequests.intValue += 1
        setContent {
            val app = viewModel {
                    AppViewModel(graph.session, graph.api, graph.pushRegistrar) { pcId ->
                        RemoteDesktopController(
                            applicationContext,
                            pcId,
                            graph.api,
                            graph.session,
                            graph.http,
                            ContentResolverDocuments(applicationContext.contentResolver),
                        )
                    }
            }
            appViewModel = app
            val requests = alertsRequests.intValue
            LaunchedEffect(requests) { if (requests > 0) app.openAlertsWhenSignedIn() }
            WolfApp(
                viewModel = app,
                alerts = viewModel { AlertsAutomationsViewModel(graph.session, graph.api, pushRegistrar = graph.pushRegistrar) },
                configuration = viewModel {
                    ConfigurationViewModel(graph.session, graph.api, ContentResolverDocuments(applicationContext.contentResolver))
                },
                onUnlock = ::promptUnlock,
                onAppLock = ::promptAppLock,
            )
        }
    }

    override fun onStart() {
        super.onStart()
        lifecycleScope.launch { graph.session.cameToForeground() }
    }

    override fun onStop() {
        super.onStop()
        // A rotation stops and starts the activity within a moment; the lock is minutes away, so that costs nothing.
        graph.session.wentToBackground()
    }

    /** Taps on a notification while the app is already running arrive here. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (opensAlerts(intent)) alertsRequests.intValue += 1
    }

    private fun promptUnlock() = authenticate(
        title = "Unlock WOLF",
        subtitle = "With your fingerprint or screen lock",
        onSuccess = { appViewModel?.unlock() },
        onEnded = { reason -> appViewModel?.lockPromptEnded("Not unlocked: $reason") },
    )

    private fun promptAppLock(enabled: Boolean) = authenticate(
        title = if (enabled) "Turn on app lock" else "Turn off app lock",
        subtitle = "Confirm it is you",
        onSuccess = { appViewModel?.setAppLock(enabled) },
        onEnded = { reason -> appViewModel?.lockPromptEnded("App lock was not changed: $reason") },
    )

    /**
     * The system's own prompt: a fingerprint or face of the strong class, or the screen lock. WOLF sees neither — only
     * that the phone accepted one. The prompt is how the owner reaches the lock; the Keystore key it opens is the lock.
     */
    private fun authenticate(title: String, subtitle: String, onSuccess: () -> Unit, onEnded: (String) -> Unit) {
        val authenticators = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        } else {
            // Android 9 and 10 cannot offer the screen lock beside a strong biometric, only beside a weak one. A weak
            // biometric does not open the Keystore key, so an unlock made with one says so and asks again.
            BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        }
        if (BiometricManager.from(this).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            onEnded("this phone has no screen lock, which the app lock needs. Set one in Android's settings.")
            return
        }

        val prompt = BiometricPrompt(
            this,
            mainExecutor,
            object : BiometricPrompt.AuthenticationCallback() {
                override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = onSuccess()
                override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = onEnded(errString.toString())
            },
        )
        prompt.authenticate(
            BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setAllowedAuthenticators(authenticators)
                .build(),
        )
    }

    private val alertsRequests = mutableIntStateOf(0)

    private fun opensAlerts(intent: Intent?): Boolean = intent?.getStringExtra(EXTRA_OPEN) == OPEN_ALERTS

    companion object {
        const val EXTRA_OPEN = "app.amizhthan.wolf.OPEN"
        const val OPEN_ALERTS = "alerts"
    }
}

/** The app's long-lived objects, created once per process. */
class AppGraph private constructor(context: Context) {
    val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS)
        .build()

    val api = WolfApi(ApiEndpoint.BASE_URL.toHttpUrl(), http)

    val session = SessionManager(
        api = api,
        // noBackupFilesDir: excluded from Auto Backup by the platform, not only by our rules.
        vault = TokenVault(File(context.noBackupFilesDir, "credentials.bin"), KeystoreSecretCipher(), KeystoreLockCipher()),
        identity = KeystoreDeviceIdentity(context),
        deviceName = listOfNotNull(Build.MANUFACTURER, Build.MODEL).joinToString(" "),
        platform = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
    )

    /** This build's push service, or null when it was built without a Firebase project. */
    val pushTokens: PushTokens? = if (PushSetup.initialize(context)) FirebasePushTokens() else null

    val pushRegistrar = PushRegistrar(api, session, pushTokens, PrefsRegistrationStore(context))

    val wakeHandler = WakeHandler(api, session, AndroidNotifier(context), PrefsSeenStore(context))

    companion object {
        @Volatile
        private var instance: AppGraph? = null

        fun get(context: Context): AppGraph =
            instance ?: synchronized(this) { instance ?: AppGraph(context.applicationContext).also { instance = it } }
    }
}
