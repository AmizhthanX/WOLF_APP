package app.amizhthan.wolf.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.amizhthan.wolf.api.CommandView
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.LatestTelemetry
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.ProcessListResult
import app.amizhthan.wolf.api.ProcessRow
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfJson
import app.amizhthan.wolf.api.WolfProblem
import app.amizhthan.wolf.remote.RemoteDesktopController
import app.amizhthan.wolf.remote.StreamProfile
import app.amizhthan.wolf.session.CommandOutcome
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.PendingCommand
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.session.SessionState
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject

sealed interface Screen {
    data object Starting : Screen
    data object SignIn : Screen
    data object Pcs : Screen
    data class Pc(val id: String) : Screen
    data class RemoteDesktop(val pcId: String) : Screen
}

/** What to do with a command's result once it has one. Kept with a pending command across its confirmation. */
sealed interface CommandPurpose {
    data class Power(val label: String) : CommandPurpose
    data object ListProcesses : CommandPurpose
    data class Terminate(val pid: Int, val name: String) : CommandPurpose
}

data class Confirmation(val pending: PendingCommand, val purpose: CommandPurpose)

data class UiState(
    val screen: Screen = Screen.Starting,
    val busy: Boolean = false,
    val problem: WolfProblem? = null,
    val pcs: List<PcSummary>? = null,
    val telemetry: LatestTelemetry? = null,
    val processes: List<ProcessRow>? = null,
    val processesTruncated: Boolean = false,
    val confirmation: Confirmation? = null,
    val confirming: Boolean = false,
    val confirmationProblem: WolfProblem? = null,
    val notice: String? = null,
)

