using System.Diagnostics;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Wolf.Agent.SessionHost.Capture;
using Wolf.Agent.SessionHost.Displays;
using Xunit;
using Xunit.Abstractions;

namespace Wolf.Agent.Core.Tests;

/// <summary>
/// The Desktop Duplication fallback, against the real display.
///
/// This path exists for machines that do not have Windows Graphics Capture, which are
/// precisely the machines nobody develops on — so it is forced on here rather than waited
/// for. A fallback that is only exercised by the people who cannot report bugs is a fallback
/// that has already rotted.
///
/// What is being checked is that it is genuinely interchangeable with the primary path: the
/// same interface, the same texture on the same device, frames that keep coming, and the one
/// real difference between them reported rather than left to be discovered.
/// </summary>
/// <remarks>
/// Takes a <see cref="ScreenActivity"/> it never reads. Both capture APIs deliver a frame
/// when the screen changes, so on an idle desktop these measure nothing and fail at random.
/// </remarks>
[Collection("Capture")]
public sealed class DuplicationCaptureTests : IClassFixture<ScreenActivity>
{
    private readonly ITestOutputHelper _output;

    public DuplicationCaptureTests(ITestOutputHelper output, ScreenActivity activity)
    {
        _output = output;
        _ = activity;
    }

    private bool CanRun()
    {
        var displays = new DisplayEnumerator(NullLogger<DisplayEnumerator>.Instance);
        if (displays.Enumerate().Count > 0) return true;

        _output.WriteLine("No desktop here; duplication needs a real display.");
        return false;
    }

    [Fact]
    public void Duplication_captures_the_desktop_onto_the_gpu()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Information);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        Assert.NotNull(device);

        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();
        Assert.NotNull(monitor);

        using DuplicationCapture? capture = DuplicationCapture.TryStart(
            device!,
            monitor!.Value,
            loggers.CreateLogger<DuplicationCapture>());

        if (capture is null)
        {
            // Windows allows a limited number of duplications per output. Another one being
            // held is a real condition, not a failure of this code.
            _output.WriteLine("This display could not be duplicated; skipping.");
            return;
        }

        Assert.True(capture.Width > 0);
        Assert.True(capture.Height > 0);
        _output.WriteLine($"duplicating {capture.Width}x{capture.Height}");

        var frames = 0;
        var overall = Stopwatch.StartNew();

        while (frames < 5 && overall.Elapsed < TimeSpan.FromSeconds(10))
        {
            using CaptureFrameLease? lease = capture.TryAcquire();
            if (lease is null)
            {
                Thread.Sleep(5);
                continue;
            }

            // The whole point of capturing this way: the frame is a Direct3D texture on the
            // same device the converter and encoder use, so it never crosses system memory.
            Assert.NotNull(lease.Frame.Texture);
            Assert.Equal(capture.Width, lease.Frame.Width);
            Assert.Equal(capture.Height, lease.Frame.Height);

            frames++;
        }

        _output.WriteLine($"{frames} frames in {overall.ElapsedMilliseconds} ms");
        Assert.True(frames >= 5, $"only {frames} frames arrived; duplication is not producing pictures");
    }

    [Fact]
    public void Duplication_keeps_producing_once_a_frame_is_released()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        using DuplicationCapture? capture = DuplicationCapture.TryStart(
            device!,
            monitor!.Value,
            loggers.CreateLogger<DuplicationCapture>());

        if (capture is null)
        {
            _output.WriteLine("This display could not be duplicated; skipping.");
            return;
        }

        // Duplication allows exactly one outstanding frame and refuses the next until it is
        // released. Getting that wrong does not throw — capture simply stops for ever — so
        // it is worth an explicit test rather than trusting the release path by inspection.
        var acquired = 0;
        var overall = Stopwatch.StartNew();

        while (acquired < 20 && overall.Elapsed < TimeSpan.FromSeconds(15))
        {
            CaptureFrameLease? lease = capture.TryAcquire();
            if (lease is null)
            {
                Thread.Sleep(2);
                continue;
            }

            acquired++;
            lease.Dispose();
        }

        _output.WriteLine($"{acquired} frames acquired and released");
        Assert.True(acquired >= 20, $"capture stalled after {acquired} frames, which suggests a frame was never released");
    }

    [Fact]
    public void Duplication_says_what_it_cannot_do()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        using DuplicationCapture? capture = DuplicationCapture.TryStart(
            device!,
            monitor!.Value,
            loggers.CreateLogger<DuplicationCapture>());

        if (capture is null)
        {
            _output.WriteLine("This display could not be duplicated; skipping.");
            return;
        }

        // Both of these are worse than the Graphics Capture path, and both are reported as
        // false rather than claimed. The cursor is missing from the picture, and Windows
        // draws no indicator telling the person at the PC that they are being watched —
        // saying otherwise would be a lie to the operator about somebody else's privacy.
        Assert.False(capture.CursorCaptured);
        Assert.False(capture.BorderShown);
        Assert.Equal("desktop-duplication", capture.Api);
    }

    [Fact]
    public void A_whole_pipeline_can_run_on_the_fallback()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        var received = 0;

        using CapturePipeline? pipeline = CapturePipeline.TryCreate(
            device!,
            monitor!.Value,
            30,
            8_000_000,
            _ => Interlocked.Increment(ref received),
            loggers,
            preferDuplication: true);

        Assert.NotNull(pipeline);

        // The point of the fallback is that everything above it is unchanged: the same
        // converter, the same encoder, the same H.264 coming out of the far end.
        Assert.Equal("desktop-duplication", pipeline!.CaptureApi);
        Assert.False(pipeline.CursorCaptured);

        pipeline.Start();
        Thread.Sleep(TimeSpan.FromSeconds(4));

        PipelineStats stats = pipeline.Stats();
        _output.WriteLine(
            $"{stats.WidthPixels}x{stats.HeightPixels} via {stats.Encoder}, " +
            $"{stats.FramesEncoded} frames, {stats.BytesEncoded / 1024} KB");

        Assert.True(received > 0, "the fallback pipeline produced no encoded frames");
        Assert.True(stats.BytesEncoded > 0);
        Assert.Equal(0, stats.FramesDropped);
    }

    [Fact]
    public void The_factory_prefers_graphics_capture_where_it_exists()
    {
        if (!CanRun()) return;

        using var loggers = new XunitLoggerFactory(_output, LogLevel.Warning);
        using CaptureDevice? device = CaptureDevice.TryCreate(loggers.CreateLogger<CaptureDevice>());
        IntPtr? monitor = DisplayEnumerator.FindPrimaryMonitorHandle();

        using IDisplayCapture? chosen = DisplayCaptureFactory.TryStart(device!, monitor!.Value, loggers);
        Assert.NotNull(chosen);

        string expected = CaptureDevice.IsCaptureSupported() ? "graphics-capture" : "desktop-duplication";

        _output.WriteLine($"chose {chosen!.Api}, detected {DisplayCaptureFactory.DetectApi()}");

        // Graphics Capture composites the pointer and shows the person at the PC that their
        // screen is being watched. Duplication is the fallback, not an equal option, so a
        // machine that has both must not quietly end up on the worse one.
        Assert.Equal(expected, chosen.Api);

        // And what the machine advertises in the capability handshake has to be what it will
        // actually use, or the cloud offers a stream on the strength of the wrong answer.
        Assert.Equal(expected, DisplayCaptureFactory.DetectApi());
    }
}
