package app.amizhthan.wolf

import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.RefreshRequest
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.RefreshProof
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.SessionManager
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant

/**
 * The app against a real WOLF API — not a model of one.
 *
 * The JVM tests prove the client behaves the way this code believes the server does. This proves the
 * server agrees: that a Keystore identity key is accepted at sign-in, that the device is recorded as an
 * Android device, that a rotated refresh token restores a session after a relaunch, that the server verifies the
 * Keystore key's signature on every refresh — refusing a wrong clock without revoking, and revoking the device's
 * tokens when a refresh arrives unsigned — and that signing out really revokes the refresh token on the server.
 *
 * It needs a running cloud, so it is off unless asked for:
 *
 *     npm run dev:cloud
 *     npm run test:android:device -- -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *         -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 *
 * Without the argument it records that it did not run, and says why, rather than passing on nothing.
 */
@RunWith(AndroidJUnit4::class)
class LiveApiTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun signs_in_restores_and_signs_out_against_a_real_wolf_api() = runBlocking {
        val baseUrl = arguments.getString("wolfLiveApi")
        if (baseUrl == null) {
            Log.i(TAG, "Not run: pass wolfLiveApi (and wolfLivePassword) with a local cloud running.")
            assertNull(arguments.getString("wolfLivePassword"))
            return@runBlocking
        }

        val email = arguments.getString("wolfLiveEmail") ?: "owner@example.com"
        val password = requireNotNull(arguments.getString("wolfLivePassword")) { "wolfLivePassword is required with wolfLiveApi" }

        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-wrap")
        val file = File(context.noBackupFilesDir, "live-credentials.bin")
        val api = WolfApi(baseUrl.toHttpUrl(), OkHttpClient())

        fun session() = SessionManager(api, TokenVault(file, cipher), identity, "WOLF live test", "Android ${Build.VERSION.RELEASE}")

        try {
            val first = session()
            first.signIn(email, password)

            val me = first.authorized { api.me(it) }
            assertEquals("the server recorded an Android device", "android", me.device?.kind)
            val pcs = first.authorized { api.listPcs(it) }
            Log.i(TAG, "signed in as device ${me.device?.id}; ${pcs.pcs.size} PC(s)")

            // A relaunch: a new session manager, the same stored credentials.
            val relaunched = session()
            assertTrue(relaunched.restore())
            assertEquals(me.device?.id, relaunched.authorized { api.me(it) }.device?.id)

            // Proof of possession, against the server's own verifier.
            val deviceId = requireNotNull(me.device?.id)
            var token = requireNotNull(TokenVault(file, cipher).read()).refreshToken
            try {
                api.refresh(RefreshRequest(token, deviceId, RefreshProof.create(identity, deviceId, token, Instant.now().minusSeconds(3600))))
                fail("a signature an hour old is refused")
            } catch (error: WolfApiException) {
                assertEquals(400, error.httpStatus)
                assertEquals("auth.device_clock", error.problem.code)
                Log.i(TAG, "a Keystore signature by a wrong clock refused without revoking: ${error.problem.code}")
            }

            token = api.refresh(RefreshRequest(token, deviceId, RefreshProof.create(identity, deviceId, token, Instant.now()))).refreshToken
            Log.i(TAG, "a Keystore-signed refresh accepted by the server's verifier")

            try {
                api.refresh(RefreshRequest(token, deviceId))
                fail("an unsigned refresh from a device with a key is refused")
            } catch (error: WolfApiException) {
                assertEquals(401, error.httpStatus)
            }
            try {
                api.refresh(RefreshRequest(token, deviceId, RefreshProof.create(identity, deviceId, token, Instant.now())))
                fail("the unsigned refresh revoked the device's tokens, so even a signed one of that token fails")
            } catch (error: WolfApiException) {
                assertEquals(401, error.httpStatus)
                Log.i(TAG, "an unsigned refresh revoked the device's tokens: ${error.problem.code}")
            }

            val stored = TokenVault(file, cipher).read()
            assertNotNull(stored)
            relaunched.signOut()

            try {
                api.refresh(RefreshRequest(stored!!.refreshToken, stored.deviceId))
                fail("a refresh token must not work after signing out")
            } catch (error: WolfApiException) {
                assertEquals(401, error.httpStatus)
                Log.i(TAG, "refresh after sign-out refused: ${error.problem.code}")
            }
        } finally {
            identity.delete()
            cipher.delete()
            file.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLiveApiTest"
    }
}
