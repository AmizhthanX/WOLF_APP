package app.amizhthan.wolf.remote

import app.amizhthan.wolf.api.WolfJson
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.time.temporal.ChronoUnit

data class IceServerConfig(val urls: List<String>, val username: String?, val credential: String?)

fun interface Cancellable {
    fun cancel()
}

fun interface Scheduler {
    fun every(periodMs: Long, task: () -> Unit): Cancellable
}

/** The WebSocket to the realtime relay. */
interface SignalingSocket {
    fun send(text: String): Boolean
    fun close()
}

/** What the peer connection reports back. */
interface PeerEvents {
    fun onLocalCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?)
    fun onLocalCandidatesComplete()
    fun onControlMessage(text: String)

    /** The data channel the PC opened is ready to carry messages. It can open after the connection itself. */
    fun onControlChannelOpen()
    fun onConnected()
    fun onDisconnected()
    fun onFailed()
}

/** The peer connection, as the state machine needs it. */
interface PeerLink {
    fun answer(offerSdp: String, onAnswer: (String) -> Unit, onError: (String) -> Unit)
    fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?)
    /** False when the data channel is not open. */
    fun sendControl(text: String): Boolean
    fun close()
}

fun interface PeerFactory {
    fun create(iceServers: List<IceServerConfig>, events: PeerEvents): PeerLink
}

enum class StreamPhase { IDLE, AUTHENTICATING, REQUESTING, NEGOTIATING, CONNECTING, STREAMING, RECONNECTING, FAILED, STOPPED }

data class StreamFailure(val code: String, val message: String, val retryable: Boolean, val recommendedAction: String)

data class Negotiation(val displayName: String, val widthPixels: Int, val heightPixels: Int, val videoCodec: String, val hardwareEncoded: Boolean)

data class InputControl(val granted: Boolean, val reason: String?, val expiresAt: String?)

data class RemoteState(val state: String, val unavailableReason: String?, val detail: String?, val showing: String)

interface StreamListener {
    fun onPhase(phase: StreamPhase, detail: String?)
    fun onFailure(failure: StreamFailure)
    fun onNegotiation(negotiation: Negotiation)
    fun onInputControl(control: InputControl)
    fun onRemoteState(state: RemoteState)
    fun onInputRefused(reason: String, limitation: Boolean)

    /** Who holds this PC's files, as the cloud last decided. */
    fun onFileControl(control: InputControl) {}
}

/**
 * One remote desktop stream: the signaling, the peer connection's lifecycle, and input.
 *
 * The phone's port of `apps/web/lib/remote-desktop.ts`, message for message, kept free of Android and of
 * WebRTC itself so every message it sends can be tested on the JVM. The socket, the peer connection and
 * the timer are handed in.
 *
 * **Not thread-safe by design.** Every call — socket callbacks, peer callbacks, the owner's taps — must
 * arrive on one thread. The Android controller runs it on a single-threaded executor, which makes the
 * ordering of signaling messages the ordering they arrived in.
 *
 * - The socket is authenticated with the session token before anything else is sent; the relay closes a
 *   socket that speaks first.
 * - The PC offers; the phone answers. The PC knows which encoder it has, so its offer describes reality.
 * - The data channel is opened by the PC as part of its offer and received here, never created here.
 * - Input goes on that channel, straight to the PC, and only while the cloud says this session holds
 *   control. The request is renewed on a timer, because the grant expires: a phone put in a pocket stops
 *   holding somebody's keyboard.
 */
