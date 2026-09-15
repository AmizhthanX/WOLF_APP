package app.amizhthan.wolf.api

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/** Alert rules, the inbox and automations on the paths and methods `services/api` serves them. */
class AlertsApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: WolfApi
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()

    private val ruleId = "01J9ZQK7T0000000000000000R"
    private val automationId = "01J9ZQK7T0000000000000000A"
    private val notificationId = "01J9ZQK7T0000000000000000N"

    private val rule = """{"id":"$ruleId","pcId":null,"name":"Offline","condition":"pc-offline","metric":null,"seriesKey":null,"threshold":null,"forMinutes":10,"severity":"warning","cooldownMinutes":60,"enabled":false,"createdAt":"2026-09-15T00:00:00Z","updatedAt":"2026-09-15T00:00:00Z"}"""

    private fun json(body: String, status: Int = 200) = MockResponse().setResponseCode(status).setBody(body)

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                return when ("${request.method} ${request.path}") {
                    "GET /api/v1/alert-rules" -> json("""{"rules":[$rule],"limit":100}""")
                    "POST /api/v1/alert-rules" -> json("""{"rule":$rule}""", 201)
                    "PATCH /api/v1/alert-rules/$ruleId" -> json("""{"rule":$rule}""")
                    "DELETE /api/v1/alert-rules/$ruleId" -> MockResponse().setResponseCode(204)
                    "GET /api/v1/notifications" -> json(
                        """{"notifications":[{"id":"$notificationId","ruleId":null,"automationId":null,"pcId":"01J9ZQK7T0000000000000000P","kind":"fired","severity":"critical","title":"DESKTOP is offline","detail":"No heartbeat for 10 minutes.","metric":null,"seriesKey":null,"value":null,"threshold":null,"occurredAt":"2026-09-15T00:00:00Z","readAt":null}],"unreadCount":1}""",
                    )
                    "POST /api/v1/notifications/$notificationId/read" -> MockResponse().setResponseCode(204)
                    "POST /api/v1/notifications/read-all" -> json("""{"marked":3}""")
                    "POST /api/v1/automations/$automationId/run" -> json("""{"accepted":true,"pcIds":["01J9ZQK7T0000000000000000P"]}""", 202)
                    "GET /api/v1/automations/$automationId/runs" -> json(
                        """{"runs":[{"id":"01J9ZQK7T0000000000000000U","automationId":"$automationId","pcId":"01J9ZQK7T0000000000000000P","triggerKind":"manual","status":"skipped","reason":"pc-offline","steps":[],"startedAt":"2026-09-15T00:00:00Z","finishedAt":"2026-09-15T00:00:01Z"}]}""",
                    )
                    "POST /api/v1/automations" -> json(
                        """{"error":{"code":"resource.conflict","problem":"This account already has the maximum number of automations.","cause":"An account can hold at most 50 automations.","currentState":"Nothing was changed.","recommendedAction":"Delete automations you no longer need.","referenceId":"WOLF-API-1A2B"}}""",
                        409,
                    )
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
        api = WolfApi(server.url("/"), OkHttpClient())
    }

    @After
    fun stop() = server.shutdown()

    private fun last(method: String) = requests.last { it.first.method == method }

    @Test
    fun rules_are_listed_created_switched_and_deleted() = runBlocking {
        val listed = api.listAlertRules("token")
        assertEquals(100, listed.limit)
        assertNull(listed.rules.single().threshold)

        api.createAlertRule(AlertRules.rule("Offline", null, "pc-offline", null, null, null, 10, "warning", 60), "token")
        val created = WolfJson.parseToJsonElement(last("POST").second).jsonObject
        assertEquals("\"pc-offline\"", created["condition"].toString())
        assertFalse("an offline rule sends no metric", created.containsKey("metric"))

        api.setAlertRuleEnabled(ruleId, false, "token")
        assertEquals("""{"enabled":false}""", last("PATCH").second)
        assertEquals("/api/v1/alert-rules/$ruleId", last("PATCH").first.path)

        api.deleteAlertRule(ruleId, "token")
        assertEquals("/api/v1/alert-rules/$ruleId", last("DELETE").first.path)
        assertEquals("Bearer token", last("DELETE").first.getHeader("Authorization"))
    }

    @Test
    fun the_inbox_keeps_what_a_notification_does_not_have_as_null() = runBlocking {
        val inbox = api.listNotifications("token")

        assertEquals(1, inbox.unreadCount)
        val entry = inbox.notifications.single()
        assertNull("a rule's value is unknown, not zero", entry.value)
        assertNull(entry.ruleId)
        assertNull(entry.readAt)

        api.markNotificationRead(entry.id, "token")
        assertEquals("/api/v1/notifications/$notificationId/read", last("POST").first.path)
        assertEquals(3, api.markAllNotificationsRead("token").marked)
    }

    @Test
    fun a_run_is_accepted_not_finished_and_its_history_says_why_it_did_nothing() = runBlocking {
        val accepted = api.runAutomation(automationId, "token")
        assertTrue(accepted.accepted)

        val run = api.automationRuns(automationId, "token").runs.single()
        assertEquals("skipped", run.status)
        assertEquals("The PC was offline", Automations.describeReason(run.reason!!))
    }

    @Test
    fun a_refused_save_carries_the_servers_own_words() = runBlocking {
        try {
            api.createAutomation(
                Automations.definition("x", Automations.manual(), emptyList(), listOf(Automations.notify("hi", "info")), Automations.onPcs(listOf("01J9ZQK7T0000000000000000P"))),
                confirmedRiskLevel = null,
                bearer = "token",
            )
            fail("the server refused this save")
        } catch (error: WolfApiException) {
            assertEquals(409, error.httpStatus)
            assertEquals("resource.conflict", error.problem.code)
            assertEquals("WOLF-API-1A2B", error.problem.referenceId)
        }
    }

    @Test
    fun an_automation_id_cannot_add_a_path_of_its_own() = runBlocking {
        try {
            api.deleteAutomation("../alert-rules/$ruleId", "token")
            fail("that path does not exist")
        } catch (error: WolfApiException) {
            assertEquals(404, error.httpStatus)
        }
        val path = last("DELETE").first.path!!
        assertTrue(path, path.startsWith("/api/v1/automations/"))
        assertFalse("the id stayed one segment: $path", path.contains("/alert-rules/"))
    }
}