class AppViewModel(
    private val session: SessionManager,
    private val api: WolfApi,
    private val remoteDesktops: (pcId: String) -> RemoteDesktopController,
) : ViewModel() {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var telemetryJob: Job? = null
    private var controller: PcSessionController? = null
    private var remote: RemoteDesktopController? = null

    init {
        viewModelScope.launch {
            val restored = session.restore()
            _state.update { it.copy(screen = if (restored) Screen.Pcs else Screen.SignIn) }
            if (restored) loadPcs()
        }

        // A refresh that the server refuses signs the phone out wherever it happens.
        viewModelScope.launch {
            session.state.collect { state ->
                if (state is SessionState.SignedOut && _state.value.screen !is Screen.SignIn && _state.value.screen !is Screen.Starting) {
                    stopRemote()
                    leavePc()
                    _state.update { UiState(screen = Screen.SignIn, problem = it.problem) }
                }
            }
        }
    }

    fun signIn(email: String, password: String) = launchBusy {
        session.signIn(email, password)
        _state.update { it.copy(screen = Screen.Pcs, problem = null) }
        loadPcs()
    }

    fun loadPcs() = launchBusy {
        val pcs = session.authorized { api.listPcs(it) }.pcs
        _state.update { it.copy(pcs = pcs, problem = null) }
    }

    fun openPc(id: String) {
        leavePc()
        controller = PcSessionController(id, api, session)
        _state.update { it.copy(screen = Screen.Pc(id), telemetry = null, processes = null, problem = null, notice = null) }
        watchTelemetry(id)
    }

    fun back() {
        leavePc()
        _state.update { it.copy(screen = Screen.Pcs, telemetry = null, processes = null, problem = null, notice = null, confirmation = null) }
        loadPcs()
    }

    fun signOut() = launchBusy {
        stopRemote()
        leavePc()
        session.signOut()
        _state.value = UiState(screen = Screen.SignIn)
    }

    /** The controller for the open remote desktop, if one is open. */
    fun remoteDesktop(): RemoteDesktopController? = remote

    fun openRemoteDesktop(profile: StreamProfile) {
        val pcId = (_state.value.screen as? Screen.Pc)?.id ?: return
        telemetryJob?.cancel()
        stopRemote()

        val opened = remoteDesktops(pcId)
        remote = opened
        _state.update { it.copy(screen = Screen.RemoteDesktop(pcId), problem = null, notice = null) }

        viewModelScope.launch {
            try {
                opened.start(profile)
            } catch (error: WolfApiException) {
                // No stream to show: back to the PC with the reason.
                if (remote === opened) closeRemoteDesktop()
                _state.update { it.copy(problem = error.problem) }
            }
        }
    }

    fun closeRemoteDesktop() {
        val pcId = (_state.value.screen as? Screen.RemoteDesktop)?.pcId ?: return
        stopRemote()
        _state.update { it.copy(screen = Screen.Pc(pcId)) }
        watchTelemetry(pcId)
    }

    fun power(action: String, label: String, description: String) =
        send(Commands.power(action), "$label this PC", description, CommandPurpose.Power(label))

    fun loadProcesses() =
        send(Commands.processList(), "List processes", "Read the process list from this PC.", CommandPurpose.ListProcesses)

    fun terminate(row: ProcessRow) = send(
        Commands.terminate(row.pid, row.name),
        "Terminate ${row.name}",
        "WOLF will ask ${row.name} (PID ${row.pid}) to close, then end it if it does not.",
        CommandPurpose.Terminate(row.pid, row.name),
    )

    fun confirm(password: String?) {
        val confirmation = _state.value.confirmation ?: return
        val active = controller ?: return
        viewModelScope.launch {
            _state.update { it.copy(confirming = true, confirmationProblem = null) }
            try {
                handle(active.confirm(confirmation.pending, password), confirmation.purpose)
            } catch (error: WolfApiException) {
                // The dialog stays open: a mistyped password is corrected, not restarted.
                _state.update { it.copy(confirmationProblem = error.problem) }
            } catch (error: IllegalArgumentException) {
                _state.update { it.copy(confirmationProblem = localProblem("confirm.password_required", error.message ?: "A password is required.")) }
            } finally {
                _state.update { it.copy(confirming = false) }
            }
        }
    }

    fun cancelConfirmation() = _state.update { it.copy(confirmation = null, confirmationProblem = null, notice = "Cancelled. Nothing was sent to the PC.") }

    fun dismissProblem() = _state.update { it.copy(problem = null, notice = null) }

    private fun watchTelemetry(id: String) {
        telemetryJob?.cancel()
        telemetryJob = viewModelScope.launch {
            while (isActive) {
                try {
                    val latest = session.authorized { api.latestTelemetry(id, it) }
                    _state.update { it.copy(telemetry = latest) }
                } catch (error: WolfApiException) {
                    _state.update { it.copy(problem = error.problem) }
                }
                delay(TELEMETRY_REFRESH_MS)
            }
        }
    }

    private fun send(command: JsonObject, title: String, description: String, purpose: CommandPurpose) {
        val active = controller ?: return
        launchBusy {
            _state.update { it.copy(notice = null) }
            handle(active.run(command, title, description), purpose)
        }
    }

    private fun handle(outcome: CommandOutcome, purpose: CommandPurpose) {
        when (outcome) {
            is CommandOutcome.NeedsConfirmation -> _state.update {
                it.copy(confirmation = Confirmation(outcome.pending, purpose), confirmationProblem = null)
            }
            is CommandOutcome.Done -> {
                _state.update { it.copy(confirmation = null, confirmationProblem = null) }
                completed(outcome.command, purpose)
            }
        }
    }

    private fun completed(command: CommandView, purpose: CommandPurpose) {
        val failure = command.failure
        when {
            command.status == "completed" -> when (purpose) {
                is CommandPurpose.Power -> _state.update { it.copy(notice = "${purpose.label} was accepted by Windows.") }
                CommandPurpose.ListProcesses -> {
                    val result = try {
                        command.result?.let { WolfJson.decodeFromJsonElement(ProcessListResult.serializer(), it) }
                    } catch (_: SerializationException) {
                        null
                    }
                    _state.update {
                        it.copy(
                            processes = result?.processes?.sortedByDescending { row -> row.cpuPercent ?: -1.0 },
                            processesTruncated = result?.truncated ?: false,
                        )
                    }
                }
                is CommandPurpose.Terminate -> {
                    _state.update { it.copy(notice = "${purpose.name} was ended.", processes = it.processes?.filterNot { row -> row.pid == purpose.pid }) }
                }
            }
            failure != null -> _state.update {
                it.copy(
                    problem = WolfProblem(
                        code = failure.code,
                        problem = "The PC did not carry this out.",
                        cause = failure.message ?: failure.code,
                        currentState = if (failure.limitation) "Windows does not allow this on that PC." else "Nothing was changed.",
                        recommendedAction = if (failure.limitation) {
                            "This is a Windows limitation on that PC rather than a WOLF fault."
                        } else {
                            "Retry. If it keeps failing, check the agent log on the PC."
                        },
                        referenceId = "WOLF-CMD-${command.id.takeLast(4)}",
                    ),
                )
            }
            else -> _state.update { it.copy(notice = "Sent. The PC has not reported back yet (${command.status}).") }
        }
    }

    private fun stopRemote() {
        remote?.let { closing -> viewModelScope.launch { closing.stop() } }
        remote = null
    }

    private fun leavePc() {
        telemetryJob?.cancel()
        telemetryJob = null
        controller?.let { closing -> viewModelScope.launch { closing.close() } }
        controller = null
    }

    private fun launchBusy(work: suspend () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            try {
                work()
            } catch (error: WolfApiException) {
                _state.update { it.copy(problem = error.problem) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    private fun localProblem(code: String, message: String) = WolfProblem(
        code = code,
        problem = message,
        currentState = "Nothing was sent to the PC.",
        recommendedAction = "Enter your password to confirm.",
        referenceId = "WOLF-CMD-LOCAL",
    )

    override fun onCleared() {
        stopRemote()
        leavePc()
    }

    private companion object {
        /** Matches the web dashboard: presence and load change on this scale, not faster. */
        const val TELEMETRY_REFRESH_MS = 10_000L
    }
}
