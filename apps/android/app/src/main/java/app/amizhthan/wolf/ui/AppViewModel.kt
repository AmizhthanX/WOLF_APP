package app.amizhthan.wolf.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.amizhthan.wolf.api.CommandView
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.LatestTelemetry
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.ProcessListResult
import app.amizhthan.wolf.api.PcTools
import app.amizhthan.wolf.api.ProcessRow
import app.amizhthan.wolf.api.ServiceChangeResult
import app.amizhthan.wolf.api.ServiceListResult
import app.amizhthan.wolf.api.ServiceRow
import app.amizhthan.wolf.api.StartupListResult
import app.amizhthan.wolf.api.StartupRow
import app.amizhthan.wolf.api.TaskListResult
import app.amizhthan.wolf.api.TaskRow
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfJson
import app.amizhthan.wolf.api.WolfProblem
import app.amizhthan.wolf.push.PushRegistrar
import app.amizhthan.wolf.remote.RemoteDesktopController
import app.amizhthan.wolf.remote.StreamProfile
import app.amizhthan.wolf.session.CommandOutcome
import app.amizhthan.wolf.session.PcSessionController
import app.amizhthan.wolf.session.PendingCommand
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.security.VaultLockedException
import app.amizhthan.wolf.session.SessionState
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject

sealed interface Screen {
    data object Starting : Screen
    data object SignIn : Screen
    data object Locked : Screen
    data object Pcs : Screen
    data class Pc(val id: String) : Screen
    data class RemoteDesktop(val pcId: String) : Screen
    data class PcServices(val pcId: String) : Screen
    data class PcAutorun(val pcId: String) : Screen
    data object Alerts : Screen
    data object Automations : Screen
    data object Configuration : Screen
}

/** What to do with a command's result once it has one. Kept with a pending command across its confirmation. */
sealed interface CommandPurpose {
    data class Power(val label: String) : CommandPurpose
    data object ListProcesses : CommandPurpose
    data class Terminate(val pid: Int, val name: String) : CommandPurpose
    data object ListServices : CommandPurpose
    data class ServiceChanged(val displayName: String) : CommandPurpose
    data object ListTasks : CommandPurpose
    data object ListStartup : CommandPurpose
    data class AutorunChanged(val name: String) : CommandPurpose
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
    val services: ServiceListResult? = null,
    val tasks: TaskListResult? = null,
    val startup: StartupListResult? = null,
    val confirmation: Confirmation? = null,
    val confirming: Boolean = false,
    val confirmationProblem: WolfProblem? = null,
    val notice: String? = null,
    val appLockOn: Boolean = false,
)

