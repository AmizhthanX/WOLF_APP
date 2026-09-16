package app.amizhthan.wolf.api

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import java.util.Locale

/** A metric a rule or condition can watch, in the words the web dashboard's charts use. */
data class WatchedMetric(val id: String, val label: String, val unit: String, val perDevice: String? = null)

private fun JsonObject.text(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

private fun JsonObject.strings(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }.orEmpty()

/** 90.0 as "90", 99.5 as "99.5": a threshold the owner typed, not a floating-point artefact. */
internal fun number(value: Double): String =
    if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()

/**
 * Alert rules as `packages/protocol/src/alerts.ts` defines them.
 *
 * The bounds are applied here as well as on the server so the owner is told what is wrong while typing,
 * not after a round trip — but the server's check is the one that counts, and nothing here relaxes it.
 */
object AlertRules {
    val CONDITIONS = listOf("metric-above", "metric-below", "pc-offline")
    val SEVERITIES = listOf("info", "warning", "critical")
    const val MAX_NAME = 120

    /** The metrics the web dashboard offers for rules: the ids the server's rollup computes, so a rule never judges a number no chart shows. */
    val METRICS = listOf(
        WatchedMetric("cpu.usage", "CPU usage", "%"),
        WatchedMetric("cpu.temperature", "CPU temperature", "°C"),
        WatchedMetric("memory.usedPercent", "Memory used", "%"),
        WatchedMetric("gpu.usage", "GPU usage", "%", perDevice = "Adapter id"),
        WatchedMetric("gpu.temperature", "GPU temperature", "°C", perDevice = "Adapter id"),
        WatchedMetric("disk.usedPercent", "Disk used", "%", perDevice = "Volume, e.g. C:"),
        WatchedMetric("disk.activeTime", "Disk active time", "%", perDevice = "Volume, e.g. C:"),
        WatchedMetric("network.receiveRate", "Network receive", "B/s", perDevice = "Adapter id"),
        WatchedMetric("network.sendRate", "Network send", "B/s", perDevice = "Adapter id"),
        WatchedMetric("battery.charge", "Battery charge", "%"),
    )

    fun rule(
        name: String,
        pcId: String?,
        condition: String,
        metric: String?,
        threshold: Double?,
        seriesKey: String?,
        forMinutes: Int,
        severity: String,
        cooldownMinutes: Int,
    ): AlertRuleInput {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "Give the rule a name." }
        require(trimmed.length <= MAX_NAME) { "A rule's name is at most $MAX_NAME characters." }
        require(condition in CONDITIONS) { "Unknown condition \"$condition\"." }
        require(severity in SEVERITIES) { "Unknown severity \"$severity\"." }
        require(forMinutes in 1..1440) { "How long it must hold is between 1 and 1440 minutes." }
        // The server's floor: a rule hovering at its threshold would otherwise notify every minute.
        require(cooldownMinutes in 5..10_080) { "The quiet period after notifying is between 5 minutes and 7 days." }

        if (condition == "pc-offline") {
            return AlertRuleInput(trimmed, pcId, condition, forMinutes = forMinutes, severity = severity, cooldownMinutes = cooldownMinutes)
        }

        val watched = requireNotNull(METRICS.firstOrNull { it.id == metric }) { "Choose a metric to watch." }
        require(threshold != null && threshold.isFinite()) { "A metric rule needs a threshold." }
        // A device only means something for a metric that has devices; "C:" on CPU usage would match nothing, silently.
        val series = seriesKey?.trim()?.takeIf { it.isNotEmpty() && watched.perDevice != null }
        require(series == null || series.length <= 128) { "A device name is at most 128 characters." }
        return AlertRuleInput(trimmed, pcId, condition, watched.id, series, threshold, forMinutes, severity, cooldownMinutes)
    }

    fun describe(rule: AlertRuleView, target: String): String {
        val quiet = "quiet ${rule.cooldownMinutes} min after notifying"
        if (rule.condition == "pc-offline") return "$target offline for ${rule.forMinutes} min · $quiet"

        val watched = METRICS.firstOrNull { it.id == rule.metric }
        val label = watched?.label ?: rule.metric ?: "A metric"
        val series = rule.seriesKey?.let { " ($it)" }.orEmpty()
        val direction = if (rule.condition == "metric-above") "above" else "below"
        val threshold = rule.threshold?.let { number(it) } ?: "?"
        return "$label$series on $target $direction $threshold${watched?.unit.orEmpty()} for ${rule.forMinutes} min · $quiet"
    }

    fun label(notification: NotificationView): String = when (notification.kind) {
        "resolved" -> "Resolved"
        "automation" -> "Automation · ${notification.severity}"
        "webhook" -> "Webhook · ${notification.severity}"
        else -> notification.severity.replaceFirstChar { it.titlecase(Locale.ROOT) }
    }
}

