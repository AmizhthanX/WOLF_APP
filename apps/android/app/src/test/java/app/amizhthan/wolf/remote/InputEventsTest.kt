package app.amizhthan.wolf.remote

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Touch to remote coordinates, input event shapes, stream ids and codecs. */
class InputEventsTest {

    @Test
    fun a_touch_is_normalised_against_the_picture_not_the_view() {
        // A 1920x1080 picture in a 1080x2000 portrait view: 1080 wide, ~607 tall, centred vertically.
        val centre = Picture.normalize(1080f, 2000f, 1920, 1080, 540f, 1000f)!!
        assertEquals(0.5, centre.x, 1e-6)
        assertEquals(0.5, centre.y, 1e-6)

        val topLeft = Picture.normalize(1080f, 2000f, 1920, 1080, 0f, (2000f - 607.5f) / 2)!!
        assertEquals(0.0, topLeft.x, 1e-6)
        assertEquals(0.0, topLeft.y, 1e-3)
    }

    @Test
    fun a_touch_on_the_letterbox_is_not_a_touch_at_the_edge() {
        assertNull(Picture.normalize(1080f, 2000f, 1920, 1080, 540f, 100f))
        // Landscape phone, portrait picture: bars left and right.
        assertNull(Picture.normalize(2000f, 1080f, 1080, 1920, 50f, 540f))
        assertNull("no picture yet", Picture.normalize(1080f, 2000f, 0, 0, 540f, 1000f))
    }

    @Test
    fun a_tap_is_a_left_click_and_a_long_press_a_right_click_at_the_point() {
        val point = NormalizedPoint(0.3, 0.6)
        val tap = InputEvents.tap(point)
        assertEquals(listOf("pointer.move", "pointer.button", "pointer.button"), tap.map { it["type"]!!.jsonPrimitive.content })
        assertEquals(listOf("down", "up"), tap.drop(1).map { it["action"]!!.jsonPrimitive.content })
        assertEquals("left", tap[1]["button"]!!.jsonPrimitive.content)
        assertEquals("right", InputEvents.longPress(point)[1]["button"]!!.jsonPrimitive.content)
    }

    @Test
    fun keys_that_need_the_extended_flag_carry_it() {
        assertEquals("true", InputEvents.key(VirtualKey.DELETE, "down")["extended"].toString())
        assertEquals("false", InputEvents.key(VirtualKey.ENTER, "down")["extended"].toString())
        assertEquals(JsonNull, InputEvents.key(VirtualKey.ENTER, "down")["scanCode"])
        assertTrue(runCatching { InputEvents.key(0, "down") }.isFailure)
        assertTrue(runCatching { InputEvents.key(255, "down") }.isFailure)
    }

    @Test
    fun long_text_is_split_within_the_limit_without_cutting_a_character() {
        val emoji = "😀"
        val text = "a".repeat(511) + emoji + "b".repeat(700)
        val events = InputEvents.text(text)

        assertTrue(events.all { it["value"]!!.jsonPrimitive.content.length <= InputEvents.MAX_TEXT })
        assertEquals(text, events.joinToString("") { it["value"]!!.jsonPrimitive.content })
        assertTrue(events.none { Character.isHighSurrogate(it["value"]!!.jsonPrimitive.content.last()) })
    }

    @Test
    fun scroll_is_bounded() {
        assertEquals("100.0", InputEvents.scroll(NormalizedPoint(0.5, 0.5), 1_000.0)["deltaY"].toString())
    }

    @Test
    fun stream_ids_are_wolf_identifiers_that_sort_by_time() {
        val earlier = Ulid.next(1_700_000_000_000)
        val later = Ulid.next(1_700_000_000_001)

        assertTrue(Ulid.PATTERN.matches(earlier))
        assertTrue(earlier < later)
        assertTrue(earlier.substring(0, 10) != later.substring(0, 10))
        assertTrue((1..50).map { Ulid.next() }.toSet().size == 50)
    }

    @Test
    fun h264_profiles_are_read_from_decoder_profile_level_ids_including_what_each_contains() {
        // The emulator's only H.264 decoder: Constrained Baseline 3.1.
        assertEquals(listOf("constrained-baseline"), DecoderCodecs.h264Profiles(listOf("42e01f")))
        // A phone with a High-profile hardware decoder takes everything below it too.
        assertEquals(listOf("high", "main", "constrained-baseline"), DecoderCodecs.h264Profiles(listOf("42e01f", "640c1f")))
        assertEquals(listOf("main", "constrained-baseline"), DecoderCodecs.h264Profiles(listOf("4d001f")))
        assertEquals(emptyList<String>(), DecoderCodecs.h264Profiles(emptyList()))
    }

    @Test
    fun the_phone_claims_only_what_its_decoders_report() {
        assertEquals(listOf("h264", "vp9", "vp8"), DecoderCodecs.fromDecoderNames(listOf("VP8", "VP9", "H264", "H265")))
        // No H.264 floor on Android: without a hardware decoder there is no H.264 decoder at all, and
        // claiming one negotiated a stream the phone could not answer.
        assertEquals(listOf("av1", "vp9", "vp8"), DecoderCodecs.fromDecoderNames(listOf("VP8", "VP9", "AV1")))
        assertEquals(emptyList<String>(), DecoderCodecs.fromDecoderNames(emptyList()))
    }
}
