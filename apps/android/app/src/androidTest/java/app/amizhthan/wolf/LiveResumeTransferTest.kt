package app.amizhthan.wolf

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.remote.Cancellable
import app.amizhthan.wolf.remote.DecoderCodecs
import app.amizhthan.wolf.remote.FileMessages
import app.amizhthan.wolf.remote.FileTransfer
import app.amizhthan.wolf.remote.IceServerConfig
import app.amizhthan.wolf.remote.InputControl
import app.amizhthan.wolf.remote.Negotiation
import app.amizhthan.wolf.remote.OkHttpSignalingSocket
import app.amizhthan.wolf.remote.RemoteState
import app.amizhthan.wolf.remote.StreamFailure
import app.amizhthan.wolf.remote.StreamListener
import app.amizhthan.wolf.remote.StreamPhase
import app.amizhthan.wolf.remote.StreamProfile
import app.amizhthan.wolf.remote.StreamSession
import app.amizhthan.wolf.remote.TransferInterruptedException
import app.amizhthan.wolf.remote.Ulid
import app.amizhthan.wolf.remote.WebRtc
import app.amizhthan.wolf.remote.WebRtcPeerFactory
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.random.Random

/**
 * Transfers cut off by a stream ending, carried on over a new stream, against a real WOLF cloud and a real PC.
 *
 * An upload of 400 KB of random bytes into `C:\Users\Public\Documents` has its stream stopped after two chunks.
 * The PC is asked, over a second stream, how much of the part file it kept; the upload carries on from there, and
 * the file is fetched back and compared byte for byte. That file is then fetched again with the stream stopped
 * partway, and the rest fetched over a third stream onto what had arrived.
 *
 * **WOLF cannot delete files**, so the file this test writes stays on the PC. Its name starts with
 * `wolf-live-test-resume-`, and whoever runs the test removes it afterwards.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveResumeTransferTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveRealtime=ws://10.0.2.2:8081 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LiveResumeTransferTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    /** One stream to the PC holding the file lease, on its own thread. */
    private class Link(val stream: StreamSession, val executor: ScheduledExecutorService) {
        fun post(task: () -> Unit) {
            if (!executor.isShutdown) executor.execute(task)
        }

        val transfer = FileTransfer { message: JsonObject ->
            suspendCancellableCoroutine { continuation ->
                post { stream.askFiles(message) { result -> result.fold({ continuation.resume(it) }, { continuation.resumeWithException(it) }) } }
            }
        }

        fun stop() {
            post { stream.stop() }
            executor.shutdown()
            executor.awaitTermination(5, TimeUnit.SECONDS)
        }
    }

    @Test
    fun an_interrupted_upload_and_download_carry_on_over_a_new_stream() = runBlocking {
        val apiUrl = arguments.getString("wolfLiveApi")
        val realtimeUrl = arguments.getString("wolfLiveRealtime")
        if (apiUrl == null || realtimeUrl == null) {
            Log.i(TAG, "Not run: pass wolfLiveApi, wolfLiveRealtime and wolfLivePassword with a local cloud and a running agent.")
            assertNull(arguments.getString("wolfLivePassword"))
            return@runBlocking
        }
        val email = arguments.getString("wolfLiveEmail") ?: "owner@example.com"
        val password = requireNotNull(arguments.getString("wolfLivePassword"))

        val http = OkHttpClient()
        val api = WolfApi(apiUrl.toHttpUrl(), http)
        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-resume-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-resume-wrap")
        val credentials = File(context.noBackupFilesDir, "live-resume-credentials.bin")
        val session = SessionManager(api, TokenVault(credentials, cipher), identity, "WOLF live resume test", "Android ${Build.VERSION.RELEASE}")
        var pcSession: PcSessionController? = null
        var link: Link? = null

        try {
            session.signIn(email, password)
            val pc = requireNotNull(session.authorized { api.listPcs(it) }.pcs.firstOrNull { it.status == "online" }) { "an online PC is enrolled against this cloud" }
            val remote = PcSessionController(pc.id, api, session, capabilities = listOf("screen", "file-transfer")).also { pcSession = it }
            val rtc = WebRtc.get(context)

            fun open(): Link {
                val token = runBlocking { remote.sessionToken() }
                val ice = runBlocking { api.iceServers(pc.id, token) }.configuration.iceServers.map { IceServerConfig(it.urls, it.username, it.credential) }
                val executor = Executors.newSingleThreadScheduledExecutor()
                val post: (() -> Unit) -> Unit = { task -> if (!executor.isShutdown) executor.execute(task) }
                val streaming = CountDownLatch(1)
                val granted = CountDownLatch(1)
                val failures = mutableListOf<StreamFailure>()
                val listener = object : StreamListener {
                    override fun onPhase(phase: StreamPhase, detail: String?) {
                        if (phase == StreamPhase.STREAMING) streaming.countDown()
                    }
                    override fun onFailure(failure: StreamFailure) {
                        failures += failure
                    }
                    override fun onNegotiation(negotiation: Negotiation) = Unit
                    override fun onInputControl(control: InputControl) = Unit
                    override fun onRemoteState(state: RemoteState) = Unit
                    override fun onInputRefused(reason: String, limitation: Boolean) = Unit
                    override fun onFileControl(control: InputControl) {
                        Log.i(TAG, "file access: granted=${control.granted} reason=${control.reason}")
                        if (control.granted) granted.countDown()
                    }
                }
                val stream = executor.submit<StreamSession> {
                    lateinit var created: StreamSession
                    val socket = OkHttpSignalingSocket(http, "${realtimeUrl.trimEnd('/')}/client", post, { created.onSocketOpen() }, { created.onSocketMessage(it) }, { created.onSocketClosed(it) })
                    created = StreamSession(
                        sessionToken = token,
                        iceServers = ice,
                        profile = StreamProfile.WIFI.json,
                        clientCodecs = DecoderCodecs.fromDecoderNames(rtc.decoderCodecNames),
                        socket = socket,
                        peers = WebRtcPeerFactory(rtc, post) { },
                        scheduler = { period, task ->
                            val future = executor.scheduleWithFixedDelay(task, period, period, TimeUnit.MILLISECONDS)
                            Cancellable { future.cancel(false) }
                        },
                        listener = listener,
                        h264Profiles = DecoderCodecs.h264Profiles(rtc.h264ProfileLevelIds),
                    )
                    created
                }.get()
                val opened = Link(stream, executor)
                assertTrue("the stream reached STREAMING (failures: $failures)", streaming.await(60, TimeUnit.SECONDS))
                opened.post { stream.requestFiles() }
                assertTrue("the cloud granted file access (failures: $failures)", granted.await(30, TimeUnit.SECONDS))
                return opened
            }

            val folder = "C:\\Users\\Public\\Documents"
            val path = FileMessages.childPath(folder, "wolf-live-test-resume-${Ulid.next()}.bin")
            val bytes = Random(System.nanoTime()).nextBytes(400_000)

            // 1. An upload whose stream is stopped after two chunks: interrupted, not cancelled.
            val first = open().also { link = it }
            var chunks = 0
            val interrupted = try {
                first.transfer.upload(path, bytes.size.toLong(), ByteArrayInputStream(bytes)) { done, _ ->
                    if (++chunks == 2) first.post { first.stream.stop() }
                    Log.i(TAG, "sent $done")
                }
                error("the upload should have been interrupted")
            } catch (error: TransferInterruptedException) {
                error
            }
            first.stop()
            Log.i(TAG, "upload interrupted at ${interrupted.done} of ${interrupted.total}")

            // 2. A new stream: the PC kept the part file, and the upload carries on from what it kept.
            val second = open().also { link = it }
            val kept = second.transfer.stat(path)
            assertNull("the file is not in place yet", kept.entry)
            assertTrue("the PC kept the part file (partialBytes ${kept.partialBytes})", (kept.partialBytes ?: 0) >= FileMessages.MAX_CHUNK)
            val (from, written) = second.transfer.resumeUpload(path, bytes.size.toLong(), ByteArrayInputStream(bytes))
            assertTrue(written.complete)
            assertEquals(kept.partialBytes, from)
            assertEquals("the PC's checksum covers the whole file", FileMessages.sha256Hex(bytes), written.sha256)
            val fetched = ByteArrayOutputStream()
            second.transfer.download(path, fetched)
            assertArrayEquals(bytes, fetched.toByteArray())
            Log.i(TAG, "upload resumed from $from over a new stream and verified byte for byte")

            // 3. A download whose stream is stopped partway, carried on over a third stream onto what arrived.
            val entry = requireNotNull(second.transfer.stat(path).entry)
            val sink = ByteArrayOutputStream()
            var reads = 0
            val cut = try {
                second.transfer.download(path, sink) { _, _ -> if (++reads == 2) second.post { second.stream.stop() } }
                error("the download should have been interrupted")
            } catch (error: TransferInterruptedException) {
                error
            }
            second.stop()
            assertEquals(cut.done, sink.size().toLong())

            val third = open().also { link = it }
            third.transfer.resumeDownload(path, sink, cut.done, cut.total, entry.modifiedAt)
            assertArrayEquals(bytes, sink.toByteArray())
            Log.i(TAG, "download interrupted at ${cut.done}, resumed over a new stream, verified byte for byte")
        } finally {
            link?.let { current -> runCatching { current.stop() } }
            runCatching { pcSession?.close() }
            runCatching { session.signOut() }
            identity.delete()
            cipher.delete()
            credentials.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLiveResume"
    }
}
