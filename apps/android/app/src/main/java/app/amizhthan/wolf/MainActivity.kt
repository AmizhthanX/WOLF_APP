package app.amizhthan.wolf

import android.content.Context
import android.os.Build
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.lifecycle.viewmodel.compose.viewModel
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.remote.RemoteDesktopController
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.ui.AlertsAutomationsViewModel
import app.amizhthan.wolf.storage.ContentResolverDocuments
import app.amizhthan.wolf.ui.AppViewModel
import app.amizhthan.wolf.ui.ConfigurationViewModel
import app.amizhthan.wolf.ui.WolfApp
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // No screenshots, no screen recording, no thumbnail in the recent-apps view. This app shows
        // other machines' screens and the owner's password field; neither belongs in a gallery.
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)

        val graph = AppGraph.get(applicationContext)
        setContent {
            WolfApp(
                viewModel = viewModel {
                    AppViewModel(graph.session, graph.api) { pcId ->
                        RemoteDesktopController(applicationContext, pcId, graph.api, graph.session, graph.http)
                    }
                },
                alerts = viewModel { AlertsAutomationsViewModel(graph.session, graph.api) },
                configuration = viewModel {
                    ConfigurationViewModel(graph.session, graph.api, ContentResolverDocuments(applicationContext.contentResolver))
                },
            )
        }
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
        vault = TokenVault(File(context.noBackupFilesDir, "credentials.bin"), KeystoreSecretCipher()),
        identity = KeystoreDeviceIdentity(context),
        deviceName = listOfNotNull(Build.MANUFACTURER, Build.MODEL).joinToString(" "),
        platform = "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})",
    )

    companion object {
        @Volatile
        private var instance: AppGraph? = null

        fun get(context: Context): AppGraph =
            instance ?: synchronized(this) { instance ?: AppGraph(context.applicationContext).also { instance = it } }
    }
}
