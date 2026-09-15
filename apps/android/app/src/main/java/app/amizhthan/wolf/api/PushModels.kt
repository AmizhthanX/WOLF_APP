package app.amizhthan.wolf.api

import kotlinx.serialization.Serializable

/** Push registration, mirroring `packages/protocol/src/push.ts` and `services/api/src/routes/push.ts`. */

@Serializable
data class PushStatusView(
    /** Whether the WOLF server has a push service configured at all. */
    val configured: Boolean,
    val provider: String? = null,
    /** Whether this device has a token registered. */
    val registered: Boolean,
)

@Serializable
data class PushTokenRequest(val provider: String = "fcm", val token: String)
