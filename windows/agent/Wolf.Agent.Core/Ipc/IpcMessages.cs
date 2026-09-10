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

/// <summary>
/// Which desktop within the session currently has the input.
///
/// The service cannot answer this. A process inside the session can, by asking Windows
/// whether it may open the input desktop, and being refused is the answer rather than an
/// error — it means the secure desktop has it.
/// </summary>
public static class IpcInputDesktop
{
    public const string Unknown = "unknown";

    /// <summary>The ordinary user desktop.</summary>
    public const string User = "user";

    /// <summary>The lock screen, the sign-in screen, or a UAC prompt.</summary>
    public const string Secure = "secure";
}

/// <summary>Periodic liveness and layout report. Displays change when monitors are plugged in.</summary>
public sealed record HostStatusMessage(
    [property: JsonPropertyName("at")] string At,
    [property: JsonPropertyName("displays")] IReadOnlyList<IpcDisplay> Displays,
    [property: JsonPropertyName("streams")] IReadOnlyList<IpcStreamStatus> Streams,
    /// <summary>True when the host can see a desktop right now, false on the secure desktop.</summary>
    [property: JsonPropertyName("desktopAccessible")] bool DesktopAccessible,
    /// <summary>One of <see cref="IpcInputDesktop"/>. Absent from older hosts, which read as unknown.</summary>
    [property: JsonPropertyName("inputDesktop")] string InputDesktop = IpcInputDesktop.Unknown)
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
    [property: JsonPropertyName("clipboardAllowed")] bool ClipboardAllowed = false,
    /// <summary>
    /// Whether the session that sent this may run commands on the PC.
    ///
    /// Its own grant, and the one that matters most: this is arbitrary command execution,
    /// and no other capability implies it. False by default, so a message that lost the
    /// field produces a stream with no terminal rather than one with a shell nobody
    /// authorised.
    /// </summary>
    [property: JsonPropertyName("terminalAllowed")] bool TerminalAllowed = false)
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

// ---------------------------------------------------------------------------
// The secure desktop's frames
// ---------------------------------------------------------------------------

/// <summary>Tell the secure-desktop host to start or stop producing frames.</summary>
public sealed record ServiceSecureCaptureMessage(
    [property: JsonPropertyName("capture")] bool Capture,
    /// <summary>Cap on the encoded width. A lock screen does not need full resolution.</summary>
    [property: JsonPropertyName("maxWidthPixels")] int MaxWidthPixels,
    [property: JsonPropertyName("maxHeightPixels")] int MaxHeightPixels,
    [property: JsonPropertyName("targetFps")] int TargetFps,
    [property: JsonPropertyName("bitrateBps")] int BitrateBps)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.secure-capture";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>
/// One encoded frame of the secure desktop.
///
/// Base64 over the same newline-delimited channel as everything else. A length-prefixed
/// binary framing would save a third of the bytes and cost a second protocol to get wrong,
/// on a path that carries a static lock screen at a few frames a second.
/// </summary>
public sealed record HostFrameMessage(
    [property: JsonPropertyName("data")] string Data,
    [property: JsonPropertyName("keyFrame")] bool KeyFrame,
    [property: JsonPropertyName("widthPixels")] int WidthPixels,
    [property: JsonPropertyName("heightPixels")] int HeightPixels,
    /// <summary>Milliseconds since this host started capturing. Its own clock, not the session's.</summary>
    [property: JsonPropertyName("timestampMs")] double TimestampMs)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "host.frame";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>
/// A secure-desktop frame on its way to the client, relayed by the service.
///
/// The one place media crosses the agent service, and a deliberate exception to the rule
/// that it does not. The two reasons behind that rule do not hold here: the frames are the
/// lock screen, produced by a SYSTEM process and relayed by another, so nothing is exposed
/// that was not already; and a static lock screen at a few frames a second is not the
/// throughput the rule was written about.
///
/// The alternative — a pipe directly between the two hosts — puts a channel carrying the
/// lock screen where a user-mode process could squat on the name. That is a worse trade.
/// </summary>
public sealed record ServiceSecureFrameMessage(
    [property: JsonPropertyName("data")] string Data,
    [property: JsonPropertyName("keyFrame")] bool KeyFrame,
    [property: JsonPropertyName("widthPixels")] int WidthPixels,
    [property: JsonPropertyName("heightPixels")] int HeightPixels)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.secure-frame";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>
/// Tell the user host whether the secure desktop is what the client is now seeing.
///
/// Sent on the change rather than with every frame. The host uses it to stop sending its own
/// pipeline's output — which on a locked screen is nothing, but "nothing" and "somebody
/// else's frames" must not interleave — and to tell the client the picture changed size.
/// </summary>
public sealed record ServiceSecureStateMessage(
    [property: JsonPropertyName("active")] bool Active,
    [property: JsonPropertyName("reason")] string? Reason)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.secure-state";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>
/// Input the user host has authorised, on its way to the secure desktop.
///
/// The batch is carried verbatim. Both hosts are the same executable and parse it with the
/// same code, so re-shaping it in the middle would only create somewhere for the two to
/// disagree.
///
/// Everything that decides whether this input is allowed happened before the message was
/// sent: the session's control lease, its expiry, the batch bounds. The secure host injects
/// what it is handed. That is the right split — the lease belongs to a session, and the
/// secure host does not have one.
/// </summary>
public sealed record HostSecureInputMessage(
    [property: JsonPropertyName("streamId")] string StreamId,
    /// <summary>The batch exactly as it arrived on the data channel.</summary>
    [property: JsonPropertyName("batch")] JsonElement Batch)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "host.secure-input";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}

/// <summary>The same batch, relayed by the service to the host on the secure desktop.</summary>
public sealed record ServiceSecureInputMessage(
    [property: JsonPropertyName("streamId")] string StreamId,
    [property: JsonPropertyName("batch")] JsonElement Batch)
{
    [JsonPropertyName("kind")]
    public string Kind { get; init; } = "service.secure-input";

    [JsonPropertyName("ipcVersion")]
    public int IpcVersion { get; init; } = WolfIpc.Version;
}
