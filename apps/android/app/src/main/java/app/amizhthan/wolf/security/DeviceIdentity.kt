package app.amizhthan.wolf.security

import android.content.Context
import android.content.pm.PackageManager
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.Base64

/** The phone's identity as the WOLF API sees it: the public half of a key that never leaves the phone. */
interface DeviceIdentityProvider {
    /** Base64url (no padding) X.509 SubjectPublicKeyInfo of an ECDSA P-256 key. */
    fun publicKeySpki(): String
}

object Spki {
    /**
     * The encoding the server uses for every identity key: DER SPKI, base64url, no padding — what
     * Node's `export({ type: 'spki', format: 'der' }).toString('base64url')` produces.
     */
    fun base64Url(der: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(der)

    /**
     * Every P-256 SPKI begins with the same 26 DER bytes — the algorithm identifiers for EC and for
     * prime256v1 — which encode to this prefix. A key that does not start with it is not the key type
     * the server verifies.
     */
    const val P256_PREFIX = "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE"
}

/**
 * The phone's ECDSA P-256 identity key, in the Android Keystore.
 *
 * P-256 because it is what the server and the Windows agent already use, and because every Keystore
 * implementation back to Android 6 supports it in hardware. StrongBox is used where the phone has one;
 * otherwise the TEE; otherwise — on an emulator — software, which [isHardwareBacked] reports.
 *
 * The key is created with no export purpose: the Keystore will sign with it and nothing will read it.
 */
class KeystoreDeviceIdentity(
    private val context: Context,
    private val alias: String = "wolf-device-identity",
) : DeviceIdentityProvider {

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    override fun publicKeySpki(): String = Spki.base64Url(publicKey().encoded)

    @Synchronized
    fun publicKey(): PublicKey = keyStore().getCertificate(alias)?.publicKey ?: generate()

    fun sign(data: ByteArray): ByteArray {
        publicKey()
        val privateKey = keyStore().getKey(alias, null) as PrivateKey
        return Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey)
            update(data)
            sign()
        }
    }

    /** Null when the Keystore will not say. */
    fun isHardwareBacked(): Boolean? = runCatching {
        publicKey()
        val privateKey = keyStore().getKey(alias, null) as PrivateKey
        val info = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE).getKeySpec(privateKey, KeyInfo::class.java)
        @Suppress("DEPRECATION")
        info.isInsideSecureHardware
    }.getOrNull()

    /** Removes the key. A new one, and a new device in the owner's list, follow the next sign-in. */
    fun delete() {
        keyStore().deleteEntry(alias)
    }

    private fun generate(): PublicKey {
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .apply { if (strongBox) setIsStrongBoxBacked(true) }
            .build()

        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
        val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

        return try {
            generator.initialize(spec(strongBox))
            generator.generateKeyPair().public
        } catch (_: StrongBoxUnavailableException) {
            generator.initialize(spec(false))
            generator.generateKeyPair().public
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
    }
}
