package app.amizhthan.wolf.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.amizhthan.wolf.remote.HeldModifiers
import app.amizhthan.wolf.remote.InputEvents
import app.amizhthan.wolf.remote.PictureRect
import app.amizhthan.wolf.remote.RemoteDesktopController
import app.amizhthan.wolf.remote.RemoteDesktopUiState
import app.amizhthan.wolf.remote.StreamPhase
import app.amizhthan.wolf.remote.StreamQuality
import app.amizhthan.wolf.remote.TouchpadCursor
import app.amizhthan.wolf.remote.Typing
import app.amizhthan.wolf.remote.Viewport
import app.amizhthan.wolf.remote.VirtualKey
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import org.webrtc.SurfaceViewRenderer
import kotlin.math.roundToInt

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

private enum class Panel { NONE, MENU, FILES, CLIPBOARD }

private enum class MouseMode(val label: String) { TOUCHPAD("Touchpad"), DIRECT("Direct touch") }

private const val MAX_RECONNECTS = 5
private const val RECONNECT_BASE_MS = 2_000L
private const val RECONNECT_MAX_MS = 30_000L
private const val RECONNECT_STUCK_MS = 25_000L

private val Overlay = Color(0xE6121212)
private val OverlayText = Color(0xFFECECEC)

/**
 * The PC, full screen, in the way Parsec shows one: nothing but the picture, and a small button that can be dragged
 * out of the way and opens everything else.
 *
 * Asked for by the owner after the first stream over mobile data. It keeps what the stream already had — control is
 * still the cloud's to grant, files and clipboard still go only over the data channel — and changes how it is driven:
 * a touchpad cursor by default, a keyboard with the keys a PC needs, and a picture quality that can be changed
 * without starting again.
 */
