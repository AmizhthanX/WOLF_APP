package app.amizhthan.wolf.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.PcTools
import app.amizhthan.wolf.api.ServiceRow
import app.amizhthan.wolf.api.StartupRow
import app.amizhthan.wolf.api.TaskRow

/** A phone list shows this many at once; a filter finds the rest. */
private const val MAX_ROWS = 150

/**
 * Windows services on the PC. On the command path, so every change is classified for risk, confirmed at
 * the level the server names, and audited — the same as from the web dashboard.
 */
@Composable
fun ServicesScreen(
    pc: PcSummary?,
    state: UiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onControl: (ServiceRow, String) -> Unit,
    onSetStartType: (ServiceRow, String) -> Unit,
) {
    var search by rememberSaveable { mutableStateOf("") }
    var choosingStartType by remember { mutableStateOf<String?>(null) }
    val result = state.services
    val term = search.trim().lowercase()
    val matching = result?.services.orEmpty().filter { term.isEmpty() || "${it.name} ${it.displayName}".lowercase().contains(term) }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton(onClick = onBack) { Text("Back") }
            Text("Services", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(pc?.name.orEmpty(), style = MaterialTheme.typography.bodySmall)
            state.notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }

        item { FilterRow(search, { search = it }, state.busy, onRefresh) }

        when {
            result == null -> item { Text(if (state.busy) "Reading the service list…" else "No service list has been read yet.") }
            !result.helperAvailable -> item { Unavailable("WOLF cannot read this PC's services.", result.unavailableReason ?: PcTools.HELPER_MISSING) }
            matching.isEmpty() -> item { Text(if (result.services.isEmpty()) "The PC listed no services." else "No service matches that filter.") }
        }

        items(matching.take(MAX_ROWS)) { row ->
            ServiceCard(
                row = row,
                busy = state.busy,
                choosingStartType = choosingStartType == row.name,
                onToggleStartType = { choosingStartType = if (choosingStartType == row.name) null else row.name },
                onControl = onControl,
                onSetStartType = { service, startType ->
                    choosingStartType = null
                    onSetStartType(service, startType)
                },
            )
        }
        if (matching.size > MAX_ROWS) item { Text("Showing $MAX_ROWS of ${matching.size}. Filter to find the rest.", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun ServiceCard(
    row: ServiceRow,
    busy: Boolean,
    choosingStartType: Boolean,
    onToggleStartType: () -> Unit,
    onControl: (ServiceRow, String) -> Unit,
    onSetStartType: (ServiceRow, String) -> Unit,
) {
    // Boot and system start types belong to drivers that load before the service control manager exists.
    val settable = row.protectedBy == null && row.startType != null && row.startType in Commands.SERVICE_START_TYPES
    val stoppable = row.protectedBy == null && row.canStop

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.displayName, fontWeight = FontWeight.SemiBold)
            Text(listOfNotNull(row.name, row.account).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            Text("${row.status} · starts ${PcTools.startType(row.startType).lowercase()}", style = MaterialTheme.typography.labelMedium)
            row.protectedBy?.let { Text(PcTools.protection(it), style = MaterialTheme.typography.bodySmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                if (row.status == "running") {
                    OutlinedButton(onClick = { onControl(row, "restart") }, enabled = !busy && stoppable) { Text("Restart") }
                    OutlinedButton(onClick = { onControl(row, "stop") }, enabled = !busy && stoppable) { Text("Stop") }
                } else {
                    OutlinedButton(onClick = { onControl(row, "start") }, enabled = !busy) { Text("Start") }
                }
                if (settable) TextButton(onClick = onToggleStartType, enabled = !busy) { Text("Start type") }
            }
            if (row.status == "running" && row.protectedBy == null && !row.canStop) {
                Text("Windows says this service does not accept a stop.", style = MaterialTheme.typography.bodySmall)
            }
            if (choosingStartType && settable) {
                Choices(Commands.SERVICE_START_TYPES.map { it to PcTools.startType(it) }, selected = { it == row.startType }, onSelect = { onSetStartType(row, it) })
            }
        }
    }
}

/**
 * What the PC does on its own. WOLF can turn these off and on; it cannot create or remove either, because
 * those are how Windows persistence is installed.
 */
@Composable
fun AutorunScreen(
    pc: PcSummary?,
    state: UiState,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    onControlTask: (TaskRow, String) -> Unit,
    onSetStartupEnabled: (StartupRow, Boolean) -> Unit,
) {
    var search by rememberSaveable { mutableStateOf("") }
    val term = search.trim().lowercase()
    val tasks = state.tasks
    val startup = state.startup
    val matchingStartup = startup?.entries.orEmpty().filter { term.isEmpty() || "${it.name} ${it.command.orEmpty()}".lowercase().contains(term) }
    val matchingTasks = tasks?.tasks.orEmpty().filter { term.isEmpty() || "${it.path} ${it.actions.joinToString(" ")}".lowercase().contains(term) }
    val unavailable = listOfNotNull(
        tasks?.takeIf { !it.helperAvailable }?.let { it.unavailableReason ?: PcTools.HELPER_MISSING },
        startup?.takeIf { !it.helperAvailable }?.let { it.unavailableReason ?: PcTools.HELPER_MISSING },
    ).distinct()

    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton(onClick = onBack) { Text("Back") }
            Text("Tasks & startup", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(pc?.name.orEmpty(), style = MaterialTheme.typography.bodySmall)
            Text(
                "WOLF can turn these off and on. It cannot create a scheduled task or add a startup entry, and it cannot " +
                    "delete either: those are how Windows persistence is installed. Disabling a startup entry leaves it in place, so it can be put back.",
                style = MaterialTheme.typography.bodySmall,
            )
            state.notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }

        item { FilterRow(search, { search = it }, state.busy, onRefresh) }
        unavailable.forEach { reason -> item { Unavailable("WOLF cannot read what this PC runs on its own.", reason) } }

        item {
            SectionHeader("Startup items") { Text(startup?.let { "${it.entries.size}" }.orEmpty(), style = MaterialTheme.typography.labelMedium) }
            when {
                startup == null -> Text(if (state.busy) "Reading…" else "Nothing has been read yet.")
                startup.helperAvailable && matchingStartup.isEmpty() -> Text(if (startup.entries.isEmpty()) "Nothing runs at sign-in." else "Nothing matches that filter.")
            }
        }
        items(matchingStartup.take(MAX_ROWS)) { row -> StartupCard(row, state.busy, onSetStartupEnabled) }

        item {
            SectionHeader("Scheduled tasks") { Text(tasks?.let { "${it.tasks.size}" }.orEmpty(), style = MaterialTheme.typography.labelMedium) }
            when {
                tasks == null -> Text(if (state.busy) "Reading…" else "Nothing has been read yet.")
                tasks.helperAvailable && matchingTasks.isEmpty() -> Text(if (tasks.tasks.isEmpty()) "The PC listed no scheduled tasks." else "No task matches that filter.")
            }
            if (tasks?.truncated == true) Text("The PC returned only part of its task list.", style = MaterialTheme.typography.bodySmall)
        }
        items(matchingTasks.take(MAX_ROWS)) { row -> TaskCard(row, state.busy, onControlTask) }
        if (matchingTasks.size > MAX_ROWS) item { Text("Showing $MAX_ROWS of ${matchingTasks.size} tasks. Filter to find the rest.", style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun StartupCard(row: StartupRow, busy: Boolean, onSetEnabled: (StartupRow, Boolean) -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.name, fontWeight = FontWeight.SemiBold)
            Text("${PcTools.source(row.source)} · ${row.user ?: if (row.scope == "machine") "everyone" else "this user"}", style = MaterialTheme.typography.bodySmall)
            row.command?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis) }
            row.protectedBy?.let { Text(PcTools.protection(it), style = MaterialTheme.typography.bodySmall) }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (row.enabled) "runs at sign-in" else "turned off", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                OutlinedButton(onClick = { onSetEnabled(row, !row.enabled) }, enabled = !busy && !(row.protectedBy != null && row.enabled)) {
                    Text(if (row.enabled) "Disable" else "Enable")
                }
            }
        }
    }
}

