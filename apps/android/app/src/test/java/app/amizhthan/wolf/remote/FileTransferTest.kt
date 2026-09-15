package app.amizhthan.wolf.remote

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Base64
import kotlin.random.Random

/**
 * Moving files a chunk at a time, against a fake PC that behaves like the session host's `FileChannel`:
 * contiguous offsets, a part file renamed into place on the last chunk, a checksum on every chunk.
 */
class FileTransferTest {
    private val transferId = "01J9ZQK7T0000000000000000T"

    private fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull

    /** The session host's file channel, as far as these tests need it. */
    private class FakePc(val files: MutableMap<String, ByteArray> = mutableMapOf()) {
        val received = mutableListOf<JsonObject>()
        val parts = mutableMapOf<String, ByteArrayOutputStream>()
        var corruptNextRead = false
        var misreportWritten = false
        var damageAssembledFile = false
        var refuseWriteWith: String? = null

        fun answer(message: JsonObject): JsonObject {
            received += message
            val path = (message["path"] as? JsonPrimitive)?.contentOrNull
            return when ((message["kind"] as JsonPrimitive).content) {
                "file.read" -> {
                    val file = files[path] ?: return refused("not-found", "Nothing is there.")
                    val offset = message["offset"]!!.jsonPrimitive.long.toInt()
                    val length = message["length"]!!.jsonPrimitive.long.toInt()
                    val chunk = file.copyOfRange(offset, minOf(file.size, offset + length))
                    val sha = if (corruptNextRead) "0".repeat(64).also { corruptNextRead = false } else FileMessages.sha256Hex(chunk)
                    buildJsonObject {
                        put("kind", "file.chunk")
                        put("offset", offset)
                        put("data", Base64.getEncoder().encodeToString(chunk))
                        put("sha256", sha)
                        put("eof", offset + chunk.size >= file.size)
                        put("totalBytes", file.size)
                    }
                }
                "file.write" -> {
                    refuseWriteWith?.let { return refused(it, "A file is already there.") }
                    val id = message["transferId"]!!.jsonPrimitive.content
                    val part = parts.getOrPut(id) { ByteArrayOutputStream() }
                    val offset = message["offset"]!!.jsonPrimitive.long
                    val bytes = Base64.getDecoder().decode(message["data"]!!.jsonPrimitive.content)
                    if (FileMessages.sha256Hex(bytes) != message["sha256"]!!.jsonPrimitive.content) return refused("corrupt", "Checksum.")
                    if (offset != part.size().toLong()) return written(id, part.size().toLong(), null, false)
                    part.write(bytes)
                    val final = (message["final"] as JsonPrimitive).booleanOrNull == true
                    if (!final) {
                        return written(id, if (misreportWritten) part.size() - 1L else part.size().toLong(), null, false)
                    }
                    val assembled = part.toByteArray()
                    files[path!!] = assembled
                    parts.remove(id)
                    val digest = if (damageAssembledFile) "f".repeat(64) else FileMessages.sha256Hex(assembled)
                    written(id, assembled.size.toLong(), digest, true)
                }
                "file.cancel" -> {
                    parts.remove(message["transferId"]!!.jsonPrimitive.content)
                    refused("not-found", "No such transfer.")
                }
                else -> refused("unsupported", "Not in this fake.")
            }
        }

        private fun written(id: String, bytes: Long, sha: String?, complete: Boolean) = buildJsonObject {
            put("kind", "file.written")
            put("transferId", id)
            put("bytesWritten", bytes)
            put("sha256", sha)
            put("complete", complete)
        }

        private fun refused(reason: String, detail: String) = buildJsonObject {
            put("kind", "file.refused")
            put("reason", reason)
            put("detail", detail)
            put("limitation", false)
        }
    }

    /** What the stream does with an answer: a refusal becomes the exception, anything else is returned. */
    private fun transferFor(pc: FakePc) = FileTransfer { message ->
        val answer = pc.answer(message)
        if ((answer["kind"] as JsonPrimitive).content == "file.refused") throw FileRefusalException(FileMessages.refusal(answer))
        answer
    }

    private fun kinds(pc: FakePc) = pc.received.map { it.text("kind") }

