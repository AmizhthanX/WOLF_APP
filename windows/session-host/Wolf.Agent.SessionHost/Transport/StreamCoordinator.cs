using System.Collections.Concurrent;
using System.Runtime.Versioning;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Displays;

namespace Wolf.Agent.SessionHost.Transport;

/// <summary>
/// Routes signaling to the stream it belongs to, and owns the streams that exist.
///
/// Streams are keyed by the id the cloud assigned, so a second display can be opened
/// without disturbing the first, and a stop for one stream does not take down the other.
/// Nothing here interprets SDP or ICE — that is the transport's job — but everything here
/// checks that a message is for a stream that exists before acting on it.
/// </summary>
[SupportedOSPlatform("windows10.0.19041.0")]
public sealed class StreamCoordinator : IDisposable
{
    /// <summary>
    /// How many streams one PC will run at once.
    ///
    /// Each one is a capture pipeline and a hardware encoder session. The limit exists
    /// because the honest failure — "this PC is already streaming two displays" — is far
    /// better than the alternative, which is every stream degrading until none of them work.
    /// </summary>
    private const int MaxConcurrentStreams = 2;

    private readonly ConcurrentDictionary<string, StreamSession> _streams = new(StringComparer.Ordinal);
    private readonly DisplayEnumerator _displays;
    private readonly Func<HostSignalMessage, CancellationToken, Task> _send;
    private readonly ILoggerFactory _loggers;
    private readonly ILogger<StreamCoordinator> _logger;

    /// <summary>
    /// True when every stream here must capture through Desktop Duplication.
    ///
    /// Set for the host on the secure desktop, where Graphics Capture has no item to create.
    /// </summary>
    private readonly bool _preferDuplication;

    public StreamCoordinator(
        DisplayEnumerator displays,
        Func<HostSignalMessage, CancellationToken, Task> send,
        ILoggerFactory loggers,
        bool preferDuplication = false)
    {
        _displays = displays;
        _send = send;
        _loggers = loggers;
        _preferDuplication = preferDuplication;
        _logger = loggers.CreateLogger<StreamCoordinator>();
    }

    public int ActiveStreams => _streams.Count;

    /// <summary>
    /// Put a frame of the secure desktop on every running stream.
    ///
    /// Every stream, because they are all watching the same PC and the lock screen is what
    /// the PC is showing. There is no per-stream choice to make: a client that asked for this
    /// display is being shown what is on it.
    /// </summary>
    public void SendSecureFrame(byte[] data, bool keyFrame, int width, int height)
    {
        foreach (StreamSession session in _streams.Values)
        {
            session.SendSecureFrame(data, keyFrame, width, height);
        }
    }

    /// <summary>Tell every running stream whether the secure desktop is what it is showing.</summary>
    public void SetSecureDesktopActive(bool active, string? reason)
    {
        foreach (StreamSession session in _streams.Values)
        {
            session.SetSecureDesktopActive(active, reason);
        }
    }

    /// <summary>
    /// What is running, for the periodic status report.
    ///
    /// Built from the live sessions rather than from a counter kept alongside them, so a
    /// stream that failed to tear down cleanly shows up here instead of being invisible.
    /// </summary>
    public IReadOnlyList<IpcStreamStatus> Describe() =>
        _streams.Values
            .Select(stream => new IpcStreamStatus(
                stream.StreamId,
                stream.SessionId,
                stream.State,
                stream.StartedAt))
            .ToArray();

    public async Task HandleAsync(ServiceSignalMessage signal, CancellationToken cancellationToken)
    {
        string? type = ReadType(signal.Payload);
        if (type is null)
        {
            _logger.LogWarning("A signaling message without a type was ignored.");
            return;
        }

        SignalSender send = (payloadType, payload) => SendAsync(signal, payloadType, payload);

        switch (type)
        {
            case SignalTypes.StreamRequest:
                await StartAsync(signal, send, cancellationToken).ConfigureAwait(false);
                return;

            case SignalTypes.SdpAnswer:
                if (TryFind(signal, out StreamSession? answering))
                {
                    string? sdp = ReadString(signal.Payload, "sdp");
                    if (sdp is not null) answering.AcceptAnswer(sdp);
                }

                return;

            case SignalTypes.IceCandidate:
                if (TryFind(signal, out StreamSession? candidateTarget))
                {
                    SignalCandidate? candidate = Deserialize<SignalCandidate>(signal.Payload);
                    if (candidate is not null) candidateTarget.AddCandidate(candidate);
                }

                return;

            case SignalTypes.IceComplete:
                // Nothing to do: the transport does not wait on the client's gathering to
                // finish, and a candidate that arrives after this would still be tried.
                return;

            case SignalTypes.InputControl:
                if (TryFind(signal, out StreamSession? controlled))
                {
                    controlled.ApplyInputControl(
                        ReadBool(signal.Payload, "granted"),
                        ReadString(signal.Payload, "holderSessionId"),
                        ReadTimestamp(signal.Payload, "expiresAt"));
                }

                return;

            case SignalTypes.SetDisplay:
                if (TryFind(signal, out StreamSession? switching))
                {
                    await switching.ApplyDisplayAsync(ReadString(signal.Payload, "displayId"))
                        .ConfigureAwait(false);
                }

                return;

            case SignalTypes.SetProfile:
                if (TryFind(signal, out StreamSession? profiled))
                {
                    SignalProfile? profile = ReadProfile(signal.Payload);
                    if (profile is not null) await profiled.ApplyProfileAsync(profile).ConfigureAwait(false);
                }

                return;

            case SignalTypes.StreamStop:
                Stop(signal.StreamId, ReadString(signal.Payload, "reason") ?? "client-closed");
                return;

            default:
                _logger.LogDebug("Ignored a '{Type}' signaling message the host does not handle.", type);
                return;
        }
    }

