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

/** The actions this phone builds. Services, scheduled tasks and startup items are built on the web. */
private sealed interface ActionDraft {
    data class Notify(val message: String = "", val severity: String = "info") : ActionDraft
    data class Power(val action: String = "restart", val delaySeconds: String = "60") : ActionDraft
}

private fun <T> List<T>.replaced(index: Int, value: T): List<T> = mapIndexed { at, entry -> if (at == index) value else entry }

@Composable
private fun NewAutomationForm(
    pcs: List<PcSummary>,
    rules: List<AlertRuleView>,
    busy: Boolean,
    created: Int,
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

    LaunchedEffect(created) { if (created > 0) name = "" }

    val useAlertPc = triggerKind == "alert" && alertPc
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
            actions = actions.map { draft ->
                when (draft) {
                    is ActionDraft.Notify -> Automations.notify(draft.message, draft.severity)
                    is ActionDraft.Power -> Automations.power(draft.action, draft.delaySeconds.toIntOrNull() ?: -1)
                }
            },
            targets = if (useAlertPc) Automations.alertPc() else Automations.onPcs(pcIds),
            cooldownMinutes = cooldown.toIntOrNull() ?: 0,
            maxRunsPerDay = maxRuns.toIntOrNull() ?: 0,
        )
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
                        listOf("notify" to "Notify me", "power" to "Power"),
                        selected = { (it == "notify") == (draft is ActionDraft.Notify) },
                        onSelect = { kind ->
                            if ((kind == "notify") != (draft is ActionDraft.Notify)) {
                                actions = actions.replaced(index, if (kind == "notify") ActionDraft.Notify() else ActionDraft.Power())
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
                    }
                    TextButton(onClick = { actions = actions.filterIndexed { at, _ -> at != index } }) { Text("Remove this action") }
                }
            }
            if (actions.size < Automations.MAX_ACTIONS) {
                TextButton(onClick = { actions = actions + ActionDraft.Notify() }) { Text("Add action") }
            }
            Text(
                "Each action waits for the one before it; if one fails, the rest are skipped. Services, scheduled tasks and " +
                    "startup items can be automated from the web dashboard. Forced power actions, and anything that names a " +
                    "process, can never be automated.",
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
