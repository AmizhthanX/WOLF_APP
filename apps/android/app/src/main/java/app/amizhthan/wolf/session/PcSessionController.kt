package app.amizhthan.wolf.session

import app.amizhthan.wolf.api.CommandView
import app.amizhthan.wolf.api.DispatchRequest
import app.amizhthan.wolf.api.SessionGrant
import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import java.time.Instant
import java.util.UUID

/** A command waiting for the owner's answer. */
data class PendingCommand(
    val command: JsonObject,
    val title: String,
    val description: String,
    /** The level the server named. Nothing on the phone guesses it. */
    val riskLevel: String,
    val idempotencyKey: String,
) {
    val requiresPassword: Boolean get() = riskLevel == "high" || riskLevel == "critical"
    val commandType: String get() = command["type"]?.jsonPrimitive?.contentOrNull ?: "command"
}

sealed interface CommandOutcome {
    data class Done(val command: CommandView) : CommandOutcome
    data class NeedsConfirmation(val pending: PendingCommand) : CommandOutcome
}

/**
 * A remote session on one PC, and sending commands through it.
 *
 * The escalation ladder is the web client's, rule for rule, because getting it wrong is how a
 * confirmation ends up authorizing more than it showed:
 *
 * 1. Send with no confirmation. Accepted means it was low risk.
 * 2. Refused for confirmation: the server names the risk level. That level — never a guess on the
 *    phone — is what the owner is asked about.
 * 3. Medium: an explicit yes. High: the password as well, after which the session token is re-issued
 *    so it carries the fresh sign-in time. Critical: both, plus a single-use privileged grant.
 * 4. The confirmed level is sent back with the same idempotency key. If the server now classifies the
 *    command higher, it asks again; the phone never climbs the ladder on its own.
 *
 * The session is opened the first time a command needs one, not when a PC is looked at: reading
 * metrics does not need a session, and every session is audited on the PC.
 */
class PcSessionController(
    private val pcId: String,
    private val api: WolfApi,
    private val session: SessionManager,
    private val capabilities: List<String> = DEFAULT_CAPABILITIES,
    private val newKey: () -> String = { UUID.randomUUID().toString() },
    private val clock: () -> Instant = Instant::now,
) {
    private val mutex = Mutex()
    private var grant: SessionGrant? = null
    private var token: String? = null
    private var tokenExpiresAt: Instant = Instant.EPOCH

    /** Send a command. Either it ran, or it needs the owner. */
    suspend fun run(command: JsonObject, title: String, description: String): CommandOutcome =
        attempt(PendingCommand(command, title, description, riskLevel = "low", idempotencyKey = newKey()), confirmed = null, grantId = null)

    /**
     * The owner said yes. Re-enter the password if the level needs it, obtain a grant if it is critical,
     * and send again at the level the server named.
     *
     * A wrong password throws, and nothing is sent.
     */
    suspend fun confirm(pending: PendingCommand, password: String?): CommandOutcome {
        if (pending.requiresPassword) {
            require(!password.isNullOrEmpty()) { "A password is required to confirm ${pending.riskLevel}-risk actions." }
            val access = session.withAccessToken { api.reauthenticate(password, it) }
            session.adoptAccessToken(access.accessToken, access.accessTokenExpiresAt)
            mutex.withLock { refreshTokenLocked() }
        }

        val grantId = if (pending.riskLevel == "critical") {
            sessionToken().let { api.requestPrivilegedGrant(pcId, pending.commandType, it).grant.id }
        } else {
            null
        }

        return attempt(pending, confirmed = pending.riskLevel, grantId = grantId)
    }

    /** End the session on the PC. Best effort: a phone that has lost its connection still forgets it. */
    suspend fun close() = mutex.withLock {
        val current = grant
        grant = null
        token = null
        if (current != null) {
            runCatching { session.authorized { api.endSession(pcId, current.session.id, it) } }
        }
    }

    private suspend fun attempt(pending: PendingCommand, confirmed: String?, grantId: String?): CommandOutcome {
        val request = DispatchRequest(pending.command, pending.idempotencyKey, confirmed, grantId)
        return try {
            CommandOutcome.Done(dispatch(request))
        } catch (error: WolfApiException) {
            if (error.problem.code !in ESCALATIONS) throw error

            val named = error.problem.context?.get("riskLevel")?.jsonPrimitive?.contentOrNull
            // A re-authentication refusal names no level: it is about the one already confirmed.
            val level = named ?: if (confirmed != null) pending.riskLevel else "high"
            CommandOutcome.NeedsConfirmation(pending.copy(riskLevel = level))
        }
    }

    private suspend fun dispatch(request: DispatchRequest): CommandView {
        val bearer = sessionToken()
        return try {
            api.dispatch(pcId, request, bearer).command
        } catch (error: WolfApiException) {
            if (error.httpStatus != 401) throw error
            // The session token lapsed or the session ended. Once, then the answer stands.
            mutex.withLock { refreshTokenLocked() }
            api.dispatch(pcId, request, sessionToken()).command
        }
    }

    /** The session token, opening or renewing the session as needed. Remote desktop authenticates its socket with it. */
    suspend fun sessionToken(): String = mutex.withLock {
        val current = token
        if (current != null && tokenExpiresAt.isAfter(clock().plusSeconds(30))) return@withLock current
        if (grant == null) openLocked() else refreshTokenLocked()
    }

    private suspend fun openLocked(): String {
        val opened = session.authorized { api.openSession(pcId, capabilities, it) }
        grant = opened
        token = opened.sessionToken
        tokenExpiresAt = Instant.parse(opened.sessionTokenExpiresAt)
        return opened.sessionToken
    }

    private suspend fun refreshTokenLocked(): String {
        val current = grant ?: return openLocked()
        return try {
            val refreshed = session.authorized { api.refreshSessionToken(pcId, current.session.id, it) }
            token = refreshed.sessionToken
            tokenExpiresAt = Instant.parse(refreshed.sessionTokenExpiresAt)
            refreshed.sessionToken
        } catch (error: WolfApiException) {
            // The session itself has ended or expired: start a new one rather than failing the command.
            if (error.httpStatus !in setOf(401, 403, 404)) throw error
            openLocked()
        }
    }

    companion object {
        /**
         * What the PC screen does, and nothing more: processes, power, services and scheduled tasks
         * (`services`), and startup items (`configuration`). Remote desktop opens its own session.
         */
        val DEFAULT_CAPABILITIES = listOf("processes", "power", "services", "configuration")

        val ESCALATIONS = setOf(
            "command.confirmation_required",
            "command.reauth_required",
            "command.privileged_grant_required",
        )
    }
}
