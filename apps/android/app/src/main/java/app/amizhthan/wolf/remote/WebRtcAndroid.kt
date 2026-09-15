package app.amizhthan.wolf.remote

import android.content.Context
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.VideoTrack
import java.nio.ByteBuffer

/**
 * libwebrtc, created once per process.
 *
 * Decoding is hardware where the phone's MediaCodec offers it. There is no microphone and no camera: the
 * phone receives a PC's screen and sends nothing but input on the data channel.
 */
class WebRtc private constructor(context: Context) {
    val egl: EglBase = EglBase.create()
    private val decoders = DefaultVideoDecoderFactory(egl.eglBaseContext)

    val factory: PeerConnectionFactory = PeerConnectionFactory.builder()
        .setVideoDecoderFactory(decoders)
        .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, true))
        .createPeerConnectionFactory()

    val decoderCodecNames: List<String> = decoders.supportedCodecs.map { it.name }

    /** `profile-level-id` of every H.264 decoder the factory reports. */
    val h264ProfileLevelIds: List<String> = decoders.supportedCodecs
        .filter { it.name.equals("H264", ignoreCase = true) }
        .mapNotNull { it.params["profile-level-id"] }

    /** Each decoder with its parameters — for H.264, the profiles it actually accepts. */
    val decoderCodecDescriptions: List<String> = decoders.supportedCodecs.map { "${it.name}${it.params}" }

    companion object {
        @Volatile
        private var instance: WebRtc? = null

        fun get(context: Context): WebRtc = instance ?: synchronized(this) {
            instance ?: run {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
                )
                WebRtc(context.applicationContext).also { instance = it }
            }
        }
    }
}

/** A peer connection that answers. Every callback is posted back to the stream's thread. */
class WebRtcPeerFactory(
    private val rtc: WebRtc,
    private val post: (() -> Unit) -> Unit,
    private val onVideoTrack: (VideoTrack) -> Unit,
) : PeerFactory {

    override fun create(iceServers: List<IceServerConfig>, events: PeerEvents): PeerLink {
        val servers = iceServers.map { server ->
            PeerConnection.IceServer.builder(server.urls).apply {
                server.username?.let { setUsername(it) }
                server.credential?.let { setPassword(it) }
            }.createIceServer()
        }

        val configuration = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // "all" so a host candidate can win on a LAN. Forcing relay is a diagnostic.
            iceTransportsType = PeerConnection.IceTransportsType.ALL
        }

        val holder = arrayOfNulls<Link>(1)
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
            override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) post { events.onLocalCandidatesComplete() }
            }
            override fun onIceCandidate(candidate: IceCandidate) {
                post { events.onLocalCandidate(candidate.sdp, candidate.sdpMid, candidate.sdpMLineIndex) }
            }
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
            override fun onAddStream(stream: MediaStream) = Unit
            override fun onRemoveStream(stream: MediaStream) = Unit
            override fun onDataChannel(channel: DataChannel) {
                holder[0]?.adopt(channel, events)
            }
            override fun onRenegotiationNeeded() = Unit
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {
                (receiver.track() as? VideoTrack)?.let { track -> post { onVideoTrack(track) } }
            }
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
                post {
                    when (state) {
                        PeerConnection.PeerConnectionState.CONNECTED -> events.onConnected()
                        PeerConnection.PeerConnectionState.DISCONNECTED -> events.onDisconnected()
                        PeerConnection.PeerConnectionState.FAILED -> events.onFailed()
                        else -> Unit
                    }
                }
            }
        }

        val connection = rtc.factory.createPeerConnection(configuration, observer)
            ?: error("WebRTC refused to create a peer connection.")
        return Link(connection, post).also { holder[0] = it }
    }

    private class Link(private val connection: PeerConnection, private val post: (() -> Unit) -> Unit) : PeerLink {
        @Volatile
        private var channel: DataChannel? = null

        fun adopt(dataChannel: DataChannel, events: PeerEvents) {
            channel = dataChannel
            dataChannel.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit
                override fun onStateChange() = Unit
                override fun onMessage(buffer: DataChannel.Buffer) {
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes)
                    val text = String(bytes, Charsets.UTF_8)
                    post { events.onControlMessage(text) }
                }
            })
        }

        override fun answer(offerSdp: String, onAnswer: (String) -> Unit, onError: (String) -> Unit) {
            connection.setRemoteDescription(object : SdpAdapter() {
                override fun onSetSuccess() {
                    connection.createAnswer(object : SdpAdapter() {
                        override fun onCreateSuccess(description: SessionDescription) {
                            connection.setLocalDescription(object : SdpAdapter() {
                                override fun onSetSuccess() = post { onAnswer(description.description) }
                                override fun onSetFailure(error: String?) = post { onError(error ?: "The answer could not be applied.") }
                            }, description)
                        }
                        override fun onCreateFailure(error: String?) = post { onError(error ?: "No answer could be created.") }
                    }, MediaConstraints())
                }
                override fun onSetFailure(error: String?) = post { onError(error ?: "The PC's offer could not be applied.") }
            }, SessionDescription(SessionDescription.Type.OFFER, offerSdp))
        }

        override fun addRemoteCandidate(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) {
            connection.addIceCandidate(IceCandidate(sdpMid ?: "", sdpMLineIndex ?: 0, candidate))
        }

        override fun sendControl(text: String): Boolean {
            val open = channel?.takeIf { it.state() == DataChannel.State.OPEN } ?: return false
            return open.send(DataChannel.Buffer(ByteBuffer.wrap(text.toByteArray(Charsets.UTF_8)), false))
        }

        override fun close() {
            channel?.let {
                it.unregisterObserver()
                it.close()
                it.dispose()
            }
            channel = null
            connection.dispose()
        }
    }

    private open class SdpAdapter : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) = Unit
        override fun onSetFailure(error: String?) = Unit
    }
}

/** The WebSocket to the relay, over the same OkHttp client as the API, callbacks posted to the stream's thread. */
class OkHttpSignalingSocket(
    http: OkHttpClient,
    url: String,
    post: (() -> Unit) -> Unit,
    onOpen: () -> Unit,
    onMessage: (String) -> Unit,
    onClosed: (String?) -> Unit,
) : SignalingSocket {
    private val socket: WebSocket = http.newWebSocket(
        Request.Builder().url(url).build(),
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = post { onOpen() }
            override fun onMessage(webSocket: WebSocket, text: String) = post { onMessage(text) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                post { onClosed(reason) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = post { onClosed(t.message) }
        },
    )

    override fun send(text: String): Boolean = socket.send(text)

    override fun close() {
        socket.close(1000, "client-closed")
    }
}
