package app.amizhthan.wolf.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.amizhthan.wolf.api.AlertRuleInput
import app.amizhthan.wolf.api.AlertRuleView
import app.amizhthan.wolf.api.AutomationRunView
import app.amizhthan.wolf.api.AutomationView
import app.amizhthan.wolf.api.Automations
import app.amizhthan.wolf.api.NotificationView
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfProblem
import app.amizhthan.wolf.session.AccountAuthority
import app.amizhthan.wolf.session.Authorized
import app.amizhthan.wolf.session.PendingAuthority
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
import kotlinx.serialization.json.JsonObject

/** A question for the owner, with the save to repeat at the level they confirm and what to do once it is saved. */
data class AuthorityRequest(
    val pending: PendingAuthority,
    val save: suspend (bearer: String, confirmedRiskLevel: String?) -> Unit,
    val onSaved: (AlertsState) -> AlertsState,
)

data class AlertsState(
    val notifications: List<NotificationView>? = null,
    val unreadCount: Int = 0,
    val rules: List<AlertRuleView>? = null,
    val ruleLimit: Int = 0,
    val automations: List<AutomationView>? = null,
    val automationLimit: Int = 0,
    val pcs: List<PcSummary> = emptyList(),
    /** The automation whose run history is open, and that history. */
    val expanded: String? = null,
    val runs: List<AutomationRunView>? = null,
    /** Counted so a form clears itself only after the server accepted what it sent. */
    val rulesCreated: Int = 0,
    val automationsCreated: Int = 0,
    val busy: Boolean = false,
    val problem: WolfProblem? = null,
    val notice: String? = null,
    val authority: AuthorityRequest? = null,
    val confirming: Boolean = false,
    val authorityProblem: WolfProblem? = null,
)

/**
 * Alert rules, the inbox and automations. Account-wide, so kept apart from the PC screen and its session:
 * none of this opens a session on any PC.
 *
 * Lists refresh every 30 seconds while a screen showing them is open — the web dashboard's pace — and a
 * run's history every 3 seconds while it is open. Nothing is polled in the background: WOLF has no push
 * notifications yet, and a phone that woke itself to poll would be pretending to have them.
 */
