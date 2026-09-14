package app.amizhthan.wolf.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.amizhthan.wolf.api.LatestTelemetry
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfProblem
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

sealed interface Screen {
    data object Starting : Screen
    data object SignIn : Screen
    data object Pcs : Screen
    data class Pc(val id: String) : Screen
}

data class UiState(
    val screen: Screen = Screen.Starting,
    val busy: Boolean = false,
    val problem: WolfProblem? = null,
    val pcs: List<PcSummary>? = null,
    val telemetry: LatestTelemetry? = null,
)

class AppViewModel(
    private val session: SessionManager,
    private val api: WolfApi,
) : ViewModel() {
    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var telemetryJob: Job? = null

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
                    telemetryJob?.cancel()
                    _state.update { UiState(screen = Screen.SignIn, problem = it.problem) }
                }
            }
        }
    }

    fun signIn(email: String, password: String) = run {
        session.signIn(email, password)
        _state.update { it.copy(screen = Screen.Pcs, problem = null) }
        loadPcs()
    }

    fun loadPcs() = run {
        val pcs = session.authorized { api.listPcs(it) }.pcs
        _state.update { it.copy(pcs = pcs, problem = null) }
    }

    fun openPc(id: String) {
        _state.update { it.copy(screen = Screen.Pc(id), telemetry = null, problem = null) }
        telemetryJob?.cancel()
        telemetryJob = viewModelScope.launch {
            while (isActive) {
                try {
                    val latest = session.authorized { api.latestTelemetry(id, it) }
                    _state.update { it.copy(telemetry = latest, problem = null) }
                } catch (error: WolfApiException) {
                    _state.update { it.copy(problem = error.problem) }
                }
                delay(TELEMETRY_REFRESH_MS)
            }
        }
    }

    fun back() {
        telemetryJob?.cancel()
        _state.update { it.copy(screen = Screen.Pcs, telemetry = null, problem = null) }
        loadPcs()
    }

    fun signOut() = run {
        telemetryJob?.cancel()
        session.signOut()
        _state.value = UiState(screen = Screen.SignIn)
    }

    fun dismissProblem() = _state.update { it.copy(problem = null) }

    private fun run(work: suspend () -> Unit) {
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

    private companion object {
        /** Matches the web dashboard: presence and load change on this scale, not faster. */
        const val TELEMETRY_REFRESH_MS = 10_000L
    }
}
