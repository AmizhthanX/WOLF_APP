package app.amizhthan.wolf

import android.app.KeyguardManager
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.security.TokenVault
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Leaves the app itself signed in with the app lock on, for a runner to relaunch and look at: the system prompt on
 * arrival, and the locked screen with what dismissing the prompt said.
 *
 * Uses the app's own graph — its real vault, Keystore aliases and API address — against a local cloud, so it runs
 * only when asked (`wolfPrepareLockedApp=true`), and through `am instrument` rather than Gradle, which uninstalls the
 * app afterwards. The runner clears the app's data when it is done.
 */
@RunWith(AndroidJUnit4::class)
class PrepareLockedAppTest {
    @Test
    fun sign_in_and_turn_the_app_lock_on() = runBlocking {
        val arguments = InstrumentationRegistry.getArguments()
        if (arguments.getString("wolfPrepareLockedApp") != "true") {
            Log.i(TAG, "Not run: pass wolfPrepareLockedApp=true and wolfLivePassword with a local cloud.")
            return@runBlocking
        }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertTrue("the device has a screen lock", context.getSystemService(KeyguardManager::class.java).isDeviceSecure)

        val graph = AppGraph.get(context)
        graph.session.signIn(arguments.getString("wolfLiveEmail") ?: "owner@example.com", requireNotNull(arguments.getString("wolfLivePassword")))
        graph.session.setAppLock(true)

        assertTrue(graph.session.appLockOn)
        assertEquals(TokenVault.FORMAT_LOCKED, File(context.noBackupFilesDir, "credentials.bin").readBytes()[0])
        Log.i(TAG, "signed in, app lock on, the vault sealed with the lock key")
    }

    private companion object {
        const val TAG = "WolfPrepareLocked"
    }
}
