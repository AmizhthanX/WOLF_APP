package app.amizhthan.wolf.api

import app.amizhthan.wolf.ui.bytes
import app.amizhthan.wolf.ui.percent
import app.amizhthan.wolf.ui.ratio
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/** The HTTP client: paths, headers, the WOLF error envelope, and nulls that stay null. */
class WolfApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: WolfApi

    @Before
    fun start() {
        server = MockWebServer().apply { start() }
        api = WolfApi(server.url("/"), OkHttpClient())
    }

    @After
    fun stop() = server.shutdown()

    @Test
    fun an_authorized_call_sends_the_bearer_to_the_versioned_path() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"pcs":[{"id":"01J9ZQK7T0000000000000000P","name":"STUDIO","status":"online","registrationState":"active"}]}"""))

        val list = api.listPcs("token-1")
        val request = server.takeRequest()

        assertEquals("/api/v1/pcs", request.path)
        assertEquals("Bearer token-1", request.getHeader("Authorization"))
        assertEquals("STUDIO", list.pcs.single().name)
    }

    @Test
    fun an_id_cannot_add_path_segments_of_its_own() = runBlocking {
        server.enqueue(MockResponse().setBody("""{"sample":null,"sampledAt":null,"pcStatus":"offline"}"""))

        api.latestTelemetry("../../auth/logout", "token-1")

        assertEquals("/api/v1/pcs/..%2F..%2Fauth%2Flogout/telemetry/latest", server.takeRequest().path)
    }

    @Test
    fun a_wolf_error_keeps_every_field_the_owner_needs() = runBlocking {
        server.enqueue(
            MockResponse().setResponseCode(428).setBody(
                """{"error":{"code":"command.confirmation_required","problem":"Restart needs to be confirmed.","cause":"High risk.","currentState":"Nothing was changed.","recommendedAction":"Confirm the action to proceed.","referenceId":"WOLF-CMD-1A2B","context":{"riskLevel":"high"}}}""",
            ),
        )

        try {
            api.listPcs("token-1")
            fail("expected an error")
        } catch (error: WolfApiException) {
            assertEquals(428, error.httpStatus)
            assertEquals("command.confirmation_required", error.problem.code)
            assertEquals("Confirm the action to proceed.", error.problem.recommendedAction)
            assertEquals("WOLF-CMD-1A2B", error.problem.referenceId)
            assertEquals("\"high\"", error.problem.context?.get("riskLevel").toString())
        }
    }

    @Test
    fun a_non_wolf_error_body_still_becomes_a_problem_with_a_reference() = runBlocking {
        server.enqueue(MockResponse().setResponseCode(502).setBody("<html>Bad gateway</html>"))

        try {
            api.listPcs("token-1")
            fail("expected an error")
        } catch (error: WolfApiException) {
            assertEquals(502, error.httpStatus)
            assertEquals("WOLF-NET-HTTP502", error.problem.referenceId)
        }
    }

    @Test
    fun an_unreachable_server_is_a_network_problem_not_a_crash() = runBlocking {
        server.shutdown()
        try {
            api.listPcs("token-1")
            fail("expected an error")
        } catch (error: WolfApiException) {
            assertEquals(0, error.httpStatus)
            assertEquals("network.unreachable", error.problem.code)
        }
    }

    @Test
    fun a_metric_the_pc_could_not_read_stays_unknown() = runBlocking {
        server.enqueue(
            MockResponse().setBody(
                """{"sample":{"sampledAt":"2026-09-14T12:00:00Z","uptimeSeconds":3600,"cpu":{"usagePercent":null},"memory":{"totalBytes":16000,"usedBytes":null},"gpus":[],"disks":[],"networks":[]},"sampledAt":"2026-09-14T12:00:00Z","pcStatus":"online"}""",
            ),
        )

        val latest = api.latestTelemetry("01J9ZQK7T0000000000000000P", "token-1")

        assertNull(latest.sample?.cpu?.usagePercent)
        // Shown as a dash, never as 0%.
        assertEquals("—", percent(latest.sample?.cpu?.usagePercent))
        assertEquals("—", percent(ratio(latest.sample?.memory?.usedBytes, latest.sample?.memory?.totalBytes)))
        assertEquals("15.6 KB", bytes(latest.sample?.memory?.totalBytes))
    }
}
