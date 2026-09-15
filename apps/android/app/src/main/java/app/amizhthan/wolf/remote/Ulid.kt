package app.amizhthan.wolf.remote

import java.security.SecureRandom

/**
 * A WOLF identifier: 26 characters of Crockford base32, the first ten encoding milliseconds since the
 * epoch, the rest 80 random bits. The same format `@wolf/shared-types` produces and `wolfId` validates.
 *
 * The phone mints one for each stream it starts, so its signaling can be told apart from another stream
 * in the same session.
 */
object Ulid {
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val random = SecureRandom()

    val PATTERN = Regex("^[0-9A-HJKMNP-TV-Z]{26}$")

    fun next(nowMillis: Long = System.currentTimeMillis()): String {
        val chars = CharArray(26)

        var time = nowMillis
        for (index in 9 downTo 0) {
            chars[index] = ALPHABET[(time and 31L).toInt()]
            time = time ushr 5
        }

        val bytes = ByteArray(10).also(random::nextBytes)
        var buffer = 0L
        var bits = 0
        var byteIndex = 0
        for (index in 10 until 26) {
            if (bits < 5) {
                buffer = (buffer shl 8) or (bytes[byteIndex++].toLong() and 0xFF)
                bits += 8
            }
            bits -= 5
            chars[index] = ALPHABET[((buffer ushr bits) and 31L).toInt()]
        }

        return String(chars)
    }
}