/**
 * Automations as `packages/protocol/src/automations.ts` defines them, built and described.
 *
 * Every payload the phone can save is built here, so the whole set is in one place and can be checked
 * against the protocol field by field. The phone builds notify and power actions; the other automatable
 * commands (services, scheduled tasks, startup items) are shown when they exist and built on the web.
 */
object Automations {
    val DAYS = listOf("mon", "tue", "wed", "thu", "fri", "sat", "sun")
    const val MAX_NAME = 120
    const val MAX_ACTIONS = 5
    const val MAX_CONDITIONS = 5
    const val MAX_TARGETS = 20

    private val CLOCK = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")

    /* Triggers */

    fun schedule(time: String, days: Collection<String>, timeZone: String): JsonObject = buildJsonObject {
        put("kind", "schedule")
        put("time", clock(time))
        putDays(days)
        put("timeZone", zone(timeZone))
    }

    /** A null rule: any of the owner's rules. */
    fun onAlert(ruleId: String?, on: String): JsonObject {
        require(on == "fired" || on == "resolved") { "An alert trigger runs when a rule fires or resolves." }
        return buildJsonObject {
            put("kind", "alert")
            put("ruleId", ruleId)
            put("on", on)
        }
    }

    fun manual(): JsonObject = buildJsonObject { put("kind", "manual") }

    /* Conditions */

    fun noActiveSession(): JsonObject = buildJsonObject { put("kind", "no-active-session") }

    fun timeWindow(start: String, end: String, days: Collection<String>, timeZone: String): JsonObject = buildJsonObject {
        put("kind", "time-window")
        put("start", clock(start))
        put("end", clock(end))
        putDays(days)
        put("timeZone", zone(timeZone))
    }

    /** The whole machine's CPU; a PC that is not reporting does not satisfy it. */
    fun cpuBelow(percent: Double): JsonObject {
        require(percent.isFinite() && percent > 0 && percent <= 100) { "The CPU level is between 1 and 100%." }
        return buildJsonObject {
            put("kind", "metric")
            put("metric", "cpu.usage")
            put("seriesKey", null as String?)
            put("comparison", "below")
            put("threshold", percent)
        }
    }

    /* Actions */

    fun notify(message: String, severity: String): JsonObject {
        val trimmed = message.trim()
        require(trimmed.isNotEmpty()) { "A notification needs a message." }
        require(trimmed.length <= 200) { "A notification is at most 200 characters." }
        require(severity in AlertRules.SEVERITIES) { "Unknown severity \"$severity\"." }
        return buildJsonObject {
            put("kind", "notify")
            put("severity", severity)
            put("message", trimmed)
        }
    }

    /** Never forced: a forced power action is critical risk, and critical actions can never be automated. */
    fun power(action: String, delaySeconds: Int): JsonObject = buildJsonObject {
        put("kind", "command")
        put("command", Commands.power(action, delaySeconds))
    }

    /** The display name is checked by the PC before it acts, so on a PC without that service the run fails and says so. */
    fun serviceControl(name: String, action: String, displayName: String): JsonObject = buildJsonObject {
        put("kind", "command")
        put("command", Commands.serviceControl(name, action, displayName))
    }

