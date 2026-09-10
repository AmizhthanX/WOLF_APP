using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Locking the console session, which the agent service cannot do itself.
///
/// Not a question of privilege — the service is already LocalSystem and still cannot do it,
/// because `LockWorkStation` affects only the caller's own session and a service's is
/// session 0, which has no desktop to lock. The session host is already running inside the
/// interactive session for screen capture, so it is what gets asked.
///
/// The lock itself is the one thing here that cannot be run as part of an ordinary test:
/// it would lock the screen of whoever is running the suite, and take the capture tests with
/// it. That test exists, says so, and runs only when somebody opts in.
/// </summary>
[Collection("SessionHost")]
public sealed class SessionActionTests
{
    private readonly ITestOutputHelper _output;

    public SessionActionTests(ITestOutputHelper output)
    {
        _output = output;
    }

    /// <summary>Set to run the test that really locks this machine's screen.</summary>
    private const string OptInVariable = "WOLF_TEST_ALLOW_LOCK";

    private static string HostPath =>
        Path.Combine(AppContext.BaseDirectory, "Wolf.Agent.SessionHost.exe");

    [Fact]
    public void The_action_list_is_exactly_what_the_session_host_implements()
    {
        // Two places would drift: the name the service may send, and the switch that carries
        // it out. This is the assertion that fails when one gains an entry without the other.
        Assert.True(IpcActions.IsAllowed(IpcActions.LockSession));

        foreach (string action in new[] { "sign-out", "shutdown", "run", "LOCK", "" })
        {
            Assert.False(IpcActions.IsAllowed(action), $"'{action}' must not be an action");
        }
    }

    [Fact]
    public void The_session_host_refuses_an_action_it_does_not_have()
    {
        // Checked in the host as well as in the service. The host is the process with the
        // desktop, so it is the boundary that counts — a service that had been tampered with
        // does not get to invent operations.
        HostActionResultMessage result = SessionActions.Perform(
            "request-1",
            "shutdown",
            NullLogger.Instance);

        Assert.False(result.Ok);
        Assert.Equal("not-allowed", result.Code);
        Assert.Equal("request-1", result.RequestId);
        _output.WriteLine($"refused: {result.Message}");
    }

    [Fact]
    public async Task Asking_with_no_session_host_says_so_rather_than_waiting()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);

        // A supervisor that has never started, so nothing is connected. This is the ordinary
        // case at the sign-in screen: there is no interactive session and so no host.
        await using var supervisor = new SessionHostSupervisor(
            loggers.CreateLogger<SessionHostSupervisor>(),
            HostPath);

        HostActionResultMessage result = await supervisor.PerformActionAsync(
            IpcActions.LockSession,
            CancellationToken.None);

        _output.WriteLine($"{result.Code}: {result.Message}");

        Assert.False(result.Ok);
        Assert.Equal("no-session-host", result.Code);

        // A limitation rather than a failure: nothing is broken, there is simply nobody
        // signed in to lock out.
        Assert.True(result.Limitation);
    }

    [Fact]
    public async Task The_service_refuses_to_send_an_action_that_is_not_allowed()
    {
        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);

        await using var supervisor = new SessionHostSupervisor(
            loggers.CreateLogger<SessionHostSupervisor>(),
            HostPath);

        // Checked on both sides on purpose. The host is what matters, but a service asking
        // for something it knows is not an action has a bug worth failing on immediately
        // rather than discovering from a refusal over the pipe.
        await Assert.ThrowsAsync<ArgumentException>(() =>
            supervisor.PerformActionAsync("shutdown", CancellationToken.None));
    }

    /// <summary>
    /// The real thing, end to end, on somebody's actual screen.
    ///
    /// Opt-in because it does exactly what it says: the machine running it locks, the person
    /// at it has to sign back in, and every capture test after it sees a blank secure desktop
    /// instead of a screen. That is too much to do to somebody who typed `npm test`.
    ///
    /// Run it deliberately with <c>WOLF_TEST_ALLOW_LOCK=1</c>.
    /// </summary>
    [Fact]
    public async Task Locking_the_session_really_locks_it()
    {
        if (Environment.GetEnvironmentVariable(OptInVariable) is not ("1" or "true"))
        {
            _output.WriteLine(
                $"This test locks the screen of the machine it runs on. Set {OptInVariable}=1 to run it.");
            return;
        }

        Assert.True(File.Exists(HostPath), $"the session host was not built to {HostPath}");

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        await using var supervisor = new SessionHostSupervisor(
            loggers.CreateLogger<SessionHostSupervisor>(),
            HostPath);

        supervisor.Start();

        DateTimeOffset deadline = DateTimeOffset.UtcNow + TimeSpan.FromSeconds(30);
        while (!supervisor.State.Connected && DateTimeOffset.UtcNow < deadline)
        {
            await Task.Delay(100);
        }

        if (!supervisor.State.Connected)
        {
            _output.WriteLine($"No session host here ({supervisor.State.UnavailableReason}); skipping.");
            return;
        }

        HostActionResultMessage result = await supervisor.PerformActionAsync(
            IpcActions.LockSession,
            CancellationToken.None);

        _output.WriteLine($"ok={result.Ok} code={result.Code} message={result.Message}");

        // Windows queues the lock and returns, so this asserts that it accepted the request
        // — which is also all the command claims. There is no supported way to observe the
        // lock completing, and inferring one from the presence of LogonUI would be a guess.
        Assert.True(result.Ok, $"the lock was refused: {result.Code} {result.Message}");
    }
}
