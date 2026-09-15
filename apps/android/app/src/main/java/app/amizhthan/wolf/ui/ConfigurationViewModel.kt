package app.amizhthan.wolf.ui

import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import app.amizhthan.wolf.api.BackupFileException
import app.amizhthan.wolf.api.ConfigurationBackups
import app.amizhthan.wolf.api.RestorePlan
import app.amizhthan.wolf.api.RestoreRequest
import app.amizhthan.wolf.api.RestoreResult
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfProblem
import app.amizhthan.wolf.session.AccountAuthority
import app.amizhthan.wolf.session.Authorized
import app.amizhthan.wolf.session.PendingAuthority
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.session.SessionState
import app.amizhthan.wolf.storage.DocumentStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.io.IOException

/** A backup fetched and waiting for the owner to choose where it goes. Held in memory, and only until then. */
data class PendingSave(val fileName: String, val text: String, val pickerOpened: Boolean = false)

data class ChosenBackup(val name: String, val backup: JsonObject, val summary: String)

data class ConfigurationState(
    val pendingSave: PendingSave? = null,
    val chosen: ChosenBackup? = null,
    val sections: List<String> = ConfigurationBackups.SECTIONS.map { it.id },
    val enableAutomations: Boolean = false,
    /** What the restore will do, for exactly the sections and choice shown. Cleared when either changes. */
    val plan: RestorePlan? = null,
    val restored: RestorePlan? = null,
    val busy: Boolean = false,
    val problem: WolfProblem? = null,
    val notice: String? = null,
    val pendingAuthority: PendingAuthority? = null,
    val confirming: Boolean = false,
    val authorityProblem: WolfProblem? = null,
)

/**
 * Saving a backup to a file the owner picks, and restoring one — the web dashboard's flow.
 *
 * Backup: fetched first, then the picker, so a failed request never leaves an empty file behind. The
 * backup is only in memory until it is written, and dropped if the owner cancels.
 *
 * Restore: choose a file, choose sections, check what will change, then restore. The restore sends the
 * very request that was previewed, and is authorized like any saved decision: the server names the level
 * — at least medium, high if restored automations will be turned on and one of them needs it.
 */
