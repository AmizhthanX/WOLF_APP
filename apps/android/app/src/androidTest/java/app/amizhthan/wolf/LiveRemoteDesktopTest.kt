package app.amizhthan.wolf

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.remote.Cancellable
import app.amizhthan.wolf.remote.DecoderCodecs
import app.amizhthan.wolf.remote.IceServerConfig
import app.amizhthan.wolf.remote.InputControl
import app.amizhthan.wolf.remote.InputEvents
import app.amizhthan.wolf.remote.Negotiation
import app.amizhthan.wolf.remote.NormalizedPoint
import app.amizhthan.wolf.remote.OkHttpSignalingSocket
import app.amizhthan.wolf.remote.RemoteState
import app.amizhthan.wolf.remote.StreamFailure
import app.amizhthan.wolf.remote.StreamListener
import app.amizhthan.wolf.remote.StreamPhase
import app.amizhthan.wolf.remote.StreamProfile
import app.amizhthan.wolf.remote.StreamSession
import app.amizhthan.wolf.remote.WebRtc
import app.amizhthan.wolf.remote.WebRtcPeerFactory
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.webrtc.VideoSink
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Remote desktop against a real WOLF cloud and a real PC — the shipping agent and session host.
 *
 * It proves what nothing short of the real thing can: that the relay accepts this client's messages, that
 * the PC's offer is one libwebrtc on Android accepts, that frames are actually decoded, and that input
 * reaches the PC. The input it sends is a single pointer move, never a click: moving the cursor changes
 * nothing on the machine, and the test runner can read the cursor's position back to confirm it arrived.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveRemoteDesktopTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveRealtime=ws://10.0.2.2:8081 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LiveRemoteDesktopTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun streams_a_real_pc_and_moves_its_pointer() = runBlocking {
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
        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-rd-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-rd-wrap")
        val file = File(context.noBackupFilesDir, "live-rd-credentials.bin")
        val session = SessionManager(api, TokenVault(file, cipher), identity, "WOLF live remote desktop test", "Android ${Build.VERSION.RELEASE}")

        val executor = Executors.newSingleThreadScheduledExecutor()
        val post: (() -> Unit) -> Unit = { task -> executor.execute(task) }
        val phases = CopyOnWriteArrayList<StreamPhase>()
        val failures = CopyOnWriteArrayList<StreamFailure>()
        val streaming = CountDownLatch(1)
        val granted = CountDownLatch(1)
        val firstFrame = CountDownLatch(1)
        val frames = AtomicInteger()
        var frameSize = ""
        var negotiated: Negotiation? = null
        var pcSession: PcSessionController? = null
        var stream: StreamSession? = null

        try {
            session.signIn(email, password)
            val pc = session.authorized { api.listPcs(it) }.pcs.firstOrNull { it.status == "online" }
            assertTrue("an online PC is enrolled against this cloud", pc != null)

            val remoteSession = PcSessionController(pc!!.id, api, session, capabilities = listOf("screen", "input"))
            pcSession = remoteSession
            val token = remoteSession.sessionToken()
            val ice = api.iceServers(pc.id, token).configuration.iceServers.map { IceServerConfig(it.urls, it.username, it.credential) }
            val rtc = WebRtc.get(context)
            val codecs = DecoderCodecs.fromDecoderNames(rtc.decoderCodecNames)
            Log.i(TAG, "streaming ${pc.name}; phone claims $codecs; ${ice.size} ICE server(s)")
            Log.i(TAG, "decoders: ${rtc.decoderCodecDescriptions.joinToString(" ; ")}")
            val realPeers = WebRtcPeerFactory(rtc, post) { track ->
                track.addSink(VideoSink { frame ->
                    if (frames.incrementAndGet() == 1) {
                        frameSize = "${frame.rotatedWidth}x${frame.rotatedHeight}"
                        firstFrame.countDown()
                    }
                })
            }
            // Record the video codecs on each side of the negotiation: what the PC offered, what the phone answered.
            fun videoCodecs(sdp: String) = sdp.lines().filter { it.startsWith("a=rtpmap:") || it.startsWith("m=video") || it.startsWith("a=fmtp:") }.joinToString(" | ")
            val recordingPeers = app.amizhthan.wolf.remote.PeerFactory { servers, events ->
                val real = realPeers.create(servers, events)
                object : app.amizhthan.wolf.remote.PeerLink by real {
                    override fun answer(offerSdp: String, onAnswer: (String) -> Unit, onError: (String) -> Unit) {
                        Log.i(TAG, "offer: ${videoCodecs(offerSdp)}")
                        real.answer(offerSdp, { answer ->
                            Log.i(TAG, "answer: ${videoCodecs(answer)}")
                            onAnswer(answer)
                        }, onError)
                    }
                }
            }

            val listener = object : StreamListener {
                override fun onPhase(phase: StreamPhase, detail: String?) {
                    phases += phase
                    if (phase == StreamPhase.STREAMING) streaming.countDown()
                }
                override fun onFailure(failure: StreamFailure) {
                    failures += failure
                    Log.e(TAG, "failure: $failure")
                }
                override fun onNegotiation(negotiation: Negotiation) {
                    negotiated = negotiation
                }
                override fun onInputControl(control: InputControl) {
                    Log.i(TAG, "input control: $control")
                    if (control.granted) granted.countDown()
                }
                override fun onRemoteState(state: RemoteState) {
                    Log.i(TAG, "remote state: $state")
                }
                override fun onInputRefused(reason: String, limitation: Boolean) {
                    Log.w(TAG, "input refused: $reason (limitation=$limitation)")
                }
            }

            executor.submit {
                lateinit var created: StreamSession
                val socket = OkHttpSignalingSocket(
                    http,
                    "${realtimeUrl.trimEnd('/')}/client",
                    post,
                    onOpen = { created.onSocketOpen() },
                    onMessage = { created.onSocketMessage(it) },
                    onClosed = { created.onSocketClosed(it) },
                )
                created = StreamSession(
                    sessionToken = token,
                    iceServers = ice,
                    profile = StreamProfile.WIFI.json,
                    clientCodecs = codecs,
                    socket = socket,
                    peers = recordingPeers,
                    scheduler = { period, task ->
                        val future = executor.scheduleWithFixedDelay(task, period, period, TimeUnit.MILLISECONDS)
                        Cancellable { future.cancel(false) }
                    },
                    listener = listener,
                    h264Profiles = DecoderCodecs.h264Profiles(rtc.h264ProfileLevelIds),
                )
                stream = created
            }.get()

            // Wait first, then build the message: an argument list is evaluated before the call, so
            // "$phases" inline would describe the stream as it was before it had a chance to start.
            val reachedStreaming = streaming.await(60, TimeUnit.SECONDS)
            assertTrue("the stream reached STREAMING (phases $phases, failures $failures)", reachedStreaming)
            val decoded = firstFrame.await(30, TimeUnit.SECONDS)
            assertTrue("a frame was decoded (phases $phases, failures $failures)", decoded)

            Thread.sleep(3_000)
            Log.i(TAG, "negotiated $negotiated; first frame $frameSize; ${frames.get()} frames decoded in the first seconds")

            post { stream?.requestControl() }
            assertTrue("the relay granted input control", granted.await(20, TimeUnit.SECONDS))

            // A move and nothing else. The runner reads the PC's cursor afterwards.
            post { stream?.sendInput(listOf(InputEvents.move(NormalizedPoint(0.25, 0.25)))) }
            Thread.sleep(2_000)
            Log.i(TAG, "pointer.move sent to 0.25,0.25; ${frames.get()} frames decoded in total")

            post { stream?.releaseControl() }
            Thread.sleep(500)
            assertTrue("no failure during the stream: $failures", failures.isEmpty())
        } finally {
            post { stream?.stop() }
            Thread.sleep(500)
            executor.shutdown()
            pcSession?.close()
            runCatching { session.signOut() }
            identity.delete()
            cipher.delete()
            file.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLiveRemoteDesktop"
    }
}
