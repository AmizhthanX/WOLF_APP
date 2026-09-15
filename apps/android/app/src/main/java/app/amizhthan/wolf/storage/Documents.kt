package app.amizhthan.wolf.storage

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

class ChosenDocument(val name: String, val bytes: ByteArray)

/**
 * Files the owner picked in the system's document picker.
 *
 * Only documents the owner chose, through the picker's own grant: the app asks for no storage permission,
 * sees no other files, and keeps nothing it read or wrote.
 */
interface DocumentStore {
    suspend fun write(uri: Uri, text: String)

    /** Reads at most [limitBytes]; a longer file comes back cut at that length, for the caller to refuse. */
    suspend fun read(uri: Uri, limitBytes: Int): ChosenDocument

    /** A chosen document open for writing, truncated. The caller closes it. */
    suspend fun openOutput(uri: Uri): OutputStream

    /** A chosen document open for reading, with its name and, when the provider knows it, its size. */
    suspend fun openInput(uri: Uri): OpenedDocument

    /** Remove a document this app created, when what went into it is not the whole file. */
    suspend fun delete(uri: Uri): Boolean
}

class OpenedDocument(val name: String, val sizeBytes: Long?, val stream: InputStream)

class ContentResolverDocuments(private val resolver: ContentResolver) : DocumentStore {
    override suspend fun write(uri: Uri, text: String) = withContext(Dispatchers.IO) {
        // "wt" truncates, so saving over an older, longer backup does not leave its tail in the file.
        val stream = resolver.openOutputStream(uri, "wt") ?: throw IOException("The chosen location could not be opened for writing.")
        stream.use { it.write(text.toByteArray(Charsets.UTF_8)) }
    }

    override suspend fun read(uri: Uri, limitBytes: Int): ChosenDocument = withContext(Dispatchers.IO) {
        val stream = resolver.openInputStream(uri) ?: throw IOException("The chosen file could not be opened.")
        val bytes = stream.use { input ->
            val buffer = ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            while (buffer.size() < limitBytes) {
                val read = input.read(chunk, 0, minOf(chunk.size, limitBytes - buffer.size()))
                if (read < 0) break
                buffer.write(chunk, 0, read)
            }
            buffer.toByteArray()
        }
        ChosenDocument(displayName(uri) ?: uri.lastPathSegment ?: "backup", bytes)
    }

    override suspend fun openOutput(uri: Uri): OutputStream = withContext(Dispatchers.IO) {
        resolver.openOutputStream(uri, "wt") ?: throw IOException("The chosen location could not be opened for writing.")
    }

    override suspend fun openInput(uri: Uri): OpenedDocument = withContext(Dispatchers.IO) {
        var name: String? = null
        var size: Long? = null
        runCatching {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.getString(0)
                    size = if (cursor.isNull(1)) null else cursor.getLong(1)
                }
            }
        }
        if (uri.scheme == "file") size = size ?: uri.path?.let { File(it).takeIf(File::isFile)?.length() }
        val stream = resolver.openInputStream(uri) ?: throw IOException("The chosen file could not be opened.")
        OpenedDocument(name ?: uri.lastPathSegment ?: "file", size, stream)
    }

    override suspend fun delete(uri: Uri): Boolean = withContext(Dispatchers.IO) {
        if (uri.scheme == "file") {
            uri.path?.let { File(it).delete() } == true
        } else {
            runCatching { DocumentsContract.deleteDocument(resolver, uri) }.getOrDefault(false)
        }
    }

    private fun displayName(uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull()
}
