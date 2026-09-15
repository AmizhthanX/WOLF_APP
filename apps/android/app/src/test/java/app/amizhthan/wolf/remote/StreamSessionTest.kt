package app.amizhthan.wolf.remote

import app.amizhthan.wolf.api.WolfJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.Instant

/**
 * The stream's signaling and input, message for message.
 *
 * The relay validates every client message against `packages/protocol`, and the PC acts on what arrives.
 * These tests pin the exact shape of what goes out and when, with the socket, peer connection and timer
 * replaced by recorders — the same approach as the web client's `remote-desktop.test.ts`.
 */
class StreamSessionTest {
    private val sessionId = "01J9ZQK7T0000000000000000S"
    private val pcId = "01J9ZQK7T0000000000000000P"

    private class FakeSocket : SignalingSocket {
        val sent = mutableListOf<JsonObject>()
        var closed = false
        override fun send(text: String): Boolean {
            sent += WolfJson.parseToJsonElement(text).jsonObject
            return true
        }
        override fun close() {
            closed = true
        }
    }

    private class FakePeer : PeerLink {
        val offers = mutableListOf<String>()
        val remoteCandidates = mutableListOf<String>()
        val control = mutableListOf<JsonObject>()
        var channelOpen = true
        var closed = false
        override fun answer(offerSdp: String, onAnswer: (String) -> Unit, onError: (String) -> Unit) {
            offers += offerSdp
            onAnswer("v=0 ANSWER")
        }
        override fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) {
            remoteCandidates += candidate
        }
        override fun sendControl(text: String): Boolean {
            if (!channelOpen) return false
            control += WolfJson.parseToJsonElement(text).jsonObject
            return true
        }
        override fun close() {
            closed = true
        }
    }

    private class FakeScheduler : Scheduler {
        val tasks = mutableListOf<Pair<Long, () -> Unit>>()
        override fun every(periodMs: Long, task: () -> Unit): Cancellable {
            val entry = periodMs to task
            tasks += entry
            return Cancellable { tasks.remove(entry) }
        }
        fun tick() = tasks.toList().forEach { it.second() }
    }

    private class Recorder : StreamListener {
        val phases = mutableListOf<StreamPhase>()
        val failures = mutableListOf<StreamFailure>()
        val negotiations = mutableListOf<Negotiation>()
        val controls = mutableListOf<InputControl>()
        val states = mutableListOf<RemoteState>()
        val refusals = mutableListOf<String>()
        val fileControls = mutableListOf<InputControl>()
        override fun onFileControl(control: InputControl) { fileControls += control }
        override fun onPhase(phase: StreamPhase, detail: String?) { phases += phase }
        override fun onFailure(failure: StreamFailure) { failures += failure }
        override fun onNegotiation(negotiation: Negotiation) { negotiations += negotiation }
        override fun onInputControl(control: InputControl) { controls += control }
        override fun onRemoteState(state: RemoteState) { states += state }
        override fun onInputRefused(reason: String, limitation: Boolean) { refusals += reason }
    }

    private lateinit var socket: FakeSocket
    private lateinit var scheduler: FakeScheduler
    private lateinit var recorder: Recorder
    private val peers = mutableListOf<FakePeer>()
    private lateinit var peerEvents: PeerEvents
    private lateinit var stream: StreamSession

    @Before
    fun setUp() {
        socket = FakeSocket()
        scheduler = FakeScheduler()
        recorder = Recorder()
        stream = StreamSession(
            sessionToken = "session-token",
            iceServers = listOf(IceServerConfig(listOf("stun:stun.example.com:3478"), null, null)),
            profile = StreamProfile.MOBILE_DATA.json,
            clientCodecs = listOf("h264", "vp8"),
            socket = socket,
            peers = { _, events -> peerEvents = events; FakePeer().also { peers += it } },
            scheduler = scheduler,
            listener = recorder,
            h264Profiles = listOf("constrained-baseline"),
            clock = { Instant.parse("2026-09-15T10:00:00.123456Z") },
        )
    }

    private fun accepted(agentConnected: Boolean = true) =
        """{"kind":"cloud.client-auth-accepted","protocolVersion":1,"sessionId":"$sessionId","pcId":"$pcId","capabilities":["screen","input"],"agentConnected":$agentConnected,"serverTime":"2026-09-15T10:00:00Z"}"""

    private fun signal(payload: String, streamId: String = stream.streamId) =
        """{"kind":"cloud.signal","protocolVersion":1,"envelope":{"protocolVersion":1,"sessionId":"$sessionId","streamId":"$streamId","sentAt":"2026-09-15T10:00:00Z","payload":$payload}}"""

    private fun connect() {
        stream.onSocketOpen()
        stream.onSocketMessage(accepted())
        stream.onSocketMessage(signal("""{"type":"sdp.offer","sdp":"v=0 OFFER"}"""))
        peerEvents.onConnected()
        peerEvents.onControlChannelOpen()
    }

    private fun payloads() = socket.sent.filter { it["kind"]!!.jsonPrimitive.content == "client.signal" }
        .map { it["envelope"]!!.jsonObject["payload"]!!.jsonObject }

    private fun types() = payloads().map { it["type"]!!.jsonPrimitive.content }

    private fun grantFiles() = stream.onSocketMessage(
        signal("""{"type":"file.control","granted":true,"holderSessionId":"$sessionId","expiresAt":"2026-09-15T10:10:00Z","reason":"granted"}"""),
    )

    @Test
    fun a_file_request_made_before_the_data_channel_opens_is_sent_when_it_does() {
        // The order the first live run saw: connected, access granted, and the channel still opening.
        stream.onSocketOpen()
        stream.onSocketMessage(accepted())
        stream.onSocketMessage(signal("""{"type":"sdp.offer","sdp":"v=0 OFFER"}"""))
        peerEvents.onConnected()
        grantFiles()
        var result: Result<JsonObject>? = null

        stream.askFiles(FileMessages.list(null)) { result = it }
        assertTrue("nothing is sent into a channel that is not open", peers.single().control.isEmpty())
        assertNull("and it is not refused either", result)

        peerEvents.onControlChannelOpen()
        val sent = peers.single().control.single()
        assertEquals("file.list", sent["kind"]!!.jsonPrimitive.content)

        peerEvents.onControlMessage("""{"kind":"file.listing","requestId":"${sent["requestId"]!!.jsonPrimitive.content}","path":null,"entries":[],"truncated":false}""")
        assertTrue(result!!.isSuccess)
    }

    @Test
    fun a_request_that_timed_out_waiting_for_the_channel_is_not_sent_when_it_opens() {
        stream.onSocketOpen()
        stream.onSocketMessage(accepted())
        stream.onSocketMessage(signal("""{"type":"sdp.offer","sdp":"v=0 OFFER"}"""))
        grantFiles()
        val results = mutableListOf<Result<JsonObject>>()

        stream.askFiles(FileMessages.list(null)) { results += it }
        scheduler.tick()
        peerEvents.onControlChannelOpen()

        assertEquals(1, results.size)
        assertTrue(results.single().isFailure)
        assertTrue(peers.single().control.isEmpty())
    }

    @Test
    fun file_access_is_asked_for_renewed_while_held_and_released() {
        connect()
        stream.requestFiles()
        assertEquals("file.request", types().last())

        grantFiles()
        assertTrue(stream.holdsFiles)
        assertTrue(recorder.fileControls.single().granted)

        scheduler.tick()
        assertEquals(2, types().count { it == "file.request" })

        stream.releaseFiles()
        assertEquals("file.release", types().last())
        assertFalse(stream.holdsFiles)
        scheduler.tick()
        assertEquals("no renewal after releasing", 2, types().count { it == "file.request" })
    }

    @Test
    fun no_file_request_goes_to_the_pc_without_the_lease() {
        connect()
        var result: Result<JsonObject>? = null

        stream.askFiles(FileMessages.list(null)) { result = it }

        assertEquals("not-permitted", (result!!.exceptionOrNull() as FileRefusalException).refusal.reason)
        assertTrue(peers.single().control.isEmpty())
    }

    @Test
    fun file_answers_reach_the_request_that_asked_matched_by_id_not_by_order() {
        connect()
        grantFiles()
        var first: Result<JsonObject>? = null
        var second: Result<JsonObject>? = null

        stream.askFiles(FileMessages.list(null)) { first = it }
        stream.askFiles(FileMessages.stat("C:\\a.txt")) { second = it }
        val sent = peers.single().control
        val firstId = sent[0]["requestId"]!!.jsonPrimitive.content
        val secondId = sent[1]["requestId"]!!.jsonPrimitive.content
        assertTrue(Ulid.PATTERN.matches(firstId))
        assertEquals("file.list", sent[0]["kind"]!!.jsonPrimitive.content)

        peerEvents.onControlMessage("""{"kind":"file.info","requestId":"$secondId","path":"C:\\a.txt","entry":null,"partialBytes":null}""")
        assertNull(first)
        assertEquals("file.info", second!!.getOrThrow()["kind"]!!.jsonPrimitive.content)

        peerEvents.onControlMessage("""{"kind":"file.refused","requestId":"$firstId","reason":"access-denied","detail":"Windows said no.","limitation":true}""")
        val refusal = (first!!.exceptionOrNull() as FileRefusalException).refusal
        assertEquals(FileRefusal("access-denied", "Windows said no.", true), refusal)

        // An answer nobody is waiting for is dropped, not handed to the next request.
        peerEvents.onControlMessage("""{"kind":"file.listing","requestId":"$firstId","path":null,"entries":[],"truncated":false}""")
    }

    @Test
    fun a_file_request_the_pc_never_answers_is_timed_out_once() {
        connect()
        grantFiles()
        val results = mutableListOf<Result<JsonObject>>()

        stream.askFiles(FileMessages.list(null)) { results += it }
        scheduler.tick()
        scheduler.tick()

        assertEquals(1, results.size)
        assertEquals("The PC did not answer in time.", results.single().exceptionOrNull()!!.message)
    }

    @Test
    fun file_requests_waiting_when_the_stream_ends_are_answered_and_the_lease_is_gone() {
        connect()
        grantFiles()
        var result: Result<JsonObject>? = null
        stream.askFiles(FileMessages.list(null)) { result = it }

        stream.stop()

        assertEquals("failed", (result!!.exceptionOrNull() as FileRefusalException).refusal.reason)
        assertFalse(stream.holdsFiles)
    }

    @Test
    fun losing_the_file_lease_stops_renewing_it() {
        connect()
        stream.requestFiles()
        grantFiles()
        stream.onSocketMessage(signal("""{"type":"file.control","granted":false,"holderSessionId":null,"expiresAt":null,"reason":"held-by-another-session"}"""))

        assertFalse(stream.holdsFiles)
        assertEquals("held-by-another-session", recorder.fileControls.last().reason)
        scheduler.tick()
        assertEquals(1, types().count { it == "file.request" })
    }

    @Test
    fun the_socket_is_authenticated_before_anything_else_is_said() {
        stream.onSocketOpen()

        assertEquals(1, socket.sent.size)
        val auth = socket.sent.single()
        assertEquals("client.auth", auth["kind"]!!.jsonPrimitive.content)
        assertEquals(1, auth["protocolVersion"]!!.jsonPrimitive.content.toInt())
        assertEquals("session-token", auth["sessionToken"]!!.jsonPrimitive.content)
    }

    @Test
    fun once_accepted_the_stream_is_requested_with_a_whole_profile_and_what_the_phone_can_decode() {
        stream.onSocketOpen()
        stream.onSocketMessage(accepted())

        val message = socket.sent.last()
        val envelope = message["envelope"]!!.jsonObject
        assertEquals("client.signal", message["kind"]!!.jsonPrimitive.content)
        assertEquals(sessionId, envelope["sessionId"]!!.jsonPrimitive.content)
        assertTrue("stream ids are WOLF identifiers", Ulid.PATTERN.matches(envelope["streamId"]!!.jsonPrimitive.content))
        assertEquals("2026-09-15T10:00:00.123Z", envelope["sentAt"]!!.jsonPrimitive.content)

        val request = envelope["payload"]!!.jsonObject["request"]!!.jsonObject
        assertEquals(JsonNull, request["displayId"])
        assertEquals(listOf("h264", "vp8"), request["clientCodecs"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertEquals("false", request["requestAudio"].toString())
        assertEquals(listOf("constrained-baseline"), request["h264Profiles"]!!.jsonArray.map { it.jsonPrimitive.content })

        val profile = request["profile"]!!.jsonObject
        // Every field of `remoteDesktopProfile`, because the agent reads every field.
        assertEquals(
            setOf("name", "maxWidthPixels", "maxHeightPixels", "targetFps", "minBitrateBps", "maxBitrateBps", "codecPreference", "audioEnabled", "qualityBias", "adaptive", "overrides"),
            profile.keys,
        )
        assertEquals(setOf("bitrateBps", "frameRate", "resolutionScale"), profile["overrides"]!!.jsonObject.keys)
        assertEquals(StreamPhase.REQUESTING, stream.phase)
    }

    @Test
    fun a_pc_whose_agent_is_away_is_said_so_and_nothing_is_requested() {
        stream.onSocketOpen()
        stream.onSocketMessage(accepted(agentConnected = false))

        assertEquals("agent-offline", recorder.failures.single().code)
        assertTrue(recorder.failures.single().retryable)
        assertTrue(types().isEmpty())
        assertTrue(socket.closed)
        assertEquals(StreamPhase.FAILED, stream.phase)
    }

    @Test
    fun a_rejected_session_is_a_failure_with_the_relay_reason() {
        stream.onSocketOpen()
        stream.onSocketMessage("""{"kind":"cloud.client-auth-rejected","protocolVersion":1,"reason":"capability-missing","detail":"This session does not hold screen."}""")

        val failure = recorder.failures.single()
        assertEquals("capability-missing", failure.code)
        assertFalse(failure.retryable)
    }

    @Test
    fun the_pc_offers_and_the_phone_answers_trading_candidates_both_ways() {
        stream.onSocketOpen()
        stream.onSocketMessage(accepted())
        stream.onSocketMessage(signal("""{"type":"stream.ready","negotiation":{"streamId":"${stream.streamId}","display":{"id":"d1","name":"DELL U2723QE","widthPixels":2560,"heightPixels":1440,"refreshHz":60,"primary":true,"scaleFactor":1.5,"hdr":false,"originX":0,"originY":0},"videoCodec":"h264","hardwareEncoded":true,"audioCodec":null,"effectiveProfile":{},"adjustments":[],"startedAt":"2026-09-15T10:00:00Z"}}"""))
        stream.onSocketMessage(signal("""{"type":"sdp.offer","sdp":"v=0 OFFER"}"""))
        stream.onSocketMessage(signal("""{"type":"ice.candidate","candidate":"candidate:1 1 udp 2122260223 192.168.1.20 50000 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":null}"""))

        assertEquals(Negotiation("DELL U2723QE", 2560, 1440, "h264", true), recorder.negotiations.single())
        assertEquals(listOf("v=0 OFFER"), peers.single().offers)
        assertEquals(1, peers.single().remoteCandidates.size)

        val answer = payloads().single { it["type"]!!.jsonPrimitive.content == "sdp.answer" }
        assertEquals("v=0 ANSWER", answer["sdp"]!!.jsonPrimitive.content)

        peerEvents.onLocalCandidate("candidate:2 1 udp 1 10.0.2.16 40000 typ host", null, null)
        peerEvents.onLocalCandidatesComplete()
        val local = payloads().single { it["type"]!!.jsonPrimitive.content == "ice.candidate" }
        assertEquals(JsonNull, local["sdpMid"])
        assertEquals(JsonNull, local["sdpMLineIndex"])
        assertEquals("ice.complete", types().last())

        peerEvents.onConnected()
        assertEquals(StreamPhase.STREAMING, stream.phase)
    }

    @Test
    fun an_answer_that_declines_video_is_not_sent_and_the_phone_says_why() {
        // What the first real stream did: the PC offered High-profile H.264, and libwebrtc on the phone
        // answered with the video section rejected. The PC refused that with a generic error.
        val declining = StreamSession(
            sessionToken = "session-token",
            iceServers = emptyList(),
            profile = StreamProfile.WIFI.json,
            clientCodecs = listOf("h264"),
            socket = socket,
            peers = { _, events ->
                peerEvents = events
                object : PeerLink {
                    override fun answer(offerSdp: String, onAnswer: (String) -> Unit, onError: (String) -> Unit) =
                        onAnswer("v=0\r\nm=video 0 UDP/TLS/RTP/SAVP 0\r\n")
                    override fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) = Unit
                    override fun sendControl(text: String) = false
                    override fun close() = Unit
                }
            },
            scheduler = scheduler,
            listener = recorder,
        )
        val offer = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVP 96\r\na=rtpmap:96 H264/90000\r\na=fmtp:96 packetization-mode=1;level-asymmetry-allowed=1;profile-level-id=640033\r\n"

        declining.onSocketOpen()
        declining.onSocketMessage(accepted())
        declining.onSocketMessage(
            """{"kind":"cloud.signal","protocolVersion":1,"envelope":{"protocolVersion":1,"sessionId":"$sessionId","streamId":"${declining.streamId}","sentAt":"2026-09-15T10:00:00Z","payload":{"type":"sdp.offer","sdp":${WolfJson.encodeToString(kotlinx.serialization.json.JsonPrimitive.serializer(), kotlinx.serialization.json.JsonPrimitive(offer))}}}}""",
        )

        val failure = recorder.failures.single()
        assertEquals("codec-unsupported", failure.code)
        assertEquals("The PC sends H.264 (High profile, level 5.1), and this phone cannot decode it.", failure.message)
        assertTrue("no doomed answer went to the PC", types().none { it == "sdp.answer" })
    }

    @Test
    fun offered_video_is_described_in_words() {
        assertEquals("H.264 (Baseline profile, level 3.1)", Sdp.describeOfferedVideo("a=rtpmap:96 H264/90000\na=fmtp:96 profile-level-id=42e01f"))
        assertEquals("VP8", Sdp.describeOfferedVideo("a=rtpmap:97 VP8/90000"))
        assertTrue(Sdp.rejectsVideo("m=video 0 UDP/TLS/RTP/SAVP 0"))
        assertFalse(Sdp.rejectsVideo("m=video 9 UDP/TLS/RTP/SAVP 96"))
    }

    @Test
    fun signaling_for_another_stream_is_not_this_one_to_act_on() {
        stream.onSocketOpen()
        stream.onSocketMessage(accepted())
        stream.onSocketMessage(signal("""{"type":"sdp.offer","sdp":"v=0 NOT-OURS"}""", streamId = Ulid.next()))

        assertTrue(peers.isEmpty())
    }

    @Test
    fun no_input_is_sent_without_control() {
        connect()

        assertFalse(stream.sendInput(InputEvents.tap(NormalizedPoint(0.5, 0.5))))
        assertTrue(peers.single().control.isEmpty())
    }

    @Test
    fun with_control_input_goes_on_the_data_channel_in_sequence_and_a_burst_is_split_not_cut() {
        connect()
        stream.requestControl()
        stream.onSocketMessage(signal("""{"type":"input.control","granted":true,"holderSessionId":"$sessionId","expiresAt":"2026-09-15T10:02:00Z","reason":"granted"}"""))

        assertTrue(stream.sendInput(InputEvents.tap(NormalizedPoint(0.25, 0.75))))
        val burst = List(200) { InputEvents.move(NormalizedPoint(0.5, 0.5)) }
        assertTrue(stream.sendInput(burst))

        val batches = peers.single().control
        assertEquals(listOf("input", "input", "input"), batches.map { it["kind"]!!.jsonPrimitive.content })
        assertEquals(listOf(0L, 1L, 2L), batches.map { it["batch"]!!.jsonObject["sequence"]!!.jsonPrimitive.long })
        assertEquals(listOf(3, 128, 72), batches.map { it["batch"]!!.jsonObject["events"]!!.jsonArray.size })
        assertEquals(stream.streamId, batches.first()["batch"]!!.jsonObject["streamId"]!!.jsonPrimitive.content)
    }

    @Test
    fun control_is_renewed_while_held_and_stops_when_it_is_taken_away() {
        connect()
        stream.requestControl()
        stream.onSocketMessage(signal("""{"type":"input.control","granted":true,"holderSessionId":"$sessionId","expiresAt":null,"reason":"granted"}"""))

        assertEquals(StreamSession.RENEW_INTERVAL_MS, scheduler.tasks.single().first)
        scheduler.tick()
        assertEquals(2, types().count { it == "input.request" })

        stream.onSocketMessage(signal("""{"type":"input.control","granted":false,"holderSessionId":"01J9ZQK7T0000000000000000X","expiresAt":null,"reason":"held-by-another-session"}"""))
        assertTrue("the renewal stops with the grant", scheduler.tasks.isEmpty())
        assertEquals("held-by-another-session", recorder.controls.last().reason)
        assertFalse(stream.sendInput(InputEvents.tap(NormalizedPoint(0.5, 0.5))))
    }

    @Test
    fun releasing_stops_input_at_once_and_tells_the_cloud() {
        connect()
        stream.requestControl()
        stream.onSocketMessage(signal("""{"type":"input.control","granted":true,"holderSessionId":"$sessionId","expiresAt":null,"reason":"granted"}"""))

        stream.releaseControl()

        assertEquals("input.release", types().last())
        assertFalse(stream.sendInput(InputEvents.tap(NormalizedPoint(0.5, 0.5))))
    }

    @Test
    fun a_refusal_from_the_pc_is_reported() {
        connect()
        peerEvents.onControlMessage("""{"kind":"input.response","response":{"streamId":"${stream.streamId}","sequence":0,"outcome":"not-permitted","reason":"The secure desktop refuses injected input.","limitation":true}}""")
        // Clipboard content from the PC is neither shown nor kept.
        peerEvents.onControlMessage("""{"kind":"clipboard.content","streamId":"${stream.streamId}","format":"text","text":"secret","origin":"pc","at":"2026-09-15T10:00:00Z"}""")

        assertEquals(listOf("The secure desktop refuses injected input."), recorder.refusals)
    }

    @Test
    fun stopping_says_so_closes_everything_and_ignores_what_arrives_after() {
        connect()
        stream.stop()

        val stop = payloads().last()
        assertEquals("stream.stop", stop["type"]!!.jsonPrimitive.content)
        assertEquals("client-closed", stop["reason"]!!.jsonPrimitive.content)
        assertTrue(peers.single().closed)
        assertTrue(socket.closed)
        assertEquals(StreamPhase.STOPPED, stream.phase)

        val sentBefore = socket.sent.size
        stream.onSocketMessage(signal("""{"type":"sdp.offer","sdp":"v=0 LATE"}"""))
        stream.requestControl()
        assertEquals(sentBefore, socket.sent.size)
        assertEquals(1, peers.size)
    }

    @Test
    fun a_failed_connection_says_what_would_fix_it_and_a_drop_is_reconnecting() {
        connect()
        peerEvents.onDisconnected()
        assertEquals(StreamPhase.RECONNECTING, stream.phase)

        peerEvents.onFailed()
        assertEquals("ice-failed", recorder.failures.single().code)
        assertTrue(recorder.failures.single().recommendedAction.contains("TURN"))
    }

    @Test
    fun a_stream_error_from_the_pc_carries_its_own_advice_or_names_a_windows_limitation() {
        stream.onSocketOpen()
        stream.onSocketMessage(accepted())
        stream.onSocketMessage(signal("""{"type":"stream.error","code":"capture-denied","message":"Windows would not share the screen.","limitation":true,"recommendedAction":null}"""))

        val failure = recorder.failures.single()
        assertEquals("capture-denied", failure.code)
        assertTrue(failure.recommendedAction.contains("Windows limitation"))
        assertNull(stream.let { null })
    }
}
