package app.amizhthan.wolf.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Alert rules, the notification inbox and automations, mirroring `packages/protocol/src/alerts.ts`,
 * `automations.ts` and `services/api/src/routes/alerts.ts` and `automations.ts`.
 */

@Serializable
data class AlertRuleView(
    val id: String,
    /** Null: every PC on the account, including ones enrolled later. */
    val pcId: String? = null,
    val name: String,
    val condition: String,
    val metric: String? = null,
    /** One disk, adapter or GPU; null for every series of the metric, each judged on its own. */
    val seriesKey: String? = null,
    val threshold: Double? = null,
    val forMinutes: Int,
    val severity: String,
    val cooldownMinutes: Int,
    val enabled: Boolean,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class AlertRuleList(val rules: List<AlertRuleView>, val limit: Int)

@Serializable
data class AlertRuleResponse(val rule: AlertRuleView)

/** A new rule. Built through [AlertRules.rule], which applies the protocol's bounds before anything is sent. */
@Serializable
data class AlertRuleInput(
    val name: String,
    val pcId: String? = null,
    val condition: String,
    val metric: String? = null,
    val seriesKey: String? = null,
    val threshold: Double? = null,
    val forMinutes: Int,
    val severity: String,
    val cooldownMinutes: Int,
    val enabled: Boolean = true,
)

@Serializable
data class AlertRulePatch(val enabled: Boolean)

@Serializable
data class NotificationView(
    val id: String,
    /** Null once the rule is deleted; the notification outlives it on purpose. */
    val ruleId: String? = null,
    val automationId: String? = null,
    val pcId: String? = null,
    /** `fired`, `resolved` or `automation`. */
    val kind: String,
    val severity: String,
    val title: String,
    val detail: String = "",
    val metric: String? = null,
    val seriesKey: String? = null,
    val value: Double? = null,
    val threshold: Double? = null,
    val occurredAt: String,
    val readAt: String? = null,
)

@Serializable
data class NotificationList(val notifications: List<NotificationView>, val unreadCount: Int)

@Serializable
data class MarkedRead(val marked: Int)

@Serializable
data class AutomationView(
    val id: String,
    val name: String,
    val enabled: Boolean,
    /**
     * Kept as JSON rather than modelled class by class: the phone describes these and never re-sends
     * them, and a newer server's trigger or action kind is shown by name instead of failing the list.
     */
    val trigger: JsonObject,
    val conditions: List<JsonObject> = emptyList(),
    val actions: List<JsonObject>,
    val targets: JsonObject,
    val cooldownMinutes: Int,
    val maxRunsPerDay: Int,
    /** What the owner confirmed when saving. A run whose actions classify higher is refused by the server. */
    val authorizedRiskLevel: String,
    val authorizedAt: String,
    val lastRunAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class AutomationList(val automations: List<AutomationView>, val limit: Int)

@Serializable
data class AutomationResponse(val automation: AutomationView)

@Serializable
data class SaveAutomationRequest(
    val automation: JsonObject,
    /** Only ever the level the server named. Absent until the server has asked for one. */
    val confirmedRiskLevel: String? = null,
)

@Serializable
data class RunAccepted(val accepted: Boolean, val pcIds: List<String> = emptyList())

@Serializable
data class AutomationStepView(
    val index: Int,
    val kind: String,
    val status: String,
    val commandId: String? = null,
    val commandType: String? = null,
    /** An error code or a short fixed description. Never a command's result. */
    val detail: String? = null,
)

@Serializable
data class AutomationRunView(
    val id: String,
    val automationId: String,
    val pcId: String? = null,
    val triggerKind: String,
    val status: String,
    val reason: String? = null,
    val steps: List<AutomationStepView> = emptyList(),
    val startedAt: String,
    val finishedAt: String? = null,
)

@Serializable
data class AutomationRunList(val runs: List<AutomationRunView>)
