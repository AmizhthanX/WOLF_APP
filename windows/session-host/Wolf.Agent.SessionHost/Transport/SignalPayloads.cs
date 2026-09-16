using System.Text.Json.Serialization;

namespace Wolf.Agent.SessionHost.Transport;

/// <summary>
/// The signaling payloads the session host reads and writes.
///
/// These mirror `packages/protocol/src/signaling.ts`, which is the source of truth for the
/// shapes; the cloud validates every message against it in both directions, so anything
/// this file gets wrong is rejected at the relay rather than reaching a client. They are
/// typed records rather than loose JSON for the same reason the command protocol is: a
/// stream is negotiated from these values, and a misread profile is a stream that runs at
/// the wrong bitrate on somebody's metered connection.
/// </summary>
public static class SignalTypes
{
    // Client -> agent.
    public const string StreamRequest = "stream.request";
    public const string SdpAnswer = "sdp.answer";
    public const string IceCandidate = "ice.candidate";
    public const string IceComplete = "ice.complete";
    public const string StreamStop = "stream.stop";
    public const string SetProfile = "stream.set-profile";
    public const string SetDisplay = "stream.set-display";

    /// <summary>
    /// Who holds keyboard and mouse control, decided by the cloud.
    ///
    /// Authored only by the relay — neither a client nor an agent may send it — because it
    /// is the decision that says who is allowed to drive somebody's PC.
    /// </summary>
    public const string InputControl = "input.control";

    /// <summary>
    /// Who holds the terminal, decided by the cloud.
    ///
    /// Authored only by the relay, like <see cref="InputControl"/>, and gating something
    /// larger: a session holding this lease can run commands on this PC.
    /// </summary>
    public const string TerminalControl = "terminal.control";

    /// <summary>
    /// Who may browse and move this PC's files, decided by the cloud.
    ///
    /// Authored only by the relay, like the other two.
    /// </summary>
    public const string FileControl = "file.control";

    // Agent -> client.
    public const string StreamReady = "stream.ready";
    public const string SdpOffer = "sdp.offer";
    public const string StreamState = "stream.state";
    public const string StreamStats = "stream.stats";
    public const string StreamError = "stream.error";

    /// <summary>Agent -> relay only: a file operation, with no path, for the audit trail.</summary>
    public const string FileActivity = "file.activity";
}

/// <summary>
/// Levers the operator has taken away from adaptation, each null when they have not.
///
/// Sent with the profile rather than as a separate message: a pin is part of what the
/// operator asked the stream to be, and splitting it out would let the two disagree.
/// </summary>
public sealed record SignalOverrides(
    [property: JsonPropertyName("bitrateBps")] int? BitrateBps,
    [property: JsonPropertyName("frameRate")] int? FrameRate,
    [property: JsonPropertyName("resolutionScale")] double? ResolutionScale)
{
    /// <summary>Nothing pinned. Also what a client that predates overrides means.</summary>
    public static readonly SignalOverrides None = new(null, null, null);

    public bool Any => BitrateBps is not null || FrameRate is not null || ResolutionScale is not null;
}

/// <summary>A streaming profile. Every field is a ceiling or a target, never a guarantee.</summary>
public sealed record SignalProfile(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("maxWidthPixels")] int? MaxWidthPixels,
    [property: JsonPropertyName("maxHeightPixels")] int? MaxHeightPixels,
    [property: JsonPropertyName("targetFps")] int TargetFps,
    [property: JsonPropertyName("minBitrateBps")] int MinBitrateBps,
    [property: JsonPropertyName("maxBitrateBps")] int MaxBitrateBps,
    [property: JsonPropertyName("codecPreference")] IReadOnlyList<string> CodecPreference,
    [property: JsonPropertyName("audioEnabled")] bool AudioEnabled,
    [property: JsonPropertyName("qualityBias")] string QualityBias,
    [property: JsonPropertyName("adaptive")] bool Adaptive,
    /// <summary>Null from a client that does not send overrides, which means none.</summary>
    [property: JsonPropertyName("overrides")] SignalOverrides? Overrides = null);

public sealed record SignalStreamRequest(
    [property: JsonPropertyName("displayId")] string? DisplayId,
    [property: JsonPropertyName("profile")] SignalProfile Profile,
    [property: JsonPropertyName("clientCodecs")] IReadOnlyList<string> ClientCodecs,
    [property: JsonPropertyName("requestAudio")] bool RequestAudio,
    /// <summary>
    /// H.264 profiles the client can decode. Null or empty from a client that does not say — every
    /// browser, and every client before the field existed — which is read as High.
    /// </summary>
    [property: JsonPropertyName("h264Profiles")] IReadOnlyList<string>? H264Profiles = null);

/// <summary>
/// A setting the agent could not honour, and why.
///
/// Reported rather than applied silently: a profile that asks for 4K at 120 fps on a
/// 1080p60 display should come back saying what it actually got.
/// </summary>
public sealed record SignalAdjustment(
    [property: JsonPropertyName("setting")] string Setting,
    [property: JsonPropertyName("requested")] string Requested,
    [property: JsonPropertyName("applied")] string Applied,
    [property: JsonPropertyName("reason")] string Reason);

public sealed record SignalNegotiation(
    [property: JsonPropertyName("streamId")] string StreamId,
    [property: JsonPropertyName("display")] object Display,
    [property: JsonPropertyName("videoCodec")] string VideoCodec,
    [property: JsonPropertyName("hardwareEncoded")] bool HardwareEncoded,
    [property: JsonPropertyName("audioCodec")] string? AudioCodec,
    [property: JsonPropertyName("effectiveProfile")] SignalProfile EffectiveProfile,
    [property: JsonPropertyName("adjustments")] IReadOnlyList<SignalAdjustment> Adjustments,
    [property: JsonPropertyName("startedAt")] string StartedAt);

public sealed record SignalStats(
    [property: JsonPropertyName("streamId")] string StreamId,
    [property: JsonPropertyName("at")] string At,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("route")] string? Route,
    [property: JsonPropertyName("fps")] double? Fps,
    [property: JsonPropertyName("bitrateBps")] double? BitrateBps,
    [property: JsonPropertyName("widthPixels")] int? WidthPixels,
    [property: JsonPropertyName("heightPixels")] int? HeightPixels,
    [property: JsonPropertyName("latencyMs")] double? LatencyMs,
    [property: JsonPropertyName("jitterMs")] double? JitterMs,
    [property: JsonPropertyName("packetLossPercent")] double? PacketLossPercent,
    [property: JsonPropertyName("keyFramesSent")] int? KeyFramesSent,
    [property: JsonPropertyName("encoder")] string? Encoder,
    [property: JsonPropertyName("encoderHardware")] bool? EncoderHardware,
    [property: JsonPropertyName("encodeMsPerFrame")] double? EncodeMsPerFrame,
    [property: JsonPropertyName("degradedReason")] string? DegradedReason);

public sealed record SignalCandidate(
    [property: JsonPropertyName("candidate")] string Candidate,
    [property: JsonPropertyName("sdpMid")] string? SdpMid,
    [property: JsonPropertyName("sdpMLineIndex")] int? SdpMLineIndex,
    [property: JsonPropertyName("usernameFragment")] string? UsernameFragment);
