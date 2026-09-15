package app.amizhthan.wolf.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.amizhthan.wolf.remote.InputEvents
import app.amizhthan.wolf.remote.NormalizedPoint
import app.amizhthan.wolf.remote.Picture
import app.amizhthan.wolf.remote.RemoteDesktopController
import app.amizhthan.wolf.remote.StreamPhase
import app.amizhthan.wolf.remote.VirtualKey
import org.webrtc.SurfaceViewRenderer

/** What the stream is doing, in words. */
internal fun phaseWords(phase: StreamPhase): String = when (phase) {
    StreamPhase.IDLE -> "Starting"
    StreamPhase.AUTHENTICATING -> "Connecting to WOLF"
    StreamPhase.REQUESTING -> "Asking the PC to stream"
    StreamPhase.NEGOTIATING -> "The PC is preparing the stream"
    StreamPhase.CONNECTING -> "Connecting to the PC"
    StreamPhase.STREAMING -> "Streaming"
    StreamPhase.RECONNECTING -> "Reconnecting"
    StreamPhase.FAILED -> "Stopped"
    StreamPhase.STOPPED -> "Stopped"
}

/** Why the cloud did not grant control, in words. */
internal fun controlWords(reason: String?): String = when (reason) {
    "held-by-another-session" -> "Someone else is controlling this PC."
    "capability-missing" -> "This session is not allowed to control the PC."
    "session-ended" -> "The session ended."
    "kill-switch" -> "Remote access is switched off on this PC."
    "unsupported" -> "This PC does not accept remote input."
    "released" -> "You released control."
    else -> "View only."
}

@Composable
fun RemoteDesktopScreen(controller: RemoteDesktopController, onClose: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val controlling = state.control?.granted == true
    var dragAt by remember { mutableStateOf<NormalizedPoint?>(null) }
    var typed by remember { mutableStateOf("") }

    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row {
            TextButton(onClick = onClose) { Text("Close") }
            Column(modifier = Modifier.weight(1f).padding(top = 8.dp)) {
                Text(phaseWords(state.phase), fontWeight = FontWeight.SemiBold)
                val negotiation = state.negotiation
                if (negotiation != null) {
                    Text(
                        "${negotiation.displayName} · ${negotiation.widthPixels}×${negotiation.heightPixels} · ${negotiation.videoCodec}${if (negotiation.hardwareEncoded) " (hardware)" else ""}",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            if (controlling) {
                TextButton(onClick = controller::releaseControl) { Text("Release") }
            } else {
                TextButton(onClick = controller::requestControl, enabled = state.phase == StreamPhase.STREAMING) { Text("Take control") }
            }
        }

        state.failure?.let {
            Text(it.message, color = MaterialTheme.colorScheme.error)
            Text(it.recommendedAction, style = MaterialTheme.typography.bodySmall)
        }
        state.remoteState?.let { remote ->
            if (remote.unavailableReason != null) Text("The PC reports: ${remote.detail ?: remote.unavailableReason}", style = MaterialTheme.typography.bodySmall)
            if (remote.showing == "secure-desktop") Text("Showing the Windows lock or sign-in screen.", style = MaterialTheme.typography.bodySmall)
        }
        if (state.phase == StreamPhase.STREAMING) {
            // Connected is not the same as seeing the PC: the first decoded frame is what says so.
            Text(if (state.pictureShown) "Picture received" else "Waiting for the first picture…", style = MaterialTheme.typography.bodySmall)
        }
        if (!controlling && state.control != null) Text(controlWords(state.control?.reason), style = MaterialTheme.typography.bodySmall)
        state.inputRefusal?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

        Box(modifier = Modifier.weight(1f).fillMaxWidth().background(Color.Black)) {
            AndroidView(
                factory = { context -> SurfaceViewRenderer(context).also(controller::attachRenderer) },
                onRelease = controller::detachRenderer,
                modifier = Modifier.fillMaxSize(),
            )

            // Touch is read only while this session holds control; otherwise the picture is only a picture.
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .pointerInput(controlling, state.frameWidth, state.frameHeight) {
                        if (!controlling) return@pointerInput
                        fun at(offset: Offset) = Picture.normalize(size.width.toFloat(), size.height.toFloat(), state.frameWidth, state.frameHeight, offset.x, offset.y)
                        detectTapGestures(
                            onTap = { offset -> at(offset)?.let { controller.send(InputEvents.tap(it)) } },
                            onLongPress = { offset -> at(offset)?.let { controller.send(InputEvents.longPress(it)) } },
                        )
                    }
                    .pointerInput(controlling, state.frameWidth, state.frameHeight) {
                        if (!controlling) return@pointerInput
                        fun at(offset: Offset) = Picture.normalize(size.width.toFloat(), size.height.toFloat(), state.frameWidth, state.frameHeight, offset.x, offset.y)
                        detectDragGestures(
                            onDragStart = { offset ->
                                at(offset)?.let { point ->
                                    dragAt = point
                                    controller.send(listOf(InputEvents.move(point), InputEvents.button("left", "down", point)))
                                }
                            },
                            onDrag = { change, _ ->
                                at(change.position)?.let { point ->
                                    dragAt = point
                                    controller.send(listOf(InputEvents.move(point)))
                                }
                            },
                            onDragEnd = {
                                // Always released, wherever the finger ended: a button left down is a stuck drag.
                                dragAt?.let { controller.send(listOf(InputEvents.button("left", "up", it))) }
                                dragAt = null
                            },
                            onDragCancel = {
                                dragAt?.let { controller.send(listOf(InputEvents.button("left", "up", it))) }
                                dragAt = null
                            },
                        )
                    },
            )
        }

        if (controlling) {
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedTextField(
                    value = typed,
                    onValueChange = { typed = it },
                    label = { Text("Type on the PC") },
                    singleLine = true,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = {
                    if (typed.isNotEmpty()) controller.send(InputEvents.text(typed))
                    typed = ""
                }) { Text("Send") }
            }
            val centre = NormalizedPoint(0.5, 0.5)
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf("Enter" to VirtualKey.ENTER, "⌫" to VirtualKey.BACKSPACE, "Esc" to VirtualKey.ESCAPE, "Tab" to VirtualKey.TAB).forEach { (label, key) ->
                    OutlinedButton(onClick = { controller.send(InputEvents.keyPress(key)) }, modifier = Modifier.weight(1f)) { Text(label) }
                }
                OutlinedButton(onClick = { controller.send(listOf(InputEvents.scroll(centre, 3.0))) }, modifier = Modifier.weight(1f)) { Text("▲") }
                OutlinedButton(onClick = { controller.send(listOf(InputEvents.scroll(centre, -3.0))) }, modifier = Modifier.weight(1f)) { Text("▼") }
            }
        }
    }
}
