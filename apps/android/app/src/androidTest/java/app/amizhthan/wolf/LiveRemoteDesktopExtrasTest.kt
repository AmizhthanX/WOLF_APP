package app.amizhthan.wolf

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.remote.Cancellable
import app.amizhthan.wolf.remote.ClipboardEvent
import app.amizhthan.wolf.remote.ClipboardSend
import app.amizhthan.wolf.remote.DecoderCodecs
import app.amizhthan.wolf.remote.Displays
import app.amizhthan.wolf.remote.IceServerConfig
import app.amizhthan.wolf.remote.InputControl
import app.amizhthan.wolf.remote.Negotiation
import app.amizhthan.wolf.remote.OkHttpSignalingSocket
import app.amizhthan.wolf.remote.PeerFactory
import app.amizhthan.wolf.remote.PeerLink
import app.amizhthan.wolf.remote.RemoteState
import app.amizhthan.wolf.remote.StreamFailure
import app.amizhthan.wolf.remote.StreamListener
import app.amizhthan.wolf.remote.StreamPhase
import app.amizhthan.wolf.remote.StreamProfile
import app.amizhthan.wolf.remote.StreamSession
import app.amizhthan.wolf.remote.Ulid
import app.amizhthan.wolf.remote.WebRtc
import app.amizhthan.wolf.remote.WebRtcPeerFactory
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.CommandOutcome
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
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
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * The remote desktop's extras against a real cloud and the real PC: the PC's displays and switching between
 * them, its sound, and the clipboard in both directions.
 *
 * No click, key or scroll is sent — the session does not even hold `input`. The one thing on the PC it changes
 * is the clipboard, and only when `wolfLiveClipboard=true` says the runner is keeping it safe: the runner saves
 * the PC's clipboard first, answers the phone's marker with a marker of its own, and puts the saved text back
 * afterwards. What it saved is never printed.
 *
 *     npm run dev:cloud                      (and an enrolled, running agent)
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveRemoteDesktopExtrasTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveRealtime=ws://10.0.2.2:8081 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password> \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveClipboard=true
 */
@RunWith(AndroidJUnit4::class)
class LiveRemoteDesktopExtrasTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun displays_sound_and_the_clipboard_on_a_real_pc() = runBlocking {
        val apiUrl = arguments.getString("wolfLiveApi")
        val realtimeUrl = arguments.getString("wolfLiveRealtime")
        if (apiUrl == null || realtimeUrl == null) {
            Log.i(TAG, "Not run: pass wolfLiveApi, wolfLiveRealtime and wolfLivePassword with a local cloud and a running agent.")
            assertNull(arguments.getString("wolfLivePassword"))
            return@runBlocking
        }
        val email = arguments.getString("wolfLiveEmail") ?: "owner@example.com"
        val password = requireNotNull(arguments.getString("wolfLivePassword"))
        val checkClipboard = arguments.getString("wolfLiveClipboard") == "true"
        val askSound = arguments.getString("wolfLiveSound") != "false"

        val http = OkHttpClient()
        val api = WolfApi(apiUrl.toHttpUrl(), http)
        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-rdx-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-rdx-wrap")
        val file = File(context.noBackupFilesDir, "live-rdx-credentials.bin")
        val session = SessionManager(api, TokenVault(file, cipher), identity, "WOLF live remote desktop extras test", "Android ${Build.VERSION.RELEASE}")

        val executor = Executors.newSingleThreadScheduledExecutor()
        val post: (() -> Unit) -> Unit = { task -> executor.execute(task) }
        val phases = CopyOnWriteArrayList<StreamPhase>()
        val failures = CopyOnWriteArrayList<StreamFailure>()
        val negotiations = CopyOnWriteArrayList<Negotiation>()
        val clipboard = CopyOnWriteArrayList<ClipboardEvent>()
        val streaming = CountDownLatch(1)
        val firstFrame = CountDownLatch(1)
        var pcSession: PcSessionController? = null
        var stream: StreamSession? = null

