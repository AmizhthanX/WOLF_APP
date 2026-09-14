package app.amizhthan.wolf.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import app.amizhthan.wolf.api.WolfJson
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import java.io.File
import java.security.GeneralSecurityException
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts and decrypts small secrets. The output carries everything decryption needs except the key. */
interface SecretCipher {
    fun encrypt(plaintext: ByteArray): ByteArray

    /** Throws [GeneralSecurityException] for anything tampered with, truncated, or sealed under another key. */
    fun decrypt(sealed: ByteArray): ByteArray
}

/** The one durable credential the app holds, and the device it belongs to. */
@Serializable
data class StoredCredentials(val refreshToken: String, val deviceId: String)

/**
 * Where the refresh token lives between launches.
 *
 * On disk only as ciphertext, in `noBackupFilesDir`, sealed with a Keystore AES-256-GCM key the app
 * can use and cannot read. The access token is never here: it lives in memory and dies with the
 * process.
 *
 * Anything that does not decrypt — a file from another install, a Keystore key that was wiped when the
 * lock screen changed, a bit flipped on disk — is treated as "not signed in" and deleted, never as an
 * error the owner has to understand.
 */
class TokenVault(
    private val file: File,
    private val cipher: SecretCipher,
) {
    @Synchronized
    fun write(credentials: StoredCredentials) {
        val plaintext = WolfJson.encodeToString(StoredCredentials.serializer(), credentials).toByteArray(Charsets.UTF_8)
        val sealed = byteArrayOf(FORMAT_VERSION) + cipher.encrypt(plaintext)

        // Written beside the real file and renamed over it, so a crash mid-write leaves the previous
        // credentials rather than half of new ones.
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeBytes(sealed)
        if (!temporary.renameTo(file)) {
            file.delete()
            check(temporary.renameTo(file)) { "Could not store credentials." }
        }
    }

    @Synchronized
    fun read(): StoredCredentials? {
        if (!file.exists()) return null
        val sealed = file.readBytes()

        if (sealed.isEmpty() || sealed[0] != FORMAT_VERSION) {
            clear()
            return null
        }

        return try {
            val plaintext = cipher.decrypt(sealed.copyOfRange(1, sealed.size))
            WolfJson.decodeFromString(StoredCredentials.serializer(), plaintext.toString(Charsets.UTF_8))
        } catch (_: GeneralSecurityException) {
            clear()
            null
        } catch (_: SerializationException) {
            clear()
            null
        } catch (_: IllegalArgumentException) {
            clear()
            null
        }
    }

    @Synchronized
    fun clear() {
        file.delete()
    }

    companion object {
        const val FORMAT_VERSION: Byte = 1
    }
}

/**
 * AES-GCM over any key. Layout: one byte of IV length, the IV, then ciphertext with its tag.
 *
 * The Keystore cipher below and the JVM tests share this layout, so the format is tested without a
 * phone and the Keystore is tested only for being the Keystore.
 */
abstract class AesGcmCipher : SecretCipher {
    protected abstract fun key(): SecretKey

    override fun encrypt(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // The IV is chosen by the provider: the Keystore refuses caller-chosen IVs for encryption,
        // which is what stops an IV from ever being reused.
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val ciphertext = cipher.doFinal(plaintext)
        return byteArrayOf(iv.size.toByte()) + iv + ciphertext
    }

    override fun decrypt(sealed: ByteArray): ByteArray {
        if (sealed.isEmpty()) throw GeneralSecurityException("Empty ciphertext.")
        val ivLength = sealed[0].toInt()
        if (ivLength !in 12..16 || sealed.size < 1 + ivLength + TAG_BITS / 8) {
            throw GeneralSecurityException("Malformed ciphertext.")
        }

        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 1, ivLength))
        return cipher.doFinal(sealed, 1 + ivLength, sealed.size - 1 - ivLength)
    }

    private companion object {
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_BITS = 128
    }
}

class KeystoreSecretCipher(private val alias: String = "wolf-token-wrap") : AesGcmCipher() {
    @Synchronized
    override fun key(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    fun delete() {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }.deleteEntry(alias)
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}