@Composable
fun RemoteDesktopScreen(controller: RemoteDesktopController, onClose: () -> Unit) {
    val state by controller.state.collectAsStateWithLifecycle()
    val controlling = state.control?.granted == true
    val streaming = state.phase == StreamPhase.STREAMING

    var panel by remember { mutableStateOf(Panel.NONE) }
    var mouseMode by remember { mutableStateOf(MouseMode.TOUCHPAD) }
    var keyboardOpen by remember { mutableStateOf(false) }
    var viewport by remember { mutableStateOf(Viewport.FIT) }
    var cursor by remember { mutableStateOf(TouchpadCursor()) }
    val currentViewport = rememberUpdatedState(viewport)
    val currentCursor = rememberUpdatedState(cursor)
    // Whether the owner wants the keyboard and mouse: true until they choose View only, and asked for again on every
    // (re)connection while it is.
    var wantControl by remember { mutableStateOf(true) }
    var reconnects by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()

    FullScreenLandscape()

    // A picture of a different size is a different picture — another display, usually. A zoom into the old one
    // would leave the owner looking at, and touching, somewhere they did not choose.
    LaunchedEffect(state.frameWidth, state.frameHeight) { viewport = Viewport.FIT }

    // Opening a stream from this screen is asking to use the PC, so control is asked for once it is streaming, as
    // Parsec does. The cloud still decides, and a refusal is shown; "View only" in the menu gives it back.
    LaunchedEffect(streaming) {
        if (streaming) {
            reconnects = 0
            if (wantControl) controller.requestControl()
        }
    }

    // A stream that stopped for a reason that can pass — the connection to WOLF dropped, the network changed — starts
    // again by itself, a few times and further apart, as Parsec does. Collected with the lifecycle, so this runs when
    // the owner is looking, not while the app sits in the background.
    LaunchedEffect(state.phase, state.failure) {
        if (state.phase == StreamPhase.FAILED && state.failure?.retryable == true && reconnects < MAX_RECONNECTS) {
            delay(minOf(RECONNECT_BASE_MS shl reconnects, RECONNECT_MAX_MS))
            reconnects += 1
            // Launched in the screen's scope, not run in this effect: restarting changes the phase this effect is
            // keyed on, which would cancel the restart halfway — the first version stayed on "Connecting" forever.
            scope.launch { runCatching { controller.restart() } }
        }
    }

    // A reconnection that is still "connecting" after a while is treated as failed and tried again: a socket opened
    // on a network that has just gone away can wait far longer than the owner will.
    LaunchedEffect(state.phase, reconnects) {
        val connecting = state.phase in setOf(StreamPhase.AUTHENTICATING, StreamPhase.REQUESTING, StreamPhase.NEGOTIATING, StreamPhase.CONNECTING)
        if (connecting && reconnects in 1 until MAX_RECONNECTS) {
            delay(RECONNECT_STUCK_MS)
            reconnects += 1
            scope.launch { runCatching { controller.restart() } }
        }
    }

    BoxWithConstraints(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        val density = LocalDensity.current
        val widthPx = with(density) { maxWidth.toPx() }
        val heightPx = with(density) { maxHeight.toPx() }

        Box(modifier = Modifier.fillMaxSize().clipToBounds()) {
            // The picture view takes the PC picture's own shape, centred, rather than the whole screen. libwebrtc's
            // renderer crops a frame to the shape of its view: filling a 19.5:9 phone with a 16:9 PC desktop cut off
            // its top and bottom — the taskbar — on the owner's phone. Until the first frame says the shape, it fills.
            val fit = PictureRect.of(widthPx, heightPx, state.frameWidth, state.frameHeight, Viewport.FIT)
                ?: PictureRect(0f, 0f, widthPx, heightPx)
            // Remade when the screen's size changes: made a moment before the turn to landscape, the renderer kept
            // the surface it had sized for portrait.
            key(widthPx.roundToInt(), heightPx.roundToInt()) {
                AndroidView(
                    factory = { context -> SurfaceViewRenderer(context).also(controller::attachRenderer) },
                    // Zoom moves the picture view itself; since Android 7 a SurfaceView scales and moves with its
                    // view. The viewport is in screen coordinates and the view sits at (left, top), so its own
                    // translation carries that offset through the scale.
                    update = { view ->
                        view.pivotX = 0f
                        view.pivotY = 0f
                        view.scaleX = viewport.scale
                        view.scaleY = viewport.scale
                        view.translationX = fit.left * (viewport.scale - 1f) + viewport.offsetX
                        view.translationY = fit.top * (viewport.scale - 1f) + viewport.offsetY
                    },
                    onRelease = controller::detachRenderer,
                    modifier = Modifier
                        .offset { IntOffset(fit.left.roundToInt(), fit.top.roundToInt()) }
                        .size(with(density) { fit.width.toDp() }, with(density) { fit.height.toDp() }),
                )
            }

            val gestures = when (mouseMode) {
                MouseMode.TOUCHPAD -> Modifier.touchpadGestures(
                    controlling,
                    state.frameWidth,
                    state.frameHeight,
                    currentViewport,
                    currentCursor,
                    onViewport = { viewport = it },
                    onCursor = { cursor = it },
                    send = controller::send,
                    onThreeFingers = { keyboardOpen = !keyboardOpen },
                )
                MouseMode.DIRECT -> Modifier.remoteGestures(
                    controlling,
                    state.frameWidth,
                    state.frameHeight,
                    currentViewport,
                    onViewport = { viewport = it },
                    send = controller::send,
                )
            }
            Box(modifier = Modifier.fillMaxSize().then(gestures))

            // The cursor's hotspot, drawn at once on the phone. The PC's own cursor is in the picture too, but a
            // frame or two behind the finger over mobile data; this ring says where a tap will click.
            if (mouseMode == MouseMode.TOUCHPAD && controlling && state.pictureShown) {
                val rect = PictureRect.of(widthPx, heightPx, state.frameWidth, state.frameHeight, viewport)
                if (rect != null) {
                    Canvas(modifier = Modifier.fillMaxSize()) {
                        val (x, y) = rect.toScreen(cursor.point)
                        drawCircle(Color.Black.copy(alpha = 0.6f), radius = 9.dp.toPx(), center = Offset(x, y), style = Stroke(3.dp.toPx()))
                        drawCircle(Color.White, radius = 9.dp.toPx(), center = Offset(x, y), style = Stroke(1.5.dp.toPx()))
                    }
                }
            }
        }

        if (!streaming || !state.pictureShown) {
            StatusCard(
                state,
                reconnecting = state.phase == StreamPhase.FAILED && state.failure?.retryable == true && reconnects < MAX_RECONNECTS,
                onReconnect = {
                    reconnects = 0
                    scope.launch { runCatching { controller.restart() } }
                },
                onClose = onClose,
                modifier = Modifier.align(Alignment.Center),
            )
        }

        state.inputRefusal?.let {
            Notice(it, modifier = Modifier.align(Alignment.TopCenter).padding(top = 12.dp))
        }

        if (keyboardOpen && panel == Panel.NONE) {
            KeyboardBar(
                enabled = controlling,
                send = controller::send,
                onHide = { keyboardOpen = false },
                modifier = Modifier.align(Alignment.BottomCenter).fillMaxWidth().imePadding(),
            )
        }

        if (panel == Panel.NONE) {
            MenuButton(onOpen = { panel = Panel.MENU }, maxX = widthPx, maxY = heightPx)
        }

        when (panel) {
            Panel.MENU -> SidePanel(onDismiss = { panel = Panel.NONE }) {
                StreamMenu(
                    state = state,
                    controlling = controlling,
                    streaming = streaming,
                    mouseMode = mouseMode,
                    zoomed = viewport.zoomed,
                    onMouseMode = { mouseMode = it },
                    onKeyboard = {
                        keyboardOpen = true
                        panel = Panel.NONE
                    },
                    onQuality = controller::setQuality,
                    onDisplay = controller::setDisplay,
                    onSound = { controller.setSoundOn(!state.soundOn) },
                    onFit = { viewport = Viewport.FIT },
                    onControl = {
                        wantControl = !controlling
                        if (controlling) controller.releaseControl() else controller.requestControl()
                    },
                    onFiles = { panel = Panel.FILES },
                    onClipboard = { panel = Panel.CLIPBOARD },
                    onClose = onClose,
                )
            }
            Panel.FILES -> SidePanel(onDismiss = { panel = Panel.NONE }, wide = true) {
                FilesPanel(controller, streaming = streaming, modifier = Modifier.fillMaxSize())
            }
            Panel.CLIPBOARD -> SidePanel(onDismiss = { panel = Panel.NONE }) {
                ClipboardPanel(
                    state,
                    streaming = streaming,
                    onSend = controller::sendPhoneClipboard,
                    onCopy = controller::copyPcClipboardToPhone,
                    onDismiss = controller::dismissPcClipboard,
                    modifier = Modifier.fillMaxSize(),
                )
            }
            Panel.NONE -> Unit
        }
    }
}

