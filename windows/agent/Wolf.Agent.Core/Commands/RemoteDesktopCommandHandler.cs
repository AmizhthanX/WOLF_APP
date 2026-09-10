using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Sessions;
using Wolf.Agent.Core.Storage;

namespace Wolf.Agent.Core.Commands;

/// <summary>
/// Remote desktop control surface.
///
/// Starting a stream is a signaling exchange, not a command, so what lives here is the
/// question every client asks first: can this PC stream right now, what can it show, and
/// stop what is running.
///
/// The status answer is the honest core of the feature. "No" has several distinct causes —
/// nobody is signed in, the workstation is locked, there is no encoder, the capture
/// pipeline is not implemented in this build — and the client is told which, because
/// "wait a moment" and "this will never work here" call for different responses from the
/// person at the other end.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class RemoteDesktopCommandHandler : ICommandHandler
{
    private readonly SessionHostSupervisor _sessionHost;
    private readonly WindowsSessionMonitor _sessions;
    private readonly AgentStore _store;
    private readonly Func<bool> _secureDesktop;
    private readonly ILogger<RemoteDesktopCommandHandler> _logger;

    public RemoteDesktopCommandHandler(
        SessionHostSupervisor sessionHost,
        WindowsSessionMonitor sessions,
        SecureDesktopSupervisor secureDesktop,
        AgentStore store,
        ILogger<RemoteDesktopCommandHandler> logger)
    {
        _sessionHost = sessionHost;
        _sessions = sessions;
        _store = store;
        // Asked at call time, like the capability report: whether a host could be put on the
        // secure desktop is the difference between a locked PC that can be streamed and one
        // that cannot, and the two answers must not come from different moments.
        _secureDesktop = secureDesktop.CanCapture;
        _logger = logger;
    }

    public IReadOnlyList<string> SupportedTypes { get; } = new[]
    {
        "remote-desktop.list-displays",
        "remote-desktop.status",
        "remote-desktop.stop",
    };

    public async Task<CommandExecution> ExecuteAsync(
        CommandEnvelope envelope,
        CancellationToken cancellationToken)
    {
        return envelope.Type switch
        {
            "remote-desktop.list-displays" => ListDisplays(),
            "remote-desktop.status" => Status(),
            "remote-desktop.stop" => await StopAsync(envelope.Payload, cancellationToken)
                .ConfigureAwait(false),
            _ => CommandExecution.Failed("unsupported-command", $"Unhandled type {envelope.Type}."),
        };
    }

    private CommandExecution ListDisplays()
    {
        SessionHostState host = _sessionHost.State;

        if (!host.Connected)
        {
            return CommandExecution.Limitation(
                "capability-unavailable",
                host.UnavailableReason ?? "The WOLF session host is not running.",
                "Displays can only be enumerated from inside the signed-in session.");
        }

        return CommandExecution.Success(new
        {
            displays = host.Displays,
            observedAt = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private CommandExecution Status()
    {
        SessionHostState host = _sessionHost.State;
        SystemSessionStateResult session = _sessions.Query();

        (bool available, string? reason) = RemoteDesktopAvailability.Evaluate(
            host, session.State, _store.KillSwitchEngaged, _secureDesktop());

        return CommandExecution.Success(new
        {
            available,
            unavailableReason = reason,
            sessionHostRunning = host.Connected,
            sessionHostVersion = host.HostVersion,
            windowsSessionState = session.State,
            availableEncoders = host.Encoders.Select(encoder => encoder.Id).ToArray(),
            displayCount = host.Displays.Count,

            // What is actually running, from the host that is running it. An empty array
            // here used to be a placeholder; now it means there are no streams.
            activeStreams = host.Streams
                .Select(stream => new
                {
                    streamId = stream.StreamId,
                    sessionId = stream.SessionId,
                    state = stream.State,
                    startedAt = stream.StartedAt,
                })
                .ToArray(),
            observedAt = DateTimeOffset.UtcNow.ToString("o"),
        });
    }

    private async Task<CommandExecution> StopAsync(JsonElement payload, CancellationToken cancellationToken)
    {
        string? streamId = payload.TryGetProperty("streamId", out JsonElement element) &&
                           element.ValueKind == JsonValueKind.String
            ? element.GetString()
            : null;

        SessionHostState host = _sessionHost.State;
        int running = host.ActiveStreams;

        bool delivered = await _sessionHost
            .SendAsync(new ServiceStopMessage(streamId, "operator-stopped"), cancellationToken)
            .ConfigureAwait(false);

        if (!delivered && running > 0)
        {
            return CommandExecution.Failed(
                "capability-unavailable",
                "The WOLF session host is not reachable, so streams could not be stopped.",
                "The host is restarted automatically; the streams end with it.");
        }

        _store.RecordLocalAudit("remote-desktop.stop", "success", new { streamId, running });
        _logger.LogInformation("Stopped {Count} stream(s) at the operator request.", running);

        return CommandExecution.Success(new
        {
            stopped = running,
            observedAt = DateTimeOffset.UtcNow.ToString("o"),
        });
    }
}
