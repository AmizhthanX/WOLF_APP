using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Wolf.Agent.Core.Ipc;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Wolf.Agent.SessionHost.Encoding;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The assembled pipeline, running against the real screen for a couple of seconds.
///
/// The individual stages have their own tests; what this checks is the behaviour that only
/// appears once they run together and on a clock: that it holds a frame rate, that it hands
/// frames to its consumer, and that it stops cleanly rather than leaving a thread encoding
/// somebody's desktop.
/// </summary>
[Collection("Capture")]
public sealed class CapturePipelineTests
{
    private readonly ITestOutputHelper _output;

    public CapturePipelineTests(ITestOutputHelper output)
    {
        _output = output;
    }

    private bool CanRun()
    {
        var enumerator = new DisplayEnumerator(Microsoft.Extensions.Logging.Abstractions.NullLogger<DisplayEnumerator>.Instance);
        if (enumerator.Enumerate().Count > 0 && CaptureDevice.IsCaptureSupported()) return true;

        _output.WriteLine("No desktop or capture support in this session; skipping.");
        return false;
    }

    [Fact]
    public void The_pipeline_holds_its_frame_rate_and_delivers_frames()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        Assert.NotNull(device);

        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        Assert.NotNull(monitor);

        const int targetFps = 30;
        var received = new List<EncodedVideoFrame>();

        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            targetFps,
            8_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);

        pipeline!.Start();
        Thread.Sleep(TimeSpan.FromSeconds(3));

        PipelineStats stats = pipeline.Stats();
        int delivered;
        lock (received) delivered = received.Count;

        _output.WriteLine(
            $"{stats.WidthPixels}x{stats.HeightPixels} via {stats.Encoder} (hardware={stats.HardwareEncoded})");
        _output.WriteLine(
            $"captured {stats.FramesCaptured} ({stats.CapturedFps:F1} fps), " +
            $"encoded {stats.FramesEncoded} ({stats.EncodedFps:F1} fps), dropped {stats.FramesDropped}");
        _output.WriteLine(
            $"{stats.BytesEncoded / 1024} KB, mean encode {stats.MeanEncodeMs:F2} ms/frame");
        _output.WriteLine($"delivered to the consumer: {delivered}");

        Assert.True(stats.FramesEncoded > 0, "the pipeline produced no frames");
        Assert.Equal(stats.FramesEncoded, delivered);

        // Pacing must not overshoot the request: a pipeline that ignores its target would
        // encode at the display's refresh rate and cost far more than asked.
        Assert.True(
            stats.EncodedFps <= targetFps * 1.3,
            $"encoded at {stats.EncodedFps:F1} fps against a {targetFps} fps target");

        // Encoding must comfortably fit inside a frame interval, or the pipeline cannot keep
        // up and latency grows without bound.
        Assert.True(
            stats.MeanEncodeMs < 1000.0 / targetFps,
            $"encoding took {stats.MeanEncodeMs:F1} ms against a {1000.0 / targetFps:F1} ms budget");
    }

    [Fact]
    public void A_key_frame_can_be_requested_on_demand()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        var received = new List<EncodedVideoFrame>();

        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            30,
            8_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);

        pipeline!.Start();

        // Let the stream settle past its opening key frame, and past the first scheduled
        // one, so that what this measures is the response to the request rather than the
        // encoder's own cadence.
        Thread.Sleep(TimeSpan.FromSeconds(3));

        if (!pipeline.SupportsForcedKeyFrames)
        {
            // Not every encoder implements the codec property. Saying so beats a green test
            // that proves nothing, and beats a red one on a machine that is behaving.
            _output.WriteLine(
                "This encoder does not support forced key frames; a joining client waits for " +
                "the next scheduled one.");
            return;
        }

        int before;
        lock (received) before = received.Count;

        // A client joining mid-stream cannot decode anything until the next key frame, so
        // being able to ask for one is what makes joining feel immediate. "Immediate" is the
        // assertion: within a few frames, not somewhere in the next second — a request that
        // merely coincided with the regular key frame interval would pass that.
        Assert.True(pipeline.RequestKeyFrame(), "the encoder refused a key frame request");

        var deadline = Stopwatch.StartNew();
        EncodedVideoFrame? keyFrame = null;
        int position = 0;
        while (deadline.Elapsed < TimeSpan.FromMilliseconds(500) && keyFrame is null)
        {
            lock (received)
            {
                for (int i = before; i < received.Count; i++)
                {
                    if (!received[i].IsKeyFrame) continue;
                    keyFrame = received[i];
                    position = i - before;
                    break;
                }
            }

            if (keyFrame is null) Thread.Sleep(10);
        }

        int arrived;
        lock (received) arrived = received.Count - before;

        _output.WriteLine(
            keyFrame is null
                ? $"no key frame in {arrived} frames over {deadline.ElapsedMilliseconds} ms"
                : $"key frame {position + 1} of {arrived}, {keyFrame.Data.Length / 1024} KB, " +
                  $"after {deadline.ElapsedMilliseconds} ms");

        Assert.NotNull(keyFrame);

        // At 30 fps a request honoured on the next picture arrives within a frame or two.
        // Allowing more would let a scheduled key frame satisfy the assertion.
        Assert.True(position < 4, $"the key frame arrived {position} frames after the request");
    }

    [Fact]
    public void The_frame_rate_can_be_lowered_on_a_running_pipeline()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        var received = new List<EncodedVideoFrame>();

        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            60,
            8_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);

        pipeline!.Start();
        Thread.Sleep(TimeSpan.FromSeconds(2));

        int atFullRate;
        lock (received) atFullRate = received.Count;

        // Frame rate is the second lever adaptation reaches for, after bitrate. If the
        // pacing loop ignored a change, the controller would keep lowering a number that
        // did nothing while the stream stayed broken.
        pipeline.SetTargetFrameRate(15);
        Assert.Equal(15, pipeline.TargetFrameRate);

        lock (received) received.Clear();
        Thread.Sleep(TimeSpan.FromSeconds(2));

        int atLowRate;
        lock (received) atLowRate = received.Count;

        double fullRateFps = atFullRate / 2.0;
        double lowRateFps = atLowRate / 2.0;

        _output.WriteLine($"{fullRateFps:F1} fps at the 60 fps target, {lowRateFps:F1} fps at 15");

        // The target is a ceiling, not a floor. Windows Graphics Capture delivers a frame
        // when the screen changes, so a still desktop legitimately produces fewer than the
        // target — asserting a lower bound would be asserting that something was moving.
        Assert.True(lowRateFps > 0, "the pipeline stopped producing frames entirely");
        Assert.True(lowRateFps < fullRateFps, "lowering the target did not slow the pipeline");
        Assert.True(
            lowRateFps <= 15 * 1.3,
            $"paced at {lowRateFps:F1} fps against a 15 fps target");
    }

    [Theory]
    [InlineData(1920, 1080, 1280, 720, 1280, 720)]
    [InlineData(2560, 1440, 1280, 720, 1280, 720)]
    [InlineData(1920, 1080, 1280, 1280, 1280, 720)]
    [InlineData(1366, 768, 1920, 1080, 1366, 768)]
    [InlineData(1921, 1081, 0, 0, 1920, 1080)]
    public void A_capped_resolution_keeps_the_display_shape(
        int width,
        int height,
        int maxWidth,
        int maxHeight,
        int expectedWidth,
        int expectedHeight)
    {
        (int Width, int Height) fitted = maxWidth > 0
            ? CapturePipeline.FitWithin(width, height, maxWidth, maxHeight)
            : CapturePipeline.EvenSize(width, height);

        _output.WriteLine($"{width}x{height} within {maxWidth}x{maxHeight} -> {fitted.Width}x{fitted.Height}");

        // Squeezing a desktop into the wrong shape is worse than sending a smaller one, and
        // an odd dimension has no representation in NV12 at all.
        Assert.Equal((expectedWidth, expectedHeight), fitted);
        Assert.Equal(0, fitted.Width % 2);
        Assert.Equal(0, fitted.Height % 2);
    }

    [Fact]
    public void The_encoded_resolution_can_be_lowered_on_a_running_pipeline()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        var received = new List<EncodedVideoFrame>();

        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            30,
            8_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);

        int fullWidth = pipeline!.EncodedWidth;
        int fullHeight = pipeline.EncodedHeight;
        Assert.Equal(pipeline.Width, fullWidth);

        pipeline.Start();
        Thread.Sleep(TimeSpan.FromSeconds(1));

        int beforeChange;
        lock (received) beforeChange = received.Count;
        Assert.True(beforeChange > 0, "the pipeline produced nothing before the change");

        // Half size: the last lever adaptation reaches for. A new converter and a new
        // encoder are built between frames, so the stream has to survive the swap.
        (int Width, int Height) half = CapturePipeline.EvenSize(fullWidth / 2, fullHeight / 2);
        pipeline.RequestEncodedSize(half.Width, half.Height);

        lock (received) received.Clear();
        Thread.Sleep(TimeSpan.FromSeconds(2));

        int afterChange;
        EncodedVideoFrame[] frames;
        lock (received)
        {
            afterChange = received.Count;
            frames = received.ToArray();
        }

        _output.WriteLine(
            $"{fullWidth}x{fullHeight} -> {pipeline.EncodedWidth}x{pipeline.EncodedHeight}; " +
            $"{beforeChange} frames before, {afterChange} after");

        Assert.Equal(half.Width, pipeline.EncodedWidth);
        Assert.Equal(half.Height, pipeline.EncodedHeight);

        // Still streaming: a pipeline that stopped rather than resized would have turned a
        // congested link into a dead one.
        Assert.True(afterChange > 0, "the pipeline stopped producing frames after the resize");

        // The new encoder starts with a key frame, so the client can decode what follows
        // without waiting for the next scheduled one.
        Assert.Contains(frames, frame => frame.IsKeyFrame);

        // And the display it is capturing has not changed, only what is encoded from it.
        Assert.Equal(fullWidth, pipeline.Width);
    }

    [Fact]
    public void The_streamed_display_can_be_switched_without_restarting()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        var enumerator = new DisplayEnumerator(loggers.CreateLogger<DisplayEnumerator>());
        IReadOnlyList<IpcDisplay> displays = enumerator.Enumerate();

        if (displays.Count < 2)
        {
            // One monitor is the common case and cannot exercise a switch. Saying so beats a
            // green test that proved nothing.
            _output.WriteLine($"This machine has {displays.Count} display(s); a switch needs two.");
            return;
        }

        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? first = enumerator.FindMonitorHandle(displays[0].Id);
        IntPtr? second = enumerator.FindMonitorHandle(displays[1].Id);
        Assert.NotNull(first);
        Assert.NotNull(second);

        var received = new List<EncodedVideoFrame>();
        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            first!.Value,
            30,
            8_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);

        pipeline!.Start();
        Thread.Sleep(TimeSpan.FromSeconds(1));

        int before;
        lock (received) before = received.Count;
        Assert.True(before > 0, "the pipeline produced nothing on the first display");
        Assert.Equal(first.Value, pipeline.MonitorHandle);

        // Switching in place rather than restarting: a fresh negotiation and ICE exchange is
        // a lot to pay for looking at the other monitor.
        pipeline.RequestDisplay(second!.Value);

        lock (received) received.Clear();
        Thread.Sleep(TimeSpan.FromSeconds(2));

        int after;
        EncodedVideoFrame[] frames;
        lock (received)
        {
            after = received.Count;
            frames = received.ToArray();
        }

        _output.WriteLine(
            $"{displays[0].Id} ({displays[0].WidthPixels}x{displays[0].HeightPixels}) -> " +
            $"{displays[1].Id} ({displays[1].WidthPixels}x{displays[1].HeightPixels}); " +
            $"now encoding {pipeline.EncodedWidth}x{pipeline.EncodedHeight}, {after} frames after");

        Assert.Equal(second.Value, pipeline.MonitorHandle);
        Assert.True(after > 0, "the pipeline stopped producing frames after the switch");

        // The new display's own size, and a key frame so the client can decode what follows.
        Assert.Equal(displays[1].WidthPixels, pipeline.Width);
        Assert.Contains(frames, frame => frame.IsKeyFrame);
    }

    [Fact]
    public void Switching_to_a_display_that_is_not_there_leaves_the_stream_alone()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        var received = new List<EncodedVideoFrame>();
        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            30,
            8_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);

        pipeline!.Start();
        Thread.Sleep(TimeSpan.FromSeconds(1));

        // A handle that is not a monitor. Everything is built before anything is torn down,
        // so a display that cannot be captured leaves the stream exactly as it was.
        pipeline.RequestDisplay(new IntPtr(0x1234));

        lock (received) received.Clear();
        Thread.Sleep(TimeSpan.FromSeconds(1));

        int after;
        lock (received) after = received.Count;

        _output.WriteLine($"{after} frames after asking for a display that does not exist");

        Assert.Equal(monitor.Value, pipeline.MonitorHandle);
        Assert.True(after > 0, "the stream stopped when a bad display was requested");
    }

    [Fact]
    public void Stopping_the_pipeline_stops_the_capture()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        var received = new List<EncodedVideoFrame>();

        CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            30,
            4_000_000,
            frame =>
            {
                lock (received) received.Add(frame);
            },
            loggers);
        Assert.NotNull(pipeline);

        pipeline!.Start();
        Thread.Sleep(TimeSpan.FromSeconds(1));
        pipeline.Dispose();

        int atStop;
        lock (received) atStop = received.Count;
        Assert.True(atStop > 0);

        // Nothing may arrive after disposal: a pipeline that kept running would be capturing
        // somebody's screen after the session that authorised it ended.
        Thread.Sleep(TimeSpan.FromMilliseconds(700));
        int later;
        lock (received) later = received.Count;

        _output.WriteLine($"{atStop} frames at stop, {later} a moment later");
        Assert.Equal(atStop, later);
    }
}
