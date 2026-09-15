package app.amizhthan.wolf.remote

import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max

/**
 * How the picture is magnified on the phone.
 *
 * A PC's desktop on a phone-sized screen puts a close button a few millimetres wide, so the picture can be
 * zoomed to reach it. This is the phone's own view of the picture — nothing is sent to the PC, which keeps
 * streaming the same frames.
 *
 * The picture view is drawn scaled by [scale] from its top-left corner and moved by ([offsetX], [offsetY]) in
 * view pixels, and always covers the view: it cannot be zoomed out past fitting, or panned to show nothing.
 * No Android types, so the geometry is tested on the JVM.
 */
data class Viewport(val scale: Float = MIN_SCALE, val offsetX: Float = 0f, val offsetY: Float = 0f) {
    val zoomed: Boolean get() = scale > MIN_SCALE

    /** Zoom by [factor], keeping the point under ([focusX], [focusY]) where it is on the screen. */
    fun zoomBy(factor: Float, focusX: Float, focusY: Float, viewWidth: Float, viewHeight: Float): Viewport {
        if (!(factor > 0f) || viewWidth <= 0f || viewHeight <= 0f) return this
        val next = (scale * factor).coerceIn(MIN_SCALE, MAX_SCALE)
        val (pictureX, pictureY) = toView(focusX, focusY)
        return Viewport(next, focusX - pictureX * next, focusY - pictureY * next).clamped(viewWidth, viewHeight)
    }

    fun panBy(dx: Float, dy: Float, viewWidth: Float, viewHeight: Float): Viewport =
        copy(offsetX = offsetX + dx, offsetY = offsetY + dy).clamped(viewWidth, viewHeight)

    /** A point on the screen, as a point on the unzoomed picture view. */
    fun toView(x: Float, y: Float): Pair<Float, Float> = (x - offsetX) / scale to (y - offsetY) / scale

    private fun clamped(viewWidth: Float, viewHeight: Float): Viewport = copy(
        offsetX = offsetX.coerceIn(viewWidth - viewWidth * scale, 0f),
        offsetY = offsetY.coerceIn(viewHeight - viewHeight * scale, 0f),
    )

    companion object {
        const val MIN_SCALE = 1f

        /** Four times is enough to hit a title-bar button on a 4K desktop from a phone. */
        const val MAX_SCALE = 4f

        val FIT = Viewport()
    }
}

enum class TwoFingerIntent { ZOOM, SCROLL }

/**
 * Whether two fingers are pinching (zoom the picture on the phone) or moving together (scroll the PC).
 *
 * Decided once per gesture, as soon as the fingers have moved past the touch slop, and kept until they lift:
 * a scroll that became a zoom halfway through would move the picture out from under the owner's fingers.
 */
class TwoFingerClassifier(private val slopPx: Float) {
    var intent: TwoFingerIntent? = null
        private set

    private var zoom = 1f
    private var travelX = 0f
    private var travelY = 0f

    /** One movement: the change in finger spread as a factor, the centroid's travel, and the average spread. */
    fun update(zoomFactor: Float, panX: Float, panY: Float, spanPx: Float): TwoFingerIntent? {
        intent?.let { return it }
        zoom *= zoomFactor
        travelX += panX
        travelY += panY

        val spread = abs(zoom - 1f) * spanPx
        val travel = hypot(travelX, travelY)
        if (max(spread, travel) <= slopPx) return null
        return (if (spread * 2 > travel) TwoFingerIntent.ZOOM else TwoFingerIntent.SCROLL).also { intent = it }
    }
}

/**
 * Two-finger travel into wheel notches, the way a phone scrolls: fingers moving up move the content up, which
 * is scrolling down.
 *
 * Windows counts a notch up as positive and a notch right as positive. Movement is kept until it amounts to a
 * tenth of a notch, so a steady scroll is a few messages a second rather than one per touch event.
 */
class ScrollAccumulator(private val pixelsPerNotch: Float = InputEvents.PIXELS_PER_NOTCH) {
    private var x = 0f
    private var y = 0f

    /** Pixels of travel in; (deltaX, deltaY) in notches out, or null while it is still too little to send. */
    fun add(panX: Float, panY: Float): Pair<Double, Double>? {
        x += panX
        y += panY
        val deltaX = -x / pixelsPerNotch
        val deltaY = y / pixelsPerNotch
        if (abs(deltaX) < MIN_NOTCHES && abs(deltaY) < MIN_NOTCHES) return null
        x = 0f
        y = 0f
        // Adding zero turns a negative zero into zero, so a vertical scroll does not carry "-0.0" sideways.
        return (deltaX.toDouble() + 0.0) to (deltaY.toDouble() + 0.0)
    }

    private companion object {
        const val MIN_NOTCHES = 0.1f
    }
}
