using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Native;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The host that sits on the lock screen's desktop.
///
/// **Most of this has never run, and these tests say so rather than hiding it.** Starting the
/// secure host needs two things a development machine does not have: the agent installed as a
/// Windows service, so that it is SYSTEM and can duplicate a SYSTEM token, and a screen that
/// is locked while somebody watches what happens. Everything below either runs here or states
/// which of those it is waiting for.
///
/// What *does* run is the part that decides whether to try, and that is worth more than it
/// looks. The failure this guards against is a PC that tells the cloud it can capture the
/// lock screen and then cannot — because the operator's next move after "yes" is to lock a
/// machine they are not sitting at.
/// </summary>
public sealed class SecureDesktopTests
{
    private readonly ITestOutputHelper _output;

    public SecureDesktopTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static string HostPath =>
        Path.Combine(AppContext.BaseDirectory, "Wolf.Agent.SessionHost.exe");

    /* --------------------------------------------------------------------- */
    /* Whether it would work here, which is answerable                        */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void An_agent_that_is_not_system_says_so_rather_than_trying()
    {
        // This test process is not SYSTEM, and neither is an agent somebody started by hand.
        // The honest answer is that this needs the service — not an access-denied three calls
        // later that reads like a bug in WOLF.
        Assert.False(SecureDesktopLaunch.RunningAsSystem());

        SecureLaunchFailure? failure = SecureDesktopLaunch.CheckPreconditions(HostPath);

        Assert.NotNull(failure);
        Assert.Equal("not-system", failure!.Code);

        // A limitation rather than a failure: nothing is broken, the agent is simply not
        // installed in the way this needs.
        Assert.True(failure.Limitation);
        _output.WriteLine($"{failure.Code}: {failure.Message}");
    }

    [Fact]
    public void A_missing_session_host_is_reported_before_anything_else()
    {
        // Checked first because it is the one precondition that is a genuine installation
        // fault rather than a property of how the agent was started.
        SecureLaunchFailure? failure = SecureDesktopLaunch.CheckPreconditions(
            Path.Combine(AppContext.BaseDirectory, "not-the-session-host.exe"));

        Assert.NotNull(failure);
        Assert.Equal("not-installed", failure!.Code);
        Assert.False(failure.Limitation);
    }

    [Fact]
    public void The_supervisor_reports_that_it_cannot_capture_here()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        var supervisor = new SecureDesktopSupervisor(
            loggers.CreateLogger<SecureDesktopSupervisor>(),
            HostPath);

        Assert.False(supervisor.CanCapture());

        // And says why, in words an operator can act on. "Cannot capture" alone leaves
        // somebody with nothing to do about it.
        string? why = supervisor.WhyNot();
        _output.WriteLine($"why not: {why}");

        Assert.NotNull(why);
        Assert.Contains("service", why!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Before_it_starts_the_supervisor_says_nothing_is_being_captured()
    {
        var supervisor = new SecureDesktopSupervisor(
            NullLogger<SecureDesktopSupervisor>.Instance,
            HostPath);

        SecureDesktopState state = supervisor.State;

        Assert.False(state.Connected);
        Assert.Equal("not-running", state.UnavailableCode);
        Assert.NotNull(state.UnavailableReason);

        // No displays, rather than the user desktop's. The secure desktop's layout is
        // whatever the host on it reports, and before there is one there is no answer.
        Assert.Empty(state.Displays);
        Assert.Equal("none", state.CaptureApi);
    }

    [Fact]
    public async Task Stopping_a_supervisor_that_never_started_is_harmless()
    {
        // Called on every unlock, including the ones where nothing was ever running because
        // the PC could not capture in the first place.
        var supervisor = new SecureDesktopSupervisor(
            NullLogger<SecureDesktopSupervisor>.Instance,
            HostPath);

        await supervisor.StopAsync();
        await supervisor.DisposeAsync();

        Assert.False(supervisor.State.Connected);
    }

    /* --------------------------------------------------------------------- */
    /* The policy that decides when to try                                    */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void The_watcher_does_nothing_on_a_pc_that_cannot_capture()
    {
        // The case every development machine is in, and most PCs are in whenever nobody has
        // locked the screen. It must be quiet: a watcher that tried and failed every fifteen
        // seconds would fill a log with something nobody can fix.
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);

        var sessionHost = new SessionHostSupervisor(
            loggers.CreateLogger<SessionHostSupervisor>(),
            HostPath);

        var secureHost = new SecureDesktopSupervisor(
            loggers.CreateLogger<SecureDesktopSupervisor>(),
            HostPath);

        var watcher = new SecureDesktopWatcher(
            sessionHost,
            secureHost,
            loggers.CreateLogger<SecureDesktopWatcher>());

        watcher.Start();

        // Nothing was started, because nothing could be. The state is still the one it
        // began with rather than an error about a launch that was never attempted.
        Assert.Equal("not-running", secureHost.State.UnavailableCode);
    }

