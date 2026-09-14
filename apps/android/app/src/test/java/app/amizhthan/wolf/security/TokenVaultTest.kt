package app.amizhthan.wolf.security

import app.amizhthan.wolf.JvmAesGcmCipher
import app.amizhthan.wolf.JvmDeviceIdentity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.KeyFactory
import java.security.interfaces.ECPublicKey
import java.security.spec.X509EncodedKeySpec
import java.util.Base64

/**
 * The refresh token at rest, and the identity key's encoding.
 *
 * What must hold: the token is never on disk in the clear; anything that does not decrypt is "signed
 * out", not a crash; and the public key the phone sends is exactly the encoding the server verifies.
 */
class TokenVaultTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val credentials = StoredCredentials(refreshToken = "rt_01J9ZQK7T0000000000000000A.secret-half", deviceId = "01J9ZQK7T0000000000000000D")

    private fun vault(cipher: SecretCipher = JvmAesGcmCipher(), file: File = File(folder.root, "credentials.bin")) = TokenVault(file, cipher)

    @Test
    fun credentials_round_trip() {
        val cipher = JvmAesGcmCipher()
        vault(cipher).write(credentials)
        assertEquals(credentials, vault(cipher).read())
    }

    @Test
    fun the_refresh_token_is_never_on_disk_in_the_clear() {
        val file = File(folder.root, "credentials.bin")
        vault(file = file).write(credentials)

        val raw = file.readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(raw.contains("secret-half"))
        assertFalse(raw.contains(credentials.deviceId))
        assertEquals(TokenVault.FORMAT_VERSION, file.readBytes()[0])
    }

    @Test
    fun the_same_credentials_encrypt_differently_each_time() {
        val cipher = JvmAesGcmCipher()
        val first = cipher.encrypt("same".toByteArray())
        val second = cipher.encrypt("same".toByteArray())
        assertNotEquals(first.toList(), second.toList())
    }

    @Test
    fun a_tampered_file_reads_as_signed_out_and_is_removed() {
        val file = File(folder.root, "credentials.bin")
        val cipher = JvmAesGcmCipher()
        vault(cipher, file).write(credentials)

        val bytes = file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 0x01).toByte()
        file.writeBytes(bytes)

        assertNull(vault(cipher, file).read())
        assertFalse("a file that cannot be decrypted is not kept", file.exists())
    }

    @Test
    fun a_file_sealed_under_another_key_reads_as_signed_out() {
        // What a restore onto a new phone, or a wiped Keystore, looks like from here.
        val file = File(folder.root, "credentials.bin")
        vault(JvmAesGcmCipher(), file).write(credentials)
        assertNull(vault(JvmAesGcmCipher(), file).read())
    }

    @Test
    fun an_unknown_format_or_a_truncated_file_reads_as_signed_out() {
        val file = File(folder.root, "credentials.bin")
        file.writeBytes(byteArrayOf(9, 1, 2, 3))
        assertNull(vault(file = file).read())

        file.writeBytes(byteArrayOf(TokenVault.FORMAT_VERSION, 12))
        assertNull(vault(file = file).read())

        file.writeBytes(ByteArray(0))
        assertNull(vault(file = file).read())
    }

    @Test
    fun clearing_removes_the_credentials() {
        val file = File(folder.root, "credentials.bin")
        val v = vault(file = file)
        v.write(credentials)
        v.clear()
        assertNull(v.read())
        assertFalse(file.exists())
    }

    @Test
    fun the_identity_key_is_encoded_as_the_server_expects() {
        val identity = JvmDeviceIdentity()
        val encoded = identity.publicKeySpki()

        // Base64url, no padding, and the P-256 SPKI header the server and the Windows agent share.
        assertFalse(encoded.contains('=') || encoded.contains('+') || encoded.contains('/'))
        assertTrue(encoded.startsWith(Spki.P256_PREFIX))

        val decoded = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(Base64.getUrlDecoder().decode(encoded))) as ECPublicKey
        assertEquals(256, decoded.params.curve.field.fieldSize)
        assertEquals(identity.keyPair.public, decoded)
    }
}