        try {
            session.signIn(email, password)
            val pc = requireNotNull(session.authorized { api.listPcs(it) }.pcs.firstOrNull { it.status == "online" }) { "an online PC is enrolled against this cloud" }
            val remote = PcSessionController(pc.id, api, session, capabilities = listOf("screen", "audio", "clipboard"))
            pcSession = remote

            // 1. The displays, through the command the app sends.
            val listed = (remote.run(Commands.listDisplays(), "List displays", "Live test") as CommandOutcome.Done).command
            Log.i(TAG, "list-displays: ${listed.status} ${listed.failure ?: ""}")
            assertEquals("completed", listed.status)
            val displays = Displays.parse(listed.result)
            Log.i(TAG, "displays: ${displays.joinToString(" ; ") { "${Displays.label(it)} [${it.id}]" }}")
            assertTrue("the PC has at least one display", displays.isNotEmpty())

            // 2. A stream that asks for sound.
            val token = remote.sessionToken()
            val ice = api.iceServers(pc.id, token).configuration.iceServers.map { IceServerConfig(it.urls, it.username, it.credential) }
            val rtc = WebRtc.get(context)
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
                    negotiations += negotiation
                    Log.i(TAG, "negotiated: $negotiation")
                }
                override fun onInputControl(control: InputControl) = Unit
                override fun onRemoteState(state: RemoteState) {
                    Log.i(TAG, "remote state: $state")
                }
                override fun onInputRefused(reason: String, limitation: Boolean) = Unit
                override fun onClipboard(event: ClipboardEvent) {
                    clipboard += event
                    // A length, never the text: ClipboardEvent.Content prints no content.
                    Log.i(TAG, "clipboard: $event")
                }
            }
            val realPeers = WebRtcPeerFactory(rtc, post) { track -> track.addSink(VideoSink { firstFrame.countDown() }) }
            // The media sections each side put in the negotiation, for a stream that shows nothing.
            fun media(sdp: String) = sdp.lines()
                .filter { line -> listOf("m=", "a=mid:", "a=group:", "a=sendrecv", "a=sendonly", "a=recvonly", "a=inactive").any { line.startsWith(it) } }
                .joinToString(" | ")
            val recordingPeers = PeerFactory { servers, events ->
                val real = realPeers.create(servers, events)
                object : PeerLink by real {
                    override fun answer(offerSdp: String, onAnswer: (String) -> Unit, onError: (String) -> Unit) {
                        Log.i(TAG, "offer: ${media(offerSdp)}")
                        real.answer(offerSdp, { answer ->
                            Log.i(TAG, "answer: ${media(answer)}")
                            onAnswer(answer)
                        }, onError)
                    }
                }
            }
            executor.submit {
                lateinit var created: StreamSession
                val socket = OkHttpSignalingSocket(
                    http,
                    "${realtimeUrl.trimEnd('/')}/client",
                    post,
                    onOpen = { created.onSocketOpen() },
                    onMessage = { text ->
                        // The PC's own account of the stream — key frames sent, loss, rate — for a picture that does not arrive.
                        if (text.contains("\"stream.stats\"")) Log.i(TAG, "pc stats: ${statsSummary(text)}")
                        created.onSocketMessage(text)
                    },
                    onClosed = { created.onSocketClosed(it) },
                )
                created = StreamSession(
                    sessionToken = token,
                    iceServers = ice,
                    // The full picture. On the emulator's lossy link a 2560x1440 key frame loses about a fifth of its
                    // packets; before the session host re-encoded a still desktop's picture on request, a lost one was
                    // never replaced and this stream showed nothing.
                    profile = StreamProfile.SHARP.json,
                    clientCodecs = DecoderCodecs.fromDecoderNames(rtc.decoderCodecNames),
                    socket = socket,
                    peers = recordingPeers,
                    scheduler = { period, task ->
                        val future = executor.scheduleWithFixedDelay(task, period, period, TimeUnit.MILLISECONDS)
                        Cancellable { future.cancel(false) }
                    },
                    listener = listener,
                    h264Profiles = DecoderCodecs.h264Profiles(rtc.h264ProfileLevelIds),
                    requestAudio = askSound,
                )
                stream = created
            }.get()

            val reached = streaming.await(60, TimeUnit.SECONDS)
            assertTrue("the stream reached STREAMING (phases $phases, failures $failures)", reached)
            val decoded = firstFrame.await(45, TimeUnit.SECONDS)
            if (!decoded) {
                // Say what did arrive before failing: nothing at all, packets but no frames, or frames not decoded.
                val reported = CountDownLatch(2)
                post {
                    val current = stream
                    if (current == null) {
                        reported.countDown()
                        reported.countDown()
                    } else {
                        current.inboundRtp("video") { video ->
                            Log.w(TAG, "no picture; video inbound-rtp: $video")
                            reported.countDown()
                        }
                        current.inboundRtp("audio") { audio ->
                            Log.w(TAG, "no picture; audio inbound-rtp packetsReceived: ${audio?.get("packetsReceived")}")
                            reported.countDown()
                        }
                    }
                }
                reported.await(10, TimeUnit.SECONDS)
            }
            assertTrue("a frame was decoded", decoded)

            // 3. Sound: what the PC settled on, and packets actually arriving — or the PC's reason there are none.
            val first = negotiations.first()
            if (!askSound) {
                Log.i(TAG, "sound: not asked for (wolfLiveSound=false)")
            } else if (first.audioCodec == null) {
                Log.i(TAG, "no sound: ${first.adjustments}")
                assertTrue("a stream without sound says why", first.adjustments.any { it.setting == "audioEnabled" })
            } else {
                Thread.sleep(5_000)
                val received = AtomicLong(-1)
                val counted = CountDownLatch(1)
                post {
                    val current = stream
                    if (current == null) counted.countDown() else current.inboundRtp("audio") { stats ->
                        received.set((stats?.get("packetsReceived") as? Number)?.toLong() ?: -1)
                        counted.countDown()
                    }
                }
                assertTrue("the connection reported its statistics", counted.await(10, TimeUnit.SECONDS))
                Log.i(TAG, "sound: ${first.audioCodec}, ${received.get()} audio packets received in about five seconds")
                assertTrue("audio packets arrived", received.get() > 0)
            }

            // 4. Another display, switched in place — when the PC has another to switch to.
            val readies = negotiations.size
            val showing = negotiations.last().displayId
            val other = displays.firstOrNull { it.id != showing }
            if (other == null) {
                // One display. Asking for the one already shown is not a switch: the PC leaves the stream exactly as
                // it was and answers nothing, and that is what is checked. A real switch needs a second monitor.
                post { stream?.setDisplay(showing) }
                Thread.sleep(5_000)
                Log.i(TAG, "one display: asking for it again changed nothing (new readies ${negotiations.size - readies}, phase ${stream?.phase}, failures $failures)")
                assertEquals(readies, negotiations.size)
                assertEquals(StreamPhase.STREAMING, stream?.phase)
            } else {
                post { stream?.setDisplay(other.id) }
                assertTrue("the PC answered the display switch", waitFor(20_000) { negotiations.size > readies })
                Thread.sleep(1_000)
                Log.i(TAG, "switched to ${negotiations.last()}; phase ${stream?.phase}; failures $failures")
                assertEquals(other.id, negotiations.last().displayId)
                assertEquals(StreamPhase.STREAMING, stream?.phase)
                val back = negotiations.size
                post { stream?.setDisplay(null) }
                assertTrue("the PC switched back to the primary display", waitFor(20_000) { negotiations.size > back })
                Log.i(TAG, "back on ${negotiations.last()}")
            }

            // 5. The clipboard both ways, only when the runner is keeping the PC's clipboard safe.
            if (checkClipboard) {
                val id = Ulid.next()
                val sent = AtomicReference<ClipboardSend?>()
                val done = CountDownLatch(1)
                post {
                    sent.set(stream?.sendClipboard("$PHONE_MARKER $id"))
                    done.countDown()
                }
                assertTrue(done.await(5, TimeUnit.SECONDS))
                assertEquals(ClipboardSend.SENT, sent.get())
                Log.i(TAG, "clipboard: marker $id sent to the PC; waiting for the PC's answer")

                val answered = waitFor(90_000) { clipboard.any { it is ClipboardEvent.Content && it.text == "$PC_MARKER $id" } }
                assertTrue("the PC's clipboard reached the phone (events $clipboard)", answered)
                assertTrue("the PC refused nothing (events $clipboard)", clipboard.none { it is ClipboardEvent.Notice })
                Log.i(TAG, "clipboard: the PC's answer to $id arrived")
            } else {
                Log.i(TAG, "clipboard: not checked; pass wolfLiveClipboard=true with a runner that saves and restores the PC's clipboard")
            }

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

    private fun waitFor(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return true
            Thread.sleep(200)
        }
        return condition()
    }

    private fun statsSummary(text: String): String =
        listOf("state", "fps", "bitrateBps", "packetLossPercent", "keyFramesSent", "degradedReason").joinToString(" ") { field ->
            "$field=" + (Regex("\"$field\":(\"[^\"]*\"|[^,}]*)").find(text)?.groupValues?.get(1) ?: "?")
        }

    private companion object {
        const val TAG = "WolfLiveRemoteExtras"
        const val PHONE_MARKER = "WOLF live clipboard check"
        const val PC_MARKER = "WOLF live clipboard from the PC"
    }
}