    fun taskControl(path: String, action: String, name: String): JsonObject = buildJsonObject {
        put("kind", "command")
        put("command", Commands.taskControl(path, action, name))
    }

    fun startupSetEnabled(name: String, scope: String, source: String, enabled: Boolean): JsonObject = buildJsonObject {
        put("kind", "command")
        put("command", Commands.startupSetEnabled(name, scope, source, enabled))
    }

    /* Targets */

    fun onPcs(pcIds: List<String>): JsonObject {
        require(pcIds.isNotEmpty()) { "Choose at least one PC." }
        require(pcIds.size <= MAX_TARGETS) { "An automation acts on at most $MAX_TARGETS PCs." }
        require(pcIds.toSet().size == pcIds.size) { "A PC is listed twice." }
        return buildJsonObject {
            put("mode", "pcs")
            putJsonArray("pcIds") { pcIds.forEach { add(it) } }
        }
    }

    /** The PC the triggering alert fired for. There is deliberately no "every PC". */
    fun alertPc(): JsonObject = buildJsonObject { put("mode", "alert-pc") }

    /* The automation */

    fun definition(
        name: String,
        trigger: JsonObject,
        conditions: List<JsonObject>,
        actions: List<JsonObject>,
        targets: JsonObject,
        cooldownMinutes: Int = 60,
        maxRunsPerDay: Int = 4,
        enabled: Boolean = true,
    ): JsonObject {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty()) { "Give the automation a name." }
        require(trimmed.length <= MAX_NAME) { "An automation's name is at most $MAX_NAME characters." }
        require(actions.isNotEmpty()) { "Add at least one action." }
        require(actions.size <= MAX_ACTIONS) { "An automation has at most $MAX_ACTIONS actions." }
        require(conditions.size <= MAX_CONDITIONS) { "An automation has at most $MAX_CONDITIONS conditions." }
        require(cooldownMinutes in 1..10_080) { "The wait between runs is between 1 minute and 7 days." }
        require(maxRunsPerDay in 1..96) { "Runs a day are between 1 and 96." }
        require(targets.text("mode") != "alert-pc" || trigger.text("kind") == "alert") {
            "\"The PC the alert fired for\" needs an alert trigger."
        }

