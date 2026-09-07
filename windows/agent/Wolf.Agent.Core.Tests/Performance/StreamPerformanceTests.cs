using System.Diagnostics;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using SIPSorcery.Net;
using SIPSorceryMedia.Abstractions;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Input;
using Wolf.Agent.SessionHost.Transport;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests.Performance;

/// <summary>
/// What the whole stream costs, measured end to end.
///
/// The numbers here are the ones somebody actually experiences: how long they wait for a
/// picture, how much bandwidth a profile really uses, and how long the screen freezes when
/// adaptation reaches for its most expensive lever. Each runs against the real GPU with a
/// second WebRTC peer standing in for a browser.
///
/// Tagged and excluded from the ordinary suite. Run with
/// <c>dotnet test --filter Category=Performance</c> on a machine with a screen.
/// </summary>
[Trait("Category", "Performance")]
[Collection("Capture")]
public sealed class StreamPerformanceTests
{
    private readonly ITestOutputHelper _output;

    public StreamPerformanceTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private const string SessionId = "01J9ZQK7T0000000000000000A";
    private const string StreamId = "01J9ZQK7T0000000000000000B";

    private bool CanRun()
    {
        var displays = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        if (displays.Enumerate().Count > 0 && CaptureDevice.IsCaptureSupported()) return true;

        _output.WriteLine("No desktop or capture support here; a performance run needs a real screen.");
        return false;
    }

    /* --------------------------------------------------------------------- */
    /* Time to first frame                                                    */
    /* --------------------------------------------------------------------- */

    [Fact]
    public async Task A_picture_arrives_before_somebody_wonders_whether_they_clicked()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        var displays = new DisplayEnumerator(loggers.CreateLogger<DisplayEnumerator>());
        var outbound = new List<(string Type, JsonElement Payload)>();

        using var coordinator = new StreamCoordinator(
            displays,
            (message, _) =>
            {
                string type = message.Payload.TryGetProperty("type", out JsonElement value)
                    ? value.GetString() ?? string.Empty
                    : string.Empty;

                lock (outbound) outbound.Add((type, message.Payload.Clone()));
                return Task.CompletedTask;
            },
            loggers);

        // The clock starts where the operator's does: at the click that asks for a stream.
        var stopwatch = Stopwatch.StartNew();

        await coordinator.HandleAsync(
            new ServiceSignalMessage(SessionId, StreamId, StreamRequest()),
            CancellationToken.None);

        double toOffer = stopwatch.Elapsed.TotalMilliseconds;

        JsonElement offer = Find(outbound, "sdp.offer");
        string sdp = offer.GetProperty("sdp").GetString()!;

        var firstFrame = new TaskCompletionSource<double>(TaskCreationOptions.RunContinuationsAsynchronously);
        RTCPeerConnection client = BuildClient(coordinator, outbound, stopwatch, firstFrame);

