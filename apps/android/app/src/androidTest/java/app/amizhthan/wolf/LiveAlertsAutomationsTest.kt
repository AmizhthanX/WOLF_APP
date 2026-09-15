package app.amizhthan.wolf

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.AlertRules
import app.amizhthan.wolf.api.AutomationResponse
import app.amizhthan.wolf.api.AutomationRunView
import app.amizhthan.wolf.api.Automations
import app.amizhthan.wolf.api.WolfApi
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
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Alert rules, the inbox and automations against a real WOLF API and, for the run, a real agent.
 *
 * It proves what the JVM tests cannot: that the rules and automations this app builds are ones the
 * server's schemas accept, that saving a high-risk automation really asks for the password, and that a
 * run by hand reaches the inbox. Nothing it saves can act on the PC — the one automation with a power
 * action is saved turned off, with a manual trigger, and is deleted before the test ends.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveAlertsAutomationsTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LiveAlertsAutomationsTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun rules_the_inbox_and_automations_against_a_real_wolf_api() = runBlocking {
        val baseUrl = arguments.getString("wolfLiveApi")
        if (baseUrl == null) {
            Log.i(TAG, "Not run: pass wolfLiveApi and wolfLivePassword with a local cloud and a running agent.")
            assertNull(arguments.getString("wolfLivePassword"))
            return@runBlocking
        }
        val email = arguments.getString("wolfLiveEmail") ?: "owner@example.com"
        val password = requireNotNull(arguments.getString("wolfLivePassword")) { "wolfLivePassword is required with wolfLiveApi" }

        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-automation-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-automation-wrap")
        val file = File(context.noBackupFilesDir, "live-automation-credentials.bin")
        val api = WolfApi(baseUrl.toHttpUrl(), OkHttpClient())
        val session = SessionManager(api, TokenVault(file, cipher), identity, "WOLF live automations test", "Android ${Build.VERSION.RELEASE}")
        val authority = AccountAuthority(api, session)
        val rules = mutableListOf<String>()
        val automations = mutableListOf<String>()

        fun <T> Authorized<T>.saved(): T = when (this) {
            is Authorized.Done -> value
            is Authorized.NeedsConfirmation -> throw AssertionError("expected a save, the server asked for ${pending.riskLevel}")
        }

        try {
            session.signIn(email, password)
            val pcs = session.authorized { api.listPcs(it) }.pcs
            val pc = requireNotNull(pcs.firstOrNull { it.status == "online" } ?: pcs.firstOrNull()) { "a PC is enrolled against this cloud" }

            // 1. Rules, in both shapes the phone builds.
            val offline = session.authorized {
                api.createAlertRule(AlertRules.rule("Live test: offline for a day", null, "pc-offline", null, null, null, 1440, "info", 60), it)
            }.rule
            rules += offline.id
            assertNull(offline.pcId)
            assertNull(offline.metric)

            val disk = session.authorized {
                api.createAlertRule(AlertRules.rule("Live test: disk nearly full", pc.id, "metric-above", "disk.usedPercent", 99.5, "C:", 30, "warning", 120), it)
            }.rule
            rules += disk.id
            assertEquals("C:", disk.seriesKey)
            assertEquals(99.5, disk.threshold!!, 0.0)

            assertTrue(session.authorized { api.listAlertRules(it) }.rules.map { it.id }.containsAll(rules))
            assertEquals(false, session.authorized { api.setAlertRuleEnabled(offline.id, false, it) }.rule.enabled)

            // 2. A notify-only automation: nothing to confirm, run by hand, reported in the inbox.
            val hello = Automations.definition(
                name = "Live test: say hello",
                trigger = Automations.manual(),
                conditions = emptyList(),
                actions = listOf(Automations.notify("Hello from the WOLF live test", "info")),
                targets = Automations.onPcs(listOf(pc.id)),
                cooldownMinutes = 1,
            )
            val saved = authority.attempt("Save", "Live test") { bearer, confirmed -> api.createAutomation(hello, confirmed, bearer) }.saved().automation
            automations += saved.id
            assertEquals("low", saved.authorizedRiskLevel)

            assertTrue(session.authorized { api.runAutomation(saved.id, it) }.accepted)
            var run: AutomationRunView? = null
            val deadline = System.currentTimeMillis() + 20_000
            while (System.currentTimeMillis() < deadline) {
                run = session.authorized { api.automationRuns(saved.id, it) }.runs.firstOrNull()
                if (run != null && run.status != "running") break
                delay(500)
            }
            Log.i(TAG, "run by hand on ${pc.name} (${pc.status}): ${run?.status} ${run?.reason.orEmpty()} ${run?.steps?.map { Automations.describeStep(it) }}")
            assertNotNull("the run was recorded", run)

            if (pc.status == "online") {
                assertEquals("completed", run!!.status)
                val note = session.authorized { api.listNotifications(it) }.notifications.firstOrNull { it.automationId == saved.id }
                assertNotNull("the notify action reached the inbox", note)
                assertEquals("automation", note!!.kind)
                session.authorized { api.markNotificationRead(note.id, it) }
                assertNotNull(session.authorized { api.listNotifications(it) }.notifications.first { it.id == note.id }.readAt)
            }

            // 3. High risk asks for the password. Saved off, manual only: it can never run.
            val restart = Automations.definition(
                name = "Live test: restart (never turned on)",
                trigger = Automations.manual(),
                conditions = listOf(Automations.noActiveSession()),
                actions = listOf(Automations.power("restart", 300)),
                targets = Automations.onPcs(listOf(pc.id)),
                maxRunsPerDay = 1,
                enabled = false,
            )
            val save: suspend (String, String?) -> AutomationResponse = { bearer, confirmed -> api.createAutomation(restart, confirmed, bearer) }

            val asked = authority.attempt("Authorize restart", "Live test", save)
            val pending = (asked as Authorized.NeedsConfirmation).pending
            assertEquals("high", pending.riskLevel)
            assertTrue(pending.requiresPassword)

            val high = authority.confirm(pending, password, save).saved().automation
            automations += high.id
            assertEquals("high", high.authorizedRiskLevel)
            assertEquals(false, high.enabled)

            // A rename cannot widen what it does, so the server asks for nothing.
            val renamed = authority.attempt("Rename", "Live test") { bearer, confirmed ->
                api.updateAutomation(high.id, Automations.renamePatch("Live test: restart, renamed"), confirmed, bearer)
            }.saved().automation
            assertEquals("Live test: restart, renamed", renamed.name)
            assertEquals(false, renamed.enabled)

            Log.i(TAG, "rules ${rules.size}, automations ${automations.size}: low saved at once, high saved after the password")
        } finally {
            automations.forEach { id -> runCatching { session.authorized { api.deleteAutomation(id, it) } } }
            rules.forEach { id -> runCatching { session.authorized { api.deleteAlertRule(id, it) } } }
            runCatching { session.signOut() }
            identity.delete()
            cipher.delete()
            file.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLiveAutomations"
    }
}