    @Test
    fun messages_are_the_protocol_shape() {
        assertEquals("""{"kind":"file.list","path":null}""", FileMessages.list(null).toString())
        assertEquals("""{"kind":"file.read","path":"C:\\a.txt","offset":65536,"length":65536}""", FileMessages.read("C:\\a.txt", 65_536).toString())
        assertEquals("""{"kind":"file.cancel","transferId":"$transferId"}""", FileMessages.cancel(transferId).toString())

        val write = FileMessages.write(transferId, "C:\\a.txt", 0, "hello".toByteArray(), final = true, overwrite = false, totalBytes = 5)
        assertEquals("aGVsbG8=", write.text("data"))
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", write.text("sha256"))
        assertEquals(setOf("kind", "transferId", "path", "offset", "data", "sha256", "final", "overwrite", "totalBytes"), write.keys)

        try {
            FileMessages.write(transferId, "C:\\a", 0, ByteArray(FileMessages.MAX_CHUNK + 1), true, false, 70_000)
            fail("a chunk larger than the data channel carries must not be built")
        } catch (_: IllegalArgumentException) {
        }
        try {
            FileMessages.read("C:\\a", 0, FileMessages.MAX_CHUNK + 1)
            fail("a read larger than a chunk must not be built")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun paths_are_built_the_way_the_web_dashboard_builds_them() {
        val drive = FileEntry(name = "System (C:\\)", kind = "drive", path = "C:")
        assertEquals("C:\\", FileMessages.pathOf(null, drive))
        assertEquals("C:\\Users", FileMessages.pathOf("C:\\", FileEntry("Users", "directory")))
        assertEquals("C:\\Users\\Public", FileMessages.pathOf("C:\\Users", FileEntry("Public", "directory")))

        assertEquals("C:\\Users", FileMessages.parentOf("C:\\Users\\Public"))
        assertEquals("C:\\", FileMessages.parentOf("C:\\Users"))
        assertNull("above a drive root is the list of drives", FileMessages.parentOf("C:\\"))
    }

    @Test
    fun a_file_is_fetched_chunk_by_chunk_at_the_offsets_asked_for() = runBlocking {
        val bytes = Random(7).nextBytes(200_000)
        val pc = FakePc(mutableMapOf("C:\\data.bin" to bytes))
        val sink = ByteArrayOutputStream()
        val progress = mutableListOf<Pair<Long, Long>>()

        val count = transferFor(pc).download("C:\\data.bin", sink) { done, total -> progress += done to total }

        assertEquals(200_000L, count)
        assertArrayEquals(bytes, sink.toByteArray())
        assertEquals(listOf(0L, 65_536L, 131_072L, 196_608L), pc.received.map { it["offset"]!!.jsonPrimitive.long })
        assertEquals(200_000L to 200_000L, progress.last())
    }

    @Test
    fun a_chunk_with_the_wrong_checksum_is_refused_before_any_of_it_is_written() = runBlocking {
        val bytes = Random(8).nextBytes(100_000)
        val pc = FakePc(mutableMapOf("C:\\data.bin" to bytes)).apply { corruptNextRead = true }
        val sink = ByteArrayOutputStream()

        try {
            transferFor(pc).download("C:\\data.bin", sink)
            fail("a corrupt chunk must end the download")
        } catch (error: FileRefusalException) {
            assertEquals("corrupt", error.refusal.reason)
        }
        assertEquals(0, sink.size())
    }

    @Test
    fun a_download_stops_between_chunks_when_asked() = runBlocking {
        val pc = FakePc(mutableMapOf("C:\\data.bin" to ByteArray(200_000)))
        var asked = 0

        try {
            transferFor(pc).download("C:\\data.bin", ByteArrayOutputStream(), cancelled = { asked++ >= 2 })
            fail("expected the download to stop")
        } catch (_: TransferCancelledException) {
        }
        assertEquals(2, pc.received.size)
    }

    @Test
    fun a_file_is_sent_in_contiguous_chunks_and_the_pc_s_checksum_is_compared() = runBlocking {
        val bytes = Random(9).nextBytes(150_000)
        val pc = FakePc()

        val written = transferFor(pc).upload("C:\\Users\\Public\\data.bin", bytes.size.toLong(), ByteArrayInputStream(bytes), transferId = transferId)

        assertTrue(written.complete)
        assertArrayEquals(bytes, pc.files["C:\\Users\\Public\\data.bin"])
        val writes = pc.received.filter { it.text("kind") == "file.write" }
        assertEquals(listOf(0L, 65_536L, 131_072L), writes.map { it["offset"]!!.jsonPrimitive.long })
        assertEquals(listOf(false, false, true), writes.map { it["final"]!!.jsonPrimitive.content.toBoolean() })
        assertTrue("never told to overwrite", writes.all { it["overwrite"]!!.jsonPrimitive.content == "false" })
        assertTrue(writes.all { it["totalBytes"]!!.jsonPrimitive.long == 150_000L })
    }

    @Test
    fun an_empty_file_is_one_final_chunk_of_nothing() = runBlocking {
        val pc = FakePc()
        transferFor(pc).upload("C:\\empty.txt", 0, ByteArrayInputStream(ByteArray(0)), transferId = transferId)

        val write = pc.received.single()
        assertEquals("", write.text("data"))
        assertEquals("true", write["final"]!!.jsonPrimitive.content)
        assertArrayEquals(ByteArray(0), pc.files["C:\\empty.txt"])
    }

    @Test
    fun a_pc_whose_copy_does_not_line_up_ends_the_upload_and_it_is_cancelled_there() = runBlocking {
        val pc = FakePc().apply { misreportWritten = true }

        try {
            transferFor(pc).upload("C:\\data.bin", 150_000, ByteArrayInputStream(ByteArray(150_000)), transferId = transferId)
            fail("a misaligned copy must not carry on")
        } catch (error: FileRefusalException) {
            assertEquals("failed", error.refusal.reason)
        }
        assertEquals("file.cancel", kinds(pc).last())
        assertFalse(pc.parts.containsKey(transferId))
    }

    @Test
    fun a_file_the_pc_assembled_differently_is_reported_not_trusted() = runBlocking {
        val pc = FakePc().apply { damageAssembledFile = true }

        try {
            transferFor(pc).upload("C:\\data.bin", 10, ByteArrayInputStream(ByteArray(10)), transferId = transferId)
            fail("a whole-file checksum mismatch must be reported")
        } catch (error: FileRefusalException) {
            assertEquals("corrupt", error.refusal.reason)
        }
    }

    @Test
    fun a_refusal_ends_the_upload_with_the_pc_s_words() = runBlocking {
        val pc = FakePc().apply { refuseWriteWith = "exists" }

        try {
            transferFor(pc).upload("C:\\data.bin", 10, ByteArrayInputStream(ByteArray(10)), transferId = transferId)
            fail("a refusal must end the upload")
        } catch (error: FileRefusalException) {
            assertEquals("exists", error.refusal.reason)
            assertEquals("A file is already there.", error.refusal.detail)
        }
        assertEquals("file.cancel", kinds(pc).last())
    }

    @Test
    fun a_stopped_upload_is_cancelled_on_the_pc_and_its_part_file_goes() = runBlocking {
        val pc = FakePc()
        var checks = 0

        try {
            transferFor(pc).upload("C:\\data.bin", 200_000, ByteArrayInputStream(ByteArray(200_000)), transferId = transferId, cancelled = { checks++ >= 1 })
            fail("expected the upload to stop")
        } catch (_: TransferCancelledException) {
        }
        assertEquals(listOf("file.write", "file.cancel"), kinds(pc))
        assertFalse(pc.parts.containsKey(transferId))
        assertNull(pc.files["C:\\data.bin"])
    }

    @Test
    fun a_file_shorter_than_its_stated_size_is_not_sent_as_if_it_were_whole() = runBlocking {
        val pc = FakePc()
        try {
            transferFor(pc).upload("C:\\data.bin", 100, ByteArrayInputStream(ByteArray(40)), transferId = transferId)
            fail("a short source must not be sent as the whole file")
        } catch (error: FileRefusalException) {
            assertEquals("failed", error.refusal.reason)
        }
        assertNull(pc.files["C:\\data.bin"])
    }

    @Test
    fun a_file_over_the_limit_is_refused_before_anything_is_sent() = runBlocking {
        val pc = FakePc()
        try {
            transferFor(pc).upload("C:\\huge.img", FileMessages.MAX_TRANSFER_BYTES + 1, ByteArrayInputStream(ByteArray(0)))
            fail("an over-limit file must be refused")
        } catch (error: FileRefusalException) {
            assertEquals("too-large", error.refusal.reason)
        }
        assertTrue(pc.received.isEmpty())
    }

    @Test
    fun sizes_are_readable() {
        assertEquals("", FileMessages.readableSize(null))
        assertEquals("512 B", FileMessages.readableSize(512))
        assertEquals("64 KB", FileMessages.readableSize(65_536))
        assertEquals("1.5 MB", FileMessages.readableSize(1_572_864))
        assertEquals("8.00 GB", FileMessages.readableSize(FileMessages.MAX_TRANSFER_BYTES))
        assertEquals(64, MessageDigest.getInstance("SHA-256").digestLength * 2)
    }
}
