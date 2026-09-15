package app.amizhthan.wolf.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.serializer
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * The WOLF HTTP API.
 *
 * Stateless: it holds no token. Every authorized call is given its bearer by
 * [app.amizhthan.wolf.session.SessionManager], which owns the refresh-and-retry, so there is exactly
 * one place that decides what a 401 means.
 */
class WolfApi(
    private val baseUrl: HttpUrl,
    private val http: OkHttpClient,
) {
    suspend fun login(request: LoginRequest): TokenGrant =
        send("POST", listOf("auth", "login"), null, request, LoginRequest.serializer(), TokenGrant.serializer())

    suspend fun refresh(request: RefreshRequest): TokenGrant =
        send("POST", listOf("auth", "refresh"), null, request, RefreshRequest.serializer(), TokenGrant.serializer())

    suspend fun logout(request: LogoutRequest) {
        send<LogoutRequest, Unit>("POST", listOf("auth", "logout"), null, request, LogoutRequest.serializer(), null)
    }

    suspend fun reauthenticate(password: String, bearer: String): AccessGrant =
        send(
            "POST",
            listOf("auth", "reauthenticate"),
            bearer,
            ReauthenticateRequest(password),
            ReauthenticateRequest.serializer(),
            AccessGrant.serializer(),
        )

    /** Opened with the account token; the session token it returns is what commands are sent with. */
    suspend fun openSession(pcId: String, capabilities: List<String>, bearer: String): SessionGrant =
        send(
            "POST",
            listOf("pcs", pcId, "sessions"),
            bearer,
            SessionRequest(capabilities = capabilities),
            SessionRequest.serializer(),
            SessionGrant.serializer(),
        )

    /** Re-issued with the account token, so a fresh password re-entry is carried into the session token. */
    suspend fun refreshSessionToken(pcId: String, sessionId: String, bearer: String): SessionToken =
        send<Unit, SessionToken>("POST", listOf("pcs", pcId, "sessions", sessionId, "token"), bearer, null, null, SessionToken.serializer())

    suspend fun endSession(pcId: String, sessionId: String, bearer: String) {
        send<Unit, Unit>("DELETE", listOf("pcs", pcId, "sessions", sessionId), bearer, null, null, null)
    }

    suspend fun dispatch(pcId: String, request: DispatchRequest, sessionToken: String): DispatchResponse =
        send(
            "POST",
            listOf("pcs", pcId, "commands"),
            sessionToken,
            request,
            DispatchRequest.serializer(),
            DispatchResponse.serializer(),
        )

    /** Requested with the session token, within two minutes of a password re-entry. Single use. */
    suspend fun requestPrivilegedGrant(pcId: String, purpose: String, sessionToken: String): GrantResponse =
        send(
            "POST",
            listOf("pcs", pcId, "privileged-grants"),
            sessionToken,
            GrantRequest(purpose = purpose.take(120)),
            GrantRequest.serializer(),
            GrantResponse.serializer(),
        )

    suspend fun me(bearer: String): MeView =
        send<Unit, MeView>("GET", listOf("users", "me"), bearer, null, null, MeView.serializer())

    suspend fun listPcs(bearer: String): PcList =
        send<Unit, PcList>("GET", listOf("pcs"), bearer, null, null, PcList.serializer())

    suspend fun latestTelemetry(pcId: String, bearer: String): LatestTelemetry =
        send<Unit, LatestTelemetry>("GET", listOf("pcs", pcId, "telemetry", "latest"), bearer, null, null, LatestTelemetry.serializer())

    private suspend fun <B, R> send(
        method: String,
        segments: List<String>,
        bearer: String?,
        body: B?,
        bodySerializer: KSerializer<B>?,
        resultSerializer: KSerializer<R>?,
    ): R = withContext(Dispatchers.IO) {
        val url = baseUrl.newBuilder().addPathSegment("api").addPathSegment("v1").apply {
            // One segment at a time, so an id can never add a path of its own.
            segments.forEach { addPathSegment(it) }
        }.build()

        val requestBody = if (body != null && bodySerializer != null) {
            WolfJson.encodeToString(bodySerializer, body).toRequestBody(JSON)
        } else if (method == "POST") {
            "{}".toRequestBody(JSON)
        } else {
            null
        }

        val request = Request.Builder()
            .url(url)
            .method(method, requestBody)
            .header("Accept", "application/json")
            .apply { if (bearer != null) header("Authorization", "Bearer $bearer") }
            .build()

        val response = try {
            http.newCall(request).execute()
        } catch (error: IOException) {
            throw WolfApiException(
                WolfProblem(
                    code = "network.unreachable",
                    problem = "WOLF could not be reached.",
                    cause = error.message ?: "The connection failed.",
                    currentState = "Nothing was changed.",
                    recommendedAction = "Check the phone's connection and try again.",
                    referenceId = "WOLF-NET-UNREACHABLE",
                ),
                httpStatus = 0,
            )
        }

        response.use {
            val text = it.body?.string().orEmpty()

            if (!it.isSuccessful) {
                val problem = try {
                    WolfJson.decodeFromString(ErrorEnvelope.serializer(), text).error
                } catch (_: SerializationException) {
                    unexpected(it.code)
                } catch (_: IllegalArgumentException) {
                    unexpected(it.code)
                }
                throw WolfApiException(problem, it.code)
            }

            @Suppress("UNCHECKED_CAST")
            when {
                resultSerializer == null -> Unit as R
                resultSerializer == Unit.serializer() -> Unit as R
                else -> try {
                    WolfJson.decodeFromString(resultSerializer, text)
                } catch (error: SerializationException) {
                    throw WolfApiException(
                        WolfProblem(
                            code = "api.unexpected_response",
                            problem = "WOLF answered in a way this app does not understand.",
                            cause = error.message ?: "The response did not match what was expected.",
                            currentState = "The request may have been carried out.",
                            recommendedAction = "Update the app. If it is up to date, report this reference.",
                            referenceId = "WOLF-API-DECODE",
                        ),
                        it.code,
                    )
                }
            }
        }
    }

    private fun unexpected(status: Int) = WolfProblem(
        code = "http.$status",
        problem = "WOLF returned an error this app could not read.",
        cause = "HTTP $status with no WOLF error body.",
        currentState = "Unknown.",
        recommendedAction = "Try again. If it keeps happening, check that the app points at a WOLF server.",
        referenceId = "WOLF-NET-HTTP$status",
    )

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
