package app.amizhthan.wolf

import app.amizhthan.wolf.security.AesGcmCipher
import app.amizhthan.wolf.security.HybridLockCipher
import app.amizhthan.wolf.security.LockKeyLostException
import app.amizhthan.wolf.security.VaultLockedException
import java.security.GeneralSecurityException
import java.security.KeyPair
import java.security.PublicKey
import javax.crypto.Cipher
import app.amizhthan.wolf.security.DeviceIdentityProvider
import app.amizhthan.wolf.security.Spki
import java.security.KeyPairGenerator
import java.security.spec.ECGenParameterSpec
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/** AES-GCM with a key held in memory: the vault's format, without a phone. */
class JvmAesGcmCipher(private val secret: SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()) : AesGcmCipher() {
    override fun key(): SecretKey = secret
}

/** A real P-256 key from the JVM, encoded the way the Keystore identity encodes its own. */
class JvmDeviceIdentity : DeviceIdentityProvider {
    val keyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

    override fun publicKeySpki(): String = Spki.base64Url(keyPair.public.encoded)
}

/** The app lock's sealing with a JVM RSA key, and a switch standing in for the owner's fingerprint. */
class JvmLockCipher : HybridLockCipher() {
    private var keyPair: KeyPair = newKeyPair()

    @Volatile
    var unlocked = false

    override fun publicKey(): PublicKey = keyPair.public

    override fun unwrap(wrapped: ByteArray): ByteArray {
        if (!unlocked) throw VaultLockedException()
        return try {
            Cipher.getInstance(HybridLockCipher.RSA_TRANSFORMATION).run {
                init(Cipher.DECRYPT_MODE, keyPair.private, HybridLockCipher.OAEP)
                doFinal(wrapped)
            }
        } catch (error: GeneralSecurityException) {
            throw LockKeyLostException("Not this key.", error)
        }
    }

    /** What removing the screen lock does to the Keystore key: nothing sealed before opens again. */
    fun invalidate() {
        keyPair = newKeyPair()
    }

    private companion object {
        fun newKeyPair(): KeyPair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
    }
}
