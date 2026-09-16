package app.amizhthan.wolf.remote

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** Rename, move, delete and new folder from the phone: the messages, the names refused before sending, and the answers. */
class FileChangesTest {
    @Test
    fun changes_are_the_protocol_shape() {
        assertEquals("""{"kind":"file.delete","path":"C:\\a.txt"}""", FileMessages.delete("C:\\a.txt").toString())
        assertEquals("""{"kind":"file.rename","path":"C:\\a.txt","newName":"b.txt"}""", FileMessages.rename("C:\\a.txt", "b.txt").toString())
        assertEquals("""{"kind":"file.move","path":"C:\\a.txt","destinationFolder":"C:\\Archive"}""", FileMessages.move("C:\\a.txt", "C:\\Archive").toString())
        assertEquals("""{"kind":"file.create-folder","path":"C:\\New"}""", FileMessages.createFolder("C:\\New").toString())
    }

    @Test
    fun a_name_windows_would_not_allow_is_not_sent() {
        assertTrue(FileMessages.validName("Quarterly final.txt"))
        for (bad in listOf("", ".", "..", "a\\b", "a/b", "c:d", "star*", "ends.", "ends ", "tab\tname")) {
            assertFalse(bad, FileMessages.validName(bad))
        }
        try {
            FileMessages.rename("C:\\a.txt", "..")
            fail("an invalid name must not be built")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun a_change_waits_for_done_and_a_refusal_is_the_pc_s_words() = runBlocking {
        var answer: JsonObject = buildJsonObject { put("kind", "file.done"); put("operation", "delete") }
        val transfer = FileTransfer { message ->
            assertEquals("file.delete", (message["kind"] as JsonPrimitive).content)
            if ((answer["kind"] as JsonPrimitive).content == "file.refused") throw FileRefusalException(FileMessages.refusal(answer))
            answer
        }

        transfer.change(FileMessages.delete("C:\\a.txt"))

        answer = buildJsonObject {
            put("kind", "file.refused")
            put("reason", "rejected")
            put("detail", "WOLF does not change Windows' own folders.")
        }
        try {
            transfer.change(FileMessages.delete("C:\\Windows\\notepad.exe"))
            fail("a refusal must be thrown")
        } catch (error: FileRefusalException) {
            assertEquals("rejected", error.refusal.reason)
        }
    }
}
