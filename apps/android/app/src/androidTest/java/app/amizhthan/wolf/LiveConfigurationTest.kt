package app.amizhthan.wolf

import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.amizhthan.wolf.api.AlertRules
import app.amizhthan.wolf.api.ConfigurationBackups
import app.amizhthan.wolf.api.RestoreRequest
import app.amizhthan.wolf.api.RestoreResult
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.security.KeystoreDeviceIdentity
import app.amizhthan.wolf.security.KeystoreSecretCipher
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.session.AccountAuthority
import app.amizhthan.wolf.session.Authorized
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.storage.ContentResolverDocuments
import kotlinx.coroutines.runBlocking
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Backup and restore against a real WOLF API, through the app's real document store.
 *
 * A backup is saved to a file and read back, an alert rule it holds is deleted, and only the alert rules
 * are restored from the file — confirmed at the level the server names. An edited copy is then refused by
 * the server. Only alert rules are restored, so the account's PC names, profiles and automations are not
 * touched.
 *
 *     npm run dev:cloud
 *     npm run test:android:device -- \
 *       -Pandroid.testInstrumentationRunnerArguments.class=app.amizhthan.wolf.LiveConfigurationTest \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLiveApi=http://10.0.2.2:8080 \
 *       -Pandroid.testInstrumentationRunnerArguments.wolfLivePassword=<owner password>
 */
@RunWith(AndroidJUnit4::class)
class LiveConfigurationTest {
    private val arguments = InstrumentationRegistry.getArguments()
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun backs_up_to_a_file_and_restores_alert_rules_from_it() = runBlocking {
        val baseUrl = arguments.getString("wolfLiveApi")
        if (baseUrl == null) {
            Log.i(TAG, "Not run: pass wolfLiveApi and wolfLivePassword with a local cloud running.")
            assertNull(arguments.getString("wolfLivePassword"))
            return@runBlocking
        }
        val email = arguments.getString("wolfLiveEmail") ?: "owner@example.com"
        val password = requireNotNull(arguments.getString("wolfLivePassword")) { "wolfLivePassword is required with wolfLiveApi" }

        val identity = KeystoreDeviceIdentity(context, alias = "wolf-live-configuration-identity")
        val cipher = KeystoreSecretCipher(alias = "wolf-live-configuration-wrap")
        val credentials = File(context.noBackupFilesDir, "live-configuration-credentials.bin")
        val api = WolfApi(baseUrl.toHttpUrl(), OkHttpClient())
        val session = SessionManager(api, TokenVault(credentials, cipher), identity, "WOLF live configuration test", "Android ${Build.VERSION.RELEASE}")
        val authority = AccountAuthority(api, session)
        val documents = ContentResolverDocuments(context.contentResolver)
        var ruleId: String? = null
        var saved: File? = null

        try {
            session.signIn(email, password)
            val rule = session.authorized {
                api.createAlertRule(AlertRules.rule("Live test: backed up", null, "pc-offline", null, null, null, 720, "info", 60), it)
            }.rule
            ruleId = rule.id

            // 1. The backup, written through the document store and read back unchanged.
            val backup = session.authorized { api.configurationBackup(it) }
            val file = File(context.cacheDir, ConfigurationBackups.fileName(backup)).also { saved = it }
            documents.write(Uri.fromFile(file), ConfigurationBackups.text(backup))
            val reread = ConfigurationBackups.parse(documents.read(Uri.fromFile(file), ConfigurationBackups.MAX_FILE_BYTES + 1).bytes)
            assertEquals(backup, reread)

            val text = file.readText()
            assertTrue("the backup holds the rule", text.contains("Live test: backed up"))
            listOf("passwordHash", "password_hash", "refreshToken", "accessToken", "sessionToken", "enrollmentToken", "publicKey").forEach {
                assertFalse("a backup holds nothing that grants access ($it)", text.contains(it))
            }
            Log.i(TAG, "backup ${file.name}: ${ConfigurationBackups.summary(reread)}, ${file.length()} bytes")

            // 2. Delete the rule, then restore only alert rules from the file.
            session.authorized { api.deleteAlertRule(rule.id, it) }
            val request = RestoreRequest(reread, listOf("alertRules"))
            val plan = session.authorized { api.previewRestore(request, it) }.plan
            assertTrue("the preview creates the deleted rule", (plan.sections["alertRules"]?.created ?: 0) >= 1)
            assertEquals("medium", plan.riskLevel)

            val save: suspend (String, String?) -> RestoreResult = { bearer, confirmed -> api.restoreConfiguration(request.copy(confirmedRiskLevel = confirmed), bearer) }
            val pending = (authority.attempt("Restore configuration", "Live test", save) as Authorized.NeedsConfirmation).pending
            assertEquals("medium", pending.riskLevel)
            assertFalse(pending.requiresPassword)

            val result = when (val outcome = authority.confirm(pending, password = null, save)) {
                is Authorized.Done -> outcome.value
                is Authorized.NeedsConfirmation -> throw AssertionError("the server asked again, for ${outcome.pending.riskLevel}")
            }
            val restored = session.authorized { api.listAlertRules(it) }.rules.firstOrNull { it.id == rule.id }
            assertNotNull("the rule came back, with its id", restored)
            Log.i(TAG, "restored at ${result.restoredAt}: ${ConfigurationBackups.describe(result.plan)}")

            // 3. An edited copy: its checksum no longer matches, and the server says so.
            val edited = ConfigurationBackups.parse(text.replace("Live test: backed up", "Live test: edited").toByteArray())
            try {
                session.authorized { api.previewRestore(RestoreRequest(edited, listOf("alertRules")), it) }
                fail("an edited backup must be refused")
            } catch (error: WolfApiException) {
                assertEquals("configuration.invalid_backup", error.problem.code)
                Log.i(TAG, "edited copy refused: ${error.problem.problem}")
            }
        } finally {
            ruleId?.let { id -> runCatching { session.authorized { api.deleteAlertRule(id, it) } } }
            runCatching { session.signOut() }
            saved?.delete()
            identity.delete()
            cipher.delete()
            credentials.delete()
        }
    }

    private companion object {
        const val TAG = "WolfLiveConfiguration"
    }
}
