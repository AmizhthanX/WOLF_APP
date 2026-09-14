package app.amizhthan.wolf.session

import app.amizhthan.wolf.JvmAesGcmCipher
import app.amizhthan.wolf.JvmDeviceIdentity
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfJson
import app.amizhthan.wolf.security.StoredCredentials
import app.amizhthan.wolf.security.TokenVault
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
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
import org.junit.Assert.assertNotNull
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
 * Sign-in, refresh and sign-out against a fake WOLF API that behaves like the real one: rotating
 * refresh tokens, and a replayed refresh token treated as theft.
 */
class SessionManagerTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<RecordedRequest>()
    private val refreshes = AtomicInteger()
    private val issued = AtomicInteger()
    private val consumed = java.util.Collections.synchronizedSet(mutableSetOf<String>())

    @Volatile
    private var validAccess = "access-0"

    @Volatile
    private var accessLifetimeSeconds = 600L

    @Volatile
    private var refreshRevoked = false

    private val cipher = JvmAesGcmCipher()
    private val identity = JvmDeviceIdentity()

    private fun grant(): String {
        val n = issued.incrementAndGet()
        validAccess = "access-$n"
        return """
            {"accessToken":"access-$n","accessTokenExpiresAt":"${Instant.now().plusSeconds(accessLifetimeSeconds)}",
             "refreshToken":"refresh-$n-0123456789abcdef","refreshTokenExpiresAt":"${Instant.now().plusSeconds(86_400)}",
             "device":{"id":"01J9ZQK7T0000000000000000D","name":"Pixel","kind":"android","status":"active"}}
        """.trimIndent()
    }

    private fun error(status: Int, code: String) = MockResponse().setResponseCode(status).setBody(
        """{"error":{"code":"$code","problem":"Refused.","cause":"Test.","currentState":"Nothing changed.","recommendedAction":"Try again.","referenceId":"WOLF-AUTH-TEST"}}""",
    )

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when (request.path) {
                    "/api/v1/auth/login" -> MockResponse().setBody(grant())
                    "/api/v1/auth/refresh" -> {
                        refreshes.incrementAndGet()
                        val token = WolfJson.parseToJsonElement(request.body.readUtf8()).jsonObject["refreshToken"]!!.jsonPrimitive.content
                        // Rotation with replay detection, as the server does it.
                        if (refreshRevoked || !consumed.add(token)) error(401, "auth.token_replayed") else MockResponse().setBody(grant())
                    }
                    "/api/v1/auth/logout" -> MockResponse().setResponseCode(204)
                    "/api/v1/pcs" ->
                        if (request.getHeader("Authorization") == "Bearer $validAccess") MockResponse().setBody("""{"pcs":[]}""")
                        else error(401, "auth.unauthorized")
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private fun manager(vaultFile: File = File(folder.root, "credentials.bin")) = SessionManager(
        api = WolfApi(server.url("/"), OkHttpClient()),
        vault = TokenVault(vaultFile, cipher),
        identity = identity,
        deviceName = "Google Pixel 9",
        platform = "Android 16 (API 36)",
    )

    @Test
    fun signing_in_sends_the_phone_identity_and_stores_only_the_refresh_token() = runBlocking {
        val file = File(folder.root, "credentials.bin")
        val session = manager(file)

        session.signIn(" owner@example.com ", "a-long-owner-passphrase")

        val login = WolfJson.parseToJsonElement(requests.first { it.path == "/api/v1/auth/login" }.body.readUtf8()).jsonObject
        val device = login["device"]!!.jsonObject
        assertEquals("owner@example.com", login["email"]!!.jsonPrimitive.content)
        assertEquals("android", device["kind"]!!.jsonPrimitive.content)
        assertEquals(identity.publicKeySpki(), device["publicKey"]!!.jsonPrimitive.content)

        assertTrue(session.state.value is SessionState.SignedIn)
        val stored = TokenVault(file, cipher).read()
        assertEquals("refresh-1-0123456789abcdef", stored?.refreshToken)
        // The access token is not in the vault: it is not a field there at all.
        assertTrue(!file.readBytes().toString(Charsets.ISO_8859_1).contains("access-1"))
    }

    @Test
    fun a_second_sign_in_reuses_the_device_id() = runBlocking {
        val file = File(folder.root, "credentials.bin")
        manager(file).signIn("owner@example.com", "pw")
        manager(file).signIn("owner@example.com", "pw")

        val second = WolfJson.parseToJsonElement(requests.filter { it.path == "/api/v1/auth/login" }[1].body.readUtf8()).jsonObject
        assertEquals("01J9ZQK7T0000000000000000D", second["device"]!!.jsonObject["id"]!!.jsonPrimitive.content)
    }

    @Test
    fun a_rejected_access_token_is_refreshed_once_and_the_call_retried() = runBlocking {
        val session = manager()
        session.signIn("owner@example.com", "pw")

        // The server has moved on (a restart, a revoked token): the next call gets a 401.
        validAccess = "something-else"
        val pcs = session.authorized { bearer ->
            WolfApi(server.url("/"), OkHttpClient()).listPcs(bearer).also {
                // The retry carries the refreshed token.
                assertEquals("access-2", bearer)
            }
        }

        assertEquals(0, pcs.pcs.size)
        assertEquals(1, refreshes.get())
    }

    @Test
    fun concurrent_calls_with_an_expired_token_share_one_refresh() = runBlocking {
        accessLifetimeSeconds = 5 // inside the expiry margin: every call must refresh first
        val session = manager()
        session.signIn("owner@example.com", "pw")
        accessLifetimeSeconds = 600

        val api = WolfApi(server.url("/"), OkHttpClient())
        (1..8).map { async(kotlinx.coroutines.Dispatchers.IO) { session.authorized { api.listPcs(it) } } }.awaitAll()

        // Refresh tokens rotate, and presenting a used one revokes the family. Eight refreshes would
        // have signed the phone out; one is correct.
        assertEquals(1, refreshes.get())
        assertTrue(session.state.value is SessionState.SignedIn)
    }

    @Test
    fun a_refused_refresh_signs_out_and_forgets_the_credentials() = runBlocking {
        val file = File(folder.root, "credentials.bin")
        val session = manager(file)
        session.signIn("owner@example.com", "pw")

        refreshRevoked = true
        validAccess = "revoked"

        try {
            session.authorized { WolfApi(server.url("/"), OkHttpClient()).listPcs(it) }
            fail("a revoked device must not keep working")
        } catch (error: WolfApiException) {
            assertEquals(401, error.httpStatus)
            assertEquals("auth.token_replayed", error.problem.code)
        }

        assertTrue(session.state.value is SessionState.SignedOut)
        assertNull(TokenVault(file, cipher).read())
    }

    @Test
    fun being_offline_is_not_being_signed_out() = runBlocking {
        val file = File(folder.root, "credentials.bin")
        TokenVault(file, cipher).write(StoredCredentials("refresh-9-0123456789abcdef", "01J9ZQK7T0000000000000000D"))
        server.shutdown()

        val session = manager(file)
        assertTrue("stored credentials survive a launch with no network", session.restore())
        assertNotNull(TokenVault(file, cipher).read())
    }

    @Test
    fun launching_with_stored_credentials_restores_the_session() = runBlocking {
        val file = File(folder.root, "credentials.bin")
        manager(file).signIn("owner@example.com", "pw")

        val relaunched = manager(file)
        assertTrue(relaunched.restore())
        assertEquals(0, relaunched.authorized { WolfApi(server.url("/"), OkHttpClient()).listPcs(it) }.pcs.size)
    }

    @Test
    fun signing_out_tells_the_server_and_forgets_locally() = runBlocking {
        val file = File(folder.root, "credentials.bin")
        val session = manager(file)
        session.signIn("owner@example.com", "pw")

        session.signOut()

        assertTrue(requests.any { it.path == "/api/v1/auth/logout" })
        assertNull(TokenVault(file, cipher).read())
        assertTrue(session.state.value is SessionState.SignedOut)
    }
}
