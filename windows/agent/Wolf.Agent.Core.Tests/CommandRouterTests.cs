using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Storage;
using Xunit;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// Command routing safety.
///
/// These tests cover the guarantees the router owes every handler: an expired command is
/// never run, an unknown command type is refused explicitly, and a redelivered command
/// returns its original outcome instead of performing the action twice.
/// </summary>
public sealed class CommandRouterTests : IDisposable
{
    private readonly string _databasePath = Path.Combine(Path.GetTempPath(), $"wolf-test-{Guid.NewGuid():N}.db");
    private readonly AgentStore _store;

    public CommandRouterTests()
    {
        _store = new AgentStore(_databasePath, NullLogger<AgentStore>.Instance);
    }

    private static CommandEnvelope Envelope(
        string type,
        string payloadJson = "{}",
        DateTimeOffset? expiresAt = null,
        string? commandId = null)
    {
        using JsonDocument payload = JsonDocument.Parse(payloadJson);
        using JsonDocument authorization = JsonDocument.Parse("""{"userId":"01J9ZQK7T0000000000000000C"}""");

        return new CommandEnvelope(
            CommandId: commandId ?? Guid.NewGuid().ToString("N"),
            PcId: "01J9ZQK7T0000000000000000A",
            RequestId: Guid.NewGuid().ToString("N"),
            IssuedAt: DateTimeOffset.UtcNow,
            ExpiresAt: expiresAt ?? DateTimeOffset.UtcNow.AddMinutes(2),
            IdempotencyKey: Guid.NewGuid().ToString("N"),
            Type: type,
            Payload: payload.RootElement.Clone(),
            Authorization: authorization.RootElement.Clone());
    }

    private CommandRouter CreateRouter(params ICommandHandler[] handlers) =>
        new(handlers, _store, "0.1.0-test", NullLogger<CommandRouter>.Instance);

    private sealed class CountingHandler : ICommandHandler
    {
        public int Calls { get; private set; }

        public IReadOnlyList<string> SupportedTypes { get; } = new[] { "process.list" };

        public Task<CommandExecution> ExecuteAsync(CommandEnvelope envelope, CancellationToken cancellationToken)
        {
            Calls++;
            return Task.FromResult(CommandExecution.Success(new { calls = Calls }));
        }
    }

