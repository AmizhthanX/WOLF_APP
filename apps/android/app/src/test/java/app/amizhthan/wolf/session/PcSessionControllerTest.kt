package app.amizhthan.wolf.session

import app.amizhthan.wolf.JvmAesGcmCipher
import app.amizhthan.wolf.JvmDeviceIdentity
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfJson
import app.amizhthan.wolf.security.TokenVault
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
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
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * The confirmation ladder, against a fake API that enforces the real rules: the server classifies,
 * medium needs a matching confirmation, high needs a session token issued after a password re-entry,
 * critical needs a single-use grant as well.
 */
class PcSessionControllerTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private val sessionTokens = AtomicInteger()

    @Volatile
    private var freshAuthToken: String? = null

    @Volatile
    private var grantIssued: String? = null

    @Volatile
    private var expireNextDispatch = false

    private val pcId = "01J9ZQK7T0000000000000000P"
    private val sessionId = "01J9ZQK7T0000000000000000S"
    private val grantId = "01J9ZQK7T0000000000000000G"

    private fun json(body: String) = MockResponse().setResponseCode(200).setBody(body)

    private fun refusal(status: Int, code: String, riskLevel: String? = null) = MockResponse().setResponseCode(status).setBody(
        """{"error":{"code":"$code","problem":"Refused.","cause":"Test.","currentState":"Nothing was changed.","recommendedAction":"Confirm.","referenceId":"WOLF-CMD-TEST"${riskLevel?.let { ",\"context\":{\"riskLevel\":\"$it\"}" } ?: ""}}}""",
    )

    private fun sessionToken(): String {
        val token = "session-${sessionTokens.incrementAndGet()}"
        return """"sessionToken":"$token","sessionTokenExpiresAt":"${Instant.now().plusSeconds(600)}""""
    }

    private fun completed(type: String, risk: String, result: String = "{}") =
        MockResponse().setResponseCode(202).setBody("""{"command":{"id":"01J9ZQK7T0000000000000000C","type":"$type","riskLevel":"$risk","status":"completed","result":$result},"deduplicated":false}""")

    /** The server's classification, as `classifyRisk` does it for these payloads. */
    private fun classify(command: JsonObject): String {
        val type = command["type"]!!.jsonPrimitive.content
        val payload = command["payload"]!!.jsonObject
        return when (type) {
            "process.list" -> "low"
            "power.action" -> "high"
            "process.terminate" -> if (payload["expectedName"]!!.jsonPrimitive.content == "lsass.exe") "critical" else "medium"
            else -> error("unexpected $type")
        }
    }

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val body = request.body.readUtf8()
                requests += request to body
                val bearer = request.getHeader("Authorization")?.removePrefix("Bearer ")
                return when (request.path) {
                    "/api/v1/auth/login" -> json(
                        """{"accessToken":"access-1","accessTokenExpiresAt":"${Instant.now().plusSeconds(600)}","refreshToken":"refresh-1-0123456789abcdef","refreshTokenExpiresAt":"${Instant.now().plusSeconds(86400)}","device":{"id":"01J9ZQK7T0000000000000000D","name":"Pixel","kind":"android"}}""",
                    )
                    "/api/v1/auth/reauthenticate" ->
                        if (WolfJson.parseToJsonElement(body).jsonObject["password"]!!.jsonPrimitive.content == "right") {
                            json("""{"accessToken":"access-reauth","accessTokenExpiresAt":"${Instant.now().plusSeconds(600)}"}""")
                        } else {
                            refusal(401, "auth.invalid_credentials")
                        }
                    "/api/v1/pcs/$pcId/sessions" -> json("""{"session":{"id":"$sessionId","capabilities":["processes","power"],"expiresAt":"${Instant.now().plusSeconds(3600)}"},${sessionToken()}}""")
                    "/api/v1/pcs/$pcId/sessions/$sessionId/token" -> {
                        val token = sessionToken()
                        // A token issued with the re-authenticated account token carries the fresh sign-in.
                        if (bearer == "access-reauth") freshAuthToken = "session-${sessionTokens.get()}"
                        json("{$token}")
                    }
                    "/api/v1/pcs/$pcId/sessions/$sessionId" -> MockResponse().setResponseCode(204)
                    "/api/v1/pcs/$pcId/privileged-grants" ->
                        if (bearer != null && bearer == freshAuthToken) {
                            grantIssued = grantId
                            MockResponse().setResponseCode(201).setBody("""{"grant":{"id":"$grantId","purpose":"x","expiresAt":"${Instant.now().plusSeconds(120)}","singleUse":true}}""")
                        } else {
                            refusal(428, "auth.reauth_required")
                        }
                    "/api/v1/pcs/$pcId/commands" -> {
                        if (expireNextDispatch) {
                            expireNextDispatch = false
                            return refusal(401, "auth.unauthorized")
                        }
                        val parsed = WolfJson.parseToJsonElement(body).jsonObject
                        val command = parsed["command"]!!.jsonObject
                        val confirmed = parsed["confirmedRiskLevel"]?.jsonPrimitive?.contentOrNull
                        val risk = classify(command)
                        val type = command["type"]!!.jsonPrimitive.content
                        when {
                            risk != "low" && confirmed != risk -> refusal(428, "command.confirmation_required", risk)
                            (risk == "high" || risk == "critical") && bearer != freshAuthToken -> refusal(428, "command.reauth_required")
                            risk == "critical" && parsed["privilegedGrantId"]?.jsonPrimitive?.contentOrNull != grantIssued -> refusal(403, "command.privileged_grant_required", risk)
                            else -> completed(type, risk, if (type == "process.list") """{"processes":[{"pid":4,"name":"System","protectedProcess":true}],"truncated":false,"totalCount":1}""" else "{}")
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

    private suspend fun controller(): PcSessionController {
        val api = WolfApi(server.url("/"), OkHttpClient())
        val session = SessionManager(api, TokenVault(File(folder.root, "credentials.bin"), JvmAesGcmCipher()), JvmDeviceIdentity(), "Pixel", "Android 16")
        session.signIn("owner@example.com", "right")
        return PcSessionController(pcId, api, session)
    }

    private fun bodies(path: String) = requests.filter { it.first.path == path }.map { WolfJson.parseToJsonElement(it.second.ifEmpty { "{}" }).jsonObject }

    @Test
    fun a_low_risk_command_runs_at_once_through_a_session_opened_for_it() = runBlocking {
        val outcome = controller().run(Commands.processList(), "List processes", "Read the process list.")

        assertTrue(outcome is CommandOutcome.Done)
        assertEquals(1, requests.count { it.first.path == "/api/v1/pcs/$pcId/sessions" })
        val dispatch = requests.single { it.first.path == "/api/v1/pcs/$pcId/commands" }
        assertEquals("Bearer session-1", dispatch.first.getHeader("Authorization"))
        assertNull("nothing is confirmed before the server asks", bodies("/api/v1/pcs/$pcId/commands").single()["confirmedRiskLevel"])

        val session = bodies("/api/v1/pcs/$pcId/sessions").single()
        assertEquals("[\"processes\",\"power\",\"services\",\"configuration\"]", session["capabilities"].toString())
    }

    @Test
    fun medium_risk_asks_for_a_yes_and_resends_the_same_command_at_the_named_level() = runBlocking {
        val controller = controller()
        val first = controller.run(Commands.terminate(1234, "notepad.exe"), "Terminate notepad.exe", "End it.")

        val pending = (first as CommandOutcome.NeedsConfirmation).pending
        assertEquals("medium", pending.riskLevel)
        assertTrue(!pending.requiresPassword)

        val done = controller.confirm(pending, password = null)
        assertTrue(done is CommandOutcome.Done)

        val dispatches = bodies("/api/v1/pcs/$pcId/commands")
        assertEquals(2, dispatches.size)
        assertEquals("medium", dispatches[1]["confirmedRiskLevel"]!!.jsonPrimitive.content)
        // One command, one key: a retried request cannot run it twice.
        assertEquals(dispatches[0]["idempotencyKey"], dispatches[1]["idempotencyKey"])
        assertEquals(0, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
    }

    @Test
    fun high_risk_needs_the_password_and_a_session_token_issued_after_it() = runBlocking {
        val controller = controller()
        val pending = (controller.run(Commands.power("restart"), "Restart this PC", "Restart Windows.") as CommandOutcome.NeedsConfirmation).pending

        assertEquals("high", pending.requiresPassword.let { pending.riskLevel })
        assertTrue(pending.requiresPassword)

        val done = controller.confirm(pending, "right")
        assertTrue(done is CommandOutcome.Done)

        val final = requests.last { it.first.path == "/api/v1/pcs/$pcId/commands" }
        assertEquals("Bearer $freshAuthToken", final.first.getHeader("Authorization"))
        assertEquals("high", WolfJson.parseToJsonElement(final.second).jsonObject["confirmedRiskLevel"]!!.jsonPrimitive.content)
    }

    @Test
    fun a_wrong_password_is_tried_once_and_sends_nothing() = runBlocking {
        val controller = controller()
        val pending = (controller.run(Commands.power("shutdown"), "Shut this PC down", "Shut down.") as CommandOutcome.NeedsConfirmation).pending
        val dispatchesBefore = requests.count { it.first.path == "/api/v1/pcs/$pcId/commands" }

        try {
            controller.confirm(pending, "wrong")
            fail("a wrong password must not confirm anything")
        } catch (error: WolfApiException) {
            assertEquals(401, error.httpStatus)
        }

        // Retrying a 401 here would count one typo twice against the account lockout.
        assertEquals(1, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
        assertEquals(0, requests.count { it.first.path == "/api/v1/auth/refresh" })
        assertEquals(dispatchesBefore, requests.count { it.first.path == "/api/v1/pcs/$pcId/commands" })
    }

    @Test
    fun critical_risk_adds_a_single_use_grant_obtained_after_the_password() = runBlocking {
        val controller = controller()
        val first = controller.run(Commands.terminate(700, "lsass.exe"), "Terminate lsass.exe", "End it.")
        val pending = (first as CommandOutcome.NeedsConfirmation).pending
        assertEquals("critical", pending.riskLevel)

        val done = controller.confirm(pending, "right")
        assertTrue(done is CommandOutcome.Done)

        val grantRequest = requests.single { it.first.path == "/api/v1/pcs/$pcId/privileged-grants" }
        assertEquals("Bearer $freshAuthToken", grantRequest.first.getHeader("Authorization"))
        assertEquals(grantId, bodies("/api/v1/pcs/$pcId/commands").last()["privilegedGrantId"]!!.jsonPrimitive.content)
    }

    @Test
    fun the_phone_never_climbs_the_ladder_on_its_own() = runBlocking {
        // Confirmed at the level the server named. If the server now names a higher one, the owner is
        // asked again — the phone does not re-send at a level nobody agreed to.
        val controller = controller()
        val shown = (controller.run(Commands.power("restart"), "Restart", "Restart.") as CommandOutcome.NeedsConfirmation).pending
        val understated = shown.copy(riskLevel = "medium")

        val again = controller.confirm(understated, password = null)

        assertTrue(again is CommandOutcome.NeedsConfirmation)
        assertEquals("high", (again as CommandOutcome.NeedsConfirmation).pending.riskLevel)
    }

    @Test
    fun a_lapsed_session_token_is_renewed_once_and_the_command_retried() = runBlocking {
        val controller = controller()
        controller.run(Commands.processList(), "List", "List.")

        expireNextDispatch = true
        val outcome = controller.run(Commands.processList(), "List", "List.")

        assertTrue(outcome is CommandOutcome.Done)
        assertEquals(1, requests.count { it.first.path == "/api/v1/pcs/$pcId/sessions/$sessionId/token" })
    }

    @Test
    fun closing_ends_the_session_on_the_server() = runBlocking {
        val controller = controller()
        controller.run(Commands.processList(), "List", "List.")
        controller.close()

        assertTrue(requests.any { it.first.method == "DELETE" && it.first.path == "/api/v1/pcs/$pcId/sessions/$sessionId" })
    }

    @Test
    fun power_payloads_are_never_forced() {
        Commands.POWER_ACTIONS.forEach { action ->
            assertEquals("false", Commands.power(action)["payload"]!!.jsonObject["force"].toString())
        }
    }
}
