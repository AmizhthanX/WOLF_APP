package app.amizhthan.wolf.push

import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.session.SessionManager
import app.amizhthan.wolf.session.SessionState
import kotlinx.coroutines.CancellationException
import java.security.MessageDigest

/** This phone's registration token with the push service. */
interface PushTokens {
    /** The current token, or null when the push service cannot give one. */
    suspend fun current(): String?

    suspend fun delete()
}

/**
 * What was last registered with WOLF, kept as a marker — the device id and a hash of the token — so an unchanged
 * token is not registered again. Never the token itself.
 */
interface RegistrationStore {
    var marker: String?
}

data class PushState(
    /** This build has a push service (a Firebase project was supplied when it was built). */
    val buildConfigured: Boolean,
    /** The WOLF server has a push service; null when it could not be asked. */
    val serverConfigured: Boolean?,
    /** WOLF holds a token for this device. */
    val registered: Boolean,
)

/**
 * Keeping WOLF's record of this phone's push token current.
 *
 * Registered when signed in and the token is new, changed, or no longer on the server (a server's database
 * restored, say). Cleared on sign-out, on the server and on the phone, so a signed-out phone is not woken. No
 * failure here is shown as an error: push is a convenience, and every notification is in the inbox regardless.
 */
class PushRegistrar(
    private val api: WolfApi,
    private val session: SessionManager,
    private val tokens: PushTokens?,
    private val store: RegistrationStore,
) {
    suspend fun sync(): PushState {
        val signedIn = session.state.value as? SessionState.SignedIn ?: return PushState(tokens != null, null, registered = false)

        val status = try {
            session.authorized { api.pushStatus(it) }
        } catch (_: WolfApiException) {
            return PushState(tokens != null, null, registered = false)
        }

        val source = tokens ?: return PushState(false, status.configured, status.registered)
        val token = try {
            source.current()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            null
        } ?: return PushState(true, status.configured, status.registered)

        val marker = marker(signedIn.deviceId, token)
        if (status.registered && store.marker == marker) return PushState(true, status.configured, registered = true)

        return try {
            session.authorized { api.registerPushToken(token, it) }
            store.marker = marker
            PushState(true, status.configured, registered = true)
        } catch (_: WolfApiException) {
            PushState(true, status.configured, status.registered)
        }
    }

    /** Before signing out, while there is still an access token to clear the registration with. */
    suspend fun unregister() {
        if (session.state.value is SessionState.SignedIn) {
            try {
                session.authorized { api.clearPushToken(it) }
            } catch (_: WolfApiException) {
                // Offline: the server's copy goes when the device is revoked or the token is found dead.
            }
        }
        store.marker = null
        try {
            tokens?.delete()
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
        }
    }

    private fun marker(deviceId: String, token: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(token.toByteArray(Charsets.UTF_8))
        return "$deviceId:" + digest.joinToString("") { "%02x".format(it) }
    }
}