class ConfigurationViewModel(
    private val session: SessionManager,
    private val api: WolfApi,
    private val documents: DocumentStore,
    private val authority: AccountAuthority = AccountAuthority(api, session),
) : ViewModel() {
    private val _state = MutableStateFlow(ConfigurationState())
    val state: StateFlow<ConfigurationState> = _state.asStateFlow()

    /** The previewed request, repeated unchanged when the owner confirms. */
    private var previewed: RestoreRequest? = null

    init {
        // A chosen file is the owner's configuration; it does not outlive their sign-in.
        viewModelScope.launch {
            session.state.collect { signed ->
                if (signed is SessionState.SignedOut) reset()
            }
        }
    }

    fun prepareBackup() = launchBusy {
        _state.update { it.copy(notice = null, problem = null) }
        val backup = session.authorized { api.configurationBackup(it) }
        _state.update { it.copy(pendingSave = PendingSave(ConfigurationBackups.fileName(backup), ConfigurationBackups.text(backup))) }
    }

    /** The picker is on screen. Recorded so a recreated screen does not open a second one. */
    fun savePickerOpened() = _state.update { it.copy(pendingSave = it.pendingSave?.copy(pickerOpened = true)) }

    fun saveBackup(uri: Uri?) {
        val pending = _state.value.pendingSave ?: return
        _state.update { it.copy(pendingSave = null) }
        if (uri == null) {
            _state.update { it.copy(notice = "Not saved. WOLF keeps no copy, so the backup is gone.") }
            return
        }
        launchBusy {
            try {
                documents.write(uri, pending.text)
                _state.update {
                    it.copy(notice = "Saved ${pending.fileName}. It lists your PCs and what WOLF does to them, so keep it somewhere you trust.")
                }
            } catch (error: IOException) {
                _state.update {
                    it.copy(problem = fileProblem("configuration.save_failed", "The backup could not be saved there.", error, "Nothing was saved, and WOLF keeps no copy.", "Save it again, to another location."))
                }
            }
        }
    }

    fun chooseBackup(uri: Uri?) {
        if (uri == null) return
        previewed = null
        _state.update { it.copy(chosen = null, plan = null, restored = null, notice = null, problem = null) }
        launchBusy {
            try {
                val document = documents.read(uri, ConfigurationBackups.MAX_FILE_BYTES + 1)
                val backup = ConfigurationBackups.parse(document.bytes)
                _state.update { it.copy(chosen = ChosenBackup(document.name, backup, ConfigurationBackups.summary(backup))) }
            } catch (error: BackupFileException) {
                _state.update { it.copy(problem = error.problem) }
            } catch (error: IOException) {
                _state.update {
                    it.copy(problem = fileProblem("configuration.read_failed", "That file could not be opened.", error, "Nothing was changed.", "Choose the file again, or copy it onto this phone first."))
                }
            }
        }
    }

    fun toggleSection(id: String, on: Boolean) = _state.update {
        val sections = ConfigurationBackups.toggle(it.sections, id, on)
        it.copy(sections = sections, enableAutomations = it.enableAutomations && "automations" in sections, plan = null)
    }

    fun setEnableAutomations(on: Boolean) = _state.update { it.copy(enableAutomations = on && "automations" in it.sections, plan = null) }

    fun preview() {
        val current = _state.value
        val chosen = current.chosen ?: return
        val request = RestoreRequest(chosen.backup, current.sections, current.enableAutomations)
        launchBusy {
            val plan = session.authorized { api.previewRestore(request, it) }.plan
            _state.update {
                // The choice changed while the server was answering: that plan describes a different restore.
                if (it.sections != request.sections || it.enableAutomations != request.enableAutomations || it.chosen?.backup !== request.backup) {
                    it
                } else {
                    previewed = request
                    it.copy(plan = plan, restored = null, notice = null, problem = null)
                }
            }
        }
    }

    fun restore() {
        val request = previewed ?: return
        val plan = _state.value.plan ?: return
        launchBusy {
            when (val outcome = authority.attempt(TITLE, ConfigurationBackups.restoreDescription(plan, request.enableAutomations), restoreWith(request))) {
                is Authorized.Done -> finished(outcome.value)
                is Authorized.NeedsConfirmation -> _state.update { it.copy(pendingAuthority = outcome.pending, authorityProblem = null) }
            }
        }
    }

    fun confirmRestore(password: String?) {
        val pending = _state.value.pendingAuthority ?: return
        val request = previewed ?: return
        viewModelScope.launch {
            _state.update { it.copy(confirming = true, authorityProblem = null) }
            try {
                when (val outcome = authority.confirm(pending, password, restoreWith(request))) {
                    is Authorized.Done -> finished(outcome.value)
                    is Authorized.NeedsConfirmation -> _state.update { it.copy(pendingAuthority = outcome.pending) }
                }
            } catch (error: WolfApiException) {
                // The dialog stays open: a mistyped password is corrected, and a refusal is read where it was asked.
                _state.update { it.copy(authorityProblem = error.problem) }
            } catch (error: IllegalArgumentException) {
                _state.update {
                    it.copy(
                        authorityProblem = WolfProblem(
                            code = "authorize.password_required",
                            problem = error.message ?: "Your password is needed.",
                            currentState = "Nothing was restored.",
                            recommendedAction = "Enter your password to confirm.",
                            referenceId = "WOLF-CFG-LOCAL",
                        ),
                    )
                }
            } finally {
                _state.update { it.copy(confirming = false) }
            }
        }
    }

    fun cancelRestore() = _state.update { it.copy(pendingAuthority = null, authorityProblem = null, notice = "Cancelled. Nothing was restored.") }

    fun dismissProblem() = _state.update { it.copy(problem = null, notice = null) }

    /** Leaving the screen forgets the chosen file and any fetched backup. */
    fun reset() {
        previewed = null
        _state.value = ConfigurationState()
    }

    private fun restoreWith(request: RestoreRequest): suspend (String, String?) -> RestoreResult =
        { bearer, confirmed -> api.restoreConfiguration(request.copy(confirmedRiskLevel = confirmed), bearer) }

    private fun finished(result: RestoreResult) {
        previewed = null
        _state.update {
            it.copy(restored = result.plan, plan = null, pendingAuthority = null, authorityProblem = null, notice = "Restored ${relative(result.restoredAt)}.")
        }
    }

    private fun fileProblem(code: String, problem: String, error: IOException, currentState: String, action: String) = WolfProblem(
        code = code,
        problem = problem,
        cause = error.message ?: "The storage provider refused.",
        currentState = currentState,
        recommendedAction = action,
        referenceId = "WOLF-CFG-FILE",
    )

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

    private companion object {
        const val TITLE = "Restore configuration"
    }
}
