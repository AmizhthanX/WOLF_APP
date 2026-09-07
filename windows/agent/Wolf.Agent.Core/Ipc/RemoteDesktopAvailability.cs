namespace Wolf.Agent.Core.Ipc;

/// <summary>
/// Decides whether this PC can stream its screen right now, and if not, why.
///
/// Kept in one place because two callers need the same answer and must not drift: the
/// capability handshake the cloud stores, and the status command a client asks directly.
/// If those two ever disagreed, the dashboard would offer a stream the agent then refuses.
///
/// The order of the checks is the order an operator can act on. A locked workstation is
/// reported before a missing encoder, because "sign in and it will work" is more useful
/// than "this machine has no hardware encoder" when both happen to be true.
/// </summary>
public static class RemoteDesktopAvailability
{
    /// <summary>Reason codes, matching the protocol's stream-unavailable list.</summary>
    public const string KillSwitch = "kill-switch";
    public const string Locked = "locked";
    public const string Login = "login";
    public const string Restarting = "restarting";
    public const string SignedOut = "signed-out";
    public const string NoSessionHost = "no-session-host";
    public const string NoDisplay = "no-display";
    public const string NoEncoder = "no-encoder";
    public const string CaptureUnsupported = "capture-unsupported";
    public const string TransportUnavailable = "transport-unavailable";

    public static (bool Available, string? Reason) Evaluate(
        SessionHostState host,
        string windowsSessionState,
        bool killSwitchEngaged)
    {
        if (killSwitchEngaged)
        {
            return (false, KillSwitch);
        }

        // A locked or signed-out session is not a fault. It resolves on its own when
        // somebody signs in, and the client should say "waiting", not "broken".
        switch (windowsSessionState)
        {
            case "locked":
                return (false, Locked);
            case "login":
                return (false, Login);
            case "restarting":
                return (false, Restarting);
        }

        if (!host.Connected)
        {
            return (false, windowsSessionState == "desktop" ? NoSessionHost : SignedOut);
        }

        if (host.Displays.Count == 0)
        {
            return (false, NoDisplay);
        }

        if (host.Encoders.Count == 0)
        {
            return (false, NoEncoder);
        }

        // Detecting an encoder proves the machine could encode video; it does not prove
        // WOLF can capture a frame, and conflating the two is what this field exists to
        // prevent.
        if (string.Equals(host.CaptureApi, "none", StringComparison.Ordinal))
        {
            return (false, CaptureUnsupported);
        }

        // Capturing and encoding are not enough on their own: without transport the frames
        // have nowhere to go. Reported as its own reason because the diagnosis differs —
        // "this machine cannot capture" and "this build cannot send" call for different
        // answers.
        return host.TransportAvailable ? (true, null) : (false, TransportUnavailable);
    }
}
