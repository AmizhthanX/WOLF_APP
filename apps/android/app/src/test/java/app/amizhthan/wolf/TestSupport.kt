package app.amizhthan.wolf

import app.amizhthan.wolf.security.AesGcmCipher
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