    [Fact]
    public async Task An_expired_command_is_refused_rather_than_run_late()
    {
        var handler = new CountingHandler();
        CommandRouter router = CreateRouter(handler);

        CommandResultPayload result = await router.ExecuteAsync(
            Envelope("process.list", expiresAt: DateTimeOffset.UtcNow.AddSeconds(-1)),
            CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Equal("expired", result.Failure?.Code);
        Assert.Equal(0, handler.Calls);
    }

    [Fact]
    public async Task An_unknown_command_type_is_refused_explicitly()
    {
        CommandRouter router = CreateRouter(new CountingHandler());

        CommandResultPayload result = await router.ExecuteAsync(
            Envelope("terminal.execute"),
            CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Equal("unsupported-command", result.Failure?.Code);
        Assert.False(result.Failure?.Limitation);
    }

    [Fact]
    public async Task A_redelivered_command_runs_only_once()
    {
        var handler = new CountingHandler();
        CommandRouter router = CreateRouter(handler);
        CommandEnvelope envelope = Envelope("process.list", commandId: "01J9ZQK7T0000000000000000X");

        CommandResultPayload first = await router.ExecuteAsync(envelope, CancellationToken.None);
        CommandResultPayload second = await router.ExecuteAsync(envelope, CancellationToken.None);

        Assert.Equal("completed", first.Status);
        Assert.Equal("completed", second.Status);
        Assert.Equal(1, handler.Calls);
    }

    [Fact]
    public async Task A_handler_that_throws_becomes_a_reported_failure_not_a_crash()
    {
        CommandRouter router = CreateRouter(new ThrowingHandler());

        CommandResultPayload result = await router.ExecuteAsync(
            Envelope("process.list"),
            CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Equal("agent-error", result.Failure?.Code);
    }

    [Fact]
    public async Task An_access_denied_handler_reports_a_platform_limitation()
    {
        CommandRouter router = CreateRouter(new AccessDeniedHandler());

        CommandResultPayload result = await router.ExecuteAsync(
            Envelope("process.list"),
            CancellationToken.None);

        Assert.Equal("failed", result.Status);
        Assert.Equal("access-denied", result.Failure?.Code);
        Assert.True(result.Failure?.Limitation, "Windows refusing access is a limitation, not a WOLF fault");
    }

    [Fact]
    public void The_router_advertises_exactly_what_its_handlers_support()
    {
        CommandRouter router = CreateRouter(new CountingHandler());
        Assert.Equal(new[] { "process.list" }, router.SupportedTypes);
    }

    private sealed class ThrowingHandler : ICommandHandler
    {
        public IReadOnlyList<string> SupportedTypes { get; } = new[] { "process.list" };

        public Task<CommandExecution> ExecuteAsync(CommandEnvelope envelope, CancellationToken cancellationToken) =>
            throw new InvalidOperationException("the counter went away");
    }

    private sealed class AccessDeniedHandler : ICommandHandler
    {
        public IReadOnlyList<string> SupportedTypes { get; } = new[] { "process.list" };

        public Task<CommandExecution> ExecuteAsync(CommandEnvelope envelope, CancellationToken cancellationToken) =>
            throw new UnauthorizedAccessException();
    }

    public void Dispose()
    {
        _store.Dispose();
        if (File.Exists(_databasePath))
        {
            File.Delete(_databasePath);
        }
    }
}

/// <summary>
/// Process termination safety.
///
/// The PID-reuse guard is the reason these run against a real process rather than a mock:
/// the check only means anything if it reads the live process table.
/// </summary>
public sealed class ProcessSafetyTests
{
    private static CommandEnvelope TerminateEnvelope(int pid, string expectedName)
    {
        using JsonDocument payload = JsonDocument.Parse(
            $$"""{"pid": {{pid}}, "expectedName": "{{expectedName}}", "force": true, "includeChildren": false}""");
        using JsonDocument authorization = JsonDocument.Parse("{}");

        return new CommandEnvelope(
            CommandId: Guid.NewGuid().ToString("N"),
            PcId: "01J9ZQK7T0000000000000000A",
            RequestId: Guid.NewGuid().ToString("N"),
            IssuedAt: DateTimeOffset.UtcNow,
            ExpiresAt: DateTimeOffset.UtcNow.AddMinutes(1),
            IdempotencyKey: Guid.NewGuid().ToString("N"),
            Type: "process.terminate",
            Payload: payload.RootElement.Clone(),
            Authorization: authorization.RootElement.Clone());
    }

    [Fact]
    public async Task Terminating_a_pid_whose_process_changed_is_refused()
    {
        var handler = new ProcessCommandHandler(NullLogger<ProcessCommandHandler>.Instance);

        using Process process = Process.Start(new ProcessStartInfo("cmd.exe", "/c timeout /t 30 /nobreak")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        })!;

        try
        {
            CommandExecution result = await handler.ExecuteAsync(
                TerminateEnvelope(process.Id, "definitely-not-cmd"),
                CancellationToken.None);

            Assert.NotNull(result.Failure);
            Assert.Equal("target-changed", result.Failure!.Code);
            Assert.False(process.HasExited, "the wrong process must not be terminated");
        }
        finally
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
    }

    [Fact]
    public async Task Terminating_a_matching_process_succeeds()
    {
        var handler = new ProcessCommandHandler(NullLogger<ProcessCommandHandler>.Instance);

        using Process process = Process.Start(new ProcessStartInfo("cmd.exe", "/c timeout /t 30 /nobreak")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        })!;

        CommandExecution result = await handler.ExecuteAsync(
            TerminateEnvelope(process.Id, "cmd.exe"),
            CancellationToken.None);

        Assert.Null(result.Failure);
        Assert.True(process.WaitForExit(5000));
    }

    [Fact]
    public async Task Critical_windows_processes_are_never_terminated()
    {
        var handler = new ProcessCommandHandler(NullLogger<ProcessCommandHandler>.Instance);

        Process[] candidates = Process.GetProcessesByName("lsass");
        if (candidates.Length == 0)
        {
            return; // Nothing to assert against on this machine.
        }

        int pid = candidates[0].Id;
        foreach (Process candidate in candidates)
        {
            candidate.Dispose();
        }

        CommandExecution result = await handler.ExecuteAsync(
            TerminateEnvelope(pid, "lsass.exe"),
            CancellationToken.None);

        Assert.NotNull(result.Failure);
        Assert.Equal("blocked-by-policy", result.Failure!.Code);
        Assert.True(result.Failure.Limitation);
    }
}