/** Landscape, without the status and navigation bars, for as long as the stream is open; put back on leaving. */
@Composable
private fun FullScreenLandscape() {
    val view = LocalView.current
    DisposableEffect(Unit) {
        val activity = view.context.findActivity()
        if (activity == null) {
            onDispose { }
        } else {
            val bars = WindowCompat.getInsetsController(activity.window, view)
            val orientation = activity.requestedOrientation
            activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
            bars.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            bars.hide(WindowInsetsCompat.Type.systemBars())
            onDispose {
                bars.show(WindowInsetsCompat.Type.systemBars())
                activity.requestedOrientation = orientation
            }
        }
    }
}

private tailrec fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}

/** The small round button that opens the menu, dragged anywhere so it never covers what the owner needs. */
@Composable
private fun MenuButton(onOpen: () -> Unit, maxX: Float, maxY: Float) {
    val density = LocalDensity.current
    val sizePx = with(density) { 44.dp.toPx() }
    // Placed again when the screen's size changes: placed once, it kept where portrait put it after the turn to landscape.
    var x by remember(maxX, maxY) { mutableFloatStateOf(Float.NaN) }
    var y by remember(maxX, maxY) { mutableFloatStateOf(Float.NaN) }
    if (x.isNaN()) {
        x = maxX - sizePx - with(density) { 16.dp.toPx() }
        y = with(density) { 16.dp.toPx() }
    }
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .offset { IntOffset(x.roundToInt(), y.roundToInt()) }
            .size(44.dp)
            .clip(CircleShape)
            .background(Color(0x99000000))
            .border(1.dp, Color(0x66FFFFFF), CircleShape)
            .pointerInput(maxX, maxY) {
                detectDragGestures { change, amount ->
                    change.consume()
                    x = (x + amount.x).coerceIn(0f, (maxX - sizePx).coerceAtLeast(0f))
                    y = (y + amount.y).coerceIn(0f, (maxY - sizePx).coerceAtLeast(0f))
                }
            }
            .clickable(onClick = onOpen),
    ) {
        Text("☰", color = Color.White, style = MaterialTheme.typography.titleMedium)
    }
}

/** A panel on the right that leaves the picture visible; a tap outside closes it. */
@Composable
private fun SidePanel(onDismiss: () -> Unit, wide: Boolean = false, content: @Composable () -> Unit) {
    Row(modifier = Modifier.fillMaxSize()) {
        Box(modifier = Modifier.weight(1f).fillMaxHeight().clickable(onClick = onDismiss))
        Surface(
            color = Overlay,
            contentColor = OverlayText,
            modifier = Modifier.fillMaxHeight().width(if (wide) 460.dp else 320.dp),
        ) {
            Box(modifier = Modifier.padding(12.dp)) { content() }
        }
    }
}

