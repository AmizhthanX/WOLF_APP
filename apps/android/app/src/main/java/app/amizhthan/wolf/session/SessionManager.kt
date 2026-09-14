package app.amizhthan.wolf.session

import app.amizhthan.wolf.api.DeviceDescriptor
import app.amizhthan.wolf.api.LoginRequest
import app.amizhthan.wolf.api.LogoutRequest
import app.amizhthan.wolf.api.RefreshRequest
import app.amizhthan.wolf.api.TokenGrant
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import app.amizhthan.wolf.api.WolfProblem
import app.amizhthan.wolf.security.DeviceIdentityProvider
import app.amizhthan.wolf.security.StoredCredentials
import app.amizhthan.wolf.security.TokenVault
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant

sealed interface SessionState {
    data object SignedOut : SessionState
    data class SignedIn(val deviceId: String) : SessionState
}

/**
 * Who the app is signed in as, and the only code that touches tokens.
 *
 * - The **access token** lives in this object's memory and nowhere else. It is gone when the process is.
 * - The **refresh token** lives in the [TokenVault], encrypted under a Keystore key.
 * - **A 401 means refresh once and retry once.** More than once would turn a revoked device into a
 *   loop against the refresh endpoint.
 * - **Concurrent callers share one refresh.** Refresh tokens rotate and the server revokes the whole
 *   family when a used one is presented again, so two parallel refreshes would sign the phone out.
 * - **Only a 401 from refresh signs out.** A network failure keeps the credentials; being offline is
 *   not being revoked.
 */
class SessionManager(
    private val api: WolfApi,
    private val vault: TokenVault,
    private val identity: DeviceIdentityProvider,
    private val deviceName: String,
    private val platform: String,
    private val clock: () -> Instant = Instant::now,
) {
    private val mutex = Mutex()

    @Volatile
    private var access: AccessToken? = null

    private val _state = MutableStateFlow<SessionState>(SessionState.SignedOut)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    private data class AccessToken(val token: String, val expiresAt: Instant)

    suspend fun signIn(email: String, password: String) = mutex.withLock {
        val previous = vault.read()
        val grant = api.login(
            LoginRequest(
                email = email.trim(),
                password = password,
                device = DeviceDescriptor(
                    id = previous?.deviceId,
                    name = deviceName.take(120).ifBlank { "Android" },
                    platform = platform.take(200),
                    publicKey = identity.publicKeySpki(),
                ),
            ),
        )
        adopt(grant)
    }

    /** At launch: turn stored credentials into a session, if there are any and they still work. */
    suspend fun restore(): Boolean = mutex.withLock {
        if (vault.read() == null) return@withLock false
        try {
            refreshLocked()
            true
        } catch (error: WolfApiException) {
            // Offline at launch with credentials that may well still be good: stay signed in, and let
            // the first call report the network problem.
            if (error.httpStatus == 0) {
                _state.value = SessionState.SignedIn(vault.read()?.deviceId ?: return@withLock false)
                true
            } else {
                false
            }
        }
    }

    /**
     * Run a call with a valid access token, refreshing once if the API rejects it.
     */
    suspend fun <T> authorized(call: suspend (bearer: String) -> T): T {
        val bearer = token(rejected = null)
        return try {
            call(bearer)
        } catch (error: WolfApiException) {
            if (error.httpStatus != 401) throw error
            call(token(rejected = bearer))
        }
    }

    /** Replace the access token with one from a password re-entry, which carries a fresh auth time. */
    suspend fun adoptAccessToken(token: String, expiresAt: String) = mutex.withLock {
        access = AccessToken(token, Instant.parse(expiresAt))
    }

    suspend fun signOut() = mutex.withLock {
        val stored = vault.read()
        if (stored != null) {
            // Best effort: a phone that cannot reach the server still forgets its credentials.
            runCatching { api.logout(LogoutRequest(stored.refreshToken)) }
        }
        forget()
    }

    private suspend fun token(rejected: String?): String = mutex.withLock {
        val current = access
        val fresh = current != null && current.expiresAt.isAfter(clock().plusSeconds(EXPIRY_MARGIN_SECONDS))

        // Another caller already refreshed while this one waited: use theirs rather than rotating again.
        if (current != null && fresh && current.token != rejected) return@withLock current.token

        refreshLocked()
    }

    private suspend fun refreshLocked(): String {
        val stored = vault.read() ?: run {
            forget()
            throw notSignedIn()
        }

        val grant = try {
            api.refresh(RefreshRequest(stored.refreshToken, stored.deviceId))
        } catch (error: WolfApiException) {
            if (error.httpStatus == 401) forget()
            throw error
        }

        return adopt(grant)
    }

    private fun adopt(grant: TokenGrant): String {
        vault.write(StoredCredentials(grant.refreshToken, grant.device.id))
        access = AccessToken(grant.accessToken, Instant.parse(grant.accessTokenExpiresAt))
        _state.value = SessionState.SignedIn(grant.device.id)
        return grant.accessToken
    }

    private fun forget() {
        access = null
        vault.clear()
        _state.value = SessionState.SignedOut
    }

    private fun notSignedIn() = WolfApiException(
        WolfProblem(
            code = "auth.not_signed_in",
            problem = "You are not signed in.",
            cause = "This phone has no WOLF credentials.",
            currentState = "Nothing was changed.",
            recommendedAction = "Sign in to continue.",
            referenceId = "WOLF-AUTH-NOCREDENTIALS",
        ),
        httpStatus = 401,
    )

    private companion object {
        /** Refresh a little before expiry, so a request is not sent with a token that dies in flight. */
        const val EXPIRY_MARGIN_SECONDS = 30L
    }
}
