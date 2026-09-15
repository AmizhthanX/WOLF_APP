package app.amizhthan.wolf.storage

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle

/**
 * This phone's clipboard, touched only when the owner taps.
 *
 * Android lets an app read the clipboard only while it is in front, and tells the owner when one does, so a
 * read here is always one the owner asked for and saw. Nothing read or written is kept or logged.
 */
class PhoneClipboard(context: Context) {
    private val manager = context.getSystemService(ClipboardManager::class.java)

    /**
     * The text on the clipboard, or null when there is none.
     *
     * Only an item's text: a copied image or file has a content address, and sending that address to a PC as
     * though it were what was copied would be a paste of nonsense.
     */
    fun readText(): String? = manager.primaryClip
        ?.takeIf { it.itemCount > 0 }
        ?.getItemAt(0)
        ?.text
        ?.toString()
        ?.takeIf { it.isNotEmpty() }

    /**
     * Put text from a PC on the clipboard, marked sensitive: a PC's clipboard routinely holds a password, and
     * Android 13 and later keep sensitive clips out of the on-screen copy preview.
     */
    fun writeText(text: String) {
        val clip = ClipData.newPlainText("From a PC", text)
        clip.description.extras = PersistableBundle().apply { putBoolean(EXTRA_IS_SENSITIVE, true) }
        manager.setPrimaryClip(clip)
    }

    private companion object {
        /** `ClipDescription.EXTRA_IS_SENSITIVE`, by value so it can be set on releases older than 13, which ignore it. */
        const val EXTRA_IS_SENSITIVE = "android.content.extra.IS_SENSITIVE"
    }
}
