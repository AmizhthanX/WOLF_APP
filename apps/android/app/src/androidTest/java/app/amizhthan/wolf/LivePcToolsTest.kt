package app.amizhthan.wolf

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.AutomationResponse
import app.amizhthan.wolf.api.Automations
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.ServiceListResult
import app.amizhthan.wolf.api.StartupListResult
import app.amizhthan.wolf.api.TaskListResult
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfJson
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.AccountAuthority
import app.amizhthan.wolf.session.Authorized
import app.amizhthan.wolf.session.CommandOutcome
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonObject
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
 * Services, scheduled tasks and startup items against a real WOLF API and a real agent.
 *
 * It reads all three lists from the PC — or, where the privileged helper is not there, proves the PC says
 * why rather than returning an empty list. Then it asks the server to classify changes and **confirms none
 * of them**: a refused dispatch never reaches the PC, so nothing on the machine is touched. Last, a service
 * action built from the phone is saved into an automation that is off and manual-only, and deleted.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LivePcToolsTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LivePcToolsTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun reads_what_runs_on_a_real_pc_and_classifies_changes_without_making_any() = runBlocking {
        val baseUrl = arguments.getString("wolfLiveApi")
        if (baseUrl == null) {
            Log.i(TAG, "Not run: pass wolfLiveApi and wolfLivePassword with a local cloud and a running agent.")
            assertNull(arguments.getString("wolfLivePassword"))
            return@runBlocking
        }
        val email = arguments.getString("wolfLiveEmail") ?: "owner@example.com"
        val password = requireNotNull(arguments.getString("wolfLivePassword")) { "wolfLivePassword is required with wolfLiveApi" }

        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-tools-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-tools-wrap")
        val file = File(context.noBackupFilesDir, "live-tools-credentials.bin")
        val api = WolfApi(baseUrl.toHttpUrl(), OkHttpClient())
        val session = SessionManager(api, TokenVault(file, cipher), identity, "WOLF live PC tools test", "Android ${Build.VERSION.RELEASE}")
        var controller: PcSessionController? = null
        var automationId: String? = null

        try {
            session.signIn(email, password)
            val pc = requireNotNull(session.authorized { api.listPcs(it) }.pcs.firstOrNull { it.status == "online" }) { "an online PC is enrolled against this cloud" }
            val tools = PcSessionController(pc.id, api, session).also { controller = it }

            suspend fun <T> list(command: JsonObject, serializer: KSerializer<T>): T {
                val outcome = tools.run(command, "List", "Live test")
                val done = (outcome as? CommandOutcome.Done) ?: throw AssertionError("a list asked for confirmation: $outcome")
                assertEquals("the list command completed (${done.command.failure})", "completed", done.command.status)
                return WolfJson.decodeFromJsonElement(serializer, requireNotNull(done.command.result))
            }

            // 1. The three lists: rows, or an empty list with the reason WOLF could not ask.
            val services = list(Commands.serviceList(), ServiceListResult.serializer())
            assertTrue("services, or the reason there are none", services.services.isNotEmpty() || (!services.helperAvailable && services.unavailableReason != null))
            Log.i(TAG, "services: ${services.services.size}, helper ${services.helperAvailable}, ${services.unavailableReason.orEmpty()}")

            val tasks = list(Commands.taskList(), TaskListResult.serializer())
            assertTrue("tasks, or the reason there are none", tasks.tasks.isNotEmpty() || (!tasks.helperAvailable && tasks.unavailableReason != null))
            Log.i(TAG, "tasks: ${tasks.tasks.size}, helper ${tasks.helperAvailable}, ${tasks.unavailableReason.orEmpty()}")

            val startup = list(Commands.startupList(), StartupListResult.serializer())
            assertTrue("startup items were read, or the reason they were not", startup.helperAvailable || startup.unavailableReason != null)
            Log.i(TAG, "startup items: ${startup.entries.size}, helper ${startup.helperAvailable}, ${startup.unavailableReason.orEmpty()}")

            // 2. Classification, never execution. Each is refused for a confirmation that this test never gives.
            suspend fun level(command: JsonObject): String {
                val outcome = tools.run(command, "Classify", "Live test: not confirmed")
                return (outcome as? CommandOutcome.NeedsConfirmation)?.pending?.riskLevel
                    ?: throw AssertionError("a change ran without being confirmed: $outcome")
            }
            val levels = mapOf(
                "stop Print Spooler" to level(Commands.serviceControl("Spooler", "stop", "Print Spooler")),
                "stop RpcSs" to level(Commands.serviceControl("RpcSs", "stop", "Remote Procedure Call (RPC)")),
                "disable Spooler" to level(Commands.serviceSetStartType("Spooler", "disabled", "Print Spooler")),
                "run a task" to level(Commands.taskControl("\\Microsoft\\Windows\\Defrag\\ScheduledDefrag", "run", "ScheduledDefrag")),
                "disable an update task" to level(Commands.taskControl("\\Microsoft\\Windows\\WindowsUpdate\\Scheduled Start", "disable", "Scheduled Start")),
                "disable a startup item" to level(Commands.startupSetEnabled("OneDrive", "user", "run", false)),
            )
            Log.i(TAG, "classified, none confirmed: $levels")
            assertEquals("high", levels["stop Print Spooler"])
            assertEquals("critical", levels["stop RpcSs"])
            assertEquals("critical", levels["disable Spooler"])
            assertEquals("high", levels["run a task"])
            assertEquals("critical", levels["disable an update task"])
            assertEquals("medium", levels["disable a startup item"])

            // 3. A service action the phone built, accepted into an automation that is off and manual-only.
            val definition = Automations.definition(
                name = "Live test: restart Print Spooler (never turned on)",
                trigger = Automations.manual(),
                conditions = listOf(Automations.noActiveSession()),
                actions = listOf(Automations.serviceControl("Spooler", "restart", "Print Spooler")),
                targets = Automations.onPcs(listOf(pc.id)),
                maxRunsPerDay = 1,
                enabled = false,
            )
            val authority = AccountAuthority(api, session)
            val save: suspend (String, String?) -> AutomationResponse = { bearer, confirmed -> api.createAutomation(definition, confirmed, bearer) }
            val pending = (authority.attempt("Authorize", "Live test", save) as Authorized.NeedsConfirmation).pending
            assertEquals("high", pending.riskLevel)
            val saved = when (val outcome = authority.confirm(pending, password, save)) {
                is Authorized.Done -> outcome.value.automation
                is Authorized.NeedsConfirmation -> throw AssertionError("asked again, for ${outcome.pending.riskLevel}")
            }
            automationId = saved.id
            assertEquals(false, saved.enabled)
            assertNotNull(saved.actions.single())
            Log.i(TAG, "automation saved off: ${Automations.describeAction(saved.actions.single())}")
        } finally {
            automationId?.let { id -> runCatching { session.authorized { api.deleteAutomation(id, it) } } }
            runCatching { controller?.close() }
            runCatching { session.signOut() }
            identity.delete()
            cipher.delete()
            file.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLivePcTools"
    }
}