        return buildJsonObject {
            put("name", trimmed)
            put("enabled", enabled)
            put("trigger", trigger)
            put("conditions", JsonArray(conditions))
            put("actions", JsonArray(actions))
            put("targets", targets)
            put("cooldownMinutes", cooldownMinutes)
            put("maxRunsPerDay", maxRunsPerDay)
        }
    }

    fun enabledPatch(enabled: Boolean): JsonObject = buildJsonObject { put("enabled", enabled) }

    /** A rename cannot widen what an automation does, so the server asks for no authority. */
    fun renamePatch(name: String): JsonObject {
        val trimmed = name.trim()
        require(trimmed.isNotEmpty() && trimmed.length <= MAX_NAME) { "A name of 1 to $MAX_NAME characters." }
        return buildJsonObject { put("name", trimmed) }
    }

    /** "Run now" needs PCs to run on; an automation aimed at "the PC the alert fired for" has none without an alert. */
    fun runsByHand(targets: JsonObject): Boolean = targets.text("mode") == "pcs"

    /* Descriptions, in the web dashboard's words */

    fun describeTrigger(trigger: JsonObject, ruleName: (String) -> String?): String = when (trigger.text("kind")) {
        "manual" -> "Only when run by hand"
        "schedule" -> {
            val days = trigger.strings("days")
            "At ${trigger.text("time")} on ${if (days.size == 7) "every day" else days.joinToString(", ")} (${trigger.text("timeZone")})"
        }
        "alert" -> {
            val rule = trigger.text("ruleId")?.let { ruleName(it) ?: "a deleted rule" } ?: "any alert rule"
            "When $rule ${if (trigger.text("on") == "resolved") "resolves" else "fires"}"
        }
        // A newer server's trigger: shown by name rather than dropped, so the list is still the truth.
        else -> "When ${trigger.text("kind") ?: "an unknown trigger"} (this app cannot show more)"
    }

    fun describeCondition(condition: JsonObject): String = when (condition.text("kind")) {
        "no-active-session" -> "nobody is connected"
        "time-window" -> "it is between ${condition.text("start")} and ${condition.text("end")}"
        "metric" -> {
            val watched = AlertRules.METRICS.firstOrNull { it.id == condition.text("metric") }
            val threshold = (condition["threshold"] as? JsonPrimitive)?.doubleOrNull?.let { number(it) } ?: "?"
            "${watched?.label ?: condition.text("metric")} is ${condition.text("comparison")} $threshold${watched?.unit.orEmpty()}"
        }
        else -> condition.text("kind") ?: "an unknown condition"
    }

    fun describeAction(action: JsonObject): String {
        if (action.text("kind") == "notify") return "notify \"${action.text("message")}\""
        val command = action["command"] as? JsonObject ?: return action.text("kind") ?: "an unknown action"
        val payload = command["payload"] as? JsonObject ?: JsonObject(emptyMap())
        return when (val type = command.text("type")) {
            "power.action" -> {
                val delay = (payload["delaySeconds"] as? JsonPrimitive)?.intOrNull ?: 0
                "${payload.text("action")} the PC" + if (delay > 0) " after $delay s" else ""
            }
            "service.control" -> "${payload.text("action")} service ${payload.text("name")}"
            "task.control" -> "${payload.text("action")} task ${payload.text("path")}"
            "startup.set-enabled" -> {
                val enable = (payload["enabled"] as? JsonPrimitive)?.booleanOrNull == true
                "${if (enable) "enable" else "disable"} startup item ${payload.text("name")}"
            }
            else -> type ?: "an unknown command"
        }
    }

    fun describeTargets(targets: JsonObject, pcName: (String) -> String): String = when (targets.text("mode")) {
        "pcs" -> targets.strings("pcIds").joinToString(", ") { pcName(it) }
        "alert-pc" -> "the PC the alert fired for"
        else -> targets.text("mode") ?: "unknown PCs"
    }

    /** Words for the stable reason codes the server records; a code this app does not know is shown as it is. */
    private val REASONS = mapOf(
        "cooldown" to "Cooling down since the last run",
        "daily-limit" to "Reached its runs-per-day limit",
        "condition-not-met" to "A condition was not met",
        "pc-offline" to "The PC was offline",
        "kill-switch" to "Remote access is switched off on the PC",
        "pc-unavailable" to "The PC is no longer enrolled",
        "unsupported-command" to "The PC does not support the action",
        "authority-revoked" to "The device that authorized it was revoked",
        "risk-escalated" to "Its actions now need more authorization than it has",
        "resource-held" to "Someone connected holds control of that on the PC",
        "stale-trigger" to "The alert was too long ago to act on",
    )

    fun describeReason(reason: String): String {
        val known = REASONS[reason.substringBefore(": ")] ?: return reason
        val rest = reason.substringAfter(": ", missingDelimiterValue = "")
        return if (rest.isEmpty()) known else "$known — $rest"
    }

    fun describeStep(step: AutomationStepView): String =
        "${step.commandType ?: step.kind}: ${step.status}" + (step.detail?.let { " ($it)" }.orEmpty())

    private fun clock(value: String): String {
        require(CLOCK.matches(value)) { "A time of day as HH:MM, 24-hour." }
        return value
    }

    private fun zone(value: String): String {
        require(value.isNotBlank() && value.length <= 64) { "A time zone, such as Europe/London." }
        return value
    }

    private fun JsonObjectBuilder.putDays(days: Collection<String>) {
        require(days.isNotEmpty()) { "Choose at least one day." }
        require(days.all { it in DAYS }) { "Days are mon to sun." }
        putJsonArray("days") { DAYS.filter { it in days }.forEach { add(it) } }
    }
}
