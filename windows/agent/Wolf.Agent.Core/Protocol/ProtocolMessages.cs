using System.Text.Json;
using System.Text.Json.Serialization;

namespace Wolf.Agent.Core.Protocol;

/// <summary>
/// Wire contract with the WOLF cloud. These types mirror <c>@wolf/protocol</c>; the shared
/// package is the source of truth, and any change there has to be reflected here. The
/// cloud validates every message against its schema, so a mismatch fails loudly at the
/// boundary rather than being silently accepted.
/// </summary>
public static class WolfProtocol
{
    public const int Version = 1;

    /// <summary>Exact string an agent signs to prove PC identity during the handshake.</summary>
    public static string ChallengeSigningPayload(string pcId, string nonce) =>
        $"wolf-agent-auth v{Version} {pcId} {nonce}";

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };
}

// ---------------------------------------------------------------------------
// Agent -> cloud
// ---------------------------------------------------------------------------

public sealed record AgentAuthMessage(
    [property: JsonPropertyName("pcId")] string PcId,
    [property: JsonPropertyName("agentVersion")] string AgentVersion,
    [property: JsonPropertyName("signature")] string Signature,
    [property: JsonPropertyName("nonce")] string Nonce)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "agent.auth";

    [JsonPropertyName("protocolVersion")]
    public int ProtocolVersion { get; init; } = WolfProtocol.Version;
}

public sealed record AgentHelloMessage(
    [property: JsonPropertyName("info")] SystemInfoResult Info,
    [property: JsonPropertyName("capabilities")] SystemCapabilitiesResult Capabilities,
    [property: JsonPropertyName("sessionState")] string SessionState,
    [property: JsonPropertyName("localKillSwitchEngaged")] bool LocalKillSwitchEngaged,
    [property: JsonPropertyName("queuedResultCount")] int QueuedResultCount)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "agent.hello";

    [JsonPropertyName("protocolVersion")]
    public int ProtocolVersion { get; init; } = WolfProtocol.Version;
}

public sealed record AgentHeartbeatMessage(
    [property: JsonPropertyName("at")] string At,
    [property: JsonPropertyName("sessionState")] string SessionState,
    [property: JsonPropertyName("localKillSwitchEngaged")] bool LocalKillSwitchEngaged,
    [property: JsonPropertyName("activeSessionCount")] int ActiveSessionCount)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "agent.heartbeat";

    [JsonPropertyName("protocolVersion")]
    public int ProtocolVersion { get; init; } = WolfProtocol.Version;
}

public sealed record TelemetryBatchPayload(
    [property: JsonPropertyName("samples")] IReadOnlyList<JsonElement> Samples,
    [property: JsonPropertyName("backfill")] bool Backfill);

public sealed record AgentTelemetryMessage(
    [property: JsonPropertyName("batch")] TelemetryBatchPayload Batch)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "agent.telemetry";

    [JsonPropertyName("protocolVersion")]
    public int ProtocolVersion { get; init; } = WolfProtocol.Version;
}

public sealed record CommandFailurePayload(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message,
    /// <summary>True when Windows itself prevents the operation, rather than WOLF failing.</summary>
    [property: JsonPropertyName("limitation")] bool Limitation,
    [property: JsonPropertyName("recommendedAction")] string? RecommendedAction);

public sealed record CommandResultPayload(
    [property: JsonPropertyName("commandId")] string CommandId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("startedAt")] string? StartedAt,
    [property: JsonPropertyName("completedAt")] string? CompletedAt,
    [property: JsonPropertyName("failure")] CommandFailurePayload? Failure,
    [property: JsonPropertyName("result")] object? Result,
    [property: JsonPropertyName("agentVersion")] string AgentVersion)
{
    [JsonPropertyName("protocolVersion")]
    public int ProtocolVersion { get; init; } = WolfProtocol.Version;
}

public sealed record AgentCommandResultMessage(
    [property: JsonPropertyName("result")] CommandResultPayload Result)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "agent.command-result";

    [JsonPropertyName("protocolVersion")]
    public int ProtocolVersion { get; init; } = WolfProtocol.Version;
}

