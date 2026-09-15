package app.amizhthan.wolf.remote

import android.content.Context
import android.net.Uri
import app.amizhthan.wolf.ApiEndpoint
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.session.CommandOutcome
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.storage.DocumentStore
import app.amizhthan.wolf.storage.PhoneClipboard
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import org.webrtc.AudioTrack
import org.webrtc.RendererCommon
import org.webrtc.SurfaceViewRenderer
import org.webrtc.VideoTrack
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

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
    /** Whether the owner asked to hear the PC. Whether it can be heard is the negotiation's audio codec. */
    val soundRequested: Boolean = false,
    /** Muted on this phone only; the PC keeps sending. */
    val soundOn: Boolean = true,
    /** The PC's displays; null until listed. */
    val displays: List<RemoteDisplay>? = null,
    val displaysNotice: String? = null,
    /** Text the PC copied, held until the owner copies or dismisses it. Its `toString` never shows the text. */
    val clipboardFromPc: ClipboardEvent.Content? = null,
    val clipboardNotice: String? = null,
)

data class TransferProgress(val name: String, val downloading: Boolean, val done: Long, val total: Long)

/** The file manager as the screen shows it. Held in memory only, and only while the stream runs. */
data class FilesUiState(
    val control: InputControl? = null,
    val folder: String? = null,
    val entries: List<FileEntry>? = null,
    val truncated: Boolean = false,
    val busy: Boolean = false,
    val notice: String? = null,
    val progress: TransferProgress? = null,
)

/**
 * Remote desktop on the phone: its own PC session, the stream, the picture and sound, the clipboard, and the
 * PC's files.
 *
 * The session asks for `screen`, `audio`, `input`, `clipboard` and `file-transfer` — separate from the session
 * commands use, because watching a machine and restarting it are different things to have been granted. Holding
 * a capability is not using it, the way the web dashboard holds them: sound only when the owner asks for it,
 * clipboard text only on a tap, and control and files each a lease on top, decided by the cloud.
 *
 * Everything the stream does happens on one thread, which the socket, the peer connection and the
 * renewal timer all post to. File transfers run on their own coroutines and reach the stream through it.
 */
