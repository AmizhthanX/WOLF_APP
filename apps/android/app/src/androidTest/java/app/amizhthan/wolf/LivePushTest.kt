package app.amizhthan.wolf

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.Automations
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.push.AndroidNotifier
import app.amizhthan.wolf.push.PushRegistrar
import app.amizhthan.wolf.push.PushTokens
import app.amizhthan.wolf.push.RegistrationStore
import app.amizhthan.wolf.push.SeenStore
import app.amizhthan.wolf.push.WakeHandler
import app.amizhthan.wolf.remote.Ulid
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.AccountAuthority
import app.amizhthan.wolf.session.Authorized
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The phone's half of push against a real WOLF API, a real agent, and the phone's real notification manager.
 *
 * **What it cannot prove:** that Google delivers a wake-up. That needs a Firebase project, which this repository
 * does not have; the token registered here is synthetic, and the server under test has no push service. What it
 * proves is everything either side of Google: WOLF records this phone's registration and clears it on sign-out,
 * and a wake-up — here, called directly, as the messaging service calls it — fetches a real notification from WOLF
 * and posts it on the phone: once, private on the lock screen, and not again on the next wake-up.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LivePushTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LivePushTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private class SyntheticTokens(var token: String?) : PushTokens {
        override suspend fun current(): String? = token
        override suspend fun delete() {
            token = null
        }
    }

    private class MemoryStore : RegistrationStore, SeenStore {
        override var marker: String? = null
        val ids = LinkedHashSet<String>()
        override fun seen(): Set<String> = ids.toSet()
        override fun remember(ids: Collection<String>) {
            this.ids += ids
        }
    }

    @Test
    fun registers_and_turns_a_wake_up_into_a_private_notification() = runBlocking {
        val baseUrl = arguments.getString("wolfLiveApi")
        if (baseUrl == null) {
            Log.i(TAG, "Not run: pass wolfLiveApi and wolfLivePassword with a local cloud and a running agent.")
            assertNull(arguments.getString("wolfLivePassword"))
            return@runBlocking
        }
        val email = arguments.getString("wolfLiveEmail") ?: "owner@example.com"
        val password = requireNotNull(arguments.getString("wolfLivePassword"))

        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-push-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-push-wrap")
        val credentials = File(context.noBackupFilesDir, "live-push-credentials.bin")
        val api = WolfApi(baseUrl.toHttpUrl(), OkHttpClient())
        val session = SessionManager(api, TokenVault(credentials, cipher), identity, "WOLF live push test", "Android ${Build.VERSION.RELEASE}")
        val manager = context.getSystemService(NotificationManager::class.java)
        var automationId: String? = null

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
        manager.cancelAll()

        try {
            session.signIn(email, password)

            // 1. Registration, and what the server says about push.
            val tokens = SyntheticTokens("wolf-live-synthetic-token-${Ulid.next()}")
            val store = MemoryStore()
            val registrar = PushRegistrar(api, session, tokens, store)
            val state = registrar.sync()
            Log.i(TAG, "push state: $state")
            assertTrue("WOLF holds this phone's registration", state.registered)
            assertTrue(session.authorized { api.pushStatus(it) }.registered)

            // 2. A real notification to fetch: a notify-only automation run by hand.
            val pc = requireNotNull(session.authorized { api.listPcs(it) }.pcs.firstOrNull { it.status == "online" }) { "an online PC is enrolled against this cloud" }
            val definition = Automations.definition(
                name = "Live test: push",
                trigger = Automations.manual(),
                conditions = emptyList(),
                actions = listOf(Automations.notify("Wake-up check from the WOLF live test", "warning")),
                targets = Automations.onPcs(listOf(pc.id)),
                cooldownMinutes = 1,
            )
            val saved = AccountAuthority(api, session).attempt("Save", "Live test") { bearer, confirmed -> api.createAutomation(definition, confirmed, bearer) }
            automationId = (saved as Authorized.Done).value.automation.id
            session.authorized { api.runAutomation(automationId, it) }
            val deadline = System.currentTimeMillis() + 20_000
            while (System.currentTimeMillis() < deadline) {
                if (session.authorized { api.listNotifications(it) }.notifications.any { it.automationId == automationId }) break
                delay(500)
            }

            // 3. The wake-up, as the messaging service performs it, with the phone's real notification manager.
            val wake = WakeHandler(api, session, AndroidNotifier(context), store)
            val shown = wake.onWake()
            Log.i(TAG, "first wake-up: $shown new")
            assertTrue("the wake-up found the new notification", shown >= 1)

            val posted = manager.activeNotifications.filter { it.tag == AndroidNotifier.TAG }
            assertTrue("a notification is on the phone", posted.isNotEmpty())
            posted.forEach { entry ->
                val notification = entry.notification
                assertEquals("private on the lock screen", Notification.VISIBILITY_PRIVATE, notification.visibility)
                val publicText = notification.publicVersion?.extras?.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
                assertTrue("the lock-screen version is generic", publicText.contains("Unlock to see it"))
                assertFalse("the lock-screen version names nothing", publicText.contains(pc.name))
            }
            Log.i(TAG, "posted ${posted.size}: channels ${posted.map { it.notification.channelId }}")

            // 4. The same news is not shown twice.
            assertEquals(0, wake.onWake())

            // 5. Signing out clears the registration on the server.
            registrar.unregister()
            assertFalse(session.authorized { api.pushStatus(it) }.registered)
            assertNull(store.marker)
        } finally {
            manager.cancelAll()
            automationId?.let { id -> runCatching { session.authorized { api.deleteAutomation(id, it) } } }
            runCatching { session.signOut() }
            identity.delete()
            cipher.delete()
            credentials.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLivePush"
    }
}
