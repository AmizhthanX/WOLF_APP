package app.amizhthan.wolf.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.amizhthan.wolf.api.LatestTelemetry
import app.amizhthan.wolf.api.PcSummary
import app.amizhthan.wolf.api.WolfProblem
import java.time.Duration
import java.time.Instant
import java.util.Locale

private const val UNAVAILABLE = "—"

@Composable
fun WolfApp(viewModel: AppViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()

    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Column(modifier = Modifier.safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                state.problem?.let { ProblemCard(it, onDismiss = viewModel::dismissProblem) }

                when (val screen = state.screen) {
                    Screen.Starting -> Centered { CircularProgressIndicator() }
                    Screen.SignIn -> SignInScreen(busy = state.busy, onSignIn = viewModel::signIn)
                    Screen.Pcs -> PcListScreen(
                        pcs = state.pcs,
                        busy = state.busy,
                        onRefresh = viewModel::loadPcs,
                        onOpen = viewModel::openPc,
                        onSignOut = viewModel::signOut,
                    )
                    is Screen.Pc -> {
                        BackHandler(onBack = viewModel::back)
                        PcScreen(
                            pc = state.pcs?.firstOrNull { it.id == screen.id },
                            telemetry = state.telemetry,
                            onBack = viewModel::back,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        content()
    }
}

/** Every failure shows what went wrong, why, what to do, and the reference to quote. */
@Composable
private fun ProblemCard(problem: WolfProblem, onDismiss: () -> Unit) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(problem.problem, fontWeight = FontWeight.SemiBold)
            if (problem.cause.isNotBlank()) Text(problem.cause, style = MaterialTheme.typography.bodySmall)
            if (problem.recommendedAction.isNotBlank()) Text(problem.recommendedAction, style = MaterialTheme.typography.bodySmall)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(problem.referenceId, style = MaterialTheme.typography.labelSmall, modifier = Modifier.weight(1f))
                TextButton(onClick = onDismiss) { Text("Dismiss") }
            }
        }
    }
}

@Composable
private fun SignInScreen(busy: Boolean, onSignIn: (String, String) -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    // Deliberately not saveable: a password is not written into the saved instance state bundle.
    var password by androidx.compose.runtime.remember { mutableStateOf("") }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("WOLF", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("Sign in with your WOLF owner account.", style = MaterialTheme.typography.bodyMedium)
        OutlinedTextField(
            value = email,
            onValueChange = { email = it },
            label = { Text("Email") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth(),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("Password") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
        )
        Button(
            onClick = {
                onSignIn(email, password)
                password = ""
            },
            enabled = !busy && email.isNotBlank() && password.isNotEmpty(),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(if (busy) "Signing in…" else "Sign in")
        }
    }
}

@Composable
private fun PcListScreen(
    pcs: List<PcSummary>?,
    busy: Boolean,
    onRefresh: () -> Unit,
    onOpen: (String) -> Unit,
    onSignOut: () -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(modifier = Modifier.weight(1f)) {
                Text("PCs", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(
                    pcs?.let { list -> "${list.count { it.status == "online" }} of ${list.size} online" } ?: "Loading…",
                    style = MaterialTheme.typography.bodySmall,
                )
            }
            TextButton(onClick = onRefresh, enabled = !busy) { Text("Refresh") }
            TextButton(onClick = onSignOut) { Text("Sign out") }
        }

        if (pcs != null && pcs.isEmpty()) {
            Text("No PCs are enrolled yet. Add one from the web dashboard.")
        }

        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(pcs.orEmpty(), key = { it.id }) { pc ->
                Card(modifier = Modifier.fillMaxWidth().clickable { onOpen(pc.id) }) {
                    Row(modifier = Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(modifier = Modifier.weight(1f)) {
                            Text(pc.name, fontWeight = FontWeight.SemiBold)
                            Text(
                                listOfNotNull(pc.hostname, sessionWords(pc.windowsSessionState)).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Text(if (pc.remoteAccessEnabled) pc.status else "remote access off", style = MaterialTheme.typography.labelMedium)
                    }
                }
            }
        }
    }
}

@Composable
private fun PcScreen(pc: PcSummary?, telemetry: LatestTelemetry?, onBack: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onBack) { Text("Back") }
            Spacer(Modifier.weight(1f))
        }
        Text(pc?.name ?: "PC", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text(listOfNotNull(pc?.status, pc?.lastSeenAt?.let { "seen ${relative(it)}" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall)

        val sample = telemetry?.sample
        when {
            telemetry == null -> Text("Loading live metrics…")
            sample == null && telemetry.pcStatus == "online" -> Text("No telemetry has arrived from this PC yet.")
            sample == null -> Text("This PC is offline, so no live metrics are available.")
            else -> Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Metric("CPU", percent(sample.cpu.usagePercent))
                    Metric(
                        "Memory",
                        "${percent(ratio(sample.memory.usedBytes, sample.memory.totalBytes))} · ${bytes(sample.memory.usedBytes)} of ${bytes(sample.memory.totalBytes)}",
                    )
                    Metric("Uptime", duration(sample.uptimeSeconds))
                    sample.gpus.forEach { gpu ->
                        Metric(gpu.name, "${percent(gpu.usagePercent)} · ${bytes(gpu.vramUsedBytes)} of ${bytes(gpu.vramTotalBytes)}")
                    }
                    sample.disks.forEach { disk ->
                        val used = if (disk.totalBytes != null && disk.freeBytes != null) disk.totalBytes - disk.freeBytes else null
                        Metric("Disk ${disk.volume}", "${percent(ratio(used, disk.totalBytes))} used · ${disk.healthStatus}")
                    }
                    Text("Sampled ${relative(sample.sampledAt)}", style = MaterialTheme.typography.labelSmall)
                }
            }
        }
    }
}

@Composable
private fun Metric(label: String, value: String) {
    Row {
        Text(label, modifier = Modifier.weight(1f))
        Text(value, fontWeight = FontWeight.Medium)
    }
}

internal fun sessionWords(state: String): String? = when (state) {
    "desktop" -> "signed in"
    "locked" -> "locked"
    "login" -> "at the sign-in screen"
    "restarting" -> "restarting"
    else -> null
}

internal fun percent(value: Double?): String = value?.let { String.format(Locale.US, "%.0f%%", it) } ?: UNAVAILABLE

internal fun ratio(part: Double?, whole: Double?): Double? =
    if (part == null || whole == null || whole <= 0) null else part / whole * 100

internal fun bytes(value: Double?): String {
    if (value == null) return UNAVAILABLE
    val units = listOf("B", "KB", "MB", "GB", "TB")
    var amount = value
    var unit = 0
    while (amount >= 1024 && unit < units.size - 1) {
        amount /= 1024
        unit += 1
    }
    return String.format(Locale.US, if (unit == 0) "%.0f %s" else "%.1f %s", amount, units[unit])
}

internal fun duration(seconds: Double?): String {
    if (seconds == null) return UNAVAILABLE
    val total = seconds.toLong()
    val days = total / 86_400
    val hours = (total % 86_400) / 3_600
    val minutes = (total % 3_600) / 60
    return when {
        days > 0 -> "${days}d ${hours}h"
        hours > 0 -> "${hours}h ${minutes}m"
        else -> "${minutes}m"
    }
}

internal fun relative(iso: String, now: Instant = Instant.now()): String {
    val then = runCatching { Instant.parse(iso) }.getOrNull() ?: return "at an unknown time"
    val seconds = Duration.between(then, now).seconds
    return when {
        seconds < 45 -> "just now"
        seconds < 3_600 -> "${seconds / 60} min ago"
        seconds < 86_400 -> "${seconds / 3_600} h ago"
        else -> "${seconds / 86_400} d ago"
    }
}
