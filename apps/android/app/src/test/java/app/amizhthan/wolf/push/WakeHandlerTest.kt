package app.amizhthan.wolf.push

import app.amizhthan.wolf.JvmAesGcmCipher
import app.amizhthan.wolf.JvmDeviceIdentity
import app.amizhthan.wolf.api.NotificationView
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList

/** What a wake-up shows: only what WOLF says is new, fetched over the phone's own connection. */
class WakeHandlerTest {
    @get:Rule
    val folder = TemporaryFolder()

    private lateinit var server: MockWebServer
    private val requests = CopyOnWriteArrayList<RecordedRequest>()

    @Volatile
    private var inbox = emptyList<String>()

    @Volatile
    private var failInbox = false

    private class Recorder : Notifier {
        val shown = mutableListOf<NotificationView>()
        val summaries = mutableListOf<Int>()
        override fun show(notification: NotificationView) {
            shown += notification
        }
        override fun showSummary(more: Int) {
            summaries += more
        }
    }

    private class MemorySeen : SeenStore {
        val ids = LinkedHashSet<String>()
        override fun seen(): Set<String> = ids.toSet()
        override fun remember(ids: Collection<String>) {
            this.ids += ids
        }
    }

    private fun notification(id: Char, minute: Int, read: Boolean = false) =
        """{"id":"01J9ZQK7T000000000000000$id$id","ruleId":null,"automationId":null,"pcId":null,"kind":"fired","severity":"warning","title":"Alert $id","detail":"Detail $id","metric":null,"seriesKey":null,"value":null,"threshold":null,"occurredAt":"2026-09-15T10:${minute.toString().padStart(2, '0')}:00Z","readAt":${if (read) "\"2026-09-15T11:00:00Z\"" else "null"}}"""

    @Before
    fun start() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                requests += request
                return when ("${request.method} ${request.path}") {
                    "POST /api/v1/auth/login" -> MockResponse().setBody(
                        """{"accessToken":"access-1","accessTokenExpiresAt":"${Instant.now().plusSeconds(600)}","refreshToken":"refresh-1-0123456789abcdef","refreshTokenExpiresAt":"${Instant.now().plusSeconds(86400)}","device":{"id":"01J9ZQK7T0000000000000000D","name":"Pixel","kind":"android"}}""",
                    )
                    "GET /api/v1/notifications" ->
                        if (failInbox) {
                            MockResponse().setResponseCode(503)
                        } else {
                            // Newest first, as the API orders it.
                            MockResponse().setBody("""{"notifications":[${inbox.reversed().joinToString(",")}],"unreadCount":${inbox.size}}""")
                        }
                    else -> MockResponse().setResponseCode(404)
                }
            }
        }
        server.start()
    }

    @After
    fun stop() = server.shutdown()

    private suspend fun handler(recorder: Recorder, seen: SeenStore = MemorySeen(), signIn: Boolean = true): WakeHandler {
        val api = WolfApi(server.url("/"), OkHttpClient())
        val session = SessionManager(api, TokenVault(File(folder.root, "credentials.bin"), JvmAesGcmCipher()), JvmDeviceIdentity(), "Pixel", "Android 16")
        if (signIn) session.signIn("owner@example.com", "right")
        return WakeHandler(api, session, recorder, seen)
    }

    @Test
    fun news_not_shown_before_is_shown_oldest_first_and_remembered() = runBlocking {
        inbox = listOf(notification('A', 1), notification('B', 2))
        val recorder = Recorder()
        val seen = MemorySeen()

        assertEquals(2, handler(recorder, seen).onWake())

        assertEquals(listOf("Alert A", "Alert B"), recorder.shown.map { it.title })
        assertEquals(2, seen.ids.size)
    }

    @Test
    fun a_second_wake_up_about_the_same_news_shows_nothing() = runBlocking {
        inbox = listOf(notification('A', 1))
        val recorder = Recorder()
        val wake = handler(recorder)

        wake.onWake()
        inbox = listOf(notification('A', 1), notification('C', 3))
        wake.onWake()

        assertEquals(listOf("Alert A", "Alert C"), recorder.shown.map { it.title })
    }

    @Test
    fun notifications_already_read_are_not_shown() = runBlocking {
        inbox = listOf(notification('A', 1, read = true), notification('B', 2))
        val recorder = Recorder()

        handler(recorder).onWake()

        assertEquals(listOf("Alert B"), recorder.shown.map { it.title })
    }

    @Test
    fun a_burst_shows_the_latest_few_and_counts_the_rest() = runBlocking {
        inbox = listOf('A', 'B', 'C', 'D', 'E', 'F').mapIndexed { index, id -> notification(id, index) }
        val recorder = Recorder()

        assertEquals(6, handler(recorder).onWake())

        assertEquals(listOf("Alert C", "Alert D", "Alert E", "Alert F"), recorder.shown.map { it.title })
        assertEquals(listOf(2), recorder.summaries)
    }

    @Test
    fun a_phone_with_no_credentials_shows_nothing_and_asks_nothing() = runBlocking {
        inbox = listOf(notification('A', 1))
        val recorder = Recorder()

        assertEquals(0, handler(recorder, signIn = false).onWake())

        assertTrue(recorder.shown.isEmpty())
        assertTrue(requests.none { it.path == "/api/v1/notifications" })
    }

    @Test
    fun a_failed_fetch_shows_nothing_and_remembers_nothing_so_the_news_is_not_lost() = runBlocking {
        inbox = listOf(notification('A', 1))
        val recorder = Recorder()
        val seen = MemorySeen()
        val wake = handler(recorder, seen)

        failInbox = true
        assertEquals(0, wake.onWake())
        assertTrue(seen.ids.isEmpty())

        failInbox = false
        assertEquals(1, wake.onWake())
        assertEquals(listOf("Alert A"), recorder.shown.map { it.title })
    }
}
