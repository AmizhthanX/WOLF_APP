package app.amizhthan.wolf.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.amizhthan.wolf.api.ConfigurationBackups
import app.amizhthan.wolf.api.RestorePlan

@Composable
fun ConfigurationScreen(
    state: ConfigurationState,
    onBack: () -> Unit,
    onPrepareBackup: () -> Unit,
    onSavePickerOpened: () -> Unit,
    onSaveBackup: (Uri?) -> Unit,
    onChooseBackup: (Uri?) -> Unit,
    onToggleSection: (String, Boolean) -> Unit,
    onEnableAutomations: (Boolean) -> Unit,
    onPreview: () -> Unit,
    onRestore: () -> Unit,
    onDismissProblem: () -> Unit,
) {
    // The system's document picker: the app needs no storage permission and sees only the file chosen.
    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json"), onSaveBackup)
    val openLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument(), onChooseBackup)

    val pending = state.pendingSave
    LaunchedEffect(pending) {
        if (pending != null && !pending.pickerOpened) {
            saveLauncher.launch(pending.fileName)
            onSavePickerOpened()
        }
    }

    LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        item {
            TextButton(onClick = onBack) { Text("Back") }
            Text("Configuration backup", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(
                "Your PC names and tags, remote desktop profiles, alert rules and automations. A backup holds no passwords, " +
                    "keys, tokens or history, and WOLF keeps no copy of it: it is only the file you save.",
                style = MaterialTheme.typography.bodySmall,
            )
        }

        state.problem?.let { problem -> item { ProblemCard(problem, onDismiss = onDismissProblem) } }
        state.notice?.let { notice -> item { Text(notice, style = MaterialTheme.typography.bodyMedium) } }

        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Back up", fontWeight = FontWeight.SemiBold)
                    Text(
                        "The file carries a checksum, so a damaged or edited copy is refused when you restore it. Edit your " +
                            "configuration in WOLF, not in the file.",
                        style = MaterialTheme.typography.bodySmall,
                    )
                    Button(onClick = onPrepareBackup, enabled = !state.busy && state.pendingSave == null, modifier = Modifier.fillMaxWidth()) {
                        Text("Save backup file")
                    }
                }
            }
        }

        item {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(modifier = Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Restore", fontWeight = FontWeight.SemiBold)
                    OutlinedButton(
                        onClick = { openLauncher.launch(arrayOf("application/json", "application/octet-stream", "text/plain")) },
                        enabled = !state.busy,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (state.chosen == null) "Choose backup file" else "Choose another file")
                    }

                    state.chosen?.let { chosen ->
                        Text(chosen.name, fontWeight = FontWeight.Medium)
                        Text(chosen.summary, style = MaterialTheme.typography.bodySmall)

                        FieldLabel("Restore these, replacing what is there now")
                        ConfigurationBackups.SECTIONS.forEach { section ->
                            CheckRow(section.label, section.id in state.sections) { onToggleSection(section.id, it) }
                            Text(section.note, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(start = 48.dp))
                        }
                        CheckRow("Turn restored automations back on as they were", state.enableAutomations, enabled = "automations" in state.sections) {
                            onEnableAutomations(it)
                        }
                        Text(
                            "You confirm at the risk of the riskiest one. Otherwise they come back turned off.",
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(start = 48.dp),
                        )

                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = onPreview, enabled = !state.busy && state.sections.isNotEmpty(), modifier = Modifier.weight(1f)) {
                                Text("Check what will change")
                            }
                            Button(
                                onClick = onRestore,
                                enabled = !state.busy && state.plan != null,
                                colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                                modifier = Modifier.weight(1f),
                            ) {
                                Text("Restore")
                            }
                        }
                    }

                    state.plan?.let { PlanView(it, "This restore will") }
                    state.restored?.let { PlanView(it, "Restored") }
                }
            }
        }
    }
}

@Composable
private fun PlanView(plan: RestorePlan, heading: String) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(heading, fontWeight = FontWeight.SemiBold)
        ConfigurationBackups.describe(plan).forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
        plan.warnings.forEach { warning ->
            Text("Note: ${warning.message}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        }
    }
}
