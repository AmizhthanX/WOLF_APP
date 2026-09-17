package app.amizhthan.wolf.remote

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** A point on the remote picture, 0..1 on each axis. */
data class NormalizedPoint(val x: Double, val y: Double)

/**
 * Where a touch lands on the remote desktop.
 *
 * The picture is drawn aspect-fit — the web viewer's `object-fit: contain` — so there are black bars on
 * whichever axis the phone's shape does not match. A touch on a bar is not a touch at the edge of the
 * screen, and is dropped rather than clamped: clamping would move the remote pointer somewhere the owner
 * did not aim.
 */
object Picture {
    fun normalize(viewWidth: Float, viewHeight: Float, frameWidth: Int, frameHeight: Int, x: Float, y: Float): NormalizedPoint? {
        if (viewWidth <= 0f || viewHeight <= 0f || frameWidth <= 0 || frameHeight <= 0) return null

        val scale = minOf(viewWidth / frameWidth, viewHeight / frameHeight)
        val shownWidth = frameWidth * scale
        val shownHeight = frameHeight * scale
        val left = (viewWidth - shownWidth) / 2
        val top = (viewHeight - shownHeight) / 2

        val nx = (x - left) / shownWidth
        val ny = (y - top) / shownHeight
        if (nx < 0f || nx > 1f || ny < 0f || ny > 1f) return null
        return NormalizedPoint(nx.toDouble(), ny.toDouble())
    }

    /** The same, on a picture the owner has zoomed and panned: the touch is taken back through the zoom first. */
    fun normalize(viewWidth: Float, viewHeight: Float, frameWidth: Int, frameHeight: Int, x: Float, y: Float, viewport: Viewport): NormalizedPoint? {
        val (viewX, viewY) = viewport.toView(x, y)
        return normalize(viewWidth, viewHeight, frameWidth, frameHeight, viewX, viewY)
    }
}

/** Windows virtual-key codes the phone sends by name. Codes, not strings: nothing to parse differently. */
object VirtualKey {
    const val BACKSPACE = 0x08
    const val TAB = 0x09
    const val ENTER = 0x0D
    const val ESCAPE = 0x1B
    const val PAGE_UP = 0x21
    const val PAGE_DOWN = 0x22
    const val END = 0x23
    const val HOME = 0x24
    const val LEFT = 0x25
    const val UP = 0x26
    const val RIGHT = 0x27
    const val DOWN = 0x28
    const val INSERT = 0x2D
    const val DELETE = 0x2E
    const val SHIFT = 0x10
    const val CONTROL = 0x11
    const val ALT = 0x12
    const val SPACE = 0x20
    const val PRINT_SCREEN = 0x2C
    const val LEFT_WINDOWS = 0x5B
    const val F1 = 0x70

    /** F1..F12. */
    fun function(number: Int): Int {
        require(number in 1..12) { "No such function key: F$number" }
        return F1 + number - 1
    }

    /** The key for a letter, digit or space, for shortcuts like Ctrl+C; null for anything else. */
    fun forCharacter(character: Char): Int? = when (character) {
        in 'a'..'z' -> 0x41 + (character - 'a')
        in 'A'..'Z' -> 0x41 + (character - 'A')
        in '0'..'9' -> 0x30 + (character - '0')
        ' ' -> SPACE
        else -> null
    }

    /** The keys Windows only reads correctly with the extended flag — the same set `packages/protocol` lists. */
    private val EXTENDED = setOf(INSERT, DELETE, HOME, END, PAGE_UP, PAGE_DOWN, LEFT, UP, RIGHT, DOWN, 0x5B, 0x5C, 0x2C)

    fun isExtended(key: Int): Boolean = key in EXTENDED
}

/**
 * Input events in the shape `packages/protocol/src/input.ts` validates.
 *
 * Touch becomes pointer events at the touched point: a tap is a left click, a long press a right click,
 * a drag a left-button drag, two fingers a scroll. Text from the phone keyboard is sent as text — autocorrect and IMEs produce
 * characters with no honest key sequence — and the handful of keys a phone keyboard cannot type are sent
 * as virtual keys.
 */
object InputEvents {
    const val MAX_EVENTS_PER_BATCH = 128
    const val MAX_TEXT = 512

    /** Pixels of two-finger travel per wheel notch. */
    const val PIXELS_PER_NOTCH = 60f

    fun move(point: NormalizedPoint): JsonObject = buildJsonObject {
        put("type", "pointer.move")
        put("x", point.x)
        put("y", point.y)
        put("offsetMs", 0)
    }

    fun button(button: String, action: String, point: NormalizedPoint): JsonObject = buildJsonObject {
        put("type", "pointer.button")
        put("button", button)
        put("action", action)
        put("x", point.x)
        put("y", point.y)
        putJsonObject("modifiers") {
            put("shift", false)
            put("control", false)
            put("alt", false)
            put("meta", false)
        }
        put("offsetMs", 0)
    }

    /** Wheel notches in Windows' sense: positive [deltaY] scrolls up, positive [deltaX] scrolls right. */
    fun scroll(point: NormalizedPoint, deltaY: Double, deltaX: Double = 0.0): JsonObject = buildJsonObject {
        put("type", "pointer.scroll")
        put("x", point.x)
        put("y", point.y)
        put("deltaX", deltaX.coerceIn(-100.0, 100.0))
        put("deltaY", deltaY.coerceIn(-100.0, 100.0))
        putJsonObject("modifiers") {
            put("shift", false)
            put("control", false)
            put("alt", false)
            put("meta", false)
        }
        put("offsetMs", 0)
    }

