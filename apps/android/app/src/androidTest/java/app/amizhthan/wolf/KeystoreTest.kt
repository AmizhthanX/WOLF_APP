package app.amizhthan.wolf

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.Spki
import app.amizhthan.wolf.security.StoredCredentials
import app.amizhthan.wolf.security.TokenVault
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature

/**
 * The Android Keystore itself, on a device or emulator.
 *
 * The JVM tests cover the formats. These cover what only a phone can: that the identity key is made by
 * the Keystore and cannot be read out of it, that what it signs verifies against the key the server is
 * sent, and that the token vault's key persists across instances.
 */
@RunWith(AndroidJUnit4::class)
class KeystoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val identity = KeystoreDeviceIdentity(context, alias = "wolf-test-identity")
    private val cipher = KeystoreSecretCipher(alias = "wolf-test-wrap")
    private val file = File(context.noBackupFilesDir, "test-credentials.bin")

    @After
    fun cleanUp() {
        identity.delete()
        cipher.delete()
        file.delete()
    }

    @Test
    fun the_identity_key_is_created_once_and_its_private_half_cannot_be_read() {
        val first = identity.publicKeySpki()
        val second = KeystoreDeviceIdentity(context, alias = "wolf-test-identity").publicKeySpki()

        assertEquals("the same key across instances, so the phone stays one device", first, second)
        assertTrue(first.startsWith(Spki.P256_PREFIX))

        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val privateKey = keyStore.getKey("wolf-test-identity", null) as PrivateKey
        assertNull("a Keystore private key exposes no key material", privateKey.encoded)

        Log.i("WolfKeystoreTest", "identity key hardware-backed: ${identity.isHardwareBacked()}")
    }

    @Test
    fun what_the_identity_signs_verifies_against_the_key_sent_to_the_server() {
        val payload = "wolf-device-proof".toByteArray()
        val signature = identity.sign(payload)

        val verifier = Signature.getInstance("SHA256withECDSA").apply {
            initVerify(identity.publicKey())
            update(payload)
        }
        assertTrue(verifier.verify(signature))
    }

    @Test
    fun the_vault_round_trips_through_the_keystore_across_instances() {
        val credentials = StoredCredentials("refresh-1-0123456789abcdef", "01J9ZQK7T0000000000000000D")
        TokenVault(file, cipher).write(credentials)

        assertEquals(credentials, TokenVault(file, KeystoreSecretCipher(alias = "wolf-test-wrap")).read())
    }

    @Test
    fun the_keystore_cipher_rejects_tampering_and_a_deleted_key_means_signed_out() {
        val sealed = cipher.encrypt("secret".toByteArray())
        assertArrayEquals("secret".toByteArray(), cipher.decrypt(sealed))

        val tampered = sealed.copyOf().also { it[it.size - 1] = (it[it.size - 1].toInt() xor 1).toByte() }
        assertTrue(runCatching { cipher.decrypt(tampered) }.isFailure)

        TokenVault(file, cipher).write(StoredCredentials("refresh-1-0123456789abcdef", "01J9ZQK7T0000000000000000D"))
        cipher.delete()
        // A new key is made on demand; the old file no longer decrypts and is treated as signed out.
        assertNull(TokenVault(file, KeystoreSecretCipher(alias = "wolf-test-wrap")).read())
    }
}
