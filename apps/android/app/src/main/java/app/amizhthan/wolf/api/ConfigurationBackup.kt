package app.amizhthan.wolf.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Configuration backup and restore, mirroring `packages/protocol/src/configuration.ts` and
 * `services/api/src/routes/configuration.ts`.
 */

@Serializable
data class RestoreRequest(
    /** The file exactly as read. Never re-modelled: the server verifies its checksum and every item in it. */
    val backup: JsonObject,
    val sections: List<String>,
    val enableAutomations: Boolean = false,
    /** Only ever the level the server named. Absent until the server has asked for one. */
    val confirmedRiskLevel: String? = null,
)

@Serializable
data class RestoreSectionCounts(val created: Int = 0, val updated: Int = 0, val deleted: Int = 0, val skipped: Int = 0)

@Serializable
data class RestoreWarning(val code: String, val section: String, val id: String, val message: String)

@Serializable
data class RestorePlan(
    val sections: Map<String, RestoreSectionCounts> = emptyMap(),
    val warnings: List<RestoreWarning> = emptyList(),
    val automationsEnabled: Int = 0,
    val riskLevel: String,
)

@Serializable
data class RestorePlanResponse(val plan: RestorePlan)

@Serializable
data class RestoreResult(val plan: RestorePlan, val restoredAt: String)

/** A file the owner chose that is not something to send to a restore. Nothing was sent. */
class BackupFileException(val problem: WolfProblem) : Exception(problem.problem)

/**
 * The backup file on the phone.
 *
 * The phone checks only what it can tell without trusting itself: that the file is small enough to
 * send, is JSON, and says it is a WOLF backup. The checksum, the format version and every item are
 * verified by the server, which is the check that counts — a doctored file that passes here is refused
 * there, and one refused here would have been refused there too.
 */
object ConfigurationBackups {
    const val FORMAT = "wolf.configuration"

    /** The API accepts a restore body of 4 MiB; the file has to fit inside the request around it. */
    const val MAX_FILE_BYTES = 4 * 1024 * 1024 - 16 * 1024

    data class Section(val id: String, val label: String, val note: String)

    /** The web dashboard's sections, words and order. */
    val SECTIONS = listOf(
        Section("pcs", "PC names and tags", "Applied to PCs still enrolled. PCs themselves cannot be restored from a file."),
        Section("remoteDesktopProfiles", "Remote desktop profiles", "Replaces your saved profiles."),
        Section("alertRules", "Alert rules", "Replaces your alert rules."),
        Section("automations", "Automations", "Replaces your automations. They come back turned off unless you choose otherwise."),
    )

    private val pretty = Json { prettyPrint = true }
    private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    fun fileName(backup: JsonObject): String {
        val date = (backup["createdAt"] as? JsonPrimitive)?.contentOrNull?.take(10)
        return if (date != null && DATE.matches(date)) "wolf-configuration-$date.json" else "wolf-configuration.json"
    }

    /** The file's text: the server's JSON, indented. Every value is written back exactly as it was received. */
    fun text(backup: JsonObject): String = pretty.encodeToString(JsonElement.serializer(), backup)

    fun parse(bytes: ByteArray): JsonObject {
        if (bytes.size > MAX_FILE_BYTES) {
            throw refusal("configuration.file_too_large", "That file is too large to restore.", "A restore accepts a file of at most ${MAX_FILE_BYTES / 1024} KB.")
        }

        // An editor that saved the file may have added a byte-order mark; that is not damage.
        val text = bytes.toString(Charsets.UTF_8).removePrefix("﻿")
        val element = try {
            WolfJson.parseToJsonElement(text)
        } catch (_: SerializationException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }

        val backup = element as? JsonObject
            ?: throw refusal("configuration.unreadable", "That file could not be read as a backup.", "It is not a JSON object.")
        if ((backup["format"] as? JsonPrimitive)?.contentOrNull != FORMAT || backup["content"] !is JsonObject) {
            throw refusal("configuration.not_a_backup", "That file is not a WOLF configuration backup.", "It does not have the format of a backup made by WOLF.")
        }
        return backup
    }

    /** What the file holds, counted — never its names, which are the owner's and shown only in WOLF. */
    fun summary(backup: JsonObject): String {
        val content = backup["content"] as? JsonObject
        val counts = listOf("pcs" to "PC", "remoteDesktopProfiles" to "profile", "alertRules" to "alert rule", "automations" to "automation")
            .mapNotNull { (key, noun) -> (content?.get(key) as? JsonArray)?.size?.let { "$it $noun${if (it == 1) "" else "s"}" } }
        val made = (backup["createdAt"] as? JsonPrimitive)?.contentOrNull?.take(10)?.takeIf { DATE.matches(it) }
        return (counts + listOfNotNull(made?.let { "made $it" })).joinToString(" · ")
    }

    /** Sections stay in the web dashboard's order whatever order they are chosen in. */
    fun toggle(sections: List<String>, id: String, on: Boolean): List<String> {
        val chosen = if (on) sections + id else sections - id
        return SECTIONS.map { it.id }.filter { it in chosen }
    }

    fun describe(plan: RestorePlan): List<String> =
        SECTIONS.mapNotNull { section ->
            plan.sections[section.id]?.let { "${section.label}: ${it.created} created, ${it.updated} updated, ${it.deleted} deleted, ${it.skipped} skipped" }
        } + (
            if (plan.automationsEnabled > 0) {
                "${plan.automationsEnabled} restored automation(s) will be on. Confirmed at ${plan.riskLevel} risk."
            } else {
                "Restored automations will be off. Confirmed at ${plan.riskLevel} risk."
            }
            )

    fun restoreDescription(plan: RestorePlan, enableAutomations: Boolean): String =
        if (enableAutomations && plan.automationsEnabled > 0) {
            "This replaces the chosen configuration and turns on ${plan.automationsEnabled} automation(s), which will then act on their own."
        } else {
            "This replaces the chosen configuration with the backup's."
        }

    private fun refusal(code: String, problem: String, cause: String) = BackupFileException(
        WolfProblem(
            code = code,
            problem = problem,
            cause = cause,
            currentState = "Nothing was changed.",
            recommendedAction = "Choose a backup file saved from WOLF, unchanged.",
            referenceId = "WOLF-CFG-FILE",
        ),
    )
}
