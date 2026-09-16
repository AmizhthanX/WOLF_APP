package app.amizhthan.wolf.api

import kotlinx.serialization.Serializable
import java.net.URI

/**
 * Webhooks, mirroring `packages/protocol/src/webhooks.ts` and `services/api/src/routes/webhooks.ts`.
 *
 * The phone sends a URL once, when a webhook is made, and is never given it back: the API shows the host. The
 * signing secret is shown once, when made or replaced, and held only in memory until the owner dismisses it.
 */

@Serializable
data class WebhookView(
    val id: String,
    val name: String,
    /** The host only. The URL itself is never returned. */
    val host: String,
    /** `wolf`, `slack` or `discord`. */
    val format: String = "wolf",
    val minSeverity: String,
    val enabled: Boolean,
    val disabledReason: String? = null,
    val consecutiveFailures: Int = 0,
    val lastDeliveryAt: String? = null,
    val lastOutcome: String? = null,
    val lastStatus: Int? = null,
    val createdAt: String,
)

@Serializable
data class WebhookList(val configured: Boolean, val webhooks: List<WebhookView> = emptyList(), val limit: Int = 10)

@Serializable
data class WebhookInput(val name: String, val url: String, val format: String, val minSeverity: String)

@Serializable
data class CreateWebhookRequest(val webhook: WebhookInput)

@Serializable
data class CreatedWebhook(val webhook: WebhookView, val secret: String)

@Serializable
data class WebhookPatch(val enabled: Boolean? = null, val minSeverity: String? = null)

@Serializable
data class WebhookSecret(val secret: String)

@Serializable
data class WebhookTestResult(val outcome: String, val status: Int? = null, val detail: String = "")

/** A signing secret on screen: shown once, for one webhook. Its `toString` never prints the secret. */
class ShownSecret(val webhookName: String, val secret: String) {
    override fun toString(): String = "ShownSecret($webhookName)"
}

object Webhooks {
    val SEVERITIES = listOf("info" to "Everything", "warning" to "Warnings and critical", "critical" to "Critical only")

    /** Slack and Discord accept only their own message shape; `wolf` is WOLF's JSON. */
    val FORMATS = listOf("slack" to "Slack", "discord" to "Discord", "wolf" to "WOLF JSON")

    /** Mirrors `suggestedWebhookFormat` in `packages/protocol`: a guess from the host. */
    fun suggestedFormat(url: String): String {
        val host = try {
            URI(url.trim()).host?.lowercase() ?: return "wolf"
        } catch (_: java.net.URISyntaxException) {
            return "wolf"
        }
        return when {
            host == "hooks.slack.com" -> "slack"
            host == "discord.com" || host == "discordapp.com" || host.endsWith(".discord.com") -> "discord"
            else -> "wolf"
        }
    }

    /**
     * What the phone checks before sending: https, a host, no user name or password, no fragment. Whether the
     * address is public is the server's to decide — it resolves the name — so the phone does not guess.
     */
    fun input(name: String, url: String, minSeverity: String, format: String = suggestedFormat(url)): WebhookInput {
        val trimmedName = name.trim()
        require(trimmedName.length in 1..80) { "A webhook's name is 1 to 80 characters." }
        require(minSeverity in SEVERITIES.map { it.first }) { "Unknown severity $minSeverity." }
        require(format in FORMATS.map { it.first }) { "Unknown format $format." }
        val trimmedUrl = url.trim()
        val parsed = try {
            URI(trimmedUrl)
        } catch (_: java.net.URISyntaxException) {
            throw IllegalArgumentException("That is not a web address.")
        }
        require(parsed.scheme.equals("https", ignoreCase = true)) { "A webhook must use https." }
        require(!parsed.host.isNullOrBlank()) { "A webhook address needs a host." }
        require(parsed.rawUserInfo == null) { "A webhook address cannot carry a user name or password." }
        require(parsed.rawFragment == null) { "A webhook address cannot have a #fragment." }
        require(trimmedUrl.length <= 2048) { "That address is too long." }
        return WebhookInput(trimmedName, trimmedUrl, format, minSeverity)
    }

    fun outcomeText(outcome: String, status: Int?): String = when (outcome) {
        "delivered" -> if (status != null) "Delivered ($status)" else "Delivered"
        "http-error" -> "The receiver answered ${status ?: "with an error"}"
        "redirect" -> "The receiver answered with a redirect${status?.let { " ($it)" }.orEmpty()}, which WOLF does not follow"
        "timeout" -> "No answer within five seconds"
        "network" -> "The connection failed"
        "address-refused" -> "The address now points somewhere private, so WOLF did not send to it"
        "tls" -> "The receiver's certificate could not be verified"
        else -> outcome
    }

    fun stateText(webhook: WebhookView): String = when {
        !webhook.enabled && webhook.disabledReason == "too-many-failures" -> "Turned off by WOLF after too many failed deliveries"
        !webhook.enabled -> "Off"
        webhook.lastOutcome == null -> "On · nothing sent yet"
        webhook.lastOutcome == "delivered" -> "On · last delivery succeeded"
        else -> "On · ${outcomeText(webhook.lastOutcome, webhook.lastStatus)}" +
            if (webhook.consecutiveFailures > 1) " · ${webhook.consecutiveFailures} failures in a row" else ""
    }
}
