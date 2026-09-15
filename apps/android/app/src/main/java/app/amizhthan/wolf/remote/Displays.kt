package app.amizhthan.wolf.remote

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/** One of a PC's displays, as `remote-desktop.list-displays` reports it. */
data class RemoteDisplay(val id: String, val name: String, val widthPixels: Int, val heightPixels: Int, val primary: Boolean)

object Displays {
    /** The protocol's bound on a display id. */
    private const val MAX_ID = 256

    /**
     * The displays in a list-displays result.
     *
     * An entry without a usable id or size is left out rather than guessed at: a guessed id is a switch the PC
     * would refuse, and a guessed size is a picture described wrongly.
     */
    fun parse(result: JsonElement?): List<RemoteDisplay> {
        val displays = (result as? JsonObject)?.get("displays") as? JsonArray ?: return emptyList()
        return displays.mapNotNull { element ->
            val display = element as? JsonObject ?: return@mapNotNull null
            val id = display.text("id")?.takeIf { it.length in 1..MAX_ID } ?: return@mapNotNull null
            val width = display.number("widthPixels")?.takeIf { it > 0 } ?: return@mapNotNull null
            val height = display.number("heightPixels")?.takeIf { it > 0 } ?: return@mapNotNull null
            RemoteDisplay(
                id = id,
                name = display.text("name")?.takeIf { it.isNotBlank() } ?: "Display",
                widthPixels = width,
                heightPixels = height,
                primary = (display["primary"] as? JsonPrimitive)?.booleanOrNull == true,
            )
        }
    }

    fun label(display: RemoteDisplay): String =
        listOfNotNull(display.name, "${display.widthPixels}×${display.heightPixels}", "primary".takeIf { display.primary }).joinToString(" · ")
}

private fun JsonObject.text(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonObject.number(key: String): Int? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull
