using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Ipc;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The service-to-session-host bridge, exercised against the real host executable.
///
/// This is the seam that makes remote desktop possible at all: a service in session 0
/// cannot see a desktop, so it launches a process that can and talks to it over a named
/// pipe. Mocking the pipe would test the mock. These tests start the actual host, wait for
/// it to report in, and check that what arrives is a real description of this machine.
/// </summary>
[Collection("SessionHost")]
public sealed class SessionHostSupervisorTests
{
    private readonly ITestOutputHelper _output;

    public SessionHostSupervisorTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private static string HostPath =>
        Path.Combine(AppContext.BaseDirectory, "Wolf.Agent.SessionHost.exe");

    private static async Task<SessionHostState> WaitForConnectionAsync(
        SessionHostSupervisor supervisor,
        TimeSpan timeout)
    {
        DateTimeOffset deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            SessionHostState state = supervisor.State;
            if (state.Connected) return state;
            await Task.Delay(100);
        }

        return supervisor.State;
    }

    [Fact]
    public async Task The_supervisor_launches_the_host_and_learns_what_the_machine_can_do()
    {
        Assert.True(File.Exists(HostPath), $"the session host was not built to {HostPath}");

        await using var supervisor = new SessionHostSupervisor(
            NullLogger<SessionHostSupervisor>.Instance,
            HostPath);

        // Before it starts, the supervisor says why there is nothing rather than implying
        // the machine simply has no displays.
        Assert.False(supervisor.State.Connected);
        Assert.NotNull(supervisor.State.UnavailableReason);

        supervisor.Start();
        SessionHostState state = await WaitForConnectionAsync(supervisor, TimeSpan.FromSeconds(30));

        _output.WriteLine(
            $"connected={state.Connected} session={state.WindowsSessionId} user={state.UserName} " +
            $"host={state.HostVersion} captureApi={state.CaptureApi} " +
            $"displays={state.Displays.Count} encoders={state.Encoders.Count}");

        Assert.True(state.Connected, $"the host never connected: {state.UnavailableReason}");
        Assert.Null(state.UnavailableReason);
        Assert.NotNull(state.HostVersion);

        foreach (IpcDisplay display in state.Displays)
        {
            _output.WriteLine($"  display {display.Id} {display.WidthPixels}x{display.HeightPixels}");
            Assert.InRange(display.WidthPixels, 1, 32_768);
        }

        foreach (IpcEncoder encoder in state.Encoders)
        {
            _output.WriteLine($"  encoder {encoder.Id} hardware={encoder.Hardware}");
        }
    }

    [Fact]
    public async Task A_host_that_can_capture_and_deliver_says_so_and_the_stream_is_offered()
    {
        await using var supervisor = new SessionHostSupervisor(
            NullLogger<SessionHostSupervisor>.Instance,
            HostPath);

        supervisor.Start();
        SessionHostState state = await WaitForConnectionAsync(supervisor, TimeSpan.FromSeconds(30));
        Assert.True(state.Connected, $"the host never connected: {state.UnavailableReason}");

        // Capture and transport are reported separately because they fail independently.
        // This machine has both, so the availability decision — the one the dashboard acts
        // on — must come back yes, with no reason attached.
        _output.WriteLine(
            $"captureApi={state.CaptureApi} transport={state.TransportAvailable} " +
            $"displays={state.Displays.Count} encoders={state.Encoders.Count}");

        Assert.NotEqual("none", state.CaptureApi);
        Assert.True(state.TransportAvailable);

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            state, "desktop", killSwitchEngaged: false);
        Assert.True(available, $"a capable host was refused: {reason}");
        Assert.Null(reason);

        using var payload = System.Text.Json.JsonDocument.Parse("""{"type":"stream.request"}""");
        bool delivered = await supervisor.SendAsync(
            new ServiceSignalMessage("01J9ZQK7T0000000000000000A", "01J9ZQK7T0000000000000000B", payload.RootElement),
            CancellationToken.None);

        Assert.True(delivered, "the message should reach a connected host");
    }

    [Fact]
    public async Task Sending_without_a_host_fails_rather_than_blocking()
    {
        await using var supervisor = new SessionHostSupervisor(
            NullLogger<SessionHostSupervisor>.Instance,
            Path.Combine(AppContext.BaseDirectory, "does-not-exist.exe"));

        using var payload = System.Text.Json.JsonDocument.Parse("{}");
        bool delivered = await supervisor.SendAsync(
            new ServiceSignalMessage("a", "b", payload.RootElement),
            CancellationToken.None);

        Assert.False(delivered);
    }

    [Fact]
    public async Task A_missing_host_executable_is_reported_rather_than_retried_silently()
    {
        await using var supervisor = new SessionHostSupervisor(
            NullLogger<SessionHostSupervisor>.Instance,
            Path.Combine(AppContext.BaseDirectory, "does-not-exist.exe"));

        supervisor.Start();
        await Task.Delay(TimeSpan.FromSeconds(2));

        SessionHostState state = supervisor.State;
        Assert.False(state.Connected);
        Assert.NotNull(state.UnavailableReason);
        _output.WriteLine($"reason: {state.UnavailableReason}");
        Assert.Contains("session host", state.UnavailableReason!, StringComparison.OrdinalIgnoreCase);
    }
}

/// <summary>
/// The supervisor binds a fixed named pipe, so only one of these tests may run at a time.
/// </summary>
[CollectionDefinition("SessionHost", DisableParallelization = true)]
public sealed class SessionHostCollection
{
}
