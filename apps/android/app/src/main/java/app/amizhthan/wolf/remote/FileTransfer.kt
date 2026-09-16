package app.amizhthan.wolf.remote

import app.amizhthan.wolf.api.WolfJson
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.util.Base64
import java.util.Locale

/** One thing in a folder on the PC, mirroring `packages/protocol/src/files.ts`. */
@Serializable
data class FileEntry(
    val name: String,
    /** `file`, `directory` or `drive`. */
    val kind: String,
    /** A file's size; a drive's free space; null when the PC could not read it. */
    val sizeBytes: Long? = null,
    val modifiedAt: String? = null,
    val readOnly: Boolean = false,
    val hidden: Boolean = false,
    /** A symlink or junction: a folder that is really somewhere else on the machine. */
    val reparse: Boolean = false,
    /** Under a Windows-owned location. */
    val protectedLocation: Boolean = false,
    /** Drives only: the drive itself, e.g. `C:`. */
    val path: String? = null,
)

@Serializable
data class FileListing(
    /** Null when this is the list of drives. */
    val path: String? = null,
    val entries: List<FileEntry> = emptyList(),
    /** More than the PC lists at once. Said, so a folder is not taken to be all there is. */
    val truncated: Boolean = false,
)

data class FileInfo(val path: String, val entry: FileEntry?, val partialBytes: Long?)

class FileChunk(val offset: Long, val bytes: ByteArray, val eof: Boolean, val totalBytes: Long)

data class FileWritten(val bytesWritten: Long, val sha256: String?, val complete: Boolean)

/** Why a file operation did not happen, in the PC's own words. */
data class FileRefusal(val reason: String, val detail: String, val limitation: Boolean)

class FileRefusalException(val refusal: FileRefusal) : Exception(refusal.detail)

class TransferCancelledException : Exception("The transfer was stopped.")

/**
 * The connection to the PC ended partway through a transfer — not a refusal and not a decision to stop.
 *
 * [done] is how far it had got by this phone's count. An upload's part file waits on the PC for
 * [FileMessages.PARTIAL_UPLOAD_KEPT_MINUTES] minutes; the PC's own count, asked for when resuming, is the one
 * that decides where it carries on.
 */
class TransferInterruptedException(val done: Long, val total: Long) : Exception("The connection to the PC ended partway through.")

/** The stream going away, as the stream reports it. */
val FileRefusalException.isInterruption: Boolean get() = refusal.reason == FileMessages.INTERRUPTED

private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull

private fun JsonObject.flag(key: String): Boolean = (this[key] as? JsonPrimitive)?.booleanOrNull == true

/**
 * The file messages on the stream's data channel, and what they mean.
 *
 * **Everything here goes between the phone and the PC and nowhere else**, names included: a folder listing
 * is a set of facts about somebody. Nothing in this app logs a path, a name or a byte of a file.
 */
object FileMessages {
    /** Sized for the data channel's message limit, not for throughput. */
    const val MAX_CHUNK = 64 * 1024
    const val MAX_TRANSFER_BYTES = 8L * 1024 * 1024 * 1024

    /** Mirrors `PARTIAL_UPLOAD_KEPT_SECONDS` in `packages/protocol`. */
    const val PARTIAL_UPLOAD_KEPT_MINUTES = 30

    /** This app's reason for a request the stream could not carry because it ended. Never sent by the PC. */
    const val INTERRUPTED = "interrupted"

    fun list(path: String?): JsonObject = buildJsonObject {
        put("kind", "file.list")
        put("path", path)
    }

    fun stat(path: String): JsonObject = buildJsonObject {
        put("kind", "file.stat")
        put("path", path)
    }

    fun read(path: String, offset: Long, length: Int = MAX_CHUNK): JsonObject {
        require(offset >= 0) { "An offset is never negative." }
        require(length in 1..MAX_CHUNK) { "A read asks for 1 to $MAX_CHUNK bytes." }
        return buildJsonObject {
            put("kind", "file.read")
            put("path", path)
            put("offset", offset)
            put("length", length)
        }
    }

