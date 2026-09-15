package app.amizhthan.wolf.remote

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** Zoom, pan and two-finger gestures: the geometry that decides where on the PC a touch lands. */
class ViewportTest {
    private val width = 400f
    private val height = 200f

    @Test
    fun at_fit_a_touch_lands_exactly_where_it_did_without_zoom() {
        assertEquals(
            Picture.normalize(width, height, 1920, 1080, 123f, 77f),
            Picture.normalize(width, height, 1920, 1080, 123f, 77f, Viewport.FIT),
        )
        assertFalse(Viewport.FIT.zoomed)
    }

    @Test
    fun zooming_keeps_the_point_under_the_fingers_where_it_was() {
        val zoomed = Viewport.FIT.zoomBy(2f, 100f, 50f, width, height)

        assertEquals(2f, zoomed.scale, 0f)
        val (x, y) = zoomed.toView(100f, 50f)
        assertEquals(100f, x, 0.001f)
        assertEquals(50f, y, 0.001f)
    }

    @Test
    fun a_touch_on_a_zoomed_picture_lands_where_that_part_of_the_picture_is_drawn() {
        // The frame has the view's shape, so it fills it. At twice the size from the corner, the middle of the
        // screen shows the point a quarter of the way into the PC's screen.
        val point = Picture.normalize(width, height, 400, 200, 200f, 100f, Viewport(scale = 2f))!!

        assertEquals(0.25, point.x, 1e-6)
        assertEquals(0.25, point.y, 1e-6)
    }

    @Test
    fun a_touch_on_the_bars_of_a_zoomed_picture_is_still_dropped() {
        // A 4:3 frame in a 2:1 view has bars left and right; zoomed, the left bar is still not the PC.
        assertNull(Picture.normalize(width, height, 800, 600, 10f, 100f, Viewport(scale = 1.5f)))
    }

    @Test
    fun the_picture_cannot_be_zoomed_out_past_fit_or_in_past_the_limit() {
        assertEquals(Viewport.FIT, Viewport(2f, -100f, -50f).zoomBy(0.1f, 0f, 0f, width, height))
        assertEquals(Viewport.MAX_SCALE, Viewport.FIT.zoomBy(100f, 0f, 0f, width, height).scale, 0f)
        assertEquals(Viewport.FIT, Viewport.FIT.zoomBy(Float.NaN, 0f, 0f, width, height))
    }

    @Test
    fun panning_stops_at_the_edges_of_the_picture() {
        val panned = Viewport(scale = 2f).panBy(1000f, -1000f, width, height)

        assertEquals(0f, panned.offsetX, 0f)
        assertEquals(height - height * 2, panned.offsetY, 0f)
        assertEquals(Viewport.FIT, Viewport.FIT.panBy(50f, 50f, width, height))
    }

    @Test
    fun a_pinch_is_a_zoom_and_fingers_moving_together_are_a_scroll_decided_once() {
        val pinch = TwoFingerClassifier(slopPx = 10f)
        assertNull("two pixels of spread is not yet anything", pinch.update(1.01f, 0f, 0f, spanPx = 200f))
        assertEquals(TwoFingerIntent.ZOOM, pinch.update(1.1f, 1f, 0f, spanPx = 200f))

        val swipe = TwoFingerClassifier(slopPx = 10f)
        assertNull(swipe.update(1f, 0f, -4f, spanPx = 200f))
        assertEquals(TwoFingerIntent.SCROLL, swipe.update(1.001f, 0f, -12f, spanPx = 200f))
        assertEquals("a scroll does not become a zoom halfway through", TwoFingerIntent.SCROLL, swipe.update(1.5f, 0f, 0f, spanPx = 200f))
    }

    @Test
    fun fingers_moving_up_scroll_the_pc_down_as_a_phone_does() {
        val scroll = ScrollAccumulator(pixelsPerNotch = 60f)

        val (sideways, down) = scroll.add(0f, -60f)!!
        assertEquals(-1.0, down, 1e-6)
        assertEquals("0.0", sideways.toString())

        val (right, _) = scroll.add(-30f, 0f)!!
        assertEquals("fingers moving left bring in what is to the right", 0.5, right, 1e-6)
    }

    @Test
    fun a_tiny_movement_is_kept_until_it_amounts_to_something() {
        val scroll = ScrollAccumulator(pixelsPerNotch = 60f)

        assertNull(scroll.add(0f, -2f))
        assertNull(scroll.add(0f, -2f))
        assertEquals(-7.0 / 60, scroll.add(0f, -3f)!!.second, 1e-5)
        assertNull("what was sent is not sent again", scroll.add(0f, -1f))
    }

    @Test
    fun a_scroll_is_sent_in_both_directions_within_the_protocols_bounds() {
        val event = InputEvents.scroll(NormalizedPoint(0.5, 0.5), deltaY = -1.5, deltaX = 250.0)

        assertEquals("\"pointer.scroll\"", event["type"].toString())
        assertEquals("-1.5", event["deltaY"].toString())
        assertEquals("100.0", event["deltaX"].toString())
    }
}
