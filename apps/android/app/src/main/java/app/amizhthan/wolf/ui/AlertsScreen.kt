package app.amizhthan.wolf.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.ui.platform.LocalContext
import app.amizhthan.wolf.push.PushState
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.amizhthan.wolf.api.AlertRuleInput
import app.amizhthan.wolf.api.AlertRuleView
import app.amizhthan.wolf.api.AlertRules
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.WebhookView
import app.amizhthan.wolf.api.Webhooks
import java.util.Locale

@Composable
fun AlertsScreen(
    state: AlertsState,
    onBack: () -> Unit,
    onMarkRead: (String) -> Unit,
    onMarkAllRead: () -> Unit,
    onSetRuleEnabled: (AlertRuleView, Boolean) -> Unit,
    onDeleteRule: (AlertRuleView) -> Unit,
    onCreateRule: (AlertRuleInput) -> Unit,
    onDismissProblem: () -> Unit,
    onPushChanged: () -> Unit = {},
    webhooks: WebhookActions? = null,
) {
    var deleting by remember { mutableStateOf<AlertRuleView?>(null) }
    val pcName: (String?) -> String = { id -> if (id == null) "every PC" else state.pcs.firstOrNull { it.id == id }?.name ?: "a removed PC" }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton(onClick = onBack) { Text("Back") }
            Text("Alerts", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("Rules are checked once a minute. WOLF does not send e-mail; it can send webhooks, below.", style = MaterialTheme.typography.bodySmall)
        }

        item { PushCard(state.push, onPushChanged) }

        state.problem?.let { problem -> item { ProblemCard(problem, onDismiss = onDismissProblem) } }
        state.notice?.let { notice -> item { Text(notice, style = MaterialTheme.typography.bodyMedium) } }

        item {
            SectionHeader(if (state.unreadCount > 0) "Inbox · ${state.unreadCount} unread" else "Inbox") {
                TextButton(onClick = onMarkAllRead, enabled = state.unreadCount > 0 && !state.busy) { Text("Mark all read") }
            }
            when {
                state.notifications == null -> Text("Loading…")
                state.notifications.isEmpty() -> Text("Nothing yet. When a rule fires or recovers, or an automation reports, it shows up here.")
            }
        }

        items(state.notifications.orEmpty(), key = { it.id }) { entry ->
            val unread = entry.readAt == null
            Card(modifier = Modifier.fillMaxWidth().alpha(if (unread) 1f else 0.65f)) {
                Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.Top) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            AlertRules.label(entry),
                            style = MaterialTheme.typography.labelMedium,
                            color = if (entry.severity == "critical" && entry.kind != "resolved") MaterialTheme.colorScheme.error else Color.Unspecified,
                        )
                        Text(entry.title, fontWeight = FontWeight.SemiBold)
                        if (entry.detail.isNotBlank()) Text(entry.detail, style = MaterialTheme.typography.bodySmall)
                        Text(relative(entry.occurredAt), style = MaterialTheme.typography.labelSmall)
                    }
                    if (unread) TextButton(onClick = { onMarkRead(entry.id) }, enabled = !state.busy) { Text("Mark read") }
                }
            }
        }

        item {
            SectionHeader("Rules") {
                Text(state.rules?.let { "${it.size} of ${state.ruleLimit}" }.orEmpty(), style = MaterialTheme.typography.labelMedium)
            }
            if (state.rules?.isEmpty() == true) Text("No rules. Add one below to be told when something needs attention.")
        }

        items(state.rules.orEmpty(), key = { it.id }) { rule ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(rule.name, fontWeight = FontWeight.SemiBold)
                    Text(listOfNotNull(rule.severity, if (rule.enabled) null else "off").joinToString(" · "), style = MaterialTheme.typography.labelMedium)
                    Text(AlertRules.describe(rule, pcName(rule.pcId)), style = MaterialTheme.typography.bodySmall)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = { onSetRuleEnabled(rule, !rule.enabled) }, enabled = !state.busy) {
                            Text(if (rule.enabled) "Turn off" else "Turn on")
                        }
                        TextButton(onClick = { deleting = rule }, enabled = !state.busy) {
                            Text("Delete", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }

        item { NewRuleForm(pcs = state.pcs, busy = state.busy, created = state.rulesCreated, onCreate = onCreateRule) }

        if (webhooks != null) {
            item { WebhooksSection(state, webhooks) }
        }
    }

    deleting?.let { rule ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete \"${rule.name}\"?") },
            text = { Text("Notifications it already produced are kept.") },
            confirmButton = {
                Button(onClick = {
                    onDeleteRule(rule)
                    deleting = null
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

/**
 * Whether this phone hears about news while WOLF is closed, and what stands in the way if not — in the order the
 * owner can do something about it.
 */
@Composable
private fun PushCard(push: PushState?, onPushChanged: () -> Unit) {
    val context = LocalContext.current
    fun permitted() = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
        context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
    var allowed by remember { mutableStateOf(permitted()) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        allowed = granted
        onPushChanged()
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Notifications on this phone", fontWeight = FontWeight.SemiBold)
            Text(
                when {
                    push == null -> "Checking…"
                    !push.buildConfigured -> "This build of the app has no push service, so news shows only while WOLF is open."
                    push.serverConfigured == null -> "WOLF could not be asked whether it can wake this phone. News is always in the inbox."
                    !push.serverConfigured -> "This WOLF server has no push service configured, so news shows only while WOLF is open."
                    !allowed -> "WOLF can wake this phone, but notifications are not allowed for it."
                    !push.registered -> "This phone is not registered for wake-ups yet."
                    else -> "WOLF wakes this phone when there is news."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            if (push?.buildConfigured == true) {
                Text(
                    "A wake-up goes through Google's push service and says nothing about what happened: no PC, no alert, " +
                        "no count. The phone then fetches the notification from WOLF itself. On the lock screen it shows only that " +
                        "WOLF has something.",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            if (!allowed && push?.buildConfigured == true) {
                OutlinedButton(onClick = { ask.launch(Manifest.permission.POST_NOTIFICATIONS) }) { Text("Allow notifications") }
            }
        }
    }
}

/** What the webhooks section can ask for. */
data class WebhookActions(
    val create: (name: String, url: String, minSeverity: String) -> Unit,
    val setEnabled: (WebhookView, Boolean) -> Unit,
    val setSeverity: (WebhookView, String) -> Unit,
    val test: (WebhookView) -> Unit,
    val rotate: (WebhookView) -> Unit,
    val delete: (WebhookView) -> Unit,
    val dismissSecret: () -> Unit,
)

@Composable
private fun WebhooksSection(state: AlertsState, actions: WebhookActions) {
    val list = state.webhooks
    var name by rememberSaveable(state.webhooksCreated) { mutableStateOf("") }
    // Not saved across process death: a URL may carry a credential of its own.
    var url by remember(state.webhooksCreated) { mutableStateOf("") }
    var severity by rememberSaveable(state.webhooksCreated) { mutableStateOf("warning") }
    var deleting by remember { mutableStateOf<WebhookView?>(null) }

    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SectionHeader("Webhooks") {
            list?.takeIf { it.configured }?.let { Text("${it.webhooks.size} of ${it.limit}", style = MaterialTheme.typography.labelMedium) }
        }

        state.shownSecret?.let { shown ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Signing secret for \"${shown.webhookName}\"", fontWeight = FontWeight.SemiBold)
                    androidx.compose.foundation.text.selection.SelectionContainer { Text(shown.secret, style = MaterialTheme.typography.bodySmall) }
                    Text(
                        "Shown this once. WOLF does not store it; replacing it is the only way to see a secret again. Each request carries " +
                            "WOLF-Signature: t=…,v1=…, an HMAC-SHA256 of the timestamp, a dot and the body.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Button(onClick = actions.dismissSecret) { Text("I have saved it") }
                }
            }
        }

        when {
            list == null -> Text("Loading…")
            !list.configured -> Text(
                "Webhooks are not set up on this WOLF server: it needs a webhook key to keep their addresses encrypted and to sign what it sends.",
                style = MaterialTheme.typography.bodySmall,
            )
            else -> {
                if (list.webhooks.isEmpty()) Text("No webhooks. Add one to send notifications to a chat channel or your own service.")
                list.webhooks.forEach { webhook ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(webhook.name, fontWeight = FontWeight.SemiBold)
                            Text(webhook.host, style = MaterialTheme.typography.labelMedium)
                            Text(
                                "${Webhooks.stateText(webhook)} · sends ${Webhooks.SEVERITIES.first { it.first == webhook.minSeverity }.second.lowercase(Locale.ROOT)}",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                OutlinedButton(onClick = { actions.setEnabled(webhook, !webhook.enabled) }, enabled = !state.busy) {
                                    Text(if (webhook.enabled) "Turn off" else "Turn on")
                                }
                                TextButton(onClick = { actions.test(webhook) }, enabled = !state.busy) { Text("Test") }
                                TextButton(onClick = { actions.rotate(webhook) }, enabled = !state.busy) { Text("New secret") }
                            }
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Webhooks.SEVERITIES.filter { it.first != webhook.minSeverity }.forEach { (id, label) ->
                                    TextButton(onClick = { actions.setSeverity(webhook, id) }, enabled = !state.busy) { Text(label) }
                                }
                            }
                            TextButton(onClick = { deleting = webhook }, enabled = !state.busy) {
                                Text("Delete", color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }

                if (list.webhooks.size < list.limit) {
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("Add a webhook", fontWeight = FontWeight.SemiBold)
                            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("Name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                            OutlinedTextField(value = url, onValueChange = { url = it }, label = { Text("https:// address") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                            Text(
                                "A public https address. WOLF refuses private and local ones, and afterwards shows only the host. Sent: each " +
                                    "notification's title, detail, severity, time and which PC. Adding one needs your password.",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                Webhooks.SEVERITIES.forEach { (id, label) ->
                                    if (id == severity) Button(onClick = {}) { Text(label) } else OutlinedButton(onClick = { severity = id }) { Text(label) }
                                }
                            }
                            Button(onClick = { actions.create(name, url, severity) }, enabled = !state.busy && name.isNotBlank() && url.isNotBlank()) {
                                Text("Add webhook")
                            }
                        }
                    }
                }
            }
        }
    }

    deleting?.let { webhook ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("Delete \"${webhook.name}\"?") },
            text = { Text("WOLF stops sending to ${webhook.host} at once.") },
            confirmButton = {
                Button(onClick = {
                    actions.delete(webhook)
                    deleting = null
                }) { Text("Delete") }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun NewRuleForm(pcs: List<PcSummary>, busy: Boolean, created: Int, onCreate: (AlertRuleInput) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var pcId by rememberSaveable { mutableStateOf<String?>(null) }
    var condition by rememberSaveable { mutableStateOf("metric-above") }
    var metric by rememberSaveable { mutableStateOf("cpu.usage") }
    var seriesKey by rememberSaveable { mutableStateOf("") }
    var threshold by rememberSaveable { mutableStateOf("90") }
    var forMinutes by rememberSaveable { mutableStateOf("10") }
    var severity by rememberSaveable { mutableStateOf("warning") }
    var cooldown by rememberSaveable { mutableStateOf("60") }

    LaunchedEffect(created) { if (created > 0) name = "" }

    val watched = AlertRules.METRICS.firstOrNull { it.id == metric }
    val built = runCatching {
        AlertRules.rule(
            name = name,
            pcId = pcId,
            condition = condition,
            metric = metric,
            threshold = threshold.toDoubleOrNull(),
            seriesKey = seriesKey,
            forMinutes = forMinutes.toIntOrNull() ?: 0,
            severity = severity,
            cooldownMinutes = cooldown.toIntOrNull() ?: 0,
        )
    }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("New rule", fontWeight = FontWeight.SemiBold)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it.take(AlertRules.MAX_NAME) },
                label = { Text("Name") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )

            FieldLabel("PC")
            Choices(listOf<Pair<String?, String>>(null to "Every PC") + pcs.map { it.id to it.name }, selected = { it == pcId }, onSelect = { pcId = it })

            FieldLabel("When")
            Choices(
                listOf("metric-above" to "A metric stays above", "metric-below" to "A metric stays below", "pc-offline" to "The PC is offline"),
                selected = { it == condition },
                onSelect = { condition = it },
            )

            if (condition != "pc-offline") {
                FieldLabel("Metric")
                Choices(AlertRules.METRICS.map { it.id to it.label }, selected = { it == metric }, onSelect = { metric = it })
                NumberField("Threshold (${watched?.unit.orEmpty()})", threshold, { threshold = it })
                watched?.perDevice?.let { hint ->
                    OutlinedTextField(
                        value = seriesKey,
                        onValueChange = { seriesKey = it.take(128) },
                        label = { Text("Only this device (optional)") },
                        placeholder = { Text(hint) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }

            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NumberField("For (minutes)", forMinutes, { forMinutes = it }, Modifier.weight(1f))
                NumberField("Quiet after (minutes)", cooldown, { cooldown = it }, Modifier.weight(1f))
            }

            FieldLabel("Severity")
            Choices(AlertRules.SEVERITIES.map { it to it.replaceFirstChar { c -> c.titlecase(Locale.ROOT) } }, selected = { it == severity }, onSelect = { severity = it })

            Text(
                "A rule fires only when every reading across the whole window crossed the line. If the PC stops " +
                    "reporting, the rule neither fires nor resolves until there is data again.",
                style = MaterialTheme.typography.bodySmall,
            )

            if (name.isNotBlank()) {
                built.exceptionOrNull()?.message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
            Button(onClick = { built.getOrNull()?.let(onCreate) }, enabled = !busy && built.isSuccess, modifier = Modifier.fillMaxWidth()) {
                Text("Add rule")
            }
        }
    }
}