public sealed record AgentEventPayload(
    [property: JsonPropertyName("at")] string At,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("detail")] IReadOnlyDictionary<string, object?> Detail);

public sealed record AgentEventMessage(
    [property: JsonPropertyName("event")] AgentEventPayload Event)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "agent.event";

    [JsonPropertyName("protocolVersion")]
    public int ProtocolVersion { get; init; } = WolfProtocol.Version;
}

// ---------------------------------------------------------------------------
// Command results
// ---------------------------------------------------------------------------

public sealed record SystemInfoResult(
    [property: JsonPropertyName("hostname")] string Hostname,
    [property: JsonPropertyName("osName")] string OsName,
    [property: JsonPropertyName("osVersion")] string OsVersion,
    [property: JsonPropertyName("osBuild")] string OsBuild,
    [property: JsonPropertyName("architecture")] string Architecture,
    [property: JsonPropertyName("cpuModel")] string? CpuModel,
    [property: JsonPropertyName("cpuCores")] int? CpuCores,
    [property: JsonPropertyName("cpuThreads")] int? CpuThreads,
    [property: JsonPropertyName("totalMemoryBytes")] long? TotalMemoryBytes,
    [property: JsonPropertyName("gpus")] IReadOnlyList<string> Gpus,
    [property: JsonPropertyName("bootedAt")] string? BootedAt,
    [property: JsonPropertyName("agentVersion")] string AgentVersion);

public sealed record SystemCapabilitiesResult(
    [property: JsonPropertyName("hardwareVideoEncoders")] IReadOnlyList<string> HardwareVideoEncoders,
    [property: JsonPropertyName("preferredVideoCodec")] string? PreferredVideoCodec,
    [property: JsonPropertyName("displayCount")] int DisplayCount,
    [property: JsonPropertyName("audioCaptureAvailable")] bool AudioCaptureAvailable,
    [property: JsonPropertyName("wakeOnLanCapable")] bool WakeOnLanCapable,
    [property: JsonPropertyName("privilegedHelperAvailable")] bool PrivilegedHelperAvailable,
    [property: JsonPropertyName("secureDesktopCaptureAvailable")] bool SecureDesktopCaptureAvailable,
    [property: JsonPropertyName("remoteUnlockProvisioned")] bool RemoteUnlockProvisioned,
    [property: JsonPropertyName("gpuVendors")] IReadOnlyList<string> GpuVendors,
    [property: JsonPropertyName("windowsBuild")] string? WindowsBuild,
    /// <summary>
    /// Command types this build can actually execute. The cloud refuses to dispatch
    /// anything absent from this list rather than queueing work that would never run.
    /// </summary>
    [property: JsonPropertyName("supportedCommands")] IReadOnlyList<string> SupportedCommands,
    /// <summary>
    /// Whether this PC can stream its screen right now — a different question from whether
    /// it owns an encoder, and the one a dashboard must ask before offering to connect.
    /// </summary>
    [property: JsonPropertyName("remoteDesktopAvailable")] bool RemoteDesktopAvailable,
    [property: JsonPropertyName("remoteDesktopUnavailableReason")] string? RemoteDesktopUnavailableReason,
    /// <summary>Every detected encoder, hardware and software.</summary>
    [property: JsonPropertyName("videoEncoders")] IReadOnlyList<string> VideoEncoders);

public sealed record SystemSessionStateResult(
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("sessionId")] int? SessionId,
    [property: JsonPropertyName("userName")] string? UserName,
    [property: JsonPropertyName("observedAt")] string ObservedAt);

// ---------------------------------------------------------------------------
// Cloud -> agent
// ---------------------------------------------------------------------------

/// <summary>A command as delivered by the cloud, with the authorization it was granted under.</summary>
public sealed record CommandEnvelope(
    string CommandId,
    string PcId,
    string RequestId,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt,
    string IdempotencyKey,
    string Type,
    JsonElement Payload,
    JsonElement Authorization);
