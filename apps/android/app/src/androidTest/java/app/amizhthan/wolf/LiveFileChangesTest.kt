package app.amizhthan.wolf

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
import app.amizhthan.wolf.remote.StreamListener
import app.amizhthan.wolf.remote.StreamPhase
import app.amizhthan.wolf.remote.StreamProfile
import app.amizhthan.wolf.remote.StreamSession
import app.amizhthan.wolf.remote.StreamFailure
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Rename, move, new folder and delete on a real PC, over a real stream, against a real WOLF cloud.
 *
 * In `C:\Users\Public\Documents` it makes a folder, sends a small file into it, renames the file, is refused a taken
 * name, makes a second folder and moves the file there, is refused a Windows file, then deletes the whole folder —
 * which goes to the Recycle Bin. Whoever runs it removes the test folder from the Recycle Bin afterwards, and checks
 * the audit trail for the path-free records.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveFileChangesTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveRealtime=ws://10.0.2.2:8081 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LiveFileChangesTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun files_are_renamed_moved_and_sent_to_the_recycle_bin_on_a_real_pc() = runBlocking {
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
        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-changes-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-changes-wrap")
        val credentials = File(context.noBackupFilesDir, "live-changes-credentials.bin")
        val session = SessionManager(api, TokenVault(credentials, cipher), identity, "WOLF live file changes test", "Android ${Build.VERSION.RELEASE}")
        val executor = Executors.newSingleThreadScheduledExecutor()
        val post: (() -> Unit) -> Unit = { task -> if (!executor.isShutdown) executor.execute(task) }
        var pcSession: PcSessionController? = null
        var stream: StreamSession? = null

        try {
            session.signIn(email, password)
            val pc = requireNotNull(session.authorized { api.listPcs(it) }.pcs.firstOrNull { it.status == "online" }) { "an online PC is enrolled against this cloud" }
            val remote = PcSessionController(pc.id, api, session, capabilities = listOf("screen", "file-transfer")).also { pcSession = it }
            val token = remote.sessionToken()
            val ice = api.iceServers(pc.id, token).configuration.iceServers.map { IceServerConfig(it.urls, it.username, it.credential) }
            val rtc = WebRtc.get(context)
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
                    if (control.granted) granted.countDown()
                }
            }

            executor.submit {
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
                stream = created
            }.get()

            assertTrue("the stream reached STREAMING (failures: $failures)", streaming.await(60, TimeUnit.SECONDS))
            post { stream?.requestFiles() }
            assertTrue("the cloud granted file access", granted.await(30, TimeUnit.SECONDS))

            val files = FileTransfer { message: JsonObject ->
                suspendCancellableCoroutine { continuation ->
                    post { stream!!.askFiles(message) { result -> result.fold({ continuation.resume(it) }, { continuation.resumeWithException(it) }) } }
                }
            }

            val base = "C:\\Users\\Public\\Documents"
            val topName = "wolf-live-test-changes-${Ulid.next()}"
            val top = FileMessages.childPath(base, topName)

            files.change(FileMessages.createFolder(top))
            val bytes = "changes".toByteArray()
            files.upload(FileMessages.childPath(top, "draft.txt"), bytes.size.toLong(), ByteArrayInputStream(bytes))

            files.change(FileMessages.rename(FileMessages.childPath(top, "draft.txt"), "final.txt"))
            assertEquals(listOf("final.txt"), files.list(top).entries.map { it.name })

            files.upload(FileMessages.childPath(top, "other.txt"), 1, ByteArrayInputStream(ByteArray(1)))
            try {
                files.change(FileMessages.rename(FileMessages.childPath(top, "other.txt"), "final.txt"))
                fail("a taken name must be refused")
            } catch (error: FileRefusalException) {
                assertEquals("exists", error.refusal.reason)
            }

            val archive = FileMessages.childPath(top, "Archive")
            files.change(FileMessages.createFolder(archive))
            files.change(FileMessages.move(FileMessages.childPath(top, "final.txt"), archive))
            assertEquals(listOf("final.txt"), files.list(archive).entries.map { it.name })

            try {
                files.change(FileMessages.delete("C:\\Windows\\notepad.exe"))
                fail("a Windows file must be refused")
            } catch (error: FileRefusalException) {
                assertEquals("rejected", error.refusal.reason)
            }

            files.change(FileMessages.delete(top))
            assertTrue("the folder is gone from Public Documents", files.list(base).entries.none { it.name == topName })
            Log.i(TAG, "made $topName, renamed, refused a taken name, moved, refused a Windows file, sent the folder to the Recycle Bin")
        } finally {
            post { stream?.releaseFiles() }
            post { stream?.stop() }
            Thread.sleep(500)
            executor.shutdown()
            runCatching { pcSession?.close() }
            runCatching { session.signOut() }
            identity.delete()
            cipher.delete()
            credentials.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLiveChanges"
    }
}
