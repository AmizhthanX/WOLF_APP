package app.amizhthan.wolf.remote

import app.amizhthan.wolf.api.Commands
import app.amizhthan.wolf.api.WolfJson
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The PC's displays, as the agent lists them, and the command that asks. */
class DisplaysTest {
    @Test
    fun the_command_is_the_protocols_list_displays() {
        assertEquals(
            """{"type":"remote-desktop.list-displays","payload":{"refresh":true}}""",
            Commands.listDisplays().toString(),
        )
    }

    @Test
    fun displays_are_read_from_the_agents_result() {
        val result = WolfJson.parseToJsonElement(
            """{"displays":[{"id":"\\\\.\\DISPLAY1","name":"DELL U2723QE","widthPixels":2560,"heightPixels":1440,"refreshHz":60,"primary":true,"scaleFactor":1.5,"hdr":false,"originX":0,"originY":0},{"id":"\\\\.\\DISPLAY2","name":"","widthPixels":1920,"heightPixels":1080,"refreshHz":null,"primary":false,"scaleFactor":null,"hdr":false,"originX":2560,"originY":0}],"observedAt":"2026-09-15T10:00:00Z"}""",
        )

        assertEquals(
            listOf(
                RemoteDisplay("\\\\.\\DISPLAY1", "DELL U2723QE", 2560, 1440, primary = true),
                RemoteDisplay("\\\\.\\DISPLAY2", "Display", 1920, 1080, primary = false),
            ),
            Displays.parse(result),
        )
    }

    @Test
    fun an_entry_that_cannot_be_switched_to_or_described_is_left_out() {
        val tooLong = "d".repeat(257)
        val result = WolfJson.parseToJsonElement(
            """{"displays":[{"name":"no id","widthPixels":1920,"heightPixels":1080},{"id":"","widthPixels":1920,"heightPixels":1080},{"id":"$tooLong","widthPixels":1920,"heightPixels":1080},{"id":7,"widthPixels":1920,"heightPixels":1080},{"id":"no size","widthPixels":0,"heightPixels":1080},{"id":"text size","widthPixels":"1920","heightPixels":1080},"not an object",{"id":"ok","widthPixels":1280,"heightPixels":720}]}""",
        )

        assertEquals(listOf("ok"), Displays.parse(result).map { it.id })
        assertTrue(Displays.parse(null).isEmpty())
        assertTrue(Displays.parse(JsonNull).isEmpty())
        assertTrue(Displays.parse(JsonPrimitive("displays")).isEmpty())
    }

    @Test
    fun a_display_is_named_with_its_size_and_whether_it_is_primary() {
        assertEquals("DELL U2723QE · 2560×1440 · primary", Displays.label(RemoteDisplay("d1", "DELL U2723QE", 2560, 1440, primary = true)))
        assertEquals("LG · 1920×1080", Displays.label(RemoteDisplay("d2", "LG", 1920, 1080, primary = false)))
    }
}
