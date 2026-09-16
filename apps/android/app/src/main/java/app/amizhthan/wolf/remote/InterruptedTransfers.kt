package app.amizhthan.wolf.remote

import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** A transfer the connection interrupted, kept so the next stream to the same PC can carry it on. */
sealed interface InterruptedTransfer {
    val name: String
    val done: Long
    val total: Long
}

/**
 * An upload whose part file waits on the PC. [source] is the document's URI as a string, opened again from its
 * start when resuming; this phone holds none of its bytes.
 */
data class InterruptedUpload(
    override val name: String,
    val source: String,
    val destination: String,
    override val done: Long,
    override val total: Long,
) : InterruptedTransfer

/**
 * A download whose first [done] bytes are in [part], in this app's own cache — never in a document the owner
 * can open, so half a file is never mistaken for the file.
 */
data class InterruptedDownload(
    override val name: String,
    val path: String,
    val modifiedAt: String?,
    val part: File,
    override val done: Long,
    override val total: Long,
) : InterruptedTransfer

/**
 * One interrupted transfer per PC, for as long as this app process lives.
 *
 * Remote desktop builds a new controller for every stream, and the point of a record is to outlive the stream
 * that was interrupted — so the records live here, beside the app's other long-lived parts, not in a controller.
 * Memory only: a record holds a path on the PC, and nothing about a PC's files is written down on this phone.
 * If the process ends, the records go; the PC clears the part file on its own, and [sweep] clears the phone's.
 */
class InterruptedTransfers(private val cacheDirectory: File) {
    private val byPc = ConcurrentHashMap<String, InterruptedTransfer>()

    /** Where a download is put together before it is handed to the document the owner chose. */
    val partsDirectory: File get() = File(cacheDirectory, "transfers")

    operator fun get(pcId: String): InterruptedTransfer? = byPc[pcId]

    fun keep(pcId: String, transfer: InterruptedTransfer) {
        byPc.put(pcId, transfer)?.let { replaced -> if (replaced !== transfer) discardParts(replaced, transfer) }
    }

    /** The record, removed. Its part file stays for the caller that is resuming it. */
    fun take(pcId: String): InterruptedTransfer? = byPc.remove(pcId)

    /** The record and, for a download, what arrived. */
    fun discard(pcId: String) {
        byPc.remove(pcId)?.let { discardParts(it, null) }
    }

    /** Delete any download part no record refers to — left by a stream that ended some other way, or a process that did. */
    fun sweep() {
        val kept = byPc.values.mapNotNull { (it as? InterruptedDownload)?.part?.absoluteFile }.toSet()
        partsDirectory.listFiles()?.forEach { file ->
            if (file.isFile && file.name.endsWith(PART_SUFFIX) && file.absoluteFile !in kept) file.delete()
        }
    }

    private fun discardParts(old: InterruptedTransfer, new: InterruptedTransfer?) {
        val part = (old as? InterruptedDownload)?.part ?: return
        if ((new as? InterruptedDownload)?.part?.absoluteFile != part.absoluteFile) part.delete()
    }

    companion object {
        const val PART_SUFFIX = ".part"
    }
}
