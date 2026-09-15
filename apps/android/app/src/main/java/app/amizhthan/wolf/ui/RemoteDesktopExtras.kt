package app.amizhthan.wolf.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.AwaitPointerEventScope
import androidx.compose.ui.input.pointer.PointerEvent
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.amizhthan.wolf.remote.Displays
import app.amizhthan.wolf.remote.InputEvents
import app.amizhthan.wolf.remote.NormalizedPoint
import app.amizhthan.wolf.remote.Picture
import app.amizhthan.wolf.remote.RemoteDesktopUiState
import app.amizhthan.wolf.remote.ScrollAccumulator
import app.amizhthan.wolf.remote.TwoFingerClassifier
import app.amizhthan.wolf.remote.TwoFingerIntent
import app.amizhthan.wolf.remote.Viewport
import kotlinx.serialization.json.JsonObject

private enum class GestureMode { PENDING, DRAG, PAN, TWO_FINGER, IGNORED }

/**
 * Touch on the remote picture, in one place so the gestures cannot fight over a finger.
 *
 * With control: a tap is a left click, a finger held still a right click, a drag a left-button drag, two fingers
 * moving together scroll the PC, and a pinch zooms the picture on the phone. Without control nothing reaches the
 * PC: a pinch zooms and a drag moves around the zoomed picture.
 *
 * Every touch is taken back through the zoom before it becomes a point on the PC's screen, and a touch on the
 * black bars is dropped rather than clamped to the edge.
 */
internal fun Modifier.remoteGestures(
    controlling: Boolean,
    frameWidth: Int,
    frameHeight: Int,
    viewport: State<Viewport>,
    onViewport: (Viewport) -> Unit,
    send: (List<JsonObject>) -> Unit,
): Modifier = pointerInput(controlling, frameWidth, frameHeight) {
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        val width = size.width.toFloat()
        val height = size.height.toFloat()
        val slop = viewConfiguration.touchSlop
        fun at(position: Offset): NormalizedPoint? =
            Picture.normalize(width, height, frameWidth, frameHeight, position.x, position.y, viewport.value)

        val classifier = TwoFingerClassifier(slop)
        val scroll = ScrollAccumulator()
        var mode = GestureMode.PENDING
        var dragAt: NormalizedPoint? = null

        var pending: PointerEvent? = withTimeoutOrNull(viewConfiguration.longPressTimeoutMillis) { awaitStillFingerMoves(down.position, slop) }
        if (pending == null && controlling) {
            at(down.position)?.let { send(InputEvents.longPress(it)) }
            mode = GestureMode.IGNORED
        }

        while (true) {
            val event = pending ?: awaitPointerEvent()
            pending = null
            val pressed = event.changes.filter { it.pressed }

            if (pressed.isEmpty()) {
                when (mode) {
                    GestureMode.PENDING -> if (controlling) at(down.position)?.let { send(InputEvents.tap(it)) }
                    // Always released, wherever the finger ended: a button left down is a stuck drag.
                    GestureMode.DRAG -> dragAt?.let { send(listOf(InputEvents.button("left", "up", it))) }
                    else -> Unit
                }
                break
            }
            if (mode == GestureMode.IGNORED) continue

            if (pressed.size >= 2) {
                if (mode == GestureMode.DRAG) {
                    dragAt?.let { send(listOf(InputEvents.button("left", "up", it))) }
                    dragAt = null
                }
                mode = GestureMode.TWO_FINGER
                val zoom = event.calculateZoom()
                val pan = event.calculatePan()
                val centroid = event.calculateCentroid(useCurrent = true)
                when (classifier.update(zoom, pan.x, pan.y, event.calculateCentroidSize(useCurrent = true))) {
                    TwoFingerIntent.ZOOM -> onViewport(viewport.value.zoomBy(zoom, centroid.x, centroid.y, width, height).panBy(pan.x, pan.y, width, height))
                    TwoFingerIntent.SCROLL -> if (controlling) {
                        scroll.add(pan.x, pan.y)?.let { (deltaX, deltaY) ->
                            at(centroid)?.let { point -> send(listOf(InputEvents.scroll(point, deltaY, deltaX))) }
                        }
                    } else {
                        onViewport(viewport.value.panBy(pan.x, pan.y, width, height))
                    }
                    null -> Unit
                }
                event.changes.forEach { it.consume() }
                continue
            }

            // One finger left after two: nothing more until every finger lifts.
            if (mode == GestureMode.TWO_FINGER) continue

            val finger = pressed.first()
            if (mode == GestureMode.PENDING && (finger.position - down.position).getDistance() > slop) {
                val start = at(down.position)
                mode = when {
                    !controlling -> GestureMode.PAN
                    // A drag that starts on the black bars has nothing on the PC to press.
                    start == null -> GestureMode.IGNORED
                    else -> {
                        dragAt = start
                        send(listOf(InputEvents.move(start), InputEvents.button("left", "down", start)))
                        GestureMode.DRAG
                    }
                }
            }
            when (mode) {
                GestureMode.DRAG -> at(finger.position)?.let { point ->
                    dragAt = point
                    send(listOf(InputEvents.move(point)))
                }
                GestureMode.PAN -> {
                    val moved = finger.position - finger.previousPosition
                    onViewport(viewport.value.panBy(moved.x, moved.y, width, height))
                }
                else -> Unit
            }
            finger.consume()
        }
    }
}

