using System.Net.WebSockets;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Commands;
using Wolf.Agent.Core.Identity;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.Core.Protocol;
using Wolf.Agent.Core.Sessions;
using Wolf.Agent.Core.Storage;
using Wolf.Agent.Core.Telemetry;

namespace Wolf.Agent.Core.Cloud;

/// <summary>
/// The agent's link to the WOLF cloud.
///
/// The PC always dials out, so no inbound port is ever opened on the machine. The link is
/// authenticated by signing a per-connection nonce with the PC's private key, which means
/// intercepting traffic is not enough to impersonate this machine.
///
/// Losing the link is treated as normal, not exceptional: telemetry keeps being collected
/// into the local store, command results that could not be delivered are queued, and the
/// agent reconnects with exponential backoff. Nothing here ever disables the agent because
/// the cloud is unreachable.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class CloudLink
{
    private const int ReceiveBufferBytes = 64 * 1024;
    private const int TelemetryBatchSize = 120;

    private readonly AgentOptions _options;
    private readonly PcIdentity _identity;
    private readonly CommandRouter _router;
    private readonly TelemetryCollector _telemetry;
    private readonly AgentStore _store;
    private readonly WindowsSessionMonitor _sessions;
    private readonly MachineInfoProvider _machine;
    private readonly SessionHostSupervisor _sessionHost;
    private readonly ILogger<CloudLink> _logger;
    private readonly string _agentVersion;

    private ClientWebSocket? _socket;
    private string _lastReportedSessionState = "unknown";

    public CloudLink(
        AgentOptions options,
        PcIdentity identity,
        CommandRouter router,
        TelemetryCollector telemetry,
        AgentStore store,
        WindowsSessionMonitor sessions,
        MachineInfoProvider machine,
        SessionHostSupervisor sessionHost,
        string agentVersion,
        ILogger<CloudLink> logger)
    {
        _options = options;
        _identity = identity;
        _router = router;
        _telemetry = telemetry;
        _store = store;
        _sessions = sessions;
        _machine = machine;
        _sessionHost = sessionHost;
        _agentVersion = agentVersion;
        _logger = logger;

        // Signaling the host produces goes straight up to the cloud. It is real-time by
        // nature: if the link is down there is nothing useful to queue, because an SDP
        // answer that arrives a minute late describes a negotiation nobody is waiting for.
        _sessionHost.SignalReceived += OnHostSignalAsync;
    }

    private async Task OnHostSignalAsync(HostSignalMessage signal)
    {
        ClientWebSocket? socket = _socket;
        if (socket is null || socket.State != WebSocketState.Open)
        {
            _logger.LogWarning(
                "Dropped a signaling message for stream {Stream}: the cloud link is down.",
                signal.StreamId);
            return;
        }

        try
        {
            await SendAsync(
                socket,
                new
                {
                    kind = "agent.signal",
                    protocolVersion = WolfProtocol.Version,
                    envelope = new
                    {
                        protocolVersion = WolfProtocol.Version,
                        sessionId = signal.SessionId,
                        streamId = signal.StreamId,
                        sentAt = DateTimeOffset.UtcNow.ToString("o"),
                        payload = signal.Payload,
                    },
                },
                CancellationToken.None).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or InvalidOperationException)
        {
            _logger.LogWarning("Could not forward a signaling message; the cloud link dropped.");
        }
    }

    /// <summary>Connect, serve, reconnect. Returns only when cancellation is requested.</summary>
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        int delaySeconds = _options.ReconnectBaseDelaySeconds;

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await RunSessionAsync(cancellationToken).ConfigureAwait(false);
                delaySeconds = _options.ReconnectBaseDelaySeconds;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "The cloud link dropped; reconnecting in {Delay}s.", delaySeconds);
            }

            // Jitter keeps a fleet of agents from reconnecting in lockstep after an outage.
            int jitter = Random.Shared.Next(0, Math.Max(1, delaySeconds / 2 + 1));
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(delaySeconds + jitter), cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            delaySeconds = Math.Min(delaySeconds * 2, _options.ReconnectMaxDelaySeconds);
        }
    }

    private async Task RunSessionAsync(CancellationToken cancellationToken)
    {
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        _socket = socket;

        _logger.LogInformation("Connecting to {Url}.", _options.RealtimeUrl);
        await socket.ConnectAsync(new Uri(_options.RealtimeUrl), cancellationToken).ConfigureAwait(false);

        using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task? heartbeat = null;
        Task? telemetry = null;

        try
        {
            await foreach (JsonDocument message in ReadMessagesAsync(socket, sessionCts.Token).ConfigureAwait(false))
            {
                using (message)
                {
                    string kind = message.RootElement.TryGetProperty("kind", out JsonElement kindElement)
                        ? kindElement.GetString() ?? string.Empty
                        : string.Empty;

                    switch (kind)
                    {
                        case "cloud.challenge":
                            await RespondToChallengeAsync(socket, message.RootElement, sessionCts.Token)
                                .ConfigureAwait(false);
                            break;

                        case "cloud.auth-accepted":
                            await OnAuthenticatedAsync(socket, sessionCts.Token).ConfigureAwait(false);
                            heartbeat ??= HeartbeatLoopAsync(socket, sessionCts.Token);
                            telemetry ??= TelemetryLoopAsync(socket, sessionCts.Token);
                            break;

                        case "cloud.auth-rejected":
                            HandleAuthRejected(message.RootElement);
                            return;

                        case "cloud.command":
                            await HandleCommandAsync(socket, message.RootElement, sessionCts.Token)
                                .ConfigureAwait(false);
                            break;

                        case "cloud.kill-switch":
                            HandleKillSwitch(message.RootElement);
                            break;

                        case "cloud.signal":
                            await HandleSignalAsync(message.RootElement, sessionCts.Token)
                                .ConfigureAwait(false);
                            break;

                        case "cloud.cancel":
                        case "cloud.ping":
                            break;

                        default:
                            _logger.LogDebug("Ignored an unrecognised cloud message of kind {Kind}.", kind);
                            break;
                    }
                }
            }
        }
        finally
        {
            await sessionCts.CancelAsync().ConfigureAwait(false);
            await AwaitQuietly(heartbeat).ConfigureAwait(false);
            await AwaitQuietly(telemetry).ConfigureAwait(false);
            _socket = null;
        }
    }

    // -----------------------------------------------------------------------
    // Handshake
    // -----------------------------------------------------------------------

    private async Task RespondToChallengeAsync(
        ClientWebSocket socket,
        JsonElement message,
        CancellationToken cancellationToken)
    {
        string nonce = message.GetProperty("nonce").GetString() ?? string.Empty;
        string payload = WolfProtocol.ChallengeSigningPayload(_identity.PcId, nonce);

        // DER-encoded ECDSA, matching what the cloud's verifier expects.
        byte[] signature = _identity.Key.SignData(
            Encoding.UTF8.GetBytes(payload),
            HashAlgorithmName.SHA256,
            DSASignatureFormat.Rfc3279DerSequence);

        await SendAsync(
            socket,
            new AgentAuthMessage(_identity.PcId, _agentVersion, Base64Url.Encode(signature), nonce),
            cancellationToken).ConfigureAwait(false);
    }

    private void HandleAuthRejected(JsonElement message)
    {
        string reason = message.TryGetProperty("reason", out JsonElement reasonElement)
            ? reasonElement.GetString() ?? "unknown"
            : "unknown";
        int retryAfter = message.TryGetProperty("retryAfterSeconds", out JsonElement retryElement)
            ? retryElement.GetInt32()
            : 60;

        // A revoked PC must not hammer the cloud. The backoff loop handles the delay; what
        // matters here is that the failure is recorded locally, where an operator at the
        // machine can see why it stopped connecting.
        _logger.LogError(
            "The cloud refused this PC's identity ({Reason}). Retrying no sooner than {RetryAfter}s.",
            reason,
            retryAfter);
        _store.RecordLocalAudit("cloud.auth", "failure", new { reason });
    }

    private async Task OnAuthenticatedAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        SystemSessionStateResult session = _sessions.Query();
        _lastReportedSessionState = session.State;

        await SendAsync(
            socket,
            new AgentHelloMessage(
                _machine.Describe(_agentVersion),
                _machine.DescribeCapabilities(_router.SupportedTypes, session.State),
                session.State,
                _store.KillSwitchEngaged,
                _store.PendingResults().Count),
            cancellationToken).ConfigureAwait(false);

        _logger.LogInformation("Cloud link established for PC {PcId}.", _identity.PcId);
        _store.RecordLocalAudit("cloud.connect", "success");

        // Deliver anything produced while the link was down, so an action that really
        // happened is never left showing as merely pending.
        foreach (CommandResultPayload queued in _store.PendingResults())
        {
            await SendAsync(socket, new AgentCommandResultMessage(queued), cancellationToken)
                .ConfigureAwait(false);
            _store.DeleteResult(queued.CommandId);
        }
    }

    // -----------------------------------------------------------------------
    // Commands
    // -----------------------------------------------------------------------

    private async Task HandleCommandAsync(
        ClientWebSocket socket,
        JsonElement message,
        CancellationToken cancellationToken)
    {
        JsonElement envelopeElement = message.GetProperty("envelope");
        JsonElement commandElement = envelopeElement.GetProperty("command");

        var envelope = new CommandEnvelope(
            CommandId: envelopeElement.GetProperty("commandId").GetString() ?? string.Empty,
            PcId: envelopeElement.GetProperty("pcId").GetString() ?? string.Empty,
            RequestId: envelopeElement.GetProperty("requestId").GetString() ?? string.Empty,
            IssuedAt: envelopeElement.GetProperty("issuedAt").GetDateTimeOffset(),
            ExpiresAt: envelopeElement.GetProperty("expiresAt").GetDateTimeOffset(),
            IdempotencyKey: envelopeElement.GetProperty("idempotencyKey").GetString() ?? string.Empty,
            Type: commandElement.GetProperty("type").GetString() ?? string.Empty,
            Payload: commandElement.GetProperty("payload").Clone(),
            Authorization: envelopeElement.GetProperty("authorization").Clone());

        // A command addressed to another PC is either a routing bug or an attack. Either
        // way this machine does not run it.
        if (!string.Equals(envelope.PcId, _identity.PcId, StringComparison.Ordinal))
        {
            _logger.LogError(
                "Refused command {CommandId}: it is addressed to {PcId}, not this PC.",
                envelope.CommandId,
                envelope.PcId);
            _store.RecordLocalAudit("command.misaddressed", "failure", new { envelope.CommandId });
            return;
        }

        // The local kill switch is the operator's own override and outranks the cloud.
        if (_store.KillSwitchEngaged)
        {
            var refusal = new CommandResultPayload(
                envelope.CommandId,
                "failed",
                DateTimeOffset.UtcNow.ToString("o"),
                DateTimeOffset.UtcNow.ToString("o"),
                new CommandFailurePayload(
                    "blocked-by-kill-switch",
                    "Remote access is disabled on this PC by the local kill switch.",
                    Limitation: false,
                    "Release the kill switch in the WOLF Control Panel on the PC."),
                null,
                _agentVersion);

            await DeliverResultAsync(socket, refusal, cancellationToken).ConfigureAwait(false);
            return;
        }

        _logger.LogInformation("Running {Type} ({CommandId}).", envelope.Type, envelope.CommandId);
        CommandResultPayload result = await _router.ExecuteAsync(envelope, cancellationToken)
            .ConfigureAwait(false);
        _store.RecordLocalAudit(envelope.Type, result.Status, new { envelope.CommandId });

        await DeliverResultAsync(socket, result, cancellationToken).ConfigureAwait(false);
    }

    private async Task DeliverResultAsync(
        ClientWebSocket socket,
        CommandResultPayload result,
        CancellationToken cancellationToken)
    {
        // Queue first, then send. If the link dies mid-send the result survives; a duplicate
        // delivery is harmless because the cloud resolves results by command id.
        _store.EnqueueResult(result);
        try
        {
            await SendAsync(socket, new AgentCommandResultMessage(result), cancellationToken)
                .ConfigureAwait(false);
            _store.DeleteResult(result.CommandId);
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or InvalidOperationException)
        {
            _logger.LogWarning(
                "Could not deliver the result for {CommandId}; it is queued for the next connection.",
                result.CommandId);
        }
    }

    /// <summary>
    /// Pass a client signaling message to the session host.
    ///
    /// The agent service does not interpret SDP or ICE; it routes them. What it does check
    /// is the local kill switch, because a stream is exactly the kind of thing an operator
    /// engages that switch to stop.
    /// </summary>
    private async Task HandleSignalAsync(JsonElement message, CancellationToken cancellationToken)
    {
        JsonElement envelope = message.GetProperty("envelope");
        string sessionId = envelope.GetProperty("sessionId").GetString() ?? string.Empty;
        string streamId = envelope.GetProperty("streamId").GetString() ?? string.Empty;

        if (_store.KillSwitchEngaged)
        {
            _logger.LogInformation("Refused signaling for stream {Stream}: kill switch engaged.", streamId);
            await OnHostSignalAsync(
                new HostSignalMessage(
                    sessionId,
                    streamId,
                    JsonSerializer.SerializeToElement(
                        new
                        {
                            type = "stream.error",
                            code = "blocked-by-kill-switch",
                            message = "Remote access is disabled on this PC by the local kill switch.",
                            limitation = false,
                            recommendedAction =
                                "Release the kill switch in the WOLF Control Panel on the PC.",
                        },
                        WolfProtocol.Json))).ConfigureAwait(false);
            return;
        }

        bool delivered = await _sessionHost
            .SendAsync(
                new ServiceSignalMessage(
                    sessionId,
                    streamId,
                    envelope.GetProperty("payload").Clone(),
                    ReadIceServers(message),
                    message.TryGetProperty("audioAllowed", out JsonElement audioAllowed) &&
                        audioAllowed.ValueKind == JsonValueKind.True,
                    message.TryGetProperty("clipboardAllowed", out JsonElement clipboardAllowed) &&
                        clipboardAllowed.ValueKind == JsonValueKind.True),
                cancellationToken)
            .ConfigureAwait(false);

        if (!delivered)
        {
            // No host means no desktop to stream. Say which, rather than letting the client
            // wait for an offer that is never coming.
            SessionHostState host = _sessionHost.State;
            await OnHostSignalAsync(
                new HostSignalMessage(
                    sessionId,
                    streamId,
                    JsonSerializer.SerializeToElement(
                        new
                        {
                            type = "stream.error",
                            code = "no-session-host",
                            message = host.UnavailableReason ?? "The WOLF session host is not running.",
                            limitation = true,
                            recommendedAction =
                                "Streaming needs somebody signed in at this PC. It resumes on its own once they are.",
                        },
                        WolfProtocol.Json))).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// ICE servers the cloud attached to this message, if any.
    ///
    /// Read defensively rather than deserialised as a whole: a signaling message with a
    /// malformed server list is still a signaling message, and refusing to route it would
    /// turn a cloud configuration mistake into a dead stream instead of a LAN-only one.
    /// </summary>
    private static IReadOnlyList<IpcIceServer>? ReadIceServers(JsonElement message)
    {
        if (!message.TryGetProperty("iceServers", out JsonElement servers) ||
            servers.ValueKind != JsonValueKind.Array)
        {
            return null;
        }

        var parsed = new List<IpcIceServer>();

        foreach (JsonElement server in servers.EnumerateArray())
        {
            if (!server.TryGetProperty("urls", out JsonElement urls) ||
                urls.ValueKind != JsonValueKind.Array)
            {
                continue;
            }

            var addresses = urls
                .EnumerateArray()
                .Where(url => url.ValueKind == JsonValueKind.String)
                .Select(url => url.GetString()!)
                .ToArray();

            if (addresses.Length == 0) continue;

            parsed.Add(new IpcIceServer(
                addresses,
                ReadString(server, "username"),
                ReadString(server, "credential")));
        }

        return parsed;
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private void HandleKillSwitch(JsonElement message)
    {
        bool remoteAccessEnabled = message.TryGetProperty("remoteAccessEnabled", out JsonElement element) &&
                                   element.GetBoolean();

        if (!remoteAccessEnabled)
        {
            _store.KillSwitchEngaged = true;
            _store.RecordLocalAudit("kill-switch.engage", "success", new { source = "cloud" });
            _logger.LogWarning("Remote access was disabled from the cloud.");
            return;
        }

        // The cloud can only ever turn remote access off. Re-enabling requires a local
        // operator at this PC, so a "true" here is reconciliation, never an instruction.
        _logger.LogInformation(
            "The cloud reports remote access as enabled; the local kill switch is unchanged ({Engaged}).",
            _store.KillSwitchEngaged);
    }

    // -----------------------------------------------------------------------
    // Periodic work
    // -----------------------------------------------------------------------

    private async Task HeartbeatLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            try
            {
                SystemSessionStateResult session = _sessions.Query();

                await SendAsync(
                    socket,
                    new AgentHeartbeatMessage(
                        DateTimeOffset.UtcNow.ToString("o"),
                        session.State,
                        _store.KillSwitchEngaged,
                        0),
                    cancellationToken).ConfigureAwait(false);

                // A lock or sign-in transition is worth reporting immediately rather than
                // waiting for the next heartbeat, because it changes what a client may do.
                if (!string.Equals(session.State, _lastReportedSessionState, StringComparison.Ordinal))
                {
                    _lastReportedSessionState = session.State;
                    await SendAsync(
                        socket,
                        new AgentEventMessage(new AgentEventPayload(
                            DateTimeOffset.UtcNow.ToString("o"),
                            "session-state-changed",
                            new Dictionary<string, object?> { ["state"] = session.State })),
                        cancellationToken).ConfigureAwait(false);
                }

                await Task.Delay(TimeSpan.FromSeconds(_options.HeartbeatSeconds), cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or InvalidOperationException)
            {
                return;
            }
        }
    }

    private async Task TelemetryLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && socket.State == WebSocketState.Open)
        {
            try
            {
                IReadOnlyList<(long Id, string Payload)> queued = _store.PeekTelemetry(TelemetryBatchSize);
                if (queued.Count > 0)
                {
                    var samples = new List<JsonElement>(queued.Count);
                    var documents = new List<JsonDocument>(queued.Count);
                    try
                    {
                        foreach ((_, string payload) in queued)
                        {
                            JsonDocument document = JsonDocument.Parse(payload);
                            documents.Add(document);
                            samples.Add(document.RootElement.Clone());
                        }

                        await SendAsync(
                            socket,
                            new AgentTelemetryMessage(new TelemetryBatchPayload(samples, Backfill: queued.Count > 30)),
                            cancellationToken).ConfigureAwait(false);

                        // Only drop the local copies once the cloud has them.
                        _store.DeleteTelemetry(queued.Select(entry => entry.Id));
                    }
                    finally
                    {
                        foreach (JsonDocument document in documents)
                        {
                            document.Dispose();
                        }
                    }
                }

                await Task.Delay(TimeSpan.FromSeconds(_options.TelemetryUploadSeconds), cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or InvalidOperationException)
            {
                return;
            }
            catch (JsonException ex)
            {
                _logger.LogError(ex, "A buffered telemetry sample could not be parsed; dropping the batch.");
                _store.DeleteTelemetry(_store.PeekTelemetry(TelemetryBatchSize).Select(entry => entry.Id));
            }
        }
    }

    // -----------------------------------------------------------------------
    // Transport
    // -----------------------------------------------------------------------

    private static async Task SendAsync<T>(ClientWebSocket socket, T message, CancellationToken cancellationToken)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(message, WolfProtocol.Json);
        await socket.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, cancellationToken)
            .ConfigureAwait(false);
    }

    private static async IAsyncEnumerable<JsonDocument> ReadMessagesAsync(
        ClientWebSocket socket,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    {
        byte[] buffer = new byte[ReceiveBufferBytes];

        while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
        {
            using var stream = new MemoryStream();
            WebSocketReceiveResult result;

            do
            {
                result = await socket.ReceiveAsync(buffer, cancellationToken).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    yield break;
                }

                stream.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            stream.Position = 0;
            JsonDocument? document;
            try
            {
                document = JsonDocument.Parse(stream);
            }
            catch (JsonException)
            {
                // A frame the cloud could not have sent. Ignore it rather than tearing down
                // a working link.
                continue;
            }

            yield return document;
        }
    }

    private static async Task AwaitQuietly(Task? task)
    {
        if (task is null)
        {
            return;
        }

        try
        {
            await task.ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is OperationCanceledException or WebSocketException)
        {
        }
    }
}
