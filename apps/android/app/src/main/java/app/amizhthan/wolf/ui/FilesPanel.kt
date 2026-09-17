package app.amizhthan.wolf.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.amizhthan.wolf.api.PcTools
import app.amizhthan.wolf.remote.FileEntry
import app.amizhthan.wolf.remote.FileMessages
import app.amizhthan.wolf.remote.InterruptedDownload
import app.amizhthan.wolf.remote.InterruptedUpload
import app.amizhthan.wolf.remote.RemoteDesktopController

/**
 * This PC's files, from the phone.
 *
 * Nothing here goes through the cloud, contents or names. A fetched file goes into a document the owner picks
 * once it is whole; a sent file is read from one they pick. The app keeps neither — except, inside its own cache,
 * the part of a download a lost connection interrupted, until it is resumed or discarded.
 */
@Composable
fun FilesPanel(controller: RemoteDesktopController, streaming: Boolean, modifier: Modifier = Modifier) {
    val files by controller.files.collectAsStateWithLifecycle()
    var saving by remember { mutableStateOf<FileEntry?>(null) }
    var savingResumed by remember { mutableStateOf(false) }

    val saveLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val entry = saving
        val resumed = savingResumed
        saving = null
        savingResumed = false
        when {
            uri == null -> Unit
            resumed -> controller.resumeDownload(uri)
            entry != null -> controller.download(entry, uri)
        }
    }
    val openLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) controller.upload(uri)
    }

    // A change being asked about: what it is, and the entry it is for (none for a new folder).
    var changing by remember { mutableStateOf<Pair<String, FileEntry?>?>(null) }
    var answer by remember { mutableStateOf("") }

    val holds = files.control?.granted == true
    val progress = files.progress
    val interrupted = files.interrupted

    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (!holds) {
            Text("Reaching this PC's files is a separate permission.", fontWeight = FontWeight.SemiBold)
            Text(
                when (files.control?.reason) {
                    "capability-missing" -> "This session was not granted this PC's files. Watching a screen is not being handed the disks behind it."
                    "held-by-another-session" -> "Another session is browsing this PC. Two transfers into one folder produce a file that is neither of the things either sent."
                    "kill-switch" -> "Remote access is switched off on this PC."
                    else -> "Ask for access and WOLF decides whether this session may have it. What you browse and move goes straight between this phone and the PC; no server sees a name or a byte."
                },
                style = MaterialTheme.typography.bodySmall,
            )
            Button(onClick = controller::requestFiles, enabled = streaming) { Text("Ask for file access") }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = controller::up, enabled = files.folder != null && !files.busy) { Text("Up") }
                Text(files.folder ?: "This PC", modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                TextButton(onClick = { controller.browse(files.folder) }, enabled = !files.busy) { Text(if (files.busy) "Reading…" else "Refresh") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    onClick = { openLauncher.launch(arrayOf("*/*")) },
                    enabled = files.folder != null && progress == null && interrupted == null,
                ) { Text("Send a file here") }
                TextButton(
                    onClick = {
                        answer = ""
                        changing = "create-folder" to null
                    },
                    enabled = files.folder != null && !files.busy && progress == null,
                ) { Text("New folder") }
                TextButton(onClick = controller::releaseFiles) { Text("Give up file access") }
            }
        }

        files.notice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

        if (interrupted != null && progress == null) {
            Text(
                "${if (interrupted is InterruptedUpload) "Sending" else "Fetching"} ${interrupted.name} stopped at " +
                    "${FileMessages.readableSize(interrupted.done)} of ${FileMessages.readableSize(interrupted.total)}",
                fontWeight = FontWeight.SemiBold,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        when (interrupted) {
                            is InterruptedUpload -> controller.resumeUpload()
                            is InterruptedDownload -> {
                                // Where it goes is chosen again: the document chosen before was removed so half a
                                // file never sat among the owner's files.
                                savingResumed = true
                                saveLauncher.launch(interrupted.name)
                            }
                        }
                    },
                    enabled = holds,
                ) { Text("Resume") }
                TextButton(onClick = controller::discardInterrupted) { Text("Discard") }
            }
            if (!holds) Text("Resuming needs file access to this PC again.", style = MaterialTheme.typography.bodySmall)
        }

        if (progress != null) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "${if (progress.downloading) "Fetching" else "Sending"} ${progress.name}: ${FileMessages.readableSize(progress.done)}" +
                        if (progress.total > 0) " of ${FileMessages.readableSize(progress.total)}" else "",
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = controller::stopTransfer) { Text("Stop") }
            }
            LinearProgressIndicator(
                progress = { if (progress.total > 0) (progress.done.toFloat() / progress.total).coerceIn(0f, 1f) else 0f },
                modifier = Modifier.fillMaxWidth(),
            )
        }

        if (files.truncated) {
            Text("This folder holds more than WOLF lists at once. What is below is the first part of it, not all of it.", style = MaterialTheme.typography.bodySmall)
        }

        if (holds) {
            val entries = files.entries
            when {
                entries == null -> Text(if (files.busy) "Reading…" else "Nothing has been read yet.", style = MaterialTheme.typography.bodySmall)
                entries.isEmpty() -> Text("This folder is empty.", style = MaterialTheme.typography.bodySmall)
                else -> LazyColumn(modifier = Modifier.weight(1f)) {
                    items(entries) { entry ->
                        val opens = entry.kind != "file"
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .then(if (opens) Modifier.clickable(enabled = !files.busy) { controller.browse(FileMessages.pathOf(files.folder, entry)) } else Modifier)
                                .padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    if (opens) "${entry.name}${if (entry.kind == "directory") "\\" else ""}" else entry.name,
                                    fontWeight = if (opens) FontWeight.Medium else FontWeight.Normal,
                                    maxLines = 2,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    listOfNotNull(
                                        entry.sizeBytes?.let { FileMessages.readableSize(it) + if (entry.kind == "drive") " free" else "" },
                                        entry.modifiedAt?.let(PcTools::localTime),
                                        // A folder that is really a link to somewhere else should say so before anybody copies it.
                                        "link".takeIf { entry.reparse },
                                        "Windows".takeIf { entry.protectedLocation },
                                        "hidden".takeIf { entry.hidden },
                                    ).joinToString(" · "),
                                    style = MaterialTheme.typography.labelSmall,
                                )
                            }
                            if (!opens) {
                                TextButton(
                                    onClick = {
                                        saving = entry
                                        saveLauncher.launch(entry.name)
                                    },
                                    enabled = progress == null && interrupted == null,
                                ) { Text("Fetch") }
                            }
                            if (entry.kind != "drive" && !entry.protectedLocation) {
                                TextButton(
                                    onClick = {
                                        answer = entry.name
                                        changing = "menu" to entry
                                    },
                                    enabled = !files.busy && progress == null,
                                ) { Text("More") }
                            }
                        }
                    }
                }
            }
        }
    }

    changing?.let { (kind, entry) ->
        val folder = files.folder
        val close = { changing = null }
        when {
            folder == null -> close()
            kind == "menu" && entry != null -> AlertDialog(
                onDismissRequest = close,
                title = { Text(entry.name) },
                text = { Text("Change it on the PC. The cloud is told that a change happened, never what it was called.") },
                confirmButton = {
                    Column {
                        TextButton(onClick = { answer = entry.name; changing = "rename" to entry }) { Text("Rename") }
                        TextButton(onClick = { answer = folder; changing = "move" to entry }) { Text("Move") }
                        TextButton(onClick = { changing = "delete" to entry }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                },
                dismissButton = { TextButton(onClick = close) { Text("Cancel") } },
            )
            kind == "delete" && entry != null -> AlertDialog(
                onDismissRequest = close,
                title = { Text("Move ${entry.name} to the Recycle Bin?") },
                text = {
                    Text(
                        (if (entry.kind == "directory") "The folder and everything in it go. " else "") +
                            "It can be restored from the Recycle Bin at the PC. WOLF does not delete anything permanently; if it is too " +
                            "large for the Recycle Bin, Windows asks the person at the PC instead.",
                    )
                },
                confirmButton = {
                    Button(onClick = {
                        controller.change(FileMessages.delete(FileMessages.pathOf(folder, entry)), "${entry.name} was moved to the Recycle Bin on the PC.")
                        close()
                    }) { Text("Move to Recycle Bin") }
                },
                dismissButton = { TextButton(onClick = close) { Text("Cancel") } },
            )
            else -> {
                val valid = when (kind) {
                    "move" -> answer.isNotBlank()
                    else -> FileMessages.validName(answer.trim())
                }
                val submit = {
                    val value = answer.trim()
                    when (kind) {
                        "rename" -> controller.change(FileMessages.rename(FileMessages.pathOf(folder, entry!!), value), "${entry.name} was renamed.")
                        "move" -> controller.change(FileMessages.move(FileMessages.pathOf(folder, entry!!), value), "${entry.name} was moved.")
                        else -> controller.change(FileMessages.createFolder(FileMessages.childPath(folder, value)), "The folder $value was made.")
                    }
                    close()
                }
                AlertDialog(
                    onDismissRequest = close,
                    title = {
                        Text(
                            when (kind) {
                                "rename" -> "Rename ${entry?.name}"
                                "move" -> "Move ${entry?.name}"
                                else -> "New folder"
                            },
                        )
                    },
                    text = {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            OutlinedTextField(
                                value = answer,
                                onValueChange = { answer = it },
                                label = { Text(if (kind == "move") "Into the folder" else "Name") },
                                singleLine = true,
                                // The keyboard's own Done confirms. In landscape — the stream's orientation — the phone
                                // keyboard covers the whole screen, and the dialog's button could not be reached
                                // without closing the keyboard first; found on the owner's phone.
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = { if (valid) submit() }),
                            )
                            if (kind == "move") Text("A folder on the same drive. Nothing already there is replaced.", style = MaterialTheme.typography.bodySmall)
                            if (kind != "move" && answer.isNotEmpty() && !valid) {
                                Text("Windows does not allow that name.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                            }
                        }
                    },
                    confirmButton = {
                        Button(
                            enabled = valid,
                            onClick = submit,
                        ) { Text(if (kind == "rename") "Rename" else if (kind == "move") "Move" else "Make folder") }
                    },
                    dismissButton = { TextButton(onClick = close) { Text("Cancel") } },
                )
            }
        }
    }
}
