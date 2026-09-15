package app.amizhthan.wolf

import android.app.KeyguardManager
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.security.KeystoreLockCipher
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.StoredCredentials
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.security.VaultLockedException
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The app lock's key in the real Android Keystore.
 *
 * Needs a screen lock, which the runner sets on the emulator as a throwaway PIN (`wolfTestPin`) and removes afterwards.
 * Without one it proves nothing and says so. The owner's unlock is stood in for by `locksettings verify`, run as the
 * shell: the same credential check the lock screen makes, which gives the Keystore the same proof of authentication.
 * The system prompt itself is not driven here.
 *
 *     adb shell locksettings set-pin <pin>
 *     adb shell am instrument -w -e class app.amizhthan.wolf.AppLockKeystoreTest -e wolfTestPin <pin> \
 *       app.amizhthan.wolf.test/androidx.test.runner.AndroidJUnitRunner
 */
@RunWith(AndroidJUnit4::class)
class AppLockKeystoreTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val lock = KeystoreLockCipher(alias = "wolf-test-lock", unlockWindowSeconds = UNLOCK_WINDOW_SECONDS)
    private val plain = KeystoreSecretCipher(alias = "wolf-test-lock-plain")
    private val file = File(context.noBackupFilesDir, "test-locked-credentials.bin")

    @After
    fun cleanUp() {
        runCatching { lock.delete() }
        plain.delete()
        file.delete()
        File(file.parentFile, "${file.name}.lock").delete()
    }

    @Test
    fun sealing_needs_nobody_opening_needs_the_owner_and_losing_the_screen_lock_loses_the_sign_in() {
        val pin = InstrumentationRegistry.getArguments().getString("wolfTestPin")
        val keyguard = context.getSystemService(KeyguardManager::class.java)
        if (pin == null || !keyguard.isDeviceSecure) {
            Log.i(TAG, "Not run: set a screen lock PIN and pass it as wolfTestPin.")
            assertNull(pin)
            return
        }

        val vault = TokenVault(file, plain, lock)
        val credentials = StoredCredentials("refresh-1-0123456789abcdef", "01J9ZQK7T0000000000000000D")

        // Well past any authentication the runner's own PIN change counted as.
        Thread.sleep((UNLOCK_WINDOW_SECONDS + 3) * 1000L)

        vault.setLockEnabled(true, credentials)
        assertEquals("sealed with the lock key, by nobody", TokenVault.FORMAT_LOCKED, file.readBytes()[0])

        val refused = runCatching { vault.read() }.exceptionOrNull()
        Log.i(TAG, "read without the owner: $refused")
        assertTrue("refused as locked, not as broken: $refused", refused is VaultLockedException)
        assertTrue("and the sealed sign-in is kept", file.exists())

        Log.i(TAG, "verify: ${shell("locksettings verify --old $pin").trim()}")
        assertEquals("opened once the owner authenticated", credentials, vault.read())

        Thread.sleep((UNLOCK_WINDOW_SECONDS + 3) * 1000L)
        val rotated = credentials.copy(refreshToken = "refresh-2-0123456789abcdef")
        vault.write(rotated)
        val refusedAgain = runCatching { vault.read() }.exceptionOrNull()
        assertTrue("a token rotated while locked is written, and stays locked: $refusedAgain", refusedAgain is VaultLockedException)

        shell("locksettings verify --old $pin")
        assertEquals(rotated, vault.read())

        Log.i(TAG, "clear: ${shell("locksettings clear --old $pin").trim()}")
        assertFalse("the screen lock is gone", keyguard.isDeviceSecure)
        assertNull("a sign-in sealed with a key that went with the screen lock reads as signed out", vault.read())
        assertFalse(file.exists())
        assertTrue("and says why, once", vault.takeLockLoss())
        assertFalse(vault.takeLockLoss())
        assertFalse("the lock turns itself off rather than failing the next sign-in", vault.lockEnabled)
        Log.i(TAG, "lock key lost with the screen lock, as expected")
    }

    private fun shell(command: String): String =
        instrumentation.uiAutomation.executeShellCommand(command).let { descriptor ->
            java.io.FileInputStream(descriptor.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { descriptor.close() }
        }

    private companion object {
        const val TAG = "WolfAppLockTest"
        const val UNLOCK_WINDOW_SECONDS = 5
    }
}