        try
        {
            Assert.Equal(
                SetDescriptionResultEnum.OK,
                client.setRemoteDescription(new RTCSessionDescriptionInit { type = RTCSdpType.offer, sdp = sdp }));

            foreach ((string type, JsonElement payload) in Snapshot(outbound).Where(entry => entry.Type == "ice.candidate"))
            {
                _ = type;
                client.addIceCandidate(new RTCIceCandidateInit
                {
                    candidate = payload.GetProperty("candidate").GetString(),
                    sdpMid = ReadString(payload, "sdpMid"),
                    sdpMLineIndex = (ushort)(ReadInt(payload, "sdpMLineIndex") ?? 0),
                });
            }

            RTCSessionDescriptionInit answer = client.createAnswer(new RTCAnswerOptions());
            await client.setLocalDescription(answer);

            double toAnswer = stopwatch.Elapsed.TotalMilliseconds;

            await coordinator.HandleAsync(
                new ServiceSignalMessage(
                    SessionId,
                    StreamId,
                    JsonDocument.Parse(JsonSerializer.Serialize(new { type = "sdp.answer", sdp = answer.sdp })).RootElement.Clone()),
                CancellationToken.None);

            Task completed = await Task.WhenAny(firstFrame.Task, Task.Delay(TimeSpan.FromSeconds(20)));
            Assert.True(completed == firstFrame.Task, "no picture ever arrived");

            double toFirstFrame = await firstFrame.Task;

            _output.WriteLine($"request to offer        {toOffer:F0} ms");
            _output.WriteLine($"request to answer       {toAnswer:F0} ms");
            _output.WriteLine($"request to first frame  {toFirstFrame:F0} ms");
            _output.WriteLine($"budget                  {PerformanceBudgets.TimeToFirstFrameMs:F0} ms");

            Assert.True(
                toFirstFrame < PerformanceBudgets.TimeToFirstFrameMs,
                $"first frame after {toFirstFrame:F0} ms against a {PerformanceBudgets.TimeToFirstFrameMs:F0} ms budget");
        }
        finally
        {
            client.close();
            coordinator.Stop(null, "performance-run-finished");
        }
    }

    /* --------------------------------------------------------------------- */
    /* Bandwidth                                                              */
    /* --------------------------------------------------------------------- */

    [Theory]
    [InlineData("Mobile data", 3_000_000, 1280, 720, 30)]
    [InlineData("Internet balanced", 20_000_000, 0, 0, 60)]
    public void A_profile_stays_within_the_bandwidth_it_asked_for(
        string name,
        int ceilingBps,
        int maxWidth,
        int maxHeight,
        int frameRate)
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        long bytes = 0;
        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            frameRate,
            ceilingBps,
            frame => Interlocked.Add(ref bytes, frame.Data.Length),
            loggers,
            maxWidth,
            maxHeight);

        Assert.NotNull(pipeline);

        pipeline!.Start();

        // Measured under load. A still screen encodes to nothing and would let any profile
        // pass, which would make this a test of the desktop wallpaper.
        using var painter = new ScreenActivity();
        var window = Stopwatch.StartNew();
        Thread.Sleep(TimeSpan.FromSeconds(5));
        window.Stop();

        PipelineStats stats = pipeline.Stats();
        double measuredBps = Interlocked.Read(ref bytes) * 8 / window.Elapsed.TotalSeconds;
        double allowed = ceilingBps * PerformanceBudgets.BitrateOvershoot;

        _output.WriteLine($"profile      {name}");
        _output.WriteLine($"encoding     {pipeline.EncodedWidth}x{pipeline.EncodedHeight} at {stats.EncodedFps:F1} fps");
        _output.WriteLine($"measured     {measuredBps / 1_000_000:F2} Mbps against a {ceilingBps / 1_000_000.0:F1} Mbps ceiling");
        _output.WriteLine($"allowed      {allowed / 1_000_000:F1} Mbps (rate control is a target, not a limit)");

        if (maxWidth > 0)
        {
            // A capped profile is only meaningful if the cap was honoured.
            Assert.True(pipeline.EncodedWidth <= maxWidth, "the resolution cap was ignored");
            Assert.True(pipeline.EncodedHeight <= maxHeight, "the resolution cap was ignored");
        }

        Assert.True(
            measuredBps < allowed,
            $"{name} used {measuredBps / 1_000_000:F2} Mbps against a {ceilingBps / 1_000_000.0:F1} Mbps ceiling");
    }

    /* --------------------------------------------------------------------- */
    /* What adaptation costs                                                  */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Changing_resolution_does_not_stall_the_picture()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        var arrivals = new List<long>();
        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            60,
            20_000_000,
            _ =>
            {
                lock (arrivals) arrivals.Add(Stopwatch.GetTimestamp());
            },
            loggers);

        Assert.NotNull(pipeline);

        pipeline!.Start();
        using var painter = new ScreenActivity();
        Thread.Sleep(TimeSpan.FromSeconds(2));

        (int Width, int Height) half = CapturePipeline.EvenSize(
            pipeline.EncodedWidth / 2,
            pipeline.EncodedHeight / 2);

        long changeAt = Stopwatch.GetTimestamp();
        pipeline.RequestEncodedSize(half.Width, half.Height);

        Thread.Sleep(TimeSpan.FromSeconds(2));

        long[] samples;
        lock (arrivals) samples = arrivals.ToArray();

        if (samples.Length < 20)
        {
            _output.WriteLine($"Only {samples.Length} frames arrived; nothing is changing on screen. Skipping.");
            return;
        }

        // The gap that spans the change: the last frame at the old size to the first at the
        // new one, which is exactly what the viewer sees as a freeze.
        long before = samples.Where(at => at <= changeAt).DefaultIfEmpty(changeAt).Max();
        long after = samples.Where(at => at > changeAt).DefaultIfEmpty(changeAt).Min();
        double gapMs = (after - before) * 1000.0 / Stopwatch.Frequency;

        _output.WriteLine($"resized to   {pipeline.EncodedWidth}x{pipeline.EncodedHeight}");
        _output.WriteLine($"picture gap  {gapMs:F0} ms across the change");
        _output.WriteLine($"budget       {PerformanceBudgets.ResolutionChangeGapMs:F0} ms");

        Assert.True(
            gapMs < PerformanceBudgets.ResolutionChangeGapMs,
            $"the picture stopped for {gapMs:F0} ms across a resolution change");
    }

    /* --------------------------------------------------------------------- */
    /* Input                                                                  */
    /* --------------------------------------------------------------------- */

    [Fact]
    public void Input_is_handled_far_faster_than_a_client_can_send_it()
    {
        // A *mouse* hook, because these are pointer events. A keyboard hook would observe
        // none of them and, worse, swallow none of them — the measurement would run by
        // moving the pointer of whoever started it, three thousand times.
        using var hook = new MouseHook();

        var channel = new InputChannel(
            StreamId,
            new InputInjector(
                new IpcDisplay("\\\\.\\DISPLAY1", "Test", 1920, 1080, 60, true, 1, false, 0, 0),
                NullLogger<InputInjector>.Instance),
            NullLogger<InputChannel>.Instance);

        channel.ApplyControl(true, SessionId, DateTimeOffset.UtcNow.AddMinutes(5));

        // One pointer move per event, sixteen per batch, as a client tracking a mouse would
        // send them. Injected for real and swallowed by the hook, so the measurement includes
        // the actual SendInput call and nothing reaches a window.
        JsonElement batch = JsonDocument.Parse(
            $$"""
            {
              "streamId": "{{StreamId}}",
              "sequence": 1,
              "sentAt": "2026-01-01T00:00:00.000Z",
              "events": [{{string.Join(",", Enumerable.Range(0, 16).Select(index =>
                  $$"""{"type":"pointer.move","x":0.{{index}}1,"y":0.5,"offsetMs":0}"""))}}]
            }
            """).RootElement.Clone();

        const int batches = 200;
        var stopwatch = new Stopwatch();

        hook.Run(
            () =>
            {
                stopwatch.Start();
                for (var index = 0; index < batches; index++)
                {
                    channel.Handle(batch);
                }

                stopwatch.Stop();
            },
            settleMs: 200);

        double perSecond = batches / stopwatch.Elapsed.TotalSeconds;
        double perBatchMs = stopwatch.Elapsed.TotalMilliseconds / batches;

        _output.WriteLine($"handled      {batches} batches of 16 events in {stopwatch.ElapsedMilliseconds} ms");
        _output.WriteLine($"rate         {perSecond:F0} batches/s ({perBatchMs:F3} ms each)");
        _output.WriteLine($"budget       {PerformanceBudgets.MinimumInputBatchesPerSecond} batches/s");
        _output.WriteLine($"observed     {hook.Events.Count} events reached the input stack");

        // If nothing was observed, nothing was injected, and the rate above is the speed of
        // rejecting input rather than of delivering it.
        Assert.True(hook.Events.Count > 0, "no input reached the input stack; nothing was measured");

        Assert.True(
            perSecond > PerformanceBudgets.MinimumInputBatchesPerSecond,
            $"input handled at {perSecond:F0} batches/s against a {PerformanceBudgets.MinimumInputBatchesPerSecond} floor");
    }

    /* --------------------------------------------------------------------- */
    /* Harness                                                                */
    /* --------------------------------------------------------------------- */

    private static RTCPeerConnection BuildClient(
        StreamCoordinator coordinator,
        List<(string Type, JsonElement Payload)> outbound,
        Stopwatch stopwatch,
        TaskCompletionSource<double> firstFrame)
    {
        var client = new RTCPeerConnection(new RTCConfiguration { iceServers = new List<RTCIceServer>() });
        client.addTrack(new MediaStreamTrack(
            new VideoFormat(VideoCodecsEnum.H264, 96, 90_000, "packetization-mode=1"),
            MediaStreamStatusEnum.RecvOnly));

        client.OnVideoFrameReceived += (_, _, _, _) =>
            firstFrame.TrySetResult(stopwatch.Elapsed.TotalMilliseconds);

        client.onicecandidate += candidate =>
        {
            if (candidate is null) return;

            _ = coordinator.HandleAsync(
                new ServiceSignalMessage(
                    SessionId,
                    StreamId,
                    JsonDocument.Parse(JsonSerializer.Serialize(new
                    {
                        type = "ice.candidate",
                        candidate = candidate.candidate,
                        sdpMid = candidate.sdpMid,
                        sdpMLineIndex = candidate.sdpMLineIndex,
                        usernameFragment = candidate.usernameFragment,
                    })).RootElement.Clone()),
                CancellationToken.None);
        };

        // Candidates the host finds after the client exists still have to reach it.
        _ = Task.Run(async () =>
        {
            var forwarded = 0;
            for (var attempt = 0; attempt < 100 && !firstFrame.Task.IsCompleted; attempt++)
            {
                foreach ((string type, JsonElement payload) in Snapshot(outbound).Skip(forwarded))
                {
                    forwarded++;
                    if (type != "ice.candidate") continue;

                    try
                    {
                        client.addIceCandidate(new RTCIceCandidateInit
                        {
                            candidate = payload.GetProperty("candidate").GetString(),
                            sdpMid = ReadString(payload, "sdpMid"),
                            sdpMLineIndex = (ushort)(ReadInt(payload, "sdpMLineIndex") ?? 0),
                        });
                    }
                    catch (Exception)
                    {
                        // One unusable candidate does not stop ICE trying every other pair.
                    }
                }

                await Task.Delay(20);
            }
        });

        return client;
    }

    private static JsonElement StreamRequest() => JsonDocument.Parse(
        """
        {
          "type": "stream.request",
          "request": {
            "displayId": null,
            "profile": {
              "name": "Performance",
              "maxWidthPixels": null,
              "maxHeightPixels": null,
              "targetFps": 60,
              "minBitrateBps": 1000000,
              "maxBitrateBps": 20000000,
              "codecPreference": [],
              "audioEnabled": false,
              "qualityBias": "balanced",
              "adaptive": true
            },
            "clientCodecs": ["h264"],
            "requestAudio": false
          }
        }
        """).RootElement.Clone();

    private static (string Type, JsonElement Payload)[] Snapshot(
        List<(string Type, JsonElement Payload)> outbound)
    {
        lock (outbound) return outbound.ToArray();
    }

    private static JsonElement Find(List<(string Type, JsonElement Payload)> outbound, string type)
    {
        (string Type, JsonElement Payload) found = Snapshot(outbound).FirstOrDefault(entry => entry.Type == type);
        Assert.Equal(type, found.Type);
        return found.Payload;
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
