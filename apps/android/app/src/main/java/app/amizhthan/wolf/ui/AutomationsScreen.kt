package app.amizhthan.wolf.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.amizhthan.wolf.api.AlertRuleView
import app.amizhthan.wolf.api.AlertRules
import app.amizhthan.wolf.api.AutomationRunView
import app.amizhthan.wolf.api.AutomationView
import app.amizhthan.wolf.api.Automations
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.PcTools
import kotlinx.serialization.json.JsonObject
import java.time.ZoneId

@Composable
fun AutomationsScreen(
    state: AlertsState,
    onBack: () -> Unit,
    onRunNow: (AutomationView) -> Unit,
    onSetEnabled: (AutomationView, Boolean) -> Unit,
    onToggleHistory: (AutomationView) -> Unit,
    onDelete: (AutomationView) -> Unit,
    onSave: (JsonObject, String) -> Unit,
    onOpenPicker: (pcId: String, kind: String) -> Unit,
    onClosePicker: () -> Unit,
    onDismissProblem: () -> Unit,
) {
    var deleting by remember { mutableStateOf<AutomationView?>(null) }
    val pcName: (String) -> String = { id -> state.pcs.firstOrNull { it.id == id }?.name ?: "a removed PC" }
    // Null until the rules have loaded, so a rule is not called deleted just because the list is not here yet.
    val ruleName: (String) -> String? = { id -> state.rules?.let { rules -> rules.firstOrNull { it.id == id }?.name ?: "a deleted rule" } ?: "an alert rule" }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton(onClick = onBack) { Text("Back") }
            Text("Automations", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                "When something happens, and conditions hold, WOLF does these things. Saving an automation authorizes it: " +
                    "medium-risk actions need a confirmation, high-risk ones your password, and critical actions can never be automated.",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        state.problem?.let { problem -> item { ProblemCard(problem, onDismiss = onDismissProblem) } }
        state.notice?.let { notice -> item { Text(notice, style = MaterialTheme.typography.bodyMedium) } }

        item {
            SectionHeader("Automations") {
                Text(state.automations?.let { "${it.size} of ${state.automationLimit}" }.orEmpty(), style = MaterialTheme.typography.labelMedium)
            }
            when {
                state.automations == null -> Text("Loading…")
                state.automations.isEmpty() -> Text("No automations yet.")
            }
        }

        items(state.automations.orEmpty(), key = { it.id }) { automation ->
            val byHand = Automations.runsByHand(automation.targets)
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(automation.name, fontWeight = FontWeight.SemiBold)
                    Text(
                        listOfNotNull("${automation.authorizedRiskLevel} risk", if (automation.enabled) null else "off").joinToString(" · "),
                        style = MaterialTheme.typography.labelMedium,
                    )
                    Text(Automations.describeTrigger(automation.trigger, ruleName), style = MaterialTheme.typography.bodySmall)
                    Text(
                        automation.actions.joinToString(", then ") { Automations.describeAction(it) } +
                            " · " + Automations.describeTargets(automation.targets, pcName),
                        style = MaterialTheme.typography.bodySmall,
                    )
                    if (automation.conditions.isNotEmpty()) {
                        Text("Only if " + automation.conditions.joinToString(" and ") { Automations.describeCondition(it) }, style = MaterialTheme.typography.bodySmall)
                    }
                    Text(
                        "Last run ${automation.lastRunAt?.let { relative(it) } ?: "never"} · ${automation.cooldownMinutes} min between runs · at most ${automation.maxRunsPerDay} a day",
                        style = MaterialTheme.typography.labelSmall,
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { onRunNow(automation) }, enabled = !state.busy && automation.enabled && byHand, modifier = Modifier.weight(1f)) {
                            Text("Run now")
                        }
                        OutlinedButton(onClick = { onSetEnabled(automation, !automation.enabled) }, enabled = !state.busy, modifier = Modifier.weight(1f)) {
                            Text(if (automation.enabled) "Turn off" else "Turn on")
                        }
                    }
                    if (!byHand) Text("It acts on the PC an alert fired for, so it only runs when that alert does.", style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { onToggleHistory(automation) }) { Text(if (state.expanded == automation.id) "Hide history" else "History") }
                        TextButton(onClick = { deleting = automation }, enabled = !state.busy) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                    if (state.expanded == automation.id) RunHistory(state.runs, pcName)
                }
            }
        }

        item {
            NewAutomationForm(
                pcs = state.pcs,
                rules = state.rules.orEmpty(),
                busy = state.busy,
                created = state.automationsCreated,
                picker = state.picker,
                onOpenPicker = onOpenPicker,
                onClosePicker = onClosePicker,
                onSave = onSave,
            )
        }
    }

    deleting?.let { automation ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete \"${automation.name}\"?") },
            text = { Text("Its run history goes with it.") },
            confirmButton = {
                Button(onClick = {
                    onDelete(automation)
                    deleting = null
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun RunHistory(runs: List<AutomationRunView>?, pcName: (String) -> String) {
    when {
        runs == null -> Text("Loading history…", style = MaterialTheme.typography.bodySmall)
        runs.isEmpty() -> Text("It has not run yet.", style = MaterialTheme.typography.bodySmall)
        else -> runs.take(20).forEach { run ->
            Column(modifier = Modifier.padding(top = 4.dp)) {
                Text(
                    "${run.status} · ${run.triggerKind} · ${run.pcId?.let(pcName) ?: "—"} · ${relative(run.startedAt)}",
                    style = MaterialTheme.typography.labelMedium,
                )
                run.reason?.let { Text(Automations.describeReason(it), style = MaterialTheme.typography.bodySmall) }
                if (run.steps.isNotEmpty()) {
                    Text(run.steps.joinToString("; ") { Automations.describeStep(it) }, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}

/**
 * The actions this phone builds. Services, tasks and startup items are chosen from a PC's own list — the
 * names come from the PC, never typed — and the PC checks them again before it acts.
 */
private sealed interface ActionDraft {
    data class Notify(val message: String = "", val severity: String = "info") : ActionDraft
    data class Power(val action: String = "restart", val delaySeconds: String = "60") : ActionDraft
    data class Service(val name: String = "", val displayName: String = "", val action: String = "restart") : ActionDraft
    data class Task(val path: String = "", val name: String = "", val action: String = "run") : ActionDraft
    data class Startup(val name: String = "", val scope: String = "", val source: String = "", val enabled: Boolean = false) : ActionDraft
}

private val ACTION_KINDS = listOf("notify" to "Notify me", "power" to "Power", "service" to "Service", "task" to "Scheduled task", "startup" to "Startup item")

private fun ActionDraft.kind(): String = when (this) {
    is ActionDraft.Notify -> "notify"
    is ActionDraft.Power -> "power"
    is ActionDraft.Service -> "service"
    is ActionDraft.Task -> "task"
    is ActionDraft.Startup -> "startup"
}

private fun blankDraft(kind: String): ActionDraft = when (kind) {
    "power" -> ActionDraft.Power()
    "service" -> ActionDraft.Service()
    "task" -> ActionDraft.Task()
    "startup" -> ActionDraft.Startup()
    else -> ActionDraft.Notify()
}

private fun ActionDraft.toAction(): JsonObject = when (this) {
    is ActionDraft.Notify -> Automations.notify(message, severity)
    is ActionDraft.Power -> Automations.power(action, delaySeconds.toIntOrNull() ?: -1)
    is ActionDraft.Service -> {
        require(name.isNotEmpty()) { "Choose the service from a PC's list." }
        Automations.serviceControl(name, action, displayName)
    }
    is ActionDraft.Task -> {
        require(path.isNotEmpty()) { "Choose the scheduled task from a PC's list." }
        Automations.taskControl(path, action, name)
    }
    is ActionDraft.Startup -> {
        require(name.isNotEmpty()) { "Choose the startup item from a PC's list." }
        Automations.startupSetEnabled(name, scope, source, enabled)
    }
}

private fun <T> List<T>.replaced(index: Int, value: T): List<T> = mapIndexed { at, entry -> if (at == index) value else entry }

@Composable
private fun NewAutomationForm(
    pcs: List<PcSummary>,
    rules: List<AlertRuleView>,
    busy: Boolean,
    created: Int,
    picker: PickerState?,
    onOpenPicker: (pcId: String, kind: String) -> Unit,
    onClosePicker: () -> Unit,
    onSave: (JsonObject, String) -> Unit,
) {
    val systemZone = remember { ZoneId.systemDefault().id }
    var name by rememberSaveable { mutableStateOf("") }
    var triggerKind by rememberSaveable { mutableStateOf("schedule") }
    var time by rememberSaveable { mutableStateOf("03:00") }
    var days by remember { mutableStateOf(Automations.DAYS) }
    var timeZone by rememberSaveable { mutableStateOf(systemZone) }
    var ruleId by rememberSaveable { mutableStateOf<String?>(null) }
    var on by rememberSaveable { mutableStateOf("fired") }
    var alertPc by rememberSaveable { mutableStateOf(true) }
    var pcIds by remember { mutableStateOf(emptyList<String>()) }
    var noSession by rememberSaveable { mutableStateOf(true) }
    var windowOn by rememberSaveable { mutableStateOf(false) }
    var windowStart by rememberSaveable { mutableStateOf("22:00") }
    var windowEnd by rememberSaveable { mutableStateOf("06:00") }
    var idleOn by rememberSaveable { mutableStateOf(false) }
    var idleBelow by rememberSaveable { mutableStateOf("20") }
    var actions by remember { mutableStateOf<List<ActionDraft>>(listOf(ActionDraft.Notify())) }
    var cooldown by rememberSaveable { mutableStateOf("60") }
    var maxRuns by rememberSaveable { mutableStateOf("4") }
    var pickingFor by remember { mutableStateOf<Int?>(null) }
    var pickerFilter by remember { mutableStateOf("") }

    LaunchedEffect(created) { if (created > 0) name = "" }

    val useAlertPc = triggerKind == "alert" && alertPc
    // The PC to read a list from: the first chosen target, or for "the PC the alert fired for", an online one.
    val listPc = (if (useAlertPc) null else pcIds.firstOrNull()) ?: pcs.firstOrNull { it.status == "online" }?.id ?: pcs.firstOrNull()?.id

    val built = runCatching {
        Automations.definition(
            name = name,
            trigger = when (triggerKind) {
                "schedule" -> Automations.schedule(time, days, timeZone)
                "alert" -> Automations.onAlert(ruleId, on)
                else -> Automations.manual()
            },
            conditions = buildList {
                if (noSession) add(Automations.noActiveSession())
                if (windowOn) add(Automations.timeWindow(windowStart, windowEnd, Automations.DAYS, timeZone))
                if (idleOn) add(Automations.cpuBelow(idleBelow.toDoubleOrNull() ?: Double.NaN))
            },
            actions = actions.map { it.toAction() },
            targets = if (useAlertPc) Automations.alertPc() else Automations.onPcs(pcIds),
            cooldownMinutes = cooldown.toIntOrNull() ?: 0,
            maxRunsPerDay = maxRuns.toIntOrNull() ?: 0,
        )
    }

    fun finishPicking() {
        pickingFor = null
        pickerFilter = ""
        onClosePicker()
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("New automation", fontWeight = FontWeight.SemiBold)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(Automations.MAX_NAME) },
                label = { Text("Name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            FieldLabel("When")
            Choices(
                listOf("schedule" to "On a schedule", "alert" to "When an alert changes", "manual" to "Only when I run it"),
                selected = { it == triggerKind },
                onSelect = { triggerKind = it },
            )
            when (triggerKind) {
                "schedule" -> {
                    OutlinedTextField(
                        value = time,
                        onValueChange = { time = it.take(5) },
                        label = { Text("Time, 24-hour (HH:MM)") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Choices(Automations.DAYS.map { it to it }, selected = { it in days }, onSelect = { day -> days = if (day in days) days - day else days + day })
                    OutlinedTextField(
                        value = timeZone,
                        onValueChange = { timeZone = it.take(64) },
                        label = { Text("Time zone") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                "alert" -> {
                    Choices(listOf<Pair<String?, String>>(null to "Any alert rule") + rules.map { it.id to it.name }, selected = { it == ruleId }, onSelect = { ruleId = it })
                    Choices(listOf("fired" to "fires", "resolved" to "resolves"), selected = { it == on }, onSelect = { on = it })
                }
            }

            FieldLabel("On which PCs")
            if (triggerKind == "alert") CheckRow("The PC the alert fired for", alertPc) { alertPc = it }
            if (!useAlertPc) {
                if (pcs.isEmpty()) Text("No PCs are enrolled.", style = MaterialTheme.typography.bodySmall)
                Choices(pcs.map { it.id to it.name }, selected = { it in pcIds }, onSelect = { id -> pcIds = if (id in pcIds) pcIds - id else pcIds + id })
            }

            FieldLabel("Only if")
            CheckRow("Nobody is connected to the PC", noSession) { noSession = it }
            CheckRow("It is between two times", windowOn) { windowOn = it }
            if (windowOn) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(value = windowStart, onValueChange = { windowStart = it.take(5) }, label = { Text("From") }, singleLine = true, modifier = Modifier.weight(1f))
                    OutlinedTextField(value = windowEnd, onValueChange = { windowEnd = it.take(5) }, label = { Text("Until") }, singleLine = true, modifier = Modifier.weight(1f))
                }
            }
            CheckRow("CPU is below a level", idleOn) { idleOn = it }
            if (idleOn) {
                NumberField("CPU below (%)", idleBelow, { idleBelow = it })
                Text("A PC that is not reporting does not count as idle.", style = MaterialTheme.typography.bodySmall)
            }

            FieldLabel("Do, in order")
            actions.forEachIndexed { index, draft ->
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Choices(
                        ACTION_KINDS,
                        selected = { it == draft.kind() },
                        onSelect = { kind ->
                            if (kind != draft.kind()) {
                                if (pickingFor == index) finishPicking()
                                actions = actions.replaced(index, blankDraft(kind))
                            }
                        },
                    )
                    when (draft) {
                        is ActionDraft.Notify -> {
                            OutlinedTextField(
                                value = draft.message,
                                onValueChange = { actions = actions.replaced(index, draft.copy(message = it.take(200))) },
                                label = { Text("Message") },
                                singleLine = true,
                                modifier = Modifier.fillMaxWidth(),
                            )
                            Choices(AlertRules.SEVERITIES.map { it to it }, selected = { it == draft.severity }, onSelect = { actions = actions.replaced(index, draft.copy(severity = it)) })
                        }
                        is ActionDraft.Power -> {
                            Choices(Commands.POWER_ACTIONS.map { it to it }, selected = { it == draft.action }, onSelect = { actions = actions.replaced(index, draft.copy(action = it)) })
                            NumberField("After (seconds)", draft.delaySeconds, { actions = actions.replaced(index, draft.copy(delaySeconds = it)) })
                        }
                        is ActionDraft.Service -> {
                            Choices(Commands.SERVICE_ACTIONS.map { it to it }, selected = { it == draft.action }, onSelect = { actions = actions.replaced(index, draft.copy(action = it)) })
                            if (draft.name.isNotEmpty()) Text("${draft.displayName} (${draft.name})", fontWeight = FontWeight.Medium)
                        }
                        is ActionDraft.Task -> {
                            Choices(Commands.TASK_ACTIONS.map { it to it }, selected = { it == draft.action }, onSelect = { actions = actions.replaced(index, draft.copy(action = it)) })
                            if (draft.path.isNotEmpty()) Text("${draft.name} (${draft.path})", fontWeight = FontWeight.Medium)
                        }
                        is ActionDraft.Startup -> {
                            Choices(listOf(false to "disable", true to "enable"), selected = { it == draft.enabled }, onSelect = { actions = actions.replaced(index, draft.copy(enabled = it)) })
                            if (draft.name.isNotEmpty()) Text("${draft.name} (${PcTools.source(draft.source)}, ${draft.scope})", fontWeight = FontWeight.Medium)
                        }
                    }

                    if (draft is ActionDraft.Service || draft is ActionDraft.Task || draft is ActionDraft.Startup) {
                        val active = picker?.takeIf { pickingFor == index && it.kind == draft.kind() }
                        if (active == null) {
                            OutlinedButton(
                                onClick = {
                                    listPc?.let { pcId ->
                                        pickingFor = index
                                        pickerFilter = ""
                                        onOpenPicker(pcId, draft.kind())
                                    }
                                },
                                enabled = listPc != null,
                            ) {
                                Text(if (listPc == null) "Enroll a PC to choose from" else "Choose from a PC")
                            }
                        } else {
                            PickerPanel(
                                picker = active,
                                pcs = pcs,
                                filter = pickerFilter,
                                onFilter = { pickerFilter = it },
                                onReadFrom = { pcId -> onOpenPicker(pcId, active.kind) },
                                onPickService = { row ->
                                    actions = actions.replaced(index, ActionDraft.Service(row.name, row.displayName, (draft as? ActionDraft.Service)?.action ?: "restart"))
                                    finishPicking()
                                },
                                onPickTask = { row ->
                                    actions = actions.replaced(index, ActionDraft.Task(row.path, row.name, (draft as? ActionDraft.Task)?.action ?: "run"))
                                    finishPicking()
                                },
                                onPickStartup = { row ->
                                    actions = actions.replaced(index, ActionDraft.Startup(row.name, row.scope, row.source, (draft as? ActionDraft.Startup)?.enabled ?: false))
                                    finishPicking()
                                },
                                onCancel = { finishPicking() },
                            )
                        }
                    }

                    TextButton(onClick = {
                        if (pickingFor == index) finishPicking()
                        actions = actions.filterIndexed { at, _ -> at != index }
                    }) { Text("Remove this action") }
                }
            }
            if (actions.size < Automations.MAX_ACTIONS) {
                TextButton(onClick = { actions = actions + ActionDraft.Notify() }) { Text("Add action") }
            }
            Text(
                "Each action waits for the one before it; if one fails, the rest are skipped. Services, tasks and startup items " +
                    "are chosen from a PC's own list, and each PC checks the name again before acting, so on a PC without it " +
                    "the run fails and says so. Forced power actions, and anything that names a process, can never be automated.",
                style = MaterialTheme.typography.bodySmall,
            )

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NumberField("Minutes between runs", cooldown, { cooldown = it }, Modifier.weight(1f))
                NumberField("Most runs a day", maxRuns, { maxRuns = it }, Modifier.weight(1f))
            }

            if (name.isNotBlank()) {
                built.exceptionOrNull()?.message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            Button(onClick = { built.getOrNull()?.let { onSave(it, name.trim()) } }, enabled = !busy && built.isSuccess, modifier = Modifier.fillMaxWidth()) {
                Text("Save and authorize")
            }
        }
    }
}

@Composable
private fun PickerPanel(
    picker: PickerState,
    pcs: List<PcSummary>,
    filter: String,
    onFilter: (String) -> Unit,
    onReadFrom: (String) -> Unit,
    onPickService: (app.amizhthan.wolf.api.ServiceRow) -> Unit,
    onPickTask: (app.amizhthan.wolf.api.TaskRow) -> Unit,
    onPickStartup: (app.amizhthan.wolf.api.StartupRow) -> Unit,
    onCancel: () -> Unit,
) {
    val term = filter.trim().lowercase()
    val pcName = pcs.firstOrNull { it.id == picker.pcId }?.name ?: "the PC"

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            FieldLabel("Read the list from")
            Choices(pcs.map { it.id to it.name }, selected = { it == picker.pcId }, onSelect = onReadFrom)
            when {
                picker.loading -> Text("Reading the list from $pcName…", style = MaterialTheme.typography.bodySmall)
                picker.unavailableReason != null -> Text(picker.unavailableReason, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                else -> {
                    OutlinedTextField(value = filter, onValueChange = { onFilter(it.take(200)) }, label = { Text("Filter") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    when (picker.kind) {
                        "service" -> picker.services.filter { term.isEmpty() || "${it.name} ${it.displayName}".lowercase().contains(term) }.take(PICK_ROWS).forEach { row ->
                            PickRow(row.displayName, listOfNotNull(row.name, row.status, row.protectedBy?.let(PcTools::protection)).joinToString(" · ")) { onPickService(row) }
                        }
                        "task" -> picker.tasks.filter { term.isEmpty() || row(it.path).contains(term) }.take(PICK_ROWS).forEach { row ->
                            PickRow(row.name, listOfNotNull(row.path, row.protectedBy?.let(PcTools::protection)).joinToString(" · ")) { onPickTask(row) }
                        }
                        else -> picker.startup.filter { term.isEmpty() || it.name.lowercase().contains(term) }.take(PICK_ROWS).forEach { row ->
                            PickRow(row.name, listOfNotNull(PcTools.source(row.source), row.scope, row.protectedBy?.let(PcTools::protection)).joinToString(" · ")) { onPickStartup(row) }
                        }
                    }
                    Text("Showing up to $PICK_ROWS. Filter to find others.", style = MaterialTheme.typography.labelSmall)
                }
            }
            TextButton(onClick = onCancel) { Text("Cancel") }
        }
    }
}

private const val PICK_ROWS = 30

private fun row(value: String) = value.lowercase()

@Composable
private fun PickRow(title: String, detail: String, onPick: () -> Unit) {
    TextButton(onClick = onPick, modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.fillMaxWidth()) {
            Text(title)
            Text(detail, style = MaterialTheme.typography.bodySmall)
        }
    }
}
