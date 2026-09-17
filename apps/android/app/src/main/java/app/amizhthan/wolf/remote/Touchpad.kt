package app.amizhthan.wolf.remote

import kotlinx.serialization.json.JsonObject
import kotlin.math.hypot
import kotlin.math.min

/**
 * The phone as a laptop touchpad: the finger moves a cursor rather than being the cursor.
 *
 * A PC's desktop on a phone puts every target under a fingertip-sized blur, and direct touch cannot point at
 * anything smaller than a finger. A touchpad can: the cursor moves by how far the finger travels, faster for a
 * flick than for a slow drag, and clicks happen wherever the cursor is. This is how Parsec and Chrome Remote
 * Desktop drive a PC from a phone, and what the owner asked for.
 *
 * Positions are 0..1 on the PC's picture, as the input protocol wants. No Android types: tested on the JVM.
 */
data class TouchpadCursor(val x: Double = 0.5, val y: Double = 0.5) {
    val point: NormalizedPoint get() = NormalizedPoint(x, y)

    /**
     * Move by a finger's travel of ([dxPx], [dyPx]) screen pixels over a picture drawn [shownWidthPx] by
     * [shownHeightPx] on screen (after zoom).
     *
     * Travel across the whole visible picture moves the cursor across it once at slow speed; quick movements are
     * accelerated up to [MAX_ACCELERATION] times, so crossing a large desktop does not take several swipes.
     */
    fun moveBy(dxPx: Float, dyPx: Float, shownWidthPx: Float, shownHeightPx: Float): TouchpadCursor {
        if (shownWidthPx <= 0f || shownHeightPx <= 0f) return this
        val distance = hypot(dxPx, dyPx)
        val acceleration = 1.0 + min(distance / ACCELERATION_PIXELS, MAX_ACCELERATION - 1.0)
        return TouchpadCursor(
            x = (x + dxPx / shownWidthPx * acceleration).coerceIn(0.0, 1.0),
            y = (y + dyPx / shownHeightPx * acceleration).coerceIn(0.0, 1.0),
        )
    }

    companion object {
        /** Pixels of travel in one touch event at which movement is twice as fast. */
        const val ACCELERATION_PIXELS = 24.0
        const val MAX_ACCELERATION = 3.0
    }
}

/**
 * Where the PC's picture sits on the phone's screen: drawn aspect-fit inside the view, then zoomed and panned.
 *
 * The inverse of [Picture.normalize], for drawing the touchpad cursor where the PC's cursor is, and for keeping
 * it on screen while zoomed.
 */
data class PictureRect(val left: Float, val top: Float, val width: Float, val height: Float) {
    fun toScreen(point: NormalizedPoint): Pair<Float, Float> =
        (left + point.x.toFloat() * width) to (top + point.y.toFloat() * height)

    companion object {
        fun of(viewWidth: Float, viewHeight: Float, frameWidth: Int, frameHeight: Int, viewport: Viewport): PictureRect? {
            if (viewWidth <= 0f || viewHeight <= 0f || frameWidth <= 0 || frameHeight <= 0) return null
            val fit = minOf(viewWidth / frameWidth, viewHeight / frameHeight)
            val fitWidth = frameWidth * fit
            val fitHeight = frameHeight * fit
            val fitLeft = (viewWidth - fitWidth) / 2
            val fitTop = (viewHeight - fitHeight) / 2
            return PictureRect(
                left = fitLeft * viewport.scale + viewport.offsetX,
                top = fitTop * viewport.scale + viewport.offsetY,
                width = fitWidth * viewport.scale,
                height = fitHeight * viewport.scale,
            )
        }
    }
}

