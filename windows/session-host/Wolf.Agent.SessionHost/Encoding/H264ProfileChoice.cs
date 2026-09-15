namespace Wolf.Agent.SessionHost.Encoding;

/// <summary>
/// Which H.264 profile to encode, given what the client says it can decode.
///
/// High by default, because every browser decodes it and it is what this host produced before clients could
/// say otherwise. A client that states its profiles and does not include High gets the best one it does
/// list. This exists because of a real stream: an Android phone whose only H.264 decoder takes Constrained
/// Baseline rejected a High-profile offer in its own WebRTC stack, and nothing reached the screen.
///
/// Baseline here is Media Foundation's Baseline profile. Media Foundation encoders use none of the Baseline
/// features Constrained Baseline removes, and the offer still describes whatever the encoder's own sequence
/// parameter set says, so nothing about the stream is claimed that the stream does not carry.
/// </summary>
public static class H264ProfileChoice
{
    public const string High = "high";
    public const string Main = "main";
    public const string ConstrainedBaseline = "constrained-baseline";

    /// <summary>The MF_MT_MPEG2_PROFILE value to encode with, or null when the client lists no profile this host can produce.</summary>
    public static uint? Choose(IReadOnlyList<string>? clientProfiles)
    {
        if (clientProfiles is null || clientProfiles.Count == 0) return MfGuids.H264ProfileHigh;
        if (clientProfiles.Contains(High, StringComparer.Ordinal)) return MfGuids.H264ProfileHigh;
        if (clientProfiles.Contains(Main, StringComparer.Ordinal)) return MfGuids.H264ProfileMain;
        if (clientProfiles.Contains(ConstrainedBaseline, StringComparer.Ordinal)) return MfGuids.H264ProfileBaseline;
        return null;
    }

    public static string Describe(uint profile) => profile switch
    {
        MfGuids.H264ProfileHigh => High,
        MfGuids.H264ProfileMain => Main,
        MfGuids.H264ProfileBaseline => ConstrainedBaseline,
        _ => $"profile {profile}",
    };
}
