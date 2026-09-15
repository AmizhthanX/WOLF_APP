package app.amizhthan.wolf.remote

import android.content.Context
import app.amizhthan.wolf.ApiEndpoint
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

data class RemoteDesktopUiState(
    val phase: StreamPhase = StreamPhase.IDLE,
    val detail: String? = null,
    val failure: StreamFailure? = null,
    val negotiation: Negotiation? = null,
    val control: InputControl? = null,
    val remoteState: RemoteState? = null,
    val inputRefusal: String? = null,
    val frameWidth: Int = 0,
    val frameHeight: Int = 0,
    /** True once a decoded frame has actually been drawn, not when the connection came up. */
    val pictureShown: Boolean = false,
    val profile: StreamProfile = StreamProfile.MOBILE_DATA,
)

/**
 * Remote desktop on the phone: its own PC session, the stream, and the picture.
 *
 * The session asks for `screen` and `input` and nothing more — separate from the session commands use,
 * because watching a machine and restarting it are different things to have been granted.
 *
 * Everything the stream does happens on one thread, which the socket, the peer connection and the
 * renewal timer all post to.
 */
class RemoteDesktopController(
    context: Context,
    private val pcId: String,
    private val api: WolfApi,
    session: SessionManager,
    private val http: OkHttpClient,
) {
    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "wolf-remote-desktop") }
    private val post: (() -> Unit) -> Unit = { task -> if (!executor.isShutdown) executor.execute(task) }
    private val pcSession = PcSessionController(pcId, api, session, capabilities = listOf("screen", "input"))

    private val _state = MutableStateFlow(RemoteDesktopUiState())
    val state: StateFlow<RemoteDesktopUiState> = _state.asStateFlow()

    val rtc: WebRtc by lazy { WebRtc.get(appContext) }

    private var stream: StreamSession? = null
    private var track: VideoTrack? = null
    private var renderer: SurfaceViewRenderer? = null

    suspend fun start(profile: StreamProfile) {
        _state.update { RemoteDesktopUiState(phase = StreamPhase.AUTHENTICATING, profile = profile) }

        val token = pcSession.sessionToken()
        val ice = api.iceServers(pcId, token).configuration.iceServers.map { IceServerConfig(it.urls, it.username, it.credential) }
        val codecs = DecoderCodecs.fromDecoderNames(rtc.decoderCodecNames)

        post {
            lateinit var created: StreamSession
            val socket = OkHttpSignalingSocket(
                http = http,
                url = "${ApiEndpoint.REALTIME_URL.trimEnd('/')}/client",
                post = post,
                onOpen = { created.onSocketOpen() },
                onMessage = { created.onSocketMessage(it) },
                onClosed = { created.onSocketClosed(it) },
            )
            created = StreamSession(
                sessionToken = token,
                iceServers = ice,
                profile = profile.json,
                clientCodecs = codecs,
                socket = socket,
                peers = WebRtcPeerFactory(rtc, post) { attachTrack(it) },
                scheduler = { period, task ->
                    val future = executor.scheduleWithFixedDelay(task, period, period, TimeUnit.MILLISECONDS)
                    Cancellable { future.cancel(false) }
                },
                listener = listener,
                h264Profiles = DecoderCodecs.h264Profiles(rtc.h264ProfileLevelIds),
            )
            stream = created
        }
    }

    fun requestControl() = post { stream?.requestControl() }

    fun releaseControl() = post { stream?.releaseControl() }

    fun send(events: List<JsonObject>) = post { stream?.sendInput(events) }

    /** Bind the picture. Called when the view exists; the track may arrive before or after. */
    fun attachRenderer(view: SurfaceViewRenderer) {
        view.init(rtc.egl.eglBaseContext, object : RendererCommon.RendererEvents {
            override fun onFirstFrameRendered() = _state.update { it.copy(pictureShown = true) }
            override fun onFrameResolutionChanged(width: Int, height: Int, rotation: Int) {
                val rotated = rotation == 90 || rotation == 270
                _state.update { it.copy(frameWidth = if (rotated) height else width, frameHeight = if (rotated) width else height) }
            }
        })
        view.setScalingType(RendererCommon.ScalingType.SCALE_ASPECT_FIT)
        view.setEnableHardwareScaler(true)
        view.keepScreenOn = true
        post {
            renderer = view
            track?.addSink(view)
        }
    }

    fun detachRenderer(view: SurfaceViewRenderer) {
        post {
            track?.removeSink(view)
            if (renderer === view) renderer = null
        }
        view.release()
    }

    /** Stop the stream and end its session on the server. */
    suspend fun stop() {
        post {
            renderer?.let { track?.removeSink(it) }
            track = null
            stream?.stop()
            stream = null
        }
        pcSession.close()
        executor.shutdown()
    }

    private fun attachTrack(videoTrack: VideoTrack) {
        track = videoTrack
        renderer?.let { videoTrack.addSink(it) }
    }

    private val listener = object : StreamListener {
        override fun onPhase(phase: StreamPhase, detail: String?) = _state.update { it.copy(phase = phase, detail = detail) }
        override fun onFailure(failure: StreamFailure) = _state.update { it.copy(failure = failure, control = null) }
        override fun onNegotiation(negotiation: Negotiation) = _state.update { it.copy(negotiation = negotiation) }
        override fun onInputControl(control: InputControl) = _state.update { it.copy(control = control, inputRefusal = null) }
        override fun onRemoteState(state: RemoteState) = _state.update { it.copy(remoteState = state) }
        override fun onInputRefused(reason: String, limitation: Boolean) = _state.update {
            it.copy(inputRefusal = if (limitation) "$reason (a Windows limitation)" else reason)
        }
    }
}
