using Wolf.Agent.Core.Ipc;
using Xunit;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The one decision that determines whether WOLF offers a stream at all.
///
/// It is worth testing exhaustively because getting it wrong in either direction is bad in
/// a specific way: too permissive and the dashboard offers a connection that never
/// completes; too strict and a perfectly capable PC looks broken. The reason code matters
/// as much as the boolean, since it is what tells the operator to wait rather than to go
/// and fix something.
/// </summary>
public sealed class RemoteDesktopAvailabilityTests
{
    private static SessionHostState Ready(string captureApi = "graphics-capture") => new()
    {
        Connected = true,
        CaptureApi = captureApi,
        TransportAvailable = true,
        Displays = new[]
        {
            new IpcDisplay("DISPLAY1", "Monitor", 1920, 1080, 60, true, 1, false, 0, 0),
        },
        Encoders = new[] { new IpcEncoder("h264-hardware", "h264", "H.264 (hardware)", true) },
    };

    [Fact]
    public void A_ready_host_on_a_desktop_session_can_stream()
    {
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            Ready(), "desktop", killSwitchEngaged: false);

        Assert.True(available);
        Assert.Null(reason);
    }

    [Fact]
    public void The_kill_switch_outranks_everything_else()
    {
        // Even a perfectly capable machine says no, and says why, because the operator
        // deliberately turned remote access off.
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            Ready(), "desktop", killSwitchEngaged: true);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.KillSwitch, reason);
    }

    [Theory]
    [InlineData("locked", RemoteDesktopAvailability.Locked)]
    [InlineData("login", RemoteDesktopAvailability.Login)]
    [InlineData("restarting", RemoteDesktopAvailability.Restarting)]
    public void A_session_boundary_is_reported_as_itself(string sessionState, string expected)
    {
        // These resolve on their own. Reporting them as a capability failure would send an
        // operator looking for a problem that is about to disappear.
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            Ready(), sessionState, killSwitchEngaged: false);

        Assert.False(available);
        Assert.Equal(expected, reason);
    }

    [Fact]
    public void A_locked_workstation_is_reported_before_a_missing_encoder()
    {
        // Both are true; the one the operator can act on comes first.
        SessionHostState noEncoders = Ready() with { Encoders = Array.Empty<IpcEncoder>() };

        (_, string? reason) = RemoteDesktopAvailability.Evaluate(
            noEncoders, "locked", killSwitchEngaged: false);

        Assert.Equal(RemoteDesktopAvailability.Locked, reason);
    }

    [Fact]
    public void No_host_on_a_live_desktop_means_the_host_is_missing()
    {
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            new SessionHostState { Connected = false }, "desktop", killSwitchEngaged: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.NoSessionHost, reason);
    }

    [Fact]
    public void No_host_and_no_desktop_means_nobody_is_signed_in()
    {
        (_, string? reason) = RemoteDesktopAvailability.Evaluate(
            new SessionHostState { Connected = false }, "unknown", killSwitchEngaged: false);

        Assert.Equal(RemoteDesktopAvailability.SignedOut, reason);
    }

    [Fact]
    public void A_host_with_no_display_cannot_stream()
    {
        SessionHostState headless = Ready() with { Displays = Array.Empty<IpcDisplay>() };

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            headless, "desktop", killSwitchEngaged: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.NoDisplay, reason);
    }

    [Fact]
    public void A_host_with_no_encoder_cannot_stream()
    {
        SessionHostState noEncoders = Ready() with { Encoders = Array.Empty<IpcEncoder>() };

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            noEncoders, "desktop", killSwitchEngaged: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.NoEncoder, reason);
    }

    [Fact]
    public void Owning_an_encoder_is_not_the_same_as_being_able_to_capture()
    {
        // This is the case that made the field necessary. The machine has a hardware H.264
        // encoder and a display; the build cannot capture a frame. Inferring availability
        // from the hardware would offer a stream that never starts.
        SessionHostState cannotCapture = Ready(captureApi: "none");

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            cannotCapture, "desktop", killSwitchEngaged: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.CaptureUnsupported, reason);
        Assert.NotEmpty(cannotCapture.Encoders);
    }

    [Fact]
    public void Being_able_to_capture_is_not_the_same_as_being_able_to_deliver()
    {
        // The agent builds that capture and encode before WebRTC exists land in this state.
        // It is reported as its own reason because the diagnosis differs: nothing about the
        // PC is wrong, and telling the operator their capture is unsupported would send
        // them looking at drivers and display settings for a missing feature.
        SessionHostState noTransport = Ready() with { TransportAvailable = false };

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            noTransport, "desktop", killSwitchEngaged: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.TransportUnavailable, reason);
    }

    [Fact]
    public void A_host_that_can_neither_capture_nor_deliver_reports_the_capture_problem()
    {
        // Ordering: capture comes first because it is a property of the machine, while
        // transport is a property of the build. The one the operator might fix is reported.
        SessionHostState neither = Ready(captureApi: "none") with { TransportAvailable = false };

        (_, string? reason) = RemoteDesktopAvailability.Evaluate(
            neither, "desktop", killSwitchEngaged: false);

        Assert.Equal(RemoteDesktopAvailability.CaptureUnsupported, reason);
    }
}
