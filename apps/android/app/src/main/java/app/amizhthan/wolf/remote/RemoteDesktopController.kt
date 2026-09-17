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
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.RandomAccessFile
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val LOG_TAG = "WolfStream"

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
    val profile: StreamProfile = StreamProfile.BALANCED,
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
    /** A transfer to this PC the connection interrupted, waiting to be resumed or discarded. */
    val interrupted: InterruptedTransfer? = null,
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
    private val interruptedTransfers: InterruptedTransfers,
    private val clipboard: PhoneClipboard = PhoneClipboard(context),
) {
    private val appContext = context.applicationContext
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable -> Thread(runnable, "wolf-remote-desktop") }
    private val post: (() -> Unit) -> Unit = { task -> if (!executor.isShutdown) executor.execute(task) }
    private val pcSession = PcSessionController(pcId, api, session, capabilities = CAPABILITIES)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow(RemoteDesktopUiState())
    val state: StateFlow<RemoteDesktopUiState> = _state.asStateFlow()

    private val _files = MutableStateFlow(FilesUiState(interrupted = interruptedTransfers[pcId]))
    val files: StateFlow<FilesUiState> = _files.asStateFlow()

    init {
        // Download parts nothing will resume — from a stream that ended some other way, or an app process that did.
        scope.launch { interruptedTransfers.sweep() }
    }

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
        StreamForegroundService.start(appContext)
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

    /**
     * Start again, at the same quality and sound, after the stream stopped — the connection to WOLF dropped or the
     * network changed. The old stream is taken down on the stream thread first, so nothing it still reports can
     * overwrite the new one's state.
     *
     * Found on the owner's phone: a few minutes in the background and Android cut the app's connection ("Software
     * caused connection abort"); the stream stayed stopped until it was closed and opened again by hand.
     */
    suspend fun restart() {
        val current = _state.value
        suspendCancellableCoroutine { continuation ->
            post {
                renderer?.let { track?.removeSink(it) }
                track = null
                audioTrack = null
                stream?.stop()
                stream = null
                continuation.resume(Unit)
            }
        }
        try {
            start(current.profile, current.soundRequested)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            // No network yet, or WOLF unreachable: a failure the screen retries, not a silent "Connecting" forever.
            _state.update {
                it.copy(
                    phase = StreamPhase.FAILED,
                    failure = StreamFailure(
                        "reconnect-failed",
                        "WOLF could not be reached to reconnect${error.message?.let { message -> ": $message" } ?: "."}",
                        retryable = true,
                        "WOLF tries again by itself. Check this phone's connection.",
                    ),
                )
            }
        }
    }

    fun requestControl() = post { stream?.requestControl() }

    fun releaseControl() = post { stream?.releaseControl() }

    fun send(events: List<JsonObject>) = post { stream?.sendInput(events) }

    /* Displays and sound. */

    /** Look at another of the PC's displays, switched in place; the negotiation follows what the PC switched to. */
    fun setDisplay(displayId: String?) = post { stream?.setDisplay(displayId) }

    /** Sharper or lighter picture, on the running stream. */
    fun setQuality(quality: StreamQuality) {
        _state.update { it.copy(profile = quality.profile) }
        post { stream?.setProfile(quality.profile.json) }
    }

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
        _files.update { FilesUiState(control = it.control?.copy(granted = false, reason = "released"), interrupted = it.interrupted) }
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

    /** Delete to the Recycle Bin, rename, move within a drive, or make a folder — then list the folder again. */
    fun change(message: JsonObject, done: String) {
        val folder = _files.value.folder
        _files.update { it.copy(busy = true, notice = null) }
        scope.launch {
            try {
                transfer.change(message)
                browse(folder)
                _files.update { it.copy(notice = done) }
            } catch (error: FileRefusalException) {
                _files.update { it.copy(notice = words(error.refusal), busy = false) }
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
     * Fetch a file into a document the owner chose.
     *
     * It is put together in this app's cache first and copied into the document only once it is whole, so a
     * partial copy never sits among the owner's files looking like the real one. If the connection ends partway,
     * what arrived stays in the cache to be resumed, and the document is removed until then.
     */
    fun download(entry: FileEntry, destination: Uri) {
        val path = FileMessages.pathOf(_files.value.folder, entry)
        transferStopped = false
        _files.update { it.copy(notice = null, progress = TransferProgress(entry.name, true, 0, entry.sizeBytes ?: 0)) }
        scope.launch { fetch(entry.name, path, entry.modifiedAt, destination, resuming = null) }
    }

    /** Carry on with the interrupted download, into a document the owner chose again. */
    fun resumeDownload(destination: Uri) {
        val record = interruptedTransfers[pcId] as? InterruptedDownload ?: return
        transferStopped = false
        _files.update { it.copy(notice = null, progress = TransferProgress(record.name, true, record.done, record.total)) }
        scope.launch { fetch(record.name, record.path, record.modifiedAt, destination, resuming = record) }
    }

    private suspend fun fetch(name: String, path: String, modifiedAt: String?, destination: Uri, resuming: InterruptedDownload?) {
        val part = resuming?.part ?: newPart()
        if (resuming != null) interruptedTransfers.take(pcId)
        var delivered = false
        var keptForResume = false
        val progress = { done: Long, total: Long -> _files.update { it.copy(progress = TransferProgress(name, true, done, total)) } }

        try {
            if (resuming == null) {
                FileOutputStream(part).use { sink -> transfer.download(path, sink, cancelled = { transferStopped }, onProgress = progress) }
            } else {
                // What is really on disk decides, not the record: the cache may have been trimmed since.
                val from = minOf(part.length(), resuming.done)
                RandomAccessFile(part, "rw").use { it.setLength(from) }
                FileOutputStream(part, true).use { sink ->
                    transfer.resumeDownload(path, sink, from, resuming.total, modifiedAt, cancelled = { transferStopped }, onProgress = progress)
                }
            }

            documents.openOutput(destination).use { sink -> part.inputStream().use { it.copyTo(sink, FileMessages.MAX_CHUNK) } }
            delivered = true
            _files.update { it.copy(notice = "$name was saved to this phone.") }
        } catch (interrupted: TransferInterruptedException) {
            interruptedTransfers.keep(pcId, InterruptedDownload(name, path, modifiedAt, part, interrupted.done, interrupted.total))
            keptForResume = true
            _files.update {
                it.copy(notice = "Fetching $name was interrupted when the connection to the PC ended. What arrived is kept inside this app, not among your files; once this session has file access again, resume it.")
            }
        } catch (error: FileRefusalException) {
            // Cut off again before a byte moved — while asking the PC about the file. The record stands as it was.
            if (error.isInterruption && resuming != null) {
                interruptedTransfers.keep(pcId, resuming)
                keptForResume = true
            }
            _files.update { it.copy(notice = words(error.refusal)) }
        } catch (_: TransferCancelledException) {
            _files.update { it.copy(notice = "Stopped. The partial copy on this phone was removed.") }
        } catch (error: IOException) {
            _files.update { it.copy(notice = "That file could not be saved on this phone: ${error.message ?: "the storage provider refused"}.") }
        } finally {
            withContext(NonCancellable) {
                if (!delivered) documents.delete(destination)
                if (!keptForResume) part.delete()
            }
            _files.update { it.copy(progress = null, interrupted = interruptedTransfers[pcId]) }
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
        scope.launch { send(source, folder, resuming = null) }
    }

    /** Carry on with the interrupted upload, from wherever the PC says its part file got to. */
    fun resumeUpload() {
        val record = interruptedTransfers[pcId] as? InterruptedUpload ?: return
        transferStopped = false
        _files.update { it.copy(notice = null, progress = TransferProgress(record.name, false, record.done, record.total)) }
        scope.launch { send(Uri.parse(record.source), folder = null, resuming = record) }
    }

    private suspend fun send(source: Uri, folder: String?, resuming: InterruptedUpload?) {
        if (resuming != null) interruptedTransfers.take(pcId)
        var name = resuming?.name ?: "That file"
        var destination = resuming?.destination
        try {
            val document = documents.openInput(source)
            name = document.name
            document.stream.use { input ->
                val total = document.sizeBytes ?: throw FileRefusalException(
                    FileRefusal("unsupported", "This phone could not tell how large that file is, and the PC needs to know before it accepts one.", false),
                )
                if (resuming != null && total != resuming.total) {
                    throw FileRefusalException(
                        FileRefusal("changed", "$name has changed on this phone since it was being sent, so it was not joined to the part on the PC. Send it again.", false),
                    )
                }
                val target = destination ?: FileMessages.childPath(folder!!, document.name)
                destination = target
                val progress = { done: Long, of: Long -> _files.update { it.copy(progress = TransferProgress(name, false, done, of)) } }
                _files.update { it.copy(progress = TransferProgress(name, false, resuming?.done ?: 0, total)) }

                if (resuming == null) {
                    transfer.upload(target, total, input, cancelled = { transferStopped }, onProgress = progress)
                    _files.update { it.copy(notice = "$name was written to the PC.") }
                } else {
                    transfer.resumeUpload(target, total, input, cancelled = { transferStopped }, onProgress = progress)
                    _files.update { it.copy(notice = "$name was written to the PC, and matches the file on this phone.") }
                }
            }
            browse(FileMessages.parentOf(destination!!))
        } catch (interrupted: TransferInterruptedException) {
            interruptedTransfers.keep(pcId, InterruptedUpload(name, source.toString(), destination!!, interrupted.done, interrupted.total))
            _files.update {
                it.copy(
                    notice = "Sending $name was interrupted when the connection to the PC ended. What reached the PC waits there for " +
                        "${FileMessages.PARTIAL_UPLOAD_KEPT_MINUTES} minutes; once this session has file access again, resume it.",
                )
            }
        } catch (error: FileRefusalException) {
            // Cut off again before a byte moved — while asking the PC how far it got. The record stands as it was.
            if (error.isInterruption && resuming != null) interruptedTransfers.keep(pcId, resuming)
            _files.update { it.copy(notice = words(error.refusal)) }
        } catch (_: TransferCancelledException) {
            _files.update { it.copy(notice = "Stopped. The PC removed the part it had received.") }
        } catch (error: IOException) {
            _files.update { it.copy(notice = "$name could not be read on this phone: ${error.message ?: "the storage provider refused"}.") }
        } catch (_: SecurityException) {
            // The permission to read a chosen document lasts only so long; an app restart ends it.
            _files.update { it.copy(notice = "This phone no longer lets WOLF read $name. Choose it again to send it.") }
        } finally {
            _files.update { it.copy(progress = null, interrupted = interruptedTransfers[pcId]) }
        }
    }

    /** Forget the interrupted transfer. What reached the PC is removed there when its time is up. */
    fun discardInterrupted() {
        val record = interruptedTransfers[pcId] ?: return
        interruptedTransfers.discard(pcId)
        _files.update {
            it.copy(
                interrupted = null,
                notice = if (record is InterruptedUpload) {
                    "The part of ${record.name} already on the PC is removed there within ${FileMessages.PARTIAL_UPLOAD_KEPT_MINUTES} minutes."
                } else {
                    "What arrived of ${record.name} was removed from this phone."
                },
            )
        }
    }

    private fun newPart(): File =
        File(interruptedTransfers.partsDirectory.apply { mkdirs() }, Ulid.next() + InterruptedTransfers.PART_SUFFIX)

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
        StreamForegroundService.stop(appContext)
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
        _files.value = FilesUiState(interrupted = interruptedTransfers[pcId])
        _state.update { it.copy(clipboardFromPc = null) }
    }

    private suspend fun askOnStream(message: JsonObject): JsonObject = suspendCancellableCoroutine { continuation ->
        post {
            val current = stream
            if (current == null) {
                continuation.resumeWithException(FileRefusalException(FileRefusal(FileMessages.INTERRUPTED, "The stream to this PC is not running.", false)))
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
        override fun onPhase(phase: StreamPhase, detail: String?) {
            // Phases and failure codes only: never a path, a clipboard, a token or anything the owner typed.
            android.util.Log.i(LOG_TAG, "stream phase $phase")
            _state.update { it.copy(phase = phase, detail = detail) }
        }
        override fun onFailure(failure: StreamFailure) {
            android.util.Log.w(LOG_TAG, "stream failed: ${failure.code} (retryable=${failure.retryable}): ${failure.message}")
            _state.update { it.copy(failure = failure, control = null) }
        }
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
                _files.update { FilesUiState(control = control, interrupted = it.interrupted) }
            }
        }
    }

    private companion object {
        val CAPABILITIES = listOf("screen", "audio", "input", "clipboard", "file-transfer")

        const val TOO_LARGE = "That is more than 256 KB of text. WOLF refuses it whole rather than sending part of it."
    }
}