    /**
     * One chunk, with the checksum of exactly these bytes so the PC can refuse it before it reaches the disk.
     *
     * [fileSha256] goes on the final chunk: this phone's checksum of the whole file, so a file the PC put
     * together differently — above all one resumed onto a part an earlier stream wrote — is not put in place.
     */
    fun write(
        transferId: String,
        path: String,
        offset: Long,
        bytes: ByteArray,
        final: Boolean,
        overwrite: Boolean,
        totalBytes: Long,
        fileSha256: String? = null,
    ): JsonObject {
        require(bytes.size <= MAX_CHUNK) { "A chunk is at most $MAX_CHUNK bytes." }
        require(totalBytes in 0..MAX_TRANSFER_BYTES) { "WOLF moves files up to 8 GB." }
        require(fileSha256 == null || final) { "The whole file's checksum goes with the last chunk." }
        return buildJsonObject {
            put("kind", "file.write")
            put("transferId", transferId)
            put("path", path)
            put("offset", offset)
            put("data", Base64.getEncoder().encodeToString(bytes))
            put("sha256", sha256Hex(bytes))
            put("final", final)
            put("overwrite", overwrite)
            put("totalBytes", totalBytes)
            if (fileSha256 != null) put("fileSha256", fileSha256)
        }
    }

    fun cancel(transferId: String): JsonObject = buildJsonObject {
        put("kind", "file.cancel")
        put("transferId", transferId)
    }

    fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    fun hex(digest: ByteArray): String = digest.joinToString("") { String.format(Locale.ROOT, "%02x", it) }

    fun listing(message: JsonObject): FileListing = try {
        WolfJson.decodeFromJsonElement(FileListing.serializer(), message)
    } catch (_: SerializationException) {
        throw unreadable()
    } catch (_: IllegalArgumentException) {
        throw unreadable()
    }

    fun info(message: JsonObject): FileInfo = FileInfo(
        path = message.str("path").orEmpty(),
        entry = (message["entry"] as? JsonObject)?.let {
            runCatching { WolfJson.decodeFromJsonElement(FileEntry.serializer(), it) }.getOrNull()
        },
        partialBytes = message.long("partialBytes"),
    )

    /**
     * A chunk, verified. Checked here rather than trusted: a byte that arrives wrong is caught where it
     * happened, not as a file that turns out broken a week later, and this end is the one that can retry.
     */
    fun chunk(message: JsonObject): FileChunk {
        val bytes = try {
            Base64.getDecoder().decode(message.str("data").orEmpty())
        } catch (_: IllegalArgumentException) {
            throw corrupt()
        }
        if (sha256Hex(bytes) != message.str("sha256")?.lowercase(Locale.ROOT)) throw corrupt()
        return FileChunk(
            offset = message.long("offset") ?: -1,
            bytes = bytes,
            eof = message.flag("eof"),
            totalBytes = message.long("totalBytes") ?: 0,
        )
    }

    fun written(message: JsonObject): FileWritten = FileWritten(
        bytesWritten = message.long("bytesWritten") ?: -1,
        sha256 = message.str("sha256"),
        complete = message.flag("complete"),
    )

    fun refusal(message: JsonObject): FileRefusal = FileRefusal(
        reason = message.str("reason") ?: "failed",
        detail = message.str("detail") ?: "The PC refused that file operation.",
        limitation = message.flag("limitation"),
    )

    /** The path of an entry in the folder shown, as the web dashboard builds it. */
    fun pathOf(folder: String?, entry: FileEntry): String = when {
        entry.kind == "drive" -> "${entry.path ?: entry.name}\\"
        folder == null -> entry.name
        else -> childPath(folder, entry.name)
    }

    fun childPath(folder: String, name: String): String = if (folder.endsWith("\\")) folder + name else "$folder\\$name"

    /** The folder above, or null above a drive root, which is the list of drives. */
    fun parentOf(folder: String): String? {
        val trimmed = folder.trimEnd('\\')
        val cut = trimmed.lastIndexOf('\\')
        if (cut < 0 || cut < trimmed.indexOf(':')) return null
        return if (cut == 2) "${trimmed.take(2)}\\" else trimmed.take(cut)
    }

    fun readableSize(bytes: Long?): String = when {
        bytes == null -> ""
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> "${bytes / 1024} KB"
        bytes < 1024L * 1024 * 1024 -> String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024))
        else -> String.format(Locale.ROOT, "%.2f GB", bytes / (1024.0 * 1024 * 1024))
    }

    private fun corrupt() = FileRefusalException(FileRefusal("corrupt", "A chunk of that file arrived with the wrong checksum and was discarded.", false))

    private fun unreadable() = FileRefusalException(FileRefusal("failed", "The PC answered in a way this app does not understand.", false))
}

