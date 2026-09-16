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
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlin.random.Random

/**
 * Transfers the connection cuts off partway, against a PC that behaves the way the session host does: part files
 * that outlive the stream, contiguous offsets, and a whole-file checksum that keeps a mismatch out of place.
 */
class ResumeTransferTest {
    @get:Rule
    val temporary = TemporaryFolder()

    private class FakePc {
        val files = mutableMapOf<String, Pair<ByteArray, String>>()
        val parts = mutableMapOf<String, ByteArray>()
        val received = mutableListOf<JsonObject>()
        private val inFlight = mutableMapOf<String, String>()

        /** Answers left before the connection drops. */
        var connectionLeft = Int.MAX_VALUE

        fun reconnect() {
            inFlight.clear()
            connectionLeft = Int.MAX_VALUE
        }

        fun answer(message: JsonObject): JsonObject {
            if (connectionLeft <= 0) throw FileRefusalException(FileRefusal(FileMessages.INTERRUPTED, "The connection to this PC ended.", false))
            connectionLeft--
            received += message
            val path = (message["path"] as? JsonPrimitive)?.contentOrNull
            return when ((message["kind"] as JsonPrimitive).content) {
                "file.stat" -> buildJsonObject {
                    put("kind", "file.info")
                    put("path", path)
                    val file = files[path]
                    if (file == null) {
                        put("entry", kotlinx.serialization.json.JsonNull)
                    } else {
                        put(
                            "entry",
                            buildJsonObject {
                                put("name", path)
                                put("kind", "file")
                                put("sizeBytes", file.first.size)
                                put("modifiedAt", file.second)
                            },
                        )
                    }
                    put("partialBytes", parts[path]?.size)
                }
                "file.read" -> {
                    val file = files[path]!!.first
                    val offset = message["offset"]!!.jsonPrimitive.long.toInt()
                    val length = message["length"]!!.jsonPrimitive.long.toInt()
                    val chunk = file.copyOfRange(offset, minOf(file.size, offset + length))
                    buildJsonObject {
                        put("kind", "file.chunk")
                        put("offset", offset)
                        put("data", Base64.getEncoder().encodeToString(chunk))
                        put("sha256", FileMessages.sha256Hex(chunk))
                        put("eof", offset + chunk.size >= file.size)
                        put("totalBytes", file.size)
                    }
                }
                "file.write" -> {
                    val id = message["transferId"]!!.jsonPrimitive.content
                    val offset = message["offset"]!!.jsonPrimitive.long.toInt()
                    var part = parts[path] ?: ByteArray(0)
                    if (id !in inFlight) {
                        if (offset > part.size) return refused("rejected", "Past the end of the partial file.")
                        part = part.copyOf(offset)
                        inFlight[id] = path!!
                    }
                    if (offset != part.size) return refused("rejected", "Gap.")
                    part += Base64.getDecoder().decode(message["data"]!!.jsonPrimitive.content)
                    parts[path!!] = part
                    if ((message["final"] as JsonPrimitive).booleanOrNull != true) return written(id, part.size.toLong(), null, false)

                    inFlight.remove(id)
                    parts.remove(path)
                    val expected = (message["fileSha256"] as? JsonPrimitive)?.contentOrNull
                    if (expected != null && expected != FileMessages.sha256Hex(part)) return refused("corrupt", "Does not match.")
                    files[path] = part to "2026-09-16T10:00:00Z"
                    written(id, part.size.toLong(), FileMessages.sha256Hex(part), true)
                }
                "file.cancel" -> {
                    inFlight.remove(message["transferId"]!!.jsonPrimitive.content)?.let { parts.remove(it) }
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
        }
    }

    private fun transferFor(pc: FakePc) = FileTransfer { message ->
        val answer = pc.answer(message)
        if ((answer["kind"] as JsonPrimitive).content == "file.refused") throw FileRefusalException(FileMessages.refusal(answer))
        answer
    }

    private fun kinds(pc: FakePc) = pc.received.map { (it["kind"] as JsonPrimitive).content }

    @Test
    fun an_interrupted_upload_is_not_cancelled_and_carries_on_from_what_the_pc_kept() = runBlocking {
        val bytes = Random(3).nextBytes(FileMessages.MAX_CHUNK * 3 + 17)
        val pc = FakePc().apply { connectionLeft = 2 }
        val transfer = transferFor(pc)

        val interrupted = try {
            transfer.upload("C:\\setup.exe", bytes.size.toLong(), ByteArrayInputStream(bytes), transferId = "first")
            fail("expected the upload to be interrupted")
            error("unreachable")
        } catch (error: TransferInterruptedException) {
            error
        }

        assertEquals(FileMessages.MAX_CHUNK * 2L, interrupted.done)
        assertFalse("an interruption is not a decision to stop", "file.cancel" in kinds(pc))
        assertEquals(FileMessages.MAX_CHUNK * 2, pc.parts["C:\\setup.exe"]!!.size)

        pc.reconnect()
        pc.received.clear()
        val (from, written) = transfer.resumeUpload("C:\\setup.exe", bytes.size.toLong(), ByteArrayInputStream(bytes), transferId = "second")

        assertEquals(FileMessages.MAX_CHUNK * 2L, from)
        assertTrue(written.complete)
        assertArrayEquals(bytes, pc.files["C:\\setup.exe"]!!.first)
        val writes = pc.received.filter { (it["kind"] as JsonPrimitive).content == "file.write" }
        assertEquals("the part already on the PC is not sent again", FileMessages.MAX_CHUNK * 2L, writes.first()["offset"]!!.jsonPrimitive.long)
        assertEquals(FileMessages.sha256Hex(bytes), writes.last()["fileSha256"]!!.jsonPrimitive.content)
        assertTrue(writes.dropLast(1).none { "fileSha256" in it })
    }

    @Test
    fun a_resume_onto_the_wrong_bytes_is_refused_before_it_is_put_in_place() = runBlocking {
        val bytes = Random(5).nextBytes(FileMessages.MAX_CHUNK * 2 + 9)
        val pc = FakePc().apply { connectionLeft = 1 }
        val transfer = transferFor(pc)

        try {
            transfer.upload("C:\\a.bin", bytes.size.toLong(), ByteArrayInputStream(bytes))
            fail("expected an interruption")
        } catch (_: TransferInterruptedException) {
        }

        // Something else wrote into the part file meanwhile.
        pc.parts["C:\\a.bin"] = Random(99).nextBytes(FileMessages.MAX_CHUNK)
        pc.reconnect()

        try {
            transfer.resumeUpload("C:\\a.bin", bytes.size.toLong(), ByteArrayInputStream(bytes))
            fail("a mismatched file must not be put in place")
        } catch (error: FileRefusalException) {
            assertEquals("corrupt", error.refusal.reason)
        }
        assertNull(pc.files["C:\\a.bin"])
    }

    @Test
    fun a_part_file_the_pc_no_longer_has_means_sending_it_all_again() = runBlocking {
        val bytes = Random(7).nextBytes(FileMessages.MAX_CHUNK + 40)
        val pc = FakePc()

        val (from, _) = transferFor(pc).resumeUpload("C:\\b.bin", bytes.size.toLong(), ByteArrayInputStream(bytes))

        assertEquals(0L, from)
        assertArrayEquals(bytes, pc.files["C:\\b.bin"]!!.first)
    }

    @Test
    fun a_complete_part_file_still_ends_with_a_final_checked_chunk() = runBlocking {
        val bytes = Random(8).nextBytes(100)
        val pc = FakePc().apply { parts["C:\\c.bin"] = bytes.copyOf() }

        val (from, written) = transferFor(pc).resumeUpload("C:\\c.bin", 100, ByteArrayInputStream(bytes))

        assertEquals(99L, from)
        assertTrue(written.complete)
        assertArrayEquals(bytes, pc.files["C:\\c.bin"]!!.first)
    }

    @Test
    fun a_file_that_appeared_at_the_destination_is_not_sent_over() = runBlocking {
        val pc = FakePc().apply { files["C:\\d.bin"] = ByteArray(1) to "x" }

        try {
            transferFor(pc).resumeUpload("C:\\d.bin", 10, ByteArrayInputStream(ByteArray(10)))
            fail("an existing file must not be replaced by a resume")
        } catch (error: FileRefusalException) {
            assertEquals("exists", error.refusal.reason)
        }
        assertEquals(listOf("file.stat"), kinds(pc))
    }

    @Test
    fun an_interrupted_download_keeps_what_arrived_and_fetches_only_the_rest() = runBlocking {
        val bytes = Random(11).nextBytes(FileMessages.MAX_CHUNK * 3 + 5)
        val pc = FakePc().apply {
            files["C:\\big.iso"] = bytes to "2026-09-01T00:00:00Z"
            connectionLeft = 2
        }
        val transfer = transferFor(pc)
        val sink = ByteArrayOutputStream()

        val interrupted = try {
            transfer.download("C:\\big.iso", sink)
            error("unreachable")
        } catch (error: TransferInterruptedException) {
            error
        }
        assertEquals(FileMessages.MAX_CHUNK * 2L, interrupted.done)
        assertEquals(bytes.size.toLong(), interrupted.total)

        pc.reconnect()
        pc.received.clear()
        transfer.resumeDownload("C:\\big.iso", sink, interrupted.done, interrupted.total, "2026-09-01T00:00:00Z")

        assertArrayEquals(bytes, sink.toByteArray())
        assertEquals(interrupted.done, pc.received.first { (it["kind"] as JsonPrimitive).content == "file.read" }["offset"]!!.jsonPrimitive.long)
    }

    @Test
    fun a_download_is_not_joined_onto_a_file_that_changed_meanwhile() = runBlocking {
        val pc = FakePc().apply { files["C:\\log.txt"] = ByteArray(200_000) to "2026-09-02T00:00:00Z" }

        try {
            transferFor(pc).resumeDownload("C:\\log.txt", ByteArrayOutputStream(), 65_536, 200_000, "2026-09-01T00:00:00Z")
            fail("a changed file must not be joined")
        } catch (error: FileRefusalException) {
            assertEquals("changed", error.refusal.reason)
        }
        assertEquals(listOf("file.stat"), kinds(pc))
    }

    @Test
    fun the_whole_file_checksum_goes_only_with_the_last_chunk() {
        val write = FileMessages.write("t", "C:\\a", 0, ByteArray(1), final = true, overwrite = false, totalBytes = 1, fileSha256 = "a".repeat(64))
        assertEquals("a".repeat(64), write["fileSha256"]!!.jsonPrimitive.content)
        try {
            FileMessages.write("t", "C:\\a", 0, ByteArray(1), final = false, overwrite = false, totalBytes = 2, fileSha256 = "a".repeat(64))
            fail("a whole-file checksum on a middle chunk must not be built")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test
    fun records_outlive_the_stream_and_download_parts_nobody_resumes_are_swept() {
        val store = InterruptedTransfers(temporary.root)
        store.partsDirectory.mkdirs()
        val kept = java.io.File(store.partsDirectory, "kept.part").apply { writeBytes(ByteArray(10)) }
        val orphan = java.io.File(store.partsDirectory, "orphan.part").apply { writeBytes(ByteArray(10)) }
        val download = InterruptedDownload("big.iso", "C:\\big.iso", null, kept, 10, 100)

        store.keep("pc-1", download)
        store.sweep()

        assertTrue(kept.exists())
        assertFalse(orphan.exists())
        assertSame(download, store["pc-1"])
        assertNull(store["pc-2"])

        // Taken to resume: the record goes, the part stays for the resume.
        assertSame(download, store.take("pc-1"))
        assertTrue(kept.exists())

        // Replaced by another transfer's record, or discarded: what arrived goes too.
        store.keep("pc-1", download)
        store.keep("pc-1", InterruptedUpload("a.bin", "content://x", "C:\\a.bin", 1, 2))
        assertFalse(kept.exists())
        store.discard("pc-1")
        assertNull(store["pc-1"])
    }
}