/** Waits while a single finger stays within the slop of [start], and returns the event that ended that. */
private suspend fun AwaitPointerEventScope.awaitStillFingerMoves(start: Offset, slop: Float): PointerEvent {
    while (true) {
        val event = awaitPointerEvent()
        val pressed = event.changes.filter { it.pressed }
        if (pressed.size != 1 || (pressed.first().position - start).getDistance() > slop) return event
    }
}

@Composable
internal fun PanelToggle(label: String, open: Boolean, onClick: () -> Unit) {
    TextButton(onClick = onClick) { Text(if (open) "Hide ${label.lowercase()}" else label) }
}

/** The PC's displays, when there is more than one to choose from. */
@Composable
internal fun DisplayPicker(state: RemoteDesktopUiState, enabled: Boolean, onSelect: (String) -> Unit) {
    val displays = state.displays ?: return
    if (displays.size < 2) return
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, enabled = enabled) { Text("Display: ${state.negotiation?.displayName ?: "primary"}") }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            displays.forEach { display ->
                DropdownMenuItem(
                    text = { Text(Displays.label(display)) },
                    onClick = {
                        open = false
                        onSelect(display.id)
                    },
                )
            }
        }
    }
}

@Composable
internal fun ClipboardPanel(
    state: RemoteDesktopUiState,
    streaming: Boolean,
    onSend: () -> Unit,
    onCopy: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Clipboard", fontWeight = FontWeight.SemiBold)
        Text(
            "Text only, straight between this phone and the PC — never through the WOLF cloud, which keeps none of it. Nothing is copied either way until you tap.",
            style = MaterialTheme.typography.bodySmall,
        )
        val offered = state.clipboardFromPc
        if (offered != null) {
            Text("The PC copied ${offered.text.length} characters.", fontWeight = FontWeight.SemiBold)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = onCopy) { Text("Copy to this phone") }
                TextButton(onClick = onDismiss) { Text("Dismiss") }
            }
        } else {
            Text("Text copied on the PC while this stream runs is offered here.", style = MaterialTheme.typography.bodySmall)
        }
        OutlinedButton(onClick = onSend, enabled = streaming) { Text("Send this phone's clipboard to the PC") }
        Text("Android shows a notice when an app reads the clipboard. WOLF reads it only when you tap Send.", style = MaterialTheme.typography.bodySmall)
        state.clipboardNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
    }
}
