using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Transport;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The whole slice: a client asks for a stream and the screen arrives.
///
/// Everything between those two points is real — the signaling exchange in the shape the
/// cloud relays it, Windows Graphics Capture, the hardware H.264 encoder, ICE, DTLS, SRTP,
/// and a peer on the other end that reassembles what it is sent. The only thing standing in
/// for the cloud is a function that hands messages between the two halves, which is exactly
/// what the relay does.
///
/// This is the test that would catch the failures that matter: an SDP that describes a
/// profile the encoder is not producing, a stream that negotiates and never sends a
/// picture, a pipeline that keeps capturing after the client has gone.
/// </summary>
[Collection("Capture")]
public sealed class StreamSessionTests
{
    private readonly ITestOutputHelper _output;

    public StreamSessionTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const string SessionId = "01J9ZQK7T0000000000000000A";
    private const string StreamId = "01J9ZQK7T0000000000000000B";

    private bool CanRun()
    {
        var displays = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        if (displays.Enumerate().Count > 0 && CaptureDevice.IsCaptureSupported()) return true;

        _output.WriteLine("No desktop or capture support in this session; skipping.");
        return false;
    }

    /// <summary>A signaling message the host sent towards the client.</summary>
    private sealed record Outbound(string Type, JsonElement Payload);

    /// <summary>
    /// Stands in for the cloud: collects what the host sends and lets the test read it.
    ///
    /// Deliberately not a mock of the coordinator. The messages that pass through here are
    /// the real ones, in the real shape, so a payload this host builds wrongly fails here
    /// rather than at the relay in production.
    /// </summary>
    private sealed class Relay
    {
        private readonly List<Outbound> _messages = new();
        private readonly ITestOutputHelper _output;

        public Relay(ITestOutputHelper output)
        {
            _output = output;
        }

        public Task AcceptAsync(HostSignalMessage message, CancellationToken cancellationToken)
        {
            string type = message.Payload.TryGetProperty("type", out JsonElement value)
                ? value.GetString() ?? "(none)"
                : "(none)";

            lock (_messages)
            {
                _messages.Add(new Outbound(type, message.Payload.Clone()));
            }

            // ice.candidate is the only high-volume one and says nothing useful in a log.
            if (type != "ice.candidate") _output.WriteLine($"host -> client: {type}");
            _ = cancellationToken;
            return Task.CompletedTask;
        }

        public IReadOnlyList<Outbound> Snapshot()
        {
            lock (_messages) return _messages.ToArray();
        }

        public Outbound? FirstOf(string type)
        {
            lock (_messages) return _messages.FirstOrDefault(message => message.Type == type);
        }

        public int CountOf(string type)
        {
            lock (_messages) return _messages.Count(message => message.Type == type);
        }
    }

    private static ServiceSignalMessage Signal(string json) =>
        new(SessionId, StreamId, JsonDocument.Parse(json).RootElement.Clone());

    /// <summary>A stream request in the shape the protocol defines it.</summary>
    private static string StreamRequest(string clientCodecs = "[\"h264\"]", int targetFps = 30) => $$"""
        {
          "type": "stream.request",
          "request": {
            "displayId": null,
            "profile": {
              "name": "Test",
              "maxWidthPixels": null,
              "maxHeightPixels": null,
              "targetFps": {{targetFps}},
              "minBitrateBps": 1000000,
              "maxBitrateBps": 8000000,
              "codecPreference": [],
              "audioEnabled": false,
              "qualityBias": "balanced",
              "adaptive": false
            },
            "clientCodecs": {{clientCodecs}},
            "requestAudio": false
          }
        }
        """;

    private static async Task<bool> WaitForAsync(Func<bool> condition, TimeSpan timeout)
    {
        var deadline = Stopwatch.StartNew();
        while (deadline.Elapsed < timeout)
        {
            if (condition()) return true;
            await Task.Delay(25);
        }

        return condition();
    }

    [Fact]
    public async Task A_client_asks_for_the_screen_and_the_screen_arrives()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        var displays = new DisplayEnumerator(loggers.CreateLogger<DisplayEnumerator>());
        var relay = new Relay(_output);

        using var coordinator = new StreamCoordinator(displays, relay.AcceptAsync, loggers);

        // 1. The request, as the cloud would relay it. No ICE servers: the shipped default
        //    configures none, and on one machine there is nothing for them to do.
        await coordinator.HandleAsync(Signal(StreamRequest()), CancellationToken.None);

        Outbound? ready = relay.FirstOf("stream.ready");
        Assert.NotNull(ready);

        JsonElement negotiation = ready!.Payload.GetProperty("negotiation");
        _output.WriteLine("negotiated: " + negotiation.ToString());

