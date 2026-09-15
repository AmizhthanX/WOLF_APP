package app.amizhthan.wolf.session

import app.amizhthan.wolf.JvmAesGcmCipher
import app.amizhthan.wolf.JvmDeviceIdentity
import app.amizhthan.wolf.api.AutomationResponse
import app.amizhthan.wolf.api.Automations
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfJson
import app.amizhthan.wolf.security.TokenVault
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
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
 * Authorizing an automation, against a fake API that enforces `authorizeSave`: critical is refused
 * outright, anything above low needs the confirmed level to equal the server's, and high needs a sign-in
 * fresh from a password re-entry.
 */
class AccountAuthorityTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()

    /** The next save treats even a re-authenticated token as too old, once. */
    @Volatile
    private var signInTooOld = false

    private val pcId = "01J9ZQK7T0000000000000000P"
    private val automationId = "01J9ZQK7T0000000000000000A"
    private val rank = listOf("low", "medium", "high", "critical")

    private fun refusal(status: Int, code: String, riskLevel: String? = null) = MockResponse().setResponseCode(status).setBody(
        """{"error":{"code":"$code","problem":"Refused.","cause":"Test.","currentState":"Nothing was changed.","recommendedAction":"Confirm.","referenceId":"WOLF-AUTO-TEST"${riskLevel?.let { ",\"context\":{\"riskLevel\":\"$it\"}" } ?: ""}}}""",
    )

    private fun saved(risk: String, enabled: Boolean) = MockResponse().setResponseCode(201).setBody(
        """{"automation":{"id":"$automationId","name":"Nightly","enabled":$enabled,"trigger":{"kind":"manual"},"conditions":[],"actions":[],"targets":{"mode":"pcs","pcIds":["$pcId"]},"cooldownMinutes":60,"maxRunsPerDay":4,"authorizedRiskLevel":"$risk","authorizedAt":"2026-09-15T00:00:00Z","lastRunAt":null,"createdAt":"2026-09-15T00:00:00Z","updatedAt":"2026-09-15T00:00:00Z"}}""",
    )

    /** `automationRisk` for the actions these tests send. */
    private fun classify(actions: JsonArray): String = actions.map { it.jsonObject }
        .filter { it["kind"]!!.jsonPrimitive.content == "command" }
        .map { action ->
            val command = action["command"]!!.jsonObject
            when (command["type"]!!.jsonPrimitive.content) {
                "power.action" -> if (command["payload"]!!.jsonObject["force"]!!.jsonPrimitive.boolean) "critical" else "high"
                "service.control" -> "medium"
                else -> error("unexpected command")
            }
        }
        .maxByOrNull { rank.indexOf(it) } ?: "low"

    private fun authorize(risk: String, confirmed: String?, bearer: String?, enabled: Boolean): MockResponse = when {
        risk == "critical" -> refusal(403, "auth.forbidden")
        risk != "low" && confirmed != risk -> refusal(428, "command.confirmation_required", risk)
        risk == "high" && (bearer != "access-reauth" || signInTooOld) -> {
            signInTooOld = false
            refusal(428, "command.reauth_required")
        }
        else -> saved(risk, enabled)
    }

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
                    "POST /api/v1/automations" -> {
                        val parsed = WolfJson.parseToJsonElement(body).jsonObject
                        val automation = parsed["automation"]!!.jsonObject
                        authorize(
                            classify(automation["actions"]!!.jsonArray),
                            parsed["confirmedRiskLevel"]?.jsonPrimitive?.contentOrNull,
                            bearer,
                            automation["enabled"]!!.jsonPrimitive.boolean,
                        )
                    }
                    // The stored automation restarts a PC: high. Turning it off needs nothing; turning it on re-authorizes.
                    "PATCH /api/v1/automations/$automationId" -> {
                        val parsed = WolfJson.parseToJsonElement(body).jsonObject
                        val enabled = parsed["automation"]!!.jsonObject["enabled"]!!.jsonPrimitive.boolean
                        if (!enabled) saved("high", enabled = false) else authorize("high", parsed["confirmedRiskLevel"]?.jsonPrimitive?.contentOrNull, bearer, true)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private suspend fun signedIn(): Pair<AccountAuthority, WolfApi> {
        val api = WolfApi(server.url("/"), OkHttpClient())
        val session = SessionManager(api, TokenVault(File(folder.root, "credentials.bin"), JvmAesGcmCipher()), JvmDeviceIdentity(), "Pixel", "Android 16")
        session.signIn("owner@example.com", "right")
        return AccountAuthority(api, session) to api
    }

    private fun definition(action: JsonObject) = Automations.definition(
        name = "Nightly",
        trigger = Automations.manual(),
        conditions = emptyList(),
        actions = listOf(action),
        targets = Automations.onPcs(listOf(pcId)),
    )

    private val restartSpooler = buildJsonObject {
        put("kind", "command")
        putJsonObject("command") {
            put("type", "service.control")
            putJsonObject("payload") {
                put("name", "Spooler")
                put("action", "restart")
                put("expectedDisplayName", "Print Spooler")
            }
        }
    }

    /** Not something the phone can build — [Automations.power] never forces — but a server must still refuse it. */
    private val forcedShutdown = buildJsonObject {
        put("kind", "command")
        putJsonObject("command") {
            put("type", "power.action")
            putJsonObject("payload") {
                put("action", "shutdown")
                put("delaySeconds", 0)
                put("force", true)
            }
        }
    }

    private fun create(api: WolfApi, definition: JsonObject): suspend (String, String?) -> AutomationResponse =
        { bearer, confirmed -> api.createAutomation(definition, confirmed, bearer) }

    private fun <T> Authorized<T>.saved(): T = when (this) {
        is Authorized.Done -> value
        is Authorized.NeedsConfirmation -> throw AssertionError("expected a save, got a request for ${pending.riskLevel}")
    }

    private fun Authorized<*>.asked(): PendingAuthority = when (this) {
        is Authorized.NeedsConfirmation -> pending
        is Authorized.Done -> throw AssertionError("expected a question for the owner, got a save")
    }

    private fun bodies(method: String, path: String) =
        requests.filter { it.first.method == method && it.first.path == path }.map { WolfJson.parseToJsonElement(it.second).jsonObject }

    @Test
    fun an_automation_that_only_notifies_saves_at_once_with_nothing_confirmed() = runBlocking {
        val (authority, api) = signedIn()

        val saved = authority.attempt("Save", "Later.", create(api, definition(Automations.notify("Disk nearly full", "warning")))).saved()

        assertEquals("low", saved.automation.authorizedRiskLevel)
        assertFalse("nothing is confirmed before the server asks", bodies("POST", "/api/v1/automations").single().containsKey("confirmedRiskLevel"))
        assertEquals(0, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
    }

    @Test
    fun medium_asks_for_a_yes_and_saves_at_exactly_the_named_level() = runBlocking {
        val (authority, api) = signedIn()
        val save = create(api, definition(restartSpooler))

        val pending = authority.attempt("Authorize", "Later.", save).asked()
        assertEquals("medium", pending.riskLevel)
        assertFalse(pending.requiresPassword)

        authority.confirm(pending, password = null, save).saved()

        assertEquals("medium", bodies("POST", "/api/v1/automations").last()["confirmedRiskLevel"]!!.jsonPrimitive.content)
        assertEquals(0, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
    }

    @Test
    fun high_needs_the_password_and_saves_with_the_sign_in_it_produced() = runBlocking {
        val (authority, api) = signedIn()
        val save = create(api, definition(Automations.power("restart", 60)))

        val pending = authority.attempt("Authorize", "Later.", save).asked()
        assertEquals("high", pending.riskLevel)
        assertTrue(pending.requiresPassword)

        val saved = authority.confirm(pending, "right", save).saved()

        assertEquals("high", saved.automation.authorizedRiskLevel)
        val final = requests.last { it.first.path == "/api/v1/automations" }
        assertEquals("Bearer access-reauth", final.first.getHeader("Authorization"))
        assertEquals("high", WolfJson.parseToJsonElement(final.second).jsonObject["confirmedRiskLevel"]!!.jsonPrimitive.content)
    }

    @Test
    fun a_wrong_password_is_tried_once_and_saves_nothing() = runBlocking {
        val (authority, api) = signedIn()
        val save = create(api, definition(Automations.power("shutdown", 0)))
        val pending = authority.attempt("Authorize", "Later.", save).asked()
        val savesBefore = requests.count { it.first.path == "/api/v1/automations" }

        try {
            authority.confirm(pending, "wrong", save)
            fail("a wrong password must not authorize anything")
        } catch (error: WolfApiException) {
            assertEquals(401, error.httpStatus)
        }

        // A retried 401 here would count one typo twice against the account's lockout.
        assertEquals(1, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
        assertEquals(0, requests.count { it.first.path == "/api/v1/auth/refresh" })
        assertEquals(savesBefore, requests.count { it.first.path == "/api/v1/automations" })
    }

    @Test
    fun no_password_means_nothing_is_sent() = runBlocking {
        val (authority, api) = signedIn()
        val save = create(api, definition(Automations.power("restart", 0)))
        val pending = authority.attempt("Authorize", "Later.", save).asked()

        try {
            authority.confirm(pending, password = "", save)
            fail("a high-risk automation must not be confirmed without the password")
        } catch (_: IllegalArgumentException) {
        }

        assertEquals(0, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
        assertEquals(1, requests.count { it.first.path == "/api/v1/automations" })
    }

    @Test
    fun a_critical_action_is_a_refusal_never_a_question() = runBlocking {
        val (authority, api) = signedIn()

        try {
            authority.attempt("Authorize", "Later.", create(api, definition(forcedShutdown)))
            fail("a critical automation must not become a confirmation the owner could click through")
        } catch (error: WolfApiException) {
            assertEquals("auth.forbidden", error.problem.code)
        }
    }

    @Test
    fun the_phone_never_climbs_on_its_own() = runBlocking {
        val (authority, api) = signedIn()
        val save = create(api, definition(Automations.power("restart", 0)))
        val shown = authority.attempt("Authorize", "Later.", save).asked()

        // Confirmed at a level lower than the server's: the server asks again, and so does the phone.
        val again = authority.confirm(shown.copy(riskLevel = "medium"), password = null, save).asked()

        assertEquals("high", again.riskLevel)
        assertTrue(again.requiresPassword)
    }

    @Test
    fun a_sign_in_that_is_too_old_asks_for_the_password_again() = runBlocking {
        val (authority, api) = signedIn()
        val save = create(api, definition(Automations.power("restart", 0)))
        val pending = authority.attempt("Authorize", "Later.", save).asked()

        signInTooOld = true
        // A re-authentication refusal names no level; it always means the password.
        val again = authority.confirm(pending, "right", save).asked()
        assertEquals("high", again.riskLevel)

        authority.confirm(again, "right", save).saved()
        assertEquals(2, requests.count { it.first.path == "/api/v1/auth/reauthenticate" })
    }

    @Test
    fun turning_an_automation_off_needs_nothing_and_turning_it_on_needs_authority() = runBlocking {
        val (authority, api) = signedIn()

        val off = authority.attempt("Turn off", "Later.") { bearer, confirmed ->
            api.updateAutomation(automationId, Automations.enabledPatch(false), confirmed, bearer)
        }.saved()
        assertFalse(off.automation.enabled)

        val on = authority.attempt("Turn on", "Later.") { bearer, confirmed ->
            api.updateAutomation(automationId, Automations.enabledPatch(true), confirmed, bearer)
        }.asked()
        assertEquals("high", on.riskLevel)
    }
}