    [Fact]
    public void A_secure_host_is_told_which_desktop_it_is_on()
    {
        // The executable serves both desktops and cannot work out afterwards which one it
        // was launched onto, so the service passes it in. If this argument ever changed
        // without the host's parsing changing, the secure host would connect to the user
        // host's pipe and quietly fight it for the channel.
        Assert.Equal("--secure-desktop", SecureDesktopSupervisor.SecureModeArgument);

        string commandLine = SecureDesktopLaunch.BuildCommandLine(
            @"C:\Program Files\WOLF\Wolf.Agent.SessionHost.exe",
            SecureDesktopSupervisor.SecureModeArgument);

        _output.WriteLine(commandLine);

        // Argument zero quoted, because an unquoted path with a space in it is the classic
        // way to end up running something else entirely — here, `C:\Program.exe`.
        Assert.StartsWith("\"C:\\Program Files\\", commandLine, StringComparison.Ordinal);
        Assert.EndsWith("\" --secure-desktop", commandLine, StringComparison.Ordinal);
    }

    [Fact]
    public void The_two_hosts_do_not_share_a_channel()
    {
        // They run as different accounts on different desktops with different lifetimes.
        // Sharing a pipe name would mean whichever started second failed to bind, silently,
        // and the operator would see one of the two features stop working.
        Assert.NotEqual(WolfIpc.PipeName, SecureDesktopSupervisor.PipeName);
    }

    /* --------------------------------------------------------------------- */
    /* What is not tested here, and why                                       */
    /* --------------------------------------------------------------------- */

    /// <summary>
    /// The one that matters, and the one that cannot run here.
    ///
    /// It needs the agent installed as a Windows service — so it is SYSTEM and can duplicate
    /// a SYSTEM token into the console session — and the screen locked while it runs. Both
    /// are things a person arranges deliberately, not something a test suite should do to
    /// somebody who typed `npm test`.
    ///
    /// Run it with <c>WOLF_TEST_SECURE_DESKTOP=1</c>, from a service context, on a machine
    /// whose screen is locked.
    /// </summary>
    [Fact]
    public async Task Capturing_the_secure_desktop_really_works()
    {
        if (Environment.GetEnvironmentVariable("WOLF_TEST_SECURE_DESKTOP") is not ("1" or "true"))
        {
            _output.WriteLine(
                "Needs the agent running as a service, on a machine with the screen locked. " +
                "Set WOLF_TEST_SECURE_DESKTOP=1 to run it there.");
            return;
        }

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        await using var supervisor = new SecureDesktopSupervisor(
            loggers.CreateLogger<SecureDesktopSupervisor>(),
            HostPath);

        if (!supervisor.CanCapture())
        {
            _output.WriteLine($"Cannot capture here: {supervisor.WhyNot()}");
            Assert.Fail("WOLF_TEST_SECURE_DESKTOP was set on a machine that cannot capture the secure desktop.");
        }

        supervisor.Start();

        DateTimeOffset deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(40);
        while (!supervisor.State.Connected && DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(250);
        }

        SecureDesktopState state = supervisor.State;
        _output.WriteLine(
            $"connected={state.Connected} api={state.CaptureApi} " +
            $"displays={state.Displays.Count} reason={state.UnavailableReason}");

        Assert.True(state.Connected, $"the secure host never connected: {state.UnavailableReason}");

        // Duplication, because Graphics Capture has no item to create on that desktop. If
        // this ever comes back as graphics-capture, the reasoning in DetectCaptureApi was
        // wrong and the fallback is doing more work than it needs to.
        Assert.Equal("desktop-duplication", state.CaptureApi);

        // A lock screen is drawn on a real display. Zero would mean the host attached to a
        // desktop with no output, which is a different failure to not attaching at all.
        Assert.True(state.Displays.Count > 0, "the secure host reported no displays");
    }
}
