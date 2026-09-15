package app.amizhthan.wolf.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** Sessions and commands, mirroring `services/api/src/routes/pcs.ts` and `commands.ts`. */

@Serializable
data class SessionRequest(val mode: String = "control", val capabilities: List<String>)

@Serializable
data class SessionInfo(val id: String, val capabilities: List<String> = emptyList(), val expiresAt: String)

@Serializable
data class SessionGrant(val session: SessionInfo, val sessionToken: String, val sessionTokenExpiresAt: String)

@Serializable
data class SessionToken(val sessionToken: String, val sessionTokenExpiresAt: String)

@Serializable
data class DispatchRequest(
    val command: JsonObject,
    /** The same key for every attempt at one command, so a retried request cannot run it twice. */
    val idempotencyKey: String,
    /** Only ever the level the server named. Never sent before the server has asked for one. */
    val confirmedRiskLevel: String? = null,
    val privilegedGrantId: String? = null,
    val waitSeconds: Int = 8,
)

@Serializable
data class CommandFailure(val code: String, val message: String? = null, val limitation: Boolean = false)

@Serializable
data class CommandView(
    val id: String,
    val type: String,
    val riskLevel: String,
    val status: String,
    val failure: CommandFailure? = null,
    val result: JsonElement? = null,
)

@Serializable
data class DispatchResponse(val command: CommandView, val deduplicated: Boolean = false)

@Serializable
data class GrantRequest(val purpose: String, val expiresInSeconds: Int = 120)

@Serializable
data class GrantInfo(val id: String, val expiresAt: String)

@Serializable
data class GrantResponse(val grant: GrantInfo)

@Serializable
data class ProcessRow(
    val pid: Int,
    val name: String,
    val cpuPercent: Double? = null,
    val workingSetBytes: Double? = null,
    val gpuPercent: Double? = null,
    val status: String = "unknown",
    val protectedProcess: Boolean = false,
)

@Serializable
data class ProcessListResult(
    val processes: List<ProcessRow> = emptyList(),
    val truncated: Boolean = false,
    val totalCount: Int = 0,
)

/**
 * The typed commands this app sends. Built here rather than at call sites, so every payload the
 * phone can produce is in one place and matches `packages/protocol` field for field.
 */
object Commands {
    val POWER_ACTIONS = listOf("lock", "sign-out", "sleep", "hibernate", "restart", "shutdown")

    fun power(action: String): JsonObject {
        require(action in POWER_ACTIONS) { "Unknown power action $action" }
        return buildJsonObject {
            put("type", "power.action")
            putJsonObject("payload") {
                put("action", action)
                put("delaySeconds", 0)
                // Never forced from here: forcing is critical risk and closes the user's unsaved work.
                put("force", false)
            }
        }
    }

    fun processList(limit: Int = 400): JsonObject = buildJsonObject {
        put("type", "process.list")
        putJsonObject("payload") {
            put("limit", limit)
            put("includeIo", false)
        }
    }

    /** The name travels with the PID: the agent refuses if a recycled PID now belongs to something else. */
    fun terminate(pid: Int, expectedName: String): JsonObject = buildJsonObject {
        put("type", "process.terminate")
        putJsonObject("payload") {
            put("pid", pid)
            put("expectedName", expectedName)
            put("force", false)
            put("includeChildren", false)
        }
    }
}
