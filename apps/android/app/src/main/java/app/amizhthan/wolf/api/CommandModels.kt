package app.amizhthan.wolf.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

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
data class IceServerView(val urls: List<String>, val username: String? = null, val credential: String? = null)

@Serializable
data class IceConfigurationView(
    val iceServers: List<IceServerView> = emptyList(),
    val expiresAt: String,
    val iceTransportPolicy: String = "all",
)

@Serializable
data class IceServersResponse(
    val configuration: IceConfigurationView,
    val reachability: String? = null,
    val note: String? = null,
)

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

    /** The PC's displays, for choosing one to watch. Low risk and read-only, under `screen`. */
    fun listDisplays(refresh: Boolean = true): JsonObject = buildJsonObject {
        put("type", "remote-desktop.list-displays")
        putJsonObject("payload") { put("refresh", refresh) }
    }

    fun power(action: String, delaySeconds: Int = 0): JsonObject {
        require(action in POWER_ACTIONS) { "Unknown power action $action" }
        require(delaySeconds in 0..86_400) { "A power action's delay is between 0 seconds and a day." }
        return buildJsonObject {
            put("type", "power.action")
            putJsonObject("payload") {
                put("action", action)
                put("delaySeconds", delaySeconds)
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

    val SERVICE_ACTIONS = listOf("start", "stop", "restart")

    /** The start types that can be set. `boot` and `system` are readable and never settable. */
    val SERVICE_START_TYPES = listOf("automatic", "automatic-delayed", "manual", "disabled")
    val TASK_ACTIONS = listOf("enable", "disable", "run")
    val STARTUP_SCOPES = listOf("machine", "user")
    val STARTUP_SOURCES = listOf("run", "run-once", "startup-folder")

    /** What `sc` would take: no spaces, no path separators. */
    private val SERVICE_NAME = Regex("^[^\\\\/\\s]+$")

    /** Rooted and backslash-separated, the scheduler's own shape. */
    private val TASK_PATH = Regex("^\\\\(?:[^\\\\/:*?\"<>|]+\\\\?)*$")

    fun serviceList(): JsonObject = buildJsonObject {
        put("type", "service.list")
        putJsonObject("payload") {}
    }

    /** The display name travels with the name: the agent refuses if the service is not the one the list showed. */
    fun serviceControl(name: String, action: String, expectedDisplayName: String): JsonObject {
        requireServiceName(name)
        require(action in SERVICE_ACTIONS) { "Unknown service action $action" }
        requireExpected(expectedDisplayName)
        return buildJsonObject {
            put("type", "service.control")
            putJsonObject("payload") {
                put("name", name)
                put("action", action)
                put("expectedDisplayName", expectedDisplayName)
            }
        }
    }

    fun serviceSetStartType(name: String, startType: String, expectedDisplayName: String): JsonObject {
        requireServiceName(name)
        require(startType in SERVICE_START_TYPES) { "A service can be set to ${SERVICE_START_TYPES.joinToString()} only." }
        requireExpected(expectedDisplayName)
        return buildJsonObject {
            put("type", "service.set-start-type")
            putJsonObject("payload") {
                put("name", name)
                put("startType", startType)
                put("expectedDisplayName", expectedDisplayName)
            }
        }
    }

    fun taskList(): JsonObject = buildJsonObject {
        put("type", "task.list")
        putJsonObject("payload") {}
    }

    fun taskControl(path: String, action: String, expectedName: String): JsonObject {
        require(path.length in 1..1024 && TASK_PATH.matches(path)) { "A task path is rooted and backslash-separated." }
        // The path that is checked and the path that is opened must be the same string.
        require(path.split('\\').none { it == ".." }) { "A task path must not climb out of itself." }
        require(action in TASK_ACTIONS) { "Unknown task action $action" }
        requireExpected(expectedName)
        return buildJsonObject {
            put("type", "task.control")
            putJsonObject("payload") {
                put("path", path)
                put("action", action)
                put("expectedName", expectedName)
            }
        }
    }

    fun startupList(): JsonObject = buildJsonObject {
        put("type", "startup.list")
        putJsonObject("payload") {}
    }

    /** On or off, and nothing else: there is no field for what an entry runs, so none can be installed under a known name. */
    fun startupSetEnabled(name: String, scope: String, source: String, enabled: Boolean): JsonObject {
        requireExpected(name)
        require(scope in STARTUP_SCOPES) { "Unknown startup scope $scope" }
        require(source in STARTUP_SOURCES) { "Unknown startup source $source" }
        return buildJsonObject {
            put("type", "startup.set-enabled")
            putJsonObject("payload") {
                put("name", name)
                put("scope", scope)
                put("source", source)
                put("enabled", enabled)
            }
        }
    }

    private fun requireServiceName(name: String) =
        require(name.length in 1..256 && SERVICE_NAME.matches(name)) { "A service name has no spaces or path separators." }

    private fun requireExpected(value: String) =
        require(value.length in 1..512) { "The name the list showed is needed, so the PC can check it is the same one." }
}

@Serializable
data class ServiceRow(
    val name: String,
    val displayName: String,
    /** running, stopped, starting, stopping, paused: what Windows reports now. */
    val status: String = "unknown",
    val startType: String? = null,
    val account: String? = null,
    val imagePath: String? = null,
    /** Whether Windows itself says the service accepts a stop. */
    val canStop: Boolean = false,
    /** Which of WOLF's protections covers it, or null. Shown before anybody tries, not after a refusal. */
    val protectedBy: String? = null,
)

/**
 * A list, or an empty list with the reason WOLF could not ask. Every Windows machine has services and
 * tasks, so "none" and "could not read" are told apart by `helperAvailable`, never guessed.
 */
@Serializable
data class ServiceListResult(
    val services: List<ServiceRow> = emptyList(),
    val helperAvailable: Boolean = true,
    val unavailableReason: String? = null,
)

@Serializable
data class ServiceChangeResult(
    val name: String? = null,
    val displayName: String? = null,
    /** What Windows reports afterwards, never what was asked for. */
    val status: String = "unknown",
    val note: String? = null,
)

@Serializable
data class TaskRow(
    val path: String,
    val name: String,
    val enabled: Boolean,
    val state: String = "unknown",
    val lastRunAt: String? = null,
    val nextRunAt: String? = null,
    val lastResult: Int = 0,
    val author: String? = null,
    val account: String? = null,
    /** What it runs: the first thing anybody investigating a machine reads. */
    val actions: List<String> = emptyList(),
    val protectedBy: String? = null,
)

@Serializable
data class TaskListResult(
    val tasks: List<TaskRow> = emptyList(),
    val truncated: Boolean = false,
    val helperAvailable: Boolean = true,
    val unavailableReason: String? = null,
)

@Serializable
data class StartupRow(
    val name: String,
    val command: String? = null,
    val scope: String,
    val source: String,
    val user: String? = null,
    /** Whether Windows will run it, per the same approval flag Task Manager writes. */
    val enabled: Boolean,
    val protectedBy: String? = null,
)

@Serializable
data class StartupListResult(
    val entries: List<StartupRow> = emptyList(),
    val truncated: Boolean = false,
    val helperAvailable: Boolean = true,
    val unavailableReason: String? = null,
)

/** Words for services, scheduled tasks and startup items, in the web dashboard's terms. */
object PcTools {
    const val HELPER_MISSING =
        "The WOLF privileged helper is not running on that PC. Services, scheduled tasks and startup items are read " +
            "and changed through it, so that the process holding the network connection is not the one holding administrator rights."

    private val PROTECTIONS = mapOf(
        "wolf-service" to "WOLF's own service. Stopping it would end this session.",
        "wolf-task" to "WOLF's own scheduled work.",
        "wolf-startup" to "WOLF's own startup entry.",
        "system-critical" to "Windows needs this to keep working.",
        "network-critical" to "This is part of how the PC stays reachable.",
    )

    private val SOURCES = mapOf("run" to "Run key", "run-once" to "RunOnce key", "startup-folder" to "Startup folder")

    private val START_TYPES = mapOf(
        "automatic" to "Automatic",
        "automatic-delayed" to "Automatic (delayed)",
        "manual" to "Manual",
        "disabled" to "Disabled",
        "boot" to "Boot",
        "system" to "System",
    )

    /** A protection this app does not know is shown by its code rather than hidden. */
    fun protection(code: String): String = PROTECTIONS[code] ?: code

    fun source(code: String): String = SOURCES[code] ?: code

    fun startType(code: String?): String = code?.let { START_TYPES[it] ?: it } ?: "unknown"

    /** A scheduler time as a local date and time, or null when it is not a time at all. */
    fun localTime(value: String, zone: ZoneId = ZoneId.systemDefault()): String? {
        val instant = runCatching { OffsetDateTime.parse(value).toInstant() }.getOrNull()
            ?: runCatching { Instant.parse(value) }.getOrNull()
            ?: return null
        return DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm", Locale.getDefault()).withZone(zone).format(instant)
    }
}
