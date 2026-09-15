package app.amizhthan.wolf.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
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
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.amizhthan.wolf.remote.InputEvents
import app.amizhthan.wolf.remote.NormalizedPoint
import app.amizhthan.wolf.remote.RemoteDesktopController
import app.amizhthan.wolf.remote.StreamPhase
import app.amizhthan.wolf.remote.Viewport
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

private enum class Panel { NONE, FILES, CLIPBOARD }

@Composable
fun RemoteDesktopScreen(controller: RemoteDesktopController, onClose: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val controlling = state.control?.granted == true
    val streaming = state.phase == StreamPhase.STREAMING
    var typed by remember { mutableStateOf("") }
    var panel by remember { mutableStateOf(Panel.NONE) }
    var viewport by remember { mutableStateOf(Viewport.FIT) }
    val currentViewport = rememberUpdatedState(viewport)

    // A picture of a different size is a different picture — another display, usually. A zoom into the old one
    // would leave the owner looking at, and touching, somewhere they did not choose.
    LaunchedEffect(state.frameWidth, state.frameHeight) { viewport = Viewport.FIT }

    Column(modifier = Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row {
            TextButton(onClick = onClose) { Text("Close") }
            Column(modifier = Modifier.weight(1f).padding(top = 8.dp)) {
                Text(phaseWords(state.phase), fontWeight = FontWeight.SemiBold)
                val negotiation = state.negotiation
                if (negotiation != null) {
                    Text(
                        "${negotiation.displayName} · ${negotiation.widthPixels}×${negotiation.heightPixels} · ${negotiation.videoCodec}${if (negotiation.hardwareEncoded) " (hardware)" else ""}${if (negotiation.audioCodec != null) " · sound" else ""}",
                        style = MaterialTheme.typography.labelSmall,
                    )
                }
            }
            if (controlling) {
                TextButton(onClick = controller::releaseControl) { Text("Release") }
            } else {
                TextButton(onClick = controller::requestControl, enabled = streaming) { Text("Take control") }
            }
        }

        Row(modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically) {
            PanelToggle("Files", panel == Panel.FILES) { panel = if (panel == Panel.FILES) Panel.NONE else Panel.FILES }
            PanelToggle("Clipboard", panel == Panel.CLIPBOARD) { panel = if (panel == Panel.CLIPBOARD) Panel.NONE else Panel.CLIPBOARD }
            DisplayPicker(state, enabled = streaming, onSelect = controller::setDisplay)
            // Only what the PC actually settled on: a stream with no audio track gets no sound button over silence.
            if (state.negotiation?.audioCodec != null) {
                TextButton(onClick = { controller.setSoundOn(!state.soundOn) }) { Text(if (state.soundOn) "Mute" else "Unmute") }
            }
            if (viewport.zoomed) TextButton(onClick = { viewport = Viewport.FIT }) { Text("Fit") }
        }

        state.failure?.let {
            Text(it.message, color = MaterialTheme.colorScheme.error)
            Text(it.recommendedAction, style = MaterialTheme.typography.bodySmall)
        }
        state.remoteState?.let { remote ->
            if (remote.unavailableReason != null) Text("The PC reports: ${remote.detail ?: remote.unavailableReason}", style = MaterialTheme.typography.bodySmall)
            if (remote.showing == "secure-desktop") Text("Showing the Windows lock or sign-in screen.", style = MaterialTheme.typography.bodySmall)
        }
        state.negotiation?.adjustments?.forEach { Text("The PC adjusted this stream: ${it.reason}", style = MaterialTheme.typography.bodySmall) }
        state.displaysNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        if (streaming) {
            // Connected is not the same as seeing the PC: the first decoded frame is what says so.
            Text(
                when {
                    !state.pictureShown -> "Waiting for the first picture…"
                    controlling -> "Tap to click, hold to right-click, drag to drag. Two fingers scroll; pinch to zoom."
                    else -> "Picture received. Pinch to zoom."
                },
                style = MaterialTheme.typography.bodySmall,
            )
        }
        if (!controlling && state.control != null) Text(controlWords(state.control?.reason), style = MaterialTheme.typography.bodySmall)
        state.inputRefusal?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

        Box(modifier = Modifier.weight(if (panel == Panel.NONE) 1f else 0.35f).fillMaxWidth().clipToBounds().background(Color.Black)) {
            AndroidView(
                factory = { context -> SurfaceViewRenderer(context).also(controller::attachRenderer) },
                // Zoom moves the picture view itself. Since Android 7 a SurfaceView scales and moves with its view.
                update = { view ->
                    view.pivotX = 0f
                    view.pivotY = 0f
                    view.scaleX = viewport.scale
                    view.scaleY = viewport.scale
                    view.translationX = viewport.offsetX
                    view.translationY = viewport.offsetY
                },
                onRelease = controller::detachRenderer,
                modifier = Modifier.fillMaxSize(),
            )

            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .remoteGestures(controlling, state.frameWidth, state.frameHeight, currentViewport, onViewport = { viewport = it }, send = controller::send),
            )
        }

        when (panel) {
            Panel.FILES -> FilesPanel(controller, streaming = streaming, modifier = Modifier.weight(0.65f).fillMaxWidth())
            Panel.CLIPBOARD -> ClipboardPanel(
                state,
                streaming = streaming,
                onSend = controller::sendPhoneClipboard,
                onCopy = controller::copyPcClipboardToPhone,
                onDismiss = controller::dismissPcClipboard,
                modifier = Modifier.weight(0.65f).fillMaxWidth().padding(horizontal = 8.dp),
            )
            Panel.NONE -> if (controlling) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
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
}
