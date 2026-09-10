using System.Text.Json;
using System.Text.Json.Serialization;

namespace Wolf.Agent.Core.Ipc;

/// <summary>
/// Contract between the agent service (session 0) and the session host (the interactive
/// session).
///
/// The two processes are split because Windows session isolation makes it necessary: a
/// service cannot capture the user's screen or inject input into it. Everything that needs
/// a desktop lives in the host; everything that needs to survive sign-out lives in the
/// service.
///
/// This channel carries control messages only. Frames, audio, and input events never cross
/// it — they go directly between the host and the remote peer over WebRTC, which keeps
/// media out of the most privileged process on the machine and avoids a copy per frame.
/// </summary>
public static class WolfIpc
{
    /// <summary>Bumped when the message contract changes incompatibly.</summary>
    public const int Version = 1;

    /// <summary>
    /// Named pipe the host connects to.
    ///
    /// The service creates it with an ACL allowing only SYSTEM and the interactive user it
    /// launched the host as, so another user signed in at the same time cannot reach it.
    /// </summary>
    public const string PipeName = "WOLF.Agent.SessionHost";

    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
    };
}

/// <summary>A display the host can capture. Mirrors the cloud protocol's display shape.</summary>
public sealed record IpcDisplay(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("widthPixels")] int WidthPixels,
    [property: JsonPropertyName("heightPixels")] int HeightPixels,
    [property: JsonPropertyName("refreshHz")] double? RefreshHz,
    [property: JsonPropertyName("primary")] bool Primary,
    [property: JsonPropertyName("scaleFactor")] double? ScaleFactor,
    [property: JsonPropertyName("hdr")] bool Hdr,
    [property: JsonPropertyName("originX")] int OriginX,
    [property: JsonPropertyName("originY")] int OriginY);

/// <summary>A video encoder the machine actually has, as reported by Media Foundation.</summary>
public sealed record IpcEncoder(
    /// <summary>Stable identifier used on the wire, e.g. "h264-hardware".</summary>
    [property: JsonPropertyName("id")] string Id,
    /// <summary>Codec this encoder produces: h264, h265, av1, vp9.</summary>
    [property: JsonPropertyName("codec")] string Codec,
    /// <summary>Friendly name from the transform, e.g. "Intel Quick Sync Video H.264 Encoder". </summary>
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("hardware")] bool Hardware);

// ---------------------------------------------------------------------------
// Host -> service
// ---------------------------------------------------------------------------

/// <summary>Sent once, immediately after the host connects. Establishes what it can do.</summary>
public sealed record HostHelloMessage(
    [property: JsonPropertyName("hostVersion")] string HostVersion,
    [property: JsonPropertyName("sessionId")] int SessionId,
    [property: JsonPropertyName("userName")] string? UserName,
    [property: JsonPropertyName("displays")] IReadOnlyList<IpcDisplay> Displays,
    [property: JsonPropertyName("encoders")] IReadOnlyList<IpcEncoder> Encoders,
    /// <summary>Capture API the host settled on: "graphics-capture", "desktop-duplication", or "none".</summary>
    [property: JsonPropertyName("captureApi")] string CaptureApi,
    [property: JsonPropertyName("audioCaptureAvailable")] bool AudioCaptureAvailable,
    /// <summary>
    /// Whether the host can deliver encoded frames to a remote peer.
    ///
    /// Separate from <c>CaptureApi</c> because capturing and transporting are separate
    /// capabilities that arrive in separate milestones. A host that can capture but not yet
    /// send is useless to a client, and saying so precisely is what lets the dashboard
    /// explain the difference instead of showing a stream that never starts.
    /// </summary>
    [property: JsonPropertyName("transportAvailable")] bool TransportAvailable)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "host.hello";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>
/// A stream running in the interactive session right now.
///
/// Reported individually rather than counted, because the client asking "what is running on
/// my PC" is entitled to see which session opened each stream. A count alone cannot answer
/// whether the stream someone is looking at is their own.
/// </summary>
public sealed record IpcStreamStatus(
    [property: JsonPropertyName("streamId")] string StreamId,
    [property: JsonPropertyName("sessionId")] string SessionId,
    /// <summary>One of the protocol's remote desktop states, e.g. "STREAMING".</summary>
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("startedAt")] string StartedAt);

/// <summary>Periodic liveness and layout report. Displays change when monitors are plugged in.</summary>
public sealed record HostStatusMessage(
    [property: JsonPropertyName("at")] string At,
    [property: JsonPropertyName("displays")] IReadOnlyList<IpcDisplay> Displays,
    [property: JsonPropertyName("streams")] IReadOnlyList<IpcStreamStatus> Streams,
    /// <summary>True when the host can see a desktop right now, false on the secure desktop.</summary>
    [property: JsonPropertyName("desktopAccessible")] bool DesktopAccessible)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "host.status";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>A signaling message from the host, to be forwarded to the cloud.</summary>