class RemoteDesktopController(
    context: Context,
    private val pcId: String,
    private val api: WolfApi,
    session: SessionManager,
    private val http: OkHttpClient,
    private val documents: DocumentStore,
    private val clipboard: PhoneClipboard = PhoneClipboard(context),
) {
    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "wolf-remote-desktop") }
    private val post: (() -> Unit) -> Unit = { task -> if (!executor.isShutdown) executor.execute(task) }
    private val pcSession = PcSessionController(pcId, api, session, capabilities = CAPABILITIES)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow(RemoteDesktopUiState())
    val state: StateFlow<RemoteDesktopUiState> = _state.asStateFlow()

    private val _files = MutableStateFlow(FilesUiState())
    val files: StateFlow<FilesUiState> = _files.asStateFlow()

    @Volatile
    private var transferStopped = false

    private val transfer = FileTransfer { message -> askOnStream(message) }

    val rtc: WebRtc by lazy { WebRtc.get(appContext) }

    private var stream: StreamSession? = null
    private var track: VideoTrack? = null
    private var audioTrack: AudioTrack? = null
    private var renderer: SurfaceViewRenderer? = null

    /** Start streaming. Sound is asked for only when [sound] is true; the PC says what it settled on. */
    suspend fun start(profile: StreamProfile, sound: Boolean = false) {
        _state.update { RemoteDesktopUiState(phase = StreamPhase.AUTHENTICATING, profile = profile, soundRequested = sound) }

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
                peers = WebRtcPeerFactory(rtc, post, onAudioTrack = { attachAudio(it) }) { attachTrack(it) },
                scheduler = { period, task ->
                    val future = executor.scheduleWithFixedDelay(task, period, period, TimeUnit.MILLISECONDS)
                    Cancellable { future.cancel(false) }
                },
                listener = listener,
                h264Profiles = DecoderCodecs.h264Profiles(rtc.h264ProfileLevelIds),
                requestAudio = sound,
            )
            stream = created
        }

        loadDisplays()
    }

    fun requestControl() = post { stream?.requestControl() }

    fun releaseControl() = post { stream?.releaseControl() }

    fun send(events: List<JsonObject>) = post { stream?.sendInput(events) }

    /* Displays and sound. */

    /** Look at another of the PC's displays, switched in place; the negotiation follows what the PC switched to. */
    fun setDisplay(displayId: String?) = post { stream?.setDisplay(displayId) }

    fun setSoundOn(on: Boolean) {
        _state.update { it.copy(soundOn = on) }
        post { audioTrack?.setEnabled(on) }
    }

    /**
     * Read the PC's displays, so another can be chosen. Low risk and read-only, under `screen`; a failure only
     * leaves the choice out, with the reason.
     */
    private fun loadDisplays() {
        scope.launch {
            val notice = try {
                when (val outcome = pcSession.run(Commands.listDisplays(), "List displays", "Read the display layout from this PC.")) {
                    is CommandOutcome.Done -> if (outcome.command.status == "completed") {
                        _state.update { it.copy(displays = Displays.parse(outcome.command.result)) }
                        null
                    } else {
                        outcome.command.failure?.message ?: "The PC did not list its displays (${outcome.command.status})."
                    }
                    // Listing displays is low risk. Should the server ever ask, the answer is not given from here.
                    is CommandOutcome.NeedsConfirmation -> "WOLF asked for a confirmation before listing this PC's displays, so they were not listed."
                }
            } catch (error: WolfApiException) {
                error.problem.problem
            } catch (error: IOException) {
                "This PC's displays could not be read: ${error.message ?: "the connection failed"}."
            }
            if (notice != null) _state.update { it.copy(displaysNotice = notice) }
        }
    }

    /* Clipboard. Text only, both ways on the data channel, and only when the owner taps. */

    /** Send the text on this phone's clipboard to the PC's clipboard. */
    fun sendPhoneClipboard() {
        val text = clipboard.readText()
        when {
            text == null -> _state.update { it.copy(clipboardNotice = "This phone's clipboard has no text to send.") }
            // Refused whole rather than cut: a paste that arrives shortened is worse than one that did not happen.
            text.length > StreamSession.MAX_CLIPBOARD_TEXT -> _state.update { it.copy(clipboardNotice = TOO_LARGE) }
            else -> post {
                val words = when (stream?.sendClipboard(text) ?: ClipboardSend.NOT_READY) {
                    ClipboardSend.SENT -> "Sent ${text.length} characters to the PC's clipboard. If the PC refuses them, it says so here."
                    ClipboardSend.TOO_LARGE -> TOO_LARGE
                    ClipboardSend.NOT_READY -> "The connection to this PC is not ready for clipboard text."
                }
                _state.update { it.copy(clipboardNotice = words) }
            }
        }
    }

    /** Put what the PC copied on this phone's clipboard — the owner's tap, never the PC's. */
    fun copyPcClipboardToPhone() {
        val offered = _state.value.clipboardFromPc ?: return
        clipboard.writeText(offered.text)
        _state.update { it.copy(clipboardFromPc = null, clipboardNotice = "Copied to this phone's clipboard, marked as sensitive.") }
    }

    fun dismissPcClipboard() = _state.update { it.copy(clipboardFromPc = null, clipboardNotice = null) }

    /* Files. Names and bytes go between this phone and the PC on the data channel, and nowhere else. */

    fun requestFiles() = post { stream?.requestFiles() }

    fun releaseFiles() {
        transferStopped = true
        post { stream?.releaseFiles() }
        _files.update { FilesUiState(control = it.control?.copy(granted = false, reason = "released")) }
    }

    fun browse(path: String?) {
        _files.update { it.copy(busy = true, notice = null) }
        scope.launch {
            try {
                val listing = transfer.list(path)
                _files.update { it.copy(folder = listing.path, entries = listing.entries, truncated = listing.truncated) }
            } catch (error: FileRefusalException) {
                // The PC's own words: WOLF refused it, Windows refused it, or nothing is there.
                _files.update { it.copy(notice = words(error.refusal)) }
            } finally {
                _files.update { it.copy(busy = false) }
            }
        }
    }

    fun up() {
        val folder = _files.value.folder ?: return
        browse(FileMessages.parentOf(folder))
    }

    fun stopTransfer() {
        transferStopped = true
    }

    /**
     * Fetch a file into a document the owner chose. If it does not arrive whole, the document is removed, so a
     * partial copy never sits on the phone looking like the real file.
     */
    fun download(entry: FileEntry, destination: Uri) {
        val path = FileMessages.pathOf(_files.value.folder, entry)
        transferStopped = false
        _files.update { it.copy(notice = null, progress = TransferProgress(entry.name, true, 0, entry.sizeBytes ?: 0)) }
        scope.launch {
            var complete = false
            try {
                documents.openOutput(destination).use { sink ->
                    transfer.download(path, sink, cancelled = { transferStopped }) { done, total ->
                        _files.update { it.copy(progress = TransferProgress(entry.name, true, done, total)) }
                    }
                }
                complete = true
                _files.update { it.copy(notice = "${entry.name} was saved to this phone.") }
            } catch (error: FileRefusalException) {
                _files.update { it.copy(notice = words(error.refusal)) }
            } catch (_: TransferCancelledException) {
                _files.update { it.copy(notice = "Stopped. The partial copy on this phone was removed.") }
            } catch (error: IOException) {
                _files.update { it.copy(notice = "That file could not be saved on this phone: ${error.message ?: "the storage provider refused"}.") }
            } finally {
                if (!complete) withContext(NonCancellable) { documents.delete(destination) }
                _files.update { it.copy(progress = null) }
            }
        }
    }

    /** Send a file the owner chose into the folder shown. Never replaces a file already there. */
    fun upload(source: Uri) {
        val folder = _files.value.folder
        if (folder == null) {
            _files.update { it.copy(notice = "Open a folder on the PC first.") }
            return
        }
        transferStopped = false
        _files.update { it.copy(notice = null) }
        scope.launch {
            var name = "That file"
            try {
                val document = documents.openInput(source)
                name = document.name
                document.stream.use { input ->
                    val size = document.sizeBytes ?: throw FileRefusalException(
                        FileRefusal("unsupported", "This phone could not tell how large that file is, and the PC needs to know before it accepts one.", false),
                    )
                    _files.update { it.copy(progress = TransferProgress(document.name, false, 0, size)) }
                    transfer.upload(FileMessages.childPath(folder, document.name), size, input, cancelled = { transferStopped }) { done, total ->
                        _files.update { it.copy(progress = TransferProgress(document.name, false, done, total)) }
                    }
                }
                _files.update { it.copy(notice = "$name was written to the PC.", progress = null) }
                browse(folder)
            } catch (error: FileRefusalException) {
                _files.update { it.copy(notice = words(error.refusal)) }
            } catch (_: TransferCancelledException) {
                _files.update { it.copy(notice = "Stopped. The PC removed the part it had received.") }
            } catch (error: IOException) {
                _files.update { it.copy(notice = "$name could not be read on this phone: ${error.message ?: "the storage provider refused"}.") }
            } finally {
                _files.update { it.copy(progress = null) }
            }
        }
    }

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

    /** Stop the stream and end its session on the server. Transfers in flight end with it; clipboard text is dropped. */
    suspend fun stop() {
        transferStopped = true
        scope.cancel()
        post {
            renderer?.let { track?.removeSink(it) }
            track = null
            audioTrack = null
            stream?.stop()
            stream = null
        }
        pcSession.close()
        executor.shutdown()
        _files.value = FilesUiState()
        _state.update { it.copy(clipboardFromPc = null) }
    }

    private suspend fun askOnStream(message: JsonObject): JsonObject = suspendCancellableCoroutine { continuation ->
        post {
            val current = stream
            if (current == null) {
                continuation.resumeWithException(FileRefusalException(FileRefusal("failed", "The stream to this PC is not running.", false)))
            } else {
                current.askFiles(message) { result ->
                    result.fold({ continuation.resume(it) }, { continuation.resumeWithException(it) })
                }
            }
        }
    }

    private fun words(refusal: FileRefusal): String =
        if (refusal.limitation) "${refusal.detail} Windows refused this, not WOLF." else refusal.detail

    private fun attachTrack(videoTrack: VideoTrack) {
        track = videoTrack
        renderer?.let { videoTrack.addSink(it) }
    }

    private fun attachAudio(track: AudioTrack) {
        audioTrack = track
        track.setEnabled(_state.value.soundOn)
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
        override fun onClipboard(event: ClipboardEvent) = when (event) {
            is ClipboardEvent.Content -> _state.update { it.copy(clipboardFromPc = event, clipboardNotice = null) }
            is ClipboardEvent.Notice -> _state.update { it.copy(clipboardNotice = event.detail) }
        }
        override fun onFileControl(control: InputControl) {
            if (control.granted) {
                _files.update { it.copy(control = control) }
                if (_files.value.entries == null && !_files.value.busy) browse(null)
            } else {
                // Losing the lease ends what was shown: the listing belonged to a permission this session no longer has.
                transferStopped = true
                _files.update { FilesUiState(control = control) }
            }
        }
    }

    private companion object {
        val CAPABILITIES = listOf("screen", "audio", "input", "clipboard", "file-transfer")

        const val TOO_LARGE = "That is more than 256 KB of text. WOLF refuses it whole rather than sending part of it."
    }
}
