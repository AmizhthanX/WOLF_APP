package app.amizhthan.wolf

import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.remote.Cancellable
import app.amizhthan.wolf.remote.DecoderCodecs
import app.amizhthan.wolf.remote.FileMessages
import app.amizhthan.wolf.remote.FileRefusalException
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
import app.amizhthan.wolf.remote.TransferCancelledException
import app.amizhthan.wolf.remote.Ulid
import app.amizhthan.wolf.remote.WebRtc
import app.amizhthan.wolf.remote.WebRtcPeerFactory
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.storage.ContentResolverDocuments
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.random.Random

/**
 * The file manager against a real WOLF cloud and a real PC, over a real stream's data channel.
 *
 * It lists the drives, sees the PC refuse paths WOLF does not touch, sends a 200 KB file of random bytes into
 * `C:\Users\Public\Documents`, is refused when it sends the same name again, fetches the file back — once into
 * memory, once through the app's document store into a real file — and compares every byte. A second upload is
 * stopped partway, and the PC is asked whether its part file is gone.
 *
 * **WOLF cannot delete files**, so the one file this test writes stays on the PC. Its name starts with
 * `wolf-live-test-`, and whoever runs the test removes it afterwards.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveFileManagerTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveRealtime=ws://10.0.2.2:8081 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LiveFileManagerTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun sends_and_fetches_a_file_on_a_real_pc_over_the_data_channel() = runBlocking {
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
        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-files-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-files-wrap")
        val credentials = File(context.noBackupFilesDir, "live-files-credentials.bin")
        val session = SessionManager(api, TokenVault(credentials, cipher), identity, "WOLF live file manager test", "Android ${Build.VERSION.RELEASE}")

        val executor = Executors.newSingleThreadScheduledExecutor()
        val post: (() -> Unit) -> Unit = { task -> executor.execute(task) }
        val streaming = CountDownLatch(1)
        val filesGranted = CountDownLatch(1)
        val failures = mutableListOf<StreamFailure>()
        var pcSession: PcSessionController? = null
        var stream: StreamSession? = null
        val local = File(context.cacheDir, "wolf-live-fetched.bin")

        try {
            session.signIn(email, password)
            val pc = requireNotNull(session.authorized { api.listPcs(it) }.pcs.firstOrNull { it.status == "online" }) { "an online PC is enrolled against this cloud" }
            val remote = PcSessionController(pc.id, api, session, capabilities = listOf("screen", "file-transfer")).also { pcSession = it }
            val token = remote.sessionToken()
            val ice = api.iceServers(pc.id, token).configuration.iceServers.map { IceServerConfig(it.urls, it.username, it.credential) }
            val rtc = WebRtc.get(context)

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
                    Log.i(TAG, "file access: $control")
                    if (control.granted) filesGranted.countDown()
                }
            }

            executor.submit {
                lateinit var created: StreamSession
                val socket = OkHttpSignalingSocket(http, "${realtimeUrl.trimEnd('/')}/client", post, { created.onSocketOpen() }, { created.onSocketMessage(it) }, { created.onSocketClosed(it) })
                created = StreamSession(
                    sessionToken = token,
                    iceServers = ice,
                    profile = StreamProfile.SHARP.json,
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
                stream = created
            }.get()

            assertTrue("the stream reached STREAMING", streaming.await(60, TimeUnit.SECONDS).also { if (!it) Log.e(TAG, "failures: $failures") })
            post { stream?.requestFiles() }
            assertTrue("the cloud granted file access", filesGranted.await(20, TimeUnit.SECONDS))

            val transfer = FileTransfer { message: JsonObject ->
                suspendCancellableCoroutine { continuation ->
                    post { stream!!.askFiles(message) { result -> result.fold({ continuation.resume(it) }, { continuation.resumeWithException(it) }) } }
                }
            }
            suspend fun refusedReason(block: suspend () -> Unit): String = try {
                block()
                fail("expected the PC to refuse")
                ""
            } catch (error: FileRefusalException) {
                error.refusal.reason
            }

            // 1. The drives, and a folder.
            val drives = transfer.list(null)
            assertTrue("C: is listed", drives.entries.any { it.kind == "drive" && it.path.equals("C:", ignoreCase = true) })
            val folder = "C:\\Users\\Public\\Documents"
            assertEquals(folder, transfer.list(folder).path)

            // 2. Paths WOLF does not touch, refused by the PC with a reason.
            val network = refusedReason { transfer.list("\\\\wolf-live-test-server\\share") }
            val climbing = refusedReason { transfer.list("C:\\Users\\..\\Windows") }
            val device = refusedReason { transfer.list("C:\\Users\\Public\\CON") }
            Log.i(TAG, "refused: network path $network, climbing $climbing, device name $device")

            // 3. Send 200 KB of random bytes.
            val bytes = Random(System.nanoTime()).nextBytes(200_000)
            val name = "wolf-live-test-${Ulid.next()}.bin"
            val path = FileMessages.childPath(folder, name)
            val written = transfer.upload(path, bytes.size.toLong(), ByteArrayInputStream(bytes))
            assertTrue(written.complete)
            assertEquals(FileMessages.sha256Hex(bytes), written.sha256)
            assertEquals(200_000L, transfer.list(folder).entries.single { it.name == name }.sizeBytes)
            Log.i(TAG, "sent $name (200000 bytes) into $folder; WOLF cannot delete it, so the runner removes it")

            // 4. The same name again is refused rather than overwritten.
            assertEquals("exists", refusedReason { transfer.upload(path, 10, ByteArrayInputStream(ByteArray(10))) })

            // 5. Fetched back, into memory and through the document store into a real file.
            val fetched = ByteArrayOutputStream()
            transfer.download(path, fetched)
            assertArrayEquals(bytes, fetched.toByteArray())

            val documents = ContentResolverDocuments(context.contentResolver)
            documents.openOutput(Uri.fromFile(local)).use { transfer.download(path, it) }
            assertArrayEquals(bytes, local.readBytes())

            // 6. A stopped upload leaves no part file behind.
            val stoppedPath = FileMessages.childPath(folder, "wolf-live-test-stopped-${Ulid.next()}.bin")
            var checks = 0
            try {
                transfer.upload(stoppedPath, 200_000, ByteArrayInputStream(ByteArray(200_000)), cancelled = { checks++ >= 2 })
                fail("the upload should have stopped")
            } catch (_: TransferCancelledException) {
            }
            val stopped = transfer.stat(stoppedPath)
            assertNull("no file was created", stopped.entry)
            assertNull("the part file went with the cancelled transfer", stopped.partialBytes)
            Log.i(TAG, "round trip verified byte for byte; stopped upload left nothing")
        } finally {
            post { stream?.releaseFiles() }
            post { stream?.stop() }
            Thread.sleep(500)
            executor.shutdown()
            runCatching { pcSession?.close() }
            runCatching { session.signOut() }
            local.delete()
            identity.delete()
            cipher.delete()
            credentials.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLiveFiles"
    }
}