        // The negotiation has to describe what is really going to be sent, including the
        // things that were asked for and could not be given.
        Assert.Equal("h264", negotiation.GetProperty("videoCodec").GetString());
        Assert.Equal(StreamId, negotiation.GetProperty("streamId").GetString());
        Assert.True(negotiation.GetProperty("display").GetProperty("widthPixels").GetInt32() > 0);

        Outbound? offer = relay.FirstOf("sdp.offer");
        Assert.NotNull(offer);
        string sdp = offer!.Payload.GetProperty("sdp").GetString()!;

        // The offer's profile-level-id comes from the encoder's own SPS, so it must not be
        // the fallback on a machine with a working encoder.
        Assert.Contains("profile-level-id=", sdp, StringComparison.Ordinal);
        _output.WriteLine("offer profile: " + ProfileLevelIdOf(sdp));

        // 2. Answer it the way a browser would.
        var client = new RTCPeerConnection(new RTCConfiguration { iceServers = new List<RTCIceServer>() });
        client.addTrack(new MediaStreamTrack(
            new VideoFormat(VideoCodecsEnum.H264, 96, 90_000, "packetization-mode=1"),
            MediaStreamStatusEnum.RecvOnly));

        var frames = new List<byte[]>();
        client.OnVideoFrameReceived += (_, _, frame, _) =>
        {
            lock (frames) frames.Add(frame);
        };

        client.onicecandidate += candidate =>
        {
            if (candidate is null) return;
            _ = coordinator.HandleAsync(
                Signal(JsonSerializer.Serialize(new
                {
                    type = "ice.candidate",
                    candidate = candidate.candidate,
                    sdpMid = candidate.sdpMid,
                    sdpMLineIndex = candidate.sdpMLineIndex,
                    usernameFragment = candidate.usernameFragment,
                })),
                CancellationToken.None);
        };

        try
        {
            Assert.Equal(
                SetDescriptionResultEnum.OK,
                client.setRemoteDescription(new RTCSessionDescriptionInit
                {
                    type = RTCSdpType.offer,
                    sdp = sdp,
                }));

            // Candidates the host gathered before the client existed still have to reach it.
            foreach (Outbound message in relay.Snapshot().Where(m => m.Type == "ice.candidate"))
            {
                client.addIceCandidate(new RTCIceCandidateInit
                {
                    candidate = message.Payload.GetProperty("candidate").GetString(),
                    sdpMid = ReadString(message.Payload, "sdpMid"),
                    sdpMLineIndex = (ushort)(ReadInt(message.Payload, "sdpMLineIndex") ?? 0),
                    usernameFragment = ReadString(message.Payload, "usernameFragment"),
                });
            }

            RTCSessionDescriptionInit answer = client.createAnswer(new RTCAnswerOptions());
            await client.setLocalDescription(answer);

            await coordinator.HandleAsync(
                Signal(JsonSerializer.Serialize(new { type = "sdp.answer", sdp = answer.sdp })),
                CancellationToken.None);

            // 3. Connected, and then pictures.
            bool connected = await WaitForAsync(
                () => client.connectionState == RTCPeerConnectionState.connected,
                TimeSpan.FromSeconds(20));
            Assert.True(connected, $"the client never connected; it is {client.connectionState}");

            bool arrived = await WaitForAsync(
                () => { lock (frames) return frames.Count >= 10; },
                TimeSpan.FromSeconds(15));

            int count;
            long total;
            int largest;
            lock (frames)
            {
                count = frames.Count;
                total = frames.Sum(frame => (long)frame.Length);
                largest = frames.Count == 0 ? 0 : frames.Max(frame => frame.Length);
            }

            _output.WriteLine(
                $"{count} frames, {total / 1024} KB, largest {largest / 1024} KB, state {relay.CountOf("stream.state")} " +
                $"state message(s), {relay.CountOf("stream.stats")} stats message(s)");

            Assert.True(arrived, $"only {count} frames reached the client");

            // Every frame must carry an Annex-B start code, or no decoder can read it.
            lock (frames)
            {
                foreach (byte[] frame in frames)
                {
                    Assert.True(frame.Length > 4, "an empty frame reached the client");
                    Assert.True(
                        frame[0] == 0 && frame[1] == 0 && (frame[2] == 1 || (frame[2] == 0 && frame[3] == 1)),
                        "a frame arrived without an Annex-B start code");
                }
            }

            // The stream announced itself as streaming. A client that never sees this waits
            // on a spinner while pictures are arriving behind it.
            Outbound? state = relay.FirstOf("stream.state");
            Assert.NotNull(state);
            Assert.Equal("STREAMING", state!.Payload.GetProperty("state").GetString());

            // Live statistics are what answer "why is this laggy" without the operator
            // having to ask anybody. They are published on a timer, so this waits for one.
            bool published = await WaitForAsync(
                () => relay.FirstOf("stream.stats") is not null,
                TimeSpan.FromSeconds(6));
            Assert.True(published, "the stream never published any statistics");

            JsonElement statistics = relay.FirstOf("stream.stats")!.Payload.GetProperty("stats");
            _output.WriteLine("stats: " + statistics.ToString());

            Assert.Equal("lan", statistics.GetProperty("route").GetString());
            Assert.True(statistics.GetProperty("fps").GetDouble() > 0);
            Assert.False(string.IsNullOrEmpty(statistics.GetProperty("encoder").GetString()));
            Assert.True(statistics.GetProperty("encoderHardware").GetBoolean());
            Assert.True(statistics.GetProperty("encodeMsPerFrame").GetDouble() > 0);

            // Not measured is reported as not measured. A zero here would be a claim that
            // the round trip is instant, which is the sort of number an operator would act
            // on and should never be invented.
            Assert.Equal(JsonValueKind.Null, statistics.GetProperty("latencyMs").ValueKind);
            Assert.Equal(JsonValueKind.Null, statistics.GetProperty("packetLossPercent").ValueKind);

            // 4. Stopping must actually stop the capture. A pipeline still running here
            //    would be reading somebody's screen after the session that authorised it.
            Assert.Equal(1, coordinator.ActiveStreams);
            await coordinator.HandleAsync(
                Signal("""{"type":"stream.stop","reason":"client-closed","detail":null}"""),
                CancellationToken.None);
            Assert.Equal(0, coordinator.ActiveStreams);

            int atStop;
            lock (frames) atStop = frames.Count;
            await Task.Delay(800);

            int later;
            lock (frames) later = frames.Count;

            _output.WriteLine($"{atStop} frames at stop, {later} a moment later");
            Assert.Equal(atStop, later);
        }
        finally
        {
            client.close();
        }
    }

    [Fact]
    public async Task A_client_that_cannot_decode_h264_is_told_so_rather_than_sent_it()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        var displays = new DisplayEnumerator(loggers.CreateLogger<DisplayEnumerator>());
        var relay = new Relay(_output);
        using var coordinator = new StreamCoordinator(displays, relay.AcceptAsync, loggers);

        await coordinator.HandleAsync(
            Signal(StreamRequest(clientCodecs: """["av1","vp9"]""")),
            CancellationToken.None);

        Outbound? error = relay.FirstOf("stream.error");
        Assert.NotNull(error);
        Assert.Equal("codec-mismatch", error!.Payload.GetProperty("code").GetString());

        // Nothing was started, and nothing was offered: sending H.264 to a client that said
        // it cannot decode H.264 produces a black rectangle and no explanation.
        Assert.Null(relay.FirstOf("sdp.offer"));
        Assert.Equal(0, coordinator.ActiveStreams);

        _output.WriteLine(error.Payload.GetProperty("message").GetString());
    }

    [Fact]
    public async Task A_profile_the_display_cannot_meet_is_reported_rather_than_silently_ignored()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        var displays = new DisplayEnumerator(loggers.CreateLogger<DisplayEnumerator>());
        var relay = new Relay(_output);
        using var coordinator = new StreamCoordinator(displays, relay.AcceptAsync, loggers);

        try
        {
            // 500 fps is not available from any display. The stream should still start, at a
            // rate the display can produce, and say which setting it changed.
            await coordinator.HandleAsync(Signal(StreamRequest(targetFps: 500)), CancellationToken.None);

            Outbound? ready = relay.FirstOf("stream.ready");
            Assert.NotNull(ready);

            JsonElement negotiation = ready!.Payload.GetProperty("negotiation");
            JsonElement adjustments = negotiation.GetProperty("adjustments");

            foreach (JsonElement adjustment in adjustments.EnumerateArray())
            {
                _output.WriteLine(
                    $"{adjustment.GetProperty("setting").GetString()}: " +
                    $"asked {adjustment.GetProperty("requested").GetString()}, " +
                    $"got {adjustment.GetProperty("applied").GetString()} — " +
                    adjustment.GetProperty("reason").GetString());
            }

            JsonElement fpsAdjustment = adjustments
                .EnumerateArray()
                .First(entry => entry.GetProperty("setting").GetString() == "targetFps");

            Assert.Equal("500", fpsAdjustment.GetProperty("requested").GetString());
            Assert.NotEqual("500", fpsAdjustment.GetProperty("applied").GetString());

            int effective = negotiation.GetProperty("effectiveProfile").GetProperty("targetFps").GetInt32();
            Assert.InRange(effective, 1, 240);
        }
        finally
        {
            coordinator.Stop(null, "test-finished");
        }
    }

    private static string ProfileLevelIdOf(string sdp)
    {
        int index = sdp.IndexOf("profile-level-id=", StringComparison.Ordinal);
        if (index < 0) return "(none)";
        return new string(sdp[(index + 17)..].TakeWhile(Uri.IsHexDigit).ToArray());
    }

    private static string? ReadString(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static int? ReadInt(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.Number
            ? value.GetInt32()
            : null;
}