class AppViewModel(
    private val session: SessionManager,
    private val api: WolfApi,
    private val push: PushRegistrar?,
    private val remoteDesktops: (pcId: String) -> RemoteDesktopController,
) : ViewModel() {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var telemetryJob: Job? = null
    private var controller: PcSessionController? = null
    private var remote: RemoteDesktopController? = null

    /** A notification was tapped before the app knew whether it was signed in. */
    private var alertsRequested = false

    init {
        viewModelScope.launch {
            val restored = session.restore()
            val screen = when {
                session.state.value is SessionState.Locked -> Screen.Locked
                !restored -> Screen.SignIn
                alertsRequested -> Screen.Alerts
                else -> Screen.Pcs
            }
            if (restored) alertsRequested = false
            _state.update { it.copy(screen = screen, appLockOn = session.appLockOn) }
            if (!restored && session.takeLockLoss()) _state.update { it.copy(problem = lockLostProblem(), appLockOn = false) }
            if (restored) {
                loadPcs()
                registerPush()
            }
        }

        // A refresh that the server refuses signs the phone out wherever it happens.
        viewModelScope.launch {
            session.state.collect { state ->
                if (state is SessionState.SignedOut && _state.value.screen !is Screen.SignIn && _state.value.screen !is Screen.Starting) {
                    stopRemote()
                    leavePc()
                    _state.update { UiState(screen = Screen.SignIn, problem = it.problem) }
                }
                if (state is SessionState.Locked && _state.value.screen !is Screen.Locked && _state.value.screen !is Screen.Starting) {
                    // Everything on screen is put away with the credentials: a stream, a PC's details, a list.
                    stopRemote()
                    leavePc()
                    _state.update { UiState(screen = Screen.Locked, appLockOn = true) }
                }
            }
        }
    }

    fun signIn(email: String, password: String) = launchBusy {
        session.signIn(email, password)
        _state.update { it.copy(screen = Screen.Pcs, problem = null) }
        loadPcs()
        registerPush()
        if (alertsRequested) {
            alertsRequested = false
            openAlerts()
        }
    }

    /** From a notification tapped on the phone: the inbox, once signed in. */
    fun openAlertsWhenSignedIn() {
        when (_state.value.screen) {
            Screen.Starting, Screen.SignIn, Screen.Locked -> alertsRequested = true
            else -> openAlerts()
        }
    }

    /** The owner passed the system prompt: open the vault and carry on where the app left off. */
    fun unlock() = launchBusy {
        val restored = try {
            session.unlock()
        } catch (_: VaultLockedException) {
            _state.update { it.copy(problem = stillLockedProblem()) }
            return@launchBusy
        }
        if (!restored) {
            _state.update { it.copy(screen = Screen.SignIn, notice = null) }
            return@launchBusy
        }
        _state.update { it.copy(screen = if (alertsRequested) Screen.Alerts else Screen.Pcs, problem = null, notice = null, appLockOn = session.appLockOn) }
        alertsRequested = false
        loadPcs()
        registerPush()
    }

    /** The prompt was dismissed or could not be shown. Said, and nothing changes. */
    fun lockPromptEnded(reason: String) = _state.update { it.copy(notice = reason) }

    /** Turn the app lock on or off, after the owner confirmed it at the system prompt. */
    fun setAppLock(enabled: Boolean) = launchBusy {
        try {
            session.setAppLock(enabled)
            _state.update {
                it.copy(
                    appLockOn = session.appLockOn,
                    notice = if (enabled) {
                        "App lock is on. WOLF locks when it restarts and after ${SessionManager.LOCK_AFTER_MINUTES} minutes in the background."
                    } else {
                        "App lock is off."
                    },
                )
            }
        } catch (error: java.security.GeneralSecurityException) {
            _state.update { it.copy(problem = lockUnavailableProblem(error.message), appLockOn = session.appLockOn) }
        } catch (error: IllegalStateException) {
            _state.update { it.copy(problem = lockUnavailableProblem(error.message), appLockOn = session.appLockOn) }
        }
    }

    /** Best effort: push is a convenience, and every notification is in the inbox whether it works or not. */
    private fun registerPush() {
        val registrar = push ?: return
        viewModelScope.launch { registrar.sync() }
    }

    fun loadPcs() = launchBusy {
        val pcs = session.authorized { api.listPcs(it) }.pcs
        _state.update { it.copy(pcs = pcs, problem = null) }
    }

    fun openPc(id: String) {
        leavePc()
        controller = PcSessionController(id, api, session)
        _state.update {
            it.copy(screen = Screen.Pc(id), telemetry = null, processes = null, services = null, tasks = null, startup = null, problem = null, notice = null)
        }
        watchTelemetry(id)
    }

    fun back() {
        leavePc()
        _state.update {
            it.copy(screen = Screen.Pcs, telemetry = null, processes = null, services = null, tasks = null, startup = null, problem = null, notice = null, confirmation = null)
        }
        loadPcs()
    }

    fun openAlerts() = openAccountScreen(Screen.Alerts)

    fun openAutomations() = openAccountScreen(Screen.Automations)

    fun openConfiguration() = openAccountScreen(Screen.Configuration)

    /** Back to the PC list from a screen that is about the account rather than one PC. */
    fun home() {
        _state.update { it.copy(screen = Screen.Pcs, problem = null, notice = null) }
        loadPcs()
    }

    private fun openAccountScreen(screen: Screen) {
        leavePc()
        _state.update { it.copy(screen = screen, problem = null, notice = null) }
    }

    fun signOut() = launchBusy {
        stopRemote()
        leavePc()
        // While there is still an access token to clear the registration with: a signed-out phone is not woken.
        push?.unregister()
        session.signOut()
        _state.value = UiState(screen = Screen.SignIn)
    }

    /** The controller for the open remote desktop, if one is open. */
    fun remoteDesktop(): RemoteDesktopController? = remote

    fun openRemoteDesktop(profile: StreamProfile, sound: Boolean) {
        val pcId = (_state.value.screen as? Screen.Pc)?.id ?: return
        telemetryJob?.cancel()
        stopRemote()

        val opened = remoteDesktops(pcId)
        remote = opened
        _state.update { it.copy(screen = Screen.RemoteDesktop(pcId), problem = null, notice = null) }

        viewModelScope.launch {
            try {
                opened.start(profile, sound)
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

    fun openServices() {
        val pcId = (_state.value.screen as? Screen.Pc)?.id ?: return
        telemetryJob?.cancel()
        _state.update { it.copy(screen = Screen.PcServices(pcId), notice = null) }
        if (_state.value.services == null) loadServices()
    }

    fun openAutorun() {
        val pcId = (_state.value.screen as? Screen.Pc)?.id ?: return
        telemetryJob?.cancel()
        _state.update { it.copy(screen = Screen.PcAutorun(pcId), notice = null) }
        if (_state.value.tasks == null || _state.value.startup == null) loadAutorun()
    }

    /** Back to the PC from services or tasks, keeping its session and the lists already read. */
    fun closeTool() {
        val pcId = when (val screen = _state.value.screen) {
            is Screen.PcServices -> screen.pcId
            is Screen.PcAutorun -> screen.pcId
            else -> return
        }
        _state.update { it.copy(screen = Screen.Pc(pcId), notice = null) }
        watchTelemetry(pcId)
    }

    fun loadServices() =
        send(Commands.serviceList(), "List services", "Read the Windows service list from this PC.", CommandPurpose.ListServices)

    fun controlService(row: ServiceRow, action: String) = sendChecked(
        { Commands.serviceControl(row.name, action, row.displayName) },
        "${action.replaceFirstChar { it.uppercase() }} ${row.displayName}",
        if (action == "start") "WOLF will start ${row.displayName} on this PC." else "WOLF will $action ${row.displayName}. Anything depending on it stops too.",
        CommandPurpose.ServiceChanged(row.displayName),
    )

    fun setServiceStartType(row: ServiceRow, startType: String) {
        if (startType == row.startType) return
        val words = PcTools.startType(startType).lowercase()
        sendChecked(
            { Commands.serviceSetStartType(row.name, startType, row.displayName) },
            "Set ${row.displayName} to $words",
            if (startType == "disabled") "${row.displayName} will not start again, including after a restart." else "${row.displayName} will start $words from now on.",
            CommandPurpose.ServiceChanged(row.displayName),
        )
    }

    fun loadAutorun() {
        send(Commands.taskList(), "List scheduled tasks", "Read the scheduled tasks from this PC, hidden ones included.", CommandPurpose.ListTasks)
        send(Commands.startupList(), "List startup items", "Read what runs when somebody signs in to this PC.", CommandPurpose.ListStartup)
    }

    fun controlTask(row: TaskRow, action: String) = sendChecked(
        { Commands.taskControl(row.path, action, row.name) },
        "${action.replaceFirstChar { it.uppercase() }} ${row.name}",
        if (action == "run") {
            "WOLF will ask this PC to run ${row.name} now. What it runs was decided by whoever registered it."
        } else {
            "${row.name} will be ${action}d on this PC."
        },
        CommandPurpose.AutorunChanged(row.name),
    )

    fun setStartupEnabled(row: StartupRow, enabled: Boolean) = sendChecked(
        { Commands.startupSetEnabled(row.name, row.scope, row.source, enabled) },
        "${if (enabled) "Enable" else "Disable"} ${row.name} at sign-in",
        if (enabled) "${row.name} will start again when somebody signs in." else "${row.name} will not start at sign-in. The entry itself stays, so this can be undone.",
        CommandPurpose.AutorunChanged(row.name),
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

    /** A command built from what the PC listed. One the protocol would refuse is not sent, and the owner is told. */
    private fun sendChecked(build: () -> JsonObject, title: String, description: String, purpose: CommandPurpose) {
        val command = try {
            build()
        } catch (error: IllegalArgumentException) {
            _state.update {
                it.copy(
                    problem = WolfProblem(
                        code = "command.invalid",
                        problem = "WOLF cannot send that.",
                        cause = error.message ?: "The item's details are not ones the PC would accept.",
                        currentState = "Nothing was sent to the PC.",
                        recommendedAction = "Refresh the list and try again.",
                        referenceId = "WOLF-CMD-LOCAL",
                    ),
                )
            }
            return
        }
        send(command, title, description, purpose)
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
                CommandPurpose.ListServices -> decoded(command, ServiceListResult.serializer())?.let { result -> _state.update { it.copy(services = result) } }
                is CommandPurpose.ServiceChanged -> {
                    val result = decoded(command, ServiceChangeResult.serializer())
                    // What Windows reports afterwards: a service told to stop that did not is the case this shows.
                    _state.update { it.copy(notice = result?.note ?: "${purpose.displayName} is now ${result?.status ?: "in an unknown state"}.") }
                    loadServices()
                }
                CommandPurpose.ListTasks -> decoded(command, TaskListResult.serializer())?.let { result -> _state.update { it.copy(tasks = result) } }
                CommandPurpose.ListStartup -> decoded(command, StartupListResult.serializer())?.let { result -> _state.update { it.copy(startup = result) } }
                is CommandPurpose.AutorunChanged -> {
                    _state.update { it.copy(notice = "${purpose.name} was changed on this PC.") }
                    loadAutorun()
                }
            }
            // WOLF or Windows refusing on purpose: the product working as designed, so a notice with the
            // reason rather than an error that suggests a retry would work.
            failure != null && failure.limitation && (purpose is CommandPurpose.ServiceChanged || purpose is CommandPurpose.AutorunChanged) ->
                _state.update { it.copy(notice = failure.message ?: failure.code) }
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

    private fun <T> decoded(command: CommandView, serializer: KSerializer<T>): T? {
        val result = command.result
        val value = if (result == null) {
            null
        } else {
            try {
                WolfJson.decodeFromJsonElement(serializer, result)
            } catch (_: SerializationException) {
                null
            } catch (_: IllegalArgumentException) {
                null
            }
        }
        if (value == null) {
            _state.update {
                it.copy(
                    problem = WolfProblem(
                        code = "api.unexpected_response",
                        problem = "The PC answered in a way this app does not understand.",
                        cause = "The command's result did not have the shape this app expects.",
                        currentState = "The list shown may be out of date.",
                        recommendedAction = "Update the app. If it is up to date, report this reference.",
                        referenceId = "WOLF-CMD-${command.id.takeLast(4)}",
                    ),
                )
            }
        }
        return value
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

    private fun lockLostProblem() = WolfProblem(
        code = "auth.lock_reset",
        problem = "WOLF's sign-in on this phone was erased.",
        cause = "The app lock was tied to this phone's screen lock, which has been removed or reset, so nobody can open the sealed sign-in any more.",
        currentState = "You are signed out, and the app lock is off.",
        recommendedAction = "Sign in again, and turn the app lock back on once the phone has a screen lock.",
        referenceId = "WOLF-AUTH-LOCKRESET",
    )

    private fun stillLockedProblem() = WolfProblem(
        code = "auth.still_locked",
        problem = "WOLF is still locked.",
        cause = "The phone did not confirm a strong unlock: a fingerprint or face of the strongest class, or the screen lock's PIN, pattern or password.",
        currentState = "Your sign-in is still on this phone, sealed.",
        recommendedAction = "Unlock again, using the screen lock if a fingerprint or face does not open it.",
        referenceId = "WOLF-AUTH-LOCKED",
    )

    private fun lockUnavailableProblem(detail: String?) = WolfProblem(
        code = "auth.lock_unavailable",
        problem = "The app lock could not be changed.",
        cause = detail?.takeIf { it.isNotBlank() } ?: "The phone's Keystore refused the lock key.",
        currentState = "The app lock is as it was.",
        recommendedAction = "The app lock needs a screen lock on this phone. Set a PIN, pattern or password in Android's settings, then try again.",
        referenceId = "WOLF-AUTH-LOCKKEY",
    )

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
