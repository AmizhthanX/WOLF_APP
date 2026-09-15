package app.amizhthan.wolf.push

import app.amizhthan.wolf.JvmAesGcmCipher
import app.amizhthan.wolf.JvmDeviceIdentity
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfJson
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.SessionManager
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
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/** Keeping WOLF's record of this phone's push token current, against a fake API that keeps one registration per device. */
class PushRegistrarTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<Pair<RecordedRequest, String>>()
    private val deviceId = "01J9ZQK7T0000000000000000D"

    @Volatile
    private var serverRegistered = false

    @Volatile
    private var serverConfigured = true

    private class FakeTokens(var token: String?) : PushTokens {
        var deleted = 0
        override suspend fun current(): String? = token
        override suspend fun delete() {
            deleted += 1
            token = null
        }
    }

    private class MemoryStore : RegistrationStore {
        override var marker: String? = null
    }

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request to request.body.readUtf8()
                return when ("${request.method} ${request.path}") {
                    "POST /api/v1/auth/login" -> MockResponse().setBody(
                        """{"accessToken":"access-1","accessTokenExpiresAt":"${Instant.now().plusSeconds(600)}","refreshToken":"refresh-1-0123456789abcdef","refreshTokenExpiresAt":"${Instant.now().plusSeconds(86400)}","device":{"id":"$deviceId","name":"Pixel","kind":"android"}}""",
                    )
                    "GET /api/v1/push" -> MockResponse().setBody("""{"configured":$serverConfigured,"provider":${if (serverConfigured) "\"fcm\"" else "null"},"registered":$serverRegistered}""")
                    "PUT /api/v1/push/token" -> {
                        serverRegistered = true
                        MockResponse().setResponseCode(204)
                    }
                    "DELETE /api/v1/push/token" -> {
                        serverRegistered = false
                        MockResponse().setResponseCode(204)
                    }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private suspend fun session(signIn: Boolean = true): Pair<WolfApi, SessionManager> {
        val api = WolfApi(server.url("/"), OkHttpClient())
        val session = SessionManager(api, TokenVault(File(folder.root, "credentials.bin"), JvmAesGcmCipher()), JvmDeviceIdentity(), "Pixel", "Android 16")
        if (signIn) session.signIn("owner@example.com", "right")
        return api to session
    }

    private fun puts() = requests.filter { it.first.method == "PUT" }

    @Test
    fun a_token_is_registered_once_and_not_again_while_nothing_has_changed() = runBlocking {
        val (api, session) = session()
        val tokens = FakeTokens("fcm-token-0123456789abcdef")
        val registrar = PushRegistrar(api, session, tokens, MemoryStore())

        val first = registrar.sync()
        assertEquals(PushState(buildConfigured = true, serverConfigured = true, registered = true), first)
        val body = WolfJson.parseToJsonElement(puts().single().second).jsonObject
        assertEquals("\"fcm\"", body["provider"].toString())
        assertEquals("\"fcm-token-0123456789abcdef\"", body["token"].toString())

        registrar.sync()
        assertEquals(1, puts().size)
    }

    @Test
    fun a_new_token_is_registered() = runBlocking {
        val (api, session) = session()
        val tokens = FakeTokens("fcm-token-0123456789abcdef")
        val registrar = PushRegistrar(api, session, tokens, MemoryStore())

        registrar.sync()
        tokens.token = "fcm-token-rotated-9876543210"
        registrar.sync()

        assertEquals(2, puts().size)
        assertTrue(puts().last().second.contains("fcm-token-rotated-9876543210"))
    }

    @Test
    fun a_server_that_lost_the_registration_is_given_it_again() = runBlocking {
        val (api, session) = session()
        val registrar = PushRegistrar(api, session, FakeTokens("fcm-token-0123456789abcdef"), MemoryStore())

        registrar.sync()
        serverRegistered = false
        registrar.sync()

        assertEquals(2, puts().size)
    }

    @Test
    fun the_phone_keeps_a_marker_of_what_it_registered_never_the_token() = runBlocking {
        val (api, session) = session()
        val store = MemoryStore()
        PushRegistrar(api, session, FakeTokens("fcm-token-0123456789abcdef"), store).sync()

        val marker = store.marker!!
        assertTrue(marker.startsWith("$deviceId:"))
        assertFalse(marker.contains("fcm-token"))
    }

    @Test
    fun a_build_without_a_push_service_registers_nothing_and_says_which_side_is_missing() = runBlocking {
        val (api, session) = session()

        val state = PushRegistrar(api, session, tokens = null, store = MemoryStore()).sync()

        assertEquals(PushState(buildConfigured = false, serverConfigured = true, registered = false), state)
        assertTrue(puts().isEmpty())
    }

    @Test
    fun a_server_without_a_push_service_still_keeps_the_registration_and_says_it_has_none() = runBlocking {
        serverConfigured = false
        val (api, session) = session()

        val state = PushRegistrar(api, session, FakeTokens("fcm-token-0123456789abcdef"), MemoryStore()).sync()

        assertEquals(false, state.serverConfigured)
        assertTrue(state.registered)
    }

    @Test
    fun a_signed_out_phone_asks_nothing() = runBlocking {
        val (api, session) = session(signIn = false)

        val state = PushRegistrar(api, session, FakeTokens("fcm-token-0123456789abcdef"), MemoryStore()).sync()

        assertNull(state.serverConfigured)
        assertFalse(state.registered)
        assertTrue(requests.isEmpty())
    }

    @Test
    fun signing_out_clears_the_registration_on_the_server_and_on_the_phone() = runBlocking {
        val (api, session) = session()
        val tokens = FakeTokens("fcm-token-0123456789abcdef")
        val store = MemoryStore()
        val registrar = PushRegistrar(api, session, tokens, store)
        registrar.sync()

        registrar.unregister()

        assertEquals(1, requests.count { it.first.method == "DELETE" && it.first.path == "/api/v1/push/token" })
        assertNull(store.marker)
        assertEquals(1, tokens.deleted)
        assertFalse(serverRegistered)
    }
}
