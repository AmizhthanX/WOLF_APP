package app.amizhthan.wolf.security

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import java.nio.ByteBuffer
import java.security.GeneralSecurityException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * The owner has not unlocked WOLF recently enough to read its credentials.
 *
 * Nothing is wrong with them, and they are kept: this is a door that is shut, not a key that is lost. Deliberately not a
 * [GeneralSecurityException], which the vault answers by deleting what it cannot open.
 */
class VaultLockedException(cause: Throwable? = null) : Exception("WOLF is locked.", cause)

/** The key a locked vault needs is gone — with the screen lock it was tied to — so nobody can open that vault again. */
class LockKeyLostException(message: String, cause: Throwable? = null) : GeneralSecurityException(message, cause)

/**
 * Sealing that needs nobody, and opening that needs the owner.
 *
 * Each write makes a fresh AES-256 key, seals the credentials with it in the vault's AES-GCM layout, and wraps that key
 * with an RSA public key. The public half needs no authentication, so a refresh token the server rotates is written
 * when it is issued — in the background too. Only unwrapping needs the private half, which the Keystore releases for a
 * short while after the owner's fingerprint, face or screen lock.
 *
 * Layout: two bytes of wrapped-key length, the wrapped key, then the AES-GCM body.
 */
abstract class HybridLockCipher : SecretCipher {
    protected abstract fun publicKey(): PublicKey

    /** The data key, unwrapped. Throws [VaultLockedException] when the owner has not unlocked. */
    protected abstract fun unwrap(wrapped: ByteArray): ByteArray

    override fun encrypt(plaintext: ByteArray): ByteArray {
        val raw = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey().encoded
        try {
            val rsa = Cipher.getInstance(RSA_TRANSFORMATION)
            rsa.init(Cipher.ENCRYPT_MODE, publicKey(), OAEP)
            val wrapped = rsa.doFinal(raw)
            val body = AesGcmCipher.seal(SecretKeySpec(raw, "AES"), plaintext)
            return ByteBuffer.allocate(2 + wrapped.size + body.size)
                .putShort(wrapped.size.toShort())
                .put(wrapped)
                .put(body)
                .array()
        } finally {
            raw.fill(0)
        }
    }

    override fun decrypt(sealed: ByteArray): ByteArray {
        if (sealed.size < 2) throw GeneralSecurityException("Malformed locked ciphertext.")
        val wrappedLength = ((sealed[0].toInt() and 0xFF) shl 8) or (sealed[1].toInt() and 0xFF)
        if (wrappedLength !in 64..1024 || sealed.size <= 2 + wrappedLength) {
            throw GeneralSecurityException("Malformed locked ciphertext.")
        }

        val raw = unwrap(sealed.copyOfRange(2, 2 + wrappedLength))
        try {
            if (raw.size != 32) throw GeneralSecurityException("Unexpected data key.")
            return AesGcmCipher.open(SecretKeySpec(raw, "AES"), sealed.copyOfRange(2 + wrappedLength, sealed.size))
        } finally {
            raw.fill(0)
        }
    }

    companion object {
        const val RSA_TRANSFORMATION = "RSA/ECB/OAEPPadding"

        /** SHA-256 OAEP with SHA-1 MGF1: the combination the Android Keystore decrypts with. */
        val OAEP = OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT)
    }
}

/**
 * The app lock's RSA key pair in the Android Keystore, released only after the owner authenticates.
 *
 * - A fingerprint or face of the platform's strong class, or the screen lock's PIN, pattern or password.
 * - Usable for [unlockWindowSeconds] afterwards: enough to read the vault straight after the prompt, and no more.
 *   Once read, the session holds the credentials in memory, so the window does not need to be long.
 * - Destroyed by the platform when the screen lock is removed or reset. The vault then cannot be opened by anyone
 *   and reads as signed out, with the reason.
 * - Not tied to biometric enrollment: adding a fingerprint needs the screen lock, which already opens the key.
 */
class KeystoreLockCipher(
    private val alias: String = "wolf-token-lock",
    private val unlockWindowSeconds: Int = 30,
) : HybridLockCipher() {
    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    /** Throws when the phone has no secure screen lock: an authentication-bound key cannot exist without one. */
    @Synchronized
    private fun ensureKey() {
        if (keyStore().containsAlias(alias)) return

        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(2048)
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            .setUserAuthenticationRequired(true)
            .setInvalidatedByBiometricEnrollment(false)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            spec.setUserAuthenticationParameters(unlockWindowSeconds, KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
        } else {
            @Suppress("DEPRECATION")
            spec.setUserAuthenticationValidityDurationSeconds(unlockWindowSeconds)
        }

        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE).run {
            initialize(spec.build())
            generateKeyPair()
        }
    }

    override fun publicKey(): PublicKey {
        ensureKey()
        val certificate = keyStore().getCertificate(alias) ?: throw LockKeyLostException("The lock key is gone.")
        // An ordinary copy of the public half, so sealing runs in an ordinary provider and needs no authentication.
        return KeyFactory.getInstance(certificate.publicKey.algorithm).generatePublic(X509EncodedKeySpec(certificate.publicKey.encoded))
    }

    override fun unwrap(wrapped: ByteArray): ByteArray {
        val key = try {
            keyStore().getKey(alias, null) as? PrivateKey
        } catch (error: GeneralSecurityException) {
            throw LockKeyLostException("The lock key could not be loaded.", error)
        } ?: throw LockKeyLostException("The lock key is gone.")

        try {
            val rsa = Cipher.getInstance(RSA_TRANSFORMATION)
            rsa.init(Cipher.DECRYPT_MODE, key, OAEP)
            return rsa.doFinal(wrapped)
        } catch (error: KeyPermanentlyInvalidatedException) {
            throw LockKeyLostException("The screen lock this key depended on was removed or reset.", error)
        } catch (error: GeneralSecurityException) {
            // Some releases refuse at init, others only at doFinal with the reason further down the chain.
            if (error.meansNotAuthenticated()) throw VaultLockedException(error)
            throw error
        }
    }

    fun delete() {
        keyStore().deleteEntry(alias)
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}

private fun Throwable.meansNotAuthenticated(): Boolean = generateSequence(this) { it.cause }.any { cause ->
    cause is UserNotAuthenticatedException || cause.message?.contains("not authenticated", ignoreCase = true) == true
}
