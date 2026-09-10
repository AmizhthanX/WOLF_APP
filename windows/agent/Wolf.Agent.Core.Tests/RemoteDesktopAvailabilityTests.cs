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
            Ready(), "desktop", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.True(available);
        Assert.Null(reason);
    }

    [Fact]
    public void The_kill_switch_outranks_everything_else()
    {
        // Even a perfectly capable machine says no, and says why, because the operator
        // deliberately turned remote access off.
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            Ready(), "desktop", killSwitchEngaged: true, secureDesktopCaptureAvailable: false);

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
            Ready(), sessionState, killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.False(available);
        Assert.Equal(expected, reason);
    }

    [Fact]
    public void A_locked_workstation_is_reported_before_a_missing_encoder()
    {
        // Both are true; the one the operator can act on comes first.
        SessionHostState noEncoders = Ready() with { Encoders = Array.Empty<IpcEncoder>() };

        (_, string? reason) = RemoteDesktopAvailability.Evaluate(
            noEncoders, "locked", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.Equal(RemoteDesktopAvailability.Locked, reason);
    }

    /* --------------------------------------------------------------------- */
    /* A locked PC that can show its own lock screen                          */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void A_locked_pc_that_can_show_its_lock_screen_can_stream()
    {
        // The case this field exists for. The operator locked the machine, walked away, and
        // now wants back in — which used to be refused, so the only way to reach a locked PC
        // was to have been streaming before it locked.
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            Ready(), "locked", killSwitchEngaged: false, secureDesktopCaptureAvailable: true);

        Assert.True(available);
        Assert.Null(reason);
    }

    [Fact]
    public void A_locked_pc_that_cannot_reach_the_secure_desktop_still_says_locked()
    {
        // Most PCs, most of the time: the agent has to be installed as a Windows service
        // before it can put a host on the Winlogon desktop. The answer is the one it always
        // was, rather than an offer that fails after the operator accepts it.
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            Ready(), "locked", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.Locked, reason);
    }

    [Fact]
    public void A_locked_pc_with_no_user_host_says_locked_however_capable_the_secure_one_is()
    {
        // The half that is easy to forget. The secure host produces pixels; it has no peer
        // connection, and the frames go out on the *user* host's. Without one there is
        // nowhere to send them, and offering the stream would strand the client.
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            new SessionHostState { Connected = false },
            "locked",
            killSwitchEngaged: false,
            secureDesktopCaptureAvailable: true);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.Locked, reason);
    }

    [Fact]
    public void A_sign_in_screen_is_still_refused_even_where_it_could_be_captured()
    {
        // Nobody is signed in, so there is no session and no user host — and therefore no
        // connection. The secure host could capture the sign-in screen perfectly well and
        // would have nowhere to send it. Reported as `login` rather than as a stream that
        // starts and then produces nothing.
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            new SessionHostState { Connected = false },
            "login",
            killSwitchEngaged: false,
            secureDesktopCaptureAvailable: true);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.Login, reason);
    }

    [Fact]
    public void A_locked_pc_is_still_checked_for_everything_else()
    {
        // Falling through is not the same as skipping. A locked machine that can reach the
        // secure desktop but has no encoder is refused for the encoder, which is the answer
        // that stays true after somebody signs in.
        SessionHostState noEncoders = Ready() with { Encoders = Array.Empty<IpcEncoder>() };

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            noEncoders, "locked", killSwitchEngaged: false, secureDesktopCaptureAvailable: true);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.NoEncoder, reason);
    }

    [Fact]
    public void The_kill_switch_still_outranks_a_lock_screen_that_could_be_shown()
    {
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            Ready(), "locked", killSwitchEngaged: true, secureDesktopCaptureAvailable: true);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.KillSwitch, reason);
    }

    [Fact]
    public void No_host_on_a_live_desktop_means_the_host_is_missing()
    {
        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            new SessionHostState { Connected = false }, "desktop", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.NoSessionHost, reason);
    }

    [Fact]
    public void No_host_and_no_desktop_means_nobody_is_signed_in()
    {
        (_, string? reason) = RemoteDesktopAvailability.Evaluate(
            new SessionHostState { Connected = false }, "unknown", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.Equal(RemoteDesktopAvailability.SignedOut, reason);
    }

    [Fact]
    public void A_host_with_no_display_cannot_stream()
    {
        SessionHostState headless = Ready() with { Displays = Array.Empty<IpcDisplay>() };

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            headless, "desktop", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.False(available);
        Assert.Equal(RemoteDesktopAvailability.NoDisplay, reason);
    }

    [Fact]
    public void A_host_with_no_encoder_cannot_stream()
    {
        SessionHostState noEncoders = Ready() with { Encoders = Array.Empty<IpcEncoder>() };

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            noEncoders, "desktop", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

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
            cannotCapture, "desktop", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

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
            noTransport, "desktop", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

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
            neither, "desktop", killSwitchEngaged: false, secureDesktopCaptureAvailable: false);

        Assert.Equal(RemoteDesktopAvailability.CaptureUnsupported, reason);
    }
}
