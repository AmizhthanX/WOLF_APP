package app.amizhthan.wolf.api

import kotlinx.coroutines.runBlocking
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
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Webhooks on the phone: what is checked before sending, the paths `services/api` serves, and the words. */
class WebhooksTest {
    private lateinit var server: MockWebServer
    private lateinit var api: WolfApi
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private val id = "01J9ZQK7T0000000000000000W"
    private val webhook = """{"id":"$id","name":"Team chat","host":"hooks.slack.com","minSeverity":"warning","enabled":true,"disabledReason":null,"consecutiveFailures":0,"lastDeliveryAt":null,"lastOutcome":null,"lastStatus":null,"createdAt":"2026-09-16T00:00:00Z"}"""

    private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setBody(body)

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                return when ("${request.method} ${request.path}") {
                    "GET /api/v1/webhooks" -> json("""{"configured":true,"webhooks":[$webhook],"limit":10}""")
                    "POST /api/v1/webhooks" -> json("""{"webhook":$webhook,"secret":"whsec_abc"}""", 201)
                    "PATCH /api/v1/webhooks/$id" -> json("""{"webhook":$webhook}""")
                    "POST /api/v1/webhooks/$id/rotate-secret" -> json(
                        """{"error":{"code":"command.reauth_required","problem":"Replacing a webhook's signing secret needs your password.","cause":"x","currentState":"y","recommendedAction":"z","referenceId":"WOLF-CMD-0001"}}""",
                        401,
                    )
                    "POST /api/v1/webhooks/$id/test" -> json("""{"outcome":"http-error","status":503,"detail":"Answered with 503."}""")
                    "DELETE /api/v1/webhooks/$id" -> MockResponse().setResponseCode(204)
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        api = WolfApi(server.url("/"), OkHttpClient())
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun only_an_https_address_with_no_credentials_is_sent() {
        assertEquals("https://hooks.slack.com/services/T/B/x", Webhooks.input(" Team chat ", " https://hooks.slack.com/services/T/B/x ", "warning").url)
        for (bad in listOf("http://hooks.example.com/in", "https://user:pw@hooks.example.com/in", "https://hooks.example.com/in#frag", "not a url", "https:///nohost")) {
            try {
                Webhooks.input("x", bad, "warning")
                fail("$bad must not be sent")
            } catch (_: IllegalArgumentException) {
            }
        }
        try {
            Webhooks.input("x", "https://hooks.example.com/in", "everything")
            fail("an unknown severity must not be sent")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun webhooks_are_listed_made_changed_tested_and_deleted_on_the_api_s_paths() = runBlocking {
        val list = api.listWebhooks("token")
        assertTrue(list.configured)
        assertEquals("hooks.slack.com", list.webhooks.single().host)

        val created = api.createWebhook(Webhooks.input("Team chat", "https://hooks.slack.com/services/T/B/x", "critical"), "token")
        assertEquals("whsec_abc", created.secret)
        val body = kotlinx.serialization.json.Json.parseToJsonElement(requests.last().second).jsonObject["webhook"]!!.jsonObject
        assertEquals("critical", body["minSeverity"]!!.jsonPrimitive.content)

        api.updateWebhook(id, WebhookPatch(enabled = false), "token")
        assertEquals("""{"enabled":false}""", requests.last().second)

        val tested = api.testWebhook(id, "token")
        assertEquals("The receiver answered 503", Webhooks.outcomeText(tested.outcome, tested.status))

        try {
            api.rotateWebhookSecret(id, "token")
            fail("a stale sign-in must be asked for the password")
        } catch (error: WolfApiException) {
            assertEquals("command.reauth_required", error.problem.code)
        }

        api.deleteWebhook(id, "token")
        assertEquals("DELETE", requests.last().first.method)
    }

    @Test
    fun the_format_follows_the_host_and_is_sent() {
        assertEquals("slack", Webhooks.suggestedFormat("https://hooks.slack.com/services/T/B/x"))
        assertEquals("discord", Webhooks.suggestedFormat("https://discord.com/api/webhooks/1/x"))
        assertEquals("wolf", Webhooks.suggestedFormat("https://hooks.slack.com.evil.example/x"))
        assertEquals("discord", Webhooks.input("x", "https://discord.com/api/webhooks/1/x", "warning").format)
        assertEquals("wolf", Webhooks.input("x", "https://discord.com/api/webhooks/1/x", "warning", format = "wolf").format)
    }

    @Test
    fun a_secret_on_screen_never_prints_itself() {
        assertFalse(ShownSecret("Team chat", "whsec_supersecret").toString().contains("whsec"))
    }

    @Test
    fun state_says_why_a_webhook_is_off() {
        val base = WolfJson.decodeFromString(WebhookView.serializer(), webhook)
        assertEquals("On · nothing sent yet", Webhooks.stateText(base))
        assertEquals("Off", Webhooks.stateText(base.copy(enabled = false)))
        assertTrue(Webhooks.stateText(base.copy(enabled = false, disabledReason = "too-many-failures")).startsWith("Turned off by WOLF"))
        assertTrue(Webhooks.stateText(base.copy(lastOutcome = "timeout", consecutiveFailures = 3)).endsWith("3 failures in a row"))
    }
}