public sealed record HostSignalMessage(
    [property: JsonPropertyName("sessionId")] string SessionId,
    [property: JsonPropertyName("streamId")] string StreamId,
    /// <summary>Opaque here, validated against the protocol schema before it leaves the agent.</summary>
    [property: JsonPropertyName("payload")] JsonElement Payload)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "host.signal";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>The host could not do something, and the operator needs to know why.</summary>
public sealed record HostErrorMessage(
    [property: JsonPropertyName("streamId")] string? StreamId,
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("message")] string Message,
    /// <summary>True when Windows prevents it, rather than WOLF failing.</summary>
    [property: JsonPropertyName("limitation")] bool Limitation)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "host.error";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

// ---------------------------------------------------------------------------
// Service -> host
// ---------------------------------------------------------------------------

public sealed record ServiceHelloAckMessage(
    [property: JsonPropertyName("agentVersion")] string AgentVersion,
    [property: JsonPropertyName("statusIntervalSeconds")] int StatusIntervalSeconds)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.hello-ack";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>
/// An ICE server for the host's side of a connection.
///
/// Minted by the cloud and passed through: the agent holds no TURN secret, so it cannot
/// create these and does not try. An empty list means no STUN or TURN is configured, and
/// the stream will connect on the local network only.
/// </summary>
public sealed record IpcIceServer(
    [property: JsonPropertyName("urls")] IReadOnlyList<string> Urls,
    [property: JsonPropertyName("username")] string? Username,
    [property: JsonPropertyName("credential")] string? Credential);

/// <summary>A signaling message from a remote client, to be handled by the host.</summary>
public sealed record ServiceSignalMessage(
    [property: JsonPropertyName("sessionId")] string SessionId,
    [property: JsonPropertyName("streamId")] string StreamId,
    [property: JsonPropertyName("payload")] JsonElement Payload,
    /// <summary>Attached by the cloud to a stream request; empty for every other message.</summary>
    [property: JsonPropertyName("iceServers")] IReadOnlyList<IpcIceServer>? IceServers = null,
    /// <summary>
    /// Whether the session that sent this may hear the PC.
    ///
    /// The host cannot know: only the cloud sees what the session was granted. Defaulting to
    /// false means a message that lost the field on the way through produces a silent
    /// stream rather than an unauthorised one.
    /// </summary>
    [property: JsonPropertyName("audioAllowed")] bool AudioAllowed = false,
    /// <summary>
    /// Whether the session that sent this may exchange clipboard content with the PC.
    ///
    /// Its own grant, like audio: reading what somebody copied is a separate intrusion from
    /// watching their screen. False by default, so a message that lost the field produces a
    /// stream without clipboard sharing rather than one that shares without permission.
    /// </summary>
    [property: JsonPropertyName("clipboardAllowed")] bool ClipboardAllowed = false)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.signal";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>Stop a stream, or every stream when the id is null. </summary>
public sealed record ServiceStopMessage(
    [property: JsonPropertyName("streamId")] string? StreamId,
    [property: JsonPropertyName("reason")] string Reason)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.stop";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>
/// Ask the host to do something in the interactive session and say whether it worked.
///
/// The only service-to-host message that expects an answer. Everything else here is
/// fire-and-forget because it concerns a stream that reports its own state; an action like
/// locking the screen either happened or it did not, and the operator is owed which.
/// </summary>
public sealed record ServiceActionMessage(
    /// <summary>Correlates the answer. Generated per request, never reused.</summary>
    [property: JsonPropertyName("requestId")] string RequestId,
    /// <summary>One of <see cref="IpcActions"/>. Anything else is refused by the host.</summary>
    [property: JsonPropertyName("action")] string Action)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.action";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>Everything the service may ask the session host to do. Anything else is refused.</summary>
public static class IpcActions
{
    /// <summary>
    /// Lock the interactive session.
    ///
    /// Needs to run *in* that session — `LockWorkStation` affects only the caller's own —
    /// which is what the session host is for. It is not a question of privilege: the agent
    /// service is already LocalSystem and still cannot do it.
    /// </summary>
    public const string LockSession = "lock";

    public static bool IsAllowed(string action) => action == LockSession;
}

/// <summary>What happened to a <see cref="ServiceActionMessage"/>.</summary>
public sealed record HostActionResultMessage(
    [property: JsonPropertyName("requestId")] string RequestId,
    [property: JsonPropertyName("ok")] bool Ok,
    [property: JsonPropertyName("code")] string? Code,
    [property: JsonPropertyName("message")] string? Message,
    /// <summary>True when Windows prevents it, rather than WOLF failing.</summary>
    [property: JsonPropertyName("limitation")] bool Limitation)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "host.action-result";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>Ask the host to re-enumerate displays and encoders. </summary>
public sealed record ServiceRefreshMessage
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.refresh";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}