    private async Task StartAsync(
        ServiceSignalMessage signal,
        SignalSender send,
        CancellationToken cancellationToken)
    {
        if (_streams.ContainsKey(signal.StreamId))
        {
            _logger.LogInformation("Stream {Stream} is already running; the request was a repeat.", signal.StreamId);
            return;
        }

        if (_streams.Count >= MaxConcurrentStreams)
        {
            await send(SignalTypes.StreamError, new
            {
                code = "too-many-streams",
                message = $"This PC is already running {_streams.Count} streams, which is the limit.",
                limitation = false,
                recommendedAction = "Stop one of the running streams and try again.",
            }).ConfigureAwait(false);
            return;
        }

        SignalStreamRequest? request = ReadRequest(signal.Payload);
        if (request is null)
        {
            await send(SignalTypes.StreamError, new
            {
                code = "bad-request",
                message = "The stream request could not be read.",
                limitation = false,
                recommendedAction = (string?)null,
            }).ConfigureAwait(false);
            return;
        }

        IReadOnlyList<IceServerSetting> iceServers = (signal.IceServers ?? Array.Empty<IpcIceServer>())
            .Select(server => new IceServerSetting(server.Urls, server.Username, server.Credential))
            .ToArray();

        _logger.LogInformation(
            "Starting stream {Stream} with {Servers} ICE server(s).",
            signal.StreamId,
            iceServers.Count);

        StreamSession? session = await StreamSession
            .TryStartAsync(
                signal.StreamId,
                signal.SessionId,
                request,
                iceServers,
                signal.AudioAllowed,
                signal.ClipboardAllowed,
                _displays,
                send,
                _loggers,
                _preferDuplication)
            .ConfigureAwait(false);

        if (session is null) return;

        if (!_streams.TryAdd(signal.StreamId, session))
        {
            // Two requests for the same id raced. The one already registered wins, and this
            // one is disposed rather than left running with nothing pointing at it.
            session.Dispose();
        }

        _ = cancellationToken;
    }

    /// <summary>Stop one stream, or every stream when the id is null.</summary>
    public void Stop(string? streamId, string reason)
    {
        if (streamId is null)
        {
            foreach (string id in _streams.Keys.ToArray()) Stop(id, reason);
            return;
        }

        if (!_streams.TryRemove(streamId, out StreamSession? session)) return;

        _logger.LogInformation("Stopping stream {Stream}: {Reason}.", streamId, reason);
        session.Dispose();
    }

    private bool TryFind(ServiceSignalMessage signal, out StreamSession session)
    {
        if (_streams.TryGetValue(signal.StreamId, out StreamSession? found))
        {
            session = found;
            return true;
        }

        // Not an error worth reporting upward: a candidate arriving just after a stream was
        // stopped is ordinary, and answering it would only confuse a client that has already
        // moved on.
        _logger.LogDebug("Signaling arrived for stream {Stream}, which is not running.", signal.StreamId);
        session = null!;
        return false;
    }

    /// <summary>
    /// Serialise a payload with its discriminator and hand it to the agent service.
    ///
    /// The cloud validates against a discriminated union, so `type` has to sit beside the
    /// payload's own fields rather than wrapping them — hence building the object and adding
    /// the key, rather than nesting one record inside another.
    /// </summary>
    private Task SendAsync(ServiceSignalMessage signal, string type, object payload)
    {
        var body = JsonSerializer.SerializeToNode(payload, WolfIpc.Json) as JsonObject ?? new JsonObject();
        body["type"] = type;

        return _send(
            new HostSignalMessage(signal.SessionId, signal.StreamId, body.Deserialize<JsonElement>()),
            CancellationToken.None);
    }

    private static string? ReadType(JsonElement payload) => ReadString(payload, "type");

    private static bool ReadBool(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    private static DateTimeOffset? ReadTimestamp(JsonElement element, string name) =>
        DateTimeOffset.TryParse(ReadString(element, name), out DateTimeOffset parsed) ? parsed : null;

    private static string? ReadString(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object &&
        element.TryGetProperty(name, out JsonElement value) &&
        value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static T? Deserialize<T>(JsonElement element)
        where T : class
    {
        try
        {
            return element.Deserialize<T>(WolfIpc.Json);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static SignalStreamRequest? ReadRequest(JsonElement payload) =>
        payload.TryGetProperty("request", out JsonElement request)
            ? Deserialize<SignalStreamRequest>(request)
            : null;

    private static SignalProfile? ReadProfile(JsonElement payload) =>
        payload.TryGetProperty("profile", out JsonElement profile)
            ? Deserialize<SignalProfile>(profile)
            : null;

    public void Dispose() => Stop(null, "host-shutdown");
}