/** Modifier keys held for the next key or character, the way a phone's on-screen Ctrl and Alt work. */
data class HeldModifiers(
    val control: Boolean = false,
    val alt: Boolean = false,
    val shift: Boolean = false,
    val windows: Boolean = false,
) {
    val any: Boolean get() = control || alt || shift || windows

    private fun keys(): List<Int> = buildList {
        if (control) add(VirtualKey.CONTROL)
        if (alt) add(VirtualKey.ALT)
        if (shift) add(VirtualKey.SHIFT)
        if (windows) add(VirtualKey.LEFT_WINDOWS)
    }

    /**
     * [events] with every held modifier pressed before and released after, in reverse order.
     *
     * Always released in the same batch: a Ctrl left down on the PC would turn the owner's next click into a
     * Ctrl-click, somewhere they cannot see from the phone.
     */
    fun around(events: List<JsonObject>): List<JsonObject> {
        val held = keys()
        return held.map { InputEvents.key(it, "down") } + events + held.reversed().map { InputEvents.key(it, "up") }
    }
}

/** What a phone keyboard typed, as input for the PC. */
object Typing {
    /**
     * The keyboard's field starts as [SENTINEL] with the cursor at its end, and each edit is read against what the
     * field held just before it: characters that went are Backspaces, characters that came are typed. Phone keyboards
     * send Backspace as an edit, not a key, so a field that started empty could never report one.
     *
     * Read against the previous text, not against the sentinel. The first version put the sentinel back after every
     * edit, and a keyboard typing faster than the screen redrew still held the old text: "hello wolf" reached the
     * owner's PC as "o o wo wollf". The field is only put back to the sentinel once it grows long ([MAX_FIELD]) or
     * the sentinel itself is deleted.
     */
    const val SENTINEL = "​​"
    const val MAX_FIELD = 256

    data class Edit(val deleted: Int, val inserted: String)

    fun edit(before: String, after: String): Edit {
        val common = before.commonPrefixWith(after).length
        return Edit(deleted = before.length - common, inserted = after.substring(common))
    }

    /** Whether the field should go back to just the sentinel after holding [text]. */
    fun needsReset(text: String): Boolean = !text.startsWith(SENTINEL) || text.length > MAX_FIELD

    /**
     * The events for one edit.
     *
     * Plain typing goes as text, which carries any character any keyboard can produce. With a modifier held
     * (Ctrl+C, Alt+F4 and the like) a letter or digit has to be a key, because Windows reads shortcuts from keys,
     * not characters; anything without a key of its own is still sent as text.
     */
    fun events(edit: Edit, held: HeldModifiers): List<JsonObject> {
        val events = mutableListOf<JsonObject>()
        repeat(edit.deleted) { events += InputEvents.keyPress(VirtualKey.BACKSPACE) }

        val pending = StringBuilder()
        fun flush() {
            if (pending.isNotEmpty()) events += InputEvents.text(pending.toString())
            pending.clear()
        }

        for (character in edit.inserted) {
            val key = when {
                character == '\n' -> VirtualKey.ENTER
                held.any -> VirtualKey.forCharacter(character)
                else -> null
            }
            if (key == null) {
                pending.append(character)
            } else {
                flush()
                events += InputEvents.keyPress(key)
            }
        }
        flush()
        return if (held.any && events.isNotEmpty()) held.around(events) else events
    }
}

/**
 * How sharp the picture is, against how much data it uses. Changed while streaming, without restarting.
 *
 * The first phone stream ran at the old "Mobile data" profile — 720p at no more than 3 Mbps — and the owner
 * found text unreadable. Balanced is the new default: 1080p at up to 10 Mbps, which a 4G or 5G connection carries.
 */
enum class StreamQuality(val label: String, val description: String, val profile: StreamProfile) {
    SHARP("Sharp", "The PC's full resolution, 60 fps, up to 20 Mbps", StreamProfile.SHARP),
    BALANCED("Balanced", "Up to 1080p, 60 fps, up to 10 Mbps", StreamProfile.BALANCED),
    DATA_SAVER("Data saver", "Up to 720p, 30 fps, up to 3 Mbps", StreamProfile.DATA_SAVER),
    ;

    companion object {
        fun of(profile: StreamProfile): StreamQuality = entries.first { it.profile == profile }
    }
}