class AlertsAutomationsViewModel(
    private val session: SessionManager,
    private val api: WolfApi,
    private val authority: AccountAuthority = AccountAuthority(api, session),
) : ViewModel() {
    private val _state = MutableStateFlow(AlertsState())
    val state: StateFlow<AlertsState> = _state.asStateFlow()

    private var watchJob: Job? = null
    private var runsJob: Job? = null

    init {
        // Another account's rules must not survive a sign-out on screen.
        viewModelScope.launch {
            session.state.collect { signed ->
                if (signed is SessionState.SignedOut) {
                    watchJob?.cancel()
                    runsJob?.cancel()
                    _state.value = AlertsState()
                }
            }
        }
    }

    fun watch() {
        watchJob?.cancel()
        watchJob = viewModelScope.launch {
            while (isActive) {
                load()
                delay(REFRESH_MS)
            }
        }
    }

    fun stopWatching() {
        watchJob?.cancel()
        watchJob = null
        runsJob?.cancel()
        runsJob = null
        _state.update { it.copy(expanded = null, runs = null, notice = null, problem = null) }
    }

    /** The unread count for the PC list. */
    fun refreshUnread() {
        viewModelScope.launch {
            try {
                val inbox = session.authorized { api.listNotifications(it) }
                _state.update { it.copy(notifications = inbox.notifications, unreadCount = inbox.unreadCount) }
            } catch (_: WolfApiException) {
                // The PC list reports the connection problem itself; the count stays at what was last read.
            }
        }
    }

    fun markRead(notificationId: String) = act { session.authorized { api.markNotificationRead(notificationId, it) } }

    fun markAllRead() = act { session.authorized { api.markAllNotificationsRead(it) } }

    fun setRuleEnabled(rule: AlertRuleView, enabled: Boolean) =
        act(if (enabled) "\"${rule.name}\" is on." else "\"${rule.name}\" is off. It will not notify until it is turned back on.") {
            session.authorized { api.setAlertRuleEnabled(rule.id, enabled, it) }
        }

    fun deleteRule(rule: AlertRuleView) = act("Deleted \"${rule.name}\". Notifications it already produced are kept.") {
        session.authorized { api.deleteAlertRule(rule.id, it) }
    }

    fun createRule(input: AlertRuleInput) = act("Added \"${input.name}\".") {
        session.authorized { api.createAlertRule(input, it) }
        _state.update { it.copy(rulesCreated = it.rulesCreated + 1) }
    }

    /** On the authority it was saved with — the server asks for nothing more, and it can do nothing a scheduled run could not. */
    fun runNow(automation: AutomationView) = act("Started \"${automation.name}\". Its history shows how it goes.") {
        session.authorized { api.runAutomation(automation.id, it) }
        showHistory(automation.id)
    }

    fun setAutomationEnabled(automation: AutomationView, enabled: Boolean) {
        if (!enabled) {
            // Turning off cannot make it do more, so the server asks for no authority.
            act("\"${automation.name}\" is off.") {
                session.authorized { api.updateAutomation(automation.id, Automations.enabledPatch(false), null, it) }
            }
        } else {
            authorize(
                "Turn on \"${automation.name}\"",
                { bearer, confirmed -> api.updateAutomation(automation.id, Automations.enabledPatch(true), confirmed, bearer) },
            ) { it.copy(notice = "\"${automation.name}\" is on.") }
        }
    }

    fun deleteAutomation(automation: AutomationView) = act("Deleted \"${automation.name}\" and its run history.") {
        session.authorized { api.deleteAutomation(automation.id, it) }
        if (_state.value.expanded == automation.id) closeHistory()
    }

    fun save(definition: JsonObject, name: String) = authorize(
        "Authorize \"$name\"",
        { bearer, confirmed -> api.createAutomation(definition, confirmed, bearer) },
    ) { it.copy(automationsCreated = it.automationsCreated + 1, notice = "Saved and authorized \"$name\".") }

    fun toggleHistory(automation: AutomationView) {
        if (_state.value.expanded == automation.id) closeHistory() else showHistory(automation.id)
    }

    fun confirmAuthority(password: String?) {
        val request = _state.value.authority ?: return
        viewModelScope.launch {
            _state.update { it.copy(confirming = true, authorityProblem = null) }
            try {
                when (val outcome = authority.confirm(request.pending, password, request.save)) {
                    is Authorized.Done -> {
                        _state.update { it.copy(authority = null) }
                        saved(request.onSaved)
                    }
                    // The server named a higher level than the one confirmed: ask again, at that level.
                    is Authorized.NeedsConfirmation -> _state.update { it.copy(authority = request.copy(pending = outcome.pending)) }
                }
            } catch (error: WolfApiException) {
                // The dialog stays open: a mistyped password is corrected, not restarted.
                _state.update { it.copy(authorityProblem = error.problem) }
            } catch (error: IllegalArgumentException) {
                _state.update {
                    it.copy(
                        authorityProblem = WolfProblem(
                            code = "authorize.password_required",
                            problem = error.message ?: "Your password is needed.",
                            currentState = "Nothing was saved.",
                            recommendedAction = "Enter your password to confirm.",
                            referenceId = "WOLF-AUTO-LOCAL",
                        ),
                    )
                }
            } finally {
                _state.update { it.copy(confirming = false) }
            }
        }
    }

    fun cancelAuthority() = _state.update { it.copy(authority = null, authorityProblem = null, notice = "Cancelled. Nothing was saved.") }

    fun dismissProblem() = _state.update { it.copy(problem = null, notice = null) }

    private fun authorize(
        title: String,
        save: suspend (bearer: String, confirmedRiskLevel: String?) -> Unit,
        onSaved: (AlertsState) -> AlertsState,
    ) = launchBusy {
        _state.update { it.copy(notice = null) }
        when (val outcome = authority.attempt(title, DESCRIPTION, save)) {
            is Authorized.Done -> saved(onSaved)
            is Authorized.NeedsConfirmation -> _state.update {
                it.copy(authority = AuthorityRequest(outcome.pending, save, onSaved), authorityProblem = null)
            }
        }
    }

    private suspend fun saved(onSaved: (AlertsState) -> AlertsState) {
        _state.update(onSaved)
        load()
    }

    private fun showHistory(automationId: String) {
        runsJob?.cancel()
        _state.update { it.copy(expanded = automationId, runs = null) }
        runsJob = viewModelScope.launch {
            while (isActive) {
                try {
                    val runs = session.authorized { api.automationRuns(automationId, it) }.runs
                    _state.update { if (it.expanded == automationId) it.copy(runs = runs) else it }
                } catch (error: WolfApiException) {
                    _state.update { it.copy(problem = error.problem, runs = it.runs ?: emptyList()) }
                    return@launch
                }
                delay(RUNS_REFRESH_MS)
            }
        }
    }

    private fun closeHistory() {
        runsJob?.cancel()
        runsJob = null
        _state.update { it.copy(expanded = null, runs = null) }
    }

    private suspend fun load() {
        try {
            val inbox = session.authorized { api.listNotifications(it) }
            val rules = session.authorized { api.listAlertRules(it) }
            val automations = session.authorized { api.listAutomations(it) }
            val pcs = session.authorized { api.listPcs(it) }.pcs
            _state.update {
                it.copy(
                    notifications = inbox.notifications,
                    unreadCount = inbox.unreadCount,
                    rules = rules.rules,
                    ruleLimit = rules.limit,
                    automations = automations.automations,
                    automationLimit = automations.limit,
                    pcs = pcs,
                )
            }
        } catch (error: WolfApiException) {
            _state.update { it.copy(problem = error.problem) }
        }
    }

    private fun act(notice: String? = null, work: suspend () -> Unit) = launchBusy {
        _state.update { it.copy(notice = null) }
        work()
        _state.update { it.copy(notice = notice, problem = null) }
        load()
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

    override fun onCleared() {
        watchJob?.cancel()
        runsJob?.cancel()
    }

    private companion object {
        const val REFRESH_MS = 30_000L
        const val RUNS_REFRESH_MS = 3_000L
        const val DESCRIPTION = "WOLF will act on this decision later, when nobody is watching."
    }
}
