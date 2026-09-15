package app.amizhthan.wolf.session

import app.amizhthan.wolf.api.WolfApi
import app.amizhthan.wolf.api.WolfApiException
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/** A decision waiting for the owner: saving, or turning on, something WOLF will act on later. */
data class PendingAuthority(
    val title: String,
    val description: String,
    /** The level the server named. Nothing on the phone guesses it. */
    val riskLevel: String,
) {
    val requiresPassword: Boolean get() = riskLevel == "high" || riskLevel == "critical"
}

sealed interface Authorized<out T> {
    data class Done<T>(val value: T) : Authorized<T>
    data class NeedsConfirmation(val pending: PendingAuthority) : Authorized<Nothing>
}

/**
 * Authority for decisions that are saved rather than sent — an automation, which acts later with nobody
 * watching. The web client's `useAuthority`, rule for rule:
 *
 * 1. Save with no confirmation. Accepted means nothing in it needed one.
 * 2. Refused for confirmation: the server names the risk level, and that level is what the owner is
 *    asked about.
 * 3. High: the password is re-entered first, so the retry carries a fresh sign-in.
 * 4. Retried at exactly the named level. If the server names a higher one, the owner is asked again;
 *    the phone never climbs by itself.
 *
 * Critical actions can never be automated. The server refuses them outright, and that refusal reaches
 * the owner as a problem — never as a dialog that could be clicked through.
 *
 * There is no PC session and no privileged grant here: the account token carries the decision, and the
 * server records the authority against this device.
 */
class AccountAuthority(
    private val api: WolfApi,
    private val session: SessionManager,
) {
    suspend fun <T> attempt(
        title: String,
        description: String,
        save: suspend (bearer: String, confirmedRiskLevel: String?) -> T,
    ): Authorized<T> = tryOnce(PendingAuthority(title, description, riskLevel = "low"), confirmed = null, save)

    /**
     * The owner said yes. Re-enter the password if the level needs it, then save again at that level.
     * A wrong password throws, and nothing is saved.
     */
    suspend fun <T> confirm(
        pending: PendingAuthority,
        password: String?,
        save: suspend (bearer: String, confirmedRiskLevel: String?) -> T,
    ): Authorized<T> {
        if (pending.requiresPassword) {
            require(!password.isNullOrEmpty()) { "Your password is needed to authorize ${pending.riskLevel}-risk actions." }
            // No 401 retry: a wrong password answered with 401 would otherwise count twice against the lockout.
            val access = session.withAccessToken { api.reauthenticate(password, it) }
            session.adoptAccessToken(access.accessToken, access.accessTokenExpiresAt)
        }
        return tryOnce(pending, confirmed = pending.riskLevel, save)
    }

    private suspend fun <T> tryOnce(
        pending: PendingAuthority,
        confirmed: String?,
        save: suspend (bearer: String, confirmedRiskLevel: String?) -> T,
    ): Authorized<T> = try {
        Authorized.Done(session.authorized { save(it, confirmed) })
    } catch (error: WolfApiException) {
        if (error.problem.code !in ESCALATIONS) throw error

        val named = error.problem.context?.get("riskLevel")?.jsonPrimitive?.contentOrNull
        // A re-authentication refusal names no level, and always means a password.
        val level = named ?: confirmed?.takeIf { it == "high" || it == "critical" } ?: "high"
        Authorized.NeedsConfirmation(pending.copy(riskLevel = level))
    }

    companion object {
        val ESCALATIONS = setOf("command.confirmation_required", "command.reauth_required")
    }
}