/**
 * Moving one file off the PC or onto it, a chunk at a time, over whatever [ask] sends the request on.
 *
 * Free of Android and of WebRTC, so every message and every failure path is tested on the JVM. On the phone
 * [ask] is the stream's data channel; nothing here reaches the cloud.
 */
class FileTransfer(private val ask: suspend (JsonObject) -> JsonObject) {

    suspend fun list(path: String?): FileListing = FileMessages.listing(ask(FileMessages.list(path)))

    suspend fun stat(path: String): FileInfo = FileMessages.info(ask(FileMessages.stat(path)))

    /**
     * Fetch a file into [sink], from [startOffset]. Each chunk's checksum is verified before any of it is written,
     * and the chunks must arrive at the offsets asked for. Returns the number of bytes the file has reached.
     *
     * When [expectedTotal] is given — a resumed download — a file whose size is no longer that is refused
     * rather than joined onto the part already fetched. The connection ending throws
     * [TransferInterruptedException] with how far it got; everything in [sink] up to there is good.
     */
    suspend fun download(
        path: String,
        sink: OutputStream,
        cancelled: () -> Boolean = { false },
        startOffset: Long = 0,
        expectedTotal: Long? = null,
        onProgress: (done: Long, total: Long) -> Unit = { _, _ -> },
    ): Long {
        var offset = startOffset
        var total = expectedTotal ?: 0
        try {
            while (true) {
                if (cancelled()) throw TransferCancelledException()
                val chunk = FileMessages.chunk(ask(FileMessages.read(path, offset)))
                if (chunk.offset != offset) {
                    throw FileRefusalException(FileRefusal("failed", "The PC sent a different part of that file than the one asked for.", false))
                }
                if (expectedTotal != null && chunk.totalBytes != expectedTotal) throw changed()
                sink.write(chunk.bytes)
                offset += chunk.bytes.size
                total = chunk.totalBytes
                onProgress(offset, total)
                if (chunk.eof) return offset
                // A file that never reports its end would otherwise be read forever, a chunk of nothing at a time.
                if (chunk.bytes.isEmpty()) throw FileRefusalException(FileRefusal("failed", "The PC stopped sending that file.", false))
            }
        } catch (error: FileRefusalException) {
            if (error.isInterruption) throw TransferInterruptedException(offset, total)
            throw error
        }
    }

    /**
     * Carry on fetching a file the connection interrupted, into [sink] which already holds its first
     * [startOffset] bytes — if it is still the same file: the same size and the same modification time.
     */
    suspend fun resumeDownload(
        path: String,
        sink: OutputStream,
        startOffset: Long,
        expectedTotal: Long,
        modifiedAt: String?,
        cancelled: () -> Boolean = { false },
        onProgress: (done: Long, total: Long) -> Unit = { _, _ -> },
    ): Long {
        val entry = stat(path).entry
            ?: throw FileRefusalException(FileRefusal("not-found", "That file is no longer on the PC.", false))
        if (entry.sizeBytes != expectedTotal || entry.modifiedAt != modifiedAt) throw changed()
        return download(path, sink, cancelled, startOffset, expectedTotal, onProgress)
    }

