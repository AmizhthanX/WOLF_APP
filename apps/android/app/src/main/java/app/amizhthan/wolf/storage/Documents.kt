package app.amizhthan.wolf.storage

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException

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
}

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

    private fun displayName(uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) cursor.getString(0) else null
        }
    }.getOrNull()
}