    fun key(virtualKey: Int, action: String): JsonObject {
        require(virtualKey in 1..254) { "Not a virtual-key code: $virtualKey" }
        return buildJsonObject {
            put("type", "key")
            put("key", virtualKey)
            put("action", action)
            put("scanCode", JsonNull)
            put("extended", VirtualKey.isExtended(virtualKey))
            putJsonObject("modifiers") {
                put("shift", false)
                put("control", false)
                put("alt", false)
                put("meta", false)
            }
            put("offsetMs", 0)
        }
    }

    fun tap(point: NormalizedPoint): List<JsonObject> = listOf(move(point), button("left", "down", point), button("left", "up", point))

    fun longPress(point: NormalizedPoint): List<JsonObject> = listOf(move(point), button("right", "down", point), button("right", "up", point))

    fun keyPress(virtualKey: Int): List<JsonObject> = listOf(key(virtualKey, "down"), key(virtualKey, "up"))

    /** Text in pieces no longer than the protocol allows, split on code points so no character is cut in half. */
    fun text(value: String): List<JsonObject> {
        val events = mutableListOf<JsonObject>()
        var start = 0
        while (start < value.length) {
            var end = minOf(value.length, start + MAX_TEXT)
            if (end < value.length && Character.isHighSurrogate(value[end - 1])) end -= 1
            events += buildJsonObject {
                put("type", "text")
                put("value", value.substring(start, end))
                put("offsetMs", 0)
            }
            start = end
        }
        return events
    }
}

/** What this phone can decode, in the order it would rather have it. */
object DecoderCodecs {
    private val ORDER = listOf("h264", "av1", "vp9", "vp8")

    /**
     * From libwebrtc's decoder names to the protocol's codec names — only what the decoder factory reports.
     *
     * The web client claims H.264 as a floor when its browser will not say, because every browser decodes
     * it. That is not true here, and the first real stream found out: libwebrtc on Android has no software
     * H.264 decoder, so a phone (or emulator) without a hardware one cannot decode it at all. Claiming it
     * anyway negotiated a stream the phone's own peer connection could not answer, and the PC refused the
     * answer. A phone with nothing in common with the PC is told so by the PC as a codec mismatch.
     */
    fun fromDecoderNames(names: Collection<String>): List<String> {
        val available = names.mapNotNull {
            when (it.uppercase()) {
                "H264" -> "h264"
                "AV1" -> "av1"
                "VP9" -> "vp9"
                "VP8" -> "vp8"
                else -> null
            }
        }.toSet()
        return ORDER.filter { it in available }
    }

    /**
     * The H.264 profiles this phone's decoders accept, from each decoder's `profile-level-id`.
     *
     * A decoder for a profile also decodes the profiles it contains: High takes Main and Constrained
     * Baseline, Main takes Constrained Baseline, and Baseline takes its constrained subset. Sent with the
     * stream request so the PC can encode something the phone can actually decode; an emulator reports only
     * Constrained Baseline, and a High-profile offer is one its WebRTC stack rejects.
     */
    fun h264Profiles(profileLevelIds: Collection<String>): List<String> {
        val accepted = mutableSetOf<String>()
        for (id in profileLevelIds) {
            when (id.take(2).lowercase()) {
                "64" -> accepted += listOf("high", "main", "constrained-baseline")
                "4d" -> accepted += listOf("main", "constrained-baseline")
                "42" -> accepted += "constrained-baseline"
            }
        }
        return listOf("high", "main", "constrained-baseline").filter { it in accepted }
    }
}

/** The built-in profiles a phone would pick, sent whole: the agent reads every field. */
enum class StreamProfile(val label: String, val json: JsonObject) {
    SHARP("Sharp", profile("Phone — Sharp", maxWidth = null, maxHeight = null, fps = 60, minBps = 2_000_000, maxBps = 20_000_000, bias = "quality")),
    BALANCED("Balanced", profile("Phone — Balanced", maxWidth = 1920, maxHeight = 1080, fps = 60, minBps = 1_000_000, maxBps = 10_000_000, bias = "balanced")),
    DATA_SAVER("Data saver", profile("Mobile Data — Low Bandwidth", maxWidth = 1280, maxHeight = 720, fps = 30, minBps = 400_000, maxBps = 3_000_000, bias = "performance")),
}

private fun profile(name: String, maxWidth: Int?, maxHeight: Int?, fps: Int, minBps: Int, maxBps: Int, bias: String): JsonObject = buildJsonObject {
    put("name", name)
    put("maxWidthPixels", maxWidth?.let(::JsonPrimitive) ?: JsonNull)
    put("maxHeightPixels", maxHeight?.let(::JsonPrimitive) ?: JsonNull)
    put("targetFps", fps)
    put("minBitrateBps", minBps)
    put("maxBitrateBps", maxBps)
    put("codecPreference", JsonArray(emptyList()))
    // Sound is asked for in the stream request, when the owner wants it; the PC fills this in with what it gave.
    put("audioEnabled", false)
    put("qualityBias", bias)
    put("adaptive", true)
    putJsonObject("overrides") {
        put("bitrateBps", JsonNull)
        put("frameRate", JsonNull)
        put("resolutionScale", JsonNull)
    }
}