@Composable
private fun StreamMenu(
    state: RemoteDesktopUiState,
    controlling: Boolean,
    streaming: Boolean,
    mouseMode: MouseMode,
    zoomed: Boolean,
    onMouseMode: (MouseMode) -> Unit,
    onKeyboard: () -> Unit,
    onQuality: (StreamQuality) -> Unit,
    onDisplay: (String) -> Unit,
    onSound: () -> Unit,
    onFit: () -> Unit,
    onControl: () -> Unit,
    onFiles: () -> Unit,
    onClipboard: () -> Unit,
    onClose: () -> Unit,
) {
    Column(modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(phaseWords(state.phase), fontWeight = FontWeight.SemiBold)
        state.negotiation?.let { negotiation ->
            Text(
                "${negotiation.displayName} · ${negotiation.widthPixels}×${negotiation.heightPixels} · ${negotiation.videoCodec}${if (negotiation.hardwareEncoded) " (hardware)" else ""}",
                style = MaterialTheme.typography.labelSmall,
            )
            negotiation.adjustments.forEach { Text("The PC adjusted this stream: ${it.reason}", style = MaterialTheme.typography.labelSmall) }
        }
        if (!controlling && state.control != null) Text(controlWords(state.control.reason), style = MaterialTheme.typography.bodySmall)

        OutlinedButton(onClick = onControl, enabled = streaming, modifier = Modifier.fillMaxWidth()) {
            Text(if (controlling) "View only (release control)" else "Take control")
        }

        Section("Mouse")
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            MouseMode.entries.forEach { mode ->
                Choice(mode.label, selected = mode == mouseMode, modifier = Modifier.weight(1f)) { onMouseMode(mode) }
            }
        }
        Text(
            if (mouseMode == MouseMode.TOUCHPAD) {
                "Slide to move the pointer, tap to click. Two-finger tap or hold: right click. Tap then slide, or hold then slide: drag. Two fingers: scroll. Pinch: zoom. Three-finger tap: keyboard."
            } else {
                "Tap to click where you touch, hold to right-click, drag to drag. Two fingers scroll; pinch to zoom."
            },
            style = MaterialTheme.typography.labelSmall,
        )

        OutlinedButton(onClick = onKeyboard, enabled = controlling, modifier = Modifier.fillMaxWidth()) { Text("Keyboard") }

        Section("Picture")
        val current = StreamQuality.of(state.profile)
        StreamQuality.entries.forEach { quality ->
            Choice("${quality.label} — ${quality.description}", selected = quality == current, enabled = streaming, modifier = Modifier.fillMaxWidth()) {
                onQuality(quality)
            }
        }
        if (zoomed) OutlinedButton(onClick = onFit, modifier = Modifier.fillMaxWidth()) { Text("Fit to screen") }
        DisplayPicker(state, enabled = streaming, onSelect = onDisplay)
        // Only what the PC actually settled on: a stream with no audio track gets no sound button over silence.
        if (state.negotiation?.audioCodec != null) {
            OutlinedButton(onClick = onSound, modifier = Modifier.fillMaxWidth()) { Text(if (state.soundOn) "Mute sound" else "Unmute sound") }
        }

        Section("Transfer")
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedButton(onClick = onFiles, modifier = Modifier.weight(1f)) { Text("Files") }
            OutlinedButton(onClick = onClipboard, modifier = Modifier.weight(1f)) { Text("Clipboard") }
        }

        state.remoteState?.let { remote ->
            if (remote.unavailableReason != null) Text("The PC reports: ${remote.detail ?: remote.unavailableReason}", style = MaterialTheme.typography.bodySmall)
            if (remote.showing == "secure-desktop") Text("Showing the Windows lock or sign-in screen.", style = MaterialTheme.typography.bodySmall)
        }
        state.displaysNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }

        TextButton(onClick = onClose, modifier = Modifier.fillMaxWidth()) { Text("Disconnect", color = Color(0xFFFF8A80)) }
    }
}

@Composable
private fun Section(title: String) {
    Text(title.uppercase(), style = MaterialTheme.typography.labelSmall, color = Color(0xFF9E9E9E), modifier = Modifier.padding(top = 4.dp))
}

@Composable
private fun Choice(label: String, selected: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(8.dp))
            .background(if (selected) Color(0xFF2E5BFF) else Color(0x22FFFFFF))
            .alpha(if (enabled) 1f else 0.5f)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp, vertical = 8.dp),
    ) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = Color.White)
    }
}

