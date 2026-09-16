package app.amizhthan.wolf.api

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
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

    /** ICE servers for a stream, minted for a session that holds `screen`. TURN credentials expire on their own. */
    suspend fun iceServers(pcId: String, sessionToken: String): IceServersResponse =
        send<Unit, IceServersResponse>("GET", listOf("pcs", pcId, "ice-servers"), sessionToken, null, null, IceServersResponse.serializer())

    suspend fun me(bearer: String): MeView =
        send<Unit, MeView>("GET", listOf("users", "me"), bearer, null, null, MeView.serializer())

    suspend fun listPcs(bearer: String): PcList =
        send<Unit, PcList>("GET", listOf("pcs"), bearer, null, null, PcList.serializer())

    suspend fun latestTelemetry(pcId: String, bearer: String): LatestTelemetry =
        send<Unit, LatestTelemetry>("GET", listOf("pcs", pcId, "telemetry", "latest"), bearer, null, null, LatestTelemetry.serializer())

    suspend fun pushStatus(bearer: String): PushStatusView =
        send<Unit, PushStatusView>("GET", listOf("push"), bearer, null, null, PushStatusView.serializer())

    /** Registers the token for the device the access token belongs to, and no other. */
    suspend fun registerPushToken(token: String, bearer: String) {
        send<PushTokenRequest, Unit>("PUT", listOf("push", "token"), bearer, PushTokenRequest(token = token), PushTokenRequest.serializer(), null)
    }

    suspend fun clearPushToken(bearer: String) {
        send<Unit, Unit>("DELETE", listOf("push", "token"), bearer, null, null, null)
    }

    suspend fun listAlertRules(bearer: String): AlertRuleList =
        send<Unit, AlertRuleList>("GET", listOf("alert-rules"), bearer, null, null, AlertRuleList.serializer())

    suspend fun createAlertRule(input: AlertRuleInput, bearer: String): AlertRuleResponse =
        send("POST", listOf("alert-rules"), bearer, input, AlertRuleInput.serializer(), AlertRuleResponse.serializer())

    suspend fun setAlertRuleEnabled(ruleId: String, enabled: Boolean, bearer: String): AlertRuleResponse =
        send("PATCH", listOf("alert-rules", ruleId), bearer, AlertRulePatch(enabled), AlertRulePatch.serializer(), AlertRuleResponse.serializer())

    suspend fun deleteAlertRule(ruleId: String, bearer: String) {
        send<Unit, Unit>("DELETE", listOf("alert-rules", ruleId), bearer, null, null, null)
    }

    suspend fun listWebhooks(bearer: String): WebhookList =
        send<Unit, WebhookList>("GET", listOf("webhooks"), bearer, null, null, WebhookList.serializer())

    /** Needs a recently entered password; the server says so with `command.reauth_required`. */
    suspend fun createWebhook(input: WebhookInput, bearer: String): CreatedWebhook =
        send("POST", listOf("webhooks"), bearer, CreateWebhookRequest(input), CreateWebhookRequest.serializer(), CreatedWebhook.serializer())

    suspend fun updateWebhook(webhookId: String, patch: WebhookPatch, bearer: String) {
        send<WebhookPatch, Unit>("PATCH", listOf("webhooks", webhookId), bearer, patch, WebhookPatch.serializer(), null)
    }

    suspend fun rotateWebhookSecret(webhookId: String, bearer: String): WebhookSecret =
        send<Unit, WebhookSecret>("POST", listOf("webhooks", webhookId, "rotate-secret"), bearer, null, null, WebhookSecret.serializer())

    suspend fun testWebhook(webhookId: String, bearer: String): WebhookTestResult =
        send<Unit, WebhookTestResult>("POST", listOf("webhooks", webhookId, "test"), bearer, null, null, WebhookTestResult.serializer())

    suspend fun deleteWebhook(webhookId: String, bearer: String) {
        send<Unit, Unit>("DELETE", listOf("webhooks", webhookId), bearer, null, null, null)
    }

    suspend fun listNotifications(bearer: String): NotificationList =
        send<Unit, NotificationList>("GET", listOf("notifications"), bearer, null, null, NotificationList.serializer())

    suspend fun markNotificationRead(notificationId: String, bearer: String) {
        send<Unit, Unit>("POST", listOf("notifications", notificationId, "read"), bearer, null, null, null)
    }

    suspend fun markAllNotificationsRead(bearer: String): MarkedRead =
        send<Unit, MarkedRead>("POST", listOf("notifications", "read-all"), bearer, null, null, MarkedRead.serializer())

    suspend fun listAutomations(bearer: String): AutomationList =
        send<Unit, AutomationList>("GET", listOf("automations"), bearer, null, null, AutomationList.serializer())

    /** Saving is where an automation's authority comes from, so it carries the confirmed level the server named. */
    suspend fun createAutomation(definition: JsonObject, confirmedRiskLevel: String?, bearer: String): AutomationResponse =
        send(
            "POST",
            listOf("automations"),
            bearer,
            SaveAutomationRequest(definition, confirmedRiskLevel),
            SaveAutomationRequest.serializer(),
            AutomationResponse.serializer(),
        )

    /** A partial update. Turning one off needs no authority; turning one on, or widening it, does. */
    suspend fun updateAutomation(automationId: String, patch: JsonObject, confirmedRiskLevel: String?, bearer: String): AutomationResponse =
        send(
            "PATCH",
            listOf("automations", automationId),
            bearer,
            SaveAutomationRequest(patch, confirmedRiskLevel),
            SaveAutomationRequest.serializer(),
            AutomationResponse.serializer(),
        )

    suspend fun deleteAutomation(automationId: String, bearer: String) {
        send<Unit, Unit>("DELETE", listOf("automations", automationId), bearer, null, null, null)
    }

    /** Runs on the authority it was saved with, on its listed PCs. Accepted, not finished: see [automationRuns]. */
    suspend fun runAutomation(automationId: String, bearer: String): RunAccepted =
        send<Unit, RunAccepted>("POST", listOf("automations", automationId, "run"), bearer, null, null, RunAccepted.serializer())

    /**
     * The backup as the server built it, kept as JSON rather than modelled, so the file holds exactly what
     * the server's checksum covers. The cloud keeps no copy.
     */
    suspend fun configurationBackup(bearer: String): JsonObject =
        send<Unit, JsonObject>("GET", listOf("configuration", "backup"), bearer, null, null, JsonObject.serializer())

    suspend fun previewRestore(request: RestoreRequest, bearer: String): RestorePlanResponse =
        send("POST", listOf("configuration", "restore", "preview"), bearer, request, RestoreRequest.serializer(), RestorePlanResponse.serializer())

    /** Always at least medium risk, so the first attempt is refused for a confirmation: see [app.amizhthan.wolf.session.AccountAuthority]. */
    suspend fun restoreConfiguration(request: RestoreRequest, bearer: String): RestoreResult =
        send("POST", listOf("configuration", "restore"), bearer, request, RestoreRequest.serializer(), RestoreResult.serializer())

    suspend fun automationRuns(automationId: String, bearer: String): AutomationRunList =
        send<Unit, AutomationRunList>("GET", listOf("automations", automationId, "runs"), bearer, null, null, AutomationRunList.serializer())

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
