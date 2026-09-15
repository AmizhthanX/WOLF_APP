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
import app.amizhthan.wolf.security.RefreshProof
import app.amizhthan.wolf.security.StoredCredentials
import app.amizhthan.wolf.security.TokenVault
import app.amizhthan.wolf.security.VaultLockedException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Duration
import java.time.Instant

sealed interface SessionState {
    data object SignedOut : SessionState

    /** Credentials are on the phone, sealed until the owner unlocks WOLF. */
    data object Locked : SessionState

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
 *   not being revoked, and neither is a clock the server says is wrong.
 * - **Every refresh is signed with the Keystore identity key**, so a refresh token copied off the phone is refused
 *   without the phone.
 * - **With the app lock on**, the vault opens only after the owner's fingerprint or screen lock. Once opened, the
 *   credentials are held here, in memory, so refreshing goes on while WOLF is in use; they are dropped when the process
 *   ends and after [lockAfter] in the background, and the session is [SessionState.Locked] until the owner unlocks
 *   again. Work that arrives while locked — a wake-up, a token about to expire — is refused with `auth.locked` and
 *   sends nothing.
 */
class SessionManager(
    private val api: WolfApi,
    private val vault: TokenVault,
    private val identity: DeviceIdentityProvider,
    private val deviceName: String,
    private val platform: String,
    private val clock: () -> Instant = Instant::now,
    private val lockAfter: Duration = Duration.ofMinutes(LOCK_AFTER_MINUTES),
) {
    private val mutex = Mutex()

    @Volatile
    private var access: AccessToken? = null

    /** The credentials, once opened. Held in memory so a locked vault is read once per unlock. */
    @Volatile
    private var held: StoredCredentials? = null

    @Volatile
    private var backgroundSince: Instant? = null

    private val _state = MutableStateFlow<SessionState>(SessionState.SignedOut)
    val state: StateFlow<SessionState> = _state.asStateFlow()

    val appLockOn: Boolean get() = vault.lockEnabled

    private data class AccessToken(val token: String, val expiresAt: Instant)

    suspend fun signIn(email: String, password: String) = mutex.withLock {
        val previous = try {
            stored()
        } catch (_: VaultLockedException) {
            null
        }
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

    /**
     * At launch: turn stored credentials into a session, if there are any and they still work.
     *
     * False with [state] at [SessionState.Locked] when they are there and sealed: nothing is sent until [unlock].
     */
    suspend fun restore(): Boolean = mutex.withLock {
        val credentials = try {
            stored()
        } catch (_: VaultLockedException) {
            locked()
            return@withLock false
        } ?: return@withLock false
        resume(credentials)
    }

    /**
     * After the owner's fingerprint or screen lock: open the vault and go on as [restore] would have.
     *
     * @throws VaultLockedException when the Keystore still does not count the owner as authenticated — a weak biometric
     *   on an older release, or a prompt that was passed too long ago. The session stays locked.
     */
    suspend fun unlock(): Boolean = mutex.withLock {
        backgroundSince = null
        val credentials = stored() ?: run {
            forget()
            return@withLock false
        }
        resume(credentials)
    }

    /** Put the credentials away until the owner unlocks again. Only with the app lock on; otherwise nothing happens. */
    suspend fun lock() = mutex.withLock {
        if (vault.lockEnabled && _state.value is SessionState.SignedIn) locked()
    }

    /** Turn the app lock on or off. The owner has just confirmed it at the prompt. */
    suspend fun setAppLock(enabled: Boolean) = mutex.withLock {
        val current = held ?: if (_state.value is SessionState.SignedIn) stored() else null
        vault.setLockEnabled(enabled, current)
    }

    /** True once, after a locked sign-in was erased because the screen lock it depended on went away. */
    fun takeLockLoss(): Boolean = vault.takeLockLoss()

    /** WOLF left the screen. From here, [lockAfter] of this puts the session away. */
    fun wentToBackground(at: Instant = clock()) {
        backgroundSince = at
    }

    /** WOLF is back on screen: lock first if it was away for long enough. */
    suspend fun cameToForeground(at: Instant = clock()) {
        val since = backgroundSince
        backgroundSince = null
        if (since != null && lockDue(since, at)) lock()
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

    /**
     * Run a call with a valid access token, and no retry.
     *
     * For calls where a 401 does not mean "the token expired": re-entering a password answers a wrong
     * password with 401, and retrying it would count one mistake twice against the account's lockout.
     * The token is refreshed before the call if it is near expiry, so a 401 here is the call's answer.
     */
    suspend fun <T> withAccessToken(call: suspend (bearer: String) -> T): T = call(token(rejected = null))

    /** Replace the access token with one from a password re-entry, which carries a fresh auth time. */
    suspend fun adoptAccessToken(token: String, expiresAt: String) = mutex.withLock {
        access = AccessToken(token, Instant.parse(expiresAt))
    }

    suspend fun signOut() = mutex.withLock {
        val credentials = try {
            stored()
        } catch (_: VaultLockedException) {
            null
        }
        if (credentials != null) {
            // Best effort: a phone that cannot reach the server still forgets its credentials.
            runCatching { api.logout(LogoutRequest(credentials.refreshToken)) }
        }
        forget()
    }

    private suspend fun token(rejected: String?): String = mutex.withLock {
        // Work done while WOLF sits in the background — a wake-up, a token rotating — does not outlast the lock.
        backgroundSince?.let { since ->
            if (_state.value is SessionState.SignedIn && lockDue(since, clock())) locked()
        }

        val current = access
        val fresh = current != null && current.expiresAt.isAfter(clock().plusSeconds(EXPIRY_MARGIN_SECONDS))

        // Another caller already refreshed while this one waited: use theirs rather than rotating again.
        if (current != null && fresh && current.token != rejected) return@withLock current.token

        refreshLocked()
    }

    private suspend fun resume(credentials: StoredCredentials): Boolean = try {
        refreshLocked()
        true
    } catch (error: WolfApiException) {
        // Offline at launch, or a clock the server calls wrong, with credentials that may well still be good: stay
        // signed in, and let the first call report the problem.
        if (error.httpStatus == 0 || error.problem.code == "auth.device_clock") {
            _state.value = SessionState.SignedIn(credentials.deviceId)
            true
        } else {
            false
        }
    }

    private suspend fun refreshLocked(): String {
        val credentials = try {
            stored()
        } catch (_: VaultLockedException) {
            locked()
            throw lockedProblem()
        } ?: run {
            forget()
            throw notSignedIn()
        }

        val grant = try {
            api.refresh(
                RefreshRequest(
                    credentials.refreshToken,
                    credentials.deviceId,
                    RefreshProof.create(identity, credentials.deviceId, credentials.refreshToken, clock()),
                ),
            )
        } catch (error: WolfApiException) {
            if (error.httpStatus == 401) forget()
            throw error
        }

        return adopt(grant)
    }

    /** Held credentials, or the vault's. Throws [VaultLockedException] when the vault is sealed and nothing is held. */
    private fun stored(): StoredCredentials? = held ?: vault.read()?.also { held = it }

    private fun adopt(grant: TokenGrant): String {
        val credentials = StoredCredentials(grant.refreshToken, grant.device.id)
        // A locked vault seals with its public key, so a rotated token is written even while the lock key is shut.
        vault.write(credentials)
        held = credentials
        access = AccessToken(grant.accessToken, Instant.parse(grant.accessTokenExpiresAt))
        _state.value = SessionState.SignedIn(grant.device.id)
        return grant.accessToken
    }

    private fun lockDue(since: Instant, now: Instant): Boolean =
        vault.lockEnabled && Duration.between(since, now) >= lockAfter

    private fun locked() {
        access = null
        held = null
        _state.value = SessionState.Locked
    }

    private fun forget() {
        access = null
        held = null
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

    private fun lockedProblem() = WolfApiException(
        WolfProblem(
            code = "auth.locked",
            problem = "WOLF is locked.",
            cause = "The app lock is on, and WOLF has not been unlocked since it was put away.",
            currentState = "Your sign-in is still on this phone, sealed. Nothing was sent.",
            recommendedAction = "Open WOLF and unlock it with your fingerprint or screen lock.",
            referenceId = "WOLF-AUTH-LOCKED",
        ),
        // Never a server's answer: it is not a 401, so nothing refreshes or retries on it.
        httpStatus = 423,
    )

    companion object {
        /** Refresh a little before expiry, so a request is not sent with a token that dies in flight. */
        private const val EXPIRY_MARGIN_SECONDS = 30L

        /** How long WOLF may sit in the background with the app lock on before it locks. */
        const val LOCK_AFTER_MINUTES = 5L
    }
}