/** While connecting, or when the stream stopped: what is happening, and a way out. */
@Composable
private fun StatusCard(
    state: RemoteDesktopUiState,
    reconnecting: Boolean,
    onReconnect: () -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Surface(color = Overlay, contentColor = OverlayText, shape = RoundedCornerShape(12.dp), modifier = modifier.padding(24.dp)) {
        Column(modifier = Modifier.padding(16.dp).width(360.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                if (state.phase == StreamPhase.STREAMING) "Waiting for the first picture…" else phaseWords(state.phase),
                fontWeight = FontWeight.SemiBold,
            )
            state.failure?.let {
                Text(it.message, color = Color(0xFFFF8A80))
                Text(it.recommendedAction, style = MaterialTheme.typography.bodySmall)
            }
            if (reconnecting) Text("Reconnecting by itself in a moment…", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (state.phase == StreamPhase.FAILED) TextButton(onClick = onReconnect) { Text("Reconnect now") }
                TextButton(onClick = onClose) { Text("Close") }
            }
        }
    }
}

@Composable
private fun Notice(text: String, modifier: Modifier = Modifier) {
    Surface(color = Overlay, contentColor = OverlayText, shape = RoundedCornerShape(8.dp), modifier = modifier) {
        Text(text, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp))
    }
}

/**
 * The phone keyboard, plus the keys a PC needs and a phone keyboard does not have.
 *
 * Ctrl, Alt, Shift and Win are held for the next key or character and then let go, like a phone keyboard's own
 * Shift. Typing goes to the PC as it happens; nothing is kept on the phone. The field asks for a password-style
 * keyboard, which types each character at once instead of holding a word for autocorrect, and does not learn what
 * the owner types on the PC.
 */
@Composable
private fun KeyboardBar(enabled: Boolean, send: (List<JsonObject>) -> Unit, onHide: () -> Unit, modifier: Modifier = Modifier) {
    var held by remember { mutableStateOf(HeldModifiers()) }
    val resetField = TextFieldValue(Typing.SENTINEL, TextRange(Typing.SENTINEL.length))
    var field by remember { mutableStateOf(resetField) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current

    LaunchedEffect(Unit) {
        focus.requestFocus()
        keyboard?.show()
    }

    fun press(key: Int) {
        if (!enabled) return
        send(held.around(InputEvents.keyPress(key)))
        held = HeldModifiers()
    }

    Surface(color = Overlay, contentColor = OverlayText, modifier = modifier) {
        Column {
            BasicTextField(
                value = field,
                onValueChange = { next ->
                    if (next.composition != null) {
                        field = next
                        return@BasicTextField
                    }
                    val edit = Typing.edit(field.text, next.text)
                    if (enabled && (edit.deleted > 0 || edit.inserted.isNotEmpty())) {
                        send(Typing.events(edit, held))
                        if (held.any) held = HeldModifiers()
                    }
                    field = if (Typing.needsReset(next.text)) resetField else next
                },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.None),
                modifier = Modifier.size(1.dp).alpha(0f).focusRequester(focus),
            )
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(4.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Key("⌨ Hide") {
                    keyboard?.hide()
                    onHide()
                }
                Key("Show") {
                    focus.requestFocus()
                    keyboard?.show()
                }
                Key("Ctrl", held.control) { held = held.copy(control = !held.control) }
                Key("Alt", held.alt) { held = held.copy(alt = !held.alt) }
                Key("Shift", held.shift) { held = held.copy(shift = !held.shift) }
                Key("Win", held.windows) { held = held.copy(windows = !held.windows) }
                Key("Esc") { press(VirtualKey.ESCAPE) }
                Key("Tab") { press(VirtualKey.TAB) }
                Key("←") { press(VirtualKey.LEFT) }
                Key("↑") { press(VirtualKey.UP) }
                Key("↓") { press(VirtualKey.DOWN) }
                Key("→") { press(VirtualKey.RIGHT) }
                Key("Del") { press(VirtualKey.DELETE) }
                Key("Home") { press(VirtualKey.HOME) }
                Key("End") { press(VirtualKey.END) }
                Key("PgUp") { press(VirtualKey.PAGE_UP) }
                Key("PgDn") { press(VirtualKey.PAGE_DOWN) }
                Key("PrtSc") { press(VirtualKey.PRINT_SCREEN) }
                (1..12).forEach { number -> Key("F$number") { press(VirtualKey.function(number)) } }
            }
        }
    }
}

@Composable
private fun Key(label: String, active: Boolean = false, onClick: () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(if (active) Color(0xFF2E5BFF) else Color(0x33FFFFFF))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 10.dp),
    ) {
        Text(label, color = Color.White, style = MaterialTheme.typography.bodyMedium)
    }
}
