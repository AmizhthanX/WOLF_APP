package app.amizhthan.wolf.remote

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Parsec-style stream: a touchpad cursor, held modifiers, the phone keyboard, and quality presets. */
class TouchpadTest {
    private fun JsonObject.type() = this["type"]!!.jsonPrimitive.content
    private fun JsonObject.keyAndAction() = this["key"]!!.jsonPrimitive.int to this["action"]!!.jsonPrimitive.content

    @Test
    fun a_slow_finger_moves_the_cursor_by_the_distance_it_travels_and_a_quick_one_further() {
        val start = TouchpadCursor()
        val slow = start.moveBy(10f, 0f, shownWidthPx = 1000f, shownHeightPx = 500f)
        val quick = start.moveBy(100f, 0f, shownWidthPx = 1000f, shownHeightPx = 500f)

        // 10 px of 1000 is 1%, a little accelerated; 100 px is 10%, accelerated to the cap.
        assertTrue(slow.x > 0.51 && slow.x < 0.52)
        assertEquals(0.5 + 0.1 * TouchpadCursor.MAX_ACCELERATION, quick.x, 1e-6)
        assertEquals(0.5, quick.y, 1e-9)
    }

    @Test
    fun the_cursor_stops_at_the_edges_of_the_pc_screen() {
        val cursor = TouchpadCursor(0.98, 0.02).moveBy(500f, -500f, 1000f, 1000f)
        assertEquals(1.0, cursor.x, 0.0)
        assertEquals(0.0, cursor.y, 0.0)
        assertEquals(TouchpadCursor(0.3, 0.3), TouchpadCursor(0.3, 0.3).moveBy(5f, 5f, 0f, 0f))
    }

    @Test
    fun the_cursor_is_drawn_where_the_pc_picture_is_on_the_phone_zoomed_or_not() {
        // A 1920×1080 desktop in a 2000×1000 view: fitted to the height, with bars left and right.
        val fitted = PictureRect.of(2000f, 1000f, 1920, 1080, Viewport.FIT)!!
        val (x, y) = fitted.toScreen(NormalizedPoint(0.5, 0.5))
        assertEquals(1000f, x, 0.5f)
        assertEquals(500f, y, 0.5f)

        val zoomed = PictureRect.of(2000f, 1000f, 1920, 1080, Viewport(scale = 2f, offsetX = -1000f, offsetY = -500f))!!
        val (zx, zy) = zoomed.toScreen(NormalizedPoint(0.5, 0.5))
        assertEquals(1000f, zx, 0.5f)
        assertEquals(500f, zy, 0.5f)
        assertNull(PictureRect.of(2000f, 1000f, 0, 0, Viewport.FIT))
    }

    @Test
    fun held_modifiers_are_pressed_around_the_key_and_always_released_in_reverse() {
        val events = HeldModifiers(control = true, shift = true).around(InputEvents.keyPress(VirtualKey.ESCAPE))
        assertEquals(
            listOf(
                VirtualKey.CONTROL to "down", VirtualKey.SHIFT to "down",
                VirtualKey.ESCAPE to "down", VirtualKey.ESCAPE to "up",
                VirtualKey.SHIFT to "up", VirtualKey.CONTROL to "up",
            ),
            events.map { it.keyAndAction() },
        )
        assertEquals(1, HeldModifiers().around(listOf(InputEvents.move(NormalizedPoint(0.1, 0.1)))).size)
    }

    @Test
    fun the_phone_keyboard_field_reports_typing_and_backspace() {
        assertEquals(Typing.Edit(0, "hé"), Typing.edit(Typing.SENTINEL + "hé"))
        assertEquals(Typing.Edit(1, ""), Typing.edit(Typing.SENTINEL.dropLast(1)))
        // Everything selected and replaced: both sentinel characters gone, the new text typed.
        assertEquals(Typing.Edit(2, "x"), Typing.edit("x"))
    }

    @Test
    fun plain_typing_is_text_and_enter_and_backspace_are_keys() {
        val events = Typing.events(Typing.Edit(deleted = 1, inserted = "ok\nnext"), HeldModifiers())
        assertEquals(listOf("key", "key", "text", "key", "key", "text"), events.map { it.type() })
        assertEquals("ok", events[2]["value"]!!.jsonPrimitive.content)
        assertEquals(VirtualKey.ENTER, events[3]["key"]!!.jsonPrimitive.int)
    }

    @Test
    fun with_ctrl_held_a_letter_is_its_key_so_windows_sees_the_shortcut() {
        val events = Typing.events(Typing.Edit(0, "c"), HeldModifiers(control = true))
        assertEquals(
            listOf(VirtualKey.CONTROL to "down", 0x43 to "down", 0x43 to "up", VirtualKey.CONTROL to "up"),
            events.map { it.keyAndAction() },
        )
        // A character with no key of its own is still typed, inside the held modifier.
        assertEquals(listOf("key", "text", "key"), Typing.events(Typing.Edit(0, "€"), HeldModifiers(alt = true)).map { it.type() })
        assertTrue(Typing.events(Typing.Edit(0, ""), HeldModifiers(control = true)).isEmpty())
    }

    @Test
    fun function_and_character_keys_have_their_windows_codes() {
        assertEquals(0x70, VirtualKey.function(1))
        assertEquals(0x7B, VirtualKey.function(12))
        assertEquals(0x41, VirtualKey.forCharacter('A'))
        assertEquals(0x5A, VirtualKey.forCharacter('z'))
        assertEquals(0x39, VirtualKey.forCharacter('9'))
        assertNull(VirtualKey.forCharacter('!'))
    }

    @Test
    fun quality_presets_are_whole_profiles_the_protocol_accepts() {
        StreamQuality.entries.forEach { quality ->
            val profile = quality.profile.json
            val min = profile["minBitrateBps"]!!.jsonPrimitive.int
            val max = profile["maxBitrateBps"]!!.jsonPrimitive.int
            assertTrue("${quality.label}: max below min", max >= min)
            assertTrue(profile["qualityBias"]!!.jsonPrimitive.content in setOf("quality", "balanced", "performance"))
            assertEquals(quality, StreamQuality.of(quality.profile))
        }
        assertEquals(1080, StreamProfile.BALANCED.json["maxHeightPixels"]!!.jsonPrimitive.int)
    }
}