    /**
     * Send [totalBytes] from [source] to [destination] on the PC, from [startOffset].
     *
     * The PC writes into a part file and renames it into place only on the last chunk, so an interrupted
     * upload never looks like the real file. It is never told to overwrite unless [overwrite] says so. The
     * PC's answer says where it is: [source] is read in order, so an answer that is not exactly past what
     * was sent cannot be repaired by seeking back, and ends the transfer.
     *
     * A resumed upload still reads — and checksums — the part it does not send, so the last chunk carries this
     * phone's checksum of the whole file and the PC refuses to put in place a file that does not match. The
     * checksum the PC reports back is compared too, for a PC too old to do that.
     *
     * Stopping or a refusal cancels the transfer on the PC, and the part file goes with it. The connection
     * ending does not: it throws [TransferInterruptedException], and the part file waits to be resumed.
     */
    suspend fun upload(
        destination: String,
        totalBytes: Long,
        source: InputStream,
        overwrite: Boolean = false,
        transferId: String = Ulid.next(),
        cancelled: () -> Boolean = { false },
        startOffset: Long = 0,
        onProgress: (done: Long, total: Long) -> Unit = { _, _ -> },
    ): FileWritten {
        if (totalBytes !in 0..FileMessages.MAX_TRANSFER_BYTES) {
            throw FileRefusalException(FileRefusal("too-large", "WOLF moves files up to 8 GB.", false))
        }
        require(startOffset in 0..totalBytes) { "A resume point lies within the file." }

        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(FileMessages.MAX_CHUNK)
        var offset = 0L
        var cancelledOnPc = false

        // The part already on the PC, read past and counted into the checksum, not sent again.
        while (offset < startOffset) {
            val wanted = minOf(FileMessages.MAX_CHUNK.toLong(), startOffset - offset).toInt()
            val count = readUpTo(source, buffer, wanted)
            if (count < wanted) {
                throw FileRefusalException(FileRefusal("failed", "The file on this phone ended before its stated size.", false))
            }
            digest.update(buffer, 0, count)
            offset += count
        }

        try {
            while (true) {
                if (cancelled()) {
                    cancelledOnPc = true
                    cancelQuietly(transferId)
                    throw TransferCancelledException()
                }

                val wanted = minOf(FileMessages.MAX_CHUNK.toLong(), totalBytes - offset).toInt()
                val count = readUpTo(source, buffer, wanted)
                if (count < wanted) {
                    throw FileRefusalException(FileRefusal("failed", "The file on this phone ended before its stated size.", false))
                }
                val chunk = buffer.copyOf(count)
                val final = offset + count >= totalBytes

                digest.update(chunk)
                val sent = if (final) FileMessages.hex(digest.digest()) else null

                val written = FileMessages.written(
                    ask(FileMessages.write(transferId, destination, offset, chunk, final, overwrite, totalBytes, fileSha256 = sent)),
                )
                if (written.bytesWritten != offset + count) {
                    throw FileRefusalException(FileRefusal("failed", "The PC's copy did not line up with what was sent.", false))
                }

                offset = written.bytesWritten
                onProgress(offset, totalBytes)

                if (final) {
                    if (!written.complete) throw FileRefusalException(FileRefusal("failed", "The PC did not confirm the file was complete.", false))
                    if (written.sha256 != null && written.sha256.lowercase(Locale.ROOT) != sent) {
                        throw FileRefusalException(
                            FileRefusal("corrupt", "The file the PC put together does not match the one sent. It was written, so check or replace it.", false),
                        )
                    }
                    return written
                }
            }
        } catch (error: Throwable) {
            // Not cancelled on the PC: that would delete exactly the part a resume needs.
            if (error is FileRefusalException && error.isInterruption) throw TransferInterruptedException(offset, totalBytes)
            if (!cancelledOnPc && error !is TransferCancelledException) withContext(NonCancellable) { cancelQuietly(transferId) }
            throw error
        }
    }

    /**
     * Carry on with an upload the connection interrupted, with [source] opened again from its start.
     *
     * The PC is asked how much of the part file it still has, because only it knows: the last chunk sent may or
     * may not have landed, and the part file may have been cleared since. At least the last byte is sent again,
     * so there is always a final chunk for the PC to check the whole file against. Returns where it resumed from
     * with the PC's answer.
     */
    suspend fun resumeUpload(
        destination: String,
        totalBytes: Long,
        source: InputStream,
        transferId: String = Ulid.next(),
        cancelled: () -> Boolean = { false },
        onProgress: (done: Long, total: Long) -> Unit = { _, _ -> },
    ): Pair<Long, FileWritten> {
        val info = stat(destination)
        if (info.entry != null) {
            throw FileRefusalException(FileRefusal("exists", "A file with that name is already in that folder on the PC, so this one was not sent over it.", false))
        }
        val from = if (totalBytes == 0L) 0L else minOf(info.partialBytes ?: 0L, totalBytes - 1)
        return from to upload(destination, totalBytes, source, false, transferId, cancelled, from, onProgress)
    }

    private fun changed() = FileRefusalException(
        FileRefusal("changed", "That file has changed on the PC since it was being fetched, so the part that arrived was discarded. Fetch it again.", false),
    )

    private suspend fun cancelQuietly(transferId: String) {
        runCatching { ask(FileMessages.cancel(transferId)) }
    }

    private fun readUpTo(source: InputStream, buffer: ByteArray, wanted: Int): Int {
        var total = 0
        while (total < wanted) {
            val read = source.read(buffer, total, wanted - total)
            if (read < 0) break
            total += read
        }
        return total
    }
}