class StreamSession(
    private val sessionToken: String,
    private val iceServers: List<IceServerConfig>,
    private val profile: JsonObject,
    private val clientCodecs: List<String>,
    private val socket: SignalingSocket,
    private val peers: PeerFactory,
    private val scheduler: Scheduler,
    private val listener: StreamListener,
    /** H.264 profiles the phone's decoders accept; empty means not stated. */
    private val h264Profiles: List<String> = emptyList(),
    val streamId: String = Ulid.next(),
    private val clock: () -> Instant = Instant::now,
) : PeerEvents {

    var phase: StreamPhase = StreamPhase.IDLE
        private set

    private var sessionId: String? = null
    private var peer: PeerLink? = null
    private var hasControl = false
    private var renewal: Cancellable? = null
    private var sequence = 0L
    private var closed = false
    private var hasFiles = false
    private var fileRenewal: Cancellable? = null
    private var channelOpen = false

    /** File requests asked for before the data channel opened, by request id, sent once it does. */
    private val unsentFiles = ArrayDeque<Pair<String, String>>()

    private class PendingFile(val reply: (Result<JsonObject>) -> Unit, val timeout: Cancellable)

    /**
     * File requests waiting for their answer, by request id. Correlated by id rather than by order, because
     * a browse and a transfer chunk can be in flight together.
     */
    private val pendingFiles = LinkedHashMap<String, PendingFile>()

    val holdsControl: Boolean get() = hasControl

    val holdsFiles: Boolean get() = hasFiles

    /**
     * Ask to be allowed at this PC's files: its own lease, asked for separately, because watching a screen is
     * not being handed the disks behind it. Renewed while held, like control.
     */
    fun requestFiles() {
        if (closed) return
        signal(buildJsonObject { put("type", "file.request") })
        if (fileRenewal == null) {
            fileRenewal = scheduler.every(RENEW_INTERVAL_MS) {
                if (hasFiles && !closed) signal(buildJsonObject { put("type", "file.request") })
            }
        }
    }

    fun releaseFiles() {
        stopRenewingFiles()
        hasFiles = false
        signal(buildJsonObject { put("type", "file.release") })
    }

    /**
     * Send one file request on the data channel and hand [reply] the answer with the matching id.
     *
     * Always answered exactly once: the PC's answer, the PC's refusal, a timeout, or the stream ending. A
     * request left unanswered would be a file manager showing a spinner until the app is closed. Nothing is
     * sent without the file lease.
     */
    fun askFiles(message: JsonObject, reply: (Result<JsonObject>) -> Unit) {
        if (closed) return reply(Result.failure(fileFailure("failed", "The connection to this PC ended.")))
        if (!hasFiles) return reply(Result.failure(fileFailure("not-permitted", "This session does not hold this PC's files.")))
        val link = peer ?: return reply(Result.failure(fileFailure("failed", "The connection to this PC is not ready.")))

        val requestId = Ulid.next()
        lateinit var timeout: Cancellable
        timeout = scheduler.every(FILE_REPLY_TIMEOUT_MS) {
            timeout.cancel()
            pendingFiles.remove(requestId)?.reply?.invoke(Result.failure(fileFailure("failed", "The PC did not answer in time.")))
        }
        pendingFiles[requestId] = PendingFile(reply, timeout)
        val text = JsonObject(message + ("requestId" to JsonPrimitive(requestId))).toString()

        // The lease can be granted before the PC's data channel has finished opening. Found by the first live
        // run: the stream was connected, access granted, and the channel still opening. The request waits for
        // the channel, bounded by its timeout, rather than failing as though the PC had refused it.
        if (!channelOpen) {
            unsentFiles.addLast(requestId to text)
            return
        }
        sendFile(link, requestId, text)
    }

    override fun onControlChannelOpen() {
        if (closed) return
        channelOpen = true
        val link = peer ?: return
        while (unsentFiles.isNotEmpty()) {
            val (requestId, text) = unsentFiles.removeFirst()
            // One that timed out while waiting has already been answered.
            if (pendingFiles.containsKey(requestId)) sendFile(link, requestId, text)
        }
    }

    private fun sendFile(link: PeerLink, requestId: String, text: String) {
        if (!link.sendControl(text)) {
            settleFile(requestId, Result.failure(fileFailure("failed", "The connection to this PC is not ready.")))
        }
    }

    fun onSocketOpen() {
        if (closed) return
        setPhase(StreamPhase.AUTHENTICATING, null)
        socket.send(
            buildJsonObject {
                put("kind", "client.auth")
                put("protocolVersion", PROTOCOL_VERSION)
                put("sessionToken", sessionToken)
            }.toString(),
        )
    }

    fun onSocketMessage(text: String) {
        if (closed) return
        val message = runCatching { WolfJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return

        when (message.str("kind")) {
            "cloud.client-auth-accepted" -> {
                sessionId = message.str("sessionId")
                if (message["agentConnected"].bool() == false) {
                    fail("agent-offline", "This PC is not connected to WOLF right now.", retryable = true, "Start the remote desktop again once the PC is back online.")
                    return
                }
                setPhase(StreamPhase.REQUESTING, null)
                signal(
                    buildJsonObject {
                        put("type", "stream.request")
                        putJsonObject("request") {
                            put("displayId", JsonNull)
                            put("profile", profile)
                            put("clientCodecs", JsonArray(clientCodecs.map(::JsonPrimitive)))
                            put("requestAudio", false)
                            put("h264Profiles", JsonArray(h264Profiles.map(::JsonPrimitive)))
                        }
                    },
                )
            }

            "cloud.client-auth-rejected" -> fail(
                message.str("reason") ?: "rejected",
                message.str("detail") ?: "WOLF refused the streaming session.",
                retryable = false,
                "Go back and open the remote desktop again to start a new session.",
            )

            "cloud.peer-gone" -> fail(
                message.str("reason") ?: "peer-gone",
                message.str("detail") ?: "The PC stopped responding.",
                retryable = true,
                "The stream can be started again once the PC is back.",
            )

            "cloud.signal" -> {
                val envelope = message.obj("envelope") ?: return
                // Signaling for another stream in the same session is not this stream's to act on.
                if (envelope.str("streamId") != streamId) return
                handleSignal(envelope.obj("payload") ?: return)
            }
        }
    }

    fun onSocketClosed(reason: String?) {
        if (closed) return
        fail("socket-closed", "The connection to WOLF closed${reason?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: "."}", retryable = true, "Start the remote desktop again.")
    }

    /** Ask for keyboard and mouse. The cloud decides; nothing here assumes the answer. */
    fun requestControl() {
        if (closed) return
        signal(buildJsonObject { put("type", "input.request") })
        if (renewal == null) {
            renewal = scheduler.every(RENEW_INTERVAL_MS) {
                if (hasControl && !closed) signal(buildJsonObject { put("type", "input.request") })
            }
        }
    }

    fun releaseControl() {
        stopRenewing()
        // Stop sending at once rather than waiting for the cloud to confirm the release.
        hasControl = false
        signal(buildJsonObject { put("type", "input.release") })
    }

    /**
     * Send input to the PC on the data channel. Nothing is sent without control.
     *
     * A burst larger than one batch is split rather than cut: a dropped key-up leaves a key held down.
     */
    fun sendInput(events: List<JsonObject>): Boolean {
        if (events.isEmpty() || !hasControl || closed) return false
        val link = peer ?: return false

        for (chunk in events.chunked(InputEvents.MAX_EVENTS_PER_BATCH)) {
            val batch = buildJsonObject {
                put("kind", "input")
                putJsonObject("batch") {
                    put("streamId", streamId)
                    put("sequence", sequence)
                    put("sentAt", timestamp())
                    put("events", JsonArray(chunk))
                }
            }
            if (!link.sendControl(batch.toString())) return false
            sequence += 1
        }
        return true
    }

    fun stop() {
        if (closed) return
        signal(
            buildJsonObject {
                put("type", "stream.stop")
                put("reason", "client-closed")
                put("detail", JsonNull)
            },
        )
        teardown()
        socket.close()
        setPhase(StreamPhase.STOPPED, null)
    }

    private fun handleSignal(payload: JsonObject) {
        when (payload.str("type")) {
            "stream.ready" -> {
                val negotiation = payload.obj("negotiation")
                val display = negotiation.obj("display")
                if (negotiation != null) {
                    listener.onNegotiation(
                        Negotiation(
                            displayName = display.str("name") ?: "Display",
                            widthPixels = display.int("widthPixels"),
                            heightPixels = display.int("heightPixels"),
                            videoCodec = negotiation.str("videoCodec") ?: "unknown",
                            hardwareEncoded = negotiation["hardwareEncoded"].bool() ?: false,
                        ),
                    )
                }
                setPhase(StreamPhase.NEGOTIATING, null)
            }

            "sdp.offer" -> answer(payload.str("sdp") ?: return)

            "ice.candidate" -> peer?.addRemoteCandidate(
                payload.str("candidate") ?: return,
                payload.str("sdpMid"),
                (payload["sdpMLineIndex"] as? JsonPrimitive)?.intOrNull,
            )

            "ice.complete" -> Unit

            "input.control" -> {
                hasControl = payload["granted"].bool() == true
                if (!hasControl) stopRenewing()
                listener.onInputControl(InputControl(hasControl, payload.str("reason"), payload.str("expiresAt")))
            }

            "file.control" -> {
                hasFiles = payload["granted"].bool() == true
                if (!hasFiles) stopRenewingFiles()
                listener.onFileControl(InputControl(hasFiles, payload.str("reason"), payload.str("expiresAt")))
            }

            "stream.state" -> listener.onRemoteState(
                RemoteState(
                    state = payload.str("state") ?: "unknown",
                    unavailableReason = payload.str("unavailableReason"),
                    detail = payload.str("detail"),
                    // Absent from an agent that predates the field, which can only be showing the desktop.
                    showing = if (payload.str("showing") == "secure-desktop") "secure-desktop" else "desktop",
                ),
            )

            "stream.error" -> {
                val limitation = payload["limitation"].bool() == true
                fail(
                    payload.str("code") ?: "stream-error",
                    payload.str("message") ?: "The PC could not stream.",
                    retryable = false,
                    payload.str("recommendedAction")
                        ?: if (limitation) "This is a Windows limitation on that PC rather than a WOLF fault." else "Start the remote desktop again.",
                )
            }

            "stream.stop" -> {
                teardown()
                socket.close()
                setPhase(StreamPhase.STOPPED, payload.str("detail") ?: payload.str("reason"))
            }
        }
    }

    private fun answer(sdp: String) {
        setPhase(StreamPhase.CONNECTING, null)
        // A new peer brings a new data channel, which is not open until it says so.
        channelOpen = false
        peer?.close()

        val link = peers.create(iceServers, this)
        peer = link
        link.answer(
            sdp,
            onAnswer = { answerSdp ->
                if (!closed && peer === link && Sdp.rejectsVideo(answerSdp)) {
                    // The phone's own stack declined every video format in the offer. Sending that answer
                    // would only have the PC refuse it with a generic error; saying why is more use.
                    fail(
                        "codec-unsupported",
                        "The PC sends ${Sdp.describeOfferedVideo(sdp)}, and this phone cannot decode it.",
                        retryable = false,
                        "Use a phone whose hardware decodes that format, or view this PC from the web dashboard.",
                    )
                } else if (!closed && peer === link) {
                    signal(
                        buildJsonObject {
                            put("type", "sdp.answer")
                            put("sdp", answerSdp)
                        },
                    )
                }
            },
            onError = { error ->
                fail("negotiation-failed", "The phone could not accept the PC's stream: $error", retryable = false, "Start the remote desktop again.")
            },
        )
    }

    override fun onLocalCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) {
        signal(
            buildJsonObject {
                put("type", "ice.candidate")
                put("candidate", candidate)
                put("sdpMid", sdpMid?.let(::JsonPrimitive) ?: JsonNull)
                put("sdpMLineIndex", sdpMLineIndex?.let(::JsonPrimitive) ?: JsonNull)
                put("usernameFragment", JsonNull)
            },
        )
    }

    override fun onLocalCandidatesComplete() {
        signal(buildJsonObject { put("type", "ice.complete") })
    }

    /**
     * Whatever the PC sent back on the data channel, discriminated on `kind`.
     *
     * Clipboard content from the PC is ignored: the phone does not offer clipboard sync, so it neither
     * shows nor keeps what was copied there.
     */
    override fun onControlMessage(text: String) {
        if (closed) return
        val message = runCatching { WolfJson.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        when (message.str("kind")) {
            "input.response" -> {
                val response = message.obj("response") ?: return
                listener.onInputRefused(response.str("reason") ?: "The PC refused that input.", response["limitation"].bool() == true)
            }
            // Handed to whoever asked and nowhere else; nothing here keeps a listing or a chunk.
            "file.listing", "file.info", "file.chunk", "file.written" -> settleFile(message.str("requestId"), Result.success(message))
            "file.refused" -> settleFile(message.str("requestId"), Result.failure(FileRefusalException(FileMessages.refusal(message))))
        }
    }

    private fun settleFile(requestId: String?, result: Result<JsonObject>) {
        val pending = pendingFiles.remove(requestId ?: return) ?: return
        pending.timeout.cancel()
        pending.reply(result)
    }

    private fun fileFailure(reason: String, detail: String) = FileRefusalException(FileRefusal(reason, detail, false))

    override fun onConnected() {
        if (!closed) setPhase(StreamPhase.STREAMING, null)
    }

    override fun onDisconnected() {
        if (!closed) setPhase(StreamPhase.RECONNECTING, "The connection to the PC dropped.")
    }

    override fun onFailed() {
        fail(
            "ice-failed",
            "The direct connection to this PC could not be established.",
            retryable = false,
            "On a different network this needs a TURN relay; configure one and try again.",
        )
    }

    private fun signal(payload: JsonObject) {
        val session = sessionId ?: return
        if (closed) return
        socket.send(
            buildJsonObject {
                put("kind", "client.signal")
                put("protocolVersion", PROTOCOL_VERSION)
                putJsonObject("envelope") {
                    put("protocolVersion", PROTOCOL_VERSION)
                    put("sessionId", session)
                    put("streamId", streamId)
                    put("sentAt", timestamp())
                    put("payload", payload)
                }
            }.toString(),
        )
    }

    private fun fail(code: String, message: String, retryable: Boolean, recommendedAction: String) {
        if (closed) return
        teardown()
        socket.close()
        listener.onFailure(StreamFailure(code, message, retryable, recommendedAction))
        setPhase(StreamPhase.FAILED, message)
    }

    private fun teardown() {
        closed = true
        stopRenewing()
        stopRenewingFiles()
        hasControl = false
        hasFiles = false
        channelOpen = false
        unsentFiles.clear()
        peer?.close()
        peer = null

        // Nothing is coming back for these; left waiting they would never be answered.
        val waiting = pendingFiles.values.toList()
        pendingFiles.clear()
        waiting.forEach {
            it.timeout.cancel()
            it.reply(Result.failure(fileFailure("failed", "The connection to this PC ended.")))
        }
    }

    private fun stopRenewing() {
        renewal?.cancel()
        renewal = null
    }

    private fun stopRenewingFiles() {
        fileRenewal?.cancel()
        fileRenewal = null
    }

    private fun setPhase(next: StreamPhase, detail: String?) {
        phase = next
        listener.onPhase(next, detail)
    }

    private fun timestamp(): String = clock().truncatedTo(ChronoUnit.MILLIS).toString()

    companion object {
        const val PROTOCOL_VERSION = 1

        /** The web client's renewal period; the lease the cloud grants outlasts it. */
        const val RENEW_INTERVAL_MS = 45_000L

        /** A file answer is one chunk read or written; far longer than that means the PC is not answering. */
        const val FILE_REPLY_TIMEOUT_MS = 30_000L
    }
}

/** Just enough SDP reading to explain a failed negotiation. Nothing here builds or edits SDP. */
object Sdp {
    /** True when the answer declines video: an `m=video` line with port 0. */
    fun rejectsVideo(answer: String): Boolean = answer.lines().any { it.trim().startsWith("m=video 0 ") }

    /** The offered video codec in words, e.g. "H.264 (High profile, level 5.1)". */
    fun describeOfferedVideo(offer: String): String {
        val lines = offer.lines().map { it.trim() }
        val rtpmap = lines.firstOrNull { it.startsWith("a=rtpmap:") && it.contains("/90000") } ?: return "a video format"
        val payload = rtpmap.removePrefix("a=rtpmap:").substringBefore(' ')
        val codec = rtpmap.substringAfter(' ').substringBefore('/')
        if (!codec.equals("H264", ignoreCase = true)) return codec

        val profileLevel = lines.firstOrNull { it.startsWith("a=fmtp:$payload ") }
            ?.substringAfter("profile-level-id=", "")
            ?.take(6)
            ?.takeIf { it.length == 6 }
            ?: return "H.264"

        val profile = when (profileLevel.substring(0, 2).lowercase()) {
            "42" -> "Baseline"
            "4d" -> "Main"
            "58" -> "Extended"
            "64" -> "High"
            "6e" -> "High 10"
            "7a" -> "High 4:2:2"
            "f4" -> "High 4:4:4"
            else -> "profile ${profileLevel.substring(0, 2)}"
        }
        val level = profileLevel.substring(4, 6).toIntOrNull(16)?.let { "level ${it / 10}.${it % 10}" }
        return "H.264 ($profile profile${level?.let { ", $it" } ?: ""})"
    }
}

private fun JsonObject?.str(key: String): String? = (this?.get(key) as? JsonPrimitive)?.contentOrNull

private fun JsonObject?.int(key: String): Int = (this?.get(key) as? JsonPrimitive)?.intOrNull ?: 0

private fun JsonObject?.obj(key: String): JsonObject? = this?.get(key) as? JsonObject

private fun kotlinx.serialization.json.JsonElement?.bool(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull
