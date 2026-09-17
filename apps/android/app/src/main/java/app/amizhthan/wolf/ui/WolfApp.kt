package app.amizhthan.wolf.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
import app.amizhthan.wolf.api.ProcessRow
import app.amizhthan.wolf.api.Wake
import app.amizhthan.wolf.api.WolfProblem
import app.amizhthan.wolf.remote.StreamProfile
import java.time.Duration
import java.time.Instant
import java.util.Locale

private const val UNAVAILABLE = "—"

/** The web dashboard's power actions, with the same words. */
private data class PowerAction(val action: String, val label: String, val description: String, val danger: Boolean = false)

private val POWER_ACTIONS = listOf(
    PowerAction("lock", "Lock", "Lock the Windows session on this PC."),
    PowerAction("sign-out", "Sign out", "Sign the current user out of Windows."),
    PowerAction("sleep", "Sleep", "Put this PC to sleep."),
    PowerAction("hibernate", "Hibernate", "Hibernate this PC."),
    PowerAction("restart", "Restart", "Restart Windows on this PC.", danger = true),
    PowerAction("shutdown", "Shut down", "Shut this PC down.", danger = true),
)

@Composable
fun WolfApp(
    viewModel: AppViewModel,
    alerts: AlertsAutomationsViewModel,
    configuration: ConfigurationViewModel,
    onUnlock: () -> Unit = {},
    onAppLock: (Boolean) -> Unit = {},
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val alertsState by alerts.state.collectAsStateWithLifecycle()
    val configurationState by configuration.state.collectAsStateWithLifecycle()

    MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
        Surface(modifier = Modifier.fillMaxSize()) {
            // The stream is the whole screen, edge to edge, without the padding and safe-area margins every other
            // screen keeps.
            val streamScreen = state.screen as? Screen.RemoteDesktop
            if (streamScreen != null) {
                BackHandler(onBack = viewModel::closeRemoteDesktop)
                viewModel.remoteDesktop()?.let { RemoteDesktopScreen(it, onClose = viewModel::closeRemoteDesktop) }
            } else Column(modifier = Modifier.safeDrawingPadding().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                state.problem?.let { ProblemCard(it, onDismiss = viewModel::dismissProblem) }

                when (val screen = state.screen) {
                    Screen.Starting -> Centered { CircularProgressIndicator() }
                    Screen.SignIn -> SignInScreen(busy = state.busy, onSignIn = viewModel::signIn)
                    Screen.Locked -> LockedScreen(busy = state.busy, notice = state.notice, onUnlock = onUnlock)
                    Screen.Pcs -> {
                        // Rules fire whether or not their screen is open; the count on this one is how the owner hears of it.
                        LaunchedEffect(Unit) { alerts.refreshUnread() }
                        PcListScreen(
                            pcs = state.pcs,
                            busy = state.busy,
                            unreadCount = alertsState.unreadCount,
                            onRefresh = {
                                viewModel.loadPcs()
                                alerts.refreshUnread()
                            },
                            onOpen = viewModel::openPc,
                            onAlerts = viewModel::openAlerts,
                            onAutomations = viewModel::openAutomations,
                            onConfiguration = viewModel::openConfiguration,
                            onSignOut = viewModel::signOut,
                            appLockOn = state.appLockOn,
                            notice = state.notice,
                            onAppLock = onAppLock,
                        )
                    }
                    is Screen.Pc -> {
                        BackHandler(onBack = viewModel::back)
                        PcScreen(
                            pc = state.pcs?.firstOrNull { it.id == screen.id },
                            state = state,
                            onBack = viewModel::back,
                            onPower = viewModel::power,
                            onLoadProcesses = viewModel::loadProcesses,
                            onTerminate = viewModel::terminate,
                            onRemoteDesktop = viewModel::openRemoteDesktop,
                            onServices = viewModel::openServices,
                            onAutorun = viewModel::openAutorun,
                            onWake = viewModel::wake,
                        )
                    }
                    is Screen.PcServices -> {
                        BackHandler(onBack = viewModel::closeTool)
                        ServicesScreen(
                            pc = state.pcs?.firstOrNull { it.id == screen.pcId },
                            state = state,
                            onBack = viewModel::closeTool,
                            onRefresh = viewModel::loadServices,
                            onControl = viewModel::controlService,
                            onSetStartType = viewModel::setServiceStartType,
                        )
                    }
                    is Screen.PcAutorun -> {
                        BackHandler(onBack = viewModel::closeTool)
                        AutorunScreen(
                            pc = state.pcs?.firstOrNull { it.id == screen.pcId },
                            state = state,
                            onBack = viewModel::closeTool,
                            onRefresh = viewModel::loadAutorun,
                            onControlTask = viewModel::controlTask,
                            onSetStartupEnabled = viewModel::setStartupEnabled,
                        )
                    }
                    // Drawn full screen above, outside this padded column.
                    is Screen.RemoteDesktop -> Unit
                    Screen.Alerts -> {
                        BackHandler(onBack = viewModel::home)
                        DisposableEffect(Unit) {
                            alerts.watch()
                            onDispose { alerts.stopWatching() }
                        }
                        AlertsScreen(
                            state = alertsState,
                            onBack = viewModel::home,
                            onMarkRead = alerts::markRead,
                            onMarkAllRead = alerts::markAllRead,
                            onSetRuleEnabled = alerts::setRuleEnabled,
                            onDeleteRule = alerts::deleteRule,
                            onCreateRule = alerts::createRule,
                            onDismissProblem = alerts::dismissProblem,
                            onPushChanged = alerts::refreshPush,
                            webhooks = WebhookActions(
                                create = alerts::createWebhook,
                                setEnabled = alerts::setWebhookEnabled,
                                setSeverity = alerts::setWebhookSeverity,
                                test = alerts::testWebhook,
                                rotate = alerts::rotateWebhookSecret,
                                delete = alerts::deleteWebhook,
                                dismissSecret = alerts::dismissSecret,
                            ),
                        )
                    }
                    Screen.Automations -> {
                        BackHandler(onBack = viewModel::home)
                        DisposableEffect(Unit) {
                            alerts.watch()
                            onDispose { alerts.stopWatching() }
                        }
                        AutomationsScreen(
                            state = alertsState,
                            onBack = viewModel::home,
                            onRunNow = alerts::runNow,
                            onSetEnabled = alerts::setAutomationEnabled,
                            onToggleHistory = alerts::toggleHistory,
                            onDelete = alerts::deleteAutomation,
                            onSave = alerts::save,
                            onOpenPicker = alerts::openPicker,
                            onClosePicker = alerts::closePicker,
                            onDismissProblem = alerts::dismissProblem,
                        )
                    }
                    Screen.Configuration -> {
                        val leave = {
                            configuration.reset()
                            viewModel.home()
                        }
                        BackHandler(onBack = leave)
                        ConfigurationScreen(
                            state = configurationState,
                            onBack = leave,
                            onPrepareBackup = configuration::prepareBackup,
                            onSavePickerOpened = configuration::savePickerOpened,
                            onSaveBackup = configuration::saveBackup,
                            onChooseBackup = configuration::chooseBackup,
                            onToggleSection = configuration::toggleSection,
                            onEnableAutomations = configuration::setEnableAutomations,
                            onPreview = configuration::preview,
                            onRestore = configuration::restore,
                            onDismissProblem = configuration::dismissProblem,
                        )
                    }
                }
            }

            state.confirmation?.let { confirmation ->
                ConfirmDialog(
                    title = confirmation.pending.title,
                    description = confirmation.pending.description,
                    riskLevel = confirmation.pending.riskLevel,
                    requiresPassword = confirmation.pending.requiresPassword,
                    busy = state.confirming,
                    problem = state.confirmationProblem,
                    onCancel = viewModel::cancelConfirmation,
                    onConfirm = viewModel::confirm,
                )
            }

            alertsState.authority?.let { request ->
                val pending = request.pending
                ConfirmDialog(
                    title = pending.title,
                    description = pending.description +
                        if (pending.requiresPassword) " Because it is ${pending.riskLevel} risk, your password is needed." else "",
                    riskLevel = pending.riskLevel,
                    requiresPassword = pending.requiresPassword,
                    busy = alertsState.confirming,
                    problem = alertsState.authorityProblem,
                    onCancel = alerts::cancelAuthority,
                    onConfirm = alerts::confirmAuthority,
                )
            }

            configurationState.pendingAuthority?.let { pending ->
                ConfirmDialog(
                    title = pending.title,
                    description = pending.description +
                        if (pending.requiresPassword) " Because it is ${pending.riskLevel} risk, your password is needed." else "",
                    riskLevel = pending.riskLevel,
                    requiresPassword = pending.requiresPassword,
                    busy = configurationState.confirming,
                    problem = configurationState.authorityProblem,
                    onCancel = configuration::cancelRestore,
                    onConfirm = configuration::confirmRestore,
                )
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
internal fun ProblemCard(problem: WolfProblem, onDismiss: () -> Unit) {
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

/** What the risk level asks of the owner, in the web dashboard's words. */
internal fun riskWords(level: String): String = when (level) {
    "low" -> "Low risk"
    "medium" -> "Medium risk — confirmation required"
    "high" -> "High risk — password required"
    "critical" -> "Critical — password and a single-use privileged grant required"
    else -> "Risk level $level"
}

@Composable
internal fun ConfirmDialog(
    title: String,
    description: String,
    riskLevel: String,
    requiresPassword: Boolean,
    busy: Boolean,
    problem: WolfProblem?,
    onCancel: () -> Unit,
    onConfirm: (String?) -> Unit,
) {
    // Never saveable: the password is not written into saved state, and is gone with the dialog.
    var password by remember { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = { if (!busy) onCancel() },
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(description)
                Text(riskWords(riskLevel), fontWeight = FontWeight.SemiBold)
                if (requiresPassword) {
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("Your WOLF password") },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                problem?.let {
                    Text(it.problem, color = MaterialTheme.colorScheme.error)
                    if (it.recommendedAction.isNotBlank()) Text(it.recommendedAction, style = MaterialTheme.typography.bodySmall)
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(if (requiresPassword) password else null) },
                enabled = !busy && (!requiresPassword || password.isNotEmpty()),
            ) {
                Text(if (busy) "Confirming…" else "Confirm")
            }
        },
        dismissButton = { TextButton(onClick = onCancel, enabled = !busy) { Text("Cancel") } },
    )
}

@Composable
private fun LockedScreen(busy: Boolean, notice: String?, onUnlock: () -> Unit) {
    // The prompt is offered once on arrival, and after that only when the owner taps: a prompt that reopens itself
    // after being dismissed is one that cannot be dismissed.
    LaunchedEffect(Unit) { onUnlock() }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("WOLF", style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold)
        Text("WOLF is locked.", style = MaterialTheme.typography.titleMedium)
        Text(
            "Your sign-in is sealed on this phone until you unlock WOLF with your fingerprint or screen lock.",
            style = MaterialTheme.typography.bodyMedium,
        )
        OutlinedButton(onClick = onUnlock, enabled = !busy, modifier = Modifier.fillMaxWidth()) { Text("Unlock") }
        notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
private fun SignInScreen(busy: Boolean, onSignIn: (String, String) -> Unit) {
    var email by rememberSaveable { mutableStateOf("") }
    // Deliberately not saveable: a password is not written into the saved instance state bundle.
    var password by remember { mutableStateOf("") }

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
    unreadCount: Int,
    onRefresh: () -> Unit,
    onOpen: (String) -> Unit,
    onAlerts: () -> Unit,
    onAutomations: () -> Unit,
    onConfiguration: () -> Unit,
    onSignOut: () -> Unit,
    appLockOn: Boolean = false,
    notice: String? = null,
    onAppLock: (Boolean) -> Unit = {},
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

        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = onAlerts, modifier = Modifier.weight(1f)) {
                Text(if (unreadCount > 0) "Alerts · $unreadCount unread" else "Alerts")
            }
            OutlinedButton(onClick = onAutomations, modifier = Modifier.weight(1f)) { Text("Automations") }
        }
        OutlinedButton(onClick = onConfiguration, modifier = Modifier.fillMaxWidth()) { Text("Configuration backup") }
        // Changed only through the system prompt, both ways: turning it off is as much a decision about this phone as on.
        OutlinedButton(onClick = { onAppLock(!appLockOn) }, modifier = Modifier.fillMaxWidth()) {
            Text(if (appLockOn) "App lock is on · Turn off" else "App lock is off · Turn on")
        }
        notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

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

/** Waking an offline PC through another of the owner's PCs on the same network. */
@Composable
private fun WakeCard(pc: PcSummary, pcs: List<PcSummary>, busy: Boolean, onWake: (String) -> Unit) {
    val readiness = Wake.readiness(pc)
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Wake", fontWeight = FontWeight.SemiBold)
            Text(
                "${pc.name} is not connected. Another of your PCs that is online on the same local network can send it a wake packet. " +
                    "WOLF does not know which of your PCs share a network, so choose one that does.",
                style = MaterialTheme.typography.bodySmall,
            )
            when (readiness) {
                Wake.Readiness.SWITCHED_OFF -> Text("Remote access to ${pc.name} is switched off, so WOLF does not wake it.", style = MaterialTheme.typography.bodySmall)
                Wake.Readiness.NO_ADDRESS -> Text(
                    "${pc.name} has never reported a wired network adapter, so there is no address to wake it at. Wake-on-LAN needs Ethernet.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Wake.Readiness.NOT_ARMED -> Text(
                    "The last time ${pc.name} connected, Windows had not allowed its wired adapter to wake the PC, so a wake packet may do nothing.",
                    style = MaterialTheme.typography.bodySmall,
                )
                else -> Unit
            }
            if (readiness == Wake.Readiness.READY || readiness == Wake.Readiness.NOT_ARMED) {
                val senders = Wake.senders(pc, pcs)
                if (senders.isEmpty()) {
                    Text("None of your other PCs is online with a WOLF version that can send a wake packet.", style = MaterialTheme.typography.bodySmall)
                }
                senders.forEach { sender ->
                    OutlinedButton(onClick = { onWake(sender.id) }, enabled = !busy, modifier = Modifier.fillMaxWidth()) {
                        Text("Wake from ${sender.name}")
                    }
                }
            }
        }
    }
}

@Composable
private fun PcScreen(
    pc: PcSummary?,
    state: UiState,
    onBack: () -> Unit,
    onPower: (String, String, String) -> Unit,
    onLoadProcesses: () -> Unit,
    onTerminate: (ProcessRow) -> Unit,
    onRemoteDesktop: (StreamProfile, Boolean) -> Unit,
    onServices: () -> Unit,
    onAutorun: () -> Unit,
    onWake: (senderId: String) -> Unit,
) {
    val online = pc?.status == "online" && pc.remoteAccessEnabled
    // Off unless the owner turns it on: starting to watch a PC is not a decision to start listening to it.
    var sound by rememberSaveable { mutableStateOf(false) }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = onBack) { Text("Back") }
            }
            Text(pc?.name ?: "PC", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                listOfNotNull(pc?.status, pc?.lastSeenAt?.let { "seen ${relative(it)}" }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
            )
            state.notice?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
        }

        item { Metrics(state.telemetry) }

        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Remote desktop", fontWeight = FontWeight.SemiBold)
                    CheckRow("Play the PC's sound", checked = sound, enabled = online) { sound = it }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        StreamProfile.entries.forEach { profile ->
                            OutlinedButton(onClick = { onRemoteDesktop(profile, sound) }, enabled = online, modifier = Modifier.weight(1f)) {
                                Text(profile.label)
                            }
                        }
                    }
                    Text(
                        "Opens full screen and asks for control. Sharp needs a fast connection; Balanced suits 4G and 5G; Data saver keeps usage low. Change it any time from the ☰ button. The picture, sound and clipboard never pass through the WOLF cloud. Sound is what the PC plays, never its microphone.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }

        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("What runs on this PC", fontWeight = FontWeight.SemiBold)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        OutlinedButton(onClick = onServices, enabled = online, modifier = Modifier.weight(1f)) { Text("Services") }
                        OutlinedButton(onClick = onAutorun, enabled = online, modifier = Modifier.weight(1f)) { Text("Tasks & startup") }
                    }
                    Text(
                        "Read and changed through the WOLF privileged helper on the PC. WOLF turns things off and on; it never creates or removes them.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }

        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Power", fontWeight = FontWeight.SemiBold)
                    POWER_ACTIONS.chunked(3).forEach { row ->
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            row.forEach { entry ->
                                OutlinedButton(
                                    onClick = { onPower(entry.action, entry.label, entry.description) },
                                    enabled = online && !state.busy,
                                    colors = if (entry.danger) {
                                        ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error)
                                    } else {
                                        ButtonDefaults.outlinedButtonColors()
                                    },
                                    modifier = Modifier.weight(1f),
                                ) { Text(entry.label) }
                            }
                        }
                    }
                    if (!online) Text("Power actions need the PC to be online with remote access on.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }

        if (pc != null && pc.status != "online") {
            item { WakeCard(pc, state.pcs.orEmpty(), busy = state.busy, onWake = onWake) }
        }

        item {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("Processes", fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
                TextButton(onClick = onLoadProcesses, enabled = online && !state.busy) {
                    Text(if (state.processes == null) "Load" else "Refresh")
                }
            }
            if (state.processesTruncated) Text("Only part of the list was returned.", style = MaterialTheme.typography.bodySmall)
        }

        items(state.processes.orEmpty().take(60), key = { it.pid }) { row ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Row(modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(row.name, fontWeight = FontWeight.Medium)
                        Text(
                            "PID ${row.pid} · CPU ${percent(row.cpuPercent)} · ${bytes(row.workingSetBytes)}",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                    if (row.protectedProcess) {
                        Text("protected", style = MaterialTheme.typography.labelSmall)
                    } else {
                        TextButton(onClick = { onTerminate(row) }, enabled = !state.busy) {
                            Text("End", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Metrics(telemetry: LatestTelemetry?) {
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