@Composable
private fun TaskCard(row: TaskRow, busy: Boolean, onControl: (TaskRow, String) -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.name, fontWeight = FontWeight.SemiBold)
            Text(row.path, style = MaterialTheme.typography.bodySmall)
            // What it runs is the first thing anybody investigating a machine reads.
            row.actions.firstOrNull()?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            row.protectedBy?.let { Text(PcTools.protection(it), style = MaterialTheme.typography.bodySmall) }
            Text(
                listOfNotNull(
                    if (row.enabled) row.state else "disabled",
                    row.lastRunAt?.let(PcTools::localTime)?.let { "last run $it" },
                    row.lastResult.takeIf { it != 0 }?.let { "exit $it" },
                    row.nextRunAt?.let(PcTools::localTime)?.let { "next $it" },
                ).joinToString(" · "),
                style = MaterialTheme.typography.labelMedium,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { onControl(row, "run") }, enabled = !busy) { Text("Run") }
                OutlinedButton(onClick = { onControl(row, if (row.enabled) "disable" else "enable") }, enabled = !busy && !(row.protectedBy != null && row.enabled)) {
                    Text(if (row.enabled) "Disable" else "Enable")
                }
            }
        }
    }
}

@Composable
private fun FilterRow(search: String, onSearch: (String) -> Unit, busy: Boolean, onRefresh: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(value = search, onValueChange = { onSearch(it.take(200)) }, label = { Text("Filter") }, singleLine = true, modifier = Modifier.weight(1f))
        TextButton(onClick = onRefresh, enabled = !busy) { Text(if (busy) "Reading…" else "Refresh") }
    }
}

/** An empty list with a reason is not an empty list: every Windows machine has services and tasks. */
@Composable
internal fun Unavailable(title: String, reason: String) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold)
            Text(reason, style = MaterialTheme.typography.bodySmall)
        }
    }
}
