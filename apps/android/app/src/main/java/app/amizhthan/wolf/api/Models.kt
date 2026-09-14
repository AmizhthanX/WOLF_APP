package app.amizhthan.wolf.api

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * The WOLF API's shapes, as this client uses them.
 *
 * Mirrors `services/api` and `apps/web/lib/wolf.ts`. Unknown fields are ignored so a newer API does
 * not break an older app; missing optional fields stay null rather than becoming zeros, because
 * "the PC could not read this" is a real answer and a zero would be a false one.
 */
val WolfJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** Every failure the API returns: what went wrong, why, what state things are in, and what to do. */
@Serializable
data class WolfProblem(
    val code: String,
    val problem: String,
    val cause: String = "",
    val currentState: String = "",
    val recommendedAction: String = "",
    val referenceId: String = "",
    val context: JsonObject? = null,
)

@Serializable
internal data class ErrorEnvelope(val error: WolfProblem)

class WolfApiException(val problem: WolfProblem, val httpStatus: Int) :
    Exception("${problem.problem} (${problem.code})")

@Serializable
data class DeviceDescriptor(
    /** The device id from a previous sign-in, so the same phone stays one device in the list. */
    val id: String? = null,
    val kind: String = "android",
    val name: String,
    val platform: String? = null,
    /** Base64url SPKI of the Keystore P-256 identity key. The private key never leaves the phone. */
    val publicKey: String? = null,
)

@Serializable
data class LoginRequest(val email: String, val password: String, val device: DeviceDescriptor)

@Serializable
data class RefreshRequest(val refreshToken: String, val deviceId: String)

@Serializable
data class LogoutRequest(val refreshToken: String)

@Serializable
data class ReauthenticateRequest(val password: String)

@Serializable
data class DeviceView(val id: String, val name: String, val kind: String)

@Serializable
data class TokenGrant(
    val accessToken: String,
    val accessTokenExpiresAt: String,
    val refreshToken: String,
    val refreshTokenExpiresAt: String,
    val device: DeviceView,
)

@Serializable
data class AccessGrant(val accessToken: String, val accessTokenExpiresAt: String)

/** `GET /users/me`: who the token belongs to, as far as this app needs to know. */
@Serializable
data class MeView(val device: DeviceView? = null)

@Serializable
data class PcSummary(
    val id: String,
    val name: String,
    val hostname: String? = null,
    val status: String,
    val registrationState: String,
    val lastSeenAt: String? = null,
    val windowsSessionState: String = "unknown",
    val remoteAccessEnabled: Boolean = true,
    val tags: List<String> = emptyList(),
    val favorite: Boolean = false,
    val activeSessionCount: Int = 0,
    val pendingCommandCount: Int = 0,
)

@Serializable
data class PcList(val pcs: List<PcSummary>)

@Serializable
data class CpuSample(val usagePercent: Double? = null, val temperatureCelsius: Double? = null)

@Serializable
data class MemorySample(val totalBytes: Double? = null, val usedBytes: Double? = null)

@Serializable
data class GpuSample(
    val adapterId: String,
    val name: String,
    val usagePercent: Double? = null,
    val vramTotalBytes: Double? = null,
    val vramUsedBytes: Double? = null,
    val temperatureCelsius: Double? = null,
)

@Serializable
data class DiskSample(
    val volume: String,
    val totalBytes: Double? = null,
    val freeBytes: Double? = null,
    val healthStatus: String = "unknown",
)

@Serializable
data class TelemetrySample(
    val sampledAt: String,
    val uptimeSeconds: Double? = null,
    val cpu: CpuSample = CpuSample(),
    val memory: MemorySample = MemorySample(),
    val gpus: List<GpuSample> = emptyList(),
    val disks: List<DiskSample> = emptyList(),
)

@Serializable
data class LatestTelemetry(
    val sample: TelemetrySample? = null,
    val sampledAt: String? = null,
    val pcStatus: String = "offline",
)
