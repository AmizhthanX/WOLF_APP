using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Sessions;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.SessionHost.Displays;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Knowing whether the screen is locked, rather than guessing.
///
/// The agent has been inferring this from whether `LogonUI.exe` is running in the console
/// session — a guess that works most of the time and is wrong in the ways guesses usually
/// are. LogonUI lingers for a moment after an unlock, and a UAC prompt puts the secure
/// desktop up without starting it at all.
///
/// A process inside the session can ask Windows directly: may it open the desktop that
/// currently has the input? Being refused *is* the answer — the secure desktop has it. These
/// tests run that against the real machine, which is possible precisely because the ordinary
/// developer session is not the secure desktop.
///
/// This matters beyond a status field. It is what will decide when to hand capture over to a
/// secure-desktop host, and a caller acting on a wrong answer could send input to a screen
/// that is not the one they think they are looking at.
/// </summary>
public sealed class InputDesktopTests
{
    private readonly ITestOutputHelper _output;

    public InputDesktopTests(ITestOutputHelper output)
    {
        _output = output;
    }

    [Fact]
    public void This_session_reports_the_desktop_it_is_actually_on()
    {
        InputDesktopState state = InputDesktop.Query();
        _output.WriteLine($"input desktop: {state}");

        // The test host runs on the user's desktop with a screen that is not locked, so this
        // is the answer. If it came back `Secure` the machine would have locked mid-run, and
        // if it came back `Unknown` the query is not working at all — both worth failing on
        // rather than tolerating, because a status that is sometimes unknown for no reason is
        // one nobody can act on.
        Assert.Equal(InputDesktopState.UserDesktop, state);
    }

    [Fact]
    public void Asking_repeatedly_gives_a_stable_answer()
    {
        // Reported on every status message, so a query that leaked handles or raced would
        // show up as an agent that slowly stopped answering rather than as an obvious fault.
        for (var attempt = 0; attempt < 200; attempt++)
        {
            Assert.Equal(InputDesktopState.UserDesktop, InputDesktop.Query());
        }
    }

    /* --------------------------------------------------------------------- */
    /* What the agent does with the answer                                    */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void The_hosts_answer_is_preferred_over_the_old_inference()
    {
        // The host is inside the session and put the question to Windows. The inference
        // watches for a process from outside. There is no case where the guess is better, so
        // the host's answer wins wherever it has one.
        var monitor = new WindowsSessionMonitor(
            NullLogger<WindowsSessionMonitor>.Instance,
            () => IpcInputDesktop.Secure);

        SystemSessionStateResult state = monitor.Query();
        _output.WriteLine($"state: {state.State}, session {state.SessionId}, user {state.UserName}");

        // This machine is signed in and unlocked, so the LogonUI inference would say
        // "desktop". The host said the secure desktop has the input, and that is what is
        // reported — which is exactly the disagreement this change exists to settle.
        Assert.Equal("locked", state.State);
    }

    [Fact]
    public void A_host_reporting_the_user_desktop_means_not_locked()
    {
        var monitor = new WindowsSessionMonitor(
            NullLogger<WindowsSessionMonitor>.Instance,
            () => IpcInputDesktop.User);

        Assert.Equal("desktop", monitor.Query().State);
    }

    [Fact]
    public void With_no_host_the_agent_falls_back_to_the_inference()
    {
        // A PC with nobody signed in has no session host and still has a state worth
        // reporting. The guess is kept for exactly that case rather than deleted.
        var monitor = new WindowsSessionMonitor(
            NullLogger<WindowsSessionMonitor>.Instance,
            () => IpcInputDesktop.Unknown);

        SystemSessionStateResult state = monitor.Query();
        _output.WriteLine($"fallback state: {state.State}");

        // On this machine — signed in, unlocked, LogonUI not running — the inference agrees
        // with the truth. What is asserted is that it still answers, not that it is right.
        Assert.Contains(state.State, new[] { "desktop", "locked", "login", "unknown" });
    }

    [Fact]
    public void The_default_monitor_still_works_for_callers_that_have_no_host()
    {
        // The single-argument constructor is what the tests and any caller without a
        // supervisor use. It must behave, not throw for want of a host.
        var monitor = new WindowsSessionMonitor(NullLogger<WindowsSessionMonitor>.Instance);

        SystemSessionStateResult state = monitor.Query();
        Assert.False(string.IsNullOrWhiteSpace(state.State));
    }
}
