package app.amizhthan.wolf.api

import app.amizhthan.wolf.JvmAesGcmCipher
import app.amizhthan.wolf.JvmDeviceIdentity
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.AccountAuthority
import app.amizhthan.wolf.session.Authorized
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Backup and restore against a fake API that behaves like `routes/configuration.ts`: a restore is always
 * at least medium, high when restored automations are turned on, and the file is verified by the server.
 */
class ConfigurationApiTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private val damaged = "0".repeat(64)

    private val file =
        """{"format":"wolf.configuration","version":1,"createdAt":"2026-09-15T08:30:00.000Z","checksum":"${"a".repeat(64)}",""" +
            """"content":{"pcs":[],"remoteDesktopProfiles":[],"alertRules":[{"id":"01J9ZQK7T0000000000000000R","rule":{"name":"Disk","condition":"metric-above","metric":"disk.usedPercent","threshold":99.5,"forMinutes":30}}],"automations":[]}}"""

    private fun refusal(status: Int, code: String, riskLevel: String? = null) = MockResponse().setResponseCode(status).setBody(
        """{"error":{"code":"$code","problem":"Refused.","cause":"Test.","currentState":"Nothing was changed.","recommendedAction":"Try again.","referenceId":"WOLF-CFG-TEST"${riskLevel?.let { ",\"context\":{\"riskLevel\":\"$it\"}" } ?: ""}}}""",
    )

    private fun plan(risk: String, enabled: Int) =
        """{"sections":{"alertRules":{"created":1,"updated":0,"deleted":2,"skipped":0}},"warnings":[{"code":"rule-pc-missing","section":"alertRules","id":"01J9ZQK7T0000000000000000R","message":"A rule about a PC that is not enrolled was not restored."}],"automationsEnabled":$enabled,"riskLevel":"$risk"}"""

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                requests += request to body
                val bearer = request.getHeader("Authorization")?.removePrefix("Bearer ")
                return when ("${request.method} ${request.path}") {
                    "POST /api/v1/auth/login" -> MockResponse().setBody(
                        """{"accessToken":"access-1","accessTokenExpiresAt":"${Instant.now().plusSeconds(600)}","refreshToken":"refresh-1-0123456789abcdef","refreshTokenExpiresAt":"${Instant.now().plusSeconds(86400)}","device":{"id":"01J9ZQK7T0000000000000000D","name":"Pixel","kind":"android"}}""",
                    )
                    "POST /api/v1/auth/reauthenticate" ->
                        if (WolfJson.parseToJsonElement(body).jsonObject["password"]!!.jsonPrimitive.content == "right") {
                            MockResponse().setBody("""{"accessToken":"access-reauth","accessTokenExpiresAt":"${Instant.now().plusSeconds(600)}"}""")
                        } else {
                            refusal(401, "auth.invalid_credentials")
                        }
                    "GET /api/v1/configuration/backup" -> MockResponse().setBody(file).setHeader("Cache-Control", "no-store")
                    "POST /api/v1/configuration/restore/preview", "POST /api/v1/configuration/restore" -> {
                        val parsed = WolfJson.parseToJsonElement(body).jsonObject
                        val backup = parsed["backup"]!!.jsonObject
                        val enable = parsed["enableAutomations"]!!.jsonPrimitive.boolean
                        val risk = if (enable) "high" else "medium"
                        val confirmed = parsed["confirmedRiskLevel"]?.jsonPrimitive?.contentOrNull
                        when {
                            backup["checksum"]!!.jsonPrimitive.content == damaged -> refusal(422, "configuration.invalid_backup")
                            request.path!!.endsWith("/preview") -> MockResponse().setBody("""{"plan":${plan(risk, if (enable) 1 else 0)}}""")
                            confirmed != risk -> refusal(428, "command.confirmation_required", risk)
                            risk == "high" && bearer != "access-reauth" -> refusal(428, "command.reauth_required")
                            else -> MockResponse().setBody("""{"plan":${plan(risk, if (enable) 1 else 0)},"restoredAt":"2026-09-15T09:00:00.000Z"}""")
                        }
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private suspend fun signedIn(): Triple<WolfApi, SessionManager, AccountAuthority> {
        val api = WolfApi(server.url("/"), OkHttpClient())
        val session = SessionManager(api, TokenVault(File(folder.root, "credentials.bin"), JvmAesGcmCipher()), JvmDeviceIdentity(), "Pixel", "Android 16")
        session.signIn("owner@example.com", "right")
        return Triple(api, session, AccountAuthority(api, session))
    }

    private fun restores() = requests.filter { it.first.path == "/api/v1/configuration/restore" }

    private fun <T> Authorized<T>.saved(): T = when (this) {
        is Authorized.Done -> value
        is Authorized.NeedsConfirmation -> throw AssertionError("expected a restore, the server asked for ${pending.riskLevel}")
    }

    @Test
    fun a_backup_is_kept_as_the_server_sent_it() = runBlocking {
        val (api, session, _) = signedIn()

        val backup = session.authorized { api.configurationBackup(it) }

        assertEquals(WolfJson.parseToJsonElement(file), backup)
        assertEquals("GET", requests.last().first.method)
    }

    @Test
    fun a_preview_sends_the_file_unchanged_and_confirms_nothing() = runBlocking {
        val (api, session, _) = signedIn()
        val backup = ConfigurationBackups.parse(file.toByteArray())

        val plan = session.authorized { api.previewRestore(RestoreRequest(backup, listOf("alertRules")), it) }.plan

        val sent = WolfJson.parseToJsonElement(requests.last().second).jsonObject
        assertEquals(backup, sent["backup"])
        assertEquals("[\"alertRules\"]", sent["sections"].toString())
        assertEquals("false", sent["enableAutomations"].toString())
        assertFalse("nothing is confirmed before the server asks", sent.containsKey("confirmedRiskLevel"))

        assertEquals("medium", plan.riskLevel)
        assertEquals(2, plan.sections["alertRules"]!!.deleted)
        assertEquals("rule-pc-missing", plan.warnings.single().code)
    }

    @Test
    fun a_restore_always_asks_first_and_is_sent_at_the_level_named() = runBlocking {
        val (api, _, authority) = signedIn()
        val request = RestoreRequest(ConfigurationBackups.parse(file.toByteArray()), listOf("alertRules"))
        val save: suspend (String, String?) -> RestoreResult = { bearer, confirmed -> api.restoreConfiguration(request.copy(confirmedRiskLevel = confirmed), bearer) }

        val asked = authority.attempt("Restore configuration", "Replaces it.", save)
        val pending = (asked as Authorized.NeedsConfirmation).pending
        assertEquals("medium", pending.riskLevel)
        assertFalse(pending.requiresPassword)

        val result = authority.confirm(pending, password = null, save).saved()

        assertEquals("2026-09-15T09:00:00.000Z", result.restoredAt)
        assertEquals("medium", WolfJson.parseToJsonElement(restores().last().second).jsonObject["confirmedRiskLevel"]!!.jsonPrimitive.content)
        assertEquals(0, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
    }

    @Test
    fun turning_restored_automations_on_can_need_the_password() = runBlocking {
        val (api, _, authority) = signedIn()
        val request = RestoreRequest(ConfigurationBackups.parse(file.toByteArray()), listOf("automations"), enableAutomations = true)
        val save: suspend (String, String?) -> RestoreResult = { bearer, confirmed -> api.restoreConfiguration(request.copy(confirmedRiskLevel = confirmed), bearer) }

        val pending = (authority.attempt("Restore configuration", "Turns them on.", save) as Authorized.NeedsConfirmation).pending
        assertEquals("high", pending.riskLevel)
        assertTrue(pending.requiresPassword)

        authority.confirm(pending, "right", save).saved()

        assertEquals("Bearer access-reauth", restores().last().first.getHeader("Authorization"))
    }

    @Test
    fun a_file_the_server_refuses_carries_its_reason_and_restores_nothing() = runBlocking {
        val (api, session, _) = signedIn()
        val doctored = ConfigurationBackups.parse(file.replace("a".repeat(64), damaged).toByteArray())

        try {
            session.authorized { api.previewRestore(RestoreRequest(doctored, listOf("alertRules")), it) }
            fail("a damaged file must be refused")
        } catch (error: WolfApiException) {
            assertEquals(422, error.httpStatus)
            assertEquals("configuration.invalid_backup", error.problem.code)
        }
        assertTrue(restores().isEmpty())
    }
}
