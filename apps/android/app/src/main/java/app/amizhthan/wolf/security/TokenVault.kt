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
 * On disk only as ciphertext, in `noBackupFilesDir`. The access token is never here: it lives in memory and dies with
 * the process. Two ways of sealing, told apart by the first byte:
 *
 * - **1, ordinary:** a Keystore AES-256-GCM key the app can use and cannot read.
 * - **2, locked,** while the owner has the app lock on: [HybridLockCipher], which seals with a public key and opens
 *   only after the owner's fingerprint or screen lock. Reading it while locked throws [VaultLockedException] and keeps
 *   the file, because nothing is wrong with it.
 *
 * Anything else that does not decrypt — a file from another install, a Keystore key wiped when the lock screen
 * changed, a bit flipped on disk — is treated as "not signed in" and deleted, never as an error the owner has to
 * understand. When it was a locked vault whose key went with the screen lock, the app lock is turned off too, and
 * [takeLockLoss] says so once.
 */
class TokenVault(
    private val file: File,
    private val cipher: SecretCipher,
    private val lockCipher: SecretCipher? = null,
    /** Present while the app lock is on. It holds nothing — its existence is the setting — and it outlives signing out. */
    private val lockSetting: File = File(file.parentFile, "${file.name}.lock"),
) {
    @Volatile
    private var lockLost = false

    val lockEnabled: Boolean get() = lockCipher != null && lockSetting.exists()

    @Synchronized
    fun write(credentials: StoredCredentials) {
        val plaintext = WolfJson.encodeToString(StoredCredentials.serializer(), credentials).toByteArray(Charsets.UTF_8)
        val lock = lockCipher?.takeIf { lockSetting.exists() }
        val sealed = if (lock != null) {
            byteArrayOf(FORMAT_LOCKED) + lock.encrypt(plaintext)
        } else {
            byteArrayOf(FORMAT_VERSION) + cipher.encrypt(plaintext)
        }

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

    /**
     * The stored credentials, or null when there are none or they can no longer be opened.
     *
     * @throws VaultLockedException when they are there, locked, and the owner has not unlocked WOLF.
     */
    @Synchronized
    fun read(): StoredCredentials? {
        if (!file.exists()) return null
        val sealed = file.readBytes()

        val opening = when (sealed.firstOrNull()) {
            FORMAT_VERSION -> cipher
            FORMAT_LOCKED -> lockCipher ?: return discard()
            else -> return discard()
        }

        return try {
            val plaintext = opening.decrypt(sealed.copyOfRange(1, sealed.size))
            WolfJson.decodeFromString(StoredCredentials.serializer(), plaintext.toString(Charsets.UTF_8))
        } catch (_: LockKeyLostException) {
            // Nobody can open this one again. The lock it depended on is gone, so the setting goes with it rather than
            // failing the next sign-in on a key that cannot be made.
            lockSetting.delete()
            lockLost = true
            discard()
        } catch (_: GeneralSecurityException) {
            discard()
        } catch (_: SerializationException) {
            discard()
        } catch (_: IllegalArgumentException) {
            discard()
        }
    }

    /**
     * Turn the app lock on or off, and seal [current] — the credentials in use, if any — the new way.
     *
     * Turning it on makes and uses the lock key first. On a phone without a secure screen lock that throws, and the
     * vault is left exactly as it was.
     */
    @Synchronized
    fun setLockEnabled(enabled: Boolean, current: StoredCredentials?) {
        if (enabled) {
            val lock = requireNotNull(lockCipher) { "This vault has no lock." }
            lock.encrypt(byteArrayOf(0))
            lockSetting.parentFile?.mkdirs()
            lockSetting.writeBytes(ByteArray(0))
        } else {
            lockSetting.delete()
        }
        if (current != null) write(current)
    }

    /** True once, after a locked vault was lost with the screen lock it depended on. */
    fun takeLockLoss(): Boolean = lockLost.also { lockLost = false }

    /** Forget the credentials. The app lock setting is the owner's choice and stays. */
    @Synchronized
    fun clear() {
        file.delete()
    }

    private fun discard(): StoredCredentials? {
        file.delete()
        return null
    }

    companion object {
        const val FORMAT_VERSION: Byte = 1
        const val FORMAT_LOCKED: Byte = 2
    }
}

/**
 * AES-GCM over any key. Layout: one byte of IV length, the IV, then ciphertext with its tag.
 *
 * The Keystore cipher below, the app lock's per-write keys and the JVM tests share this layout, so the format is
 * tested without a phone and the Keystore is tested only for being the Keystore.
 */
abstract class AesGcmCipher : SecretCipher {
    protected abstract fun key(): SecretKey

    override fun encrypt(plaintext: ByteArray): ByteArray = seal(key(), plaintext)

    override fun decrypt(sealed: ByteArray): ByteArray = open(key(), sealed)

    companion object {
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128

        fun seal(key: SecretKey, plaintext: ByteArray): ByteArray {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            // The IV is chosen by the provider: the Keystore refuses caller-chosen IVs for encryption,
            // which is what stops an IV from ever being reused.
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(plaintext)
            return byteArrayOf(iv.size.toByte()) + iv + ciphertext
        }

        fun open(key: SecretKey, sealed: ByteArray): ByteArray {
            if (sealed.isEmpty()) throw GeneralSecurityException("Empty ciphertext.")
            val ivLength = sealed[0].toInt()
            if (ivLength !in 12..16 || sealed.size < 1 + ivLength + TAG_BITS / 8) {
                throw GeneralSecurityException("Malformed ciphertext.")
            }

            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, sealed, 1, ivLength))
            return cipher.doFinal(sealed, 1 + ivLength, sealed.size - 1 - ivLength)
        }
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
